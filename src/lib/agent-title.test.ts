import { describe, expect, it } from 'vitest'
import { createTitleWorkTracker } from './agent-title'

const read = (titles: string[]): (boolean | null)[] => {
  const track = createTitleWorkTracker()
  return titles.map(track)
}

describe('createTitleWorkTracker', () => {
  it('reads older braille-spinner titles', () => {
    expect(read(['⠋ Compiling…', '✳ Compiling…', '✳ Claude Code'])).toEqual([true, true, false])
  })

  it('reads Claude Code 2.1.300 circle-spinner titles', () => {
    expect(
      read(['claude', '✳ Claude Code', '◐ Claude Code', '◑ Topic', '✳ Topic', '◓ Topic', '✳ Topic', '']),
    ).toEqual([false, false, true, true, false, true, false, false])
  })

  it('cannot tell from a ✳ task title before any spinner', () => {
    expect(read(['✳ Topic', '◐ Topic', '✳ Topic'])).toEqual([null, true, false])
  })

  it('forgets the spinner family when the title leaves Claude', () => {
    expect(read(['◐ Topic', '✳ Topic', 'pwsh', '✳ Task', '⠋ Task', '✳ Task'])).toEqual([
      true,
      false,
      false,
      null,
      true,
      true,
    ])
  })
})
