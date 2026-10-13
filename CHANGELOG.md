# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow the app's
`x.y.z` tags. The top **Unreleased** section accumulates entries as work lands;
`scripts/release.mjs` stamps it with the version and date at release time.

## [Unreleased]
### Added
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

### Changed
- `Ctrl/Cmd+Shift+P` opens the command palette (it used to open file search, which stays on
  `Ctrl/Cmd+P`). `Ctrl/Cmd+Shift+W` no longer closes a terminal; use `Ctrl/Cmd+W`.
  Shortcuts no longer fire while Alt is held, and on macOS they need Cmd, not Ctrl.
- In a focused terminal on Windows and Linux, `Ctrl+K` now opens the palette and no longer
  reaches the shell (where it deleted to the end of the line).

## [0.4.2] - 2026-09-14
### Added
- Auto-switch to a healthy Claude account when a session hits its usage limit.
