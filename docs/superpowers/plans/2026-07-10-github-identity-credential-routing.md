# GitHub Identity Per-Repo Credential Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every git push — from an embedded terminal, from Claude Code inside a terminal, or from the app's push button — authenticate as the repo's mapped GitHub account with no manual `gh auth switch`, no global-state mutation, and no tokens on disk, by routing each HTTPS github.com repo's credential-helper chain through `gh auth token --user <login>`.

**Architecture:** On apply, `identity::apply_identity` (already sets local `user.name`/`user.email` + rewrites origin) additionally resets the repo-local `credential.helper` list (empty first entry to cut GCM + global gh) and adds an inline `sh` helper that answers `get` with the login + a fresh `gh auth token`. A preflight command validates `gh`/token before pushes and feeds a git-panel "pushing as `<login>`" indicator; an opt-in setting can additionally `gh auth switch` on repo selection. Routing is written via `git config` CLI shell-outs (not git2) for correct multi-value handling and Windows quoting, and is fully removed on unmap/account-removal.

**Tech Stack:** Rust (Tauri 2, git2 + `git`/`gh` CLI shell-outs), React + TypeScript + Zustand + Vite, Windows (Git for Windows bundled `sh` executes `!`-prefixed helpers).

---

## File Structure

**Modified — backend**
- `src-tauri/src/identity/mod.rs` — add `credential_helper_value`, `write_credential_routing`, `clear_credential_routing`, `origin_is_https_github`, `GhProbe`, `PreflightResult`, `evaluate_preflight`, `real_gh_probe`, `align_gh`; wire routing into `apply_identity`; add `IdentityStore::unmap` + `IdentityStore::preflight`; add cleanup to `remove_account`; new unit tests.
- `src-tauri/src/commands.rs` — add `identity_unmap`, `identity_push_preflight`, `identity_align_gh` commands; import `PreflightResult`.
- `src-tauri/src/lib.rs` — register the three new commands (~lines 170-179 block).

**Modified — frontend**
- `src/lib/ipc.ts` — add `PreflightResult` type + `identity.unmap`, `identity.pushPreflight`, `identity.alignGh`.
- `src/state/settings.ts` — add `IdentitySettings` (`alignGhOnSelect`, default off) with defaults/read/snapshot/replaceAll/`updateIdentity`.
- `src/main.tsx` — merge `identity` defaults on hydration.
- `src/components/settings-modal.tsx` (via `AccountsSection`) — the opt-in toggle.
- `src/components/identity/accounts-section.tsx` — render the "Align gh CLI on repo select" toggle.
- `src/components/right-sidebar/git-panel.tsx` — "pushing as `<login>`" indicator, preflight fetch + warning state, preflight-before-push, gh-align effect.

---

### Task 1 — Inline credential-helper string builder (pure)

**Files:** `src-tauri/src/identity/mod.rs` (add near the other `// ---- git mutations ----` helpers, after line 345; test in `mod tests`).

- [ ] Add a failing test at the end of `mod tests` (before the closing `}` at line 686):
```rust
    #[test]
    fn credential_helper_value_is_exact() {
        assert_eq!(
            credential_helper_value("octocat"),
            "!f() { test $1 = get && echo username=octocat && echo password=$(gh auth token --user octocat); }; f"
        );
    }
```
- [ ] Run from `src-tauri`: `cargo test --lib identity::tests::credential_helper_value_is_exact` — expect **compile error** (function undefined).
- [ ] Add the builder after `apply_global` (after line 345):
```rust
/// The inline `sh` credential helper written to a repo's local `credential.helper`.
/// Git for Windows runs `!`-prefixed helpers via its bundled `sh`, appending the
/// operation (`get`/`store`/`erase`) as `$1`. We answer only `get`; `store`/`erase`
/// short-circuit to a no-op. `login` is constrained to `[A-Za-z0-9-]` by the
/// account form, so it needs no shell escaping. The token is resolved at fill
/// time from gh's keyring and never persisted.
fn credential_helper_value(login: &str) -> String {
    format!(
        "!f() {{ test $1 = get && echo username={login} && echo password=$(gh auth token --user {login}); }}; f"
    )
}
```
- [ ] Run the same command — expect **pass**.
- [ ] Commit: `git commit -m "feat(identity): add inline gh credential-helper builder"`

---

### Task 2 — Write/clear credential routing and wire into `apply_identity`

**Files:** `src-tauri/src/identity/mod.rs` (add helpers after `credential_helper_value`; modify `apply_identity` lines 314-322; tests in `mod tests`).

- [ ] Add failing tests at the end of `mod tests`:
```rust
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
```
- [ ] Run: `cargo test --lib identity::tests::routing` and `cargo test --lib identity::tests::clear_routing_removes_all_entries` — expect **compile error** (`write_credential_routing`/`clear_credential_routing` undefined).
- [ ] Add the routing helpers after `credential_helper_value`:
```rust
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
```
- [ ] Modify `apply_identity` (lines 314-322): in the `Some(new_url)` arm, after `repo.remote_set_url(...)?`, add the routing write. Replace the match block with:
```rust
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
```
- [ ] Run: `cargo test --lib identity::tests` — expect **all pass** (new routing tests + existing).
- [ ] Commit: `git commit -m "feat(identity): route HTTPS github push auth through gh credential helper"`

---

### Task 3 — Cleanup on unmap + account removal

**Files:** `src-tauri/src/identity/mod.rs` (modify `remove_account` lines 144-153; add `IdentityStore::unmap`); `src-tauri/src/commands.rs` (add `identity_unmap`); `src-tauri/src/lib.rs` (register); `src/lib/ipc.ts` (add `unmap`).

- [ ] Add a failing test at the end of `mod tests`:
```rust
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
```
- [ ] Run: `cargo test --lib identity::tests::unmap_and_remove_account_clear_routing` — expect **compile error** (`unmap` undefined).
- [ ] Add `IdentityStore::unmap` after `apply` (after line 200):
```rust
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
```
- [ ] Modify `remove_account` (lines 144-153) to clear routing for every repo that mapped to the removed account:
```rust
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
```
- [ ] Add the command in `commands.rs` after `identity_apply` (after line 809):
```rust
#[tauri::command]
pub fn identity_unmap(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    repo_id: String,
) -> AppResult<()> {
    let root = repo_root(&store, &repo_id)?;
    ids.unmap(&root);
    Ok(())
}
```
- [ ] Register in `lib.rs` inside the `identity_*` block (after `commands::identity_apply,` line 176):
```rust
            commands::identity_unmap,
```
- [ ] Add to `ipc.ts` `identity` namespace (after the `apply` entry, line 538):
```ts
    unmap: (repoId: string) => invoke<void>('identity_unmap', { repoId }),
```
- [ ] Run: `cargo test --lib identity::tests::unmap_and_remove_account_clear_routing` — expect **pass**.
- [ ] Verify frontend types: from repo root run `npx tsc --noEmit` — expect **no errors**.
- [ ] Commit: `git commit -m "feat(identity): clear credential routing on unmap and account removal"`

---

### Task 4 — Push preflight (gh present + token available)

**Files:** `src-tauri/src/identity/mod.rs` (add `PreflightResult`, `GhProbe`, `evaluate_preflight`, `real_gh_probe`, `origin_is_https_github`, `IdentityStore::preflight`; tests); `src-tauri/src/commands.rs` (add command + import); `src-tauri/src/lib.rs` (register); `src/lib/ipc.ts` (type + method).

- [ ] Add failing tests at the end of `mod tests`:
```rust
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
```
- [ ] Run: `cargo test --lib identity::tests::preflight` — expect **compile error**.
- [ ] Add the preflight types + logic after `clear_credential_routing`:
```rust
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
```
- [ ] Add `IdentityStore::preflight` after `current` (after line 206):
```rust
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
```
- [ ] Add the command in `commands.rs` after `identity_unmap`:
```rust
#[tauri::command]
pub fn identity_push_preflight(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    repo_id: String,
) -> AppResult<crate::identity::PreflightResult> {
    let root = repo_root(&store, &repo_id)?;
    Ok(ids.preflight(&root))
}
```
- [ ] Add `PreflightResult` to the `use crate::identity::{...}` import (commands.rs lines 11-14).
- [ ] Register in `lib.rs` `identity_*` block: `commands::identity_push_preflight,`
- [ ] Add to `ipc.ts`: the interface near `ApplyResult` (after line 252):
```ts
export interface PreflightResult {
  ok: boolean
  reason: string | null
  login: string | null
}
```
and the method in the `identity` namespace:
```ts
    pushPreflight: (repoId: string) =>
      invoke<PreflightResult>('identity_push_preflight', { repoId }),
```
- [ ] Run: `cargo test --lib identity::tests::preflight` — expect **pass**.
- [ ] Verify frontend types: `npx tsc --noEmit` — expect **no errors**.
- [ ] Commit: `git commit -m "feat(identity): add push preflight for gh token availability"`

---

### Task 5 — `gh auth switch` backend command (for the opt-in align)

**Files:** `src-tauri/src/identity/mod.rs` (add `align_gh`); `src-tauri/src/commands.rs` (command); `src-tauri/src/lib.rs` (register); `src/lib/ipc.ts` (method).

- [ ] Add `align_gh` after `detect_gh_accounts` (after line 458):
```rust
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
```
- [ ] Add the command in `commands.rs` after `identity_detect_gh_accounts` (after line 829):
```rust
#[tauri::command]
pub fn identity_align_gh(login: String) -> AppResult<()> {
    crate::identity::align_gh(&login)
}
```
- [ ] Register in `lib.rs`: `commands::identity_align_gh,`
- [ ] Add to `ipc.ts` `identity` namespace:
```ts
    alignGh: (login: string) => invoke<void>('identity_align_gh', { login }),
```
- [ ] Run from `src-tauri`: `cargo build` — expect **success** (no unit test; behavior verified in e2e Task 9).
- [ ] Verify frontend types: `npx tsc --noEmit` — expect **no errors**.
- [ ] Commit: `git commit -m "feat(identity): add opt-in gh auth switch command"`

---

### Task 6 — Frontend settings plumbing for `alignGhOnSelect`

**Files:** `src/state/settings.ts` (interface/defaults/read/snapshot/replaceAll/action); `src/main.tsx` (hydration merge).

- [ ] In `settings.ts`, add after `TERMINAL_DEFAULTS` (after line 39):
```ts
export interface IdentitySettings {
  /** Opt-in: run `gh auth switch` for the selected repo's account on selection. */
  alignGhOnSelect: boolean
}

export const IDENTITY_DEFAULTS: IdentitySettings = {
  alignGhOnSelect: false,
}
```
- [ ] Add `identity: IdentitySettings` to the `Settings` interface (after `terminal: TerminalSettings`, line 48) and to `SETTINGS_DEFAULTS` (after `terminal: TERMINAL_DEFAULTS,`, line 58): `identity: IDENTITY_DEFAULTS,`.
- [ ] In `readStoredSettings` return object (after the `terminal` line 76) add:
```ts
      identity: { ...IDENTITY_DEFAULTS, ...parsed.identity },
```
- [ ] In the `snapshot` destructure/return (lines 152-153) add `identity`:
```ts
    const { themeId, themeShuffle, lastShuffleDate, editor, terminal, identity, customThemes } = get()
    return { themeId, themeShuffle, lastShuffleDate, editor, terminal, identity, customThemes }
```
- [ ] Add the action to the `SettingsState` interface (after `updateTerminal`, line 103):
```ts
  updateIdentity: (patch: Partial<IdentitySettings>) => void
```
and its implementation in the store return (after `updateTerminal`, line 198):
```ts
    updateIdentity: (patch) => {
      set((state) => ({ identity: { ...state.identity, ...patch } }))
      commit()
    },
```
- [ ] In `replaceAll` (after `terminal: s.terminal,`, line 220) add:
```ts
        identity: s.identity ?? IDENTITY_DEFAULTS,
```
- [ ] In `main.tsx`, import `IDENTITY_DEFAULTS` (add to the settings import block lines 6-13) and add to the `merged` object (after the `terminal` line 39):
```ts
        identity: { ...IDENTITY_DEFAULTS, ...remote.identity },
```
- [ ] Verify: `npx tsc --noEmit` — expect **no errors**.
- [ ] Manual note: settings load in a plain browser (localStorage) still works with the new default off.
- [ ] Commit: `git commit -m "feat(settings): add opt-in align-gh-on-select identity setting"`

---

### Task 7 — Settings toggle UI (GitHub tab)

**Files:** `src/components/identity/accounts-section.tsx` (add the toggle).

- [ ] Add imports at the top of `accounts-section.tsx`:
```ts
import { useSettings } from '../../state/settings'
```
- [ ] Inside `AccountsSection`, add selectors near the other hooks (after line 28):
```ts
  const alignGh = useSettings((s) => s.identity.alignGhOnSelect)
  const updateIdentity = useSettings((s) => s.updateIdentity)
```
- [ ] Add a new subsection just before the closing `</div>` of the component (before line 281, after the unmapped-behavior block):
```tsx
      {/* opt-in: align gh CLI on repo select */}
      <div className="mt-4 border-t border-border pt-3">
        <label className="flex items-start gap-2 text-sm text-foreground/80">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={alignGh}
            onChange={(e) => updateIdentity({ alignGhOnSelect: e.target.checked })}
          />
          <span>
            Align gh CLI on repo select
            <span className="mt-0.5 block text-xs text-muted">
              When you select a repo in the Git panel, run{' '}
              <code className="font-mono">gh auth switch</code> to its mapped account so bare{' '}
              <code className="font-mono">gh</code> commands (e.g. <code className="font-mono">gh pr create</code>)
              act as that account. This is the only feature that changes your global gh state.
            </span>
          </span>
        </label>
      </div>
```
- [ ] Verify: `npx tsc --noEmit` — expect **no errors**; `pnpm build` — expect **success**.
- [ ] Manual note: open Settings → GitHub tab, toggle appears and persists (reload keeps state).
- [ ] Commit: `git commit -m "feat(identity): settings toggle for align-gh-on-select"`

---

### Task 8 — Git panel indicator, preflight fetch, warning states, gh-align effect

**Files:** `src/components/right-sidebar/git-panel.tsx`.

- [ ] Add imports/type: extend the `ipc` import (line 2) to include `PreflightResult`, and add `import { useSettings } from '../../state/settings'`:
```ts
import { ipc, type CurrentIdentity, type FileDiff, type GitInfo, type PreflightResult, type RepoInfo } from '../../lib/ipc'
import { useSettings } from '../../state/settings'
```
- [ ] Add state + selector inside `GitPanel` (after line 143, near `identity`):
```ts
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const alignGhOnSelect = useSettings((s) => s.identity.alignGhOnSelect)
```
- [ ] In `refresh` (inside the callback, after the `ipc.identity.current(...)` line 178) add the preflight fetch:
```ts
    ipc.identity.pushPreflight(selectedId).then(setPreflight).catch(() => setPreflight(null))
```
- [ ] In the `appliedTick` effect (after line 187's `ipc.identity.current(...)`) also refresh preflight:
```ts
    ipc.identity.pushPreflight(selectedId).then(setPreflight).catch(() => setPreflight(null))
```
- [ ] Add derived values before the `return` (after `selectedRepo` memo, ~line 154). Note: `remoteLogin` present ⇒ HTTPS routing applied; mapped account but no `remoteLogin` ⇒ SSH/non-github ⇒ routing skipped:
```ts
  const mappedAccount = identity?.accountId
    ? accounts.find((a) => a.id === identity.accountId)
    : undefined
  const pushLogin = identity?.remoteLogin ?? mappedAccount?.login ?? null
  const routingSkipped = !!identity?.accountId && !identity?.remoteLogin
  const preflightBad = !!preflight && !preflight.ok
```
- [ ] Add the gh-align effect after the `appliedTick` effect (after line 188):
```ts
  // Opt-in: keep the gh CLI's active account aligned with the selected repo.
  useEffect(() => {
    if (!alignGhOnSelect || !pushLogin) return
    ipc.identity.alignGh(pushLogin).catch(() => {})
  }, [alignGhOnSelect, pushLogin, selectedId])
```
- [ ] Add the indicator JSX inside the push block, right after the branch/account header `</div>` and before the push button block (insert before line 303's `{(info.dirty || ...`):
```tsx
      {pushLogin && (
        <div
          className={`px-3 pb-1 text-[11px] ${
            preflightBad || routingSkipped ? 'text-warning' : 'text-muted'
          }`}
        >
          {preflightBad
            ? preflight?.reason
            : routingSkipped
            ? `Author only — ${pushLogin} not routed (non-HTTPS remote)`
            : `Pushing as ${pushLogin}`}
        </div>
      )}
```
- [ ] Replace `onPush` (lines 197-210) to run preflight first and surface its warning without blocking (justification: keeping the check in the frontend leaves `git_push` a thin shell-out and shows the actionable message before the doomed push; wiring identity state into the git module would require passing `IdentityStore` into `git::push`):
```ts
  const onPush = async (): Promise<void> => {
    if (!info?.branch || !selectedId) return
    setPushing(true)
    setPushMsg(null)
    try {
      const pf = await ipc.identity.pushPreflight(selectedId).catch(() => null)
      setPreflight(pf)
      const warn = pf && !pf.ok ? `${pf.reason ?? 'Credential preflight failed'}\n` : ''
      const res = await ipc.git.push(selectedId, info.branch)
      setPushMsg(warn + (res.ok ? 'Pushed.' : res.output || 'Push failed'))
      if (res.ok) refresh()
    } catch (e) {
      setPushMsg(String(e))
    } finally {
      setPushing(false)
    }
  }
```
- [ ] Verify: `npx tsc --noEmit` — expect **no errors**; `pnpm build` — expect **success**.
- [ ] Manual note: select an HTTPS github repo mapped to an account → indicator reads "Pushing as `<login>`"; an SSH repo shows the "Author only" warning; a repo whose account is logged out of gh shows the preflight reason in warning color.
- [ ] Commit: `git commit -m "feat(git-panel): show push identity, preflight warnings, and gh-align on select"`

---

### Task 9 — Full verification + manual e2e

**Files:** none (verification only).

- [ ] From `src-tauri`: `cargo test` — expect **all tests pass** (identity routing/idempotency/overwrite/https-guard/cleanup/preflight + existing git/identity suites).
- [ ] From `src-tauri`: `cargo build` — expect **success**.
- [ ] From repo root: `npx tsc --noEmit` — expect **no errors**.
- [ ] From repo root: `pnpm build` — expect **success**.
- [ ] Manual e2e (Windows, gh 2.93.0, active account `patt-rick`, inactive `jephtta`):
  - [ ] Map a repo with an HTTPS github origin to the **inactive** account (`jephtta`) via the account picker. Confirm `.git/config` shows two `credential.helper` entries (empty first, `!f() {...}` second) and `git config --local --get-all credential.helper` returns both.
  - [ ] In an embedded terminal in that repo, run `git push` — it authenticates as `jephtta` with **no** `gh auth switch`. Repeat for a repo mapped to `patt-rick`.
  - [ ] Click the git-panel Push button for the `jephtta` repo — push succeeds; indicator reads "Pushing as jephtta".
  - [ ] Log `jephtta` out of gh (or map to an account with no gh token), reselect the repo — the indicator turns to a warning with the actionable reason; Push surfaces the same reason then attempts the push.
  - [ ] Confirm an **SSH**-remote repo is unaffected: no local `credential.helper` written, indicator shows "Author only", `git push` uses SSH as before.
  - [ ] Remove the mapped account in Settings → GitHub; confirm the repo's local `credential.helper` entries are gone (`git config --local --get-all credential.helper` empty) and the inherited chain is restored.
  - [ ] Enable "Align gh CLI on repo select", select the `jephtta` repo, then run `gh api user` in a terminal — it reports `jephtta` (active account switched). Disable the toggle and confirm no further switching on selection.
- [ ] Commit (if any incidental fixes): `git commit -m "chore(identity): finalize credential routing verification"`

---

**Notes for the implementer**
- All routing writes go through the `git` CLI with `Command::arg("-C").arg(repo_path)` — args are passed directly to `CreateProcess` (no shell), so the helper string needs no OS-level quoting; git's own config quoting (it wraps the value in `"..."` because of the `;`) is exercised and asserted by the round-trip test.
- The helper deliberately contains **no** embedded double quotes; `$1` is always a non-empty operation token (`get`/`store`/`erase`), so `test $1 = get` is safe and keeps the stored string byte-for-byte deterministic for the exact-string assertion.
- Account logins are validated `^[A-Za-z0-9-]+$` in `accounts-section.tsx`, so no login can inject shell metacharacters into the helper or the `gh auth token --user` call.
- Migration is automatic: `identity-auto-apply.tsx` re-resolves and re-applies every discovered repo on project select, so existing mappings gain credential routing the next time their project is opened — no separate migration step.
