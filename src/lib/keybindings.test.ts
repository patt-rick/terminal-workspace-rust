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
    expect(terminalConsumes('mod+arrowleft', MAC)).toBe(false)
  })

  it('on macOS is true only for the named keys xterm still sends with Cmd', () => {
    expect(terminalConsumes('mod+enter', MAC)).toBe(true)
    expect(terminalConsumes('mod+shift+f5', MAC)).toBe(true)
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

  it('removing a default key and adding it back leaves no override', () => {
    const removed = withoutBinding({}, winDefaults, 'palette.toggle', 'mod+k')
    expect(withBinding(removed, winDefaults, 'palette.toggle', { key: 'mod+k', inTerminal: true })).toEqual({})
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
    expect(isReservedKey('mod+backspace')).toBe(true)
    expect(isReservedKey('mod+shift+arrowleft')).toBe(true)
    expect(isReservedKey('mod+t')).toBe(false)
    expect(isReservedKey('mod+enter')).toBe(false)
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
    expect(formatKey('mod+pageup', WIN)).toBe('Ctrl+PageUp')
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
