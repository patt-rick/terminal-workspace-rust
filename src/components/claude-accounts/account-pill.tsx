import { useEffect, useState } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { useApiKeys } from '../../state/apikeys'
import { utilizationBarClass, worstUtilization } from '../../lib/claude-accounts'
import { AccountsPopover } from './accounts-popover'

/**
 * Title-bar pill: active Claude account (or "API Key" / "Log In") plus a
 * health dot colored by the active account's worst 5h/7d utilization.
 * Clicking toggles the accounts popover. The button is no-drag via the
 * .app-titlebar rule in globals.css (same mechanism as WindowControls).
 */
export function AccountPill() {
  const [open, setOpen] = useState(false)
  const accounts = useClaudeAccounts((s) => s.accounts)
  const activeAccountId = useClaudeAccounts((s) => s.activeAccountId)
  const usage = useClaudeAccounts((s) => s.usage)
  const startPolling = useClaudeAccounts((s) => s.startPolling)
  const stopPolling = useClaudeAccounts((s) => s.stopPolling)
  const apiKeysLoaded = useApiKeys((s) => s.loaded)
  const loadApiKeys = useApiKeys((s) => s.load)
  const apiKeys = useApiKeys((s) => s.keys)

  useEffect(() => {
    startPolling()
    if (!apiKeysLoaded) void loadApiKeys()
    return stopPolling
  }, [startPolling, stopPolling, apiKeysLoaded, loadApiKeys])

  const apiKeyActive = apiKeys.some((k) => k.provider === 'anthropic' && k.enabled && k.hasValue)
  const active = accounts.find((a) => a.id === activeAccountId)
  const label = apiKeyActive ? 'API Key' : active ? active.email : 'Log In'
  const worst = active && !apiKeyActive ? worstUtilization(usage[active.id]?.usage ?? null) : null

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Claude accounts"
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-[var(--title-bar-fg-dim)] hover:bg-foreground/5 hover:text-[var(--title-bar-fg)]"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            worst === null ? 'bg-foreground/30' : utilizationBarClass(worst)
          }`}
        />
        <span className="max-w-40 truncate">{label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-50">
            <AccountsPopover />
          </div>
        </>
      )}
    </div>
  )
}
