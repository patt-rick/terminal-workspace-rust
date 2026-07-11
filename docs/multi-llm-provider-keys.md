# Architecture: Multi-LLM Provider Keys

**Status:** Implemented (v1); extended by the v2 one-click provider setup (preset install/launch
flow, binary-on-PATH checks, ready-only model picker) — see
`docs/superpowers/specs/2026-07-03-multi-llm-provider-keys-design.md` for the original locked
decisions and `docs/superpowers/specs/2026-07-05-one-click-provider-setup-design.md` for the v2
design; extended by the v3 launch-scoped Claude Code presets — see
docs/superpowers/specs/2026-07-11-claude-code-third-party-models-design.md.
**Goal:** Let users bring their own API keys for any LLM provider (Claude, ChatGPT/OpenAI,
DeepSeek, Qwen, and anything OpenAI-compatible) so that agent CLIs launched in the app's
terminals can use them. "Plug in what's needed and start working."

---

## 1. Context: how the app runs LLMs today

This is a terminal-workspace IDE. It does **not** call any LLM itself — every "AI" workflow
runs as a CLI process inside a PTY (`claude`, `aider`, `codex`, dev servers, etc.). The app's
job is to spawn those processes, stream their output, and manage sessions.

Two existing facts drive this design:

- **Env is set at spawn.** `PtyManager::create` (`src-tauri/src/pty/mod.rs`) builds a
  `CommandBuilder`, sets `TERM`/`TERM_PROGRAM`, then layers env from `shell::prepare`. Any
  provider credentials a CLI needs must be present in the process environment **at this point**.
- **Secrets already use the OS keychain.** The GitHub token is stored via the `keyring` crate
  (`src-tauri/src/github/mod.rs`), with only non-secret metadata in a JSON file. The
  `IdentityStore` (`src-tauri/src/identity/mod.rs`) is the existing pattern for a *multi-entry*
  store (add / list / remove / default). This feature reuses both patterns.

**The mechanism is env-var injection.** The app stores provider credentials securely and injects
them into every new terminal's environment. The CLI running in that terminal reads them exactly
as it would if the user had exported them by hand. There is no in-app inference, no provider SDK
in the app, and no proxy.

---

## 2. Non-goals

- **No built-in chat/LLM panel.** The app does not call providers directly. (See §9 for how this
  design leaves room for that later.)
- **No retroactive injection.** Keys apply to terminals opened *after* the key is saved; running
  shells are not mutated. This is intentional — pushing `export` into live shells is fragile
  across shells and startup states.
- **No session-history for non-Claude tools.** The "past sessions" feature reads Claude's on-disk
  transcripts (`~/.claude/projects`) and is Claude-specific. Other providers/CLIs won't populate
  it. Out of scope here.
- **No secret sandboxing.** Injected env vars are readable by *every* process in that terminal
  (`echo $OPENAI_API_KEY`). That is inherent to env injection and is how the CLIs consume them.

---

## 3. The core insight: a provider is a *set of env vars*, not one key

Making a provider usable is rarely "one key = one variable." OpenAI-compatible providers
(DeepSeek, Qwen, OpenRouter, Groq, local vLLM, …) typically need **two or more** values:

- the **API key**, and
- a **base-URL override** that points the OpenAI-format client away from `api.openai.com`.

The **model name is not an env var** — the user passes it to the CLI (`aider --model …`).

Therefore each stored entry holds an **arbitrary set of environment pairs**, one of which is the
secret. Provider "presets" merely prefill these fields. This is what makes adding a new provider a
*config action, not a code change*: any OpenAI-compatible endpoint works by filling in a key and a
base URL.

---

## 4. Data model

### 4.1 Persisted metadata — `keys.json` (app-data dir, non-secret)

```jsonc
{
  "keys": [
    {
      "id": "b1f0…",              // uuid
      "provider": "deepseek",     // preset id: anthropic | openai | deepseek | qwen | custom
      "label": "DeepSeek (personal)",
      "keyEnvVar": "DEEPSEEK_API_KEY",  // env var that carries the secret
      "hasValue": true,           // secret presence flag; the secret itself is NOT here
      "extraEnv": {               // additional non-secret env injected alongside the key
        "OPENAI_BASE_URL": "https://api.deepseek.com"
      },
      "enabled": true
    }
  ]
}
```

- Written atomically (tmp + rename), same as `identity/mod.rs` / `settings/mod.rs`.
- `extraEnv` values are **not secret** (base URLs, region ids) and can live in JSON. If a provider
  ever needs a *second* secret, add it as its own entry rather than putting a secret in `extraEnv`.

### 4.2 Secret storage — OS keychain

One keychain entry per key id, mirroring `github/mod.rs`:

```
service = "com.patt-rick.terminalworkspace"
user    = "apikey-<id>"
value   = <the raw API key>
```

Metadata records only `hasValue: bool`; the secret is fetched from the keychain on demand.

---

## 5. Injection model

At terminal creation the resolved environment is: **inherited process env → provider key env
(enabled entries) → `TERM*` vars → shell-integration env.**

Decision to make at build time: **do provider keys override inherited env, or defer to it?**
Recommended: provider entries win (an explicit key in the app should beat a stale shell export),
but keep the ordering in one place so it's easy to flip.

If two enabled entries define the same env var (e.g. two OpenAI keys both using `OPENAI_API_KEY`),
last-enabled wins and the UI should warn. Most users will keep one enabled entry per variable.

### Optional refinement — scoped injection

Baseline injects all enabled keys into every terminal. A later refinement: allow an entry to be
scoped so it's only injected when the startup command matches (e.g. inject the DeepSeek key only
for terminals launched with `aider`). Not required for v1; the data model can add a `scope` field
without breaking existing entries.

---

## 6. Backend changes (Rust)

New module **`src-tauri/src/apikeys/mod.rs`**, modeled on `IdentityStore`:

- `ApiKeyStore { path, inner: Mutex<ApiKeyData> }` with `new(path)`, atomic `persist`.
- `struct ApiKey { id, provider, label, key_env_var, extra_env: Map, enabled }` (+ `has_value`
  derived from the keychain, not persisted as truth).
- Methods:
  - `list() -> Vec<ApiKey>` (metadata only; never returns secrets)
  - `save(entry, secret: Option<String>)` — upsert metadata; if `secret` present, write keychain
  - `remove(id)` — delete metadata + keychain entry
  - `set_enabled(id, bool)`
  - `resolved_env() -> Vec<(String, String)>` — for enabled entries, read each secret from the
    keychain and expand `key_env_var` + `extra_env` into a flat list. **Called at spawn time.**

Wiring:

- **`lib.rs`** — `app.manage(ApiKeyStore::new(data_dir.join("keys.json")))` next to the other
  stores; add the new commands to `generate_handler![]`.
- **`pty/mod.rs`** — add `env: Vec<(String, String)>` to `CreateOpts`; set those pairs in
  `PtyManager::create` right after the `TERM*` vars and before `prepared.env`.
- **`commands.rs`** — in `terminal_create`, call `apikeys.resolved_env()` and pass it into
  `CreateOpts.env`. Add commands: `apikeys_list`, `apikeys_save`, `apikeys_remove`,
  `apikeys_set_enabled`, and optionally `apikeys_test` (a lightweight reachability check).

Secrets never cross the IPC boundary back to the frontend — `list` returns metadata only, and the
UI shows at most the last few characters if it re-reads a secret for display.

---

## 7. Frontend changes (React)

Mirror the existing identity UI (`components/identity/accounts-section.tsx` + `state/identity.ts`):

- **`components/settings-modal.tsx`** — new "Providers / API Keys" section: provider preset
  dropdown, label, paste field for the key, editable key-env-var name, editable extra-env pairs,
  enable toggle, delete. Choosing a preset prefills `keyEnvVar` + `extraEnv`.
- **`state/apikeys.ts`** — Zustand store calling the new commands.
- **`lib/ipc.ts`** — typed `invoke` wrappers.

The paste field is write-only (never echoes a stored secret back); saved entries show a masked
indicator, not the value.

---

## 8. Provider presets

Presets are just default field values; the underlying storage is generic. Exact values live in
`src/lib/apikey-presets.ts` — the table below mirrors it:

| Preset | Key env var | Launch command | Install command |
|---|---|---|---|
| **Anthropic / Claude** | `ANTHROPIC_API_KEY` | `claude` | `npm install -g @anthropic-ai/claude-code` |
| **OpenAI / ChatGPT** | `OPENAI_API_KEY` | `codex` | `npm install -g @openai/codex` |
| **Google Gemini** | `GEMINI_API_KEY` | `gemini` | `npm install -g @google/gemini-cli` |
| **DeepSeek** | `DEEPSEEK_API_KEY` | `aider --model deepseek/deepseek-chat` | `python -m pip install aider-install ; aider-install` |
| **xAI Grok** | `XAI_API_KEY` | `aider --model xai/grok-4` | `python -m pip install aider-install ; aider-install` |
| **Mistral** | `MISTRAL_API_KEY` | `aider --model mistral/mistral-large-latest` | `python -m pip install aider-install ; aider-install` |
| **Groq** | `GROQ_API_KEY` | `aider --model groq/llama-3.3-70b-versatile` | `python -m pip install aider-install ; aider-install` |
| **OpenRouter** | `OPENROUTER_API_KEY` | `aider --model openrouter/openrouter/auto` | `python -m pip install aider-install ; aider-install` |
| **Qwen** | `DASHSCOPE_API_KEY` | `qwen` | `npm install -g @qwen-code/qwen-code` |
| **Custom (OpenAI-compatible)** | `OPENAI_API_KEY` (editable) | (empty) | — |

The aider-based presets (DeepSeek, Grok, Mistral, Groq, OpenRouter) rely on litellm's native
`provider/model` prefixes, which read each provider's own key env var directly — no
`OPENAI_BASE_URL` juggling needed. Launch checks the CLI binary on PATH first and offers a
prompt-then-install flow (`<install> ; <launch>`) when it's missing.

Because "Custom" exists, **any** OpenAI-compatible provider is supported without a new preset.

---

## 9. User flows (what "plug in and work" looks like)

**DeepSeek via aider (native):**
1. Settings → API Keys → preset *DeepSeek* → paste key → save (env var `DEEPSEEK_API_KEY`).
2. Open a new terminal → `aider --model deepseek/deepseek-chat`. Done.

**DeepSeek/Qwen via any OpenAI-compatible tool:**
1. Add the key as `OPENAI_API_KEY` and set `OPENAI_BASE_URL` to the provider's endpoint.
2. New terminal → run the tool → select the provider's model (`deepseek-chat`, `qwen-plus`, …).

**ChatGPT via codex:**
1. Add key, preset *OpenAI* (`OPENAI_API_KEY`).
2. New terminal → `codex`.

**Claude (unchanged):** add an Anthropic key, or keep using existing `gh`/subscription auth.

> Compatibility note: Claude Code speaks the **Anthropic** wire format. Providers with native
> Anthropic-compatible endpoints (DeepSeek, Kimi/Moonshot, GLM/Z.ai, OpenRouter, local Ollama)
> can back Claude Code directly via the launch-scoped "X (Claude Code)" presets, which inject
> `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` only into terminals launched from that entry.
> OpenAI-format-only providers (OpenAI, Groq, Mistral, xAI) still use a CLI that speaks their
> format (codex/aider) or a translating proxy.

---

## 9b. Claude Code on third-party models (launch-scoped entries)

Entries have an injection scope: **global** (default — env goes into every new terminal, the
v1 behavior) or **launch** (env goes only into terminals started from that entry's ▶ Launch
button or the model picker). The "X (Claude Code)" presets default to launch scope so a
DeepSeek/Kimi/GLM/OpenRouter/Ollama-backed Claude Code never hijacks normal `claude`
terminals, the ⌘⇧T/⌘⇧D shortcuts, or the active managed Claude account.

Preset `extraEnv` values (base URL, `ANTHROPIC_MODEL`, …) are fully initialised but editable.
Values matching a superseded release's defaults are silently upgraded on load
(`LEGACY_EXTRA_ENV`); values that differ from the current defaults show a per-entry warning
with one-click **Reset to defaults**.

Known limitations:
- Resuming a session from the Sessions tab (`claude --resume`) does not re-inject a
  launch-scoped entry's env — the resumed session runs on the default Claude credentials.
- On third-party backends Claude Code loses web search, prompt caching, and Anthropic
  thinking betas (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is preset to avoid header
  errors); tool-calling quality varies by model.
- The scope is per-terminal: any command run later in a launch-scoped terminal sees the
  injected env.

---

## 10. Open questions / decisions for implementation

1. **Override precedence** — do app keys beat inherited shell env, or defer to it? (§5)
2. **Duplicate env vars across enabled entries** — warn, block, or last-wins? (§5)
3. **`apikeys_test`** — include a reachability/auth check per provider, or ship without it first?
4. **Scoped injection** (§5) — v1 (inject everywhere) or include command-matched scoping?
5. **Import from environment** — offer to detect keys already in the user's shell env and import
   them into the keychain?

---

## 11. Future extension (explicitly out of scope now)

Because credentials + base URLs live in a generic, provider-agnostic store, a future in-app chat
panel could call providers directly by reusing `ApiKeyStore` — no schema change. This design keeps
that door open without building it.
