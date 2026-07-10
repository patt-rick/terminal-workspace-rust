use crate::error::{AppError, AppResult};
use git2::{ConfigLevel, Repository};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentIdentity {
    pub is_repo: bool,
    pub name: Option<String>,
    pub email: Option<String>,
    pub remote_login: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub current: CurrentIdentity,
    pub routing_skipped: bool,
}

/// A GitHub account detected from the local `gh` CLI. `name`/`email` are filled
/// only for the active account (best-effort via `gh api user`); `gh` does not
/// expose them for inactive accounts without switching, which we avoid.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGhAccount {
    pub login: String,
    pub active: bool,
    pub name: Option<String>,
    pub email: Option<String>,
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

    pub fn save_account(&self, account: Account) -> Vec<Account> {
        let mut d = self.inner.lock();
        if let Some(slot) = d.accounts.iter_mut().find(|a| a.id == account.id) {
            *slot = account;
        } else {
            d.accounts.push(account);
        }
        self.persist(&d);
        d.accounts.clone()
    }

    pub fn remove_account(&self, id: &str) -> Vec<Account> {
        let (accounts, unmapped) = {
            let mut d = self.inner.lock();
            d.accounts.retain(|a| a.id != id);
            let unmapped: Vec<String> = d
                .mapping
                .iter()
                .filter(|(_, v)| v.as_str() == id)
                .map(|(k, _)| k.clone())
                .collect();
            d.mapping.retain(|_, v| v != id);
            if d.default_account_id.as_deref() == Some(id) {
                d.default_account_id = None;
            }
            self.persist(&d);
            (d.accounts.clone(), unmapped)
        };
        for path in unmapped {
            let _ = clear_credential_routing(Path::new(&path));
        }
        accounts
    }

    pub fn set_config(
        &self,
        default_account_id: Option<String>,
        unmapped_behavior: UnmappedBehavior,
    ) -> IdentityConfig {
        let mut d = self.inner.lock();
        d.default_account_id = default_account_id;
        d.unmapped_behavior = unmapped_behavior;
        self.persist(&d);
        IdentityConfig {
            default_account_id: d.default_account_id.clone(),
            unmapped_behavior: d.unmapped_behavior,
        }
    }

    /// Decide what to do for a repo. `owner` is the repo's GitHub owner (if known).
    pub fn resolve_for(&self, repo_path: &str, owner: Option<&str>) -> Resolution {
        let d = self.inner.lock();
        resolve(
            &d.accounts,
            d.mapping.get(repo_path).map(|s| s.as_str()),
            d.default_account_id.as_deref(),
            d.unmapped_behavior,
            owner,
        )
    }

    /// Apply an account to a repo and remember the mapping.
    pub fn apply(&self, repo_path: &str, account_id: &str) -> AppResult<ApplyResult> {
        let account = self
            .accounts()
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| AppError::Msg("account not found".to_string()))?;
        let routing_skipped = apply_identity(Path::new(repo_path), &account)?;
        {
            let mut d = self.inner.lock();
            d.mapping.insert(repo_path.to_string(), account_id.to_string());
            self.persist(&d);
        }
        let current = current_identity(Path::new(repo_path), Some(account_id.to_string()));
        Ok(ApplyResult {
            current,
            routing_skipped,
        })
    }

    /// Forget a repo's mapping and remove its credential routing (restore the
    /// inherited helper chain). Author identity in the repo is left untouched.
    pub fn unmap(&self, repo_path: &str) {
        {
            let mut d = self.inner.lock();
            d.mapping.remove(repo_path);
            self.persist(&d);
        }
        let _ = clear_credential_routing(Path::new(repo_path));
    }

    /// Read the current identity for a repo, including its mapped account (if any).
    pub fn current(&self, repo_path: &str) -> CurrentIdentity {
        let mapped = self.inner.lock().mapping.get(repo_path).cloned();
        current_identity(Path::new(repo_path), mapped)
    }

    /// Preflight the mapped account's push credentials for a repo. Only HTTPS
    /// github origins depend on gh; others (unmapped, SSH) return ok with no login.
    pub fn preflight(&self, repo_path: &str) -> PreflightResult {
        let login = {
            let d = self.inner.lock();
            d.mapping
                .get(repo_path)
                .and_then(|id| d.accounts.iter().find(|a| &a.id == id))
                .map(|a| a.login.clone())
        };
        let effective = if origin_is_https_github(Path::new(repo_path)) {
            login.as_deref()
        } else {
            None
        };
        evaluate_preflight(effective, real_gh_probe)
    }

    /// Set the account as the global git identity (`git config --global`).
    pub fn apply_global(&self, account_id: &str) -> AppResult<()> {
        let account = self
            .accounts()
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| AppError::Msg("account not found".to_string()))?;
        apply_global(&account)
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

// ---- git mutations ----

/// Set local `user.name`/`user.email` and (for HTTPS github remotes) embed the
/// account login in `origin`. Returns `true` when push-auth routing was skipped
/// because `origin` is missing or not an HTTPS github remote.
pub fn apply_identity(repo_path: &Path, account: &Account) -> AppResult<bool> {
    let repo = Repository::discover(repo_path)
        .map_err(|e| AppError::Msg(format!("not a git repository: {e}")))?;

    {
        let cfg = repo.config().map_err(|e| AppError::Msg(e.to_string()))?;
        let mut local = cfg
            .open_level(ConfigLevel::Local)
            .map_err(|e| AppError::Msg(e.to_string()))?;
        local
            .set_str("user.name", &account.name)
            .map_err(|e| AppError::Msg(e.to_string()))?;
        local
            .set_str("user.email", &account.email)
            .map_err(|e| AppError::Msg(e.to_string()))?;
    }

    let url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(String::from));
    let routing_skipped = match url.as_deref().and_then(|u| rewrite_remote_url(u, &account.login)) {
        Some(new_url) => {
            repo.remote_set_url("origin", &new_url)
                .map_err(|e| AppError::Msg(e.to_string()))?;
            // HTTPS github origin: route push auth through gh for this repo.
            write_credential_routing(repo_path, &account.login)?;
            false
        }
        None => true,
    };
    Ok(routing_skipped)
}

/// Write the account's identity to the global git config. Shelling out to the
/// git CLI (as the push path does) guarantees `~/.gitconfig` is created on first
/// use, which `git2`'s global config level does not.
pub fn apply_global(account: &Account) -> AppResult<()> {
    use std::process::Command;
    for (key, val) in [
        ("user.name", account.name.as_str()),
        ("user.email", account.email.as_str()),
    ] {
        let out = Command::new("git")
            .args(["config", "--global", key, val])
            .output()
            .map_err(|e| AppError::Msg(e.to_string()))?;
        if !out.status.success() {
            return Err(AppError::Msg(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
    }
    Ok(())
}

/// GitHub logins are ASCII alphanumerics and hyphens. Enforced server-side
/// before a login is embedded in the sh credential helper, so injection safety
/// doesn't rest on the frontend form validation alone.
fn valid_login(login: &str) -> bool {
    !login.is_empty() && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The inline `sh` credential helper written to a repo's local `credential.helper`.
/// Git for Windows runs `!`-prefixed helpers via its bundled `sh`, appending the
/// operation (`get`/`store`/`erase`) as `$1`. We answer only `get`; `store`/`erase`
/// short-circuit to a no-op. `login` is validated by `valid_login` before it is
/// embedded, so it needs no shell escaping. The token is resolved at fill
/// time from gh's keyring and never persisted.
fn credential_helper_value(login: &str) -> String {
    format!(
        "!f() {{ test $1 = get && echo username={login} && echo password=$(gh auth token --user {login}); }}; f"
    )
}

/// Run a `git config` subcommand in `repo_path`, erroring on a non-success exit.
fn run_git_config(repo_path: &Path, args: &[&str]) -> AppResult<()> {
    use std::process::Command;
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    if !out.status.success() {
        return Err(AppError::Msg(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

/// Route this HTTPS github repo's push auth through `gh auth token --user <login>`.
/// Resets the inherited helper chain (GCM + global gh) with an empty first entry,
/// then adds our inline helper. `--unset-all` first makes re-apply idempotent and
/// re-map overwrite. CLI (not git2) for correct multi-value + Windows quoting.
fn write_credential_routing(repo_path: &Path, login: &str) -> AppResult<()> {
    if !valid_login(login) {
        return Err(AppError::Msg(format!(
            "invalid GitHub login {login:?} — refusing to write credential helper"
        )));
    }
    // Exit code 5 = "nothing to unset"; ignore any failure here (best-effort reset).
    let _ = run_git_config(
        repo_path,
        &["config", "--local", "--unset-all", "credential.helper"],
    );
    run_git_config(
        repo_path,
        &["config", "--local", "--add", "credential.helper", ""],
    )?;
    let helper = credential_helper_value(login);
    run_git_config(
        repo_path,
        &["config", "--local", "--add", "credential.helper", &helper],
    )?;
    Ok(())
}

/// Remove all local `credential.helper` entries, restoring the inherited chain.
/// Used on unmap and account removal. Ignores "nothing to unset".
fn clear_credential_routing(repo_path: &Path) -> AppResult<()> {
    let _ = run_git_config(
        repo_path,
        &["config", "--local", "--unset-all", "credential.helper"],
    );
    Ok(())
}

/// Outcome of probing `gh` for a login's token.
#[derive(Clone, Copy)]
pub enum GhProbe {
    /// `gh` binary not found on PATH.
    Missing,
    /// `gh auth token --user <login>` exited 0 with a token.
    TokenOk,
    /// `gh` present but the token could not be fetched (account logged out).
    TokenFailed,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub login: Option<String>,
}

/// Decide whether a push for `login` will authenticate, given a gh probe. Pure so
/// it can be unit-tested with a stubbed probe (no real `gh` needed). `login=None`
/// (repo unmapped or non-HTTPS remote) means gh is not in the loop — always ok.
pub fn evaluate_preflight(
    login: Option<&str>,
    probe: impl FnOnce(&str) -> GhProbe,
) -> PreflightResult {
    let Some(login) = login else {
        return PreflightResult { ok: true, reason: None, login: None };
    };
    match probe(login) {
        GhProbe::Missing => PreflightResult {
            ok: false,
            reason: Some(
                "GitHub CLI (gh) not found on PATH — install gh or use an SSH remote".to_string(),
            ),
            login: Some(login.to_string()),
        },
        GhProbe::TokenOk => PreflightResult {
            ok: true,
            reason: None,
            login: Some(login.to_string()),
        },
        GhProbe::TokenFailed => PreflightResult {
            ok: false,
            reason: Some(format!("{login} isn't logged in to gh — run `gh auth login`")),
            login: Some(login.to_string()),
        },
    }
}

/// Real gh probe: spawn errors ⇒ Missing; non-zero/empty ⇒ TokenFailed.
fn real_gh_probe(login: &str) -> GhProbe {
    use std::process::Command;
    match Command::new("gh")
        .args(["auth", "token", "--user", login])
        .output()
    {
        Err(_) => GhProbe::Missing,
        Ok(out) if out.status.success() && !out.stdout.trim_ascii().is_empty() => GhProbe::TokenOk,
        Ok(_) => GhProbe::TokenFailed,
    }
}

/// True when `origin` is an HTTPS github.com remote (routing applies).
fn origin_is_https_github(repo_path: &Path) -> bool {
    Repository::discover(repo_path)
        .ok()
        .and_then(|r| r.find_remote("origin").ok().and_then(|rm| rm.url().map(String::from)))
        .and_then(|u| rewrite_remote_url(&u, "x"))
        .is_some()
}

/// Read the effective identity + embedded origin login for display. `account_id`
/// is the mapped account for this repo (passed through unchanged).
pub fn current_identity(repo_path: &Path, account_id: Option<String>) -> CurrentIdentity {
    let repo = match Repository::discover(repo_path) {
        Ok(r) => r,
        Err(_) => {
            return CurrentIdentity {
                is_repo: false,
                name: None,
                email: None,
                remote_login: None,
                account_id,
            }
        }
    };
    // Read the LOCAL config level only: apply_identity writes locally, so the
    // read-back must not fall back to the user's global identity (which would
    // falsely report an unconfigured repo as configured).
    let local = repo
        .config()
        .ok()
        .and_then(|c| c.open_level(ConfigLevel::Local).ok());
    let name = local.as_ref().and_then(|c| c.get_string("user.name").ok());
    let email = local.as_ref().and_then(|c| c.get_string("user.email").ok());
    let remote_login = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(String::from))
        .and_then(|u| remote_login(&u));
    CurrentIdentity {
        is_repo: true,
        name,
        email,
        remote_login,
        account_id,
    }
}

/// Detect github.com accounts the user is already logged into via the `gh` CLI.
/// Parses `gh auth status` for logins + the active flag, and enriches the active
/// account with name/email from `gh api user` (best effort). Returns an error
/// only when the `gh` binary is missing.
pub fn detect_gh_accounts() -> AppResult<Vec<DetectedGhAccount>> {
    use std::process::Command;
    let out = Command::new("gh")
        .args(["auth", "status"])
        .output()
        .map_err(|_| AppError::Msg("GitHub CLI (gh) not found on PATH".to_string()))?;
    // gh prints the status to stderr on some versions, stdout on others.
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let mut accounts: Vec<DetectedGhAccount> = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        // e.g. "✓ Logged in to github.com account patt-rick (keyring)"
        if l.contains("Logged in") {
            if let Some(idx) = l.find("account ") {
                let login = l[idx + "account ".len()..]
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !login.is_empty() {
                    accounts.push(DetectedGhAccount {
                        login,
                        active: false,
                        name: None,
                        email: None,
                    });
                }
            }
        } else if l.contains("Active account: true") {
            if let Some(last) = accounts.last_mut() {
                last.active = true;
            }
        }
    }

    // Enrich the active account with name/email (gh api uses the active account).
    if accounts.iter().any(|a| a.active) {
        if let Ok(u) = Command::new("gh")
            .args(["api", "user", "--jq", "{login: .login, name: .name, email: .email}"])
            .output()
        {
            if u.status.success() {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&u.stdout) {
                    let api_login = v.get("login").and_then(|x| x.as_str());
                    if let Some(active) = accounts.iter_mut().find(|a| a.active) {
                        if api_login == Some(active.login.as_str()) {
                            active.name = v
                                .get("name")
                                .and_then(|x| x.as_str())
                                .map(str::to_string)
                                .filter(|s| !s.is_empty());
                            active.email = v
                                .get("email")
                                .and_then(|x| x.as_str())
                                .map(str::to_string)
                                .filter(|s| !s.is_empty());
                        }
                    }
                }
            }
        }
    }

    Ok(accounts)
}

/// Make `login` the active gh account (`gh auth switch --user <login>`). This is
/// the ONE feature that mutates global gh state, so it's opt-in. Errors when gh
/// is missing or the switch fails.
pub fn align_gh(login: &str) -> AppResult<()> {
    use std::process::Command;
    let out = Command::new("gh")
        .args(["auth", "switch", "--user", login])
        .output()
        .map_err(|_| AppError::Msg("GitHub CLI (gh) not found on PATH".to_string()))?;
    if !out.status.success() {
        return Err(AppError::Msg(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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

    #[test]
    fn apply_identity_sets_config_and_rewrites_origin() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();

        let account = acct("a1", "octocat");
        let routing_skipped = apply_identity(dir.path(), &account).unwrap();
        assert!(!routing_skipped);

        // Re-open and assert local config + remote url.
        let repo = git2::Repository::open(dir.path()).unwrap();
        let cfg = repo.config().unwrap();
        assert_eq!(cfg.get_string("user.name").unwrap(), "a1 name");
        assert_eq!(cfg.get_string("user.email").unwrap(), "a1@example.com");
        let url = repo.find_remote("origin").unwrap().url().unwrap().to_string();
        assert_eq!(url, "https://octocat@github.com/acme/widgets.git");
    }

    #[test]
    fn apply_identity_skips_routing_for_ssh_origin() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "git@github.com:acme/widgets.git").unwrap();

        let routing_skipped = apply_identity(dir.path(), &acct("a1", "octocat")).unwrap();
        assert!(routing_skipped);

        let repo = git2::Repository::open(dir.path()).unwrap();
        let url = repo.find_remote("origin").unwrap().url().unwrap().to_string();
        assert_eq!(url, "git@github.com:acme/widgets.git"); // unchanged
    }

    #[test]
    fn current_identity_reads_back_values() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        apply_identity(dir.path(), &acct("a1", "octocat")).unwrap();

        let cur = current_identity(dir.path(), Some("a1".to_string()));
        assert!(cur.is_repo);
        assert_eq!(cur.name.as_deref(), Some("a1 name"));
        assert_eq!(cur.email.as_deref(), Some("a1@example.com"));
        assert_eq!(cur.remote_login.as_deref(), Some("octocat"));
        assert_eq!(cur.account_id.as_deref(), Some("a1"));
    }

    #[test]
    fn current_identity_reports_non_repo() {
        let dir = tempdir().unwrap();
        let cur = current_identity(dir.path(), None);
        assert!(!cur.is_repo);
        assert_eq!(cur.name, None);
        assert_eq!(cur.email, None);
        assert_eq!(cur.remote_login, None);
        assert_eq!(cur.account_id, None);
    }

    #[test]
    fn multi_repo_applies_distinct_identities_and_skips_ssh() {
        // R2.13 mixed case: sub-repos mapped to different accounts, one SSH repo.
        // Each repo keeps its own identity; SSH routing is skipped, others rewrite.
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let c = tempdir().unwrap();
        git2::Repository::init(a.path())
            .unwrap()
            .remote("origin", "https://github.com/acme/back.git")
            .unwrap();
        git2::Repository::init(b.path())
            .unwrap()
            .remote("origin", "https://github.com/acme/front.git")
            .unwrap();
        git2::Repository::init(c.path())
            .unwrap()
            .remote("origin", "git@github.com:acme/infra.git")
            .unwrap();

        let alpha = acct("a1", "alpha");
        let beta = acct("a2", "beta");

        assert!(!apply_identity(a.path(), &alpha).unwrap());
        assert!(!apply_identity(b.path(), &beta).unwrap());
        assert!(apply_identity(c.path(), &alpha).unwrap()); // SSH -> routing skipped

        let ca = current_identity(a.path(), Some("a1".to_string()));
        let cb = current_identity(b.path(), Some("a2".to_string()));
        assert_eq!(ca.email.as_deref(), Some("a1@example.com"));
        assert_eq!(ca.remote_login.as_deref(), Some("alpha"));
        assert_eq!(cb.email.as_deref(), Some("a2@example.com"));
        assert_eq!(cb.remote_login.as_deref(), Some("beta"));

        // SSH repo: user config set but origin url unchanged (no embedded login).
        let rc = git2::Repository::open(c.path()).unwrap();
        assert_eq!(
            rc.find_remote("origin").unwrap().url().unwrap(),
            "git@github.com:acme/infra.git"
        );
        assert_eq!(current_identity(c.path(), None).remote_login, None);
    }

    #[test]
    fn credential_helper_value_is_exact() {
        assert_eq!(
            credential_helper_value("octocat"),
            "!f() { test $1 = get && echo username=octocat && echo password=$(gh auth token --user octocat); }; f"
        );
    }

    // Reads local credential.helper as an ordered Vec (empty entries preserved).
    fn get_all_credential_helper(repo: &std::path::Path) -> Vec<String> {
        let out = std::process::Command::new("git")
            .args(["-C"])
            .arg(repo)
            .args(["config", "--local", "--get-all", "credential.helper"])
            .output()
            .unwrap();
        if !out.status.success() {
            return Vec::new();
        }
        let s = String::from_utf8_lossy(&out.stdout);
        s.strip_suffix('\n')
            .unwrap_or(&s)
            .split('\n')
            .map(|l| l.to_string())
            .collect()
    }

    #[test]
    fn routing_written_with_reset_entry_first() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        assert!(!apply_identity(dir.path(), &acct("a1", "octocat")).unwrap());

        let vals = get_all_credential_helper(dir.path());
        assert_eq!(vals.len(), 2, "expected reset entry + helper");
        assert_eq!(vals[0], "");
        assert_eq!(
            vals[1],
            "!f() { test $1 = get && echo username=octocat && echo password=$(gh auth token --user octocat); }; f"
        );
    }

    #[test]
    fn routing_is_idempotent_on_reapply() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        apply_identity(dir.path(), &acct("a1", "octocat")).unwrap();
        apply_identity(dir.path(), &acct("a1", "octocat")).unwrap();
        assert_eq!(get_all_credential_helper(dir.path()).len(), 2);
    }

    #[test]
    fn routing_overwrites_on_remap() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        apply_identity(dir.path(), &acct("a1", "octocat")).unwrap();
        apply_identity(dir.path(), &acct("a2", "hubot")).unwrap();
        let vals = get_all_credential_helper(dir.path());
        assert_eq!(vals.len(), 2);
        assert!(vals[1].contains("--user hubot"));
        assert!(!vals[1].contains("octocat"));
    }

    #[test]
    fn no_routing_for_ssh_origin() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "git@github.com:acme/widgets.git").unwrap();
        assert!(apply_identity(dir.path(), &acct("a1", "octocat")).unwrap());
        assert!(get_all_credential_helper(dir.path()).is_empty());
    }

    #[test]
    fn clear_routing_removes_all_entries() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        apply_identity(dir.path(), &acct("a1", "octocat")).unwrap();
        clear_credential_routing(dir.path()).unwrap();
        assert!(get_all_credential_helper(dir.path()).is_empty());
    }

    #[test]
    fn routing_rejects_login_with_shell_metacharacters() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        let err = apply_identity(dir.path(), &acct("a1", "x; rm -rf ~")).unwrap_err();
        assert!(err.to_string().contains("invalid GitHub login"));
        assert!(get_all_credential_helper(dir.path()).is_empty());
    }

    #[test]
    fn unmap_and_remove_account_clear_routing() {
        let dir = tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/acme/widgets.git").unwrap();
        let store = IdentityStore::new(dir.path().join("identity.json"));
        store.save_account(acct("a1", "octocat"));
        let path = dir.path().to_string_lossy().to_string();

        store.apply(&path, "a1").unwrap();
        assert_eq!(get_all_credential_helper(dir.path()).len(), 2);

        store.unmap(&path);
        assert!(get_all_credential_helper(dir.path()).is_empty());

        // Re-apply, then remove the account: routing must be cleared too.
        store.apply(&path, "a1").unwrap();
        store.remove_account("a1");
        assert!(get_all_credential_helper(dir.path()).is_empty());
    }

    #[test]
    fn preflight_ok_when_unmapped() {
        let r = evaluate_preflight(None, |_| GhProbe::TokenOk);
        assert!(r.ok);
        assert!(r.login.is_none());
        assert!(r.reason.is_none());
    }

    #[test]
    fn preflight_fails_when_gh_missing() {
        let r = evaluate_preflight(Some("jephtta"), |_| GhProbe::Missing);
        assert!(!r.ok);
        assert!(r.reason.unwrap().contains("gh"));
    }

    #[test]
    fn preflight_fails_when_token_unavailable() {
        let r = evaluate_preflight(Some("jephtta"), |_| GhProbe::TokenFailed);
        assert!(!r.ok);
        assert!(r.reason.unwrap().contains("jephtta"));
    }

    #[test]
    fn preflight_ok_when_token_present() {
        let r = evaluate_preflight(Some("jephtta"), |_| GhProbe::TokenOk);
        assert!(r.ok);
        assert_eq!(r.login.as_deref(), Some("jephtta"));
    }
}
