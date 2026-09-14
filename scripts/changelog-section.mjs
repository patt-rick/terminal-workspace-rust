import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Extract the CHANGELOG.md section body for a tag/version. A leading `v` is
 * stripped (git tags are `v0.4.2`; headings are `## [0.4.2]`). The heading line
 * itself is dropped so the notes read cleanly. Unknown version -> ''.
 */
export function sectionFor(changelog, tag) {
  const version = String(tag ?? '').replace(/^v/, '').trim()
  if (!version) return ''
  const lines = changelog.split(/\r?\n/)
  const heading = /^## \[([^\]]+)\]/
  const out = []
  let capturing = false
  for (const line of lines) {
    const m = heading.exec(line)
    if (m) {
      if (capturing) break // reached the next section
      if (m[1].trim() === version) {
        capturing = true // start after this heading; do not push it
      }
      continue
    }
    if (capturing) out.push(line)
  }
  return out.join('\n').trim()
}

// CLI: `node scripts/changelog-section.mjs <tag>` -> prints the section to stdout.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const tag = process.argv[2] ?? ''
  let text = ''
  try {
    text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  } catch {
    // no changelog -> empty notes, exit 0
  }
  process.stdout.write(sectionFor(text, tag))
}
