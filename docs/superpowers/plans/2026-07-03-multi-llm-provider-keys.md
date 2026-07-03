# Multi-LLM Provider Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users save API keys for any LLM provider (Anthropic, OpenAI, DeepSeek, Qwen, any OpenAI-compatible endpoint); the app stores secrets in the OS keychain and injects them as env vars into every new terminal so CLIs (`claude`, `aider`, `codex`) pick them up.

**Architecture:** New Rust module `apikeys` (metadata in `keys.json`, secrets in keychain via `keyring`, mirroring `identity`/`github` stores). Injection happens in `PtyManager::create` via a new `env` field on `CreateOpts`, populated by both spawn paths (`commands::terminal_create` and `remote/bridge.rs::spawn_terminal`). Frontend mirrors the identity feature: typed ipc wrappers → Zustand store → a settings-modal section.

**Tech Stack:** Rust (Tauri 2, `keyring` 3, `reqwest` 0.12, `parking_lot`, `serde`), React + Zustand + Tailwind, vitest for frontend unit tests, `cargo test` for Rust.

**Spec:** `docs/superpowers/specs/2026-07-03-multi-llm-provider-keys-design.md` — read it first; it locks precedence (app keys win), collision behavior (later stored entry wins + UI warning), and v1 scope (test + import-from-env in; scoped injection out).

**Conventions used throughout:**
- Run Rust tests from `src-tauri/`: `cargo test`. Frontend from repo root: `pnpm test`, `pnpm typecheck`.
- All serde structs use `#[serde(rename_all = "camelCase")]`; Tauri maps JS camelCase args to Rust snake_case params automatically.
- Commit after every green test, no `Co-Authored-By` trailer (repo preference).

---

### Task 1: `apikeys` data model, store persistence, and pure env expansion

**Files:**
- Create: `src-tauri/src/apikeys/mod.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration only in this task)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/apikeys/mod.rs`

- [ ] **Step 1: Create the module with types, store skeleton, and `expand_env`, plus failing-by-compilation tests**

Create `src-tauri/src/apikeys/mod.rs`:

```rust
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "com.patt-rick.terminalworkspace";

// ---- types ----

/// One provider-key entry. Non-secret metadata only — the secret lives in the
/// OS keychain under `apikey-<id>`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKey {
    pub id: String,
    /// preset id: anthropic | openai | deepseek | qwen | custom
    pub provider: String,
    pub label: String,
    /// env var that carries the secret (e.g. OPENAI_API_KEY)
    pub key_env_var: String,
    /// non-secret env injected alongside the key (base URLs etc.)
    #[serde(default)]
    pub extra_env: BTreeMap<String, String>,
    pub enabled: bool,
}

/// `list()` response shape: metadata + whether a secret exists in the keychain.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyMeta {
    #[serde(flatten)]
    pub key: ApiKey,
    pub has_value: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct ApiKeyData {
    #[serde(default)]
    keys: Vec<ApiKey>,
}

pub struct ApiKeyStore {
    path: PathBuf,
    inner: Mutex<ApiKeyData>,
}

impl ApiKeyStore {
    pub fn new(path: PathBuf) -> Self {
        let inner = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    fn persist(&self, data: &ApiKeyData) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(data) {
            let tmp = self.path.with_extension("tmp");
            if fs::write(&tmp, s).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }
}

// ---- pure helpers ----

/// Expand enabled entries into env pairs, in stored order. `secret_for` looks
/// up an entry's secret by id; an entry whose secret is missing is skipped
/// entirely (a base URL without its key would misroute tools). When two
/// entries emit the same var, the later pair wins at apply time — callers set
/// the pairs sequentially, so "later in stored order" is the deterministic rule.
pub fn expand_env(
    keys: &[ApiKey],
    secret_for: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for k in keys.iter().filter(|k| k.enabled) {
        let Some(secret) = secret_for(&k.id) else {
            continue;
        };
        out.push((k.key_env_var.clone(), secret));
        for (name, val) in &k.extra_env {
            out.push((name.clone(), val.clone()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn key(id: &str, var: &str, enabled: bool) -> ApiKey {
        ApiKey {
            id: id.to_string(),
            provider: "custom".to_string(),
            label: id.to_string(),
            key_env_var: var.to_string(),
            extra_env: BTreeMap::new(),
            enabled,
        }
    }

    #[test]
    fn expand_skips_disabled_entries() {
        let keys = vec![key("a", "OPENAI_API_KEY", false), key("b", "GROQ_API_KEY", true)];
        let env = expand_env(&keys, |_| Some("sk-x".to_string()));
        assert_eq!(env, vec![("GROQ_API_KEY".to_string(), "sk-x".to_string())]);
    }

    #[test]
    fn expand_skips_whole_entry_when_secret_missing() {
        let mut k = key("a", "OPENAI_API_KEY", true);
        k.extra_env
            .insert("OPENAI_BASE_URL".to_string(), "https://api.deepseek.com".to_string());
        let env = expand_env(&[k], |_| None);
        assert!(env.is_empty()); // no orphaned base URL
    }

    #[test]
    fn expand_includes_extra_env_after_the_key() {
        let mut k = key("a", "DEEPSEEK_API_KEY", true);
        k.extra_env
            .insert("OPENAI_BASE_URL".to_string(), "https://api.deepseek.com".to_string());
        let env = expand_env(&[k], |id| Some(format!("secret-{id}")));
        assert_eq!(
            env,
            vec![
                ("DEEPSEEK_API_KEY".to_string(), "secret-a".to_string()),
                ("OPENAI_BASE_URL".to_string(), "https://api.deepseek.com".to_string()),
            ]
        );
    }

    #[test]
    fn expand_preserves_stored_order_so_later_entries_win_on_collision() {
        let keys = vec![key("a", "OPENAI_API_KEY", true), key("b", "OPENAI_API_KEY", true)];
        let env = expand_env(&keys, |id| Some(format!("secret-{id}")));
        // Both pairs present, "b" last: sequential application makes it win.
        assert_eq!(env.len(), 2);
        assert_eq!(env[1], ("OPENAI_API_KEY".to_string(), "secret-b".to_string()));
    }

    #[test]
    fn store_roundtrips_through_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        {
            let store = ApiKeyStore::new(path.clone());
            let mut d = store.inner.lock();
            d.keys.push(key("a", "OPENAI_API_KEY", true));
            store.persist(&d);
        }
        let store = ApiKeyStore::new(path);
        let d = store.inner.lock();
        assert_eq!(d.keys.len(), 1);
        assert_eq!(d.keys[0].key_env_var, "OPENAI_API_KEY");
    }

    #[test]
    fn store_starts_empty_on_corrupt_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        fs::write(&path, "{not json").unwrap();
        let store = ApiKeyStore::new(path);
        assert!(store.inner.lock().keys.is_empty());
    }
}
```

- [ ] **Step 2: Declare the module and verify tests fail before, pass after**

In `src-tauri/src/lib.rs`, add to the module list (alphabetical, after `mod claude;`):

```rust
mod apikeys;
```

Run: `cargo test apikeys` (from `src-tauri/`)
Expected: all 6 tests PASS. (Compilation is the "red" phase here — the tests and code land together; make sure `cargo test` output actually lists the 6 tests.)

Note: `expand_env`, `ApiKeyMeta`, `AppError`/`AppResult` imports may warn as unused until Task 2 — that's fine, don't remove them. If `cargo test` fails on unused-import lints treated as errors (it doesn't in this repo), prefix with `#[allow(unused)]` temporarily and remove in Task 2.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/apikeys/mod.rs src-tauri/src/lib.rs
git commit -m "feat(apikeys): data model, persisted store, pure env expansion"
```

---

### Task 2: Keychain-backed store methods

**Files:**
- Modify: `src-tauri/src/apikeys/mod.rs`

The OS keychain can't run in unit tests; these methods are thin composition over Task 1's tested logic, mirroring `github/mod.rs`. Tests for `save`/`remove`/`set_enabled` use `secret: None` paths that never touch the keychain.

- [ ] **Step 1: Add keychain helpers and store methods**

Add to `src-tauri/src/apikeys/mod.rs` (below `persist`, inside `impl ApiKeyStore`):

```rust
    /// Metadata + derived has_value. Never returns secrets.
    pub fn list(&self) -> Vec<ApiKeyMeta> {
        self.inner
            .lock()
            .keys
            .iter()
            .cloned()
            .map(|k| {
                let has_value = keychain_secret(&k.id).is_some();
                ApiKeyMeta { key: k, has_value }
            })
            .collect()
    }

    /// Upsert metadata; when `secret` is Some, write the keychain first — a
    /// keychain failure aborts the save so metadata never claims a value it
    /// doesn't have. `secret: None` keeps any existing secret.
    pub fn save(&self, entry: ApiKey, secret: Option<String>) -> AppResult<()> {
        if let Some(s) = secret {
            keychain_set(&entry.id, &s)?;
        }
        let mut d = self.inner.lock();
        if let Some(slot) = d.keys.iter_mut().find(|k| k.id == entry.id) {
            *slot = entry;
        } else {
            d.keys.push(entry);
        }
        self.persist(&d);
        Ok(())
    }

    pub fn remove(&self, id: &str) {
        keychain_delete(id);
        let mut d = self.inner.lock();
        d.keys.retain(|k| k.id != id);
        self.persist(&d);
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) {
        let mut d = self.inner.lock();
        if let Some(k) = d.keys.iter_mut().find(|k| k.id == id) {
            k.enabled = enabled;
        }
        self.persist(&d);
    }

    /// Flat env pairs for every enabled entry, secrets read from the keychain.
    /// Called at terminal-spawn time.
    pub fn resolved_env(&self) -> Vec<(String, String)> {
        let d = self.inner.lock();
        expand_env(&d.keys, keychain_secret)
    }
```

Add below the `impl` block (module level):

```rust
// ---- keychain ----

fn keyring_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("apikey-{id}")).ok()
}

fn keychain_secret(id: &str) -> Option<String> {
    keyring_entry(id)?.get_password().ok()
}

fn keychain_set(id: &str, secret: &str) -> AppResult<()> {
    keyring_entry(id)
        .ok_or_else(|| AppError::Msg("keychain unavailable".to_string()))?
        .set_password(secret)
        .map_err(|e| AppError::Msg(format!("keychain write failed: {e}")))
}

fn keychain_delete(id: &str) {
    if let Some(e) = keyring_entry(id) {
        let _ = e.delete_credential();
    }
}
```

- [ ] **Step 2: Add store-method tests (keychain-free paths)**

Append inside `mod tests`:

```rust
    #[test]
    fn save_upserts_and_set_enabled_toggles() {
        let dir = tempdir().unwrap();
        let store = ApiKeyStore::new(dir.path().join("keys.json"));
        store.save(key("a", "OPENAI_API_KEY", true), None).unwrap();
        store.save(key("b", "GROQ_API_KEY", true), None).unwrap();
        // upsert replaces in place, preserving order
        let mut edited = key("a", "OPENAI_API_KEY", true);
        edited.label = "renamed".to_string();
        store.save(edited, None).unwrap();
        store.set_enabled("b", false);

        let metas = store.list();
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].key.label, "renamed");
        assert!(!metas[1].key.enabled);
        assert!(!metas[0].has_value); // nothing in the keychain for test ids
    }

    #[test]
    fn remove_deletes_metadata() {
        let dir = tempdir().unwrap();
        let store = ApiKeyStore::new(dir.path().join("keys.json"));
        store.save(key("a", "OPENAI_API_KEY", true), None).unwrap();
        store.remove("a");
        assert!(store.list().is_empty());
    }
```

- [ ] **Step 3: Run tests**

Run: `cargo test apikeys` (from `src-tauri/`)
Expected: 8 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/apikeys/mod.rs
git commit -m "feat(apikeys): keychain-backed save/remove/list/resolved_env"
```

---

### Task 3: Env injection at PTY spawn (both spawn paths)

**Files:**
- Modify: `src-tauri/src/pty/mod.rs` (`CreateOpts` at ~line 175, `PtyManager::create` env block at ~line 216)
- Modify: `src-tauri/src/commands.rs` (`terminal_create`, ~line 140)
- Modify: `src-tauri/src/remote/bridge.rs` (`spawn_terminal`, ~line 92)
- Modify: `src-tauri/src/lib.rs` (manage the store)

No new unit tests here — `PtyManager::create` spawns real PTYs (no existing test harness for it). Correctness is covered by the Task 8 manual smoke test. Keep the change mechanical.

- [ ] **Step 1: Add `env` to `CreateOpts` and apply it in `create`**

In `src-tauri/src/pty/mod.rs`, extend the struct:

```rust
pub struct CreateOpts {
    pub id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub startup_command: Option<String>,
    /// Extra env pairs applied after TERM* and before shell-integration env.
    /// Later pairs override earlier ones (provider-key collision rule).
    pub env: Vec<(String, String)>,
}
```

In `PtyManager::create`, insert between the `TERM_PROGRAM_VERSION` line and the `prepared.env` loop:

```rust
        cmd.env("TERM_PROGRAM_VERSION", "1.1.0");
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        for (k, v) in &prepared.env {
```

- [ ] **Step 2: Manage the store and pass resolved env from both call sites**

In `src-tauri/src/lib.rs`:
- add `use apikeys::ApiKeyStore;` next to the other store imports;
- in `setup`, next to the other `app.manage(...)` lines:

```rust
            app.manage(ApiKeyStore::new(data_dir.join("keys.json")));
```

In `src-tauri/src/commands.rs::terminal_create`, change the `CreateOpts` construction:

```rust
    pty.create(
        &app,
        CreateOpts {
            id: id.clone(),
            cwd,
            shell: Some(shell.clone()),
            cols: args.cols.unwrap_or(80),
            rows: args.rows.unwrap_or(24),
            startup_command: args.startup_command.clone(),
            env: app.state::<crate::apikeys::ApiKeyStore>().resolved_env(),
        },
    )?;
```

In `src-tauri/src/remote/bridge.rs::spawn_terminal`, same addition:

```rust
    pty.create(
        app,
        CreateOpts {
            id: id.clone(),
            cwd: full_cwd,
            shell: Some(shell.clone()),
            cols: 80,
            rows: 24,
            startup_command,
            env: app.state::<crate::apikeys::ApiKeyStore>().resolved_env(),
        },
    )
    .map_err(|e| e.to_string())?;
```

- [ ] **Step 3: Verify both feature configurations compile and tests still pass**

Run (from `src-tauri/`):
- `cargo check`
- `cargo check --features remote-access` (bridge.rs is feature-gated)
- `cargo test`

Expected: clean checks; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pty/mod.rs src-tauri/src/commands.rs src-tauri/src/remote/bridge.rs src-tauri/src/lib.rs
git commit -m "feat(apikeys): inject provider env into every new terminal (desktop + remote spawn paths)"
```

---

### Task 4: CRUD Tauri commands

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`)

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, add the import near the other `crate::` imports:

```rust
use crate::apikeys::{ApiKey, ApiKeyMeta, ApiKeyStore};
```

(then simplify the Task 3 call site to `app.state::<ApiKeyStore>()`). Add a new section after the identity commands (~line 810):

```rust
// ---------- provider API keys ----------

#[tauri::command]
pub fn apikeys_list(store: State<ApiKeyStore>) -> Vec<ApiKeyMeta> {
    store.list()
}

#[tauri::command]
pub fn apikeys_save(
    store: State<ApiKeyStore>,
    entry: ApiKey,
    secret: Option<String>,
) -> AppResult<Vec<ApiKeyMeta>> {
    // Treat an empty paste as "no change" so the write-only field can be
    // submitted blank when editing.
    let secret = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    store.save(entry, secret)?;
    Ok(store.list())
}

#[tauri::command]
pub fn apikeys_remove(store: State<ApiKeyStore>, id: String) -> Vec<ApiKeyMeta> {
    store.remove(&id);
    store.list()
}

#[tauri::command]
pub fn apikeys_set_enabled(store: State<ApiKeyStore>, id: String, enabled: bool) -> Vec<ApiKeyMeta> {
    store.set_enabled(&id, enabled);
    store.list()
}
```

- [ ] **Step 2: Register in `lib.rs`**

Add to `generate_handler![]` after the `identity_*` entries:

```rust
            commands::apikeys_list,
            commands::apikeys_save,
            commands::apikeys_remove,
            commands::apikeys_set_enabled,
```

- [ ] **Step 3: Verify**

Run: `cargo check` then `cargo test` (from `src-tauri/`)
Expected: clean; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(apikeys): list/save/remove/set-enabled commands"
```

---

### Task 5: `apikeys_test` — reachability/auth check

**Files:**
- Modify: `src-tauri/src/apikeys/mod.rs` (pure request builder + `test_inputs`)
- Modify: `src-tauri/src/commands.rs` (async command)
- Modify: `src-tauri/src/lib.rs` (register)

- [ ] **Step 1: Write failing tests for the request builder**

Append inside `mod tests` in `src-tauri/src/apikeys/mod.rs`:

```rust
    #[test]
    fn test_request_anthropic_uses_x_api_key() {
        let r = build_test_request("anthropic", None, "sk-ant-x");
        assert_eq!(r.url, "https://api.anthropic.com/v1/models");
        assert!(r.headers.contains(&("x-api-key".to_string(), "sk-ant-x".to_string())));
        assert!(r
            .headers
            .iter()
            .any(|(k, v)| k == "anthropic-version" && !v.is_empty()));
    }

    #[test]
    fn test_request_openai_defaults_to_openai_base() {
        let r = build_test_request("openai", None, "sk-x");
        assert_eq!(r.url, "https://api.openai.com/v1/models");
        assert_eq!(
            r.headers,
            vec![("Authorization".to_string(), "Bearer sk-x".to_string())]
        );
    }

    #[test]
    fn test_request_respects_base_url_override_and_trailing_slash() {
        let r = build_test_request("deepseek", Some("https://api.deepseek.com/"), "sk-x");
        assert_eq!(r.url, "https://api.deepseek.com/models");
        let r2 = build_test_request("custom", Some("https://openrouter.ai/api/v1"), "sk-x");
        assert_eq!(r2.url, "https://openrouter.ai/api/v1/models");
    }
```

Run: `cargo test apikeys` — Expected: FAIL to compile (`build_test_request` not found).

- [ ] **Step 2: Implement the builder, result type, and `test_inputs`**

Add at module level in `src-tauri/src/apikeys/mod.rs`:

```rust
// ---- reachability test ----

pub struct TestRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TestResult {
    Ok,
    AuthFailed,
    Unreachable { message: String },
}

/// Build the auth-check request. Anthropic-format entries hit `<base>/v1/models`
/// with `x-api-key`; everything else is OpenAI-format: `<base>/models` with a
/// bearer token, where `<base>` is the entry's *_BASE_URL override as the CLI
/// would consume it (so it may or may not contain `/v1` — DeepSeek's doesn't,
/// OpenRouter's does; we append only `/models`).
pub fn build_test_request(provider: &str, base_url: Option<&str>, secret: &str) -> TestRequest {
    if provider == "anthropic" {
        let base = base_url
            .unwrap_or("https://api.anthropic.com")
            .trim_end_matches('/');
        TestRequest {
            url: format!("{base}/v1/models"),
            headers: vec![
                ("x-api-key".to_string(), secret.to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ],
        }
    } else {
        let base = base_url
            .unwrap_or("https://api.openai.com/v1")
            .trim_end_matches('/');
        TestRequest {
            url: format!("{base}/models"),
            headers: vec![("Authorization".to_string(), format!("Bearer {secret}"))],
        }
    }
}
```

Add inside `impl ApiKeyStore`:

```rust
    /// (provider, base-url override, secret) for the reachability test.
    /// Gathered under the lock and returned owned, so the async command never
    /// holds the lock across an await.
    pub fn test_inputs(&self, id: &str) -> AppResult<(String, Option<String>, String)> {
        let d = self.inner.lock();
        let k = d
            .keys
            .iter()
            .find(|k| k.id == id)
            .ok_or_else(|| AppError::Msg("key not found".to_string()))?;
        let base = k
            .extra_env
            .iter()
            .find(|(name, _)| name.ends_with("BASE_URL"))
            .map(|(_, v)| v.clone());
        let provider = k.provider.clone();
        drop(d);
        let secret =
            keychain_secret(id).ok_or_else(|| AppError::Msg("no API key stored".to_string()))?;
        Ok((provider, base, secret))
    }
```

Run: `cargo test apikeys` — Expected: 11 tests PASS.

- [ ] **Step 3: Add the async command and register it**

In `src-tauri/src/commands.rs` (extend the apikeys import with `TestResult`):

```rust
#[tauri::command]
pub async fn apikeys_test(store: State<'_, ApiKeyStore>, id: String) -> AppResult<TestResult> {
    let (provider, base, secret) = store.test_inputs(&id)?;
    let req = crate::apikeys::build_test_request(&provider, base.as_deref(), &secret);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let mut r = client.get(&req.url);
    for (k, v) in &req.headers {
        r = r.header(k, v);
    }
    Ok(match r.send().await {
        Ok(resp) if resp.status().is_success() => TestResult::Ok,
        Ok(resp)
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN =>
        {
            TestResult::AuthFailed
        }
        Ok(resp) => TestResult::Unreachable {
            message: format!("HTTP {}", resp.status()),
        },
        Err(e) => TestResult::Unreachable {
            message: e.to_string(),
        },
    })
}
```

Register `commands::apikeys_test,` in `lib.rs`'s `generate_handler![]`.

- [ ] **Step 4: Verify and commit**

Run: `cargo check` and `cargo test` (from `src-tauri/`) — Expected: clean, all PASS.

```bash
git add src-tauri/src/apikeys/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(apikeys): per-entry reachability/auth test command"
```

---

### Task 6: Detect & import keys from the environment

**Files:**
- Modify: `src-tauri/src/apikeys/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing tests**

Append inside `mod tests`:

```rust
    #[test]
    fn detect_skips_vars_already_stored_and_empty_values() {
        let existing = vec![key("a", "OPENAI_API_KEY", true)];
        let fake_env = |name: &str| match name {
            "OPENAI_API_KEY" => Some("sk-already".to_string()),
            "DEEPSEEK_API_KEY" => Some("sk-deep-1234".to_string()),
            "GROQ_API_KEY" => Some("   ".to_string()),
            _ => None,
        };
        let found = detect_candidates(&existing, fake_env);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].env_var, "DEEPSEEK_API_KEY");
        assert_eq!(found[0].masked_tail, "…1234");
    }

    #[test]
    fn mask_tail_handles_short_values() {
        assert_eq!(mask_tail("ab"), "…ab");
        assert_eq!(mask_tail("sk-abcdef"), "…cdef");
    }
```

Run: `cargo test apikeys` — Expected: FAIL to compile (`detect_candidates` not found).

- [ ] **Step 2: Implement**

Add at module level in `src-tauri/src/apikeys/mod.rs`:

```rust
// ---- import from environment ----

/// Key vars the detector looks for in the app's own process environment.
pub const KNOWN_ENV_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
    "GEMINI_API_KEY",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEnvKey {
    pub env_var: String,
    /// Last few characters for display — never the full value.
    pub masked_tail: String,
}

pub fn mask_tail(v: &str) -> String {
    let chars: Vec<char> = v.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("…{tail}")
}

/// Known key vars present in the environment that no stored entry uses yet.
pub fn detect_candidates(
    existing: &[ApiKey],
    get: impl Fn(&str) -> Option<String>,
) -> Vec<DetectedEnvKey> {
    let used: std::collections::HashSet<&str> =
        existing.iter().map(|k| k.key_env_var.as_str()).collect();
    KNOWN_ENV_VARS
        .iter()
        .filter(|name| !used.contains(**name))
        .filter_map(|name| {
            let v = get(name)?;
            let v = v.trim();
            if v.is_empty() {
                return None;
            }
            Some(DetectedEnvKey {
                env_var: name.to_string(),
                masked_tail: mask_tail(v),
            })
        })
        .collect()
}
```

Add inside `impl ApiKeyStore`:

```rust
    pub fn keys_snapshot(&self) -> Vec<ApiKey> {
        self.inner.lock().keys.clone()
    }
```

Run: `cargo test apikeys` — Expected: 13 tests PASS.

- [ ] **Step 3: Add the commands and register them**

In `src-tauri/src/commands.rs` (extend the apikeys import with `DetectedEnvKey`):

```rust
#[tauri::command]
pub fn apikeys_detect_env(store: State<ApiKeyStore>) -> Vec<DetectedEnvKey> {
    crate::apikeys::detect_candidates(&store.keys_snapshot(), |name| std::env::var(name).ok())
}

#[tauri::command]
pub fn apikeys_import_env(
    store: State<ApiKeyStore>,
    env_var: String,
    provider: String,
    label: String,
) -> AppResult<Vec<ApiKeyMeta>> {
    let secret = std::env::var(&env_var)
        .map_err(|_| AppError::Msg(format!("{env_var} is not set in the app's environment")))?;
    let entry = ApiKey {
        id: Uuid::new_v4().to_string(),
        provider,
        label,
        key_env_var: env_var,
        extra_env: Default::default(),
        enabled: true,
    };
    store.save(entry, Some(secret.trim().to_string()))?;
    Ok(store.list())
}
```

Register in `lib.rs`:

```rust
            commands::apikeys_detect_env,
            commands::apikeys_import_env,
```

- [ ] **Step 4: Verify and commit**

Run: `cargo check` and `cargo test` (from `src-tauri/`) — Expected: clean, all PASS.

```bash
git add src-tauri/src/apikeys/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(apikeys): detect and import provider keys from the environment"
```

---

### Task 7: Frontend — ipc types, presets + conflict helper, Zustand store

**Files:**
- Modify: `src/lib/ipc.ts`
- Create: `src/lib/apikey-presets.ts`
- Create: `src/state/apikeys.ts`
- Test: `src/lib/apikey-presets.test.ts`

- [ ] **Step 1: Add ipc types and wrappers**

In `src/lib/ipc.ts`, add types after the `DetectedGhAccount` interface:

```ts
export interface ApiKeyMeta {
  id: string
  /** preset id: anthropic | openai | deepseek | qwen | custom */
  provider: string
  label: string
  /** env var carrying the secret, e.g. OPENAI_API_KEY */
  keyEnvVar: string
  /** non-secret env injected alongside the key (base URLs etc.) */
  extraEnv: Record<string, string>
  enabled: boolean
  /** derived from the keychain; the secret itself never crosses IPC */
  hasValue: boolean
}

export type ApiKeyEntry = Omit<ApiKeyMeta, 'hasValue'>

export type ApiKeyTestResult =
  | { status: 'ok' }
  | { status: 'authFailed' }
  | { status: 'unreachable'; message: string }

export interface DetectedEnvKey {
  envVar: string
  maskedTail: string
}
```

Add to the `ipc` object after the `identity` group:

```ts
  apikeys: {
    list: () => invoke<ApiKeyMeta[]>('apikeys_list'),
    /** `secret` null/empty = keep the existing stored secret (write-only field). */
    save: (entry: ApiKeyEntry, secret: string | null) =>
      invoke<ApiKeyMeta[]>('apikeys_save', { entry, secret }),
    remove: (id: string) => invoke<ApiKeyMeta[]>('apikeys_remove', { id }),
    setEnabled: (id: string, enabled: boolean) =>
      invoke<ApiKeyMeta[]>('apikeys_set_enabled', { id, enabled }),
    test: (id: string) => invoke<ApiKeyTestResult>('apikeys_test', { id }),
    detectEnv: () => invoke<DetectedEnvKey[]>('apikeys_detect_env'),
    importEnv: (envVar: string, provider: string, label: string) =>
      invoke<ApiKeyMeta[]>('apikeys_import_env', { envVar, provider, label }),
  },
```

- [ ] **Step 2: Write the failing conflict-helper test**

Create `src/lib/apikey-presets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { envConflicts, PROVIDER_PRESETS, presetById } from './apikey-presets'

const entry = (
  id: string,
  keyEnvVar: string,
  enabled = true,
  extraEnv: Record<string, string> = {}
) => ({ id, provider: 'custom', label: id, keyEnvVar, extraEnv, enabled, hasValue: true })

describe('envConflicts', () => {
  it('reports vars defined by two or more enabled entries', () => {
    const conflicts = envConflicts([
      entry('a', 'OPENAI_API_KEY'),
      entry('b', 'OPENAI_API_KEY'),
      entry('c', 'GROQ_API_KEY'),
    ])
    expect(conflicts.get('OPENAI_API_KEY')).toEqual(['a', 'b'])
    expect(conflicts.has('GROQ_API_KEY')).toBe(false)
  })

  it('ignores disabled entries and counts extraEnv vars', () => {
    const conflicts = envConflicts([
      entry('a', 'DEEPSEEK_API_KEY', true, { OPENAI_BASE_URL: 'https://api.deepseek.com' }),
      entry('b', 'OPENAI_API_KEY', true, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }),
      entry('c', 'OPENAI_API_KEY', false),
    ])
    expect(conflicts.get('OPENAI_BASE_URL')).toEqual(['a', 'b'])
    expect(conflicts.has('OPENAI_API_KEY')).toBe(false)
  })
})

describe('presets', () => {
  it('every preset id is unique and resolvable', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(presetById(id)?.id).toBe(id)
  })
})
```

Run: `pnpm test` — Expected: FAIL (`./apikey-presets` does not exist).

- [ ] **Step 3: Implement presets + conflict helper**

Create `src/lib/apikey-presets.ts`:

```ts
export interface ProviderPreset {
  id: string
  name: string
  /** which auth check the backend runs; anthropic vs OpenAI-compatible */
  wire: 'anthropic' | 'openai'
  keyEnvVar: string
  extraEnv: Record<string, string>
}

/**
 * Presets only prefill the add-form; storage is fully generic, so any
 * OpenAI-compatible provider (OpenRouter, Groq, local vLLM, …) works via
 * "custom" with a base URL.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    wire: 'anthropic',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    extraEnv: {},
  },
  {
    id: 'openai',
    name: 'OpenAI / ChatGPT',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: {},
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    extraEnv: { OPENAI_BASE_URL: 'https://api.deepseek.com' },
  },
  {
    id: 'qwen',
    name: 'Qwen (DashScope)',
    wire: 'openai',
    keyEnvVar: 'DASHSCOPE_API_KEY',
    extraEnv: { OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: { OPENAI_BASE_URL: '' },
  },
]

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/**
 * env var -> ids of the enabled entries that define it, in list order, for
 * vars defined by 2+ entries. The last id in each list is the one that wins
 * at injection time (later stored entry overrides earlier).
 */
export function envConflicts(
  keys: {
    id: string
    enabled: boolean
    keyEnvVar: string
    extraEnv: Record<string, string>
  }[]
): Map<string, string[]> {
  const byVar = new Map<string, string[]>()
  for (const k of keys) {
    if (!k.enabled) continue
    for (const name of [k.keyEnvVar, ...Object.keys(k.extraEnv)]) {
      const list = byVar.get(name) ?? []
      if (!list.includes(k.id)) list.push(k.id)
      byVar.set(name, list)
    }
  }
  for (const [name, ids] of [...byVar]) {
    if (ids.length < 2) byVar.delete(name)
  }
  return byVar
}
```

Run: `pnpm test` — Expected: PASS (existing `claude-command` tests + 3 new).

- [ ] **Step 4: Create the Zustand store**

Create `src/state/apikeys.ts`:

```ts
import { create } from 'zustand'
import {
  ipc,
  type ApiKeyEntry,
  type ApiKeyMeta,
  type ApiKeyTestResult,
  type DetectedEnvKey,
} from '../lib/ipc'

interface ApiKeysState {
  keys: ApiKeyMeta[]
  loaded: boolean
  /** keys found in the environment, refreshed by detectEnv() */
  detected: DetectedEnvKey[]

  load: () => Promise<void>
  save: (entry: ApiKeyEntry, secret: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  test: (id: string) => Promise<ApiKeyTestResult>
  detectEnv: () => Promise<void>
  importEnv: (envVar: string, provider: string, label: string) => Promise<void>
}

export const useApiKeys = create<ApiKeysState>((set) => ({
  keys: [],
  loaded: false,
  detected: [],

  load: async () => {
    const keys = await ipc.apikeys.list()
    set({ keys, loaded: true })
  },

  save: async (entry, secret) => {
    const keys = await ipc.apikeys.save(entry, secret)
    set({ keys })
  },

  remove: async (id) => {
    const keys = await ipc.apikeys.remove(id)
    set({ keys })
  },

  setEnabled: async (id, enabled) => {
    const keys = await ipc.apikeys.setEnabled(id, enabled)
    set({ keys })
  },

  test: (id) => ipc.apikeys.test(id),

  detectEnv: async () => {
    const detected = await ipc.apikeys.detectEnv()
    set({ detected })
  },

  importEnv: async (envVar, provider, label) => {
    const keys = await ipc.apikeys.importEnv(envVar, provider, label)
    // The imported var is stored now, so it drops out of the candidates.
    const detected = await ipc.apikeys.detectEnv()
    set({ keys, detected })
  },
}))
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm test` and `pnpm typecheck` — Expected: PASS, no type errors.

```bash
git add src/lib/ipc.ts src/lib/apikey-presets.ts src/lib/apikey-presets.test.ts src/state/apikeys.ts
git commit -m "feat(apikeys): frontend ipc wrappers, provider presets, conflict helper, store"
```

---

### Task 8: Settings UI — Providers section

**Files:**
- Create: `src/components/apikeys/providers-section.tsx`
- Modify: `src/components/settings-modal.tsx` (import + render after `<AccountsSection />`, ~line 223)

UI components have no unit-test harness in this repo (components are untested; logic was tested in Task 7). Verification is `pnpm typecheck` + the manual smoke test.

- [ ] **Step 1: Create the component**

Create `src/components/apikeys/providers-section.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { type ApiKeyEntry, type ApiKeyMeta } from '../../lib/ipc'
import { envConflicts, PROVIDER_PRESETS, presetById } from '../../lib/apikey-presets'
import { useApiKeys } from '../../state/apikeys'

interface Draft {
  id: string
  provider: string
  label: string
  keyEnvVar: string
  extraEnv: { name: string; value: string }[]
  enabled: boolean
  /** write-only paste field; empty = keep the stored secret */
  secret: string
  hasValue: boolean
}

const draftFromPreset = (presetId: string): Draft => {
  const p = presetById(presetId) ?? PROVIDER_PRESETS[0]
  return {
    id: crypto.randomUUID(),
    provider: p.id,
    label: p.name,
    keyEnvVar: p.keyEnvVar,
    extraEnv: Object.entries(p.extraEnv).map(([name, value]) => ({ name, value })),
    enabled: true,
    secret: '',
    hasValue: false,
  }
}

const draftFromEntry = (k: ApiKeyMeta): Draft => ({
  id: k.id,
  provider: k.provider,
  label: k.label,
  keyEnvVar: k.keyEnvVar,
  extraEnv: Object.entries(k.extraEnv).map(([name, value]) => ({ name, value })),
  enabled: k.enabled,
  secret: '',
  hasValue: k.hasValue,
})

const entryFromDraft = (d: Draft): ApiKeyEntry => ({
  id: d.id,
  provider: d.provider,
  label: d.label.trim(),
  keyEnvVar: d.keyEnvVar.trim(),
  extraEnv: Object.fromEntries(
    d.extraEnv
      .map((p) => [p.name.trim(), p.value.trim()])
      .filter(([name, value]) => name && value)
  ),
  enabled: d.enabled,
})

/**
 * Provider API-key management, rendered as a section inside the Settings
 * modal. Keys are injected into terminals opened AFTER saving; secrets live in
 * the OS keychain and are never echoed back into the UI.
 */
export function ProvidersSection() {
  const keys = useApiKeys((s) => s.keys)
  const loaded = useApiKeys((s) => s.loaded)
  const detected = useApiKeys((s) => s.detected)
  const load = useApiKeys((s) => s.load)
  const save = useApiKeys((s) => s.save)
  const remove = useApiKeys((s) => s.remove)
  const setEnabled = useApiKeys((s) => s.setEnabled)
  const test = useApiKeys((s) => s.test)
  const detectEnv = useApiKeys((s) => s.detectEnv)
  const importEnv = useApiKeys((s) => s.importEnv)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) {
      void load()
      void detectEnv()
    }
  }, [loaded, load, detectEnv])

  const conflicts = envConflicts(keys)
  const labelOf = (id: string) => keys.find((k) => k.id === id)?.label ?? id

  /** Conflict note for one entry: which of its vars collide and who wins. */
  const conflictNote = (k: ApiKeyMeta): string | null => {
    if (!k.enabled) return null
    const vars = [k.keyEnvVar, ...Object.keys(k.extraEnv)]
    for (const v of vars) {
      const ids = conflicts.get(v)
      if (!ids || !ids.includes(k.id)) continue
      const winner = ids[ids.length - 1]
      return winner === k.id
        ? `${v} also set by ${ids
            .filter((i) => i !== k.id)
            .map(labelOf)
            .join(', ')} — this entry wins`
        : `${v} overridden by ${labelOf(winner)}`
    }
    return null
  }

  const canSave =
    !!draft &&
    !!draft.label.trim() &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.keyEnvVar.trim()) &&
    (draft.hasValue || !!draft.secret.trim())

  const onSave = async (): Promise<void> => {
    if (!draft || !canSave) return
    setBusy(true)
    try {
      await save(entryFromDraft(draft), draft.secret.trim() || null)
      setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  const onTest = async (id: string): Promise<void> => {
    setTestMsg((m) => ({ ...m, [id]: 'Testing…' }))
    try {
      const r = await test(id)
      setTestMsg((m) => ({
        ...m,
        [id]:
          r.status === 'ok'
            ? 'OK — key accepted'
            : r.status === 'authFailed'
              ? 'Auth failed — key rejected'
              : `Unreachable: ${r.message}`,
      }))
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: String(e) }))
    }
  }

  const onImport = async (envVar: string): Promise<void> => {
    const preset = PROVIDER_PRESETS.find((p) => p.keyEnvVar === envVar)
    await importEnv(envVar, preset?.id ?? 'custom', preset?.name ?? envVar)
  }

  const applyPreset = (presetId: string): void => {
    if (!draft) return
    const p = presetById(presetId)
    if (!p) return
    setDraft({
      ...draft,
      provider: p.id,
      label: draft.label || p.name,
      keyEnvVar: p.keyEnvVar,
      extraEnv: Object.entries(p.extraEnv).map(([name, value]) => ({ name, value })),
    })
  }

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          AI providers
        </div>
        <button
          type="button"
          onClick={() => setDraft(draftFromPreset('anthropic'))}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
        >
          + Add key
        </button>
      </div>

      <p className="mb-2 text-xs text-muted">
        Keys are stored in the OS keychain and injected into terminals opened after saving —
        CLIs like claude, aider, and codex pick them up automatically.
      </p>

      {/* key list */}
      <div className="flex flex-col gap-1">
        {keys.length === 0 && <div className="py-1 text-xs text-muted">No provider keys yet.</div>}
        {keys.map((k) => {
          const note = conflictNote(k)
          return (
            <div key={k.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {k.label}
                    <span className="ml-2 text-xs text-muted">
                      {presetById(k.provider)?.name ?? k.provider}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted">
                    {k.keyEnvVar} {k.hasValue ? '= ••••••••' : '(no value stored)'}
                    {Object.keys(k.extraEnv).length > 0 &&
                      ` · +${Object.keys(k.extraEnv).length} env`}
                  </div>
                </div>
                <label className="flex items-center gap-1 text-xs text-muted" title="Inject into new terminals">
                  <input
                    type="checkbox"
                    checked={k.enabled}
                    onChange={(e) => void setEnabled(k.id, e.target.checked)}
                  />
                  Enabled
                </label>
                <button
                  type="button"
                  onClick={() => void onTest(k.id)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(draftFromEntry(k))}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(k.id)}
                  className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-foreground/5"
                >
                  Delete
                </button>
              </div>
              {testMsg[k.id] && <div className="mt-1 text-xs text-muted">{testMsg[k.id]}</div>}
              {note && <div className="mt-1 text-xs text-danger">⚠ {note}</div>}
            </div>
          )
        })}
      </div>

      {/* import from environment */}
      {detected.length > 0 && (
        <div className="mt-3 rounded-md border border-border p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Found in your environment
          </div>
          {detected.map((d) => (
            <div key={d.envVar} className="flex items-center gap-2 py-1">
              <div className="min-w-0 flex-1 truncate text-xs text-foreground/80">
                {d.envVar} <span className="text-muted">({d.maskedTail})</span>
              </div>
              <button
                type="button"
                onClick={() => void onImport(d.envVar)}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
              >
                Import
              </button>
            </div>
          ))}
        </div>
      )}

      {/* add / edit form */}
      {draft && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3">
          <label className="block">
            <span className="text-xs text-muted">Provider preset</span>
            <select
              value={draft.provider}
              onChange={(e) => applyPreset(e.target.value)}
              className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Label"
            value={draft.label}
            onChange={(v) => setDraft({ ...draft, label: v })}
            placeholder="DeepSeek (personal)"
          />
          <label className="block">
            <span className="text-xs text-muted">
              API key {draft.hasValue && '(leave blank to keep the current value)'}
            </span>
            <input
              type="password"
              value={draft.secret}
              placeholder={draft.hasValue ? '••••••••  (unchanged)' : 'sk-…'}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              autoComplete="off"
              className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>
          <Field
            label="Key env var"
            value={draft.keyEnvVar}
            onChange={(v) => setDraft({ ...draft, keyEnvVar: v })}
            placeholder="OPENAI_API_KEY"
          />
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-muted">Extra env (base URLs etc. — not secret)</span>
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, extraEnv: [...draft.extraEnv, { name: '', value: '' }] })
                }
                className="rounded border border-border px-2 py-0.5 text-xs hover:bg-foreground/5"
              >
                + Add pair
              </button>
            </div>
            {draft.extraEnv.map((pair, i) => (
              <div key={i} className="mb-1 flex items-center gap-1">
                <input
                  type="text"
                  value={pair.name}
                  placeholder="OPENAI_BASE_URL"
                  onChange={(e) => {
                    const extraEnv = [...draft.extraEnv]
                    extraEnv[i] = { ...pair, name: e.target.value }
                    setDraft({ ...draft, extraEnv })
                  }}
                  className="w-2/5 rounded border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                />
                <input
                  type="text"
                  value={pair.value}
                  placeholder="https://…"
                  onChange={(e) => {
                    const extraEnv = [...draft.extraEnv]
                    extraEnv[i] = { ...pair, value: e.target.value }
                    setDraft({ ...draft, extraEnv })
                  }}
                  className="flex-1 rounded border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, extraEnv: draft.extraEnv.filter((_, j) => j !== i) })
                  }
                  className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-foreground/5"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave || busy}
              onClick={() => void onSave()}
              className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
      />
    </label>
  )
}
```

- [ ] **Step 2: Render it in the settings modal**

In `src/components/settings-modal.tsx`:
- add the import next to `AccountsSection`:

```ts
import { ProvidersSection } from './apikeys/providers-section'
```

- render it right after `<AccountsSection />` (~line 223):

```tsx
        <AccountsSection />

        <ProvidersSection />
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck` then `pnpm test`
Expected: no type errors; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/apikeys/providers-section.tsx src/components/settings-modal.tsx
git commit -m "feat(apikeys): AI Providers settings section — presets, write-only key field, test/import, conflict warnings"
```

---

### Task 9: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full suites**

From `src-tauri/`: `cargo test` and `cargo check --features remote-access`
From repo root: `pnpm test` and `pnpm typecheck`
Expected: everything green.

- [ ] **Step 2: Manual smoke test (requires a dev run)**

Launch the app: `pnpm tauri dev` (use `TW_DATA_DIR` for an isolated data dir if you don't want to touch real app data: set `TW_DATA_DIR` to a temp folder first).

1. Settings → AI providers → **+ Add key** → preset DeepSeek → paste any placeholder value (e.g. `sk-test-1234`) → Save. Entry appears with `DEEPSEEK_API_KEY = ••••••••`.
2. Open a **new** terminal in any project. Run `echo $env:DEEPSEEK_API_KEY` (PowerShell) or `echo $DEEPSEEK_API_KEY` (bash). Expected: the placeholder value prints, plus `echo $env:OPENAI_BASE_URL` prints `https://api.deepseek.com`.
3. In a terminal opened **before** saving, the var must NOT be set (no retroactive injection).
4. Toggle the entry off → open another new terminal → var absent.
5. Click **Test** on the entry. Expected: "Auth failed — key rejected" for the placeholder (proves the request went out and got a 401), or "OK" with a real key.
6. Edit the entry, leave the key field blank, change the label, Save → `hasValue` still true (secret kept).
7. Delete the entry → `keys.json` in the app-data dir no longer lists it.

- [ ] **Step 3: Update the proposal doc status**

In `docs/multi-llm-provider-keys.md`, change the status line:

```markdown
**Status:** Implemented (v1) — see `docs/superpowers/specs/2026-07-03-multi-llm-provider-keys-design.md` for the locked decisions.
```

- [ ] **Step 4: Commit**

```bash
git add docs/multi-llm-provider-keys.md
git commit -m "docs: mark multi-LLM provider keys v1 as implemented"
```
