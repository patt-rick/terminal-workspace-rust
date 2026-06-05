# GitHub Account Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-repo GitHub account switcher to `terminal-workspace-rust` that sets commit identity (`user.name`/`user.email`) and routes HTTPS push auth (by embedding the account login in the `origin` URL), auto-applying when a project is opened.

**Architecture:** A new self-contained Rust `identity/` module owns account profiles, a repo→account mapping, behavior settings, and the git mutations (all via `git2`, plus `git config --global` for the global action). It is exposed through Tauri commands. The React frontend adds an `identity` IPC namespace, a Zustand store, an auto-apply effect that runs on project selection, an account picker, an accounts-management modal, and a current-account badge in the git panel.

**Tech Stack:** Rust (Tauri 2, `git2`/libgit2, `parking_lot`, `serde`), React 19 + TypeScript, Zustand, Tailwind v4, pnpm.

---

## Conventions for every command in this plan

- **Working directory** for all commands is the repo root:
  `C:\Users\Patrick Ackom\Desktop\repos\tw\terminal-workspace-rust`
- Rust tests/build: `cargo test --manifest-path src-tauri/Cargo.toml` / `cargo build --manifest-path src-tauri/Cargo.toml`
- TypeScript check: `pnpm typecheck` (runs `tsc --noEmit`)
- Full web build: `pnpm build`
- Manual app run: `pnpm tauri dev`
- There is **no JS unit-test runner** in this project. Frontend tasks are verified with `pnpm typecheck` and the final manual end-to-end task.

## File Structure

**Rust (new):**
- `src-tauri/src/identity/mod.rs` — account/config types, `IdentityStore` (persistence), pure helpers (`rewrite_remote_url`, `remote_login`, `resolve`), git mutations (`apply_identity`, `current_identity`, `apply_global`), and `#[cfg(test)]` tests.

**Rust (modified):**
- `src-tauri/src/lib.rs` — register `mod identity`, manage `IdentityStore`, add commands to the handler.
- `src-tauri/src/commands.rs` — Tauri command wrappers for identity.
- `src-tauri/Cargo.toml` — add `tempfile` dev-dependency.

**Frontend (new):**
- `src/state/identity.ts` — Zustand store for accounts/config + UI flags (picker/modal open).
- `src/components/identity/accounts-modal.tsx` — manage accounts (CRUD), default, behavior, set-as-global.
- `src/components/identity/account-picker.tsx` — pick/switch the account for the current repo.
- `src/components/identity/identity-auto-apply.tsx` — host: auto-apply effect + renders picker & modal.

**Frontend (modified):**
- `src/lib/ipc.ts` — identity types + `ipc.identity` namespace.
- `src/app.tsx` — mount `<IdentityAutoApply />`.
- `src/components/right-sidebar/git-panel.tsx` — current-account badge that opens the picker.

---

## Task 1: Identity module skeleton — types, store, registration

**Files:**
- Create: `src-tauri/src/identity/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the module with types and store (no git logic yet)**

Create `src-tauri/src/identity/mod.rs` (the `crate::error` and `git2` imports are added in Task 5, where they are first used):

```rust
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
```

The `accounts()`/`config()` methods are unused until Task 7 wires the commands in; the resulting dead-code warnings are expected at this stage and clear in Task 7.

- [ ] **Step 2: Register the module and manage the store in `lib.rs`**

In `src-tauri/src/lib.rs`, add `mod identity;` to the module list (alphabetical, after `mod github;`):

```rust
mod github;
mod identity;
mod pty;
```

Add the import near the other store imports:

```rust
use github::GithubStore;
use identity::IdentityStore;
use pty::PtyManager;
```

In the `.setup(...)` closure, after the `GithubStore` line, manage the new store:

```rust
            app.manage(GithubStore::new(data_dir.join("github.json")));
            app.manage(IdentityStore::new(data_dir.join("identity.json")));
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds successfully (warnings about unused store methods are acceptable at this stage).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/identity/mod.rs src-tauri/src/lib.rs
git commit -m "feat(identity): scaffold account store module"
```

---

## Task 2: `rewrite_remote_url` (TDD)

Pure function: given an `origin` URL and a login, return the HTTPS GitHub URL with the login embedded as userinfo, or `None` if it is not an HTTPS `github.com` remote (so push-routing is skipped).

**Files:**
- Modify: `src-tauri/src/identity/mod.rs`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/identity/mod.rs`:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml rewrite`
Expected: FAIL to compile — `cannot find function rewrite_remote_url`.

- [ ] **Step 3: Implement `rewrite_remote_url`**

Add to `src-tauri/src/identity/mod.rs` (above the `#[cfg(test)]` block), in a `// ---- pure helpers ----` section:

```rust
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml rewrite`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/identity/mod.rs
git commit -m "feat(identity): add remote-url rewrite helper"
```

---

## Task 3: `remote_login` (TDD)

Pure function: extract the login (userinfo) already embedded in an HTTPS remote URL, for display in the badge.

**Files:**
- Modify: `src-tauri/src/identity/mod.rs`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `mod tests` block:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote_login`
Expected: FAIL to compile — `cannot find function remote_login`.

- [ ] **Step 3: Implement `remote_login`**

Add to the `// ---- pure helpers ----` section:

```rust
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote_login`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/identity/mod.rs
git commit -m "feat(identity): add remote-login parser"
```

---

## Task 4: `resolve` decision logic (TDD)

Pure function deciding what to do for a repo: nothing (no accounts), apply a specific account, or ask the user.

**Files:**
- Modify: `src-tauri/src/identity/mod.rs`

- [ ] **Step 1: Write the failing tests**

Add inside the `mod tests` block. The helper `acct` builds a test account:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_`
Expected: FAIL to compile — `Resolution` and `resolve` are not defined.

- [ ] **Step 3: Implement `Resolution` and `resolve`**

Add the `Resolution` type near the other types (after `IdentityConfig`):

```rust
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Resolution {
    None,
    Apply { account: Account },
    Ask { suggested_account_id: Option<String> },
}
```

Add `resolve` to the `// ---- pure helpers ----` section:

```rust
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml resolve_`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/identity/mod.rs
git commit -m "feat(identity): add resolve decision logic"
```

---

## Task 5: Git mutations — `apply_identity` (TDD with a temp repo) + `current_identity`

`apply_identity` sets local `user.name`/`user.email` and rewrites `origin` (returning whether routing was skipped). `current_identity` reads the effective identity back for display.

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `tempfile` dev-dependency)
- Modify: `src-tauri/src/identity/mod.rs`

- [ ] **Step 1: Add the `tempfile` dev-dependency**

In `src-tauri/Cargo.toml`, add a new section immediately after the `[dependencies]` block ends (right after the `git2 = { ... }` line on line 46) and before `[features]`:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Write the failing integration test**

Add inside the `mod tests` block. It creates a real git repo in a temp dir using `git2`:

```rust
    use std::path::Path;
    use tempfile::tempdir;

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml apply_identity`
Expected: FAIL to compile — `apply_identity` / `current_identity` not found.

- [ ] **Step 4: Implement `CurrentIdentity`, `apply_identity`, `current_identity`**

Add the `CurrentIdentity` type near the other types (after `Resolution`):

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentIdentity {
    pub is_repo: bool,
    pub name: Option<String>,
    pub email: Option<String>,
    pub remote_login: Option<String>,
    pub account_id: Option<String>,
}
```

Add a `// ---- git mutations ----` section (above the `#[cfg(test)]` block). Note the `use` lines go at the top of the file with the other imports:

At the top of the file, add to the imports (these are the `crate::error` and `git2` imports deferred from Task 1):

```rust
use crate::error::{AppError, AppResult};
use git2::{ConfigLevel, Repository};
use std::path::Path;
```

Then the section:

```rust
// ---- git mutations ----

/// Set local `user.name`/`user.email` and (for HTTPS github remotes) embed the
/// account login in `origin`. Returns `true` when push-auth routing was skipped
/// because `origin` is missing or not an HTTPS github remote.
pub fn apply_identity(repo_path: &Path, account: &Account) -> AppResult<bool> {
    let repo = Repository::discover(repo_path)
        .map_err(|e| AppError::Msg(format!("not a git repository: {e}")))?;

    {
        let mut cfg = repo.config().map_err(|e| AppError::Msg(e.to_string()))?;
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
            false
        }
        None => true,
    };
    Ok(routing_skipped)
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
    let cfg = repo.config().ok();
    let name = cfg.as_ref().and_then(|c| c.get_string("user.name").ok());
    let email = cfg.as_ref().and_then(|c| c.get_string("user.email").ok());
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — all identity tests (rewrite, remote_login, resolve, apply_identity, current_identity).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/identity/mod.rs
git commit -m "feat(identity): apply identity to repo and read it back"
```

---

## Task 6: Store methods — CRUD, mapping, resolve_for, apply, apply_global

Wire the pure logic and git mutations into `IdentityStore` methods used by the commands.

**Files:**
- Modify: `src-tauri/src/identity/mod.rs`

- [ ] **Step 1: Add an `ApplyResult` type**

After `CurrentIdentity`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub current: CurrentIdentity,
    pub routing_skipped: bool,
}
```

- [ ] **Step 2: Add the store methods**

Inside `impl IdentityStore`, after `config()`, add:

```rust
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
        let mut d = self.inner.lock();
        d.accounts.retain(|a| a.id != id);
        d.mapping.retain(|_, v| v != id);
        if d.default_account_id.as_deref() == Some(id) {
            d.default_account_id = None;
        }
        self.persist(&d);
        d.accounts.clone()
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

    /// Read the current identity for a repo, including its mapped account (if any).
    pub fn current(&self, repo_path: &str) -> CurrentIdentity {
        let mapped = self.inner.lock().mapping.get(repo_path).cloned();
        current_identity(Path::new(repo_path), mapped)
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
```

- [ ] **Step 3: Add the `apply_global` free function**

In the `// ---- git mutations ----` section, add:

```rust
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
```

- [ ] **Step 4: Build and run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — existing tests still pass; the crate builds with the new methods (unused-warning-free except possibly `apply`/`current` until commands land in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/identity/mod.rs
git commit -m "feat(identity): store CRUD, mapping, resolve, apply, global"
```

---

## Task 7: Tauri commands + handler registration

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the identity commands**

In `src-tauri/src/commands.rs`, add to the imports near the other `use crate::` lines:

```rust
use crate::identity::{
    Account, ApplyResult, CurrentIdentity, IdentityConfig, IdentityStore, Resolution,
    UnmappedBehavior,
};
```

At the end of the file (after the `// ---------- claude sessions ----------` section, before `// ---------- helpers ----------`), add:

```rust
// ---------- identity (account switcher) ----------

#[tauri::command]
pub fn identity_list_accounts(ids: State<IdentityStore>) -> Vec<Account> {
    ids.accounts()
}

#[tauri::command]
pub fn identity_get_config(ids: State<IdentityStore>) -> IdentityConfig {
    ids.config()
}

#[tauri::command]
pub fn identity_save_account(ids: State<IdentityStore>, account: Account) -> Vec<Account> {
    ids.save_account(account)
}

#[tauri::command]
pub fn identity_remove_account(ids: State<IdentityStore>, id: String) -> Vec<Account> {
    ids.remove_account(&id)
}

#[tauri::command]
pub fn identity_set_config(
    ids: State<IdentityStore>,
    default_account_id: Option<String>,
    unmapped_behavior: UnmappedBehavior,
) -> IdentityConfig {
    ids.set_config(default_account_id, unmapped_behavior)
}

#[tauri::command]
pub fn identity_resolve(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    project_id: String,
) -> AppResult<Resolution> {
    let root = project_root(&store, &project_id)?;
    let info = crate::git::get_info(Path::new(&root));
    let owner = info.github_repo.as_ref().map(|g| g.owner.clone());
    Ok(ids.resolve_for(&root, owner.as_deref()))
}

#[tauri::command]
pub fn identity_apply(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    project_id: String,
    account_id: String,
) -> AppResult<ApplyResult> {
    let root = project_root(&store, &project_id)?;
    ids.apply(&root, &account_id)
}

#[tauri::command]
pub fn identity_current(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    project_id: String,
) -> AppResult<CurrentIdentity> {
    let root = project_root(&store, &project_id)?;
    Ok(ids.current(&root))
}

#[tauri::command]
pub fn identity_apply_global(ids: State<IdentityStore>, account_id: String) -> AppResult<()> {
    ids.apply_global(&account_id)
}
```

- [ ] **Step 2: Register the commands in the handler**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]`, add after the `commands::claude_session_delete,` line:

```rust
            commands::claude_session_delete,
            commands::identity_list_accounts,
            commands::identity_get_config,
            commands::identity_save_account,
            commands::identity_remove_account,
            commands::identity_set_config,
            commands::identity_resolve,
            commands::identity_apply,
            commands::identity_current,
            commands::identity_apply_global,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds successfully, no warnings about unused identity methods.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(identity): expose tauri commands"
```

---

## Task 8: Frontend IPC types + namespace

**Files:**
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Add the identity types**

In `src/lib/ipc.ts`, after the `ClaudeSession` interface (around line 200), add:

```ts
export interface Account {
  id: string
  label: string
  login: string
  name: string
  email: string
}

export type UnmappedBehavior = 'useDefault' | 'ask'

export interface IdentityConfig {
  defaultAccountId: string | null
  unmappedBehavior: UnmappedBehavior
}

export type IdentityResolution =
  | { kind: 'none' }
  | { kind: 'apply'; account: Account }
  | { kind: 'ask'; suggestedAccountId: string | null }

export interface CurrentIdentity {
  isRepo: boolean
  name: string | null
  email: string | null
  remoteLogin: string | null
  accountId: string | null
}

export interface ApplyResult {
  current: CurrentIdentity
  routingSkipped: boolean
}
```

- [ ] **Step 2: Add the `identity` namespace to the `ipc` object**

In the `ipc` object, after the `claude: { ... }` block (and before the closing `}` of `ipc`), add:

```ts
  identity: {
    listAccounts: () => invoke<Account[]>('identity_list_accounts'),
    getConfig: () => invoke<IdentityConfig>('identity_get_config'),
    saveAccount: (account: Account) =>
      invoke<Account[]>('identity_save_account', { account }),
    removeAccount: (id: string) => invoke<Account[]>('identity_remove_account', { id }),
    setConfig: (config: IdentityConfig) =>
      invoke<IdentityConfig>('identity_set_config', {
        defaultAccountId: config.defaultAccountId,
        unmappedBehavior: config.unmappedBehavior,
      }),
    resolve: (projectId: string) =>
      invoke<IdentityResolution>('identity_resolve', { projectId }),
    apply: (projectId: string, accountId: string) =>
      invoke<ApplyResult>('identity_apply', { projectId, accountId }),
    current: (projectId: string) =>
      invoke<CurrentIdentity>('identity_current', { projectId }),
    applyGlobal: (accountId: string) =>
      invoke<void>('identity_apply_global', { accountId }),
  },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(identity): frontend ipc types and namespace"
```

---

## Task 9: Frontend identity store

**Files:**
- Create: `src/state/identity.ts`

- [ ] **Step 1: Create the store**

Create `src/state/identity.ts`:

```ts
import { create } from 'zustand'
import { ipc, type Account, type IdentityConfig } from '../lib/ipc'

interface IdentityState {
  accounts: Account[]
  config: IdentityConfig
  loaded: boolean
  /** bumped after any apply so dependent views (the badge) refresh */
  appliedTick: number

  // UI flags (shared across the picker, badge, and modal)
  accountsModalOpen: boolean
  pickerProjectId: string | null
  pickerSuggestedId: string | null

  load: () => Promise<void>
  saveAccount: (account: Account) => Promise<void>
  removeAccount: (id: string) => Promise<void>
  setConfig: (config: IdentityConfig) => Promise<void>
  markApplied: () => void

  openAccountsModal: () => void
  closeAccountsModal: () => void
  openPicker: (projectId: string, suggestedId?: string | null) => void
  closePicker: () => void
}

export const useIdentity = create<IdentityState>((set) => ({
  accounts: [],
  config: { defaultAccountId: null, unmappedBehavior: 'ask' },
  loaded: false,
  appliedTick: 0,
  accountsModalOpen: false,
  pickerProjectId: null,
  pickerSuggestedId: null,

  load: async () => {
    const [accounts, config] = await Promise.all([
      ipc.identity.listAccounts(),
      ipc.identity.getConfig(),
    ])
    set({ accounts, config, loaded: true })
  },

  saveAccount: async (account) => {
    const accounts = await ipc.identity.saveAccount(account)
    set({ accounts })
  },

  removeAccount: async (id) => {
    const accounts = await ipc.identity.removeAccount(id)
    set({ accounts })
  },

  setConfig: async (config) => {
    const next = await ipc.identity.setConfig(config)
    set({ config: next })
  },

  markApplied: () => set((s) => ({ appliedTick: s.appliedTick + 1 })),

  openAccountsModal: () => set({ accountsModalOpen: true }),
  closeAccountsModal: () => set({ accountsModalOpen: false }),
  openPicker: (projectId, suggestedId = null) =>
    set({ pickerProjectId: projectId, pickerSuggestedId: suggestedId }),
  closePicker: () => set({ pickerProjectId: null, pickerSuggestedId: null }),
}))
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/state/identity.ts
git commit -m "feat(identity): frontend zustand store"
```

---

## Task 10: Accounts management modal

**Files:**
- Create: `src/components/identity/accounts-modal.tsx`

- [ ] **Step 1: Create the modal**

Create `src/components/identity/accounts-modal.tsx`:

```tsx
import { useState } from 'react'
import { useIdentity } from '../../state/identity'
import type { Account, UnmappedBehavior } from '../../lib/ipc'

const blank = (): Account => ({
  id: crypto.randomUUID(),
  label: '',
  login: '',
  name: '',
  email: '',
})

export function AccountsModal() {
  const open = useIdentity((s) => s.accountsModalOpen)
  const close = useIdentity((s) => s.closeAccountsModal)
  const accounts = useIdentity((s) => s.accounts)
  const config = useIdentity((s) => s.config)
  const saveAccount = useIdentity((s) => s.saveAccount)
  const removeAccount = useIdentity((s) => s.removeAccount)
  const setConfig = useIdentity((s) => s.setConfig)

  const [draft, setDraft] = useState<Account | null>(null)
  const [globalMsg, setGlobalMsg] = useState<string | null>(null)

  if (!open) return null

  const startAdd = (): void => setDraft(blank())
  const startEdit = (a: Account): void => setDraft({ ...a })

  const canSave =
    !!draft && draft.label.trim() && draft.login.trim() && draft.name.trim() && draft.email.trim()

  const onSave = async (): Promise<void> => {
    if (!draft || !canSave) return
    await saveAccount({
      id: draft.id,
      label: draft.label.trim(),
      login: draft.login.trim(),
      name: draft.name.trim(),
      email: draft.email.trim(),
    })
    setDraft(null)
  }

  const onSetGlobal = async (a: Account): Promise<void> => {
    setGlobalMsg(null)
    try {
      const { ipc } = await import('../../lib/ipc')
      await ipc.identity.applyGlobal(a.id)
      setGlobalMsg(`Global git identity set to ${a.label}.`)
    } catch (e) {
      setGlobalMsg(String(e))
    }
  }

  const setBehavior = (b: UnmappedBehavior): void => {
    void setConfig({ ...config, unmappedBehavior: b })
  }
  const setDefault = (id: string | null): void => {
    void setConfig({ ...config, defaultAccountId: id })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="flex max-h-[80vh] w-[34rem] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">GitHub accounts</h2>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {/* account list */}
          <div className="space-y-1">
            {accounts.length === 0 && (
              <div className="py-2 text-xs text-muted">No accounts yet.</div>
            )}
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.label}</div>
                  <div className="truncate text-xs text-muted">
                    {a.login} · {a.email}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onSetGlobal(a)}
                  title="Set as global git identity"
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Set global
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(a)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void removeAccount(a.id)}
                  className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-foreground/5"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>

          {globalMsg && <div className="mt-2 text-xs text-muted">{globalMsg}</div>}

          {/* add / edit form */}
          {draft ? (
            <div className="mt-3 space-y-2 rounded-md border border-border p-3">
              <Field
                label="Label"
                value={draft.label}
                onChange={(v) => setDraft({ ...draft, label: v })}
                placeholder="Personal"
              />
              <Field
                label="GitHub login"
                value={draft.login}
                onChange={(v) => setDraft({ ...draft, login: v })}
                placeholder="octocat"
              />
              <Field
                label="Commit name (user.name)"
                value={draft.name}
                onChange={(v) => setDraft({ ...draft, name: v })}
                placeholder="Octo Cat"
              />
              <Field
                label="Commit email (user.email)"
                value={draft.email}
                onChange={(v) => setDraft({ ...draft, email: v })}
                placeholder="octocat@users.noreply.github.com"
              />
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
                  disabled={!canSave}
                  onClick={() => void onSave()}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={startAdd}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-foreground/5"
            >
              + Add account
            </button>
          )}

          {/* behavior settings */}
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              When opening an unmapped repo
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={config.unmappedBehavior === 'ask'}
                onChange={() => setBehavior('ask')}
              />
              Always ask
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={config.unmappedBehavior === 'useDefault'}
                onChange={() => setBehavior('useDefault')}
              />
              Use default account
            </label>
            {config.unmappedBehavior === 'useDefault' && (
              <div className="mt-2">
                <label className="text-xs text-muted">Default account</label>
                <select
                  value={config.defaultAccountId ?? ''}
                  onChange={(e) => setDefault(e.target.value || null)}
                  className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                >
                  <option value="">— none —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </div>
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
        className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
      />
    </label>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/identity/accounts-modal.tsx
git commit -m "feat(identity): accounts management modal"
```

---

## Task 11: Account picker

**Files:**
- Create: `src/components/identity/account-picker.tsx`

- [ ] **Step 1: Create the picker**

Create `src/components/identity/account-picker.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useIdentity } from '../../state/identity'

export function AccountPicker() {
  const projectId = useIdentity((s) => s.pickerProjectId)
  const suggestedId = useIdentity((s) => s.pickerSuggestedId)
  const accounts = useIdentity((s) => s.accounts)
  const close = useIdentity((s) => s.closePicker)
  const openAccountsModal = useIdentity((s) => s.openAccountsModal)
  const markApplied = useIdentity((s) => s.markApplied)

  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reset selection whenever the picker (re)opens.
  useEffect(() => {
    if (projectId) setSelected(suggestedId ?? accounts[0]?.id ?? null)
  }, [projectId, suggestedId, accounts])

  if (!projectId) return null

  const onApply = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      await ipc.identity.apply(projectId, selected)
      markApplied()
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="w-[24rem] rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">Account for this repo</h2>

        {accounts.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">No accounts configured yet.</p>
            <button
              type="button"
              onClick={() => {
                close()
                openAccountsModal()
              }}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              Add an account
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              {accounts.map((a) => (
                <label
                  key={a.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5"
                >
                  <input
                    type="radio"
                    checked={selected === a.id}
                    onChange={() => setSelected(a.id)}
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium">{a.label}</span>
                    <span className="ml-2 text-xs text-muted">{a.login}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  close()
                  openAccountsModal()
                }}
                className="text-xs text-link hover:underline"
              >
                Manage accounts…
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!selected || busy}
                  onClick={() => void onApply()}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/identity/account-picker.tsx
git commit -m "feat(identity): account picker modal"
```

---

## Task 12: Auto-apply host + mount in app

**Files:**
- Create: `src/components/identity/identity-auto-apply.tsx`
- Modify: `src/app.tsx`

- [ ] **Step 1: Create the host component**

Create `src/components/identity/identity-auto-apply.tsx`:

```tsx
import { useEffect } from 'react'
import { ipc } from '../../lib/ipc'
import { useWorkspace } from '../../state/store'
import { useIdentity } from '../../state/identity'
import { AccountPicker } from './account-picker'
import { AccountsModal } from './accounts-modal'

/**
 * Watches the selected project and applies the right GitHub account on open:
 * - `apply`  -> set identity silently
 * - `ask`    -> open the picker (suggestion preselected)
 * - `none`   -> do nothing (no accounts, or not a git repo)
 * Also hosts the picker and accounts modal so any component can open them.
 */
export function IdentityAutoApply() {
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const loaded = useIdentity((s) => s.loaded)
  const load = useIdentity((s) => s.load)
  const openPicker = useIdentity((s) => s.openPicker)
  const markApplied = useIdentity((s) => s.markApplied)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  useEffect(() => {
    if (!selectedProjectId) return
    let cancelled = false
    void ipc.identity
      .resolve(selectedProjectId)
      .then((res) => {
        if (cancelled) return
        if (res.kind === 'apply') {
          void ipc.identity.apply(selectedProjectId, res.account.id).then(() => {
            if (!cancelled) markApplied()
          })
        } else if (res.kind === 'ask') {
          openPicker(selectedProjectId, res.suggestedAccountId)
        }
      })
      .catch(() => {
        // resolve fails when the project isn't a git repo; ignore.
      })
    return () => {
      cancelled = true
    }
  }, [selectedProjectId, openPicker, markApplied])

  return (
    <>
      <AccountPicker />
      <AccountsModal />
    </>
  )
}
```

- [ ] **Step 2: Mount it in `app.tsx`**

In `src/app.tsx`, add the import after the `SettingsModal` import (line 8):

```ts
import { SettingsModal } from './components/settings-modal'
import { IdentityAutoApply } from './components/identity/identity-auto-apply'
```

Render it just before the closing `</div>` of the root container, right after the `<SettingsModal ... />` line (line 271):

```tsx
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <IdentityAutoApply />
    </div>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/identity/identity-auto-apply.tsx src/app.tsx
git commit -m "feat(identity): auto-apply on project open"
```

---

## Task 13: Current-account badge in the git panel

**Files:**
- Modify: `src/components/right-sidebar/git-panel.tsx`

- [ ] **Step 1: Add imports and current-identity state**

In `src/components/right-sidebar/git-panel.tsx`, update the imports at the top:

```ts
import { useCallback, useEffect, useState } from 'react'
import { ipc, type CurrentIdentity, type FileDiff, type GitInfo } from '../../lib/ipc'
import { useDiffView } from '../../state/diff'
import { useIdentity } from '../../state/identity'
```

Inside the `GitPanel` component, after the existing `const [pushMsg, setPushMsg] = useState<string | null>(null)` line, add:

```ts
  const [identity, setIdentity] = useState<CurrentIdentity | null>(null)
  const accounts = useIdentity((s) => s.accounts)
  const appliedTick = useIdentity((s) => s.appliedTick)
  const openPicker = useIdentity((s) => s.openPicker)
```

- [ ] **Step 2: Fetch current identity in `refresh` and on apply**

Replace the existing `refresh` callback with one that also loads the current identity:

```ts
  const refresh = useCallback(() => {
    setLoading(true)
    Promise.all([
      ipc.git.info(projectId).catch(() => null),
      ipc.git.diff(projectId).catch(() => [] as FileDiff[]),
    ])
      .then(([i, d]) => {
        setInfo(i)
        setDiffs(d)
      })
      .finally(() => setLoading(false))
    ipc.identity.current(projectId).then(setIdentity).catch(() => setIdentity(null))
  }, [projectId])

  useEffect(refresh, [refresh])

  // Refresh the badge when an account is applied elsewhere (picker / auto-apply).
  useEffect(() => {
    ipc.identity.current(projectId).then(setIdentity).catch(() => setIdentity(null))
  }, [projectId, appliedTick])
```

(The original file already has `useEffect(refresh, [refresh])` — keep a single copy; the block above includes it.)

- [ ] **Step 3: Render the badge in the header**

In the header `div` (the one containing the branch name), add the badge button after the closing of the branch info `</div>` and before the Refresh button. Locate this block:

```tsx
          {info.behind > 0 && <span className="text-warning">↓{info.behind}</span>}
        </div>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
```

Insert the badge between `</div>` and the Refresh `<button>`:

```tsx
          {info.behind > 0 && <span className="text-warning">↓{info.behind}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => openPicker(projectId, identity?.accountId ?? null)}
            title="Switch GitHub account for this repo"
            className="max-w-[8rem] truncate rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground/70 hover:bg-foreground/5"
          >
            {accountLabel(identity, accounts)}
          </button>
          <button
            type="button"
            onClick={refresh}
            title="Refresh"
```

Then close the wrapping `div` after the Refresh button's closing `</button>`. Locate:

```tsx
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
```

and change the trailing `</button>` / `</div>` to close both the button and the new wrapper:

```tsx
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          </button>
        </div>
      </div>
```

- [ ] **Step 4: Add the `accountLabel` helper**

At the top of the file, after the existing `basename` helper, add:

```ts
const accountLabel = (
  identity: CurrentIdentity | null,
  accounts: { id: string; label: string }[]
): string => {
  const id = identity?.accountId
  const matched = id ? accounts.find((a) => a.id === id) : undefined
  if (matched) return matched.label
  if (identity?.remoteLogin) return identity.remoteLogin
  return 'Set account'
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/right-sidebar/git-panel.tsx
git commit -m "feat(identity): current-account badge in git panel"
```

---

## Task 14: Full build + manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full type/build check**

Run: `pnpm build`
Expected: `tsc --noEmit` passes and Vite builds with no errors.

- [ ] **Step 2: Full Rust test + build**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all identity tests pass.

- [ ] **Step 3: Launch the app**

Run: `pnpm tauri dev`
Expected: the app launches without console errors.

- [ ] **Step 4: Manual end-to-end checks**

Verify each, in order:

1. **Add accounts.** Open a project, open the git panel (right sidebar). Click the account badge → "Manage accounts…" → add two accounts (e.g. Personal `login=patt-rick`, and a second one). Confirm they persist after closing/reopening the modal.
2. **Behavior = Ask.** Set "When opening an unmapped repo" to **Always ask**. Select a different project that has an HTTPS `github.com` origin and no mapping yet → the picker appears. Pick an account → Apply.
3. **Verify the repo was configured.** In a terminal at that repo run:
   - `git config --local user.name` and `git config --local user.email` → match the chosen account.
   - `git remote get-url origin` → now `https://<login>@github.com/owner/repo.git`.
4. **Mapping sticks.** Switch to another project and back → no prompt; the badge shows the mapped account; identity unchanged.
5. **Badge switch.** Click the badge → pick the other account → Apply → confirm `git config --local user.email` and the origin login changed.
6. **Use-default mode.** In Manage accounts, set behavior to **Use default account** and choose a default. Open a fresh unmapped repo → it applies the default silently (badge shows it; no prompt).
7. **Routing skipped.** Open a repo whose origin is SSH (`git@github.com:...`) or has no remote → applying sets only `user.name`/`user.email`; origin is left unchanged (no error).
8. **Set global.** In Manage accounts, click "Set global" on an account → run `git config --global user.email` in any directory → matches.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(identity): end-to-end verification fixes"
```

(If no fixes were needed, skip this step.)

---

## Notes for the implementer

- **Tauri arg casing:** Tauri converts camelCase JS keys to snake_case Rust params automatically (e.g. JS `{ projectId }` → Rust `project_id`). This is why the IPC layer sends camelCase while the commands declare snake_case.
- **Credential helper:** This feature never stores tokens. After the origin URL carries the account login, the **first push per account** triggers the active credential helper (Git Credential Manager on Windows, or `gh` if `gh auth setup-git` was run) to prompt once and remember the token. That prompt is expected and out of scope here.
- **Mapping key:** the repo→account mapping is keyed by the project's absolute path (the same string `StateStore` stores), so it survives app restarts and project re-selection.
