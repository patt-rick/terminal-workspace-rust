import { useEffect, useState } from 'react'

/** Below this width the project list would squeeze the terminal, so the nav stays a rail. */
const NARROW_QUERY = '(max-width: 999px)'

export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => setNarrow(query.matches)
    onChange()
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return narrow
}
