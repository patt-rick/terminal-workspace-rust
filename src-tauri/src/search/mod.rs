//! Quick-open file search: a per-project, in-memory fuzzy index over file paths.

use crate::error::AppResult;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{WalkBuilder, WalkState};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// Hard cap on files indexed per project (matches the spec's safety rail).
pub const MAX_FILES: usize = 200_000;
/// Rebuild interval used when the native watcher is unavailable.
pub const TTL_MS: u64 = 30_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub mod watcher;

/// Placeholder so `pub mod watcher;` resolves; replaced in later tasks.
#[derive(Default)]
pub struct SearchStore {
    pub(crate) indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    watchers: Arc<Mutex<HashMap<String, watcher::Handle>>>,
}

pub struct ProjectIndex;

/// Walk `root` in parallel, returning sorted, project-relative, forward-slash
/// file paths and whether `cap` was hit. Gitignored entries and `.git` are
/// excluded; walk errors are skipped silently (as in git/discover.rs).
pub(crate) fn build_paths_capped(root: &Path, cap: usize) -> (Vec<String>, bool) {
    let count = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let collected = Arc::new(Mutex::new(Vec::<String>::new()));
    let root_buf = root.to_path_buf();

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .follow_links(false) // symlink-cycle protection
        .filter_entry(|e| e.file_name().to_str() != Some(".git"))
        .build_parallel();

    walker.run(|| {
        let count = count.clone();
        let truncated = truncated.clone();
        let collected = collected.clone();
        let root_buf = root_buf.clone();
        Box::new(move |result| {
            let entry = match result {
                Ok(e) => e,
                Err(_) => return WalkState::Continue,
            };
            // files only
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
                return WalkState::Continue;
            }
            let n = count.fetch_add(1, Ordering::Relaxed);
            if n >= cap {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            if let Ok(rel) = entry.path().strip_prefix(&root_buf) {
                collected
                    .lock()
                    .push(rel.to_string_lossy().replace('\\', "/"));
            }
            WalkState::Continue
        })
    });

    let mut paths = std::mem::take(&mut *collected.lock());
    if paths.len() > cap {
        paths.truncate(cap); // threads may overshoot slightly before Quit
    }
    paths.sort();
    (paths, truncated.load(Ordering::Relaxed))
}

/// Cached gitignore matcher for incremental membership checks. Root `.gitignore`
/// plus git globals; nested gitignores are approximated and any `.gitignore`
/// change forces a full rebuild (see watcher).
pub(crate) fn build_ignore(root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    let _ = b.add(root.join(".gitignore"));
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn build_excludes_gitignored_and_git_and_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, ".gitignore", "*.log\n");
        write(root, "a/keep.rs", "x");
        write(root, "a/skip.log", "x");
        write(root, ".git/config", "x");
        let (paths, truncated) = build_paths_capped(root, MAX_FILES);
        assert!(paths.contains(&"a/keep.rs".to_string()));
        assert!(!paths.iter().any(|p| p == "a/skip.log"));
        assert!(!paths.iter().any(|p| p.starts_with(".git/")));
        assert!(!paths.iter().any(|p| p == "a")); // directories excluded
        assert!(!truncated);
    }

    #[test]
    fn build_truncates_at_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for i in 0..5 {
            write(root, &format!("f{i}.txt"), "x");
        }
        let (paths, truncated) = build_paths_capped(root, 2);
        assert!(truncated);
        assert_eq!(paths.len(), 2);
    }
}
