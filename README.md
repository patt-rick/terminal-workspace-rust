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
- **Remote access.** Control your terminals (and view git / push) from a phone or another
  computer over the web — a paired, single-session web client backed by an embedded server. See
  [Remote access](#remote-access). *(Built behind the `remote-access` cargo feature.)*

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

## Multi-repo workspaces

A project folder doesn't have to be a single git repo. When you add a folder that
contains several repositories (e.g. `~/work/` holding `amc-back/`, `amc-front/`,
`arij/`), the app discovers them all and presents them in a **repo picker** at the
top of the Git tab — the same model VS Code uses for Source Control.

- **Discovery** runs off the main thread on project open (and on demand via the
  empty-state *Rescan*). It finds every `.git` at any depth but does **not**
  descend *into* a discovered repo except to resolve its registered submodules;
  submodules appear as their own badged entries nested under the parent. Stray
  `.git` dirs inside `node_modules`/`target`/etc. are ignored, symlink loops are
  skipped, and a 10,000-directory cap guards pathological trees. The discovered
  list is cached per project in `state.json` and revalidated on project switch.
- **The whole Git tab operates on the selected repo** — branch, ahead/behind,
  the working-tree diff viewer, and push/publish. The Git tab icon shows an
  aggregate dot if *any* discovered repo is dirty, so changes in a non-selected
  repo aren't invisible. With a single repo the picker collapses to a label.
- **Identity is per-repo.** Account mappings key on the repo path, so each
  sub-repo can push as a different GitHub account; on project switch the app
  applies the right identity to every repo and batches any "which account?"
  prompts into one dialog.
- **GitHub** PRs and Actions target the picker-selected repo (owner/repo parsed
  from that repo's origin).

## Remote access

Control your terminals from another device through a small web client served by an embedded
`axum` server. It's built behind a cargo feature while the milestone series lands:

```bash
pnpm tauri dev --features remote-access      # or add it to your tauri build
```

Open **Settings → Remote Access**, pick a connectivity mode, and press **Start Remote Session**.
You get a URL + QR code and a 6-digit pairing code; scan the QR on your phone and enter the code.

### Connectivity modes

- **Quick Start (Cloudflare)** — *default.* The app runs a `cloudflared` quick tunnel and gives
  you a temporary public `https://<random>.trycloudflare.com` link each session (the link changes
  every time). No account or config. If `cloudflared` isn't on your `PATH`, the app downloads the
  official binary into app-data on first use (Windows x64 and Linux; on macOS install it with
  `brew install cloudflared`).
- **Tailscale (advanced)** — no tunnel process. Install [Tailscale](https://tailscale.com/download)
  on this PC and your phone once, sign in on both, and the app serves at your stable tailnet
  address (`http://<magicdns-or-100.x.y.z>:<port>`). Nothing is exposed to the public internet.
  Optionally bind `0.0.0.0` to also reach it over your LAN (off by default; anyone on that network
  can then reach the pairing screen).
- **This computer only** — binds `127.0.0.1`; reachable only from a browser on this machine.

### Security model

- The public tunnel URL is not a secret; access is gated by **pairing**. A successful pair returns
  a 256-bit session token and immediately consumes the one-time 6-digit code.
- Pairing codes expire after 5 minutes; 5 wrong attempts stops remote access. Codes and tokens are
  **in memory only** — never written to disk — so an app restart ends any remote session.
- **Single active session:** a new pairing evicts the previous device.
- Every remote capability goes through an explicit allowlist (`remote/bridge.rs`) — there is no
  generic command passthrough, and no filesystem or project-management access.
- The server binds `127.0.0.1` in Cloudflare/local mode and never silently binds `0.0.0.0`.

### Limitations

- One remote device at a time; a second pairing takes over.
- No adding/removing projects, no file editing, and no PR creation from the web client (yet).
- Remote sessions don't survive an app restart.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘/Ctrl T | New terminal in the selected project |
| ⌘/Ctrl W | Close the active terminal (with confirmation) |
| ⌘/Ctrl B | Toggle the project sidebar |
| ⌘/Ctrl , | Open settings |
| ⌘/Ctrl S | Save the active file |
