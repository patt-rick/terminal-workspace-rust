import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '../lib/ipc'

// Custom window controls for the frameless window (decorations: false). The
// native frame is off so the title bar matches the theme; these replace the
// OS minimize/maximize/close buttons. Buttons sit in the .app-titlebar drag
// region but are themselves no-drag (handled by globals.css).
export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    const win = getCurrentWindow()
    void win.isMaximized().then(setMaximized)
    const unlisten = win.onResized(() => {
      void win.isMaximized().then(setMaximized)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  if (!isTauri) return null

  const win = getCurrentWindow()

  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => void win.minimize()}
        title="Minimize"
        aria-label="Minimize"
        className="flex w-[46px] items-center justify-center text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <line x1="0" y1="5" x2="10" y2="5" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => void win.toggleMaximize()}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        className="flex w-[46px] items-center justify-center text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="2.5" width="7" height="7" />
            <path d="M2.5 2.5V0.5h7v7h-2" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={() => void win.close()}
        title="Close"
        aria-label="Close"
        className="flex w-[46px] items-center justify-center text-foreground/70 transition-colors hover:bg-[#e81123] hover:text-white"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  )
}
