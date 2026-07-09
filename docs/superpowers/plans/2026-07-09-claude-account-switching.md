# Claude Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage multiple claude.ai subscription accounts in the app — OAuth login, import-from-CLI, one-click switch (writes `~/.claude/.credentials.json`), per-account 5h/7d usage bars — surfaced as a title-bar pill + popover and a Settings section.

**Architecture:** New Rust domain `src-tauri/src/claude/{creds,accounts,oauth,usage}.rs` following the `ApiKeyStore` house pattern (JSON metadata + OS-keychain secrets + `parking_lot::Mutex`). Switching captures the CLI's rotated tokens back into the store, then writes the target account's credentials to `~/.claude/.credentials.json` and disables enabled Anthropic provider keys. Usage is fetched per account from Anthropic's OAuth usage endpoint with lazy token refresh; the frontend polls every 5 minutes.

**Tech Stack:** Rust (Tauri 2, reqwest, keyring, sha2/base64/rand for PKCE), React 19 + zustand + Tailwind 4, vitest.

**Spec:** `docs/superpowers/specs/2026-07-09-claude-account-switching-design.md`

**Verified constants (from Agent-Orchestrator source — do not re-derive):**
- Authorize URL: `https://claude.ai/oauth/authorize`
- Token endpoint: `https://platform.claude.com/v1/oauth/token` — **JSON body**, not form-encoded
- Client id: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Profile: `GET https://api.anthropic.com/api/oauth/profile` (Bearer)
- Usage: `GET https://api.anthropic.com/api/oauth/usage` (Bearer + header `anthropic-beta: oauth-2025-04-20`)
- Exchange body: `{grant_type:"authorization_code", code, code_verifier, redirect_uri, client_id, state}`
- Refresh body: `{grant_type:"refresh_token", refresh_token, client_id}`
- Token response: `{access_token, refresh_token, expires_in (seconds), token_type:"Bearer"}`
- Credentials file: `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`), shape `{"claudeAiOauth": {"accessToken", "refreshToken"?, "expiresAt"? (epoch ms), "scopes"?, "subscriptionType"?}}` — unknown sibling/inner fields must survive a rewrite.

**Security rules for every task:** never log token values; never return tokens across IPC; keychain write failures abort the metadata save.

**Working style:** run commands from the repo root `C:/Users/Patrick Ackom/Desktop/repos/tw/terminal-workspace-rust`. Rust tests: `cd src-tauri && cargo test <filter>`. TS: `pnpm test`, `pnpm typecheck`. Commit after each task (no Co-Authored-By trailer; commit directly on master).

---

### Task 1: Cargo deps + credentials-file module (`claude/creds.rs`)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/claude/creds.rs`
- Modify: `src-tauri/src/claude/mod.rs` (add `pub mod creds;`)

- [ ] **Step 1: Make `base64` + `rand` non-optional, add `sha2`**

In `src-tauri/Cargo.toml`: change lines 55–56 from optional to regular deps and add sha2:

```toml
base64 = "0.22"
rand = "0.8"
sha2 = "0.10"
```

Then remove `"dep:base64",` and `"dep:rand",` from the `remote-access` feature array (they'd be a compile error once the deps are non-optional). Leave `ring` optional.

- [ ] **Step 2: Write failing tests in `claude/creds.rs`**

Create the file with module skeleton + tests first:

```rust
//! Read/write `~/.claude/.credentials.json` — the Claude CLI's OAuth
//! credentials file. The `claudeAiOauth` block is handled as raw JSON so
//! fields this app doesn't know about survive a rewrite.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const EXPIRY_BUFFER_MS: i64 = 5 * 60 * 1000;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn path_defaults_to_home_dot_claude() {
        let p = credentials_path_from(Path::new("/home/u"), None);
        assert_eq!(p, Path::new("/home/u").join(".claude").join(".credentials.json"));
    }

    #[test]
    fn path_honors_claude_config_dir() {
        let p = credentials_path_from(Path::new("/home/u"), Some("/custom/dir".into()));
        assert_eq!(p, Path::new("/custom/dir").join(".credentials.json"));
    }

    #[test]
    fn read_returns_oauth_block() {
        let dir = tempdir().unwrap();
        let f = dir.path().join(".credentials.json");
        std::fs::write(&f, r#"{"claudeAiOauth":{"accessToken":"tok-a","expiresAt":123},"other":1}"#).unwrap();
        let v = read_credentials_file(&f).unwrap();
        assert_eq!(creds_str(&v, "accessToken").as_deref(), Some("tok-a"));
        assert_eq!(creds_i64(&v, "expiresAt"), Some(123));
    }

    #[test]
    fn read_missing_or_malformed_is_none() {
        let dir = tempdir().unwrap();
        assert!(read_credentials_file(&dir.path().join("nope.json")).is_none());
        let f = dir.path().join("bad.json");
        std::fs::write(&f, "{not json").unwrap();
        assert!(read_credentials_file(&f).is_none());
        let f2 = dir.path().join("empty-block.json");
        std::fs::write(&f2, r#"{"claudeAiOauth":{"expiresAt":1}}"#).unwrap();
        assert!(read_credentials_file(&f2).is_none()); // no accessToken -> unusable
    }

    #[test]
    fn write_preserves_unknown_siblings_and_creates_dirs() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("nested").join(".credentials.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, r#"{"claudeAiOauth":{"accessToken":"old","weird":true},"sibling":{"keep":1}}"#).unwrap();
        let new_block: Value = serde_json::from_str(r#"{"accessToken":"new","refreshToken":"r1"}"#).unwrap();
        write_credentials_file(&f, &new_block).unwrap();
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(after["claudeAiOauth"]["accessToken"], "new");
        assert_eq!(after["sibling"]["keep"], 1);           // sibling preserved
        assert!(after["claudeAiOauth"].get("weird").is_none()); // block replaced whole

        // Writing when no file exists yet also works.
        let f2 = dir.path().join("fresh").join(".credentials.json");
        write_credentials_file(&f2, &new_block).unwrap();
        let after2: Value = serde_json::from_str(&std::fs::read_to_string(&f2).unwrap()).unwrap();
        assert_eq!(after2["claudeAiOauth"]["refreshToken"], "r1");
    }

    #[test]
    fn needs_refresh_uses_buffer_and_fails_safe() {
        let now = 1_000_000_000;
        assert!(needs_refresh(None, now));                              // unknown expiry -> refresh
        assert!(needs_refresh(Some(now - 1), now));                     // expired
        assert!(needs_refresh(Some(now + EXPIRY_BUFFER_MS - 1), now));  // inside buffer
        assert!(!needs_refresh(Some(now + EXPIRY_BUFFER_MS + 1), now)); // comfortably valid
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test creds`
Expected: FAIL — `credentials_path_from`, `read_credentials_file`, etc. not found.

- [ ] **Step 4: Implement**

Add above the tests:

```rust
/// Resolve the credentials file path. `config_dir_override` is
/// `$CLAUDE_CONFIG_DIR` when set (tested seam); callers pass the env var.
pub fn credentials_path_from(home: &Path, config_dir_override: Option<String>) -> PathBuf {
    match config_dir_override.filter(|s| !s.trim().is_empty()) {
        Some(dir) => PathBuf::from(dir).join(".credentials.json"),
        None => home.join(".claude").join(".credentials.json"),
    }
}

pub fn credentials_path(home: &Path) -> PathBuf {
    credentials_path_from(home, std::env::var("CLAUDE_CONFIG_DIR").ok())
}

/// The `claudeAiOauth` block, only when it exists and carries an accessToken.
/// Missing file / malformed JSON / unusable block all read as None — callers
/// treat "no credentials" and "unreadable credentials" the same way.
pub fn read_credentials_file(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    let block = root.get("claudeAiOauth")?.clone();
    block.get("accessToken")?.as_str().filter(|s| !s.is_empty())?;
    Some(block)
}

/// Replace the `claudeAiOauth` block, preserving unknown sibling keys.
/// Atomic tmp+rename, creating parent dirs as needed.
pub fn write_credentials_file(path: &Path, oauth_block: &Value) -> AppResult<()> {
    let mut root: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    if !root.is_object() {
        root = Value::Object(Default::default());
    }
    root.as_object_mut()
        .expect("root forced to object above")
        .insert("claudeAiOauth".to_string(), oauth_block.clone());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::Msg(e.to_string()))?;
    }
    let s = serde_json::to_string_pretty(&root).map_err(|e| AppError::Msg(e.to_string()))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, s).map_err(|e| AppError::Msg(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

pub fn creds_str(block: &Value, key: &str) -> Option<String> {
    block.get(key)?.as_str().map(str::to_string)
}

pub fn creds_i64(block: &Value, key: &str) -> Option<i64> {
    block.get(key)?.as_i64()
}

/// True when the token should be refreshed before use. Unknown expiry fails
/// safe (refresh).
pub fn needs_refresh(expires_at_ms: Option<i64>, now_ms: i64) -> bool {
    match expires_at_ms {
        Some(exp) => now_ms >= exp - EXPIRY_BUFFER_MS,
        None => true,
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```

Add `pub mod creds;` after `pub mod hooks;` in `src-tauri/src/claude/mod.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test creds`
Expected: all creds tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/claude/creds.rs src-tauri/src/claude/mod.rs
git commit -m "feat(claude): credentials file read/write module"
```

---

### Task 2: Account store (`claude/accounts.rs`)

**Files:**
- Create: `src-tauri/src/claude/accounts.rs`
- Modify: `src-tauri/src/claude/mod.rs` (add `pub mod accounts;`)

- [ ] **Step 1: Write the store with failing tests**

```rust
//! Managed claude.ai accounts: non-secret metadata on disk, OAuth token blobs
//! in the OS keychain (service com.patt-rick.terminalworkspace, user
//! `claude-oauth-<id>`). Mirrors the ApiKeyStore pattern.

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "com.patt-rick.terminalworkspace";

/// Env vars stripped from new terminals while a login account is active, so a
/// stray machine-level token can't override the switched account.
pub const AMBIENT_CLAUDE_ENV: &[&str] = &["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccount {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    /// raw Anthropic rate_limit_tier, e.g. "max_20x"
    pub plan: Option<String>,
    /// epoch millis
    pub added_at: i64,
    /// refresh token rejected (invalid_grant) — needs re-login
    #[serde(default)]
    pub refresh_dead: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountMeta {
    #[serde(flatten)]
    pub account: ClaudeAccount,
    pub has_token: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAccountsList {
    pub accounts: Vec<ClaudeAccountMeta>,
    pub active_account_id: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    #[serde(default)]
    accounts: Vec<ClaudeAccount>,
    #[serde(default)]
    active_account_id: Option<String>,
    /// accessToken this app last wrote to (or absorbed from) the credentials
    /// file — drift detection baseline. Not a secret by itself but still only
    /// ever compared, never logged.
    #[serde(default)]
    last_synced_access_token: Option<String>,
}

/// One cached usage result per account (10-minute TTL).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedUsage {
    pub usage: Option<crate::claude::usage::ClaudeUsage>,
    pub error: Option<String>,
    pub fetched_at: i64,
}

pub const USAGE_TTL_MS: i64 = 10 * 60 * 1000;

pub struct ClaudeAccountStore {
    path: PathBuf,
    inner: Mutex<Data>,
    usage_cache: Mutex<HashMap<String, CachedUsage>>,
}

impl ClaudeAccountStore {
    pub fn new(path: PathBuf) -> Self {
        let inner = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
            usage_cache: Mutex::new(HashMap::new()),
        }
    }

    fn persist(&self, data: &Data) {
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

    pub fn list(&self) -> ClaudeAccountsList {
        let d = self.inner.lock();
        ClaudeAccountsList {
            accounts: d
                .accounts
                .iter()
                .cloned()
                .map(|a| {
                    let has_token = keychain_creds(&a.id).is_some();
                    ClaudeAccountMeta { account: a, has_token }
                })
                .collect(),
            active_account_id: d.active_account_id.clone(),
        }
    }

    pub fn accounts_snapshot(&self) -> Vec<ClaudeAccount> {
        self.inner.lock().accounts.clone()
    }

    pub fn account_by_email(&self, email: &str) -> Option<ClaudeAccount> {
        self.inner
            .lock()
            .accounts
            .iter()
            .find(|a| a.email.eq_ignore_ascii_case(email))
            .cloned()
    }

    pub fn has_active_login_account(&self) -> bool {
        self.inner.lock().active_account_id.is_some()
    }

    /// Upsert by email: re-adding an account refreshes the existing record
    /// (same id, refresh_dead cleared). Keychain is written FIRST — a keychain
    /// failure aborts so metadata never claims a token it doesn't have.
    pub fn upsert(&self, mut account: ClaudeAccount, creds: &Value) -> AppResult<ClaudeAccount> {
        let existing_id = self
            .inner
            .lock()
            .accounts
            .iter()
            .find(|a| a.email.eq_ignore_ascii_case(&account.email))
            .map(|a| a.id.clone());
        if let Some(id) = existing_id {
            account.id = id;
        }
        account.refresh_dead = false;
        keychain_set_creds(&account.id, creds)?;
        let mut d = self.inner.lock();
        if let Some(slot) = d.accounts.iter_mut().find(|a| a.id == account.id) {
            *slot = account.clone();
        } else {
            d.accounts.push(account.clone());
        }
        self.persist(&d);
        Ok(account)
    }

    pub fn remove(&self, id: &str) {
        keychain_delete_creds(id);
        self.usage_cache.lock().remove(id);
        let mut d = self.inner.lock();
        d.accounts.retain(|a| a.id != id);
        if d.active_account_id.as_deref() == Some(id) {
            d.active_account_id = None;
        }
        self.persist(&d);
    }

    pub fn set_active(&self, id: Option<String>) {
        let mut d = self.inner.lock();
        d.active_account_id = id;
        self.persist(&d);
    }

    pub fn set_refresh_dead(&self, id: &str, dead: bool) {
        let mut d = self.inner.lock();
        if let Some(a) = d.accounts.iter_mut().find(|a| a.id == id) {
            a.refresh_dead = dead;
        }
        self.persist(&d);
    }

    pub fn last_synced_access_token(&self) -> Option<String> {
        self.inner.lock().last_synced_access_token.clone()
    }

    pub fn set_last_synced_access_token(&self, token: Option<String>) {
        let mut d = self.inner.lock();
        d.last_synced_access_token = token;
        self.persist(&d);
    }

    /// Update stored credentials for an account (e.g. after refresh or
    /// capture-back). Keychain only — metadata unchanged.
    pub fn set_creds(&self, id: &str, creds: &Value) -> AppResult<()> {
        keychain_set_creds(id, creds)
    }

    pub fn creds(&self, id: &str) -> Option<Value> {
        keychain_creds(id)
    }

    pub fn cached_usage(&self, id: &str, now_ms: i64) -> Option<CachedUsage> {
        let cache = self.usage_cache.lock();
        let entry = cache.get(id)?;
        if now_ms - entry.fetched_at < USAGE_TTL_MS {
            Some(entry.clone())
        } else {
            None
        }
    }

    /// Stale entry regardless of TTL (kept for stale-while-error display).
    pub fn stale_usage(&self, id: &str) -> Option<CachedUsage> {
        self.usage_cache.lock().get(id).cloned()
    }

    pub fn put_usage(&self, id: &str, entry: CachedUsage) {
        self.usage_cache.lock().insert(id.to_string(), entry);
    }
}

// ---- keychain ----

fn keyring_entry(id: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("claude-oauth-{id}")).ok()
}

fn keychain_creds(id: &str) -> Option<Value> {
    let text = keyring_entry(id)?.get_password().ok()?;
    serde_json::from_str(&text).ok()
}

fn keychain_set_creds(id: &str, creds: &Value) -> AppResult<()> {
    let text = serde_json::to_string(creds).map_err(|e| AppError::Msg(e.to_string()))?;
    keyring_entry(id)
        .ok_or_else(|| AppError::Msg("keychain unavailable".to_string()))?
        .set_password(&text)
        .map_err(|e| AppError::Msg(format!("keychain write failed: {e}")))
}

fn keychain_delete_creds(id: &str) {
    if let Some(e) = keyring_entry(id) {
        let _ = e.delete_credential();
    }
}
```

Tests (same file; note keychain calls succeed on the dev machine — tests must not rely on absence/presence of real keychain state, so they use unique ids and clean up):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn acct(id: &str, email: &str) -> ClaudeAccount {
        ClaudeAccount {
            id: id.to_string(),
            email: email.to_string(),
            display_name: None,
            plan: Some("max_20x".to_string()),
            added_at: 1,
            refresh_dead: false,
        }
    }

    fn creds(token: &str) -> Value {
        serde_json::json!({ "accessToken": token, "refreshToken": "r", "expiresAt": 9_999_999_999_999i64 })
    }

    #[test]
    fn upsert_dedupes_by_email_and_clears_dead() {
        let dir = tempdir().unwrap();
        let store = ClaudeAccountStore::new(dir.path().join("a.json"));
        let uid = format!("test-{}", uuid::Uuid::new_v4());
        let uid2 = format!("test-{}", uuid::Uuid::new_v4());
        store.upsert(acct(&uid, "x@y.z"), &creds("t1")).unwrap();
        store.set_refresh_dead(&uid, true);
        // Re-login with a NEW id but same email reuses the original id.
        let saved = store.upsert(acct(&uid2, "X@Y.Z"), &creds("t2")).unwrap();
        assert_eq!(saved.id, uid);
        let list = store.list();
        assert_eq!(list.accounts.len(), 1);
        assert!(!list.accounts[0].account.refresh_dead);
        store.remove(&uid); // cleanup keychain
    }

    #[test]
    fn remove_clears_active_and_roundtrips_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.json");
        let uid = format!("test-{}", uuid::Uuid::new_v4());
        {
            let store = ClaudeAccountStore::new(path.clone());
            store.upsert(acct(&uid, "a@b.c"), &creds("t")).unwrap();
            store.set_active(Some(uid.clone()));
            store.set_last_synced_access_token(Some("t".to_string()));
        }
        let store = ClaudeAccountStore::new(path); // reload from disk
        assert!(store.has_active_login_account());
        assert_eq!(store.last_synced_access_token().as_deref(), Some("t"));
        store.remove(&uid);
        assert!(!store.has_active_login_account());
        assert!(store.list().accounts.is_empty());
    }

    #[test]
    fn usage_cache_respects_ttl() {
        let dir = tempdir().unwrap();
        let store = ClaudeAccountStore::new(dir.path().join("a.json"));
        let entry = CachedUsage { usage: None, error: Some("e".into()), fetched_at: 1000 };
        store.put_usage("id1", entry);
        assert!(store.cached_usage("id1", 1000 + USAGE_TTL_MS - 1).is_some());
        assert!(store.cached_usage("id1", 1000 + USAGE_TTL_MS + 1).is_none());
        assert!(store.stale_usage("id1").is_some()); // stale still readable
    }

    #[test]
    fn creds_roundtrip_through_keychain() {
        let dir = tempdir().unwrap();
        let store = ClaudeAccountStore::new(dir.path().join("a.json"));
        let uid = format!("test-{}", uuid::Uuid::new_v4());
        store.upsert(acct(&uid, "kc@t.t"), &creds("tok-round")).unwrap();
        let v = store.creds(&uid).expect("creds stored");
        assert_eq!(v["accessToken"], "tok-round");
        store.remove(&uid);
        assert!(store.creds(&uid).is_none());
    }
}
```

`usage::ClaudeUsage` doesn't exist yet — add a temporary placeholder so this task compiles standalone: in `claude/mod.rs` add `pub mod accounts;` and create a stub `src-tauri/src/claude/usage.rs` containing only:

```rust
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub fetched_at: i64,
}
```

with `pub mod usage;` in `claude/mod.rs` (Task 4 replaces the stub with the real module).

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test accounts`
Expected: PASS (4 tests). If keychain tests fail on CI-like environments, they may be marked `#[ignore]` — on this dev machine (Windows Credential Manager) they must pass.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/claude/accounts.rs src-tauri/src/claude/usage.rs src-tauri/src/claude/mod.rs
git commit -m "feat(claude): managed account store with keychain-backed tokens"
```

---

### Task 3: OAuth module (`claude/oauth.rs`)

**Files:**
- Create: `src-tauri/src/claude/oauth.rs`
- Modify: `src-tauri/src/claude/mod.rs` (add `pub mod oauth;`)

- [ ] **Step 1: Write tests first** (PKCE shape, callback parsing, state compare)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_is_base64url_and_s256() {
        let (verifier, challenge) = pkce_pair();
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert!(verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // challenge must equal base64url(sha256(verifier))
        use sha2::{Digest, Sha256};
        let expect = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            Sha256::digest(verifier.as_bytes()),
        );
        assert_eq!(challenge, expect);
        // two calls differ
        assert_ne!(pkce_pair().0, verifier);
    }

    #[test]
    fn parses_callback_query() {
        let r = parse_callback_path("/callback?code=abc123&state=st-1");
        assert_eq!(r, Some(("abc123".to_string(), "st-1".to_string())));
        // reversed param order
        let r2 = parse_callback_path("/callback?state=st-1&code=abc123");
        assert_eq!(r2, Some(("abc123".to_string(), "st-1".to_string())));
        // url-encoded characters decode
        let r3 = parse_callback_path("/callback?code=a%2Bb&state=s");
        assert_eq!(r3, Some(("a+b".to_string(), "s".to_string())));
        assert_eq!(parse_callback_path("/callback?code=only"), None);
        assert_eq!(parse_callback_path("/favicon.ico"), None);
    }

    #[test]
    fn state_compare_is_exact() {
        assert!(constant_time_eq(b"same-state", b"same-state"));
        assert!(!constant_time_eq(b"same-state", b"other-stat"));
        assert!(!constant_time_eq(b"short", b"longer-state"));
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let url = build_authorize_url("challenge-x", "state-y", 8123, Some("hint@x.y"));
        assert!(url.starts_with("https://claude.ai/oauth/authorize?"));
        for needle in [
            "client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "response_type=code",
            "code_challenge=challenge-x",
            "code_challenge_method=S256",
            "state=state-y",
            "redirect_uri=http%3A%2F%2Flocalhost%3A8123%2Fcallback",
            "login_hint=hint%40x.y",
        ] {
            assert!(url.contains(needle), "missing {needle} in {url}");
        }
        assert!(url.contains("scope=org%3Acreate_api_key+user%3Aprofile")
            || url.contains("scope=org%3Acreate_api_key%20user%3Aprofile"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test oauth`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the module**

```rust
//! PKCE OAuth against claude.ai (the flow Claude Code itself uses) plus the
//! token/profile HTTP calls. Constants verified against Agent-Orchestrator's
//! auth-service.ts / auth-token-endpoint-gateway.ts.

use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const TOKEN_ENDPOINT: &str = "https://platform.claude.com/v1/oauth/token";
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const OAUTH_SCOPES: &[&str] = &[
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub fn pkce_pair() -> (String, String) {
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn build_authorize_url(
    challenge: &str,
    state: &str,
    port: u16,
    login_hint: Option<&str>,
) -> String {
    let redirect = format!("http://localhost:{port}/callback");
    let mut url = format!(
        "{AUTHORIZE_URL}?client_id={CLIENT_ID}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        urlencode(&redirect),
        urlencode(&OAUTH_SCOPES.join(" ")),
        urlencode(challenge),
        urlencode(state),
    );
    if let Some(hint) = login_hint {
        url.push_str(&format!("&login_hint={}", urlencode(hint)));
    }
    url
}

/// Minimal percent-encoding for query values (RFC 3986 unreserved kept).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                    16,
                ) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Extract (code, state) from the callback request path.
pub fn parse_callback_path(path: &str) -> Option<(String, String)> {
    let query = path.strip_prefix("/callback?")?;
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "code" => code = Some(urldecode(v)),
            "state" => state = Some(urldecode(v)),
            _ => {}
        }
    }
    Some((code?, state?))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Block until the browser hits /callback with a valid state, the timeout
/// elapses, or `cancel` flips. Runs on a blocking thread (spawn_blocking).
pub fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> AppResult<String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Msg("login cancelled".to_string()));
        }
        if Instant::now() >= deadline {
            return Err(AppError::Msg(
                "login timed out after 5 minutes — no response from browser".to_string(),
            ));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("");
                let parsed = parse_callback_path(path);
                let ok = parsed
                    .as_ref()
                    .map(|(_, s)| constant_time_eq(s.as_bytes(), expected_state.as_bytes()))
                    .unwrap_or(false);
                let body = if ok {
                    "<html><body style=\"font-family:sans-serif\"><h3>Signed in.</h3>You can close this tab and return to Terminal Workspace.</body></html>"
                } else {
                    "<html><body style=\"font-family:sans-serif\"><h3>Login failed.</h3>Invalid callback — return to the app and try again.</body></html>"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
                if ok {
                    return Ok(parsed.expect("checked above").0);
                }
                // Not our callback (favicon, wrong state) — keep listening.
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(AppError::Msg(e.to_string())),
        }
    }
}

// ---- HTTP calls (token endpoint takes JSON bodies) ----

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    /// seconds
    pub expires_in: i64,
}

pub async fn exchange_code(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    state: &str,
) -> AppResult<TokenResponse> {
    let resp = client
        .post(TOKEN_ENDPOINT)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "state": state,
        }))
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("token exchange failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Msg(format!("token exchange failed: HTTP {status}")));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| AppError::Msg(format!("token exchange returned invalid response: {e}")))
}

pub enum RefreshOutcome {
    Fresh(TokenResponse),
    /// invalid_grant — the refresh token is dead; re-login required.
    Dead,
    /// transient failure (network / 429 / 5xx) — try again later.
    Transient(String),
}

pub async fn do_refresh(client: &reqwest::Client, refresh_token: &str) -> RefreshOutcome {
    let resp = client
        .post(TOKEN_ENDPOINT)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return RefreshOutcome::Transient(e.to_string()),
    };
    let status = resp.status();
    if status.is_success() {
        return match resp.json::<TokenResponse>().await {
            Ok(t) => RefreshOutcome::Fresh(t),
            Err(e) => RefreshOutcome::Transient(format!("invalid refresh response: {e}")),
        };
    }
    let body = resp.text().await.unwrap_or_default();
    // 400/401 with invalid_grant = dead token. Anything else is transient.
    if (status == 400 || status == 401) && body.contains("invalid_grant") {
        RefreshOutcome::Dead
    } else {
        RefreshOutcome::Transient(format!("HTTP {status}"))
    }
}

pub struct Profile {
    pub email: String,
    pub display_name: Option<String>,
    pub plan: Option<String>,
}

/// Fetch the account profile for a token. Email is required; a response
/// without one is an error (we key accounts by email).
pub async fn fetch_profile(client: &reqwest::Client, access_token: &str) -> AppResult<Profile> {
    let resp = client
        .get(PROFILE_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("profile fetch failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Msg(format!("profile fetch failed: HTTP {status}")));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Msg(format!("profile returned invalid JSON: {e}")))?;
    let account = v.get("account");
    let email = account
        .and_then(|a| a.get("email"))
        .and_then(|e| e.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Msg("profile response had no email".to_string()))?
        .to_string();
    let display_name = account
        .and_then(|a| a.get("display_name").or_else(|| a.get("full_name")))
        .and_then(|d| d.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let plan = v
        .get("organization")
        .and_then(|o| o.get("rate_limit_tier"))
        .and_then(|p| p.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(Profile { email, display_name, plan })
}
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test oauth`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude/oauth.rs src-tauri/src/claude/mod.rs
git commit -m "feat(claude): PKCE OAuth flow with localhost callback"
```

---

### Task 4: Usage module (`claude/usage.rs`, replaces the Task-2 stub)

**Files:**
- Rewrite: `src-tauri/src/claude/usage.rs`

- [ ] **Step 1: Write the module with tests**

```rust
//! Anthropic OAuth usage endpoint: fetch + map to the frontend shape.
//! Endpoint/beta header verified against Agent-Orchestrator's
//! auth-usage-fetcher.ts.

use serde::Serialize;
use serde_json::Value;

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    /// 0-100 (may exceed 100 when over quota)
    pub utilization: f64,
    /// ISO timestamp, when known
    pub resets_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: Option<bool>,
    /// dollars (API reports cents)
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: Option<UsageBucket>,
    pub seven_day: Option<UsageBucket>,
    pub extra_usage: Option<ExtraUsage>,
    pub fetched_at: i64,
}

/// Per-account entry in the usage rollup returned to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account_id: String,
    pub usage: Option<ClaudeUsage>,
    pub error: Option<String>,
}

fn map_bucket(v: Option<&Value>) -> Option<UsageBucket> {
    let b = v?;
    if b.is_null() {
        return None;
    }
    Some(UsageBucket {
        utilization: b.get("utilization")?.as_f64()?,
        resets_at: b
            .get("resets_at")
            .and_then(|r| r.as_str())
            .map(str::to_string),
    })
}

/// Map the raw usage response. Absent/null buckets map to None without
/// failing the rest (the live API emits explicit nulls for unprovisioned
/// blocks). Cents fields become dollars.
pub fn map_usage_response(v: &Value, now_ms: i64) -> ClaudeUsage {
    let extra = v
        .get("extra_usage")
        .filter(|e| !e.is_null())
        .map(|e| ExtraUsage {
            is_enabled: e.get("is_enabled").and_then(|x| x.as_bool()),
            monthly_limit: e
                .get("monthly_limit")
                .and_then(|x| x.as_f64())
                .map(|c| c / 100.0),
            used_credits: e
                .get("used_credits")
                .and_then(|x| x.as_f64())
                .map(|c| c / 100.0),
            utilization: e.get("utilization").and_then(|x| x.as_f64()),
        });
    ClaudeUsage {
        five_hour: map_bucket(v.get("five_hour")),
        seven_day: map_bucket(v.get("seven_day")),
        extra_usage: extra,
        fetched_at: now_ms,
    }
}

/// Raw usage fetch. 401 is surfaced distinctly so the caller can refresh
/// the token once and retry.
pub enum UsageFetch {
    Ok(Value),
    AuthFailed,
    Err(String),
}

pub async fn fetch_usage_raw(client: &reqwest::Client, access_token: &str) -> UsageFetch {
    let resp = client
        .get(USAGE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", OAUTH_BETA_HEADER)
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return UsageFetch::Err(e.to_string()),
    };
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return UsageFetch::AuthFailed;
    }
    if !status.is_success() {
        return UsageFetch::Err(format!("HTTP {status}"));
    }
    match resp.json::<Value>().await {
        Ok(v) => UsageFetch::Ok(v),
        Err(e) => UsageFetch::Err(format!("invalid usage response: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_buckets_and_converts_cents() {
        let v: Value = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": 42.5, "resets_at": "2026-07-09T18:00:00Z"},
                "seven_day": {"utilization": 91.0, "resets_at": null},
                "extra_usage": {"is_enabled": true, "monthly_limit": 2500, "used_credits": 125, "utilization": 5.0}
            }"#,
        )
        .unwrap();
        let u = map_usage_response(&v, 777);
        assert_eq!(u.fetched_at, 777);
        let fh = u.five_hour.unwrap();
        assert_eq!(fh.utilization, 42.5);
        assert_eq!(fh.resets_at.as_deref(), Some("2026-07-09T18:00:00Z"));
        assert_eq!(u.seven_day.unwrap().resets_at, None);
        let ex = u.extra_usage.unwrap();
        assert_eq!(ex.monthly_limit, Some(25.0)); // cents -> dollars
        assert_eq!(ex.used_credits, Some(1.25));
    }

    #[test]
    fn null_and_missing_blocks_map_to_none() {
        let v: Value =
            serde_json::from_str(r#"{"five_hour": null, "extra_usage": null}"#).unwrap();
        let u = map_usage_response(&v, 1);
        assert!(u.five_hour.is_none());
        assert!(u.seven_day.is_none());
        assert!(u.extra_usage.is_none());

        // A bucket missing `utilization` maps to None rather than panicking.
        let v2: Value = serde_json::from_str(r#"{"five_hour": {"resets_at": "x"}}"#).unwrap();
        assert!(map_usage_response(&v2, 1).five_hour.is_none());
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd src-tauri && cargo test usage`
Expected: 2 tests PASS (plus the accounts tests still pass — `CachedUsage` references `ClaudeUsage` which now has more fields; run `cargo test accounts` too).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/claude/usage.rs
git commit -m "feat(claude): usage endpoint fetch and mapping"
```

---

### Task 5: Tauri commands + registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (new section after the provider-API-keys section, ~line 920)
- Modify: `src-tauri/src/lib.rs` (manage the store + oauth flow state, register commands)

- [ ] **Step 1: Add managed state in `lib.rs`**

After `app.manage(ApiKeyStore::new(data_dir.join("keys.json")));` (line 66):

```rust
app.manage(claude::accounts::ClaudeAccountStore::new(
    data_dir.join("claude-accounts.json"),
));
app.manage(commands::ClaudeOauthFlow::default());
```

- [ ] **Step 2: Add the commands section in `commands.rs`**

Imports to add at the top of commands.rs (merge with existing `use` lines):

```rust
use crate::claude::accounts::{CachedUsage, ClaudeAccount, ClaudeAccountStore, ClaudeAccountsList};
```

New section:

```rust
// ---------- claude accounts ----------

/// Cancel flag for the (single) in-flight OAuth login. Starting a new login
/// cancels any previous one.
#[derive(Default)]
pub struct ClaudeOauthFlow {
    cancel: parking_lot::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

impl ClaudeOauthFlow {
    fn begin(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        let mut slot = self.cancel.lock();
        if let Some(old) = slot.take() {
            old.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *slot = Some(flag.clone());
        flag
    }

    pub fn cancel_pending(&self) {
        if let Some(flag) = self.cancel.lock().take() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Msg(e.to_string()))
}

/// Absorb credential-file drift: when the CLI refreshed tokens (file token !=
/// last synced), identify the file's account via the profile endpoint and
/// update that account's stored credentials. Best-effort — any failure skips.
async fn capture_credentials_drift(
    app: &AppHandle,
    store: &ClaudeAccountStore,
    client: &reqwest::Client,
) {
    let Ok(home) = home_dir(app) else { return };
    let path = crate::claude::creds::credentials_path(&home);
    let Some(file_creds) = crate::claude::creds::read_credentials_file(&path) else {
        return;
    };
    let Some(file_token) = crate::claude::creds::creds_str(&file_creds, "accessToken") else {
        return;
    };
    if store.last_synced_access_token().as_deref() == Some(file_token.as_str()) {
        return; // no drift
    }
    let Ok(profile) = crate::claude::oauth::fetch_profile(client, &file_token).await else {
        return; // can't attribute — leave for next time
    };
    if let Some(account) = store.account_by_email(&profile.email) {
        if store.set_creds(&account.id, &file_creds).is_ok() {
            store.set_last_synced_access_token(Some(file_token));
            store.set_refresh_dead(&account.id, false);
        }
    }
}

/// Return fresh credentials for an account, refreshing through the token
/// endpoint when inside the expiry buffer. Rotated tokens persist to the
/// keychain before anything else happens.
async fn ensure_fresh_creds(
    store: &ClaudeAccountStore,
    client: &reqwest::Client,
    id: &str,
) -> AppResult<serde_json::Value> {
    let mut creds = store
        .creds(id)
        .ok_or_else(|| AppError::Msg("no token stored — log in again".to_string()))?;
    let expires_at = crate::claude::creds::creds_i64(&creds, "expiresAt");
    let now = crate::claude::creds::now_ms();
    if !crate::claude::creds::needs_refresh(expires_at, now) {
        return Ok(creds);
    }
    let refresh_token = crate::claude::creds::creds_str(&creds, "refreshToken")
        .ok_or_else(|| AppError::Msg("no refresh token — log in again".to_string()))?;
    match crate::claude::oauth::do_refresh(client, &refresh_token).await {
        crate::claude::oauth::RefreshOutcome::Fresh(t) => {
            let obj = creds.as_object_mut().expect("creds blob is an object");
            obj.insert("accessToken".into(), t.access_token.clone().into());
            obj.insert("refreshToken".into(), t.refresh_token.into());
            obj.insert(
                "expiresAt".into(),
                serde_json::Value::from(now + t.expires_in * 1000),
            );
            store.set_creds(id, &creds)?;
            store.set_refresh_dead(id, false);
            Ok(creds)
        }
        crate::claude::oauth::RefreshOutcome::Dead => {
            store.set_refresh_dead(id, true);
            Err(AppError::Msg("session expired — log in again".to_string()))
        }
        crate::claude::oauth::RefreshOutcome::Transient(msg) => {
            // Token may still be usable if not FULLY expired (buffer only).
            if expires_at.is_some_and(|exp| now < exp) {
                Ok(creds)
            } else {
                Err(AppError::Msg(format!("token refresh failed: {msg}")))
            }
        }
    }
}

/// Write an account's credentials to ~/.claude/.credentials.json and record
/// it as active. Also disables enabled Anthropic provider keys so
/// ANTHROPIC_API_KEY doesn't override the login in new claude sessions.
fn activate_login_account(
    app: &AppHandle,
    store: &ClaudeAccountStore,
    creds: &serde_json::Value,
    id: &str,
) -> AppResult<()> {
    let home = home_dir(app)?;
    let path = crate::claude::creds::credentials_path(&home);
    crate::claude::creds::write_credentials_file(&path, creds)?;
    store.set_active(Some(id.to_string()));
    store.set_last_synced_access_token(crate::claude::creds::creds_str(creds, "accessToken"));
    let apikeys = app.state::<ApiKeyStore>();
    for k in apikeys.keys_snapshot() {
        if k.provider == "anthropic" && k.enabled {
            apikeys.set_enabled(&k.id, false);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn claude_accounts_list(store: State<ClaudeAccountStore>) -> ClaudeAccountsList {
    store.list()
}

#[tauri::command]
pub async fn claude_accounts_add_via_oauth(
    app: AppHandle,
    store: State<'_, ClaudeAccountStore>,
    flow: State<'_, ClaudeOauthFlow>,
    login_hint: Option<String>,
) -> AppResult<ClaudeAccountsList> {
    let cancel = flow.begin();
    let (verifier, challenge) = crate::claude::oauth::pkce_pair();
    let state_param = crate::claude::oauth::random_state();
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Msg(format!("could not bind callback port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Msg(e.to_string()))?
        .port();
    let redirect_uri = format!("http://localhost:{port}/callback");
    let url = crate::claude::oauth::build_authorize_url(
        &challenge,
        &state_param,
        port,
        login_hint.as_deref(),
    );

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| AppError::Msg(format!("could not open browser: {e}")))?;

    let expected = state_param.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        crate::claude::oauth::wait_for_callback(
            listener,
            &expected,
            cancel,
            crate::claude::oauth::LOGIN_TIMEOUT,
        )
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))??;

    let client = http_client()?;
    let tokens =
        crate::claude::oauth::exchange_code(&client, &code, &verifier, &redirect_uri, &state_param)
            .await?;
    let now = crate::claude::creds::now_ms();
    let creds = serde_json::json!({
        "accessToken": tokens.access_token,
        "refreshToken": tokens.refresh_token,
        "expiresAt": now + tokens.expires_in * 1000,
        "scopes": crate::claude::oauth::OAUTH_SCOPES,
    });
    let profile = crate::claude::oauth::fetch_profile(&client, &tokens.access_token).await?;

    // Absorb any CLI-rotated tokens for the PREVIOUS account before the new
    // account's credentials overwrite the file.
    capture_credentials_drift(&app, &store, &client).await;

    let account = store.upsert(
        ClaudeAccount {
            id: Uuid::new_v4().to_string(),
            email: profile.email,
            display_name: profile.display_name,
            plan: profile.plan,
            added_at: now,
            refresh_dead: false,
        },
        &creds,
    )?;
    activate_login_account(&app, &store, &creds, &account.id)?;
    Ok(store.list())
}

#[tauri::command]
pub fn claude_accounts_login_cancel(flow: State<ClaudeOauthFlow>) {
    flow.cancel_pending();
}

#[tauri::command]
pub async fn claude_accounts_import_cli(
    app: AppHandle,
    store: State<'_, ClaudeAccountStore>,
) -> AppResult<ClaudeAccountsList> {
    let home = home_dir(&app)?;
    let path = crate::claude::creds::credentials_path(&home);
    let creds = crate::claude::creds::read_credentials_file(&path).ok_or_else(|| {
        AppError::Msg("no CLI credentials found — run `claude` and log in first".to_string())
    })?;
    let token = crate::claude::creds::creds_str(&creds, "accessToken")
        .ok_or_else(|| AppError::Msg("credentials file has no access token".to_string()))?;
    let client = http_client()?;
    let profile = crate::claude::oauth::fetch_profile(&client, &token)
        .await
        .map_err(|_| {
            AppError::Msg(
                "could not identify the CLI account — its token may be expired; run `claude` to refresh it, then retry"
                    .to_string(),
            )
        })?;
    let account = store.upsert(
        ClaudeAccount {
            id: Uuid::new_v4().to_string(),
            email: profile.email,
            display_name: profile.display_name,
            plan: profile.plan,
            added_at: crate::claude::creds::now_ms(),
            refresh_dead: false,
        },
        &creds,
    )?;
    // The file already IS this account: mark active without rewriting it.
    store.set_active(Some(account.id.clone()));
    store.set_last_synced_access_token(Some(token));
    Ok(store.list())
}

#[tauri::command]
pub async fn claude_accounts_switch(
    app: AppHandle,
    store: State<'_, ClaudeAccountStore>,
    id: String,
) -> AppResult<ClaudeAccountsList> {
    let client = http_client()?;
    capture_credentials_drift(&app, &store, &client).await;
    let creds = ensure_fresh_creds(&store, &client, &id).await?;
    activate_login_account(&app, &store, &creds, &id)?;
    Ok(store.list())
}

/// Switch to "API Key" auth: enable the given Anthropic provider entry. The
/// credentials file is left alone (ANTHROPIC_API_KEY wins for claude).
#[tauri::command]
pub fn claude_accounts_switch_to_apikey(
    apikeys: State<ApiKeyStore>,
    id: String,
) -> Vec<ApiKeyMeta> {
    apikeys.set_enabled(&id, true);
    apikeys.list()
}

#[tauri::command]
pub fn claude_accounts_remove(store: State<ClaudeAccountStore>, id: String) -> ClaudeAccountsList {
    store.remove(&id);
    store.list()
}

#[tauri::command]
pub async fn claude_accounts_usage(
    app: AppHandle,
    store: State<'_, ClaudeAccountStore>,
    force: bool,
) -> AppResult<Vec<crate::claude::usage::AccountUsage>> {
    use crate::claude::usage::{fetch_usage_raw, map_usage_response, AccountUsage, UsageFetch};
    let client = http_client()?;
    capture_credentials_drift(&app, &store, &client).await;
    let now = crate::claude::creds::now_ms();
    let mut out = Vec::new();
    for account in store.accounts_snapshot() {
        if !force {
            if let Some(hit) = store.cached_usage(&account.id, now) {
                out.push(AccountUsage {
                    account_id: account.id.clone(),
                    usage: hit.usage,
                    error: hit.error,
                });
                continue;
            }
        }
        let entry = fetch_account_usage(&store, &client, &account.id).await;
        store.put_usage(
            &account.id,
            CachedUsage {
                usage: entry.usage.clone(),
                error: entry.error.clone(),
                fetched_at: crate::claude::creds::now_ms(),
            },
        );
        out.push(entry);
    }
    Ok(out)
}

/// One account's usage: fresh token -> fetch -> map, with a single
/// refresh+retry on 401 and stale-while-error fallback.
async fn fetch_account_usage(
    store: &ClaudeAccountStore,
    client: &reqwest::Client,
    id: &str,
) -> crate::claude::usage::AccountUsage {
    use crate::claude::usage::{fetch_usage_raw, map_usage_response, AccountUsage, UsageFetch};
    let stale = |error: String| AccountUsage {
        account_id: id.to_string(),
        usage: store.stale_usage(id).and_then(|c| c.usage),
        error: Some(error),
    };
    let creds = match ensure_fresh_creds(store, client, id).await {
        Ok(c) => c,
        Err(e) => return stale(e.to_string()),
    };
    let token = match crate::claude::creds::creds_str(&creds, "accessToken") {
        Some(t) => t,
        None => return stale("no access token".to_string()),
    };
    match fetch_usage_raw(client, &token).await {
        UsageFetch::Ok(v) => AccountUsage {
            account_id: id.to_string(),
            usage: Some(map_usage_response(&v, crate::claude::creds::now_ms())),
            error: None,
        },
        UsageFetch::AuthFailed => {
            // Access token rejected despite looking valid — force refresh once.
            match ensure_fresh_creds(store, client, id).await {
                Ok(fresh) => {
                    let t2 = crate::claude::creds::creds_str(&fresh, "accessToken")
                        .unwrap_or_default();
                    match fetch_usage_raw(client, &t2).await {
                        UsageFetch::Ok(v) => AccountUsage {
                            account_id: id.to_string(),
                            usage: Some(map_usage_response(&v, crate::claude::creds::now_ms())),
                            error: None,
                        },
                        UsageFetch::AuthFailed => stale("auth rejected".to_string()),
                        UsageFetch::Err(e) => stale(e),
                    }
                }
                Err(e) => stale(e.to_string()),
            }
        }
        UsageFetch::Err(e) => stale(e),
    }
}
```

Adjustments the implementer must make while wiring:
- `AppError`, `AppHandle`, `State`, `Uuid`, `ApiKeyStore`, `ApiKeyMeta` are already imported at the top of commands.rs — reuse them, don't duplicate imports.
- The 401-retry path is only meaningful when the first `ensure_fresh_creds` skipped refreshing (token looked valid); a second call within the buffer window will attempt a real refresh because the first fetch's 401 proves staleness — if the implementation can't distinguish this, an acceptable simplification is: on `AuthFailed`, call `do_refresh` directly (via `ensure_fresh_creds` after zeroing nothing) and accept a possible duplicate no-op refresh.
- Delete the erroneous `AccountUsageList` import if present.

- [ ] **Step 3: Register the commands in `lib.rs`**

Add to `generate_handler!` after `commands::claude_hooks_disable`:

```rust
commands::claude_accounts_list,
commands::claude_accounts_add_via_oauth,
commands::claude_accounts_login_cancel,
commands::claude_accounts_import_cli,
commands::claude_accounts_switch,
commands::claude_accounts_switch_to_apikey,
commands::claude_accounts_remove,
commands::claude_accounts_usage,
```

- [ ] **Step 4: Compile + full Rust test suite**

Run: `cd src-tauri && cargo check && cargo test`
Expected: compiles clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(claude): account commands - oauth add, import, switch, usage"
```

---

### Task 6: PTY ambient-env stripping

**Files:**
- Modify: `src-tauri/src/pty/mod.rs:180-235` (CreateOpts + create)
- Modify: `src-tauri/src/commands.rs` terminal_create (~line 141)
- Modify: `src-tauri/src/remote/bridge.rs` (~line 101, the second CreateOpts construction site)

- [ ] **Step 1: Add `env_remove` to CreateOpts**

In `pty/mod.rs`, extend the struct:

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
    /// Vars removed from the child env (ambient credential stripping).
    pub env_remove: Vec<String>,
}
```

And in `create()`, right after `cmd.cwd(&opts.cwd);`:

```rust
for k in &opts.env_remove {
    cmd.env_remove(k);
}
```

- [ ] **Step 2: Populate at both construction sites**

In `commands.rs` `terminal_create`, change the `CreateOpts { ... }` literal to add:

```rust
env: app.state::<ApiKeyStore>().resolved_env(),
env_remove: claude_ambient_env_remove(&app),
```

and add the helper near the claude-accounts section:

```rust
/// Strip ambient Claude credential env vars from new terminals while a
/// managed login account is active, so the credentials file decides auth.
pub fn claude_ambient_env_remove(app: &AppHandle) -> Vec<String> {
    if app.state::<ClaudeAccountStore>().has_active_login_account() {
        crate::claude::accounts::AMBIENT_CLAUDE_ENV
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    }
}
```

In `remote/bridge.rs` (~line 101) there is a second `CreateOpts` literal with `env: app.state::<crate::apikeys::ApiKeyStore>().resolved_env(),` — add the matching line:

```rust
env_remove: crate::commands::claude_ambient_env_remove(&app),
```

(Read the surrounding code first; if the variable holding the AppHandle is named differently there, adapt.)

- [ ] **Step 3: Compile + test**

Run: `cd src-tauri && cargo check && cargo test`
Expected: clean. (remote module is feature-gated but on by default, so `cargo check` covers it.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pty/mod.rs src-tauri/src/commands.rs src-tauri/src/remote/bridge.rs
git commit -m "feat(pty): strip ambient claude auth env when a login account is active"
```

---

### Task 7: Frontend IPC types + pure helpers

**Files:**
- Modify: `src/lib/ipc.ts` (types + `ipc.claudeAccounts`)
- Create: `src/lib/claude-accounts.ts`
- Create: `src/lib/claude-accounts.test.ts`

- [ ] **Step 1: Add types + IPC surface in `ipc.ts`**

After the `DetectedEnvKey` interface (~line 287), add:

```ts
export interface ClaudeAccountMeta {
  id: string
  email: string
  displayName: string | null
  /** raw Anthropic tier, e.g. "max_20x" — humanize with formatPlanName */
  plan: string | null
  /** epoch millis */
  addedAt: number
  /** refresh token rejected — needs re-login */
  refreshDead: boolean
  hasToken: boolean
}

export interface ClaudeAccountsList {
  accounts: ClaudeAccountMeta[]
  activeAccountId: string | null
}

export interface ClaudeUsageBucket {
  /** 0-100, may exceed 100 when over quota */
  utilization: number
  resetsAt: string | null
}

export interface ClaudeExtraUsage {
  isEnabled: boolean | null
  monthlyLimit: number | null
  usedCredits: number | null
  utilization: number | null
}

export interface ClaudeUsage {
  fiveHour: ClaudeUsageBucket | null
  sevenDay: ClaudeUsageBucket | null
  extraUsage: ClaudeExtraUsage | null
  /** epoch millis */
  fetchedAt: number
}

export interface ClaudeAccountUsage {
  accountId: string
  usage: ClaudeUsage | null
  error: string | null
}
```

In the `ipc` object, after the `claude` group:

```ts
claudeAccounts: {
  list: () => invoke<ClaudeAccountsList>('claude_accounts_list'),
  addViaOauth: (loginHint?: string) =>
    invoke<ClaudeAccountsList>('claude_accounts_add_via_oauth', { loginHint }),
  loginCancel: () => invoke<void>('claude_accounts_login_cancel'),
  importCli: () => invoke<ClaudeAccountsList>('claude_accounts_import_cli'),
  switchTo: (id: string) => invoke<ClaudeAccountsList>('claude_accounts_switch', { id }),
  switchToApiKey: (id: string) =>
    invoke<ApiKeyMeta[]>('claude_accounts_switch_to_apikey', { id }),
  remove: (id: string) => invoke<ClaudeAccountsList>('claude_accounts_remove', { id }),
  usage: (force = false) =>
    invoke<ClaudeAccountUsage[]>('claude_accounts_usage', { force }),
},
```

- [ ] **Step 2: Write failing tests for the pure helpers**

`src/lib/claude-accounts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  formatPlanName,
  formatResetsIn,
  formatAgo,
  sortAccounts,
  utilizationBarClass,
  worstUtilization,
} from './claude-accounts'
import type { ClaudeAccountMeta } from './ipc'

const acct = (id: string, addedAt: number): ClaudeAccountMeta => ({
  id,
  email: `${id}@x.y`,
  displayName: null,
  plan: null,
  addedAt,
  refreshDead: false,
  hasToken: true,
})

describe('formatPlanName', () => {
  it('humanizes tier ids', () => {
    expect(formatPlanName('max_20x')).toBe('Max 20x')
    expect(formatPlanName('max_5x')).toBe('Max 5x')
    expect(formatPlanName('pro')).toBe('Pro')
    expect(formatPlanName('enterprise')).toBe('Enterprise')
    expect(formatPlanName(null)).toBe('')
  })
})

describe('sortAccounts', () => {
  it('pins active first, then oldest-added', () => {
    const list = [acct('b', 200), acct('a', 100), acct('c', 300)]
    const sorted = sortAccounts(list, 'c')
    expect(sorted.map((a) => a.id)).toEqual(['c', 'a', 'b'])
    // no active id -> pure addedAt order
    expect(sortAccounts(list, null).map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('utilizationBarClass', () => {
  it('maps thresholds to colors', () => {
    expect(utilizationBarClass(100)).toBe('bg-red-700')
    expect(utilizationBarClass(95)).toBe('bg-red-500')
    expect(utilizationBarClass(75)).toBe('bg-orange-500')
    expect(utilizationBarClass(65)).toBe('bg-yellow-500')
    expect(utilizationBarClass(10)).toBe('bg-green-500')
  })
})

describe('worstUtilization', () => {
  it('takes the max across buckets, null-safe', () => {
    expect(
      worstUtilization({
        fiveHour: { utilization: 42, resetsAt: null },
        sevenDay: { utilization: 91, resetsAt: null },
        extraUsage: null,
        fetchedAt: 0,
      })
    ).toBe(91)
    expect(worstUtilization(null)).toBe(null)
    expect(
      worstUtilization({ fiveHour: null, sevenDay: null, extraUsage: null, fetchedAt: 0 })
    ).toBe(null)
  })
})

describe('formatResetsIn', () => {
  const now = Date.parse('2026-07-09T12:00:00Z')
  it('renders d/h/m tiers', () => {
    expect(formatResetsIn('2026-07-16T09:00:00Z', now)).toBe('6d 21h')
    expect(formatResetsIn('2026-07-09T16:00:00Z', now)).toBe('4h')
    expect(formatResetsIn('2026-07-09T12:25:00Z', now)).toBe('25m')
    expect(formatResetsIn('2026-07-09T11:00:00Z', now)).toBe('now') // past
    expect(formatResetsIn(null, now)).toBe('')
    expect(formatResetsIn('garbage', now)).toBe('')
  })
})

describe('formatAgo', () => {
  const now = 1_000_000_000
  it('renders compact ago labels', () => {
    expect(formatAgo(now - 20_000, now)).toBe('just now')
    expect(formatAgo(now - 3 * 60_000, now)).toBe('3m ago')
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2h ago')
  })
})
```

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm test`
Expected: FAIL — module `./claude-accounts` not found.

- [ ] **Step 4: Implement `src/lib/claude-accounts.ts`**

```ts
// Pure helpers for the Claude accounts UI. Kept free of Tauri/ipc calls so
// they run in plain vitest (same pattern as claude-command.ts).

import type { ClaudeAccountMeta, ClaudeUsage } from './ipc'

/** "max_20x" -> "Max 20x"; unknown tiers title-case per segment. */
export function formatPlanName(plan: string | null): string {
  if (!plan) return ''
  return plan
    .split('_')
    .map((p) => (/^\d+x$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

/** Active account pinned first, then by addedAt ascending. */
export function sortAccounts(
  accounts: ClaudeAccountMeta[],
  activeId: string | null
): ClaudeAccountMeta[] {
  return [...accounts].sort((a, b) => {
    if (a.id === activeId && b.id !== activeId) return -1
    if (b.id === activeId && a.id !== activeId) return 1
    return a.addedAt - b.addedAt
  })
}

/** Bar fill color by utilization tier (matches the reference thresholds). */
export function utilizationBarClass(utilization: number): string {
  if (utilization >= 100) return 'bg-red-700'
  if (utilization >= 90) return 'bg-red-500'
  if (utilization >= 70) return 'bg-orange-500'
  if (utilization >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

/** Highest utilization across the 5h/7d windows; null when unknown. */
export function worstUtilization(usage: ClaudeUsage | null): number | null {
  if (!usage) return null
  const values = [usage.fiveHour?.utilization, usage.sevenDay?.utilization].filter(
    (v): v is number => typeof v === 'number'
  )
  return values.length ? Math.max(...values) : null
}

/** "6d 21h" / "4h" / "25m" / "now"; empty for missing/invalid input. */
export function formatResetsIn(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return ''
  const diff = t - nowMs
  if (diff <= 0) return 'now'
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

/** "just now" / "3m ago" / "2h ago" */
export function formatAgo(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs)
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ipc.ts src/lib/claude-accounts.ts src/lib/claude-accounts.test.ts
git commit -m "feat(claude-accounts): ipc surface and pure UI helpers"
```

---

### Task 8: Zustand store (`src/state/claude-accounts.ts`)

**Files:**
- Create: `src/state/claude-accounts.ts`

- [ ] **Step 1: Implement the store** (house pattern = `src/state/apikeys.ts`: thin async actions that set returned state; no try/catch except where the UI needs the message)

```ts
import { create } from 'zustand'
import {
  ipc,
  type ClaudeAccountMeta,
  type ClaudeAccountUsage,
} from '../lib/ipc'
import { useApiKeys } from './apikeys'

const POLL_INTERVAL_MS = 5 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null

interface ClaudeAccountsState {
  accounts: ClaudeAccountMeta[]
  activeAccountId: string | null
  /** by accountId */
  usage: Record<string, ClaudeAccountUsage>
  usageFetchedAt: number | null
  loaded: boolean
  /** login flow in flight (shows "waiting for browser…") */
  loggingIn: boolean
  /** switch/remove/import in flight (disables row actions) */
  busy: boolean
  error: string | null

  load: () => Promise<void>
  refreshUsage: (force?: boolean) => Promise<void>
  addViaOauth: (loginHint?: string) => Promise<void>
  cancelLogin: () => Promise<void>
  importCli: () => Promise<void>
  switchTo: (id: string) => Promise<void>
  switchToApiKey: (apiKeyId: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearError: () => void
  startPolling: () => void
  stopPolling: () => void
}

export const useClaudeAccounts = create<ClaudeAccountsState>((set, get) => ({
  accounts: [],
  activeAccountId: null,
  usage: {},
  usageFetchedAt: null,
  loaded: false,
  loggingIn: false,
  busy: false,
  error: null,

  load: async () => {
    const list = await ipc.claudeAccounts.list()
    set({ accounts: list.accounts, activeAccountId: list.activeAccountId, loaded: true })
  },

  refreshUsage: async (force = false) => {
    if (get().accounts.length === 0) return
    const entries = await ipc.claudeAccounts.usage(force)
    const usage: Record<string, ClaudeAccountUsage> = {}
    for (const e of entries) usage[e.accountId] = e
    set({ usage, usageFetchedAt: Date.now() })
    // refreshDead flags may have changed during token refresh
    await get().load()
  },

  addViaOauth: async (loginHint) => {
    set({ loggingIn: true, error: null })
    try {
      const list = await ipc.claudeAccounts.addViaOauth(loginHint)
      set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
      // switching disables Anthropic provider keys — resync that store
      await useApiKeys.getState().load()
      await get().refreshUsage(true)
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ loggingIn: false })
    }
  },

  cancelLogin: async () => {
    await ipc.claudeAccounts.loginCancel()
  },

  importCli: async () => {
    set({ busy: true, error: null })
    try {
      const list = await ipc.claudeAccounts.importCli()
      set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
      await get().refreshUsage(true)
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  switchTo: async (id) => {
    set({ busy: true, error: null })
    try {
      const list = await ipc.claudeAccounts.switchTo(id)
      set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
      await useApiKeys.getState().load()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  switchToApiKey: async (apiKeyId) => {
    set({ busy: true, error: null })
    try {
      await ipc.claudeAccounts.switchToApiKey(apiKeyId)
      await useApiKeys.getState().load()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  remove: async (id) => {
    const list = await ipc.claudeAccounts.remove(id)
    set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
  },

  clearError: () => set({ error: null }),

  startPolling: () => {
    if (pollTimer) return
    const tick = async () => {
      const s = get()
      if (!s.loaded) await s.load()
      await s.refreshUsage(false).catch(() => {})
    }
    void tick()
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  },

  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  },
}))
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/state/claude-accounts.ts
git commit -m "feat(claude-accounts): zustand store with 5-minute usage polling"
```

---

### Task 9: Usage bar + account row components

**Files:**
- Create: `src/components/claude-accounts/mini-usage-bar.tsx`
- Create: `src/components/claude-accounts/account-row.tsx`

- [ ] **Step 1: `mini-usage-bar.tsx`**

```tsx
import { utilizationBarClass, formatResetsIn } from '../../lib/claude-accounts'
import type { ClaudeUsageBucket } from '../../lib/ipc'

/**
 * One labeled quota bar ("5h" / "7d"): fill width = utilization, color by
 * tier, reset countdown on the right. Renders a dimmed empty bar when the
 * bucket is unknown.
 */
export function MiniUsageBar({ label, bucket }: { label: string; bucket: ClaudeUsageBucket | null }) {
  const pct = bucket ? Math.max(0, Math.min(bucket.utilization, 100)) : 0
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted">
      <span className="w-4 flex-shrink-0">{label}</span>
      <div className="h-1.5 w-16 flex-shrink-0 overflow-hidden rounded-full bg-foreground/10">
        {bucket && (
          <div
            className={`h-full rounded-full ${utilizationBarClass(bucket.utilization)}`}
            style={{ width: `${pct}%` }}
            title={`${Math.round(bucket.utilization)}% used`}
          />
        )}
      </div>
      <span className="min-w-0 truncate">
        {bucket ? formatResetsIn(bucket.resetsAt, Date.now()) : '—'}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: `account-row.tsx`**

```tsx
import { useState } from 'react'
import type { ClaudeAccountMeta, ClaudeAccountUsage } from '../../lib/ipc'
import { formatPlanName } from '../../lib/claude-accounts'
import { MiniUsageBar } from './mini-usage-bar'

/**
 * One login account: email + plan, Switch/delete actions, 5h/7d usage bars.
 * The active row gets an accent left border and no Switch button. Delete is
 * two-click (first click arms, second confirms).
 */
export function AccountRow({
  account,
  usage,
  isActive,
  busy,
  onSwitch,
  onRemove,
  onRelogin,
}: {
  account: ClaudeAccountMeta
  usage: ClaudeAccountUsage | undefined
  isActive: boolean
  busy: boolean
  onSwitch: () => void
  onRemove: () => void
  onRelogin: () => void
}) {
  const [armedRemove, setArmedRemove] = useState(false)

  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        isActive ? 'border-l-2 border-accent bg-accent/5' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm font-medium ${isActive ? 'text-accent' : 'text-foreground'}`}>
            {account.email}
          </div>
          <div className="truncate text-xs text-muted">
            {formatPlanName(account.plan) || 'Claude account'}
            {account.displayName ? ` · ${account.displayName}` : ''}
          </div>
        </div>
        {account.refreshDead ? (
          <button
            type="button"
            onClick={onRelogin}
            disabled={busy}
            className="rounded border border-warning/50 px-2 py-1 text-xs text-warning hover:bg-warning/10 disabled:opacity-50"
          >
            Log in again
          </button>
        ) : (
          !isActive && (
            <button
              type="button"
              onClick={onSwitch}
              disabled={busy}
              title="Make this the account claude uses (writes ~/.claude credentials)"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
            >
              ⇄ Switch
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => {
            if (armedRemove) onRemove()
            else setArmedRemove(true)
          }}
          onBlur={() => setArmedRemove(false)}
          disabled={busy}
          title={armedRemove ? 'Click again to confirm' : 'Remove account from the app'}
          className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
            armedRemove
              ? 'border-danger/60 bg-danger/10 text-danger'
              : 'border-border text-danger hover:bg-foreground/5'
          }`}
        >
          {armedRemove ? 'Sure?' : '🗑'}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-4">
        <MiniUsageBar label="5h" bucket={usage?.usage?.fiveHour ?? null} />
        <MiniUsageBar label="7d" bucket={usage?.usage?.sevenDay ?? null} />
      </div>
      {usage?.error && <div className="mt-1 truncate text-xs text-danger">{usage.error}</div>}
    </div>
  )
}
```

Note: check that `text-warning` / `border-warning` exist in the theme (settings-modal.tsx uses `text-warning` at line 527, so they do).

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm typecheck`

```bash
git add src/components/claude-accounts/mini-usage-bar.tsx src/components/claude-accounts/account-row.tsx
git commit -m "feat(claude-accounts): usage bar and account row components"
```

---

### Task 10: Popover + title-bar pill

**Files:**
- Create: `src/components/claude-accounts/accounts-popover.tsx`
- Create: `src/components/claude-accounts/account-pill.tsx`
- Modify: `src/components/title-bar.tsx`

- [ ] **Step 1: `accounts-popover.tsx`**

```tsx
import { useClaudeAccounts } from '../../state/claude-accounts'
import { useApiKeys } from '../../state/apikeys'
import { useUi } from '../../state/ui'
import { formatAgo, sortAccounts } from '../../lib/claude-accounts'
import { AccountRow } from './account-row'

/**
 * The dropdown under the title-bar pill: login-account list, API-key row
 * (synthesized from Anthropic provider entries), and footer actions.
 * Rendered inside a fixed overlay owned by AccountPill.
 */
export function AccountsPopover() {
  const s = useClaudeAccounts()
  const apiKeys = useApiKeys((st) => st.keys)
  const openSettings = useUi((st) => st.openSettings)

  const anthropicKeys = apiKeys.filter((k) => k.provider === 'anthropic' && k.hasValue)
  const apiKeyActive = anthropicKeys.some((k) => k.enabled)
  const sorted = sortAccounts(s.accounts, s.activeAccountId)

  return (
    <div className="flex max-h-[70vh] w-80 flex-col overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-lg">
      <div className="mb-1.5 flex items-baseline gap-1.5 px-1">
        <span className="text-sm font-semibold text-foreground">Accounts</span>
        <span className="text-xs text-muted">({s.accounts.length})</span>
      </div>

      {s.accounts.length === 0 && (
        <div className="px-1 py-2 text-xs text-muted">
          No Claude accounts yet. Log in or import the account you're already using in the CLI.
        </div>
      )}

      <div className="flex flex-col gap-1">
        {sorted.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            usage={s.usage[a.id]}
            isActive={a.id === s.activeAccountId && !apiKeyActive}
            busy={s.busy || s.loggingIn}
            onSwitch={() => void s.switchTo(a.id)}
            onRemove={() => void s.remove(a.id)}
            onRelogin={() => void s.addViaOauth(a.email)}
          />
        ))}

        {anthropicKeys.map((k) => (
          <div
            key={k.id}
            className={`rounded-md border px-3 py-2 ${
              k.enabled ? 'border-l-2 border-accent bg-accent/5' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${k.enabled ? 'text-accent' : 'text-foreground'}`}>
                  🔑 {k.label}
                </div>
                <div className="truncate text-xs text-muted">
                  API key · pay per token{k.enabled ? ' · overrides login for claude' : ''}
                </div>
              </div>
              {!k.enabled && (
                <button
                  type="button"
                  onClick={() => void s.switchToApiKey(k.id)}
                  disabled={s.busy || s.loggingIn}
                  title="Enable this key — claude will bill the API key instead of a subscription"
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
                >
                  ⇄ Switch
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {s.error && (
        <div className="mt-2 flex items-start gap-2 px-1 text-xs text-danger">
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button type="button" onClick={s.clearError} className="flex-shrink-0 hover:underline">
            ✕
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 border-t border-border px-1 pt-2 text-xs">
        {s.loggingIn ? (
          <span className="flex items-center gap-2 text-muted">
            Waiting for browser…
            <button
              type="button"
              onClick={() => void s.cancelLogin()}
              className="text-link hover:underline"
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void s.addViaOauth()}
              className="text-link hover:underline"
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => void s.importCli()}
              disabled={s.busy}
              title="Import the account already logged in via the claude CLI"
              className="text-link hover:underline disabled:opacity-50"
            >
              Import from CLI
            </button>
            <button
              type="button"
              onClick={() => openSettings('ai')}
              className="text-link hover:underline"
            >
              API Key
            </button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1 text-muted">
          {s.usageFetchedAt ? formatAgo(s.usageFetchedAt, Date.now()) : ''}
          <button
            type="button"
            onClick={() => void s.refreshUsage(true)}
            title="Refresh usage"
            className="hover:text-foreground"
          >
            ⟳
          </button>
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `account-pill.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { useApiKeys } from '../../state/apikeys'
import { utilizationBarClass, worstUtilization } from '../../lib/claude-accounts'
import { AccountsPopover } from './accounts-popover'

/**
 * Title-bar pill: active Claude account (or "API Key" / "Log In") plus a
 * health dot colored by the active account's worst 5h/7d utilization.
 * Clicking toggles the accounts popover.
 */
export function AccountPill() {
  const [open, setOpen] = useState(false)
  const accounts = useClaudeAccounts((s) => s.accounts)
  const activeAccountId = useClaudeAccounts((s) => s.activeAccountId)
  const usage = useClaudeAccounts((s) => s.usage)
  const startPolling = useClaudeAccounts((s) => s.startPolling)
  const stopPolling = useClaudeAccounts((s) => s.stopPolling)
  const apiKeysLoaded = useApiKeys((s) => s.loaded)
  const loadApiKeys = useApiKeys((s) => s.load)
  const apiKeys = useApiKeys((s) => s.keys)

  useEffect(() => {
    startPolling()
    if (!apiKeysLoaded) void loadApiKeys()
    return stopPolling
  }, [startPolling, stopPolling, apiKeysLoaded, loadApiKeys])

  const apiKeyActive = apiKeys.some((k) => k.provider === 'anthropic' && k.enabled && k.hasValue)
  const active = accounts.find((a) => a.id === activeAccountId)
  const label = apiKeyActive ? 'API Key' : active ? active.email : 'Log In'
  const worst = active && !apiKeyActive ? worstUtilization(usage[active.id]?.usage ?? null) : null

  return (
    <div className="relative flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Claude accounts"
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            worst === null ? 'bg-foreground/30' : utilizationBarClass(worst)
          }`}
        />
        <span className="max-w-40 truncate">{label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-50">
            <AccountsPopover />
          </div>
        </>
      )}
    </div>
  )
}
```

Implementation notes:
- `WebkitAppRegion` inline style makes the pill clickable inside the drag-region title bar. First check `src/styles/globals.css` for how `.app-titlebar` sets the drag region and whether an existing no-drag class exists (WindowControls uses one) — prefer the existing class over the inline style if present.
- If TypeScript rejects `WebkitAppRegion`, cast as shown or use the existing CSS class.

- [ ] **Step 3: Mount in `title-bar.tsx`**

```tsx
import { WindowControls } from './window-controls'
import { AccountPill } from './claude-accounts/account-pill'
import { isTauri } from '../lib/ipc'
import appIcon from '../../src-tauri/icons/32x32.png'

export function TitleBar() {
  if (!isTauri) return null

  return (
    <header className="app-titlebar flex h-8 flex-shrink-0 select-none items-stretch justify-between border-b border-border bg-surface">
      <div className="flex items-center gap-2 pl-2.5 text-xs font-medium text-foreground/55">
        <img src={appIcon} alt="" className="h-4 w-4" />
        <span>Terminal Workspace</span>
      </div>
      <div className="flex items-stretch gap-1">
        <AccountPill />
        <WindowControls />
      </div>
    </header>
  )
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add src/components/claude-accounts/accounts-popover.tsx src/components/claude-accounts/account-pill.tsx src/components/title-bar.tsx
git commit -m "feat(claude-accounts): title-bar pill and accounts popover"
```

---

### Task 11: Settings section

**Files:**
- Create: `src/components/claude-accounts/claude-accounts-section.tsx`
- Modify: `src/components/settings-modal.tsx` (AI tab, before `<ProvidersSection />`)

- [ ] **Step 1: `claude-accounts-section.tsx`**

```tsx
import { useEffect } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { sortAccounts } from '../../lib/claude-accounts'
import { AccountRow } from './account-row'

/**
 * Claude account management inside Settings → AI. Same rows as the popover;
 * management-oriented copy. Switching writes ~/.claude/.credentials.json so
 * the account applies to claude everywhere.
 */
export function ClaudeAccountsSection() {
  const s = useClaudeAccounts()

  useEffect(() => {
    if (!s.loaded) void s.load()
    // usage is nice-to-have here; fetch once if the pill hasn't polled yet
    if (s.usageFetchedAt === null && s.accounts.length > 0) void s.refreshUsage(false)
  }, [s.loaded, s.accounts.length, s.usageFetchedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = sortAccounts(s.accounts, s.activeAccountId)

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          Claude accounts
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void s.importCli()}
            disabled={s.busy || s.loggingIn}
            title="Import the account already logged in via the claude CLI"
            className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
          >
            Import from CLI
          </button>
          <button
            type="button"
            onClick={() => void s.addViaOauth()}
            disabled={s.loggingIn}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {s.loggingIn ? 'Waiting for browser…' : '+ Log in with claude.ai'}
          </button>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted">
        Switching writes <code className="font-mono">~/.claude/.credentials.json</code>, so the
        selected account applies to <code className="font-mono">claude</code> everywhere — new
        terminals here and outside the app. Sessions already running keep their old account.
      </p>

      {s.loggingIn && (
        <div className="mb-2 text-xs text-muted">
          Complete the sign-in in your browser.{' '}
          <button type="button" onClick={() => void s.cancelLogin()} className="text-link hover:underline">
            Cancel
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {s.accounts.length === 0 && (
          <div className="py-1 text-xs text-muted">No accounts yet.</div>
        )}
        {sorted.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            usage={s.usage[a.id]}
            isActive={a.id === s.activeAccountId}
            busy={s.busy || s.loggingIn}
            onSwitch={() => void s.switchTo(a.id)}
            onRemove={() => void s.remove(a.id)}
            onRelogin={() => void s.addViaOauth(a.email)}
          />
        ))}
      </div>

      {s.error && <div className="mt-2 text-xs text-danger">{s.error}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Mount in `settings-modal.tsx`**

Add the import:

```tsx
import { ClaudeAccountsSection } from './claude-accounts/claude-accounts-section'
```

In the AI tab block, render it between the Claude Code `Section` and `<ProvidersSection />`:

```tsx
{tab === 'ai' && (
  <>
    <Section title="Claude Code">
      {/* ...existing content unchanged... */}
      <ClaudeHooksToggle />
    </Section>

    <ClaudeAccountsSection />

    <ProvidersSection />
  </>
)}
```

- [ ] **Step 3: Typecheck + full test suite + commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add src/components/claude-accounts/claude-accounts-section.tsx src/components/settings-modal.tsx
git commit -m "feat(claude-accounts): settings section for account management"
```

---

### Task 12: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Rust suite**

Run: `cd src-tauri && cargo test`
Expected: all tests pass (creds, accounts, oauth, usage + existing modules).

- [ ] **Step 2: Frontend suite + typecheck + build**

Run: `pnpm test && pnpm build`
Expected: vitest green; `tsc --noEmit` + vite build clean.

- [ ] **Step 3: Smoke-run the app**

Run: `pnpm tauri dev` (leave running briefly)
Verify manually / report for user verification:
1. Title-bar pill renders ("Log In" when no accounts).
2. "Import from CLI" imports the currently logged-in CLI account (this dev machine has one) and it appears with plan + usage bars.
3. Settings → AI shows the Claude accounts section.
No OAuth-flow automation — adding a second account via browser login is user-verified after delivery.

- [ ] **Step 4: Commit any fixes, then final commit**

```bash
git add -A
git commit -m "chore(claude-accounts): verification fixes"
```

(Skip if nothing changed.)
