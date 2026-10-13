import { describe, expect, it } from 'vitest'
import type { GitInfo } from './ipc'
import { statusItems } from './status-bar'

const info = (over: Partial<GitInfo> = {}): GitInfo => ({
  isRepo: true,
  branch: 'master',
  githubRepo: null,
  hasUpstream: true,
  ahead: 0,
  behind: 0,
  dirty: false,
  defaultBranch: 'master',
  changed: 0,
  ...over,
})

const base = { hasProject: true, info: null, fiveHourUtilization: null, terminalCount: 0 }
const texts = (items: ReturnType<typeof statusItems>): string[] => items.map((i) => i.text)

describe('statusItems', () => {
  it('shows nothing without a project', () => {
    expect(statusItems({ ...base, hasProject: false, info: info(), terminalCount: 2 })).toEqual([])
  })

  it('shows only the terminal count when nothing else is known', () => {
    expect(statusItems(base)).toEqual([{ id: 'terminals', text: '0 terminals', action: null }])
  })

  it('shows the branch and changes of a repo, both opening the Git tab', () => {
    const items = statusItems({ ...base, info: info({ changed: 3 }), terminalCount: 1 })
    expect(items).toEqual([
      { id: 'branch', text: 'master', action: 'git' },
      { id: 'changes', text: '3 changes', action: 'git' },
      { id: 'terminals', text: '1 terminal', action: null },
    ])
  })

  it('words zero and one change', () => {
    expect(texts(statusItems({ ...base, info: info() }))).toContain('No changes')
    expect(texts(statusItems({ ...base, info: info({ changed: 1 }) }))).toContain('1 change')
  })

  it('says detached when there is no branch', () => {
    expect(texts(statusItems({ ...base, info: info({ branch: null }) }))[0]).toBe('detached')
  })

  it('leaves git out for a folder that is not a repo', () => {
    const items = statusItems({ ...base, info: info({ isRepo: false }) })
    expect(items.map((i) => i.id)).toEqual(['terminals'])
  })

  it('shows what is left of the 5-hour window, opening the Usage page', () => {
    const items = statusItems({ ...base, fiveHourUtilization: 38.4 })
    expect(items[0]).toEqual({ id: 'limit', text: '5-hour limit: 62% left', action: 'usage' })
  })

  it('never shows less than 0% or more than 100% left', () => {
    expect(texts(statusItems({ ...base, fiveHourUtilization: 130 }))[0]).toBe('5-hour limit: 0% left')
    expect(texts(statusItems({ ...base, fiveHourUtilization: -5 }))[0]).toBe('5-hour limit: 100% left')
  })
})
