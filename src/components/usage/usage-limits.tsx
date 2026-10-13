import { useEffect } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import {
  formatPlanName,
  formatResetsIn,
  sortAccounts,
  utilizationBarClass,
} from '../../lib/claude-accounts'
import { formatUsd, pooledWindow } from '../../lib/usage'
import type { ClaudeAccountMeta, ClaudeAccountUsage } from '../../lib/ipc'

const WINDOWS = [
  { id: 'fiveHour', title: '5-hour window' },
  { id: 'sevenDay', title: '7-day window' },
] as const

function PooledCard({
  title,
  window,
  accounts,
  usages,
}: {
  title: string
  window: 'fiveHour' | 'sevenDay'
  accounts: ClaudeAccountMeta[]
  usages: ClaudeAccountUsage[]
}) {
  const now = Date.now()
  const pooled = pooledWindow(usages, window, now)
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.email ?? id
  const count = pooled.accounts.length

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {pooled.nextReset && (
          <span className="text-xs text-muted">
            Next reset in {formatResetsIn(pooled.nextReset.resetsAt, now)} ({nameOf(pooled.nextReset.accountId)})
            restores {Math.round(pooled.nextReset.restores)}%
          </span>
        )}
      </div>
      {pooled.meanRemaining === null ? (
        <div className="text-xs text-muted">No account reports this window.</div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-medium text-foreground">
              {Math.round(pooled.meanRemaining)}% left
            </span>
            {count > 1 && <span className="text-xs text-muted">average across {count} accounts</span>}
          </div>
          <div className="flex h-2.5 w-full gap-1">
            {pooled.accounts.map((a) => (
              <div
                key={a.accountId}
                className="h-full flex-1 overflow-hidden rounded-full bg-foreground/10"
                title={`${nameOf(a.accountId)}: ${Math.round(a.remaining)}% left`}
              >
                <div
                  className={`h-full rounded-full ${utilizationBarClass(a.utilization)}`}
                  style={{ width: `${a.remaining}%` }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

export function UsageLimits() {
  const accounts = useClaudeAccounts((s) => s.accounts)
  const activeAccountId = useClaudeAccounts((s) => s.activeAccountId)
  const usage = useClaudeAccounts((s) => s.usage)
  const refreshUsage = useClaudeAccounts((s) => s.refreshUsage)
  const addViaOauth = useClaudeAccounts((s) => s.addViaOauth)
  const loggingIn = useClaudeAccounts((s) => s.loggingIn)

  useEffect(() => {
    void refreshUsage(false).catch(() => {})
  }, [refreshUsage])

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-8 text-sm text-muted">
        <span>No Claude accounts yet. Log in to see subscription limits.</span>
        <button
          type="button"
          onClick={() => void addViaOauth()}
          disabled={loggingIn}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-foreground/5 disabled:opacity-50"
        >
          {loggingIn ? 'Waiting for browser…' : 'Log In'}
        </button>
      </div>
    )
  }

  const sorted = sortAccounts(accounts, activeAccountId)
  const usages = sorted.map((a) => usage[a.id]).filter((u): u is ClaudeAccountUsage => !!u)
  const now = Date.now()

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {WINDOWS.map((w) => (
          <PooledCard key={w.id} title={w.title} window={w.id} accounts={sorted} usages={usages} />
        ))}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-2 text-left font-normal">Account</th>
            <th className="py-2 pl-4 text-left font-normal">Plan</th>
            <th className="py-2 pl-4 text-right font-normal">5-hour used</th>
            <th className="py-2 pl-4 text-right font-normal">Resets in</th>
            <th className="py-2 pl-4 text-right font-normal">7-day used</th>
            <th className="py-2 pl-4 text-right font-normal">Resets in</th>
            <th className="py-2 pl-4 text-right font-normal">Extra usage</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => {
            const u = usage[a.id]
            const five = u?.usage?.fiveHour ?? null
            const seven = u?.usage?.sevenDay ?? null
            const extra = u?.usage?.extraUsage ?? null
            return (
              <tr key={a.id} className="border-b border-border/50">
                <td className="py-2 text-foreground">
                  {a.email}
                  {u?.error && <div className="text-danger">{u.error}</div>}
                </td>
                <td className="py-2 pl-4 text-muted">{formatPlanName(a.plan) || '—'}</td>
                <td className="py-2 pl-4 text-right text-foreground">
                  {five ? `${Math.round(five.utilization)}%` : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-muted">
                  {five ? formatResetsIn(five.resetsAt, now) || '—' : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-foreground">
                  {seven ? `${Math.round(seven.utilization)}%` : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-muted">
                  {seven ? formatResetsIn(seven.resetsAt, now) || '—' : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-muted">
                  {extra?.isEnabled && extra.usedCredits !== null && extra.monthlyLimit !== null
                    ? `${formatUsd(extra.usedCredits)} / ${formatUsd(extra.monthlyLimit)}`
                    : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
