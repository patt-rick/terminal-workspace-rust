import { openUrl } from '@tauri-apps/plugin-opener'
import { ConfirmDialog } from '../confirm-dialog'
import { checkTarget } from '../../lib/apikey-presets'
import { useApiKeys } from '../../state/apikeys'

/**
 * Shown when a provider's CLI fails its presence check: on confirm the new
 * terminal runs the installer, then the CLI, in sequence — visibly.
 */
export function InstallPrompt() {
  const pending = useApiKeys((s) => s.pendingInstall)
  const confirmInstall = useApiKeys((s) => s.confirmInstall)
  const cancel = useApiKeys((s) => s.cancelInstall)
  const target = pending ? checkTarget(pending.check) : ''

  return (
    <ConfirmDialog
      open={!!pending}
      title={pending ? `${target} isn't installed` : ''}
      message={
        pending && (
          <>
            {pending.entry.label} launches <code>{pending.entry.launchCommand}</code>, but{' '}
            {pending.check.kind === 'binary' ? (
              <>
                <code>{target}</code> wasn't found on your PATH.
              </>
            ) : (
              <>
                the <code>{target}</code> Python package isn't installed.
              </>
            )}{' '}
            Install it now? The new terminal will run{' '}
            <code className="break-all">{pending.installCommand}</code> and then start the CLI.
            {pending.check.kind === 'binary' &&
              " If the CLI still isn't found after installing, restart the app so it picks up the updated PATH."}
            {pending.installUrl && (
              <>
                {' '}
                Prefer to install it yourself? Follow the{' '}
                <button
                  type="button"
                  className="text-link underline"
                  onClick={() => void openUrl(pending.installUrl!)}
                >
                  official install guide
                </button>
                , then launch again.
              </>
            )}
          </>
        )
      }
      confirmLabel="Install & launch"
      onConfirm={() => void confirmInstall()}
      onCancel={cancel}
    />
  )
}
