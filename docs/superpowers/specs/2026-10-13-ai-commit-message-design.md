# Commit messages written by Claude — design

Roadmap item 1.9 (commit messages only; PR titles and descriptions wait for milestone 4).

## What it is

A **Write message** button in the Git tab's commit box. It reads what is staged, asks
Claude for a commit message, and puts the answer in the message field. The user reads it,
edits it if they want, and commits as usual. Nothing is committed automatically.

## Decisions

- **Who writes it:** the Claude Code CLI, run headless (`claude -p`). Owner's choice. It
  uses the account Claude Code is logged in as, so there is no key to store.
- **Model:** `haiku`, fixed. A commit message is a small job and this keeps it to a few
  seconds. No setting in this version.
- **No transcript:** the call passes `--no-session-persistence`, so it does not appear in
  the Sessions panel or in the Usage page's history. It still counts against the
  account's limits. (Checked on CLI 2.1.296: a call took 3 seconds and left no project
  folder under `~/.claude/projects`.)
- **No tools, no project context:** `--tools ""`, `--setting-sources ""`,
  `--strict-mcp-config`, `--disable-slash-commands`, a replacement `--system-prompt`, and a
  private empty working folder (`commit-message` under the app's data folder, not the
  shared temp folder). The call cannot read files or run anything and skips the user's and
  the project's settings, and with them their hooks and plugins. Settings an organisation
  manages centrally may still apply. A diff that contains instructions can at worst
  produce a bad message, which the user sees before committing.
- **Staged secrets are sent.** Whatever is staged goes to Claude, including a staged
  `.env`. The button's tooltip says the staged changes are sent; nothing is sent without
  the click.
- **Constraint kept:** this is a button and a text field in the right pane. Nothing is
  typed into a terminal and there is no chat view.

## What Claude is sent

Standard input, in this order:

1. The last 10 commit subjects (`git log -10 --format=%s`), so the message matches the
   repo's style. Left out when the repo has no commits.
2. The staged summary (`git diff --cached --stat`).
3. The staged patch (`git diff --cached --no-color --no-ext-diff --no-textconv`), cut at
   60,000 bytes on a character boundary with a line saying it was cut. The summary above
   still names every file.

The system prompt asks for only the message: a subject of at most 72 characters in the
imperative mood, matching the style of the recent subjects, then a blank line and a short
body only when the change needs one; no quotes, code fences or commentary.

## Backend

**`src-tauri/src/git/message.rs`** (new; `git/mod.rs` is already long).

- `build_input(recent, stat, patch) -> String` — pure; applies the 60,000-byte cut.
- `clean_message(raw) -> String` — pure; trims, removes a wrapping code fence, and removes
  one pair of wrapping quotes or backticks around a single-line answer.
- `parse_answer(stdout) -> Result<String, String>` — pure; the call uses
  `--output-format json`, and this reads `result` and `is_error`, so a login or quota
  notice is reported as an error and never lands in the message field.
- `git_read(root, args, limit)` — runs a read-only git command and reads at most `limit`
  bytes of its output, then stops git. A huge staged file is never held in memory.
- `generate(root, cli) -> (bool, String)` — gathers the three inputs, refuses with
  "Nothing is staged" when the staged patch and summary are both empty, runs Claude, and
  returns the cleaned message or the error text.
- `run_claude(input, cli) -> Result<String, String>`:
  - spawned through `proc::hidden_command`, no shell;
  - tries `claude`, then `claude.cmd` on Windows (an npm-only install has no
    `claude.exe`), then the usual install folders (`~/.local/bin`, `~/.claude/local`,
    `/opt/homebrew/bin`, `/usr/local/bin`), because an app started from the dock has a
    shorter PATH than a terminal;
  - standard input written from its own thread; output read on threads that report over
    a channel, so a process left holding the pipes cannot outlast the limit;
  - 90-second limit, after which the process is killed;
  - `cli.env_remove` is the same list new terminals use (`claude_ambient_env_remove`), so
    a stray token in the environment does not override the account chosen in the app;
  - `ANTHROPIC_API_KEY` is always removed, so the call uses the Claude Code login and is
    never billed to an API key that happens to be in the environment. A machine with an
    API key and no login gets the CLI's "log in" error. `CLAUDECODE` and
    `CLAUDE_CODE_ENTRYPOINT` are removed too;
  - at the time limit the whole process tree is ended (`taskkill /T` on Windows, where an
    npm install runs through `claude.cmd`);
  - the answer is the last JSON object line of standard output; an error the CLI reports
    in it is shown as is, and standard error is used only when there is no answer to read.

**Command:** `git_generate_commit_message(repo_id) -> { ok, output }`, registered in
`lib.rs`, run on the blocking pool like the other git commands. Not exposed to the remote
bridge.

## Frontend

`ipc.git.generateCommitMessage(repoId)`.

In `git-changes.tsx`, a small row between the message field and the main buttons:

- **Write message** — enabled when something is staged and nothing else is running. Its
  tooltip says the staged changes are sent to Claude with the Claude Code login.
- While it runs: the row shows "Writing…" and **Cancel**; the message field is read-only
  (it keeps focus) and the commit, push, stage and unstage buttons are disabled, so the
  answer describes what is still staged. Cancel stops waiting and ignores the answer (the
  process ends on its own or at the time limit).
- On success the answer replaces the draft. If the field already had text, **Undo**
  appears in the row and restores it; asking again keeps the same Undo, so the text the
  user typed is what comes back. Undo goes away when the user types or commits, and does
  not survive switching repos.
- On failure the draft is untouched and the error is shown where git errors are shown.

## Errors

| Case | What the user sees |
|---|---|
| Nothing staged | Button disabled; backend also answers "Nothing is staged" |
| Claude Code not installed | "Claude Code was not found. Install it to write commit messages." |
| Not logged in, out of quota, network | The CLI's own message |
| No answer in 90 seconds | "Claude took too long to answer." |
| Empty answer | "Claude returned an empty message." |
| Repo switched or tab closed mid-way | Answer dropped |

## Testing

- Rust unit tests: `build_input` (order, missing history, the cut and its notice, cut on a
  multi-byte character), `clean_message` (plain, fenced, quoted, multi-line body kept),
  `generate` on a repo with nothing staged.
- `run_claude` is not unit tested (it needs the CLI and an account). It is checked in the
  running app: stage a file, press Write message, see the field fill; press it again over
  existing text and use Undo.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo test --lib`,
  `cargo check --no-default-features`.

## Not in this version

A model setting, an API-key path, PR titles and descriptions, a palette command, killing
the process on Cancel.
