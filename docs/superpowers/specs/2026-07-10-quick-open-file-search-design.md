# Quick-Open File Search — Design

**Date:** 2026-07-10
**Status:** Approved

## Purpose

A VS Code Ctrl+P-style quick-open: fuzzy filename/path search over the currently
selected project, with instant results as you type. There is currently no file
search of any kind in the app — the file tree (`fs_list`) is a lazy,
one-directory-at-a-time listing with no index, no watcher, and no fuzzy matcher.

## Scope

- Searches **file names/paths only** (no content search) within the **selected
  project's** root. Multi-project search and content grep are out of scope.
- Results open in the existing file viewer/editor via the `useFiles` store,
  same as clicking a file in the tree.

## Architecture

### Backend — new `src-tauri/src/search/` module

**Index.** A `SearchStore` in Tauri managed state:
`Mutex<HashMap<ProjectId, ProjectIndex>>`. Each `ProjectIndex` holds:

- a flat `Vec` of project-relative file paths (forward slashes, files only —
  directories excluded; gitignored entries excluded, unlike `fs_list` which
  shows them dimmed; `.git` always skipped),
- build status: `Building | Ready | Stale`, a build timestamp, file count, and
  a `truncated` flag.

**Build.** Triggered on project select (and by `search_rebuild`). Runs under
`tauri::async_runtime::spawn_blocking` (the established pattern used by
`fs_list` and the git commands). Uses the already-present `ignore` crate's
**parallel walker** (`WalkBuilder::build_parallel`) with gitignore /
git_global / git_exclude / parents enabled, mirroring the safety rails of
`git/discover.rs`: symlink-cycle protection and a hard cap (`MAX_FILES =
200_000`, setting `truncated: true` when hit). Walk errors (permissions etc.)
are skipped silently, as in `discover.rs`.

**Watcher.** New crate: `notify` (+ debouncing, ~500 ms coalescing window; use
`notify-debouncer-mini` or a manual coalescer). One recursive watcher per
selected project, started with the index build and stopped on project
deselect/removal:

- Create/remove/rename events are applied **incrementally** to the index,
  filtered through a cached gitignore matcher built during the walk.
- A change to any `.gitignore`/`.git/info/exclude`, or a watcher
  overflow/rescan event, triggers a full rebuild.
- If the watcher fails to start or dies, the index degrades to
  rebuild-on-palette-open with a TTL (e.g. 30 s) — search still works, just
  eventually-consistent.

**Matching.** New crate: `nucleo-matcher` (the Helix fuzzy engine). Matching
runs in Rust per query over the cached path list; 100k paths score in
single-digit milliseconds. Results are ranked by nucleo score (with its
standard path/filename bonus behavior) and returned with matched-character
indices for highlighting.

**Commands** (registered in `lib.rs`, impl in `commands.rs`, exposed through
`src/lib/ipc.ts` as a `search` namespace):

- `search_query(projectId, query, limit?) -> { status, total, hits: [{ path, score, indices }] }`
  — top ~50 by default. If the index is missing it kicks off a build and
  returns `status: "building"`.
- `search_index_status(projectId) -> { status, fileCount, truncated, builtAt }`
- `search_rebuild(projectId)`

### Frontend — `src/components/quick-open/`

- **Global shortcut** Ctrl+P / Cmd+P registered in `app.tsx`, opens the
  palette overlay for the selected project. Esc closes. The shortcut must not
  fire while focus is inside a terminal pane in a way that conflicts with
  shell keybindings — the palette opens from anywhere, but Ctrl+P is
  intercepted at the app level (consistent with how other app-level shortcuts
  behave; verify no collision with xterm keybinds during implementation).
- **Palette overlay**: input on top, results list below. Each row renders the
  filename emphasized and the directory dimmed, with matched characters
  highlighted from the `indices` payload. Arrow keys move selection, Enter
  opens via `useFiles`, click works too.
- **Empty query** shows recently-opened files (frontend-only, from the
  `useFiles` store order) — no backend call.
- **Per-keystroke querying**: invoke on every input change with a
  monotonically increasing request stamp; out-of-order responses are dropped.
  No debounce (matching is ms-fast).
- **Footer** shows index state: file count, "indexing…", or "index truncated
  at 200k files".

## Error handling

- Query while building → palette shows "indexing…" and re-invokes the current
  query on a short interval (~300 ms) until status is `ready`.
- Walk/watch errors are non-fatal and silent, matching `discover.rs`.
- Project removed/deselected → watcher stopped, index dropped.

## Testing

- Rust unit tests: index build against temp trees with `.gitignore` files
  (excluded entries, `.git` skipped, cap/truncation), incremental
  add/remove/rename updates, `.gitignore`-change rebuild trigger, matcher
  ranking sanity (filename match beats scattered path match).
- Manual/e2e: palette latency on a large real repo (with `node_modules`
  present), open-file flow, watcher picks up a newly created file.
