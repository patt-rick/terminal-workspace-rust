# GitHub Account Switcher — Design

**Date:** 2026-06-05
**Status:** Approved (design)
**Target:** Feature inside `terminal-workspace-rust` (Tauri 2 + Rust)

## Summary

A per-repo GitHub account switcher built into the existing terminal workspace app. For
each repository it sets the **commit identity** (`user.name` / `user.email`) and routes
**push authentication** to the correct GitHub account by embedding that account's login in
the `origin` remote URL (`https://<login>@github.com/owner/repo.git`). Git Credential
Manager (GCM) then uses the token associated with that login. The switch **auto-applies**
when a project is opened in the app, and the user can also set a **global** identity on
demand.

The tool stores **no secrets** — token handling is left entirely to GCM, which prompts once
per account on first push and remembers it thereafter.

## Goals

- Switch commit identity per repo (local `user.name` / `user.email`), or set it globally.
- Switch push auth per repo so pushes go out as the correct GitHub account over HTTPS.
- Auto-apply the right account when a repo/project is opened in the app.
- Keep the new logic self-contained so it could later be lifted into a standalone CLI.

## Non-Goals (YAGNI)

- Storing Personal Access Tokens or managing SSH keys — GCM owns token storage.
- Making the app's existing single-account GitHub features (PR list, Actions) multi-account.
- Auto-switching for repos opened **outside** this app (no shell/`cd` hooks). That was the
  rejected standalone approach.
- SSH-based push auth. Users authenticate via `gh` / HTTPS + PAT; remotes are HTTPS.

## Background / Why this fits the host app

`terminal-workspace-rust` already provides the building blocks this feature needs:

- **Projects = folders.** `state/mod.rs` models a `Project { id, name, path, ... }` and a
  `selected_project_id`, giving a clear "current repo" and a selection-change event to hook.
- **Git plumbing.** `git/mod.rs` uses `git2` and already parses the `origin` GitHub remote
  (`parse_github_remote` → `owner` / `repo`).
- **Atomic JSON persistence.** Existing settings/state store can hold account profiles,
  the repo→account mapping, and the behavior settings.
- **GitHub auth + OS keychain.** Present already, though this feature deliberately does not
  rely on it (GCM handles push tokens).

## The core constraint

GitHub HTTPS credentials are keyed by **hostname**. Both accounts push to `github.com`, so a
plain credential helper cannot tell them apart per repo. The fix is to embed the account
login in the remote URL so GCM stores and selects a **separate token per login**:

```
https://github.com/owner/repo.git         →  https://<login>@github.com/owner/repo.git
```

## Data Model (no secrets)

- **Account profile**
  ```
  { id, label, login, name, email }
  ```
  Example: `{ login: "patt-rick", name: "Patrick Ackom", email: "dev.asqii@gmail.com" }`.
  - `login` — GitHub username, embedded in the remote URL for push routing.
  - `name` / `email` — written to git config as commit identity.
  - `label` — human-friendly display name (e.g. "Personal", "Work").

- **Repo → account mapping**: `repoPath → accountId`. The source of truth for auto-apply.

- **Settings**
  - `unmappedRepoBehavior: "useDefault" | "ask"`
  - `defaultAccountId: <id | null>`

All persisted via the app's existing atomic-JSON store.

## Rust `identity/` module

Self-contained module; pure logic kept separate from Tauri command glue so it is unit-testable
and extractable into a standalone CLI later.

- `apply_to_repo(repo_path, account)` — via `git2`:
  1. Set **local** `user.name` = `account.name`, `user.email` = `account.email`.
  2. If `origin` is an HTTPS `github.com` remote, rewrite its URL to carry `account.login`
     (preserve `owner`/`repo` and any `.git` suffix; replace any existing userinfo).
  3. Save the repo→account mapping.
  - Non-github remote, SSH remote, or no `origin`: set identity only and return a
    `push_routing_skipped` note so the UI can surface it.

- `apply_global(account)` — write `--global` `user.name` / `user.email`
  ("make this my default identity"). Does not touch remotes.

- `resolve_for_repo(repo_path) -> Resolution` — mapping wins; otherwise honor settings:
  `useDefault` → the default account; `ask` → signal the UI to prompt.

- `current_identity(repo_path)` — read back local `user.name` / `user.email` and the `origin`
  login, for display in the badge.

- Account + settings CRUD: `list/add/update/remove_account`, get/set default and behavior.

### URL rewrite rules (the one tricky pure function)

Input `origin` URL + `login` → output URL:

| Input | Output |
|-------|--------|
| `https://github.com/owner/repo.git` | `https://<login>@github.com/owner/repo.git` |
| `https://github.com/owner/repo` | `https://<login>@github.com/owner/repo` |
| `https://olduser@github.com/owner/repo.git` | `https://<login>@github.com/owner/repo.git` (userinfo replaced) |
| `git@github.com:owner/repo.git` (SSH) | unchanged (identity-only; routing skipped) |
| `https://gitlab.com/owner/repo.git` (non-github) | unchanged (routing skipped) |

## Auto-apply integration

Hook the existing **project-selection** path. When `selected_project_id` changes to a project
whose folder is a git repo:

1. Call `resolve_for_repo(project.path)`.
2. If resolved → `apply_to_repo` silently.
3. If `ask` and unmapped → emit an event; the UI shows a one-time account picker; the chosen
   account is applied and the mapping remembered.

## UI (small surface)

- **Accounts panel** (settings / right-sidebar): list, add, edit, remove accounts; choose the
  **default account**; toggle **unmapped behavior** (use default vs ask); a **"Set as global"**
  button per account.
- **Current-account badge** near the existing git info, with a dropdown to change a repo's
  account (re-applies and updates the mapping).
- **Picker modal** for the first-open `ask` case (may pre-select the account whose `login`
  matches the repo's `owner`, as a convenience).

## Error / edge-case handling

- **No `origin` remote** → set identity only; report routing skipped.
- **SSH or non-github `origin`** → set identity only; report routing skipped (no URL rewrite).
- **`origin` already carries a different login** → replace the userinfo with the new login.
- **Folder is not a git repo** → no-op for auto-apply.
- **Multiple remotes** → only `origin` is handled (keep it simple).

## Testing

- **Pure-function unit tests** for URL rewrite: HTTPS with/without existing login, with/without
  `.git`, non-github and SSH inputs left unchanged.
- **`resolve_for_repo` tests**: mapping present; `useDefault` with/without a default set; `ask`.
- **Integration test**: `apply_to_repo` against a temporary `git2`-init'd repo; assert local
  `user.name` / `user.email` and the rewritten `origin` URL.

## Future extensions (not now)

- Extract `identity/` into a standalone `gh-switch` CLI for use outside the app.
- Optional PAT seeding into GCM to avoid the one-time login prompt.
- Multi-account PR/Actions views in the existing GitHub panel.
