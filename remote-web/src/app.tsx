import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { pair, RemoteClient, type ProjectInfo } from './protocol'

const TOKEN_KEY = 'tw_remote_token'
type Phase = 'pair' | 'connecting' | 'ready' | 'evicted' | 'closed'

// Dark theme matching the desktop default. Following the desktop's *active*
// theme (sent in hello.ok) is a later refinement.
const XTERM_THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
}

export function App() {
  const [phase, setPhase] = useState<Phase>(() =>
    sessionStorage.getItem(TOKEN_KEY) ? 'connecting' : 'pair'
  )
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [pairError, setPairError] = useState<string | null>(null)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)

  const projectsRef = useRef<ProjectInfo[]>([])
  projectsRef.current = projects
  const workingRef = useRef<Set<string>>(working)
  workingRef.current = working

  const clientRef = useRef<RemoteClient | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const curIdRef = useRef<string | null>(null)
  const curTagRef = useRef<number | null>(null)
  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase

  const termName = (id: string): string =>
    projectsRef.current.flatMap((p) => p.terminals).find((t) => t.id === id)?.name ?? 'Terminal'

  const notify = useCallback((title: string, body: string) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body })
        return
      } catch {
        // fall through to toast
      }
    }
    setToast(`${title} — ${body}`)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const attachTo = useCallback((id: string) => {
    const client = clientRef.current
    if (!client || curIdRef.current === id) return
    if (curIdRef.current) client.detach(curIdRef.current)
    curIdRef.current = id
    curTagRef.current = null
    setCurrentId(id)
    termRef.current?.reset()
    client.attach(id)
    const term = termRef.current
    if (term) client.resize(id, term.cols, term.rows)
    setDrawerOpen(false)
  }, [])

  // Create the client once and connect if a token is already stored.
  useEffect(() => {
    const client = new RemoteClient({
      onState: (state) => {
        setProjects(state.projects)
        setStatus('connected')
        setPhase('ready')
      },
      onAttached: (tid, tag) => {
        if (tid === curIdRef.current) {
          curTagRef.current = tag
          termRef.current?.reset()
        }
      },
      onSnapshot: (tid, _tag, bytes) => {
        if (tid === curIdRef.current) termRef.current?.write(bytes)
      },
      onOutput: (tag, bytes) => {
        if (tag === curTagRef.current) termRef.current?.write(bytes)
      },
      onCreated: (t) => {
        setProjects((ps) =>
          ps.map((p) => (p.id === t.projectId ? { ...p, terminals: [...p.terminals, t] } : p))
        )
        attachTo(t.id)
      },
      onClosed: (tid) => {
        setProjects((ps) =>
          ps.map((p) => ({ ...p, terminals: p.terminals.filter((t) => t.id !== tid) }))
        )
        if (curIdRef.current === tid) {
          curIdRef.current = null
          curTagRef.current = null
          setCurrentId(null)
          termRef.current?.reset()
        }
      },
      onWorking: (tid, isWorking) => {
        const wasWorking = workingRef.current.has(tid)
        setWorking((s) => {
          const n = new Set(s)
          if (isWorking) n.add(tid)
          else n.delete(tid)
          return n
        })
        // Notify when a background terminal finishes a task.
        if (wasWorking && !isWorking && tid !== curIdRef.current) {
          notify(termName(tid), 'Finished')
        }
      },
      onBell: (tid) => notify(termName(tid), 'Bell'),
      onExit: (tid) => {
        setWorking((s) => {
          const n = new Set(s)
          n.delete(tid)
          return n
        })
        setProjects((ps) =>
          ps.map((p) => ({
            ...p,
            terminals: p.terminals.map((t) => (t.id === tid ? { ...t, live: false } : t)),
          }))
        )
      },
      onEvicted: () => {
        sessionStorage.removeItem(TOKEN_KEY)
        setPhase('evicted')
      },
      onError: (m) => {
        if (phaseRef.current === 'connecting') {
          sessionStorage.removeItem(TOKEN_KEY)
          setPairError(m)
          setPhase('pair')
        } else {
          setStatus(m)
        }
      },
      onClose: () => {
        if (phaseRef.current === 'ready' || phaseRef.current === 'connecting') setPhase('closed')
      },
    })
    clientRef.current = client
    const token = sessionStorage.getItem(TOKEN_KEY)
    if (token) client.connect(token)
    return () => client.disconnect()
  }, [attachTo])

  // Re-fit on viewport changes (orientation, mobile keyboard show/hide).
  useEffect(() => {
    const onResize = () => fitRef.current?.fit()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const mountTerminal = useCallback((node: HTMLDivElement | null) => {
    if (!node || termRef.current) return
    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(node)
    fit.fit()
    term.onData((data) => {
      const id = curIdRef.current
      if (id) clientRef.current?.input(id, data)
    })
    term.onResize(({ cols, rows }) => {
      const id = curIdRef.current
      if (id) clientRef.current?.resize(id, cols, rows)
    })
    termRef.current = term
    fitRef.current = fit
  }, [])

  const doPair = async (code: string) => {
    setPairError(null)
    // Ask for notification permission once, from within this user gesture.
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    try {
      const token = await pair(code)
      sessionStorage.setItem(TOKEN_KEY, token)
      setPhase('connecting')
      clientRef.current?.connect(token)
    } catch (e) {
      setPairError(e instanceof Error ? e.message : String(e))
    }
  }

  const sendKey = (seq: string) => {
    const id = curIdRef.current
    if (id) clientRef.current?.input(id, seq)
    termRef.current?.focus()
  }

  if (phase === 'pair') return <PairScreen onSubmit={doPair} error={pairError} />
  if (phase === 'connecting') return <CenterCard title="Connecting…" />
  if (phase === 'evicted')
    return (
      <CenterCard
        title="Disconnected"
        body="Another device paired with this session."
        action="Reconnect"
        onAction={() => location.reload()}
      />
    )
  if (phase === 'closed')
    return (
      <CenterCard
        title="Connection closed"
        body="The remote session ended."
        action="Reconnect"
        onAction={() => location.reload()}
      />
    )

  const current = projects.flatMap((p) => p.terminals).find((t) => t.id === currentId)

  return (
    <div className="app">
      <div className="topbar">
        <button className="iconbtn" onClick={() => setDrawerOpen(true)} aria-label="Menu">
          ☰
        </button>
        <span className="title">
          {current && working.has(current.id) && <span className="spin">◐</span>}
          {current ? current.name : 'No terminal'}
        </span>
        <span className="status">{status}</span>
      </div>

      <div className="termwrap">
        {current ? (
          <div className="term" ref={mountTerminal} onClick={() => termRef.current?.focus()} />
        ) : (
          <div className="emptyterm">Open the menu (☰) to pick or create a terminal.</div>
        )}
      </div>

      <div className="keys">
        <button className="key" onClick={() => sendKey('\x1b')}>
          Esc
        </button>
        <button className="key" onClick={() => sendKey('\t')}>
          Tab
        </button>
        <button className="key" onClick={() => sendKey('\x03')}>
          ^C
        </button>
        <button className="key" onClick={() => sendKey('\x1b[D')}>
          ←
        </button>
        <button className="key" onClick={() => sendKey('\x1b[A')}>
          ↑
        </button>
        <button className="key" onClick={() => sendKey('\x1b[B')}>
          ↓
        </button>
        <button className="key" onClick={() => sendKey('\x1b[C')}>
          →
        </button>
      </div>

      {drawerOpen && (
        <>
          <div className="scrim" onClick={() => setDrawerOpen(false)} />
          <div className="drawer">
            <h2>Projects</h2>
            {projects.map((p) => (
              <div className="proj" key={p.id}>
                <div className="proj-name">
                  <span className="dot" style={{ background: p.color }} />
                  {p.name}
                </div>
                {p.terminals.map((t) => (
                  <div
                    key={t.id}
                    className={`term-row ${t.id === currentId ? 'active' : ''}`}
                    onClick={() => attachTo(t.id)}
                  >
                    {working.has(t.id) && <span className="spin">◐</span>}
                    <span className={`name ${t.live ? '' : 'dead'}`}>{t.name}</span>
                    <button
                      className="x"
                      onClick={(e) => {
                        e.stopPropagation()
                        clientRef.current?.close(t.id)
                      }}
                      aria-label="Close terminal"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="mk">
                  <button onClick={() => clientRef.current?.create(p.id, 'shell')}>+ Shell</button>
                  <button onClick={() => clientRef.current?.create(p.id, 'claude')}>+ Claude</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function PairScreen({
  onSubmit,
  error,
}: {
  onSubmit: (code: string) => void
  error: string | null
}) {
  const [code, setCode] = useState('')
  return (
    <div className="app">
      <div className="center">
        <div className="card">
          <h1>Terminal Workspace</h1>
          <p>Enter the pairing code shown on your computer.</p>
          <input
            className="code-input"
            inputMode="numeric"
            autoFocus
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && code && onSubmit(code)}
          />
          <button className="primary" disabled={code.length < 6} onClick={() => onSubmit(code)}>
            Connect
          </button>
          {error && <div className="err">{error}</div>}
        </div>
      </div>
    </div>
  )
}

function CenterCard({
  title,
  body,
  action,
  onAction,
}: {
  title: string
  body?: string
  action?: string
  onAction?: () => void
}) {
  return (
    <div className="app">
      <div className="center">
        <div className="card">
          <h1>{title}</h1>
          {body && <p>{body}</p>}
          {action && onAction && (
            <button className="primary" onClick={onAction}>
              {action}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
