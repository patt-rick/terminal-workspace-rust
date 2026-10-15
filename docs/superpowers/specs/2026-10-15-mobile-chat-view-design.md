# Mobile chat view: design

Date: 2026-10-15
Status: approved in conversation; revised after an Opus spec review

## Problem

The phone client (`remote-web/`) renders every terminal as a full xterm.js
view of the PTY. For Claude Code terminals this works badly on a phone:

- The phone keyboard types straight into the TUI's input line, so autocorrect,
  dictation and multi-line text misbehave.
- Text wraps at the PTY's column count, not at the phone's width.

## Decision

On the **phone only**, Claude terminals open in a chat view. The view has two
parts:

- a message list, built from Claude's own transcript file;
- a native composer that types into the same PTY.

The agent keeps running as its real TUI on the desktop, and the desktop does
not change. A header toggle switches to the raw terminal at any time. Shell
terminals are unchanged.

This is a deliberate, phone-only exception to the desktop's "no chat
interface" rule.

Rejected alternatives:

- **Scrape chat from the xterm screen buffer.** It needs no protocol work, but
  it breaks with every Claude Code UI change.
- **Run phone sessions headless with `--output-format stream-json`.** That gives
  real token streaming, but the desktop would stop being a TUI.

## Phase 0: input spike (before any feature code)

The chat view depends on input behaviour we have not verified. Prove these
first, in a scratch build against a real Claude Code TUI, on native Windows
(ConPTY, Windows 10 19045) and in WSL. Record the results in the plan.

1. A bracketed paste (`ESC[200~ … ESC[201~`), followed by a separate `\r` sent
   about 100 ms later, submits the prompt. Test a single-line prompt, a
   multi-line prompt, and a large one, which Claude collapses to
   `[Pasted text #N]`.
2. If bracketed paste fails under ConPTY, find a fallback that works there:
   type the text line by line with the TUI's own newline key, then send `\r`.
3. Digit keys select permission options, and `ESC` interrupts a running turn.

If (1) and (2) both fail on a platform, the composer for that platform falls
back to "View in terminal". The rest of the design is unchanged.

## Architecture

### Which terminals get the chat view

A terminal is a **chat terminal** when its PTY has a Claude session id. That
id comes from one of three places:

- `--session-id <uuid>` in the startup command. The desktop's
  `src/state/claude-command.ts` already injects this.
- `--resume <uuid>`, `--resume=<uuid>` or `-r <uuid>`.
- A later hook update (see "Session tracking").

`extract_claude_session` (`src-tauri/src/pty/mod.rs:151`) is tightened. It
accepts only a UUID-shaped value and handles the `=` and `-r` forms. Today,
`claude --resume --dangerously-skip-permissions` stores the flag as the id;
with this change it stores nothing.

Phone-created Claude terminals must get an id too. `bridge::create_terminal`
(`bridge.rs:66-76`) currently launches a bare `claude`. It is changed to
generate a UUID and append `--session-id <uuid>`, as the desktop does.

These cases never get the chat view and stay as terminals:

- a user typing `claude` in a shell;
- `claude -c` / `--continue`;
- a picker-form `--resume` with no id, until a hook reports the id.

`TermInfo` gains two fields. Dead terminals report `false` for both.

- `claude: bool`, from a new `PtyManager::session_id(id)` accessor. It is
  filled in `state_snapshot` (`bridge.rs:34-39`) and in `spawn_terminal`
  (`bridge.rs:121-126`).
- `working: bool`, from the detector, so a phone that reconnects shows the
  right state straight away.

**Claude alive.** A chat terminal whose Claude has exited (`/exit`, a crash,
the auto-switch relaunch) is just a shell. The composer must never paste into
it. The server tracks `claude_alive` per PTY:

- It becomes true when the title detector (`detect.rs`) sees a Claude spinner
  or `✳` title, or when a Claude hook event arrives for that terminal.
- It becomes false on a shell prompt or OSC 133 `D` after that, or on PTY exit.

The server sends `state.claudeAlive { terminalId, alive }` whenever this
changes, and includes it in `TermInfo`. While it is false, the composer is
disabled with the note "Claude isn't running — open the terminal".

### Session tracking (hooks route by terminal)

Today hook events are routed by session id (`hooks.rs:243-245` →
`terminal_for_session`), and that id is fixed when the PTY is created
(`pty/mod.rs:322`). After a `/clear`, events carry a new id, the lookup fails,
and the event is dropped. Attention already breaks for that terminal, without
any chat feature involved.

Fix:

- Every PTY gets `TW_TERMINAL_ID=<pty id>` in its environment. It is added to
  the `WSLENV` list (`pty/mod.rs:266-277`) so it reaches WSL and comes back
  through interop.
- `run_sink` (`hooks.rs:32`) wraps stdin as
  `{ "terminalId": <env or null>, "payload": <stdin> }`. The spool reader also
  accepts the old, unwrapped form.
- Routing uses `terminalId` first and falls back to `session_id`.
- When a routed event's `session_id` differs from the PTY's stored one, the
  server calls a new `PtyManager::set_session_id(terminal_id, new)`. It records
  the event's `transcript_path` and tells any chat watcher on that terminal to
  re-point.
- `SessionStart` is added to `EVENTS`. On `/clear` it fires with the new
  `session_id` and `transcript_path`, so the switch is picked up immediately.
  It is not classified as attention.
- Hook installation is opt-in. Without hooks, nothing re-points. The chat view
  then shows a one-time banner: "Turn on Claude notifications on the desktop
  so chat follows /clear".

**Out of scope:** syncing the new id back to the desktop's own
`claudeSessionId` (`src/state/store.ts`). The desktop Sessions panel's "live"
flag can go stale after `/clear`, as it does today.

### Finding the transcript

The transcript path is resolved in this order:

1. The latest `transcript_path` from a hook event for that terminal. For WSL,
   the Linux path is mapped to UNC with `unc_path` (`wsl/mod.rs:117`).
2. Otherwise, the terminal's own home, taken from `TerminalRecord.shell` plus
   `parse_shell_token`. That means the Windows home, or that one distro's home.
   `<home>/.claude/projects/*/<id>.jsonl` is searched there only, which also
   covers a cwd that differs from the project root.

Discovery runs once per `chat.open` or re-point, and the result is cached. If
the file doesn't exist yet, only the existence check is retried, at most every
2 s. Discovery is never re-run, and it never calls `wsl.exe` or boots a distro.

Ids pass the UUID check before use. `CLAUDE_CONFIG_DIR` is ignored, as in the
existing Sessions panel.

### Normalised message model

Rust parses JSONL rows into a phone-friendly shape:

```
ChatMessage {
  id: String,                 // message.id for assistant rows; row uuid for user rows
  role: "user" | "assistant" | "divider",
  ts: i64,                    // epoch millis
  blocks: Vec<ChatBlock>,
}
ChatBlock =
  | { kind: "text", text: String }
  | { kind: "image" }                                   // placeholder only
  | { kind: "toolUse", id: String, name: String, summary: String }
  | { kind: "toolResult", toolUseId: String, ok: bool, preview: String }
  | { kind: "divider", label: String }                  // "Conversation compacted"
```

Rules:

- **Whitelist.** Only `type ∈ {user, assistant}` rows are kept, plus `system`
  rows with subtype `compact_boundary`, which become a divider. Everything
  else is dropped: `summary`, other `system` subtypes,
  `file-history-snapshot`, `ai-title`, `queue-operation`, `progress`, and
  unknown types.
- **Sidechains.** Rows with `isSidechain: true` are dropped, so subagent
  traffic doesn't appear as user bubbles.
- **Compaction.** User rows with `isCompactSummary: true` are dropped. The
  boundary divider stands in for them.
- **User wrappers.** User rows are dropped when they are `isMeta`, or when
  their text starts with any of these: `<command-name>`, `<command-message>`,
  `<command-args>`, `<local-command-stdout>`, `<local-command-stderr>`,
  `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, `<system-reminder>`.
  `[Request interrupted by user…]` becomes a small "Interrupted" divider.
- **Content shapes.** User content may be a string or a block array. A
  `tool_result.content` may be a string or an array of text and image blocks.
  Text is joined, and images become an `image` placeholder.
- **Grouping.** Streamed assistant blocks are written as separate rows that
  share `message.id`. Consecutive assistant rows with the same `message.id`
  merge into one `ChatMessage`, and `chat.append` may therefore send an update
  to an existing id. The client upserts by id. User rows that contain only
  `tool_result` blocks attach their results to the preceding assistant
  message's matching `toolUse`. They are not separate bubbles.
- **Orphans.** A `toolResult` whose `toolUse` fell outside the history window
  is dropped.
- **Dropped blocks.** `thinking` and `redacted_thinking` blocks are dropped.
- **Tool summaries.** Each tool use gets a short label, taken from the input
  field below. A tool not in the table shows its name.

  | Tool | Label |
  | --- | --- |
  | `Edit`, `Write`, `Read`, `MultiEdit` | `file_path` |
  | `NotebookEdit` | `notebook_path` |
  | `Bash` | first line of `command`, truncated to 120 chars |
  | `Grep`, `Glob` | `pattern` |
  | `Task` | `description` |
  | `WebFetch` | `url` |
  | `WebSearch` | `query` |

- **Caps.** `preview` is capped at 2,000 chars, with `ok = !is_error`. A text
  block is capped at 50,000 chars.
- **Parsing.** Rows are parsed shallowly, as `Row` in `claude/mod.rs` already
  does, and malformed lines are skipped.

### Protocol additions

Client → server:

- `chat.open { terminalId }` starts following that terminal's transcript.
  There is at most one chat per connection; opening another stops the previous
  one.
  - **Security:** it accepts only a terminal id, never a path or a session id.
    The server resolves the file itself. A contract test checks that an extra
    `path` field is ignored.
- `chat.close { terminalId }` stops following.
- `term.releaseSize { terminalId }` hands the PTY's size back to the desktop
  (`restore_local_size` plus `emit_remote_size(None)`).

Server → client:

- `chat.history { terminalId, sessionId, messages, truncated }` carries the
  last 200 grouped messages. It is sent on open and after each re-point.
- `chat.append { terminalId, messages }` carries new or updated messages. The
  client upserts them by id.
- `chat.unavailable { terminalId, reason }` means there is no session id, or
  the transcript is unreadable. The client falls back to the terminal view.
- `state.claudeAlive { terminalId, alive }`.

New wire tags are pinned in the contract tests in `protocol.rs`, and
`remote-web/src/protocol.ts` is updated to match.

### Reading and tailing

The work runs in a `spawn_blocking` loop owned by the connection.

- **Open.** Read backwards from the end of the file in 256 KB chunks until 200
  grouped messages are collected or the start of the file is reached. Large
  transcripts are never read whole.
- **Tick.** Every 500 ms:
  - check that the PTY still exists (`pty.has(id)`), and stop if it doesn't;
  - compare the file's length and identity;
  - read from the last offset and parse only complete lines, keeping any
    trailing partial line for the next tick.
- **Reset.** If the file shrinks, or is replaced by a different file, reset and
  send a fresh `chat.history`.

Lifecycle: `Conn` (`server.rs:278`) gets a field
`chat: Option<(terminal_id, stop flag / JoinHandle)>`. It is stopped:

- on `chat.close`;
- on another `chat.open`;
- on `TermClose` (`server.rs:325`);
- in socket cleanup (`server.rs:540`);
- when the PTY disappears.

Polling avoids a file-watcher dependency, and it works on WSL UNC paths.

## Phone UI (`remote-web/`)

### Layout and modes

- **ChatView** is a new component. It shows for the current terminal when the
  terminal has `claude` set and chat mode is on. The mode is remembered per
  terminal in `localStorage`, and chat is the default.
- **Terminal attachment.** The xterm instance stays mounted and attached, but
  hidden, so its scrollback stays current and switching back is instant.
- **Size ownership:**
  - On entering chat mode, the client sends `term.releaseSize`.
  - `attachTo`, the reconnect path and xterm's `onResize` send `term.resize`
    only while the terminal view is showing.
  - On Chat → Terminal, the client calls `fit()` and then always sends
    `resize`, because `onResize` doesn't fire when the size hasn't changed.
  - The desktop pane therefore never letterboxes while the phone is in chat.

### Messages

- User messages are right-aligned bubbles.
- Assistant text is rendered as Markdown (headings, lists, inline and fenced
  code, links) at phone width. Code blocks scroll horizontally.
- Tool uses are one-line rows (icon, name, summary, ✓ or ✗) that expand on tap
  to show the result preview.
- Dividers are for compaction and interrupts.
- The list stays pinned to the bottom while you are at the bottom. If you have
  scrolled up, a "New messages ↓" pill appears instead of jumping.

### Composer

- The input is a native auto-growing `<textarea>`. Enter inserts a newline;
  only the Send button sends.
- **Send** strips `ESC` characters, so a literal `ESC[201~` can't end the
  paste early. It then sends the paste and, about 100 ms later, `\r` as a
  separate `term.input`. If Phase 0 chose the fallback, Send uses that
  instead.
- Send stays available while Claude is working, because Claude queues typed
  prompts.
- **Stop** appears next to Send while `working` is true and sends one `ESC`.
  It is debounced to one tap per second and never sent while idle, because a
  second or idle Esc opens Claude's rewind picker.
- The composer uses the existing `--kb-inset` mechanism to stay above the
  keyboard.
- It is disabled when `claudeAlive` is false, or when the socket is closed
  (the text is kept and "Not connected" is shown).

### Working and permissions

- **Working row.** A "Claude is working…" row shows while `working` is true.
  There is no token streaming: messages appear as Claude writes each row.
- **Permission card.** It appears on a `needs-permission` attention for this
  terminal. The client now keeps the attention `message`, not only the reason
  (`app.tsx:93`, `:315`). The card shows:
  - the hook message;
  - generic **1**, **2** and **3** buttons, which send that digit;
  - **Esc — reject & stop**;
  - **View in terminal**.

  The labels are deliberately generic. Option meanings vary by tool, and plan
  approval and AskUserQuestion reuse the same prompt.
- **Dismissing the card.** It closes only on:
  - a button tap;
  - a `chat.append` that carries a `toolResult`;
  - a later attention or `finished` for this terminal.

  `state.working` changes do not dismiss it, because the spinner and the hook
  are not ordered relative to each other.
- **No card for `waiting-input`.** The composer already handles it.

### Fallbacks and styling

- On `chat.unavailable`, the client switches to the terminal and shows the
  reason in a toast.
- The view uses the existing theme tokens in `theme.ts` and `styles.css`, so
  it follows the desktop's live theme.
- Markdown is rendered with `marked`, with HTML escaped. Raw HTML in messages
  is never rendered.

## Error handling

- **Transcript missing or unreadable:** the server sends `chat.unavailable`
  and the client falls back to the terminal.
- **Malformed line:** it is skipped.
- **Reconnect:** on `hello.ok` the client sends `chat.open` again if chat was
  active. The fresh `chat.history` replaces the list. `TermInfo.working` and
  `claudeAlive` restore the state. An attention that was pending before the
  reconnect is not replayed; this is a known limitation.

## Testing

Rust unit tests:

- **Normaliser fixtures:**
  - string vs block content;
  - assistant rows split by `message.id` and merged;
  - `tool_use` with string and array `tool_result` content, ok and error;
  - thinking, sidechain, compact summary and command/meta wrappers all
    dropped;
  - the compact-boundary divider;
  - orphan results dropped;
  - malformed lines skipped;
  - caps applied.
- **Summary labels:** one test for each tool in the table, plus an unknown
  tool.
- **Tail reader:**
  - a partial trailing line is kept;
  - a file that shrinks or is replaced triggers a reset;
  - the backward chunked read returns the last N grouped messages.
- **Session-id extraction:** `--session-id`, `--resume`, `--resume=`, `-r`;
  the picker form (`--resume --flag`) is rejected, as is a non-UUID value.
- **Hook routing:** the wrapped payload routes by `terminalId`; the unwrapped
  payload falls back to `session_id`; a changed `session_id` calls
  `set_session_id`; `SessionStart` re-points.
- **Resolver:** prefers `transcript_path`; searches only the terminal's own
  home; rejects ids that aren't UUIDs.
- **Protocol contracts:** the new tags; the `claude`, `working` and
  `claudeAlive` fields; `chat.open` ignores a `path` field.

Manual testing, on a real phone over Tailscale:

- send a single-line and a multi-line prompt;
- Stop;
- the permission card: digits, Esc, and View in terminal;
- re-pointing after `/clear`;
- `/exit`, which should disable the composer;
- the Chat ⇄ Terminal toggle in both directions;
- reconnecting after switching apps;
- confirm the desktop pane doesn't letterbox while the phone is in chat;
- a Claude terminal created from the phone gets the chat view.

## Out of scope

- chat for shell terminals;
- editing or retrying messages;
- sending images;
- token-level streaming;
- syncing a re-pointed session id back to the desktop's store;
- replaying a pending attention after a reconnect.
