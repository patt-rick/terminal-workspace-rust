// Pure helpers for the Claude accounts UI. Kept free of Tauri/ipc calls so
// they run in plain vitest (same pattern as claude-command.ts).

import type { ClaudeAccountMeta, ClaudeUsage } from './ipc'

/** "max_20x" -> "Max 20x"; unknown tiers title-case per segment. */
export function formatPlanName(plan: string | null): string {
  if (!plan) return ''
  return plan
    .split('_')
    .map((p) => (/^\d+x$/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

/** Active account pinned first, then by addedAt ascending. */
export function sortAccounts(
  accounts: ClaudeAccountMeta[],
  activeId: string | null
): ClaudeAccountMeta[] {
  return [...accounts].sort((a, b) => {
    if (a.id === activeId && b.id !== activeId) return -1
    if (b.id === activeId && a.id !== activeId) return 1
    return a.addedAt - b.addedAt
  })
}

/** Bar fill color by utilization tier (matches the reference thresholds). */
export function utilizationBarClass(utilization: number): string {
  if (utilization >= 100) return 'bg-red-700'
  if (utilization >= 90) return 'bg-red-500'
  if (utilization >= 70) return 'bg-orange-500'
  if (utilization >= 60) return 'bg-yellow-500'
  return 'bg-green-500'
}

/** Highest utilization across the 5h/7d windows; null when unknown. */
export function worstUtilization(usage: ClaudeUsage | null): number | null {
  if (!usage) return null
  const values = [usage.fiveHour?.utilization, usage.sevenDay?.utilization].filter(
    (v): v is number => typeof v === 'number'
  )
  return values.length ? Math.max(...values) : null
}

/** "6d 21h" / "4h" / "25m" / "now"; empty for missing/invalid input. */
export function formatResetsIn(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return ''
  const diff = t - nowMs
  if (diff <= 0) return 'now'
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

/** "just now" / "3m ago" / "2h ago" */
export function formatAgo(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs)
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}
