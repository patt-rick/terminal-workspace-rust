// Web-client half of the remote protocol — a hand-maintained mirror of
// src-tauri/src/remote/protocol.rs. The Rust side pins every wire `type` tag in
// contract tests (`server_msg_wire_tags_are_stable` /
// `client_msg_wire_tags_all_deserialize` in protocol.rs); when those tags or
// fields change, update this mirror to match.

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

export interface RepoInfo {
  id: string
  path: string
  relativePath: string
  name: string
  isSubmodule: boolean
  parentRepoId: string | null
}
export interface GitInfo {
  isRepo: boolean
  branch: string | null
  githubRepo: { owner: string; repo: string } | null
  hasUpstream: boolean
  ahead: number
  behind: number
  dirty: boolean
  defaultBranch: string | null
}
export interface DiffLine {
  origin: string
  content: string
  oldLineno: number | null
  newLineno: number | null
}
export interface DiffHunk {
  header: string
  lines: DiffLine[]
}
export interface FileDiff {
  path: string
  oldPath: string | null
  status: string
  binary: boolean
  hunks: DiffHunk[]
}

export interface SessionSummary {
  sessionId: string
  title: string
  messageCount: number
  lastActive: number
  gitBranch: string | null
}

export interface Handlers {
  onState?: (state: StateSnapshot, appVersion: string) => void
  onAttached?: (terminalId: string, tag: number) => void
  onSnapshot?: (terminalId: string, tag: number, bytes: Uint8Array) => void
  onOutput?: (tag: number, bytes: Uint8Array) => void
  onCreated?: (terminal: TermInfo) => void
  onClosed?: (terminalId: string) => void
  onWorking?: (terminalId: string, working: boolean) => void
  onBell?: (terminalId: string) => void
  onExit?: (terminalId: string) => void
  onGitRepos?: (projectId: string, repos: RepoInfo[]) => void
  onGitStatus?: (repoId: string, info: GitInfo) => void
  onGitDiff?: (repoId: string, files: FileDiff[]) => void
  onGitPushProgress?: (repoId: string, message: string) => void
  onGitPushDone?: (repoId: string, ok: boolean, output: string) => void
  onClaudeSessions?: (projectId: string, sessions: SessionSummary[]) => void
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
        case 'state.working':
          this.h.onWorking?.(m.terminalId, m.working)
          break
        case 'state.bell':
          this.h.onBell?.(m.terminalId)
          break
        case 'state.exit':
          this.h.onExit?.(m.terminalId)
          break
        case 'git.repos':
          this.h.onGitRepos?.(m.projectId, m.repos)
          break
        case 'git.status':
          this.h.onGitStatus?.(m.repoId, m.info)
          break
        case 'git.diff':
          this.h.onGitDiff?.(m.repoId, m.files)
          break
        case 'git.push.progress':
          this.h.onGitPushProgress?.(m.repoId, m.message)
          break
        case 'git.push.done':
          this.h.onGitPushDone?.(m.repoId, m.ok, m.output)
          break
        case 'claude.sessions':
          this.h.onClaudeSessions?.(m.projectId, m.sessions)
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
  gitRepos(projectId: string): void {
    this.send({ type: 'git.repos', projectId })
  }
  gitStatus(repoId: string): void {
    this.send({ type: 'git.status', repoId })
  }
  gitDiff(repoId: string): void {
    this.send({ type: 'git.diff', repoId })
  }
  gitPush(repoId: string): void {
    this.send({ type: 'git.push', repoId })
  }
  claudeSessions(projectId: string): void {
    this.send({ type: 'claude.sessions', projectId })
  }
  claudeResume(projectId: string, sessionId: string): void {
    this.send({ type: 'claude.resume', projectId, sessionId })
  }
  ping(): void {
    this.send({ type: 'ping' })
  }
  disconnect(): void {
    this.ws?.close()
  }
}
