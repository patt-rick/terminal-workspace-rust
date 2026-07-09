import { describe, expect, it } from 'vitest'
import {
  formatPlanName,
  formatResetsIn,
  formatAgo,
  sortAccounts,
  utilizationBarClass,
  worstUtilization,
} from './claude-accounts'
import type { ClaudeAccountMeta } from './ipc'

const acct = (id: string, addedAt: number): ClaudeAccountMeta => ({
  id,
  email: `${id}@x.y`,
  displayName: null,
  plan: null,
  addedAt,
  refreshDead: false,
  hasToken: true,
})

describe('formatPlanName', () => {
  it('humanizes tier ids', () => {
    expect(formatPlanName('max_20x')).toBe('Max 20x')
    expect(formatPlanName('max_5x')).toBe('Max 5x')
    expect(formatPlanName('pro')).toBe('Pro')
    expect(formatPlanName('enterprise')).toBe('Enterprise')
    expect(formatPlanName(null)).toBe('')
  })
})

describe('sortAccounts', () => {
  it('pins active first, then oldest-added', () => {
    const list = [acct('b', 200), acct('a', 100), acct('c', 300)]
    const sorted = sortAccounts(list, 'c')
    expect(sorted.map((a) => a.id)).toEqual(['c', 'a', 'b'])
    // no active id -> pure addedAt order
    expect(sortAccounts(list, null).map((a) => a.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('utilizationBarClass', () => {
  it('maps thresholds to colors', () => {
    expect(utilizationBarClass(100)).toBe('bg-red-700')
    expect(utilizationBarClass(95)).toBe('bg-red-500')
    expect(utilizationBarClass(75)).toBe('bg-orange-500')
    expect(utilizationBarClass(65)).toBe('bg-yellow-500')
    expect(utilizationBarClass(10)).toBe('bg-green-500')
  })
})

describe('worstUtilization', () => {
  it('takes the max across buckets, null-safe', () => {
    expect(
      worstUtilization({
        fiveHour: { utilization: 42, resetsAt: null },
        sevenDay: { utilization: 91, resetsAt: null },
        extraUsage: null,
        fetchedAt: 0,
      })
    ).toBe(91)
    expect(worstUtilization(null)).toBe(null)
    expect(
      worstUtilization({ fiveHour: null, sevenDay: null, extraUsage: null, fetchedAt: 0 })
    ).toBe(null)
  })
})

describe('formatResetsIn', () => {
  const now = Date.parse('2026-07-09T12:00:00Z')
  it('renders d/h/m tiers', () => {
    expect(formatResetsIn('2026-07-16T09:00:00Z', now)).toBe('6d 21h')
    expect(formatResetsIn('2026-07-09T16:00:00Z', now)).toBe('4h')
    expect(formatResetsIn('2026-07-09T12:25:00Z', now)).toBe('25m')
    expect(formatResetsIn('2026-07-09T11:00:00Z', now)).toBe('now') // past
    expect(formatResetsIn(null, now)).toBe('')
    expect(formatResetsIn('garbage', now)).toBe('')
  })
})

describe('formatAgo', () => {
  const now = 1_000_000_000
  it('renders compact ago labels', () => {
    expect(formatAgo(now - 20_000, now)).toBe('just now')
    expect(formatAgo(now - 3 * 60_000, now)).toBe('3m ago')
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2h ago')
  })
})
