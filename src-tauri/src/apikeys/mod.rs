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
    /// Optional command auto-run in a terminal launched for this entry
    /// (e.g. `aider --model deepseek/deepseek-chat`). Serialized as null when
    /// absent so the frontend type is always `string | null`, never undefined.
    #[serde(default)]
    pub launch_command: Option<String>,
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

    pub fn keys_snapshot(&self) -> Vec<ApiKey> {
        self.inner.lock().keys.clone()
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

/// Default API base for the reachability test, for presets whose CLIs read the
/// provider's native key env var (so entries carry no *_BASE_URL). An entry's
/// explicit *_BASE_URL extra env still wins.
fn default_base(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "https://api.deepseek.com",
        "grok" => "https://api.x.ai/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        _ => "https://api.openai.com/v1",
    }
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
        let base = base_url.unwrap_or_else(|| default_base(provider)).trim_end_matches('/');
        TestRequest {
            url: format!("{base}/models"),
            headers: vec![("Authorization".to_string(), format!("Bearer {secret}"))],
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

/// True when `name` resolves to a file on PATH. Windows also tries PATHEXT
/// suffixes (an npm shim `codex` on disk is `codex.cmd`). Fails open — any
/// resolution problem returns true so the check can never block a launch.
pub fn binary_on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return true;
    };
    let pathext = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
    } else {
        String::new()
    };
    find_in_paths(name, std::env::split_paths(&paths), &pathext)
}

fn find_in_paths(
    name: &str,
    dirs: impl Iterator<Item = PathBuf>,
    pathext: &str,
) -> bool {
    let exts: Vec<String> = std::iter::once(String::new())
        .chain(
            pathext
                .split(';')
                .filter(|e| !e.is_empty())
                .map(|e| e.to_ascii_lowercase()),
        )
        .collect();
    for dir in dirs {
        for ext in &exts {
            if dir.join(format!("{name}{ext}")).is_file() {
                return true;
            }
        }
    }
    false
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
            launch_command: None,
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

    #[test]
    fn test_request_uses_provider_default_base() {
        let cases = [
            ("deepseek", "https://api.deepseek.com/models"),
            ("grok", "https://api.x.ai/v1/models"),
            ("mistral", "https://api.mistral.ai/v1/models"),
            ("groq", "https://api.groq.com/openai/v1/models"),
            ("openrouter", "https://openrouter.ai/api/v1/models"),
            ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/models"),
            ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1/models"),
            ("custom", "https://api.openai.com/v1/models"),
        ];
        for (provider, url) in cases {
            assert_eq!(build_test_request(provider, None, "sk-x").url, url, "{provider}");
        }
    }

    #[test]
    fn find_in_paths_matches_pathext_and_bare_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("aider.cmd"), "").unwrap();
        fs::write(dir.path().join("rg"), "").unwrap();
        let dirs = || vec![dir.path().to_path_buf()].into_iter();
        assert!(find_in_paths("aider", dirs(), ".COM;.EXE;.BAT;.CMD"));
        assert!(find_in_paths("rg", dirs(), ".COM;.EXE;.BAT;.CMD")); // bare file
        assert!(find_in_paths("rg", dirs(), ""));
        assert!(!find_in_paths("codex", dirs(), ".COM;.EXE;.BAT;.CMD"));
    }

    #[test]
    fn launch_command_roundtrips_and_defaults_to_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        {
            let store = ApiKeyStore::new(path.clone());
            let mut k = key("a", "OPENAI_API_KEY", true);
            k.launch_command = Some("codex".to_string());
            store.save(k, None).unwrap();
        }
        let store = ApiKeyStore::new(path.clone());
        assert_eq!(
            store.keys_snapshot()[0].launch_command.as_deref(),
            Some("codex")
        );

        // Entries persisted before the field existed load as None.
        fs::write(
            &path,
            r#"{"keys":[{"id":"b","provider":"openai","label":"b","keyEnvVar":"OPENAI_API_KEY","extraEnv":{},"enabled":true}]}"#,
        )
        .unwrap();
        let store = ApiKeyStore::new(path);
        assert_eq!(store.keys_snapshot()[0].launch_command, None);
    }
}
