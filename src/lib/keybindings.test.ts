import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYBINDINGS, commandForEvent, eventKey, shortcutLabel } from './keybindings'

const WIN = false
const MAC = true

const ev = (key: string, mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

describe('eventKey', () => {
  it('writes the platform modifier as mod and lower-cases the key', () => {
    expect(eventKey(ev('t', { ctrl: true }), WIN)).toBe('mod+t')
    expect(eventKey(ev('K', { meta: true }), MAC)).toBe('mod+k')
    expect(eventKey(ev('T', { ctrl: true, shift: true }), WIN)).toBe('mod+shift+t')
    expect(eventKey(ev(',', { ctrl: true }), WIN)).toBe('mod+,')
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

describe('commandForEvent', () => {
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
  })

  it('is null for unbound keys', () => {
    expect(commandForEvent(ev('u', { ctrl: true }), WIN)).toBeNull()
    expect(commandForEvent(ev('z', { ctrl: true }), WIN)).toBeNull()
    expect(commandForEvent(ev('t'), WIN)).toBeNull()
  })
})

describe('shortcutLabel', () => {
  it('formats the first binding for the platform', () => {
    expect(shortcutLabel('terminal.newClaude', false)).toBe('Ctrl+Shift+T')
    expect(shortcutLabel('terminal.newClaude', true)).toBe('⌘⇧T')
    expect(shortcutLabel('view.settings', false)).toBe('Ctrl+,')
    expect(shortcutLabel('palette.toggle', false)).toBe('Ctrl+K')
  })

  it('is null for a command with no binding', () => {
    expect(shortcutLabel('project.add', false)).toBeNull()
  })
})

describe('DEFAULT_KEYBINDINGS', () => {
  it('binds each key once', () => {
    const keys = DEFAULT_KEYBINDINGS.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
