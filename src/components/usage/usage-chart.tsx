import { useState } from 'react'
import { OTHER_KEY, slotLabel, type UsagePeriod, type UsageSeries } from '../../lib/usage'

const WIDTH = 960
const HEIGHT = 220
const LEFT = 52
const BOTTOM = 22
const TOP = 8
const TICKS = 4

const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]
const OTHER_COLOR = 'var(--muted)'
const GRID_COLOR = 'color-mix(in srgb, var(--foreground) 14%, transparent)'
const MAX_BAR_WIDTH = 44

/**
 * Colours by entity, not by position: built once from the unfiltered ranking so
 * filtering to one row does not repaint it.
 */
export function seriesColors(keys: { key: string }[]): (key: string) => string {
  const byKey = new Map<string, string>()
  keys.forEach((k, i) => {
    if (k.key !== OTHER_KEY && i < SERIES_COLORS.length) byKey.set(k.key, SERIES_COLORS[i])
  })
  return (key) => byKey.get(key) ?? OTHER_COLOR
}

/** Stacked bars, one per slot. Hovering a bar swaps the legend to its values. */
export function UsageChart({
  data,
  boundaries,
  period,
  format,
  colorOf,
}: {
  colorOf: (key: string) => string
  data: UsageSeries
  boundaries: number[]
  period: UsagePeriod
  format: (value: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const slots = data.values.length
  const slotTotals = data.values.map((row) => row.reduce((a, b) => a + b, 0))
  const max = Math.max(...slotTotals, 0)
  const plotWidth = WIDTH - LEFT
  const plotHeight = HEIGHT - TOP - BOTTOM
  const step = slots > 0 ? plotWidth / slots : plotWidth
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(1, step * 0.72))
  const labelEvery = Math.max(1, Math.ceil(slots / 8))
  const legendValues = hover === null ? null : data.values[hover]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="w-24 text-foreground/80">
          {hover === null ? 'Total' : slotLabel(boundaries[hover], period)}
        </span>
        {data.keys.map((k, i) => (
          <span key={k.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: colorOf(k.key) }} />
            <span className="max-w-40 truncate">{k.label}</span>
            {legendValues && <span className="text-foreground/80">{format(legendValues[i])}</span>}
          </span>
        ))}
        {hover !== null && (
          <span className="ml-auto text-foreground/80">{format(slotTotals[hover])}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="Usage over time"
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: TICKS + 1 }, (_, i) => {
          const y = TOP + plotHeight - (plotHeight * i) / TICKS
          return (
            <g key={i}>
              <line x1={LEFT} x2={WIDTH} y1={y} y2={y} stroke={GRID_COLOR} strokeWidth={1} />
              <text x={LEFT - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
                {format((max * i) / TICKS)}
              </text>
            </g>
          )
        })}
        {data.values.map((row, slot) => {
          const x = LEFT + slot * step + (step - barWidth) / 2
          let y = TOP + plotHeight
          return (
            <g key={slot} opacity={hover === null || hover === slot ? 1 : 0.45}>
              {row.map((value, i) => {
                const h = max > 0 ? (value / max) * plotHeight : 0
                y -= h
                return h > 0 ? (
                  <rect
                    key={data.keys[i].key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={h}
                    fill={colorOf(data.keys[i].key)}
                    stroke="var(--background)"
                    strokeWidth={1.5}
                  />
                ) : null
              })}
              {slot % labelEvery === 0 && (
                <text
                  x={LEFT + slot * step + step / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted)"
                >
                  {slotLabel(boundaries[slot], period)}
                </text>
              )}
              <rect
                x={LEFT + slot * step}
                y={TOP}
                width={step}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHover(slot)}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
