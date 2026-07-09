import { utilizationBarClass, formatResetsIn } from '../../lib/claude-accounts'
import type { ClaudeUsageBucket } from '../../lib/ipc'

/**
 * One labeled quota bar ("5h" / "7d"): fill width = utilization, color by
 * tier, reset countdown on the right. Renders a dimmed empty bar when the
 * bucket is unknown.
 */
export function MiniUsageBar({ label, bucket }: { label: string; bucket: ClaudeUsageBucket | null }) {
  const pct = bucket ? Math.max(0, Math.min(bucket.utilization, 100)) : 0
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted">
      <span className="w-4 flex-shrink-0">{label}</span>
      <div className="h-1.5 w-16 flex-shrink-0 overflow-hidden rounded-full bg-foreground/10">
        {bucket && (
          <div
            className={`h-full rounded-full ${utilizationBarClass(bucket.utilization)}`}
            style={{ width: `${pct}%` }}
            title={`${Math.round(bucket.utilization)}% used`}
          />
        )}
      </div>
      <span className="min-w-0 truncate">
        {bucket ? formatResetsIn(bucket.resetsAt, Date.now()) : '—'}
      </span>
    </div>
  )
}
