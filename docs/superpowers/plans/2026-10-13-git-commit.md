# Git Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage, unstage and commit from the Git tab, with separate Staged and Changes lists.

**Architecture:** The Rust git module gains scoped diffs (libgit2) and three write operations that run the `git` program without a shell. Three new Tauri commands expose them. A new React component replaces the single "Changes" list in the Git panel with two lists and a commit box.

**Tech Stack:** Rust (git2 0.19, std::process), Tauri 2 commands, React 19, Zustand 5, Vitest.

Spec: `docs/superpowers/specs/2026-10-13-git-commit-design.md`

**The commit-message field is approved** (owner, 2026-10-13: "commit message field can be under the git tab in the right page").

**Conventions for every task:**

- Rust tests run from `src-tauri/`: `cargo test --lib git::`. They run the real `git` program, which must be on `PATH`.
- TypeScript: `pnpm test`, `pnpm typecheck` (`noUnusedLocals` is on).
- Commit messages follow the repo's conventional style and carry **no** `Co-Authored-By` trailer. The repo commits directly to `master`.
- Do not add comments unless they say something the code cannot (project rule).
- Keep each existing file's line endings.
- Confirm at least 5 GB free on drive C: before any Rust build.

---

## File Structure

**Modified (Rust):**
- `src-tauri/src/git/mod.rs` — `DiffScope`, shared diff-to-files helper, `run_git`, `stage`, `unstage`, `commit`, tests.
- `src-tauri/src/commands.rs` — `git_diff` scope argument; `git_stage`, `git_unstage`, `git_commit`.
- `src-tauri/src/remote/bridge.rs:230` — pass `DiffScope::All`.
- `src-tauri/src/lib.rs` — register three commands.

**New (frontend):**
- `src/lib/git-changes.ts` + `src/lib/git-changes.test.ts` — pure helpers.
- `src/components/right-sidebar/git-changes.tsx` — the two lists and the commit box.

**Modified (frontend):**
- `src/lib/ipc.ts` — bindings.
- `src/state/diff.ts` — the diff's scope.
- `src/components/right-sidebar/git-panel.tsx` — use the new component.
- `README.md`, `CHANGELOG.md`.

---

### Task 1: Scoped diffs and write operations in the git module

**Files:**
- Modify: `src-tauri/src/git/mod.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/git/mod.rs`, inside the existing `mod tests`, after `parses_github_remotes`, add:

```rust
    fn init_repo() -> (tempfile::TempDir, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let hooks = dir.path().join(".git").join("no-hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        cfg.set_bool("commit.gpgsign", false).unwrap();
        cfg.set_str("core.hooksPath", &hooks.to_string_lossy()).unwrap();
        (dir, repo)
    }

    fn write(root: &Path, name: &str, content: &str) {
        std::fs::write(root.join(name), content).unwrap();
    }

    fn paths(root: &Path, scope: DiffScope) -> Vec<String> {
        let mut out: Vec<String> = diff(root, scope).unwrap().into_iter().map(|f| f.path).collect();
        out.sort();
        out
    }

    #[test]
    fn parses_diff_scopes() {
        assert_eq!(DiffScope::parse(Some("staged")), DiffScope::Staged);
        assert_eq!(DiffScope::parse(Some("unstaged")), DiffScope::Unstaged);
        assert_eq!(DiffScope::parse(Some("anything")), DiffScope::All);
        assert_eq!(DiffScope::parse(None), DiffScope::All);
    }

    #[test]
    fn stages_commits_and_separates_staged_from_unstaged() {
        let (dir, repo) = init_repo();
        let root = dir.path();

        write(root, "a.txt", "one\n");
        let (ok, out) = stage(root, &[]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["a.txt"]);
        assert!(paths(root, DiffScope::Unstaged).is_empty());

        let (ok, out) = commit(root, "first\n\nbody line");
        assert!(ok, "{out}");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary(), Some("first"));
        assert!(head.message().unwrap().contains("body line"));
        assert!(paths(root, DiffScope::All).is_empty());

        write(root, "a.txt", "one\ntwo\n");
        let (ok, out) = stage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        write(root, "a.txt", "one\ntwo\nthree\n");
        write(root, "b.txt", "new\n");

        assert_eq!(paths(root, DiffScope::Staged), ["a.txt"]);
        assert_eq!(paths(root, DiffScope::Unstaged), ["a.txt", "b.txt"]);
        assert_eq!(paths(root, DiffScope::All), ["a.txt", "b.txt"]);

        let unstaged = diff(root, DiffScope::Unstaged).unwrap();
        let untracked = unstaged.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(untracked.status, "added");
        assert!(!untracked.hunks.is_empty());
    }

    #[test]
    fn unstages_one_file_and_everything() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        write(root, "b.txt", "one\n");
        assert!(stage(root, &[]).0);
        assert!(commit(root, "base").0);

        write(root, "a.txt", "two\n");
        write(root, "b.txt", "two\n");
        assert!(stage(root, &[]).0);
        assert_eq!(paths(root, DiffScope::Staged), ["a.txt", "b.txt"]);

        let (ok, out) = unstage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["b.txt"]);
        assert_eq!(paths(root, DiffScope::Unstaged), ["a.txt"]);

        let (ok, out) = unstage(root, &[]);
        assert!(ok, "{out}");
        assert!(paths(root, DiffScope::Staged).is_empty());
        assert_eq!(paths(root, DiffScope::Unstaged), ["a.txt", "b.txt"]);
    }

    #[test]
    fn unstages_before_the_first_commit() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        write(root, "b.txt", "one\n");
        assert!(stage(root, &[]).0);

        let (ok, out) = unstage(root, &["a.txt".to_string()]);
        assert!(ok, "{out}");
        assert_eq!(paths(root, DiffScope::Staged), ["b.txt"]);

        let (ok, out) = unstage(root, &[]);
        assert!(ok, "{out}");
        assert!(paths(root, DiffScope::Staged).is_empty());
        assert!(root.join("a.txt").exists() && root.join("b.txt").exists());
    }

    #[test]
    fn commit_refuses_a_blank_message_and_reports_nothing_staged() {
        let (dir, _repo) = init_repo();
        let root = dir.path();
        write(root, "a.txt", "one\n");
        assert!(stage(root, &[]).0);

        let (ok, out) = commit(root, "  \n ");
        assert!(!ok);
        assert_eq!(out, "Commit message is empty");
        assert_eq!(paths(root, DiffScope::Staged), ["a.txt"]);

        assert!(commit(root, "base").0);
        let (ok, out) = commit(root, "again");
        assert!(!ok);
        assert!(!out.is_empty());
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `src-tauri/`): `cargo test --lib git::`
Expected: FAIL to compile — `DiffScope`, `stage`, `unstage` and `commit` do not exist, and `diff` takes one argument.

- [ ] **Step 3: Implement**

At the top of `src-tauri/src/git/mod.rs`, extend the imports:

```rust
use git2::{BranchType, DiffOptions, Patch, Repository};
use serde::Serialize;
use std::io::Write as _;
use std::path::Path;
use std::process::Stdio;
```

Replace the whole existing `diff` function (from its doc comment `/// All uncommitted changes …` to its closing brace, just above `#[cfg(test)]`) with:

```rust
/// Which changes a diff covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffScope {
    /// HEAD against the index and working tree together.
    All,
    /// HEAD against the index: what a commit would contain.
    Staged,
    /// The index against the working tree, untracked files included.
    Unstaged,
}

impl DiffScope {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("staged") => DiffScope::Staged,
            Some("unstaged") => DiffScope::Unstaged,
            _ => DiffScope::All,
        }
    }
}

fn files_from_diff(diff: &git2::Diff) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    for idx in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(idx) else {
            continue;
        };
        let to_path = |p: Option<&Path>| p.map(|p| p.to_string_lossy().replace('\\', "/"));
        let new_path = to_path(delta.new_file().path());
        let old_path = to_path(delta.old_file().path());
        let path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();

        let mut hunks: Vec<Hunk> = Vec::new();
        let mut binary = delta.flags().is_binary();

        match Patch::from_diff(diff, idx) {
            Ok(Some(patch)) => {
                for h in 0..patch.num_hunks() {
                    let header = match patch.hunk(h) {
                        Ok((hunk, _)) => String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
                        Err(_) => String::new(),
                    };
                    let mut lines: Vec<DiffLine> = Vec::new();
                    for l in 0..patch.num_lines_in_hunk(h).unwrap_or(0) {
                        if let Ok(line) = patch.line_in_hunk(h, l) {
                            lines.push(DiffLine {
                                origin: line.origin().to_string(),
                                content: String::from_utf8_lossy(line.content())
                                    .trim_end_matches(['\n', '\r'])
                                    .to_string(),
                                old_lineno: line.old_lineno(),
                                new_lineno: line.new_lineno(),
                            });
                        }
                    }
                    hunks.push(Hunk { header, lines });
                }
            }
            Ok(None) | Err(_) => binary = true,
        }

        files.push(FileDiff {
            path,
            old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
            status: status_label(delta.status()).to_string(),
            binary,
            hunks,
        });
    }
    files
}

/// Uncommitted changes as structured per-file hunks for the diff viewer.
pub fn diff(root: &Path, scope: DiffScope) -> Result<Vec<FileDiff>, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .context_lines(3);

    let diff = match scope {
        DiffScope::All => repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts)),
        DiffScope::Staged => repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts)),
        DiffScope::Unstaged => {
            opts.show_untracked_content(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
        }
    }
    .map_err(|e| e.to_string())?;

    Ok(files_from_diff(&diff))
}

// ---- staging and committing ----

/// Runs the `git` program in `root` with no shell: arguments are passed as
/// given and `stdin` is written to its standard input. A credential or
/// passphrase prompt fails instead of hanging the app.
fn run_git(root: &Path, args: &[&str], stdin: Option<&str>) -> (bool, String) {
    let mut cmd = crate::proc::hidden_command("git");
    cmd.args(args)
        .current_dir(root)
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return (false, e.to_string()),
    };
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let _ = pipe.write_all(input.as_bytes());
    }
    match child.wait_with_output() {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&err);
            }
            (out.status.success(), text.trim().to_string())
        }
        Err(e) => (false, e.to_string()),
    }
}

/// Stage the given paths (relative to the repo root), or everything when none
/// are given. `-A` so a deleted file's removal is staged too.
pub fn stage(root: &Path, paths: &[String]) -> (bool, String) {
    let mut args: Vec<&str> = vec!["add", "-A"];
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    run_git(root, &args, None)
}

/// Unstage the given paths, or everything when none are given. A repo with no
/// commits has no HEAD to reset to, so the index entries are removed instead.
pub fn unstage(root: &Path, paths: &[String]) -> (bool, String) {
    let has_head = run_git(root, &["rev-parse", "--verify", "-q", "HEAD"], None).0;
    let mut args: Vec<&str> = if has_head {
        vec!["reset", "-q", "HEAD", "--"]
    } else {
        vec!["rm", "--cached", "-r", "-q", "--"]
    };
    if paths.is_empty() {
        args.push(".");
    } else {
        args.extend(paths.iter().map(String::as_str));
    }
    run_git(root, &args, None)
}

/// Commit what is staged. Goes through the `git` program so the user's hooks
/// and signing apply; the message travels on standard input.
pub fn commit(root: &Path, message: &str) -> (bool, String) {
    if message.trim().is_empty() {
        return (false, "Commit message is empty".to_string());
    }
    run_git(root, &["commit", "-F", "-"], Some(message))
}
```

- [ ] **Step 4: Update the two callers of `diff`**

In `src-tauri/src/remote/bridge.rs` (near line 230), change `crate::git::diff(Path::new(&path))` to:

```rust
    crate::git::diff(Path::new(&path), crate::git::DiffScope::All)
```

In `src-tauri/src/commands.rs`, replace the `git_diff` command with:

```rust
#[tauri::command]
pub async fn git_diff(
    store: State<'_, StateStore>,
    repo_id: String,
    scope: Option<String>,
) -> AppResult<Vec<FileDiff>> {
    let root = repo_root(&store, &repo_id)?;
    let scope = crate::git::DiffScope::parse(scope.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        crate::git::diff(Path::new(&root), scope).map_err(AppError::Msg)
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --lib git::`
Expected: PASS — the 5 new tests and `parses_github_remotes`, plus the existing `git::discover` tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/git/mod.rs src-tauri/src/remote/bridge.rs src-tauri/src/commands.rs
git commit -m "feat(git): scoped diffs and stage, unstage and commit operations"
```

---

### Task 2: Commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (after `git_diff`)
- Modify: `src-tauri/src/lib.rs` (handler list near line 151)

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, directly after the `git_diff` command:

```rust
async fn git_write(
    root: String,
    op: impl FnOnce(&Path) -> (bool, String) + Send + 'static,
) -> AppResult<PushResult> {
    let (ok, output) = tauri::async_runtime::spawn_blocking(move || op(Path::new(&root)))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(PushResult { ok, output })
}

/// Stage `paths` (relative to the repo root); an empty list stages everything.
#[tauri::command]
pub async fn git_stage(
    store: State<'_, StateStore>,
    repo_id: String,
    paths: Vec<String>,
) -> AppResult<PushResult> {
    let root = repo_root(&store, &repo_id)?;
    git_write(root, move |r| crate::git::stage(r, &paths)).await
}

/// Unstage `paths`; an empty list unstages everything.
#[tauri::command]
pub async fn git_unstage(
    store: State<'_, StateStore>,
    repo_id: String,
    paths: Vec<String>,
) -> AppResult<PushResult> {
    let root = repo_root(&store, &repo_id)?;
    git_write(root, move |r| crate::git::unstage(r, &paths)).await
}

#[tauri::command]
pub async fn git_commit(
    store: State<'_, StateStore>,
    repo_id: String,
    message: String,
) -> AppResult<PushResult> {
    let root = repo_root(&store, &repo_id)?;
    git_write(root, move |r| crate::git::commit(r, &message)).await
}
```

- [ ] **Step 2: Register them**

In `src-tauri/src/lib.rs`, after `commands::git_diff,`:

```rust
            commands::git_stage,
            commands::git_unstage,
            commands::git_commit,
```

- [ ] **Step 3: Build and test**

Run (from `src-tauri/`):

```bash
cargo test --lib
cargo check --no-default-features
```

Expected: all tests pass; no warnings from the changed files.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(git): stage, unstage and commit commands"
```

---

### Task 3: Frontend bindings, diff scope and helpers

**Files:**
- Modify: `src/lib/ipc.ts` (the `git:` block near line 562)
- Modify: `src/state/diff.ts`
- Create: `src/lib/git-changes.ts`
- Create: `src/lib/git-changes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/git-changes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { canCommit, pathsOf } from './git-changes'

describe('pathsOf', () => {
  it('is the file path for an ordinary change', () => {
    expect(pathsOf({ path: 'src/a.ts', oldPath: null })).toEqual(['src/a.ts'])
  })

  it('includes the old path of a rename, so both halves move together', () => {
    expect(pathsOf({ path: 'src/b.ts', oldPath: 'src/a.ts' })).toEqual(['src/b.ts', 'src/a.ts'])
  })
})

describe('canCommit', () => {
  it('needs something staged, a message and no operation in flight', () => {
    expect(canCommit('fix', 1, false)).toBe(true)
    expect(canCommit('fix', 0, false)).toBe(false)
    expect(canCommit('   \n', 1, false)).toBe(false)
    expect(canCommit('fix', 1, true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/git-changes.test.ts`
Expected: FAIL — `Failed to resolve import "./git-changes"`.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/git-changes.ts`:

```ts
// Pure helpers for the Git tab's staging lists. No ipc calls, so they run in
// plain vitest.

import type { FileDiff } from './ipc'

/** The paths to hand to git for one listed file. */
export function pathsOf(file: Pick<FileDiff, 'path' | 'oldPath'>): string[] {
  return file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path]
}

export function canCommit(message: string, stagedCount: number, busy: boolean): boolean {
  return !busy && stagedCount > 0 && message.trim().length > 0
}
```

- [ ] **Step 4: Bindings**

In `src/lib/ipc.ts`, replace the `diff:` line of the `git:` block with:

```ts
    diff: (repoId: string, scope?: 'staged' | 'unstaged') =>
      invoke<FileDiff[]>('git_diff', { repoId, scope }),
    stage: (repoId: string, paths: string[]) =>
      invoke<{ ok: boolean; output: string }>('git_stage', { repoId, paths }),
    unstage: (repoId: string, paths: string[]) =>
      invoke<{ ok: boolean; output: string }>('git_unstage', { repoId, paths }),
    commit: (repoId: string, message: string) =>
      invoke<{ ok: boolean; output: string }>('git_commit', { repoId, message }),
```

- [ ] **Step 5: The diff store records the scope**

Replace `src/state/diff.ts` with:

```ts
import { create } from 'zustand'
import type { FileDiff } from '../lib/ipc'

export type DiffScope = 'staged' | 'unstaged'

interface DiffViewState {
  active: { projectId: string; repoId: string; file: FileDiff; scope: DiffScope } | null
  show: (projectId: string, repoId: string, file: FileDiff, scope: DiffScope) => void
  close: () => void
}

/** The diff currently shown in the center pane (if any). */
export const useDiffView = create<DiffViewState>((set) => ({
  active: null,
  show: (projectId, repoId, file, scope) => set({ active: { projectId, repoId, file, scope } }),
  close: () => set({ active: null }),
}))
```

`pnpm typecheck` now fails in `git-panel.tsx` (its `show` call has three arguments). Task 4 removes that call; do not patch it here.

- [ ] **Step 6: Run the tests**

Run: `pnpm test`
Expected: all pass (the 149 existing plus 3 new).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ipc.ts src/state/diff.ts src/lib/git-changes.ts src/lib/git-changes.test.ts
git commit -m "feat(git): frontend bindings and helpers for staging and committing"
```

---

### Task 4: Staged and Changes lists with a commit box

**Files:**
- Create: `src/components/right-sidebar/git-changes.tsx`
- Modify: `src/components/right-sidebar/git-panel.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/right-sidebar/git-changes.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, type FileDiff } from '../../lib/ipc'
import { canCommit, pathsOf } from '../../lib/git-changes'
import { useDiffView, type DiffScope } from '../../state/diff'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

const statusDot = (status: string): string => {
  switch (status) {
    case 'added':
      return 'text-success'
    case 'deleted':
      return 'text-danger'
    case 'renamed':
    case 'copied':
      return 'text-link'
    default:
      return 'text-warning'
  }
}

const statusGlyph = (status: string): string => {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    default:
      return 'M'
  }
}

type GitResult = { ok: boolean; output: string }

function FileList({
  title,
  files,
  scope,
  emptyText,
  allLabel,
  rowLabel,
  rowGlyph,
  busy,
  activePath,
  onOpen,
  onRow,
  onAll,
}: {
  title: string
  files: FileDiff[]
  scope: DiffScope
  emptyText: string
  allLabel: string
  rowLabel: string
  rowGlyph: string
  busy: boolean
  activePath: string | null
  onOpen: (file: FileDiff, scope: DiffScope) => void
  onRow: (file: FileDiff) => void
  onAll: () => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>
          {title} {files.length > 0 && `(${files.length})`}
        </span>
        {files.length > 0 && (
          <button
            type="button"
            onClick={onAll}
            disabled={busy}
            className="font-normal normal-case tracking-normal text-link hover:underline disabled:opacity-50"
          >
            {allLabel}
          </button>
        )}
      </div>
      <div className="px-1 pb-2 text-sm">
        {files.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted">{emptyText}</div>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              onClick={() => onOpen(f, scope)}
              className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${
                activePath === f.path ? 'bg-accent/15' : 'hover:bg-foreground/5'
              }`}
            >
              <span className={`w-3 flex-shrink-0 text-center font-mono text-xs font-bold ${statusDot(f.status)}`}>
                {statusGlyph(f.status)}
              </span>
              <span className="truncate text-foreground/85">{basename(f.path)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRow(f)
                }}
                disabled={busy}
                title={rowLabel}
                aria-label={`${rowLabel}: ${f.path}`}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
              >
                {rowGlyph}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * The Git tab's Staged and Changes lists and the commit box. The message field
 * is text for git only; it never reaches an agent or a shell (the backend
 * hands it to `git commit` on standard input).
 */
export function GitChanges({
  projectId,
  repoId,
  reloadTick,
  onChanged,
}: {
  projectId: string
  repoId: string
  /** bumped by the panel's Refresh button */
  reloadTick: number
  /** called after any operation so the panel can refresh the branch line */
  onChanged: () => void
}) {
  const [staged, setStaged] = useState<FileDiff[]>([])
  const [unstaged, setUnstaged] = useState<FileDiff[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const show = useDiffView((s) => s.show)
  const active = useDiffView((s) => s.active)
  const closeDiff = useDiffView((s) => s.close)
  const loadSeq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current
    const [s, u] = await Promise.all([
      ipc.git.diff(repoId, 'staged').catch(() => [] as FileDiff[]),
      ipc.git.diff(repoId, 'unstaged').catch(() => [] as FileDiff[]),
    ])
    if (seq !== loadSeq.current) return
    setStaged(s)
    setUnstaged(u)
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load, reloadTick])

  useEffect(() => {
    setMessage('')
    setOutput(null)
  }, [repoId])

  const run = async (op: () => Promise<GitResult>, clearMessage = false): Promise<void> => {
    setBusy(true)
    setOutput(null)
    try {
      const res = await op()
      if (!res.ok) setOutput(res.output || 'git failed')
      else if (clearMessage) setMessage('')
    } catch (e) {
      setOutput(String(e))
    } finally {
      // The open diff may show a file that just moved between the lists.
      if (useDiffView.getState().active?.repoId === repoId) closeDiff()
      await load()
      setBusy(false)
      onChanged()
    }
  }

  const commit = (): void => {
    if (!canCommit(message, staged.length, busy)) return
    void run(() => ipc.git.commit(repoId, message), true)
  }

  const open = (file: FileDiff, scope: DiffScope): void => show(projectId, repoId, file, scope)
  const activePathIn = (scope: DiffScope): string | null =>
    active?.repoId === repoId && active.scope === scope ? active.file.path : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <FileList
          title="Staged"
          files={staged}
          scope="staged"
          emptyText="Nothing staged"
          allLabel="Unstage all"
          rowLabel="Unstage"
          rowGlyph="−"
          busy={busy}
          activePath={activePathIn('staged')}
          onOpen={open}
          onRow={(f) => void run(() => ipc.git.unstage(repoId, pathsOf(f)))}
          onAll={() => void run(() => ipc.git.unstage(repoId, []))}
        />
        <FileList
          title="Changes"
          files={unstaged}
          scope="unstaged"
          emptyText={staged.length === 0 ? 'Working tree clean' : 'No other changes'}
          allLabel="Stage all"
          rowLabel="Stage"
          rowGlyph="+"
          busy={busy}
          activePath={activePathIn('unstaged')}
          onOpen={open}
          onRow={(f) => void run(() => ipc.git.stage(repoId, pathsOf(f)))}
          onAll={() => void run(() => ipc.git.stage(repoId, []))}
        />
      </div>
      <div className="flex flex-shrink-0 flex-col gap-1.5 border-t border-border px-3 py-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
          rows={3}
          placeholder="Commit message"
          aria-label="Commit message"
          className="w-full resize-none rounded-md border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          type="button"
          onClick={commit}
          disabled={!canCommit(message, staged.length, busy)}
          className="w-full rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5 disabled:opacity-50"
        >
          {busy ? 'Working…' : staged.length > 0 ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit'}
        </button>
        {output && (
          <div className="max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-warning">{output}</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Use it in the panel**

In `src/components/right-sidebar/git-panel.tsx`:

1. Delete the `basename`, `statusDot` and `statusGlyph` helpers near the top (they moved into `git-changes.tsx`).

2. Change the two import lines for ipc and the diff store, and add the component import:

```tsx
import { ipc, type CurrentIdentity, type GitInfo, type PreflightResult, type RepoInfo } from '../../lib/ipc'
import { useDiffView } from '../../state/diff'
import { GitChanges } from './git-changes'
```

3. In `GitPanel`, delete `const [diffs, setDiffs] = useState<FileDiff[]>([])` and `const show = useDiffView((s) => s.show)`, and add after the `loading` state:

```tsx
  const [reloadTick, setReloadTick] = useState(0)
```

4. Replace the `refresh` callback and the `useEffect(refresh, [refresh])` line with:

```tsx
  const loadInfo = useCallback(() => {
    if (!selectedId) {
      setInfo(null)
      setLoading(false)
      return
    }
    setLoading(true)
    ipc.git
      .info(selectedId)
      .catch(() => null)
      .then(setInfo)
      .finally(() => setLoading(false))
    ipc.identity.current(selectedId).then(setIdentity).catch(() => setIdentity(null))
    ipc.identity.pushPreflight(selectedId).then(setPreflight).catch(() => setPreflight(null))
    void refreshDirty(projectId)
  }, [selectedId, projectId, refreshDirty])

  useEffect(loadInfo, [loadInfo])

  const refresh = useCallback(() => {
    loadInfo()
    setReloadTick((t) => t + 1)
  }, [loadInfo])
```

5. Replace everything from the `<div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">` that holds `Changes {diffs.length > 0 …}` through the end of the list `</div>` that follows it (the block rendering `diffs.map(...)`) with:

```tsx
      {selectedId && (
        <GitChanges
          projectId={projectId}
          repoId={selectedId}
          reloadTick={reloadTick}
          onChanged={loadInfo}
        />
      )}
```

- [ ] **Step 3: Typecheck, test and build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass. `tsc` will name any import this left unused in `git-panel.tsx`; remove exactly those.

- [ ] **Step 4: Commit**

```bash
git add src/components/right-sidebar/git-changes.tsx src/components/right-sidebar/git-panel.tsx
git commit -m "feat(git): staged and changes lists with a commit box in the git tab"
```

---

### Task 5: Verify in the running app, then document

**Files:**
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Launch**

Confirm at least 5 GB free on drive C:, then run `pnpm tauri dev` against a scratch repository, not a real project. If there is less space, stop and report.

- [ ] **Step 2: Check each behaviour and record the result**

1. A repo with one modified and one new file shows both under Changes, none under Staged, Commit disabled.
2. `+` on one file moves it to Staged; `−` moves it back; Stage all and Unstage all move everything.
3. Clicking a staged file shows only the staged part of its diff; after editing it again, clicking it under Changes shows only the new edit. A new file under Changes shows its content.
4. With a file staged and a message typed, Commit works: the lists refresh, the message clears, and the branch line shows one more commit ahead (`↑`).
5. `Ctrl+Enter` in the message field commits.
6. With a `pre-commit` hook that exits 1, Commit shows the hook's output and keeps the message and staged files.
7. In a brand-new repo with no commits, staging, unstaging and the first commit all work.
8. Typing in the message field never reaches a terminal, and the app's shortcuts do not fire for plain typing.

- [ ] **Step 3: Changelog**

In `CHANGELOG.md`, under `## [Unreleased]`, add to the `### Added` list:

```markdown
- Git tab: separate Staged and Changes lists, stage and unstage files, and commit with a
  message. Commits run through git itself, so hooks and signing apply.
```

- [ ] **Step 4: README**

In the Features list, replace the **Git + working-tree diff viewer.** bullet's first sentence so it reads:

```markdown
- **Git + working-tree diff viewer.** Branch / ahead-behind / dirty status, staging and
  committing (through git itself, so hooks and signing apply), push/publish, and a
  unified, color-coded diff of staged or unstaged changes with jump-to-file.
```

In the Architecture block, change the `git/` line to:

```
  git/         info, staging + commit, push, staged/unstaged diffs (structured hunks)
```

- [ ] **Step 5: Final check and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`, then from `src-tauri/`: `cargo test --lib`.

```bash
git add CHANGELOG.md README.md
git commit -m "docs(git): changelog and readme for staging and committing"
```

---

## Changes made during the build

The plan review's findings were applied directly in the code, so the code differs from the
task text above in these places. The spec is current.

- `run_git` sets `GIT_LITERAL_PATHSPECS=1` (a path like `[id].txt` is otherwise a glob),
  no longer sets `LANG`/`LC_ALL`, and writes standard input from its own thread.
- `unstage` always uses `git reset -q HEAD --`; the `git rm --cached` branch failed when a
  file was edited after being staged in a repo with no commits.
- `files_from_diff` stops after 5,000 lines per file.
- `GitChanges` is rendered with `key={repoId}`, guards completion with a mounted flag,
  refreshes or closes the open diff instead of always closing it, shows load errors, and
  shows a successful command's output when git added a nested repository as a link.
- Commit drafts live in `src/state/commit-drafts.ts`, keyed by repo.
- Tests added: a path with glob characters, unstaging before the first commit after a
  further edit, the line cap, and `isNotableSuccess`.
- Tasks 3 and 4 were built together, so no commit left the typecheck failing.

- From the code review: `diff` opens exactly the given folder and `run_git` refuses a
  folder with no `.git` of its own, so an uninitialised submodule cannot stage or commit
  its parent's changes. Literal paths are requested with `--literal-pathspecs` on `add`
  and `reset` only, not through the environment, so the user's hooks are unaffected.
  `unstage` is refused while a merge or rebase is in progress. Diffs are also capped at
  512 KB per file and 8 MB per call, and a cut-off file carries `truncated`, which the
  diff viewer shows. Commit re-reads the staged list first and stops if it changed; the
  lists also reload when the window regains focus. The message field is disabled while an
  operation runs.
- At the owner's request the commit box and Commit button sit above the Push / Publish
  button, so the tab reads: message, commit, push, then the Staged and Changes lists.
- At the owner's request Commit and Push are one button ("Commit N files & Push") whenever
  nothing is left unstaged, just Push when everything is committed, and two buttons only
  while unstaged changes remain. `commitButtons` in `src/lib/git-changes.ts` decides, with
  tests. `GitChanges` takes `push`, `pushNote` and `pushMessage` props instead of a slot,
  and the combined button pushes only after a successful commit.
- From the review of that change: a Push button appears only when there is something to
  push; the branch line reloads on window focus; `Ctrl/Cmd+Enter` cannot start a commit
  while a push runs; a new commit clears the last push result; and the buttons stay
  separate when the push would go out as the wrong account.

## Spec coverage

| Spec section | Task |
|---|---|
| Diff scopes, running git, stage / unstage / commit | 1 |
| Commands | 1, 2 |
| Bindings, diff scope in the store, helpers | 3 |
| The two lists and the commit box | 4 |
| Error handling | 1, 4 |
| Testing | 1, 3, 5 |
