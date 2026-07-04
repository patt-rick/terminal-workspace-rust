# Provider Launch Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click launch of the right CLI per saved provider key — a ▶ Launch button opens a new terminal in the selected project running the entry's launch command, with the key already injected.

**Architecture:** Add an optional `launchCommand` to the `ApiKey` model (backward compatible). Presets prefill it; the settings UI exposes it and a Launch button that calls the existing `createProjectTerminal` helper. No new spawn machinery.

**Tech Stack:** Rust (serde), React/Zustand/vitest. Gates: `cargo test` (from `src-tauri/`), `pnpm test`, `pnpm typecheck` (repo root). Commits without `Co-Authored-By` trailer.

**Spec:** `docs/superpowers/specs/2026-07-03-multi-llm-provider-keys-design.md` — see the Addendum section.

---

### Task A: Backend — optional `launch_command` field

**Files:**
- Modify: `src-tauri/src/apikeys/mod.rs`
- Modify: `src-tauri/src/commands.rs` (`apikeys_import_env`)

- [ ] **Step 1 (TDD red):** Append inside `mod tests` in `src-tauri/src/apikeys/mod.rs`:

```rust
    #[test]
    fn launch_command_roundtrips_and_defaults_to_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        {
            let store = ApiKeyStore::new(path.clone());
            let mut k = key("a", "OPENAI_API_KEY", true);
            k.launch_command = Some("codex".to_string());
            store.save(k, None).unwrap();
        }
        let store = ApiKeyStore::new(path.clone());
        assert_eq!(
            store.keys_snapshot()[0].launch_command.as_deref(),
            Some("codex")
        );

        // Entries persisted before the field existed load as None.
        fs::write(
            &path,
            r#"{"keys":[{"id":"b","provider":"openai","label":"b","keyEnvVar":"OPENAI_API_KEY","extraEnv":{},"enabled":true}]}"#,
        )
        .unwrap();
        let store = ApiKeyStore::new(path);
        assert_eq!(store.keys_snapshot()[0].launch_command, None);
    }
```

Run `cargo test apikeys` — expect compile FAILURE (`launch_command` field missing; also the `key()` helper and other `ApiKey` literals don't have it yet).

- [ ] **Step 2 (TDD green):** In the `ApiKey` struct, add after `extra_env`:

```rust
    /// Optional command auto-run in a terminal launched for this entry
    /// (e.g. `aider --model deepseek/deepseek-chat`). Serialized as null when
    /// absent so the frontend type is always `string | null`, never undefined.
    #[serde(default)]
    pub launch_command: Option<String>,
    pub enabled: bool,
```

(i.e. the field sits between `extra_env` and `enabled`; `enabled` itself is unchanged.)

Update the `key()` test helper to include `launch_command: None`, and in `src-tauri/src/commands.rs::apikeys_import_env`:
- add a parameter `launch_command: Option<String>` (after `label`)
- set `launch_command` in the constructed `ApiKey` (replacing nothing — it's a new field; `extra_env: Default::default()` stays).

Run `cargo test apikeys` — expected: 14 tests pass. Then `cargo check` — clean.

- [ ] **Step 3:** Commit:

```bash
git add src-tauri/src/apikeys/mod.rs src-tauri/src/commands.rs
git commit -m "feat(apikeys): optional per-entry launch command"
```

---

### Task B: Frontend — preset prefills, form field, Launch button

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/lib/apikey-presets.ts`
- Modify: `src/lib/apikey-presets.test.ts`
- Modify: `src/state/apikeys.ts`
- Modify: `src/components/apikeys/providers-section.tsx`

- [ ] **Step 1 (TDD red):** In `src/lib/apikey-presets.test.ts`, add to the `presets` describe block:

```ts
  it('prefills a launch command for every non-custom preset', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'custom') expect(p.launchCommand).toBe('')
      else expect(p.launchCommand.length).toBeGreaterThan(0)
    }
    expect(presetById('deepseek')?.launchCommand).toBe('aider --model deepseek/deepseek-chat')
  })
```

Run `pnpm test` — expect FAILURE (`launchCommand` missing on `ProviderPreset`).

- [ ] **Step 2 (TDD green):** In `src/lib/apikey-presets.ts`, add `launchCommand: string` to the `ProviderPreset` interface (after `extraEnv`), and to each preset:

| preset | launchCommand |
|---|---|
| anthropic | `claude` |
| openai | `codex` |
| deepseek | `aider --model deepseek/deepseek-chat` |
| qwen | `aider --model openai/qwen-plus` |
| custom | `''` (empty) |

Run `pnpm test` — expected: 12 tests pass.

- [ ] **Step 3:** In `src/lib/ipc.ts`, add to `ApiKeyMeta` after `extraEnv`:

```ts
  /** command auto-run in a terminal launched for this entry */
  launchCommand: string | null
```

And change the `importEnv` wrapper to pass it through:

```ts
    importEnv: (envVar: string, provider: string, label: string, launchCommand: string | null) =>
      invoke<ApiKeyMeta[]>('apikeys_import_env', { envVar, provider, label, launchCommand }),
```

In `src/state/apikeys.ts`, update the `importEnv` signature to match and forward the extra argument:

```ts
  importEnv: (envVar: string, provider: string, label: string, launchCommand: string | null) => Promise<void>
```

```ts
  importEnv: async (envVar, provider, label, launchCommand) => {
    const keys = await ipc.apikeys.importEnv(envVar, provider, label, launchCommand)
    // The imported var is stored now, so it drops out of the candidates.
    const detected = await ipc.apikeys.detectEnv()
    set({ keys, detected })
  },
```

- [ ] **Step 4:** In `src/components/apikeys/providers-section.tsx`:

Add imports at the top:

```tsx
import { createProjectTerminal, useWorkspace } from '../../state/store'
import { useUi } from '../../state/ui'
```

(Verify the actual export names in `src/state/store.ts` / `src/state/ui.ts` before using — `useWorkspace` is the store created there and `useUi` exposes `closeSettings`. If the workspace store has a different export name, use that.)

Extend `Draft` with `launchCommand: string` (after `extraEnv`), and:
- `draftFromPreset`: `launchCommand: p.launchCommand,`
- `draftFromEntry`: `launchCommand: k.launchCommand ?? '',`
- `entryFromDraft`: `launchCommand: d.launchCommand.trim() || null,`
- `applyPreset`: also set `launchCommand: p.launchCommand,`

In the component body add:

```tsx
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const closeSettings = useUi((s) => s.closeSettings)

  const onLaunch = async (k: ApiKeyMeta): Promise<void> => {
    if (!selectedProjectId || !k.launchCommand) return
    await createProjectTerminal(selectedProjectId, {
      name: k.label,
      startupCommand: k.launchCommand,
    })
    closeSettings()
  }
```

In the entry row, insert a Launch button before the Test button:

```tsx
                <button
                  type="button"
                  disabled={!k.enabled || !k.hasValue || !k.launchCommand || !selectedProjectId}
                  onClick={() => void onLaunch(k)}
                  title={
                    !selectedProjectId
                      ? 'Select a project first'
                      : !k.launchCommand
                        ? 'Set a launch command on this entry'
                        : !k.hasValue
                          ? 'No API key stored'
                          : !k.enabled
                            ? 'Entry is disabled'
                            : `Open a terminal running: ${k.launchCommand}`
                  }
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
                >
                  ▶ Launch
                </button>
```

In the add/edit form, insert after the "Key env var" field:

```tsx
          <Field
            label="Launch command (runs in the new terminal)"
            value={draft.launchCommand}
            onChange={(v) => setDraft({ ...draft, launchCommand: v })}
            placeholder="aider --model deepseek/deepseek-chat"
          />
```

Update `onImport` to pass the preset's launch command:

```tsx
  const onImport = async (envVar: string): Promise<void> => {
    const preset = PROVIDER_PRESETS.find((p) => p.keyEnvVar === envVar)
    await importEnv(envVar, preset?.id ?? 'custom', preset?.name ?? envVar, preset?.launchCommand || null)
  }
```

- [ ] **Step 5:** Verify from repo root: `pnpm test` (12 pass) and `pnpm typecheck` (clean). From `src-tauri/`: `cargo test` still green (95 + 1 = 96).

- [ ] **Step 6:** Commit:

```bash
git add src/lib/ipc.ts src/lib/apikey-presets.ts src/lib/apikey-presets.test.ts src/state/apikeys.ts src/components/apikeys/providers-section.tsx
git commit -m "feat(apikeys): per-provider Launch button — one-click CLI terminal with key injected"
```
