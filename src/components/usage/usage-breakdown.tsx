import {
  formatPercent,
  formatTokens,
  formatUsd,
  type BreakdownRow,
  type UsageDimension,
} from '../../lib/usage'

export function UsageBreakdown({
  rows,
  dimension,
  filterKey,
  onDimension,
  onToggle,
}: {
  rows: BreakdownRow[]
  dimension: UsageDimension
  filterKey: string | null
  onDimension: (dimension: UsageDimension) => void
  onToggle: (key: string) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
        <div className="flex rounded-md border border-border text-xs">
          {(['model', 'project'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDimension(d)}
              className={`px-2.5 py-1 capitalize ${
                dimension === d ? 'bg-foreground/10 text-foreground' : 'text-muted hover:text-foreground'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        {filterKey !== null && (
          <button
            type="button"
            onClick={() => onToggle(filterKey)}
            className="text-xs text-link hover:underline"
          >
            Clear filter
          </button>
        )}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-2 text-left font-normal capitalize">{dimension}</th>
            <th className="py-2 pl-4 text-right font-normal">Cost</th>
            <th className="py-2 pl-4 text-right font-normal">Share</th>
            <th className="py-2 pl-4 text-right font-normal">Tokens</th>
            <th className="py-2 pl-4 text-right font-normal">Cache hit</th>
            <th className="py-2 pl-4 text-right font-normal">$ / 1M tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              onClick={() => onToggle(r.key)}
              className={`cursor-pointer border-b border-border/50 hover:bg-foreground/5 ${
                filterKey === r.key ? 'bg-accent/10' : ''
              }`}
            >
              <td className="max-w-0 truncate py-2 text-foreground" title={r.label}>
                {r.label}
              </td>
              <td className="py-2 pl-4 text-right text-foreground">
                {r.priced ? formatUsd(r.costUsd) : <span className="text-muted">Unpriced</span>}
              </td>
              <td className="py-2 pl-4 text-right text-muted">{formatPercent(r.share)}</td>
              <td className="py-2 pl-4 text-right text-foreground">{formatTokens(r.tokens)}</td>
              <td className="py-2 pl-4 text-right text-muted">{formatPercent(r.cacheHitRate)}</td>
              <td className="py-2 pl-4 text-right text-muted">
                {r.costPerMillion === null ? '—' : formatUsd(r.costPerMillion)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
