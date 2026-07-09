import { useEffect } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { sortAccounts } from '../../lib/claude-accounts'
import { AccountRow } from './account-row'

/**
 * Claude account management inside Settings → AI. Same rows as the popover;
 * management-oriented copy. Switching writes ~/.claude/.credentials.json so
 * the account applies to claude everywhere.
 */
export function ClaudeAccountsSection() {
  const s = useClaudeAccounts()

  useEffect(() => {
    if (!s.loaded) void s.load()
    // usage is nice-to-have here; fetch once if the pill hasn't polled yet
    if (s.usageFetchedAt === null && s.accounts.length > 0) void s.refreshUsage(false)
  }, [s.loaded, s.accounts.length, s.usageFetchedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = sortAccounts(s.accounts, s.activeAccountId)

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          Claude accounts
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void s.importCli()}
            disabled={s.busy || s.loggingIn}
            title="Import the account already logged in via the claude CLI"
            className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
          >
            Import from CLI
          </button>
          <button
            type="button"
            onClick={() => void s.addViaOauth()}
            disabled={s.loggingIn}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {s.loggingIn ? 'Waiting for browser…' : '+ Log in with claude.ai'}
          </button>
        </div>
      </div>

      <p className="mb-2 text-xs text-muted">
        Switching writes <code className="font-mono">~/.claude/.credentials.json</code>, so the
        selected account applies to <code className="font-mono">claude</code> everywhere — new
        terminals here and outside the app. Sessions already running keep their old account.
      </p>

      {s.loggingIn && (
        <div className="mb-2 text-xs text-muted">
          Complete the sign-in in your browser.{' '}
          <button type="button" onClick={() => void s.cancelLogin()} className="text-link hover:underline">
            Cancel
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {s.accounts.length === 0 && (
          <div className="py-1 text-xs text-muted">No accounts yet.</div>
        )}
        {sorted.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            usage={s.usage[a.id]}
            isActive={a.id === s.activeAccountId}
            busy={s.busy || s.loggingIn}
            onSwitch={() => void s.switchTo(a.id)}
            onRemove={() => void s.remove(a.id)}
            onRelogin={() => void s.addViaOauth(a.email)}
          />
        ))}
      </div>

      {s.error && <div className="mt-2 text-xs text-danger">{s.error}</div>}
    </div>
  )
}
