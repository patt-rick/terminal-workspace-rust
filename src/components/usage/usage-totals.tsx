import { formatTokens, formatUsd, type UsageTotals as Totals } from '../../lib/usage'
import { ShareBar } from './share-bar'

const ink = (percent: number): string =>
  `color-mix(in srgb, var(--foreground) ${percent}%, var(--background))`

const TYPE_COLORS = { input: ink(60), cacheRead: ink(30), cacheWrite: ink(78), output: ink(100) }

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-lg font-medium text-foreground">{value}</span>
    </div>
  )
}

export function UsageTotals({ totals }: { totals: Totals }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Estimated cost" value={formatUsd(totals.costUsd)} />
        <Stat label="Processed tokens" value={formatTokens(totals.processed)} />
        <Stat label="Cached input" value={formatTokens(totals.cachedInput)} />
        <Stat label="Uncached input" value={formatTokens(totals.uncachedInput)} />
        <Stat label="Output" value={formatTokens(totals.output)} />
        <Stat label="Cache savings" value={formatUsd(totals.cacheSavingsUsd)} />
        <Stat label="Responses" value={totals.responses.toLocaleString('en-US')} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ShareBar
          title="Tokens by type"
          format={formatTokens}
          segments={[
            { label: 'Input', value: totals.input, color: TYPE_COLORS.input },
            { label: 'Cache read', value: totals.cachedInput, color: TYPE_COLORS.cacheRead },
            { label: 'Cache write', value: totals.cacheWrite, color: TYPE_COLORS.cacheWrite },
            { label: 'Output', value: totals.output, color: TYPE_COLORS.output },
          ]}
        />
        <ShareBar
          title="Cost by type"
          format={formatUsd}
          segments={[
            { label: 'Input', value: totals.costByType.input, color: TYPE_COLORS.input },
            { label: 'Cache read', value: totals.costByType.cacheRead, color: TYPE_COLORS.cacheRead },
            { label: 'Cache write', value: totals.costByType.cacheWrite, color: TYPE_COLORS.cacheWrite },
            { label: 'Output', value: totals.costByType.output, color: TYPE_COLORS.output },
          ]}
        />
      </div>
    </section>
  )
}
