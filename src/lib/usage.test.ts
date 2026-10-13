import { describe, expect, it } from 'vitest'
import {
  OTHER_KEY,
  breakdown,
  buildBoundaries,
  filterBuckets,
  formatPercent,
  formatTokens,
  formatUsd,
  makeGroups,
  pooledWindow,
  series,
  totals,
} from './usage'
import type { ClaudeAccountUsage, UsageProject, UsageSummaryBucket } from './ipc'

const bucket = (over: Partial<UsageSummaryBucket>): UsageSummaryBucket => ({
  slot: 0,
  model: 'opus',
  project: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  costUsd: 0,
  inputCostUsd: 0,
  cacheReadCostUsd: 0,
  cacheWriteCostUsd: 0,
  outputCostUsd: 0,
  cacheSavingsUsd: 0,
  priced: true,
  responses: 0,
  ...over,
})

const projects: UsageProject[] = [
  { label: 'App', path: 'C:\\app', projectId: 'p1', distro: null },
  { label: 'App', path: '/mnt/c/app', projectId: 'p1', distro: 'Ubuntu' },
  { label: 'scratch', path: '/home/u/scratch', projectId: null, distro: 'Ubuntu' },
]

describe('buildBoundaries', () => {
  const now = new Date(2026, 9, 13, 10, 34, 7, 500)

  it('builds one slot per local day ending today', () => {
    for (const [period, days] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const b = buildBoundaries(period, now)
      expect(b).toHaveLength(days + 1)
      for (const ms of b) {
        const d = new Date(ms)
        expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0])
      }
      for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThan(b[i - 1])
      expect(b[days - 1]).toBe(new Date(2026, 9, 13).getTime())
      expect(b[days]).toBe(new Date(2026, 9, 14).getTime())
      expect(b[0]).toBe(new Date(2026, 9, 13 - (days - 1)).getTime())
    }
  })

  it('builds 24 one-hour slots ending with the current hour', () => {
    const b = buildBoundaries('24h', now)
    expect(b).toHaveLength(25)
    for (let i = 1; i < b.length; i++) expect(b[i] - b[i - 1]).toBe(3_600_000)
    expect(b[23]).toBe(new Date(2026, 9, 13, 10).getTime())
    expect(b[24]).toBeGreaterThan(now.getTime())
    expect(b[23]).toBeLessThanOrEqual(now.getTime())
  })
})

describe('totals', () => {
  it('sums buckets using the spec definitions', () => {
    const t = totals([
      bucket({ input: 10, cacheRead: 100, cacheWrite: 20, output: 5, costUsd: 3, cacheSavingsUsd: 1, responses: 2,
               inputCostUsd: 1, cacheReadCostUsd: 0.5, cacheWriteCostUsd: 0.5, outputCostUsd: 1 }),
      bucket({ input: 1, cacheRead: 0, cacheWrite: 0, output: 4, priced: false, responses: 1 }),
    ])
    expect(t.processed).toBe(140)
    expect(t.cachedInput).toBe(100)
    expect(t.uncachedInput).toBe(31)
    expect(t.output).toBe(9)
    expect(t.input).toBe(11)
    expect(t.cacheWrite).toBe(20)
    expect(t.costUsd).toBe(3)
    expect(t.cacheSavingsUsd).toBe(1)
    expect(t.responses).toBe(3)
    expect(t.unpricedTokens).toBe(5)
    expect(t.costByType).toEqual({ input: 1, cacheRead: 0.5, cacheWrite: 0.5, output: 1 })
  })

  it('is all zeros for no buckets', () => {
    expect(totals([]).processed).toBe(0)
  })
})

describe('makeGroups', () => {
  it('groups by model name', () => {
    const g = makeGroups('model', projects)
    expect(g.keyOf(bucket({ model: 'haiku' }))).toBe('haiku')
    expect(g.labelOf('haiku')).toBe('haiku')
  })

  it('merges project rows that share an app project and keeps others apart', () => {
    const g = makeGroups('project', projects)
    expect(g.keyOf(bucket({ project: 0 }))).toBe(g.keyOf(bucket({ project: 1 })))
    expect(g.keyOf(bucket({ project: 2 }))).not.toBe(g.keyOf(bucket({ project: 0 })))
    expect(g.labelOf(g.keyOf(bucket({ project: 0 })))).toBe('App')
    expect(g.labelOf(g.keyOf(bucket({ project: 2 })))).toBe('scratch (WSL Ubuntu)')
  })
})

describe('breakdown', () => {
  const buckets = [
    bucket({ model: 'opus', input: 100, cacheRead: 300, output: 100, costUsd: 9 }),
    bucket({ model: 'opus', slot: 1, input: 0, cacheRead: 0, output: 500, costUsd: 1 }),
    bucket({ model: 'haiku', input: 1000, output: 1000, costUsd: 0, priced: false }),
  ]
  const g = makeGroups('model', projects)

  it('sorts by the metric and computes shares', () => {
    const byCost = breakdown(buckets, g, 'cost')
    expect(byCost.map((r) => r.key)).toEqual(['opus', 'haiku'])
    expect(byCost[0].costUsd).toBe(10)
    expect(byCost[0].share).toBe(1)
    const byTokens = breakdown(buckets, g, 'tokens')
    expect(byTokens.map((r) => r.key)).toEqual(['haiku', 'opus'])
    expect(byTokens[0].tokens).toBe(2000)
    expect(byTokens[0].share).toBeCloseTo(2 / 3)
  })

  it('computes cache hit rate and cost per million priced tokens', () => {
    const rows = breakdown(buckets, g, 'cost')
    const opus = rows.find((r) => r.key === 'opus')!
    expect(opus.cacheHitRate).toBeCloseTo(0.75)
    expect(opus.costPerMillion).toBeCloseTo(10_000)
    expect(opus.priced).toBe(true)
    const haiku = rows.find((r) => r.key === 'haiku')!
    expect(haiku.priced).toBe(false)
    expect(haiku.costPerMillion).toBeNull()
    expect(haiku.cacheHitRate).toBe(0)
  })
})

describe('series', () => {
  const g = makeGroups('model', projects)
  const buckets = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((model, i) =>
    bucket({ model, slot: i % 2, output: (i + 1) * 10 })
  )

  it('keeps the top five and folds the rest into Other', () => {
    const s = series(buckets, 2, g, 'tokens')
    expect(s.keys.map((k) => k.key)).toEqual(['g', 'f', 'e', 'd', 'c', OTHER_KEY])
    expect(s.keys[5].label).toBe('Other')
    expect(s.values).toHaveLength(2)
    expect(s.values[0]).toEqual([70, 0, 50, 0, 30, 10])
    expect(s.values[1]).toEqual([0, 60, 0, 40, 0, 20])
  })

  it('has no Other series when five or fewer groups exist', () => {
    const s = series(buckets.slice(0, 3), 2, g, 'tokens')
    expect(s.keys.map((k) => k.key)).toEqual(['c', 'b', 'a'])
  })
})

describe('filterBuckets', () => {
  it('keeps only the chosen group, or everything for null', () => {
    const g = makeGroups('model', projects)
    const buckets = [bucket({ model: 'a' }), bucket({ model: 'b' })]
    expect(filterBuckets(buckets, g, 'a')).toHaveLength(1)
    expect(filterBuckets(buckets, g, null)).toHaveLength(2)
  })
})

describe('pooledWindow', () => {
  const now = Date.parse('2026-10-13T10:00:00Z')
  const usage = (
    accountId: string,
    fiveHour: { utilization: number; resetsAt: string | null } | null,
    error: string | null = null
  ): ClaudeAccountUsage => ({
    accountId,
    usage: fiveHour === null && error ? null : { fiveHour, sevenDay: null, extraUsage: null, fetchedAt: now },
    error,
  })

  it('averages what is left across reporting accounts', () => {
    const w = pooledWindow(
      [
        usage('a', { utilization: 80, resetsAt: '2026-10-13T12:00:00Z' }),
        usage('b', { utilization: 20, resetsAt: '2026-10-13T11:00:00Z' }),
        usage('c', null, 'fetch failed'),
        usage('d', null),
      ],
      'fiveHour',
      now
    )
    expect(w.accounts.map((a) => a.accountId)).toEqual(['a', 'b'])
    expect(w.accounts[0].remaining).toBe(20)
    expect(w.meanRemaining).toBe(50)
    expect(w.nextReset).toEqual({ accountId: 'b', resetsAt: '2026-10-13T11:00:00Z', restores: 10 })
  })

  it('clamps over-quota accounts and ignores untouched or past resets', () => {
    const w = pooledWindow(
      [
        usage('a', { utilization: 130, resetsAt: '2026-10-13T09:00:00Z' }),
        usage('b', { utilization: 0, resetsAt: '2026-10-13T11:00:00Z' }),
      ],
      'fiveHour',
      now
    )
    expect(w.accounts[0].remaining).toBe(0)
    expect(w.meanRemaining).toBe(50)
    expect(w.nextReset).toBeNull()
  })

  it('has no mean when nobody reports', () => {
    const w = pooledWindow([usage('a', null)], 'fiveHour', now)
    expect(w.accounts).toEqual([])
    expect(w.meanRemaining).toBeNull()
  })
})

describe('formatting', () => {
  it('formats token counts', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_500)).toBe('1.5K')
    expect(formatTokens(12_345)).toBe('12.3K')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(18_200_000_000)).toBe('18.2B')
  })

  it('formats dollars', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(12.346)).toBe('$12.35')
    expect(formatUsd(1234.5)).toBe('$1,235')
  })

  it('formats percentages', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.756)).toBe('76%')
    expect(formatPercent(0.004)).toBe('<1%')
    expect(formatPercent(1)).toBe('100%')
  })
})
