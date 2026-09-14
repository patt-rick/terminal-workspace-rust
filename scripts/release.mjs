import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** Rename `## [Unreleased]` -> `## [version] - date` and open a fresh empty
 *  Unreleased above it. Throws if Unreleased is missing or empty. */
export function stampUnreleased(changelog, version, date) {
  const lines = changelog.split(/\r?\n/)
  const idx = lines.findIndex((l) => /^## \[Unreleased\]/i.test(l))
  if (idx === -1) throw new Error('No "## [Unreleased]" section found in CHANGELOG.md')

  let end = lines.length
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(idx + 1, end).join('\n').trim()
  if (!body) {
    throw new Error(
      'The "## [Unreleased]" section is empty — add release notes before cutting a release.',
    )
  }

  const rebuilt = [
    ...lines.slice(0, idx),
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    ...lines.slice(idx + 1),
  ]
  return rebuilt.join('\n')
}

/** Replace the first `"version": "..."` key (package version) in a JSON file. */
export function bumpJsonVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
}

/** Replace the `version = "..."` under `[package]` in Cargo.toml. */
export function bumpCargoToml(text, version) {
  return text.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$1${version}$2`)
}

/** Replace the version of the `terminal-workspace` package in Cargo.lock. */
export function bumpCargoLock(text, version) {
  return text.replace(
    /(name = "terminal-workspace"\r?\nversion = ")[^"]+(")/,
    `$1${version}$2`,
  )
}

// CLI: `node scripts/release.mjs <x.y.z>`
import { fileURLToPath } from 'node:url'
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const version = process.argv[2]
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: node scripts/release.mjs <x.y.z>')
    process.exit(1)
  }
  const date = new Date().toISOString().slice(0, 10)
  const root = new URL('../', import.meta.url)
  const at = (rel) => new URL(rel, root)

  const read = (u) => readFileSync(u, 'utf8')

  writeFileSync(at('CHANGELOG.md'), stampUnreleased(read(at('CHANGELOG.md')), version, date))
  writeFileSync(at('package.json'), bumpJsonVersion(read(at('package.json')), version))
  writeFileSync(at('src-tauri/tauri.conf.json'), bumpJsonVersion(read(at('src-tauri/tauri.conf.json')), version))
  writeFileSync(at('src-tauri/Cargo.toml'), bumpCargoToml(read(at('src-tauri/Cargo.toml')), version))
  writeFileSync(at('src-tauri/Cargo.lock'), bumpCargoLock(read(at('src-tauri/Cargo.lock')), version))

  const files = [
    'CHANGELOG.md',
    'package.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
  ]
  execFileSync('git', ['add', ...files], { stdio: 'inherit' })
  execFileSync('git', ['commit', '-m', `chore(release): bump to ${version}`], { stdio: 'inherit' })

  console.log(`\nReleased ${version}. Next:\n  git tag v${version} && git push && git push --tags`)
}
