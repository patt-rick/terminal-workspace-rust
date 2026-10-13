// Key-to-command table and the pure editing helpers behind the Keyboard
// settings tab. Keys are written "mod+shift+t": mod is Cmd on macOS and Ctrl
// elsewhere, modifiers in that fixed order.

export interface Keybinding {
  key: string
  command: string
  /**
   * Whether the app gets the key while a terminal has focus. When false the
   * shortcut is ignored there and the key goes to the program in the terminal.
   */
  inTerminal: boolean
}

export interface KeySetting {
  key: string
  inTerminal: boolean
}

/** Per command, the complete list that replaces that command's defaults. */
export type KeybindingOverrides = Record<string, KeySetting[]>

const DEFAULT_KEYS: { key: string; command: string }[] = [
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

const PALETTE_COMMAND = 'palette.toggle'

// Copy, paste, cut, select all, undo, redo and save belong to the terminal and
// the editor.
const RESERVED_KEYS = new Set([
  'mod+c',
  'mod+v',
  'mod+x',
  'mod+a',
  'mod+z',
  'mod+y',
  'mod+s',
  'mod+shift+c',
  'mod+shift+v',
  'mod+shift+z',
])

// Word-delete and caret movement in every text field in the app.
const EDITING_NAMED = /^mod\+(shift\+)?(backspace|delete|home|end|arrow(left|right|up|down))$/

const KEY_PATTERN = /^mod\+(shift\+)?(?!shift\+|alt\+)[^\sA-Z]+$/
// What the browser reports for a key it could not name.
const UNNAMED_KEY = /\+(dead|unidentified|process)$/

const TERMINAL_CTRL = /^mod\+([a-z]|space|[3-8]|\[|\\|\]|shift\+[@_])$/
const TERMINAL_NAMED =
  /^mod\+(shift\+)?(enter|backspace|tab|escape|delete|insert|home|end|pageup|pagedown|arrow(up|down|left|right)|f\d{1,2})$/
// With Cmd held xterm ignores letters and arrows but still sends these.
const TERMINAL_NAMED_MAC = /^mod\+(shift\+)?(enter|backspace|tab|escape|delete|f\d{1,2})$/

/**
 * xterm turns these into control characters or escape sequences for the shell
 * and stops the event, so the app never sees them unless the terminal is told
 * to let them through.
 */
export function terminalConsumes(key: string, isMac: boolean): boolean {
  if (isMac) return TERMINAL_NAMED_MAC.test(key)
  return TERMINAL_CTRL.test(key) || TERMINAL_NAMED.test(key)
}

/**
 * The defaults keep the behaviour the app had before shortcuts were editable:
 * keys the terminal takes stay with the terminal, except the palette's.
 */
export function defaultKeybindings(isMac: boolean): Keybinding[] {
  return DEFAULT_KEYS.map((b) => ({
    ...b,
    inTerminal: b.command === PALETTE_COMMAND || !terminalConsumes(b.key, isMac),
  }))
}

/** One key resolves to one command: an override beats a default, a later override an earlier one. */
export function effectiveKeybindings(
  defaults: Keybinding[],
  overrides: KeybindingOverrides
): Keybinding[] {
  const byKey = new Map<string, Keybinding>()
  for (const b of defaults) {
    if (overrides[b.command] === undefined) byKey.set(b.key, b)
  }
  for (const [command, list] of Object.entries(overrides)) {
    for (const setting of list) {
      byKey.set(setting.key, { key: setting.key, command, inTerminal: setting.inTerminal })
    }
  }
  return [...byKey.values()]
}

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'])

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/**
 * `mod` is Cmd on macOS and Ctrl elsewhere, never both: on a Mac, Ctrl+K and
 * friends belong to the shell and to the editor's emacs bindings. Alt is
 * excluded because AltGr arrives as Ctrl+Alt on Windows and types characters.
 */
export function eventKey(e: KeyEventLike, isMac: boolean): string | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || MODIFIER_KEYS.has(e.key)) return null
  const name = e.key === ' ' ? 'space' : e.key.toLowerCase()
  return `mod+${e.shiftKey ? 'shift+' : ''}${name}`
}

export function bindingForEvent(
  e: KeyEventLike,
  isMac: boolean,
  bindings: Keybinding[]
): Keybinding | null {
  const key = eventKey(e, isMac)
  if (key === null) return null
  return bindings.find((b) => b.key === key) ?? null
}

export function commandForEvent(
  e: KeyEventLike,
  isMac: boolean,
  bindings: Keybinding[] = defaultKeybindings(isMac)
): string | null {
  return bindingForEvent(e, isMac, bindings)?.command ?? null
}

export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key) || EDITING_NAMED.test(key)
}

export function isBindableKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !UNNAMED_KEY.test(key) && !isReservedKey(key)
}

const KEY_NAMES: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

export function formatKey(key: string, isMac: boolean): string {
  // Sliced, not split on '+': the key itself can be '+'.
  const shift = key.startsWith('mod+shift+')
  const last = key.slice(shift ? 'mod+shift+'.length : 'mod+'.length)
  const name =
    KEY_NAMES[last] ??
    (last.length === 1 ? last.toUpperCase() : last.charAt(0).toUpperCase() + last.slice(1))
  if (isMac) return `⌘${shift ? '⇧' : ''}${name}`
  return `Ctrl+${shift ? 'Shift+' : ''}${name}`
}

export function shortcutLabel(
  command: string,
  isMac: boolean,
  bindings: Keybinding[] = defaultKeybindings(isMac)
): string | null {
  const binding = bindings.find((b) => b.command === command)
  return binding ? formatKey(binding.key, isMac) : null
}

export function withShortcut(text: string, label: string): string {
  return label ? `${text} (${label})` : text
}

function defaultSettings(defaults: Keybinding[], command: string): KeySetting[] {
  return defaults
    .filter((b) => b.command === command)
    .map(({ key, inTerminal }) => ({ key, inTerminal }))
}

function settingsFor(
  command: string,
  defaults: Keybinding[],
  overrides: KeybindingOverrides
): KeySetting[] {
  return overrides[command] ?? defaultSettings(defaults, command)
}

// Order is ignored, so removing a default key and adding it back is a reset.
function sameSettings(a: KeySetting[], b: KeySetting[]): boolean {
  return (
    a.length === b.length &&
    a.every((s) => b.some((o) => o.key === s.key && o.inTerminal === s.inTerminal))
  )
}

// A command whose list equals its defaults needs no override, so "reset" and
// "set back by hand" end in the same state.
function normalise(overrides: KeybindingOverrides, defaults: Keybinding[]): KeybindingOverrides {
  const out: KeybindingOverrides = {}
  for (const [command, list] of Object.entries(overrides)) {
    if (!sameSettings(list, defaultSettings(defaults, command))) out[command] = list
  }
  return out
}

/** Adds a key to a command and takes it away from any other command. */
export function withBinding(
  overrides: KeybindingOverrides,
  defaults: Keybinding[],
  command: string,
  setting: KeySetting
): KeybindingOverrides {
  const next: KeybindingOverrides = {}
  for (const [other, list] of Object.entries(overrides)) {
    next[other] = other === command ? list : list.filter((s) => s.key !== setting.key)
  }
  for (const b of defaults) {
    if (b.key === setting.key && b.command !== command && next[b.command] === undefined) {
      next[b.command] = defaultSettings(defaults, b.command).filter((s) => s.key !== setting.key)
    }
  }
  next[command] = [
    ...settingsFor(command, defaults, next).filter((s) => s.key !== setting.key),
    setting,
  ]
  return normalise(next, defaults)
}

export function withoutBinding(
  overrides: KeybindingOverrides,
  defaults: Keybinding[],
  command: string,
  key: string
): KeybindingOverrides {
  const next = {
    ...overrides,
    [command]: settingsFor(command, defaults, overrides).filter((s) => s.key !== key),
  }
  return normalise(next, defaults)
}

export function withInTerminal(
  overrides: KeybindingOverrides,
  defaults: Keybinding[],
  command: string,
  key: string,
  inTerminal: boolean
): KeybindingOverrides {
  const next = {
    ...overrides,
    [command]: settingsFor(command, defaults, overrides).map((s) =>
      s.key === key ? { key, inTerminal } : s
    ),
  }
  return normalise(next, defaults)
}

/** Restores a command's defaults, taking its default keys back from other commands. */
export function resetCommand(
  overrides: KeybindingOverrides,
  defaults: Keybinding[],
  command: string
): KeybindingOverrides {
  const own = new Set(defaultSettings(defaults, command).map((s) => s.key))
  const next: KeybindingOverrides = {}
  for (const [other, list] of Object.entries(overrides)) {
    if (other === command) continue
    next[other] = list.filter((s) => !own.has(s.key))
  }
  return normalise(next, defaults)
}

/** Stored data may be hand-edited or from another version: keep only what is well-formed. */
export function sanitizeOverrides(value: unknown): KeybindingOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: KeybindingOverrides = {}
  const seen = new Set<string>()
  for (const [command, list] of Object.entries(value)) {
    if (command === '__proto__' || !Array.isArray(list)) continue
    const clean: KeySetting[] = []
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const { key, inTerminal } = item as { key?: unknown; inTerminal?: unknown }
      const ok = typeof key === 'string' && isBindableKey(key) && typeof inTerminal === 'boolean'
      if (ok && !seen.has(key)) {
        seen.add(key)
        clean.push({ key, inTerminal })
      }
    }
    // An empty stored list means "unbound"; a list emptied by this filter does not.
    if (clean.length > 0 || list.length === 0) out[command] = clean
  }
  return out
}
