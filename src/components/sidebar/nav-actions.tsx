import { withShortcut } from '../../lib/keybindings'
import { useShortcutLabel } from '../../state/keybindings'
import { useUi } from '../../state/ui'
import { useUsage } from '../../state/usage'

const BUTTON =
  'flex h-7 w-7 items-center justify-center rounded-md hover:bg-foreground/10 hover:text-foreground'

/** Usage and Settings, at the foot of the left nav in both of its states. */
export function NavActions({ vertical }: { vertical: boolean }) {
  const usageOpen = useUsage((s) => s.open)
  const toggleUsage = useUsage((s) => s.togglePage)
  const openSettings = useUi((s) => s.openSettings)
  const usageKey = useShortcutLabel('view.usage')
  const settingsKey = useShortcutLabel('view.settings')

  return (
    <div className={`flex flex-shrink-0 items-center gap-1 ${vertical ? 'flex-col' : ''}`}>
      <button
        type="button"
        onClick={toggleUsage}
        title={withShortcut('Usage', usageKey)}
        aria-pressed={usageOpen}
        className={`${BUTTON} ${usageOpen ? 'text-foreground' : 'text-foreground/55'}`}
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
        className={`${BUTTON} text-foreground/55`}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="4" y1="7" x2="14" y2="7" />
          <line x1="18" y1="7" x2="20" y2="7" />
          <line x1="4" y1="17" x2="8" y2="17" />
          <line x1="12" y1="17" x2="20" y2="17" />
          <line x1="14" y1="4" x2="14" y2="10" />
          <line x1="8" y1="14" x2="8" y2="20" />
        </svg>
      </button>
    </div>
  )
}
