import { describe, it, expect } from 'vitest'
import { parseChangelog, compareVersions, entriesNewerThan } from './changelog'

const SAMPLE = `# Changelog

## [Unreleased]
- work in progress

## [0.4.10] - 2026-10-01
### Fixed
- Ten beats nine.

## [0.4.9] - 2026-09-20
### Added
- Nine.
`

describe('parseChangelog', () => {
  it('parses released entries newest-first and skips Unreleased', () => {
    const entries = parseChangelog(SAMPLE)
    expect(entries.map((e) => e.version)).toEqual(['0.4.10', '0.4.9'])
    expect(entries[0].date).toBe('2026-10-01')
    expect(entries[0].body).toContain('Ten beats nine.')
    expect(entries[0].body).not.toContain('## [')
  })

  it('tolerates a missing date', () => {
    const entries = parseChangelog('## [1.0.0]\n### Added\n- x\n')
    expect(entries[0]).toMatchObject({ version: '1.0.0', date: null })
  })

  it('returns [] for empty or heading-less input', () => {
    expect(parseChangelog('')).toEqual([])
    expect(parseChangelog('# Changelog\n\njust prose')).toEqual([])
  })
})

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.4.10', '0.4.9')).toBe(1)
    expect(compareVersions('0.4.9', '0.4.10')).toBe(-1)
    expect(compareVersions('0.4.2', '0.4.2')).toBe(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
  })

  it('treats malformed versions as oldest', () => {
    expect(compareVersions('garbage', '0.0.1')).toBe(-1)
  })
})

describe('entriesNewerThan', () => {
  it('returns only strictly-newer entries', () => {
    const entries = parseChangelog(SAMPLE)
    expect(entriesNewerThan(entries, '0.4.9').map((e) => e.version)).toEqual(['0.4.10'])
    expect(entriesNewerThan(entries, '0.4.10')).toEqual([])
  })
})
