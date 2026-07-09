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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // Windows Credential Manager races on concurrent create/delete of distinct
    // targets; serialize the real-keychain tests among themselves (the rest of
    // the suite still runs in parallel). Recover from poisoning so one failing
    // assertion doesn't cascade into unrelated panics.
    static KEYCHAIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn keychain_guard() -> std::sync::MutexGuard<'static, ()> {
        KEYCHAIN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A deleted Windows credential isn't always visible to an immediate
    /// re-read under heavy parallel load; poll briefly for the delete to land.
    fn assert_creds_cleared(store: &ClaudeAccountStore, id: &str) {
        for _ in 0..40 {
            if store.creds(id).is_none() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(store.creds(id).is_none(), "keychain entry not cleared");
    }

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
        let _g = keychain_guard();
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
        let _g = keychain_guard();
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
        let _g = keychain_guard();
        let dir = tempdir().unwrap();
        let store = ClaudeAccountStore::new(dir.path().join("a.json"));
        let uid = format!("test-{}", uuid::Uuid::new_v4());
        store.upsert(acct(&uid, "kc@t.t"), &creds("tok-round")).unwrap();
        let v = store.creds(&uid).expect("creds stored");
        assert_eq!(v["accessToken"], "tok-round");
        store.remove(&uid);
        assert_creds_cleared(&store, &uid);
    }
}
