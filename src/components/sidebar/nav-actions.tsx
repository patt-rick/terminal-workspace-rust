import type { ReactNode } from 'react'
import { withShortcut } from '../../lib/keybindings'
import { useShortcutLabel } from '../../state/keybindings'
import { useUi } from '../../state/ui'
import { useUsage } from '../../state/usage'

const BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-md hover:bg-foreground/10 hover:text-foreground'

/**
 * Usage and Settings, at the foot of the left nav in both of its states: icons
 * in the rail, labelled rows in the open nav.
 */
export function NavActions({ vertical }: { vertical: boolean }) {
  const usageOpen = useUsage((s) => s.open)
  const toggleUsage = useUsage((s) => s.togglePage)
  const settingsOpen = useUi((s) => s.settingsOpen)
  const openSettings = useUi((s) => s.openSettings)
  const usageKey = useShortcutLabel('view.usage')
  const settingsKey = useShortcutLabel('view.settings')

  if (!vertical) {
    return (
      <div className="flex w-full flex-shrink-0 flex-col gap-0.5 border-t border-border pt-2">
        <NavRow icon={<UsageIcon />} label="Usage" shortcut={usageKey} active={usageOpen} onClick={toggleUsage} />
        <NavRow
          icon={<SettingsIcon />}
          label="Settings"
          shortcut={settingsKey}
          active={settingsOpen}
          onClick={() => openSettings()}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        onClick={toggleUsage}
        title={withShortcut('Usage', usageKey)}
        aria-pressed={usageOpen}
        className={`${BUTTON} ${usageOpen ? 'text-foreground' : 'text-foreground/55'}`}
      >
        <UsageIcon />
      </button>
      <button
        type="button"
        onClick={() => openSettings()}
        title={withShortcut('Settings', settingsKey)}
        className={`${BUTTON} ${settingsOpen ? 'text-foreground' : 'text-foreground/55'}`}
      >
        <SettingsIcon />
      </button>
    </div>
  )
}

function NavRow({
  icon,
  label,
  shortcut,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  shortcut: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
        active
          ? 'bg-foreground/10 text-foreground'
          : 'text-foreground/70 hover:bg-foreground/5 hover:text-foreground'
      }`}
    >
      <span className="flex w-[22px] flex-shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && <span className="flex-shrink-0 text-[11px] text-muted">{shortcut}</span>}
    </button>
  )
}

function UsageIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="6" y1="20" x2="6" y2="12" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="18" y1="20" x2="18" y2="9" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="4" y1="7" x2="14" y2="7" />
      <line x1="18" y1="7" x2="20" y2="7" />
      <line x1="4" y1="17" x2="8" y2="17" />
      <line x1="12" y1="17" x2="20" y2="17" />
      <line x1="14" y1="4" x2="14" y2="10" />
      <line x1="8" y1="14" x2="8" y2="20" />
    </svg>
  )
}
