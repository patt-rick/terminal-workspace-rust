import { useEffect, useRef, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  trailing?: ReactNode
  separatorBefore?: boolean
}

const ITEM_H = 32
const MENU_W = 240

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

  // Hold the keyboard while open, so keys do not reach a terminal behind the
  // menu, and hand it back on close unless something else has taken it since
  // (a dialog, or the rename field a menu item opened).
  useEffect(() => {
    const menu = ref.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    menu?.focus()
    return () => {
      const now = document.activeElement
      if (now === null || now === document.body || menu?.contains(now)) previous?.focus()
    }
  }, [])

  useEffect(() => {
    // Close on a pointer-down outside the menu (keep it open when the down is on
    // a menu item, so the item's click can run). Capture is fine now that we
    // check the target.
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // Captured and stopped: a menu opened from a control that leaves focus in
    // the terminal must not pass its Escape on to the program running there.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
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
      role="menu"
      tabIndex={-1}
      style={{ left, top, width: MENU_W }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
        if (step === 0 && e.key !== 'Home' && e.key !== 'End') return
        e.preventDefault()
        const buttons = Array.from(e.currentTarget.querySelectorAll('button'))
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const last = buttons.length - 1
        const next =
          e.key === 'Home' ? 0 : e.key === 'End' ? last : at < 0 ? (step > 0 ? 0 : last) : (at + step + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}
      className="fixed z-[60] rounded-lg border border-border bg-overlay py-1 text-sm shadow-xl outline-none"
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              item.onClick()
              onClose()
            }}
            className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left outline-none hover:bg-foreground/10 focus-visible:bg-foreground/10 ${
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
