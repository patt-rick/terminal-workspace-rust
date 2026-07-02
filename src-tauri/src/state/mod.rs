use crate::error::AppResult;
use crate::git::discover::RepoInfo;
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
    /// Discovered git repos, cached across restarts (revalidated on focus, fully
    /// rescanned on explicit refresh). Not derivable without a filesystem scan.
    #[serde(default)]
    pub repos: Vec<RepoInfo>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub version: u32,
    pub selected_project_id: Option<String>,
    pub projects: Vec<Project>,
    #[serde(default)]
    pub active_terminal_by_project: HashMap<String, Option<String>>,
    /// Picker selection per project (repo_id). Persisted across restarts.
    #[serde(default)]
    pub selected_repo_by_project: HashMap<String, String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            version: 1,
            selected_project_id: None,
            projects: Vec::new(),
            active_terminal_by_project: HashMap::new(),
            selected_repo_by_project: HashMap::new(),
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
            repos: Vec::new(),
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
        state.selected_repo_by_project.remove(id);
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

    pub fn get_repos(&self, project_id: &str) -> Vec<RepoInfo> {
        self.inner
            .lock()
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.repos.clone())
            .unwrap_or_default()
    }

    /// Replace a project's cached repo list and keep its picker selection valid
    /// (default to the root repo, else the first, else clear). Persists.
    pub fn set_repos(&self, project_id: &str, repos: Vec<RepoInfo>) {
        let mut state = self.inner.lock();
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == project_id) {
            p.repos = repos.clone();
        }
        let selection_valid = state
            .selected_repo_by_project
            .get(project_id)
            .map(|cur| repos.iter().any(|r| &r.id == cur))
            .unwrap_or(false);
        if !selection_valid {
            let default = repos
                .iter()
                .find(|r| r.relative_path.is_empty())
                .or_else(|| repos.first())
                .map(|r| r.id.clone());
            match default {
                Some(id) => {
                    state.selected_repo_by_project.insert(project_id.to_string(), id);
                }
                None => {
                    state.selected_repo_by_project.remove(project_id);
                }
            }
        }
        self.persist(&state);
    }

    /// Resolve a `repo_id` to its absolute working-directory path, scanning every
    /// project's cached repos. Returns None for an unknown/stale id.
    pub fn repo_path(&self, repo_id: &str) -> Option<String> {
        self.inner
            .lock()
            .projects
            .iter()
            .flat_map(|p| p.repos.iter())
            .find(|r| r.id == repo_id)
            .map(|r| r.path.clone())
    }

    pub fn selected_repo(&self, project_id: &str) -> Option<String> {
        self.inner
            .lock()
            .selected_repo_by_project
            .get(project_id)
            .cloned()
    }

    pub fn set_selected_repo(&self, project_id: String, repo_id: String) {
        let mut state = self.inner.lock();
        state.selected_repo_by_project.insert(project_id, repo_id);
        self.persist(&state);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(id: &str, path: &str, rel: &str) -> RepoInfo {
        RepoInfo {
            id: id.to_string(),
            path: path.to_string(),
            relative_path: rel.to_string(),
            name: if rel.is_empty() { "root".into() } else { rel.to_string() },
            is_submodule: false,
            parent_repo_id: None,
        }
    }

    #[test]
    fn repos_cache_persists_and_selection_defaults_to_root() {
        // AC-2.7: cache + selected-repo round-trip; root repo is the default pick.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let store = StateStore::load(path.clone());
        let p = store.add_project("/work".to_string());
        store.set_repos(&p.id, vec![repo("r0", "/work", ""), repo("r1", "/work/sub", "sub")]);

        assert_eq!(store.selected_repo(&p.id).as_deref(), Some("r0")); // root
        assert_eq!(store.repo_path("r1").as_deref(), Some("/work/sub"));

        // Reload from disk: repos + selection survive (terminals do not).
        let reloaded = StateStore::load(path);
        assert_eq!(reloaded.get_repos(&p.id).len(), 2);
        assert_eq!(reloaded.selected_repo(&p.id).as_deref(), Some("r0"));
    }

    #[test]
    fn set_repos_resets_selection_when_it_becomes_stale() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::load(dir.path().join("state.json"));
        let p = store.add_project("/w".to_string());
        store.set_repos(&p.id, vec![repo("r0", "/w", "")]);
        store.set_selected_repo(p.id.clone(), "r0".to_string());
        // A rescan that no longer contains r0 must move the selection to a valid id.
        store.set_repos(&p.id, vec![repo("r9", "/w/x", "x")]);
        assert_eq!(store.selected_repo(&p.id).as_deref(), Some("r9"));
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
