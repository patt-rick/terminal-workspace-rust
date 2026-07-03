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
}

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
}
