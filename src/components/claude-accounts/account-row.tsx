import { useState } from 'react'
import type { ClaudeAccountMeta, ClaudeAccountUsage } from '../../lib/ipc'
import { formatPlanName } from '../../lib/claude-accounts'
import { MiniUsageBar } from './mini-usage-bar'

/**
 * One login account: email + plan, Switch/delete actions, 5h/7d usage bars.
 * The active row gets an accent left border and no Switch button. Delete is
 * two-click (first click arms, second confirms).
 */
export function AccountRow({
  account,
  usage,
  isActive,
  busy,
  onSwitch,
  onRemove,
  onRelogin,
}: {
  account: ClaudeAccountMeta
  usage: ClaudeAccountUsage | undefined
  isActive: boolean
  busy: boolean
  onSwitch: () => void
  onRemove: () => void
  onRelogin: () => void
}) {
  const [armedRemove, setArmedRemove] = useState(false)

  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        isActive ? 'border-l-2 border-accent bg-accent/5' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm font-medium ${isActive ? 'text-accent' : 'text-foreground'}`}>
            {account.email}
          </div>
          <div className="truncate text-xs text-muted">
            {formatPlanName(account.plan) || 'Claude account'}
            {account.displayName ? ` · ${account.displayName}` : ''}
          </div>
        </div>
        {account.refreshDead ? (
          <button
            type="button"
            onClick={onRelogin}
            disabled={busy}
            className="rounded border border-warning/50 px-2 py-1 text-xs text-warning hover:bg-warning/10 disabled:opacity-50"
          >
            Log in again
          </button>
        ) : (
          !isActive && (
            <button
              type="button"
              onClick={onSwitch}
              disabled={busy}
              title="Make this the account claude uses (writes ~/.claude credentials)"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
            >
              ⇄ Switch
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => {
            if (armedRemove) onRemove()
            else setArmedRemove(true)
          }}
          onBlur={() => setArmedRemove(false)}
          disabled={busy}
          title={armedRemove ? 'Click again to confirm' : 'Remove account from the app'}
          className={`rounded border px-2 py-1 text-xs disabled:opacity-50 ${
            armedRemove
              ? 'border-danger/60 bg-danger/10 text-danger'
              : 'border-border text-danger hover:bg-foreground/5'
          }`}
        >
          {armedRemove ? 'Sure?' : '🗑'}
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-4">
        <MiniUsageBar label="5h" bucket={usage?.usage?.fiveHour ?? null} />
        <MiniUsageBar label="7d" bucket={usage?.usage?.sevenDay ?? null} />
      </div>
      {usage?.error && <div className="mt-1 truncate text-xs text-danger">{usage.error}</div>}
    </div>
  )
}
