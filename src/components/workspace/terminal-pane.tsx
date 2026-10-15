import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useWorkspace } from '../../state/store'
import { useActiveTheme } from '../../themes/theme-provider'
import type { Theme } from '../../themes'
import { ipc } from '../../lib/ipc'
import { createTitleWorkTracker } from '../../lib/agent-title'
import { getWindowsBuild, isMac } from '../../lib/platform'
import { bindingForEvent } from '../../lib/keybindings'
import { currentKeybindings } from '../../state/keybindings'

interface Props {
  terminalId: string
  active: boolean
  onBell?: () => void
}

const PTY_RESIZE_SETTLE_MS = 80

// Parse `OSC 9 ; 4 ; <state> ; <progress>`. States: 0=clear, 1=normal, 2=error,
// 3=indeterminate, 4=paused. Treat 1/3/4 as busy, 0/2 as idle.
const parseConEmuProgress = (data: string): boolean | null => {
  if (!data.startsWith('4;')) return null
  const stateChar = data.charAt(2)
  if (stateChar === '0' || stateChar === '2') return false
  if (stateChar === '1' || stateChar === '3' || stateChar === '4') return true
  return null
}

// Read colors straight from the active theme object (not the DOM) so the
// terminal palette always matches the rest of the UI, regardless of effect
// ordering relative to when CSS variables are written.
const buildXtermTheme = (theme: Theme) => ({
  background: theme.chrome.background,
  foreground: theme.chrome.foreground,
  cursor: theme.terminal.cursor,
  cursorAccent: theme.chrome.background,
  selectionBackground: theme.terminal.selection,
  black: theme.terminal.ansi.black,
  red: theme.terminal.ansi.red,
  green: theme.terminal.ansi.green,
  yellow: theme.terminal.ansi.yellow,
  blue: theme.terminal.ansi.blue,
  magenta: theme.terminal.ansi.magenta,
  cyan: theme.terminal.ansi.cyan,
  white: theme.terminal.ansi.white,
  brightBlack: theme.terminal.ansi.brightBlack,
  brightRed: theme.terminal.ansi.brightRed,
  brightGreen: theme.terminal.ansi.brightGreen,
  brightYellow: theme.terminal.ansi.brightYellow,
  brightBlue: theme.terminal.ansi.brightBlue,
  brightMagenta: theme.terminal.ansi.brightMagenta,
  brightCyan: theme.terminal.ansi.brightCyan,
  brightWhite: theme.terminal.ansi.brightWhite,
})

export function TerminalPane({ terminalId, active, onBell }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // Grid a remote client mandates while attached (remote-wins sizing): the pane mirrors it
  // (letterboxed) instead of fitting, so both viewers agree with the PTY.
  const remoteSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const initRef = useRef(false)
  const fitNowRef = useRef<((force?: boolean) => void) | null>(null)
  /** the last `colsxrows` sent to the PTY */
  const sentSizeRef = useRef<string | null>(null)
  const bellRef = useRef<typeof onBell>(onBell)
  bellRef.current = onBell
  const activeRef = useRef(active)
  activeRef.current = active
  const theme = useActiveTheme()
  const themeRef = useRef(theme)
  themeRef.current = theme

  useEffect(() => {
    if (!hostRef.current || initRef.current) return
    initRef.current = true

    const windowsBuild = getWindowsBuild()
    const term = new Terminal({
      fontFamily:
        '"MesloLGS NF", "JetBrainsMono Nerd Font", "Hack Nerd Font", "Fira Code", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      allowProposedApi: true,
      scrollback: 10_000,
      theme: buildXtermTheme(themeRef.current),
      ...(windowsBuild
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: windowsBuild } }
        : {}),
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey || event.ctrlKey) void openUrl(uri)
      })
    )

    // Wire copy/paste explicitly through the Tauri clipboard plugin —
    // navigator.clipboard.readText() is denied inside the webview, so paste
    // would silently fail. macOS: ⌘C/⌘V. Elsewhere: Ctrl(+Shift)+C to copy,
    // Ctrl+V / Ctrl+Shift+V / Shift+Insert to paste. A plain Ctrl+V with no
    // clipboard text falls through as ^V (\x16) so TUIs that read the
    // clipboard themselves (Claude Code image paste) keep working.
    const pasteFromClipboard = (fallbackByte?: string): void => {
      void readText()
        .catch(() => '')
        .then((text) => {
          // With no text an empty paste is still sent, as the webview's paste
          // event used to: a TUI may take it as the cue to read the clipboard.
          term.paste(text)
          if (!text && fallbackByte) term.input(fallbackByte)
        })
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // xterm would send a Ctrl+letter shortcut to the shell and stop the
      // event. Returning false leaves it for the app, for the bindings the
      // user has given to the app while a terminal is focused.
      if (bindingForEvent(e, isMac, currentKeybindings())?.inTerminal) return false
      const key = e.key.toLowerCase()
      const copyCombo = isMac ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey
      if (key === 'c' && copyCombo && term.hasSelection()) {
        void writeText(term.getSelection())
        return false
      }
      const pasteCombo = isMac
        ? key === 'v' && e.metaKey
        : (key === 'v' && e.ctrlKey && e.shiftKey) || (key === 'insert' && e.shiftKey)
      // Returning false only stops xterm's key handling. Unless the key is also
      // cancelled the webview fires its own paste event, which xterm pastes too,
      // so the text would arrive twice.
      if (pasteCombo) {
        e.preventDefault()
        pasteFromClipboard()
        return false
      }
      if (key === 'v' && !isMac && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        pasteFromClipboard('\x16')
        return false
      }
      return true
    })

    term.open(hostRef.current)
    termRef.current = term

    // The PTY hears about a new size only once it has settled, and only if the
    // grid really changed: each resize makes a full-screen TUI (Claude Code)
    // repaint everything, which xterm then has to parse.
    let resizeTimer: number | null = null
    let pendingSize: string | null = null
    const reportSize = (cols: number, rows: number): void => {
      const key = `${cols}x${rows}`
      if (key === (pendingSize ?? sentSizeRef.current)) return
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = null
      pendingSize = null
      // Back to the size the PTY already has before the timer fired: nothing to send.
      if (key === sentSizeRef.current) return
      pendingSize = key
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        pendingSize = null
        sentSizeRef.current = key
        void ipc.terminals.resize(terminalId, cols, rows)
      }, PTY_RESIZE_SETTLE_MS)
    }

    // A hidden pane is not refitted when the layout changes (collapsing the
    // nav resizes every pane at once, and a refit reflows the whole scrollback);
    // it fits when it is shown. `force` is for mount and activation.
    const fitNow = (force = false): void => {
      if (!force && !activeRef.current) return
      try {
        const remote = remoteSizeRef.current
        if (remote) {
          // Remote owns the size: keep mirroring its grid, but keep reporting
          // what this pane would want so detach snaps back correctly (R3.14).
          if (term.cols !== remote.cols || term.rows !== remote.rows) {
            term.resize(remote.cols, remote.rows)
          }
          const dims = fit.proposeDimensions()
          if (dims?.cols && dims?.rows) reportSize(dims.cols, dims.rows)
          return
        }
        // Not measurable yet (no layout): fit() would leave xterm's default grid.
        if (!fit.proposeDimensions()) return
        fit.fit()
        reportSize(term.cols, term.rows)
      } catch {
        // teardown
      }
    }
    fitNowRef.current = fitNow
    fitNow(true)

    void Promise.all([
      document.fonts.load('13px "MesloLGS NF"'),
      document.fonts.load('bold 13px "MesloLGS NF"'),
    ])
      .catch(() => undefined)
      .then(() => {
        if (termRef.current !== term) return
        try {
          term.clearTextureAtlas()
          fitNow(true)
          term.refresh(0, term.rows - 1)
        } catch {
          // teardown race
        }
      })

    // A tab asks for focus by id: clicking the tab that is already active
    // changes no state, so the `active` effect below would not run.
    const onFocusRequest = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === terminalId) term.focus()
    }
    window.addEventListener('tw:focus-terminal', onFocusRequest)
    // Fits in the frame the layout changed, before paint. A window resize
    // reaches the host this way too.
    const ro = new ResizeObserver(() => fitNow())
    ro.observe(hostRef.current)

    // Follow remote size ownership: adopt the phone's grid while it's attached,
    // refit when it lets go. Also adopt on mount if a remote is already attached.
    let unlistenRemoteSize: (() => void) | null = null
    let remoteListenerGone = false
    void ipc.terminals
      .onRemoteSize((p) => {
        if (p.id !== terminalId || termRef.current !== term) return
        if (p.cols && p.rows) {
          remoteSizeRef.current = { cols: p.cols, rows: p.rows }
          try {
            term.resize(p.cols, p.rows)
          } catch {
            // teardown race
          }
        } else {
          remoteSizeRef.current = null
          fitNow(true)
        }
      })
      .then((un) => {
        if (remoteListenerGone) un()
        else unlistenRemoteSize = un
      })
    void ipc.terminals.remoteSize(terminalId).then((size) => {
      if (size && termRef.current === term) {
        remoteSizeRef.current = { cols: size[0], rows: size[1] }
        try {
          term.resize(size[0], size[1])
        } catch {
          // teardown race
        }
      }
    })

    // Replay the snapshot, then live chunks. Chunks arriving over the channel
    // before the snapshot resolves are buffered so output stays ordered.
    let detached = false
    let snapshotApplied = false
    const pending: string[] = []
    const onData = (chunk: string): void => {
      if (!snapshotApplied) {
        pending.push(chunk)
        return
      }
      term.write(chunk)
    }
    void ipc.terminals.attach(terminalId, onData).then((snapshot) => {
      if (detached) return
      if (snapshot) term.write(snapshot)
      snapshotApplied = true
      for (const c of pending) term.write(c)
      pending.length = 0
    })

    const writeDisposable = term.onData((data) => {
      void ipc.terminals.write(terminalId, data)
    })
    const bellDisposable = term.onBell(() => bellRef.current?.())

    const setBusy = (busy: boolean): void => {
      useWorkspace.getState().setTerminalBusy(terminalId, busy)
    }
    const setTitle = useWorkspace.getState().setTerminalTitle
    let titleWorking = false
    const titleIndicatesWork = createTitleWorkTracker()
    const titleDisposable = term.onTitleChange((title) => {
      setTitle(terminalId, title)
      const working = titleIndicatesWork(title)
      if (working === null || working === titleWorking) return
      setBusy(working)
      if (titleWorking && !working && !(activeRef.current && document.hasFocus())) {
        bellRef.current?.()
      }
      titleWorking = working
    })

    const osc9 = term.parser.registerOscHandler(9, (data) => {
      const busy = parseConEmuProgress(data)
      if (busy !== null) setBusy(busy)
      return false
    })
    const osc52 = term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(';')
      if (semi === -1) return false
      const payload = data.slice(semi + 1)
      if (payload === '?') return false
      try {
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
        void writeText(new TextDecoder().decode(bytes))
      } catch {
        // malformed base64
      }
      return true
    })

    return () => {
      detached = true
      writeDisposable.dispose()
      bellDisposable.dispose()
      titleDisposable.dispose()
      osc9.dispose()
      osc52.dispose()
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      fitNowRef.current = null
      sentSizeRef.current = null
      remoteListenerGone = true
      unlistenRemoteSize?.()
      remoteSizeRef.current = null
      window.removeEventListener('tw:focus-terminal', onFocusRequest)
      useWorkspace.getState().setTerminalBusy(terminalId, false)
      term.dispose()
      termRef.current = null
      initRef.current = false
    }
  }, [terminalId])

  // Catches up on any layout change made while the pane was hidden, before the
  // pane is first painted again.
  useLayoutEffect(() => {
    if (active) fitNowRef.current?.(true)
  }, [active, terminalId])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => termRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active, terminalId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = buildXtermTheme(theme)
  }, [theme])

  return (
    <div
      className="absolute inset-0 bg-background px-3 py-2"
      style={{ visibility: active ? 'visible' : 'hidden' }}
    >
      <div className="h-full w-full" ref={hostRef} />
    </div>
  )
}
