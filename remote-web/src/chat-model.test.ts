import { describe, expect, it } from 'vitest'
import { hasPendingTool, promptSequences, resolvesTool, upsertMessages } from './chat-model'
import type { ChatMessage } from './protocol'

const msg = (id: string, text: string): ChatMessage => ({
  id,
  role: 'assistant',
  ts: '',
  blocks: [{ kind: 'text', text }],
})

describe('upsertMessages', () => {
  it('replaces existing ids in place and appends new ones', () => {
    const list = [msg('a', '1'), msg('b', '2')]
    const out = upsertMessages(list, [msg('a', '1+'), msg('c', '3')])
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(out[0].blocks[0]).toEqual({ kind: 'text', text: '1+' })
    expect(list[0].blocks[0]).toEqual({ kind: 'text', text: '1' }) // not mutated
  })
})

describe('promptSequences', () => {
  it('clears the input line, wraps text in bracketed paste and strips ESC', () => {
    expect(promptSequences('hi\x1b[201~ there\n')).toEqual({
      clear: '\x15',
      paste: '\x1b[200~hi[201~ there\x1b[201~',
      enter: '\r',
    })
  })
  it('keeps inner newlines', () => {
    expect(promptSequences('a\nb')?.paste).toBe('\x1b[200~a\nb\x1b[201~')
  })
  it('returns null for blank input', () => {
    expect(promptSequences('  \n ')).toBeNull()
  })
})

describe('resolvesTool / hasPendingTool', () => {
  const ok = { ok: true, preview: '' }
  const tools = (t2: typeof ok | null): ChatMessage => ({
    id: 'm',
    role: 'assistant',
    ts: '',
    blocks: [
      { kind: 'toolUse', id: 't1', name: 'Read', summary: 'a', result: ok },
      { kind: 'toolUse', id: 't2', name: 'Bash', summary: 'ls', result: t2 },
    ],
  })
  it('is true only when a previously pending tool call gets its result', () => {
    const prev = [tools(null)]
    // Same merged message re-sent: t1 was already done, t2 still waits.
    expect(resolvesTool(prev, [tools(null)])).toBe(false)
    expect(resolvesTool(prev, [tools(ok)])).toBe(true)
    expect(resolvesTool([], [tools(ok)])).toBe(false)
  })
  it('sees a tool call still waiting', () => {
    expect(hasPendingTool([tools(null)])).toBe(true)
    expect(hasPendingTool([tools(ok)])).toBe(false)
  })
})
