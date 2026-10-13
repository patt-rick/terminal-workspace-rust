import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzy'

const score = (query: string, text: string): number => fuzzyMatch(query, text)!.score

describe('fuzzyMatch', () => {
  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'abc')).toEqual({ score: 0, indices: [] })
    expect(fuzzyMatch('   ', 'abc')).toEqual({ score: 0, indices: [] })
  })

  it('returns null when characters are missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'New terminal')).toBeNull()
    expect(fuzzyMatch('tn', 'New t')).toBeNull()
  })

  it('reports the matched positions', () => {
    expect(fuzzyMatch('nt', 'New terminal')!.indices).toEqual([0, 4])
  })

  it('ignores case', () => {
    expect(fuzzyMatch('NT', 'new terminal')!.indices).toEqual([0, 4])
  })

  it('ignores spaces in the query', () => {
    expect(fuzzyMatch('new term', 'New terminal')!.indices).toEqual([0, 1, 2, 4, 5, 6, 7])
  })

  it('ranks a word-start match above a mid-word one', () => {
    expect(score('nt', 'New terminal')).toBeGreaterThan(score('nt', 'Print'))
  })

  it('ranks a consecutive match above a scattered one', () => {
    expect(score('term', 'New terminal')).toBeGreaterThan(score('term', 'The extra room'))
  })

  it('tries every starting point and keeps the best', () => {
    expect(fuzzyMatch('ab', 'xa_ab')!.indices).toEqual([3, 4])
  })
})
