import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  pair,
  RemoteClient,
  type FileDiff,
  type GitInfo,
  type ProjectInfo,
  type RepoInfo,
  type SessionSummary,
} from './protocol'
import { GitSheet } from './git-sheet'
import { SessionsSheet } from './sessions-sheet'

const TOKEN_KEY = 'tw_remote_token'
type Phase = 'pair' | 'connecting' | 'ready' | 'evicted' | 'closed'

// Token lives in localStorage (not sessionStorage) so the session survives the
// app being closed or backgrounded — reopening auto-reconnects instead of
// forcing a re-pair.
const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

// Last-viewed terminal, restored when the OS reloads the backgrounded PWA so
// reopening lands you where you left off.
const LAST_TERM_KEY = 'tw_last_term'

const b64urlToBytes = (b64url: string): Uint8Array => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/// Subscribe this browser for Web Push (closed-app notifications) and register
/// the subscription with the desktop. Reconciles a stale subscription when the
/// desktop's VAPID key changed (it regenerates per desktop-app launch).
async function ensurePushSubscription(
  vapidKey: string,
  register: (endpoint: string, p256dh: string, auth: string) => void
): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  if (Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  const appKey = b64urlToBytes(vapidKey)
  let sub = await reg.pushManager.getSubscription()
  if (sub) {
    const cur = sub.options.applicationServerKey
      ? new Uint8Array(sub.options.applicationServerKey)
      : new Uint8Array()
    const same = cur.length === appKey.length && cur.every((b, i) => b === appKey[i])
    if (!same) {
      await sub.unsubscribe().catch(() => {})
      sub = null
    }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appKey.buffer as ArrayBuffer,
    })
  }
  const json = sub.toJSON()
  if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
    register(json.endpoint, json.keys.p256dh, json.keys.auth)
  }
}

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
  const [phase, setPhase] = useState<Phase>(() => (tokenStore.get() ? 'connecting' : 'pair'))
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [attention, setAttention] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<string | null>(null)

  const [gitOpen, setGitOpen] = useState(false)
  const [gitRepos, setGitRepos] = useState<RepoInfo[]>([])
  const [gitRepoId, setGitRepoId] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitInfo | null>(null)
  const [gitDiffs, setGitDiffs] = useState<FileDiff[]>([])
  const [gitPushMsg, setGitPushMsg] = useState<string | null>(null)
  const [gitPushing, setGitPushing] = useState(false)
  const gitRepoIdRef = useRef<string | null>(null)

  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const sessionsProjectRef = useRef<string | null>(null)

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
      // Prefer the service worker's notification: it keeps showing while the app
      // is backgrounded, and is tappable to refocus the PWA.
      const opts = { body, icon: '/icon.svg', badge: '/icon.svg', tag: title }
      navigator.serviceWorker?.ready
        .then((reg) => reg.showNotification(title, opts))
        .catch(() => {
          try {
            new Notification(title, opts)
          } catch {
            setToast(`${title} — ${body}`)
          }
        })
      if (navigator.serviceWorker) return
      try {
        new Notification(title, opts)
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

  const selectGitRepo = useCallback((repoId: string) => {
    gitRepoIdRef.current = repoId
    setGitRepoId(repoId)
    setGitDiffs([])
    setGitStatus(null)
    setGitPushMsg(null)
    clientRef.current?.gitStatus(repoId)
    clientRef.current?.gitDiff(repoId)
  }, [])

  const openGit = () => {
    const projectId =
      projectsRef.current.find((p) => p.terminals.some((t) => t.id === curIdRef.current))?.id ??
      projectsRef.current[0]?.id
    if (!projectId) return
    setGitOpen(true)
    clientRef.current?.gitRepos(projectId)
  }

  const doPush = () => {
    if (!gitRepoIdRef.current) return
    setGitPushing(true)
    setGitPushMsg(null)
    clientRef.current?.gitPush(gitRepoIdRef.current)
  }

  const openSessions = (projectId: string) => {
    sessionsProjectRef.current = projectId
    setSessions([])
    setSessionsLoading(true)
    setSessionsOpen(true)
    setDrawerOpen(false)
    clientRef.current?.claudeSessions(projectId)
  }

  const doResume = (sessionId: string) => {
    const projectId = sessionsProjectRef.current
    if (!projectId) return
    // The server replies with term.created → onCreated attaches automatically.
    clientRef.current?.claudeResume(projectId, sessionId)
    setSessionsOpen(false)
  }

  const attachTo = useCallback((id: string) => {
    const client = clientRef.current
    if (!client || curIdRef.current === id) return
    if (curIdRef.current) client.detach(curIdRef.current)
    curIdRef.current = id
    curTagRef.current = null
    setCurrentId(id)
    setAttention((a) => {
      if (!(id in a)) return a
      const next = { ...a }
      delete next[id]
      return next
    })
    localStorage.setItem(LAST_TERM_KEY, id)
    termRef.current?.reset()
    client.attach(id)
    const term = termRef.current
    if (term) client.resize(id, term.cols, term.rows)
    setDrawerOpen(false)
  }, [])

  // Create the client once and connect if a token is already stored.
  useEffect(() => {
    const client = new RemoteClient({
      onState: (state, _version, vapidKey) => {
        setProjects(state.projects)
        setStatus('connected')
        setReconnecting(false)
        setPhase('ready')
        // Register for closed-app push notifications (best-effort; needs HTTPS
        // + granted notification permission).
        if (vapidKey) {
          void ensurePushSubscription(vapidKey, (endpoint, p256dh, auth) =>
            clientRef.current?.pushSubscribe(endpoint, p256dh, auth)
          ).catch(() => {})
        }
        const id = curIdRef.current
        if (id) {
          // Reconnect on a live page: the server has no memory of the previous
          // socket, so re-subscribe (replays scrollback).
          curTagRef.current = null
          termRef.current?.reset()
          clientRef.current?.attach(id)
          const term = termRef.current
          if (term) clientRef.current?.resize(id, term.cols, term.rows)
          return
        }
        // Fresh page load (OS reloaded the PWA): restore the last-viewed
        // terminal if it still exists and is live; otherwise open the drawer.
        const last = localStorage.getItem(LAST_TERM_KEY)
        const terminal = last
          ? state.projects.flatMap((p) => p.terminals).find((t) => t.id === last)
          : undefined
        if (terminal?.live) {
          attachTo(terminal.id)
        } else {
          if (last && !terminal) localStorage.removeItem(LAST_TERM_KEY)
          setDrawerOpen(true)
        }
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
        if (localStorage.getItem(LAST_TERM_KEY) === tid) localStorage.removeItem(LAST_TERM_KEY)
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
      onAttention: (tid, reason, message) => {
        setAttention((a) => ({ ...a, [tid]: reason }))
        // Notify unless you're already looking at this terminal.
        if (tid !== curIdRef.current || document.hidden) {
          const body =
            reason === 'needs-permission'
              ? message ?? 'Needs your permission'
              : reason === 'waiting-input'
                ? `Waiting for input${message ? `: ${message}` : ''}`
                : reason === 'failed'
                  ? `Command failed${message ? ` — ${message}` : ''}`
                  : reason === 'finished'
                    ? 'Finished'
                    : (message ?? reason)
          notify(termName(tid), body)
        }
      },
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
      onGitRepos: (_projectId, repos) => {
        setGitRepos(repos)
        const def = repos.find((r) => r.relativePath === '') ?? repos[0]
        if (def) selectGitRepo(def.id)
      },
      onGitStatus: (repoId, info) => {
        if (repoId === gitRepoIdRef.current) setGitStatus(info)
      },
      onGitDiff: (repoId, files) => {
        if (repoId === gitRepoIdRef.current) setGitDiffs(files)
      },
      onGitPushProgress: (_repoId, message) => setGitPushMsg(message),
      onGitPushDone: (repoId, ok, output) => {
        setGitPushing(false)
        setGitPushMsg(ok ? 'Pushed.' : output || 'Push failed')
        if (ok && repoId === gitRepoIdRef.current) {
          clientRef.current?.gitStatus(repoId)
          clientRef.current?.gitDiff(repoId)
        }
      },
      onClaudeSessions: (projectId, list) => {
        if (projectId === sessionsProjectRef.current) {
          setSessions(list)
          setSessionsLoading(false)
        }
      },
      onEvicted: () => {
        tokenStore.clear()
        setReconnecting(false)
        setPhase('evicted')
      },
      onReconnecting: () => {
        setReconnecting(true)
        setStatus('reconnecting…')
      },
      onAuthFail: (m) => {
        // Token no longer valid (e.g. desktop restarted) — must re-pair.
        tokenStore.clear()
        setReconnecting(false)
        setPairError(m || 'Session expired — pair again.')
        setPhase('pair')
      },
      onError: (m) => setStatus(m),
    })
    clientRef.current = client
    const token = tokenStore.get()
    if (token) client.connect(token)
    return () => client.disconnect()
  }, [attachTo])

  // Reconnect promptly when returning to the app or regaining connectivity —
  // this is what removes the "session ended for a bit" gap after an app switch.
  useEffect(() => {
    const kick = () => {
      if (document.visibilityState === 'visible') clientRef.current?.reconnectNow()
    }
    document.addEventListener('visibilitychange', kick)
    window.addEventListener('focus', kick)
    window.addEventListener('online', kick)
    return () => {
      document.removeEventListener('visibilitychange', kick)
      window.removeEventListener('focus', kick)
      window.removeEventListener('online', kick)
    }
  }, [])

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

    // --- Scrolling in the alternate buffer (Claude Code, vim, …) ---
    // The alt buffer has no scrollback, so xterm converts each wheel tick into
    // an ↑/↓ key — which a prompt reads as history navigation. Claude Code
    // scrolls its transcript with PgUp/PgDn ("Scroll wheel is sending arrow
    // keys · use PgUp/PgDn to scroll"), so we translate scroll gestures into
    // page keys there instead. xterm 6 has no touch handling at all
    // (xtermjs/xterm.js#5377), so touch pan is handled here for both buffers.
    const sendSeq = (seq: string) => {
      const id = curIdRef.current
      if (id) clientRef.current?.input(id, seq)
    }
    const PAGE_UP = '\x1b[5~'
    const PAGE_DOWN = '\x1b[6~'
    const inAltBuffer = () => term.buffer.active.type === 'alternate'
    const cellHeight = () => Math.max(1, node.clientHeight / term.rows)
    // Drag distance that flips one page. Kept well under a typical flick
    // (~200px) so casual swipes always move.
    const pageThreshold = () => Math.max(48, Math.min(node.clientHeight / 3, 200))

    let touchY: number | null = null
    let touchAcc = 0
    let gestureDy = 0
    let gestureStart = 0
    let gesturePages = 0
    node.addEventListener(
      'touchstart',
      (e) => {
        touchY = e.touches.length === 1 ? e.touches[0].clientY : null
        touchAcc = 0
        gestureDy = 0
        gesturePages = 0
        gestureStart = performance.now()
      },
      { passive: true }
    )
    node.addEventListener(
      'touchmove',
      (e) => {
        if (touchY === null || e.touches.length !== 1) return
        const dy = e.touches[0].clientY - touchY
        touchY = e.touches[0].clientY
        gestureDy += dy
        if (touchAcc !== 0 && Math.sign(dy) !== Math.sign(touchAcc)) touchAcc = 0
        touchAcc += dy
        if (inAltBuffer()) {
          // Dragging down reveals older content → page up.
          const page = pageThreshold()
          while (touchAcc >= page) {
            sendSeq(PAGE_UP)
            touchAcc -= page
            gesturePages++
          }
          while (touchAcc <= -page) {
            sendSeq(PAGE_DOWN)
            touchAcc += page
            gesturePages++
          }
        } else {
          const cell = cellHeight()
          const lines = Math.trunc(touchAcc / cell)
          if (lines !== 0) {
            term.scrollLines(-lines)
            touchAcc -= lines * cell
          }
        }
        // Stop the browser from also panning / synthesizing wheel events.
        e.preventDefault()
      },
      { passive: false }
    )
    node.addEventListener(
      'touchend',
      () => {
        // A quick flick that didn't reach the page threshold still turns one
        // page — otherwise short swipes feel dead in the alt buffer.
        if (
          touchY !== null &&
          inAltBuffer() &&
          gesturePages === 0 &&
          Math.abs(gestureDy) >= 30 &&
          performance.now() - gestureStart < 300
        ) {
          sendSeq(gestureDy > 0 ? PAGE_UP : PAGE_DOWN)
        }
        touchY = null
      },
      { passive: true }
    )

    let wheelAcc = 0
    term.attachCustomWheelEventHandler((ev) => {
      if (!inAltBuffer()) return true // normal buffer: xterm scrolls its scrollback
      const px =
        ev.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? ev.deltaY * cellHeight()
          : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? ev.deltaY * node.clientHeight
            : ev.deltaY
      if (wheelAcc !== 0 && Math.sign(px) !== Math.sign(wheelAcc)) wheelAcc = 0
      wheelAcc += px
      const page = pageThreshold()
      while (wheelAcc >= page) {
        sendSeq(PAGE_DOWN)
        wheelAcc -= page
      }
      while (wheelAcc <= -page) {
        sendSeq(PAGE_UP)
        wheelAcc += page
      }
      return false // handled — suppress xterm's wheel→arrow fallback
    })

    term.onData((data) => {
      const id = curIdRef.current
      if (id) clientRef.current?.input(id, data)
    })
    term.onResize(({ cols, rows }) => {
      const id = curIdRef.current
      if (id) clientRef.current?.resize(id, cols, rows)
    })
    // OSC 52: a program in the remote terminal copied to the clipboard — route it
    // to THIS device's clipboard (R3.16). Payload is "<selection>;<base64>".
    term.parser.registerOscHandler(52, (payload) => {
      const semi = payload.indexOf(';')
      const b64 = semi >= 0 ? payload.slice(semi + 1) : ''
      if (!b64 || b64 === '?') return true // clipboard query/clear — ignore
      let text: string
      try {
        text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
      } catch {
        return true
      }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .catch(() => notify('Copy', text.length > 48 ? `${text.slice(0, 48)}…` : text))
      } else {
        // No async Clipboard API (e.g. non-secure http on Tailscale) — surface it.
        notify('Copied to terminal', text.length > 48 ? `${text.slice(0, 48)}…` : text)
      }
      return true
    })
    termRef.current = term
    fitRef.current = fit
  }, [notify])

  const doPair = async (code: string) => {
    setPairError(null)
    // Ask for notification permission once, from within this user gesture.
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    try {
      const token = await pair(code)
      tokenStore.set(token)
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
        <span className="status">{reconnecting ? '⟳ reconnecting…' : status}</span>
        <button className="iconbtn" onClick={openGit} aria-label="Git">
          ⎇
        </button>
      </div>
      {reconnecting && <div className="reconnbar">Connection lost — reconnecting…</div>}

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
        <button className="key" onClick={() => sendKey('\x1b[5~')}>
          PgUp
        </button>
        <button className="key" onClick={() => sendKey('\x1b[6~')}>
          PgDn
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
                    {attention[t.id] && (
                      <span
                        className={`att-dot ${
                          attention[t.id] === 'needs-permission' || attention[t.id] === 'failed'
                            ? 'att-red'
                            : attention[t.id] === 'finished'
                              ? 'att-green'
                              : 'att-amber'
                        }`}
                        title={attention[t.id]}
                      />
                    )}
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
                  <button onClick={() => openSessions(p.id)}>⟳ Sessions</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {gitOpen && (
        <GitSheet
          repos={gitRepos}
          repoId={gitRepoId}
          status={gitStatus}
          diffs={gitDiffs}
          pushMsg={gitPushMsg}
          pushing={gitPushing}
          onSelectRepo={selectGitRepo}
          onPush={doPush}
          onClose={() => setGitOpen(false)}
        />
      )}

      {sessionsOpen && (
        <SessionsSheet
          sessions={sessions}
          loading={sessionsLoading}
          onResume={doResume}
          onClose={() => setSessionsOpen(false)}
        />
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
