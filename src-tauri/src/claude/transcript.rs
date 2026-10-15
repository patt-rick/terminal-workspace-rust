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
        // A repeated row uuid replaces its message: ids stay unique for upserts.
        if let Some(&i) = self.by_id.get(&id) {
            self.msgs[i] = msg;
        } else {
            self.by_id.insert(id.clone(), self.msgs.len());
            self.msgs.push(msg);
        }
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
        newlines += piece.iter().filter(|&&b| b == b'\n').count();
        pieces.push(piece);
    }
    let buf: Vec<u8> = pieces.into_iter().rev().flatten().collect();
    // Skip a leading partial line (unless at file start) and any trailing line
    // still being written.
    let head = if start == 0 {
        0
    } else {
        buf.iter().position(|&b| b == b'\n').map_or(buf.len(), |i| i + 1)
    };
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut t = Transcript::default();
    if head < end {
        for line in buf[head..end].split(|&b| b == b'\n') {
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
    fn duplicate_row_uuid_replaces_in_place() {
        let mut t = Transcript::default();
        let changed = feed(&mut t, &[
            r#"{"type":"user","uuid":"u1","message":{"content":"first"}}"#,
            r#"{"type":"user","uuid":"u2","message":{"content":"other"}}"#,
            r#"{"type":"user","uuid":"u1","message":{"content":"again"}}"#,
        ]);
        assert_eq!(changed, vec!["u1".to_string(), "u2".to_string(), "u1".to_string()]);
        let h = t.history();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].id, "u1");
        assert_eq!(h[0].blocks, vec![ChatBlock::Text { text: "again".into() }]);
        assert_eq!(t.get(&["u1".to_string()]).len(), 1);
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
