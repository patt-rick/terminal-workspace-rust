//! Recursive git repository discovery.
//!
//! A "project" is a folder the user added; it may be a single repo, a subfolder
//! inside a repo, or a container of many nested repos. This module enumerates
//! every repo a project should expose in the git picker, mirroring VS Code's
//! multi-root behavior:
//!
//! - If the project root is itself a repo, it (plus its registered submodules)
//!   is the whole list — we do not descend hunting for further nested repos.
//! - If the project root sits *inside* a repo, that enclosing repo is the list
//!   (preserves the pre-multi-repo behavior for "added a subfolder of a repo").
//! - Otherwise the root is a plain container: we walk downward, stopping at each
//!   repo boundary (a repo's non-submodule nested repos are ignored), skipping
//!   symlinks and well-known heavy directories.

use git2::Repository;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Stable per-project id derived from the absolute workdir path.
    pub id: String,
    /// Absolute path to the repo working directory (source of truth for
    /// resolving a `repo_id` back to a path).
    pub path: String,
    /// Display path, relative to the project root (forward slashes). Empty for a
    /// repo at (or above) the project root.
    pub relative_path: String,
    /// Folder name (or submodule name) shown in the picker.
    pub name: String,
    pub is_submodule: bool,
    pub parent_repo_id: Option<String>,
}

pub struct DiscoverResult {
    pub repos: Vec<RepoInfo>,
    /// True if the directory-visit cap was hit and the scan aborted early.
    pub capped: bool,
}

/// Directories skipped when scanning *outside* any repo. Inside a repo we stop
/// descending anyway, so these only matter for container projects.
const HEAVY_DIRS: &[&str] = &["node_modules", "target", "dist", "build", ".venv", "__pycache__"];

/// Hard safety cap on directories visited in a single project scan.
const MAX_DIRS: usize = 10_000;

fn repo_id(project_id: &str, abs_path: &str) -> String {
    let mut h = DefaultHasher::new();
    project_id.hash(&mut h);
    0u8.hash(&mut h);
    abs_path.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn norm(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// `path` relative to `root` with forward slashes; empty when `path` is not
/// strictly below `root` (e.g. an enclosing repo above the project root).
fn relative_to(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().replace('\\', "/"),
        _ => String::new(),
    }
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| norm(path))
}

fn make_repo(project_id: &str, root: &Path, workdir: &Path, is_submodule: bool, parent: Option<String>) -> RepoInfo {
    let abs = norm(workdir);
    RepoInfo {
        id: repo_id(project_id, &abs),
        path: abs,
        relative_path: relative_to(root, workdir),
        name: basename(workdir),
        is_submodule,
        parent_repo_id: parent,
    }
}

/// Append a repo's registered submodules (from `.gitmodules`) as distinct,
/// badged entries nested under `parent_id`. Errors are non-fatal.
fn collect_submodules(project_id: &str, root: &Path, repo_dir: &Path, parent_id: &str, out: &mut Vec<RepoInfo>) {
    let repo = match Repository::open(repo_dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let subs = match repo.submodules() {
        Ok(s) => s,
        Err(_) => return,
    };
    for sub in subs {
        let sub_path = repo_dir.join(sub.path());
        out.push(make_repo(project_id, root, &sub_path, true, Some(parent_id.to_string())));
    }
}

/// Discover every repo a project should expose. `project_id` seeds stable ids.
pub fn discover_repos(project_id: &str, root: &Path) -> DiscoverResult {
    let mut repos: Vec<RepoInfo> = Vec::new();

    // Case 1: the project root is itself a repo.
    if root.join(".git").exists() {
        let repo = make_repo(project_id, root, root, false, None);
        let id = repo.id.clone();
        repos.push(repo);
        collect_submodules(project_id, root, root, &id, &mut repos);
        return DiscoverResult { repos, capped: false };
    }

    // Case 2: the project root sits inside a repo (a subfolder was added).
    if let Ok(repo) = Repository::discover(root) {
        if let Some(wd) = repo.workdir() {
            let wd = wd.to_path_buf();
            if wd != root {
                let info = make_repo(project_id, root, &wd, false, None);
                let id = info.id.clone();
                repos.push(info);
                collect_submodules(project_id, root, &wd, &id, &mut repos);
                return DiscoverResult { repos, capped: false };
            }
        }
    }

    // Case 3: plain container — walk downward, stopping at each repo boundary.
    let mut capped = false;
    let mut visited = 0usize;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            capped = true;
            break;
        }
        if dir.join(".git").exists() {
            let info = make_repo(project_id, root, &dir, false, None);
            let id = info.id.clone();
            repos.push(info);
            collect_submodules(project_id, root, &dir, &id, &mut repos);
            continue; // do not descend into a discovered repo
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // symlink_metadata does not follow the link → symlinked dirs are
            // detected and skipped (cycle protection, R2.2 / AC-2.8).
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() || !meta.is_dir() {
                continue;
            }
            let name = entry.file_name();
            if HEAVY_DIRS.contains(&name.to_string_lossy().as_ref()) {
                continue;
            }
            stack.push(path);
        }
    }

    DiscoverResult { repos, capped }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_repo(path: &Path) {
        fs::create_dir_all(path).unwrap();
        Repository::init(path).unwrap();
    }

    #[test]
    fn discovers_siblings_and_deeply_nested_container_repos() {
        // AC-2.1: 3 sibling repos at depth 1 + one at depth 3, project root is a
        // plain (non-repo) container.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(&root.join("amc-back"));
        init_repo(&root.join("amc-front"));
        init_repo(&root.join("arij"));
        init_repo(&root.join("group").join("sub").join("deep"));
        // a heavy dir with a stray .git that must be ignored
        init_repo(&root.join("node_modules").join("pkg"));

        let res = discover_repos("proj", root);
        let mut rels: Vec<String> = res.repos.iter().map(|r| r.relative_path.clone()).collect();
        rels.sort();
        assert_eq!(rels, vec!["amc-back", "amc-front", "arij", "group/sub/deep"]);
        assert!(res.repos.iter().all(|r| !r.is_submodule));
    }

    #[test]
    fn project_root_that_is_a_repo_ignores_non_submodule_nested_repos() {
        // AC-2.2 (negative half): a non-submodule repo nested inside a repo does
        // not appear.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        init_repo(&root.join("vendored")); // nested, NOT a submodule
        let res = discover_repos("proj", root);
        assert_eq!(res.repos.len(), 1);
        assert_eq!(res.repos[0].relative_path, "");
        assert!(!res.repos[0].is_submodule);
    }

    #[test]
    fn registered_submodules_appear_badged_under_their_parent() {
        // AC-2.2 (positive half): a repo with 2 registered submodules → 3 entries.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(root);
        let parent = Repository::open(root).unwrap();
        // Register two submodules (writes .gitmodules + index entries). No clone
        // needed for them to be listed by `submodules()`.
        parent.submodule("https://example.com/a.git", Path::new("libs/a"), true).unwrap();
        parent.submodule("https://example.com/b.git", Path::new("libs/b"), true).unwrap();

        let res = discover_repos("proj", root);
        let subs: Vec<&RepoInfo> = res.repos.iter().filter(|r| r.is_submodule).collect();
        assert_eq!(res.repos.len(), 3);
        assert_eq!(subs.len(), 2);
        let parent_id = &res.repos.iter().find(|r| !r.is_submodule).unwrap().id;
        assert!(subs.iter().all(|s| s.parent_repo_id.as_ref() == Some(parent_id)));
        let mut rels: Vec<String> = subs.iter().map(|s| s.relative_path.clone()).collect();
        rels.sort();
        assert_eq!(rels, vec!["libs/a", "libs/b"]);
    }

    #[test]
    fn subfolder_of_a_repo_resolves_to_the_enclosing_repo() {
        // Preserves pre-multi-repo behavior (R5.2): adding a subdir of a repo
        // shows that repo, keyed to the repo workdir, not the subdir.
        let tmp = tempfile::tempdir().unwrap();
        let repo_root = tmp.path();
        init_repo(repo_root);
        let sub = repo_root.join("src").join("nested");
        fs::create_dir_all(&sub).unwrap();

        let res = discover_repos("proj", &sub);
        assert_eq!(res.repos.len(), 1);
        assert!(!res.repos[0].is_submodule);
        // resolves to the repo root, not the subfolder
        assert_eq!(res.repos[0].path, norm(repo_root));
    }

    #[cfg(unix)]
    #[test]
    fn self_referencing_symlink_does_not_hang() {
        // AC-2.8
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init_repo(&root.join("real"));
        symlink(root, root.join("loop")).unwrap();
        let res = discover_repos("proj", root);
        assert_eq!(res.repos.len(), 1);
        assert_eq!(res.repos[0].relative_path, "real");
    }
}
