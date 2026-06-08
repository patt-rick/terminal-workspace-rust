import { useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { useSettings } from '../state/settings'
import { useUpdater } from '../state/updater'
import { useActiveTheme, useThemeList } from '../themes/theme-provider'
import { parseThemeJson } from '../themes/validate'
import { ipc, isTauri } from '../lib/ipc'
import { AccountsSection } from './identity/accounts-section'

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const themes = useThemeList()
  const themeId = useSettings((s) => s.themeId)
  const setThemeId = useSettings((s) => s.setThemeId)
  const addCustomTheme = useSettings((s) => s.addCustomTheme)
  const removeCustomTheme = useSettings((s) => s.removeCustomTheme)
  const activeTheme = useActiveTheme()
  const editor = useSettings((s) => s.editor)
  const updateEditor = useSettings((s) => s.updateEditor)
  const terminal = useSettings((s) => s.terminal)
  const updateTerminal = useSettings((s) => s.updateTerminal)

  const fileRef = useRef<HTMLInputElement>(null)
  const [themeError, setThemeError] = useState<string | null>(null)

  const activeIsCustom = themes.custom.some((t) => t.id === themeId)

  const exportTheme = async () => {
    const json = JSON.stringify(activeTheme, null, 2)
    const filename = `${activeTheme.meta.id.replace(/^custom:/, '')}.theme.json`
    try {
      if (isTauri) {
        // The WebView2 <a download> mechanism is a no-op in the Tauri webview,
        // so saving goes through a native save dialog + backend file write.
        const path = await save({
          defaultPath: filename,
          filters: [{ name: 'Theme JSON', extensions: ['json'] }],
        })
        if (!path) return // user cancelled
        await ipc.fs.exportText(path, json)
      } else {
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        // Revoke after the click is processed, not synchronously (which can
        // abort the download).
        setTimeout(() => URL.revokeObjectURL(url), 0)
      }
      setThemeError(null)
    } catch (err) {
      setThemeError(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const importTheme = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-importing the same filename
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = parseThemeJson(String(reader.result))
      if (!result.ok) {
        setThemeError(result.error)
        return
      }
      const stored = addCustomTheme(result.theme)
      setThemeId(stored.meta.id)
      setThemeError(null)
    }
    reader.onerror = () => setThemeError('Could not read the selected file.')
    reader.readAsText(file)
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--backdrop)' }}
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-[480px] overflow-auto rounded-xl border border-border bg-overlay p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Settings</div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <Section title="Appearance">
          <Row label="Theme">
            <select
              value={themeId}
              onChange={(e) => setThemeId(e.target.value)}
              className="rounded-md border border-border bg-field-background px-2 py-1 text-foreground outline-none focus:border-accent"
            >
              <optgroup label="Built-in">
                {themes.builtin.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
              {themes.custom.length > 0 && (
                <optgroup label="Custom">
                  {themes.custom.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Row>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void exportTheme()}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/80 hover:bg-foreground/5"
            >
              Export…
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/80 hover:bg-foreground/5"
            >
              Import…
            </button>
            <button
              type="button"
              onClick={() => removeCustomTheme(themeId)}
              disabled={!activeIsCustom}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Delete
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={importTheme}
              className="hidden"
            />
          </div>
          <div className="text-xs text-muted">
            Export the active theme, edit the JSON, then import it back.
          </div>
          {themeError && <div className="text-xs text-danger">{themeError}</div>}
        </Section>

        <Section title="Editor">
          <Row label="Font size">
            <input
              type="number"
              min={9}
              max={28}
              value={editor.fontSize}
              onChange={(e) => updateEditor({ fontSize: Number(e.target.value) || 13 })}
              className="w-20 rounded-md border border-border bg-field-background px-2 py-1 text-foreground outline-none focus:border-accent"
            />
          </Row>
          <Row label="Tab size">
            <input
              type="number"
              min={1}
              max={8}
              value={editor.tabSize}
              onChange={(e) => updateEditor({ tabSize: Number(e.target.value) || 2 })}
              className="w-20 rounded-md border border-border bg-field-background px-2 py-1 text-foreground outline-none focus:border-accent"
            />
          </Row>
          <Row label="Word wrap">
            <Toggle checked={editor.wordWrap} onChange={(v) => updateEditor({ wordWrap: v })} />
          </Row>
          <Row label="Line numbers">
            <Toggle checked={editor.lineNumbers} onChange={(v) => updateEditor({ lineNumbers: v })} />
          </Row>
        </Section>

        <Section title="Terminal">
          <div className="text-xs text-muted">Startup command — run in every new terminal tab.</div>
          <textarea
            value={terminal.startupCommand}
            onChange={(e) => updateTerminal({ startupCommand: e.target.value })}
            rows={2}
            placeholder="e.g. source .venv/bin/activate"
            className="mt-1 w-full resize-none rounded-md border border-border bg-field-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent"
          />
        </Section>

        <AccountsSection />

        <UpdatesSection />
      </div>
    </div>
  )
}

function UpdatesSection() {
  const [version, setVersion] = useState<string | null>(null)
  const status = useUpdater((s) => s.status)
  const error = useUpdater((s) => s.error)
  const runCheck = useUpdater((s) => s.check)

  useEffect(() => {
    if (isTauri) ipc.app.version().then(setVersion).catch(() => {})
  }, [])

  const checking = status === 'checking'

  return (
    <Section title="Updates">
      <Row label="Current version">
        <span className="text-foreground/60">{version ?? '—'}</span>
      </Row>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void runCheck(true)}
          disabled={checking}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/80 hover:bg-foreground/5 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        {status === 'upToDate' && (
          <span className="text-xs text-muted">You're on the latest version.</span>
        )}
        {status === 'available' && (
          <span className="text-xs text-muted">Update available.</span>
        )}
        {status === 'error' && error && (
          <span className="text-xs text-danger">{error}</span>
        )}
      </div>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-foreground/80">{label}</span>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-foreground/20'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
          checked ? 'left-0.5 translate-x-4' : 'left-0.5'
        }`}
      />
    </button>
  )
}
