import type { Terminal } from '@xterm/xterm'

// Speculative local echo (mosh-style, simplified) to hide round-trip latency on
// high-latency links (e.g. Cloudflare tunnel). The terminal has no server-side
// echo suppression, so we render each keystroke locally the instant it's typed
// and then *cancel* the server's matching echo when it arrives — no duplication.
// A misprediction is rolled back the moment the server disagrees; the server
// stream is always authoritative.
//
// Deliberately conservative: only the normal buffer, only single printable
// characters and backspace, never near a line wrap, and never on a line that
// looks like a password prompt (where the server echoes nothing).

type Pending = { byte: number; at: number }

const isPrintable = (code: number) => code >= 0x20 && code <= 0x7e
const isBackspace = (code: number) => code === 0x08 || code === 0x7f
const SECRET_RE = /pass(word|phrase)|secret|otp|token|pin\b/i

// Unconfirmed guesses older than this are assumed wrong (echo suppressed, e.g. a
// password field, or output lost) and rolled back.
const CONFIRM_TIMEOUT_MS = 800

export class PredictiveEcho {
  private pending: Pending[] = []
  private enabled: boolean
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private term: Terminal,
    enabled: boolean,
    private now: () => number = () => performance.now()
  ) {
    this.enabled = enabled
    if (enabled) this.startTimer()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.startTimer()
    } else {
      this.rollbackAll()
      this.stopTimer()
    }
  }

  /// Called from term.onData. Renders a speculative echo when it's safe to guess.
  /// Never changes what gets sent — the caller still transmits `data` verbatim.
  predict(data: string): void {
    if (!this.enabled) return
    if (this.term.buffer.active.type !== 'normal') return
    if (data.length !== 1) return // paste / IME / escape sequences: don't guess
    const code = data.charCodeAt(0)
    if (isPrintable(code)) {
      // Guessing at the wrap column would push to the next row, which '\b \b'
      // rollback can't cleanly undo.
      if (this.term.buffer.active.cursorX >= this.term.cols - 1) return
      // Only gate the *first* guess on the prompt text; mid-word the cursor has
      // already moved past it.
      if (this.pending.length === 0 && this.looksLikeSecret()) return
      this.term.write(data)
      this.pending.push({ byte: code, at: this.now() })
    } else if (isBackspace(code)) {
      // Walk back only our OWN speculative characters — never server content.
      const last = this.pending[this.pending.length - 1]
      if (last && isPrintable(last.byte)) {
        this.term.write('\b \b')
        this.pending.pop()
      }
    }
    // Anything else (Enter, arrows, Ctrl-*): don't guess, but keep `pending` so
    // its in-flight echoes are still cancelled as they arrive.
  }

  /// Called in place of term.write() for live server output. Cancels confirmed
  /// echoes, rolls back mispredictions, and writes whatever remains.
  writeServer(bytes: Uint8Array): void {
    if (!this.enabled || this.pending.length === 0) {
      this.term.write(bytes)
      return
    }
    let i = 0
    // Confirmed echoes: bytes that match our guesses in order are already on
    // screen — consume them from both sides without re-writing.
    while (i < bytes.length && this.pending.length > 0 && bytes[i] === this.pending[0].byte) {
      i++
      this.pending.shift()
    }
    // Divergence: the server produced something other than our next guess. The
    // still-unconfirmed guesses are wrong — erase them (they sit at the cursor
    // tail) and let the authoritative server bytes render.
    if (i < bytes.length && this.pending.length > 0) {
      this.rollbackAll()
    }
    if (i < bytes.length) this.term.write(bytes.subarray(i))
  }

  /// Drop predictions without touching the screen — for attach/reset/reconnect,
  /// where the terminal is cleared and repainted from a fresh snapshot anyway.
  reset(): void {
    this.pending = []
  }

  dispose(): void {
    this.stopTimer()
    this.pending = []
  }

  private rollbackAll(): void {
    const n = this.pending.length
    if (n > 0) this.term.write('\b \b'.repeat(n))
    this.pending = []
  }

  private looksLikeSecret(): boolean {
    const buf = this.term.buffer.active
    const line = buf.getLine(buf.baseY + buf.cursorY)
    return line ? SECRET_RE.test(line.translateToString(true)) : false
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.pending.length > 0 && this.now() - this.pending[0].at > CONFIRM_TIMEOUT_MS) {
        this.rollbackAll()
      }
    }, 250)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
