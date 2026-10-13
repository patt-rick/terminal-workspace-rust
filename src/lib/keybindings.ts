// Key-to-command table. Pure, so it runs in plain vitest. Keys are written
// "mod+shift+t": mod is Ctrl or Cmd, modifiers in that fixed order.

export interface Keybinding {
  key: string
  command: string
}

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: 'mod+k', command: 'palette.toggle' },
  { key: 'mod+shift+p', command: 'palette.toggle' },
  { key: 'mod+,', command: 'view.settings' },
  { key: 'mod+b', command: 'view.toggleSidebar' },
  { key: 'mod+shift+b', command: 'view.toggleRightSidebar' },
  { key: 'mod+p', command: 'file.quickOpen' },
  { key: 'mod+shift+u', command: 'view.usage' },
  { key: 'mod+t', command: 'terminal.new' },
  { key: 'mod+shift+t', command: 'terminal.newClaude' },
  { key: 'mod+shift+d', command: 'terminal.newClaudeSkipPermissions' },
  { key: 'mod+w', command: 'terminal.close' },
]

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'])

/**
 * `mod` is Cmd on macOS and Ctrl elsewhere, never both: on a Mac, Ctrl+K and
 * friends belong to the shell and to the editor's emacs bindings. Alt is
 * excluded because AltGr arrives as Ctrl+Alt on Windows and types characters.
 */
export function eventKey(e: KeyEventLike, isMac: boolean): string | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || MODIFIER_KEYS.has(e.key)) return null
  return `mod+${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`
}

export function commandForEvent(
  e: KeyEventLike,
  isMac: boolean,
  bindings: Keybinding[] = DEFAULT_KEYBINDINGS
): string | null {
  const key = eventKey(e, isMac)
  if (key === null) return null
  return bindings.find((b) => b.key === key)?.command ?? null
}

export function shortcutLabel(
  command: string,
  isMac: boolean,
  bindings: Keybinding[] = DEFAULT_KEYBINDINGS
): string | null {
  const binding = bindings.find((b) => b.command === command)
  if (!binding) return null
  const parts = binding.key.split('+')
  const key = (parts.pop() ?? '').toUpperCase()
  if (isMac) {
    return parts.map((p) => (p === 'mod' ? '⌘' : '⇧')).join('') + key
  }
  return [...parts.map((p) => (p === 'mod' ? 'Ctrl' : 'Shift')), key].join('+')
}
