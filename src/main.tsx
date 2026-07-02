import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import { ThemeProvider } from './themes/theme-provider'
import { applyTheme, resolveTheme } from './themes'
import {
  EDITOR_DEFAULTS,
  readStoredSettings,
  setSettingsBackendSync,
  TERMINAL_DEFAULTS,
  useSettings,
  type Settings,
} from './state/settings'
import { ipc } from './lib/ipc'
import { initPlatform } from './lib/platform'
import './styles/globals.css'

// Paint the persisted theme before the first frame (no flash).
const stored = readStoredSettings()
applyTheme(resolveTheme(stored.themeId, stored.customThemes))

// Persist every settings change to the Rust settings.json (source of truth).
setSettingsBackendSync((s) => {
  void ipc.settings.set(s)
})

// Resolve platform details (Windows build for ConPTY) and reconcile settings
// with the backend's authoritative copy.
async function bootstrap(): Promise<void> {
  await initPlatform()
  try {
    const remote = (await ipc.settings.get()) as Settings | null
    if (remote && remote.themeId && remote.editor && remote.terminal) {
      // Deep-merge defaults so fields added in newer versions (absent from an
      // older on-disk settings.json) hydrate to their default rather than undefined.
      const merged: Settings = {
        ...remote,
        editor: { ...EDITOR_DEFAULTS, ...remote.editor },
        terminal: { ...TERMINAL_DEFAULTS, ...remote.terminal },
        customThemes: remote.customThemes ?? [],
      }
      useSettings.getState().replaceAll(merged)
      applyTheme(resolveTheme(merged.themeId, merged.customThemes))
    }
  } catch {
    // backend unavailable (plain browser dev) — localStorage settings stand
  }
}
void bootstrap()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
)
