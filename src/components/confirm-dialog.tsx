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
        className="w-[400px] rounded-xl border border-border bg-overlay p-5 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onCancel()
        }}
      >
        <div className="flex gap-3.5">
          <span
            className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
              danger ? 'bg-danger/15 text-danger' : 'bg-accent/15 text-accent'
            }`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {danger ? (
                <>
                  <path d="M12 3.5 2.5 20h19z" />
                  <line x1="12" y1="10" x2="12" y2="14.5" />
                  <line x1="12" y1="17.3" x2="12" y2="17.4" />
                </>
              ) : (
                <>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" />
                  <line x1="12" y1="16.8" x2="12" y2="16.9" />
                </>
              )}
            </svg>
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="text-sm font-semibold text-foreground">{title}</div>
            <div className="mt-1.5 break-words text-[13px] leading-relaxed text-foreground/65">
              {message}
            </div>
          </div>
        </div>
        <div className="-mx-5 -mb-5 mt-5 flex justify-end gap-2 rounded-b-xl border-t border-border bg-foreground/5 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 items-center rounded-lg border border-border px-3.5 text-[13px] text-foreground/85 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex h-8 items-center rounded-lg px-3.5 text-[13px] font-semibold text-accent-foreground shadow-sm outline-none ring-offset-2 ring-offset-overlay hover:brightness-110 focus-visible:ring-2 focus-visible:ring-focus ${
              danger ? 'bg-danger' : 'bg-accent'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
