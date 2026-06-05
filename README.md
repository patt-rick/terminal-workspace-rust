# Terminal Workspace (Rust)

A multi-project, multi-terminal workspace IDE — a **Tauri 2 + Rust** rewrite of wTerm with a
fresh React 19 frontend and a live, token-driven theming system.

Built for agent CLI workflows (`claude`, `aider`, dev servers, test watchers) but works fine as
a general terminal multiplexer with a built-in editor and git tooling.

## Features

- **Projects & terminals.** Add folders as projects; run many live terminals per project. All
  terminals stay mounted, so switching never kills your `vim` / `claude` / `npm run dev` — and
  scrollback survives navigation.
- **Agent-aware.** Background-bell notifications, sidebar unread dots, and a "working" indicator
  driven by the title spinner that agent TUIs (Claude Code) emit.
- **Session history.** Browse a project's past Claude Code sessions — read straight from Claude's
  own on-disk transcripts (`~/.claude/projects`) — and resume any of them in a fresh terminal
  (`claude --resume`), even after the original terminal is gone. Sessions that are live right now
  are flagged and focused instead of re-opened; deleting one removes its transcript from disk.
- **Files.** gitignore-aware file tree, CodeMirror 6 editor (12 languages, syntax-themed to the
  active palette), markdown preview, 5 MB text cap with binary detection.
- **Git + working-tree diff viewer.** Branch / ahead-behind / dirty status, push/publish, and a
  unified, color-coded diff of uncommitted changes (powered by libgit2).
- **GitHub.** Device-flow or PAT auth (token stored in the OS keychain), pull-request list, and
  Actions runs with re-run / cancel.
- **Theming.** Five built-in themes (Halcyon, Tokyo Night, Catppuccin Mocha/Latte, One Dark),
  live-switchable; one set of tokens drives chrome, terminal palette, and editor syntax.

## Stack

- **Rust core (Tauri 2)** — PTY (`portable-pty`), git (`git2`), GitHub (`reqwest`), token
  storage (`keyring`), gitignore listing (`ignore`), atomic JSON persistence.
- **React 19 + Vite 6 + Tailwind v4** — frontend; xterm.js 6 terminals, CodeMirror 6 editor,
  Zustand state.
- Terminal output streams over a `tauri::ipc::Channel`; everything else is `invoke` + events.

## Architecture

```
src-tauri/src/
  pty/        portable-pty manager + OSC 133 shell integration
  state/      projects/selection persistence (state.json)
  settings/   theme + editor + terminal prefs (settings.json)
  fs/         gitignore-aware listing, read/write, CRUD
  git/        info, push, working-tree diff (structured hunks)
  github/     device flow, REST client, keychain token, models
  claude/     ~/.claude session transcripts: list/summarize, resume, delete
  commands.rs #[tauri::command] handlers
src/
  themes/     token type, presets, ThemeProvider
  lib/        ipc bridge, codemirror + platform helpers
  state/      zustand stores (workspace, files, diff, settings)
  components/  sidebar, workspace (terminal/editor/markdown), right-sidebar, diff
```

State lives in the platform app-data dir. Terminals are session-scoped (their PTYs die on
quit) and are not restored; projects, selection, settings, and the GitHub token persist.

## Development

Requires Node 20+, pnpm, and Rust (MSVC toolchain on Windows + the C++ Build Tools).

```bash
pnpm install
pnpm tauri dev      # run the app with HMR
pnpm build          # typecheck + build the frontend
pnpm tauri build    # package a desktop installer
```

> **Windows note:** if `vcvars`/`link.exe` resolution is broken on your machine, the repo
> includes `src-tauri/build-msvc.cmd` (gitignored) which sets the MSVC + Windows SDK env
> explicitly. Run `& "src-tauri/build-msvc.cmd" build` from PowerShell.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘/Ctrl T | New terminal in the selected project |
| ⌘/Ctrl W | Close the active terminal (with confirmation) |
| ⌘/Ctrl B | Toggle the project sidebar |
| ⌘/Ctrl , | Open settings |
| ⌘/Ctrl S | Save the active file |
