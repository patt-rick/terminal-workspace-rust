import { WindowControls } from './window-controls'
import { isTauri } from '../lib/ipc'
import appIcon from '../../src-tauri/icons/32x32.png'

// Full-width custom title bar for the frameless window (decorations: false).
// It spans the very top of the window above the three-column body, so the
// window controls sit in the window's true top-right corner — and the bar is
// themed to the app instead of the native (white) Windows caption. The whole
// bar is a drag region; the controls inside are no-drag (see globals.css).
export function TitleBar() {
  if (!isTauri) return null

  return (
    <header className="app-titlebar flex h-8 flex-shrink-0 select-none items-stretch justify-between border-b border-border bg-surface">
      <div className="flex items-center gap-2 pl-2.5 text-xs font-medium text-foreground/55">
        <img src={appIcon} alt="" className="h-4 w-4" />
        <span>Terminal Workspace</span>
      </div>
      <WindowControls />
    </header>
  )
}
