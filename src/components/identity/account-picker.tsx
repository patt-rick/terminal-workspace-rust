import { useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useIdentity } from '../../state/identity'
import { useUi } from '../../state/ui'

export function AccountPicker() {
  const projectId = useIdentity((s) => s.pickerProjectId)
  const suggestedId = useIdentity((s) => s.pickerSuggestedId)
  const accounts = useIdentity((s) => s.accounts)
  const close = useIdentity((s) => s.closePicker)
  const openSettings = useUi((s) => s.openSettings)
  const markApplied = useIdentity((s) => s.markApplied)

  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset selection whenever the picker (re)opens.
  useEffect(() => {
    if (projectId) {
      setSelected(suggestedId ?? accounts[0]?.id ?? null)
      setError(null)
    }
  }, [projectId, suggestedId, accounts])

  if (!projectId) return null

  const onApply = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      await ipc.identity.apply(projectId, selected)
      markApplied()
      close()
    } catch (e) {
      // Surface the failure instead of silently leaving the popup open.
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="w-[24rem] rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">Account for this repo</h2>

        {accounts.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">No accounts configured yet.</p>
            <button
              type="button"
              onClick={() => {
                close()
                openSettings()
              }}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              Add an account
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              {accounts.map((a) => (
                <label
                  key={a.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5"
                >
                  <input
                    type="radio"
                    checked={selected === a.id}
                    onChange={() => setSelected(a.id)}
                  />
                  <span className="min-w-0">
                    <span className="text-sm font-medium">{a.label}</span>
                    <span className="ml-2 text-xs text-muted">{a.login}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  close()
                  openSettings()
                }}
                className="text-xs text-link hover:underline"
              >
                Manage accounts…
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!selected || busy}
                  onClick={() => void onApply()}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
            {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}
