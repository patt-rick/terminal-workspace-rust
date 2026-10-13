import { useEffect, useMemo, useRef } from 'react'
import { ipc, isTauri } from '../../lib/ipc'
import { useUsage, type UsageView } from '../../state/usage'
import { useClaudeAccounts } from '../../state/claude-accounts'
import {
  breakdown,
  filterBuckets,
  formatTokens,
  formatUsd,
  makeGroups,
  series,
  totals,
  type UsagePeriod,
} from '../../lib/usage'
import { UsageChart, seriesColors } from './usage-chart'
import { UsageTotals } from './usage-totals'
import { UsageBreakdown } from './usage-breakdown'
import { UsageLimits } from './usage-limits'

const VIEWS: { id: UsageView; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'limits', label: 'Limits' },
]
const PERIODS: UsagePeriod[] = ['24h', '7d', '30d', '90d']

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md border border-border text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`px-2.5 py-1 ${
            value === o.id ? 'bg-foreground/10 text-foreground' : 'text-muted hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function History() {
  const s = useUsage()
  const metric = s.view === 'tokens' ? 'tokens' : 'cost'
  const format = metric === 'cost' ? formatUsd : formatTokens
  const summary = s.summary

  const groups = useMemo(
    () => makeGroups(s.dimension, summary?.projects ?? []),
    [s.dimension, summary]
  )
  const rows = useMemo(
    () => breakdown(summary?.buckets ?? [], groups, metric),
    [summary, groups, metric]
  )
  const visible = useMemo(
    () => filterBuckets(summary?.buckets ?? [], groups, s.filterKey),
    [summary, groups, s.filterKey]
  )
  const slots = Math.max(0, s.boundaries.length - 1)
  const chart = useMemo(() => series(visible, slots, groups, metric), [visible, slots, groups, metric])
  const sums = useMemo(() => totals(visible), [visible])
  const colorOf = useMemo(
    () => seriesColors(series(summary?.buckets ?? [], slots, groups, metric).keys),
    [summary, slots, groups, metric]
  )

  if (s.error) {
    return (
      <div className="flex flex-col items-start gap-3 py-8 text-sm">
        <span className="text-danger">{s.error}</span>
        <button
          type="button"
          onClick={() => void s.load(true)}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-foreground/5"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!summary) {
    return (
      <div className="py-8 text-sm text-muted">
        Reading Claude Code history…
        {s.progress && ` ${s.progress.done} of ${s.progress.total} files`}
      </div>
    )
  }
  if (summary.historyStartMs === null) {
    return (
      <div className="py-8 text-sm text-muted">
        No Claude Code usage found in <code>~/.claude/projects</code>.
      </div>
    )
  }

  const startsLate = s.boundaries.length > 0 && summary.historyStartMs > s.boundaries[0]
  const troubled = (s.scan?.sources ?? []).filter((x) => x.status !== 'ok')
  const priceNote =
    summary.pricing.tier === 'bundled'
      ? 'rates bundled with the app'
      : `rates fetched ${new Date(summary.pricing.fetchedAt ?? 0).toLocaleDateString()}${
          summary.pricing.tier === 'stale' ? ' (could not refresh)' : ''
        }`

  return (
    <div className={`flex flex-col gap-6 ${s.loading ? 'opacity-60' : ''}`}>
      <UsageChart data={chart} boundaries={s.boundaries} period={s.loadedPeriod} format={format} colorOf={colorOf} />
      <UsageTotals totals={sums} />
      <UsageBreakdown
        rows={rows}
        dimension={s.dimension}
        filterKey={s.filterKey}
        onDimension={s.setDimension}
        onToggle={s.toggleFilter}
      />
      <footer className="flex flex-col gap-1 border-t border-border pt-3 text-[11px] text-muted">
        <span>
          Costs are estimates at list API rates, not your subscription bill ({priceNote}).
        </span>
        {startsLate && (
          <span>
            History starts {new Date(summary.historyStartMs).toLocaleDateString()}. Claude Code
            deletes older transcripts; Terminal Workspace keeps what it has seen for 100 days.
          </span>
        )}
        {sums.unpricedTokens > 0 && (
          <span>{formatTokens(sums.unpricedTokens)} tokens are from models with no known rate.</span>
        )}
        {troubled.map((x) => (
          <span key={x.label}>
            {x.label}: {x.status === 'missing' ? 'no Claude Code history found' : `${x.skipped} files could not be read`}.
          </span>
        ))}
      </footer>
    </div>
  )
}

/**
 * Full-pane layer over the terminals. It takes keyboard focus while open so
 * typing and Esc cannot reach an agent hidden underneath.
 */
export function UsagePage() {
  const view = useUsage((s) => s.view)
  const period = useUsage((s) => s.period)
  const loading = useUsage((s) => s.loading)
  const setView = useUsage((s) => s.setView)
  const setPeriod = useUsage((s) => s.setPeriod)
  const refresh = useUsage((s) => s.refresh)
  const closePage = useUsage((s) => s.closePage)
  const setProgress = useUsage((s) => s.setProgress)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.focus()
  }, [])

  useEffect(() => {
    if (!isTauri) return
    const unlisten = ipc.usage.onScanProgress(setProgress)
    return () => {
      void unlisten.then((off) => off())
    }
  }, [setProgress])

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          closePage()
        }
      }}
      className="absolute inset-0 z-20 overflow-y-auto bg-background outline-none"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-5">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-medium text-foreground">Usage</h1>
          <Segmented options={VIEWS} value={view} onChange={setView} label="Usage view" />
          {view !== 'limits' && (
            <Segmented
              options={PERIODS.map((p) => ({ id: p, label: p }))}
              value={period}
              onChange={setPeriod}
              label="Usage period"
            />
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() =>
              void (view === 'limits'
                ? useClaudeAccounts.getState().refreshUsage(true)
                : refresh())
            }
            disabled={loading}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={closePage}
            title="Close (Esc)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            ✕
          </button>
        </header>
        {view === 'limits' ? <UsageLimits /> : <History />}
      </div>
    </div>
  )
}
