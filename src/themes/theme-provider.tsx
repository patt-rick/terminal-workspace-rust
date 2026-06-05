import { useLayoutEffect } from 'react'
import { applyTheme, getTheme, THEMES } from './index'
import { useSettings } from '../state/settings'

/**
 * Applies the selected theme to the document whenever it changes. Reading the
 * id from the settings store (which hydrates synchronously from localStorage)
 * means the correct theme is applied on the first effect tick — and a fallback
 * default is already inlined in globals.css so there is no flash beforehand.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeId = useSettings((s) => s.themeId)

  useLayoutEffect(() => {
    applyTheme(getTheme(themeId))
  }, [themeId])

  return children
}

export function useThemeList() {
  return THEMES.map((t) => t.meta)
}

export function useActiveTheme() {
  const themeId = useSettings((s) => s.themeId)
  return getTheme(themeId)
}
