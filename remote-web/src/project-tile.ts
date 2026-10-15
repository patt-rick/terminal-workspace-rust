// A copy of the desktop's src/lib/project-tile.ts: the letter and text colour
// of a project tile that has no icon.

/** First letter or digit of the name, upper-cased; '?' if it has none. */
export function tileLetter(name: string): string {
  const match = name.match(/[\p{L}\p{N}]/u)
  return match ? match[0].toUpperCase() : '?'
}

const DARK_TEXT = '#171c28'
const LIGHT_TEXT = '#ffffff'

/** Dark or white text, whichever reads better on a `#rrggbb` colour. */
export function readableOn(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (!m) return LIGHT_TEXT
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.4 ? DARK_TEXT : LIGHT_TEXT
}
