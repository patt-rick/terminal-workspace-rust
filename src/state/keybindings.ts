import { useMemo } from 'react'
import {
  defaultKeybindings,
  effectiveKeybindings,
  shortcutLabel,
  type Keybinding,
  type KeybindingOverrides,
} from '../lib/keybindings'
import { isMac } from '../lib/platform'
import { useSettings } from './settings'

const DEFAULTS = defaultKeybindings(isMac)

let cached: { overrides: KeybindingOverrides; bindings: Keybinding[] } | null = null

export function platformDefaults(): Keybinding[] {
  return DEFAULTS
}

/** For event handlers: recomputed only when the stored overrides change. */
export function currentKeybindings(): Keybinding[] {
  const overrides = useSettings.getState().keybindingOverrides
  if (cached === null || cached.overrides !== overrides) {
    cached = { overrides, bindings: effectiveKeybindings(DEFAULTS, overrides) }
  }
  return cached.bindings
}

export function useKeybindings(): Keybinding[] {
  const overrides = useSettings((s) => s.keybindingOverrides)
  return useMemo(() => effectiveKeybindings(DEFAULTS, overrides), [overrides])
}

/** The label of a command's first shortcut, or '' when it has none. */
export function useShortcutLabel(command: string): string {
  const bindings = useKeybindings()
  return shortcutLabel(command, isMac, bindings) ?? ''
}
