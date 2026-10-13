import { describe, expect, it } from 'vitest'
import { readableOn, tileLetter } from './project-tile'

describe('tileLetter', () => {
  it('takes the first letter, upper-cased', () => {
    expect(tileLetter('api-server')).toBe('A')
  })

  it('skips leading spaces and punctuation', () => {
    expect(tileLetter('  .config')).toBe('C')
  })

  it('accepts a digit and a non-Latin letter', () => {
    expect(tileLetter('2048')).toBe('2')
    expect(tileLetter('été')).toBe('É')
  })

  it("falls back to '?' when there is nothing to show", () => {
    expect(tileLetter('--')).toBe('?')
    expect(tileLetter('')).toBe('?')
  })
})

describe('readableOn', () => {
  it('puts dark text on a light colour', () => {
    expect(readableOn('#ffcc66')).toBe('#171c28')
    expect(readableOn('#BAE67E')).toBe('#171c28')
  })

  it('puts white text on a dark colour', () => {
    expect(readableOn('#1d2433')).toBe('#ffffff')
    expect(readableOn('#7a1f2b')).toBe('#ffffff')
  })

  it('uses white for anything that is not #rrggbb', () => {
    expect(readableOn('red')).toBe('#ffffff')
    expect(readableOn('#fc6')).toBe('#ffffff')
  })
})
