import { WindowControls } from '../window-controls'
import { AccountPill } from '../claude-accounts/account-pill'
import { runCommand } from '../../commands/app-commands'
import { isTauri } from '../../lib/ipc'
import { keepFocus } from '../../lib/keep-focus'
import { withShortcut } from '../../lib/keybindings'
import { useNarrowWindow } from '../../lib/use-narrow-window'
import { useShortcutLabel } from '../../state/keybindings'
import { useWorkspace } from '../../state/store'
import appIcon from '../../../src-tauri/icons/64x64.png'

const BUTTON =
  'flex h-6 w-6 items-center justify-center rounded-md hover:bg-foreground/10 hover:text-[var(--title-bar-fg)] disabled:opacity-30'
// The two pane toggles are never dimmed, which would read as disabled. The
// icon's filled half says whether the pane is open.
const TOGGLE = 'text-[var(--title-bar-fg-dim)]'

/**
 * The one bar across the top of the frameless window. All of it is a drag
 * region; the controls inside are no-drag (see .app-titlebar in globals.css).
 * It renders outside Tauri too, because the app's own buttons live here.
 */
export function TopBar() {
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.selectedProjectId) ?? null)
  const sidebarCollapsed = useWorkspace((s) => s.sidebarCollapsed)
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar)
  const rightSidebarCollapsed = useWorkspace((s) => s.rightSidebarCollapsed)
  const toggleRightSidebar = useWorkspace((s) => s.toggleRightSidebar)
  const sidebarKey = useShortcutLabel('view.toggleSidebar')
  const rightSidebarKey = useShortcutLabel('view.toggleRightSidebar')
  const paletteKey = useShortcutLabel('palette.toggle')
  const narrow = useNarrowWindow()
  const listOpen = !sidebarCollapsed && !narrow
  const panelOpen = project !== null && !rightSidebarCollapsed

  return (
    <header
      className="app-titlebar grid h-9 flex-shrink-0 select-none grid-cols-[minmax(0,1fr)_minmax(0,460px)_minmax(max-content,1fr)] items-center gap-3"
      style={{ background: 'var(--gradient-title-bar, transparent)' }}
    >
      <div className="flex min-w-0 items-center gap-2 pl-2.5">
        <button
          type="button"
          onClick={toggleSidebar}
          disabled={narrow}
          title={
            narrow
              ? 'Widen the window to show the project list'
              : withShortcut(listOpen ? 'Collapse to project icons' : 'Expand project list', sidebarKey)
          }
          aria-pressed={listOpen}
          className={`${BUTTON} ${TOGGLE}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {listOpen && <rect x="3" y="3" width="6" height="18" fill="currentColor" stroke="none" opacity="0.4" />}
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <span className="flex min-w-0 items-center gap-1.5">
          <img src={appIcon} alt="" width={16} height={16} draggable={false} className="flex-shrink-0" />
          <span className="truncate text-xs font-medium text-[var(--title-bar-fg-faint)]">
            Terminal Workspace
          </span>
        </span>
      </div>

      <button
        type="button"
        {...keepFocus}
        onClick={() => runCommand('palette.toggle')}
        title="Search or run a command"
        className="flex h-6 min-w-0 items-center gap-2 rounded-lg bg-surface px-2.5 text-xs text-[var(--title-bar-fg-dim)] hover:text-[var(--title-bar-fg)]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        {project && (
          <span className="max-w-[40%] flex-shrink-0 truncate text-[var(--title-bar-fg)]">
            {project.name}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-left">
          {project ? '· ' : ''}Search or run a command
        </span>
        {paletteKey && <kbd className="flex-shrink-0 font-sans text-[11px]">{paletteKey}</kbd>}
      </button>

      <div className="flex h-full flex-shrink-0 items-stretch justify-end gap-2 pr-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggleRightSidebar}
            disabled={!project}
            title={
              project
                ? withShortcut(panelOpen ? 'Hide side panel' : 'Show side panel', rightSidebarKey)
                : 'Select a project first'
            }
            aria-pressed={panelOpen}
            className={`${BUTTON} ${TOGGLE}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {panelOpen && <rect x="15" y="3" width="6" height="18" fill="currentColor" stroke="none" opacity="0.4" />}
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>
        {isTauri && <AccountPill />}
        <WindowControls />
      </div>
    </header>
  )
}
