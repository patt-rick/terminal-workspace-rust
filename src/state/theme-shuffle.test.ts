import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSettings } from './settings'
import { THEMES } from '../themes'

const BUILTIN_IDS = THEMES.map((t) => t.meta.id)

describe('daily theme shuffle', () => {
  beforeEach(() => {
    const { editor, terminal } = useSettings.getState()
    useSettings.getState().replaceAll({
      themeId: THEMES[0].meta.id,
      themeShuffle: false,
      lastShuffleDate: null,
      editor,
      terminal,
      customThemes: [],
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-09T10:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enabling shuffle immediately switches to a different built-in theme and stamps today', () => {
    const before = useSettings.getState().themeId
    useSettings.getState().setThemeShuffle(true)
    const after = useSettings.getState().themeId

    expect(after).not.toBe(before)
    expect(BUILTIN_IDS).toContain(after)
    expect(useSettings.getState().lastShuffleDate).toBe('2026-07-09')
  })

  it('applyDailyShuffle is a no-op later the same day', () => {
    useSettings.getState().setThemeShuffle(true)
    const sameDay = useSettings.getState().themeId

    vi.setSystemTime(new Date('2026-07-09T23:59:00'))
    useSettings.getState().applyDailyShuffle()

    expect(useSettings.getState().themeId).toBe(sameDay)
  })

  it('rolls over to a different theme the next day (never repeats the current one)', () => {
    useSettings.getState().setThemeShuffle(true)
    const day1 = useSettings.getState().themeId

    vi.setSystemTime(new Date('2026-07-10T00:05:00'))
    useSettings.getState().applyDailyShuffle()
    const day2 = useSettings.getState().themeId

    expect(day2).not.toBe(day1)
    expect(useSettings.getState().lastShuffleDate).toBe('2026-07-10')
  })

  it('does nothing while shuffle is disabled', () => {
    const before = useSettings.getState().themeId
    useSettings.getState().applyDailyShuffle()
    expect(useSettings.getState().themeId).toBe(before)
    expect(useSettings.getState().lastShuffleDate).toBeNull()
  })
})
