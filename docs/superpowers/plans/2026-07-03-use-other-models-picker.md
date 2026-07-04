# "Use other models" Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Use other models" action (project context menu + empty state) opens a modal listing saved provider entries; picking one launches a terminal running that entry's launch command. Claude flows untouched.

**Architecture:** Picker state (`launcherProjectId`) in the apikeys Zustand store, mirroring the identity picker. New `ModelPicker` modal modeled on `account-picker.tsx`, rendered once in `app.tsx`. Launch goes through the existing `createProjectTerminal`. Frontend only.

**Tech Stack:** React/Zustand/Tailwind/vitest. Gates from repo root: `pnpm test`, `pnpm typecheck`, `pnpm build`. Commits without `Co-Authored-By` trailer.

**Spec:** `docs/superpowers/specs/2026-07-03-multi-llm-provider-keys-design.md`, Addendum → "Use other models" picker.

---

### Task: launcher state, ModelPicker modal, two entry points

**Files:**
- Modify: `src/lib/apikey-presets.ts` (+ `launchBlocker` helper)
- Modify: `src/lib/apikey-presets.test.ts`
- Modify: `src/state/apikeys.ts` (launcher state)
- Create: `src/components/apikeys/model-picker.tsx`
- Modify: `src/app.tsx` (render picker; EmptyState tertiary button)
- Modify: `src/components/sidebar/project-list.tsx` (context-menu item)

- [ ] **Step 1 (TDD red):** In `src/lib/apikey-presets.test.ts`, add a new top-level describe:

```ts
describe('launchBlocker', () => {
  it('returns null only when launchable', () => {
    const base = { enabled: true, hasValue: true, launchCommand: 'aider' }
    expect(launchBlocker(base)).toBeNull()
    expect(launchBlocker({ ...base, enabled: false })).toBe('Disabled')
    expect(launchBlocker({ ...base, hasValue: false })).toBe('No API key stored')
    expect(launchBlocker({ ...base, launchCommand: null })).toBe('No launch command')
    expect(launchBlocker({ ...base, launchCommand: '' })).toBe('No launch command')
  })
})
```

Add `launchBlocker` to the existing import from `./apikey-presets`. Run `pnpm test` — confirm FAILURE (no export `launchBlocker`).

- [ ] **Step 2 (TDD green):** In `src/lib/apikey-presets.ts`, add at the end:

```ts
/**
 * Why an entry can't be launched right now, or null when it can. Order matters:
 * the most actionable problem is reported first.
 */
export function launchBlocker(k: {
  enabled: boolean
  hasValue: boolean
  launchCommand: string | null
}): string | null {
  if (!k.enabled) return 'Disabled'
  if (!k.hasValue) return 'No API key stored'
  if (!k.launchCommand) return 'No launch command'
  return null
}
```

Run `pnpm test` — expected: 13 tests pass.

- [ ] **Step 3:** In `src/state/apikeys.ts`, extend the store with launcher state. Add to the `ApiKeysState` interface (after `detected`):

```ts
  /** project the "Use other models" picker is open for; null = closed */
  launcherProjectId: string | null
```

and after `importEnv` in the interface:

```ts
  openLauncher: (projectId: string) => void
  closeLauncher: () => void
```

In the implementation object add `launcherProjectId: null,` (after `detected: []`) and at the end:

```ts
  openLauncher: (projectId) => set({ launcherProjectId: projectId }),
  closeLauncher: () => set({ launcherProjectId: null }),
```

- [ ] **Step 4:** Create `src/components/apikeys/model-picker.tsx`:

```tsx
import { useEffect } from 'react'
import { launchBlocker, presetById } from '../../lib/apikey-presets'
import { useApiKeys } from '../../state/apikeys'
import { createProjectTerminal, useWorkspace } from '../../state/store'
import { useUi } from '../../state/ui'

/**
 * "Use other models" chooser: lists the saved provider entries and launches a
 * terminal (in the project the picker was opened for) running the selected
 * entry's launch command. Claude has its own dedicated flows; this is the
 * everything-else path.
 */
export function ModelPicker() {
  const projectId = useApiKeys((s) => s.launcherProjectId)
  const keys = useApiKeys((s) => s.keys)
  const loaded = useApiKeys((s) => s.loaded)
  const load = useApiKeys((s) => s.load)
  const close = useApiKeys((s) => s.closeLauncher)
  const openSettings = useUi((s) => s.openSettings)

  useEffect(() => {
    if (projectId && !loaded) void load()
  }, [projectId, loaded, load])

  if (!projectId) return null

  const onPick = async (id: string): Promise<void> => {
    const k = keys.find((entry) => entry.id === id)
    if (!k || launchBlocker(k) || !k.launchCommand) return
    useWorkspace.getState().setProjectExpanded(projectId, true)
    await createProjectTerminal(projectId, {
      name: k.label,
      startupCommand: k.launchCommand,
    })
    close()
  }

  const toSettings = (): void => {
    close()
    openSettings()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="w-[26rem] rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">Use other models</h2>

        {keys.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              No models added yet. Add a provider API key first.
            </p>
            <button
              type="button"
              onClick={toSettings}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              Open settings
            </button>
          </div>
        ) : (
          <>
            <div className="max-h-72 space-y-1 overflow-auto">
              {keys.map((k) => {
                const blocker = launchBlocker(k)
                return (
                  <button
                    key={k.id}
                    type="button"
                    disabled={!!blocker}
                    onClick={() => void onPick(k.id)}
                    title={blocker ?? `Runs: ${k.launchCommand}`}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-sm font-medium">{k.label}</span>
                      <span className="ml-2 text-xs text-muted">
                        {presetById(k.provider)?.name ?? k.provider}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {blocker ?? k.launchCommand}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={toSettings}
                className="text-xs text-link hover:underline"
              >
                Manage models…
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5:** In `src/app.tsx`:

Add imports:

```tsx
import { ModelPicker } from './components/apikeys/model-picker'
import { useApiKeys } from './state/apikeys'
```

Render `<ModelPicker />` on the line after `<IdentityAutoApply />` (~line 349).

Extend `EmptyState` (bottom of the file) with a tertiary button — add to the props destructuring and type:

```tsx
  tertiaryLabel,
  onTertiary,
```

```tsx
  tertiaryLabel?: string
  onTertiary?: () => void
```

and after the secondary button block:

```tsx
          {tertiaryLabel && onTertiary && (
            <button
              type="button"
              onClick={onTertiary}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground/5"
            >
              {tertiaryLabel}
            </button>
          )}
```

In the `showEmptyNoTerminals` `<EmptyState>` (~line 276), add after `onSecondary={…}`:

```tsx
                tertiaryLabel="Use other models"
                onTertiary={() =>
                  selectedProject && useApiKeys.getState().openLauncher(selectedProject.id)
                }
```

- [ ] **Step 6:** In `src/components/sidebar/project-list.tsx`:

Add the import:

```tsx
import { useApiKeys } from '../../state/apikeys'
```

In `menuItems`, insert after the second "Claude Code" item (the ⇧D one, before "Rename"):

```tsx
    {
      label: 'Use other models…',
      onClick: () => expandAnd(() => useApiKeys.getState().openLauncher(project.id)),
    },
```

- [ ] **Step 7:** Verify from repo root: `pnpm test` (13 pass), `pnpm typecheck` (clean), `pnpm build` (succeeds).

- [ ] **Step 8:** Commit:

```bash
git add src/lib/apikey-presets.ts src/lib/apikey-presets.test.ts src/state/apikeys.ts src/components/apikeys/model-picker.tsx src/app.tsx src/components/sidebar/project-list.tsx
git commit -m "feat(apikeys): 'Use other models' picker — launch any saved provider from the project menu or empty state"
```
