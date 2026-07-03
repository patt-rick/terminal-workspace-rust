# Design: Multi-LLM Provider Keys (v1)

**Date:** 2026-07-03
**Status:** Approved for implementation
**Supersedes/extends:** `docs/multi-llm-provider-keys.md` (the proposal doc). This spec locks the
open decisions from that doc's §10 and corrects one omission (the remote spawn path).

## Summary

Users bring their own API keys for any LLM provider (Anthropic, OpenAI, DeepSeek, Qwen, and
anything OpenAI-compatible — OpenRouter, Groq, local vLLM, …). The app stores each key in the OS
keychain and injects it as environment variables into every **new** terminal, so agent CLIs
(`claude`, `aider`, `codex`, …) pick them up exactly as if the user had exported them by hand.
This is OpenRouter-style BYOK key management; it is **not** a gateway — the app never calls
providers for inference and never translates protocols.

## Decisions locked (from the proposal's open questions)

1. **Precedence:** app keys override inherited shell env. (Falls out naturally:
   `CommandBuilder::env` overrides the inherited process environment.)
2. **Duplicate env vars across enabled entries:** last-enabled wins, deterministically (stored
   order); the settings UI shows a conflict warning on the affected entries.
3. **`apikeys_test`:** IN for v1 — lightweight reachability/auth check per entry.
4. **Scoped injection:** OUT for v1 — every enabled entry injects into every new terminal. The
   data model tolerates a future `scope` field without migration.
5. **Import from environment:** IN for v1 — detect known key vars already present in the process
   env and offer one-click import into the keychain.

## Data model

### `keys.json` (app-data dir; non-secret metadata only)

```jsonc
{
  "keys": [
    {
      "id": "b1f0…",                    // uuid v4
      "provider": "deepseek",           // preset id: anthropic | openai | deepseek | qwen | custom
      "label": "DeepSeek (personal)",
      "keyEnvVar": "DEEPSEEK_API_KEY",  // env var that carries the secret
      "extraEnv": {                     // non-secret env injected alongside the key
        "OPENAI_BASE_URL": "https://api.deepseek.com"
      },
      "enabled": true
    }
  ]
}
```

- Written atomically (tmp + rename), identical pattern to `identity/mod.rs`.
- `extraEnv` values are never secret (base URLs, region ids). A provider needing a second secret
  gets a second entry.
- `hasValue` is **derived** from the keychain when listing — not persisted.

### Keychain (one entry per key)

```
service = "com.patt-rick.terminalworkspace"
user    = "apikey-<id>"
value   = <raw API key>
```

Same `keyring` usage as `github/mod.rs`.

## Backend (Rust)

### New module `src-tauri/src/apikeys/mod.rs`

Modeled on `IdentityStore` (`parking_lot::Mutex` + atomic persist):

- `struct ApiKey { id, provider, label, key_env_var, extra_env: HashMap<String,String>, enabled }`
  (serde camelCase). A separate `ApiKeyMeta` (or serde-skip) shape adds `has_value: bool` for
  `list()` responses.
- `ApiKeyStore { path, inner: Mutex<ApiKeyData> }`:
  - `list() -> Vec<ApiKeyMeta>` — metadata + derived `has_value`; **never returns secrets**.
  - `save(entry: ApiKey, secret: Option<String>)` — upsert metadata; when `secret` is `Some`,
    write the keychain entry. Saving with `None` keeps the existing secret.
  - `remove(id)` — delete metadata and the keychain entry.
  - `set_enabled(id, bool)`.
  - `resolved_env() -> Vec<(String, String)>` — for each **enabled** entry in stored order:
    read the secret from the keychain (a missing secret skips the entire entry, `extra_env`
    included — see Error handling), emit `(key_env_var, secret)` plus each `extra_env` pair.
    Called at spawn time; later pairs override earlier ones when applied (last-enabled wins).

### Injection point

- `pty/mod.rs` — add `pub env: Vec<(String, String)>` to `CreateOpts`. In `PtyManager::create`,
  apply these pairs **after** the `TERM*` vars and **before** `prepared.env`.
- **Both** spawn paths pass it:
  - `commands.rs::terminal_create` — `app.state::<ApiKeyStore>().resolved_env()`.
  - `remote/bridge.rs::spawn_terminal` — same call (it already has `AppHandle`). This path was
    missing from the proposal doc; phone/PWA-created terminals must get keys too.
- No retroactive injection: running shells are never mutated.

### Commands (registered in `lib.rs`, store managed next to the others)

| Command | Behavior |
|---|---|
| `apikeys_list` | metadata + `hasValue` |
| `apikeys_save(entry, secret?)` | upsert; secret optional (write-only field semantics) |
| `apikeys_remove(id)` | metadata + keychain delete |
| `apikeys_set_enabled(id, enabled)` | toggle |
| `apikeys_test(id)` | async; see below |
| `apikeys_detect_env` | scan process env for known key vars not already stored; return `{ envVar, maskedTail }` — never full values |
| `apikeys_import_env(envVar, provider, label)` | read the full value backend-side, save as a new entry (secret never crosses IPC) |

`app.manage(ApiKeyStore::new(data_dir.join("keys.json")))` in `lib.rs::run`.

### `apikeys_test` (reachability/auth check)

Uses the existing `reqwest` (rustls). Anthropic-format entries: `GET
https://api.anthropic.com/v1/models` with `x-api-key: <key>` (+ `anthropic-version` header).
OpenAI-format entries: `GET <base>/models` where `<base>` is the entry's base-URL override
(`OPENAI_BASE_URL`-style extra env, normalized to include `/v1` when absent) or
`https://api.openai.com/v1`, with `Authorization: Bearer <key>`. Result is one of
`ok | authFailed (401/403) | unreachable(message)`. 5s timeout. Exact endpoint URLs verified
against provider docs at implementation time.

### `apikeys_detect_env` known vars

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`,
`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`,
`GEMINI_API_KEY`. Returned with a masked tail (`…a4f2`) for display. Vars whose name is already
used by a stored entry are excluded.

## Provider presets (frontend data, not backend logic)

Presets only prefill fields; storage is fully generic. Base URLs verified at implementation time.

| Preset | keyEnvVar | extraEnv prefill |
|---|---|---|
| Anthropic / Claude | `ANTHROPIC_API_KEY` | — |
| OpenAI / ChatGPT | `OPENAI_API_KEY` | — |
| DeepSeek | `DEEPSEEK_API_KEY` | `OPENAI_BASE_URL=https://api.deepseek.com` |
| Qwen (DashScope) | `DASHSCOPE_API_KEY` | `OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Custom (OpenAI-compatible) | user-defined (default `OPENAI_API_KEY`) | `OPENAI_BASE_URL=<user>` |

Each preset also carries the wire format (`anthropic` \| `openai`) so `apikeys_test` knows which
check to run; `custom` is `openai`.

## Frontend (React)

Mirrors the identity feature end to end:

- `lib/ipc.ts` — typed `invoke` wrappers + `ApiKeyMeta` type.
- `state/apikeys.ts` — Zustand store: `load`, `save`, `remove`, `setEnabled`, `test`,
  `detectEnv`, `importEnv`.
- `components/apikeys/providers-section.tsx` — new "AI Providers" section in
  `settings-modal.tsx` (rendered next to `AccountsSection`):
  - List of saved entries: label, provider badge, env var name, masked indicator (`••••` +
    `hasValue`), enable toggle, Test button (shows ok/auth-failed/unreachable inline), delete.
  - Add/edit form: preset dropdown (prefills fields), label, **write-only** key paste field
    (placeholder "unchanged" when editing an entry that has a value; never echoes a secret),
    editable env-var name, editable extra-env key/value pairs.
  - Conflict warning badge when two enabled entries define the same env var, naming the winner.
  - "Import from environment" row listing `apikeys_detect_env` results with masked tails and an
    Import button each.

## Error handling

- Keychain read failure at spawn: skip that entry's key var (still inject its `extraEnv`? **No —
  skip the whole entry**; a base URL without a key misroutes tools). Never block terminal
  creation on key errors.
- Keychain write failure on save: return an error to the UI; metadata is not persisted (no
  entry claiming `hasValue` it doesn't have).
- `keys.json` parse failure: start empty (same forgiving load as the other stores).

## Testing

- Rust unit tests (pure logic, no OS keychain): stored-order env expansion and last-enabled-wins
  collision behavior via an injectable secret-lookup (closure or trait), persist/load roundtrip
  through a tempdir, entry-skipped-when-secret-missing.
- `apikeys_test` URL/header construction as a pure function (base-URL normalization incl. `/v1`).
- Existing integration flow: manual smoke — save a key, open a new terminal, `echo $VAR`
  (or `$env:VAR` on Windows) shows it; terminals opened before saving do not.

## Non-goals (unchanged from the proposal)

No in-app inference or chat panel; no proxy/protocol translation (Claude Code still speaks
Anthropic format only — picking a CLI that matches the provider is the user's job); no
retroactive injection into live shells; no secret sandboxing (env vars are readable by every
process in that terminal, inherently); no session history for non-Claude tools; no scoped
injection in v1.
