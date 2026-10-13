# Workspace UI redesign ("Islands") — design

A new look for the app's shell: floating rounded panels, one top bar with a search box, a
left nav that opens and closes, terminal tabs, and a status bar. It also lets the user give
each project a colour or an icon. Chosen by the owner on 2026-10-13 from four mocked
directions (option B, with the search box, terminal tabs and status bar of option A).

Mock-ups: https://claude.ai/artifact/RSA32NwwsExQdfnCHHiLzc (option B, open and closed).

**Status:** proposed, awaiting owner approval. Nothing here is built.

## Problem

The shell is three flat columns divided by lines, under two stacked bars (a 32 px title bar
and a 44 px header). Terminals can only be switched from the project tree, so collapsing the
left sidebar removes the only terminal switcher. A project is identified by an 8 px colour
dot that the user cannot change. There is no place for at-a-glance state such as the branch
or the usage limit.

## Hard constraints

- **Themes are not touched.** No preset changes and no new fields on `Theme`
  (`src/themes/types.ts`). Every new colour is derived in CSS from the existing tokens, so
  built-in and custom themes work unchanged.
- **The centre stays the terminal** (owner rule, 2026-10-13). Supporting UI goes in the top
  bar, the left nav, the right pane and the status bar.
- **Every action reachable today stays reachable.** Two things change on purpose: the left
  sidebar's smallest state becomes the rail (it can no longer be hidden completely), and the
  "project / terminal" breadcrumb goes once the tabs exist.

## Decisions

### Shell

- **Panels float on a backdrop.** The window paints a backdrop; the left nav, the centre and
  the right pane are separate cards on it with an 8 px gap and a 12 px corner radius. The
  dividing lines between columns go away.
- **The app's root element paints the backdrop**, as
  `var(--gradient-app, var(--shell-backdrop))`. Today the root is `bg-surface`
  (`src/app.tsx:235`) and covers the gradient that `body` paints, so a theme's
  `gradients.app` is not visible anywhere; with this change it becomes the backdrop.
- **Backdrop colour is derived, not themed.** On dark themes `--shell-backdrop` is `surface`
  mixed toward black; on light themes (the root has `.light`) it is `surface` mixed a little
  toward `foreground`. The left nav and right pane cards use `surface`; the centre card uses
  `background`, as the terminal does today.
- **Every card has an outline** from the `border` token. On a near-black theme the backdrop
  cannot get darker than the cards, and over a gradient the backdrop may be lighter than
  them, so the outline, not the colour difference, is what always separates a card. Cards
  stay solid over a gradient.
- **The mixes and the outline are tuned during the build on four themes** that cover the
  hard cases: Halcyon (default), Black Ash (near-black), Catppuccin Latte (light) and Tokyo Night
  (gradient).
- **Margins.** The row of cards has an 8 px margin at the sides. The top bar and the status
  bar sit directly on the backdrop and are not cards.
- **Two shared CSS variables**, `--radius-panel` and `--gap-panel`, in
  `src/styles/globals.css`. Dialogs, the settings modal and the usage page keep their
  current styling; restyling them is out of scope.
- **Resizing uses the gaps.** `Resizer` becomes an invisible handle that fills the gap
  between two cards and shows the accent tint on hover and drag. Widths, limits and stored
  keys do not change. The left nav has no handle while it is a rail.
- **Shell controls do not take keyboard focus from the terminal.** The terminal refocuses
  only when its `active` flag changes (`terminal-pane.tsx`), so a click on the active tab,
  the "+", the search box or a status item would leave focus on a button. These controls
  cancel the focus change on mouse-down, and selecting a tab focuses its terminal. They
  remain reachable by keyboard.

### Top bar

- **One bar replaces two.** `TitleBar` and the `<header>` in `src/app.tsx` merge into a
  single 36 px bar that is also the window drag region. It keeps the `.app-titlebar` class,
  the `gradients.titleBar` background and the `--title-bar-fg` text colours, and every
  button moved into it uses those colours, so the two title-bar theme options keep working.
  The "Projects" header of the left nav stops being a drag region.
- **Left:** the left-nav toggle, the app icon and the app name.
- **Centre:** a search box showing the selected project's name, the hint "Search or run a
  command" and the palette's current shortcut label. Clicking it runs `palette.toggle`. It
  is a button styled as a field, not an input: typing happens in the palette. With no
  project selected it shows only the hint.
- **Right:** Usage, Settings, the right-pane toggle, the account pill, the window controls.
  These are today's buttons, moved.
- **The "project / terminal" breadcrumb is dropped in step 2**, when the tabs arrive. The
  project is named in the search box and the terminal in its tab. Step 1 keeps the
  breadcrumb in the bar, after the app name.
- **The bar renders outside Tauri too.** `TitleBar` returns nothing in a browser today; the
  merged bar always renders because it now holds the app's buttons. `WindowControls` already
  hides itself outside Tauri, and the account pill, which polls the Rust core, is hidden
  there as well.

### Left nav

- **Two states: open and rail.** `view.toggleSidebar` and its button switch between them.
  The stored flag `tw:sidebar-collapsed` keeps its key and now means "rail". There is no
  fully hidden state.
- **Rail** (52 px): one 36 px tile per project, an add-project button at the bottom.
  - The selected project's tile has a ring.
  - A tile carries a status badge: pulsing `warning` if any of its terminals is busy,
    otherwise `link` if any has unread output, otherwise none. These are the signals the
    tree shows per terminal today (`busyByTerminal`, `unreadByTerminal`).
  - Click selects the project. Right-click opens the project menu used in the open state.
    The menu, the rename field and the remove confirmation live inside `ProjectRow` today;
    they move into a shared piece that both states use. "Rename" chosen from the rail opens
    the nav and starts the inline rename there.
  - **Hover shows a label** after a short delay: the project's name, then one line per
    terminal with its status dot, its title and its state in words ("Working", "New
    output" or "Idle"). A project with no terminals says "No terminals". Past eight
    terminals the label shows the first eight and "+N more". The label is positioned to the
    right of the tile and is also shown on keyboard focus.
- **Open**: today's tree in a card (project rows, terminals nested under them, the same
  buttons and menus). The colour dot becomes a 20 px project tile.
- **Project tile** is one component used in both states: the uploaded image, or the
  generated face, or the project's colour with the first letter of its name.

### Terminal tabs

- **A tab strip sits at the top of the centre card** and lists the selected project's
  terminals. Each tab shows the status dot (busy, unread, idle), the title
  (`titleByTerminal` or the terminal's name) and a close button on hover. The active tab has
  an accent line along its top edge.
- **A "+" button at the end** opens a menu with the creation items the project menu has
  today: New terminal, one entry per WSL distro, Claude Code, Use other models.
- **Closing goes through the existing confirmation** (`requestTerminalClose`).
- **Too many tabs scroll horizontally**; the "+" stays pinned at the right.
- **The tree keeps listing terminals** when the nav is open. That is how another project's
  busy and unread state stays visible.
- **With no project selected, or no terminals, the strip is not drawn** and the existing
  empty states show as they do today.
- Not in this version: dragging to reorder, renaming from a tab, splitting.

### File pane and usage page

- The file viewer and diff viewer stay to the right of the terminal and become their own
  card. The gap between the two cards is the resize handle.
- The usage page appears in the centre area in place of the tab strip, the terminal and the
  file card, all of which are `inert` while it is open (today the terminal and file
  wrappers are). Its contents are not restyled.

### Right pane

- A card. The four underlined tabs become a **segmented switch** (Files, Git, GitHub,
  Sessions). The Git item keeps its uncommitted-changes dot. Panels stay mounted after their
  first visit, as now.
- **The selected tab moves into the workspace store.** It is local state in `RightSidebar`
  today, so nothing outside the pane can open a tab. The status bar needs to.

### Status bar

A 24 px strip on the backdrop at the bottom, in muted small text. Each item is a button that
opens the place where the value comes from. An item whose value is not known is not drawn;
with no project selected the strip is empty but keeps its height.

| Item | Shows | Click opens |
|---|---|---|
| Branch | current branch of the selected repo | Git tab |
| Changes | number of distinct changed paths in the selected repo | Git tab |
| Limit | the active account's 5-hour window, as "5h: 62% left" | Usage page |
| Terminals | count for the selected project | nothing |

- **Limit** reads `useClaudeAccounts`, which the account pill already polls. It is absent
  when an API key is active or no account is signed in.
- **"Git tab" means:** open the right pane if it is collapsed, then select the Git tab.
- **Branch and Changes need a shared source that does not exist yet.** The branch is local
  state in `GitPanel` and the file lists are local state in `GitChanges`; both load only
  once the Git tab has been visited with the pane open, and nothing polls. `repos.ts` holds
  the repo list, the selection and a dirty flag per repo, but no branch or counts. This
  design adds a per-repo status (branch, changed paths) to shared state, loaded with the
  existing git status command. It is refreshed when the selected project or repo changes,
  when the window regains focus, and after every action in the Git tab that changes it
  (stage, unstage, commit, push, refresh). The Git panel reads the same copy. No timer is
  added.

### Project colour and icon

- **Colour.** The user picks from the eight preset colours (`COLORS` in
  `src-tauri/src/state/mod.rs`) or any colour through the system colour picker. New command
  `projects_set_color`. The colour is the tile's background when the project has no icon,
  and is used wherever the dot is used today. The command accepts only `#rrggbb`, because
  the value is written into styles here and in the remote web client.
- **Uploaded image.** The user picks a PNG, JPEG or WebP file through a file input in the
  dialog. (The dialog plugin returns only a path, and the app has no file-system plugin or
  asset protocol to read it with; a file input hands the webview the bytes directly.) SVG
  is not accepted: drawing one to a canvas is unreliable across the three webviews. The
  webview draws the image to a canvas, crops the centre square, scales it to 128 × 128 and
  exports a PNG, so what is stored is always a small PNG. The bytes go to a new command
  that writes
  `<app data>/project-icons/<project id>.png` through a temp file and a rename. A source
  file over 10 MB, or one that fails to decode, is rejected with a message; nothing is
  written.
- **Generated face (Navii).** A "Random face" button picks a new seed on each press and
  shows the face; saving stores only the seed. The face is rendered locally by the
  `@usenavii/core` package (MIT, no runtime dependencies per its docs), so it works offline
  and no request names the user's projects. The package is pinned to an exact version,
  because a major release may change which face a seed gives. The SVG string is shown
  through an `<img>` data URL, never inserted as markup.
  - **The face is drawn on the project's colour** (owner decision, 2026-10-13), through
    Navii's tile-background option, so a project keeps its colour whichever icon it has and
    changing the colour re-tints the tile.
  - This is from Navii's documentation; the package has not been installed or run. The plan
    starts by confirming it exists on npm and renders as documented. If it does not, the
    fallback is one request per chosen seed to `https://api.navii.dev/avatar/<seed>.svg`
    from Rust (`reqwest` is already a dependency), with the SVG saved beside the uploaded
    icons.
- **Stored shape.** `Project` gains an optional `icon`:
  `{ kind: 'image', version }` or `{ kind: 'navii', seed }`. `version` is a counter bumped
  on each upload so the webview does not show a stale image. Image bytes are never put in
  `state.json`, which is rewritten on every change.
- **The field must never break loading.** `state.json` is read with a fallback to defaults
  (`state/mod.rs:72`, `:329-332`), so one value that fails to parse would silently drop
  every project. `icon` therefore defaults when missing and reads as "no icon" when it is
  malformed, instead of failing the file. An older build ignores the field and drops it on
  its next save; the project then shows its colour tile again, which is accepted.
- **Loading images.** No asset protocol is configured, so a new command returns the stored
  icons as data URLs, read once at start-up and again for one project after an upload.
- **Where it is edited.** "Change icon…" in the project menu opens a small dialog: a preview
  tile, the colour swatches, Upload image, Random face, and Remove icon. Save applies,
  Cancel discards.
- **Removing a project deletes its icon file.**

## Architecture

```
src/styles/globals.css                 --shell-backdrop, --radius-panel, --gap-panel
src/components/shell/top-bar.tsx       merged bar: nav toggle, search box, buttons, pill, controls
src/components/shell/status-bar.tsx    renders items from lib/status-bar.ts
src/components/shell/panel.tsx         the card wrapper (radius, outline, overflow)
src/components/sidebar/project-rail.tsx    rail state of the left nav
src/components/sidebar/project-list.tsx    open state (existing, restyled)
src/components/sidebar/project-tile.tsx    image / face / colour-and-letter
src/components/sidebar/project-actions.tsx menu, rename and remove, shared by both nav states
src/components/sidebar/project-icon-dialog.tsx
src/components/workspace/terminal-tabs.tsx
src/lib/project-status.ts              projectBadge(terminals, busy, unread), hover lines    (pure)
src/lib/status-bar.ts                  statusItems(...) -> items to draw                      (pure)
src/lib/icon-image.ts                  crop rectangle and size checks for an upload           (pure)
src/state/project-icons.ts             data URLs by project id
src/state/git-status.ts                branch and changed paths per repo, shared by bar and Git tab
src-tauri/src/state/mod.rs             Project.icon, set_color, set_icon
src-tauri/src/project_icons.rs         write, read and delete icon files
```

`src/components/title-bar.tsx` is removed. `src/app.tsx` loses its header and keeps the
layout, which becomes: top bar, a row of cards, status bar.

## Build order

Each step leaves the app working and can be released by itself.

1. **Shell.** Backdrop, cards, gap resizers, the merged top bar with the search box. The
   breadcrumb stays in the bar.
2. **Terminal tabs.** The breadcrumb goes.
3. **Left nav.** Rail and open states, hover label, the project tile (colour and letter).
4. **Right pane switch and status bar**, including the shared git status and the right-pane
   tab moving into the store.
5. **Project colour and icon.** Colour picker, upload, Navii face.

## Error handling

- An icon file that is missing or unreadable falls back to the colour tile; nothing is
  reported.
- A failed upload or save shows the reason in the dialog and leaves the previous icon.
- A Navii seed that fails to render falls back to the colour tile.
- A status-bar item whose source errors is not drawn.

## Testing

- **Unit (vitest):** `projectBadge` and the hover label's lines, including the cap at eight; `statusItems` for each
  missing-value case; the crop and size checks in `icon-image.ts`.
- **Rust (cargo test):** a `state.json` written before this change loads with no icon;
  a malformed `icon` value loads as no icon and keeps every project; `set_color` rejects
  anything but `#rrggbb`; `set_color` and `set_icon` persist and reload; icon write, replace and delete; removing a
  project removes its file.
- **By hand, in the running app:** every step on Halcyon, Black Ash, Catppuccin Latte and Tokyo Night;
  the window dragged by the top bar and its buttons still clickable; typing lands in the
  terminal after clicking a tab, the "+", the search box and a status item; both nav states;
  tab overflow; an upload of each file type.

## Not in this version

Changes to themes or the theme format; restyling dialogs, settings or the usage page; the
remote web client (`remote-web/` has its own UI); reordering tabs or projects by dragging;
a fully hidden left nav; project icons in the command palette.

## Owner decisions (2026-10-13)

- **The rail is the left nav's smallest state.** No fully hidden state.
- **Projects keep their colours.** A generated face is drawn on the project's colour.
- **The hover label is descriptive:** it lists each terminal with its status.
