// Pure helpers for the phone chat view (unit-tested; no DOM or socket).
import type { ChatMessage } from './protocol'

/** Merge server messages into the list: same id replaces, new ids append. */
export function upsertMessages(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = list.slice()
  const at = new Map(out.map((m, i) => [m.id, i]))
  for (const m of incoming) {
    const i = at.get(m.id)
    if (i === undefined) {
      at.set(m.id, out.length)
      out.push(m)
    } else {
      out[i] = m
    }
  }
  return out
}

/** What to write to the PTY to submit `text` as one prompt: Ctrl+U first (an
 *  Esc before Claude's first token puts the last prompt back in its input box),
 *  then a bracketed paste (ESC stripped so the text can't end it early), then
 *  Enter sent separately — Claude Code can swallow an Enter that arrives in the
 *  same chunk. */
export function promptSequences(
  text: string
): { clear: string; paste: string; enter: string } | null {
  const clean = text.replace(/\x1b/g, '').replace(/\s+$/, '')
  if (!clean.trim()) return null
  return { clear: '\x15', paste: `\x1b[200~${clean}\x1b[201~`, enter: '\r' }
}

/** Delay between the paste and its Enter (Phase 0 result). */
export const ENTER_DELAY_MS = 100

/** Ids of tool calls still waiting for a result. */
function pendingTools(msgs: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of msgs) for (const b of m.blocks) if (b.kind === 'toolUse' && b.result === null) ids.add(b.id)
  return ids
}

export function hasPendingTool(msgs: ChatMessage[]): boolean {
  return pendingTools(msgs).size > 0
}

const MODE_KEY = 'tw_chat_mode'
export type ViewMode = 'chat' | 'terminal'

/** Per-terminal view choice; Claude terminals default to chat. */
export const modeStore = {
  get(id: string): ViewMode {
    try {
      const all = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}') as Record<string, ViewMode>
      return all[id] ?? 'chat'
    } catch {
      return 'chat'
    }
  },
  set(id: string, mode: ViewMode): void {
    try {
      const all = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}') as Record<string, ViewMode>
      all[id] = mode
      localStorage.setItem(MODE_KEY, JSON.stringify(all))
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  },
}
