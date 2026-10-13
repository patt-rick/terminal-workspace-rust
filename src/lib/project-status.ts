// What a terminal, and a project as a whole, is doing: the status dots in the
// project tree, the terminal tabs and the rail, and the rail's hover label.

export type TerminalState = 'busy' | 'unread' | 'idle'

export interface HoverLine {
  id: string
  title: string
  state: TerminalState
  label: string
}

const STATE_LABEL: Record<TerminalState, string> = {
  busy: 'Working',
  unread: 'New output',
  idle: 'Idle',
}

export function terminalState(
  id: string,
  busy: Record<string, boolean>,
  unread: Record<string, number>
): TerminalState {
  if (busy[id]) return 'busy'
  return (unread[id] ?? 0) > 0 ? 'unread' : 'idle'
}

/** The one badge a project tile shows: working beats unread. */
export function projectBadge(
  ids: string[],
  busy: Record<string, boolean>,
  unread: Record<string, number>
): 'busy' | 'unread' | null {
  if (ids.some((id) => busy[id])) return 'busy'
  return ids.some((id) => (unread[id] ?? 0) > 0) ? 'unread' : null
}

/** One line per terminal for the hover label, capped at `max`. */
export function hoverLines(
  terminals: { id: string; name: string }[],
  titles: Record<string, string>,
  busy: Record<string, boolean>,
  unread: Record<string, number>,
  max = 8
): { lines: HoverLine[]; more: number } {
  const lines = terminals.slice(0, max).map((t) => {
    const state = terminalState(t.id, busy, unread)
    return { id: t.id, title: titles[t.id] || t.name, state, label: STATE_LABEL[state] }
  })
  return { lines, more: Math.max(0, terminals.length - max) }
}

/** Tailwind classes for a status dot. */
export function stateDotClass(state: TerminalState): string {
  // The ring keeps a pale dot visible on a light theme.
  if (state === 'busy') {
    return 'animate-pulse bg-warning ring-1 ring-foreground/20 motion-reduce:animate-none'
  }
  return state === 'unread' ? 'bg-link ring-1 ring-foreground/20' : 'bg-foreground/20'
}
