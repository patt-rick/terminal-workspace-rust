import { useClaudeAccounts } from '../../state/claude-accounts'
import { useApiKeys } from '../../state/apikeys'
import { useUi } from '../../state/ui'
import { formatAgo, sortAccounts } from '../../lib/claude-accounts'
import { AccountRow } from './account-row'

/**
 * The dropdown under the title-bar pill: login-account list, API-key row
 * (synthesized from Anthropic provider entries), and footer actions.
 * Rendered inside a fixed overlay owned by AccountPill.
 */
export function AccountsPopover() {
  const s = useClaudeAccounts()
  const apiKeys = useApiKeys((st) => st.keys)
  const openSettings = useUi((st) => st.openSettings)

  const anthropicKeys = apiKeys.filter((k) => k.provider === 'anthropic' && k.hasValue)
  const apiKeyActive = anthropicKeys.some((k) => k.enabled)
  const sorted = sortAccounts(s.accounts, s.activeAccountId)

  return (
    <div className="flex max-h-[70vh] w-80 flex-col overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-lg">
      <div className="mb-1.5 flex items-baseline gap-1.5 px-1">
        <span className="text-sm font-semibold text-foreground">Accounts</span>
        <span className="text-xs text-muted">({s.accounts.length})</span>
      </div>

      {s.accounts.length === 0 && (
        <div className="px-1 py-2 text-xs text-muted">
          No Claude accounts yet. Log in or import the account you're already using in the CLI.
        </div>
      )}

      <div className="flex flex-col gap-1">
        {sorted.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            usage={s.usage[a.id]}
            isActive={a.id === s.activeAccountId && !apiKeyActive}
            busy={s.busy || s.loggingIn}
            onSwitch={() => void s.switchTo(a.id)}
            onRemove={() => void s.remove(a.id)}
            onRelogin={() => void s.addViaOauth(a.email)}
          />
        ))}

        {anthropicKeys.map((k) => (
          <div
            key={k.id}
            className={`rounded-md border px-3 py-2 ${
              k.enabled ? 'border-l-2 border-accent bg-accent/5' : 'border-border'
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className={`truncate text-sm font-medium ${k.enabled ? 'text-accent' : 'text-foreground'}`}>
                  🔑 {k.label}
                </div>
                <div className="truncate text-xs text-muted">
                  API key · pay per token{k.enabled ? ' · overrides login for claude' : ''}
                </div>
              </div>
              {!k.enabled && (
                <button
                  type="button"
                  onClick={() => void s.switchToApiKey(k.id)}
                  disabled={s.busy || s.loggingIn}
                  title="Enable this key — claude will bill the API key instead of a subscription"
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
                >
                  ⇄ Switch
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {s.error && (
        <div className="mt-2 flex items-start gap-2 px-1 text-xs text-danger">
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button type="button" onClick={s.clearError} className="flex-shrink-0 hover:underline">
            ✕
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 border-t border-border px-1 pt-2 text-xs">
        {s.loggingIn ? (
          <span className="flex items-center gap-2 text-muted">
            Waiting for browser…
            <button
              type="button"
              onClick={() => void s.cancelLogin()}
              className="text-link hover:underline"
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void s.addViaOauth()}
              className="text-link hover:underline"
            >
              Log In
            </button>
            <button
              type="button"
              onClick={() => void s.importCli()}
              disabled={s.busy}
              title="Import the account already logged in via the claude CLI"
              className="text-link hover:underline disabled:opacity-50"
            >
              Import from CLI
            </button>
            <button
              type="button"
              onClick={() => openSettings('ai')}
              className="text-link hover:underline"
            >
              API Key
            </button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1 text-muted">
          {s.usageFetchedAt ? formatAgo(s.usageFetchedAt, Date.now()) : ''}
          <button
            type="button"
            onClick={() => void s.refreshUsage(true)}
            title="Refresh usage"
            className="hover:text-foreground"
          >
            ⟳
          </button>
        </span>
      </div>
    </div>
  )
}
