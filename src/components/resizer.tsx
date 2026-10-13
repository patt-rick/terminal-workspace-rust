import { useCallback, useRef } from 'react'

/**
 * The gap between two panels, draggable to resize the adjacent one.
 * `side` is where the panel sits relative to this handle: 'left' grows the
 * panel as you drag right, 'right' grows it as you drag left.
 */
export function Resizer({
  width,
  setWidth,
  side,
  label,
}: {
  width: number
  setWidth: (w: number) => void
  side: 'left' | 'right'
  label: string
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      drag.current = { startX: e.clientX, startWidth: width }
      e.currentTarget.setPointerCapture(e.pointerId)
      document.body.style.cursor = 'col-resize'
    },
    [width]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      const delta = e.clientX - d.startX
      setWidth(side === 'left' ? d.startWidth + delta : d.startWidth - delta)
    },
    [setWidth, side]
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.cursor = ''
  }, [])

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      style={{ width: 'var(--gap-panel)' }}
      className="group flex flex-shrink-0 cursor-col-resize justify-center"
    >
      <div className="h-full w-0.5 rounded-full transition-colors group-hover:bg-accent/40 group-active:bg-accent/60" />
    </div>
  )
}
