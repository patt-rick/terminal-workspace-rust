import { useEffect } from 'react'
import { ipc } from '../../lib/ipc'
import { useWorkspace } from '../../state/store'
import { useIdentity } from '../../state/identity'
import { AccountPicker } from './account-picker'
import { AccountsModal } from './accounts-modal'

/**
 * Watches the selected project and applies the right GitHub account on open:
 * - `apply`  -> set identity silently
 * - `ask`    -> open the picker (suggestion preselected)
 * - `none`   -> do nothing (no accounts, or not a git repo)
 * Also hosts the picker and accounts modal so any component can open them.
 */
export function IdentityAutoApply() {
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const loaded = useIdentity((s) => s.loaded)
  const load = useIdentity((s) => s.load)
  const openPicker = useIdentity((s) => s.openPicker)
  const markApplied = useIdentity((s) => s.markApplied)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  useEffect(() => {
    if (!selectedProjectId) return
    let cancelled = false
    void ipc.identity
      .resolve(selectedProjectId)
      .then((res) => {
        if (cancelled) return
        if (res.kind === 'apply') {
          void ipc.identity.apply(selectedProjectId, res.account.id).then(() => {
            if (!cancelled) markApplied()
          })
        } else if (res.kind === 'ask') {
          openPicker(selectedProjectId, res.suggestedAccountId)
        }
      })
      .catch(() => {
        // resolve fails when the project isn't a git repo; ignore.
      })
    return () => {
      cancelled = true
    }
  }, [selectedProjectId, openPicker, markApplied])

  return (
    <>
      <AccountPicker />
      <AccountsModal />
    </>
  )
}
