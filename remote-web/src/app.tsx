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
  type TermInfo,
} from './protocol'
import type { ChatMessage } from './protocol'
import { ChatView, type PermissionPrompt } from './chat-view'
import {
  ENTER_DELAY_MS,
  hasPendingTool,
  modeStore,
  promptSequences,
  upsertMessages,
  type ViewMode,
} from './chat-model'
import { GitSheet } from './git-sheet'
import { SessionsSheet } from './sessions-sheet'
import { applyTheme, xtermTheme, type RemoteTheme } from './theme'
import {
  BranchIcon,
  ChatIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  HistoryIcon,
  MenuIcon,
  SparklesIcon,
  TerminalIcon,
} from './icons'

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

export function App() {
  const [phase, setPhase] = useState<Phase>(() => (tokenStore.get() ? 'connecting' : 'pair'))
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [attention, setAttention] = useState<Record<string, { reason: string; message: string | null }>>({})
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

  const [mode, setMode] = useState<ViewMode>('chat')
  const modeRef = useRef<ViewMode>('chat')
  modeRef.current = mode
  const [chat, setChat] = useState<{ id: string | null; messages: ChatMessage[]; truncated: boolean; loaded: boolean }>({
    id: null,
    messages: [],
    truncated: false,
    loaded: false,
  })
  const [alive, setAlive] = useState<Record<string, boolean>>({})
  const [permission, setPermission] = useState<Record<string, PermissionPrompt>>({})
  const [hooksMissing, setHooksMissing] = useState(false)
  const [unavailable, setUnavailable] = useState<Record<string, true>>({})
  const unavailableRef = useRef(unavailable)
  unavailableRef.current = unavailable
  const chatRef = useRef(chat)
  chatRef.current = chat

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

  const setTheme = useCallback((theme: RemoteTheme | null) => {
    if (!theme) return
    applyTheme(theme)
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme)
  }, [])

  const termName = (id: string): string =>
    projectsRef.current.flatMap((p) => p.terminals).find((t) => t.id === id)?.name ?? 'Terminal'

  /** Whether `id` should show chat right now (a Claude terminal, chat mode, chat not refused). */
  const chatFor = (id: string | null, info?: TermInfo): boolean => {
    if (!id) return false
    const t = info ?? projectsRef.current.flatMap((p) => p.terminals).find((x) => x.id === id)
    return !!t?.claude && modeStore.get(id) === 'chat' && !unavailableRef.current[id]
  }

  const dropPermission = (tid: string) =>
    setPermission((p) => {
      if (!(tid in p)) return p
      const next = { ...p }
      delete next[tid]
      return next
    })

  // The ref is updated before the render so back-to-back chat messages see the latest list.
  const putChat = (next: typeof chat) => {
    chatRef.current = next
    setChat(next)
  }

  /** Forget a chat refusal for `id` so chat is tried again. */
  const clearUnavailable = (id: string) => {
    if (!unavailableRef.current[id]) return
    const next = { ...unavailableRef.current }
    delete next[id]
    unavailableRef.current = next
    setUnavailable(next)
  }

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

  const attachTo = useCallback((id: string, info?: TermInfo) => {
    const client = clientRef.current
    if (!client || curIdRef.current === id) return
    if (curIdRef.current) client.detach(curIdRef.current)
    if (curIdRef.current) client.chatClose(curIdRef.current)
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
    clearUnavailable(id)
    const wantChat = chatFor(id, info)
    modeRef.current = wantChat ? 'chat' : 'terminal'
    setMode(modeRef.current)
    putChat({ id, messages: [], truncated: false, loaded: false })
    if (wantChat) {
      termRef.current?.blur() // keystrokes must not reach the hidden terminal
      client.releaseSize(id)
      client.chatOpen(id)
    } else {
      // The key row may have just reappeared: refit before sending the size.
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        const term = termRef.current
        if (term && curIdRef.current === id) client.resize(id, term.cols, term.rows)
      })
    }
    setDrawerOpen(false)
  }, [])

  // Create the client once and connect if a token is already stored.
  useEffect(() => {
    const client = new RemoteClient({
      onState: (state, _version, vapidKey, theme, claudeHooks) => {
        setTheme(theme)
        setProjects(state.projects)
        setHooksMissing(!claudeHooks)
        // A refusal may have been transient (a read error): try chat again.
        unavailableRef.current = {}
        setUnavailable({})
        setWorking(new Set(state.projects.flatMap((p) => p.terminals).filter((t) => t.working).map((t) => t.id)))
        setAlive(Object.fromEntries(state.projects.flatMap((p) => p.terminals).map((t) => [t.id, t.claudeAlive])))
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
          if (modeRef.current === 'chat' && chatFor(id)) {
            clientRef.current?.chatOpen(id)
          } else {
            const term = termRef.current
            if (term) clientRef.current?.resize(id, term.cols, term.rows)
          }
          return
        }
        // Fresh page load (OS reloaded the PWA): restore the last-viewed
        // terminal if it still exists and is live; otherwise open the drawer.
        const last = localStorage.getItem(LAST_TERM_KEY)
        const terminal = last
          ? state.projects.flatMap((p) => p.terminals).find((t) => t.id === last)
          : undefined
        if (terminal?.live) {
          attachTo(terminal.id, terminal)
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
        if (tid === curIdRef.current) {
          termRef.current?.write(bytes)
        }
      },
      onOutput: (tag, bytes) => {
        if (tag !== curTagRef.current) return
        termRef.current?.write(bytes)
      },
      onCreated: (t) => {
        setProjects((ps) =>
          ps.map((p) => (p.id === t.projectId ? { ...p, terminals: [...p.terminals, t] } : p))
        )
        attachTo(t.id, t)
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
        setAttention((a) => ({ ...a, [tid]: { reason, message } }))
        if (reason === 'needs-permission') {
          setPermission((p) => ({ ...p, [tid]: { message } }))
        } else if (reason === 'finished') {
          // Not waiting-input/notify: the idle sweeper and Claude's idle
          // notice can fire while the prompt is still open.
          dropPermission(tid)
        }
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
        setAlive((a) => ({ ...a, [tid]: false }))
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
      onChatHistory: (tid, messages, truncated) => {
        if (tid !== curIdRef.current) return
        putChat({ id: tid, messages, truncated, loaded: true })
        // A prompt answered elsewhere (on the desktop) leaves no waiting tool.
        if (!hasPendingTool(messages)) dropPermission(tid)
      },
      onChatAppend: (tid, messages) => {
        const c = chatRef.current
        if (tid !== curIdRef.current || c.id !== tid) return
        const next = upsertMessages(c.messages, messages)
        putChat({ ...c, messages: next })
        // Parallel tool calls: the prompt may be for one that still waits.
        if (!hasPendingTool(next)) dropPermission(tid)
      },
      onChatUnavailable: (tid, reason) => {
        unavailableRef.current = { ...unavailableRef.current, [tid]: true }
        setUnavailable((u) => ({ ...u, [tid]: true }))
        if (tid === curIdRef.current) {
          modeRef.current = 'terminal'
          setMode('terminal')
          setToast(reason)
          requestAnimationFrame(() => {
            fitRef.current?.fit()
            const term = termRef.current
            if (term && curIdRef.current === tid) clientRef.current?.resize(tid, term.cols, term.rows)
          })
        }
      },
      onClaudeAlive: (tid, isAlive) => setAlive((a) => ({ ...a, [tid]: isAlive })),
      onTheme: (theme) => setTheme(theme),
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
  }, [attachTo, setTheme])

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

  // Re-fit only on genuine layout changes (orientation), debounced so a burst of
  // resize events settles into one PTY resize. The mobile keyboard no longer
  // resizes the layout viewport (interactive-widget=resizes-visual), so opening
  // it never reaches here — that's what stops the desktop terminal from
  // reflowing when the keyboard appears.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => fitRef.current?.fit(), 200)
    }
    window.addEventListener('resize', onResize)
    return () => {
      if (t) clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Track the on-screen keyboard via the visual viewport and expose its height as
  // --kb-inset. The .app transform lifts the UI above the keyboard so the prompt
  // and key row stay visible — all without resizing the terminal grid.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const apply = () => {
      const kb = Math.max(0, root.clientHeight - vv.height - vv.offsetTop)
      root.style.setProperty('--kb-inset', kb > 120 ? `${Math.round(kb)}px` : '0px')
      root.classList.toggle('kb-open', kb > 120)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      root.style.removeProperty('--kb-inset')
      root.classList.remove('kb-open')
    }
  }, [])

  // Only an installed app on a phone with a home-bar inset (rounded screen
  // corners) gets the key row's screen-matching corners; elsewhere the row sits
  // on a browser toolbar, a nav bar or a square screen edge.
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean }
    if (!window.matchMedia('(display-mode: standalone)').matches && !nav.standalone) return
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;visibility:hidden;height:env(safe-area-inset-bottom)'
    document.body.appendChild(probe)
    const inset = probe.getBoundingClientRect().height
    probe.remove()
    // iOS phones report 21–34px; Android's 3-button nav bar (~48px) has square
    // corners, and tablets' screen corners are far smaller than a phone's.
    const phone = Math.min(screen.width, screen.height) < 500
    if (phone && inset >= 20 && inset <= 40) document.documentElement.classList.add('screen-corners')
  }, [])

  const mountTerminal = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || termRef.current) return
      const term = new Terminal({
        theme: xtermTheme(),
        fontFamily:
          '"MesloLGS NF", "JetBrainsMono Nerd Font", "Hack Nerd Font", "Fira Code", Menlo, Monaco, monospace',
        lineHeight: 1.2,
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
        if (!id) return
        clientRef.current?.input(id, data)
      })
      term.onResize(({ cols, rows }) => {
        const id = curIdRef.current
        // In chat mode the desktop owns the size (term.releaseSize).
        if (id && modeRef.current === 'terminal') clientRef.current?.resize(id, cols, rows)
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
    },
    [notify]
  )

  const switchMode = (next: ViewMode) => {
    const id = curIdRef.current
    if (!id) return
    modeStore.set(id, next)
    modeRef.current = next
    setMode(next)
    if (next === 'chat') {
      clearUnavailable(id)
      termRef.current?.blur()
      clientRef.current?.releaseSize(id)
      clientRef.current?.chatOpen(id)
    } else {
      clientRef.current?.chatClose(id)
      // onResize won't fire if the grid didn't change, so always send it.
      requestAnimationFrame(() => {
        fitRef.current?.fit()
        const term = termRef.current
        if (term && curIdRef.current === id) clientRef.current?.resize(id, term.cols, term.rows)
        term?.focus()
      })
    }
  }

  const sendPrompt = (text: string): boolean => {
    const id = curIdRef.current
    const client = clientRef.current
    const seq = promptSequences(text)
    if (!id || !client || !seq || !client.isOpen()) return false
    client.input(id, seq.clear + seq.paste)
    setTimeout(() => client.input(id, seq.enter), ENTER_DELAY_MS)
    return true
  }

  const answerPermission = (seq: string) => {
    const id = curIdRef.current
    if (!id) return
    clientRef.current?.input(id, seq)
    dropPermission(id)
  }

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
  const showChat = !!current?.claude && mode === 'chat' && !unavailable[current.id]

  return (
    <div className="app">
      <div className="topbar">
        <button className="iconbtn" onClick={() => setDrawerOpen(true)} aria-label="Menu">
          <MenuIcon size={18} />
        </button>
        <span className="title">
          {current && <span className={`state-dot ${working.has(current.id) ? 'busy' : ''}`} />}
          <span className="title-text">{current ? current.name : 'No terminal'}</span>
        </span>
        <span className="status">{reconnecting ? 'Reconnecting…' : status}</span>
        {current?.claude && (
          <button
            className="iconbtn"
            onClick={() => switchMode(showChat ? 'terminal' : 'chat')}
            aria-label={showChat ? 'Show terminal' : 'Show chat'}
          >
            {showChat ? <TerminalIcon size={17} /> : <ChatIcon size={17} />}
          </button>
        )}
        <button className="iconbtn" onClick={openGit} aria-label="Git">
          <BranchIcon size={17} />
        </button>
      </div>
      {reconnecting && <div className="reconnbar">Connection lost — reconnecting…</div>}

      <div className="termwrap">
        {current ? (
          <>
            <div className="term" ref={mountTerminal} onClick={() => termRef.current?.focus()} />
            {showChat && (
              <ChatView
                key={current.id}
                messages={chat.id === current.id ? chat.messages : []}
                truncated={chat.id === current.id && chat.truncated}
                loaded={chat.id === current.id && chat.loaded}
                working={working.has(current.id)}
                alive={!!alive[current.id]}
                connected={!reconnecting}
                permission={permission[current.id] ?? null}
                hooksMissing={hooksMissing}
                onSend={sendPrompt}
                onStop={() => {
                  if (working.has(current.id)) clientRef.current?.input(current.id, '\x1b')
                }}
                onKey={answerPermission}
                onViewTerminal={() => switchMode('terminal')}
              />
            )}
          </>
        ) : (
          <div className="emptyterm">
            <TerminalIcon size={22} />
            Open the menu to pick or create a terminal.
          </div>
        )}
      </div>

      {!showChat && (
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
          <div className="key-group arrows">
            <button className="key" aria-label="Left" onClick={() => sendKey('\x1b[D')}>
              <ChevronLeftIcon size={15} />
            </button>
            <button className="key" aria-label="Up" onClick={() => sendKey('\x1b[A')}>
              <ChevronUpIcon size={15} />
            </button>
            <button className="key" aria-label="Down" onClick={() => sendKey('\x1b[B')}>
              <ChevronDownIcon size={15} />
            </button>
            <button className="key" aria-label="Right" onClick={() => sendKey('\x1b[C')}>
              <ChevronRightIcon size={15} />
            </button>
          </div>
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="scrim" onClick={() => setDrawerOpen(false)} />
          <div className="drawer">
            <h2>Projects</h2>
            {projects.map((p) => (
              <div className="proj" key={p.id}>
                <div className="proj-name">
                  <span className="dot" style={{ background: p.color }} />
                  <span className="label">{p.name}</span>
                </div>
                {p.terminals.length === 0 && <div className="proj-empty">No terminals</div>}
                {p.terminals.map((t) => (
                  <div
                    key={t.id}
                    className={`term-row ${t.id === currentId ? 'active' : ''}`}
                    onClick={() => attachTo(t.id)}
                  >
                    <span className={`state-dot ${dotClass(working.has(t.id), attention[t.id]?.reason)}`} />
                    <span className={`name ${t.live ? '' : 'dead'}`}>{t.name}</span>
                    <button
                      className="x"
                      onClick={(e) => {
                        e.stopPropagation()
                        clientRef.current?.close(t.id)
                      }}
                      aria-label="Close terminal"
                    >
                      <CloseIcon size={13} />
                    </button>
                  </div>
                ))}
                <div className="mk">
                  <button className="btn" onClick={() => clientRef.current?.create(p.id, 'shell')}>
                    <TerminalIcon size={13} />
                    Shell
                  </button>
                  <button className="btn" onClick={() => clientRef.current?.create(p.id, 'claude')}>
                    <SparklesIcon size={13} />
                    Claude
                  </button>
                  <button className="btn" onClick={() => openSessions(p.id)}>
                    <HistoryIcon size={13} />
                    Sessions
                  </button>
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

/** Busy beats attention, as on the desktop's terminal tabs. */
function dotClass(busy: boolean, attention: string | undefined): string {
  if (busy) return 'busy'
  if (attention === 'needs-permission' || attention === 'failed') return 'att-red'
  if (attention === 'finished') return 'att-green'
  return attention ? 'att-amber' : ''
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
          <img className="card-icon" src="/icon.svg" alt="" />
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
          <img className="card-icon" src="/icon.svg" alt="" />
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
