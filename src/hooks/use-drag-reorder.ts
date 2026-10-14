import { useCallback, useEffect, useRef, useState } from 'react'
import { isNoopSlot, slotAt } from '../lib/reorder'

const THRESHOLD_PX = 4
const EDGE_SCROLL_PX = 28

export interface DragState {
  id: string
  /** where a drop would land; null when it would leave the order unchanged */
  slot: number | null
}

/**
 * Pointer-driven reordering of a vertical list. Not HTML5 drag and drop: in
 * the Tauri webview the native file-drop handler swallows those events on
 * Windows. A press becomes a drag only after it moves a few pixels, so a
 * plain click still clicks; the click that ends a drag is swallowed.
 *
 * Items are found in the container by `data-reorder-id`, in DOM order.
 */
export function useDragReorder(onDrop: (id: string, slot: number) => void) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || cleanupRef.current) return
    const interactive = (e.target as HTMLElement).closest('button, input, textarea')
    if (interactive && interactive !== e.currentTarget) return

    const startX = e.clientX
    const startY = e.clientY
    const pointerId = e.pointerId
    let active = false
    let slot: number | null = null

    const items = (): HTMLElement[] =>
      Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? [])

    const track = (y: number): void => {
      const els = items()
      const from = els.findIndex((el) => el.dataset.reorderId === id)
      const mids = els.map((el) => {
        const r = el.getBoundingClientRect()
        return r.top + r.height / 2
      })
      const s = slotAt(mids, y)
      slot = from < 0 || isNoopSlot(from, s) ? null : s
      setDrag({ id, slot })
    }

    const autoScroll = (y: number): void => {
      const box = containerRef.current
      if (!box) return
      const r = box.getBoundingClientRect()
      if (y < r.top + EDGE_SCROLL_PX) box.scrollTop -= 8
      else if (y > r.bottom - EDGE_SCROLL_PX) box.scrollTop += 8
    }

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD_PX) return
        active = true
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
        window.getSelection()?.removeAllRanges()
      }
      ev.preventDefault()
      autoScroll(ev.clientY)
      track(ev.clientY)
    }

    const swallowClick = (ev: MouseEvent): void => {
      ev.stopPropagation()
      ev.preventDefault()
    }

    const finish = (commit: boolean): void => {
      cleanup()
      if (!active) return
      window.getSelection()?.removeAllRanges()
      // The click that ends a drag fires after pointerup; stop it selecting or toggling.
      window.addEventListener('click', swallowClick, true)
      window.setTimeout(() => window.removeEventListener('click', swallowClick, true), 0)
      if (commit && slot !== null) onDropRef.current(id, slot)
    }

    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish(true)
    }
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) finish(false)
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      if (active) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      cleanupRef.current = null
      setDrag(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    cleanupRef.current = cleanup
  }, [])

  return { containerRef, drag, onPointerDown }
}
