import { useEffect, useMemo, useRef, useState } from 'react'
import { ipc, isTauri } from '../../lib/ipc'
import { useUsage, type UsageView } from '../../state/usage'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { useSettings } from '../../state/settings'
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
import { UsagePrices } from './usage-prices'

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
    <div role="group" aria-label={label} className="flex h-full text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`relative flex h-full items-center px-3 font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
            value === o.id
              ? 'bg-background text-foreground'
              : 'text-foreground/60 hover:text-foreground'
          }`}
        >
          {o.label}
          {value === o.id && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent" />
          )}
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
  const overrides = useSettings((x) => x.usagePriceOverrides)
  const [editingPrice, setEditingPrice] = useState<string | null>(null)
  const customKeys = useMemo(() => new Set(Object.keys(overrides)), [overrides])
  const models = useMemo(() => [...new Set((summary?.buckets ?? []).map((b) => b.model))], [summary])

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
  const customCount = customKeys.size
  const customNote = customCount === 0 ? '' : `, ${customCount} custom price${customCount === 1 ? '' : 's'}`

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
        custom={customKeys}
        onSetPrice={setEditingPrice}
      />
      <UsagePrices
        models={models}
        editing={editingPrice}
        onEdit={setEditingPrice}
        tableStamp={summary.pricing.fetchedAt}
      />
      <footer className="flex flex-col gap-1 border-t border-border pt-3 text-[11px] text-muted">
        <span>
          Costs are estimates at list API rates, not your subscription bill ({priceNote}
          {customNote}).
        </span>
        {startsLate && (
          <span>
            History starts {new Date(summary.historyStartMs).toLocaleDateString()}. Claude Code
            deletes older transcripts; Terminal Workspace keeps what it has seen for 100 days.
          </span>
        )}
        {sums.unpricedTokens > 0 && (
          <span>{formatTokens(sums.unpricedTokens)} tokens are from models with no known rate. Set a price for them
            under Custom prices.
          </span>
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
      className="panel absolute inset-0 z-20 overflow-y-auto bg-background outline-none"
    >
      {/* A bar across the top of the panel, the height and style of the tab strips, that
          stays put when the page scrolls. The close button matches Settings. */}
      <header className="sticky top-0 z-10 grid h-10 grid-cols-[1fr_auto_1fr] items-stretch border-b border-border bg-surface px-2">
        <div className="flex items-center">
          <button
            type="button"
            onClick={closePage}
            title="Close usage (Esc)"
            aria-label="Close usage"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-border text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex items-stretch justify-center">
          <Segmented options={VIEWS} value={view} onChange={setView} label="Usage view" />
          {view !== 'limits' && (
            <>
              <span className="mx-2 my-2.5 w-px bg-border" />
              <Segmented
                options={PERIODS.map((p) => ({ id: p, label: p }))}
                value={period}
                onChange={setPeriod}
                label="Usage period"
              />
            </>
          )}
          <span className="mx-2 my-2.5 w-px bg-border" />
          <button
            type="button"
            onClick={() =>
              void (view === 'limits' ? useClaudeAccounts.getState().refreshUsage(true) : refresh())
            }
            disabled={loading}
            title={loading ? 'Refreshing…' : 'Refresh'}
            aria-label="Refresh"
            className="flex w-8 items-center justify-center text-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-60"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden>
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        </div>
      </header>
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-5">
        {view === 'limits' ? <UsageLimits /> : <History />}
      </div>
    </div>
  )
}
