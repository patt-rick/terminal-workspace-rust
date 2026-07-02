import { useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useIdentity } from '../../state/identity'
import { useUi } from '../../state/ui'

/**
 * Account chooser for one or more repos. A single repo renders one radio group;
 * multiple unmapped repos (e.g. on project switch) are batched into one dialog
 * with a per-repo account selector, instead of N sequential popups.
 */
export function AccountPicker() {
  const repos = useIdentity((s) => s.pickerRepos)
  const accounts = useIdentity((s) => s.accounts)
  const close = useIdentity((s) => s.closePicker)
  const openSettings = useUi((s) => s.openSettings)
  const markApplied = useIdentity((s) => s.markApplied)

  // repoId -> chosen accountId
  const [choices, setChoices] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed choices with each repo's suggestion whenever the picker (re)opens.
  useEffect(() => {
    if (!repos) return
    const seeded: Record<string, string | null> = {}
    for (const r of repos) seeded[r.repoId] = r.suggestedId ?? accounts[0]?.id ?? null
    setChoices(seeded)
    setError(null)
  }, [repos, accounts])

  if (!repos) return null
  const multi = repos.length > 1

  const onApply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      for (const r of repos) {
        const accountId = choices[r.repoId]
        if (accountId) await ipc.identity.apply(r.repoId, accountId)
      }
      markApplied()
      close()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const anyChosen = repos.some((r) => choices[r.repoId])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="w-[26rem] rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">
          {multi ? `GitHub account for ${repos.length} repos` : 'Account for this repo'}
        </h2>

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
            <div className="max-h-72 space-y-3 overflow-auto">
              {repos.map((r) => (
                <div key={r.repoId}>
                  {multi && (
                    <div className="mb-1 truncate text-[11px] font-medium text-foreground/70">
                      {r.label}
                    </div>
                  )}
                  <div className="space-y-1">
                    {accounts.map((a) => (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/5"
                      >
                        <input
                          type="radio"
                          name={`repo-${r.repoId}`}
                          checked={choices[r.repoId] === a.id}
                          onChange={() => setChoices((c) => ({ ...c, [r.repoId]: a.id }))}
                        />
                        <span className="min-w-0">
                          <span className="text-sm font-medium">{a.label}</span>
                          <span className="ml-2 text-xs text-muted">{a.login}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
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
                  {multi ? 'Skip' : 'Cancel'}
                </button>
                <button
                  type="button"
                  disabled={!anyChosen || busy}
                  onClick={() => void onApply()}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Applying…' : multi ? 'Apply all' : 'Apply'}
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
