export interface ShareSegment {
  label: string
  value: number
  color: string
}

/** One horizontal bar split by share, with a legend of the non-zero parts. */
export function ShareBar({
  title,
  segments,
  format,
}: {
  title: string
  segments: ShareSegment[]
  format: (value: number) => string
}) {
  const shown = segments.filter((s) => s.value > 0)
  const sum = shown.reduce((acc, s) => acc + s.value, 0)
  if (sum <= 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-muted">{title}</div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full">
        {shown.map((s) => (
          <div
            key={s.label}
            style={{ width: `${(s.value / sum) * 100}%`, background: s.color }}
            title={`${s.label}: ${format(s.value)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {shown.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="text-foreground/80">{format(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
