import { describe, expect, it } from 'vitest'
import {
  earliestReset,
  isOverLimit,
  pickHealthiest,
  type UsageById,
  type UsageEntry,
} from './auto-switch'
import type { ClaudeAccountMeta, ClaudeUsage } from './ipc'

const acct = (id: string, addedAt: number, over: Partial<ClaudeAccountMeta> = {}): ClaudeAccountMeta => ({
  id,
  email: `${id}@x.y`,
  displayName: null,
  plan: null,
  addedAt,
  refreshDead: false,
  hasToken: true,
  ...over,
})

const usage = (
  fiveHour: number | null,
  sevenDay: number | null,
  opts: { extraEnabled?: boolean; extraUtil?: number | null; fiveReset?: string | null; sevenReset?: string | null } = {}
): ClaudeUsage => ({
  fiveHour: fiveHour === null ? null : { utilization: fiveHour, resetsAt: opts.fiveReset ?? null },
  sevenDay: sevenDay === null ? null : { utilization: sevenDay, resetsAt: opts.sevenReset ?? null },
  extraUsage:
    opts.extraEnabled === undefined && opts.extraUtil === undefined
      ? null
      : {
          isEnabled: opts.extraEnabled ?? null,
          monthlyLimit: null,
          usedCredits: null,
          utilization: opts.extraUtil ?? null,
        },
  fetchedAt: 0,
})

const entry = (u: ClaudeUsage | null, error: string | null = null): UsageEntry => ({ usage: u, error })

describe('isOverLimit', () => {
  it('true when a window bucket is at/over 100', () => {
    expect(isOverLimit(usage(100, 40))).toBe(true)
    expect(isOverLimit(usage(40, 105))).toBe(true)
  })
  it('true when enabled extra-usage credits are exhausted', () => {
    expect(isOverLimit(usage(50, 50, { extraEnabled: true, extraUtil: 100 }))).toBe(true)
  })
  it('false below limits, for disabled extra-usage, and for missing usage', () => {
    expect(isOverLimit(usage(99, 99))).toBe(false)
    expect(isOverLimit(usage(50, 50, { extraEnabled: false, extraUtil: 100 }))).toBe(false)
    expect(isOverLimit(null)).toBe(false)
    expect(isOverLimit(usage(null, null))).toBe(false)
  })
})

describe('pickHealthiest', () => {
  const empty = new Set<string>()

  it('picks the account with the most headroom', () => {
    const accounts = [acct('a', 1), acct('b', 2), acct('c', 3)]
    const usageById: UsageById = {
      a: entry(usage(80, 60)), // headroom 20
      b: entry(usage(10, 30)), // headroom 70
      c: entry(usage(50, 55)), // headroom 45
    }
    expect(pickHealthiest(accounts, usageById, empty)).toEqual({ id: 'b' })
  })

  it('treats a missing bucket (present usage) as 0 utilization / full headroom', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    const usageById: UsageById = { a: entry(usage(40, null)), b: entry(usage(90, 90)) }
    // a: headroom 60 (7d bucket missing -> 0) beats b: headroom 10
    expect(pickHealthiest(accounts, usageById, empty)).toEqual({ id: 'a' })
  })

  it('requires BOTH windows under 100 (either at-limit disqualifies)', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    const usageById: UsageById = {
      a: entry(usage(100, 10)), // 5h exhausted -> excluded
      b: entry(usage(10, 100)), // 7d exhausted -> excluded
    }
    expect(pickHealthiest(accounts, usageById, empty)).toBeNull()
  })

  it('extra-usage enabled keeps an at-limit window usable', () => {
    const accounts = [acct('a', 1)]
    const usageById: UsageById = { a: entry(usage(100, 100, { extraEnabled: true })) }
    expect(pickHealthiest(accounts, usageById, empty)).toEqual({ id: 'a' })
  })

  it('excludes active/tried, refresh-dead, and token-less accounts', () => {
    const accounts = [
      acct('active', 1),
      acct('tried', 2),
      acct('dead', 3, { refreshDead: true }),
      acct('notoken', 4, { hasToken: false }),
      acct('good', 5),
    ]
    const usageById: UsageById = {
      active: entry(usage(10, 10)),
      tried: entry(usage(5, 5)),
      dead: entry(usage(1, 1)),
      notoken: entry(usage(1, 1)),
      good: entry(usage(20, 20)),
    }
    const exclude = new Set(['active', 'tried'])
    expect(pickHealthiest(accounts, usageById, exclude)).toEqual({ id: 'good' })
  })

  it('breaks headroom ties by addedAt ascending (stable)', () => {
    const accounts = [acct('late', 200), acct('early', 100)]
    const usageById: UsageById = { late: entry(usage(30, 30)), early: entry(usage(30, 30)) }
    expect(pickHealthiest(accounts, usageById, empty)).toEqual({ id: 'early' })
  })

  it('ranks unknown/errored usage BELOW every known-healthy account', () => {
    const accounts = [acct('errored', 1), acct('missing', 2), acct('healthy', 3)]
    const usageById: UsageById = {
      errored: entry(usage(1, 1), 'boom'), // errored -> unknown, even though numbers look great
      // missing: no entry -> unknown
      healthy: entry(usage(85, 85)), // only headroom 15, but known -> wins
    }
    expect(pickHealthiest(accounts, usageById, empty)).toEqual({ id: 'healthy' })
  })

  it('chooses an unknown account only as a last resort (oldest first)', () => {
    const accounts = [acct('u2', 2), acct('u1', 1)]
    const usageById: UsageById = {
      u1: entry(null, 'boom'), // errored
      u2: undefined, // never fetched
    }
    // no known-healthy candidate -> fall back to unknown, oldest addedAt wins
    expect(pickHealthiest(accounts, usageById, empty)).toEqual({ id: 'u1' })
  })

  it('returns null when there are no candidates', () => {
    expect(pickHealthiest([], {}, empty)).toBeNull()
    const accounts = [acct('a', 1)]
    expect(pickHealthiest(accounts, { a: entry(usage(10, 10)) }, new Set(['a']))).toBeNull()
  })
})

describe('earliestReset', () => {
  it('returns the soonest reset among exhausted accounts', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    const usageById: UsageById = {
      a: entry(usage(100, 20, { fiveReset: '2026-07-16T09:00:00Z' })),
      b: entry(usage(20, 100, { sevenReset: '2026-07-15T09:00:00Z' })),
    }
    expect(earliestReset(accounts, usageById)).toBe('2026-07-15T09:00:00Z')
  })

  it('ignores non-exhausted buckets and unparseable/missing reset times', () => {
    const accounts = [acct('a', 1), acct('b', 2)]
    const usageById: UsageById = {
      a: entry(usage(50, 50, { fiveReset: '2026-07-16T09:00:00Z' })), // not exhausted
      b: entry(usage(100, 20, { fiveReset: 'garbage' })),
    }
    expect(earliestReset(accounts, usageById)).toBeNull()
  })

  it('returns null with no usage', () => {
    expect(earliestReset([acct('a', 1)], {})).toBeNull()
  })
})
