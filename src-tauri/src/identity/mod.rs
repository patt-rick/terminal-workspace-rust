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

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Resolution {
    None,
    Apply { account: Account },
    Ask { suggested_account_id: Option<String> },
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

/// Return the login embedded as userinfo in an HTTPS remote URL, if any.
pub fn remote_login(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let (userinfo, _tail) = rest.split_once('@')?;
    if userinfo.is_empty() {
        None
    } else {
        Some(userinfo.to_string())
    }
}

/// Decide what to do for a repo, given the configured accounts/mapping/behavior
/// and the repo's GitHub owner (used only to pre-suggest an account in Ask mode).
pub fn resolve(
    accounts: &[Account],
    mapped_id: Option<&str>,
    default_account_id: Option<&str>,
    behavior: UnmappedBehavior,
    owner: Option<&str>,
) -> Resolution {
    if accounts.is_empty() {
        return Resolution::None;
    }
    if let Some(id) = mapped_id {
        if let Some(acc) = accounts.iter().find(|a| a.id == id) {
            return Resolution::Apply { account: acc.clone() };
        }
    }
    // Unmapped, or mapped to an account that was deleted.
    let suggested = owner.and_then(|o| {
        accounts
            .iter()
            .find(|a| a.login.eq_ignore_ascii_case(o))
            .map(|a| a.id.clone())
    });
    match behavior {
        UnmappedBehavior::UseDefault => {
            if let Some(did) = default_account_id {
                if let Some(acc) = accounts.iter().find(|a| a.id == did) {
                    return Resolution::Apply { account: acc.clone() };
                }
            }
            Resolution::Ask { suggested_account_id: suggested }
        }
        UnmappedBehavior::Ask => Resolution::Ask { suggested_account_id: suggested },
    }
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

    #[test]
    fn reads_embedded_login() {
        assert_eq!(
            remote_login("https://octocat@github.com/acme/widgets.git"),
            Some("octocat".to_string())
        );
    }

    #[test]
    fn no_login_when_absent() {
        assert_eq!(remote_login("https://github.com/acme/widgets.git"), None);
    }

    #[test]
    fn no_login_for_ssh() {
        assert_eq!(remote_login("git@github.com:acme/widgets.git"), None);
    }

    fn acct(id: &str, login: &str) -> Account {
        Account {
            id: id.to_string(),
            label: id.to_string(),
            login: login.to_string(),
            name: format!("{id} name"),
            email: format!("{id}@example.com"),
        }
    }

    #[test]
    fn resolve_none_when_no_accounts() {
        let r = resolve(&[], None, None, UnmappedBehavior::Ask, Some("acme"));
        assert!(matches!(r, Resolution::None));
    }

    #[test]
    fn resolve_apply_when_mapped() {
        let accounts = vec![acct("a1", "alpha"), acct("a2", "beta")];
        let r = resolve(&accounts, Some("a2"), None, UnmappedBehavior::Ask, None);
        match r {
            Resolution::Apply { account } => assert_eq!(account.id, "a2"),
            _ => panic!("expected Apply"),
        }
    }

    #[test]
    fn resolve_ask_when_unmapped_and_behavior_ask() {
        let accounts = vec![acct("a1", "alpha")];
        let r = resolve(&accounts, None, None, UnmappedBehavior::Ask, Some("alpha"));
        match r {
            Resolution::Ask { suggested_account_id } => {
                assert_eq!(suggested_account_id, Some("a1".to_string()))
            }
            _ => panic!("expected Ask with suggestion"),
        }
    }

    #[test]
    fn resolve_apply_default_when_use_default() {
        let accounts = vec![acct("a1", "alpha"), acct("a2", "beta")];
        let r = resolve(&accounts, None, Some("a1"), UnmappedBehavior::UseDefault, Some("zzz"));
        match r {
            Resolution::Apply { account } => assert_eq!(account.id, "a1"),
            _ => panic!("expected Apply default"),
        }
    }

    #[test]
    fn resolve_ask_when_use_default_but_no_default_set() {
        let accounts = vec![acct("a1", "alpha")];
        let r = resolve(&accounts, None, None, UnmappedBehavior::UseDefault, None);
        assert!(matches!(r, Resolution::Ask { suggested_account_id: None }));
    }

    #[test]
    fn resolve_ask_when_mapped_account_deleted() {
        let accounts = vec![acct("a1", "alpha")];
        // mapping points to "gone" which no longer exists -> treat as unmapped
        let r = resolve(&accounts, Some("gone"), None, UnmappedBehavior::Ask, Some("alpha"));
        assert!(matches!(r, Resolution::Ask { .. }));
    }
}
