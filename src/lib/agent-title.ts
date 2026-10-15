// Agent TUIs (Claude Code) report turn activity through the window title. Older
// versions animate braille frames (U+2800–U+28FF) mixed with "✳ <task>" frames
// and reset to a bare "✳ Claude Code" when idle. Claude Code 2.1.300+ spins
// ◐◑◒◓ and idles on "✳ <topic>". So a "✳ <task>" title is read by the spinner
// family seen last, and before any spinner it says nothing.

type Spinner = 'braille' | 'circle'

const isBraille = (code: number): boolean => code >= 0x2800 && code <= 0x28ff
const isCircle = (code: number): boolean => code >= 0x25d0 && code <= 0x25d3

export type TitleWorkTracker = (title: string) => boolean | null

/** Returns a per-terminal reader: true/false for working/idle, null when the
 *  title alone can't tell. */
export const createTitleWorkTracker = (): TitleWorkTracker => {
  let last: Spinner | null = null
  return (title) => {
    const t = title.trimStart()
    const code = t.codePointAt(0)
    if (code === undefined) {
      last = null
      return false
    }
    if (isBraille(code)) {
      last = 'braille'
      return true
    }
    if (isCircle(code)) {
      last = 'circle'
      return true
    }
    if (t[0] !== '✳') {
      last = null
      return false
    }
    const task = t.replace(/^[✳⠀-⣿\s]+/, '').trim()
    if (task.length === 0 || /^claude code\b/i.test(task)) return false
    if (last === 'braille') return true
    if (last === 'circle') return false
    return null
  }
}
