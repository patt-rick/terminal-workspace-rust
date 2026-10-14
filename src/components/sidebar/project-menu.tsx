import { useState, type ReactNode } from 'react'
import { ipc, type Project } from '../../lib/ipc'
import { isMac } from '../../lib/platform'
import { useWorkspace } from '../../state/store'
import { useUi } from '../../state/ui'
import { useProjectIcons } from '../../state/project-icons'
import { ConfirmDialog } from '../confirm-dialog'
import type { MenuItem } from '../context-menu'
import { useNewTerminalItems } from '../workspace/new-terminal-items'

/**
 * A project's menu, shared by its row in the open nav and its tile in the
 * rail. `dialogs` must be rendered by the caller: it holds the remove
 * confirmation.
 */
export function useProjectMenu(project: Project): { items: MenuItem[]; dialogs: ReactNode } {
  const newItems = useNewTerminalItems(project.id)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const index = useWorkspace((s) => s.projects.findIndex((p) => p.id === project.id))
  const count = useWorkspace((s) => s.projects.length)
  const moveProject = useWorkspace((s) => s.moveProject)

  const doRemove = (): void => {
    void ipc.projects.remove(project.id)
    useWorkspace.getState().removeProject(project.id)
    useProjectIcons.getState().remove(project.id)
    setConfirmRemove(false)
  }

  const items: MenuItem[] = [
    ...newItems,
    {
      label: 'Rename',
      separatorBefore: true,
      onClick: () => useUi.getState().requestRename(project.id),
    },
    { label: 'Colour and icon…', onClick: () => useUi.getState().openIconDialog(project.id) },
    {
      label: isMac ? 'Open in Finder' : 'Open in Explorer',
      onClick: () => void ipc.projects.openInFileManager(project.id),
    },
    { label: 'Open in Terminal', onClick: () => void ipc.projects.openInTerminal(project.id) },
    ...(index > 0
      ? [{ label: 'Move up', separatorBefore: true, onClick: () => moveProject(project.id, index - 1) }]
      : []),
    ...(index >= 0 && index < count - 1
      ? [{ label: 'Move down', separatorBefore: index === 0, onClick: () => moveProject(project.id, index + 2) }]
      : []),
    { label: 'Remove', danger: true, separatorBefore: true, onClick: () => setConfirmRemove(true) },
  ]

  const dialogs = (
    <ConfirmDialog
      open={confirmRemove}
      title="Remove project?"
      message={
        <>
          Remove <span className="font-medium text-foreground/90">{project.name}</span> from the
          workspace? This doesn’t delete any files on disk.
        </>
      }
      confirmLabel="Remove"
      danger
      onConfirm={doRemove}
      onCancel={() => setConfirmRemove(false)}
    />
  )

  return { items, dialogs }
}
