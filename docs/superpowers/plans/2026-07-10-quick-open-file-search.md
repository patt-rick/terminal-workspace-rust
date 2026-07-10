# Quick-Open File Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code Ctrl/Cmd+P quick-open palette that fuzzy-searches file names/paths within the currently selected project and opens results in the existing file viewer.

**Architecture:** A new Rust `search` module holds a per-project in-memory index (`SearchStore = Mutex<HashMap<ProjectId, ProjectIndex>>`) built off-thread with the `ignore` crate's parallel gitignore-aware walker (files only, `.git` excluded, capped at 200k). A `notify-debouncer-mini` watcher keeps the active project's index incrementally fresh, with a 30s TTL-rebuild fallback if watching fails. Queries fuzzy-match with `nucleo-matcher` in Rust and return scored hits with matched-character indices. The React palette invokes per keystroke with a monotonic stamp, renders highlighted results, and opens files through the same `useFiles` store path the file tree uses.

**Tech Stack:** Rust (Tauri 2, `ignore` 0.4, `nucleo-matcher` 0.3, `notify-debouncer-mini` 0.7, `parking_lot`), TypeScript/React 19 + Zustand + Tailwind + Vite.

---

## File Structure

**Created**
- `src-tauri/src/search/mod.rs` — `SearchStore` managed state, `ProjectIndex`, parallel walk/index build, gitignore matcher, `nucleo` query, incremental apply, lifecycle (ensure/rebuild/drop), serde result types, unit tests.
- `src-tauri/src/search/watcher.rs` — per-project debounced `notify` watcher: incremental reconcile + full-rebuild triggers, graceful failure.
- `src/components/quick-open/quick-open.tsx` — palette overlay: input, fuzzy results with highlighting, keyboard nav, recents on empty query, status footer.

**Modified**
- `src-tauri/Cargo.toml` — add `nucleo-matcher` and `notify-debouncer-mini` deps.
- `src-tauri/src/lib.rs` — `mod search;`, manage `SearchStore`, register three search commands.
- `src-tauri/src/commands.rs` — three `search_*` commands; `projects_remove` drops the index; `PathBuf` import.
- `src/lib/ipc.ts` — `search` namespace + types.
- `src/app.tsx` — Ctrl/Cmd+P shortcut, palette mount, index-lifecycle effect on project selection.

---

### Task 1: Add dependencies and register the empty `search` module

**Files:**
- Modify: `src-tauri/Cargo.toml` (after line 48, the `ignore = "0.4"` block)
- Create: `src-tauri/src/search/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod search;` after line 15 `mod pty;`; manage state after line 71; leave invoke_handler for Task 7)

- [ ] Add to `src-tauri/Cargo.toml` immediately after the `ignore = "0.4"` line (line 48):
```toml

# Quick-open file search: fuzzy matcher (Helix engine) + debounced fs watcher.
# notify-debouncer-mini re-exports `notify`, so we don't depend on notify directly.
nucleo-matcher = "0.3"
notify-debouncer-mini = "0.7"
```
- [ ] Create `src-tauri/src/search/mod.rs` with a compiling stub:
```rust
//! Quick-open file search: a per-project, in-memory fuzzy index over file paths.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub mod watcher;

/// Placeholder so `pub mod watcher;` resolves; replaced in later tasks.
#[derive(Default)]
pub struct SearchStore {
    pub(crate) indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    watchers: Arc<Mutex<HashMap<String, watcher::Handle>>>,
}

pub struct ProjectIndex;
```
- [ ] Create `src-tauri/src/search/watcher.rs` with a stub `Handle`:
```rust
//! Debounced filesystem watcher stub (implemented in a later task).

pub struct Handle;
```
- [ ] In `src-tauri/src/lib.rs`, add `mod search;` on its own line after line 15 (`mod pty;`).
- [ ] In `src-tauri/src/lib.rs`, after line 71 (`app.manage(PtyManager::new());`) add:
```rust
            app.manage(search::SearchStore::default());
```
- [ ] Run from `src-tauri`: `cargo build` — expect it to compile (warnings about unused fields are fine).
- [ ] Commit:
```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/search src-tauri/src/lib.rs
git commit -m "feat(search): scaffold search module and dependencies"
```

---

### Task 2: Index build — parallel gitignore-aware walk (TDD)

**Files:**
- Modify: `src-tauri/src/search/mod.rs`

- [ ] Replace the stub body of `src-tauri/src/search/mod.rs` above `pub mod watcher;` with the imports and constants:
```rust
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
```
- [ ] Add the failing test module at the bottom of `src-tauri/src/search/mod.rs`:
```rust
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
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect failure: `cannot find function build_paths_capped`.
- [ ] Add the implementation to `src-tauri/src/search/mod.rs` (above the test module):
```rust
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
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect both tests to pass.
- [ ] Commit:
```bash
git add src-tauri/src/search/mod.rs
git commit -m "feat(search): parallel gitignore-aware index walk with cap"
```

---

### Task 3: Fuzzy query and ranking (TDD)

**Files:**
- Modify: `src-tauri/src/search/mod.rs`

> **Builder note:** Verify the `nucleo-matcher` 0.3.x API against docs.rs before implementing — specifically `Config::DEFAULT.match_paths()`, `Pattern::parse(&str, CaseMatching, Normalization)`, `Pattern::match_list(iter, &mut Matcher) -> Vec<(T, u32)>`, `Pattern::indices(Utf32Str, &mut Matcher, &mut Vec<u32>)`, and `Utf32Str::new(&str, &mut Vec<char>)`. Adjust the calls below if a signature differs.

- [ ] Add a failing ranking test inside the existing `mod tests` in `src-tauri/src/search/mod.rs`:
```rust
    #[test]
    fn filename_match_beats_scattered_path_match() {
        let paths = vec![
            "src/app/components/config-loader.rs".to_string(),
            "config.rs".to_string(),
        ];
        let hits = query_paths(&paths, "config", 10);
        assert_eq!(hits.first().map(|h| h.path.as_str()), Some("config.rs"));
        assert!(!hits[0].indices.is_empty());
    }
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect failure: `cannot find function query_paths`.
- [ ] Add to `src-tauri/src/search/mod.rs` (above the test module):
```rust
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
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect the ranking test to pass.
- [ ] Commit:
```bash
git add src-tauri/src/search/mod.rs
git commit -m "feat(search): nucleo fuzzy ranking with match indices"
```

---

### Task 4: Incremental reconcile (TDD)

**Files:**
- Modify: `src-tauri/src/search/mod.rs`

- [ ] Add a failing test inside `mod tests` in `src-tauri/src/search/mod.rs`:
```rust
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
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect failures: unknown `ProjectIndex` fields / `IndexStatus` / `apply_change`.
- [ ] Add the types and `apply_change` to `src-tauri/src/search/mod.rs` (above the test module), replacing the placeholder `pub struct ProjectIndex;`:
```rust
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
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect all tests to pass.
- [ ] Commit:
```bash
git add src-tauri/src/search/mod.rs
git commit -m "feat(search): incremental index reconcile with gitignore filter"
```

---

### Task 5: SearchStore lifecycle and result types (TDD)

**Files:**
- Modify: `src-tauri/src/search/mod.rs`

- [ ] Add a failing store test inside `mod tests` in `src-tauri/src/search/mod.rs`:
```rust
    #[test]
    fn store_query_reports_building_when_missing_and_hits_when_present() {
        let store = SearchStore::default();
        let empty = store.query("missing", "x", 10);
        assert!(matches!(empty.status, IndexStatus::Building));
        assert_eq!(empty.total, 0);

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "config.rs", "x");
        store
            .indices
            .lock()
            .insert("p1".to_string(), index_for(root));

        let res = store.query("p1", "config", 10);
        assert!(matches!(res.status, IndexStatus::Ready));
        assert_eq!(res.total, 1);
        assert_eq!(res.hits[0].path, "config.rs");

        let status = store.status_of("p1");
        assert_eq!(status.file_count, 1);
        assert!(!status.truncated);
    }
```
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect failure: missing `query` / `status_of`.
- [ ] Add to `src-tauri/src/search/mod.rs` (above the test module). Result types:
```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub status: IndexStatus,
    pub total: usize,
    pub hits: Vec<Hit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusResult {
    pub status: IndexStatus,
    pub file_count: usize,
    pub truncated: bool,
    pub built_at: Option<u64>,
}
```
- [ ] Add the free build helpers (used by the store and the watcher) to `src-tauri/src/search/mod.rs`:
```rust
/// Full build on a background thread: walk, cache the ignore matcher, publish the
/// Ready index, then (re)start the watcher. Watcher failure marks the index
/// degraded so ensure_active can TTL-rebuild it.
fn run_build(
    indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    watchers: Arc<Mutex<HashMap<String, watcher::Handle>>>,
    project_id: String,
    root: PathBuf,
) {
    std::thread::spawn(move || {
        let (paths, truncated) = build_paths_capped(&root, MAX_FILES);
        let ignore = Arc::new(build_ignore(&root));
        indices.lock().insert(
            project_id.clone(),
            ProjectIndex {
                root: root.clone(),
                paths,
                status: IndexStatus::Ready,
                truncated,
                built_at: now_ms(),
                ignore,
                degraded: false,
            },
        );
        match watcher::start(indices.clone(), project_id.clone(), root.clone()) {
            Ok(handle) => {
                watchers.lock().insert(project_id, handle);
            }
            Err(_) => {
                watchers.lock().remove(&project_id);
                if let Some(p) = indices.lock().get_mut(&project_id) {
                    p.degraded = true;
                }
            }
        }
    });
}

/// Rebuild paths + ignore matcher in place, keeping the existing watcher. Used by
/// the watcher for .gitignore changes and overflow rescans.
pub(crate) fn refresh_paths(
    indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    project_id: String,
    root: PathBuf,
) {
    std::thread::spawn(move || {
        let (paths, truncated) = build_paths_capped(&root, MAX_FILES);
        let ignore = Arc::new(build_ignore(&root));
        if let Some(p) = indices.lock().get_mut(&project_id) {
            p.paths = paths;
            p.truncated = truncated;
            p.ignore = ignore;
            p.built_at = now_ms();
            p.status = IndexStatus::Ready;
        }
    });
}
```
- [ ] Add the `SearchStore` methods (delete the `#[derive(Default)] pub struct SearchStore {...}` from Task 1 and re-declare with an impl) to `src-tauri/src/search/mod.rs`:
```rust
#[derive(Default)]
pub struct SearchStore {
    pub(crate) indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    watchers: Arc<Mutex<HashMap<String, watcher::Handle>>>,
}

impl SearchStore {
    /// Make `project_id` the single active index: drop every other project and
    /// its watcher, then build this one if missing or a degraded TTL has expired.
    pub fn ensure_active(&self, project_id: &str, root: PathBuf) {
        {
            let mut idx = self.indices.lock();
            let mut w = self.watchers.lock();
            let others: Vec<String> =
                idx.keys().filter(|k| k.as_str() != project_id).cloned().collect();
            for k in &others {
                idx.remove(k);
                w.remove(k); // dropping the Handle stops the watcher
            }
        }
        let need_build = match self.indices.lock().get(project_id) {
            None => true,
            Some(p) => p.degraded && now_ms().saturating_sub(p.built_at) > TTL_MS,
        };
        if need_build {
            self.spawn_build(project_id.to_string(), root);
        }
    }

    fn spawn_build(&self, project_id: String, root: PathBuf) {
        {
            let mut idx = self.indices.lock();
            match idx.get_mut(&project_id) {
                Some(p) => p.status = IndexStatus::Stale, // keep old paths queryable
                None => {
                    idx.insert(
                        project_id.clone(),
                        ProjectIndex {
                            root: root.clone(),
                            paths: Vec::new(),
                            status: IndexStatus::Building,
                            truncated: false,
                            built_at: 0,
                            ignore: Arc::new(Gitignore::empty()),
                            degraded: false,
                        },
                    );
                }
            }
        }
        run_build(self.indices.clone(), self.watchers.clone(), project_id, root);
    }

    pub fn rebuild(&self, project_id: &str, root: PathBuf) {
        let exists = self.indices.lock().contains_key(project_id);
        if exists {
            if let Some(p) = self.indices.lock().get_mut(project_id) {
                p.status = IndexStatus::Stale;
            }
            refresh_paths(self.indices.clone(), project_id.to_string(), root);
        } else {
            self.ensure_active(project_id, root);
        }
    }

    pub fn drop_project(&self, project_id: &str) {
        self.indices.lock().remove(project_id);
        self.watchers.lock().remove(project_id);
    }

    pub fn query(&self, project_id: &str, query: &str, limit: usize) -> QueryResult {
        let map = self.indices.lock();
        let Some(p) = map.get(project_id) else {
            return QueryResult {
                status: IndexStatus::Building,
                total: 0,
                hits: Vec::new(),
            };
        };
        let hits = query_paths(&p.paths, query, limit);
        QueryResult {
            status: p.status,
            total: p.paths.len(),
            hits,
        }
    }

    pub fn status_of(&self, project_id: &str) -> IndexStatusResult {
        let map = self.indices.lock();
        match map.get(project_id) {
            Some(p) => IndexStatusResult {
                status: p.status,
                file_count: p.paths.len(),
                truncated: p.truncated,
                built_at: (p.built_at != 0).then_some(p.built_at),
            },
            None => IndexStatusResult {
                status: IndexStatus::Building,
                file_count: 0,
                truncated: false,
                built_at: None,
            },
        }
    }
}
```
- [ ] Remove the now-unused `use crate::error::AppResult;` line if the compiler warns it is unused (no command code lives here).
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect all tests to pass (watcher::start is still a stub returning a Handle; Task 6 makes it real — if the stub signature does not yet match `run_build`'s call, this task will not compile, so implement Task 6 next before running the store build path; the store test itself does not exercise run_build).

> If compilation fails only on `watcher::start` arity, proceed to Task 6 then re-run; the unit tests here do not call `run_build`.

- [ ] Commit:
```bash
git add src-tauri/src/search/mod.rs
git commit -m "feat(search): SearchStore index lifecycle and query API"
```

---

### Task 6: Debounced filesystem watcher

**Files:**
- Modify: `src-tauri/src/search/watcher.rs`

> **Builder note:** Confirm the `notify-debouncer-mini` 0.7 API on docs.rs before implementing: the arity of `new_debouncer` (2-arg `(timeout, handler)` vs a variant taking a tick rate), the `DebounceEventResult` / `DebouncedEvent` shape (this code reads `event.path`), and the `notify` re-export path `notify_debouncer_mini::notify`. Adjust below to the pinned version.

- [ ] Replace the entire contents of `src-tauri/src/search/watcher.rs`:
```rust
//! Per-project debounced filesystem watcher. Incrementally reconciles index
//! entries; forces a full rebuild on any .gitignore/exclude change or watcher
//! error/overflow. Non-fatal and silent, matching git/discover.rs.

use super::{apply_change, refresh_paths, IndexStatus, ProjectIndex};
use notify_debouncer_mini::notify::{Error as NotifyError, RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Keeps the debouncer (and its watch) alive; dropping it stops watching.
pub struct Handle {
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// Start a recursive, ~500ms-debounced watcher on `root` for `project_id`.
pub fn start(
    indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    project_id: String,
    root: PathBuf,
) -> Result<Handle, NotifyError> {
    let root_cb = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                let mut need_rebuild = false;
                {
                    let mut map = indices.lock();
                    let Some(index) = map.get_mut(&project_id) else {
                        return;
                    };
                    for ev in &events {
                        let name = ev.path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if name == ".gitignore" || name == "exclude" {
                            need_rebuild = true;
                            break;
                        }
                        apply_change(index, &ev.path);
                    }
                }
                if need_rebuild {
                    if let Some(p) = indices.lock().get_mut(&project_id) {
                        p.status = IndexStatus::Stale;
                    }
                    refresh_paths(indices.clone(), project_id.clone(), root_cb.clone());
                }
            }
            Err(_errors) => {
                // Watcher error / overflow rescan: full rebuild in place.
                if let Some(p) = indices.lock().get_mut(&project_id) {
                    p.status = IndexStatus::Stale;
                }
                refresh_paths(indices.clone(), project_id.clone(), root_cb.clone());
            }
        },
    )?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive)?;
    Ok(Handle {
        _debouncer: debouncer,
    })
}
```
- [ ] Run from `src-tauri`: `cargo build` — expect it to compile.
- [ ] Run from `src-tauri`: `cargo test search:: -- --nocapture` — expect all search tests to pass.
- [ ] Commit:
```bash
git add src-tauri/src/search/watcher.rs
git commit -m "feat(search): debounced fs watcher with incremental updates"
```

---

### Task 7: Register commands and wire index lifecycle in the backend

**Files:**
- Modify: `src-tauri/src/commands.rs` (line 21 import; `projects_remove` at lines 63-66; add commands after the filesystem section ~line 277)
- Modify: `src-tauri/src/lib.rs` (invoke_handler after line 131 `commands::fs_export_text,`)

- [ ] In `src-tauri/src/commands.rs`, change line 21 from `use std::path::Path;` to:
```rust
use std::path::{Path, PathBuf};
```
- [ ] In `src-tauri/src/commands.rs`, add after the existing `use crate::` imports (e.g. after line 16 `use crate::settings::SettingsStore;`):
```rust
use crate::search::{IndexStatusResult, QueryResult, SearchStore};
```
- [ ] In `src-tauri/src/commands.rs`, replace `projects_remove` (lines 63-66) with:
```rust
#[tauri::command]
pub fn projects_remove(store: State<StateStore>, search: State<SearchStore>, id: String) {
    search.drop_project(&id);
    store.remove_project(&id);
}
```
- [ ] In `src-tauri/src/commands.rs`, add the three commands at the end of the filesystem section, immediately after `fs_export_text` (after line 277):
```rust
// ---------- search (quick open) ----------

#[tauri::command]
pub fn search_query(
    store: State<StateStore>,
    search: State<SearchStore>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> AppResult<QueryResult> {
    let root = project_root(&store, &project_id)?;
    search.ensure_active(&project_id, PathBuf::from(&root));
    Ok(search.query(&project_id, &query, limit.unwrap_or(50)))
}

#[tauri::command]
pub fn search_index_status(
    store: State<StateStore>,
    search: State<SearchStore>,
    project_id: String,
) -> AppResult<IndexStatusResult> {
    let root = project_root(&store, &project_id)?;
    search.ensure_active(&project_id, PathBuf::from(&root));
    Ok(search.status_of(&project_id))
}

#[tauri::command]
pub fn search_rebuild(
    store: State<StateStore>,
    search: State<SearchStore>,
    project_id: String,
) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    search.rebuild(&project_id, PathBuf::from(&root));
    Ok(())
}
```
- [ ] In `src-tauri/src/lib.rs`, add to `generate_handler!` immediately after line 131 (`commands::fs_export_text,`):
```rust
            commands::search_query,
            commands::search_index_status,
            commands::search_rebuild,
```
- [ ] Run from `src-tauri`: `cargo build` — expect it to compile.
- [ ] Run from `src-tauri`: `cargo test -- --nocapture` — expect all tests (including existing suites) to pass.
- [ ] Commit:
```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(search): register search commands and drop index on project removal"
```

---

### Task 8: IPC facade `search` namespace

**Files:**
- Modify: `src/lib/ipc.ts` (types after `ReadResult` ~line 63; namespace after the `fs` block ~line 445)

- [ ] In `src/lib/ipc.ts`, add after the `ReadResult` type (after line 63):
```ts
export type SearchStatus = 'building' | 'ready' | 'stale'

export interface SearchHit {
  path: string
  score: number
  /** matched character positions (char indices) for highlighting */
  indices: number[]
}

export interface SearchQueryResult {
  status: SearchStatus
  total: number
  hits: SearchHit[]
}

export interface SearchIndexStatus {
  status: SearchStatus
  fileCount: number
  truncated: boolean
  /** epoch millis of last full build, or null while first build is pending */
  builtAt: number | null
}
```
- [ ] In `src/lib/ipc.ts`, add the `search` namespace to the `ipc` object immediately after the closing brace of the `fs: { ... }` block (after line 445, before `git:`):
```ts
  search: {
    query: (projectId: string, query: string, limit?: number) =>
      invoke<SearchQueryResult>('search_query', { projectId, query, limit }),
    indexStatus: (projectId: string) =>
      invoke<SearchIndexStatus>('search_index_status', { projectId }),
    rebuild: (projectId: string) => invoke<void>('search_rebuild', { projectId }),
  },
```
- [ ] Run from repo root: `pnpm typecheck` — expect no errors.
- [ ] Commit:
```bash
git add src/lib/ipc.ts
git commit -m "feat(search): add search IPC namespace and types"
```

---

### Task 9: Quick-open palette component

**Files:**
- Create: `src/components/quick-open/quick-open.tsx`

- [ ] Create `src/components/quick-open/quick-open.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, type SearchHit, type SearchIndexStatus } from '../../lib/ipc'
import { useFiles } from '../../state/files'

const LIMIT = 50
const BUILD_RETRY_MS = 300

export function QuickOpen({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const openFile = useFiles((s) => s.openFile)
  const openFiles = useFiles((s) => s.openFiles)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState(0)
  const [status, setStatus] = useState<SearchIndexStatus | null>(null)

  const stampRef = useRef(0)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Recently-opened files for this project (most-recent first), used on empty query.
  const recents: SearchHit[] = openFiles
    .filter((f) => f.projectId === projectId)
    .slice()
    .reverse()
    .map((f) => ({ path: f.path, score: 0, indices: [] }))

  const clearRetry = () => {
    if (retryRef.current) {
      clearTimeout(retryRef.current)
      retryRef.current = null
    }
  }

  const run = useCallback(
    (q: string) => {
      clearRetry()
      const stamp = ++stampRef.current
      if (!q) {
        setHits(recents)
        setSelected(0)
        return
      }
      void ipc.search
        .query(projectId, q, LIMIT)
        .then((res) => {
          if (stamp !== stampRef.current) return // drop out-of-order response
          setHits(res.hits)
          setSelected(0)
          if (res.status !== 'ready') {
            retryRef.current = setTimeout(() => run(q), BUILD_RETRY_MS)
          }
        })
        .catch(() => {
          if (stamp === stampRef.current) setHits([])
        })
    },
    [projectId, recents]
  )

  useEffect(() => {
    inputRef.current?.focus()
    void ipc.search.indexStatus(projectId).then(setStatus).catch(() => setStatus(null))
    setHits(recents)
    return clearRetry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Poll index status while it is building/stale so the footer stays live.
  useEffect(() => {
    if (!status || status.status === 'ready') return
    const t = setTimeout(() => {
      void ipc.search.indexStatus(projectId).then(setStatus).catch(() => {})
    }, BUILD_RETRY_MS)
    return () => clearTimeout(t)
  }, [status, projectId])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return
    openFile({ projectId, path: hit.path })
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(hits[selected])
    }
  }

  const footer = status
    ? status.truncated
      ? `Index truncated at ${status.fileCount.toLocaleString()} files`
      : status.status !== 'ready'
        ? 'indexing…'
        : `${status.fileCount.toLocaleString()} files`
    : ''

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex h-fit max-h-[70vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            run(e.target.value)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search files by name…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              {query ? 'No matching files' : 'Recently opened files appear here'}
            </div>
          ) : (
            hits.map((hit, i) => (
              <div
                key={hit.path}
                data-idx={i}
                onClick={() => choose(hit)}
                onMouseEnter={() => setSelected(i)}
                className={`flex cursor-pointer items-center px-4 py-1.5 text-sm ${
                  i === selected ? 'bg-accent/15' : 'hover:bg-foreground/5'
                }`}
              >
                <Highlighted path={hit.path} indices={hit.indices} />
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-1.5 text-[11px] text-muted">
          <span>{footer}</span>
          <span>↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  )
}

/** Render the path with the filename emphasized, directory dimmed, and matched
 *  characters (from `indices`) highlighted. */
function Highlighted({ path, indices }: { path: string; indices: number[] }) {
  const set = new Set(indices)
  const chars = [...path]
  const slash = path.lastIndexOf('/')
  return (
    <span className="truncate">
      {chars.map((ch, i) => {
        const isName = i > slash
        const hit = set.has(i)
        return (
          <span
            key={i}
            className={`${hit ? 'font-semibold text-accent ' : ''}${
              isName ? 'text-foreground' : 'text-foreground/45'
            }`}
          >
            {ch}
          </span>
        )
      })}
    </span>
  )
}
```
- [ ] Run from repo root: `pnpm typecheck` — expect no errors. (If ESLint flags the disable comment as unused, remove it.)
- [ ] Commit:
```bash
git add src/components/quick-open/quick-open.tsx
git commit -m "feat(search): quick-open palette component"
```

---

### Task 10: Wire the Ctrl/Cmd+P shortcut and index lifecycle in the app shell

**Files:**
- Modify: `src/app.tsx` (imports line 1 & ~line 23; keydown handler lines 88-124; add effect + render near line 355)

- [ ] In `src/app.tsx`, change the React import on line 1 to include `useState`:
```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
```
- [ ] In `src/app.tsx`, add the palette import after line 8 (`import { SettingsModal } ...`):
```tsx
import { QuickOpen } from './components/quick-open/quick-open'
```
- [ ] In `src/app.tsx`, add palette open state inside `App()`, after the `settings*` hooks (after line 54 `const toggleSettings = ...`):
```tsx
  const [quickOpen, setQuickOpen] = useState(false)
```
- [ ] In `src/app.tsx`, add a Ctrl/Cmd+P branch to the keyboard handler. Inside the `onKey` function, after line 101 (the closing of the `b`/`B` block, before `if (!selectedProject) return`), insert:
```tsx
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        if (selectedProject) setQuickOpen((v) => !v)
        return
      }
```
- [ ] In `src/app.tsx`, add an effect that keeps the active project's index built + watched, after the keyboard effect (after line 128, the `clearUnread` effect):
```tsx
  // Build + watch the search index for the selected project (and drop others).
  useEffect(() => {
    if (!isTauri || !selectedProject) return
    void ipc.search.indexStatus(selectedProject.id).catch(() => {})
  }, [selectedProject?.id])
```
- [ ] In `src/app.tsx`, add `ipc` to the existing import from `./lib/ipc` on line 23:
```tsx
import { ipc, isTauri, type Project, type TerminalRecord } from './lib/ipc'
```
- [ ] In `src/app.tsx`, render the palette. After line 355 (`<SettingsModal open={settingsOpen} onClose={closeSettings} />`), add:
```tsx
      {quickOpen && selectedProject && (
        <QuickOpen projectId={selectedProject.id} onClose={() => setQuickOpen(false)} />
      )}
```
- [ ] Run from repo root: `pnpm build` — expect a clean `tsc --noEmit` + Vite build.
- [ ] **Manual verification (Tauri dev):** run `pnpm tauri dev`; with a project selected press Ctrl/Cmd+P — palette opens focused. Type a filename fragment; results appear per keystroke with highlighted chars, filename bright, directory dimmed. Arrow keys move selection, Enter opens the file in the file pane (same as clicking in the tree), Esc closes. Empty query shows recently-opened files. Footer shows the file count (or "indexing…" right after selecting a large repo, then the count).
- [ ] Commit:
```bash
git add src/app.tsx
git commit -m "feat(search): mount quick-open with global shortcut and index lifecycle"
```

---

### Task 11: Full verification and e2e checklist

**Files:** none (verification only)

- [ ] Run from `src-tauri`: `cargo test -- --nocapture` — all tests pass (search + existing suites).
- [ ] Run from `src-tauri`: `cargo build` — clean.
- [ ] Optional (repo does not gate on it in CI, but run if available): `cargo clippy --all-targets` from `src-tauri` — no new warnings in `search`.
- [ ] Run from repo root: `pnpm build` — clean typecheck + build.
- [ ] **Manual e2e (`pnpm tauri dev`):**
  - [ ] Large real repo with `node_modules` present: open a project, press Ctrl/Cmd+P; typing yields sub-100ms results; `node_modules` / gitignored files do NOT appear; `.git` contents never appear.
  - [ ] Footer shows the correct file count; for a >200k-file tree it shows "index truncated at 200k files".
  - [ ] Create a new file on disk (outside the app) in the selected project; within ~1s it becomes findable in the palette (watcher incremental add).
  - [ ] Delete a file on disk; it stops appearing (incremental remove).
  - [ ] Edit `.gitignore` to newly ignore an existing file; after the rebuild it disappears from results.
  - [ ] Switch the selected project; searching the new project returns its files, and the previous project's watcher is released (only one active index).
  - [ ] Remove a project; no errors, its index/watcher are dropped.
  - [ ] Confirm Ctrl+P inside a focused terminal pane opens the palette rather than being swallowed by the shell (verify no xterm keybinding collision; if one exists, note it for follow-up).
- [ ] No commit (verification task). If any check fails, use superpowers:systematic-debugging before proceeding.
