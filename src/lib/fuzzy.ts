// Subsequence matcher for the command palette. Pure, so it runs in plain vitest.

export interface FuzzyMatch {
  score: number
  /** positions in the text of each matched query character */
  indices: number[]
}

const SEPARATORS = new Set([' ', '-', '_', '/', '\\', ':', '.'])
const WORD_START_BONUS = 8
const CONSECUTIVE_BONUS = 5
const MAX_GAP_PENALTY = 3
const MAX_LEAD_PENALTY = 2.5

function matchFrom(query: string[], lower: string, text: string, start: number): FuzzyMatch | null {
  const indices: number[] = []
  let score = 0
  let from = start
  let previous = -1
  for (const ch of query) {
    const at = lower.indexOf(ch, from)
    if (at < 0) return null
    score += 1
    if (at === 0 || SEPARATORS.has(text[at - 1])) score += WORD_START_BONUS
    if (previous >= 0) {
      if (at === previous + 1) score += CONSECUTIVE_BONUS
      else score -= Math.min(at - previous - 1, MAX_GAP_PENALTY)
    }
    indices.push(at)
    previous = at
    from = at + 1
  }
  score -= Math.min(indices[0] * 0.5, MAX_LEAD_PENALTY)
  return { score, indices }
}

/**
 * Case-insensitive subsequence match. Every occurrence of the first query
 * character is tried as the start, because the leftmost alignment is often not
 * the best one ("ab" in "xa_ab").
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const chars = [...query.toLowerCase()].filter((ch) => ch !== ' ')
  if (chars.length === 0) return { score: 0, indices: [] }
  const lower = text.toLowerCase()
  let best: FuzzyMatch | null = null
  for (let start = lower.indexOf(chars[0]); start >= 0; start = lower.indexOf(chars[0], start + 1)) {
    const match = matchFrom(chars, lower, text, start)
    // A later start has less text to match in, so it cannot succeed either.
    if (!match) break
    if (best === null || match.score > best.score) best = match
  }
  return best
}
