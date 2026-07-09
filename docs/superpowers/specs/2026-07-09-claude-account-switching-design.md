# Claude Account Switching — Design

Date: 2026-07-09
Status: approved (approach A: managed account store + credentials-file write on switch)

## Goal

Manage multiple Claude subscription (claude.ai OAuth) accounts inside the app and switch
between them easily, with per-account 5h/7d usage bars — modeled on Agent-Orchestrator's
account panel (reference repo: `C:/Users/Patrick Ackom/Desktop/repos/Agent-Orchestrator`,
an Electron app; its design is ported, not its code, except where noted).

In scope (core): OAuth login, import-from-CLI, account list with plan labels, Switch,
delete, 5h/7d usage bars with reset times, lazy token refresh, title-bar pill + popover,
Settings section, API-key row reusing the existing Providers entry.

Out of scope (deferred): load balancing across accounts, the "won't run out before reset"
forecast (needs a usage-sample history DB), Codex accounts tab, "Other AI usage" cost
tracking, per-terminal account pinning.

## Key decisions

1. **Switch writes `~/.claude/.credentials.json`** (user's explicit choice). Switching
   affects `claude` everywhere — inside the app and outside. This differs from
   Agent-Orchestrator, which only injects env per spawned session.
2. **The app owns an account store**; tokens live in the OS keychain, never in the JSON
   metadata file and never across the IPC boundary.
3. **API-key row reuses the Providers store** — no duplicate key storage. Switching to it
   enables the Anthropic provider entry; switching to a login account disables enabled
   Anthropic entries (otherwise `ANTHROPIC_API_KEY` fights the credentials file and
   "Switch" would not do what it says).
4. **Capture-back before every switch**: the CLI rotates tokens and rewrites the
   credentials file; the file is the freshest copy of the active account's tokens and
   must be re-absorbed before it is overwritten.

## Backend (Rust, `src-tauri/src/claude/`)

New files: `accounts.rs` (store), `oauth.rs` (PKCE flow), `usage.rs` (quota fetcher).
House pattern throughout: a `ClaudeAccountStore` managed by Tauri, metadata JSON at
`<app-data>/claude-accounts.json`, atomic tmp+rename persistence, `parking_lot::Mutex`,
same shape as `ApiKeyStore` / `IdentityStore`.

### Data model

Metadata (on disk, non-secret):

```rust
struct ClaudeAccount {
    id: String,            // uuid
    email: String,
    display_name: Option<String>,
    plan: Option<String>,  // raw tier, e.g. "max_20x"
    added_at: i64,         // epoch millis
    refresh_dead: bool,    // refresh token rejected -> needs re-login
}
// store-level: active_account_id: Option<String>
```

Secrets (keychain, service `com.patt-rick.terminalworkspace`, user `claude-oauth-<id>`):
one JSON blob per account holding the full `claudeAiOauth` object —
`accessToken`, `refreshToken`, `expiresAt` (epoch millis), `scopes`, `subscriptionType` —
exactly the shape found in `~/.claude/.credentials.json`, so the file can be written back
faithfully. Keychain write failures abort the save (metadata never claims a token it
doesn't have — same rule as `ApiKeyStore::save`).

The `list` command returns metadata plus derived flags only (`hasToken`, `refreshDead`,
`isActive`). Tokens are never returned to the frontend.

### Switch semantics (`claude_accounts_switch(id)`)

In order:

1. **Capture-back.** Read `~/.claude/.credentials.json`. If its `accessToken` differs
   from what the app last wrote (tracked as `last_written_access_token` alongside the
   active id), the CLI refreshed tokens. Attribute the file: call the profile endpoint
   with the file's access token → email → match a stored account → update that account's
   keychain blob. No match → ignore (log); never create accounts implicitly.
2. **Ensure fresh.** If the target's access token expires within 5 minutes, refresh it
   first, persisting the rotated pair to the keychain before proceeding.
3. **Write** the target's credentials to `~/.claude/.credentials.json` (atomic tmp+rename;
   create `~/.claude/` if missing; honor `$CLAUDE_CONFIG_DIR`). Set `active_account_id`.
4. **Disable enabled Anthropic entries** in the `ApiKeyStore` (provider == "anthropic").
   Switching **to** the API Key row instead enables that entry and leaves the file alone.

**Accepted caveat:** a claude session from the old account still running at switch time
may later rewrite the credentials file. Capture-back on every switch and usage poll
re-syncs this drift via profile attribution. No attempt is made to detect live sessions.

### Ambient env stripping

At PTY spawn (the `resolved_env()` merge point, `commands.rs:150` and
`remote/bridge.rs:101`), additionally **remove** `CLAUDE_CODE_OAUTH_TOKEN` and
`ANTHROPIC_AUTH_TOKEN` from the child env, so a stray machine-level token cannot
override the switched account. `ANTHROPIC_API_KEY` is NOT stripped — the Providers
module owns it.

### Adding accounts

`claude_accounts_add_via_oauth()` (async command):

1. Generate PKCE verifier/challenge (S256) + random state.
2. Bind `std::net::TcpListener` on an ephemeral localhost port; serve one request to
   `/callback` with a minimal hand-rolled HTTP response ("You can close this tab").
   Constant-time state comparison. 5-minute timeout. A companion
   `claude_accounts_login_cancel()` command closes the listener, failing the pending
   command cleanly.
3. Open the system browser at `https://claude.ai/oauth/authorize` with Claude Code's
   public client id (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`), scopes
   `org:create_api_key user:profile user:inference` (verify the full current set against
   the reference), `response_type=code`, `code_challenge_method=S256`,
   `redirect_uri=http://localhost:<port>/callback`, optional `login_hint`.
4. Exchange code → tokens (POST, `grant_type=authorization_code`, `code_verifier`,
   `client_id`, `state`).
5. `GET https://api.anthropic.com/api/oauth/profile` (Bearer) → email, display name,
   `plan = organization.rate_limit_tier`.
6. Upsert by email (re-login refreshes an existing record and clears `refresh_dead`),
   set active, write the credentials file (steps 3–4 of switch).

**Endpoint constants must be verified during implementation** against the reference:
`src/main/services/auth/auth-service.ts` (authorize URL, client id, scopes, profile URL)
and `src/main/services/auth/auth-token-endpoint-gateway.ts` (token endpoint URL) in the
Agent-Orchestrator repo. Do not trust this spec's memory of them.

`claude_accounts_import_cli()`: read `~/.claude/.credentials.json`, call the profile
endpoint to identify it, upsert, set active (it already IS the file's account — no file
write). This is the zero-friction first-run path.

"Log In again" on a `refresh_dead` row re-runs the OAuth flow with
`login_hint=<email>`, upserting the same record.

### Usage fetching (`claude_accounts_usage(force)`)

Per stored account:

1. Lazy refresh: if the access token expires within 5 minutes, refresh (persist rotated
   pair immediately). No background timer — the frontend's 5-minute poll is the heartbeat.
2. `GET https://api.anthropic.com/api/oauth/usage`, headers
   `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, ~5s timeout.
3. Map `five_hour` / `seven_day` / `extra_usage` → `{ utilization: 0-100, resetsAt: ISO | null }`
   (+ extra: `isEnabled`, `monthlyLimit`, `usedCredits` — cents → dollars).

Caching: per-account ~10-minute TTL in the store; `force` bypasses. Stale-while-error:
on fetch failure keep the last good data and attach an error string to the account entry.
401 → one refresh + retry. Refresh returning `invalid_grant` → `refresh_dead = true`.
The usage poll also runs the capture-back drift check (step 1 of switch) opportunistically.

Response shape returned to the frontend:

```ts
interface UsageBucket { utilization: number; resetsAt: string | null }
interface AccountUsage {
  accountId: string
  usage: { fiveHour: UsageBucket; sevenDay: UsageBucket; extraUsage?: ExtraUsage; fetchedAt: number } | null
  error: string | null
}
```

### Command surface (registered in `commands.rs` / `lib.rs`, house naming)

| Command | Action |
|---|---|
| `claude_accounts_list` | metadata + active id + derived flags |
| `claude_accounts_add_via_oauth` | full PKCE flow → upserted account, set active |
| `claude_accounts_login_cancel` | abort a pending OAuth flow |
| `claude_accounts_import_cli` | import `~/.claude` credentials as an account |
| `claude_accounts_switch` | capture-back → ensure fresh → write file → toggle providers |
| `claude_accounts_switch_to_apikey` | enable the Anthropic provider entry (id param) |
| `claude_accounts_remove` | delete keychain blob + record; active → None; file untouched |
| `claude_accounts_usage` | all-account usage rollup (cached; `force` param) |

## Frontend (React + zustand)

- `src/lib/ipc.ts`: `ipc.claudeAccounts.*` + types (`ClaudeAccountMeta`, `AccountUsage`, …).
- `src/state/claude-accounts.ts`: zustand store — accounts, activeAccountId, usage map,
  fetchedAt, loading/error, `load()`, `addViaOauth()`, `importCli()`, `switchTo(id)`,
  `switchToApiKey(id)`, `remove(id)`, `refreshUsage(force)`, poll start/stop
  (5-minute `setInterval`, running while the pill is mounted).
- `src/components/claude-accounts/`:
  - `account-pill.tsx` — title-bar pill: active account email (truncated; or "API Key",
    or "Log In" when no accounts) + health dot colored by the active account's worst
    utilization. Click toggles the popover.
  - `accounts-popover.tsx` — "Accounts (N)" header (login accounts only, matching the
    reference), rows sorted active-first then by `added_at`, API Key row synthesized from
    the Providers store (`useApiKeys`, provider == "anthropic"), footer: **Log In** (OAuth
    add), **API Key** (opens Settings → AI via `useUi().openSettings('ai')` — verify the
    exact ui-store action during implementation), Refresh button + "Updated Xm ago".
  - `account-row.tsx` — email, humanized plan (`max_20x` → "Max 20x"), Switch button
    (hidden on the active row; active row gets accent left-border), two-click delete
    confirm, 5h/7d bars + "resets in Xh" labels, "Log In again" button when `refreshDead`,
    error string as subtitle when usage fetch failed.
  - `mini-usage-bar.tsx` — 0–100 fill; color: ≥100 dark red, ≥90 red, ≥70 orange,
    ≥60 yellow, else green (reference: `usage-colors.ts`).
  - `claude-accounts-section.tsx` — Settings → AI management section reusing the same
    rows, plus Import-from-CLI button; rendered alongside the existing Claude Code section
    in `settings-modal.tsx`.
- Plan formatting + row sorting live in a pure module (`src/lib/claude-accounts.ts`)
  with vitest coverage, mirroring the `claude-command.ts` precedent.

Reference UI files (for visual/behavioral fidelity, Electron repo):
`src/renderer/src/components/ui/AccountIndicator.tsx`,
`src/renderer/src/components/ui/account/LoginAccountRow.tsx`,
`src/renderer/src/components/ui/account/MiniUsageBar.tsx`,
`src/renderer/src/lib/usage-colors.ts`, `src/renderer/src/lib/account-format.ts`.

## Error handling

- OAuth: timeout / state mismatch / exchange failure → error string surfaced in the
  popover and Settings section; flow cancellable.
- Usage: per-account errors don't fail the rollup; stale data kept and marked.
- Refresh `invalid_grant` → `refresh_dead`, UI shows "Log In again"; other refresh
  failures are transient (keep trying on later polls).
- Credentials file: parse failures on capture-back are non-fatal (skip capture, log);
  write failures fail the switch command with a clear message.
- Keychain failures abort account saves (never persist metadata without its token).

## Testing

Rust unit tests (pure helpers, house style): credentials-file JSON roundtrip,
refresh-needed predicate (expiry buffer), usage-response mapping (cents→dollars,
missing fields), drift-attribution decision (file token vs last-written), PKCE param
shape/URL building, provider-toggle selection (which entries flip on switch).
Vitest: plan-label formatting, row sorting.
OAuth/network paths stay thin over `reqwest`; exercised manually (no HTTP-mock harness
in this repo).

## Execution

Fable (this session) orchestrates and reviews; Opus 4.8 subagents implement, task by
task, per the implementation plan produced by writing-plans.
