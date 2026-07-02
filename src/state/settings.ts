import { create } from 'zustand'
import { DEFAULT_THEME_ID } from '../themes'
import type { Theme } from '../themes'

export interface EditorSettings {
  fontSize: number
  fontFamily: string
  tabSize: number
  insertSpaces: boolean
  wordWrap: boolean
  lineNumbers: boolean
}

export interface TerminalSettings {
  /** Command run automatically in every new terminal tab. Empty = nothing. */
  startupCommand: string
  /**
   * When true, every default Claude Code launch appends
   * `--dangerously-skip-permissions`. The ⇧D shortcut always adds it regardless.
   */
  claudeSkipPermissions: boolean
}

export const EDITOR_DEFAULTS: EditorSettings = {
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  tabSize: 2,
  insertSpaces: true,
  wordWrap: false,
  lineNumbers: true,
}

export const TERMINAL_DEFAULTS: TerminalSettings = {
  startupCommand: '',
  claudeSkipPermissions: false,
}

export interface Settings {
  themeId: string
  editor: EditorSettings
  terminal: TerminalSettings
  /** User-imported themes; merged with the built-in presets at runtime. */
  customThemes: Theme[]
}

export const SETTINGS_DEFAULTS: Settings = {
  themeId: DEFAULT_THEME_ID,
  editor: EDITOR_DEFAULTS,
  terminal: TERMINAL_DEFAULTS,
  customThemes: [],
}

// localStorage is the first-paint mirror; the Rust settings.json is the durable
// source of truth and is reconciled on startup (see hydrateSettings).
const STORAGE_KEY = 'tw:settings'

export function readStoredSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return SETTINGS_DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      themeId: parsed.themeId ?? SETTINGS_DEFAULTS.themeId,
      editor: { ...EDITOR_DEFAULTS, ...parsed.editor },
      terminal: { ...TERMINAL_DEFAULTS, ...parsed.terminal },
      customThemes: Array.isArray(parsed.customThemes) ? parsed.customThemes : [],
    }
  } catch {
    return SETTINGS_DEFAULTS
  }
}

function persistLocal(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // ignore — storage may be unavailable
  }
}

interface SettingsState extends Settings {
  setThemeId: (id: string) => void
  updateEditor: (patch: Partial<EditorSettings>) => void
  updateTerminal: (patch: Partial<TerminalSettings>) => void
  /**
   * Add an imported theme. Its id is made unique against existing themes, and
   * the stored theme (with the final id) is returned so callers can select it.
   */
  addCustomTheme: (theme: Theme) => Theme
  /** Remove a custom theme by id; if it was selected, fall back to default. */
  removeCustomTheme: (id: string) => void
  /** Replace the whole settings object (used when hydrating from the backend). */
  replaceAll: (s: Settings) => void
}

// Ensure an imported theme's id doesn't collide with an existing custom theme.
function uniqueThemeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

// Injected by the IPC layer once available, so this store has no hard Tauri
// dependency (keeps the frontend runnable in a plain browser for dev).
let backendSync: ((s: Settings) => void) | null = null
export function setSettingsBackendSync(fn: (s: Settings) => void): void {
  backendSync = fn
}

export const useSettings = create<SettingsState>((set, get) => {
  const snapshot = (): Settings => {
    const { themeId, editor, terminal, customThemes } = get()
    return { themeId, editor, terminal, customThemes }
  }
  const commit = (): void => {
    const s = snapshot()
    persistLocal(s)
    backendSync?.(s)
  }
  const initial = readStoredSettings()
  return {
    ...initial,
    setThemeId: (id) => {
      set({ themeId: id })
      commit()
    },
    updateEditor: (patch) => {
      set((state) => ({ editor: { ...state.editor, ...patch } }))
      commit()
    },
    updateTerminal: (patch) => {
      set((state) => ({ terminal: { ...state.terminal, ...patch } }))
      commit()
    },
    addCustomTheme: (theme) => {
      const taken = new Set(get().customThemes.map((t) => t.meta.id))
      const id = uniqueThemeId(theme.meta.id, taken)
      const stored: Theme = { ...theme, meta: { ...theme.meta, id } }
      set((state) => ({ customThemes: [...state.customThemes, stored] }))
      commit()
      return stored
    },
    removeCustomTheme: (id) => {
      set((state) => ({
        customThemes: state.customThemes.filter((t) => t.meta.id !== id),
        themeId: state.themeId === id ? DEFAULT_THEME_ID : state.themeId,
      }))
      commit()
    },
    replaceAll: (s) => {
      set({
        themeId: s.themeId,
        editor: s.editor,
        terminal: s.terminal,
        customThemes: s.customThemes,
      })
      persistLocal(s)
    },
  }
})
