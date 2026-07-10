import type { Theme } from './types'
import { halcyon } from './presets/halcyon'

// Halcyon is the shape reference: required token keys are derived from it so the
// validator stays in sync with the Theme interface automatically.
const CHROME_KEYS = Object.keys(halcyon.chrome) as (keyof Theme['chrome'])[]
const ANSI_KEYS = Object.keys(halcyon.terminal.ansi) as (keyof Theme['terminal']['ansi'])[]
const SYNTAX_KEYS = Object.keys(halcyon.syntax) as (keyof Theme['syntax'])[]

export type ParseResult =
  | { ok: true; theme: Theme }
  | { ok: false; error: string }

// Theme color values are injected into the DOM as CSS custom properties, so
// every value is validated against this allowlist. Anything outside it (e.g. a
// value smuggling `;`, `}`, or `url(...)`) is rejected.
const COLOR = new RegExp(
  [
    '^#[0-9a-fA-F]{3,8}$', // hex (3/4/6/8)
    '^rgba?\\(\\s*[\\d.]+%?\\s*,\\s*[\\d.]+%?\\s*,\\s*[\\d.]+%?\\s*(,\\s*[\\d.]+%?\\s*)?\\)$',
    '^hsla?\\(\\s*[\\d.]+\\s*,\\s*[\\d.]+%\\s*,\\s*[\\d.]+%\\s*(,\\s*[\\d.]+%?\\s*)?\\)$',
    '^[a-zA-Z]+$', // named colors (transparent, red, etc.)
  ].join('|'),
)

function isColor(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && COLOR.test(v.trim())
}

// Gradients are also injected as CSS custom property values, so the same
// injection concern applies. Allow only the CSS gradient functions with an
// inner character set that covers colors, angles, stops, and keywords —
// crucially excluding `;`, `{`, `}`, and quotes that could break out of the
// declaration, plus `url` (which the char set already forbids via `:` and `/`).
const GRADIENT = /^(repeating-)?(linear|radial|conic)-gradient\(\s*[a-zA-Z0-9#.,%()\s-]+\)$/

function isGradient(v: unknown): v is string {
  return typeof v === 'string' && GRADIENT.test(v.trim())
}

// Every optional gradient key and the group name for error messages.
const GRADIENT_KEYS = ['app', 'titleBar'] as const

function checkGradients(obj: Record<string, unknown>): string | null {
  for (const key of GRADIENT_KEYS) {
    const v = obj[key]
    if (v === undefined) continue // optional
    if (!isGradient(v)) return `Invalid gradient for gradients.${key}: ${JSON.stringify(v)}`
  }
  return null
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `custom:${base || 'theme'}`
}

function checkColors(
  obj: Record<string, unknown>,
  keys: string[],
  group: string,
): string | null {
  for (const key of keys) {
    const v = obj[key]
    if (v === undefined) return `Missing ${group}.${key}`
    if (!isColor(v)) return `Invalid color for ${group}.${key}: ${JSON.stringify(v)}`
  }
  return null
}

/**
 * Parse and fully validate a user-supplied theme JSON string. Requires the
 * complete token set (the exact shape Export produces) and rejects anything
 * with a missing token, a malformed color, or bad metadata. On success the
 * returned theme has a fresh `custom:<slug>` id.
 */
export function parseThemeJson(raw: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'File is not valid JSON.' }
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'Theme must be a JSON object.' }
  }

  const t = data as Record<string, unknown>
  const meta = t.meta as Record<string, unknown> | undefined
  const chrome = t.chrome as Record<string, unknown> | undefined
  const terminal = t.terminal as Record<string, unknown> | undefined
  const syntax = t.syntax as Record<string, unknown> | undefined

  if (!meta || typeof meta.name !== 'string' || meta.name.trim() === '') {
    return { ok: false, error: 'meta.name is required and must be a non-empty string.' }
  }
  if (meta.appearance !== 'dark' && meta.appearance !== 'light') {
    return { ok: false, error: "meta.appearance must be 'dark' or 'light'." }
  }
  if (!chrome) return { ok: false, error: 'Missing chrome tokens.' }
  if (!terminal) return { ok: false, error: 'Missing terminal tokens.' }
  if (!syntax) return { ok: false, error: 'Missing syntax tokens.' }

  const chromeErr = checkColors(chrome, CHROME_KEYS, 'chrome')
  if (chromeErr) return { ok: false, error: chromeErr }

  if (!isColor(terminal.cursor)) return { ok: false, error: 'Invalid terminal.cursor.' }
  if (!isColor(terminal.selection)) return { ok: false, error: 'Invalid terminal.selection.' }
  const ansi = terminal.ansi as Record<string, unknown> | undefined
  if (!ansi) return { ok: false, error: 'Missing terminal.ansi palette.' }
  const ansiErr = checkColors(ansi, ANSI_KEYS, 'terminal.ansi')
  if (ansiErr) return { ok: false, error: ansiErr }

  const syntaxErr = checkColors(syntax, SYNTAX_KEYS, 'syntax')
  if (syntaxErr) return { ok: false, error: syntaxErr }

  // Gradients are optional; validate only the keys that are present.
  let gradients: Theme['gradients']
  if (t.gradients !== undefined) {
    if (typeof t.gradients !== 'object' || t.gradients === null) {
      return { ok: false, error: 'gradients must be a JSON object.' }
    }
    const g = t.gradients as Record<string, unknown>
    const gradientErr = checkGradients(g)
    if (gradientErr) return { ok: false, error: gradientErr }
    gradients = {
      ...(typeof g.app === 'string' ? { app: g.app.trim() } : {}),
      ...(typeof g.titleBar === 'string' ? { titleBar: g.titleBar.trim() } : {}),
    }
  }

  // Optional title-bar text color: a solid color like the chrome tokens, so it
  // runs through the same allowlist before being injected as a CSS variable.
  let titleBarText: string | undefined
  if (t.titleBarText !== undefined) {
    if (!isColor(t.titleBarText)) {
      return { ok: false, error: `Invalid color for titleBarText: ${JSON.stringify(t.titleBarText)}` }
    }
    titleBarText = (t.titleBarText as string).trim()
  }

  const theme: Theme = {
    meta: {
      id: slugify(meta.name),
      name: meta.name.trim(),
      appearance: meta.appearance,
    },
    chrome: chrome as unknown as Theme['chrome'],
    terminal: terminal as unknown as Theme['terminal'],
    syntax: syntax as unknown as Theme['syntax'],
    ...(gradients ? { gradients } : {}),
    ...(titleBarText ? { titleBarText } : {}),
  }
  return { ok: true, theme }
}
