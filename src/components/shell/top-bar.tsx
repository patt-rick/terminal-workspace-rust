import { WindowControls } from '../window-controls'
import { AccountPill } from '../claude-accounts/account-pill'
import { runCommand } from '../../commands/app-commands'
import { isTauri } from '../../lib/ipc'
import { keepFocus } from '../../lib/keep-focus'
import { withShortcut } from '../../lib/keybindings'
import { useNarrowWindow } from '../../lib/use-narrow-window'
import { useShortcutLabel } from '../../state/keybindings'
import { useWorkspace } from '../../state/store'
import { useUi } from '../../state/ui'
import { useUsage } from '../../state/usage'
import appIcon from '../../../src-tauri/icons/32x32.png'

const BUTTON =
  'flex h-6 w-6 items-center justify-center rounded-md hover:bg-foreground/10 hover:text-[var(--title-bar-fg)] disabled:opacity-30'
const ON = 'text-[var(--title-bar-fg)]'
const OFF = 'text-[var(--title-bar-fg-faint)]'
// The two pane toggles: never dimmed like OFF, which reads as disabled. The
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
  const openSettings = useUi((s) => s.openSettings)
  const usageOpen = useUsage((s) => s.open)
  const toggleUsage = useUsage((s) => s.togglePage)
  const sidebarKey = useShortcutLabel('view.toggleSidebar')
  const rightSidebarKey = useShortcutLabel('view.toggleRightSidebar')
  const usageKey = useShortcutLabel('view.usage')
  const settingsKey = useShortcutLabel('view.settings')
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
        <img src={appIcon} alt="" className="h-4 w-4 flex-shrink-0" />
        <span className="truncate text-xs font-medium text-[var(--title-bar-fg-faint)]">
          Terminal Workspace
        </span>
      </div>

      <button
        type="button"
        {...keepFocus}
        onClick={() => runCommand('palette.toggle')}
        title="Search or run a command"
        className="flex h-6 min-w-0 items-center gap-2 rounded-md border px-2.5 text-xs text-[var(--title-bar-fg-dim)] hover:text-[var(--title-bar-fg)]"
        style={{
          borderColor: 'var(--panel-outline)',
          background: 'color-mix(in srgb, var(--surface) 70%, transparent)',
        }}
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
            onClick={toggleUsage}
            title={withShortcut('Usage', usageKey)}
            className={`${BUTTON} ${usageOpen ? ON : OFF}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="6" y1="20" x2="6" y2="12" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="18" y1="20" x2="18" y2="9" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => openSettings()}
            title={withShortcut('Settings', settingsKey)}
            className={`${BUTTON} ${OFF}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
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
