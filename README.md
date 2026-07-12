# Terminal Workspace (Rust)

A multi-project, multi-terminal workspace IDE — a **Tauri 2 + Rust** rewrite of wTerm with a
React 19 frontend and a live, token-driven theming system.

Built for agent CLI workflows (`claude`, `aider`, `codex`, dev servers, test watchers) but works
fine as a general terminal multiplexer with a built-in editor and git tooling.

## Features

- **Projects & terminals.** Add folders as projects; run many live terminals per project. All
  terminals stay mounted, so switching never kills your `vim` / `claude` / `npm run dev` — and
  scrollback survives navigation. Closing a terminal kills its **entire process tree** (Windows
  Job Objects), so no orphaned dev servers.
- **Agent-aware.** Background-bell notifications, sidebar unread dots, and a "working" indicator
  driven by the title spinner that agent TUIs (Claude Code) emit. Optional Claude hooks deliver
  precise "needs permission" / "finished" badges — including push notifications to a paired phone.
- **Claude Code sessions.** Browse a project's past sessions straight from Claude's on-disk
  transcripts (`~/.claude/projects`) and resume any of them in a fresh terminal
  (`claude --resume`), even after the original terminal is gone. Live sessions are flagged and
  focused instead of re-opened; deleting one removes its transcript from disk.
- **Claude accounts.** Add multiple claude.ai accounts (OAuth or import from the CLI) and switch
  the active one app-wide, with a usage meter per account.
- **Bring-your-own-LLM keys.** Store provider API keys (Anthropic, OpenAI, Gemini, DeepSeek,
  xAI, Mistral, Groq, OpenRouter, Qwen, or any custom OpenAI-compatible endpoint) in the OS
  keychain; they're injected as env vars into every new terminal, and a model picker launches the
  matching CLI — offering to install it first if it's missing. Launch-scoped "Claude Code"
  presets can point the `claude` CLI itself at Anthropic-compatible providers (DeepSeek,
  Kimi, GLM, OpenRouter, local Ollama) without affecting other terminals. See
  [docs/multi-llm-provider-keys.md](docs/multi-llm-provider-keys.md).
- **Files.** gitignore-aware file tree, CodeMirror 6 editor (12 languages, syntax-themed to the
  active palette), markdown preview, 5 MB text cap with binary detection, and fuzzy quick-open
  (⌘/Ctrl P) backed by an incremental, watcher-refreshed index.
- **Git + working-tree diff viewer.** Branch / ahead-behind / dirty status, push/publish, and a
  unified, color-coded diff of uncommitted changes with jump-to-file (powered by libgit2).
- **Git identities.** Import GitHub accounts from the `gh` CLI and route pushes per repo: local
  `user.name`/`user.email`, an `origin` rewrite, and a credential helper that resolves the token
  at push time via `gh auth token` (never persisted). The git panel shows the push identity and
  preflight warnings before you push.
- **GitHub.** Device-flow or PAT auth (token stored in the OS keychain), pull-request list, and
  Actions runs with re-run / cancel.
- **Theming.** Six built-in themes (Halcyon, Tokyo Night, Catppuccin Mocha/Latte, One Dark,
  Black Ash), live-switchable; one set of tokens drives chrome, terminal palette, and editor
  syntax. Custom themes import/export as JSON — [docs/theme-authoring.md](docs/theme-authoring.md)
  is an LLM-ready spec for generating new ones.
- **Remote access.** Control your terminals (and view git / sessions) from a phone or another
  computer through a paired, single-session PWA web client backed by an embedded server. See
  [Remote access](#remote-access).
- **Auto-updates.** Signed updates from GitHub Releases via the Tauri updater — silent check on
  launch, one-click restart-and-install.

## Stack

- **Rust core (Tauri 2)** — PTY (`portable-pty`, ConPTY + Job Objects on Windows), git (`git2`),
  GitHub (`reqwest`), secrets (`keyring`), gitignore listing (`ignore`), fuzzy search
  (`nucleo-matcher` + debounced fs watcher), remote server (`axum`), atomic JSON persistence.
- **React 19 + Vite 6 + Tailwind v4** — frontend; xterm.js 6 terminals, CodeMirror 6 editor,
  Zustand state.
- Terminal output streams over a `tauri::ipc::Channel`; everything else is `invoke` + events.

## Architecture

```
src-tauri/src/
  pty/         portable-pty manager, OSC 133 shell integration, Job Object tree-kill
  state/       projects/selection persistence (state.json)
  settings/    theme + editor + terminal prefs (settings.json)
  fs/          gitignore-aware listing, read/write, CRUD
  git/         info, push, working-tree diff (structured hunks)
  github/      device flow, REST client, keychain token, models
  identity/    gh-account import, per-repo push routing, credential helper
  apikeys/     LLM provider keys: keychain secrets + env injection
  claude/      ~/.claude session transcripts: list/summarize, resume, delete
  search/      quick-open index (nucleo) + fs watcher
  remote/      embedded axum server, pairing, WS protocol, bridge allowlist
  commands.rs  #[tauri::command] handlers
src/
  themes/      token type, presets, ThemeProvider
  lib/         ipc bridge, codemirror + platform helpers, provider presets
  state/       zustand stores (workspace, files, diff, settings, identity)
  components/  sidebar, workspace (terminal/editor/markdown), right-sidebar
               (files/git/github/sessions), diff, quick-open, identity,
               apikeys, claude-accounts, settings-modal, title-bar
remote-web/    mobile web client (React + xterm), built to a single self-
               contained HTML file embedded in the binary at compile time
```

State lives in the platform app-data dir. Terminals are session-scoped (their PTYs die on
quit) and are not restored; projects, selection, settings, identities, and tokens persist.
Secrets (GitHub token, provider API keys) live in the OS keychain, never in JSON.

## Development

Requires Node 20+, pnpm, and Rust (MSVC toolchain on Windows + the C++ Build Tools).

```bash
pnpm install
pnpm tauri dev      # run the app with HMR
pnpm build          # typecheck + build the frontend
pnpm test           # frontend unit tests (vitest)
cargo test          # Rust tests (run inside src-tauri/)
pnpm tauri build    # package a desktop installer
```

Remote access ships enabled (`default = ["remote-access"]` in `src-tauri/Cargo.toml`); nothing
binds a socket until you start a session. Build lean with `--no-default-features` if desired.

The remote web client under `remote-web/` is a separate Vite project bundled (via
`vite-plugin-singlefile`) into `src-tauri/src/remote/web_client.html` and embedded with
`include_str!` — rebuild it there if you change the client.

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
  prompts into one dialog. An opt-in setting also runs `gh auth switch` to keep
  the `gh` CLI aligned with the selected repo.
- **GitHub** PRs and Actions target the picker-selected repo (owner/repo parsed
  from that repo's origin).

## WSL support

On Windows, terminals can run inside WSL distros, and the Claude Code integration follows them in.

- **WSL shells.** Pick a distro as the default shell for new terminals (**Settings → Terminal**),
  or open a one-off WSL terminal from a project's context menu (*New terminal — WSL \<distro\>*).
  Terminals start in the project directory as seen from inside the distro (`/mnt/c/…` for drive
  paths). Utility distros (docker-desktop and friends) are hidden from the pickers.
- **Env forwarding.** Provider API keys and terminal identification are forwarded into the distro
  automatically via `WSLENV` — no per-distro setup.
- **Claude Code inside WSL.** Sessions written by a `claude` running in a distro appear in the
  Sessions panel alongside Windows ones (tagged `WSL <distro>`); resuming one opens a terminal in
  that distro, and deleting one removes the transcript from the distro's home. Enabling attention
  hooks also installs them into every *running* distro, so an in-WSL Claude reports through the
  same badges and notifications. Stopped distros are never booted as a side effect.
- **Projects on the WSL filesystem.** Folders under `\\wsl$\<distro>\…` (or `\\wsl.localhost\…`)
  work as projects, and their new terminals default to that distro's shell.

### Limitations

- File watching over `\\wsl$` is unreliable, so the quick-open index can go stale for WSL-rooted
  projects — use *Rebuild* in the search panel.
- `git push` and identity operations on `\\wsl$` projects may hit git's `safe.directory`
  ownership check.
- Claude account switching applies to the Windows-side Claude only; a `claude` inside WSL uses
  the distro's own `~/.claude/.credentials.json`.
- WSL terminals get no OSC 133 shell integration yet; busy detection still works for TUIs that
  set window titles (e.g. Claude Code).
- A CLI that resolves through Windows interop (`/mnt/c/…` on the appended Windows PATH — e.g.
  typing `claude` in a distro where only the Windows build is installed) runs inside a *second*,
  in-box Windows 10 console host that predates years of renderer fixes, so cursor-heavy TUIs
  show the old stale-typing artifacts there. Install the CLI natively inside the distro instead
  (`curl -fsSL https://claude.ai/install.sh | bash` for Claude Code); the app's install prompts
  deliberately treat interop-only resolutions as "not installed" for this reason.

## Remote access

Control your terminals from another device through a small PWA web client (installable to a
phone home screen) served by an embedded `axum` server.

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
| ⌘/Ctrl ⇧ T | New terminal running `claude` |
| ⌘/Ctrl ⇧ D | New terminal running `claude --dangerously-skip-permissions` |
| ⌘/Ctrl W | Close the active terminal (with confirmation) |
| ⌘/Ctrl P | Quick-open file search |
| ⌘/Ctrl B | Toggle the project sidebar |
| ⌘/Ctrl ⇧ B | Toggle the right sidebar |
| ⌘/Ctrl , | Open settings |
| ⌘/Ctrl S | Save the active file (in the editor) |

## Docs

- [Theme authoring](docs/theme-authoring.md) — full token spec for building custom themes
  (written so you can hand it to an LLM and get a valid theme back).
- [Multi-LLM provider keys](docs/multi-llm-provider-keys.md) — how provider credentials are
  stored and injected into terminals.
