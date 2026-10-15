import { describe, expect, it } from 'vitest'
import {
  ENTER_DELAY_MS,
  fitWithin,
  hasPendingTool,
  hasTransparency,
  IMAGE_PASTE_GAP_MS,
  joinWrapped,
  parsePermissionOptions,
  promptSequences,
  promptSteps,
  stripImagePlaceholders,
  upsertMessages,
} from './chat-model'
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

describe('hasPendingTool', () => {
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
  it('sees a tool call still waiting', () => {
    expect(hasPendingTool([tools(null)])).toBe(true)
    expect(hasPendingTool([tools(ok)])).toBe(false)
  })
  it('still sees a parallel call waiting after another one resolves', () => {
    const other: ChatMessage = {
      id: 'n',
      role: 'assistant',
      ts: '',
      blocks: [{ kind: 'toolUse', id: 't3', name: 'Bash', summary: 'mkdir x', result: null }],
    }
    const next = upsertMessages([tools(null), other], [tools(ok)])
    expect(hasPendingTool(next)).toBe(true)
  })
})

// Lines as Claude Code 2.1.300 drew a Bash permission menu at the PTY's 93 columns.
const MENU = [
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  ' Create test directory',
  ' mkdir perm-test-a1-with-a-fairly-long-directory-name-to-wrap',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don’t ask again for: mkdir',
  '      perm-test-a1-with-a-fairly-long-directory-name-to-wrap *',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
]

describe('parsePermissionOptions', () => {
  it('reads every option, joining an indented continuation line', () => {
    expect(parsePermissionOptions(MENU)).toEqual([
      'Yes',
      'Yes, and don’t ask again for: mkdir perm-test-a1-with-a-fairly-long-directory-name-to-wrap *',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No',
    ])
  })
  it('strips box-drawing borders and finds the cursor on any option', () => {
    const boxed = [
      '╭──────────────────────────────╮',
      '│ Do you want to proceed?      │',
      '│   1. Yes                     │',
      '│ ❯ 2. Yes, and don’t ask again │',
      '│   3. No, and tell Claude what │',
      '│      to do differently (esc)  │',
      '╰──────────────────────────────╯',
    ]
    expect(parsePermissionOptions(boxed)).toEqual([
      'Yes',
      'Yes, and don’t ask again',
      'No, and tell Claude what to do differently (esc)',
    ])
  })
  it('takes the menu at the bottom, not a numbered list above it', () => {
    const lines = ['● Steps:', '  1. Build', '  2. Test', '', ...MENU]
    expect(parsePermissionOptions(lines)).toHaveLength(4)
  })
  it('ignores a numbered list with no cursor marker', () => {
    expect(parsePermissionOptions(['  1. Build', '  2. Test', '  3. Ship'])).toEqual([])
  })
  it('needs a run starting at 1 with at least two options', () => {
    expect(parsePermissionOptions([' ❯ 1. Yes'])).toEqual([])
    expect(parsePermissionOptions([' ❯ 2. Yes', '   3. No'])).toEqual([])
    expect(parsePermissionOptions(['   1. Yes', ' ❯ 2. No', '   4. Maybe'])).toEqual(['Yes', 'No'])
  })
  it('ignores your own numbered prompt echoed with >', () => {
    const lines = ['> 1. fix the bug', '  2. add a test', '', '● On it.']
    expect(parsePermissionOptions(lines)).toEqual([])
    // Even with the echo lowest on screen (the menu not drawn yet).
    expect(parsePermissionOptions(['> 1. fix the bug', '  2. add a test'])).toEqual([])
  })
  it('ignores a menu that is no longer the last thing on screen', () => {
    expect(parsePermissionOptions([...MENU, '', '● Bash(mkdir x)', '  ⎿  Done'])).toEqual([])
  })
  it('returns nothing for a garbled phone-width render', () => {
    const garbled = [
      'W╌❯o2yoperm-test-a1-with-a-fairly-long-directo',
      'r  3. Yes, andpswitch to auto mode · auto mod',
      '   4. No',
    ]
    expect(parsePermissionOptions(garbled)).toEqual([])
  })
})

describe('joinWrapped', () => {
  it('appends soft-wrapped rows to the row they continue', () => {
    expect(
      joinWrapped([
        { text: ' ❯ 1. Yes', wrapped: false },
        { text: '   2. Yes, and don’t ask', wrapped: false },
        { text: ' again', wrapped: true },
        { text: '   3. No', wrapped: false },
      ])
    ).toEqual([' ❯ 1. Yes', '   2. Yes, and don’t ask again', '   3. No'])
  })
  it('keeps a wrapped first row', () => {
    expect(joinWrapped([{ text: 'tail', wrapped: true }])).toEqual(['tail'])
  })
})

describe('promptSteps', () => {
  const P = (s: string) => `\x1b[200~${s}\x1b[201~`
  it('without images matches promptSequences', () => {
    expect(promptSteps('hi', [])).toEqual([
      { data: `\x15${P('hi')}`, wait: ENTER_DELAY_MS },
      { data: '\r', wait: 0 },
    ])
    expect(promptSteps('  ', [])).toBeNull()
  })
  it('pastes each image path alone before the text, then Enter', () => {
    const a = 'C:\\Users\\Patrick Ackom\\AppData\\Roaming\\tw\\remote-uploads\\a.jpg'
    expect(promptSteps('what is this?\n', [a, '/mnt/c/b.png'])).toEqual([
      { data: `\x15${P(a)}`, wait: IMAGE_PASTE_GAP_MS },
      { data: P('/mnt/c/b.png'), wait: IMAGE_PASTE_GAP_MS },
      { data: P(' what is this?'), wait: ENTER_DELAY_MS },
      { data: '\r', wait: 0 },
    ])
  })
  it('sends images with no text', () => {
    expect(promptSteps(' ', ['/x.png'])).toEqual([
      { data: `\x15${P('/x.png')}`, wait: IMAGE_PASTE_GAP_MS },
      { data: '\r', wait: 0 },
    ])
  })
  it('strips ESC from paths and text', () => {
    const steps = promptSteps('a\x1b[201~b', ['/x\x1b.png'])!
    expect(steps.map((s) => s.data).join('').match(/\x1b/g)).toHaveLength(4)
  })
})

describe('image helpers', () => {
  it('fits the long side, never scaling up', () => {
    expect(fitWithin(4032, 3024, 1568)).toEqual({ w: 1568, h: 1176 })
    expect(fitWithin(3024, 4032, 1568)).toEqual({ w: 1176, h: 1568 })
    expect(fitWithin(800, 600, 1568)).toEqual({ w: 800, h: 600 })
    expect(fitWithin(10000, 1, 1568)).toEqual({ w: 1568, h: 1 })
  })
  it('detects transparency', () => {
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false)
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true)
  })
  it('drops image placeholders from user text', () => {
    expect(stripImagePlaceholders('[Image #1] [Image #2]How many?')).toBe('How many?')
    expect(stripImagePlaceholders('[Image #3]')).toBe('')
  })
})
