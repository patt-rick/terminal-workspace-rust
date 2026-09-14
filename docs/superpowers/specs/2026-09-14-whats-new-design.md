# What's New for new versions — design

## Problem

When a new version of Terminal Workspace ships, there is no curated "what's new". The
auto-updater's "Update available" dialog (`src/components/update-manager.tsx`) already
renders release notes from `update.body` (`src/state/updater.ts` → `info.notes`), but that
body is whatever `tauri-action` auto-fills — releases are cut by pushing a `v*` tag with no
`CHANGELOG.md` and no notes-authoring step. There is also nothing shown *after* an update
installs (no first-launch "here's what changed"), and no way to view release history inside
the app.

We want: a single curated source of release notes that (1) is hard to forget on every tag,
(2) feeds the pre-install update dialog, (3) shows a post-install recap on first launch of a
new version, and (4) is viewable anytime in the app.

## Decisions (locked with the user)

- **Scope = all four surfaces**: a repo `CHANGELOG.md` source of truth, improved pre-install
  notes, a new post-install recap dialog, and an anytime in-app viewer.
- **Enforcement = release helper script + Claude reminder** (no git hook, no CI gate). The
  script makes forgetting nearly impossible; the reminder is the soft backstop.
- **`lastSeenVersion` = dedicated `localStorage` key** (`tw:last-seen-version`), not a durable
  `Settings` field. Self-contained. If storage is cleared, the key is absent → treated as a
  first launch → silent stamp, no recap (see §4a) — never a spurious recap.
- **Release script does not auto-tag/push.** Tagging stays manual (matches today), optional
  `--tag` flag deferred.

## Non-goals

- Git pre-push hook or CI check that fails the release when the entry is missing (considered,
  declined in favor of the script + reminder).
- Changing the draft-release / publish flow or the updater endpoint.
- Migrating existing tags (`v0.1.0`…`v0.4.2`) into `CHANGELOG.md` retroactively — the file
  starts at the current version; older history is out of scope.
- Auto-resubmitting or gating anything on network availability of release notes.

## Architecture

Single source of truth → bundled into the app at build time → surfaced in three places; a
release script keeps the source authored and the version files in lockstep.

```
CHANGELOG.md ──(?raw import)──> src/lib/changelog.ts (parser)
    │                                   │
    │                                   ├─> WhatsNewDialog (post-install recap)
    │                                   └─> Settings → Updates viewer (anytime)
    │
    └──(scripts/changelog-section.mjs <tag>)──> release.yml releaseBody
                                                 └─> "Update available" dialog (pre-install)

scripts/release.mjs <version>: refuse-if-empty → stamp Unreleased → bump 4 files → commit
```

### 1. `CHANGELOG.md` (repo root) — source of truth

[Keep a Changelog](https://keepachangelog.com) style. A top `## [Unreleased]` section
accumulates entries as work lands. Cutting a release renames it to `## [x.y.z] - YYYY-MM-DD`
and opens a fresh empty `## [Unreleased]`.

```markdown
# Changelog

## [Unreleased]

## [0.4.2] - 2026-09-14
### Added
- Auto-switch to a healthy account when a session hits its usage limit.
```

Seeded starting at the current version (`0.4.2`); no retroactive backfill.

### 2. Bundling + parsing

- `import changelogRaw from '../../CHANGELOG.md?raw'` — identical to the existing
  `themeGuideMarkdown from '../../docs/theme-authoring.md?raw'` in `settings-modal.tsx`.
  `vite.config.ts` sets no custom `root`, so the repo root is in scope; no `server.fs.allow`
  change needed.
- **`src/lib/changelog.ts`** — a pure parser: split on `^## \[version\]` headings into
  `{ version: string, date: string | null, body: string }[]`, newest first. `Unreleased` is
  skipped for user-facing surfaces. Bodies render with the existing `react-markdown` +
  `remark-gfm`.
- **CI extraction is a separate, self-contained `scripts/changelog-section.mjs`** (~15 lines,
  same heading regex, no imports). It is **not** shared with `src/lib/changelog.ts`: the
  release workflow runs Node 20 (`release.yml`), which cannot import a `.ts` module, and the
  Keep-a-Changelog heading format is stable enough that the tiny regex duplication is cheaper
  than an `allowJs`/build step to share it. Both are covered by tests keyed to the same fixture
  so they can't silently diverge.

### 3. Running app version

Vite `define` injects `__APP_VERSION__` (string, from `package.json` `version`) at build time
— synchronous and works in browser dev, unlike the async Tauri-only `getVersion()`. The
release script bumps `package.json` in the same commit that stamps the changelog, so
`__APP_VERSION__` always matches the top released changelog entry. A `src/vite-env.d.ts`
declaration types the global.

### 4. Surfaces

**(a) Post-install recap — `src/components/whats-new-dialog.tsx`.** Mounted alongside
`UpdateManager` at the app root (next to `<UpdateManager />`). On launch:

- Only runs in the Tauri runtime (`isTauri`); in plain `vite dev` it no-ops so a local version
  bump doesn't pop the recap in the browser.
- Read `tw:last-seen-version` from `localStorage`.
- If **absent** → first launch since the feature shipped (or a fresh install, or cleared
  storage): stamp `__APP_VERSION__` silently, show nothing. Existing users are not spammed
  with a recap of the version they already run — so the release that *introduces* this feature
  shows no recap to upgraders; the first recap appears on the release *after* it. This is
  intended, not a bug.
- If **present and older than `__APP_VERSION__`** (semver comparison, see below): show a
  "What's New in v`__APP_VERSION__`" dialog listing the changelog entries for **every version
  strictly newer than last-seen** (so skipping releases shows combined notes), scrollable.
- If **equal or newer** (downgrade / same): stamp and show nothing.
- Dismiss stamps `tw:last-seen-version = __APP_VERSION__`.

**Mutual exclusion with the updater dialog.** Both are `z-50` root overlays. After a
relaunch-into-new-version, the recap is due *and* `UpdateManager`'s silent launch check runs —
if a still-newer release is already published, both would stack. The recap therefore only
opens when the updater status is `idle`/`upToDate` (i.e. no update dialog is showing);
otherwise it waits until the updater dialog is dismissed. Reuses the modal styling from
`update-manager.tsx`.

**(b) Anytime viewer.** A "What's New / Release history" section in the existing
**Settings → Updates** tab (`SETTINGS_TABS` in `settings-modal.tsx`), rendering the full
parsed changelog (scrollable markdown). Shares the parser and render component with (a).

**(c) Pre-install notes.** Two changes:

1. **Curated body.** `.github/workflows/release.yml` gains a step that runs
   `node scripts/changelog-section.mjs "$GITHUB_REF_NAME"` to extract the section for the
   pushed tag. The extractor is **Node** (the matrix runs `windows-latest` + `macos-latest`
   with different default shells). Plumbing:
   - The step runs `shell: bash` (available on both runners) and writes the multiline result
     to `$GITHUB_OUTPUT` using a heredoc delimiter (`body<<EOF … EOF`), then passes it to
     `tauri-apps/tauri-action@v0` via the `releaseBody` input.
   - The step is **guarded to tag pushes only** (`if: github.ref_type == 'tag'`), so the
     documented `workflow_dispatch` smoke-test path — where `github.ref_name` is a branch, not
     a tag — skips it and `releaseBody` falls back to tauri-action's default. The extractor
     also prints empty (exit 0) for an unknown tag rather than failing the build.
2. **Markdown rendering.** `update-manager.tsx` currently renders `info.notes` as plain text
   (`whitespace-pre-wrap`), so a Keep-a-Changelog body would show literal `###`/`-`. Switch
   that block to `react-markdown` + `remark-gfm` (already deps), reusing the same render
   component as surfaces (a) and (b).

*Existing constraint (documented, unchanged):* the updater endpoint is
`.../releases/latest/download/latest.json` (`tauri.conf.json`), which only resolves to a
**published, non-draft** release. Since `release.yml` sets `releaseDraft: true`, the
maintainer already must publish each draft for any update to ship. Note tauri-action bakes the
`releaseBody` into `latest.json`'s `notes` **at build time**, not at publish time — so the
notes must be right in `CHANGELOG.md` before the tag is pushed; **hand-editing the draft
release body on GitHub afterward does not change what the updater shows.**

### 5. Enforcement

**`scripts/release.mjs`** (run via a `package.json` script, e.g. `pnpm release <version>`):

1. **Refuse if `## [Unreleased]` is empty** — hard stop, so notes can't be forgotten.
2. Rename `## [Unreleased]` → `## [<version>] - <today>` and insert a fresh empty
   `## [Unreleased]` above it.
3. Bump the version string in all four files: `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock`. For the lock file, target only the
   `[[package]]` block whose `name = "terminal-workspace"` (the crate name in `Cargo.toml`) and
   replace its `version` line — not a blind global replace, which would corrupt an unrelated
   dependency that happens to share the version string.
4. Create the commit `chore(release): bump to <version>`.
5. Print the next step (`git tag v<version> && git push --tags`); does **not** tag or push.

**Claude reminder (soft layer):** a rule in `CLAUDE.md` and a persistent project memory —
"never bump the version / cut a release without a `CHANGELOG.md` entry; use `pnpm release`" —
so a hand-driven bump is still caught in-session.

## Version comparison

A dedicated semver-lite comparator in `src/lib/changelog.ts` (or a small `semver.ts`) parses
`x.y.z` into numeric tuples and compares field-by-field, so `0.4.10 > 0.4.9`. Plain string
comparison is wrong and is explicitly avoided. Non-`x.y.z` inputs sort as older (defensive).

## Error handling / edge cases

- **Malformed / empty changelog** → parser returns `[]`; the viewer shows an empty state, the
  recap shows nothing (never throws at app root).
- **`localStorage` unavailable** → recap silently no-ops (mirrors `persistLocal`'s swallow).
- **First-ever launch** → silent stamp, no recap (see 4a).
- **Downgrade** → no recap.
- **Version file drift** → prevented by the release script bumping all four together; if it
  ever happens, the recap keys off `package.json`'s value (documented).

## Testing

Vitest (already configured) unit tests, no Tauri runtime needed:

- **Parser** (`src/lib/changelog.ts`): multiple sections, missing date, `Unreleased`
  skipped, empty/malformed input → `[]`.
- **Semver comparator**: `0.4.10 > 0.4.9`, equality, missing/extra fields.
- **"newer than last-seen" selection**: absent last-seen → none shown (silent stamp), older →
  combined entries, equal → none, downgrade → none.
- **`scripts/changelog-section.mjs`**: extracts the exact section for a tag; unknown tag →
  empty output, exit 0 (per §4c). Same fixture as the parser test so the two can't diverge.

Manual: run `pnpm release <next>`, confirm the four files + changelog change and the commit;
launch with a stale `tw:last-seen-version` to see the recap; open Settings → Updates to see
the history.

## Files touched

- **New**: `CHANGELOG.md`, `src/lib/changelog.ts`, `src/components/whats-new-dialog.tsx`,
  `scripts/release.mjs`, `scripts/changelog-section.mjs`, tests under `src/lib/`.
- **Edited**: `vite.config.ts` (`define` + version), `src/vite-env.d.ts` (typing),
  the app-root component that mounts `UpdateManager` (mount `WhatsNewDialog`),
  `src/components/update-manager.tsx` (render notes as markdown),
  `src/components/settings-modal.tsx` (Updates-tab viewer), `.github/workflows/release.yml`
  (guarded `releaseBody` step), `package.json` (`release` script), `CLAUDE.md` (release rule).
