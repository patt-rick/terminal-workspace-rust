import { useEffect } from 'react'
import { ipc } from '../../lib/ipc'
import { useWorkspace } from '../../state/store'
import { useIdentity, type PickerRepo } from '../../state/identity'
import { useRepos } from '../../state/repos'
import { AccountPicker } from './account-picker'

/**
 * Watches the selected project and, for EVERY discovered repo in it, applies the
 * right GitHub account on open:
 * - `apply` -> set identity silently
 * - `ask`   -> collect for a single batched picker (not N popups)
 * - `none`  -> skip (no accounts, or not a git repo)
 * Also hosts the picker so any component can open it.
 */
export function IdentityAutoApply() {
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const loaded = useIdentity((s) => s.loaded)
  const load = useIdentity((s) => s.load)
  const openPicker = useIdentity((s) => s.openPicker)
  const markApplied = useIdentity((s) => s.markApplied)
  const loadRepos = useRepos((s) => s.load)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  useEffect(() => {
    if (!selectedProjectId) return
    const projectId = selectedProjectId
    let cancelled = false

    void (async () => {
      const repos = await loadRepos(projectId)
      if (cancelled || repos.length === 0) return
      const asks: PickerRepo[] = []
      for (const repo of repos) {
        try {
          const res = await ipc.identity.resolve(repo.id)
          if (cancelled) return
          if (res.kind === 'apply') {
            await ipc.identity.apply(repo.id, res.account.id)
            if (!cancelled) markApplied()
          } else if (res.kind === 'ask') {
            asks.push({
              repoId: repo.id,
              label: repo.relativePath || repo.name,
              suggestedId: res.suggestedAccountId,
            })
          }
        } catch {
          // resolve fails when the repo isn't a git repo; skip it.
        }
      }
      if (!cancelled && asks.length > 0) openPicker(asks)
    })()

    return () => {
      cancelled = true
    }
  }, [selectedProjectId, loadRepos, openPicker, markApplied])

  return <AccountPicker />
}
