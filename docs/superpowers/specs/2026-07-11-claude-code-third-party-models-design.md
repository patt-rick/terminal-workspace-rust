# Claude Code on Third-Party Models — Design

**Date:** 2026-07-11
**Status:** Approved
**Builds on:** `2026-07-03-multi-llm-provider-keys-design.md` (v1 key store + injection),
`2026-07-05-one-click-provider-setup-design.md` (v2 presets, install/launch flow)

## Problem

Claude Code reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` from its
process environment at startup, and several providers now expose Anthropic-compatible
`/v1/messages` endpoints natively (DeepSeek, Moonshot/Kimi, Z.ai GLM, OpenRouter, local Ollama).
That makes "Claude Code running on a cheap or local model" a pure env-var configuration — exactly
the mechanism this app already implements — but two things block shipping it as presets today:

1. **Injection is global.** Every enabled entry's env goes into *every* new terminal
   (`ApiKeyStore::resolved_env` → `commands.rs terminal_create` → `CreateOpts.env`). A
   "Claude Code on DeepSeek" entry would silently redirect **all** `claude` launches — the
   ⌘⇧T/⌘⇧D shortcuts, Sessions-tab resumes, plain `claude` typed anywhere — away from the
   user's real claude.ai account. It would also defeat the Claude-accounts switcher: injected
   entry env is applied *after* the ambient-credential strip
   (`claude_ambient_env_remove`, `pty/mod.rs` applies `env_remove` before `opts.env`), so the
   third-party token would win everywhere.
2. **Preset rot.** Provider base URLs and model ids churn. Launch commands already have an
   upgrade path (`LEGACY_LAUNCH_COMMANDS`), but stale `extraEnv` values (base URL, model ids)
   stored in entries would silently keep being injected forever.

## Decisions (user-approved)

1. **Scoped injection.** Entries gain a `scope`: `global` (today's behavior, default) or
   `launch` (env injected only into the terminal launched *from that entry* via the model
   picker or settings ▶ Launch). Claude-Code-on-X presets default to `launch`.
2. **New preset family** — "X (Claude Code)" for providers with native Anthropic-compatible
   endpoints: DeepSeek, Moonshot/Kimi, Z.ai GLM, OpenRouter, Ollama (local). All launch
   `claude`, reusing the existing claude binary check + npm installer.
3. **Preset rot handling:** presets fully initialise `extraEnv` (base URL, `ANTHROPIC_MODEL`,
   `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`); users may edit
   any value, guarded by a tight warning system:
   - values matching a **historical** preset default are silently auto-upgraded on load
     (`LEGACY_EXTRA_ENV`, mirroring `upgradeLaunchCommand`);
   - values differing from the **current** preset default show a per-entry drift warning with
     one-click **Reset to preset defaults**;
   - editing a preset-defaulted var in the form shows an inline "changed from preset default"
     warning.
4. **Exact base URLs / model ids are verified against provider docs at implementation time**
   (same rule as the v2 spec). The values in this doc are the research snapshot, not gospel.

## Non-goals / accepted limitations

- **Resume gap:** `claude --resume` from the Sessions tab launches without a launch-scoped
  entry's env, so a session started on DeepSeek resumes on the user's default account/model.
  Documented limitation; per-session entry tracking is future work.
- Scope is per-**terminal**, not per-command: anything run later in a launch-scoped terminal
  also sees the injected env. Inherent to env injection; acceptable.
- Providers without Anthropic-compatible endpoints (Groq, Mistral, xAI, OpenAI) stay on the
  aider/codex path. A claude-code-router preset is explicitly out of scope for now.
- Degraded Claude Code features on third-party backends (no web search, no prompt caching,
  Anthropic thinking betas suppressed via `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`) are
  provider realities, not app bugs; noted in docs.
- The remote web client cannot launch provider entries; launch-scoped entries are simply never
  injected remotely (falls out of the `expand_env` filter — `remote/bridge.rs` needs no change).

## Design

### Data model

`ApiKey` (Rust, `src-tauri/src/apikeys/mod.rs`) and `ApiKeyMeta` (TS, `src/lib/ipc.ts`) gain:

```
scope: 'global' | 'launch'    // serde(default) = global → old keys.json loads unchanged
```

### Injection

- `expand_env` (feeds `resolved_env`, used by both desktop `terminal_create` and the remote
  bridge) filters to `enabled && scope == global`.
- New `ApiKeyStore::launch_env(id) -> AppResult<Vec<(String, String)>>` resolves **one**
  entry's pairs (secret from keychain + `extra_env`), regardless of scope.
- `CreateTerminalArgs` gains `apikey_entry_id: Option<String>`; `terminal_create` appends
  `launch_env(id)` after `resolved_env()` (later pairs win — existing collision rule).
- Frontend: `CreateTerminalOptions.apikeyEntryId`, threaded
  `requestLaunch`/`confirmInstall` → `launchTerminal` → `createProjectTerminal` →
  `ipc.terminals.create`. Every entry launch passes its id (harmless duplicate for global
  entries).

Because `createProjectTerminal` already applies `applySkipPermissions` + `linkClaudeSession`
to `claude` startup commands, launch-scoped Claude Code terminals get session linking, the
Sessions panel, hooks badges, and the working indicator for free.

### Presets (values to verify at implementation time)

All: `wire: 'anthropic'`, `keyEnvVar: ANTHROPIC_AUTH_TOKEN`, `scope: 'launch'`,
`launchCommand: 'claude'`, claude binary check + npm installer, and
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1'` in `extraEnv`.

| id | name | ANTHROPIC_BASE_URL | model env defaults |
|---|---|---|---|
| deepseek-claude | DeepSeek (Claude Code) | `https://api.deepseek.com/anthropic` | current DeepSeek chat/reasoner ids |
| kimi-claude | Kimi / Moonshot (Claude Code) | `https://api.moonshot.ai/anthropic` | current Kimi K-series id |
| glm-claude | GLM / Z.ai (Claude Code) | `https://api.z.ai/api/anthropic` | current GLM id |
| openrouter-claude | OpenRouter (Claude Code) | `https://openrouter.ai/api` | none (OpenRouter maps Claude ids; user may set) |
| ollama-claude | Ollama local (Claude Code) | `http://localhost:11434` | a popular local coding model id; key field takes any placeholder (Ollama ignores auth) |

`ProviderPreset` gains a required `scope` field (`'global'` on all existing presets).

### Reachability test

`test_inputs` also reports whether the entry is Anthropic-wire (`key_env_var` starts with
`ANTHROPIC_`). For those, `build_test_request` probes `<base>/v1/models` sending **both**
`x-api-key` and `Authorization: Bearer` (+ `anthropic-version`) — Anthropic ignores the extra
bearer, and compatible endpoints vary in which header they accept. Existing anthropic-preset
behavior is preserved (it also uses an `ANTHROPIC_*` key var).

### Rot-warning system (frontend, `src/lib/apikey-presets.ts`)

- `LEGACY_EXTRA_ENV: Record<presetId, Array<Record<string, string>>>` — historical `extraEnv`
  default snapshots. `upgradeExtraEnv(provider, extraEnv)` returns the current preset default
  when the stored map exactly matches a historical snapshot; applied in `useApiKeys.load()`
  next to `upgradeLaunchCommand`. Starts empty; populated whenever a release changes a
  preset's `extraEnv`.
- `presetEnvDrift(provider, extraEnv): string[]` — names of vars whose current preset default
  is non-empty and whose stored value differs (missing counts as differing). User-added extra
  vars are never flagged. Powers:
  - entry-row warning: "⚠ `ANTHROPIC_MODEL` differs from the preset default — provider
    endpoints and model ids go stale" + **Reset to preset defaults** button (overwrites the
    drifted vars with current defaults, keeps user-added pairs, saves);
  - edit-form inline warning under any preset-defaulted var the user changes.
- `envConflicts` skips `scope: 'launch'` entries — they can't collide globally.

### UI

`providers-section.tsx`: Advanced section gains an "Inject env vars into" select
(*Every new terminal* / *Only terminals launched from this entry*), prefilled from the
preset. Entry rows show the drift warning + reset button. The section's intro copy notes that
launch-scoped entries are not injected globally. `model-picker.tsx` needs no change.

### Docs

`docs/multi-llm-provider-keys.md`: replace the §9 "Claude Code can't talk to DeepSeek"
compatibility note with the new reality; add a "Claude Code on third-party models" section
(mechanism, scope semantics, resume limitation, degraded features). README gains a feature
bullet.

## Testing

- Rust: scope serde default on legacy JSON; `expand_env` filters launch entries;
  `launch_env` happy path + missing-secret error; anthropic-wire `build_test_request` cases.
- Vitest: preset shape invariants for the new family; `presetEnvDrift`; `upgradeExtraEnv`;
  `envConflicts` ignores launch-scoped entries.
- Manual: launch DeepSeek (Claude Code) → `/status` inside shows the override; a plain ⌘⇧T
  `claude` in another terminal still uses the logged-in account.
