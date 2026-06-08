import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import { ThemeProvider } from './themes/theme-provider'
import { applyTheme, resolveTheme } from './themes'
import {
  readStoredSettings,
  setSettingsBackendSync,
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
      const merged: Settings = { ...remote, customThemes: remote.customThemes ?? [] }
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
