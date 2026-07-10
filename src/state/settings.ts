import { create } from 'zustand'
import { DEFAULT_THEME_ID, THEMES } from '../themes'
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
   * When true, every AI CLI launch appends the CLI's own auto-approve flag
   * (claude `--dangerously-skip-permissions`, codex
   * `--dangerously-bypass-approvals-and-sandbox`, gemini/qwen `--yolo`, aider
   * `--yes-always`). The ⇧D shortcut always adds Claude's regardless. Key name
   * kept for stored-settings compatibility.
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

export interface IdentitySettings {
  /** Opt-in: run `gh auth switch` for the selected repo's account on selection. */
  alignGhOnSelect: boolean
}

export const IDENTITY_DEFAULTS: IdentitySettings = {
  alignGhOnSelect: false,
}

export interface Settings {
  themeId: string
  /** When true, a new theme is auto-selected once per calendar day. */
  themeShuffle: boolean
  /** Local `YYYY-MM-DD` the shuffle last fired; guards to once per day. */
  lastShuffleDate: string | null
  editor: EditorSettings
  terminal: TerminalSettings
  identity: IdentitySettings
  /** User-imported themes; merged with the built-in presets at runtime. */
  customThemes: Theme[]
}

export const SETTINGS_DEFAULTS: Settings = {
  themeId: DEFAULT_THEME_ID,
  themeShuffle: false,
  lastShuffleDate: null,
  editor: EDITOR_DEFAULTS,
  terminal: TERMINAL_DEFAULTS,
  identity: IDENTITY_DEFAULTS,
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
      themeShuffle: parsed.themeShuffle ?? SETTINGS_DEFAULTS.themeShuffle,
      lastShuffleDate: parsed.lastShuffleDate ?? SETTINGS_DEFAULTS.lastShuffleDate,
      editor: { ...EDITOR_DEFAULTS, ...parsed.editor },
      terminal: { ...TERMINAL_DEFAULTS, ...parsed.terminal },
      identity: { ...IDENTITY_DEFAULTS, ...parsed.identity },
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
  /** Toggle daily theme shuffle. Enabling it applies a fresh theme immediately. */
  setThemeShuffle: (enabled: boolean) => void
  /**
   * Pick a new random theme if shuffle is on and it hasn't fired today. Cheap
   * and idempotent to call repeatedly (guarded by the stored date), so it can
   * run on launch and on a timer to catch a midnight rollover.
   */
  applyDailyShuffle: () => void
  updateEditor: (patch: Partial<EditorSettings>) => void
  updateTerminal: (patch: Partial<TerminalSettings>) => void
  updateIdentity: (patch: Partial<IdentitySettings>) => void
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

// Local calendar day as `YYYY-MM-DD`; the shuffle keys off the user's own day.
function localDateKey(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Every selectable theme id (built-in presets + imported custom themes).
function themePool(customThemes: Theme[]): string[] {
  return [...THEMES.map((t) => t.meta.id), ...customThemes.map((t) => t.meta.id)]
}

// A random theme id from the pool that isn't `current`; falls back to `current`
// when the pool has no alternative.
function pickDifferentTheme(current: string, customThemes: Theme[]): string {
  const options = themePool(customThemes).filter((id) => id !== current)
  if (options.length === 0) return current
  return options[Math.floor(Math.random() * options.length)]
}

// Injected by the IPC layer once available, so this store has no hard Tauri
// dependency (keeps the frontend runnable in a plain browser for dev).
let backendSync: ((s: Settings) => void) | null = null
export function setSettingsBackendSync(fn: (s: Settings) => void): void {
  backendSync = fn
}

export const useSettings = create<SettingsState>((set, get) => {
  const snapshot = (): Settings => {
    const { themeId, themeShuffle, lastShuffleDate, editor, terminal, identity, customThemes } = get()
    return { themeId, themeShuffle, lastShuffleDate, editor, terminal, identity, customThemes }
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
    setThemeShuffle: (enabled) => {
      if (enabled) {
        // Apply a fresh theme right away so the effect is immediate, and stamp
        // today so applyDailyShuffle waits until tomorrow to fire again.
        set((state) => ({
          themeShuffle: true,
          themeId: pickDifferentTheme(state.themeId, state.customThemes),
          lastShuffleDate: localDateKey(),
        }))
      } else {
        set({ themeShuffle: false })
      }
      commit()
    },
    applyDailyShuffle: () => {
      const { themeShuffle, lastShuffleDate } = get()
      const today = localDateKey()
      if (!themeShuffle || lastShuffleDate === today) return
      set((state) => ({
        themeId: pickDifferentTheme(state.themeId, state.customThemes),
        lastShuffleDate: today,
      }))
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
    updateIdentity: (patch) => {
      set((state) => ({ identity: { ...state.identity, ...patch } }))
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
        themeShuffle: s.themeShuffle ?? false,
        lastShuffleDate: s.lastShuffleDate ?? null,
        editor: s.editor,
        terminal: s.terminal,
        identity: s.identity ?? IDENTITY_DEFAULTS,
        customThemes: s.customThemes,
      })
      persistLocal(s)
    },
  }
})
