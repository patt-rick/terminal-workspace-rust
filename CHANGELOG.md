# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow the app's
`x.y.z` tags. The top **Unreleased** section accumulates entries as work lands;
`scripts/release.mjs` stamps it with the version and date at release time.

## [Unreleased]
### Added
- The phone app now shows Claude Code terminals as a chat:
  - Your messages and Claude's replies wrap to the phone's width, and tool calls
    collapse into one-line rows you can tap open.
  - You type in a normal text box, with autocorrect and dictation.
  - Permission prompts get buttons.

  Tap the terminal icon in the top bar to switch to the raw terminal at any
  time. The desktop terminal is unchanged, and it no longer letterboxes while
  the phone is in chat.

### Fixed
- Claude notifications (needs permission, finished) keep working after
  `/clear`.

## [0.5.2] - 2026-10-15
### Changed
- The phone app (remote access) has been redesigned to match the desktop: rounded panels,
  the desktop's colours, type and icons, status dots, and a tidier key row where every key
  fits on screen. It also follows the theme you use on the desktop, including custom
  themes, and updates live when you switch.

### Removed
- The phone app's key row no longer has the predictive-typing (⚡) toggle or the PgUp/PgDn
  keys. Swipe on the terminal to scroll, including in Claude Code.

### Fixed
- Tailscale remote access no longer leaves its HTTPS address (`tailscale serve`) running
  after you quit the app or it crashes; a leftover is cleared at the next launch.
- Starting Tailscale remote access no longer overwrites or removes your own
  `tailscale serve` setup on port 443. It falls back to plain HTTP and says why.
- **Start Remote Session** no longer hangs when the Tailscale command line stops
  responding or is waiting for you to enable Serve. You get the link to enable it instead.
- Tighter limits on pairing attempts: forged forwarding headers can no longer be used to
  get around the per-device limit.

## [0.5.1] - 2026-10-14
### Added
- Drag projects in the left pane, open or collapsed, to put them in any order. The order is
  kept across restarts. A project's menu also has **Move up** and **Move down**.

### Changed
- Redesigned Claude account switcher: clearer account rows with an **Active** badge, and
  proper buttons along the bottom for Log in, Import from CLI, API keys and Usage.
- Project rows in the left pane: one highlight for what is selected, full-width project
  names (the action buttons appear on hover), a count of hidden terminals on a collapsed
  project, and a **New terminal** button on a project with none. In the minimised pane,
  each project tile shows its terminal count.
- Usage and Settings at the foot of the open left pane are labelled rows with their
  shortcuts, and show when their page is open.
- Settings → Updates: the release history fills the page.
- The app's logo shows in the title bar, next to its name.
- The status bar's terminal count covers every project, not just the selected one.
- The selected project is remembered across restarts.

### Fixed
- Collapsing or expanding the left pane no longer jumps back to the first project.
- Collapsing or expanding the left pane (or resizing the window) no longer freezes the app
  while terminals are busy. Only the terminal on screen is resized; the others catch up
  when you switch to them.

## [0.5.0] - 2026-10-13
### Added
- Linux: releases now include a `.deb` installer for Ubuntu and Debian (x86-64).
- Usage page (`Ctrl/Cmd+Shift+U`): Claude Code token and estimated-cost history by day,
  model and project over 24 hours to 90 days, plus pooled 5-hour and 7-day limits across
  accounts. History is kept for 100 days, beyond Claude Code's own transcript cleanup.
- Command palette (`Ctrl/Cmd+K` or `Ctrl/Cmd+Shift+P`): find and run any command, switch
  theme, and jump to any terminal or project.
- Keyboard settings: rebind any command by pressing the new shortcut, and choose per
  shortcut whether the app or the terminal gets the key while a terminal is focused.
- Git tab: separate Staged and Changes lists, stage and unstage files, and commit with a
  message. Commits run through git itself, so hooks and signing apply. When every change
  is staged, one button commits and pushes; Commit and Push are separate only while some
  changes are left unstaged.
- Usage page: **custom prices**. Set a model's rates per million tokens, or count it as
  another model, for models the price table does not know or where your rate differs.
- Git tab: **Write message** asks Claude for a commit message from the staged changes and
  puts it in the message field to edit. It uses the Claude Code login and saves nothing to
  the session history.
- Terminal tabs above the terminal for the selected project, with a **+** menu for a new
  terminal, a WSL terminal, Claude Code or another model.
- Status bar: the current branch and number of changed files (click to open the Git tab),
  what is left of the 5-hour limit (click to open Usage), and the terminal count.
- Project colours and icons: **Colour and icon…** in a project's menu picks a colour, uploads a
  PNG, JPEG or WebP image, or generates a random face (drawn on the device by Navii).
- What's new: after an update, the first launch shows what changed in the new version.
- Settings → Updates: **Release history** lists the notes for every past version.
- The update dialog shows the new version's release notes with formatting.

### Changed
- New look: the project list, the terminal and the right panel are rounded panels on a
  backdrop, resized by dragging the gaps between them. Themes are unchanged.
- One top bar replaces the title bar and the header. Its search box opens the command
  palette.
- The project sidebar no longer hides completely: its small state is a rail of project
  tiles. Hovering a tile shows the project's name and what each of its terminals is doing.
- Usage and Settings moved from the header to the foot of the project sidebar.
- Settings opens in the centre panel, like Usage, with the sidebars still visible. Opening
  one closes the other, and choosing a project or terminal closes both.
- The right panel's tabs are icons (Files, Git, GitHub, Sessions) with their names on hover.
- The Usage page's controls are in a bar across the top of the panel, and it closes from a
  button in its top-left corner.
- `Ctrl/Cmd+Shift+P` opens the command palette (it used to open file search, which stays on
  `Ctrl/Cmd+P`). `Ctrl/Cmd+Shift+W` no longer closes a terminal; use `Ctrl/Cmd+W`.
  Shortcuts no longer fire while Alt is held, and on macOS they need Cmd, not Ctrl.
- In a focused terminal on Windows and Linux, `Ctrl+K` now opens the palette and no longer
  reaches the shell (where it deleted to the end of the line).

### Fixed
- Pasting into a terminal with the keyboard no longer inserts the text twice.

## [0.4.2] - 2026-09-14
### Added
- Auto-switch to a healthy Claude account when a session hits its usage limit.
