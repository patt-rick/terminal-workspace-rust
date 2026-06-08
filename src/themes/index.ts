import type { Theme } from './types'
import { halcyon } from './presets/halcyon'
import { tokyoNight } from './presets/tokyo-night'
import { catppuccinMocha } from './presets/catppuccin-mocha'
import { oneDark } from './presets/one-dark'
import { catppuccinLatte } from './presets/catppuccin-latte'
import { blackAsh } from './presets/black-ash'

export type { Theme, Appearance, AnsiPalette } from './types'

export const THEMES: Theme[] = [
  halcyon,
  tokyoNight,
  catppuccinMocha,
  oneDark,
  catppuccinLatte,
  blackAsh,
]

export const DEFAULT_THEME_ID = halcyon.meta.id

const BY_ID = new Map(THEMES.map((t) => [t.meta.id, t]))

export function getTheme(id: string): Theme {
  return BY_ID.get(id) ?? halcyon
}

// camelCase → kebab-case for CSS custom property names.
const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/**
 * Write a theme's tokens onto :root as CSS custom properties and tag the
 * document with its id + appearance. Tailwind utilities reference these vars
 * (see globals.css `@theme inline`), and xterm / CodeMirror read them at
 * runtime — so one call recolors chrome, terminal, and editor together.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement

  for (const [key, value] of Object.entries(theme.chrome)) {
    root.style.setProperty(`--${kebab(key)}`, value)
  }

  root.style.setProperty('--terminal-cursor', theme.terminal.cursor)
  root.style.setProperty('--terminal-selection', theme.terminal.selection)
  for (const [key, value] of Object.entries(theme.terminal.ansi)) {
    root.style.setProperty(`--ansi-${kebab(key)}`, value)
  }

  for (const [key, value] of Object.entries(theme.syntax)) {
    root.style.setProperty(`--syntax-${kebab(key)}`, value)
  }

  root.setAttribute('data-theme', theme.meta.id)
  root.classList.toggle('dark', theme.meta.appearance === 'dark')
  root.classList.toggle('light', theme.meta.appearance === 'light')
  root.style.colorScheme = theme.meta.appearance
}
