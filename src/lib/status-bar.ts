// What the status bar shows. An item whose value is unknown is left out.

import type { GitInfo } from './ipc'

export interface StatusItem {
  id: 'branch' | 'changes' | 'limit' | 'terminals'
  text: string
  /** where a click goes, or null for a plain label */
  action: 'git' | 'usage' | null
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function statusItems(input: {
  hasProject: boolean
  info: GitInfo | null
  /** percent of the 5-hour window used; null when unknown or an API key is active */
  fiveHourUtilization: number | null
  terminalCount: number
}): StatusItem[] {
  if (!input.hasProject) return []
  const items: StatusItem[] = []
  if (input.info?.isRepo) {
    const { branch, changed } = input.info
    items.push({ id: 'branch', text: branch ?? 'detached', action: 'git' })
    items.push({
      id: 'changes',
      text: changed === 0 ? 'No changes' : plural(changed, 'change'),
      action: 'git',
    })
  }
  if (input.fiveHourUtilization !== null) {
    const left = Math.min(100, Math.max(0, Math.round(100 - input.fiveHourUtilization)))
    items.push({ id: 'limit', text: `5-hour limit: ${left}% left`, action: 'usage' })
  }
  items.push({ id: 'terminals', text: plural(input.terminalCount, 'terminal'), action: null })
  return items
}
