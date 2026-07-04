//! The ONLY surface remote sessions can reach into the core through. Every
//! capability is an explicit function here — there is deliberately no generic
//! "invoke any command" passthrough, and no filesystem or project-management
//! access (R3.7 / AC-3.10).

use crate::claude::SessionSummary;
use crate::git::discover::RepoInfo;
use crate::git::{FileDiff, GitInfo};
use crate::pty::{shell, CreateOpts, PtyManager};
use crate::settings::SettingsStore;
use crate::state::{StateStore, TerminalRecord};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use super::protocol::{ProjectInfo, StateSnapshot, TermInfo};

/// Snapshot of projects + their terminals (with live-PTY flags) for `hello.ok`.
pub fn state_snapshot(app: &AppHandle) -> StateSnapshot {
    let store = app.state::<StateStore>();
    let pty = app.state::<PtyManager>();
    let state = store.snapshot();
    let projects = state
        .projects
        .into_iter()
        .map(|p| ProjectInfo {
            id: p.id.clone(),
            name: p.name,
            color: p.color,
            terminals: p
                .terminals
                .into_iter()
                .map(|t| TermInfo {
                    live: pty.has(&t.id),
                    id: t.id,
                    name: t.name,
                    project_id: p.id.clone(),
                })
                .collect(),
        })
        .collect();
    StateSnapshot { projects }
}

/// Whether Claude Code should launch with `--dangerously-skip-permissions`
/// (the Phase 1 global setting, read from the opaque settings blob).
fn claude_skip_permissions(app: &AppHandle) -> bool {
    app.state::<SettingsStore>()
        .get()
        .and_then(|v| v.get("terminal")?.get("claudeSkipPermissions")?.as_bool())
        .unwrap_or(false)
}

/// Emitted so the desktop UI shows terminals a remote client created/resumed,
/// without waiting for a state reload (AC-3.5).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalAdded {
    project_id: String,
    terminal: TerminalRecord,
}

/// Build the Claude launch command, appending the Phase 1 skip-permissions flag
/// when enabled (AC-3.2). `resume_id` produces a `--resume <id>` launch.
fn claude_command(app: &AppHandle, resume_id: Option<&str>) -> String {
    let mut cmd = String::from("claude");
    if let Some(id) = resume_id {
        cmd.push_str(" --resume ");
        cmd.push_str(id);
    }
    if claude_skip_permissions(app) {
        cmd.push_str(" --dangerously-skip-permissions");
    }
    cmd
}

/// Core terminal spawn: create the PTY, persist the record, and notify the
/// desktop. Shared by shell/claude create and Claude resume.
fn spawn_terminal(
    app: &AppHandle,
    project_id: &str,
    name: String,
    full_cwd: String,
    startup_command: Option<String>,
) -> Result<TermInfo, String> {
    let store = app.state::<StateStore>();
    let pty = app.state::<PtyManager>();
    let id = Uuid::new_v4().to_string();
    let shell = shell::default_shell();

    pty.create(
        app,
        CreateOpts {
            id: id.clone(),
            cwd: full_cwd,
            shell: Some(shell.clone()),
            cols: 80,
            rows: 24,
            startup_command,
            env: app.state::<crate::apikeys::ApiKeyStore>().resolved_env(),
        },
    )
    .map_err(|e| e.to_string())?;

    let record = TerminalRecord {
        id: id.clone(),
        name: name.clone(),
        shell,
    };
    store.upsert_terminal(project_id, record.clone());
    let _ = app.emit(
        "remote:terminal-added",
        TerminalAdded {
            project_id: project_id.to_string(),
            terminal: record,
        },
    );

    Ok(TermInfo {
        id,
        name,
        project_id: project_id.to_string(),
        live: true,
    })
}

/// Absolute cwd from a project + optional relative subdir.
fn resolve_cwd(app: &AppHandle, project_id: &str, cwd: Option<&str>) -> Result<String, String> {
    let root = app
        .state::<StateStore>()
        .project_path(project_id)
        .ok_or_else(|| "project not found".to_string())?;
    Ok(match cwd.map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => Path::new(&root).join(rel).to_string_lossy().to_string(),
        None => root,
    })
}

/// Spawn a terminal in a project. `kind` is "shell" or "claude". Honors the
/// Phase 1 skip-permissions setting for Claude launches (AC-3.2). Returns the
/// created terminal's metadata.
pub fn create_terminal(
    app: &AppHandle,
    project_id: &str,
    kind: &str,
    cwd: Option<&str>,
) -> Result<TermInfo, String> {
    let full_cwd = resolve_cwd(app, project_id, cwd)?;
    let (name, startup_command) = if kind == "claude" {
        ("Claude Code".to_string(), Some(claude_command(app, None)))
    } else {
        let n = app.state::<StateStore>().terminal_count(project_id) + 1;
        (format!("Terminal {n}"), None)
    };
    spawn_terminal(app, project_id, name, full_cwd, startup_command)
}

/// Claude session list for a project (read from ~/.claude transcripts).
pub fn claude_sessions(app: &AppHandle, project_id: &str) -> Vec<SessionSummary> {
    let Some(root) = app.state::<StateStore>().project_path(project_id) else {
        return Vec::new();
    };
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    crate::claude::list_sessions(&home, &root)
}

/// Spawn a `claude --resume <id>` terminal (AC-3.5). Rejects invalid ids that
/// could escape the sessions dir.
pub fn resume_session(
    app: &AppHandle,
    project_id: &str,
    session_id: &str,
) -> Result<TermInfo, String> {
    if !crate::claude::valid_session_id(session_id) {
        return Err("invalid session id".to_string());
    }
    let full_cwd = resolve_cwd(app, project_id, None)?;
    let startup_command = Some(claude_command(app, Some(session_id)));
    spawn_terminal(
        app,
        project_id,
        "Claude Code".to_string(),
        full_cwd,
        startup_command,
    )
}

/// Kill a terminal's PTY and drop its record.
pub fn close_terminal(app: &AppHandle, terminal_id: &str) {
    let store = app.state::<StateStore>();
    app.state::<PtyManager>().kill(terminal_id);
    if let Some(project_id) = project_of_terminal(&store, terminal_id) {
        store.remove_terminal(&project_id, terminal_id);
    }
}

// ---- git (reuses Phase 2's repo cache + the existing git functions) ----

/// Discovered repos for a project (cached, discovering on first use).
pub fn git_repos(app: &AppHandle, project_id: &str) -> Vec<RepoInfo> {
    let store = app.state::<StateStore>();
    let cached = store.get_repos(project_id);
    if !cached.is_empty() {
        return cached;
    }
    match store.project_path(project_id) {
        Some(root) => {
            let repos = crate::git::discover::discover_repos(project_id, Path::new(&root)).repos;
            store.set_repos(project_id, repos.clone());
            repos
        }
        None => Vec::new(),
    }
}

pub fn git_status(app: &AppHandle, repo_id: &str) -> Option<GitInfo> {
    let path = app.state::<StateStore>().repo_path(repo_id)?;
    Some(crate::git::get_info(Path::new(&path)))
}

pub fn git_diff(app: &AppHandle, repo_id: &str) -> Result<Vec<FileDiff>, String> {
    let path = app
        .state::<StateStore>()
        .repo_path(repo_id)
        .ok_or_else(|| "repo not found".to_string())?;
    crate::git::diff(Path::new(&path))
}

/// Push the repo's current branch (upstream set on first push, matching desktop).
pub fn git_push(app: &AppHandle, repo_id: &str) -> (bool, String) {
    let Some(path) = app.state::<StateStore>().repo_path(repo_id) else {
        return (false, "repo not found".to_string());
    };
    let info = crate::git::get_info(Path::new(&path));
    let Some(branch) = info.branch else {
        return (false, "no branch to push".to_string());
    };
    crate::git::push(Path::new(&path), &branch)
}

fn project_of_terminal(store: &StateStore, terminal_id: &str) -> Option<String> {
    store
        .snapshot()
        .projects
        .into_iter()
        .find(|p| p.terminals.iter().any(|t| t.id == terminal_id))
        .map(|p| p.id)
}
