// Palette item type and ranking. Pure, so it runs in plain vitest.

import { fuzzyMatch } from './fuzzy'

export type PaletteItemKind = 'command' | 'terminal' | 'project'

export interface PaletteItem {
  key: string
  kind: PaletteItemKind
  title: string
  /** right-aligned secondary text: a shortcut, "Terminal · project", "Project" */
  hint: string
  run: () => void
}

export interface RankedItem extends PaletteItem {
  indices: number[]
}

export const COMMANDS_ONLY_PREFIX = '>'

export function rankItems(query: string, items: PaletteItem[], limit = 50): RankedItem[] {
  const trimmed = query.trimStart()
  const commandsOnly = trimmed.startsWith(COMMANDS_ONLY_PREFIX)
  const text = (commandsOnly ? trimmed.slice(COMMANDS_ONLY_PREFIX.length) : trimmed).trim()
  const pool = commandsOnly ? items.filter((i) => i.kind === 'command') : items
  if (text === '') return pool.slice(0, limit).map((i) => ({ ...i, indices: [] }))

  const matched: { item: PaletteItem; order: number; score: number; indices: number[] }[] = []
  pool.forEach((item, order) => {
    const match = fuzzyMatch(text, item.title)
    if (match) matched.push({ item, order, score: match.score, indices: match.indices })
  })
  matched.sort((a, b) => b.score - a.score || a.order - b.order)
  return matched.slice(0, limit).map((m) => ({ ...m.item, indices: m.indices }))
}
