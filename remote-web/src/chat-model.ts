// Pure helpers for the phone chat view (unit-tested; no DOM or socket).
import type { ChatMessage } from './protocol'

/** Merge server messages into the list: same id replaces, new ids append. */
export function upsertMessages(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = list.slice()
  const at = new Map(out.map((m, i) => [m.id, i]))
  for (const m of incoming) {
    const i = at.get(m.id)
    if (i === undefined) {
      at.set(m.id, out.length)
      out.push(m)
    } else {
      out[i] = m
    }
  }
  return out
}

/** What to write to the PTY to submit `text` as one prompt: Ctrl+U first (an
 *  Esc before Claude's first token puts the last prompt back in its input box),
 *  then a bracketed paste (ESC stripped so the text can't end it early), then
 *  Enter sent separately — Claude Code can swallow an Enter that arrives in the
 *  same chunk. */
export function promptSequences(
  text: string
): { clear: string; paste: string; enter: string } | null {
  const clean = text.replace(/\x1b/g, '').replace(/\s+$/, '')
  if (!clean.trim()) return null
  return { clear: '\x15', paste: `\x1b[200~${clean}\x1b[201~`, enter: '\r' }
}

/** Delay between the paste and its Enter (Phase 0 result). */
export const ENTER_DELAY_MS = 100

/** Pause after each image-path paste. Claude Code 2.1.300 turns a paste that is
 *  exactly an image path into `[Image #N]`, but reads the file afterwards: an
 *  Enter 20 ms later sent the prompt without the images, 150 ms was enough. */
export const IMAGE_PASTE_GAP_MS = 300

export interface PtyStep {
  data: string
  /** Wait this long before the next step. */
  wait: number
}

const paste = (s: string) => `\x1b[200~${s.replace(/\x1b/g, '')}\x1b[201~`

/** The writes that submit a prompt with images attached: Ctrl+U, each image
 *  path as its own bracketed paste, then the text, then Enter. */
export function promptSteps(text: string, imagePaths: string[]): PtyStep[] | null {
  const clean = text.replace(/\x1b/g, '').replace(/\s+$/, '')
  if (!imagePaths.length) {
    const seq = promptSequences(text)
    if (!seq) return null
    return [
      { data: seq.clear + seq.paste, wait: ENTER_DELAY_MS },
      { data: seq.enter, wait: 0 },
    ]
  }
  const steps: PtyStep[] = imagePaths.map((p, i) => ({
    data: (i === 0 ? '\x15' : '') + paste(p),
    wait: IMAGE_PASTE_GAP_MS,
  }))
  // A leading space keeps the text off the last `[Image #N]` placeholder.
  if (clean.trim()) steps.push({ data: paste(` ${clean.replace(/^\s+/, '')}`), wait: ENTER_DELAY_MS })
  steps.push({ data: '\r', wait: 0 })
  return steps
}

export const MAX_IMAGES = 5
/** The server's per-image cap (decoded bytes). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Longest side an image is scaled down to before upload. */
export const IMAGE_MAX_SIDE = 1568

/** `w`×`h` scaled to fit within `max` on the long side (never scaled up). */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h, 1))
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/** Whether any pixel of RGBA data is not fully opaque. */
export function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true
  return false
}

/** The user's text without Claude's `[Image #N]` placeholders (the images show as chips). */
export function stripImagePlaceholders(text: string): string {
  return text.replace(/\[Image #\d+\]\s*/g, '').trim()
}

// Only ❯ marks the menu's cursor: `>` is how the transcript echoes your own prompts.
const OPTION = /^(\s*)(❯\s*)?(\d)\.\s+(.+?)\s*$/
/** Footer lines Claude Code draws under a menu ("Esc to cancel · Tab to amend"). */
const HINT = /\b(esc|tab|enter|cancel)\b/i
const BORDER_START = /^\s*[\u2500-\u257f]+/
const BORDER_END = /[\u2500-\u257f]+\s*$/

/** Terminal rows with soft-wrapped continuations appended to the row they continue. */
export function joinWrapped(rows: { text: string; wrapped: boolean }[]): string[] {
  const out: string[] = []
  for (const r of rows) {
    if (r.wrapped && out.length) out[out.length - 1] += r.text
    else out.push(r.text)
  }
  return out
}

/** Labels of the selection menu drawn lowest on screen (Claude Code's permission
 *  prompt): a run of options numbered 1..N, one carrying the ❯ cursor. An option
 *  label may continue on lines indented to its text. Empty when there is none. */
export function parsePermissionOptions(lines: string[]): string[] {
  let best: string[] = []
  let run: string[] = []
  let cursor = false
  let labelCol = -1
  const close = () => {
    if (run.length >= 2 && cursor) best = run
    run = []
    cursor = false
    labelCol = -1
  }
  for (const raw of lines) {
    const line = raw.replace(BORDER_START, '').replace(BORDER_END, '').trimEnd()
    const m = OPTION.exec(line)
    if (m) {
      const n = Number(m[3])
      if (n !== run.length + 1) {
        close()
        if (n !== 1) continue
      }
      run.push(m[4])
      if (m[2]) cursor = true
      labelCol = line.length - m[4].length
      continue
    }
    const indent = line.length - line.trimStart().length
    if (run.length && line.trim() && indent >= labelCol) {
      run[run.length - 1] += ` ${line.trim()}`
      continue
    }
    close()
    // The open menu is the last thing on screen: anything but its footer below a
    // run means that run is history (an old menu, or an echoed list).
    if (line.trim() && !HINT.test(line)) best = []
  }
  close()
  return best
}

/** Ids of tool calls still waiting for a result. */
function pendingTools(msgs: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of msgs) for (const b of m.blocks) if (b.kind === 'toolUse' && b.result === null) ids.add(b.id)
  return ids
}

export function hasPendingTool(msgs: ChatMessage[]): boolean {
  return pendingTools(msgs).size > 0
}

const MODE_KEY = 'tw_chat_mode'
export type ViewMode = 'chat' | 'terminal'

/** Per-terminal view choice; Claude terminals default to chat. */
export const modeStore = {
  get(id: string): ViewMode {
    try {
      const all = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}') as Record<string, ViewMode>
      return all[id] ?? 'chat'
    } catch {
      return 'chat'
    }
  },
  set(id: string, mode: ViewMode): void {
    try {
      const all = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}') as Record<string, ViewMode>
      all[id] = mode
      localStorage.setItem(MODE_KEY, JSON.stringify(all))
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  },
}
