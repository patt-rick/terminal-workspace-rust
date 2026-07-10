# GitHub Identity — Deterministic Per-Repo Credential Routing — Design

**Date:** 2026-07-10
**Status:** Approved
**Extends:** 2026-06-05-github-account-switcher-design.md

## Problem

The identity system (`src-tauri/src/identity/`) maps repos to GitHub accounts
and, on apply, sets local `user.name`/`user.email` and rewrites the origin URL
to `https://<login>@github.com/...`. But the **token** used at push time comes
from git's credential-helper chain, which on this machine is Git Credential
Manager (system config) followed by gh (global config). gh's helper only
answers for its currently-active account and returns nothing for others, and
GCM's store is independent of both. Result: pushes sometimes authenticate as
the wrong account or fail until the user manually runs `gh auth switch`.

Verified on this machine (gh 2.93.0, accounts `patt-rick` active / `jephtta`):

- `gh auth git-credential get` with `username=jephtta` → **no credentials**.
- `gh auth token --user jephtta` → **valid `gho_` token even though inactive**.
  This is the primitive the design builds on.

## Goal

Every git push — from an embedded terminal, from Claude Code running inside a
terminal, or from the app's push button — authenticates as the repo's mapped
account, with no manual `gh auth switch`, no global state mutation, and no
tokens written to disk.

## Design

### Credential routing in `identity::apply_identity`

When a repo is mapped to an account (new mapping, re-mapping, or the existing
auto-apply on project select via `identity-auto-apply.tsx`), in addition to
the current author + URL-rewrite steps, write the repo's **local** git config
via `git config --local` shell-outs (CLI, not git2, for correct multi-value
handling and Windows quoting):

1. `git config --local credential.helper ""` — an empty first entry is git's
   documented mechanism to **reset the inherited helper list**, cutting GCM
   and global gh out of the loop for this repo.
2. `git config --local --add credential.helper "<inline helper>"` — a small
   inline sh helper that answers the `get` action with:

   ```
   username=<login>
   password=$(gh auth token --user <login>)
   ```

   (Other actions — `store`/`erase` — are no-ops.) Git for Windows executes
   `!`-prefixed helpers via its bundled sh, so this works in embedded
   terminals and for the app's `git push` shell-out alike. Exact quoting is an
   implementation detail; it must survive `.git/config` round-tripping on
   Windows and be covered by tests.

**Idempotency & cleanup.** Applying is idempotent: `--unset-all` before
writing. Un-mapping a repo, or deleting the mapped account, removes both
entries (`git config --local --unset-all credential.helper`), restoring the
inherited chain. Re-mapping to a different account overwrites.

**Guards.** Routing is only written for `github.com` HTTPS origins — same rule
as the existing `rewrite_remote_url` (SSH and non-GitHub remotes keep today's
`routing_skipped = true` behavior, author identity still applied).

**Migration.** None needed: `identity-auto-apply.tsx` already re-resolves and
re-applies every discovered repo on project select, so existing mappings gain
credential routing the next time their project is opened.

### Preflight

A `identity_push_preflight(repo)` check runs (a) when a mapping is applied and
(b) before app-initiated pushes (`git_push`):

- `gh` binary present?
- `gh auth token --user <login>` exits 0?

Failures produce actionable errors surfaced in the UI, e.g. *"jephtta isn't
logged in to gh — run `gh auth login`"*. A preflight failure does not roll
back author identity; it only warns that pushes will fail.

### Visibility — git panel

The git panel shows, per selected repo, the account it will push as
("pushing as `jephtta`"), derived from the identity mapping + routing state,
with a warning state when preflight fails or routing was skipped (SSH remote).

### Opt-in: align gh CLI on project select

A new setting in the identity section (default **off**): when enabled,
the app runs `gh auth switch --user <login>` for the mapped account of the
repo currently selected in the git panel (re-running when that selection
changes), so bare `gh` commands (`gh pr create`) act as the same account. This is the only feature that mutates global gh
state, which is why it is opt-in.

## Security notes

- Tokens are never persisted by the app and never appear in `.git/config` —
  the helper resolves them at use time from gh's keyring.
- Cost: one `gh auth token` subprocess per credential fill (~100–200 ms per
  push) — negligible.

## Error handling

- gh missing entirely → author identity applies, routing skipped, warning
  shown (same degradation as SSH remotes).
- Token fetch fails mid-push (account logged out of gh since preflight) → git
  fails fast with the helper's empty answer; the git panel warning reappears
  on next preflight.

## Testing

- Rust unit tests on temp-initialized repos: routing config written correctly
  (reset entry + helper entry), idempotent re-apply, overwrite on re-map,
  unset on unmap/account-removal, HTTPS-only guard, helper string generation
  and quoting round-trip through `git config`.
- Preflight logic with a stubbed `gh` (missing binary, failing token).
- Manual/e2e: from an embedded terminal, `git push` to a repo mapped to the
  **non-active** gh account succeeds without `gh auth switch`; app push button
  same; SSH-remote repo unaffected.
