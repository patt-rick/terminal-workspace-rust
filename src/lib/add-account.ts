import type { UnlistenFn } from '@tauri-apps/api/event'
import { ipc } from './ipc'
import { notify } from './notify'
import { createProjectTerminal, useWorkspace } from '../state/store'
import { useUi } from '../state/ui'
import { useIdentity } from '../state/identity'

/**
 * Authenticate a new GitHub account the way `gh auth login` does: open a terminal
 * running the real interactive flow, then import the account once it exits. The
 * Settings modal is closed so the terminal is usable. Returns an error message
 * when the flow could not be started, otherwise null.
 */
export async function addAccountViaGhAuth(): Promise<string | null> {
  const projectId = useWorkspace.getState().selectedProjectId
  if (!projectId) return 'Open a project first to run gh auth login.'

  useUi.getState().closeSettings()
  const record = await createProjectTerminal(projectId, {
    startupCommand: 'gh auth login',
    name: 'gh auth login',
  })
  if (!record) return 'Could not open a terminal.'

  let unlisten: UnlistenFn | null = null
  unlisten = await ipc.terminals.onExit(async (p) => {
    if (p.id !== record.id) return
    unlisten?.()
    try {
      const { added } = await useIdentity.getState().importGhAccounts()
      await notify(
        'GitHub',
        added.length > 0 ? `Added account: ${added.join(', ')}` : 'No new account was added.'
      )
    } catch (e) {
      await notify('GitHub', `Could not import account: ${String(e)}`)
    }
  })
  return null
}
