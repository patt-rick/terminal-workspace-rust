import { useEffect, useLayoutEffect } from 'react'
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

  // Daily shuffle: run on mount, then re-check on a minute timer and on window
  // focus so a window left open across midnight still rolls over. The store's
  // date guard makes every call after the first of the day a no-op.
  useEffect(() => {
    const run = (): void => useSettings.getState().applyDailyShuffle()
    run()
    const timer = window.setInterval(run, 60_000)
    window.addEventListener('focus', run)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', run)
    }
  }, [])

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
