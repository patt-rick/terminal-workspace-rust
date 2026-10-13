# Editable Keybindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user rebind any command in a Keyboard settings tab, and choose per shortcut whether the app or the terminal gets the key while a terminal is focused.

**Architecture:** `src/lib/keybindings.ts` grows from a fixed table into a pure model: platform defaults, user overrides, the effective list, and editing helpers. Overrides live in the existing settings store. A small state module caches the effective list for the keyboard handler, the terminal's key filter and the UI hints. A new settings section records shortcuts by key press.

**Tech Stack:** React 19, Zustand 5, Tailwind v4, Vitest. No Rust changes.

Spec: `docs/superpowers/specs/2026-10-13-editable-keybindings-design.md`

**Conventions for every task:**

- Tests: `pnpm test`. Typecheck: `pnpm typecheck` (`noUnusedLocals` and `noUnusedParameters` are on).
- Commit messages follow the repo's conventional style and carry **no** `Co-Authored-By` trailer. The repo commits directly to `master`.
- Do not add comments unless they say something the code cannot (project rule).
- Keep each existing file's line endings (several are CRLF). New files use LF.

---

## File Structure

**New:**
- `src/state/keybindings.ts` — current effective bindings (cached), hooks for components.
- `src/components/settings/keyboard-section.tsx` — the Keyboard settings tab.

**Replaced:**
- `src/lib/keybindings.ts` + `src/lib/keybindings.test.ts` — the pure model.

**Modified:**
- `src/state/settings.ts` — `keybindingOverrides` field and setter.
- `src/lib/settings-tabs.ts` — the `keyboard` tab.
- `src/components/settings-modal.tsx` — render the section.
- `src/app.tsx` — handler uses current bindings and the terminal switch; hints.
- `src/components/workspace/terminal-pane.tsx` — key filter uses current bindings.
- `src/commands/app-commands.ts` — palette hints use current bindings.
- `src/components/sidebar/project-list.tsx` — menu hints.
- `README.md`, `CHANGELOG.md`.

---

### Task 1: The keybinding model

**Files:**
- Replace: `src/lib/keybindings.ts`
- Replace: `src/lib/keybindings.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/keybindings.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import {
  bindingForEvent,
  commandForEvent,
  defaultKeybindings,
  effectiveKeybindings,
  eventKey,
  formatKey,
  isBindableKey,
  isReservedKey,
  resetCommand,
  sanitizeOverrides,
  shortcutLabel,
  terminalConsumes,
  withBinding,
  withInTerminal,
  withoutBinding,
  withShortcut,
  type KeybindingOverrides,
} from './keybindings'

const WIN = false
const MAC = true
const winDefaults = defaultKeybindings(WIN)

const ev = (key: string, mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

const commandOf = (key: string, overrides: KeybindingOverrides): string | undefined =>
  effectiveKeybindings(winDefaults, overrides).find((b) => b.key === key)?.command

describe('eventKey', () => {
  it('writes the platform modifier as mod and lower-cases the key', () => {
    expect(eventKey(ev('t', { ctrl: true }), WIN)).toBe('mod+t')
    expect(eventKey(ev('K', { meta: true }), MAC)).toBe('mod+k')
    expect(eventKey(ev('T', { ctrl: true, shift: true }), WIN)).toBe('mod+shift+t')
    expect(eventKey(ev(',', { ctrl: true }), WIN)).toBe('mod+,')
    expect(eventKey(ev(' ', { ctrl: true }), WIN)).toBe('mod+space')
  })

  it('leaves the modifier of the other platform alone', () => {
    expect(eventKey(ev('k', { ctrl: true }), MAC)).toBeNull()
    expect(eventKey(ev('k', { meta: true }), WIN)).toBeNull()
    expect(eventKey(ev('k', { ctrl: true, meta: true }), MAC)).toBeNull()
  })

  it('is null without a modifier, with alt, or for a bare modifier key', () => {
    expect(eventKey(ev('t'), WIN)).toBeNull()
    expect(eventKey(ev('t', { ctrl: true, alt: true }), WIN)).toBeNull()
    expect(eventKey(ev('Control', { ctrl: true }), WIN)).toBeNull()
    expect(eventKey(ev('Shift', { ctrl: true, shift: true }), WIN)).toBeNull()
  })
})

describe('defaultKeybindings', () => {
  it('resolves every default shortcut', () => {
    const cases: [ReturnType<typeof ev>, string][] = [
      [ev('k', { ctrl: true }), 'palette.toggle'],
      [ev('P', { ctrl: true, shift: true }), 'palette.toggle'],
      [ev(',', { ctrl: true }), 'view.settings'],
      [ev('b', { ctrl: true }), 'view.toggleSidebar'],
      [ev('B', { ctrl: true, shift: true }), 'view.toggleRightSidebar'],
      [ev('p', { ctrl: true }), 'file.quickOpen'],
      [ev('U', { ctrl: true, shift: true }), 'view.usage'],
      [ev('t', { ctrl: true }), 'terminal.new'],
      [ev('T', { ctrl: true, shift: true }), 'terminal.newClaude'],
      [ev('D', { ctrl: true, shift: true }), 'terminal.newClaudeSkipPermissions'],
      [ev('w', { ctrl: true }), 'terminal.close'],
    ]
    for (const [event, command] of cases) expect(commandForEvent(event, WIN)).toBe(command)
    expect(commandForEvent(ev('w', { meta: true }), MAC)).toBe('terminal.close')
    expect(commandForEvent(ev('z', { ctrl: true }), WIN)).toBeNull()
  })

  it('binds each key once', () => {
    const keys = winDefaults.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('off macOS leaves the keys the terminal takes with the terminal, except the palette', () => {
    const off = winDefaults.filter((b) => !b.inTerminal).map((b) => b.key).sort()
    expect(off).toEqual(['mod+b', 'mod+p', 'mod+t', 'mod+w'])
    expect(winDefaults.find((b) => b.key === 'mod+k')!.inTerminal).toBe(true)
  })

  it('on macOS gives every shortcut to the app', () => {
    expect(defaultKeybindings(MAC).every((b) => b.inTerminal)).toBe(true)
  })
})

describe('terminalConsumes', () => {
  it('is true off macOS for the keys xterm sends to the shell', () => {
    expect(terminalConsumes('mod+t', WIN)).toBe(true)
    expect(terminalConsumes('mod+space', WIN)).toBe(true)
    expect(terminalConsumes('mod+\\', WIN)).toBe(true)
    expect(terminalConsumes('mod+arrowleft', WIN)).toBe(true)
    expect(terminalConsumes('mod+shift+enter', WIN)).toBe(true)
    expect(terminalConsumes('mod+f5', WIN)).toBe(true)
  })

  it('is false for keys xterm ignores, and for everything on macOS', () => {
    expect(terminalConsumes('mod+shift+t', WIN)).toBe(false)
    expect(terminalConsumes('mod+,', WIN)).toBe(false)
    expect(terminalConsumes('mod+9', WIN)).toBe(false)
    expect(terminalConsumes('mod+t', MAC)).toBe(false)
  })
})

describe('effectiveKeybindings', () => {
  it('returns the defaults when there are no overrides', () => {
    expect(effectiveKeybindings(winDefaults, {})).toEqual(winDefaults)
  })

  it('replaces a command\'s defaults with its override list', () => {
    const overrides = { 'terminal.new': [{ key: 'mod+shift+n', inTerminal: true }] }
    expect(commandOf('mod+shift+n', overrides)).toBe('terminal.new')
    expect(commandOf('mod+t', overrides)).toBeUndefined()
  })

  it('unbinds a command whose override list is empty', () => {
    expect(commandOf('mod+k', { 'palette.toggle': [] })).toBeUndefined()
    expect(commandOf('mod+shift+p', { 'palette.toggle': [] })).toBeUndefined()
  })

  it('lets an override win a key from a default', () => {
    const overrides = { 'theme.halcyon': [{ key: 'mod+t', inTerminal: false }] }
    expect(commandOf('mod+t', overrides)).toBe('theme.halcyon')
  })
})

describe('bindingForEvent', () => {
  it('returns the whole binding, including the terminal switch', () => {
    expect(bindingForEvent(ev('t', { ctrl: true }), WIN, winDefaults)).toEqual({
      key: 'mod+t',
      command: 'terminal.new',
      inTerminal: false,
    })
    expect(bindingForEvent(ev('z', { ctrl: true }), WIN, winDefaults)).toBeNull()
  })
})

describe('editing helpers', () => {
  it('withBinding adds a key and takes it from the command that had it', () => {
    const next = withBinding({}, winDefaults, 'theme.halcyon', { key: 'mod+t', inTerminal: false })
    expect(next).toEqual({
      'terminal.new': [],
      'theme.halcyon': [{ key: 'mod+t', inTerminal: false }],
    })
    expect(commandOf('mod+t', next)).toBe('theme.halcyon')
  })

  it('withBinding takes the key from every command, not only the one that wins it', () => {
    const stored = {
      'theme.c': [],
      'theme.a': [{ key: 'mod+shift+9', inTerminal: true }],
      'theme.b': [{ key: 'mod+shift+9', inTerminal: true }],
    }
    const next = withBinding(stored, winDefaults, 'theme.c', { key: 'mod+shift+9', inTerminal: true })
    expect(next).toEqual({ 'theme.c': [{ key: 'mod+shift+9', inTerminal: true }] })
  })

  it('withBinding keeps a command\'s other keys', () => {
    const next = withBinding({}, winDefaults, 'palette.toggle', { key: 'mod+shift+k', inTerminal: true })
    expect(next['palette.toggle'].map((k) => k.key)).toEqual(['mod+k', 'mod+shift+p', 'mod+shift+k'])
  })

  it('withoutBinding removes one key', () => {
    const next = withoutBinding({}, winDefaults, 'palette.toggle', 'mod+k')
    expect(next).toEqual({ 'palette.toggle': [{ key: 'mod+shift+p', inTerminal: true }] })
  })

  it('withInTerminal flips the switch for one key', () => {
    const next = withInTerminal({}, winDefaults, 'terminal.new', 'mod+t', true)
    expect(next).toEqual({ 'terminal.new': [{ key: 'mod+t', inTerminal: true }] })
  })

  it('drops an override that has become equal to the default', () => {
    const flipped = withInTerminal({}, winDefaults, 'terminal.new', 'mod+t', true)
    expect(withInTerminal(flipped, winDefaults, 'terminal.new', 'mod+t', false)).toEqual({})
  })

  it('resetCommand restores a command\'s defaults and takes its keys back', () => {
    const moved = withBinding({}, winDefaults, 'theme.halcyon', { key: 'mod+t', inTerminal: false })
    const reset = resetCommand(moved, winDefaults, 'terminal.new')
    expect(reset).toEqual({})
    expect(commandOf('mod+t', reset)).toBe('terminal.new')
  })
})

describe('sanitizeOverrides', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(
      sanitizeOverrides({
        'terminal.new': [{ key: 'mod+shift+n', inTerminal: true }, { key: 'x', inTerminal: true }, 7],
        'palette.toggle': [],
        'view.usage': 'nope',
        'view.settings': [{ key: 'mod+c', inTerminal: true }],
        'view.usage2': [{ key: 'mod+shift+n', inTerminal: false }],
      })
    ).toEqual({
      'terminal.new': [{ key: 'mod+shift+n', inTerminal: true }],
      'palette.toggle': [],
    })
  })

  it('returns an empty object for anything that is not a plain object', () => {
    expect(sanitizeOverrides(null)).toEqual({})
    expect(sanitizeOverrides([1])).toEqual({})
    expect(sanitizeOverrides('x')).toEqual({})
    expect(sanitizeOverrides(undefined)).toEqual({})
  })
})

describe('keys and labels', () => {
  it('knows the reserved editing keys', () => {
    expect(isReservedKey('mod+c')).toBe(true)
    expect(isReservedKey('mod+shift+v')).toBe(true)
    expect(isReservedKey('mod+t')).toBe(false)
  })

  it('accepts only mod-based, non-reserved keys', () => {
    expect(isBindableKey('mod+t')).toBe(true)
    expect(isBindableKey('mod+shift+f5')).toBe(true)
    expect(isBindableKey('mod+space')).toBe(true)
    expect(isBindableKey('t')).toBe(false)
    expect(isBindableKey('mod+')).toBe(false)
    expect(isBindableKey('mod+shift+')).toBe(false)
    expect(isBindableKey('mod+T')).toBe(false)
    expect(isBindableKey('mod+alt+x')).toBe(false)
    expect(isBindableKey('mod+dead')).toBe(false)
    expect(isBindableKey('mod+s')).toBe(false)
  })

  it('formats keys for the platform', () => {
    expect(formatKey('mod+shift+t', WIN)).toBe('Ctrl+Shift+T')
    expect(formatKey('mod+shift+t', MAC)).toBe('⌘⇧T')
    expect(formatKey('mod+,', WIN)).toBe('Ctrl+,')
    expect(formatKey('mod+enter', WIN)).toBe('Ctrl+Enter')
    expect(formatKey('mod+arrowleft', WIN)).toBe('Ctrl+Left')
    expect(formatKey('mod+space', MAC)).toBe('⌘Space')
  })

  it('labels a command by its first binding', () => {
    expect(shortcutLabel('terminal.newClaude', WIN)).toBe('Ctrl+Shift+T')
    expect(shortcutLabel('palette.toggle', WIN)).toBe('Ctrl+K')
    expect(shortcutLabel('project.add', WIN)).toBeNull()
    const moved = effectiveKeybindings(winDefaults, {
      'project.add': [{ key: 'mod+shift+a', inTerminal: true }],
    })
    expect(shortcutLabel('project.add', WIN, moved)).toBe('Ctrl+Shift+A')
  })

  it('appends a shortcut to a label only when there is one', () => {
    expect(withShortcut('Usage', 'Ctrl+Shift+U')).toBe('Usage (Ctrl+Shift+U)')
    expect(withShortcut('Usage', '')).toBe('Usage')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/keybindings.test.ts`
Expected: FAIL — the file cannot import `defaultKeybindings`, `effectiveKeybindings` and the other new names from `./keybindings`.

- [ ] **Step 3: Implement**

Replace `src/lib/keybindings.ts` with:

```ts
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

const KEY_PATTERN = /^mod\+(shift\+)?(?!shift\+|alt\+)[^\sA-Z]+$/
// What the browser reports for a key it could not name.
const UNNAMED_KEY = /\+(dead|unidentified|process)$/

const TERMINAL_CTRL = /^mod\+([a-z]|space|[3-8]|\[|\\|\]|shift\+[@_])$/
const TERMINAL_NAMED =
  /^mod\+(shift\+)?(enter|backspace|tab|escape|delete|insert|home|end|pageup|pagedown|arrow(up|down|left|right)|f\d{1,2})$/

/**
 * Off macOS, xterm turns these into control characters or escape sequences for
 * the shell and stops the event, so the app never sees them unless the terminal
 * is told to let them through.
 */
export function terminalConsumes(key: string, isMac: boolean): boolean {
  return !isMac && (TERMINAL_CTRL.test(key) || TERMINAL_NAMED.test(key))
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
  return RESERVED_KEYS.has(key)
}

export function isBindableKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !UNNAMED_KEY.test(key) && !RESERVED_KEYS.has(key)
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

function sameSettings(a: KeySetting[], b: KeySetting[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.key === b[i].key && s.inTerminal === b[i].inTerminal)
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/keybindings.test.ts`
Expected: PASS, 28 tests.

Then run `pnpm typecheck`. It will report the callers of the removed `DEFAULT_KEYBINDINGS` export, if any; `src/commands/app-commands.ts`, `src/app.tsx` and `src/components/workspace/terminal-pane.tsx` only use `shortcutLabel` and `commandForEvent`, which keep their signatures, so it should exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/keybindings.ts src/lib/keybindings.test.ts
git commit -m "feat(keybindings): overrides, terminal switch and editing helpers in the key model"
```

---

### Task 2: Store the overrides and expose the current bindings

**Files:**
- Modify: `src/state/settings.ts`
- Create: `src/state/keybindings.ts`

- [ ] **Step 1: Add the field to the settings store**

In `src/state/settings.ts`:

Add the import beside the other imports:

```ts
import { sanitizeOverrides, type KeybindingOverrides } from '../lib/keybindings'
```

In `interface Settings`, after `customThemes: Theme[]`:

```ts
  /** User changes to keyboard shortcuts, on top of the platform defaults. */
  keybindingOverrides: KeybindingOverrides
```

In `SETTINGS_DEFAULTS`, after `customThemes: [],`:

```ts
  keybindingOverrides: {},
```

In `readStoredSettings`, after the `customThemes:` line of the returned object:

```ts
      keybindingOverrides: sanitizeOverrides(parsed.keybindingOverrides),
```

In `interface SettingsState`, before `replaceAll`:

```ts
  setKeybindingOverrides: (overrides: KeybindingOverrides) => void
```

In the store body, change `snapshot` to include the field:

```ts
  const snapshot = (): Settings => {
    const {
      themeId,
      themeShuffle,
      lastShuffleDate,
      editor,
      terminal,
      identity,
      customThemes,
      keybindingOverrides,
    } = get()
    return {
      themeId,
      themeShuffle,
      lastShuffleDate,
      editor,
      terminal,
      identity,
      customThemes,
      keybindingOverrides,
    }
  }
```

Add the setter before `replaceAll:`:

```ts
    setKeybindingOverrides: (overrides) => {
      set({ keybindingOverrides: overrides })
      commit()
    },
```

In `replaceAll`, add to the object passed to `set`, after `customThemes: s.customThemes,`:

```ts
        keybindingOverrides: sanitizeOverrides(s.keybindingOverrides),
```

A deleted custom theme must not leave a shortcut behind that has no row to edit it. Replace the body of `removeCustomTheme` with:

```ts
    removeCustomTheme: (id) => {
      set((state) => {
        const keybindingOverrides = { ...state.keybindingOverrides }
        delete keybindingOverrides[`theme.${id}`]
        return {
          customThemes: state.customThemes.filter((t) => t.meta.id !== id),
          themeId: state.themeId === id ? DEFAULT_THEME_ID : state.themeId,
          keybindingOverrides,
        }
      })
      commit()
    },
```

- [ ] **Step 2: Create the current-bindings module**

Create `src/state/keybindings.ts`:

```ts
import { useMemo } from 'react'
import {
  defaultKeybindings,
  effectiveKeybindings,
  shortcutLabel,
  type Keybinding,
  type KeybindingOverrides,
} from '../lib/keybindings'
import { isMac } from '../lib/platform'
import { useSettings } from './settings'

const DEFAULTS = defaultKeybindings(isMac)

let cached: { overrides: KeybindingOverrides; bindings: Keybinding[] } | null = null

export function platformDefaults(): Keybinding[] {
  return DEFAULTS
}

/** For event handlers: recomputed only when the stored overrides change. */
export function currentKeybindings(): Keybinding[] {
  const overrides = useSettings.getState().keybindingOverrides
  if (cached === null || cached.overrides !== overrides) {
    cached = { overrides, bindings: effectiveKeybindings(DEFAULTS, overrides) }
  }
  return cached.bindings
}

export function useKeybindings(): Keybinding[] {
  const overrides = useSettings((s) => s.keybindingOverrides)
  return useMemo(() => effectiveKeybindings(DEFAULTS, overrides), [overrides])
}

/** The label of a command's first shortcut, or '' when it has none. */
export function useShortcutLabel(command: string): string {
  const bindings = useKeybindings()
  return shortcutLabel(command, isMac, bindings) ?? ''
}
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Before running, fix the one existing caller that builds a whole `Settings` object: in `src/state/theme-shuffle.test.ts`, add `keybindingOverrides: {},` after `customThemes: [],` in the object passed to `replaceAll` (near line 17). Without it `tsc` fails with TS2345.

Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/state/settings.ts src/state/keybindings.ts src/state/theme-shuffle.test.ts
git commit -m "feat(keybindings): persist overrides in settings and expose the current bindings"
```

---

### Task 3: Use the current bindings everywhere a shortcut is read

**Files:**
- Modify: `src/app.tsx`
- Modify: `src/components/workspace/terminal-pane.tsx`
- Modify: `src/commands/app-commands.ts`
- Modify: `src/components/sidebar/project-list.tsx`

- [ ] **Step 1: The window handler**

In `src/app.tsx`, change the keybindings import to:

```tsx
import { bindingForEvent, withShortcut } from './lib/keybindings'
import { currentKeybindings, useShortcutLabel } from './state/keybindings'
```

Replace the body of `onKey` so the effect reads:

```tsx
  // Every shortcut is a binding (lib/keybindings.ts) that names a registry
  // command. A binding with the terminal switch off does nothing while a
  // terminal has focus; xterm has already had the key by then. The default is
  // still prevented, so e.g. Ctrl+Shift+P never opens the webview print dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The editor prevents the default for keys it handles itself.
      if (e.defaultPrevented) return
      const binding = bindingForEvent(e, isMac, currentKeybindings())
      if (binding === null) return
      e.preventDefault()
      if (e.repeat) return
      const inTerminal = document.activeElement?.closest('.xterm') != null
      if (inTerminal && !binding.inTerminal) return
      // The palette's list was built when it opened; other shortcuts acting
      // behind it would make that list stale.
      const command = binding.command
      const behindPalette = command !== 'palette.toggle' && command !== 'file.quickOpen'
      if (useUi.getState().paletteOpen && behindPalette) return
      runCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
```

- [ ] **Step 2: The hints in `src/app.tsx`**

After the `const toggleUsage = useUsage((s) => s.togglePage)` line, add:

```tsx
  const sidebarKey = useShortcutLabel('view.toggleSidebar')
  const rightSidebarKey = useShortcutLabel('view.toggleRightSidebar')
  const usageKey = useShortcutLabel('view.usage')
  const settingsKey = useShortcutLabel('view.settings')
  const newTerminalKey = useShortcutLabel('terminal.new')
```

Replace the five hard-coded hints:

| Old | New |
|---|---|
| ``title={`Show sidebar (${kbd('B')})`}`` | `title={withShortcut('Show sidebar', sidebarKey)}` |
| ``title={`Usage (${kbd('⇧U')})`}`` | `title={withShortcut('Usage', usageKey)}` |
| ``title={`Settings (${kbd(',')})`}`` | `title={withShortcut('Settings', settingsKey)}` |
| ``title={`Toggle panel (${kbd('⇧B')})`}`` | `title={withShortcut('Toggle panel', rightSidebarKey)}` |
| ``actionLabel={`New terminal (${kbd('T')})`}`` | `actionLabel={withShortcut('New terminal', newTerminalKey)}` |

Then change `import { isMac, kbd } from './lib/platform'` to `import { isMac } from './lib/platform'`.

- [ ] **Step 3: The terminal's key filter**

In `src/components/workspace/terminal-pane.tsx`, replace the three lines added with the palette (the two-line comment and the `commandForEvent` check) with:

```ts
      // xterm would send a Ctrl+letter shortcut to the shell and stop the
      // event. Returning false leaves it for the app, for the bindings the
      // user has given to the app while a terminal is focused.
      if (bindingForEvent(e, isMac, currentKeybindings())?.inTerminal) return false
```

and replace the `commandForEvent` import with:

```ts
import { bindingForEvent } from '../../lib/keybindings'
import { currentKeybindings } from '../../state/keybindings'
```

- [ ] **Step 4: The palette's hints**

In `src/commands/app-commands.ts`, add the import:

```ts
import { currentKeybindings } from '../state/keybindings'
```

and change the hint line in `paletteItems()` to:

```ts
      hint: shortcutLabel(command.id, isMac, currentKeybindings()) ?? '',
```

- [ ] **Step 5: The project menu's hints**

In `src/components/sidebar/project-list.tsx`:

Add the import and change the platform import (keep `isMac` only if the file still uses it; `tsc` will say):

```ts
import { useShortcutLabel } from '../../state/keybindings'
```

`menuItems` is built inside a component that renders one project row. At the top of that component, with its other hooks, add:

```ts
  const newTerminalKey = useShortcutLabel('terminal.new')
  const newClaudeKey = useShortcutLabel('terminal.newClaude')
```

Replace `trailing: <Hint>{kbd('T')}</Hint>,` with:

```tsx
      trailing: newTerminalKey ? <Hint>{newTerminalKey}</Hint> : undefined,
```

and replace `trailing: <Hint>{kbd('⇧T')}</Hint>,` in the `Claude Code` item with:

```tsx
      trailing: newClaudeKey ? <Hint>{newClaudeKey}</Hint> : undefined,
```

Remove `kbd` from the platform import.

- [ ] **Step 6: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: both pass. If `tsc` reports `kbd` unused in `src/lib/platform.ts` it will not (exports are never "unused"); leave the export.

- [ ] **Step 7: Commit**

```bash
git add src/app.tsx src/components/workspace/terminal-pane.tsx src/commands/app-commands.ts src/components/sidebar/project-list.tsx
git commit -m "feat(keybindings): handler, terminal filter and hints read the current bindings"
```

---

### Task 4: The Keyboard settings tab

**Files:**
- Modify: `src/lib/settings-tabs.ts`
- Create: `src/components/settings/keyboard-section.tsx`
- Modify: `src/components/settings-modal.tsx`

- [ ] **Step 1: Add the tab**

In `src/lib/settings-tabs.ts`, add `'keyboard'` to the union after `'general'` and the entry after General:

```ts
export type SettingsTabId = 'general' | 'keyboard' | 'ai' | 'github' | 'remote' | 'updates'
```

```ts
  { id: 'keyboard', label: 'Keyboard' },
```

- [ ] **Step 2: Write the section**

Create `src/components/settings/keyboard-section.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { appCommands } from '../../commands/app-commands'
import {
  eventKey,
  formatKey,
  isBindableKey,
  isModifierKey,
  isReservedKey,
  resetCommand,
  terminalConsumes,
  withBinding,
  withInTerminal,
  withoutBinding,
} from '../../lib/keybindings'
import { isMac } from '../../lib/platform'
import { platformDefaults, useKeybindings } from '../../state/keybindings'
import { useSettings } from '../../state/settings'

interface Recording {
  command: string
  message: string | null
  /** a pressed key that another command already has */
  clash: { key: string; other: string } | null
}

const MOD_NAME = isMac ? 'Cmd' : 'Ctrl'

/**
 * Shortcuts are recorded by pressing them; there is no text field. While
 * recording, the press is stopped here so it neither runs its current command
 * nor closes Settings.
 */
export function KeyboardSection() {
  const overrides = useSettings((s) => s.keybindingOverrides)
  const setOverrides = useSettings((s) => s.setKeybindingOverrides)
  const bindings = useKeybindings()
  const defaults = platformDefaults()
  const commands = useMemo(() => appCommands().map((c) => ({ id: c.id, title: c.title })), [])
  const [recording, setRecording] = useState<Recording | null>(null)
  const recordRef = useRef<HTMLButtonElement>(null)

  // Focused explicitly: the "Add" and recording buttons share a DOM node, so
  // autoFocus would not fire, and not every webview focuses a button on click.
  const waitingFor = recording !== null && recording.clash === null ? recording.command : null
  useEffect(() => {
    if (waitingFor !== null) recordRef.current?.focus()
  }, [waitingFor])

  const titleOf = (id: string): string => commands.find((c) => c.id === id)?.title ?? id

  const assign = (command: string, key: string): void => {
    setOverrides(
      withBinding(overrides, defaults, command, { key, inTerminal: !terminalConsumes(key, isMac) })
    )
    setRecording(null)
  }

  const onRecordKey = (e: React.KeyboardEvent, command: string): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      return
    }
    if (isModifierKey(e.key)) return
    const key = eventKey(e, isMac)
    if (key === null) {
      setRecording({ command, message: `Use ${MOD_NAME} with a key`, clash: null })
      return
    }
    if (isReservedKey(key)) {
      setRecording({ command, message: 'That key is used for editing', clash: null })
      return
    }
    if (!isBindableKey(key)) {
      setRecording({ command, message: 'That key cannot be used', clash: null })
      return
    }
    const holder = bindings.find((b) => b.key === key)
    if (holder && holder.command !== command) {
      setRecording({ command, message: null, clash: { key, other: holder.command } })
      return
    }
    if (holder) {
      setRecording(null)
      return
    }
    assign(command, key)
  }

  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Keyboard</div>
      <p className="mb-3 text-xs text-muted">
        “In terminal” decides whether a shortcut works while a terminal has focus. Off, the key
        is left to the program running in the terminal.
      </p>
      <div className="flex flex-col">
        {commands.map((c) => {
          const keys = bindings.filter((b) => b.command === c.id)
          const active = recording?.command === c.id ? recording : null
          return (
            <div key={c.id} className="flex flex-col gap-1.5 border-b border-border/50 py-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="pt-0.5 text-foreground/80">{c.title}</span>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {keys.map((b) => (
                    <span
                      key={b.key}
                      className="flex items-center gap-2 rounded-md border border-border px-2 py-0.5 text-xs"
                    >
                      <span className="text-foreground">{formatKey(b.key, isMac)}</span>
                      <label className="flex cursor-pointer items-center gap-1 text-muted">
                        <input
                          type="checkbox"
                          checked={b.inTerminal}
                          onChange={(e) =>
                            setOverrides(
                              withInTerminal(overrides, defaults, c.id, b.key, e.target.checked)
                            )
                          }
                        />
                        in terminal
                      </label>
                      <button
                        type="button"
                        onClick={() => setOverrides(withoutBinding(overrides, defaults, c.id, b.key))}
                        title="Remove shortcut"
                        className="text-muted hover:text-foreground"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {active && !active.clash ? (
                    <button
                      type="button"
                      ref={recordRef}
                      onKeyDown={(e) => onRecordKey(e, c.id)}
                      onBlur={() => setRecording((r) => (r !== null && r.clash === null ? null : r))}
                      className="rounded-md border border-accent px-2 py-0.5 text-xs text-accent outline-none"
                    >
                      Press a shortcut…
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRecording({ command: c.id, message: null, clash: null })}
                      className="rounded-md border border-border px-2 py-0.5 text-xs text-muted hover:text-foreground"
                    >
                      Add
                    </button>
                  )}
                  {overrides[c.id] !== undefined && (
                    <button
                      type="button"
                      onClick={() => setOverrides(resetCommand(overrides, defaults, c.id))}
                      className="text-xs text-link hover:underline"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              {active?.message && <div className="text-right text-xs text-warning">{active.message}</div>}
              {active?.clash && (
                <div className="flex items-center justify-end gap-3 text-xs">
                  <span className="text-warning">
                    {formatKey(active.clash.key, isMac)} is used by {titleOf(active.clash.other)}
                  </span>
                  <button
                    type="button"
                    onClick={() => assign(c.id, active.clash!.key)}
                    className="text-link hover:underline"
                  >
                    Move it here
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecording(null)}
                    className="text-muted hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => {
            setOverrides({})
            setRecording(null)
          }}
          disabled={Object.keys(overrides).length === 0}
          className="rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-foreground disabled:opacity-40"
        >
          Reset all
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render it**

In `src/components/settings-modal.tsx`, add the import:

```tsx
import { KeyboardSection } from './settings/keyboard-section'
```

and add this line directly before `{tab === 'github' && <AccountsSection />}`:

```tsx
          {tab === 'keyboard' && <KeyboardSection />}
```

- [ ] **Step 4: Typecheck, test and build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass (147 tests: the 127 before this plan, less the 8 old keybinding tests, plus 28 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings-tabs.ts src/components/settings/keyboard-section.tsx src/components/settings-modal.tsx
git commit -m "feat(keybindings): keyboard settings tab with shortcut recording"
```

---

### Task 5: Verify in the running app, then document

**Files:**
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Launch**

Confirm at least 5 GB free on drive C:, then run `pnpm tauri dev`. If there is less, stop and report: do not mark the checks below as passed.

- [ ] **Step 2: Check each behaviour on Windows and record the result**

1. Defaults: in a focused terminal `Ctrl+T` still goes to the shell; `Ctrl+Shift+T` still opens a Claude terminal; `Ctrl+K` still opens the palette.
2. Settings → Keyboard lists every command. `Ctrl+T` shows "in terminal" unchecked; `Ctrl+Shift+T` shows it checked.
3. Tick "in terminal" on `Ctrl+T`, close Settings, focus a terminal, press `Ctrl+T`: a new terminal opens. Untick it again: back to the shell.
4. Untick "in terminal" on `Ctrl+Shift+T`: pressing it in a focused terminal does nothing; with focus on the sidebar it still works.
5. Add → press `Ctrl+Shift+F9` on a theme command: the chip appears, no terminal opens during recording, and the shortcut switches theme. Restart the app: it is still there.
6. Add → press `Ctrl+T` on another command: "is used by New terminal" with Move it here; moving it removes it from New terminal. Reset on New terminal brings it back and removes it from the other command.
7. Add → press `Ctrl+C`: refused as an editing key. Add → press `T` alone: "Use Ctrl with a key". Add → `Esc`: cancelled, Settings stays open.
8. The empty-state button, the header button tooltips and the project menu show the current shortcut, and no hint when a command has none.
9. Reset all restores the defaults.

- [ ] **Step 3: Changelog**

In `CHANGELOG.md`, under `## [Unreleased]`, add to the `### Added` list:

```markdown
- Keyboard settings: rebind any command by pressing the new shortcut, and choose per
  shortcut whether the app or the terminal gets the key while a terminal is focused.
```

- [ ] **Step 4: README**

Replace the two-line note under the Keyboard shortcuts table ("Every command is also in the command palette…") with:

```markdown
These are the defaults; change them in **Settings → Keyboard**. On Windows and Linux a
focused terminal keeps `Ctrl+T`, `Ctrl+W`, `Ctrl+P` and `Ctrl+B` for the shell unless you
turn on "in terminal" for them there. Every command is also in the command palette, which
works from anywhere.
```

- [ ] **Step 5: Final check and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`

```bash
git add CHANGELOG.md README.md
git commit -m "docs(keybindings): changelog and readme for editable keybindings"
```

---

## Changes made during the build

From the code review, after the tasks above:

- `isReservedKey` also refuses `mod` with Backspace, Delete, Home, End or an arrow, which
  every text field uses.
- `terminalConsumes` is true on macOS for the named keys xterm still sends with Cmd held
  (Enter, Backspace, Tab, Escape, Delete, function keys).
- `sameSettings` ignores order, so removing a default key and adding it back leaves no
  override.
- The Keyboard tab lists a stored shortcut whose command no longer exists as "Unknown
  command", so it can be removed.
- The editor's `Mod-Shift-u` binding is dropped on macOS so `Cmd+Shift+U` still opens
  Usage from the editor now that the app's handler yields to keys the editor handled.
- The unused `kbd` helper was removed from `src/lib/platform.ts`.

The suite is 149 tests after these changes.

## Spec coverage

| Spec section | Task |
|---|---|
| Model: defaults, overrides, effective list, helpers, sanitising | 1 |
| Persistence | 2 |
| Window handler, terminal key filter, current bindings, hints | 2, 3 |
| The settings page | 4 |
| Error handling | 1, 2 |
| Testing | 1, 5 |
