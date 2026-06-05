import { create } from 'zustand'
import { DEFAULT_THEME_ID } from '../themes'

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
}

export interface Settings {
  themeId: string
  editor: EditorSettings
  terminal: TerminalSettings
}

export const SETTINGS_DEFAULTS: Settings = {
  themeId: DEFAULT_THEME_ID,
  editor: EDITOR_DEFAULTS,
  terminal: TERMINAL_DEFAULTS,
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
  /** Replace the whole settings object (used when hydrating from the backend). */
  replaceAll: (s: Settings) => void
}

// Injected by the IPC layer once available, so this store has no hard Tauri
// dependency (keeps the frontend runnable in a plain browser for dev).
let backendSync: ((s: Settings) => void) | null = null
export function setSettingsBackendSync(fn: (s: Settings) => void): void {
  backendSync = fn
}

export const useSettings = create<SettingsState>((set, get) => {
  const snapshot = (): Settings => {
    const { themeId, editor, terminal } = get()
    return { themeId, editor, terminal }
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
    replaceAll: (s) => {
      set({ themeId: s.themeId, editor: s.editor, terminal: s.terminal })
      persistLocal(s)
    },
  }
})
