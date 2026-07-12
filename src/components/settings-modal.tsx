import { useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { useSettings } from '../state/settings'
import { useUpdater } from '../state/updater'
import { useActiveTheme, useThemeList } from '../themes/theme-provider'
import { parseThemeJson } from '../themes/validate'
import { listen } from '@tauri-apps/api/event'
import { QRCodeSVG } from 'qrcode.react'
import { ipc, isTauri, type RemoteMode } from '../lib/ipc'
import { AccountsSection } from './identity/accounts-section'
import { ProvidersSection } from './apikeys/providers-section'
import { ClaudeAccountsSection } from './claude-accounts/claude-accounts-section'
import { useUi } from '../state/ui'
import { useWsl } from '../state/wsl'
import { isWindows } from '../lib/platform'
import themeGuideMarkdown from '../../docs/theme-authoring.md?raw'

// Save text to a file, picking the right mechanism per platform. In the Tauri
// webview the <a download> trick is a no-op, so we go through a native save
// dialog + backend file write; on the web we use a Blob download link.
async function saveTextFile(
  filename: string,
  content: string,
  filter: { name: string; extension: string; mime: string },
) {
  if (isTauri) {
    const path = await save({
      defaultPath: filename,
      filters: [{ name: filter.name, extensions: [filter.extension] }],
    })
    if (!path) return // user cancelled
    await ipc.fs.exportText(path, content)
  } else {
    const blob = new Blob([content], { type: filter.mime })
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
}

type SettingsTabId = 'general' | 'ai' | 'github' | 'remote' | 'updates'

const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'github', label: 'GitHub' },
  { id: 'remote', label: 'Remote access' },
  { id: 'updates', label: 'Updates' },
]

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const themes = useThemeList()
  const themeId = useSettings((s) => s.themeId)
  const setThemeId = useSettings((s) => s.setThemeId)
  const addCustomTheme = useSettings((s) => s.addCustomTheme)
  const removeCustomTheme = useSettings((s) => s.removeCustomTheme)
  const activeTheme = useActiveTheme()
  const themeShuffle = useSettings((s) => s.themeShuffle)
  const setThemeShuffle = useSettings((s) => s.setThemeShuffle)
  const editor = useSettings((s) => s.editor)
  const updateEditor = useSettings((s) => s.updateEditor)
  const terminal = useSettings((s) => s.terminal)
  const updateTerminal = useSettings((s) => s.updateTerminal)
  const wslDistros = useWsl((s) => s.distros)

  useEffect(() => {
    void useWsl.getState().load()
  }, [])

  const fileRef = useRef<HTMLInputElement>(null)
  const [themeError, setThemeError] = useState<string | null>(null)

  const settingsTab = useUi((s) => s.settingsTab)
  const clearSettingsTab = useUi((s) => s.clearSettingsTab)
  const [tab, setTab] = useState<SettingsTabId>('general')

  useEffect(() => {
    if (open && settingsTab) {
      if (SETTINGS_TABS.some((t) => t.id === settingsTab)) setTab(settingsTab as SettingsTabId)
      clearSettingsTab()
    }
  }, [open, settingsTab, clearSettingsTab])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const activeIsCustom = themes.custom.some((t) => t.id === themeId)

  const exportTheme = async () => {
    const json = JSON.stringify(activeTheme, null, 2)
    const filename = `${activeTheme.meta.id.replace(/^custom:/, '')}.theme.json`
    try {
      await saveTextFile(filename, json, {
        name: 'Theme JSON',
        extension: 'json',
        mime: 'application/json',
      })
      setThemeError(null)
    } catch (err) {
      setThemeError(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const downloadThemeGuide = async () => {
    try {
      await saveTextFile('theme-authoring.md', themeGuideMarkdown, {
        name: 'Markdown',
        extension: 'md',
        mime: 'text/markdown',
      })
      setThemeError(null)
    } catch (err) {
      setThemeError(`Download failed: ${err instanceof Error ? err.message : String(err)}`)
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
    <div className="fixed inset-0 z-50 flex bg-background">
      <nav className="flex w-48 flex-shrink-0 flex-col gap-0.5 border-r border-border bg-surface p-3">
        <button
          type="button"
          onClick={onClose}
          title="Close settings (Esc)"
          className="mb-4 flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Settings
        </div>
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-left text-sm ${
              tab === t.id
                ? 'bg-foreground/10 font-medium text-foreground'
                : 'text-foreground/70 hover:bg-foreground/5 hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 pb-6 pt-14">
          {tab === 'general' && (
            <>
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
          <Row label="Surprise me daily">
            <Toggle checked={themeShuffle} onChange={setThemeShuffle} />
          </Row>
          <div className="text-xs text-muted">
            Automatically switch to a different theme once a day. Flip it on for an
            instant change.
          </div>
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
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void downloadThemeGuide()}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground/80 hover:bg-foreground/5"
            >
              Download theme guide…
            </button>
          </div>
          <div className="text-xs text-muted">
            Hand this Markdown spec to an LLM (ChatGPT, Claude, …) and ask it to generate a theme,
            then import the JSON it produces.
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
                {isWindows && (
                  <Row label="Default shell">
                    <select
                      value={terminal.defaultShell}
                      onChange={(e) => updateTerminal({ defaultShell: e.target.value })}
                      className="rounded-md border border-border bg-field-background px-2 py-1 text-foreground outline-none focus:border-accent"
                    >
                      <option value="">PowerShell (default)</option>
                      <option value="cmd.exe">Command Prompt</option>
                      {wslDistros.map((d) => (
                        <option key={d.name} value={`wsl:${d.name}`}>
                          {`WSL — ${d.name}${d.isDefault ? ' (default distro)' : ''}`}
                        </option>
                      ))}
                    </select>
                  </Row>
                )}
                <div className="text-xs text-muted">Startup command — run in every new terminal tab.</div>
                <textarea
                  value={terminal.startupCommand}
                  onChange={(e) => updateTerminal({ startupCommand: e.target.value })}
                  rows={2}
                  placeholder="e.g. source .venv/bin/activate"
                  className="mt-1 w-full resize-none rounded-md border border-border bg-field-background px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-accent"
                />
              </Section>
            </>
          )}

          {tab === 'ai' && (
            <>
              <Section title="Claude Code">
          <Row label="Always skip permissions">
            <Toggle
              checked={terminal.claudeSkipPermissions}
              onChange={(v) => updateTerminal({ claudeSkipPermissions: v })}
            />
          </Row>
          <div className="text-xs text-muted">
            Starts every AI CLI with its own auto-approve flag: Claude Code{' '}
            <code className="font-mono">--dangerously-skip-permissions</code>, Codex{' '}
            <code className="font-mono">--dangerously-bypass-approvals-and-sandbox</code>, Gemini
            and Qwen <code className="font-mono">--yolo</code>, aider{' '}
            <code className="font-mono">--yes-always</code>. The CLI will not ask for permission
            before running tools. Only enable this if you understand the risk.
          </div>
                <ClaudeHooksToggle />
              </Section>

              <ClaudeAccountsSection />

              <ProvidersSection />
            </>
          )}

          {tab === 'github' && <AccountsSection />}

          {tab === 'remote' && <RemoteAccessSection />}

          {tab === 'updates' && <UpdatesSection />}
        </div>
      </div>
    </div>
  )
}

function ClaudeHooksToggle() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri) return
    ipc.claude
      .hooksStatus()
      .then(setInstalled)
      .catch(() => setInstalled(null))
  }, [])

  const toggle = async (v: boolean) => {
    setError(null)
    try {
      if (v) await ipc.claude.hooksEnable()
      else await ipc.claude.hooksDisable()
      setInstalled(v)
    } catch (e) {
      setError(String(e))
    }
  }

  if (installed === null && !isTauri) return null

  return (
    <>
      <Row label="Attention hooks">
        <Toggle checked={installed ?? false} onChange={(v) => void toggle(v)} />
      </Row>
      <div className="text-xs text-muted">
        Adds Notification/Stop hooks to <code className="font-mono">~/.claude/settings.json</code>{' '}
        so the app knows exactly when Claude needs your permission, is waiting for input, or has
        finished — powering precise badges and phone notifications. Your existing hooks are left
        untouched. Hooks are also installed into any running WSL distro so Claude Code inside WSL
        reports too.
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </>
  )
}

const REMOTE_MODES: { id: RemoteMode; label: string; blurb: string }[] = [
  {
    id: 'cloudflare',
    label: 'Quick Start (Cloudflare)',
    blurb:
      'No account or setup needed. You get a temporary public link + QR each session. The link changes every time.',
  },
  {
    id: 'tailscale',
    label: 'Tailscale (advanced)',
    blurb:
      'Install the free Tailscale app on this PC and your phone once. Your address never changes and nothing is exposed to the public internet. Recommended for daily use.',
  },
  {
    id: 'local',
    label: 'This computer only',
    blurb:
      'Serves on localhost (127.0.0.1) — reachable only from a browser on this machine. Nothing is exposed to the network.',
  },
]

const DEFAULT_TAILSCALE_PORT = 8765

function RemoteAccessSection() {
  const [status, setStatus] = useState<import('../lib/ipc').RemoteStatus | null>(null)
  const [supported, setSupported] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<RemoteMode>('cloudflare')
  const [progress, setProgress] = useState<string | null>(null)
  const [tunnelDied, setTunnelDied] = useState(false)
  const [tsInfo, setTsInfo] = useState<import('../lib/ipc').TailscaleInfo | null>(null)
  const [tsChecked, setTsChecked] = useState(false)
  const [port, setPort] = useState(DEFAULT_TAILSCALE_PORT)
  const [bindAll, setBindAll] = useState(false)

  const refresh = () => {
    if (!isTauri) {
      setSupported(false)
      return
    }
    ipc.remote
      .status()
      .then((s) => {
        setStatus(s)
        setSupported(true)
        if (s.running && s.mode) setMode(s.mode)
      })
      .catch(() => setSupported(false))
  }

  useEffect(refresh, [])

  // Backend push events: cloudflared setup progress and tunnel death (R3.11).
  useEffect(() => {
    if (!isTauri) return
    const unlisten = [
      listen<string>('remote:cloudflared-progress', (e) => setProgress(e.payload)),
      listen('remote:tunnel-died', () => {
        setTunnelDied(true)
        setProgress(null)
      }),
      listen<string>('remote:auto-stopped', (e) => {
        setError(`Remote access stopped: ${e.payload}`)
        refresh()
      }),
    ]
    return () => {
      unlisten.forEach((p) => void p.then((off) => off()))
    }
  }, [])

  // Detect the tailnet address when the user picks Tailscale mode, so we can show
  // the reachable address or fall back to setup instructions (AC-3.8).
  useEffect(() => {
    if (!isTauri || mode !== 'tailscale' || (status?.running ?? false)) return
    let cancelled = false
    setTsChecked(false)
    ipc.remote
      .detectTailscale()
      .then((info) => {
        if (cancelled) return
        setTsInfo(info)
        setTsChecked(true)
      })
      .catch(() => {
        if (cancelled) return
        setTsInfo(null)
        setTsChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [mode, status?.running])

  if (!supported) {
    return (
      <Section title="Remote Access">
        <div className="text-xs text-muted">
          Not available in this build. Run with the <code className="font-mono">remote-access</code>{' '}
          feature to enable.
        </div>
      </Section>
    )
  }

  const running = status?.running ?? false

  const start = async (startMode: RemoteMode) => {
    setBusy(true)
    setError(null)
    setTunnelDied(false)
    setProgress(startMode === 'cloudflare' ? 'Setting up tunnel…' : null)
    try {
      // Tailscale uses a stable, user-chosen port; the others take any free port.
      const startPort = startMode === 'tailscale' ? port : undefined
      const startBindAll = startMode === 'tailscale' ? bindAll : false
      const info = await ipc.remote.start(startMode, startPort, startBindAll)
      setStatus({
        running: true,
        mode: info.mode,
        port: info.port,
        url: info.url,
        localUrl: info.localUrl,
        pairingCode: info.pairingCode,
        connectedSince: null,
        hint: info.hint,
      })
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      await ipc.remote.stop()
      setTunnelDied(false)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const restartTunnel = async () => {
    await ipc.remote.stop().catch(() => {})
    await start('cloudflare')
  }

  const regenerate = async () => {
    const code = await ipc.remote.regenerateCode().catch(() => null)
    if (code) setStatus((s) => (s ? { ...s, pairingCode: code } : s))
  }

  return (
    <Section title="Remote Access">
      <div className="text-xs text-muted">
        Control your terminals from a phone or another computer over the web.
      </div>

      {running ? (
        <div className="flex flex-col gap-2.5">
          {status?.mode !== 'local' && status?.url && !tunnelDied && (
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-white p-2">
                <QRCodeSVG value={status.url} size={132} marginSize={0} />
              </div>
              <div className="text-xs text-muted">
                Scan with your phone camera, then enter the pairing code below.
                {status?.mode === 'tailscale' && ' Your phone must be on the same tailnet.'}
              </div>
            </div>
          )}

          {tunnelDied && (
            <div className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
              <span>The Cloudflare tunnel disconnected.</span>
              <button
                type="button"
                onClick={() => void restartTunnel()}
                disabled={busy}
                className="ml-auto rounded border border-danger/50 px-2 py-0.5 font-medium hover:bg-danger/10 disabled:opacity-50"
              >
                Restart tunnel
              </button>
            </div>
          )}

          <Row label="URL">
            <span className="font-mono text-xs text-foreground/80 break-all">{status?.url}</span>
          </Row>
          {status?.hint && <div className="text-xs text-warning">{status.hint}</div>}
          {status?.mode === 'cloudflare' && status.localUrl && (
            <Row label="Local URL">
              <span className="font-mono text-xs text-muted">{status.localUrl}</span>
            </Row>
          )}
          <Row label="Pairing code">
            <span className="flex items-center gap-2">
              <span className="font-mono text-base tracking-widest text-foreground">
                {status?.pairingCode ?? '——————'}
              </span>
              <button
                type="button"
                onClick={() => void regenerate()}
                className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground/70 hover:bg-foreground/5"
              >
                New code
              </button>
            </span>
          </Row>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">
              {status?.connectedSince
                ? `Connected since ${new Date(status.connectedSince).toLocaleTimeString()}`
                : 'Waiting for a device to pair…'}
            </span>
            <button
              type="button"
              onClick={() => void stop()}
              disabled={busy}
              className="ml-auto rounded-md border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Stop Remote Access
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            {REMOTE_MODES.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer gap-2 rounded-md border px-2.5 py-2 text-xs ${
                  mode === m.id ? 'border-accent bg-accent/5' : 'border-border hover:bg-foreground/5'
                }`}
              >
                <input
                  type="radio"
                  name="remote-mode"
                  className="mt-0.5"
                  checked={mode === m.id}
                  onChange={() => setMode(m.id)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">{m.label}</span>
                  <span className="text-muted">{m.blurb}</span>
                </span>
              </label>
            ))}
          </div>

          {mode === 'tailscale' && (
            <TailscaleSetup
              info={tsInfo}
              checked={tsChecked}
              port={port}
              onPort={setPort}
              bindAll={bindAll}
              onBindAll={setBindAll}
            />
          )}

          <button
            type="button"
            onClick={() => void start(mode)}
            disabled={busy || (mode === 'tailscale' && (!tsChecked || !tsInfo))}
            className="self-start rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? progress ?? 'Starting…' : 'Start Remote Session'}
          </button>
        </div>
      )}
      {error && <div className="text-xs text-danger">{error}</div>}
    </Section>
  )
}

function TailscaleSetup({
  info,
  checked,
  port,
  onPort,
  bindAll,
  onBindAll,
}: {
  info: import('../lib/ipc').TailscaleInfo | null
  checked: boolean
  port: number
  onPort: (v: number) => void
  bindAll: boolean
  onBindAll: (v: boolean) => void
}) {
  if (!checked) {
    return <div className="text-xs text-muted">Checking for Tailscale…</div>
  }

  if (!info) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-foreground/5 px-2.5 py-2 text-xs">
        <div className="font-medium text-foreground">Tailscale isn’t set up yet</div>
        <ol className="ml-4 list-decimal text-muted [&>li]:mt-0.5">
          <li>
            Install Tailscale on this PC and your phone from{' '}
            <code className="font-mono">tailscale.com/download</code>.
          </li>
          <li>Sign in on both devices with the same account.</li>
          <li>Come back here and pick Tailscale again — your address will appear.</li>
        </ol>
      </div>
    )
  }

  const host = info.dnsName ?? info.ip
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-foreground/5 px-2.5 py-2 text-xs">
      <Row label="Tailnet address">
        <span className="font-mono text-foreground/80">{host}</span>
      </Row>
      {info.dnsName && (
        <Row label="IP">
          <span className="font-mono text-muted">{info.ip}</span>
        </Row>
      )}
      <Row label="Port">
        <input
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => onPort(Number(e.target.value) || DEFAULT_TAILSCALE_PORT)}
          className="w-24 rounded border border-border bg-transparent px-2 py-0.5 text-right font-mono text-foreground"
        />
      </Row>
      <label className="flex cursor-pointer items-start gap-2 text-muted">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={bindAll}
          onChange={(e) => onBindAll(e.target.checked)}
        />
        <span>
          Also expose on my local network (bind <code className="font-mono">0.0.0.0</code>).{' '}
          <span className="text-danger">
            Anyone on your Wi-Fi/LAN can then reach the pairing screen — only enable on a trusted
            network.
          </span>
        </span>
      </label>
      <div className="text-muted">
        Will serve at <span className="font-mono">http://{host}:{port}</span>.
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
