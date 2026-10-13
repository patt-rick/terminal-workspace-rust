import { describe, expect, it } from 'vitest'
import { hoverLines, projectBadge, terminalState } from './project-status'

describe('terminalState', () => {
  it('is busy even when there is unread output', () => {
    expect(terminalState('a', { a: true }, { a: 3 })).toBe('busy')
  })

  it('is unread when not busy and output arrived', () => {
    expect(terminalState('a', {}, { a: 1 })).toBe('unread')
  })

  it('is idle otherwise', () => {
    expect(terminalState('a', {}, {})).toBe('idle')
    expect(terminalState('a', { a: false }, { a: 0 })).toBe('idle')
  })
})

describe('projectBadge', () => {
  it('is busy if any terminal is busy', () => {
    expect(projectBadge(['a', 'b'], { b: true }, { a: 2 })).toBe('busy')
  })

  it('is unread if none is busy and any has unread output', () => {
    expect(projectBadge(['a', 'b'], {}, { a: 2 })).toBe('unread')
  })

  it('is null when all are idle or there are no terminals', () => {
    expect(projectBadge(['a'], {}, {})).toBeNull()
    expect(projectBadge([], { x: true }, { y: 1 })).toBeNull()
  })

  it('ignores terminals of other projects', () => {
    expect(projectBadge(['a'], { other: true }, { other: 4 })).toBeNull()
  })
})

describe('hoverLines', () => {
  const terminals = [
    { id: 'a', name: 'Claude Code' },
    { id: 'b', name: 'pwsh' },
    { id: 'c', name: 'bash' },
  ]

  it('uses the live title over the name and words each state', () => {
    const { lines, more } = hoverLines(terminals, { a: 'Fixing paste' }, { a: true }, { b: 1 })
    expect(lines).toEqual([
      { id: 'a', title: 'Fixing paste', state: 'busy', label: 'Working' },
      { id: 'b', title: 'pwsh', state: 'unread', label: 'New output' },
      { id: 'c', title: 'bash', state: 'idle', label: 'Idle' },
    ])
    expect(more).toBe(0)
  })

  it('caps at eight and counts the rest', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: `t${i}` }))
    const { lines, more } = hoverLines(nine, {}, {}, {})
    expect(lines).toHaveLength(8)
    expect(more).toBe(1)
  })

  it('is empty for a project with no terminals', () => {
    expect(hoverLines([], {}, {}, {})).toEqual({ lines: [], more: 0 })
  })
})
