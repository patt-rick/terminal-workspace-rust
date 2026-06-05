use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// ---- types ----

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub label: String,
    pub login: String,
    pub name: String,
    pub email: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnmappedBehavior {
    UseDefault,
    Ask,
}

impl Default for UnmappedBehavior {
    fn default() -> Self {
        UnmappedBehavior::Ask
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityData {
    #[serde(default)]
    accounts: Vec<Account>,
    /// repo path -> account id
    #[serde(default)]
    mapping: HashMap<String, String>,
    #[serde(default)]
    default_account_id: Option<String>,
    #[serde(default)]
    unmapped_behavior: UnmappedBehavior,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityConfig {
    pub default_account_id: Option<String>,
    pub unmapped_behavior: UnmappedBehavior,
}

pub struct IdentityStore {
    path: PathBuf,
    inner: Mutex<IdentityData>,
}

impl IdentityStore {
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

    fn persist(&self, data: &IdentityData) {
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

    pub fn accounts(&self) -> Vec<Account> {
        self.inner.lock().accounts.clone()
    }

    pub fn config(&self) -> IdentityConfig {
        let d = self.inner.lock();
        IdentityConfig {
            default_account_id: d.default_account_id.clone(),
            unmapped_behavior: d.unmapped_behavior,
        }
    }
}

// ---- pure helpers ----

/// Rewrite an `origin` URL so `login` is embedded as userinfo. Returns `None`
/// when the URL is not an HTTPS `github.com` remote (SSH, other host, or no
/// path), in which case push-auth routing is skipped and only the commit
/// identity is changed.
pub fn rewrite_remote_url(url: &str, login: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    // Drop any existing `userinfo@`. Repo owners/names cannot contain '@', so
    // the only '@' in a GitHub HTTPS URL is the userinfo separator.
    let after_userinfo = match rest.split_once('@') {
        Some((_userinfo, tail)) => tail,
        None => rest,
    };
    let path = after_userinfo.strip_prefix("github.com/")?;
    if path.is_empty() {
        return None;
    }
    Some(format!("https://{login}@github.com/{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_plain_https_with_git_suffix() {
        assert_eq!(
            rewrite_remote_url("https://github.com/acme/widgets.git", "octocat"),
            Some("https://octocat@github.com/acme/widgets.git".to_string())
        );
    }

    #[test]
    fn rewrites_https_without_git_suffix() {
        assert_eq!(
            rewrite_remote_url("https://github.com/acme/widgets", "octocat"),
            Some("https://octocat@github.com/acme/widgets".to_string())
        );
    }

    #[test]
    fn replaces_existing_userinfo() {
        assert_eq!(
            rewrite_remote_url("https://olduser@github.com/acme/widgets.git", "octocat"),
            Some("https://octocat@github.com/acme/widgets.git".to_string())
        );
    }

    #[test]
    fn skips_ssh_remote() {
        assert_eq!(rewrite_remote_url("git@github.com:acme/widgets.git", "octocat"), None);
    }

    #[test]
    fn skips_non_github_https() {
        assert_eq!(rewrite_remote_url("https://gitlab.com/acme/widgets.git", "octocat"), None);
    }

    #[test]
    fn skips_when_no_path() {
        assert_eq!(rewrite_remote_url("https://github.com/", "octocat"), None);
    }
}
