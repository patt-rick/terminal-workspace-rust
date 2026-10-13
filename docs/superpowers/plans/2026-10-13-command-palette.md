# Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a command palette (`Ctrl/Cmd+K`, `Ctrl/Cmd+Shift+P`) that finds and runs commands and jumps to any terminal or project, backed by one command registry that the keyboard shortcuts also use.

**Architecture:** Three pure TypeScript modules (fuzzy matcher, key table, ranking) with unit tests; one registry module that builds commands from the Zustand stores at call time; one dialog component modelled on quick-open. The keyboard handler in `src/app.tsx` is reduced to a table lookup that runs a registry command.

**Tech Stack:** React 19, Zustand 5, Tailwind v4, Vitest. No Rust changes.

Spec: `docs/superpowers/specs/2026-10-13-command-palette-design.md`

**Conventions for every task:**

- Tests run from the repo root: `pnpm test`. Typecheck: `pnpm typecheck` (`noUnusedLocals` and `noUnusedParameters` are on, so remove anything a step leaves unused).
- Commit messages follow the repo's conventional style and carry **no** `Co-Authored-By` trailer. The repo commits directly to `master`.
- Do not add comments unless they say something the code cannot (project rule).
- `src/app.tsx`, `src/lib/ipc.ts`, `src/state/store.ts` and possibly `terminal-pane.tsx` use CRLF line endings; keep whatever each file has. New files use LF.
- Drive C: on the development machine is nearly full. This plan needs no Rust build except the manual check in Task 8; confirm at least 3 GB free before running `pnpm tauri dev`.

---

## File Structure

**New:**
- `src/lib/fuzzy.ts` + `src/lib/fuzzy.test.ts` — subsequence matcher with scoring.
- `src/lib/keybindings.ts` + `src/lib/keybindings.test.ts` — key-to-command table and helpers.
- `src/lib/palette.ts` + `src/lib/palette.test.ts` — palette item type and ranking.
- `src/commands/app-commands.ts` — the command registry and palette item builder.
- `src/components/command-palette/command-palette.tsx` — the dialog.

**Modified:**
- `src/state/ui.ts` — `paletteOpen` and `quickOpenOpen` flags.
- `src/hooks/use-projects.ts` — export `addProject`.
- `src/lib/settings-tabs.ts` (new) and `src/components/settings-modal.tsx` — the tab list moves to a plain module so the registry does not import a component.
- `src/components/workspace/terminal-pane.tsx` — let the palette key through xterm.
- `src/app.tsx` — keyboard handler, quick-open state, mount the palette.
- `README.md`, `CHANGELOG.md`.

---

### Task 1: Fuzzy matcher

**Files:**
- Create: `src/lib/fuzzy.ts`
- Create: `src/lib/fuzzy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/fuzzy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzy'

const score = (query: string, text: string): number => fuzzyMatch(query, text)!.score

describe('fuzzyMatch', () => {
  it('matches everything on an empty query', () => {
    expect(fuzzyMatch('', 'abc')).toEqual({ score: 0, indices: [] })
    expect(fuzzyMatch('   ', 'abc')).toEqual({ score: 0, indices: [] })
  })

  it('returns null when characters are missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'New terminal')).toBeNull()
    expect(fuzzyMatch('tn', 'New t')).toBeNull()
  })

  it('reports the matched positions', () => {
    expect(fuzzyMatch('nt', 'New terminal')!.indices).toEqual([0, 4])
  })

  it('ignores case', () => {
    expect(fuzzyMatch('NT', 'new terminal')!.indices).toEqual([0, 4])
  })

  it('ignores spaces in the query', () => {
    expect(fuzzyMatch('new term', 'New terminal')!.indices).toEqual([0, 1, 2, 4, 5, 6, 7])
  })

  it('ranks a word-start match above a mid-word one', () => {
    expect(score('nt', 'New terminal')).toBeGreaterThan(score('nt', 'Print'))
  })

  it('ranks a consecutive match above a scattered one', () => {
    expect(score('term', 'New terminal')).toBeGreaterThan(score('term', 'The extra room'))
  })

  it('tries every starting point and keeps the best', () => {
    expect(fuzzyMatch('ab', 'xa_ab')!.indices).toEqual([3, 4])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/fuzzy.test.ts`
Expected: FAIL — `Failed to resolve import "./fuzzy"`.

- [ ] **Step 3: Implement**

Create `src/lib/fuzzy.ts`:

```ts
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
    if (match && (best === null || match.score > best.score)) best = match
  }
  return best
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/fuzzy.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/fuzzy.ts src/lib/fuzzy.test.ts
git commit -m "feat(palette): fuzzy subsequence matcher"
```

---

### Task 2: Key table

**Files:**
- Create: `src/lib/keybindings.ts`
- Create: `src/lib/keybindings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/keybindings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYBINDINGS, commandForEvent, eventKey, shortcutLabel } from './keybindings'

const WIN = false
const MAC = true

const ev = (key: string, mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
})

describe('eventKey', () => {
  it('writes the platform modifier as mod and lower-cases the key', () => {
    expect(eventKey(ev('t', { ctrl: true }), WIN)).toBe('mod+t')
    expect(eventKey(ev('K', { meta: true }), MAC)).toBe('mod+k')
    expect(eventKey(ev('T', { ctrl: true, shift: true }), WIN)).toBe('mod+shift+t')
    expect(eventKey(ev(',', { ctrl: true }), WIN)).toBe('mod+,')
  })

  it('leaves the modifier of the other platform alone', () => {
    expect(eventKey(ev('k', { ctrl: true }), MAC)).toBeNull()
    expect(eventKey(ev('k', { meta: true }), WIN)).toBeNull()
    expect(eventKey(ev('k', { ctrl: true, meta: true }), MAC)).toBeNull()
  })

  it('is null without a modifier, with alt, or for a bare modifier key', () => {
    expect(eventKey(ev('t'), WIN)).toBeNull()
    expect(eventKey(ev('t', { ctrl: true, alt: true }), WIN)).toBeNull()
    expect(eventKey(ev('Control', { ctrl: true }), WIN)).toBeNull()
    expect(eventKey(ev('Shift', { ctrl: true, shift: true }), WIN)).toBeNull()
  })
})

describe('commandForEvent', () => {
  it('resolves every default shortcut', () => {
    const cases: [ReturnType<typeof ev>, string][] = [
      [ev('k', { ctrl: true }), 'palette.toggle'],
      [ev('P', { ctrl: true, shift: true }), 'palette.toggle'],
      [ev(',', { ctrl: true }), 'view.settings'],
      [ev('b', { ctrl: true }), 'view.toggleSidebar'],
      [ev('B', { ctrl: true, shift: true }), 'view.toggleRightSidebar'],
      [ev('p', { ctrl: true }), 'file.quickOpen'],
      [ev('U', { ctrl: true, shift: true }), 'view.usage'],
      [ev('t', { ctrl: true }), 'terminal.new'],
      [ev('T', { ctrl: true, shift: true }), 'terminal.newClaude'],
      [ev('D', { ctrl: true, shift: true }), 'terminal.newClaudeSkipPermissions'],
      [ev('w', { ctrl: true }), 'terminal.close'],
    ]
    for (const [event, command] of cases) expect(commandForEvent(event, WIN)).toBe(command)
    expect(commandForEvent(ev('w', { meta: true }), MAC)).toBe('terminal.close')
  })

  it('is null for unbound keys', () => {
    expect(commandForEvent(ev('u', { ctrl: true }), WIN)).toBeNull()
    expect(commandForEvent(ev('z', { ctrl: true }), WIN)).toBeNull()
    expect(commandForEvent(ev('t'), WIN)).toBeNull()
  })
})

describe('shortcutLabel', () => {
  it('formats the first binding for the platform', () => {
    expect(shortcutLabel('terminal.newClaude', false)).toBe('Ctrl+Shift+T')
    expect(shortcutLabel('terminal.newClaude', true)).toBe('⌘⇧T')
    expect(shortcutLabel('view.settings', false)).toBe('Ctrl+,')
    expect(shortcutLabel('palette.toggle', false)).toBe('Ctrl+K')
  })

  it('is null for a command with no binding', () => {
    expect(shortcutLabel('project.add', false)).toBeNull()
  })
})

describe('DEFAULT_KEYBINDINGS', () => {
  it('binds each key once', () => {
    const keys = DEFAULT_KEYBINDINGS.map((b) => b.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/keybindings.test.ts`
Expected: FAIL — `Failed to resolve import "./keybindings"`.

- [ ] **Step 3: Implement**

Create `src/lib/keybindings.ts`:

```ts
// Key-to-command table. Pure, so it runs in plain vitest. Keys are written
// "mod+shift+t": mod is Ctrl or Cmd, modifiers in that fixed order.

export interface Keybinding {
  key: string
  command: string
}

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: 'mod+k', command: 'palette.toggle' },
  { key: 'mod+shift+p', command: 'palette.toggle' },
  { key: 'mod+,', command: 'view.settings' },
  { key: 'mod+b', command: 'view.toggleSidebar' },
  { key: 'mod+shift+b', command: 'view.toggleRightSidebar' },
  { key: 'mod+p', command: 'file.quickOpen' },
  { key: 'mod+shift+u', command: 'view.usage' },
  { key: 'mod+t', command: 'terminal.new' },
  { key: 'mod+shift+t', command: 'terminal.newClaude' },
  { key: 'mod+shift+d', command: 'terminal.newClaudeSkipPermissions' },
  { key: 'mod+w', command: 'terminal.close' },
]

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'])

/**
 * `mod` is Cmd on macOS and Ctrl elsewhere, never both: on a Mac, Ctrl+K and
 * friends belong to the shell and to the editor's emacs bindings. Alt is
 * excluded because AltGr arrives as Ctrl+Alt on Windows and types characters.
 */
export function eventKey(e: KeyEventLike, isMac: boolean): string | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || MODIFIER_KEYS.has(e.key)) return null
  return `mod+${e.shiftKey ? 'shift+' : ''}${e.key.toLowerCase()}`
}

export function commandForEvent(
  e: KeyEventLike,
  isMac: boolean,
  bindings: Keybinding[] = DEFAULT_KEYBINDINGS
): string | null {
  const key = eventKey(e, isMac)
  if (key === null) return null
  return bindings.find((b) => b.key === key)?.command ?? null
}

export function shortcutLabel(
  command: string,
  isMac: boolean,
  bindings: Keybinding[] = DEFAULT_KEYBINDINGS
): string | null {
  const binding = bindings.find((b) => b.command === command)
  if (!binding) return null
  const parts = binding.key.split('+')
  const key = (parts.pop() ?? '').toUpperCase()
  if (isMac) {
    return parts.map((p) => (p === 'mod' ? '⌘' : '⇧')).join('') + key
  }
  return [...parts.map((p) => (p === 'mod' ? 'Ctrl' : 'Shift')), key].join('+')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/keybindings.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/keybindings.ts src/lib/keybindings.test.ts
git commit -m "feat(palette): key-to-command table"
```

---

### Task 3: Palette ranking

**Files:**
- Create: `src/lib/palette.ts`
- Create: `src/lib/palette.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/palette.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { rankItems, type PaletteItem, type PaletteItemKind } from './palette'

const item = (title: string, kind: PaletteItemKind = 'command'): PaletteItem => ({
  key: `${kind}:${title}`,
  kind,
  title,
  hint: '',
  run: () => {},
})

const titles = (items: { title: string }[]): string[] => items.map((i) => i.title)

describe('rankItems', () => {
  const items = [
    item('Print'),
    item('New terminal'),
    item('api-server', 'project'),
    item('npm test', 'terminal'),
  ]

  it('keeps the given order for an empty query', () => {
    const ranked = rankItems('', items)
    expect(titles(ranked)).toEqual(['Print', 'New terminal', 'api-server', 'npm test'])
    expect(ranked[0].indices).toEqual([])
  })

  it('sorts matches by score and drops non-matches', () => {
    const ranked = rankItems('nt', items)
    expect(titles(ranked)).toEqual(['New terminal', 'npm test', 'Print'])
    expect(ranked[0].indices).toEqual([0, 4])
  })

  it('keeps the given order between equal scores', () => {
    const same = [item('Alpha', 'project'), item('Alpha', 'terminal')]
    expect(rankItems('al', same).map((i) => i.kind)).toEqual(['project', 'terminal'])
  })

  it('shows only commands after a leading >', () => {
    expect(titles(rankItems('>', items))).toEqual(['Print', 'New terminal'])
    expect(titles(rankItems('> nt', items))).toEqual(['New terminal', 'Print'])
  })

  it('applies the limit', () => {
    expect(rankItems('', items, 2)).toHaveLength(2)
    expect(rankItems('t', items, 1)).toHaveLength(1)
  })
})
```

In the second test, `npm test` matches "nt" at word starts (`n` at 0, `t` at 4), the same alignment as `New terminal`, so the two tie and keep their given order; `Print` scores lower.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/palette.test.ts`
Expected: FAIL — `Failed to resolve import "./palette"`.

- [ ] **Step 3: Implement**

Create `src/lib/palette.ts`:

```ts
// Palette item type and ranking. Pure, so it runs in plain vitest.

import { fuzzyMatch } from './fuzzy'

export type PaletteItemKind = 'command' | 'terminal' | 'project'

export interface PaletteItem {
  key: string
  kind: PaletteItemKind
  title: string
  /** right-aligned secondary text: a shortcut, "Terminal · project", "Project" */
  hint: string
  run: () => void
}

export interface RankedItem extends PaletteItem {
  indices: number[]
}

export const COMMANDS_ONLY_PREFIX = '>'

export function rankItems(query: string, items: PaletteItem[], limit = 50): RankedItem[] {
  const commandsOnly = query.startsWith(COMMANDS_ONLY_PREFIX)
  const text = (commandsOnly ? query.slice(COMMANDS_ONLY_PREFIX.length) : query).trim()
  const pool = commandsOnly ? items.filter((i) => i.kind === 'command') : items
  if (text === '') return pool.slice(0, limit).map((i) => ({ ...i, indices: [] }))

  const matched: { item: PaletteItem; order: number; score: number; indices: number[] }[] = []
  pool.forEach((item, order) => {
    const match = fuzzyMatch(text, item.title)
    if (match) matched.push({ item, order, score: match.score, indices: match.indices })
  })
  matched.sort((a, b) => b.score - a.score || a.order - b.order)
  return matched.slice(0, limit).map((m) => ({ ...m.item, indices: m.indices }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/palette.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/palette.ts src/lib/palette.test.ts
git commit -m "feat(palette): palette item ranking"
```

---

### Task 4: UI flags and exports the registry needs

**Files:**
- Modify: `src/state/ui.ts`
- Modify: `src/hooks/use-projects.ts`
- Create: `src/lib/settings-tabs.ts`
- Modify: `src/components/settings-modal.tsx:51-59`

- [ ] **Step 1: Add the flags**

Replace `src/state/ui.ts` with:

```ts
import { create } from 'zustand'

/** Cross-component UI flags that don't belong to a feature store. */
interface UiState {
  settingsOpen: boolean
  settingsTab: string | null
  paletteOpen: boolean
  quickOpenOpen: boolean
  openSettings: (tab?: string) => void
  clearSettingsTab: () => void
  closeSettings: () => void
  toggleSettings: () => void
  togglePalette: () => void
  closePalette: () => void
  toggleQuickOpen: () => void
  closeQuickOpen: () => void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: null,
  paletteOpen: false,
  quickOpenOpen: false,
  openSettings: (tab?: string) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  clearSettingsTab: () => set({ settingsTab: null }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, quickOpenOpen: false })),
  closePalette: () => set({ paletteOpen: false }),
  toggleQuickOpen: () => set((s) => ({ quickOpenOpen: !s.quickOpenOpen, paletteOpen: false })),
  closeQuickOpen: () => set({ quickOpenOpen: false }),
}))
```

- [ ] **Step 2: Export `addProject`**

In `src/hooks/use-projects.ts`, move `addProject` out of the hook. The file becomes:

```ts
import { useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { ipc } from '../lib/ipc'
import { useWorkspace } from '../state/store'

export async function addProject(): Promise<void> {
  const picked = await open({ directory: true, multiple: false })
  if (!picked || typeof picked !== 'string') return
  const project = await ipc.projects.add(picked)
  const ws = useWorkspace.getState()
  ws.upsertProject(project)
  ws.selectProject(project.id)
}

/** Loads the persisted project snapshot on mount and exposes add-project. */
export function useProjects() {
  const projects = useWorkspace((s) => s.projects)
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const setProjects = useWorkspace((s) => s.setProjects)

  useEffect(() => {
    void ipc.projects
      .snapshot()
      .then((snap) => {
        setProjects(snap.projects, {
          selectedProjectId: snap.selectedProjectId,
          activeTerminalByProject: snap.activeTerminalByProject,
        })
      })
      .catch(() => {
        // backend unavailable (e.g. plain browser dev) — start empty
      })
  }, [setProjects])

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null

  return { projects, selectedProject, addProject }
}
```

- [ ] **Step 3: Move the settings tabs to a plain module**

Create `src/lib/settings-tabs.ts`:

```ts
export type SettingsTabId = 'general' | 'ai' | 'github' | 'remote' | 'updates'

export const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'github', label: 'GitHub' },
  { id: 'remote', label: 'Remote access' },
  { id: 'updates', label: 'Updates' },
]
```

In `src/components/settings-modal.tsx`, delete the `type SettingsTabId = ...` line and the whole `const SETTINGS_TABS ... ]` declaration, and add this import with the other imports:

```ts
import { SETTINGS_TABS, type SettingsTabId } from '../lib/settings-tabs'
```

- [ ] **Step 4: Typecheck and test**

Run: `pnpm typecheck && pnpm test`
Expected: `tsc` exits 0; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/ui.ts src/hooks/use-projects.ts src/lib/settings-tabs.ts src/components/settings-modal.tsx
git commit -m "refactor(ui): palette and quick-open flags, exported addProject and settings tabs"
```

---

### Task 5: Command registry

**Files:**
- Create: `src/commands/app-commands.ts`

- [ ] **Step 1: Write the registry**

Create `src/commands/app-commands.ts`:

```ts
// The command registry. Commands are built at call time from the stores, so
// the list always reflects the current projects and themes. Both the keyboard
// handler and the palette run commands from here.
//
// A command's `run` takes no arguments on purpose: nothing typed into the
// palette may ever be passed on to a shell or an agent.

import { ipc } from '../lib/ipc'
import { isMac } from '../lib/platform'
import { shortcutLabel } from '../lib/keybindings'
import type { PaletteItem } from '../lib/palette'
import { THEMES } from '../themes'
import { addProject } from '../hooks/use-projects'
import { SETTINGS_TABS } from '../lib/settings-tabs'
import { createProjectTerminal, useWorkspace } from '../state/store'
import { useSettings } from '../state/settings'
import { useUi } from '../state/ui'
import { useUsage } from '../state/usage'
import { useApiKeys } from '../state/apikeys'

export interface Command {
  id: string
  title: string
  /** absent means always enabled */
  enabled?: () => boolean
  run: () => void
  /** what the palette runs where a toggle would be wrong: it opens, never closes */
  paletteRun?: () => void
}

const PALETTE_TOGGLE = 'palette.toggle'

function selection(): { projectId: string | null; terminalId: string | null } {
  const ws = useWorkspace.getState()
  const project = ws.projects.find((p) => p.id === ws.selectedProjectId)
  if (!project) return { projectId: null, terminalId: null }
  return { projectId: project.id, terminalId: ws.activeTerminalByProject[project.id] ?? null }
}

function newClaude(projectId: string, startupCommand: string): void {
  useWorkspace.getState().setProjectExpanded(projectId, true)
  void createProjectTerminal(projectId, { name: 'Claude Code', startupCommand })
}

export function appCommands(): Command[] {
  const { projectId, terminalId } = selection()
  const hasProject = (): boolean => projectId !== null
  const withProject = (fn: (id: string) => void) => (): void => {
    if (projectId) fn(projectId)
  }

  const commands: Command[] = [
    {
      id: 'terminal.new',
      title: 'New terminal',
      enabled: hasProject,
      run: withProject((id) => void createProjectTerminal(id)),
    },
    {
      id: 'terminal.newClaude',
      title: 'New Claude Code terminal',
      enabled: hasProject,
      run: withProject((id) => newClaude(id, 'claude')),
    },
    {
      id: 'terminal.newClaudeSkipPermissions',
      title: 'New Claude Code terminal (skip permissions)',
      enabled: hasProject,
      run: withProject((id) => newClaude(id, 'claude --dangerously-skip-permissions')),
    },
    {
      id: 'terminal.newOtherModel',
      title: 'New terminal with another model…',
      enabled: hasProject,
      run: withProject((id) => useApiKeys.getState().openLauncher(id)),
    },
    {
      id: 'terminal.close',
      title: 'Close terminal',
      enabled: () => terminalId !== null && !useUsage.getState().open,
      run: withProject((id) => {
        if (terminalId) useWorkspace.getState().requestTerminalClose(id, terminalId)
      }),
    },
    {
      id: 'file.quickOpen',
      title: 'Go to file…',
      enabled: hasProject,
      run: () => useUi.getState().toggleQuickOpen(),
    },
    {
      id: 'view.toggleSidebar',
      title: 'Toggle project sidebar',
      run: () => useWorkspace.getState().toggleSidebar(),
    },
    {
      id: 'view.toggleRightSidebar',
      title: 'Toggle right panel',
      run: () => useWorkspace.getState().toggleRightSidebar(),
    },
    {
      id: 'view.usage',
      title: 'Usage',
      run: () => useUsage.getState().togglePage(),
      paletteRun: () => useUsage.getState().openPage(),
    },
    {
      id: 'view.settings',
      title: 'Settings',
      run: () => useUi.getState().toggleSettings(),
      paletteRun: () => useUi.getState().openSettings(),
    },
    { id: 'project.add', title: 'Add project…', run: () => void addProject() },
    {
      id: 'project.revealInFileManager',
      title: 'Reveal project in file manager',
      enabled: hasProject,
      run: withProject((id) => void ipc.projects.openInFileManager(id)),
    },
    {
      id: 'project.openInSystemTerminal',
      title: 'Open project in system terminal',
      enabled: hasProject,
      run: withProject((id) => void ipc.projects.openInTerminal(id)),
    },
    { id: PALETTE_TOGGLE, title: 'Command palette', run: () => useUi.getState().togglePalette() },
  ]

  for (const tab of SETTINGS_TABS) {
    commands.push({
      id: `settings.${tab.id}`,
      title: `Settings: ${tab.label}`,
      run: () => useUi.getState().openSettings(tab.id),
    })
  }

  const settings = useSettings.getState()
  for (const theme of [...THEMES, ...settings.customThemes]) {
    commands.push({
      id: `theme.${theme.meta.id}`,
      title: `Theme: ${theme.meta.name}`,
      run: () => useSettings.getState().setThemeId(theme.meta.id),
    })
  }

  return commands
}

/** Runs a command if it exists and is enabled; reports whether it ran. */
export function runCommand(id: string): boolean {
  const command = appCommands().find((c) => c.id === id)
  if (!command || (command.enabled && !command.enabled())) return false
  command.run()
  return true
}

/** Everything the palette can show, in its default order. */
export function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const command of appCommands()) {
    if (command.id === PALETTE_TOGGLE) continue
    if (command.enabled && !command.enabled()) continue
    items.push({
      key: `command:${command.id}`,
      kind: 'command',
      title: command.title,
      hint: shortcutLabel(command.id, isMac) ?? '',
      run: command.paletteRun ?? command.run,
    })
  }

  const ws = useWorkspace.getState()
  for (const project of ws.projects) {
    for (const terminal of project.terminals) {
      items.push({
        key: `terminal:${terminal.id}`,
        kind: 'terminal',
        title: ws.titleByTerminal[terminal.id] || terminal.name,
        hint: `Terminal · ${project.name}`,
        run: () => {
          const state = useWorkspace.getState()
          const live = state.projects.find((p) => p.id === project.id)
          if (!live?.terminals.some((t) => t.id === terminal.id)) return
          state.selectProject(project.id)
          state.setActiveTerminal(project.id, terminal.id)
        },
      })
    }
  }
  for (const project of ws.projects) {
    items.push({
      key: `project:${project.id}`,
      kind: 'project',
      title: project.name,
      hint: 'Project',
      run: () => {
        const state = useWorkspace.getState()
        if (state.projects.some((p) => p.id === project.id)) state.selectProject(project.id)
      },
    })
  }
  return items
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0. If `tsc` reports that `Theme` from `settings.customThemes` and `THEMES` differ in type, both come from `src/themes/types.ts`; fix the import rather than casting.

- [ ] **Step 3: Commit**

```bash
git add src/commands/app-commands.ts
git commit -m "feat(palette): command registry built from the stores"
```

---

### Task 6: The palette dialog

**Files:**
- Create: `src/components/command-palette/command-palette.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/command-palette/command-palette.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { paletteItems } from '../../commands/app-commands'
import { rankItems, type RankedItem } from '../../lib/palette'
import { useUi } from '../../state/ui'

/**
 * Finds and runs commands, and jumps to terminals and projects. The text field
 * only filters this fixed list; nothing typed here reaches an agent or a shell.
 */
export function CommandPalette() {
  const close = useUi((s) => s.closePalette)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(() => paletteItems(), [])
  const results = useMemo(() => rankItems(query, items), [query, items])

  // Give focus back to whatever had it (normally the terminal) when the
  // palette goes away, however it was closed. An item that moves focus itself
  // does so in an effect, which runs after this cleanup and therefore wins.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (item: RankedItem | undefined): void => {
    if (!item) return
    close()
    item.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // Stopped here so the same press does not also close Settings underneath.
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.max(0, Math.min(s + 1, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[selected])
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-center bg-black/40 pt-[12vh]" onClick={close}>
      <div
        className="flex h-fit max-h-[70vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search commands, terminals and projects…"
          aria-label="Command palette"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">Nothing matches</div>
          ) : (
            results.map((item, i) => (
              <div
                key={item.key}
                data-idx={i}
                onClick={() => choose(item)}
                onMouseMove={() => setSelected(i)}
                className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 text-sm ${
                  i === selected ? 'bg-accent/15' : 'hover:bg-foreground/5'
                }`}
              >
                <Highlighted text={item.title} indices={item.indices} />
                <span className="ml-auto flex-shrink-0 text-[11px] text-muted">{item.hint}</span>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-1.5 text-[11px] text-muted">
          <span>Type &gt; for commands only</span>
          <span>↑↓ navigate · ↵ run · esc close</span>
        </div>
      </div>
    </div>
  )
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  // `indices` are UTF-16 offsets; iterating by code point keeps emoji whole, so
  // the offset is tracked separately from the loop index.
  const matched = new Set(indices)
  let offset = 0
  return (
    <span className="min-w-0 truncate text-foreground">
      {[...text].map((ch, i) => {
        const at = offset
        offset += ch.length
        return (
          <span key={i} className={matched.has(at) ? 'font-semibold text-accent' : undefined}>
            {ch}
          </span>
        )
      })}
    </span>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/command-palette/command-palette.tsx
git commit -m "feat(palette): command palette dialog"
```

---

### Task 7: Wire the handler and the palette into the app

**Files:**
- Modify: `src/app.tsx`
- Modify: `src/components/workspace/terminal-pane.tsx:128-130`

- [ ] **Step 1: Replace the keyboard handler**

In `src/app.tsx`, add imports after `import { UsagePage } from './components/usage/usage-page'`:

```tsx
import { CommandPalette } from './components/command-palette/command-palette'
import { runCommand } from './commands/app-commands'
import { commandForEvent } from './lib/keybindings'
```

Also extend the existing `import { kbd } from './lib/platform'` line to `import { isMac, kbd } from './lib/platform'`.

Replace the whole `useEffect` that defines `onKey` (from `useEffect(() => {` / `const onKey = (e: KeyboardEvent): void => {` through its dependency array ending `toggleUsage, usageOpen])`) with:

```tsx
  // Every shortcut is a row in the key table (lib/keybindings.ts) that names a
  // registry command. The default is always prevented for a bound key, so e.g.
  // Ctrl+P never reaches the webview's print dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const command = commandForEvent(e, isMac)
      if (command === null) return
      e.preventDefault()
      // The palette's list was built when it opened; other shortcuts acting
      // behind it would make that list stale.
      const behindPalette = command !== 'palette.toggle' && command !== 'file.quickOpen'
      if (useUi.getState().paletteOpen && behindPalette) return
      runCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
```

- [ ] **Step 2: Move quick-open state to the UI store**

Delete the line:

```tsx
  const [quickOpen, setQuickOpen] = useState(false)
```

After `const toggleSettings = useUi((s) => s.toggleSettings)`, replace that line (it is no longer used by this file) with:

```tsx
  const quickOpen = useUi((s) => s.quickOpenOpen)
  const closeQuickOpen = useUi((s) => s.closeQuickOpen)
  const paletteOpen = useUi((s) => s.paletteOpen)
```

Change the quick-open render near the end of the component to use the store and add the palette beside it:

```tsx
      {quickOpen && selectedProject && (
        <QuickOpen projectId={selectedProject.id} onClose={closeQuickOpen} />
      )}
      {paletteOpen && <CommandPalette />}
```

- [ ] **Step 3: Let the palette key through the terminal**

xterm handles `Ctrl+letter` itself when a terminal has focus: it sends the control character to the shell and stops the event, so the window handler above never sees it. In `src/components/workspace/terminal-pane.tsx`, inside `term.attachCustomKeyEventHandler`, add one line directly after `if (e.type !== 'keydown') return true`:

```ts
      if (commandForEvent(e, isMac) === 'palette.toggle') return false
```

and add the import (`isMac` is already imported in this file):

```ts
import { commandForEvent } from '../../lib/keybindings'
```

Returning `false` makes xterm ignore the key without stopping it, so it reaches the window handler. Only the palette key is released here. Whether the terminal should also give up `Ctrl+T`, `Ctrl+W`, `Ctrl+P` and `Ctrl+B` is the owner's decision (it takes those keys away from the shell and from agent CLIs) and is not part of this plan.

- [ ] **Step 4: Remove what the old handler was the only user of**

Run: `pnpm typecheck`

`tsc` will list each now-unused local. Remove exactly those: the `requestTerminalClose` selector line, and `useState` from the React import if nothing else in the file uses it. Do not remove `toggleSidebar`, `toggleRightSidebar`, `toggleUsage`, `usageOpen`, `openSettings` or `createProjectTerminal`; header buttons and the empty state still use them. Re-run until it exits 0.

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: all test files pass (106 existing + 8 + 8 + 5 = 127 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app.tsx src/components/workspace/terminal-pane.tsx
git commit -m "feat(palette): route shortcuts through the command registry and mount the palette"
```

---

### Task 8: Verify in the running app, then document

**Files:**
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Launch**

Confirm at least 3 GB free on drive C:, then run `pnpm tauri dev`. If there is less, stop and report: do not mark the checks below as passed, and leave Steps 3 to 5 until the owner has run them.

- [ ] **Step 2: Check each behaviour and record the result**

1. With a project selected and focus **outside** a terminal (click the sidebar first), every existing shortcut still works: `Ctrl+T`, `Ctrl+Shift+T`, `Ctrl+Shift+D`, `Ctrl+W` (shows the close prompt), `Ctrl+P`, `Ctrl+B`, `Ctrl+Shift+B`, `Ctrl+,`, `Ctrl+Shift+U`. Then, with focus **inside** a terminal on Windows, record which of the unshifted ones (`Ctrl+T`, `Ctrl+W`, `Ctrl+P`, `Ctrl+B`) reach the app and which go to the shell; this plan does not change that, and the owner wants to know.
2. From a focused terminal, `Ctrl+K` and `Ctrl+Shift+P` each open the palette; either closes it again; `Esc` and a click outside close it. With Settings open, `Esc` in the palette closes only the palette. With the palette open, `Ctrl+T` does nothing.
3. With no project selected the palette opens and lists no project-only commands (no "New terminal").
4. Typing `nt` puts "New terminal" first; `>` hides terminals and projects; matched letters are emphasised; the shortcut shows on the right of commands that have one.
5. `Enter` on "Theme: Tokyo Night" switches theme. "Settings: AI" opens Settings on that tab. "Go to file…" opens quick-open. "Usage" opens the Usage page; choosing "Settings" while Settings is already open leaves it open.
6. With two projects that each have a terminal, choosing the other project's terminal switches project and terminal, and the terminal accepts typing straight away.
7. Open the palette from a focused terminal, press `Esc`, type: the characters go to the terminal.
8. With the Usage page open, `Ctrl+W` does nothing and "Close terminal" is not listed.
9. `Ctrl+Alt+T` does not create a terminal.

- [ ] **Step 3: Changelog**

In `CHANGELOG.md`, under `## [Unreleased]`, add to the existing `### Added` list:

```markdown
- Command palette (`Ctrl/Cmd+K` or `Ctrl/Cmd+Shift+P`): find and run any command, switch
  theme, and jump to any terminal or project.
```

and add a `### Changed` section below it:

```markdown
### Changed
- `Ctrl/Cmd+Shift+P` opens the command palette (it used to open file search, which stays on
  `Ctrl/Cmd+P`). `Ctrl/Cmd+Shift+W` no longer closes a terminal; use `Ctrl/Cmd+W`.
  Shortcuts no longer fire while Alt is held, and on macOS they need Cmd, not Ctrl.
```

- [ ] **Step 4: README**

In the Keyboard shortcuts table, add as the first row after the header:

```markdown
| ⌘/Ctrl K, ⌘/Ctrl ⇧ P | Command palette |
```

In the Architecture block's `src/` section, after the `lib/` line:

```
  commands/    the command registry behind the palette and the shortcuts
```

- [ ] **Step 5: Final check and commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass.

```bash
git add CHANGELOG.md README.md
git commit -m "docs(palette): changelog and readme for the command palette"
```

---

## Changes made during the build

The code as built differs from the task text above in these places, all from the code
review.

- **Keys cannot leak to the terminal (Task 6).** The key handler sits on the panel, not the
  text field; Tab is swallowed; clicking the list or footer no longer blurs the field; a
  held Enter or Esc has its auto-repeats eaten until the key is released, so they cannot
  reach the agent once focus returns to the terminal. Enter during text composition is
  ignored.
- **Selection (Task 6).** A row is selected by a real pointer move only, not by sliding
  under a resting pointer.
- **Shortcuts (Task 7).** Auto-repeated shortcut presses are ignored.
- **Registry (Task 5).** The selected project and terminal are read when a command runs,
  not when the list is built. Choosing a terminal, a project or Usage closes Settings
  first. Terminal titles are cut to 200 characters.
- **Matching (Tasks 1 and 3).** The start loop stops at the first start that cannot match.
  The `>` prefix may follow leading spaces.

Confirmed in the running app on Windows: with a terminal focused, `Ctrl+T` goes to the
shell and does not create a terminal (the spec's open question). `Ctrl+K` opens the palette
from the same place.

## Spec coverage

| Spec section | Task |
|---|---|
| Fuzzy matching | 1 |
| Key table, Alt exclusion, labels | 2 |
| Ranking, `>` prefix | 3 |
| Registry, command list, palette items | 4, 5 |
| The dialog, focus | 6 |
| Changes to existing code | 4, 7 |
| Testing | 1, 2, 3, 8 |
