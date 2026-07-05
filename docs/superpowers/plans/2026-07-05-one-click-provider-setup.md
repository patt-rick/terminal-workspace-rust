# One-Click Provider Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pick a provider, paste an API key, launch — the app fills in everything else, offers to install a missing CLI, shows only ready providers in the picker, and stops sticking labels on "Anthropic / Claude".

**Architecture:** Presets in `src/lib/apikey-presets.ts` grow `binaryName` + `installCommand` and cover 9 providers + Custom. A new dependency-free `binary_exists` Tauri command checks PATH. Launch goes through one Zustand action (`requestLaunch`) that either launches directly or opens an install-confirm modal which chains `<install> ; <launch>` in a visible terminal (`;` is sequential in PowerShell, bash, and zsh — the app's default shells). The add-key form shows only preset + API key, with everything else prefilled behind an Advanced toggle.

**Tech Stack:** React 19 + Zustand + vitest (frontend), Tauri 2 + Rust (backend, `cargo test`). No new dependencies (the repo deliberately avoids new crate downloads — see the `ring` comment in `src-tauri/Cargo.toml`).

**Spec:** `docs/superpowers/specs/2026-07-05-one-click-provider-setup-design.md`

**Verification commands** (run from repo root unless noted):
- Frontend tests: `npm test` (vitest run)
- Typecheck: `npm run typecheck`
- Backend tests: `cargo test` (run inside `src-tauri/`)

---

## File map

| File | Change |
|---|---|
| `src/lib/apikey-presets.ts` | Expanded presets, `binaryName`/`installCommand` fields, helpers `nextLabel`, `binaryFromCommand`, `withInstall` |
| `src/lib/apikey-presets.test.ts` | Tests for the above |
| `src-tauri/src/apikeys/mod.rs` | `default_base()` per-provider test URLs; `binary_on_path()` + `find_in_paths()` |
| `src-tauri/src/commands.rs` | `binary_exists` command |
| `src-tauri/src/lib.rs` | Register `binary_exists` |
| `src/lib/ipc.ts` | `binaryExists` wrapper; refresh provider-id comment |
| `src/state/apikeys.ts` | `pendingInstall` state, `requestLaunch` / `confirmInstall` / `cancelInstall` actions |
| `src/components/apikeys/install-prompt.tsx` | New confirm modal |
| `src/app.tsx` | Render `<InstallPrompt />` |
| `src/components/apikeys/model-picker.tsx` | Filter to launchable entries; launch via `requestLaunch` |
| `src/components/apikeys/providers-section.tsx` | Simple form + Advanced toggle; label fix via `nextLabel`; launch via `requestLaunch` |
| `docs/multi-llm-provider-keys.md` | Update preset table + status |

---

### Task 1: Presets + pure helpers

**Files:**
- Modify: `src/lib/apikey-presets.ts`
- Test: `src/lib/apikey-presets.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/apikey-presets.test.ts` (extend the existing import line to include the new symbols):

```ts
import {
  binaryFromCommand,
  envConflicts,
  launchBlocker,
  nextLabel,
  presetById,
  PROVIDER_PRESETS,
  withInstall,
} from './apikey-presets'
```

New test blocks at the end of the file:

```ts
describe('expanded presets', () => {
  it('covers the common providers', () => {
    for (const id of [
      'anthropic',
      'openai',
      'gemini',
      'deepseek',
      'grok',
      'mistral',
      'groq',
      'openrouter',
      'qwen',
      'custom',
    ])
      expect(presetById(id), id).toBeDefined()
  })

  it('every non-custom preset is launchable out of the box', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'custom') {
        expect(p.binaryName).toBeNull()
        expect(p.installCommand).toBeNull()
        continue
      }
      expect(p.launchCommand.length, p.id).toBeGreaterThan(0)
      expect(p.binaryName, p.id).toBe(binaryFromCommand(p.launchCommand))
      expect(p.installCommand?.length, p.id).toBeGreaterThan(0)
      expect(p.keyEnvVar, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('aider-based presets need no base-URL extra env (litellm reads native keys)', () => {
    for (const id of ['deepseek', 'grok', 'mistral', 'groq', 'openrouter'])
      expect(presetById(id)?.extraEnv).toEqual({})
  })
})

describe('nextLabel', () => {
  const openai = presetById('openai')!
  it('replaces empty and preset-default labels on preset switch', () => {
    expect(nextLabel('', openai)).toBe(openai.name)
    expect(nextLabel('  ', openai)).toBe(openai.name)
    expect(nextLabel('Anthropic / Claude', openai)).toBe(openai.name)
  })
  it('keeps a customized label', () => {
    expect(nextLabel('work key', openai)).toBe('work key')
  })
})

describe('binaryFromCommand', () => {
  it('returns the first token, unquoted', () => {
    expect(binaryFromCommand('aider --model deepseek/deepseek-chat')).toBe('aider')
    expect(binaryFromCommand('codex')).toBe('codex')
    expect(binaryFromCommand('"my tool" --flag')).toBe('my')
    expect(binaryFromCommand("'aider' --x")).toBe('aider')
    expect(binaryFromCommand('   ')).toBeNull()
  })
})

describe('withInstall', () => {
  it('chains install and launch with ";"', () => {
    expect(withInstall('npm install -g @openai/codex', 'codex')).toBe(
      'npm install -g @openai/codex ; codex'
    )
  })
})
```

(Note on `binaryFromCommand('"my tool" --flag')` → `'my'`: quoted multi-word executables aren't supported by the naive split; the check fails open downstream, so this is acceptable and the test documents it.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — `nextLabel`, `binaryFromCommand`, `withInstall` are not exported; preset ids `gemini`/`grok`/… unresolved.

- [ ] **Step 3: Implement**

In `src/lib/apikey-presets.ts`, replace the `ProviderPreset` interface and `PROVIDER_PRESETS` with:

```ts
export interface ProviderPreset {
  id: string
  name: string
  /** which auth check the backend runs; anthropic vs OpenAI-compatible */
  wire: 'anthropic' | 'openai'
  keyEnvVar: string
  extraEnv: Record<string, string>
  launchCommand: string
  /** executable looked up on PATH before launch; null = no check (custom) */
  binaryName: string | null
  /** command that installs binaryName when it's missing; null = none known */
  installCommand: string | null
}

/** aider's official installer; `;` is sequential in PowerShell, bash and zsh. */
const AIDER_INSTALL = 'python -m pip install aider-install ; aider-install'

/**
 * Presets only prefill the add-form; storage is fully generic, so any
 * OpenAI-compatible provider (Together, local vLLM, …) works via "custom"
 * with a base URL. aider presets rely on litellm's native provider prefixes
 * (deepseek/, xai/, mistral/, groq/, openrouter/) which read each provider's
 * own key env var — no OPENAI_BASE_URL juggling.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    wire: 'anthropic',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    extraEnv: {},
    launchCommand: 'claude',
    binaryName: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'openai',
    name: 'OpenAI / ChatGPT',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: {},
    launchCommand: 'codex',
    binaryName: 'codex',
    installCommand: 'npm install -g @openai/codex',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    wire: 'openai',
    keyEnvVar: 'GEMINI_API_KEY',
    extraEnv: {},
    launchCommand: 'gemini',
    binaryName: 'gemini',
    installCommand: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model deepseek/deepseek-chat',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    wire: 'openai',
    keyEnvVar: 'XAI_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model xai/grok-4',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    wire: 'openai',
    keyEnvVar: 'MISTRAL_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model mistral/mistral-large-latest',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'openai',
    keyEnvVar: 'GROQ_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model groq/llama-3.3-70b-versatile',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'openai',
    keyEnvVar: 'OPENROUTER_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model openrouter/openrouter/auto',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'qwen',
    name: 'Qwen',
    wire: 'openai',
    keyEnvVar: 'DASHSCOPE_API_KEY',
    extraEnv: {},
    launchCommand: 'qwen',
    binaryName: 'qwen',
    installCommand: 'npm install -g @qwen-code/qwen-code',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: { OPENAI_BASE_URL: '' },
    launchCommand: '',
    binaryName: null,
    installCommand: null,
  },
]
```

Keep `presetById`, `envConflicts`, `launchBlocker` unchanged. Append the helpers:

```ts
const DEFAULT_LABELS = new Set(PROVIDER_PRESETS.map((p) => p.name))

/**
 * Label to show after switching the preset dropdown: preset-default labels
 * follow the selected preset; anything the user typed sticks.
 */
export function nextLabel(current: string, preset: ProviderPreset): string {
  const c = current.trim()
  return !c || DEFAULT_LABELS.has(c) ? preset.name : c
}

/** First whitespace-separated token, unquoted — the executable to look up. */
export function binaryFromCommand(cmd: string): string | null {
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  const bare = first.replace(/^["']|["']$/g, '')
  return bare || null
}

/** Startup command that installs the CLI, then launches it, in one terminal. */
export function withInstall(installCommand: string, launchCommand: string): string {
  return `${installCommand} ; ${launchCommand}`
}
```

Note: the old `qwen` preset carried `OPENAI_BASE_URL` extra env and an aider launch command. Saved entries are self-contained (they store their own env + launch command), so this change only affects newly created entries.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (all files). The existing `prefills a launch command for every non-custom preset` test still passes because deepseek's command is unchanged.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. (Nothing else consumes the new fields yet; the interface change is additive.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/apikey-presets.ts src/lib/apikey-presets.test.ts
git commit -m "feat(apikeys): expand provider presets with install metadata and label helper"
```

---

### Task 2: Backend — per-provider test bases + `binary_exists`

**Files:**
- Modify: `src-tauri/src/apikeys/mod.rs`
- Modify: `src-tauri/src/commands.rs` (after `apikeys_import_env`, ~line 916)
- Modify: `src-tauri/src/lib.rs` (handler list, after `commands::apikeys_import_env,` at line 174)

- [ ] **Step 1: Write the failing tests**

In the `mod tests` block of `src-tauri/src/apikeys/mod.rs`, add:

```rust
#[test]
fn test_request_uses_provider_default_base() {
    let cases = [
        ("deepseek", "https://api.deepseek.com/models"),
        ("grok", "https://api.x.ai/v1/models"),
        ("mistral", "https://api.mistral.ai/v1/models"),
        ("groq", "https://api.groq.com/openai/v1/models"),
        ("openrouter", "https://openrouter.ai/api/v1/models"),
        ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/models"),
        ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1/models"),
        ("custom", "https://api.openai.com/v1/models"),
    ];
    for (provider, url) in cases {
        assert_eq!(build_test_request(provider, None, "sk-x").url, url, "{provider}");
    }
}

#[test]
fn find_in_paths_matches_pathext_and_bare_files() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("aider.cmd"), "").unwrap();
    fs::write(dir.path().join("rg"), "").unwrap();
    let dirs = || vec![dir.path().to_path_buf()].into_iter();
    assert!(find_in_paths("aider", dirs(), ".COM;.EXE;.BAT;.CMD"));
    assert!(find_in_paths("rg", dirs(), ".COM;.EXE;.BAT;.CMD")); // bare file
    assert!(find_in_paths("rg", dirs(), ""));
    assert!(!find_in_paths("codex", dirs(), ".COM;.EXE;.BAT;.CMD"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in `src-tauri/`): `cargo test apikeys`
Expected: compile FAIL — `find_in_paths` not found; `test_request_uses_provider_default_base` fails for `grok`/`groq`/… (they'd hit `api.openai.com`).

- [ ] **Step 3: Implement in `apikeys/mod.rs`**

Add above `build_test_request`:

```rust
/// Default API base for the reachability test, for presets whose CLIs read the
/// provider's native key env var (so entries carry no *_BASE_URL). An entry's
/// explicit *_BASE_URL extra env still wins.
fn default_base(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "https://api.deepseek.com",
        "grok" => "https://api.x.ai/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        _ => "https://api.openai.com/v1",
    }
}
```

In `build_test_request`'s else-branch, change

```rust
        let base = base_url
            .unwrap_or("https://api.openai.com/v1")
            .trim_end_matches('/');
```

to

```rust
        let base = base_url.unwrap_or_else(|| default_base(provider)).trim_end_matches('/');
```

Add near the other pure helpers (above the `tests` module):

```rust
/// True when `name` resolves to a file on PATH. Windows also tries PATHEXT
/// suffixes (an npm shim `codex` on disk is `codex.cmd`). Fails open — any
/// resolution problem returns true so the check can never block a launch.
pub fn binary_on_path(name: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return true;
    };
    let pathext = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
    } else {
        String::new()
    };
    find_in_paths(name, std::env::split_paths(&paths), &pathext)
}

fn find_in_paths(
    name: &str,
    dirs: impl Iterator<Item = PathBuf>,
    pathext: &str,
) -> bool {
    let exts: Vec<String> = std::iter::once(String::new())
        .chain(
            pathext
                .split(';')
                .filter(|e| !e.is_empty())
                .map(|e| e.to_ascii_lowercase()),
        )
        .collect();
    for dir in dirs {
        for ext in &exts {
            if dir.join(format!("{name}{ext}")).is_file() {
                return true;
            }
        }
    }
    false
}
```

(`PathBuf` is already imported at the top of the file.)

- [ ] **Step 4: Add the command in `commands.rs`**

After `apikeys_import_env` (before the `remote access` section):

```rust
/// PATH lookup for a CLI binary, used by the prompt-then-install launch flow.
#[tauri::command]
pub fn binary_exists(name: String) -> bool {
    crate::apikeys::binary_on_path(&name)
}
```

- [ ] **Step 5: Register in `lib.rs`**

In the `generate_handler![]` list, after `commands::apikeys_import_env,`:

```rust
            commands::binary_exists,
```

- [ ] **Step 6: Run backend tests**

Run (in `src-tauri/`): `cargo test`
Expected: PASS, including the two new tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/apikeys/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(apikeys): binary_exists command and per-provider test base URLs"
```

---

### Task 3: IPC wrapper + launch flow in the store + install prompt modal

**Files:**
- Modify: `src/lib/ipc.ts`
- Modify: `src/state/apikeys.ts`
- Create: `src/components/apikeys/install-prompt.tsx`
- Modify: `src/app.tsx`

No new unit tests here: the pure pieces (`binaryFromCommand`, `withInstall`, preset lookup) are covered by Task 1; the store action is IPC-glue verified by typecheck + the manual pass in Task 6.

- [ ] **Step 1: `ipc.ts`**

In the `apikeys` group, after `importEnv`:

```ts
    /** PATH lookup for a CLI binary (prompt-then-install launch flow). */
    binaryExists: (name: string) => invoke<boolean>('binary_exists', { name }),
```

Also update the stale comment on `ApiKeyMeta.provider` (line ~263) to:

```ts
  /** preset id: anthropic | openai | gemini | deepseek | grok | mistral | groq | openrouter | qwen | custom */
```

- [ ] **Step 2: `state/apikeys.ts` — pending install + requestLaunch**

Add imports at the top:

```ts
import { binaryFromCommand, presetById, withInstall } from '../lib/apikey-presets'
import { createProjectTerminal, useWorkspace } from './store'
```

(`state/store.ts` does not import `state/apikeys.ts`, so this adds no cycle.)

Extend the interface:

```ts
  /** launch blocked on a missing CLI, awaiting the user's install decision */
  pendingInstall: {
    projectId: string
    entry: ApiKeyMeta
    binary: string
    installCommand: string
  } | null

  /**
   * Launch an entry's CLI in a new terminal. When the binary is missing and
   * the preset knows an installer, opens the install prompt instead.
   */
  requestLaunch: (projectId: string, entry: ApiKeyMeta) => Promise<void>
  confirmInstall: () => Promise<void>
  cancelInstall: () => void
```

Change the store factory to `create<ApiKeysState>((set, get) => ({`, add `pendingInstall: null,` to the initial state, and add the actions:

```ts
  requestLaunch: async (projectId, entry) => {
    if (!entry.launchCommand) return
    const binary = binaryFromCommand(entry.launchCommand)
    const installCommand = presetById(entry.provider)?.installCommand ?? null
    if (binary && installCommand && !(await ipc.apikeys.binaryExists(binary))) {
      set({ pendingInstall: { projectId, entry, binary, installCommand } })
      return
    }
    await launchTerminal(projectId, entry.label, entry.launchCommand)
  },

  confirmInstall: async () => {
    const p = get().pendingInstall
    if (!p?.entry.launchCommand) return
    set({ pendingInstall: null })
    await launchTerminal(
      p.projectId,
      p.entry.label,
      withInstall(p.installCommand, p.entry.launchCommand)
    )
  },

  cancelInstall: () => set({ pendingInstall: null }),
```

Module-level helper (below the store):

```ts
async function launchTerminal(
  projectId: string,
  name: string,
  startupCommand: string
): Promise<void> {
  useWorkspace.getState().setProjectExpanded(projectId, true)
  await createProjectTerminal(projectId, { name, startupCommand })
}
```

- [ ] **Step 3: Create `src/components/apikeys/install-prompt.tsx`**

```tsx
import { useApiKeys } from '../../state/apikeys'

/**
 * Confirm dialog shown when a provider's CLI is missing from PATH: on confirm
 * the new terminal runs the installer, then the CLI, in sequence — visibly.
 */
export function InstallPrompt() {
  const pending = useApiKeys((s) => s.pendingInstall)
  const confirm = useApiKeys((s) => s.confirmInstall)
  const cancel = useApiKeys((s) => s.cancelInstall)

  if (!pending) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={cancel}
    >
      <div
        className="w-[26rem] rounded-lg border border-border bg-surface p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold">
          <code>{pending.binary}</code> isn't installed
        </h2>
        <p className="mb-1 text-xs text-muted">
          {pending.entry.label} launches <code>{pending.entry.launchCommand}</code>, but{' '}
          <code>{pending.binary}</code> wasn't found on your PATH.
        </p>
        <p className="mb-3 text-xs text-muted">
          Install it now? The new terminal will run{' '}
          <code className="break-all">{pending.installCommand}</code> and then start the CLI.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            Install &amp; launch
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Render it in `src/app.tsx`**

Add the import next to the ModelPicker import (line ~10):

```ts
import { InstallPrompt } from './components/apikeys/install-prompt'
```

Render it on the line after `<ModelPicker />` (~line 356):

```tsx
      <InstallPrompt />
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` then `npm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ipc.ts src/state/apikeys.ts src/components/apikeys/install-prompt.tsx src/app.tsx
git commit -m "feat(apikeys): prompt-then-install launch flow"
```

---

### Task 4: Picker shows only ready entries

**Files:**
- Modify: `src/components/apikeys/model-picker.tsx`

- [ ] **Step 1: Rewrite the component body**

Replace the `onPick` handler and the list rendering:

```tsx
import { useEffect } from 'react'
import { launchBlocker, presetById } from '../../lib/apikey-presets'
import { useApiKeys } from '../../state/apikeys'
import { useUi } from '../../state/ui'
```

(`createProjectTerminal`/`useWorkspace` imports are no longer needed here.)

Inside the component, after the existing hooks, add the launch action and the filter:

```tsx
  const requestLaunch = useApiKeys((s) => s.requestLaunch)
  ...
  const ready = keys.filter((k) => !launchBlocker(k))
```

`onPick` becomes:

```tsx
  const onPick = async (id: string): Promise<void> => {
    const k = ready.find((entry) => entry.id === id)
    if (!k) return
    close()
    await requestLaunch(projectId, k)
  }
```

The empty state triggers on `ready.length === 0` (covers both "no keys at all" and "none launchable"), with copy:

```tsx
        {ready.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              No providers are set up yet. Add a provider API key first.
            </p>
            ...unchanged "Open settings" button...
          </div>
        ) : (
```

The list maps over `ready` instead of `keys`; the `blocker` variable, the `disabled` prop, and the blocker-dependent `title`/subtitle disappear:

```tsx
              {ready.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => void onPick(k.id)}
                  title={`Runs: ${k.launchCommand}`}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-foreground/5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{k.label}</span>
                    <span className="ml-2 text-xs text-muted">
                      {presetById(k.provider)?.name ?? k.provider}
                    </span>
                    <span className="block truncate text-xs text-muted">{k.launchCommand}</span>
                  </span>
                </button>
              ))}
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck` then `npm test`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/apikeys/model-picker.tsx
git commit -m "feat(apikeys): model picker lists only ready-to-launch providers"
```

---

### Task 5: Simplified add form + label fix

**Files:**
- Modify: `src/components/apikeys/providers-section.tsx`

- [ ] **Step 1: Draft gains an `advanced` flag**

Add to the `Draft` interface:

```ts
  /** UI-only: show label/env/launch fields (auto-on for custom) */
  advanced: boolean
```

`draftFromPreset` sets `advanced: p.id === 'custom'`; `draftFromEntry` sets `advanced: false`. `entryFromDraft` is unchanged (`advanced` is simply not copied).

- [ ] **Step 2: Fix the sticky label in `applyPreset`**

```ts
  const applyPreset = (presetId: string): void => {
    if (!draft) return
    const p = presetById(presetId)
    if (!p) return
    setDraft({
      ...draft,
      provider: p.id,
      label: nextLabel(draft.label, p),
      keyEnvVar: p.keyEnvVar,
      extraEnv: Object.entries(p.extraEnv).map(([name, value]) => ({ name, value })),
      launchCommand: p.launchCommand,
      advanced: draft.advanced || p.id === 'custom',
    })
  }
```

Import `nextLabel` from `../../lib/apikey-presets` (extend the existing import).

- [ ] **Step 3: Collapse the form behind an Advanced toggle**

In the add/edit form JSX, keep the preset `<select>` and the API-key password field always visible. Wrap the Label field, Key-env-var field, Launch-command field, and the Extra-env block in:

```tsx
          <button
            type="button"
            onClick={() => setDraft({ ...draft, advanced: !draft.advanced })}
            className="self-start text-xs text-link hover:underline"
          >
            {draft.advanced ? 'Hide advanced' : 'Advanced…'}
          </button>
          {draft.advanced && (
            <>
              ...Label field...
              ...Key env var field...
              ...Launch command field...
              ...Extra env block...
            </>
          )}
```

Place the toggle button between the API-key field and the Save/Cancel row. Field order inside the advanced block: Label, Key env var, Launch command, Extra env (same fields as today, unchanged markup).

- [ ] **Step 4: Launch goes through `requestLaunch`**

Replace `onLaunch`:

```tsx
  const requestLaunch = useApiKeys((s) => s.requestLaunch)

  const onLaunch = async (k: ApiKeyMeta): Promise<void> => {
    if (!selectedProjectId || !k.launchCommand) return
    closeSettings()
    await requestLaunch(selectedProjectId, k)
  }
```

(`createProjectTerminal`/`useWorkspace` stay imported — `useWorkspace` is still used for `selectedProjectId`; drop the now-unused `createProjectTerminal` import.)

- [ ] **Step 5: Verify**

Run: `npm run typecheck` then `npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/apikeys/providers-section.tsx
git commit -m "feat(apikeys): one-field add form with advanced toggle; fix sticky preset label"
```

---

### Task 6: Docs + end-to-end verification

**Files:**
- Modify: `docs/multi-llm-provider-keys.md` (§8 preset table)

- [ ] **Step 1: Update the preset table in `docs/multi-llm-provider-keys.md` §8**

Replace the table with the 10-preset version (columns: Preset, Key env var, Launch command, Install command) matching `apikey-presets.ts`, and add one sentence: "Launch checks the CLI binary on PATH first and offers a prompt-then-install flow (`<install> ; <launch>`) when it's missing."

- [ ] **Step 2: Full test pass**

Run: `npm test && npm run typecheck`, and `cargo test` in `src-tauri/`.
Expected: all green.

- [ ] **Step 3: Manual smoke test (dev app)**

Run: `npm run tauri dev`
1. Settings → AI providers → + Add key: only preset dropdown + API key visible; switching preset updates the label shown after save (add a Groq entry — label must read "Groq", not "Anthropic / Claude").
2. "Use other models" picker: only entries with a stored key appear.
3. Launch an entry whose CLI is not installed (e.g. `qwen`): install prompt appears; Confirm opens a terminal running the installer then the CLI; Cancel does nothing.
4. Launch an installed CLI: opens directly, no prompt.

- [ ] **Step 4: Commit**

```bash
git add docs/multi-llm-provider-keys.md
git commit -m "docs: update provider preset table for one-click setup"
```
