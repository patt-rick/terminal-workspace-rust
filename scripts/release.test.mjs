import { describe, it, expect } from 'vitest'
import {
  stampUnreleased,
  bumpJsonVersion,
  bumpCargoToml,
  bumpCargoLock,
} from './release.mjs'

const CHANGELOG = `# Changelog

## [Unreleased]
### Added
- A new thing.

## [0.4.2] - 2026-09-14
### Added
- Old thing.
`

describe('stampUnreleased', () => {
  it('stamps the version+date and opens a fresh Unreleased', () => {
    const out = stampUnreleased(CHANGELOG, '0.5.0', '2026-09-20')
    expect(out).toContain('## [Unreleased]')
    expect(out).toContain('## [0.5.0] - 2026-09-20')
    expect(out).toContain('- A new thing.')
    // fresh Unreleased comes before the stamped section
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [0.5.0]'))
    // the stamped section keeps the notes; the new Unreleased is empty
    const afterUnreleased = out.slice(
      out.indexOf('## [Unreleased]') + '## [Unreleased]'.length,
      out.indexOf('## [0.5.0]'),
    )
    expect(afterUnreleased.trim()).toBe('')
  })

  it('throws when Unreleased is empty', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.4.2] - 2026-09-14\n- x\n'
    expect(() => stampUnreleased(empty, '0.5.0', '2026-09-20')).toThrow(/empty/i)
  })

  it('throws when there is no Unreleased section', () => {
    expect(() => stampUnreleased('# Changelog\n\n## [0.4.2]\n- x\n', '0.5.0', '2026-09-20')).toThrow(/Unreleased/i)
  })
})

describe('version bumpers', () => {
  it('bumps only the package version in JSON', () => {
    const pkg = '{\n  "name": "x",\n  "version": "0.4.2",\n  "deps": { "a": "^0.4.2" }\n}\n'
    const out = bumpJsonVersion(pkg, '0.5.0')
    expect(out).toContain('"version": "0.5.0"')
    expect(out).toContain('"a": "^0.4.2"') // dependency untouched
  })

  it('bumps the [package] version in Cargo.toml', () => {
    const toml = '[package]\nname = "terminal-workspace"\nversion = "0.4.2"\n\n[dependencies]\nserde = "1.0"\n'
    expect(bumpCargoToml(toml, '0.5.0')).toContain('version = "0.5.0"')
  })

  it('bumps only the terminal-workspace entry in Cargo.lock', () => {
    const lock = '[[package]]\nname = "other"\nversion = "0.4.2"\n\n[[package]]\nname = "terminal-workspace"\nversion = "0.4.2"\ndependencies = []\n'
    const out = bumpCargoLock(lock, '0.5.0')
    expect(out).toContain('name = "terminal-workspace"\nversion = "0.5.0"')
    expect(out).toContain('name = "other"\nversion = "0.4.2"') // sibling untouched
  })
})
