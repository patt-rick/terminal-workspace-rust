// Pure helpers for the Usage page. No Tauri/ipc calls, so they run in plain
// vitest (same pattern as claude-accounts.ts).

import type { ClaudeAccountUsage, UsageProject, UsageSummaryBucket } from './ipc'

export type UsagePeriod = '24h' | '7d' | '30d' | '90d'
export type UsageMetric = 'cost' | 'tokens'
export type UsageDimension = 'model' | 'project'

export const OTHER_KEY = '__other'
const TOP_SERIES = 5
const HOUR_MS = 3_600_000
const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const

/**
 * Slot i covers [b[i], b[i+1]). Days are built from calendar fields so a
 * daylight-saving day keeps its real length; hours step in milliseconds so the
 * repeated autumn hour does not produce a duplicate boundary.
 */
export function buildBoundaries(period: UsagePeriod, now: Date): number[] {
  if (period === '24h') {
    const intoHour =
      now.getMinutes() * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds()
    const start = now.getTime() - intoHour - 23 * HOUR_MS
    return Array.from({ length: 25 }, (_, i) => start + i * HOUR_MS)
  }
  const days = PERIOD_DAYS[period]
  return Array.from({ length: days + 1 }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1) + i).getTime()
  )
}

export const tokensOf = (b: UsageSummaryBucket): number =>
  b.input + b.cacheRead + b.cacheWrite + b.output

export interface UsageTotals {
  processed: number
  cachedInput: number
  uncachedInput: number
  input: number
  cacheWrite: number
  output: number
  costUsd: number
  cacheSavingsUsd: number
  responses: number
  unpricedTokens: number
  costByType: { input: number; cacheRead: number; cacheWrite: number; output: number }
}

export function totals(buckets: UsageSummaryBucket[]): UsageTotals {
  const t: UsageTotals = {
    processed: 0,
    cachedInput: 0,
    uncachedInput: 0,
    input: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    responses: 0,
    unpricedTokens: 0,
    costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  }
  for (const b of buckets) {
    t.processed += tokensOf(b)
    t.cachedInput += b.cacheRead
    t.uncachedInput += b.input + b.cacheWrite
    t.input += b.input
    t.cacheWrite += b.cacheWrite
    t.output += b.output
    t.costUsd += b.costUsd
    t.cacheSavingsUsd += b.cacheSavingsUsd
    t.responses += b.responses
    if (!b.priced) t.unpricedTokens += tokensOf(b)
    t.costByType.input += b.inputCostUsd
    t.costByType.cacheRead += b.cacheReadCostUsd
    t.costByType.cacheWrite += b.cacheWriteCostUsd
    t.costByType.output += b.outputCostUsd
  }
  return t
}

export interface UsageGroups {
  keyOf: (b: UsageSummaryBucket) => string
  labelOf: (key: string) => string
}

/**
 * Model rows group by model id. Project rows merge every source of one app
 * project into a single row; directories the app does not know stay separate.
 */
export function makeGroups(dimension: UsageDimension, projects: UsageProject[]): UsageGroups {
  if (dimension === 'model') return { keyOf: (b) => b.model, labelOf: (key) => key }
  const keys = projects.map((p, i) => (p.projectId ? `id:${p.projectId}` : `ix:${i}`))
  const labels = new Map<string, string>()
  projects.forEach((p, i) => {
    if (labels.has(keys[i])) return
    labels.set(keys[i], !p.projectId && p.distro ? `${p.label} (WSL ${p.distro})` : p.label)
  })
  return {
    keyOf: (b) => keys[b.project] ?? `ix:${b.project}`,
    labelOf: (key) => labels.get(key) ?? key,
  }
}

export function filterBuckets(
  buckets: UsageSummaryBucket[],
  groups: UsageGroups,
  key: string | null
): UsageSummaryBucket[] {
  return key === null ? buckets : buckets.filter((b) => groups.keyOf(b) === key)
}

export interface BreakdownRow {
  key: string
  label: string
  costUsd: number
  tokens: number
  /** share of the active metric, 0-1 */
  share: number
  /** cache read / all input, 0-1 */
  cacheHitRate: number
  /** USD per million priced tokens; null when nothing was priced */
  costPerMillion: number | null
  priced: boolean
}

export function breakdown(
  buckets: UsageSummaryBucket[],
  groups: UsageGroups,
  metric: UsageMetric
): BreakdownRow[] {
  const acc = new Map<
    string,
    { costUsd: number; tokens: number; pricedTokens: number; cacheRead: number; allInput: number }
  >()
  for (const b of buckets) {
    const key = groups.keyOf(b)
    const row = acc.get(key) ?? { costUsd: 0, tokens: 0, pricedTokens: 0, cacheRead: 0, allInput: 0 }
    row.costUsd += b.costUsd
    row.tokens += tokensOf(b)
    if (b.priced) row.pricedTokens += tokensOf(b)
    row.cacheRead += b.cacheRead
    row.allInput += b.input + b.cacheRead + b.cacheWrite
    acc.set(key, row)
  }
  const value = (r: { costUsd: number; tokens: number }): number =>
    metric === 'cost' ? r.costUsd : r.tokens
  let sum = 0
  for (const r of acc.values()) sum += value(r)
  return [...acc.entries()]
    .map(([key, r]) => ({
      key,
      label: groups.labelOf(key),
      costUsd: r.costUsd,
      tokens: r.tokens,
      share: sum > 0 ? value(r) / sum : 0,
      cacheHitRate: r.allInput > 0 ? r.cacheRead / r.allInput : 0,
      costPerMillion: r.pricedTokens > 0 ? (r.costUsd / r.pricedTokens) * 1_000_000 : null,
      priced: r.pricedTokens > 0,
    }))
    .sort((a, b) => value(b) - value(a) || a.label.localeCompare(b.label))
}

export interface UsageSeries {
  keys: { key: string; label: string }[]
  /** values[slot][seriesIndex] */
  values: number[][]
}

export function series(
  buckets: UsageSummaryBucket[],
  slots: number,
  groups: UsageGroups,
  metric: UsageMetric
): UsageSeries {
  const value = (b: UsageSummaryBucket): number => (metric === 'cost' ? b.costUsd : tokensOf(b))
  const sums = new Map<string, number>()
  for (const b of buckets) {
    const key = groups.keyOf(b)
    sums.set(key, (sums.get(key) ?? 0) + value(b))
  }
  const ranked = [...sums.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
  const top = ranked.slice(0, TOP_SERIES)
  const keys = top.map((key) => ({ key, label: groups.labelOf(key) }))
  if (ranked.length > TOP_SERIES) keys.push({ key: OTHER_KEY, label: 'Other' })
  const index = new Map(top.map((key, i) => [key, i]))
  const values = Array.from({ length: slots }, () => keys.map(() => 0))
  for (const b of buckets) {
    if (b.slot < 0 || b.slot >= slots) continue
    const i = index.get(groups.keyOf(b)) ?? TOP_SERIES
    values[b.slot][i] += value(b)
  }
  return { keys, values }
}

export interface PooledAccount {
  accountId: string
  utilization: number
  /** 0-100 */
  remaining: number
  resetsAt: string | null
}

export interface PooledWindow {
  accounts: PooledAccount[]
  /** mean of `remaining` across reporting accounts; null when none report */
  meanRemaining: number | null
  /** soonest future reset among accounts that have used anything */
  nextReset: { accountId: string; resetsAt: string; restores: number } | null
}

export function pooledWindow(
  usages: ClaudeAccountUsage[],
  window: 'fiveHour' | 'sevenDay',
  nowMs: number
): PooledWindow {
  const accounts: PooledAccount[] = []
  for (const u of usages) {
    const w = u.usage?.[window]
    if (!w) continue
    accounts.push({
      accountId: u.accountId,
      utilization: w.utilization,
      remaining: Math.max(0, Math.min(100, 100 - w.utilization)),
      resetsAt: w.resetsAt,
    })
  }
  if (accounts.length === 0) return { accounts, meanRemaining: null, nextReset: null }
  const meanRemaining = accounts.reduce((sum, a) => sum + a.remaining, 0) / accounts.length
  let nextReset: PooledWindow['nextReset'] = null
  for (const a of accounts) {
    if (a.utilization <= 0 || !a.resetsAt) continue
    const at = Date.parse(a.resetsAt)
    if (Number.isNaN(at) || at <= nowMs) continue
    if (nextReset && Date.parse(nextReset.resetsAt) <= at) continue
    nextReset = {
      accountId: a.accountId,
      resetsAt: a.resetsAt,
      restores: (100 - a.remaining) / accounts.length,
    }
  }
  return { accounts, meanRemaining, nextReset }
}

const trim = (n: number): string => n.toFixed(1).replace(/\.0$/, '')

export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${trim(n / 1_000)}K`
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** `ratio` is 0-1. */
export function formatPercent(ratio: number): string {
  if (ratio <= 0) return '0%'
  if (ratio < 0.01) return '<1%'
  return `${Math.round(ratio * 100)}%`
}

export function slotLabel(startMs: number, period: UsagePeriod): string {
  const d = new Date(startMs)
  return period === '24h'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
