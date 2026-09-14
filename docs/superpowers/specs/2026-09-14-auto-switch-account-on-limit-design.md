# Auto-switch Claude account on usage limit — design

## Problem

A user working in a Terminal Workspace `claude` session who runs out of subscription
window quota (5-hour / 7-day) or extra-usage credits must currently notice the limit
message, manually switch accounts in the accounts UI, and restart their session by hand.
When the user has multiple healthy claude.ai accounts, this should happen automatically:
detect the limit, switch to a healthy account, and bring the session back with its
conversation history intact.

## Decisions (locked with the user)

- **Fully automatic.** No confirmation prompt in the happy path.
- **Behavior = switch + history restored.** The conversation transcript is restored on the
  new account; the interrupted request is **not** resubmitted (Claude Code does not resume a
  turn on `--resume`). The user re-sends their last message. We do **not** auto-retype it.
- **Detection = watch the claude PTY output**, treated as a *hint* only (see Confirmation).
- **Target = healthiest account** — most remaining headroom across both windows, per a
  freshly-fetched usage snapshot; skip `refresh_dead` and already-exhausted accounts.
- **Enablement = one global opt-in toggle**, off by default (it drives the live session).
- **Loop safety = try-each-once per episode.** Each account is attempted at most once per
  limit episode; when all are exhausted, stop and notify with the earliest reset time.

## Non-goals

- Semi-automatic / confirm-before-switch mode (may be added later; not in v1).
- Resubmitting the interrupted prompt automatically.
- Detecting limits for `claude` sessions the app did not launch, or non-`claude` CLIs.
- Any change to how limits are surfaced by Claude Code itself.

## Key mechanism decisions (from design review)

### Do not touch the PTY lifecycle — relaunch in place

Killing the terminal's process and recreating it under the same id is unsafe: the dying
reader thread removes the entry after the fact (`pty/mod.rs:677`), which would delete a
freshly re-inserted handle, and a recreated entry has no output `Channel` (the pane attaches
only on mount, `terminal-pane.tsx`), leaving the relaunched terminal invisible.

Instead, the **shell hosting `claude` survives `claude` exiting**. The orchestrator drives the
existing shell via `terminal_write`:

1. Send Claude's exit sequence (`/exit\r`).
2. Wait for the shell prompt to return (the existing OSC/title detector reports the
   terminal is idle again).
3. Write `claude --resume <uuid> [--dangerously-skip-permissions]\r` into the same shell.

Same terminal id, same channel, same cwd/env, xterm scrollback preserved, no `exit` event,
no recreate race.

### Detection is a hint; the usage API confirms

Matching Claude's limit copy in the PTY stream is inherently brittle — wording changes across
CLI versions, messages split across 8 KiB reads, and the TUI ANSI-wraps text at terminal
width. Worse, `claude --resume` repaints the prior transcript, which contains the limit
message that triggered the switch — a naive matcher re-fires and burns the whole episode.

Therefore a PTY match only *suspects* a limit. The frontend orchestrator confirms by
force-fetching the **active** account's usage (`claude_accounts_usage(force: true)`) and
proceeding only when a window bucket is `>= 100` (buckets can exceed 100) or credits are
exhausted. The orchestrator also enforces a per-terminal **quiet-period** after each relaunch
(ignoring suspicion events for those terminals for a short window) to prevent self-triggering
on the transcript repaint. The Rust detector stays simple: it emits suspicions; the
orchestrator owns all episode and quiet-period state.

### Episodes are account-scoped, not per-session

The credentials file is global and a limit is per-account. If several terminals run `claude`
on the same account, all detect the limit within seconds. A single **account-keyed** limit
episode enrolls every affected terminal, performs **one** switch, then relaunches each
enrolled terminal. This prevents N concurrent switches thrashing the credentials file.

### Orchestration lives in the frontend

Everything the orchestrator needs already exists in TypeScript: the settings toggle, the
per-terminal claude session ids (`store.ts`), the switch call (`state/claude-accounts.ts`),
forced usage fetch (`lib/ipc.ts`), terminal write (`lib/ipc.ts`), and toast UI. Rust's only
new responsibility is emitting a suspicion event from the output tap.

## Architecture

```
Rust (pty/):
  LimitDetector (stateful, ANSI-stripping, rolling tail) in OutputState::on_data
    └─ on match → emit  terminals:limit-suspected { terminalId }

Frontend (state/auto-switch.ts — new orchestrator):
  on terminals:limit-suspected(terminalId):
    if !settings.autoSwitchOnLimit: return
    activeId = accounts.activeAccountId
    usage = force-fetch usage(activeId)
    if not actually over limit: return                      # false positive
    episode = getOrCreateEpisode(activeId)                  # account-keyed
    episode.enroll(terminalId)
    if episode.switching: return                            # one switch per episode
    target = pickHealthiest(accounts, usage, excluding episode.tried ∪ activeId)
    if !target:
        toast("All accounts out of quota — resets in {earliest}"); episode.stop(); return
    episode.tried.add(target); episode.switching = true
    await accounts.switchTo(target)                         # existing, race-safe
    await ensureWslDistroCreds(enrolledWslTerminals)        # awaited (see WSL note)
    if accounts.activeAccountId != target:                  # a manual switch raced us
        episode.abort(); return
    for t in episode.terminals:
        await relaunchInPlace(t)                            # /exit → await prompt → --resume
    episode.switching = false
    startQuietPeriod(episode)                               # suppress repaint re-trigger
    toast("Switched {A}→{B} — re-send your last message")
```

### Components (each independently testable)

| Unit | Location | Responsibility | Depends on |
| --- | --- | --- | --- |
| `LimitDetector` | `pty/` (Rust) | Pure-ish stateful matcher: bytes in → optional `LimitSuspected`. ANSI-strip + rolling tail across chunks. | none (pattern only; not `detect.rs`'s OSC parser) |
| suspicion event | `pty/mod.rs` + `lib.rs` | Emit `terminals:limit-suspected { terminalId }` from the reader loop, beside the existing detect events. | Tauri emit |
| `auto-switch` orchestrator | `src/state/auto-switch.ts` | Episode state machine, target selection, drives switch + relaunch. | accounts store, usage ipc, terminal write ipc, settings |
| `pickHealthiest` | `src/lib/auto-switch.ts` | Pure selection: given accounts + usage + exclusions → target id or null; also `earliestReset`. | none (unit-tested in vitest) |
| `relaunchInPlace` | orchestrator + ipc | `/exit` → await idle → write `--resume <uuid>` for a terminal. | terminal write ipc, idle signal |
| `ensureWslDistroCreds` | Rust command | Awaited write of active creds into a terminal's WSL distro before resume. | extract of `terminal_create`'s pre-spawn distro block |
| settings toggle + toasts | settings UI + accounts UI | `autoSwitchOnLimit` flag; user-facing notifications. | `useSettings` |

## Detection details

- The matcher normalizes: strip ANSI/cursor sequences, join soft-wrapped lines, keep a
  rolling tail so a phrase split across reads still matches.
- Match a small family of loose patterns for both limit kinds (window and credits), e.g.
  "usage limit reached", "limit reached ∙ resets", "reached your usage limit", "credit
  balance is too low". Patterns live in one place and are easy to extend; a miss degrades to
  "no auto-switch", never a crash.
- A match is only a suspicion. The usage-API confirmation is the source of truth.

## Target selection (`pickHealthiest`)

- Consider only accounts with `hasToken`, not `refresh_dead`, not in `episode.tried`, and not
  the current active account.
- Headroom = `100 - max(fiveHour.utilization, sevenDay.utilization)`; require both buckets
  under 100. Respect `extra_usage.is_enabled` (an account at 100% with extra usage may still
  be usable) — treated as usable when enabled.
- Pick the maximum headroom. Ties broken by `addedAt` (stable).
- `earliestReset` = min `resets_at` across exhausted candidates, for the "all tapped" toast.

## WSL note

`activate_login_account` writes the Windows credentials file under `CredsFileLock` but
propagates to running distros fire-and-forget (`spawn_blocking`). Typing `claude --resume`
into a WSL terminal immediately after a switch can therefore race the propagation and resume
under the **old** account. `terminal_create` avoids this with an awaited pre-spawn distro
write; the in-place relaunch bypasses `terminal_create`, so we extract that awaited
"ensure distro creds for `<distro>`" into a small command and call it (awaited) before writing
the resume command for any WSL terminal.

## Edge cases & failures

- **False positive:** usage confirmation < 100 and credits fine → drop silently, no switch.
- **All accounts exhausted:** stop the episode, toast the earliest reset time.
- **Manual switch races the episode:** after `switchTo`, re-read `activeAccountId`; if it is
  not the chosen target, abort the episode (the user is now driving).
- **Session without an app-owned uuid** (`--continue` / `-c` / user-supplied `--resume`):
  relaunch with `claude --continue` (resumes most recent in cwd) as a fallback; if even that
  is unavailable, switch creds only and toast "switched — resume manually".
- **`refresh_dead` target chosen:** excluded by selection; if a switch still fails, treat the
  account as tried and continue.
- **Quiet-period:** after relaunch, suppress suspicions for the enrolled terminals long
  enough for the transcript repaint to pass.
- **Toggle off:** the detector may still run, but the orchestrator no-ops; cheap.

## Testing

- **`pickHealthiest` (vitest):** headroom math, both-bucket gating, exclusions
  (active/tried/refresh_dead/no-token), extra-usage-enabled, ties, `earliestReset`, empty →
  null.
- **`LimitDetector` (Rust unit):** match across chunk boundary; match through ANSI/soft-wrap;
  no false match on unrelated text; window vs credits classification.
- **Episode state machine (vitest):** one switch per episode across multiple enrolled
  terminals; try-each-once then stop; abort on raced manual switch; false-positive drop.
- **Existing switch/creds tests** remain green (this feature reuses that path unchanged).

## Phase 0 — spike (before implementation)

Manual, ~30 min, zero code. In two plain terminals:
1. `claude --session-id <uuid>`, converse, reach (or note the exact copy of) a limit message.
2. Exit; swap `~/.claude/.credentials.json` to another account; `claude --resume <uuid>`.
3. Observe and record: does the history resume under the new account? What `session_id` do the
   hook spool files report afterwards (does `--resume` keep the uuid or fork)? Does the
   repaint re-show the limit text? Does `/exit` / Ctrl-C work from the limited state?

Spike outcomes feed the detector patterns and confirm the resume mechanism. If cross-account
resume fails, fall back to relaunching a fresh `claude` in the same terminal with a toast
("couldn't resume — started fresh on B"); the switch still works, only continuity is lost.

## Rollout / cleanup

- The PTY detection stack is currently behind the `remote-access` feature flag. Ungate the
  output tap (or introduce a shared feature) so auto-switch does not depend on a flag named
  for remote access.
