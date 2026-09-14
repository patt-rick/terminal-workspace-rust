// Orchestrator for auto-switching the active Claude account when a `claude`
// session hits its usage limit. The Rust detector only emits a *suspicion*
// (terminals:limit-suspected); all episode/quiet-period state and timing live
// here (the detector is deliberately dumb — see the design doc).
//
// Flow per suspicion (see design "Architecture"): enroll the terminal in an
// account-keyed episode → confirm the active account is truly over limit against
// a freshly-fetched usage snapshot → one switch to the healthiest other account
// (retrying the next candidate if a switch silently fails) → relaunch each
// enrolled session in place (Esc → /exit → wait for the shell prompt → resume)
// → per-terminal quiet period so the resumed transcript repaint (which still
// shows the old limit message) does not re-trigger.

import type { UnlistenFn } from '@tauri-apps/api/event'
import { ipc, type ClaudeAccountUsage } from '../lib/ipc'
import { earliestReset, isOverLimit, pickHealthiest, type UsageById } from '../lib/auto-switch'
import { formatResetsIn } from '../lib/claude-accounts'
import { notify } from '../lib/notify'
import { applySkipPermissions } from './claude-command'
import { useClaudeAccounts } from './claude-accounts'
import { useSettings } from './settings'
import { useWorkspace } from './store'

// Esc first to dismiss any open claude menu/palette so `/exit` reaches the
// prompt, with a brief pause before typing it.
const ESC_SETTLE_MS = 150
// Recent-output tail we diff to detect the shell prompt returning.
const TAIL_BYTES = 2048
// Poll cadence and the unchanged-window that counts as "prompt is back".
const IDLE_POLL_MS = 250
const QUIESCENT_MS = 500
// Hard cap on waiting for the prompt; hitting it means we do NOT type resume.
const IDLE_CAP_MS = 15_000
// After a relaunch, ignore suspicions from that terminal for this long so the
// `claude --resume` transcript repaint doesn't re-fire the episode.
const QUIET_PERIOD_MS = 8000
// Bounded passes to drain terminals that enroll mid-relaunch; anything still
// arriving after these will re-trigger a fresh episode after deletion.
const MAX_RELAUNCH_PASSES = 3

interface Episode {
  /** Enrolled terminals — only sessions with an app-owned uuid (we only ever
   * write into those; a switch is account-global and needs no terminal). */
  terminals: Set<string>
  /** Switch targets already attempted this episode (try-each-once). */
  tried: Set<string>
  /** A switch is in flight — further suspicions just enroll and return. */
  switching: boolean
}

// Keyed by the account that hit the limit; one switch per episode.
const episodes = new Map<string, Episode>()
// terminalId -> epoch ms until which suspicions are ignored (quiet period).
const quietUntil = new Map<string, number>()

function getOrCreateEpisode(accountId: string): Episode {
  let ep = episodes.get(accountId)
  if (!ep) {
    ep = { terminals: new Set(), tried: new Set(), switching: false }
    episodes.set(accountId, ep)
  }
  return ep
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True when the terminal exists and runs an app-launched claude session (has a
 * tracked uuid) — the only terminals we may write `/exit`/resume into. */
function isWritableClaudeTerminal(terminalId: string): boolean {
  const ws = useWorkspace.getState()
  const exists = ws.projects.some((p) => p.terminals.some((t) => t.id === terminalId))
  return exists && !!ws.sessionIdByTerminal[terminalId]
}

/** Enrolled terminals that are still writable claude sessions, re-read live. */
function writableEnrolled(episode: Episode): string[] {
  return [...episode.terminals].filter(isWritableClaudeTerminal)
}

/** Drop quiet-period entries that have expired or whose terminal is gone. */
function gcQuietPeriods(): void {
  const now = Date.now()
  const ws = useWorkspace.getState()
  for (const [id, until] of quietUntil) {
    const gone = !ws.projects.some((p) => p.terminals.some((t) => t.id === id))
    if (until <= now || gone) quietUntil.delete(id)
  }
}

/** Human label for a toast: display name if set, else email, else the id. */
function accountLabel(accounts: { id: string; email: string; displayName: string | null }[], id: string): string {
  const a = accounts.find((x) => x.id === id)
  return a?.displayName || a?.email || id
}

/** Adapt the accounts store's usage map to pickHealthiest's shape, keeping the
 * per-account fetch error so unknown/errored usage isn't ranked as healthy. */
function usageMap(usage: Record<string, ClaudeAccountUsage>): UsageById {
  const out: UsageById = {}
  for (const [id, entry] of Object.entries(usage)) out[id] = { usage: entry.usage, error: entry.error }
  return out
}

/**
 * Wait for the shell prompt to return after `/exit`: the output tail must first
 * GROW past `before` (claude's exit repaint burst) and then stay UNCHANGED for
 * QUIESCENT_MS. Returns true on confirmed quiescence, false if IDLE_CAP_MS
 * elapses first (so the caller can skip resume rather than type it blindly).
 */
async function waitForShellQuiescent(terminalId: string, before: string): Promise<boolean> {
  const start = Date.now()
  let last = before
  let lastChangeAt = start
  let grown = false
  while (Date.now() - start < IDLE_CAP_MS) {
    await sleep(IDLE_POLL_MS)
    const cur = await ipc.terminals.tail(terminalId, TAIL_BYTES).catch(() => last)
    if (cur !== last) {
      last = cur
      lastChangeAt = Date.now()
    }
    if (cur !== before) grown = true
    if (grown && Date.now() - lastChangeAt >= QUIESCENT_MS) return true
  }
  return false
}

/**
 * Drive one enrolled claude terminal back onto the new account: dismiss any open
 * menu, exit `claude`, wait for the shell prompt to settle, then resume the same
 * session. Never types the resume line until quiescence is confirmed. Returns
 * false — so the caller can surface it — when the terminal isn't a writable
 * claude session or the prompt never came back within the cap.
 */
async function relaunchInPlace(terminalId: string): Promise<boolean> {
  const ws = useWorkspace.getState()
  const uuid = ws.sessionIdByTerminal[terminalId]
  if (!isWritableClaudeTerminal(terminalId) || !uuid) return false

  // Esc dismisses a claude menu/palette so `/exit` lands on the prompt.
  await ipc.terminals.write(terminalId, '\x1b').catch(() => {})
  await sleep(ESC_SETTLE_MS)
  const before = await ipc.terminals.tail(terminalId, TAIL_BYTES).catch(() => '')
  await ipc.terminals.write(terminalId, '/exit\r').catch(() => {})

  const idle = await waitForShellQuiescent(terminalId, before)
  if (!idle) return false

  // Reset the Rust detector and arm the quiet period BEFORE the resume write, so
  // the repaint of the old limit message can't re-fire this terminal.
  await ipc.terminals.resetLimitDetector(terminalId).catch(() => {})
  quietUntil.set(terminalId, Date.now() + QUIET_PERIOD_MS)

  const cmd = applySkipPermissions(
    `claude --resume ${uuid}`,
    useSettings.getState().terminal.claudeSkipPermissions
  )
  await ipc.terminals.write(terminalId, `${cmd}\r`).catch(() => {})
  return true
}

/**
 * Switch to the healthiest candidate, retrying the next one when a switch
 * silently fails (switchTo swallows errors and leaves activeAccountId
 * unchanged). Returns the id we landed on, or null on exhaustion / a raced
 * manual switch (which one is disambiguated by the caller reading the result +
 * activeAccountId). `tried` is mutated as targets are attempted.
 */
async function switchToHealthiest(episode: Episode, originalActive: string): Promise<string | null> {
  while (true) {
    const store = useClaudeAccounts.getState()
    const usageById = usageMap(store.usage)
    const target = pickHealthiest(store.accounts, usageById, new Set([...episode.tried, originalActive]))
    if (!target) {
      const reset = earliestReset(store.accounts, usageById)
      const inText = reset ? formatResetsIn(reset, Date.now()) : ''
      notify(
        'Claude auto-switch',
        inText ? `All accounts out of quota — resets in ${inText}.` : 'All accounts are out of quota.'
      )
      return null
    }
    episode.tried.add(target.id)
    await store.switchTo(target.id)
    const nowActive = useClaudeAccounts.getState().activeAccountId
    if (nowActive === target.id) return target.id
    if (nowActive === originalActive) continue // switch failed — try the next candidate
    return null // a real manual switch raced us — stand down
  }
}

async function handleLimitSuspected(terminalId: string): Promise<void> {
  if (!useSettings.getState().terminal.autoSwitchOnLimit) return

  gcQuietPeriods()
  const quiet = quietUntil.get(terminalId)
  if (quiet !== undefined && Date.now() < quiet) return

  const activeId = useClaudeAccounts.getState().activeAccountId
  if (!activeId) return

  // Enroll BEFORE the confirm await so a concurrent suspicion arriving during
  // the switch isn't dropped — but only writable claude terminals ever get
  // relaunched (a non-claude tab may still trigger the switch, never a write).
  const episode = getOrCreateEpisode(activeId)
  if (isWritableClaudeTerminal(terminalId)) episode.terminals.add(terminalId)

  // Exactly one switch per episode: the first suspicion claims it; the rest just
  // enrolled above and return.
  if (episode.switching) return
  episode.switching = true

  let terminal = false // reached a terminal outcome -> drop the episode
  try {
    // Confirm gate: force-fetch usage and only proceed if the ACTIVE account is
    // genuinely over limit. The critical anti-self-trigger check — a brittle PTY
    // match is only ever a hint.
    await useClaudeAccounts.getState().refreshUsage(true).catch(() => {})
    if (useClaudeAccounts.getState().activeAccountId !== activeId) {
      terminal = true // active changed under us; this episode is moot
      return
    }
    const activeUsage = useClaudeAccounts.getState().usage[activeId]?.usage ?? null
    if (!isOverLimit(activeUsage)) {
      terminal = true // false positive
      return
    }

    const fromLabel = accountLabel(useClaudeAccounts.getState().accounts, activeId)
    const landed = await switchToHealthiest(episode, activeId)
    if (!landed) {
      // Exhaustion already toasted; a raced manual switch is silent. Either way
      // this episode is finished.
      terminal = true
      return
    }

    // WSL: land the new account's creds in each enrolled distro before resuming
    // (no-op for non-WSL terminals). Awaited to beat the fire-and-forget distro
    // propagation, which would otherwise resume under the old account.
    for (const t of writableEnrolled(episode)) {
      await ipc.terminals.ensureWslDistroCreds(t).catch(() => {})
    }

    // Relaunch every enrolled claude terminal. Each relaunch can take seconds
    // (per-terminal quiescence cap), so a suspicion may enroll a new terminal
    // mid-loop; drain those late enrollees in bounded passes so none is orphaned
    // on the old account before the episode is deleted. No extra switch happens
    // here — the account was already switched once; these terminals just need
    // resuming onto it.
    const attempted = new Set<string>()
    const failed: string[] = []
    for (let pass = 0; pass < MAX_RELAUNCH_PASSES; pass++) {
      const batch = writableEnrolled(episode).filter((t) => !attempted.has(t))
      if (batch.length === 0) break
      for (const t of batch) {
        attempted.add(t)
        if (!(await relaunchInPlace(t))) failed.push(t)
      }
    }

    const toLabel = accountLabel(useClaudeAccounts.getState().accounts, landed)
    let msg: string
    if (attempted.size === 0) {
      msg = `Switched ${fromLabel} → ${toLabel} — resume your session manually.`
    } else {
      msg = `Switched ${fromLabel} → ${toLabel} — re-send your last message.`
      if (failed.length > 0) {
        msg += ` ${failed.length} session${failed.length > 1 ? 's' : ''} couldn't be resumed automatically.`
      }
    }
    notify('Claude auto-switch', msg)
    terminal = true
  } finally {
    episode.switching = false
    // Only drop the episode on a terminal outcome (success / exhaustion / raced
    // manual switch / false positive). Intermediate switch-failure retries live
    // inside switchToHealthiest, so `tried` is preserved across them here.
    if (terminal) episodes.delete(activeId)
  }
}

/** Register the limit-suspected listener; returns an unregister fn. */
export function registerAutoSwitch(): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false
  void ipc.terminals
    .onLimitSuspected((p) => {
      void handleLimitSuspected(p.terminalId)
    })
    .then((un) => {
      if (disposed) un()
      else unlisten = un
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}
