import { openUrl } from '@tauri-apps/plugin-opener'
import { ConfirmDialog } from './confirm-dialog'
import { confirmWslClaudeInstall, useWorkspace } from '../state/store'

const SETUP_URL = 'https://docs.claude.com/en/docs/claude-code/setup'

/**
 * Shown when a Claude Code launch targets a WSL distro that has no native
 * claude: on confirm the new terminal runs the official installer, then the
 * held-back launch command — visibly, like the provider install prompt.
 */
export function WslInstallPrompt() {
  const pending = useWorkspace((s) => s.pendingWslClaudeInstall)
  const cancel = useWorkspace((s) => s.clearPendingWslClaudeInstall)
  const distroLabel = pending ? pending.distro || 'the default WSL distro' : ''

  return (
    <ConfirmDialog
      open={!!pending}
      title={pending ? `Claude Code isn't installed in ${distroLabel}` : ''}
      message={
        pending && (
          <>
            A WSL distro needs its own Linux install of Claude Code — the Windows install can't
            run through WSL interop. Install it now? The new terminal will run the official
            installer and then start Claude; the first run will ask you to <code>/login</code>.
            Prefer to install it yourself? Follow the{' '}
            <button
              type="button"
              className="text-link underline"
              onClick={() => void openUrl(SETUP_URL)}
            >
              official install guide
            </button>
            , then launch again.
          </>
        )
      }
      confirmLabel="Install & launch"
      onConfirm={() => void confirmWslClaudeInstall()}
      onCancel={cancel}
    />
  )
}
