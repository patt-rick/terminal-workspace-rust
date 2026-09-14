export interface ChangelogEntry {
  /** `x.y.z` version, no leading `v` */
  version: string
  /** ISO-ish date string from the heading, or null if absent */
  date: string | null
  /** markdown body between this heading and the next `## [` heading, trimmed */
  body: string
}

const HEADING = /^## \[([^\]]+)\](?:\s*-\s*(.+?))?\s*$/

/** Parse CHANGELOG.md text into released entries (newest-first), skipping Unreleased. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const lines = text.split(/\r?\n/)
  const entries: ChangelogEntry[] = []
  let current: { version: string; date: string | null; body: string[] } | null = null

  const flush = (): void => {
    if (current && current.version.toLowerCase() !== 'unreleased') {
      entries.push({
        version: current.version,
        date: current.date,
        body: current.body.join('\n').trim(),
      })
    }
  }

  for (const line of lines) {
    const m = HEADING.exec(line)
    if (m) {
      flush()
      current = { version: m[1].trim(), date: m[2]?.trim() ?? null, body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  flush()
  return entries
}

/** Numeric field-by-field compare of two `x.y.z` versions. Malformed fields count as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((n) => parseInt(n, 10))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Entries whose version is strictly newer than `sinceVersion`, newest-first. */
export function entriesNewerThan(
  entries: ChangelogEntry[],
  sinceVersion: string,
): ChangelogEntry[] {
  return entries.filter((e) => compareVersions(e.version, sinceVersion) > 0)
}
