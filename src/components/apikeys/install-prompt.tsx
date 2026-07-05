import { ConfirmDialog } from '../confirm-dialog'
import { useApiKeys } from '../../state/apikeys'

/**
 * Shown when a provider's CLI is missing from PATH: on confirm the new
 * terminal runs the installer, then the CLI, in sequence — visibly.
 */
export function InstallPrompt() {
  const pending = useApiKeys((s) => s.pendingInstall)
  const confirmInstall = useApiKeys((s) => s.confirmInstall)
  const cancel = useApiKeys((s) => s.cancelInstall)

  return (
    <ConfirmDialog
      open={!!pending}
      title={pending ? `${pending.binary} isn't installed` : ''}
      message={
        pending && (
          <>
            {pending.entry.label} launches <code>{pending.entry.launchCommand}</code>, but{' '}
            <code>{pending.binary}</code> wasn't found on your PATH. Install it now? The new
            terminal will run <code className="break-all">{pending.installCommand}</code> and
            then start the CLI. If the CLI still isn't found after installing, restart the app
            so it picks up the updated PATH.
          </>
        )
      }
      confirmLabel="Install & launch"
      onConfirm={() => void confirmInstall()}
      onCancel={cancel}
    />
  )
}
