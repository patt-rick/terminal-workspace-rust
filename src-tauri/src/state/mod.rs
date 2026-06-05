use crate::error::AppResult;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalRecord {
    pub id: String,
    pub name: String,
    pub shell: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: String,
    #[serde(default)]
    pub terminals: Vec<TerminalRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub version: u32,
    pub selected_project_id: Option<String>,
    pub projects: Vec<Project>,
    #[serde(default)]
    pub active_terminal_by_project: HashMap<String, Option<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            version: 1,
            selected_project_id: None,
            projects: Vec::new(),
            active_terminal_by_project: HashMap::new(),
        }
    }
}

// Project dot colors, cycled by index as projects are added.
const COLORS: &[&str] = &[
    "#ffcc66", "#5ccfe6", "#bae67e", "#c3a6ff", "#ef6b73", "#f29e74", "#73d0ff", "#d4bfff",
];

/// In-memory projects/selection state with synchronous atomic persistence.
/// Terminals are session-scoped: their PTYs die with the app, so they are
/// stripped on both load and save and never restored.
pub struct StateStore {
    path: PathBuf,
    inner: Mutex<AppState>,
}

impl StateStore {
    pub fn load(path: PathBuf) -> Self {
        let mut state = read_file(&path).unwrap_or_default();
        for p in &mut state.projects {
            p.terminals.clear();
        }
        state.active_terminal_by_project.clear();
        Self {
            path,
            inner: Mutex::new(state),
        }
    }

    pub fn snapshot(&self) -> AppState {
        self.inner.lock().clone()
    }

    fn persist(&self, state: &AppState) {
        let mut to_save = state.clone();
        for p in &mut to_save.projects {
            p.terminals.clear();
        }
        to_save.active_terminal_by_project.clear();
        let _ = write_atomic(&self.path, &to_save);
    }

    pub fn add_project(&self, path: String) -> Project {
        let mut state = self.inner.lock();
        if let Some(existing) = state.projects.iter().find(|p| p.path == path).cloned() {
            state.selected_project_id = Some(existing.id.clone());
            self.persist(&state);
            return existing;
        }
        let name = Path::new(&path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string();
        let color = COLORS[state.projects.len() % COLORS.len()].to_string();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            path,
            color,
            terminals: Vec::new(),
        };
        state.projects.push(project.clone());
        if state.selected_project_id.is_none() {
            state.selected_project_id = Some(project.id.clone());
        }
        self.persist(&state);
        project
    }

    pub fn remove_project(&self, id: &str) {
        let mut state = self.inner.lock();
        state.projects.retain(|p| p.id != id);
        state.active_terminal_by_project.remove(id);
        if state.selected_project_id.as_deref() == Some(id) {
            state.selected_project_id = state.projects.first().map(|p| p.id.clone());
        }
        self.persist(&state);
    }

    pub fn rename_project(&self, id: &str, name: String) {
        let mut state = self.inner.lock();
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == id) {
            p.name = name;
        }
        self.persist(&state);
    }

    pub fn select(&self, id: Option<String>) {
        let mut state = self.inner.lock();
        state.selected_project_id = id;
        self.persist(&state);
    }

    pub fn set_active(&self, project_id: String, terminal_id: Option<String>) {
        // Active terminal is not persisted (stripped on save) but tracked live.
        self.inner
            .lock()
            .active_terminal_by_project
            .insert(project_id, terminal_id);
    }

    pub fn project_path(&self, id: &str) -> Option<String> {
        self.inner
            .lock()
            .projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.path.clone())
    }

    pub fn terminal_count(&self, project_id: &str) -> usize {
        self.inner
            .lock()
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.terminals.len())
            .unwrap_or(0)
    }

    pub fn upsert_terminal(&self, project_id: &str, rec: TerminalRecord) {
        let mut state = self.inner.lock();
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == project_id) {
            if let Some(t) = p.terminals.iter_mut().find(|t| t.id == rec.id) {
                *t = rec;
            } else {
                p.terminals.push(rec);
            }
        }
    }

    pub fn rename_terminal(&self, project_id: &str, terminal_id: &str, name: String) {
        let mut state = self.inner.lock();
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == project_id) {
            if let Some(t) = p.terminals.iter_mut().find(|t| t.id == terminal_id) {
                t.name = name;
            }
        }
    }

    pub fn remove_terminal(&self, project_id: &str, terminal_id: &str) {
        let mut state = self.inner.lock();
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == project_id) {
            p.terminals.retain(|t| t.id != terminal_id);
        }
    }
}

fn read_file(path: &Path) -> Option<AppState> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_atomic(path: &Path, state: &AppState) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(state)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
