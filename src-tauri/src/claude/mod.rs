//! Claude Code session history: read the per-project session transcripts that
//! the `claude` CLI writes to `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, and
//! summarize them so the UI can list and resume past sessions.

pub mod hooks;
pub mod creds;
pub mod accounts;
pub mod oauth;
pub mod usage;

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    pub message_count: u32,
    /// File mtime, epoch millis. Newest sessions sort first.
    pub last_active: i64,
    pub git_branch: Option<String>,
}

/// Encode an absolute path the way Claude Code names its project dirs: every
/// character that isn't ASCII-alphanumeric becomes '-'. Existing '-' are kept.
pub fn encode_project_dir(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn sessions_dir(home: &Path, project_root: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(encode_project_dir(project_root))
}

/// Truncate to at most `max` chars (char-safe), appending '…' when shortened.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// A session id is used as a bare filename stem; reject anything that could
/// escape the sessions dir.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
        && !id.contains('\0')
}

/// Compare two filesystem paths for equality, tolerant of separator style,
/// trailing slashes, and (for Windows) case.
fn paths_equal(a: &str, b: &str) -> bool {
    fn norm(p: &str) -> String {
        p.replace('\\', "/").trim_end_matches('/').to_lowercase()
    }
    norm(a) == norm(b)
}

/// One transcript line, parsed shallowly: every field we need is a small scalar,
/// and `message` is kept as a raw slice so a multi-megabyte assistant body is
/// never materialized into a `Value` tree (only the first user message is).
#[derive(Deserialize)]
struct Row<'a> {
    #[serde(rename = "type", default)]
    ty: Option<String>,
    #[serde(rename = "aiTitle", default)]
    ai_title: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(rename = "gitBranch", default)]
    git_branch: Option<String>,
    #[serde(borrow, default)]
    message: Option<&'a RawValue>,
}

/// Pull the first text out of a `message` object (content is either a string or
/// an array of content blocks).
fn extract_user_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        arr.iter().find_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        })?
    } else {
        return None;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate(trimmed, 80))
}

struct Parsed {
    title: String,
    message_count: u32,
    git_branch: Option<String>,
    /// false only when a `cwd` line was seen AND it differs from the project root.
    cwd_ok: bool,
}

/// Parse the JSONL body of one session file. `session_id` is the filename stem,
/// used as the last-resort title.
fn parse_content(content: &str, session_id: &str, project_root: &str) -> Parsed {
    let mut ai_title: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut message_count: u32 = 0;
    let mut git_branch: Option<String> = None;
    let mut saw_cwd = false;
    let mut cwd_ok = true;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Row>(line) else {
            continue;
        };
        match row.ty.as_deref() {
            Some("ai-title") => {
                if let Some(t) = row.ai_title {
                    ai_title = Some(t); // keep the latest
                }
            }
            Some("user") => {
                message_count += 1;
                if first_user.is_none() {
                    if let Some(raw) = row.message {
                        if let Ok(msg) = serde_json::from_str::<Value>(raw.get()) {
                            first_user = extract_user_text(&msg);
                        }
                    }
                }
            }
            Some("assistant") => {
                message_count += 1;
            }
            _ => {}
        }
        if !saw_cwd {
            if let Some(c) = row.cwd {
                saw_cwd = true;
                cwd_ok = paths_equal(&c, project_root);
            }
        }
        if git_branch.is_none() {
            if let Some(b) = row.git_branch {
                if !b.is_empty() {
                    git_branch = Some(b);
                }
            }
        }
    }

    let title = ai_title
        .or(first_user)
        .unwrap_or_else(|| session_id.chars().take(8).collect());

    Parsed {
        title,
        message_count,
        git_branch,
        cwd_ok,
    }
}

fn parse_session(path: &Path, session_id: &str, project_root: &str) -> Option<SessionSummary> {
    let content = fs::read_to_string(path).ok()?;
    let parsed = parse_content(&content, session_id, project_root);
    if !parsed.cwd_ok {
        return None;
    }
    let last_active = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(SessionSummary {
        session_id: session_id.to_string(),
        title: parsed.title,
        message_count: parsed.message_count,
        last_active,
        git_branch: parsed.git_branch,
    })
}

/// List every Claude session for a project root, newest first. Returns an empty
/// vec when the project's session dir does not exist.
pub fn list_sessions(home: &Path, project_root: &str) -> Vec<SessionSummary> {
    let dir = sessions_dir(home, project_root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Some(summary) = parse_session(&path, stem, project_root) {
            out.push(summary);
        }
    }
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out
}

/// Delete one session transcript. Validates the id can't escape the sessions dir.
pub fn delete_session(home: &Path, project_root: &str, session_id: &str) -> AppResult<()> {
    if !valid_session_id(session_id) {
        return Err(AppError::Msg("invalid session id".to_string()));
    }
    let dir = sessions_dir(home, project_root);
    let file = dir.join(format!("{session_id}.jsonl"));
    // Defense in depth: the resolved file must sit directly inside the dir.
    if file.parent() != Some(dir.as_path()) {
        return Err(AppError::Msg("invalid session path".to_string()));
    }
    fs::remove_file(&file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_windows_path_like_claude() {
        assert_eq!(
            encode_project_dir(r"C:\Users\Patrick Ackom\Desktop\repos\tw\terminal-workspace-rust"),
            "C--Users-Patrick-Ackom-Desktop-repos-tw-terminal-workspace-rust"
        );
    }

    #[test]
    fn prefers_ai_title_then_counts_messages() {
        let root = r"C:\proj";
        let content = concat!(
            r#"{"type":"user","message":{"content":"first prompt"},"cwd":"C:\\proj","gitBranch":"main"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Old Title"}"#,
            "\n",
            r#"{"type":"ai-title","aiTitle":"Newest Title"}"#,
            "\n",
        );
        let p = parse_content(content, "abc12345", root);
        assert_eq!(p.title, "Newest Title");
        assert_eq!(p.message_count, 2);
        assert_eq!(p.git_branch.as_deref(), Some("main"));
        assert!(p.cwd_ok);
    }

    #[test]
    fn falls_back_to_first_user_text_then_id() {
        let root = "/proj";
        let with_user = r#"{"type":"user","message":{"content":[{"type":"text","text":"hello there"}]},"cwd":"/proj"}"#;
        assert_eq!(parse_content(with_user, "deadbeef", root).title, "hello there");

        let empty = r#"{"type":"system","subtype":"init"}"#;
        assert_eq!(parse_content(empty, "deadbeef", root).title, "deadbeef");
    }

    #[test]
    fn skips_malformed_lines() {
        let root = "/proj";
        let content = concat!(
            "not json at all\n",
            r#"{"type":"user","message":{"content":"ok"},"cwd":"/proj"}"#,
            "\n",
        );
        let p = parse_content(content, "id", root);
        assert_eq!(p.message_count, 1);
        assert_eq!(p.title, "ok");
    }

    #[test]
    fn cwd_mismatch_marks_not_ok() {
        let p = parse_content(
            r#"{"type":"user","message":{"content":"x"},"cwd":"/other/project"}"#,
            "id",
            "/proj",
        );
        assert!(!p.cwd_ok);

        // No cwd line at all -> treated as ok (can't prove otherwise).
        let p2 = parse_content(r#"{"type":"user","message":{"content":"x"}}"#, "id", "/proj");
        assert!(p2.cwd_ok);
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(valid_session_id("2b5c191b-945b-418d"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("../escape"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id(r"a\b"));
    }

    #[test]
    fn truncates_long_titles() {
        let long = "x".repeat(200);
        let t = truncate(&long, 80);
        assert_eq!(t.chars().count(), 81); // 80 + ellipsis
        assert!(t.ends_with('…'));
    }
}
