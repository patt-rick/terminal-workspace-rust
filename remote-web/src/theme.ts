import type { ITheme } from '@xterm/xterm'

// The slice of the desktop's Theme (src/themes/types.ts) the desktop sends over
// the wire. Fields are optional on purpose: an older desktop, or a hand-written
// custom theme, may leave some out, and a missing token keeps its CSS default.
export interface RemoteTheme {
  meta?: { id?: string; name?: string; appearance?: 'dark' | 'light' }
  chrome?: Record<string, string>
  terminal?: {
    cursor?: string
    selection?: string
    ansi?: Record<string, string>
  }
  gradients?: { app?: string }
}

const STORAGE_KEY = 'tw_theme'

// Only these become CSS variables: a custom theme can't override the phone's
// own layout variables, and a token a newer theme drops is reset to default.
const CHROME_TOKENS = [
  'background',
  'surface',
  'surfaceSecondary',
  'surfaceTertiary',
  'foreground',
  'muted',
  'accent',
  'accentForeground',
  'border',
  'separator',
  'success',
  'warning',
  'danger',
  'link',
  'focus',
  'fieldBackground',
  'fieldBorder',
  'overlay',
  'backdrop',
] as const

const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

const hex = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** `color-mix(in srgb, a <weight>, b)` for hex colours; null if either isn't hex. */
function mix(a: string, b: string, weight: number): string | null {
  const x = hex(a)
  const y = hex(b)
  if (!x || !y) return null
  const ch = (i: number) => Math.round(x[i] * weight + y[i] * (1 - weight))
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`
}

// Halcyon, the desktop default — used before any theme has arrived.
const DEFAULT_XTERM: ITheme = {
  background: '#1d2433',
  foreground: '#a2aabc',
  cursor: '#ffcc66',
  cursorAccent: '#1d2433',
  selectionBackground: 'rgba(255, 204, 102, 0.3)',
  black: '#2f3b54',
  red: '#ef6b73',
  green: '#bae67e',
  yellow: '#ffcc66',
  blue: '#5ccfe6',
  magenta: '#c3a6ff',
  cyan: '#5ccfe6',
  white: '#a2aabc',
  brightBlack: '#444a5e',
  brightRed: '#ef6b73',
  brightGreen: '#bae67e',
  brightYellow: '#ffcc66',
  brightBlue: '#5ccfe6',
  brightMagenta: '#c3a6ff',
  brightCyan: '#5ccfe6',
  brightWhite: '#d7dce2',
}

let current: RemoteTheme | null = null

/** Mirrors the desktop's buildXtermTheme (terminal-pane.tsx). */
export function xtermTheme(theme: RemoteTheme | null = current): ITheme {
  if (!theme) return DEFAULT_XTERM
  const c = theme.chrome ?? {}
  const t = theme.terminal ?? {}
  const background = c.background ?? DEFAULT_XTERM.background
  return {
    ...DEFAULT_XTERM,
    ...(t.ansi ?? {}),
    background,
    foreground: c.foreground ?? DEFAULT_XTERM.foreground,
    cursor: t.cursor ?? DEFAULT_XTERM.cursor,
    cursorAccent: background,
    selectionBackground: t.selection ?? DEFAULT_XTERM.selectionBackground,
  }
}

/** Write the theme's chrome tokens onto :root under the desktop's variable names. */
export function applyTheme(theme: RemoteTheme): void {
  current = theme
  const root = document.documentElement
  const chrome = theme.chrome ?? {}
  for (const key of CHROME_TOKENS) {
    const value = chrome[key]
    if (typeof value === 'string') root.style.setProperty(`--${kebab(key)}`, value)
    else root.style.removeProperty(`--${kebab(key)}`)
  }
  const app = theme.gradients?.app
  if (app) root.style.setProperty('--gradient-app', app)
  else root.style.removeProperty('--gradient-app')

  const light = theme.meta?.appearance === 'light'
  root.classList.toggle('light', light)
  root.classList.toggle('dark', !light)
  root.style.colorScheme = light ? 'light' : 'dark'

  // The status bar sits over the page backdrop (see --shell-backdrop).
  const meta = document.querySelector('meta[name="theme-color"]')
  const surface = chrome.surface
  if (meta && surface) {
    const backdrop = light
      ? mix(surface, chrome.foreground ?? '#000000', 0.93)
      : mix(surface, '#000000', 0.78)
    meta.setAttribute('content', backdrop ?? surface)
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme))
  } catch {
    // Private mode / blocked storage: the theme still applies for this visit.
  }
}

/** Re-apply the last theme seen, so the pairing screen is themed before connecting. */
export function restoreTheme(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) applyTheme(JSON.parse(raw) as RemoteTheme)
  } catch {
    // Missing or corrupt: stay on the CSS defaults.
  }
}
