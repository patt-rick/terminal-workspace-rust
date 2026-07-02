// Web-client half of the remote protocol (mirrors src-tauri/src/remote/protocol.rs).
// A round-trip drift test lives on the Rust side; keep the shapes in sync.

export interface TermInfo {
  id: string
  name: string
  projectId: string
  live: boolean
}
export interface ProjectInfo {
  id: string
  name: string
  color: string
  terminals: TermInfo[]
}
export interface StateSnapshot {
  projects: ProjectInfo[]
}

export interface Handlers {
  onState?: (state: StateSnapshot, appVersion: string) => void
  onAttached?: (terminalId: string, tag: number) => void
  onSnapshot?: (terminalId: string, tag: number, bytes: Uint8Array) => void
  onOutput?: (tag: number, bytes: Uint8Array) => void
  onCreated?: (terminal: TermInfo) => void
  onClosed?: (terminalId: string) => void
  onEvicted?: () => void
  onError?: (message: string) => void
  onClose?: () => void
}

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const strToB64 = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))

/** Exchange a pairing code for a session token. */
export async function pair(code: string): Promise<string> {
  const r = await fetch('/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!r.ok) throw new Error('Invalid pairing code')
  return (await r.json()).token as string
}

export class RemoteClient {
  private ws: WebSocket | null = null

  constructor(private h: Handlers) {}

  connect(token: string): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => this.send({ type: 'hello', token })
    ws.onclose = () => this.h.onClose?.()
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        this.onBinary(new Uint8Array(ev.data as ArrayBuffer))
        return
      }
      const m = JSON.parse(ev.data)
      switch (m.type) {
        case 'hello.ok':
          this.h.onState?.(m.state, m.appVersion)
          break
        case 'hello.err':
          this.h.onError?.(m.message)
          break
        case 'term.attached':
          this.h.onAttached?.(m.terminalId, m.tag)
          break
        case 'term.snapshot':
          this.h.onSnapshot?.(m.terminalId, m.tag, b64ToBytes(m.data))
          break
        case 'term.created':
          this.h.onCreated?.(m.terminal)
          break
        case 'term.closed':
          this.h.onClosed?.(m.terminalId)
          break
        case 'session.evicted':
          this.h.onEvicted?.()
          break
        case 'error':
          this.h.onError?.(m.message)
          break
      }
    }
  }

  private onBinary(buf: Uint8Array): void {
    if (buf.length < 4) return
    const tag = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0
    this.h.onOutput?.(tag, buf.subarray(4))
  }

  private send(o: unknown): void {
    this.ws?.send(JSON.stringify(o))
  }

  attach(terminalId: string): void {
    this.send({ type: 'term.attach', terminalId })
  }
  detach(terminalId: string): void {
    this.send({ type: 'term.detach', terminalId })
  }
  input(terminalId: string, data: string): void {
    this.send({ type: 'term.input', terminalId, data: strToB64(data) })
  }
  resize(terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'term.resize', terminalId, cols, rows })
  }
  create(projectId: string, kind: 'shell' | 'claude'): void {
    this.send({ type: 'term.create', projectId, kind })
  }
  close(terminalId: string): void {
    this.send({ type: 'term.close', terminalId })
  }
  ping(): void {
    this.send({ type: 'ping' })
  }
  disconnect(): void {
    this.ws?.close()
  }
}
