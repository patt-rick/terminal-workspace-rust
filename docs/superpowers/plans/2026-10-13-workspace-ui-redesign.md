# Workspace UI Redesign ("Islands") — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the app shell as floating rounded panels with one top bar, a rail/open left nav, terminal tabs, a segmented right pane and a status bar, and let each project have a colour, an uploaded icon or a generated face.

**Architecture:** The shell is plain layout and CSS over the existing stores; no theme or theme-format change. New pure modules hold every decision that can be tested without a DOM (project badge, hover lines, status items, crop maths). Project icons are small PNG files in app data, referenced from `state.json` by a lenient optional field; generated faces are drawn locally from a stored seed.

**Tech Stack:** React 19, Tailwind 4, Zustand, xterm.js 6, Vitest; Rust (serde, base64), Tauri 2 commands; `@usenavii/core` 0.9.1.

Spec: `docs/superpowers/specs/2026-10-13-workspace-ui-redesign-design.md`

**Checked before writing this plan:** `@usenavii/core@0.9.1` is on npm (MIT, no dependencies, 117 KB unminified ESM). In Node, `createAvatar(seed, { size, background: 'none' })` returned the same SVG string for the same seed, with no script and no external URL. Its `tileBg` option draws a disc, not a square, so the tile's project colour is painted by CSS behind a face rendered with `background: 'none'`.

**Run after every task:** `pnpm typecheck` and `pnpm test`; after Rust changes also `cargo test --manifest-path src-tauri/Cargo.toml`. `commands.rs`, `lib.rs` and `ipc.ts` use CRLF line endings; keep them.

---

## Files

Create:
- `src/components/shell/top-bar.tsx`, `src/components/shell/status-bar.tsx`
- `src/components/workspace/terminal-tabs.tsx`, `src/components/workspace/new-terminal-items.tsx`
- `src/components/sidebar/project-rail.tsx`, `project-tile.tsx`, `project-menu.tsx`, `project-icon-dialog.tsx`
- `src/lib/keep-focus.ts`
- `src/lib/project-status.ts` + `.test.ts`, `src/lib/project-tile.ts` + `.test.ts`
- `src/lib/status-bar.ts` + `.test.ts`, `src/lib/icon-image.ts` + `.test.ts`, `src/lib/navii.ts`
- `src/state/git-status.ts`, `src/state/project-icons.ts`
- `src-tauri/src/project_icons.rs`

Modify:
- `src/styles/globals.css`, `src/app.tsx`, `src/components/resizer.tsx`
- `src/components/sidebar/project-list.tsx`, `src/components/right-sidebar/right-sidebar.tsx`, `git-panel.tsx`
- `src/components/workspace/terminal-pane.tsx`, `file-viewer.tsx`, `src/components/diff/diff-viewer.tsx`, `src/components/usage/usage-page.tsx`
- `src/components/claude-accounts/account-pill.tsx` (only if a colour class needs the title-bar variable)
- `src/state/store.ts`, `src/state/ui.ts`, `src/lib/ipc.ts`
- `src-tauri/src/state/mod.rs`, `src-tauri/src/git/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `package.json` (one dependency), `CHANGELOG.md`

Delete: `src/components/title-bar.tsx`

---

## Task 1: Shell — backdrop, panels, gap resizers, merged top bar

- [ ] **1.1 CSS.** In `globals.css` add to `:root`: `--radius-panel: 12px; --gap-panel: 8px; --shell-backdrop: color-mix(in srgb, var(--surface) 78%, black); --panel-outline: color-mix(in srgb, var(--border) 70%, transparent);`. Add `:root.light { --shell-backdrop: color-mix(in srgb, var(--surface) 93%, var(--foreground)); }`. Add classes:

```css
.shell-root { background: var(--gradient-app, var(--shell-backdrop)); }
.panel { border-radius: var(--radius-panel); border: 1px solid var(--panel-outline); overflow: hidden; }
```

- [ ] **1.2 `src/lib/keep-focus.ts`.** `export const keepFocus = { onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() }` — spread onto shell buttons so a click does not move keyboard focus out of the terminal.
- [ ] **1.3 `Resizer`.** Width becomes `var(--gap-panel)`, background transparent, with a centred 2 px line that shows `bg-accent/40` on hover and while dragging. Props unchanged.
- [ ] **1.4 `top-bar.tsx`.** One `<header className="app-titlebar …">`, 36 px, `background: var(--gradient-title-bar, transparent)`, a three-column grid `grid-cols-[1fr_minmax(0,460px)_1fr]` so the search box stays centred.
  - Left: nav toggle (`toggleSidebar`), app icon, "Terminal Workspace", then the breadcrumb moved from `app.tsx` (project dot, name, `/`, terminal title).
  - Centre: a `<button>` styled as a field: search glyph, the selected project's name and "Search or run a command", and `useShortcutLabel('palette.toggle')` at the right. `onClick={() => runCommand('palette.toggle')}`.
  - Right: Usage, Settings, right-pane toggle (moved from `app.tsx`, same handlers, titles and disabled rule), `{isTauri && <AccountPill />}`, `<WindowControls />`.
  - Every glyph and label uses `text-[var(--title-bar-fg-dim)] hover:text-[var(--title-bar-fg)]`. Every button spreads `keepFocus`.
- [ ] **1.5 `app.tsx` layout.** Root: `shell-root flex h-screen w-screen flex-col text-foreground` (drop `bg-surface`). Render `<TopBar />`, then a row `flex min-h-0 flex-1 px-2 pb-2`. In the row: `ProjectList` + `Resizer` (when not collapsed, exactly as today for this task), the centre, then `Resizer` + `RightSidebar`. Delete the old `<header>` and `title-bar.tsx`.
  - Centre: `<main className="relative flex min-w-0 flex-1">` holding a terminal panel (`panel relative min-w-0 flex-1 bg-background`, keeps `inert={usageOpen}`), then `Resizer` + a file panel (`panel`, `inert={usageOpen}`), then `{usageOpen && <UsagePage />}`.
- [ ] **1.6 Panels.** `ProjectList` `<aside>`: replace `border-r border-border` with `panel`; remove `app-titlebar` from its header. `RightSidebar` `<aside>`: replace `border-l border-border` with `panel`. `FileViewer`, `DiffViewer`: remove any left border on their root so the panel outline is the only edge. `UsagePage` root (`absolute inset-0`): add `panel`.
- [ ] **1.7 Check in the running app** (`pnpm tauri dev`): window drags by the bar, buttons click, panels resize by the gaps, terminal refits, usage page covers the centre. Themes: Halcyon, Black Ash, Catppuccin Latte, Tokyo Night; adjust the two mixes and the outline if a panel edge is lost.

## Task 2: Terminal tabs

- [ ] **2.1 `new-terminal-items.tsx`.** `export function useNewTerminalItems(projectId: string): MenuItem[]` returning the four creation entries now built inline in `ProjectRow` (New terminal with shortcut hint, one per WSL distro, Claude Code with hint, Use other models…). Each calls `setProjectExpanded(projectId, true)` first, as today. `ProjectRow` uses it for the top of its menu.
- [ ] **2.2 `terminal-tabs.tsx`.** `TerminalTabs({ projectId })`. A 34 px strip `flex bg-surface border-b border-[var(--panel-outline)]`: a scroller (`flex min-w-0 flex-1 overflow-x-auto`, scrollbar hidden) of tabs, then a pinned "+" button that opens `ContextMenu` with `useNewTerminalItems`.
  - Tab: status dot (same three classes as the tree), title `titleByTerminal[id] || name` truncated at `max-w-48`, close button shown on hover that calls `requestTerminalClose`. Active tab: `bg-background text-foreground` and `box-shadow: inset 0 2px var(--accent)`.
  - Click: `setActiveTerminal(projectId, id)`, `clearUnread(id)`, then `window.dispatchEvent(new CustomEvent('tw:focus-terminal', { detail: id }))`. All buttons spread `keepFocus`.
  - The active tab scrolls into view when it changes (`scrollIntoView({ inline: 'nearest', block: 'nearest' })`).
- [ ] **2.3 `terminal-pane.tsx`.** In the mount effect add a `tw:focus-terminal` listener that calls `term.focus()` when `detail === terminalId`; remove it in cleanup.
- [ ] **2.4 `app.tsx`.** The terminal panel becomes a column: `{selectedProject && selectedProject.terminals.length > 0 && <TerminalTabs … />}` then a `relative min-h-0 flex-1` box that holds the `TerminalPane`s and empty states.
- [ ] **2.5 `top-bar.tsx`.** Remove the breadcrumb.

## Task 3: Left nav — rail, open, hover label, project tile

- [ ] **3.1 `src/lib/project-status.ts`, tests first.**

```ts
export type TerminalState = 'busy' | 'unread' | 'idle'
export interface HoverLine { id: string; title: string; state: TerminalState; label: string }

export function terminalState(id: string, busy: Record<string, boolean>, unread: Record<string, number>): TerminalState
export function projectBadge(ids: string[], busy: Record<string, boolean>, unread: Record<string, number>): 'busy' | 'unread' | null
export function hoverLines(
  terminals: { id: string; name: string }[],
  titles: Record<string, string>,
  busy: Record<string, boolean>,
  unread: Record<string, number>,
  max = 8
): { lines: HoverLine[]; more: number }
```

Tests: busy beats unread for one terminal; `projectBadge` is `busy` if any is busy, else `unread` if any unread, else `null`, and `null` for no terminals; `hoverLines` uses the title over the name, labels are `Working` / `New output` / `Idle`, nine terminals give eight lines and `more: 1`, none gives `{ lines: [], more: 0 }`.

- [ ] **3.2 `src/lib/project-tile.ts`, tests first.** `tileLetter(name)`: first letter or digit, upper-cased, `?` if none. `readableOn(hex)`: `'#171c28'` or `'#ffffff'` by relative luminance of a `#rrggbb` colour, `'#ffffff'` for anything unparseable. Tests cover `"  api-server"` → `A`, `"--"` → `?`, yellow → dark text, navy → white text, `"red"` → white.
- [ ] **3.3 `project-tile.tsx`.** `ProjectTile({ project, size })` (`size` 20 or 36): a rounded square (`rounded-md` at 20, `rounded-[10px]` at 36) with `background: project.color`, showing the letter in `readableOn(project.color)`. Task 5 adds the image and face.
- [ ] **3.4 `src/state/ui.ts`.** Add `renamingProjectId: string | null`, `requestRename(id)` (also sets `sidebarCollapsed` false through `useWorkspace` if it is true), `clearRename()`.
- [ ] **3.5 `project-menu.tsx`.** `useProjectMenu(project)` returns `{ items: MenuItem[]; dialogs: ReactNode }`: `useNewTerminalItems` then Rename (`requestRename`), Open in Explorer/Finder, Open in Terminal, Remove (opens the existing confirm dialog, returned in `dialogs`). `ProjectRow` uses it and starts editing when `renamingProjectId === project.id` (clearing it on commit or cancel); its double-click rename calls `requestRename` too.
- [ ] **3.6 `project-list.tsx`.** Replace the 8 px dot with `<ProjectTile size={20} />`.
- [ ] **3.7 `project-rail.tsx`.** `<aside className="panel flex w-[52px] flex-shrink-0 flex-col items-center gap-2 bg-surface py-2">`: one button per project holding `<ProjectTile size={36} />`; selected gets `ring-2 ring-foreground/80 ring-offset-2 ring-offset-[var(--surface)]`; a badge dot at the top-right from `projectBadge` (`animate-pulse bg-warning` or `bg-link`). Click `selectProject`; context menu from `useProjectMenu`. A dashed "+" button at the bottom calls `addProject`.
  - Hover label: on `mouseenter` or `focus` start a 150 ms timer, then render a `position: fixed` box at the tile's `getBoundingClientRect()` (`left: rect.right + 8`, `top: rect.top`, clamped to the window height). Content: name in `font-medium`, then `hoverLines` rows (dot, title, label in muted text), then "+N more" or "No terminals". `mouseleave`, `blur`, scroll and menu-open hide it. `pointer-events: none`, `role="tooltip"`.
- [ ] **3.8 `app.tsx`.** `sidebarCollapsed ? <><ProjectRail /><div className="w-2 flex-shrink-0" /></> : <><ProjectList /><Resizer … /></>`. The top bar's toggle is always shown (it is already in the bar).

## Task 4: Right-pane switch, shared git status, status bar

- [ ] **4.1 Rust `GitInfo.changed`.** In `src-tauri/src/git/mod.rs` add `pub changed: u32` to `GitInfo`: the number of distinct paths in the status output that `dirty` is already derived from (a path both staged and unstaged counts once). Add a unit test beside the existing ones for the counting function on a sample porcelain output with one such path. Add `changed: number` to `GitInfo` in `ipc.ts`.
- [ ] **4.2 `src/state/git-status.ts`.**

```ts
interface GitStatusState {
  infoByRepo: Record<string, GitInfo | null>
  /** One request per repo at a time; callers share the in-flight promise. */
  refresh: (repoId: string) => Promise<GitInfo | null>
}
```

`refresh` calls `ipc.git.info`, stores the result (`null` on error) and returns it.
- [ ] **4.3 `git-panel.tsx`.** Replace local `info` with `useGitStatus((s) => (selectedId ? s.infoByRepo[selectedId] : null) ?? null)`; `loadInfo` awaits `refresh(selectedId)` and keeps the local `loading` flag. Nothing else in the panel changes.
- [ ] **4.4 Store.** `store.ts`: `rightTab: 'files' | 'git' | 'github' | 'sessions'` (not persisted, starts `'files'`), `setRightTab`, and `openRightTab(tab)` which also clears `rightSidebarCollapsed` (writing the same localStorage key `toggleRightSidebar` writes).
- [ ] **4.5 `right-sidebar.tsx`.** Read the tab from the store; add a tab to `visited` in an effect when it changes. Replace the tab row with a segmented switch: a `m-2 flex rounded-lg bg-[var(--shell-backdrop)] p-0.5` container of four buttons, the active one `rounded-md bg-surface-tertiary text-foreground`, the Git one keeping its dirty dot.
- [ ] **4.6 `src/lib/status-bar.ts`, tests first.**

```ts
export interface StatusItem { id: 'branch' | 'changes' | 'limit' | 'terminals'; text: string; action: 'git' | 'usage' | null }
export function statusItems(input: {
  hasProject: boolean
  info: GitInfo | null
  fiveHourUtilization: number | null   // percent used; null when unknown or an API key is active
  terminalCount: number
}): StatusItem[]
```

Rules: no project → `[]`. `info?.isRepo` → `branch` (`info.branch ?? 'detached'`) and `changes` (`No changes`, `1 change`, `N changes`), both `action: 'git'`. Utilization known → `limit` with `5h: ${clamp(round(100 - u), 0, 100)}% left`, `action: 'usage'`. Always `terminals` (`1 terminal` / `N terminals`), `action: null`. Tests: each rule, plus utilization 130 → `0% left`.
- [ ] **4.7 `status-bar.tsx`.** A 24 px `<footer>` `flex items-center gap-4 px-3 text-[11px] text-muted`; git items left, a spacer, then limit and terminals. Items with an action are buttons (`keepFocus`, `hover:text-foreground`): `git` → `openRightTab('git')`, `usage` → `useUsage.getState().openPage()`.
  - Data: selected project, `useRepos` selection, `useGitStatus`, `useClaudeAccounts` + `useApiKeys` (the same expression the account pill uses for "API key active").
  - Effects: if `reposByProject[projectId]` is undefined call `useRepos.load(projectId)`; call `refresh(repoId)` when the selected repo changes, on window `focus`, and when a terminal of the selected project goes from busy to idle (an agent's turn just ended, which is when files change).
- [ ] **4.8 `app.tsx`.** Render `<StatusBar />` under the row and drop the row's `pb-2`.

## Task 5: Project colour and icon

- [ ] **5.1 Rust state, tests first** (`src-tauri/src/state/mod.rs`).

```rust
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectIcon {
    Image { version: u32 },
    Navii { seed: String },
}
```

`Project` gains `#[serde(default, deserialize_with = "lenient_icon", skip_serializing_if = "Option::is_none")] pub icon: Option<ProjectIcon>`, where `lenient_icon` deserializes a `serde_json::Value` and returns `serde_json::from_value(v).ok()`. New methods: `set_project_color(&self, id, color) -> AppResult<Project>` (rejects anything but `#` + six hex digits), `set_project_icon(&self, id, icon: Option<ProjectIcon>) -> AppResult<Project>`, `next_icon_version(&self, id) -> u32` (previous image version + 1, else 1). Tests: an old `state.json` without `icon` loads; `"icon": 5` and `"icon": {"kind":"nope"}` load as `None` with every project kept; colour validation; colour and icon survive a reload.
- [ ] **5.2 `src-tauri/src/project_icons.rs`, tests first.** `pub struct ProjectIconDir(pub PathBuf)`. `write(dir, id, bytes)`: id must be ASCII alphanumerics and `-`; bytes must start with the PNG signature and be at most 512 KB; write `<id>.png.tmp` then rename. `read_all(dir, ids) -> HashMap<String, String>` of `data:image/png;base64,…` for files that exist. `delete(dir, id)` ignores a missing file. Tests with `tempfile`: write then read, replace, delete, reject non-PNG, reject oversize, reject an id with a path separator.
- [ ] **5.3 Commands** (`commands.rs`, registered in `lib.rs`; `lib.rs` also manages `ProjectIconDir(data_dir.join("project-icons"))`):
  - `projects_set_color(id, color) -> AppResult<Project>`
  - `project_icon_set_image(id, bytes: Vec<u8>) -> AppResult<Project>` — write the file, then `set_project_icon(Image { version: next })`
  - `project_icon_set_navii(id, seed) -> AppResult<Project>` — seed 1–64 chars of `[A-Za-z0-9-]`; deletes any image file
  - `project_icon_clear(id) -> AppResult<Project>` — deletes any image file
  - `project_icons_load() -> HashMap<String, String>` — for projects whose icon is `Image`
  - `projects_remove` also deletes the icon file.
- [ ] **5.4 `ipc.ts`.** `export type ProjectIcon = { kind: 'image'; version: number } | { kind: 'navii'; seed: string }`; `Project.icon?: ProjectIcon | null`; the five calls under `ipc.projects`.
- [ ] **5.5 `src/lib/icon-image.ts`, tests first.** `ICON_SIZE = 128`, `MAX_SOURCE_BYTES = 10 * 1024 * 1024`, `ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']`. `checkUpload({ size, type }): string | null` returns the message to show or `null`. `cropSquare(w, h): { sx, sy, size }` centres the largest square. `async toIconPng(file: Blob): Promise<Uint8Array>` uses `createImageBitmap`, a 128 px canvas and `canvas.toBlob('image/png')`, throwing `Error('This image could not be read.')` on failure. Tests: accepted and rejected types, the 10 MB edge, crop of 400×200 → `{ sx: 100, sy: 0, size: 200 }`, 200×400, and a square.
- [ ] **5.6 Navii.** `pnpm add --save-exact @usenavii/core@0.9.1`. `src/lib/navii.ts`: `newSeed()` (`crypto.randomUUID()`), `faceDataUrl(seed, size): string | null` — `createAvatar(seed, { size, background: 'none' })` inside try/catch, returned as `data:image/svg+xml;utf8,` + `encodeURIComponent(svg)`, memoised in a `Map` keyed by `seed:size`.
- [ ] **5.7 `src/state/project-icons.ts`.** `urls: Record<string, string>`, `load()` (calls `project_icons_load`), `set(id, url)`, `remove(id)`. `load()` runs once from `app.tsx` when `isTauri`.
- [ ] **5.8 `project-tile.tsx`.** Order: `icon.kind === 'image'` and a URL is loaded → `<img>` filling the tile (`object-cover`, `alt=""`, `draggable={false}`); `icon.kind === 'navii'` and `faceDataUrl` is non-null → the face `<img>` over the colour; otherwise the letter.
- [ ] **5.9 `project-icon-dialog.tsx`.** Opened by `iconDialogProjectId` in `ui.ts` (`openIconDialog(id)`, `closeIconDialog()`), rendered once in `app.tsx`; "Change icon…" is added to `useProjectMenu` after Rename. Same frame as `ConfirmDialog` (backdrop, `rounded-xl border border-border bg-overlay`).
  - Draft state: `color`, and `icon` as `none | { kind: 'image', url, bytes? } | { kind: 'navii', seed }`, seeded from the project.
  - Body: a 64 px preview tile; the eight preset swatches plus an `<input type="color">` labelled "Custom"; "Upload image" (a hidden `<input type="file" accept="image/png,image/jpeg,image/webp">`; on change run `checkUpload` then `toIconPng`, set the draft with a preview URL made from the bytes); "Random face" (sets `{ kind: 'navii', seed: newSeed() }`; pressing again shuffles); "Remove icon".
  - Errors show as one line of `text-danger` under the buttons and leave the draft unchanged.
  - Save: `projects_set_color` if the colour changed; then by draft kind `project_icon_set_image` (only when new bytes were chosen), `project_icon_set_navii` or `project_icon_clear`; `upsertProject` with the returned project; update `project-icons` (`set` with the preview URL, or `remove`). A failure shows the message and keeps the dialog open.
  - The eight presets are exported once from a new `src/lib/project-colors.ts` and must equal `COLORS` in `state/mod.rs`.
- [ ] **5.10 `CHANGELOG.md`.** Under `## [Unreleased]`: an Added entry for project colours and icons, and a Changed entry for the new layout (one top bar with a search box, rail/open left nav, terminal tabs, segmented right pane, status bar; the sidebar's smallest state is now the rail).

## Corrections from review (these override the tasks above)

- **1.1** `.shell-root` and `.panel` go inside `@layer components`, so Tailwind utilities such as the usage page's `overflow-y-auto` still win over `.panel`'s `overflow: hidden`.
- **1.4 / 2.2 / 4.7** `keepFocus` goes only on the four controls the spec names: a terminal tab, the "+", the search box and a status item. The other top-bar buttons behave as they do today. `ContextMenu` takes Escape in the capture phase and stops it, so closing the "+" menu does not send Escape to the terminal.
- **1.4** With no project selected the search box shows only the hint.
- **2.2** A tab's close button is a sibling of the tab button, not nested in it, and is visible on `focus-visible` as well as hover.
- **3.4** `store.ts` gains `setSidebarCollapsed(collapsed)` (writes the same localStorage key); `requestRename` uses it.
- **3.7** Each rail tile is its own `RailTile` component that owns `useProjectMenu`, its menu position and its dialogs, so no hook is called in a loop. The tiles sit in an inner `min-h-0 flex-1 overflow-y-auto` box with the "+" pinned below it.
- **4.1** `dirty` comes from libgit2 `repo.statuses()`, which already has one entry per path, so `changed = statuses.len()`. The test builds a temp repo with one file both staged and modified again and expects 1.
- **4.2 / 4.3** `infoByRepo[repoId]` is `undefined` until first loaded, then `GitInfo | null`. `refresh` runs one request per repo at a time; a call made during a request queues exactly one trailing request and resolves with its result, so a caller after a stage or commit never gets pre-change data. In `GitPanel`, "loading" is `info === undefined`, and the effect is `useEffect(() => { void loadInfo() }, [loadInfo])`.
- **4.5** `visited` is initialised from the store's tab, not from `'files'`.
- **5.1** The image variant carries no version: icons are served as data URLs, so nothing would read it. The enum is `Image` | `Navii { seed }`, serialised as `{"kind":"image"}`. `add_project` sets `icon: None`.
- **5.3** Add a Rust test that `project_icons::delete` after `write` leaves no file; `projects_remove` calls it. Image bytes cross the bridge as `number[]` (`Array.from(bytes)`), like `fs_save_temp_paste`.
- **5.9** The preview is a `data:` URL built from the PNG bytes, never a `blob:` URL, because it is kept in `project-icons` after the dialog closes.
- **Files** also create `src/lib/project-colors.ts`.

## Final checks

- [ ] `pnpm typecheck`, `pnpm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm build`.
- [ ] In the running app on the four themes: drag by the bar; typing lands in the terminal after clicking a tab, the "+", the search box and a status item; both nav states and the hover label; tab overflow; the Git tab opens from the status bar with the pane collapsed; upload PNG, JPEG and WebP; shuffle faces; restart and see icons and colours kept.
- [ ] Code review by a Fable subagent (owner rule for a big feature); fold findings in.
