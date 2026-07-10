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

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexStatus {
    Building,
    Ready,
    Stale,
}

pub struct ProjectIndex {
    pub root: PathBuf,
    /// Sorted, project-relative, forward-slash file paths.
    pub paths: Vec<String>,
    pub status: IndexStatus,
    pub truncated: bool,
    /// Epoch millis of the last full build; 0 while first build is pending.
    pub built_at: u64,
    /// Cached ignore matcher for incremental membership checks.
    pub ignore: Arc<Gitignore>,
    /// Native watcher failed — ensure_active falls back to TTL rebuilds.
    pub degraded: bool,
}

/// Reconcile a single changed absolute path against the index: insert it when it
/// exists on disk, is a file, and isn't ignored; remove it when it's gone.
pub(crate) fn apply_change(index: &mut ProjectIndex, abs: &Path) {
    let rel = match abs.strip_prefix(&index.root) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => return,
    };
    if rel.is_empty() || rel.split('/').any(|c| c == ".git") {
        return;
    }
    let is_file = abs.is_file();
    let ignored = index
        .ignore
        .matched_path_or_any_parents(abs, false)
        .is_ignore();
    let should_have = is_file && !ignored;
    match index.paths.binary_search(&rel) {
        Ok(pos) => {
            if !should_have {
                index.paths.remove(pos);
            }
        }
        Err(pos) => {
            if should_have && index.paths.len() < MAX_FILES {
                index.paths.insert(pos, rel);
            }
        }
    }
}

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

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub score: u32,
    /// Matched character positions (char indices) for highlighting.
    pub indices: Vec<u32>,
}

/// Fuzzy-rank `paths` against `query`, returning the top `limit` hits with
/// nucleo's path/filename bonus behavior and matched-character indices.
pub(crate) fn query_paths(paths: &[String], query: &str, limit: usize) -> Vec<Hit> {
    if query.is_empty() {
        return Vec::new();
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);

    let mut ranked: Vec<(&String, u32)> = pattern.match_list(paths.iter(), &mut matcher);
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked.truncate(limit);

    ranked
        .into_iter()
        .map(|(path, score)| {
            let mut buf: Vec<char> = Vec::new();
            let mut indices: Vec<u32> = Vec::new();
            let hay = Utf32Str::new(path.as_str(), &mut buf);
            pattern.indices(hay, &mut matcher, &mut indices);
            indices.sort_unstable();
            indices.dedup();
            Hit {
                path: path.clone(),
                score,
                indices,
            }
        })
        .collect()
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

    fn index_for(root: &Path) -> ProjectIndex {
        let (paths, truncated) = build_paths_capped(root, MAX_FILES);
        ProjectIndex {
            root: root.to_path_buf(),
            paths,
            status: IndexStatus::Ready,
            truncated,
            built_at: 1,
            ignore: Arc::new(build_ignore(root)),
            degraded: false,
        }
    }

    #[test]
    fn apply_change_adds_removes_and_respects_ignore() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, ".gitignore", "*.log\n");
        write(root, "a/keep.rs", "x");
        let mut idx = index_for(root);
        assert!(!idx.paths.iter().any(|p| p == "a/new.rs"));

        // create -> added
        write(root, "a/new.rs", "x");
        apply_change(&mut idx, &root.join("a/new.rs"));
        assert!(idx.paths.iter().any(|p| p == "a/new.rs"));

        // ignored create -> not added
        write(root, "a/noise.log", "x");
        apply_change(&mut idx, &root.join("a/noise.log"));
        assert!(!idx.paths.iter().any(|p| p == "a/noise.log"));

        // remove -> dropped
        fs::remove_file(root.join("a/new.rs")).unwrap();
        apply_change(&mut idx, &root.join("a/new.rs"));
        assert!(!idx.paths.iter().any(|p| p == "a/new.rs"));
    }

    #[test]
    fn gitignore_change_rebuild_excludes_newly_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "keep.rs", "x");
        write(root, "gen.rs", "x");
        let before = index_for(root);
        assert!(before.paths.iter().any(|p| p == "gen.rs"));

        // A .gitignore change triggers a full rebuild in the running app; here we
        // verify the rebuilt path set honors the new rule.
        write(root, ".gitignore", "gen.rs\n");
        let (paths, _) = build_paths_capped(root, MAX_FILES);
        assert!(paths.iter().any(|p| p == "keep.rs"));
        assert!(!paths.iter().any(|p| p == "gen.rs"));
    }

    #[test]
    fn filename_match_beats_scattered_path_match() {
        // A clean filename match ("config" == the whole filename) must outrank a
        // match where the query characters are scattered across path segments.
        let paths = vec![
            "src/cortex/onboard/native/fixtures/img/graph.rs".to_string(),
            "config.rs".to_string(),
        ];
        let hits = query_paths(&paths, "config", 10);
        assert_eq!(hits.first().map(|h| h.path.as_str()), Some("config.rs"));
        assert!(!hits[0].indices.is_empty());
    }
}
