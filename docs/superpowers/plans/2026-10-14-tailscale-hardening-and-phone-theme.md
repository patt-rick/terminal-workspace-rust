# Tailscale hardening, then a phone client that matches the desktop

Two pieces of work, in order. Tracked in `TODO.md` under "Remote access
(Tailscale)" and "Phone app design".

## Part A — Tailscale hardening

### A1. A bounded CLI runner (`remote/tailscale.rs`)

Add `run(bin, args, timeout) -> Result<Output, RunError>` used by every
`tailscale` call. It spawns the child with piped stdout/stderr, drains both on
reader threads (so a chatty child can't block on a full pipe), polls
`try_wait()` until the deadline, and on timeout kills the child and returns
`RunError::TimedOut { stdout, stderr }` with whatever was printed so far.

- `ip -4`, `status --json`, `serve status --json`, `serve ... off`: 5 s.
- `serve --bg --https=443 ...`: 15 s. Recent CLIs print "Serve is not enabled
  on your tailnet. To enable, visit: <url>" (same for HTTPS certs) and then
  *wait* for the user. On timeout, pull the first `https://login.tailscale.com/…`
  URL out of the captured output and return an error telling the user to open
  it and start again. Without a URL: "tailscale serve didn't answer".

### A2. Know what's on :443 before touching it

`serve_status(bin) -> ServeState` parses `tailscale serve status --json`
leniently as `serde_json::Value`:

- `{}` / empty / no `TCP."443"` and no `Web."*:443"` → `Free`.
- `Web."<host>:443".Handlers."/".Proxy == "http://127.0.0.1:<port>"` and that is
  the only handler on 443 → `Ours(port)` candidate (see A3).
- anything else on 443 (other paths, other proxy targets, TCP forward, Funnel)
  → `Taken`.
- unparseable output → `Unknown`, treated like `Taken` (never clobber what we
  can't read). The parse is a pure function with unit tests over fixture JSON.

### A3. Ownership marker, so we only remove what we installed

On a successful `serve_start(port)` write `<app_data_dir>/remote/tailscale-serve.json`
`{ "port": <port> }`. `serve_stop` runs `serve --https=443 off` **only** when the
marker exists *and* the live state is `Ours(marker.port)`; it then deletes the
marker. If the live state no longer matches (user changed it), delete the
marker and leave the config alone.

`serve_start` order: read state →
- `Free` → configure, write marker.
- `Ours(p)` with a marker for `p` (leftover from a crash) → reconfigure for the
  new port, rewrite marker.
- `Taken` / `Unknown` / `Ours` without our marker → don't touch it; return an
  error that becomes the existing plain-HTTP fallback hint: "Port 443 on this
  machine's Tailscale address is already used by another `tailscale serve`
  setup, so remote access is using plain HTTP."

The marker path needs the app data dir; `RemoteServer` resolves it once in
`new()` (`app.path().app_data_dir()`) and passes it into the tailscale calls.

### A4. Cleanup that actually runs

- `RemoteServer::stop()` keeps returning immediately for the UI command, but
  the serve teardown thread's `JoinHandle` is returned from an internal
  `stop_inner()`.
- New `RemoteServer::stop_blocking()` for `RunEvent::ExitRequested`: same as
  stop but runs `serve_stop` on the calling thread (bounded by A1's 5 s), so
  the CLI finishes before the process exits.
- At launch (setup, remote-access feature): if the marker file exists, spawn a
  thread that runs `serve_stop` — clears a front left by a crash. No CLI call
  at all when there is no marker, so non-Tailscale users pay nothing.

### A5. Pairing rate limit keyed on a trustworthy address (`server.rs`, `ratelimit.rs`)

`client_ip(headers, addr)`: honour `cf-connecting-ip` / `x-forwarded-for` only
when `addr.ip().is_loopback()` (cloudflared and `tailscale serve` both connect
from loopback; in tailnet-IP / bind-all mode the peer address is the real
client and headers are attacker-controlled). Unit test both branches.

`RateLimiter::check_at`: when the map exceeds 1024 keys, drop buckets that
would be full after refill (idle). Unit test.

### A6. Small cleanups

- `serve_start(port, &TailscaleInfo)` takes the info `start()` already
  detected — one `detect()` per start, not two.
- Replace `err.contains("HTTPS")` with matches on the specific CLI phrases
  ("does not support getting TLS certs", "HTTPS is not enabled",
  "certificates"), else report the CLI's own stderr.
- `SessionManager::validate_token`: constant-time comparison (small local
  `ct_eq` over bytes; length mismatch → false). Unit test.

Out of scope (noted, not changed): watching for the tailnet IP disappearing
while bound to it; using Tailscale identity headers; the "5 bad guesses stop
the session" behaviour.

## Part B — Phone client matches the desktop

### B1. Desktop pushes its active theme to Rust

- `ThemeProvider` (`src/themes/theme-provider.tsx`) already resolves the
  active theme in a layout effect. Add an effect: when `isTauri`, call
  `ipc.remote.setTheme(themePayload(theme))`, ignoring errors (the command is
  absent when the `remote-access` feature is off). Payload =
  `{ meta, chrome, terminal, gradients }` (no `syntax`).
- Rust command `remote_set_theme(theme: serde_json::Value)` (feature-gated,
  registered in `lib.rs`): rejects payloads over 32 KB, stores it in
  `RemoteServer` via a `tokio::sync::watch::Sender<Option<Value>>` created in
  `new()`. It works whether or not a remote session is running, so the theme
  is ready before the phone connects.

### B2. Server sends it

- `ServerCtx` gains `theme: watch::Receiver<Option<Value>>`.
- `HelloOk` gains `theme: Option<Value>` (current value).
- New `ServerMsg::StateTheme { theme: Value }` → `"state.theme"`, sent from the
  socket loop's `select!` on `theme_rx.changed()`.
- Update the wire-tag contract tests in `protocol.rs` and the TS mirror in
  `remote-web/src/protocol.ts` (`onState` gets the theme; new `onTheme`).

### B3. Phone applies it (`remote-web/src/theme.ts`)

- `applyTheme(theme)`: writes `chrome.*` as the same CSS custom properties the
  desktop uses (`--background`, `--surface`, `--surface-secondary`,
  `--surface-tertiary`, `--foreground`, `--muted`, `--accent`,
  `--accent-foreground`, `--border`, `--success`, `--warning`, `--danger`,
  `--link`, `--focus`, `--field-background`, `--field-border`, `--overlay`,
  `--backdrop`), `--gradient-app` when present, toggles `.light`/`.dark`, sets
  `color-scheme` and `<meta name="theme-color">`.
- `xtermTheme(theme)`: same mapping as the desktop's `buildXtermTheme`
  (background, foreground, cursor, cursorAccent, selection, 16 ANSI). Applied
  via `term.options.theme`; the terminal is created with the current one.
- Last theme cached in `localStorage` (try/catch) and applied before React
  renders, so the pair / connecting screens are already themed. Fallback
  defaults in CSS are Halcyon (the desktop default).

### B4. Restyle (`remote-web/src/styles.css`, components)

Visual language taken from the desktop shell:

- Page background = shell backdrop
  (`var(--gradient-app, color-mix(in srgb, var(--surface) 78%, black))`;
  light themes mix toward `--foreground` like `globals.css`).
- Top bar sits on the backdrop (no bar fill), 13px UI type, the desktop system
  font stack, terminal font `'MesloLGS NF', ui-monospace, …` as on desktop.
- Terminal lives in a rounded panel (`--radius-panel: 14px`, `bg: --background`)
  with a 10px gutter, like the desktop's centre panel.
- Buttons: `rounded-md` (6px), `border: 1px solid var(--border)`,
  hover/active `color-mix(--foreground 10%)`. Primary = `--accent` on
  `--accent-foreground`, 8px radius, semibold.
- Status dots instead of the ◐ spinner, matching `stateDotClass`: busy =
  pulsing `--warning`; attention red/amber/green = `--danger` / `--warning` /
  `--success`; idle = `--foreground` 20%.
- Drawer = the project rail: project header row (colour dot + name), terminal
  rows as 32px nav rows, active row `--foreground` 10% + accent bar; actions
  under each project as small bordered buttons with icons.
- Sheets (git, sessions) get the panel header style; the push confirm and pair
  card use the desktop dialog look (`--overlay`, 12px radius, footer strip
  `--foreground` 5%). Pair card shows the app icon (`/icon.svg`).
- Key row: compact bordered keys; ⚡ becomes a "zap" icon, arrows become
  chevron icons. Diff colours use `--success` / `--danger` / `--warning` /
  `--link` mixes instead of hard-coded rgba.
- `remote-web/src/icons.tsx`: inline SVG icons in the desktop's stroke style
  (24-unit viewBox, stroke 2, round caps): menu, git-branch, x, plus,
  terminal, sparkles (Claude), history, chevron-left/up/down/right, zap,
  upload (push).
- No layout or behaviour changes: same screens, same controls, same order.

### B5. Build artefact

Rebuild `remote-web` (`npm run build`), which regenerates
`src-tauri/src/remote/web_client.html`; commit both.

## Changes after plan review

These override the sections above where they disagree.

- **Serve lock + nonce.** Every serve operation takes one process-wide mutex.
  The marker is `{ port, nonce }`; a session's teardown passes its nonce and is a
  no-op if the marker now holds another one (a newer start won the race).
  Launch cleanup passes no nonce. `RemoteServer` keeps the pending teardown
  handle; `stop_blocking()` joins it.
- **Marker survives an unreadable state.** Delete the marker only on `Free` or a
  definite `Taken`; on `Unknown` keep it so the next launch retries.
- **Header trust by mode.** `ServerCtx.forwarded`: Cloudflare →
  `cf-connecting-ip`; Tailscale serve → rightmost `x-forwarded-for`; everything
  else → peer address. Headers are honoured only from a loopback peer.
- **Adopt the pre-upgrade leftover.** A 443 config whose only handler is
  `/ → http://127.0.0.1:<the port we're about to use>` with no Funnel and no
  marker is adopted (reconfigured, marker written). Any other foreign config is
  `Taken`, and the hint names `tailscale serve --https=443 off`.
- **Marker dir from setup's `data_dir`** (honours `TW_DATA_DIR`):
  `RemoteServer::new(app, data_dir)`.
- **One deadline for the exit path** (4 s total); the runner takes a deadline,
  not a per-call timeout.
- **Runner:** `stdin(null)`, kill → wait → join readers, look for the
  `login.tailscale.com` URL in stdout and stderr.
- **Status parsing pinned:** `TCP."443"` with only `HTTPS: true` is fine;
  `TCPForward`/`TerminateTLS` → taken; `AllowFunnel."*:443"` → taken; any `Web`
  key ending `:443`; anything 443 under `Foreground` → taken. Fixture tests.
- **Limiter:** after pruning idle buckets, if still over the cap evict the
  oldest by `last`.
- **Theme on connect** comes from the per-connection receiver's
  `borrow_and_update()`, so no duplicate `state.theme` right after `hello.ok`.
- **Phone theme:** allow-list the chrome tokens; `theme-color` is computed as the
  shell backdrop; manifest/index defaults updated to Halcyon's backdrop. Terminal
  font stack = desktop `terminal-pane.tsx`. Status dots: busy/idle as desktop,
  plus the phone's existing attention colours (it has no unread tracking).
- **Theme command** accepts only a JSON object, size measured by re-serialising.
- Also: guard concurrent `start()` calls; tear serve down if `local_addr()`
  fails after setup.

## Verification

- `cargo test` in `src-tauri` (new unit tests: serve-status parsing, ownership
  decision, runner timeout, client_ip trust, limiter pruning, ct_eq, wire tags).
- `cargo clippy` clean for touched files.
- `pnpm typecheck`, `pnpm test`; `npm run typecheck && npm run build` in
  `remote-web`.
- End-to-end: launch the app with `TW_REMOTE_AUTOSTART=8899`, open the URL in
  a phone-sized browser window, pair, and check the themed UI; switch the
  desktop theme (dark and Catppuccin Latte) and confirm the phone follows live.
- Tailscale itself is not installed on this machine: the serve logic is
  covered by unit tests over the parse/decision functions; the live CLI path
  is not exercised here.

## Docs

`CHANGELOG.md` `## [Unreleased]`: one Fixed entry for the Tailscale cleanup /
timeouts / config safety, one Changed entry for the phone redesign + live theme.
Tick the `TODO.md` items.
