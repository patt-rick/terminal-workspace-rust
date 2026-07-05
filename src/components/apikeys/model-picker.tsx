import { useEffect } from 'react'
import { launchBlocker, presetById } from '../../lib/apikey-presets'
import { useApiKeys } from '../../state/apikeys'
import { useUi } from '../../state/ui'

/**
 * "Use other models" chooser: lists the saved provider entries and launches a
 * terminal (in the project the picker was opened for) running the selected
 * entry's launch command. Claude has its own dedicated flows; this is the
 * everything-else path.
 */
export function ModelPicker() {
  const projectId = useApiKeys((s) => s.launcherProjectId)
  const keys = useApiKeys((s) => s.keys)
  const loaded = useApiKeys((s) => s.loaded)
  const load = useApiKeys((s) => s.load)
  const close = useApiKeys((s) => s.closeLauncher)
  const requestLaunch = useApiKeys((s) => s.requestLaunch)
  const openSettings = useUi((s) => s.openSettings)

  useEffect(() => {
    if (projectId && !loaded) void load()
  }, [projectId, loaded, load])

  if (!projectId) return null

  const ready = keys.filter((k) => !launchBlocker(k))

  const onPick = async (id: string): Promise<void> => {
    const k = ready.find((entry) => entry.id === id)
    if (!k) return
    close()
    await requestLaunch(projectId, k)
  }

  const toSettings = (): void => {
    close()
    openSettings('ai')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="w-[26rem] rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">Use other models</h2>

        {ready.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              No providers are set up yet. Add a provider API key first.
            </p>
            <button
              type="button"
              onClick={toSettings}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              Open settings
            </button>
          </div>
        ) : (
          <>
            <div className="max-h-72 space-y-1 overflow-auto">
              {ready.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => void onPick(k.id)}
                  title={`Runs: ${k.launchCommand}`}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{k.label}</span>
                    <span className="ml-2 text-xs text-muted">
                      {presetById(k.provider)?.name ?? k.provider}
                    </span>
                    <span className="block truncate text-xs text-muted">{k.launchCommand}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={toSettings}
                className="text-xs text-link hover:underline"
              >
                Manage models…
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
