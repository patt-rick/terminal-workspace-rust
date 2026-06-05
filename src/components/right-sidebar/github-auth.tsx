import { useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ipc, type DeviceFlowStart, type GithubSettings } from '../../lib/ipc'

export function GithubAuth({
  settings,
  onChange,
}: {
  settings: GithubSettings
  onChange: (s: GithubSettings) => void
}) {
  const [token, setToken] = useState('')
  const [clientId, setClientId] = useState(settings.clientId ?? '')
  const [device, setDevice] = useState<DeviceFlowStart | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cancelled = useRef(false)

  const saveToken = async (): Promise<void> => {
    if (!token.trim()) return
    setBusy(true)
    setStatus(null)
    try {
      onChange(await ipc.github.setToken(token.trim()))
      setToken('')
    } catch (e) {
      setStatus(String(e))
    } finally {
      setBusy(false)
    }
  }

  const startDevice = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    cancelled.current = false
    try {
      await ipc.github.setClientId(clientId.trim() || null)
      const d = await ipc.github.deviceStart()
      setDevice(d)
      void openUrl(d.verificationUriComplete)
      const deadline = Date.now() + d.expiresIn * 1000
      let interval = d.interval
      const tick = async (): Promise<void> => {
        if (cancelled.current) return
        if (Date.now() > deadline) {
          setStatus('Code expired — try again')
          setBusy(false)
          setDevice(null)
          return
        }
        try {
          const r = await ipc.github.devicePoll(d.deviceCode)
          if (r.status === 'authorized') {
            setDevice(null)
            setBusy(false)
            onChange(await ipc.github.getSettings())
            return
          }
          if (r.status === 'error') {
            setStatus(r.description || r.error)
            setBusy(false)
            setDevice(null)
            return
          }
          if (r.status === 'slow-down') interval = r.interval
        } catch (e) {
          setStatus(String(e))
        }
        setTimeout(() => void tick(), interval * 1000)
      }
      setTimeout(() => void tick(), interval * 1000)
    } catch (e) {
      setStatus(String(e))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <div className="text-foreground/80">Connect GitHub to view PRs and Actions.</div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted">OAuth App client id (device flow)</label>
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Iv1.xxxxxxxx"
          className="rounded-md border border-border bg-field-background px-2 py-1.5 text-foreground outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={busy || !clientId.trim()}
          onClick={() => void startDevice()}
          className="mt-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {device ? 'Waiting for authorization…' : 'Sign in with browser'}
        </button>
        {device && (
          <div className="mt-1 rounded-md border border-border bg-overlay p-2 text-xs">
            Enter code <span className="font-mono font-bold text-accent">{device.userCode}</span> at{' '}
            <button
              type="button"
              onClick={() => void openUrl(device.verificationUri)}
              className="text-link underline"
            >
              {device.verificationUri}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted">Personal access token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_…"
          className="rounded-md border border-border bg-field-background px-2 py-1.5 text-foreground outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={busy || !token.trim()}
          onClick={() => void saveToken()}
          className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5 disabled:opacity-50"
        >
          Save token
        </button>
      </div>

      {status && <div className="text-xs text-danger">{status}</div>}
    </div>
  )
}
