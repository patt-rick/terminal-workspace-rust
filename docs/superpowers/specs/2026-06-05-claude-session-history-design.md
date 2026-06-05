# Claude Session History — Design

**Date:** 2026-06-05
**Status:** Approved for planning
**Topic:** Resume past Claude Code sessions after the terminal that ran them is closed.

## Problem

Terminals in this app are session-scoped: their PTYs die on quit/close and are
never restored. A user running `claude` in a terminal loses easy access to that
conversation once the terminal closes. Claude Code, however, persists every
session to disk and can resume any of them with `claude --resume <session-id>`.
We want to surface that history in-app so a user can browse past Claude sessions
for a project and reopen one in a new terminal.

## Goals

- Browse all Claude sessions for the selected project, newest first.
- Each session shows an identifiable title, last-active time, and message count.
- Resume a session in a new terminal with one click.
- Mark sessions that are currently open in an app terminal, and focus that
  terminal instead of resuming a second copy.
- Delete a session's transcript from disk.

## Non-goals (v1)

- Sessions started from a **subdirectory** of the project root (different Claude
  cwd → different on-disk folder). Documented limitation; can broaden later.
- Search/filter box over titles. Deferred.
- Sessions for non-Claude agents (aider, etc.).
- Live filesystem watching of `~/.claude`. The list refreshes on open, on manual
  refresh, and when a terminal exits.
- Renaming sessions, in-app transcript viewing.

## Architecture

All file access and JSONL parsing happen in Rust, consistent with the rest of the
app (`fs`, `git`, `github` modules all own their privileged work). A new Rust
module `claude/` exposes Tauri commands; the frontend gets a new **"Sessions"**
tab in the right sidebar and otherwise just renders what Rust returns.

```
Sessions tab ── invoke ──> claude_sessions_list(projectId)
                              └─> Rust: resolve ~/.claude/projects/<enc>/,
                                  scan *.jsonl, parse summaries, filter by cwd,
                                  sort by lastActive desc
   row click (not open) ──> createProjectTerminal(projectId, {
                                name: <title>, startupCommand: 'claude --resume <id>' })
   row click (open)     ──> focus the existing terminal
   delete               ── invoke ──> claude_session_delete(projectId, sessionId)
```

### Rejected alternatives

- **Frontend reads files via a generic fs command.** The app's `fs_*` commands
  are deliberately sandboxed to project roots and gitignore-aware; reaching into
  `~/.claude` would defeat that, and JSONL parsing in JS bloats the frontend.
- **Rust lists files, ships raw lines, JS parses.** Session files reach
  megabytes; sending them over IPC is wasteful.

## Locating a project's sessions

Claude stores sessions under `~/.claude/projects/<encoded-cwd>/`, where the
directory name is the project's absolute path with **every non-alphanumeric
character replaced by `-`**.

Verified example:
`C:\Users\Patrick Ackom\Desktop\repos\tw\terminal-workspace-rust`
→ `C--Users-Patrick-Ackom-Desktop-repos-tw-terminal-workspace-rust`
(`:` `\` and space all map to `-`; existing `-` are preserved).

Encoding rule (Rust): map each `char` to itself when it is ASCII alphanumeric,
else to `-`. Applied to the project's stored `path`.

Robustness: each session line carries the real `cwd` it ran in. After computing
the encoded dir, Rust reads the `cwd` from each session file and **keeps only
sessions whose `cwd` equals the project root** (path-normalized comparison). This
prevents a wrongly-encoded or stale folder from surfacing another project's
sessions, and guards against encoding drift across Claude versions.

The `~/.claude` base resolves from the user home dir (`dirs`/`home` equivalent
already available via the std/Tauri environment). If the directory does not
exist, `claude_sessions_list` returns an empty list (not an error).

## Per-session summary (data model)

Rust streams each `.jsonl` once (line-delimited JSON; malformed lines skipped)
and produces:

```rust
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    session_id: String,    // = filename stem (UUID)
    title: String,         // see precedence below
    message_count: u32,    // count of `user` + `assistant` lines
    last_active: i64,      // file mtime, epoch millis
    git_branch: Option<String>, // from any line that carries `gitBranch`
}
```

**Title precedence:**
1. Latest `ai-title` line's `aiTitle` field (Claude's own generated title).
2. Fallback: first `user` message's text, truncated (~80 chars). The user
   `message.content` is either a string or an array of blocks; take the first
   `text` block.
3. Last resort: first 8 chars of the session id.

**`lastActive`** uses the file's mtime rather than trusting in-file timestamps —
cheaper and resilient to malformed/duplicate timestamp lines. Files are sorted by
this value descending.

TS mirror (camelCase) in `lib/ipc.ts`:

```ts
interface ClaudeSession {
  sessionId: string
  title: string
  messageCount: number
  lastActive: number     // epoch millis
  gitBranch: string | null
}
```

## Tauri commands

Added to `claude/mod.rs` and registered in `lib.rs`:

- `claude_sessions_list(project_id: String) -> Vec<SessionSummary>`
  Resolves the project path via `StateStore::project_path`, computes the Claude
  dir, scans + parses + cwd-filters + sorts. Empty list if the dir is absent.
- `claude_session_delete(project_id: String, session_id: String) -> ()`
  Resolves the Claude dir, joins `<session_id>.jsonl`, **validates the resolved
  path is inside the Claude project dir** (reject any `session_id` containing path
  separators or `..`), then removes the file. Errors via the existing `AppError`.

IPC wrappers in `lib/ipc.ts` under a new `claude` namespace:

```ts
claude: {
  listSessions: (projectId: string) =>
    invoke<ClaudeSession[]>('claude_sessions_list', { projectId }),
  deleteSession: (projectId: string, sessionId: string) =>
    invoke<void>('claude_session_delete', { projectId, sessionId }),
}
```

## Resume, "currently open", and dedup

Clicking a session spawns a **new terminal** running `claude --resume <id>`,
**unless that session is already open in an app terminal** — in which case the app
selects the existing terminal (`setActiveTerminal`) instead of resuming a second
copy.

To track which session each terminal is running, every Claude terminal the app
launches carries a known session id:

- **Resume** launches with `claude --resume <id>` → id is known.
- **Fresh** "✳ Claude Code" launches generate a UUID and launch
  `claude --session-id <uuid>` → id is known from the start.

The workspace store (`state/store.ts`) gains:

```ts
sessionIdByTerminal: Record<string, string>   // terminalId -> claude sessionId
setTerminalSession: (terminalId: string, sessionId: string) => void
```

`createProjectTerminal` gains an optional `claudeSessionId` param; when present it
records the mapping after the terminal is created. The terminal cleanup paths
(`removeTerminalLocal`) drop the entry alongside the existing per-terminal maps
(unread/title/busy).

The Sessions panel derives an `openSessionIds = new Set(Object.values(sessionIdByTerminal))`
and marks matching rows **● open**. A row's click handler:
- if open → find the terminal whose `sessionIdByTerminal` value matches and
  `setActiveTerminal(projectId, terminalId)`;
- else → `createProjectTerminal(projectId, { name: title, startupCommand:
  'claude --resume ' + sessionId, claudeSessionId: sessionId })`.

Sessions started **outside** the app appear in history but never show as open
(correct — they are not open here).

**Dependency to verify in implementation:** that the installed `claude` accepts
`--session-id <uuid>` for fresh starts. If it does not, fresh launches simply omit
the flag and won't get the live indicator (graceful degradation); resume is
unaffected. The "✳ Claude Code" empty-state button and the settings-driven
`startupCommand` path are the two fresh-launch sites to wire.

## UI: Sessions tab

`right-sidebar.tsx` gains a fourth tab `sessions`:

```ts
type Tab = 'files' | 'git' | 'github' | 'sessions'
```

New component `components/right-sidebar/sessions-panel.tsx`:

- On mount / tab-open and on a manual **refresh** button, calls
  `ipc.claude.listSessions(projectId)` into local state with a loading flag.
- Re-fetches when a terminal exits (subscribe via the existing
  `ipc.terminals.onExit` listener, or a store-level signal).
- Renders rows: title (truncated), a subtle second line with relative last-active
  (e.g. "2h ago"), message count, and optional git branch. Rows matching an open
  session show a small ● open marker and act as "focus" rather than "resume".
- Right-click (reuse `components/context-menu.tsx`) → **Delete session** →
  `ConfirmDialog` (danger) → `ipc.claude.deleteSession` → refresh.
- Empty state: "No Claude sessions yet for this project."

Relative-time formatting is a small local helper (no new dependency).

## Error handling

- Missing `~/.claude/projects/<enc>` dir → empty list, no error.
- Malformed JSONL lines → skipped; a file with zero parseable content still lists
  with the last-resort title and `messageCount: 0`.
- Delete of a non-existent file → surfaced as `AppError`; the panel shows a
  transient inline error and refreshes.
- `claude` binary missing at resume time is out of scope here — the terminal will
  show the shell's "command not found", same as today's "✳ Claude Code" button.

## Testing

Rust unit tests (`claude/mod.rs`):
- **Path encoding** — known path → known encoded dir.
- **Summary parsing** against a fixture `.jsonl`: ai-title precedence over
  first-user fallback; first-user fallback when no ai-title; count of
  user+assistant lines; malformed line skipped.
- **cwd filtering** — a session whose `cwd` differs from the project root is
  excluded.
- **Delete validation** — a `session_id` containing `..` or a path separator is
  rejected before any filesystem call.

Frontend: type-check (`pnpm build`/`tsc --noEmit`) and manual verification —
resume opens a working terminal, the open indicator appears, delete removes the
row.

## Files touched

**Rust**
- `src-tauri/src/claude/mod.rs` *(new)* — module, summary struct, scan/parse,
  encoding, two commands, tests.
- `src-tauri/src/lib.rs` — `mod claude;` + register the two commands.

**Frontend**
- `src/lib/ipc.ts` — `ClaudeSession` type + `claude` namespace.
- `src/state/store.ts` — `sessionIdByTerminal` map, setter, cleanup, and
  `createProjectTerminal` `claudeSessionId` param + fresh-launch UUID/`--session-id`.
- `src/components/right-sidebar/right-sidebar.tsx` — fourth tab.
- `src/components/right-sidebar/sessions-panel.tsx` *(new)* — the panel.
- `src/app.tsx` — pass a generated session id through the "✳ Claude Code"
  empty-state launch.

## Open implementation checks

1. Confirm `claude --session-id <uuid>` is supported by the installed CLI; if not,
   degrade fresh-launch linking gracefully.
2. Confirm the home-dir resolution approach for `~/.claude` on Windows/macOS/Linux
   within the Tauri/Rust environment.
