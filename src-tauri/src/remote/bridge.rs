//! The ONLY surface remote sessions can reach into the core through. Every
//! capability is an explicit function here — there is deliberately no generic
//! "invoke any command" passthrough, and no filesystem or project-management
//! access (R3.7 / AC-3.10).

use crate::pty::{shell, CreateOpts, PtyManager};
use crate::settings::SettingsStore;
use crate::state::{StateStore, TerminalRecord};
use tauri::{AppHandle, Manager};
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

/// Spawn a terminal in a project. `kind` is "shell" or "claude". Honors the
/// Phase 1 skip-permissions setting for Claude launches (AC-3.2). Returns the
/// created terminal's metadata.
pub fn create_terminal(
    app: &AppHandle,
    project_id: &str,
    kind: &str,
    cwd: Option<&str>,
) -> Result<TermInfo, String> {
    let store = app.state::<StateStore>();
    let pty = app.state::<PtyManager>();

    let root = store
        .project_path(project_id)
        .ok_or_else(|| "project not found".to_string())?;
    let full_cwd = match cwd.map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => std::path::Path::new(&root).join(rel).to_string_lossy().to_string(),
        None => root,
    };

    let startup_command = if kind == "claude" {
        let mut cmd = String::from("claude");
        if claude_skip_permissions(app) {
            cmd.push_str(" --dangerously-skip-permissions");
        }
        Some(cmd)
    } else {
        None
    };

    let id = Uuid::new_v4().to_string();
    let shell = shell::default_shell();
    let name = if kind == "claude" {
        "Claude Code".to_string()
    } else {
        format!("Terminal {}", store.terminal_count(project_id) + 1)
    };

    pty.create(
        app,
        CreateOpts {
            id: id.clone(),
            cwd: full_cwd,
            shell: Some(shell.clone()),
            cols: 80,
            rows: 24,
            startup_command,
        },
    )
    .map_err(|e| e.to_string())?;

    store.upsert_terminal(
        project_id,
        TerminalRecord {
            id: id.clone(),
            name: name.clone(),
            shell,
        },
    );

    Ok(TermInfo {
        id,
        name,
        project_id: project_id.to_string(),
        live: true,
    })
}

/// Kill a terminal's PTY and drop its record.
pub fn close_terminal(app: &AppHandle, terminal_id: &str) {
    let store = app.state::<StateStore>();
    app.state::<PtyManager>().kill(terminal_id);
    if let Some(project_id) = project_of_terminal(&store, terminal_id) {
        store.remove_terminal(&project_id, terminal_id);
    }
}

fn project_of_terminal(store: &StateStore, terminal_id: &str) -> Option<String> {
    store
        .snapshot()
        .projects
        .into_iter()
        .find(|p| p.terminals.iter().any(|t| t.id == terminal_id))
        .map(|p| p.id)
}
