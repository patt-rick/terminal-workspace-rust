export type Appearance = 'dark' | 'light'

/** The 16 standard ANSI slots fed to xterm.js. */
export interface AnsiPalette {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * Chrome tokens become CSS custom properties on `:root` and drive every
 * surface, text color, and accent across the UI. `background` is the editor /
 * terminal surface; `surface` is the surrounding frame (kept distinct so the
 * editor area visually lifts out of the chrome, like VS Code).
 */
export interface ChromeTokens {
  background: string
  surface: string
  surfaceSecondary: string
  surfaceTertiary: string
  foreground: string
  muted: string
  accent: string
  accentForeground: string
  border: string
  separator: string
  success: string
  warning: string
  danger: string
  link: string
  focus: string
  scrollbar: string
  fieldBackground: string
  fieldBorder: string
  overlay: string
  backdrop: string
}

/** Terminal-only colors derived alongside the chrome but consumed by xterm. */
export interface TerminalTokens {
  cursor: string
  /** rgba — drawn as a translucent overlay */
  selection: string
  ansi: AnsiPalette
}

/** Editor syntax colors consumed by the CodeMirror theme builder. */
export interface SyntaxTokens {
  comment: string
  keyword: string
  string: string
  number: string
  function: string
  variable: string
  type: string
  constant: string
  operator: string
  punctuation: string
  tag: string
  attribute: string
  heading: string
  link: string
}

/**
 * Optional decorative gradients layered over the solid color tokens. Each value
 * is a full CSS gradient function string (e.g. `linear-gradient(...)`). They are
 * applied only to chrome surfaces — the terminal and editor keep solid
 * backgrounds so xterm/CodeMirror rendering and text legibility are unaffected.
 */
export interface GradientTokens {
  /** Window backdrop, painted on `body` behind the chrome. */
  app?: string
  /** The custom title bar background. */
  titleBar?: string
}

export interface Theme {
  meta: { id: string; name: string; appearance: Appearance }
  chrome: ChromeTokens
  terminal: TerminalTokens
  syntax: SyntaxTokens
  gradients?: GradientTokens
}
