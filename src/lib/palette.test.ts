import { describe, expect, it } from 'vitest'
import { rankItems, type PaletteItem, type PaletteItemKind } from './palette'

const item = (title: string, kind: PaletteItemKind = 'command'): PaletteItem => ({
  key: `${kind}:${title}`,
  kind,
  title,
  hint: '',
  run: () => {},
})

const titles = (items: { title: string }[]): string[] => items.map((i) => i.title)

describe('rankItems', () => {
  const items = [
    item('Print'),
    item('New terminal'),
    item('api-server', 'project'),
    item('npm test', 'terminal'),
  ]

  it('keeps the given order for an empty query', () => {
    const ranked = rankItems('', items)
    expect(titles(ranked)).toEqual(['Print', 'New terminal', 'api-server', 'npm test'])
    expect(ranked[0].indices).toEqual([])
  })

  it('sorts matches by score and drops non-matches', () => {
    const ranked = rankItems('nt', items)
    expect(titles(ranked)).toEqual(['New terminal', 'npm test', 'Print'])
    expect(ranked[0].indices).toEqual([0, 4])
  })

  it('keeps the given order between equal scores', () => {
    const same = [item('Alpha', 'project'), item('Alpha', 'terminal')]
    expect(rankItems('al', same).map((i) => i.kind)).toEqual(['project', 'terminal'])
  })

  it('shows only commands after a leading >', () => {
    expect(titles(rankItems('>', items))).toEqual(['Print', 'New terminal'])
    expect(titles(rankItems('> nt', items))).toEqual(['New terminal', 'Print'])
    expect(titles(rankItems('  >nt', items))).toEqual(['New terminal', 'Print'])
  })

  it('applies the limit', () => {
    expect(rankItems('', items, 2)).toHaveLength(2)
    expect(rankItems('t', items, 1)).toHaveLength(1)
  })
})
