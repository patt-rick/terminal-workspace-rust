import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onCancel,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null)

  // Take the keyboard: a dialog opened while a terminal has focus must not
  // leave Escape and Enter going to the program running there. Hand it back
  // on close unless something else has taken it since.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus()
    return () => {
      const now = document.activeElement
      if (now === null || now === document.body) previous?.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--backdrop)' }}
      onClick={onCancel}
    >
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-[360px] rounded-xl border border-border bg-overlay p-5 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onCancel()
        }}
      >
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-2 break-words text-sm text-muted">{message}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-foreground/80 hover:bg-foreground/10"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              danger ? 'bg-danger text-accent-foreground' : 'bg-accent text-accent-foreground'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
