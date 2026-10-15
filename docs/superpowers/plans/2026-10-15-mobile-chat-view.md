# Mobile Chat View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the phone remote client, show Claude terminals as a chat (a message list built from Claude's transcript, plus a native composer that types into the PTY), with a toggle back to the raw terminal.

**Architecture:** The desktop never changes. Rust follows the terminal's Claude transcript JSONL, normalises rows into `ChatMessage`s, and streams them over the existing WebSocket as `chat.history` / `chat.append`. Hook events are now routed by a `TW_TERMINAL_ID` env var, so a `/clear` re-points the follower. The phone renders a `ChatView` overlaid on the (still attached, hidden) xterm. It sends prompts as a bracketed paste followed by a separate `\r`, and hands PTY size ownership back to the desktop while chat is showing.

**Tech Stack:** Rust (Tauri 2, axum 0.7 WebSocket, serde_json, tokio mpsc), React 19 + TypeScript, react-markdown 10, vitest (run from the repo root).

**Spec:** `docs/superpowers/specs/2026-10-15-mobile-chat-view-design.md`

**Spec deltas decided while planning** (Task 14 updates the spec to match):
- `ChatMessage.ts` is the transcript's ISO-8601 string, not epoch millis, so no date-parsing dependency is needed.
- Tool results are folded into their `toolUse` block on the server (`toolUse.result`), so there is no separate `toolResult` block.
- The tail detects a reset by file shrink only. Transcripts are append-only, and a new session is a new file, which re-pointing handles.
- `hello.ok` gains `claudeHooks: bool`, which drives the "turn on Claude notifications" banner.

**Conventions:**
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml <filter>`. The default features include `remote-access`.
- Web tests: `pnpm vitest run remote-web/src` from the repo root. The root vitest has no include filter, so it picks these up.
- Web typecheck and build: `npm --prefix remote-web run build`. This runs `tsc` and also copies the bundle into `src-tauri/src/remote/web_client.html`, which is committed.
- Commits: no `Co-Authored-By` trailer; commit straight to `master`.

---

## File map

| File | Responsibility |
|---|---|
| `src-tauri/src/claude/mod.rs` | + `is_uuid`; `truncate` → `pub(crate)`; `pub mod transcript` |
| `src-tauri/src/claude/transcript.rs` (new) | JSONL row → `ChatMessage` normaliser, tool summaries, backward tail load, incremental tail |
| `src-tauri/src/claude/hooks.rs` | sink wraps payload with terminal id; `parse_event` (replaces `classify`); `SessionStart`; upgrade of existing installs; routing by terminal |
| `src-tauri/src/pty/detect.rs` | `ClaudeAlive(bool)` detection |
| `src-tauri/src/pty/mod.rs` | strict session-id extraction; `TW_TERMINAL_ID` env; per-PTY `shell`/`transcript_path`; `chat_source`, `chat_flags`, `note_hook_session`, `mark_claude_alive`; claude-alive event |
| `src-tauri/src/remote/chat.rs` (new) | transcript resolver + per-connection follower thread |
| `src-tauri/src/remote/protocol.rs` | new client/server messages, `TermInfo` flags, `claudeHooks` |
| `src-tauri/src/remote/bridge.rs` | flags in snapshots; phone-created Claude gets `--session-id` |
| `src-tauri/src/remote/server.rs` | handle `chat.*` / `term.releaseSize`; forward claude-alive; follower lifecycle |
| `src-tauri/src/lib.rs` | upgrade installed hooks at startup |
| `remote-web/src/protocol.ts` | TS mirror |
| `remote-web/src/chat-model.ts` (new) | pure helpers: upsert, prompt sequences, permission-dismiss test, mode store |
| `remote-web/src/chat-model.test.ts` (new) | vitest for the above |
| `remote-web/src/chat-view.tsx` (new) | chat UI component |
| `remote-web/src/icons.tsx` | `ChatIcon`, `SendIcon`, `StopIcon` |
| `remote-web/src/styles.css` | chat styles |
| `remote-web/src/app.tsx` | mode switching, size gating, wiring |
| `CHANGELOG.md` | Unreleased entry |

---

### Task 1: Phase 0 input spike (manual, no feature code)

This proves the input assumptions before anything is built. Nothing from this task is committed except the results note.

**Files:**
- Create (scratch, not committed): `<scratchpad>/spike.mjs`

- [ ] **Step 1: Start the desktop app with dev remote autostart**

Run, in the repo root (PowerShell): `$env:TW_REMOTE_AUTOSTART='8899'; pnpm tauri dev`

Expected: the console prints a URL `http://127.0.0.1:8899` and a 6-digit pairing code. In the app, open a project and start a **Claude** terminal (the desktop launch adds `--session-id`). Note its terminal id from the remote snapshot printed in Step 3.

- [ ] **Step 2: Write the spike script**

```js
// spike.mjs — node spike.mjs <code> [terminalId] [mode]
// mode: single | multi | big | perm1 | esc
const [code, terminalId, mode = 'single'] = process.argv.slice(2)
const base = 'http://127.0.0.1:8899'
const { token } = await (await fetch(`${base}/pair`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
})).json()
const ws = new WebSocket(`ws://127.0.0.1:8899/ws`)
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const send = (o) => ws.send(JSON.stringify(o))
const input = (s) => send({ type: 'term.input', terminalId, data: b64(s) })
const paste = (s) => input(`\x1b[200~${s}\x1b[201~`)
ws.onopen = () => send({ type: 'hello', token })
ws.onmessage = async (ev) => {
  if (typeof ev.data !== 'string') return
  const m = JSON.parse(ev.data)
  if (m.type !== 'hello.ok') return
  if (!terminalId) {
    console.log(JSON.stringify(m.state.projects.map((p) => p.terminals), null, 1))
    process.exit(0)
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  if (mode === 'single') paste('Reply with just the word PONG')
  if (mode === 'multi') paste('Line one of my prompt.\nLine two: reply with just OK')
  if (mode === 'big') paste('Reply with OK. Padding:\n' + 'x '.repeat(3000))
  if (mode === 'perm1') input('1')
  if (mode === 'esc') input('\x1b')
  if (['single', 'multi', 'big'].includes(mode)) { await wait(100); input('\r') }
  await wait(500)
  process.exit(0)
}
```

- [ ] **Step 3: Run each case and watch the desktop terminal**

```
node spike.mjs <code>                       # lists terminals; pick the Claude one
node spike.mjs <code> <id> single
node spike.mjs <code> <id> multi
node spike.mjs <code> <id> big
```

Re-pair for each run (each pairing evicts the last; re-read the code from the app's Remote Access panel).

Expected for each: the prompt lands in Claude's input as **one** prompt (`big` shows `[Pasted text #1 …]`) and is **submitted**, with Claude replying.

Then ask Claude to run a shell command so it shows a permission prompt, and run `perm1`. Expected: option 1 is chosen. Start a long task and run `esc`. Expected: the turn is interrupted.

- [ ] **Step 4: Repeat Step 3 for a WSL Claude terminal**

Use a project whose shell is a WSL distro, if one is available. Same expectations.

- [ ] **Step 5: Check that `TW_TERMINAL_ID` reaches hooks across WSL interop**

Only possible after Task 5. Defer this check and record it in Task 15's manual checklist.

- [ ] **Step 6: Record results**

Append a "Phase 0 results" section to the bottom of this plan:
- platform × case → pass/fail;
- if `\r` 100 ms after the paste did not submit on a platform, the delay that worked (try 250 ms);
- if bracketed paste failed under ConPTY, note it. Task 10's `promptSequences` then uses the fallback (see the note there).
- if **both** bracketed paste and the line-by-line fallback fail on a platform, stop and report to the owner before building anything. The composer design depends on one of them working.

Commit: `git add docs/superpowers/plans/2026-10-15-mobile-chat-view.md && git commit -m "docs(remote): mobile chat phase 0 results"`

---

### Task 2: `is_uuid` and strict session-id extraction

**Files:**
- Modify: `src-tauri/src/claude/mod.rs` (add `is_uuid`, make `truncate` `pub(crate)`)
- Modify: `src-tauri/src/pty/mod.rs:149-158` (`extract_claude_session`) and its test at `:738-755`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/claude/mod.rs`, inside `mod tests`:

```rust
    #[test]
    fn is_uuid_accepts_only_canonical_uuids() {
        assert!(is_uuid("2b5c191b-945b-418d-9a3e-0d6c3f1e2a4b"));
        assert!(is_uuid("2B5C191B-945B-418D-9A3E-0D6C3F1E2A4B"));
        assert!(!is_uuid("--dangerously-skip-permissions"));
        assert!(!is_uuid("abc-123"));
        assert!(!is_uuid("2b5c191b-945b-418d-9a3e-0d6c3f1e2a4"));
        assert!(!is_uuid("2b5c191b_945b-418d-9a3e-0d6c3f1e2a4b"));
        assert!(!is_uuid("../5c191b-945b-418d-9a3e-0d6c3f1e2a4b"));
    }
```

In `src-tauri/src/pty/mod.rs`, replace the body of `extracts_session_id_from_launch_and_resume_commands` with:

```rust
        const U: &str = "2b5c191b-945b-418d-9a3e-0d6c3f1e2a4b";
        let s = |c: String| extract_claude_session(&c);
        assert_eq!(s(format!("claude --session-id {U}")), Some(U.into()));
        assert_eq!(s(format!("claude --session-id={U}")), Some(U.into()));
        assert_eq!(s(format!("claude --resume {U} --dangerously-skip-permissions")), Some(U.into()));
        assert_eq!(s(format!("claude --resume={U}")), Some(U.into()));
        assert_eq!(s(format!("claude -r {U}")), Some(U.into()));
        assert_eq!(s(format!("claude --dangerously-skip-permissions --session-id {U}")), Some(U.into()));
        // Picker form: the next token is a flag, not an id.
        assert_eq!(extract_claude_session("claude --resume --dangerously-skip-permissions"), None);
        assert_eq!(extract_claude_session("claude --session-id abc-123"), None);
        assert_eq!(extract_claude_session("claude"), None);
        assert_eq!(extract_claude_session("npm run dev"), None);
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- is_uuid extracts_session_id`
Expected: compile error, because `is_uuid` is not defined.

- [ ] **Step 3: Implement**

In `src-tauri/src/claude/mod.rs`, change `fn truncate(` to `pub(crate) fn truncate(`. After `valid_session_id`, add:

```rust
/// A canonical 8-4-4-4-12 hex UUID — the only shape Claude session ids take.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}
```

In `src-tauri/src/pty/mod.rs`, replace `extract_claude_session` with:

```rust
/// Extract the Claude session id from a startup command, if present. Only a
/// UUID counts, so the picker form (`--resume` followed by a flag) yields None.
#[cfg(feature = "remote-access")]
fn extract_claude_session(cmd: &str) -> Option<String> {
    let mut tokens = cmd.split_whitespace();
    while let Some(tok) = tokens.next() {
        let value = match tok {
            "--session-id" | "--resume" | "-r" => tokens.next(),
            _ => tok
                .strip_prefix("--session-id=")
                .or_else(|| tok.strip_prefix("--resume=")),
        };
        if let Some(v) = value {
            if crate::claude::is_uuid(v) {
                return Some(v.to_string());
            }
        }
    }
    None
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- is_uuid extracts_session_id`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude/mod.rs src-tauri/src/pty/mod.rs
git commit -m "fix(pty): only a UUID counts as a Claude session id"
```

---

### Task 3: Transcript normaliser

**Files:**
- Create: `src-tauri/src/claude/transcript.rs`
- Modify: `src-tauri/src/claude/mod.rs` (add `pub mod transcript;` after `pub mod usage;`)

- [ ] **Step 1: Write the module with its tests first (implementation stubbed)**

Create `src-tauri/src/claude/transcript.rs`:

```rust
//! Claude Code transcript (JSONL) → chat messages for the phone's chat view.
//!
//! Only conversation rows survive: user prompts, assistant text and tool calls
//! (with their results folded in), and dividers for compaction / interrupts.
//! Streamed assistant blocks arrive as separate rows sharing `message.id` and
//! are merged into one message; callers upsert by `ChatMessage::id`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use super::truncate;

pub const HISTORY_LIMIT: usize = 200;
const PREVIEW_CAP: usize = 2_000;
const TEXT_CAP: usize = 50_000;
const SUMMARY_CAP: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatBlock {
    Text { text: String },
    Image,
    ToolUse {
        id: String,
        name: String,
        summary: String,
        result: Option<ToolResult>,
    },
    Divider { label: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    /// "user" | "assistant" | "divider"
    pub role: &'static str,
    /// ISO-8601 timestamp from the row (empty when absent).
    pub ts: String,
    pub blocks: Vec<ChatBlock>,
}

/// User-row text that is CLI plumbing, not something the user typed.
const WRAPPER_PREFIXES: [&str; 9] = [
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<system-reminder>",
];

#[derive(Deserialize)]
struct Row {
    #[serde(rename = "type", default)]
    ty: String,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: bool,
    #[serde(rename = "isMeta", default)]
    is_meta: bool,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: bool,
    #[serde(default)]
    message: Option<Value>,
}

/// One-line label for a tool call, from the input field that identifies it.
pub fn tool_summary(name: &str, input: &Value) -> String {
    let field = match name {
        "Edit" | "Write" | "Read" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        "Bash" => "command",
        "Grep" | "Glob" => "pattern",
        "Task" => "description",
        "WebFetch" => "url",
        "WebSearch" => "query",
        _ => return String::new(),
    };
    let raw = input.get(field).and_then(Value::as_str).unwrap_or("");
    truncate(raw.lines().next().unwrap_or("").trim(), SUMMARY_CAP)
}

/// Ordered, grouped chat messages built up one transcript line at a time.
#[derive(Default)]
pub struct Transcript {
    msgs: Vec<ChatMessage>,
    by_id: HashMap<String, usize>,
    /// tool_use id → index of the message holding that tool call.
    tool_owner: HashMap<String, usize>,
    anon: u64,
}

impl Transcript {
    pub fn len(&self) -> usize {
        self.msgs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.msgs.is_empty()
    }

    /// The last `HISTORY_LIMIT` messages.
    pub fn history(&self) -> Vec<ChatMessage> {
        let start = self.msgs.len().saturating_sub(HISTORY_LIMIT);
        self.msgs[start..].to_vec()
    }

    /// Current state of the given messages (for `chat.append`), in list order.
    pub fn get(&self, ids: &[String]) -> Vec<ChatMessage> {
        let mut idx: Vec<usize> = ids.iter().filter_map(|id| self.by_id.get(id).copied()).collect();
        idx.sort_unstable();
        idx.dedup();
        idx.into_iter().map(|i| self.msgs[i].clone()).collect()
    }

    /// Ingest one raw line; returns the ids of messages it created or changed.
    pub fn ingest(&mut self, line: &[u8]) -> Vec<String> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(t: &mut Transcript, lines: &[&str]) -> Vec<String> {
        lines.iter().flat_map(|l| t.ingest(l.as_bytes())).collect()
    }

    #[test]
    fn user_string_and_block_content() {
        let mut t = Transcript::default();
        feed(&mut t, &[
            r#"{"type":"user","uuid":"u1","timestamp":"2026-10-15T10:00:00Z","message":{"role":"user","content":"hello there"}}"#,
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"text","text":"second"},{"type":"image","source":{}}]}}"#,
        ]);
        let h = t.history();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].role, "user");
        assert_eq!(h[0].ts, "2026-10-15T10:00:00Z");
        assert_eq!(h[0].blocks, vec![ChatBlock::Text { text: "hello there".into() }]);
        assert_eq!(h[1].blocks, vec![ChatBlock::Text { text: "second".into() }, ChatBlock::Image]);
    }

    #[test]
    fn split_assistant_rows_merge_by_message_id() {
        let mut t = Transcript::default();
        let changed = feed(&mut t, &[
            r#"{"type":"assistant","uuid":"a1","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}"#,
            r#"{"type":"assistant","uuid":"a2","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"Let me look."}]}}"#,
            r#"{"type":"assistant","uuid":"a3","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"pnpm test\nsecond line"}}]}}"#,
        ]);
        assert_eq!(changed, vec!["msg_1".to_string(), "msg_1".to_string()]);
        let h = t.history();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].id, "msg_1");
        assert_eq!(h[0].blocks, vec![
            ChatBlock::Text { text: "Let me look.".into() },
            ChatBlock::ToolUse { id: "tu_1".into(), name: "Bash".into(), summary: "pnpm test".into(), result: None },
        ]);
    }

    #[test]
    fn tool_results_fold_into_their_tool_use() {
        let mut t = Transcript::default();
        feed(&mut t, &[
            r#"{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"src/app.tsx"}},{"type":"tool_use","id":"tu_2","name":"Bash","input":{"command":"false"}}]}}"#,
        ]);
        let changed = feed(&mut t, &[
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file body"}]}}"#,
            r#"{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","is_error":true,"content":[{"type":"text","text":"exit 1"},{"type":"image"}]}]}}"#,
        ]);
        assert_eq!(changed, vec!["m1".to_string(), "m1".to_string()]);
        let h = t.history();
        assert_eq!(h.len(), 1, "tool-result rows are not bubbles");
        let results: Vec<_> = h[0].blocks.iter().map(|b| match b {
            ChatBlock::ToolUse { result, .. } => result.clone(),
            _ => panic!(),
        }).collect();
        assert_eq!(results[0], Some(ToolResult { ok: true, preview: "file body".into() }));
        assert_eq!(results[1], Some(ToolResult { ok: false, preview: "exit 1".into() }));
    }

    #[test]
    fn orphan_tool_result_is_dropped() {
        let mut t = Transcript::default();
        let changed = feed(&mut t, &[
            r#"{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"gone","content":"x"}]}}"#,
        ]);
        assert!(changed.is_empty());
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn noise_rows_are_dropped() {
        let mut t = Transcript::default();
        let changed = feed(&mut t, &[
            r#"{"type":"summary","summary":"x"}"#,
            r#"{"type":"file-history-snapshot","snapshot":{}}"#,
            r#"{"type":"ai-title","aiTitle":"x"}"#,
            r#"{"type":"system","subtype":"local_command","content":"x"}"#,
            r#"{"type":"user","uuid":"s","isSidechain":true,"message":{"content":"subagent prompt"}}"#,
            r#"{"type":"user","uuid":"m","isMeta":true,"message":{"content":"caveat"}}"#,
            r#"{"type":"user","uuid":"c","isCompactSummary":true,"message":{"content":"This session is being continued"}}"#,
            r#"{"type":"user","uuid":"w","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","uuid":"r","message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"}]}}"#,
            "not json",
            "",
        ]);
        assert!(changed.is_empty());
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn compact_boundary_and_interrupt_become_dividers() {
        let mut t = Transcript::default();
        feed(&mut t, &[
            r#"{"type":"system","subtype":"compact_boundary","uuid":"b1","content":"Conversation compacted"}"#,
            r#"{"type":"user","uuid":"i1","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#,
        ]);
        let h = t.history();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].role, "divider");
        assert_eq!(h[0].blocks, vec![ChatBlock::Divider { label: "Conversation compacted".into() }]);
        assert_eq!(h[1].blocks, vec![ChatBlock::Divider { label: "Interrupted".into() }]);
    }

    #[test]
    fn caps_apply() {
        let mut t = Transcript::default();
        let big = "y".repeat(60_000);
        let row = serde_json::json!({"type":"assistant","uuid":"a","message":{"id":"m","content":[
            {"type":"text","text": big},
            {"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls"}}]}}).to_string();
        let res = serde_json::json!({"type":"user","uuid":"u","message":{"content":[
            {"type":"tool_result","tool_use_id":"t","content": "z".repeat(5_000)}]}}).to_string();
        feed(&mut t, &[&row, &res]);
        let h = t.history();
        match &h[0].blocks[0] { ChatBlock::Text { text } => assert_eq!(text.chars().count(), TEXT_CAP + 1), _ => panic!() }
        match &h[0].blocks[1] {
            ChatBlock::ToolUse { result: Some(r), .. } => assert_eq!(r.preview.chars().count(), PREVIEW_CAP + 1),
            _ => panic!(),
        }
    }

    #[test]
    fn history_keeps_the_last_limit() {
        let mut t = Transcript::default();
        for i in 0..(HISTORY_LIMIT + 5) {
            t.ingest(format!(r#"{{"type":"user","uuid":"u{i}","message":{{"content":"m{i}"}}}}"#).as_bytes());
        }
        let h = t.history();
        assert_eq!(h.len(), HISTORY_LIMIT);
        assert_eq!(h[0].id, "u5");
    }

    #[test]
    fn tool_summary_labels() {
        use serde_json::json;
        assert_eq!(tool_summary("Edit", &json!({"file_path":"a.rs"})), "a.rs");
        assert_eq!(tool_summary("MultiEdit", &json!({"file_path":"b.rs"})), "b.rs");
        assert_eq!(tool_summary("NotebookEdit", &json!({"notebook_path":"n.ipynb"})), "n.ipynb");
        assert_eq!(tool_summary("Grep", &json!({"pattern":"fn main"})), "fn main");
        assert_eq!(tool_summary("Task", &json!({"description":"explore"})), "explore");
        assert_eq!(tool_summary("WebFetch", &json!({"url":"https://x"})), "https://x");
        assert_eq!(tool_summary("WebSearch", &json!({"query":"q"})), "q");
        assert_eq!(tool_summary("Bash", &json!({"command":"a\nb"})), "a");
        assert_eq!(tool_summary("mcp__x__y", &json!({"a":1})), "");
        assert_eq!(tool_summary("Bash", &json!({"command":"c".repeat(200)})).chars().count(), SUMMARY_CAP + 1);
    }
}
```

- [ ] **Step 2: Register the module and run the tests to see them fail**

In `src-tauri/src/claude/mod.rs` add `pub mod transcript;` after `pub mod usage;`.

Run: `cargo test --manifest-path src-tauri/Cargo.toml claude::transcript`
Expected: `tool_summary_labels` passes; the rest panic on `todo!()`.

- [ ] **Step 3: Implement `ingest` and its helpers**

Replace the `ingest` stub with this, and add the free functions below the `impl`:

```rust
    pub fn ingest(&mut self, line: &[u8]) -> Vec<String> {
        let Ok(row) = serde_json::from_slice::<Row>(line) else {
            return Vec::new();
        };
        if row.is_sidechain {
            return Vec::new();
        }
        let ts = row.timestamp.clone().unwrap_or_default();
        match row.ty.as_str() {
            "system" if row.subtype.as_deref() == Some("compact_boundary") => {
                let id = self.row_id(&row);
                self.push_divider(id, ts, "Conversation compacted")
            }
            "assistant" => self.ingest_assistant(&row, ts),
            "user" if !row.is_meta && !row.is_compact_summary => self.ingest_user(&row, ts),
            _ => Vec::new(),
        }
    }

    fn row_id(&mut self, row: &Row) -> String {
        row.uuid.clone().unwrap_or_else(|| {
            self.anon += 1;
            format!("row-{}", self.anon)
        })
    }

    fn push(&mut self, msg: ChatMessage) -> Vec<String> {
        let id = msg.id.clone();
        self.by_id.insert(id.clone(), self.msgs.len());
        self.msgs.push(msg);
        vec![id]
    }

    fn push_divider(&mut self, id: String, ts: String, label: &str) -> Vec<String> {
        self.push(ChatMessage {
            id,
            role: "divider",
            ts,
            blocks: vec![ChatBlock::Divider { label: label.into() }],
        })
    }

    fn ingest_assistant(&mut self, row: &Row, ts: String) -> Vec<String> {
        let Some(message) = &row.message else {
            return Vec::new();
        };
        let blocks: Vec<ChatBlock> = content_blocks(message)
            .iter()
            .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = b.get("text").and_then(Value::as_str).unwrap_or("").trim();
                    (!text.is_empty()).then(|| ChatBlock::Text { text: truncate(text, TEXT_CAP) })
                }
                Some("tool_use") => {
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    Some(ChatBlock::ToolUse {
                        id: b.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                        summary: tool_summary(&name, &input),
                        name,
                        result: None,
                    })
                }
                _ => None,
            })
            .collect();
        if blocks.is_empty() {
            return Vec::new();
        }
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| self.row_id(row));
        let idx = match self.by_id.get(&id) {
            Some(&i) => {
                self.msgs[i].blocks.extend(blocks);
                i
            }
            None => {
                self.push(ChatMessage { id: id.clone(), role: "assistant", ts, blocks });
                self.msgs.len() - 1
            }
        };
        for b in &self.msgs[idx].blocks {
            if let ChatBlock::ToolUse { id: tid, .. } = b {
                self.tool_owner.insert(tid.clone(), idx);
            }
        }
        vec![id]
    }

    fn ingest_user(&mut self, row: &Row, ts: String) -> Vec<String> {
        let Some(message) = &row.message else {
            return Vec::new();
        };
        let mut changed = Vec::new();
        let mut blocks = Vec::new();
        let mut interrupted = false;
        let push_text = |text: &str, blocks: &mut Vec<ChatBlock>, interrupted: &mut bool| {
            let t = text.trim();
            if t.is_empty() || WRAPPER_PREFIXES.iter().any(|p| t.starts_with(p)) {
                return;
            }
            if t.starts_with("[Request interrupted by user") {
                *interrupted = true;
                return;
            }
            blocks.push(ChatBlock::Text { text: truncate(t, TEXT_CAP) });
        };
        match message.get("content") {
            Some(Value::String(s)) => push_text(s, &mut blocks, &mut interrupted),
            Some(Value::Array(arr)) => {
                for b in arr {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => push_text(
                            b.get("text").and_then(Value::as_str).unwrap_or(""),
                            &mut blocks,
                            &mut interrupted,
                        ),
                        Some("image") => blocks.push(ChatBlock::Image),
                        Some("tool_result") => {
                            if let Some(id) = self.attach_result(b) {
                                changed.push(id);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        if interrupted {
            // Distinct from the bubble's id when the row also has text.
            let id = format!("{}-int", self.row_id(row));
            changed.extend(self.push_divider(id, ts.clone(), "Interrupted"));
        }
        if !blocks.is_empty() {
            let id = self.row_id(row);
            changed.extend(self.push(ChatMessage { id, role: "user", ts, blocks }));
        }
        changed
    }

    /// Fold a tool_result block into its tool call; returns the owning message id.
    fn attach_result(&mut self, block: &Value) -> Option<String> {
        let tool_id = block.get("tool_use_id")?.as_str()?;
        let &idx = self.tool_owner.get(tool_id)?;
        let ok = !block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let preview = truncate(&result_text(block.get("content")), PREVIEW_CAP);
        let msg = &mut self.msgs[idx];
        for b in &mut msg.blocks {
            if let ChatBlock::ToolUse { id, result, .. } = b {
                if id == tool_id {
                    *result = Some(ToolResult { ok, preview });
                    return Some(msg.id.clone());
                }
            }
        }
        None
    }
}

/// A message's content as a block list (a bare string becomes one text block).
fn content_blocks(message: &Value) -> Vec<Value> {
    match message.get("content") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => vec![serde_json::json!({"type": "text", "text": s})],
        _ => Vec::new(),
    }
}

/// Text of a tool_result's `content` (a string, or text/image blocks).
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(arr)) => {
            let parts: Vec<&str> = arr
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            if parts.is_empty() && !arr.is_empty() {
                "[image]".to_string()
            } else {
                parts.join("\n").trim().to_string()
            }
        }
        _ => String::new(),
    }
}
```

Note: the `impl Transcript` block now ends after `attach_result`. Move the closing `}` accordingly, so `content_blocks` and `result_text` are free functions.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml claude::transcript`
Expected: all 9 tests PASS. (`row_id` borrowing `self` mutably inside `ingest_assistant` after `message` borrows `row` is fine; `row` is not `self`.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude/mod.rs src-tauri/src/claude/transcript.rs
git commit -m "feat(claude): normalise transcripts into chat messages"
```

---

### Task 4: Backward load and incremental tail

**Files:**
- Modify: `src-tauri/src/claude/transcript.rs`

- [ ] **Step 1: Write the failing tests** (append inside `mod tests`)

```rust
    fn write(path: &std::path::Path, s: &str) {
        std::fs::write(path, s).unwrap();
    }
    fn append(path: &std::path::Path, s: &str) {
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(s.as_bytes()).unwrap();
    }
    fn user(i: usize) -> String {
        format!("{{\"type\":\"user\",\"uuid\":\"u{i}\",\"message\":{{\"content\":\"m{i}\"}}}}\n")
    }

    #[test]
    fn load_tail_reads_last_messages_and_stops_at_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let mut body = String::new();
        for i in 0..300 {
            body.push_str(&user(i));
        }
        body.push_str("{\"type\":\"user\",\"uuid\":\"partial\""); // no newline yet
        write(&p, &body);
        let (t, offset, truncated) = load_tail_chunked(&p, 4096).unwrap();
        let h = t.history();
        assert_eq!(h.len(), HISTORY_LIMIT);
        assert_eq!(h.last().unwrap().id, "u299");
        assert!(truncated);
        assert_eq!(offset as usize, body.rfind('\n').unwrap() + 1);
    }

    #[test]
    fn load_tail_small_file_is_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        write(&p, &(user(0) + &user(1)));
        let (t, _, truncated) = load_tail(&p).unwrap();
        assert_eq!(t.len(), 2);
        assert!(!truncated);
    }

    #[test]
    fn tail_keeps_partial_lines_and_resets_on_shrink() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        write(&p, &user(0));
        let mut tail = Tail::at(std::fs::metadata(&p).unwrap().len());
        assert_eq!(tail.read_new(&p).unwrap(), TailRead::Lines(vec![]));
        append(&p, "{\"type\":\"user\",");
        assert_eq!(tail.read_new(&p).unwrap(), TailRead::Lines(vec![]));
        append(&p, "\"uuid\":\"u1\",\"message\":{\"content\":\"m1\"}}\n");
        match tail.read_new(&p).unwrap() {
            TailRead::Lines(lines) => {
                assert_eq!(lines.len(), 1);
                let mut t = Transcript::default();
                assert_eq!(t.ingest(&lines[0]), vec!["u1".to_string()]);
            }
            TailRead::Reset => panic!(),
        }
        write(&p, "");
        assert_eq!(tail.read_new(&p).unwrap(), TailRead::Reset);
    }
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml claude::transcript`
Expected: compile error, because `load_tail`, `Tail` and `TailRead` are not defined.

- [ ] **Step 3: Implement** (add above `#[cfg(test)]`)

```rust
const CHUNK: u64 = 256 * 1024;
/// Never read more than this backwards for the initial history.
const MAX_BACKREAD: u64 = 16 * 1024 * 1024;
/// Enough raw lines to yield ~200 messages (tool results and split assistant
/// rows make lines outnumber messages).
const LINE_BUDGET: usize = 3_000;

/// Build the initial history from the end of the file without reading it all.
/// Returns the transcript, the byte offset just past the last complete line
/// (where tailing resumes), and whether older messages were left out.
pub fn load_tail(path: &std::path::Path) -> std::io::Result<(Transcript, u64, bool)> {
    load_tail_chunked(path, CHUNK)
}

fn load_tail_chunked(path: &std::path::Path, chunk: u64) -> std::io::Result<(Transcript, u64, bool)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    // Read chunks backwards until there are enough lines, then parse once
    // (linear: no re-parsing or re-copying per chunk).
    let mut start = len;
    let mut pieces: Vec<Vec<u8>> = Vec::new();
    let mut newlines = 0usize;
    while start > 0 && newlines <= LINE_BUDGET && len - start < MAX_BACKREAD {
        let step = chunk.min(start);
        start -= step;
        let mut piece = vec![0u8; step as usize];
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut piece)?;
        newlines += piece.iter().filter(|&&b| b == b'
').count();
        pieces.push(piece);
    }
    let buf: Vec<u8> = pieces.into_iter().rev().flatten().collect();
    // Skip a leading partial line (unless at file start) and any trailing line
    // still being written.
    let head = if start == 0 {
        0
    } else {
        buf.iter().position(|&b| b == b'
').map_or(buf.len(), |i| i + 1)
    };
    let end = buf.iter().rposition(|&b| b == b'
').map_or(0, |i| i + 1);
    let mut t = Transcript::default();
    if head < end {
        for line in buf[head..end].split(|&b| b == b'
') {
            t.ingest(line);
        }
    }
    let truncated = start > 0 || t.len() > HISTORY_LIMIT;
    Ok((t, start + end as u64, truncated))
}

#[derive(Debug, PartialEq, Eq)]
pub enum TailRead {
    /// Complete new lines since the last read (possibly none).
    Lines(Vec<Vec<u8>>),
    /// The file shrank; reload from scratch.
    Reset,
}

/// Follows an append-only file from a byte offset, yielding complete lines.
pub struct Tail {
    offset: u64,
    partial: Vec<u8>,
}

impl Tail {
    pub fn at(offset: u64) -> Self {
        Self { offset, partial: Vec::new() }
    }

    pub fn read_new(&mut self, path: &std::path::Path) -> std::io::Result<TailRead> {
        use std::io::{Read, Seek, SeekFrom};
        let len = std::fs::metadata(path)?.len();
        let consumed = self.offset + self.partial.len() as u64;
        if len < consumed {
            return Ok(TailRead::Reset);
        }
        if len == consumed {
            return Ok(TailRead::Lines(Vec::new()));
        }
        let mut f = std::fs::File::open(path)?;
        f.seek(SeekFrom::Start(consumed))?;
        let mut fresh = Vec::with_capacity((len - consumed) as usize);
        f.take(len - consumed).read_to_end(&mut fresh)?;
        self.partial.extend_from_slice(&fresh);
        let Some(last_nl) = self.partial.iter().rposition(|&b| b == b'\n') else {
            return Ok(TailRead::Lines(Vec::new()));
        };
        let rest = self.partial.split_off(last_nl + 1);
        let complete = std::mem::replace(&mut self.partial, rest);
        self.offset += complete.len() as u64;
        Ok(TailRead::Lines(
            complete[..complete.len() - 1]
                .split(|&b| b == b'\n')
                .map(<[u8]>::to_vec)
                .collect(),
        ))
    }
}
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml claude::transcript`
Expected: all 12 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude/transcript.rs
git commit -m "feat(claude): read a transcript's tail and follow appends"
```

---

### Task 5: Hooks route by terminal; SessionStart/SessionEnd; safe upgrade

**Files:**
- Modify: `src-tauri/src/claude/hooks.rs`
- Modify: `src-tauri/src/pty/mod.rs` (`TW_TERMINAL_ID` env)
- Modify: `src-tauri/src/lib.rs` (upgrade existing installs)

Routing rules, which the `decide` tests pin:
- `TW_TERMINAL_ID` is inherited by everything Claude spawns. A nested `claude -p` run by a tool, or `claude` typed in a shell terminal, sends events carrying the terminal's id but a **different** session id. Those events are dropped.
- A terminal adopts a new session id only from `SessionStart` with source `clear`, `compact` or `resume`, and only when it already has a session. A shell terminal never becomes a chat terminal, and the picker-form `--resume` (no id at launch) stays a terminal.
- `SessionEnd` (any reason except `clear`) marks Claude not alive. That covers `/exit` under PowerShell and WSL, where no OSC 133 arrives.

- [ ] **Step 1: Write the failing tests**

In `hooks.rs` `mod tests`, replace `classify_permission_input_stop` with:

```rust
    #[cfg(feature = "remote-access")]
    #[test]
    fn parse_event_attention_and_routing_fields() {
        let perm = parse_event(
            r#"{"session_id":"s1","hook_event_name":"Notification","message":"Claude needs your permission to use Bash","transcript_path":"/x/s1.jsonl"}"#,
        )
        .unwrap();
        assert_eq!(perm.session_id, "s1");
        assert_eq!(perm.event, "Notification");
        assert_eq!(perm.terminal_id, None);
        assert_eq!(perm.transcript_path.as_deref(), Some("/x/s1.jsonl"));
        let (reason, msg) = perm.attention.clone().unwrap();
        assert_eq!(reason, "needs-permission");
        assert!(msg.unwrap().contains("Bash"));

        let waiting = parse_event(
            r#"{"session_id":"s2","hook_event_name":"Notification","message":"Claude is waiting for your input"}"#,
        )
        .unwrap();
        assert_eq!(waiting.attention.unwrap().0, "waiting-input");

        let stop = parse_event(r#"{"session_id":"s3","hook_event_name":"Stop"}"#).unwrap();
        assert_eq!(stop.attention, Some(("finished", None)));

        let start = parse_event(
            r#"{"terminalId":"t9","payload":{"session_id":"s4","hook_event_name":"SessionStart","source":"clear"}}"#,
        )
        .unwrap();
        assert_eq!(start.terminal_id.as_deref(), Some("t9"));
        assert_eq!(start.source.as_deref(), Some("clear"));
        assert_eq!(start.attention, None);

        let end = parse_event(
            r#"{"session_id":"s5","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}"#,
        )
        .unwrap();
        assert_eq!(end.source.as_deref(), Some("prompt_input_exit"));
        assert_eq!(end.attention, None);

        assert!(parse_event(r#"{"session_id":"s","hook_event_name":"PreToolUse"}"#).is_none());
        assert!(parse_event("not json").is_none());
    }

    #[cfg(feature = "remote-access")]
    #[test]
    fn decide_routes_only_this_terminals_session() {
        let ev = |event: &str, sid: &str, source: Option<&str>| HookEvent {
            terminal_id: Some("t".into()),
            session_id: sid.into(),
            transcript_path: None,
            event: event.into(),
            source: source.map(str::to_string),
            attention: None,
        };
        let r = |accept, adopt, ended| Route { accept, adopt, ended };
        // Same session: routed.
        assert_eq!(decide(&ev("Stop", "a", None), Some("a")), r(true, false, false));
        // A nested `claude -p` sharing the env var: dropped.
        assert_eq!(decide(&ev("Stop", "b", None), Some("a")), r(false, false, false));
        assert_eq!(decide(&ev("SessionStart", "b", Some("startup")), Some("a")), r(false, false, false));
        // /clear (and resume/compact forks) moves the terminal to the new session.
        assert_eq!(decide(&ev("SessionStart", "b", Some("clear")), Some("a")), r(true, true, false));
        assert_eq!(decide(&ev("SessionStart", "b", Some("resume")), Some("a")), r(true, true, false));
        assert_eq!(decide(&ev("SessionStart", "a", Some("compact")), Some("a")), r(true, false, false));
        // A terminal without a session never gains one (shells stay shells).
        assert_eq!(decide(&ev("SessionStart", "b", Some("clear")), None), r(false, false, false));
        // Exit ends Claude; the SessionEnd that /clear fires does not.
        assert_eq!(decide(&ev("SessionEnd", "a", Some("prompt_input_exit")), Some("a")), r(true, false, true));
        assert_eq!(decide(&ev("SessionEnd", "a", Some("clear")), Some("a")), r(true, false, false));
    }

    #[test]
    fn wrap_with_terminal_wraps_json_only() {
        let body = r#"{"session_id":"s"}"#;
        let wrapped: Value = serde_json::from_str(&wrap_with_terminal(body, Some("t1"))).unwrap();
        assert_eq!(wrapped["terminalId"], "t1");
        assert_eq!(wrapped["payload"]["session_id"], "s");
        assert_eq!(wrap_with_terminal(body, None), body);
        assert_eq!(wrap_with_terminal(body, Some("")), body);
        assert_eq!(wrap_with_terminal("garbage", Some("t1")), "garbage");
    }

    #[test]
    fn upgrade_adds_new_events_with_the_installed_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Not installed: nothing to upgrade, file untouched.
        assert_eq!(upgrade(&path), Ok(false));
        assert!(!path.exists());
        let cmd = "\"C:\\Program Files\\tw\\tw.exe\" --hook-sink \"C:\\spool\"";
        // An install from before SessionStart/SessionEnd existed.
        std::fs::write(
            &path,
            format!(
                r#"{{"hooks":{{"Notification":[{{"matcher":"","hooks":[{{"type":"command","command":{c}}}]}}],"Stop":[{{"matcher":"","hooks":[{{"type":"command","command":{c}}}]}}]}}}}"#,
                c = serde_json::to_string(cmd).unwrap()
            ),
        )
        .unwrap();
        assert!(is_installed(&path));
        assert_eq!(upgrade(&path), Ok(true));
        let root = read_settings(&path);
        for ev in ["SessionStart", "SessionEnd"] {
            // The existing install's command, verbatim — never this process's exe.
            assert_eq!(root["hooks"][ev][0]["hooks"][0]["command"], cmd);
        }
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(upgrade(&path), Ok(false));
    }
```

In `install_then_uninstall_preserves_user_hooks`, after the existing `Stop` assertion at the end, add:

```rust
        assert_eq!(root["hooks"]["SessionStart"].as_array().unwrap().len(), 0);
        assert_eq!(root["hooks"]["SessionEnd"].as_array().unwrap().len(), 0);
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml claude::hooks`
Expected: compile errors, because `parse_event`, `decide`, `Route`, `wrap_with_terminal` and `upgrade` are not defined.

- [ ] **Step 3: Implement in `hooks.rs`**

Replace the `EVENTS` constant with:

```rust
/// The hook events we subscribe to. `SessionStart`/`SessionEnd` let the phone's
/// chat view follow `/clear` and notice Claude exiting.
const EVENTS: [&str; 4] = ["Notification", "Stop", "SessionStart", "SessionEnd"];
/// Present in every install, old or new — what "installed" means.
const CORE_EVENTS: [&str; 2] = ["Notification", "Stop"];
```

In `is_installed`, change `EVENTS.iter()` to `CORE_EVENTS.iter()`. Add after `uninstall`:

```rust
/// The command an existing install uses (from a core event's marker entry).
fn our_command(root: &Value) -> Option<String> {
    CORE_EVENTS.iter().find_map(|ev| {
        root.get("hooks")?
            .get(ev)?
            .as_array()?
            .iter()
            .filter_map(|e| e.get("hooks")?.as_array())
            .flatten()
            .find_map(|c| {
                c.get("command")?
                    .as_str()
                    .filter(|s| s.contains(MARKER))
                    .map(str::to_string)
            })
    })
}

/// Add events introduced after an install, reusing that install's own command.
/// Existing entries are never rewritten, so a dev build can't take over the
/// installed app's hooks. Returns whether anything changed.
pub fn upgrade(settings_path: &Path) -> Result<bool, String> {
    let mut root = read_settings(settings_path);
    if !CORE_EVENTS.iter().all(|ev| has_our_entry(&root, ev)) {
        return Ok(false);
    }
    let Some(command) = our_command(&root) else {
        return Ok(false);
    };
    let mut changed = false;
    for event in EVENTS {
        if !has_our_entry(&root, event) {
            hooks_array(&mut root, event).push(json!({
                "matcher": "",
                "hooks": [{ "type": "command", "command": command }],
            }));
            changed = true;
        }
    }
    if changed {
        write_settings(settings_path, &root)?;
    }
    Ok(changed)
}
```

Replace `run_sink`'s `let _ = std::fs::write(spool.join(name), body);` line with:

```rust
    let terminal = std::env::var("TW_TERMINAL_ID").ok();
    let _ = std::fs::write(spool.join(name), wrap_with_terminal(&body, terminal.as_deref()));
```

and add below `run_sink`:

```rust
/// Tag a hook payload with the Terminal Workspace terminal it came from (the
/// PTY sets `TW_TERMINAL_ID`), so routing survives a session-id change.
pub fn wrap_with_terminal(body: &str, terminal: Option<&str>) -> String {
    let Some(t) = terminal.filter(|t| !t.is_empty()) else {
        return body.to_string();
    };
    match serde_json::from_str::<Value>(body) {
        Ok(payload) => json!({ "terminalId": t, "payload": payload }).to_string(),
        Err(_) => body.to_string(),
    }
}
```

Replace `HookAttention` and `classify` with:

```rust
/// One hook event from the spool.
#[cfg(feature = "remote-access")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEvent {
    /// The PTY that spawned this Claude (wrapped payloads only).
    pub terminal_id: Option<String>,
    pub session_id: String,
    pub transcript_path: Option<String>,
    /// `hook_event_name`.
    pub event: String,
    /// SessionStart `source` / SessionEnd `reason`.
    pub source: Option<String>,
    /// (reason, message) when the event wants the user's attention.
    pub attention: Option<(&'static str, Option<String>)>,
}

/// Parse a spool file body (wrapped `{terminalId, payload}` or a bare payload).
#[cfg(feature = "remote-access")]
pub fn parse_event(body: &str) -> Option<HookEvent> {
    let v: Value = serde_json::from_str(body).ok()?;
    let (terminal_id, p) = match v.get("payload") {
        Some(p) => (v.get("terminalId").and_then(Value::as_str).map(str::to_string), p),
        None => (None, &v),
    };
    let session_id = p.get("session_id")?.as_str()?.to_string();
    let event = p.get("hook_event_name")?.as_str()?.to_string();
    let attention = match event.as_str() {
        "Stop" => Some(("finished", None)),
        "Notification" => {
            let message = p.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            let lower = message.to_lowercase();
            let reason = if lower.contains("permission") {
                "needs-permission"
            } else if lower.contains("waiting") || lower.contains("input") {
                "waiting-input"
            } else {
                "notify"
            };
            Some((reason, (!message.is_empty()).then_some(message)))
        }
        "SessionStart" | "SessionEnd" => None,
        _ => return None,
    };
    let source = p
        .get("source")
        .or_else(|| p.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let transcript_path = p.get("transcript_path").and_then(Value::as_str).map(str::to_string);
    Some(HookEvent { terminal_id, session_id, transcript_path, event, source, attention })
}

/// What to do with an event routed to a terminal whose session is `current`.
#[cfg(feature = "remote-access")]
#[derive(Debug, PartialEq, Eq)]
pub struct Route {
    /// The event belongs to this terminal's Claude.
    pub accept: bool,
    /// Switch the terminal to the event's session id (`/clear` and forks).
    pub adopt: bool,
    /// Claude exited.
    pub ended: bool,
}

#[cfg(feature = "remote-access")]
pub fn decide(ev: &HookEvent, current: Option<&str>) -> Route {
    let continues = ev.event == "SessionStart"
        && current.is_some()
        && matches!(ev.source.as_deref(), Some("clear" | "compact" | "resume"));
    let adopt = continues && current != Some(ev.session_id.as_str());
    let accept = adopt || current == Some(ev.session_id.as_str());
    let ended = accept && ev.event == "SessionEnd" && ev.source.as_deref() != Some("clear");
    Route { accept, adopt, ended }
}
```

In `start_watcher`, replace everything from `let Some(att) = classify(&body)` to the end of the `for` body with:

```rust
            let Some(ev) = parse_event(&body) else {
                continue;
            };
            // Route to the spawning terminal: by its id when the payload is
            // wrapped, else by session id. Events from sessions outside
            // Terminal Workspace are dropped.
            let pty = app.state::<crate::pty::PtyManager>();
            let terminal = ev
                .terminal_id
                .clone()
                .filter(|id| pty.has(id))
                .or_else(|| pty.terminal_for_session(&ev.session_id));
            let Some(terminal_id) = terminal else {
                continue;
            };
            let current = pty.chat_source(&terminal_id).and_then(|s| s.session_id);
            let route = decide(&ev, current.as_deref());
            if !route.accept {
                continue; // a nested Claude sharing the env var
            }
            if route.adopt {
                pty.adopt_session(&terminal_id, &ev.session_id);
            }
            pty.note_transcript(&terminal_id, ev.transcript_path.clone());
            pty.set_claude_alive(&app, &terminal_id, !route.ended);
            if let Some((reason, message)) = ev.attention {
                crate::pty::emit_attention(&app, &terminal_id, reason, message);
            }
```

`chat_source`, `adopt_session`, `note_transcript` and `set_claude_alive` arrive in Task 6. This task compiles only together with Task 6, so the tests run at the end of Task 6.

- [ ] **Step 4: Set `TW_TERMINAL_ID` in the PTY env** (`src-tauri/src/pty/mod.rs`, `create`)

After `cmd.env("TERM_PROGRAM_VERSION", "1.1.0");` add:

```rust
        // Lets Claude hook events name the terminal that spawned them.
        cmd.env("TW_TERMINAL_ID", &opts.id);
```

and in the WSLENV `names` vec add `"TW_TERMINAL_ID".to_string(),`.

- [ ] **Step 5: Upgrade existing installs at startup** (`src-tauri/src/lib.rs`)

Right after the `claude::hooks::start_watcher(...)` call (inside its own `#[cfg(feature = "remote-access")]`), add:

```rust
            // Installs made before SessionStart/SessionEnd existed get them,
            // with their own command (see hooks::upgrade). WSL distros are
            // upgraded the next time the user turns hooks on.
            #[cfg(feature = "remote-access")]
            if let Ok(home) = app.path().home_dir() {
                let _ = claude::hooks::upgrade(&home.join(".claude").join("settings.json"));
            }
```

(If `lib.rs` lacks `use tauri::Manager;`, add it.)

- [ ] **Step 6: Commit** (together with Task 6, after its tests pass)

---

### Task 6: PTY chat state: session tracking, Claude-alive and flags

**Files:**
- Modify: `src-tauri/src/pty/detect.rs`
- Modify: `src-tauri/src/pty/mod.rs`

- [ ] **Step 1: Write the failing detector test** (`detect.rs` `mod tests`)

```rust
    #[test]
    fn claude_alive_follows_titles_and_command_done() {
        let mut d = ShellDetector::default();
        assert!(!d.is_claude_alive());
        assert!(d.feed(&osc("2;✳ Claude Code")).contains(&DetectEvent::ClaudeAlive(true)));
        assert!(d.is_claude_alive());
        // Further Claude titles don't repeat the event.
        assert!(!d.feed(&osc("2;\u{2809} Working")).contains(&DetectEvent::ClaudeAlive(true)));
        // Shell integration closing the command ends it (bash/zsh/fish)…
        assert!(d.feed(&osc("133;D;0")).contains(&DetectEvent::ClaudeAlive(false)));
        assert!(d.feed(&osc("2;✳ Claude Code")).contains(&DetectEvent::ClaudeAlive(true)));
        // …and so does a non-Claude title (a shell resetting it after exit).
        assert!(d.feed(&osc("2;C:\\repo")).contains(&DetectEvent::ClaudeAlive(false)));
        assert!(!d.is_claude_alive());
        assert!(d.set_claude_alive(true));
        assert!(!d.set_claude_alive(true));
    }
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::detect`
Expected: compile error, because `ClaudeAlive` is not defined.

- [ ] **Step 3: Implement in `detect.rs`**

Add the variant to `DetectEvent`:

```rust
    /// A Claude Code TUI started (its title appeared) or ended (a non-Claude
    /// title, or the shell's OSC 133;D closing the command it ran in).
    ClaudeAlive(bool),
```

Add the field `claude_alive: bool,` to `ShellDetector`, and these methods inside `impl ShellDetector`:

```rust
    pub fn is_claude_alive(&self) -> bool {
        self.claude_alive
    }

    /// Set from outside (a Claude hook event); true if it changed.
    pub fn set_claude_alive(&mut self, alive: bool) -> bool {
        let changed = self.claude_alive != alive;
        self.claude_alive = alive;
        changed
    }

    fn note_alive(&mut self, alive: bool, events: &mut Vec<DetectEvent>) {
        if self.set_claude_alive(alive) {
            events.push(DetectEvent::ClaudeAlive(alive));
        }
    }
```

In `finish_osc`, change the `"0" | "2"` arm to:

```rust
            "0" | "2" => {
                self.note_alive(is_claude_title(rest), events);
                let working = title_indicates_work(rest);
                self.set_working(working, events);
            }
```

In the `"133"` arm's `else if rest.starts_with('D')` branch, add `self.note_alive(false, events);` as its first line. Add the free function:

```rust
/// Claude Code's titles start with a braille spinner or the ✳ marker.
fn is_claude_title(title: &str) -> bool {
    title.trim_start().chars().next().is_some_and(|c| c == '✳' || is_braille(c))
}
```

- [ ] **Step 4: Update the existing tests that now see `ClaudeAlive(true)`**

These four existing tests feed a Claude title to a fresh detector. They now get `[ClaudeAlive(true), Working(true)]` where they expected `[Working(true)]`:
- `braille_title_marks_working_then_idle` (first assert);
- `marker_title_with_task_is_working`;
- `sequence_split_across_chunks_is_handled` (second feed);
- `st_terminated_osc_works`.

Prepend `DetectEvent::ClaudeAlive(true),` to each of those expected vectors. Also check every other title assertion in that file. A non-Claude title fed after a Claude one now also yields `ClaudeAlive(false)`, so fix any vector that changes the same way.

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::detect`
Expected: all detect tests PASS.

- [ ] **Step 5: PTY state and accessors** (`src-tauri/src/pty/mod.rs`)

Add to `PtyHandle`, after `session_id`:

```rust
    /// Shell token the PTY runs (`wsl:<distro>` for WSL); picks the home that
    /// holds the transcript.
    #[cfg(feature = "remote-access")]
    shell: String,
    /// Transcript path last reported by a Claude hook (Linux path under WSL).
    #[cfg(feature = "remote-access")]
    transcript_path: Option<String>,
```

In `create`, inside the `PtyHandle { … }` literal after `session_id: …,` add:

```rust
                #[cfg(feature = "remote-access")]
                shell: shell.clone(),
                #[cfg(feature = "remote-access")]
                transcript_path: None,
```

Add the public type near `CreateOpts`:

```rust
/// What the chat follower needs to find a terminal's transcript.
#[cfg(feature = "remote-access")]
#[derive(Debug, Clone)]
pub struct ChatSource {
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub shell: String,
}
```

Add to `impl PtyManager` (next to `terminal_for_session`):

```rust
    /// Session id / transcript / shell of a live terminal (None once it's gone).
    #[cfg(feature = "remote-access")]
    pub fn chat_source(&self, id: &str) -> Option<ChatSource> {
        self.entries.lock().get(id).map(|h| ChatSource {
            session_id: h.session_id.clone(),
            transcript_path: h.transcript_path.clone(),
            shell: h.shell.clone(),
        })
    }

    /// (has a Claude session, working, Claude alive) — all false when gone.
    #[cfg(feature = "remote-access")]
    pub fn chat_flags(&self, id: &str) -> (bool, bool, bool) {
        let entries = self.entries.lock();
        let Some(h) = entries.get(id) else {
            return (false, false, false);
        };
        let out = h.out.lock();
        (h.session_id.is_some(), out.detector.is_working(), out.detector.is_claude_alive())
    }

    /// The terminal's Claude moved to a new session (`/clear`, a fork); the
    /// old transcript path no longer applies.
    #[cfg(feature = "remote-access")]
    pub fn adopt_session(&self, id: &str, session_id: &str) {
        if !crate::claude::is_uuid(session_id) {
            return;
        }
        if let Some(h) = self.entries.lock().get_mut(id) {
            h.session_id = Some(session_id.to_string());
            h.transcript_path = None;
        }
    }

    /// Remember the transcript path a hook reported for the current session.
    #[cfg(feature = "remote-access")]
    pub fn note_transcript(&self, id: &str, transcript_path: Option<String>) {
        let Some(p) = transcript_path else {
            return;
        };
        if let Some(h) = self.entries.lock().get_mut(id) {
            h.transcript_path = Some(p);
        }
    }

    /// A Claude hook says whether Claude is running here (SessionEnd → false).
    #[cfg(feature = "remote-access")]
    pub fn set_claude_alive(&self, app: &AppHandle, id: &str, alive: bool) {
        let changed = self
            .entries
            .lock()
            .get(id)
            .is_some_and(|h| h.out.lock().detector.set_claude_alive(alive));
        if changed {
            emit_detect_event(app, id, detect::DetectEvent::ClaudeAlive(alive));
        }
    }
```

In `emit_detect_event`, add the arm:

```rust
        detect::DetectEvent::ClaudeAlive(alive) => {
            let _ = app.emit(
                "terminals:claude-alive",
                ClaudeAlivePayload {
                    id: id.to_string(),
                    alive,
                },
            );
        }
```

and the payload type next to `WorkingPayload`:

```rust
#[cfg(feature = "remote-access")]
#[derive(Clone, Serialize)]
struct ClaudeAlivePayload {
    id: String,
    alive: bool,
}
```

- [ ] **Step 6: Build and run the pty and hooks tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- pty:: claude::hooks`
Expected: all PASS. Then run `cargo build --manifest-path src-tauri/Cargo.toml`. Nothing should still reference `hooks::classify`.

- [ ] **Step 7: Commit Tasks 5–6**

```bash
git add src-tauri/src/claude/hooks.rs src-tauri/src/pty/mod.rs src-tauri/src/pty/detect.rs src-tauri/src/lib.rs
git commit -m "feat(hooks): route Claude hooks by terminal; follow /clear; track Claude alive"
```

---

### Task 7: Protocol additions

**Files:**
- Modify: `src-tauri/src/remote/protocol.rs`

- [ ] **Step 1: Write the failing contract tests**

In `server_msg_wire_tags_are_stable`, make `ti` include the new fields:

```rust
        let ti = TermInfo {
            id: "t".into(),
            name: "n".into(),
            project_id: "p".into(),
            live: true,
            claude: true,
            working: false,
            claude_alive: true,
        };
```

Add `claude_hooks: false,` to the `HelloOk` case, and these cases to the vec before `SessionEvicted`:

```rust
            (
                ServerMsg::ChatHistory {
                    terminal_id: "t".into(),
                    session_id: None,
                    messages: vec![],
                    truncated: false,
                },
                "chat.history",
            ),
            (
                ServerMsg::ChatAppend {
                    terminal_id: "t".into(),
                    messages: vec![],
                },
                "chat.append",
            ),
            (
                ServerMsg::ChatUnavailable {
                    terminal_id: "t".into(),
                    reason: "r".into(),
                },
                "chat.unavailable",
            ),
            (
                ServerMsg::StateClaudeAlive {
                    terminal_id: "t".into(),
                    alive: true,
                },
                "state.claudeAlive",
            ),
```

In `client_msg_wire_tags_all_deserialize`, add:

```rust
            r#"{"type":"chat.open","terminalId":"t"}"#,
            r#"{"type":"chat.close","terminalId":"t"}"#,
            r#"{"type":"term.releaseSize","terminalId":"t"}"#,
```

And add a new test:

```rust
    #[test]
    fn chat_open_takes_only_a_terminal_id() {
        // A smuggled path is ignored: the server resolves the file itself (AC-3.10).
        let m: ClientMsg = serde_json::from_str(
            r#"{"type":"chat.open","terminalId":"t","path":"C:\\Windows\\win.ini","sessionId":"x"}"#,
        )
        .unwrap();
        assert!(matches!(m, ClientMsg::ChatOpen { terminal_id } if terminal_id == "t"));
    }

    #[test]
    fn term_info_serializes_chat_flags_camel_case() {
        let v = serde_json::to_value(TermInfo {
            id: "t".into(),
            name: "n".into(),
            project_id: "p".into(),
            live: true,
            claude: true,
            working: true,
            claude_alive: false,
        })
        .unwrap();
        assert_eq!(v["claude"], true);
        assert_eq!(v["working"], true);
        assert_eq!(v["claudeAlive"], false);
    }
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::protocol`
Expected: compile errors, because the new variants and fields don't exist yet.

- [ ] **Step 3: Implement**

Add to `ClientMsg` before `Ping`:

```rust
    /// Follow a Claude terminal's transcript as chat. Only the terminal id is
    /// accepted; the server resolves the file (AC-3.10).
    #[serde(rename = "chat.open")]
    ChatOpen { terminal_id: String },
    #[serde(rename = "chat.close")]
    ChatClose { terminal_id: String },
    /// Give the PTY size back to the desktop (the phone is showing chat).
    #[serde(rename = "term.releaseSize")]
    TermReleaseSize { terminal_id: String },
```

Add to `HelloOk` after `theme`:

```rust
        /// Whether Claude hooks are installed (chat follows `/clear` only then).
        claude_hooks: bool,
```

Add to `ServerMsg` before `SessionEvicted`:

```rust
    /// Replace the chat list (on open, and after the session changed).
    #[serde(rename = "chat.history")]
    ChatHistory {
        terminal_id: String,
        session_id: Option<String>,
        messages: Vec<crate::claude::transcript::ChatMessage>,
        truncated: bool,
    },
    /// New or updated messages; the client upserts by id.
    #[serde(rename = "chat.append")]
    ChatAppend {
        terminal_id: String,
        messages: Vec<crate::claude::transcript::ChatMessage>,
    },
    #[serde(rename = "chat.unavailable")]
    ChatUnavailable { terminal_id: String, reason: String },
    #[serde(rename = "state.claudeAlive")]
    StateClaudeAlive { terminal_id: String, alive: bool },
```

Add to `TermInfo` after `live`:

```rust
    /// The PTY runs a tracked Claude session (gets the phone's chat view).
    pub claude: bool,
    pub working: bool,
    /// Claude's TUI is running right now (not just the shell it ran in).
    pub claude_alive: bool,
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::protocol`
Expected: PASS. (The full crate won't build until Task 8 fills the new fields at the `TermInfo` / `HelloOk` construction sites; these tests compile because they're in the same module. If `cargo test` refuses to build the crate, do Task 8 Step 1 first, then run.)

- [ ] **Step 5: Commit** (together with Task 8)

---

### Task 8: Bridge flags, phone-created Claude session ids, hello flag

**Files:**
- Modify: `src-tauri/src/remote/bridge.rs`
- Modify: `src-tauri/src/remote/server.rs` (`hello_ok`)

- [ ] **Step 1: Fill the flags**

In `state_snapshot`, replace the `TermInfo { … }` closure body with:

```rust
                .map(|t| {
                    let (claude, working, claude_alive) = pty.chat_flags(&t.id);
                    TermInfo {
                        live: pty.has(&t.id),
                        id: t.id,
                        name: t.name,
                        project_id: p.id.clone(),
                        claude,
                        working,
                        claude_alive,
                    }
                })
```

In `spawn_terminal`, replace the final `Ok(TermInfo { … })` with:

```rust
    let (claude, working, claude_alive) = pty.chat_flags(&id);
    Ok(TermInfo {
        id,
        name,
        project_id: project_id.to_string(),
        live: true,
        claude,
        working,
        claude_alive,
    })
```

- [ ] **Step 2: Phone-created Claude terminals get a session id**

Replace `claude_command` with:

```rust
/// Build the Claude launch command, appending the Phase 1 skip-permissions flag
/// when enabled (AC-3.2). `resume_id` produces a `--resume <id>` launch; a
/// fresh launch gets its own `--session-id` (as the desktop does), so hooks
/// and the phone's chat view can find its transcript.
fn claude_command(app: &AppHandle, resume_id: Option<&str>) -> String {
    let mut cmd = String::from("claude");
    match resume_id {
        Some(id) => {
            cmd.push_str(" --resume ");
            cmd.push_str(id);
        }
        None => {
            cmd.push_str(" --session-id ");
            cmd.push_str(&Uuid::new_v4().to_string());
        }
    }
    if claude_skip_permissions(app) {
        cmd.push_str(" --dangerously-skip-permissions");
    }
    cmd
}
```

Add to `bridge.rs`:

```rust
/// Whether the Claude hooks are installed in the Windows home's settings.
pub fn claude_hooks_installed(app: &AppHandle) -> bool {
    app.path()
        .home_dir()
        .map(|h| crate::claude::hooks::is_installed(&h.join(".claude").join("settings.json")))
        .unwrap_or(false)
}
```

- [ ] **Step 3: Send it in `hello.ok`, and keep `Conn::handle` exhaustive** (`server.rs`)

Add `claude_hooks: bridge::claude_hooks_installed(&ctx.app),` to the `ServerMsg::HelloOk { … }` literal in `handle_socket`.

`Conn::handle` matches `ClientMsg` exhaustively, so the new variants need arms now or the crate won't build. Add a placeholder at the end of the `match msg { … }`; Task 9 replaces it:

```rust
            // Wired up in the next task.
            ClientMsg::ChatOpen { .. }
            | ClientMsg::ChatClose { .. }
            | ClientMsg::TermReleaseSize { .. } => {}
```

- [ ] **Step 4: Build and test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::`
Expected: builds; all remote tests PASS.

- [ ] **Step 5: Commit Tasks 7–8**

```bash
git add src-tauri/src/remote/protocol.rs src-tauri/src/remote/bridge.rs src-tauri/src/remote/server.rs
git commit -m "feat(remote): chat protocol messages and Claude terminal flags"
```

---

### Task 9: Chat follower and server wiring

**Files:**
- Create: `src-tauri/src/remote/chat.rs`
- Modify: `src-tauri/src/remote/mod.rs` (add `mod chat;` after `mod bridge;`)
- Modify: `src-tauri/src/remote/server.rs`

- [ ] **Step 1: Write `chat.rs` with resolver tests**

```rust
//! Follows one Claude terminal's transcript for a phone connection and streams
//! it as `chat.history` / `chat.append`. Polls (500 ms) instead of watching:
//! no new dependency, and it works on WSL UNC paths.

use axum::extract::ws::Message;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use super::protocol::ServerMsg;
use crate::claude::transcript::{load_tail, Tail, TailRead, Transcript};
use crate::pty::{ChatSource, PtyManager};

const TICK: Duration = Duration::from_millis(500);
const PROBE_EVERY: Duration = Duration::from_secs(2);

/// Find `<session>.jsonl` under `<projects>/*/` (the cwd may differ from the
/// project root, e.g. a worktree).
pub fn find_in_projects(projects: &Path, session_id: &str) -> Option<PathBuf> {
    if !crate::claude::is_uuid(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// Where this terminal's transcript lives: the hook-reported path when it names
/// this session's file, else a search of the terminal's own home only.
pub fn resolve(home: &Path, src: &ChatSource) -> Option<PathBuf> {
    let sid = src.session_id.as_deref()?;
    let distro = crate::wsl::parse_shell_token(&src.shell);
    if let Some(tp) = &src.transcript_path {
        let p = match distro {
            Some(d) if tp.starts_with('/') => crate::wsl::unc_path(d, tp),
            _ => PathBuf::from(tp),
        };
        // Only ever read the session's own transcript file.
        let want = format!("{sid}.jsonl");
        if p.file_name().and_then(|n| n.to_str()) == Some(want.as_str()) {
            return Some(p);
        }
    }
    // distro_home is cached after its first wsl.exe call, and the distro is
    // already running (this terminal lives in it).
    let base = match distro {
        #[cfg(windows)]
        Some(d) => crate::wsl::unc_path(d, &crate::wsl::distro_home(d)?),
        #[cfg(not(windows))]
        Some(_) => return None,
        None => home.to_path_buf(),
    };
    find_in_projects(&base.join(".claude").join("projects"), sid)
}

/// Owned by the connection; dropping it stops the follower thread.
pub struct ChatFollow {
    pub terminal_id: String,
    stop: Arc<AtomicBool>,
}

impl Drop for ChatFollow {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn send(out_tx: &mpsc::Sender<Message>, msg: &ServerMsg) -> bool {
    let body = serde_json::to_string(msg).unwrap_or_default();
    out_tx.blocking_send(Message::Text(body)).is_ok()
}

pub fn start(app: AppHandle, terminal_id: String, out_tx: mpsc::Sender<Message>) -> ChatFollow {
    let stop = Arc::new(AtomicBool::new(false));
    let follow = ChatFollow { terminal_id: terminal_id.clone(), stop: stop.clone() };
    std::thread::spawn(move || run(app, terminal_id, out_tx, stop));
    follow
}

fn run(app: AppHandle, terminal_id: String, out_tx: mpsc::Sender<Message>, stop: Arc<AtomicBool>) {
    let pty = app.state::<PtyManager>();
    let home = app.path().home_dir().unwrap_or_default();
    let mut followed: Option<String> = None;
    let mut open: Option<(PathBuf, Transcript, Tail)> = None;
    let mut last_probe: Option<Instant> = None;
    let mut sent_empty = false;

    while !stop.load(Ordering::Relaxed) {
        let Some(src) = pty.chat_source(&terminal_id) else {
            break; // terminal gone
        };
        let Some(sid) = src.session_id.clone() else {
            send(&out_tx, &ServerMsg::ChatUnavailable {
                terminal_id: terminal_id.clone(),
                reason: "This terminal isn't running a tracked Claude session.".into(),
            });
            break;
        };
        if followed.as_deref() != Some(sid.as_str()) {
            followed = Some(sid.clone());
            open = None;
            last_probe = None;
            sent_empty = false;
        }

        if open.is_none() && last_probe.map_or(true, |t| t.elapsed() >= PROBE_EVERY) {
            last_probe = Some(Instant::now());
            match resolve(&home, &src).filter(|p| p.is_file()) {
                Some(path) => match load_tail(&path) {
                    Ok((t, offset, truncated)) => {
                        if !send(&out_tx, &ServerMsg::ChatHistory {
                            terminal_id: terminal_id.clone(),
                            session_id: Some(sid.clone()),
                            messages: t.history(),
                            truncated,
                        }) {
                            break;
                        }
                        open = Some((path, t, Tail::at(offset)));
                    }
                    Err(e) => {
                        send(&out_tx, &ServerMsg::ChatUnavailable {
                            terminal_id: terminal_id.clone(),
                            reason: format!("Couldn't read the transcript: {e}"),
                        });
                        break;
                    }
                },
                // Claude writes nothing until the first prompt: show an empty chat.
                None if !sent_empty => {
                    sent_empty = true;
                    if !send(&out_tx, &ServerMsg::ChatHistory {
                        terminal_id: terminal_id.clone(),
                        session_id: Some(sid.clone()),
                        messages: Vec::new(),
                        truncated: false,
                    }) {
                        break;
                    }
                }
                None => {}
            }
        }

        if let Some((path, t, tail)) = open.as_mut() {
            match tail.read_new(path) {
                Ok(TailRead::Lines(lines)) if !lines.is_empty() => {
                    let changed: Vec<String> = lines.iter().flat_map(|l| t.ingest(l)).collect();
                    if !changed.is_empty()
                        && !send(&out_tx, &ServerMsg::ChatAppend {
                            terminal_id: terminal_id.clone(),
                            messages: t.get(&changed),
                        })
                    {
                        break;
                    }
                }
                Ok(TailRead::Lines(_)) => {}
                Ok(TailRead::Reset) | Err(_) => {
                    open = None;
                    last_probe = None;
                }
            }
        }
        std::thread::sleep(TICK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "2b5c191b-945b-418d-9a3e-0d6c3f1e2a4b";

    fn src(session: Option<&str>, tp: Option<&str>) -> ChatSource {
        ChatSource {
            session_id: session.map(str::to_string),
            transcript_path: tp.map(str::to_string),
            shell: "powershell.exe".into(),
        }
    }

    #[test]
    fn finds_session_in_any_project_dir() {
        let home = tempfile::tempdir().unwrap();
        let other = home.path().join(".claude").join("projects").join("C--repo-worktree");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(format!("{U}.jsonl")), "").unwrap();
        assert_eq!(resolve(home.path(), &src(Some(U), None)), Some(other.join(format!("{U}.jsonl"))));
        assert_eq!(resolve(home.path(), &src(Some("not-a-uuid"), None)), None);
        assert_eq!(resolve(home.path(), &src(None, None)), None);
    }

    #[test]
    fn prefers_hook_path_only_when_it_names_the_session_file() {
        let home = tempfile::tempdir().unwrap();
        let good = home.path().join(format!("{U}.jsonl"));
        assert_eq!(resolve(home.path(), &src(Some(U), Some(good.to_str().unwrap()))), Some(good));
        // A path to some other file is ignored (falls back to the search: none).
        assert_eq!(resolve(home.path(), &src(Some(U), Some("C:\\Windows\\win.ini"))), None);
    }
}
```

- [ ] **Step 2: Register the module and run the tests**

Add `mod chat;` to `src-tauri/src/remote/mod.rs` after `mod bridge;`.
Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::chat`
Expected: 2 tests PASS.

- [ ] **Step 3: Wire it into `server.rs`**

At the top, change `use super::bridge;` to `use super::{bridge, chat};`.

Add to `Conn`: `chat: Option<chat::ChatFollow>,`, and in the `Conn { … }` construction in `handle_socket`: `chat: None,`.

In `Conn::handle`, replace Task 8's placeholder arm with:

```rust
            ClientMsg::ChatOpen { terminal_id } => {
                self.chat = None; // one chat per connection
                if self.ctx.app.state::<PtyManager>().has(&terminal_id) {
                    self.chat = Some(chat::start(
                        self.ctx.app.clone(),
                        terminal_id,
                        self.out_tx.clone(),
                    ));
                } else {
                    self.send(ServerMsg::ChatUnavailable {
                        terminal_id,
                        reason: "That terminal has closed.".into(),
                    })
                    .await;
                }
            }
            ClientMsg::ChatClose { terminal_id } => {
                if self.chat.as_ref().is_some_and(|c| c.terminal_id == terminal_id) {
                    self.chat = None;
                }
            }
            ClientMsg::TermReleaseSize { terminal_id } => {
                let pty = self.ctx.app.state::<PtyManager>();
                if pty.remote_size(&terminal_id).is_some() {
                    pty.restore_local_size(&terminal_id);
                    crate::pty::emit_remote_size(&self.ctx.app, &terminal_id, None);
                }
            }
```

In the `ClientMsg::TermClose` arm, before `self.send(...)`, add:

```rust
                if self.chat.as_ref().is_some_and(|c| c.terminal_id == terminal_id) {
                    self.chat = None;
                }
```

In `handle_socket` cleanup, right after the attachments drain loop, add `conn.chat = None;`.

In `spawn_state_forwarders`, add next to the `terminals:working` listener:

```rust
    let tx = out_tx.clone();
    ids.push(app.listen("terminals:claude-alive", move |ev| {
        if let Ok(p) = serde_json::from_str::<AliveEvt>(ev.payload()) {
            let _ = tx.try_send(text(&ServerMsg::StateClaudeAlive {
                terminal_id: p.id,
                alive: p.alive,
            }));
        }
    }));
```

and the payload struct next to `WorkingEvt`:

```rust
#[derive(Deserialize)]
struct AliveEvt {
    id: String,
    alive: bool,
}
```

- [ ] **Step 4: Build and run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: everything PASSes. Also run `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`. It should be clean; fix any new lint (for example `map_or(true, …)` → `is_none_or` if clippy asks).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote/chat.rs src-tauri/src/remote/mod.rs src-tauri/src/remote/server.rs
git commit -m "feat(remote): stream a Claude terminal's transcript as chat"
```

---

### Task 10: Web protocol mirror and the pure chat model

**Files:**
- Modify: `remote-web/src/protocol.ts`
- Create: `remote-web/src/chat-model.ts`, `remote-web/src/chat-model.test.ts`

- [ ] **Step 1: Write the failing tests** (`remote-web/src/chat-model.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { hasPendingTool, promptSequences, resolvesTool, upsertMessages } from './chat-model'
import type { ChatMessage } from './protocol'

const msg = (id: string, text: string): ChatMessage => ({
  id,
  role: 'assistant',
  ts: '',
  blocks: [{ kind: 'text', text }],
})

describe('upsertMessages', () => {
  it('replaces existing ids in place and appends new ones', () => {
    const list = [msg('a', '1'), msg('b', '2')]
    const out = upsertMessages(list, [msg('a', '1+'), msg('c', '3')])
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(out[0].blocks[0]).toEqual({ kind: 'text', text: '1+' })
    expect(list[0].blocks[0]).toEqual({ kind: 'text', text: '1' }) // not mutated
  })
})

describe('promptSequences', () => {
  it('wraps text in bracketed paste and strips ESC', () => {
    expect(promptSequences('hi\x1b[201~ there\n')).toEqual({
      paste: '\x1b[200~hi[201~ there\x1b[201~',
      enter: '\r',
    })
  })
  it('keeps inner newlines', () => {
    expect(promptSequences('a\nb')?.paste).toBe('\x1b[200~a\nb\x1b[201~')
  })
  it('returns null for blank input', () => {
    expect(promptSequences('  \n ')).toBeNull()
  })
})

describe('resolvesTool / hasPendingTool', () => {
  const ok = { ok: true, preview: '' }
  const tools = (t2: typeof ok | null): ChatMessage => ({
    id: 'm',
    role: 'assistant',
    ts: '',
    blocks: [
      { kind: 'toolUse', id: 't1', name: 'Read', summary: 'a', result: ok },
      { kind: 'toolUse', id: 't2', name: 'Bash', summary: 'ls', result: t2 },
    ],
  })
  it('is true only when a previously pending tool call gets its result', () => {
    const prev = [tools(null)]
    // Same merged message re-sent: t1 was already done, t2 still waits.
    expect(resolvesTool(prev, [tools(null)])).toBe(false)
    expect(resolvesTool(prev, [tools(ok)])).toBe(true)
    expect(resolvesTool([], [tools(ok)])).toBe(false)
  })
  it('sees a tool call still waiting', () => {
    expect(hasPendingTool([tools(null)])).toBe(true)
    expect(hasPendingTool([tools(ok)])).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm vitest run remote-web/src/chat-model.test.ts`
Expected: FAIL, because the `./chat-model` module is not found.

- [ ] **Step 3: Extend `protocol.ts`**

Add these types after `SessionSummary`:

```ts
export interface ToolResult {
  ok: boolean
  preview: string
}
export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image' }
  | { kind: 'toolUse'; id: string; name: string; summary: string; result: ToolResult | null }
  | { kind: 'divider'; label: string }
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'divider'
  ts: string
  blocks: ChatBlock[]
}
```

Add to `TermInfo`:

```ts
  /** Runs a tracked Claude session — gets the chat view. */
  claude: boolean
  working: boolean
  /** Claude's TUI is running right now (not just the shell it ran in). */
  claudeAlive: boolean
```

Change the `onState` handler signature to add `claudeHooks: boolean` as the last parameter, and in the `hello.ok` case pass `m.claudeHooks ?? false`. Add handlers:

```ts
  onChatHistory?: (terminalId: string, messages: ChatMessage[], truncated: boolean) => void
  onChatAppend?: (terminalId: string, messages: ChatMessage[]) => void
  onChatUnavailable?: (terminalId: string, reason: string) => void
  onClaudeAlive?: (terminalId: string, alive: boolean) => void
```

Add the switch cases:

```ts
        case 'chat.history':
          this.h.onChatHistory?.(m.terminalId, m.messages, m.truncated)
          break
        case 'chat.append':
          this.h.onChatAppend?.(m.terminalId, m.messages)
          break
        case 'chat.unavailable':
          this.h.onChatUnavailable?.(m.terminalId, m.reason)
          break
        case 'state.claudeAlive':
          this.h.onClaudeAlive?.(m.terminalId, m.alive)
          break
```

Add the methods next to `resize`:

```ts
  releaseSize(terminalId: string): void {
    this.send({ type: 'term.releaseSize', terminalId })
  }
  chatOpen(terminalId: string): void {
    this.send({ type: 'chat.open', terminalId })
  }
  chatClose(terminalId: string): void {
    this.send({ type: 'chat.close', terminalId })
  }
  /** True when a message can be sent right now. */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
```

- [ ] **Step 4: Write `chat-model.ts`**

```ts
// Pure helpers for the phone chat view (unit-tested; no DOM or socket).
import type { ChatMessage } from './protocol'

/** Merge server messages into the list: same id replaces, new ids append. */
export function upsertMessages(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = list.slice()
  const at = new Map(out.map((m, i) => [m.id, i]))
  for (const m of incoming) {
    const i = at.get(m.id)
    if (i === undefined) {
      at.set(m.id, out.length)
      out.push(m)
    } else {
      out[i] = m
    }
  }
  return out
}

/** What to write to the PTY to submit `text` as one prompt: a bracketed paste
 *  (ESC stripped so the text can't end it early), then Enter sent separately —
 *  Claude Code can swallow an Enter that arrives in the same chunk. */
export function promptSequences(text: string): { paste: string; enter: string } | null {
  const clean = text.replace(/\x1b/g, '').replace(/\s+$/, '')
  if (!clean.trim()) return null
  return { paste: `\x1b[200~${clean}\x1b[201~`, enter: '\r' }
}

/** Delay between the paste and its Enter (Phase 0 result). */
export const ENTER_DELAY_MS = 100

/** Ids of tool calls still waiting for a result. */
function pendingTools(msgs: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of msgs) for (const b of m.blocks) if (b.kind === 'toolUse' && b.result === null) ids.add(b.id)
  return ids
}

/** A tool call that was waiting got its result: the permission prompt was
 *  answered. Messages are re-sent whole, so compare against `prev`. */
export function resolvesTool(prev: ChatMessage[], incoming: ChatMessage[]): boolean {
  const waiting = pendingTools(prev)
  return incoming.some((m) =>
    m.blocks.some((b) => b.kind === 'toolUse' && b.result !== null && waiting.has(b.id))
  )
}

export function hasPendingTool(msgs: ChatMessage[]): boolean {
  return pendingTools(msgs).size > 0
}

const MODE_KEY = 'tw_chat_mode'
export type ViewMode = 'chat' | 'terminal'

/** Per-terminal view choice; Claude terminals default to chat. */
export const modeStore = {
  get(id: string): ViewMode {
    try {
      const all = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}') as Record<string, ViewMode>
      return all[id] ?? 'chat'
    } catch {
      return 'chat'
    }
  },
  set(id: string, mode: ViewMode): void {
    try {
      const all = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}') as Record<string, ViewMode>
      all[id] = mode
      localStorage.setItem(MODE_KEY, JSON.stringify(all))
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  },
}
```

If Phase 0 (Task 1) found that bracketed paste fails under ConPTY, change `promptSequences` to return `paste: clean.split('\n').join('\x1b\r')` (ESC+CR is Claude Code's "newline without submit") and update the first two tests to match. Note the change in the Phase 0 results.

- [ ] **Step 5: Run the tests and confirm they pass; typecheck**

Run: `pnpm vitest run remote-web/src/chat-model.test.ts`
Expected: 6 tests PASS.
Run: `npm --prefix remote-web run typecheck`
Expected: no errors (`app.tsx`'s `onState` handler with fewer parameters is still assignable).

- [ ] **Step 6: Commit**

```bash
git add remote-web/src/protocol.ts remote-web/src/chat-model.ts remote-web/src/chat-model.test.ts
git commit -m "feat(remote-web): chat protocol mirror and chat model helpers"
```

---

### Task 11: ChatView component, icons and styles

**Files:**
- Modify: `remote-web/package.json` (+ `react-markdown`)
- Modify: `remote-web/src/icons.tsx`
- Create: `remote-web/src/chat-view.tsx`
- Modify: `remote-web/src/styles.css`

- [ ] **Step 1: Add react-markdown** (the same version as the desktop app)

Run: `npm --prefix remote-web install react-markdown@^10.1.0`
Expected: `package.json` and `package-lock.json` updated. react-markdown escapes raw HTML by default (there is no `rehype-raw`), which satisfies "raw HTML is never rendered".

- [ ] **Step 2: Icons** (append to `icons.tsx`)

```tsx
export const ChatIcon = (p: P) => (
  <Icon {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Icon>
)

export const SendIcon = (p: P) => (
  <Icon {...p}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </Icon>
)

export const StopIcon = (p: P) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
)
```

- [ ] **Step 3: Write `chat-view.tsx`**

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import type { ChatBlock, ChatMessage } from './protocol'
import { SendIcon, StopIcon, TerminalIcon } from './icons'

export interface PermissionPrompt {
  message: string | null
}

export function ChatView({
  messages,
  truncated,
  loaded,
  working,
  alive,
  connected,
  permission,
  hooksMissing,
  onSend,
  onStop,
  onKey,
  onViewTerminal,
}: {
  messages: ChatMessage[]
  truncated: boolean
  /** The first chat.history arrived. */
  loaded: boolean
  working: boolean
  alive: boolean
  connected: boolean
  permission: PermissionPrompt | null
  hooksMissing: boolean
  /** Returns false when the text could not be sent (keep the draft). */
  onSend: (text: string) => boolean
  onStop: () => void
  onKey: (seq: string) => void
  onViewTerminal: () => void
}) {
  const [draft, setDraft] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastStop = useRef(0)

  // Pin to the bottom while the user is there; otherwise flag new messages.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (atBottom) el.scrollTop = el.scrollHeight
    else setUnseen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, working, permission])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAtBottom(bottom)
    if (bottom) setUnseen(false)
  }

  const jumpDown = () => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
    setUnseen(false)
  }

  const send = () => {
    if (onSend(draft)) {
      setDraft('')
      jumpDown()
    }
  }

  const stop = () => {
    const now = Date.now()
    if (now - lastStop.current < 1000) return
    lastStop.current = now
    onStop()
  }

  const disabled = !alive || !connected
  const note = !connected
    ? 'Not connected'
    : !alive
      ? "Claude isn't running — open the terminal"
      : null

  return (
    <div className="chat">
      {hooksMissing && (
        <div className="chat-banner">
          Turn on Claude notifications on the desktop so chat follows /clear.
        </div>
      )}
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {truncated && <div className="chat-divider">Earlier messages are in the terminal</div>}
        {loaded && messages.length === 0 && (
          <div className="chat-empty">Send a message to start.</div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {working && <div className="chat-working">Claude is working…</div>}
        {permission && (
          <div className="chat-perm">
            <div className="chat-perm-msg">{permission.message ?? 'Claude needs your permission'}</div>
            <div className="chat-perm-keys">
              {['1', '2', '3'].map((k) => (
                <button key={k} className="btn" onClick={() => onKey(k)}>
                  {k}
                </button>
              ))}
              <button className="btn" onClick={() => onKey('\x1b')}>
                Esc — reject &amp; stop
              </button>
            </div>
            <button className="chat-link" onClick={onViewTerminal}>
              <TerminalIcon size={13} /> View in terminal
            </button>
          </div>
        )}
      </div>
      {unseen && !atBottom && (
        <button className="chat-pill" onClick={jumpDown}>
          New messages ↓
        </button>
      )}
      <div className="composer">
        {note && <div className="composer-note">{note}</div>}
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            placeholder="Message Claude"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
          />
          {working && alive && (
            <button className="composer-btn stop" onClick={stop} aria-label="Stop">
              <StopIcon size={16} />
            </button>
          )}
          <button
            className="composer-btn"
            onClick={send}
            disabled={disabled || !draft.trim()}
            aria-label="Send"
          >
            <SendIcon size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'divider') {
    const b = m.blocks[0]
    return <div className="chat-divider">{b?.kind === 'divider' ? b.label : ''}</div>
  }
  return (
    <div className={`chat-msg ${m.role}`}>
      {m.blocks.map((b, i) => (
        <Block key={i} b={b} user={m.role === 'user'} />
      ))}
    </div>
  )
}

function Block({ b, user }: { b: ChatBlock; user: boolean }) {
  const [open, setOpen] = useState(false)
  switch (b.kind) {
    case 'text':
      return user ? (
        <div className="bubble">{b.text}</div>
      ) : (
        <div className="md">
          <Markdown
            disallowedElements={['img']}
            components={{
              a: (p) => (
                <a href={p.href} target="_blank" rel="noreferrer">
                  {p.children}
                </a>
              ),
            }}
          >
            {b.text}
          </Markdown>
        </div>
      )
    case 'image':
      return <div className="chat-image">[image]</div>
    case 'divider':
      return <div className="chat-divider">{b.label}</div>
    case 'toolUse': {
      const mark = b.result === null ? '…' : b.result.ok ? '✓' : '✗'
      return (
        <div className={`tool ${b.result && !b.result.ok ? 'err' : ''}`}>
          <button className="tool-row" onClick={() => setOpen((o) => !o)}>
            <span className="tool-name">{b.name}</span>
            <span className="tool-sum">{b.summary}</span>
            <span className="tool-mark">{mark}</span>
          </button>
          {open && b.result && <pre className="tool-out">{b.result.preview || '(no output)'}</pre>}
        </div>
      )
    }
  }
}
```

- [ ] **Step 4: Styles** (append to `styles.css`)

```css
/* chat view — overlays the (still attached) terminal inside .termwrap */
.termwrap {
  position: relative;
}
.chat {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}
.chat-banner {
  margin: 8px 8px 0;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12px;
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
}
.chat-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 10px 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat-empty,
.chat-working {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 12px;
}
.chat-working {
  text-align: left;
  padding: 0 2px;
}
.chat-divider {
  align-self: center;
  font-size: 11px;
  color: var(--muted);
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--subtle);
}
.chat-msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.chat-msg.user {
  align-items: flex-end;
}
.bubble {
  max-width: 85%;
  padding: 8px 11px;
  border-radius: 14px 14px 4px 14px;
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  color: var(--foreground);
  font-size: 14px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.md {
  font-size: 14px;
  line-height: 1.5;
  color: var(--foreground);
  overflow-wrap: anywhere;
}
.md > :first-child {
  margin-top: 0;
}
.md > :last-child {
  margin-bottom: 0;
}
.md h1,
.md h2,
.md h3 {
  font-size: 15px;
  margin: 12px 0 6px;
}
.md ul,
.md ol {
  padding-left: 20px;
}
.md a {
  color: var(--link);
}
.md code {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--subtle);
  padding: 1px 4px;
  border-radius: 4px;
}
.md pre {
  overflow-x: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface);
}
.md pre code {
  background: none;
  padding: 0;
}
.chat-image {
  color: var(--muted);
  font-size: 12px;
}
.tool {
  border-radius: 8px;
  background: var(--subtle);
  min-width: 0;
}
.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  background: none;
  border: none;
  text-align: left;
  font-size: 12px;
}
.tool-name {
  font-weight: 600;
  flex-shrink: 0;
}
.tool-sum {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-mark {
  flex-shrink: 0;
  color: var(--success);
}
.tool.err .tool-mark {
  color: var(--danger);
}
.tool-out {
  margin: 0;
  padding: 0 9px 8px;
  max-height: 240px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--muted);
}
.chat-perm {
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-perm-msg {
  font-size: 13px;
}
.chat-perm-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chat-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  color: var(--link);
  font-size: 12px;
}
.chat-pill {
  position: absolute;
  left: 50%;
  bottom: 70px;
  transform: translateX(-50%);
  border: none;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  background: var(--accent);
  color: var(--accent-foreground);
}
.composer {
  flex-shrink: 0;
  padding: 6px 8px 8px;
  /* The key row (which owned the safe area) is hidden in chat. */
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--separator);
}
.composer-note {
  font-size: 11px;
  color: var(--muted);
  padding: 0 4px 4px;
}
.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.composer-input {
  flex: 1;
  min-width: 0;
  resize: none;
  max-height: 160px;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--field-border);
  background: var(--field-background);
  color: var(--foreground);
  font: 15px/1.35 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.composer-input:focus {
  outline: none;
  border-color: var(--focus);
}
.composer-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--accent-foreground);
}
.composer-btn:disabled {
  opacity: 0.4;
}
.composer-btn.stop {
  background: var(--danger);
  color: var(--background);
}
```

Links open in a new tab, so the PWA isn't navigated away, and images in Markdown aren't loaded. The `15px` composer font stops iOS Safari from zooming on focus, which it does for inputs under 16px in a non-standalone tab. If zoom still happens on a device, raise it to 16px.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix remote-web run typecheck`
Expected: no errors in `chat-view.tsx` (`app.tsx` errors from Task 10 remain until Task 12).

- [ ] **Step 6: Commit**

```bash
git add remote-web/package.json remote-web/package-lock.json remote-web/src/icons.tsx remote-web/src/chat-view.tsx remote-web/src/styles.css
git commit -m "feat(remote-web): chat view component"
```

---

### Task 12: Wire chat mode into the app

**Files:**
- Modify: `remote-web/src/app.tsx`

Each step below is a self-contained edit. The anchors are quoted from the current file.

- [ ] **Step 1: Imports and state**

Add these imports:

```ts
import { ChatView, type PermissionPrompt } from './chat-view'
import { ENTER_DELAY_MS, hasPendingTool, modeStore, promptSequences, resolvesTool, type ViewMode } from './chat-model'
import type { ChatMessage } from './protocol'
```

Add `ChatIcon` to the `./icons` import list.

Change `const [attention, setAttention] = useState<Record<string, string>>({})` to:

```ts
  const [attention, setAttention] = useState<Record<string, { reason: string; message: string | null }>>({})
```

Add after the sessions state:

```ts
  const [mode, setMode] = useState<ViewMode>('chat')
  const modeRef = useRef<ViewMode>('chat')
  modeRef.current = mode
  const [chat, setChat] = useState<{ id: string | null; messages: ChatMessage[]; truncated: boolean; loaded: boolean }>({
    id: null,
    messages: [],
    truncated: false,
    loaded: false,
  })
  const [alive, setAlive] = useState<Record<string, boolean>>({})
  const [permission, setPermission] = useState<Record<string, PermissionPrompt>>({})
  const [hooksMissing, setHooksMissing] = useState(false)
  const [unavailable, setUnavailable] = useState<Record<string, true>>({})
  const unavailableRef = useRef(unavailable)
  unavailableRef.current = unavailable
  const chatRef = useRef(chat)
  chatRef.current = chat
```

Add a helper below `termName`:

```ts
  /** Whether `id` should show chat right now (a Claude terminal, chat mode, chat not refused). */
  const chatFor = (id: string | null, info?: TermInfo): boolean => {
    if (!id) return false
    const t = info ?? projectsRef.current.flatMap((p) => p.terminals).find((x) => x.id === id)
    return !!t?.claude && modeStore.get(id) === 'chat' && !unavailableRef.current[id]
  }
```

`info` covers a terminal that was just created: `onCreated` calls `attachTo` before `projectsRef` holds it. Add `type TermInfo` to the `./protocol` import, change `attachTo`'s signature to `useCallback((id: string, info?: TermInfo) => {`, and in `onCreated` change `attachTo(t.id)` to `attachTo(t.id, t)`.

- [ ] **Step 2: Size gating in `attachTo`**

In `attachTo`, replace:

```ts
    termRef.current?.reset()
    client.attach(id)
    const term = termRef.current
    if (term) client.resize(id, term.cols, term.rows)
    setDrawerOpen(false)
```

with:

```ts
    termRef.current?.reset()
    client.attach(id)
    const wantChat = chatFor(id, info)
    setMode(wantChat ? 'chat' : 'terminal')
    setChat({ id, messages: [], truncated: false, loaded: false })
    if (wantChat) {
      termRef.current?.blur() // keystrokes must not reach the hidden terminal
      client.releaseSize(id)
      client.chatOpen(id)
    } else {
      // The key row may have just reappeared: refit before sending the size.
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        const term = termRef.current
        if (term && curIdRef.current === id) client.resize(id, term.cols, term.rows)
      })
    }
    setDrawerOpen(false)
```

Also, in `attachTo`, change the `setAttention` updater to keep working with the new object values. It only deletes keys, so it needs no change. Before attaching, add `if (curIdRef.current) client.chatClose(curIdRef.current)` immediately after `if (curIdRef.current) client.detach(curIdRef.current)`.

- [ ] **Step 3: Client handlers**

Change `onState: (state, _version, vapidKey, theme) => {` to `onState: (state, _version, vapidKey, theme, claudeHooks) => {`. Right after `setProjects(state.projects)` add:

```ts
        setHooksMissing(!claudeHooks)
        // A refusal may have been transient (a read error): try chat again.
        unavailableRef.current = {}
        setUnavailable({})
        setWorking(new Set(state.projects.flatMap((p) => p.terminals).filter((t) => t.working).map((t) => t.id)))
        setAlive(Object.fromEntries(state.projects.flatMap((p) => p.terminals).map((t) => [t.id, t.claudeAlive])))
```

In the same handler's reconnect branch, replace:

```ts
          termRef.current?.reset()
          clientRef.current?.attach(id)
          const term = termRef.current
          if (term) clientRef.current?.resize(id, term.cols, term.rows)
          return
```

with:

```ts
          termRef.current?.reset()
          clientRef.current?.attach(id)
          if (modeRef.current === 'chat' && chatFor(id)) {
            clientRef.current?.chatOpen(id)
          } else {
            const term = termRef.current
            if (term) clientRef.current?.resize(id, term.cols, term.rows)
          }
          return
```

Note: `projectsRef.current` is still the pre-reconnect list here, which is fine for `chatFor`.

In the same handler's fresh-load branch, change `attachTo(terminal.id)` to `attachTo(terminal.id, terminal)`. `projectsRef.current` is still `[]` at that point (the state update hasn't rendered), so without `info` a reloaded PWA would always open in terminal mode.

In `onAttention`, change `setAttention((a) => ({ ...a, [tid]: reason }))` to:

```ts
        setAttention((a) => ({ ...a, [tid]: { reason, message } }))
        if (reason === 'needs-permission') {
          setPermission((p) => ({ ...p, [tid]: { message } }))
        } else if (reason === 'finished') {
          // Not waiting-input/notify: the idle sweeper and Claude's idle
          // notice can fire while the prompt is still open.
          setPermission((p) => {
            if (!(tid in p)) return p
            const next = { ...p }
            delete next[tid]
            return next
          })
        }
```

In `onExit`, add `setAlive((a) => ({ ...a, [tid]: false }))`.

Add new handlers to the `RemoteClient({ … })` object:

```ts
      onChatHistory: (tid, messages, truncated) => {
        if (tid !== curIdRef.current) return
        setChat({ id: tid, messages, truncated, loaded: true })
        // A prompt answered elsewhere (on the desktop) leaves no waiting tool.
        if (!hasPendingTool(messages)) {
          setPermission((p) => {
            if (!(tid in p)) return p
            const next = { ...p }
            delete next[tid]
            return next
          })
        }
      },
      onChatAppend: (tid, messages) => {
        if (tid !== curIdRef.current) return
        const prev = chatRef.current.id === tid ? chatRef.current.messages : []
        setChat((c) => (c.id === tid ? { ...c, messages: upsertMessages(c.messages, messages) } : c))
        if (resolvesTool(prev, messages)) {
          setPermission((p) => {
            if (!(tid in p)) return p
            const next = { ...p }
            delete next[tid]
            return next
          })
        }
      },
      onChatUnavailable: (tid, reason) => {
        setUnavailable((u) => ({ ...u, [tid]: true }))
        if (tid === curIdRef.current) {
          setMode('terminal')
          setToast(reason)
          requestAnimationFrame(() => {
            fitRef.current?.fit()
            const term = termRef.current
            if (term) clientRef.current?.resize(tid, term.cols, term.rows)
          })
        }
      },
      onClaudeAlive: (tid, isAlive) => setAlive((a) => ({ ...a, [tid]: isAlive })),
```

Also add `upsertMessages` to the `./chat-model` import.

- [ ] **Step 4: Gate xterm's own resize**

In `mountTerminal`, replace:

```ts
      term.onResize(({ cols, rows }) => {
        const id = curIdRef.current
        if (id) clientRef.current?.resize(id, cols, rows)
      })
```

with:

```ts
      term.onResize(({ cols, rows }) => {
        const id = curIdRef.current
        // In chat mode the desktop owns the size (term.releaseSize).
        if (id && modeRef.current === 'terminal') clientRef.current?.resize(id, cols, rows)
      })
```

- [ ] **Step 5: Mode toggle and send/stop**

Add before `const doPair`:

```ts
  const switchMode = (next: ViewMode) => {
    const id = curIdRef.current
    if (!id) return
    modeStore.set(id, next)
    setMode(next)
    if (next === 'chat') {
      termRef.current?.blur()
      clientRef.current?.releaseSize(id)
      clientRef.current?.chatOpen(id)
    } else {
      clientRef.current?.chatClose(id)
      // onResize won't fire if the grid didn't change, so always send it.
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        const term = termRef.current
        if (term) clientRef.current?.resize(id, term.cols, term.rows)
        term?.focus()
      })
    }
  }

  const sendPrompt = (text: string): boolean => {
    const id = curIdRef.current
    const client = clientRef.current
    const seq = promptSequences(text)
    if (!id || !client || !seq || !client.isOpen()) return false
    client.input(id, seq.paste)
    setTimeout(() => client.input(id, seq.enter), ENTER_DELAY_MS)
    return true
  }

  const answerPermission = (seq: string) => {
    const id = curIdRef.current
    if (!id) return
    clientRef.current?.input(id, seq)
    setPermission((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })
  }
```

- [ ] **Step 6: Render**

In the topbar, before the Git button, add:

```tsx
        {current?.claude && !unavailable[current.id] && (
          <button
            className="iconbtn"
            onClick={() => switchMode(mode === 'chat' ? 'terminal' : 'chat')}
            aria-label={mode === 'chat' ? 'Show terminal' : 'Show chat'}
          >
            {mode === 'chat' ? <TerminalIcon size={17} /> : <ChatIcon size={17} />}
          </button>
        )}
```

Replace the `termwrap` block's terminal branch so the chat overlays the terminal:

```tsx
        {current ? (
          <>
            <div className="term" ref={mountTerminal} onClick={() => termRef.current?.focus()} />
            {showChat && (
              <ChatView
                messages={chat.id === current.id ? chat.messages : []}
                truncated={chat.id === current.id && chat.truncated}
                loaded={chat.id === current.id && chat.loaded}
                working={working.has(current.id)}
                alive={!!alive[current.id]}
                connected={!reconnecting}
                permission={permission[current.id] ?? null}
                hooksMissing={hooksMissing}
                onSend={sendPrompt}
                onStop={() => {
                  if (working.has(current.id)) clientRef.current?.input(current.id, '\x1b')
                }}
                onKey={answerPermission}
                onViewTerminal={() => switchMode('terminal')}
              />
            )}
          </>
        ) : (
```

and compute, just after `const current = …`:

```ts
  const showChat = !!current?.claude && mode === 'chat' && !unavailable[current.id]
```

Hide the key row in chat: change `<div className="keys">` to `{!showChat && (<div className="keys">` … `</div>)}`, closing the conditional after the key row's closing `</div>`.

Update `dotClass(working.has(t.id), attention[t.id])` to `dotClass(working.has(t.id), attention[t.id]?.reason)`.

- [ ] **Step 7: Typecheck, run tests and build**

Run: `npm --prefix remote-web run typecheck`
Expected: no errors.
Run: `pnpm vitest run remote-web/src`
Expected: PASS.
Run: `npm --prefix remote-web run build`
Expected: builds and writes `src-tauri/src/remote/web_client.html`.

- [ ] **Step 8: Commit**

```bash
git add remote-web/src/app.tsx src-tauri/src/remote/web_client.html
git commit -m "feat(remote-web): Claude terminals open as chat on the phone"
```

---

### Task 13: Full build check

- [ ] **Step 1: Run every automated check**

```
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm test
npm --prefix remote-web run build
pnpm exec tsc --noEmit
```

Expected: all green. `pnpm test` runs the desktop vitest suite and the new `remote-web` test. Fix anything red before continuing.

- [ ] **Step 2: Commit any fixes**

`git commit -am "fix(remote): <what>"` if needed.

---

### Task 14: Docs — CHANGELOG and spec deltas

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-15-mobile-chat-view-design.md`

- [ ] **Step 1: CHANGELOG** (under `## [Unreleased]`)

```markdown
### Added
- The phone app now shows Claude Code terminals as a chat: your messages and Claude's
  replies wrap to the phone's width, tool calls collapse into one-line rows you can tap
  open, and you type in a normal text box with autocorrect and dictation. Permission
  prompts get buttons. Tap the terminal icon in the top bar to switch to the raw
  terminal at any time; the desktop terminal is unchanged and no longer letterboxes
  while the phone is in chat.

### Fixed
- Claude notifications (needs permission, finished) keep working after `/clear`.
```

- [ ] **Step 2: Spec deltas**

In the spec:
- change the `ChatMessage` model to `ts: String` (ISO-8601);
- replace the `toolResult` block with `result: Option<ToolResult>` on `toolUse`;
- in "Reading and tailing", replace "shrinks, or is replaced by a different file" with "shrinks";
- add `claudeHooks: bool` to `hello.ok` under "Protocol additions";
- Markdown is rendered with react-markdown (the desktop's library), not `marked`; links open in a new tab and images are not loaded;
- session tracking: the `SessionEnd` hook is added, and so is the routing rule. A terminal adopts a new id only from `SessionStart` with source `clear`, `compact` or `resume`, and only when it already has a session. Events for other session ids (nested `claude -p`) are dropped. The picker-form `--resume` therefore never gets the chat view. Hooks are upgraded in place with the existing install's command; WSL distros are upgraded on the next enable;
- Claude alive turns false on `SessionEnd`, on a non-Claude window title, or on OSC 133;D. This replaces "a shell prompt";
- initial load: rows are parsed one at a time from up to 3,000 trailing lines (16 MB cap), not shallowly; the transcript search repeats every 2 s until the file exists (`distro_home` is cached);
- `TermInfo.claude` is refreshed only on `hello.ok` / `term.created` (known limitation).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-10-15-mobile-chat-view-design.md
git commit -m "docs(remote): changelog and spec updates for the mobile chat view"
```

---

### Task 15: Manual verification on a real phone

Run the app (`pnpm tauri dev`), start Remote Access over Tailscale, and pair the phone. Check each item and note pass/fail in the final report.

- [ ] Desktop-created Claude terminal opens as chat; history appears.
- [ ] Phone-created Claude terminal (drawer → Claude) opens as chat, empty state, then fills after the first prompt.
- [ ] Single-line send submits; multi-line send arrives as one prompt.
- [ ] While working: "Claude is working…" row; Stop interrupts; one Esc only.
- [ ] Permission prompt: card shows the hook message; **1** allows; **Esc** rejects; **View in terminal** switches.
- [ ] Card is not dismissed by the spinner stopping; it is dismissed once the tool result arrives.
- [ ] `/clear` typed in the desktop TUI: the phone chat empties and follows the new session (hooks on).
- [ ] With hooks off: the banner shows.
- [ ] `/exit` in Claude, in a PowerShell terminal: the composer disables with "Claude isn't running".
- [ ] Ask Claude to run `claude -p "say hi"` through its Bash tool: the phone chat does **not** switch sessions.
- [ ] Parallel tools: when one tool finishes while another waits for permission, the card stays.
- [ ] A prompt answered on the desktop: reopening that chat on the phone shows no stale card.
- [ ] Reload the PWA (swipe it away and reopen) on a Claude terminal: it opens in chat, and the desktop doesn't letterbox.
- [ ] After a hooks upgrade, `~/.claude/settings.json` has `SessionStart`/`SessionEnd` entries using the **installed** app's command, not the dev build's.
- [ ] Chat ⇄ Terminal toggle both ways; the terminal view fits the phone and typing works.
- [ ] Desktop pane is not letterboxed while the phone shows chat; it letterboxes again in terminal view.
- [ ] Switch apps and come back: reconnects, chat reloads, working state is right.
- [ ] Shell terminals still open as terminals with the key row.
- [ ] WSL Claude terminal (if available): chat works; after `/clear` it re-points. This is also the Task 1 Step 5 check that `TW_TERMINAL_ID` crosses interop.
- [ ] Long assistant Markdown (lists, code fences) wraps and scrolls correctly; no raw HTML rendered.

---

## Phase 0 results

Run 2026-10-15 on Windows 10 (ConPTY, PowerShell shell), Claude Code 2.1.300, against `pnpm tauri dev` with `TW_REMOTE_AUTOSTART=8899` and an isolated `TW_DATA_DIR`. A node script paired once and kept one WebSocket for every case. It created the Claude terminal itself (`term.create` kind `claude`), attached, sent `term.resize` 120x40, and rendered the output frames in `@xterm/headless` to read the screen. Input was sent exactly as the composer will send it: `ESC[200~ … ESC[201~` in one `term.input`, then `\r` in a second `term.input` 100 ms later.

| Platform | Case | Result |
|---|---|---|
| Windows | single line (`What is 6 times 7?`) | pass: one prompt, submitted, replied `42` |
| Windows | multi-line (2 lines) | pass: one two-line prompt, not split on `\n`, submitted, replied |
| Windows | big paste (~6 KB, 3 lines) | pass: input shows `[Pasted text #2 +2 lines]`, then submits and replies. The echoed user message after submit shows the full expanded text. |
| Windows | big paste (~17 KB, 301 lines) | pass at 100 ms |
| Windows | permission digit `1` | pass: the digit alone picks the option, no Enter needed; the command ran |
| Windows | Esc while streaming | pass: `⎿ Interrupted · What should Claude do instead?`, input left empty |
| Windows | Esc before the first output token | interrupts, but see the surprises below |
| WSL (Ubuntu) | Claude cases | not tested: `claude` in WSL is not logged in (stops at onboarding/login) |
| WSL (Ubuntu) | byte path only | pass: `cat -v` under bash in `wsl.exe` inside the ConPTY receives `^[[200~hello⏎world^[[201~` intact, and the ESC+CR fallback arrives as `ESC`,`CR` |

- **Enter delay:** 100 ms works everywhere tested, including the 17 KB paste. No longer delay is needed.
- **Fallback:** not needed. Bracketed paste works under ConPTY, so Task 10's `promptSequences` keeps the bracketed form.
- **Step 5** (`TW_TERMINAL_ID` across WSL interop) is still deferred to Task 15.

Surprises that affect later tasks:

1. **Esc before the first output token puts the prompt back in the input box.** The submitted user message vanishes from the history and its text is restored into Claude's input. No "Interrupted" line appears. If the phone then sends another prompt, it is appended to the restored text. The composer should clear the input before pasting, or tell the user. `Ctrl+U` (`\x15`) cleared a one-line restored prompt; it was not tried on a multi-line one. Esc after output has started behaves normally.
2. **Claude Code 2.1.300's default permission mode is "auto mode".** A plain `claude` launch shows `⏵⏵ auto mode on` and handles most prompts itself. Prompts only appear in "manual mode" (shift+tab cycle: plan → bypass → auto → manual → accept edits). Read-only commands such as `echo` never prompt, even in manual mode; `mkdir` does. The prompt menu now has 4 options (`1. Yes`, `2. Yes, and don't ask again…`, `3. Yes, and switch to auto mode`, `4. No`), so don't hard-code the labels or the option count.
3. **This owner's settings have `claudeSkipPermissions: true`,** so every app-launched Claude starts with `--dangerously-skip-permissions` and never prompts. Switching mode inside a bypass session doesn't bring prompts back ("Session was started with bypass permissions…"). The permission case was tested by running `/exit` and then a plain `claude` in the same terminal.
4. **Transcript saving is off when the dev app is launched from inside a Claude Code session.** The PTY inherits `CLAUDE_CODE_CHILD_SESSION=1` and Claude prints `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`. Only a test-harness problem: a normal launch of the app doesn't have this variable. But every later manual check of the chat view (it reads the transcript) must launch the app with `CLAUDE_CODE_CHILD_SESSION` and the other `CLAUDE_CODE_*` variables removed from the environment, or the follower will find no transcript.
5. The phone's `term.resize` 120x40 held for the whole run, and the headless render stayed coherent. The desktop window was not inspected, so this says nothing about the desktop fighting for size.
