# Claude Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse a project's past Claude Code sessions in a right-sidebar tab and resume any of them in a new terminal, even after the original terminal was closed.

**Architecture:** A new Rust `claude` module scans `~/.claude/projects/<encoded-cwd>/*.jsonl`, parses a lightweight summary per session, filters by the project's cwd, and exposes two Tauri commands. The frontend adds a "Sessions" tab that lists summaries and resumes via the existing terminal-creation path (`claude --resume <id>`). Every Claude terminal the app launches carries a known session id (resumed id, or a generated one via `claude --session-id <uuid>`) so live sessions can be marked "open" and focused instead of double-resumed.

**Tech Stack:** Rust (Tauri 2, serde_json, std::fs), React 19 + Zustand, TypeScript.

---

## Reference facts (verified during design)

- Session store: `~/.claude/projects/<encoded>/<session-uuid>.jsonl`, one JSONL file per session. The dir name is the absolute cwd with **every non-alphanumeric char replaced by `-`** (e.g. `C:\Users\Patrick Ackom\Desktop\repos\tw\terminal-workspace-rust` → `C--Users-Patrick-Ackom-Desktop-repos-tw-terminal-workspace-rust`).
- JSONL line types include `ai-title` (`{"type":"ai-title","aiTitle":"...","sessionId":"..."}`), `user` and `assistant` (counted as messages), and lines carrying `cwd` / `gitBranch`. `user` message text is at `message.content` (a string, or an array of blocks where the first `{"type":"text","text":...}` is the prompt).
- `claude` CLI (v2.1.x) supports `--resume <id>`, `--continue`/`-c`, and `--session-id <uuid>`.
- `app.path().home_dir()` (Tauri `Manager` trait) resolves `~` cross-platform — no new crate needed.

## File structure

**Rust**
- `src-tauri/src/claude/mod.rs` *(new)* — `SessionSummary`, `encode_project_dir`, `parse_content`, `list_sessions`, `delete_session`, `valid_session_id`, `truncate`, unit tests.
- `src-tauri/src/lib.rs` *(modify)* — `mod claude;` + register two commands.
- `src-tauri/src/commands.rs` *(modify)* — `claude_sessions_list`, `claude_session_delete`.

**Frontend**
- `src/lib/ipc.ts` *(modify)* — `ClaudeSession` type + `claude` namespace.
- `src/state/store.ts` *(modify)* — `sessionIdByTerminal` map + `setTerminalSession`, cleanup, `linkClaudeSession`, `createProjectTerminal` linking.
- `src/components/right-sidebar/sessions-panel.tsx` *(new)* — the panel.
- `src/components/right-sidebar/right-sidebar.tsx` *(modify)* — fourth tab.

> Note: `app.tsx`'s "✳ Claude Code" button needs **no change** — it already passes `startupCommand: 'claude'`, and `linkClaudeSession` (Task 4) transparently injects a `--session-id` for any bare `claude` command.

---

## Task 1: Rust `claude` module — pure helpers + parsing (TDD)

**Files:**
- Create: `src-tauri/src/claude/mod.rs`
- Test: same file (`#[cfg(test)] mod tests`, run with `cargo test`)

- [ ] **Step 1: Write the module with failing tests**

Create `src-tauri/src/claude/mod.rs`:

```rust
//! Claude Code session history: read the per-project session transcripts that
//! the `claude` CLI writes to `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, and
//! summarize them so the UI can list and resume past sessions.

use crate::error::{AppError, AppResult};
use serde::Serialize;
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

fn extract_user_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
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
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    ai_title = Some(t.to_string()); // keep the latest
                }
            }
            Some("user") => {
                message_count += 1;
                if first_user.is_none() {
                    first_user = extract_user_text(&v);
                }
            }
            Some("assistant") => {
                message_count += 1;
            }
            _ => {}
        }
        if !saw_cwd {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                saw_cwd = true;
                cwd_ok = paths_equal(c, project_root);
            }
        }
        if git_branch.is_none() {
            if let Some(b) = v.get("gitBranch").and_then(|b| b.as_str()) {
                if !b.is_empty() {
                    git_branch = Some(b.to_string());
                }
            }
        }
    }

    let title = ai_title
        .or(first_user)
        .unwrap_or_else(|| session_id.chars().take(8).collect());

    Parsed { title, message_count, git_branch, cwd_ok }
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
            r#"{"type":"user","message":{"content":"first prompt"},"cwd":"C:\\proj","gitBranch":"main"}"#, "\n",
            r#"{"type":"assistant","message":{"content":"hi"}}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"Old Title"}"#, "\n",
            r#"{"type":"ai-title","aiTitle":"Newest Title"}"#, "\n",
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
            r#"{"type":"user","message":{"content":"ok"},"cwd":"/proj"}"#, "\n",
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
```

- [ ] **Step 2: Register the module so it compiles**

In `src-tauri/src/lib.rs`, add `mod claude;` to the module list (alphabetical, before `mod commands;` is fine):

```rust
mod claude;
mod commands;
mod error;
```

- [ ] **Step 3: Run the tests, expect them to pass**

Run: `cd src-tauri && cargo test claude::`
Expected: all 7 tests in `claude::tests` pass. (If the MSVC env is broken, use `& "src-tauri/build-msvc.cmd"` per the README, or `cargo test --lib claude::`.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/claude/mod.rs src-tauri/src/lib.rs
git commit -m "feat(claude): session summary parsing + helpers"
```

---

## Task 2: Tauri commands for list + delete

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `Manager` to the tauri import in commands.rs**

In `src-tauri/src/commands.rs`, change:

```rust
use tauri::{AppHandle, State};
```
to:
```rust
use tauri::{AppHandle, Manager, State};
```

- [ ] **Step 2: Add the two commands**

Append to `src-tauri/src/commands.rs`, after the `// ---------- github ----------` section and before `// ---------- helpers ----------`:

```rust
// ---------- claude sessions ----------

fn home_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    app.path()
        .home_dir()
        .map_err(|e| AppError::Msg(e.to_string()))
}

#[tauri::command]
pub fn claude_sessions_list(
    app: AppHandle,
    store: State<StateStore>,
    project_id: String,
) -> AppResult<Vec<crate::claude::SessionSummary>> {
    let root = project_root(&store, &project_id)?;
    let home = home_dir(&app)?;
    Ok(crate::claude::list_sessions(&home, &root))
}

#[tauri::command]
pub fn claude_session_delete(
    app: AppHandle,
    store: State<StateStore>,
    project_id: String,
    session_id: String,
) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    let home = home_dir(&app)?;
    crate::claude::delete_session(&home, &root, &session_id)
}
```

- [ ] **Step 3: Register the commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]`, add after the github commands (before the closing `]`):

```rust
            commands::github_dispatch_workflow,
            commands::claude_sessions_list,
            commands::claude_session_delete,
        ])
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check`
Expected: builds with no errors. (`SessionSummary` is `Serialize`, so it returns over IPC cleanly.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(claude): list + delete session tauri commands"
```

---

## Task 3: Frontend IPC types + namespace

**Files:**
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Add the `ClaudeSession` type**

In `src/lib/ipc.ts`, after the `CreatePullRequestInput` interface (just before the `isTauri` const), add:

```ts
export interface ClaudeSession {
  sessionId: string
  title: string
  messageCount: number
  /** epoch millis (file mtime) */
  lastActive: number
  gitBranch: string | null
}
```

- [ ] **Step 2: Add the `claude` namespace to the `ipc` object**

In the same file, inside the `ipc` object, after the `github: { ... },` block (before the closing `}` of `ipc`), add:

```ts
  claude: {
    listSessions: (projectId: string) =>
      invoke<ClaudeSession[]>('claude_sessions_list', { projectId }),
    deleteSession: (projectId: string, sessionId: string) =>
      invoke<void>('claude_session_delete', { projectId, sessionId }),
  },
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(claude): ipc types + namespace for sessions"
```

---

## Task 4: Store — session-id linking + cleanup

**Files:**
- Modify: `src/state/store.ts`

- [ ] **Step 1: Add `sessionIdByTerminal` to the state interface**

In `src/state/store.ts`, inside `interface WorkspaceState`, add after `busyByTerminal: Record<string, boolean>`:

```ts
  sessionIdByTerminal: Record<string, string>
```

And add the setter declaration near `setTerminalBusy`:

```ts
  setTerminalSession: (terminalId: string, sessionId: string) => void
```

- [ ] **Step 2: Initialize and implement the setter**

In the `create<WorkspaceState>((set) => ({ ... }))` body, add the initial value after `busyByTerminal: {},`:

```ts
  sessionIdByTerminal: {},
```

Add the setter implementation after `setTerminalBusy`:

```ts
  setTerminalSession: (terminalId, sessionId) =>
    set((state) => ({
      sessionIdByTerminal: { ...state.sessionIdByTerminal, [terminalId]: sessionId },
    })),
```

- [ ] **Step 3: Drop the mapping on terminal removal**

In `removeTerminalLocal`, alongside the existing destructured cleanups (`unreadRest`, `titleRest`, `busyRest`), add a session cleanup. Change the block that reads:

```ts
      const { [terminalId]: _b, ...busyRest } = state.busyByTerminal
```
to:
```ts
      const { [terminalId]: _b, ...busyRest } = state.busyByTerminal
      const { [terminalId]: _s, ...sessionRest } = state.sessionIdByTerminal
```

and add to that `set`'s returned object (next to `busyByTerminal: busyRest,`):

```ts
        sessionIdByTerminal: sessionRest,
```

- [ ] **Step 4: Add `linkClaudeSession` and wire `createProjectTerminal`**

At the bottom of `src/state/store.ts`, replace the existing `createProjectTerminal` function with this version, and add `linkClaudeSession` above it:

```ts
/**
 * If `command` is a bare `claude` invocation with no resume/continue/session-id
 * flag, append `--session-id <uuid>` and return that id so the app can track
 * which session the terminal is running. Otherwise returns the command unchanged.
 */
export function linkClaudeSession(command: string): {
  startupCommand: string
  sessionId?: string
} {
  const trimmed = command.trim()
  if (!/^claude(\s|$)/.test(trimmed)) return { startupCommand: command }
  if (/(^|\s)(--resume|-r|--continue|-c|--session-id)(\s|=|$)/.test(trimmed)) {
    return { startupCommand: command }
  }
  const sessionId = crypto.randomUUID()
  return { startupCommand: `${trimmed} --session-id ${sessionId}`, sessionId }
}

/** Create a terminal for a project, applying the configured startup command. */
export async function createProjectTerminal(
  projectId: string,
  opts?: { cwd?: string; name?: string; startupCommand?: string; claudeSessionId?: string }
): Promise<TerminalRecord | null> {
  let startupCommand =
    opts?.startupCommand ?? (useSettings.getState().terminal.startupCommand.trim() || undefined)
  let claudeSessionId = opts?.claudeSessionId
  // Fresh `claude` launches get a generated session id so they show as "open"
  // in the Sessions panel. Resume launches already carry an explicit id.
  if (startupCommand && !claudeSessionId) {
    const linked = linkClaudeSession(startupCommand)
    startupCommand = linked.startupCommand
    claudeSessionId = linked.sessionId
  }
  const record = await ipc.terminals.create({
    projectId,
    startupCommand,
    cwd: opts?.cwd,
    name: opts?.name,
  })
  if (record) {
    useWorkspace.getState().addTerminal(projectId, record)
    if (claudeSessionId) useWorkspace.getState().setTerminalSession(record.id, claudeSessionId)
  }
  return record
}
```

- [ ] **Step 5: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/state/store.ts
git commit -m "feat(claude): track session ids per terminal + auto-link fresh claude launches"
```

---

## Task 5: Sessions panel component

**Files:**
- Create: `src/components/right-sidebar/sessions-panel.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/right-sidebar/sessions-panel.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { ipc, type ClaudeSession } from '../../lib/ipc'
import {
  createProjectTerminal,
  useWorkspace,
} from '../../state/store'
import { ContextMenu, type MenuItem } from '../context-menu'
import { ConfirmDialog } from '../confirm-dialog'

const timeAgo = (ms: number): string => {
  if (!ms) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function SessionsPanel({ projectId }: { projectId: string }) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; session: ClaudeSession } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ClaudeSession | null>(null)

  const project = useWorkspace((s) => s.projects.find((p) => p.id === projectId))
  const sessionIdByTerminal = useWorkspace((s) => s.sessionIdByTerminal)
  const setActiveTerminal = useWorkspace((s) => s.setActiveTerminal)

  // sessionId -> terminalId for terminals open in THIS project.
  const openBySession = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of project?.terminals ?? []) {
      const sid = sessionIdByTerminal[t.id]
      if (sid) m[sid] = t.id
    }
    return m
  }, [project, sessionIdByTerminal])

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    ipc.claude
      .listSessions(projectId)
      .then(setSessions)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(refresh, [refresh])

  // A finished session's title/count may have changed; refresh when a terminal exits.
  useEffect(() => {
    let un: UnlistenFn | undefined
    void ipc.terminals.onExit(() => refresh()).then((f) => {
      un = f
    })
    return () => un?.()
  }, [refresh])

  const onOpen = (s: ClaudeSession): void => {
    const openId = openBySession[s.sessionId]
    if (openId) {
      setActiveTerminal(projectId, openId)
      return
    }
    void createProjectTerminal(projectId, {
      name: s.title.slice(0, 40) || 'Claude',
      startupCommand: `claude --resume ${s.sessionId}`,
      claudeSessionId: s.sessionId,
    })
  }

  const onDelete = async (s: ClaudeSession): Promise<void> => {
    try {
      await ipc.claude.deleteSession(projectId, s.sessionId)
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  if (loading) return <Hint>Loading sessions…</Hint>
  if (error) {
    return (
      <div className="px-3 py-3 text-xs text-muted">
        {error}
        <button type="button" onClick={refresh} className="ml-2 text-link hover:underline">
          Retry
        </button>
      </div>
    )
  }
  if (sessions.length === 0) return <Hint>No Claude sessions yet for this project.</Hint>

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 flex-shrink-0 items-center px-3 text-xs text-muted">
        <span>{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
        <div className="flex-1" />
        <button type="button" onClick={refresh} className="hover:text-foreground">
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {sessions.map((s) => {
          const open = !!openBySession[s.sessionId]
          return (
            <div
              key={s.sessionId}
              onClick={() => onOpen(s)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, session: s })
              }}
              className="cursor-pointer rounded-md px-2 py-1.5 hover:bg-foreground/5"
            >
              <div className="flex items-center gap-1.5 text-sm">
                {open && <span className="text-success" title="Open in a terminal">●</span>}
                <span className="truncate text-foreground/90">{s.title}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">
                {timeAgo(s.lastActive)} · {s.messageCount} msg
                {s.gitBranch ? ` · ${s.gitBranch}` : ''}
                {open ? ' · open' : ''}
              </div>
            </div>
          )
        })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            [
              {
                label: openBySession[menu.session.sessionId] ? 'Focus terminal' : 'Resume session',
                onClick: () => onOpen(menu.session),
              },
              {
                label: 'Delete session',
                danger: true,
                separatorBefore: true,
                onClick: () => setPendingDelete(menu.session),
              },
            ] satisfies MenuItem[]
          }
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete session?"
        message={
          <>
            Permanently delete{' '}
            <span className="font-medium text-foreground/90">{pendingDelete?.title}</span>? This
            removes its transcript from disk and cannot be undone.
          </>
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) void onDelete(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-3 text-xs text-muted">{children}</div>
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm typecheck`
Expected: no errors. (Note: `crypto.randomUUID` is used only in the store; the panel relies on it indirectly via resume passing an explicit id.)

- [ ] **Step 3: Commit**

```bash
git add src/components/right-sidebar/sessions-panel.tsx
git commit -m "feat(claude): sessions panel (list, resume, focus, delete)"
```

---

## Task 6: Wire the Sessions tab into the right sidebar

**Files:**
- Modify: `src/components/right-sidebar/right-sidebar.tsx`

- [ ] **Step 1: Import the panel and extend the tab union**

In `src/components/right-sidebar/right-sidebar.tsx`:

Add the import after the `GithubPanel` import:

```tsx
import { SessionsPanel } from './sessions-panel'
```

Change the `Tab` type:

```tsx
type Tab = 'files' | 'git' | 'github' | 'sessions'
```

- [ ] **Step 2: Add the tab button and panel body**

Add a `TabButton` after the GitHub one (inside the tab bar `div`):

```tsx
        <TabButton active={tab === 'github'} onClick={() => setTab('github')}>
          GitHub
        </TabButton>
        <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
          Sessions
        </TabButton>
```

Add the panel body after the github line:

```tsx
        {tab === 'github' && <GithubPanel projectId={projectId} />}
        {tab === 'sessions' && <SessionsPanel projectId={projectId} />}
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/right-sidebar/right-sidebar.tsx
git commit -m "feat(claude): add Sessions tab to the right sidebar"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rust tests + check**

Run: `cd src-tauri && cargo test`
Expected: all tests pass, including the 7 `claude::tests`.

- [ ] **Step 2: Frontend build**

Run: `pnpm build`
Expected: `tsc --noEmit` clean + Vite build succeeds.

- [ ] **Step 3: Manual smoke test (record results)**

Run `pnpm tauri dev`. With a project that has Claude history:
1. Open the right sidebar → **Sessions** tab. Confirm sessions list, newest first, with titles, "Xm ago", and msg counts.
2. Click a session → a new terminal opens running `claude --resume <id>` and the conversation resumes.
3. The resumed session row now shows a green ● and "open"; clicking it again **focuses** that terminal instead of opening a second one.
4. Click the empty-state "✳ Claude Code" button → after Claude starts, its session appears in the list marked open (verifies `--session-id` linking).
5. Right-click a session → Delete → confirm → row disappears and the `.jsonl` is gone from `~/.claude/projects/<encoded>/`.

- [ ] **Step 4: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "test(claude): verify session history end-to-end"
```

---

## Self-review

**Spec coverage**
- Read Claude's own session files → Task 1 (`list_sessions`, encoding) + Task 2 (commands). ✓
- Right-sidebar "Sessions" tab → Task 6. ✓
- Resume in a new terminal + dedup/focus when open → Task 4 (`createProjectTerminal`, `linkClaudeSession`) + Task 5 (`onOpen`, `openBySession`). ✓
- Title (ai-title → first-user → id), last-active, message count → Task 1 (`parse_content`) shown in Task 5. ✓
- "Currently open" indicator → Task 4 (`sessionIdByTerminal`) + Task 5 (green ●). ✓
- Delete a session → Task 1 (`delete_session` + `valid_session_id`) + Task 2 + Task 5 (ConfirmDialog). ✓
- cwd filtering / subdirectory limitation → Task 1 (`paths_equal`, `cwd_ok`). ✓
- Refresh on open / manual / terminal exit → Task 5 (`useEffect` + `onExit`). ✓
- No search box (deferred) → correctly omitted. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `SessionSummary` (Rust, camelCase serialize) ↔ `ClaudeSession` (TS) fields match: `sessionId`, `title`, `messageCount`, `lastActive`, `gitBranch`. `createProjectTerminal` opts `claudeSessionId` used consistently in Tasks 4 & 5. `setTerminalSession`, `sessionIdByTerminal` names consistent across Tasks 4 & 5. `linkClaudeSession` return shape (`startupCommand`, `sessionId?`) consistent. ✓
