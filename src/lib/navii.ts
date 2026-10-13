// Generated project faces. Drawn locally from a seed by @usenavii/core, so
// nothing is fetched and only the seed is stored.

import { createAvatar } from '@usenavii/core'

const cache = new Map<string, string | null>()

export function newSeed(): string {
  return crypto.randomUUID()
}

/**
 * The face for a seed as an `<img>` source, or null if it cannot be drawn.
 * It has no background of its own: the tile's project colour shows behind it.
 */
export function faceDataUrl(seed: string, size: number): string | null {
  const key = `${seed}:${size}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let url: string | null = null
  try {
    const svg = createAvatar(seed, { size, background: 'none' })
    url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  } catch {
    url = null
  }
  cache.set(key, url)
  return url
}
