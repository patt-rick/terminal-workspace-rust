import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useWorkspace } from '../../state/store'
import { useActiveTheme } from '../../themes/theme-provider'
import type { Theme } from '../../themes'
import { ipc } from '../../lib/ipc'
import { getWindowsBuild, isMac } from '../../lib/platform'

interface Props {
  terminalId: string
  active: boolean
  onBell?: () => void
}

// Parse `OSC 9 ; 4 ; <state> ; <progress>`. States: 0=clear, 1=normal, 2=error,
// 3=indeterminate, 4=paused. Treat 1/3/4 as busy, 0/2 as idle.
const parseConEmuProgress = (data: string): boolean | null => {
  if (!data.startsWith('4;')) return null
  const stateChar = data.charAt(2)
  if (stateChar === '0' || stateChar === '2') return false
  if (stateChar === '1' || stateChar === '3' || stateChar === '4') return true
  return null
}

// Agent TUIs (Claude Code) report turn activity through the window title: while
// working they prefix it with an animated spinner — braille frames
// (U+2800–U+28FF) or the ✳ marker — then reset to a bare "✳ Claude Code" idle.
const SPINNER_PREFIX = /^[✳⠀-⣿]/
const titleIndicatesWork = (title: string): boolean => {
  if (!SPINNER_PREFIX.test(title)) return false
  const code = title.trimStart().charCodeAt(0)
  if (code >= 0x2800 && code <= 0x28ff) return true
  const task = title.replace(/^[✳⠀-⣿\s ]+/, '').trim()
  return task.length > 0 && !/^claude code\b/i.test(task)
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
  const fitRef = useRef<FitAddon | null>(null)
  const initRef = useRef(false)
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

    // Wire copy/paste explicitly. macOS uses ⌘C/⌘V; elsewhere Ctrl+Shift+C/V.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      const copyCombo = isMac ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey
      if (key === 'c' && copyCombo && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (key === 'v' && !isMac && e.ctrlKey && e.shiftKey) {
        void navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text)
        })
        return false
      }
      return true
    })

    term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit

    void Promise.all([
      document.fonts.load('13px "MesloLGS NF"'),
      document.fonts.load('bold 13px "MesloLGS NF"'),
    ])
      .catch(() => undefined)
      .then(() => {
        if (termRef.current !== term) return
        try {
          term.clearTextureAtlas()
          fit.fit()
          term.refresh(0, term.rows - 1)
        } catch {
          // teardown race
        }
      })

    const fitNow = (): void => {
      try {
        fit.fit()
        void ipc.terminals.resize(terminalId, term.cols, term.rows)
      } catch {
        // teardown
      }
    }
    fitNow()

    const onResize = (): void => fitNow()
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(() => fitNow())
    ro.observe(hostRef.current)

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
    const titleDisposable = term.onTitleChange((title) => {
      setTitle(terminalId, title)
      const working = titleIndicatesWork(title)
      if (working === titleWorking) return
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
        void navigator.clipboard.writeText(new TextDecoder().decode(bytes))
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
      window.removeEventListener('resize', onResize)
      useWorkspace.getState().setTerminalBusy(terminalId, false)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      initRef.current = false
    }
  }, [terminalId])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        termRef.current?.focus()
        const term = termRef.current
        if (term) void ipc.terminals.resize(terminalId, term.cols, term.rows)
      } catch {
        // ignore
      }
    })
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
