import { useEffect } from 'react'
import { useUpdater } from '../state/updater'

// Module scope survives component remounts and StrictMode's double-invoke, so
// the silent launch check fires exactly once per app open.
let launchChecked = false

/**
 * Mounted once at the app root. Runs a silent update check on launch and, when
 * an update is available (whether from that check or a manual one in Settings),
 * presents the install prompt. A silent check that finds nothing — or fails,
 * e.g. no published release yet — stays invisible; only `available`,
 * `downloading`, and post-prompt `error` states open the dialog.
 */
export function UpdateManager() {
  const status = useUpdater((s) => s.status)
  const info = useUpdater((s) => s.info)
  const progress = useUpdater((s) => s.progress)
  const error = useUpdater((s) => s.error)
  const runCheck = useUpdater((s) => s.check)
  const install = useUpdater((s) => s.install)
  const dismiss = useUpdater((s) => s.dismiss)

  useEffect(() => {
    if (launchChecked) return
    launchChecked = true
    void runCheck(false)
  }, [runCheck])

  const open = !!info && (status === 'available' || status === 'downloading' || status === 'error')
  if (!open || !info) return null

  const downloading = status === 'downloading'
  const failed = status === 'error'
  const pct = progress < 0 ? null : Math.round(progress * 100)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--backdrop)' }}
      onClick={downloading ? undefined : dismiss}
    >
      <div
        className="w-[400px] rounded-xl border border-border bg-overlay p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">
          Update available
        </div>
        <div className="mt-1 text-sm text-muted">
          Version <span className="font-medium text-foreground/90">{info.version}</span> is
          available — you have {info.currentVersion}.
        </div>

        {info.notes && (
          <div className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-field-background p-2.5 text-xs text-foreground/80">
            {info.notes}
          </div>
        )}

        {downloading && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/15">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: pct === null ? '100%' : `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-xs text-muted">
              {pct === null ? 'Downloading…' : `Downloading… ${pct}%`}
            </div>
          </div>
        )}

        {failed && error && (
          <div className="mt-3 text-xs text-danger">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            disabled={downloading}
            className="rounded-md px-3 py-1.5 text-sm text-foreground/80 hover:bg-foreground/10 disabled:opacity-40"
          >
            {failed ? 'Close' : 'Later'}
          </button>
          {!failed && (
            <button
              type="button"
              onClick={() => void install()}
              disabled={downloading}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-60"
            >
              {downloading ? 'Installing…' : 'Restart & install'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
