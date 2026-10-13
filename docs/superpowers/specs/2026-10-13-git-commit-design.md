# Git commit from the Git tab — design

Roadmap item 1.8 of `docs/superpowers/plans/2026-10-13-t3code-inspired-roadmap.md`.

## Problem

The Git tab shows a repo's branch, its uncommitted changes as one list, and a Push button.
There is no way to stage or commit there: committing means switching to a terminal. The
list also mixes staged and unstaged changes, so it cannot show what a commit would contain.

## Decisions

- **Two lists: Staged and Changes.** Each file has a button to move it to the other list,
  and each list has a button to move everything.
- **A commit message field and a Commit button** under the Staged list.
- **The message field is approved.** The owner ruled on 2026-10-13: "commit message field
  can be under the git tab in the right page", and more generally that supporting UI may go
  in the right pane and its tabs as long as the terminal TUI stays.
- **Commits go through the `git` program,** not libgit2, so the user's hooks, signing and
  commit template rules apply exactly as they do in a terminal. Reading (status and diffs)
  stays on libgit2, as today.
- **Nothing passes through a shell.** File paths are separate arguments after `--`; the
  message is sent on standard input.
- **No destructive actions in this version.** No discard, no amend, no reset beyond
  unstaging.
- **The identity the app already applies per repo** (`user.name`, `user.email`) is what the
  commit uses; nothing new is needed.

## Backend (`src-tauri/src/git/mod.rs`)

**Diff scopes.** `diff(root, scope)` gains a scope:

| Scope | Compares | Used for |
|---|---|---|
| `All` | HEAD against index and working tree together | the remote web client (unchanged) |
| `Staged` | HEAD against the index | the Staged list |
| `Unstaged` | the index against the working tree, untracked files included with their content | the Changes list |

The loop that turns a libgit2 diff into `FileDiff` values moves into one helper used by all
three.

**Running git.** `run_git(root, args, stdin)` starts `git` in the repo with no console
window and returns success and the combined output. One environment setting:

- `GIT_TERMINAL_PROMPT=0`, so git's own credential prompt fails instead of hanging.

Paths are taken literally (see Guards): without that a file named `[id].txt` is a pattern
that also matches `i.txt` and `d.txt`, and staging one row would stage three files.

The locale is left alone, so hooks see the environment they would in a terminal. The
message is written to standard input from a separate thread, because git reads it only
after its hooks finish. The existing `push` function is left as it is.

**Operations.**

- `stage(root, paths)` — `git add -A -- <paths>`; with no paths, `git add -A`.
- `unstage(root, paths)` — `git reset -q HEAD -- <paths>` (`.` when no paths). This also
  works before the first commit: git treats the missing HEAD as an empty tree.
- `commit(root, message)` — refuses a blank message, then `git commit -F -` with the
  message on standard input. A commit template is not applied, since a message is given.

Diffs are bounded so an un-ignored build folder cannot freeze the tab: 5,000 lines and
512 KB per file, and 8 MB per call, after which files are listed without content. A
cut-off file is marked, and the diff viewer says so. This applies to every scope,
including the remote client's.

**Guards.**

- Every operation refuses a folder that has no `.git` of its own, and `diff` opens exactly
  that folder. Otherwise an uninitialised submodule's empty folder would show, stage and
  commit its parent repo's changes.
- `unstage` is refused while a merge, rebase or cherry-pick is in progress. Resetting a
  conflicted file there erases the record that it is unresolved, and the next commit would
  take the conflict markers as content.
- Literal paths are requested with `--literal-pathspecs` on `add` and `reset`, not
  through the environment, so hooks that filter staged files by pattern still work.
- **Commit** re-reads the staged list first. If it no longer matches what is shown (an
  agent ran `git add .` in the terminal), it shows the new list and asks to commit again.
  The lists also reload when the window regains focus.

**Commands.** `git_diff` takes an optional `scope` (`"staged"`, `"unstaged"`; absent means
all). New: `git_stage(repo_id, paths)`, `git_unstage(repo_id, paths)`,
`git_commit(repo_id, message)`, each returning `{ ok, output }` like `git_push`.

## Frontend

**`src/components/right-sidebar/git-changes.tsx`** replaces the single "Changes" list in
the Git panel.

Top to bottom the tab reads in the order the work happens (owner's request): the commit
message, the buttons, then the two lists.

Commit and Push are one button unless some changes are left unstaged (owner's request).
`commitButtons(staged, unstaged, canPush, pushPending, holdPush)` in
`src/lib/git-changes.ts` decides. "Something to push" means commits ahead or a branch not
published yet.

| State | Buttons |
|---|---|
| Something staged, nothing unstaged | One: **Commit N files & Push** (or **& Publish branch**) |
| Nothing staged, nothing unstaged, something to push | One: **Push N** / **Publish branch** |
| Any unstaged change, something to push | Two: **Commit N files**, then **Push** / **Publish branch** |
| Any unstaged change, nothing to push | One: **Commit N files** |
| Clean and nothing to push, or no branch | One: **Commit** (disabled until something is staged) |
| Push would go out as the wrong account | Never combined: **Commit N files**, and **Push** if there is something to push |

The combined button commits, then pushes only if the commit succeeded, so a failed hook is
never followed by a push. A commit cannot start while a push is running, and starting one
clears the last push result. The branch line reloads with the lists when the window
regains focus, so the buttons match what an agent did in the terminal. Pushing itself stays in the Git panel, which owns the account
checks; the panel hands `GitChanges` a `PushAction` (`label`, `verb`, `busy`, `run`).

- **Staged (n)** — files in the index. Per file: status letter, name, folder, and a `−`
  button to unstage. Header button: **Unstage all**.
- **Changes (n)** — unstaged and untracked files. Per file: a `+` button to stage. Header
  button: **Stage all**.
- Clicking a file opens its diff for that list: the staged diff from Staged, the unstaged
  diff from Changes. The diff store records which.
- **Commit box** — a message field and a **Commit** button, enabled when something is
  staged and the message is not blank. `Ctrl/Cmd+Enter` in the field does what the
  commit button showing would do (commit, or commit and push). On success
  the message clears and the lists and the branch line refresh (the Push button then shows
  one more commit ahead). On failure the message stays and git's output is shown (a failed
  hook, nothing staged, no identity).
- While an operation runs, the buttons are disabled.
- The message is a draft per repo, held in a small store, so it survives switching tabs,
  switching repos and hiding the right sidebar. It is cleared by a successful commit.
- The component is created afresh for each repo, so one repo's rows can never be acted on
  against another while lists are loading.
- After an operation the open diff is refreshed if its file is still in the same list, and
  closed if the file moved or went away.

Renames are not detected today (a rename shows as one deleted and one added file), so each
row is a single path. The helper that builds the path list already handles an old path for
when rename detection is added.

## Error handling

| Case | Behaviour |
|---|---|
| `git` is not installed | The operation fails with the system's error text, shown under the commit box |
| A hook rejects the commit | Shown output is the hook's; message and staged files are kept |
| Signing needs a passphrase | Depends on the user's gpg or ssh agent; if it cannot ask, git fails and its output is shown |
| A hook hangs | The buttons stay disabled until it ends; there is no cancel in this version |
| `commit.cleanup=strip` and a message starting with `#` | git drops the line and may abort as empty; its output is shown |
| Stage all with a nested repo that has no commits | git refuses; its output is shown and nothing is staged |
| Stage all with a nested repo that has commits | It is staged as a link, and git's warning is shown although the command succeeded |
| The lists fail to load | The error is shown under the commit box, not "Working tree clean" |
| The message is blank | Commit is disabled; the backend also refuses |
| Nothing is staged | Commit is disabled; if raced, git's "nothing to commit" is shown |
| A file changed on disk since the list loaded | git acts on what is there now; the lists reload after every operation |

## Testing

**Rust unit tests** (`cargo test`, temp repos; these run the real `git` program): staged,
unstaged and combined diffs after a mix of staged, modified and untracked files, with
untracked content present; stage one file and all files; unstage one file and all files;
unstage before the first commit; commit with a multi-line message; blank message refused;
commit with nothing staged reports failure.

**TypeScript unit tests** (`pnpm test`): the paths sent for a plain and a renamed file;
when the Commit button is enabled.

**Manual check in the running app:** stage and unstage single files and all; the two lists
and their diffs; commit; the Push count going up; a failing commit showing git's output;
a repo with no commits.

## Out of scope

- Discarding changes, amending, stashing, branch switching.
- Staging individual hunks or lines.
- AI-written commit messages (roadmap 1.9).
- The remote web client.
