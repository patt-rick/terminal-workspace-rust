import { useEffect, useRef, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  trailing?: ReactNode
  separatorBefore?: boolean
}

const ITEM_H = 32
const MENU_W = 200

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Close on a pointer-down outside the menu (keep it open when the down is on
    // a menu item, so the item's click can run). Capture is fine now that we
    // check the target.
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const sepCount = items.filter((i) => i.separatorBefore).length
  const height = items.length * ITEM_H + sepCount * 9 + 8
  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8))

  return (
    <div
      ref={ref}
      style={{ left, top, width: MENU_W }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[60] rounded-lg border border-border bg-overlay py-1 text-sm shadow-xl"
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="my-1 h-px bg-border" />}
          <button
            type="button"
            onClick={() => {
              item.onClick()
              onClose()
            }}
            className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left hover:bg-foreground/10 ${
              item.danger ? 'text-danger' : 'text-foreground/90'
            }`}
          >
            <span>{item.label}</span>
            {item.trailing}
          </button>
        </div>
      ))}
    </div>
  )
}
