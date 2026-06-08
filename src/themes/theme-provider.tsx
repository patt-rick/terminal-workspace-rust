import { useLayoutEffect } from 'react'
import { applyTheme, resolveTheme, THEMES } from './index'
import { useSettings } from '../state/settings'

/**
 * Applies the selected theme to the document whenever it changes. Reading the
 * id from the settings store (which hydrates synchronously from localStorage)
 * means the correct theme is applied on the first effect tick — and a fallback
 * default is already inlined in globals.css so there is no flash beforehand.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeId = useSettings((s) => s.themeId)
  const customThemes = useSettings((s) => s.customThemes)

  useLayoutEffect(() => {
    applyTheme(resolveTheme(themeId, customThemes))
  }, [themeId, customThemes])

  return children
}

/** Built-in and custom theme metadata, grouped for the settings picker. */
export function useThemeList() {
  const customThemes = useSettings((s) => s.customThemes)
  return {
    builtin: THEMES.map((t) => t.meta),
    custom: customThemes.map((t) => t.meta),
  }
}

export function useActiveTheme() {
  const themeId = useSettings((s) => s.themeId)
  const customThemes = useSettings((s) => s.customThemes)
  return resolveTheme(themeId, customThemes)
}
