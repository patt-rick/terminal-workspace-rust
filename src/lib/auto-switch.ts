// Pure selection/confirmation helpers for auto-switching the active Claude
// account when a session hits its usage limit. Kept free of Tauri/ipc imports
// so they run in plain vitest (same pattern as claude-accounts.ts).

import type { ClaudeAccountMeta, ClaudeUsage } from './ipc'

/** One account's fetched usage plus the fetch error, if any. */
export interface UsageEntry {
  usage: ClaudeUsage | null
  error?: string | null
}

/** Usage snapshots keyed by account id (undefined = never fetched). */
export type UsageById = Record<string, UsageEntry | null | undefined>

const bucketUtil = (bucket: { utilization: number } | null | undefined): number =>
  bucket?.utilization ?? 0

/** Worst window utilization; a missing bucket counts as 0 (unknown-usable). */
function windowUtil(usage: ClaudeUsage | null | undefined): number {
  return Math.max(bucketUtil(usage?.fiveHour), bucketUtil(usage?.sevenDay))
}

/** True when either window bucket is at/over quota. */
function windowExhausted(usage: ClaudeUsage | null | undefined): boolean {
  return bucketUtil(usage?.fiveHour) >= 100 || bucketUtil(usage?.sevenDay) >= 100
}

/**
 * Confirm gate: is the account actually over its limit? A window bucket at/over
 * 100, or extra-usage credits exhausted. This is the anti-self-trigger check the
 * orchestrator runs against a freshly-fetched snapshot before switching.
 */
export function isOverLimit(usage: ClaudeUsage | null | undefined): boolean {
  if (!usage) return false
  if (windowExhausted(usage)) return true
  const eu = usage.extraUsage
  return !!eu?.isEnabled && (eu.utilization ?? 0) >= 100
}

/**
 * Pick the healthiest account to switch to, or null when none qualifies.
 * Considers only accounts with a token, not refresh-dead, and not excluded
 * (active + already-tried this episode).
 *
 * A *known-healthy* account has usage that fetched cleanly (no error) with both
 * windows under quota — or extra-usage enabled, which keeps an at-limit window
 * usable. These rank by headroom = 100 - worst window utilization; ties break by
 * addedAt ascending (stable). An account whose usage is missing or came back
 * with an error is *unknown*: it ranks below every known-healthy account and is
 * only chosen as a last resort when no known-healthy candidate exists (ordered
 * by addedAt). A known account with an exhausted window is excluded outright.
 */
export function pickHealthiest(
  accounts: ClaudeAccountMeta[],
  usageById: UsageById,
  exclude: Set<string>
): { id: string } | null {
  let bestHealthy: { id: string; headroom: number; addedAt: number } | null = null
  let bestUnknown: { id: string; addedAt: number } | null = null
  for (const acct of accounts) {
    if (!acct.hasToken || acct.refreshDead || exclude.has(acct.id)) continue
    const entry = usageById[acct.id]
    const usage = entry?.usage ?? null
    const known = usage !== null && !entry?.error
    if (!known) {
      if (bestUnknown === null || acct.addedAt < bestUnknown.addedAt) {
        bestUnknown = { id: acct.id, addedAt: acct.addedAt }
      }
      continue
    }
    const extraEnabled = !!usage.extraUsage?.isEnabled
    if (!extraEnabled && windowExhausted(usage)) continue
    const headroom = 100 - windowUtil(usage)
    if (
      bestHealthy === null ||
      headroom > bestHealthy.headroom ||
      (headroom === bestHealthy.headroom && acct.addedAt < bestHealthy.addedAt)
    ) {
      bestHealthy = { id: acct.id, headroom, addedAt: acct.addedAt }
    }
  }
  if (bestHealthy) return { id: bestHealthy.id }
  if (bestUnknown) return { id: bestUnknown.id }
  return null
}

/**
 * Earliest `resetsAt` (raw ISO string) across accounts whose window is
 * exhausted — for the "all accounts out of quota, resets in …" message. Null
 * when nothing is exhausted or no reset time is known.
 */
export function earliestReset(
  accounts: ClaudeAccountMeta[],
  usageById: UsageById
): string | null {
  let bestMs: number | null = null
  let bestStr: string | null = null
  for (const acct of accounts) {
    if (!acct.hasToken || acct.refreshDead) continue
    const usage = usageById[acct.id]?.usage
    if (!usage) continue
    for (const bucket of [usage.fiveHour, usage.sevenDay]) {
      if (!bucket || bucket.utilization < 100 || !bucket.resetsAt) continue
      const t = Date.parse(bucket.resetsAt)
      if (Number.isNaN(t)) continue
      if (bestMs === null || t < bestMs) {
        bestMs = t
        bestStr = bucket.resetsAt
      }
    }
  }
  return bestStr
}
