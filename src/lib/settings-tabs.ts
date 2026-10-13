export type SettingsTabId = 'general' | 'ai' | 'github' | 'remote' | 'updates'

export const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'github', label: 'GitHub' },
  { id: 'remote', label: 'Remote access' },
  { id: 'updates', label: 'Updates' },
]
