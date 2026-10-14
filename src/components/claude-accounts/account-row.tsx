import { useState } from 'react'
import type { ClaudeAccountMeta, ClaudeAccountUsage } from '../../lib/ipc'
import { formatPlanName } from '../../lib/claude-accounts'
import { MiniUsageBar } from './mini-usage-bar'

/**
 * One login account: email + plan, Switch/delete actions, 5h/7d usage bars.
 * The active row gets an accent border, an "Active" badge and no Switch
 * button. A dead refresh token adds "Log in again" alongside Switch —
 * switching to a stale account is still allowed. Delete is two-click (first
 * arms, second confirms).
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
      className={`rounded-lg border px-3 py-2.5 ${
        isActive ? 'border-accent/50 bg-accent/5' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{account.email}</span>
            {isActive && <ActiveBadge />}
          </div>
          <div className="truncate text-xs text-muted">
            {formatPlanName(account.plan) || 'Claude account'}
            {account.displayName ? ` · ${account.displayName}` : ''}
          </div>
        </div>
        {account.refreshDead && (
          <button
            type="button"
            onClick={onRelogin}
            disabled={busy}
            className={`${ROW_BUTTON} border-warning/50 text-warning hover:bg-warning/10`}
          >
            Log in again
          </button>
        )}
        {!isActive && (
          <button
            type="button"
            onClick={onSwitch}
            disabled={busy}
            title="Make this the account claude uses (writes ~/.claude credentials)"
            className={`${ROW_BUTTON} border-border text-foreground/85 hover:bg-foreground/10 hover:text-foreground`}
          >
            Switch
          </button>
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
          aria-label={armedRemove ? 'Confirm remove' : 'Remove account'}
          className={
            armedRemove
              ? `${ROW_BUTTON} border-danger/60 bg-danger/10 text-danger`
              : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/45 outline-none hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50'
          }
        >
          {armedRemove ? 'Remove?' : <TrashIcon />}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-4">
        <MiniUsageBar label="5h" bucket={usage?.usage?.fiveHour ?? null} />
        <MiniUsageBar label="7d" bucket={usage?.usage?.sevenDay ?? null} />
      </div>
      {usage?.error && <div className="mt-1 truncate text-xs text-danger">{usage.error}</div>}
    </div>
  )
}

const ROW_BUTTON =
  'flex h-7 shrink-0 items-center rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50'

export function ActiveBadge() {
  return (
    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-accent">
      Active
    </span>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
    </svg>
  )
}
