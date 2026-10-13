export type SettingsTabId = 'general' | 'keyboard' | 'ai' | 'github' | 'remote' | 'updates'

export const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'ai', label: 'AI' },
  { id: 'github', label: 'GitHub' },
  { id: 'remote', label: 'Remote access' },
  { id: 'updates', label: 'Updates' },
]
