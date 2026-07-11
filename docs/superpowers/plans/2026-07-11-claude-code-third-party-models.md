# Claude Code on Third-Party Models — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users launch Claude Code against Anthropic-compatible third-party endpoints (DeepSeek, Kimi, GLM, OpenRouter, local Ollama) via launch-scoped provider presets, without hijacking normal `claude` sessions.

**Architecture:** Provider-key entries gain an injection `scope` (`global` = today's inject-everywhere, `launch` = only the terminal launched from that entry). New "X (Claude Code)" presets carry `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/model env and launch `claude`. Preset-default `extraEnv` drift gets a warning + reset system mirroring the existing `LEGACY_LAUNCH_COMMANDS` upgrade machinery.

**Tech Stack:** Rust (Tauri 2, serde, keyring), React 19 + Zustand, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-07-11-claude-code-third-party-models-design.md`

**Repo conventions:** commit directly to `master`, no Co-Authored-By trailer, no code comments that merely restate the code. Run vitest with `pnpm test -- --run` (CI mode, no watch). Run Rust tests from `src-tauri/` with `cargo test`. If `cargo` linking fails, use `& "src-tauri/build-msvc.cmd" test` from PowerShell.

---

### Task 1: Rust backend — injection scope, per-launch env, anthropic-wire test probe

**Files:**
- Modify: `src-tauri/src/apikeys/mod.rs`
- Modify: `src-tauri/src/commands.rs` (lines ~107-156 `CreateTerminalArgs`/`terminal_create`, ~929 `apikeys_test`, ~967 `apikeys_import_env`)
- Tests: inline `#[cfg(test)] mod tests` in `src-tauri/src/apikeys/mod.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/apikeys/mod.rs` tests module, first update the existing `key()` fixture to include the new field (this is the only edit to existing tests besides `build_test_request` call sites in Step 3):

```rust
    fn key(id: &str, var: &str, enabled: bool) -> ApiKey {
        ApiKey {
            id: id.to_string(),
            provider: "custom".to_string(),
            label: id.to_string(),
            key_env_var: var.to_string(),
            extra_env: BTreeMap::new(),
            launch_command: None,
            enabled,
            scope: InjectionScope::Global,
        }
    }
```

Then add these tests:

```rust
    #[test]
    fn scope_defaults_to_global_on_legacy_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        fs::write(
            &path,
            r#"{"keys":[{"id":"a","provider":"openai","label":"a","keyEnvVar":"OPENAI_API_KEY","extraEnv":{},"enabled":true}]}"#,
        )
        .unwrap();
        let store = ApiKeyStore::new(path);
        assert_eq!(store.keys_snapshot()[0].scope, InjectionScope::Global);
    }

    #[test]
    fn scope_launch_roundtrips_through_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("keys.json");
        {
            let store = ApiKeyStore::new(path.clone());
            let mut k = key("a", "ANTHROPIC_AUTH_TOKEN", true);
            k.scope = InjectionScope::Launch;
            store.save(k, None).unwrap();
        }
        let store = ApiKeyStore::new(path);
        assert_eq!(store.keys_snapshot()[0].scope, InjectionScope::Launch);
    }

    #[test]
    fn expand_skips_launch_scoped_entries() {
        let mut launch = key("a", "ANTHROPIC_AUTH_TOKEN", true);
        launch.scope = InjectionScope::Launch;
        let keys = vec![launch, key("b", "GROQ_API_KEY", true)];
        let env = expand_env(&keys, |_| Some("sk-x".to_string()));
        assert_eq!(env, vec![("GROQ_API_KEY".to_string(), "sk-x".to_string())]);
    }

    #[test]
    fn launch_pairs_expands_one_entry_with_extra_env() {
        let mut k = key("a", "ANTHROPIC_AUTH_TOKEN", true);
        k.scope = InjectionScope::Launch;
        k.extra_env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://api.deepseek.com/anthropic".to_string(),
        );
        let env = launch_pairs(&k, |id| Some(format!("secret-{id}"))).unwrap();
        assert_eq!(
            env,
            vec![
                ("ANTHROPIC_AUTH_TOKEN".to_string(), "secret-a".to_string()),
                (
                    "ANTHROPIC_BASE_URL".to_string(),
                    "https://api.deepseek.com/anthropic".to_string()
                ),
            ]
        );
    }

    #[test]
    fn launch_pairs_errors_when_secret_missing() {
        let k = key("a", "ANTHROPIC_AUTH_TOKEN", true);
        assert!(launch_pairs(&k, |_| None).is_err());
    }

    #[test]
    fn test_request_anthropic_wire_probes_v1_models_with_both_auth_headers() {
        let r = build_test_request(
            "deepseek-claude",
            Some("https://api.deepseek.com/anthropic/"),
            "sk-x",
            true,
        );
        assert_eq!(r.url, "https://api.deepseek.com/anthropic/v1/models");
        assert!(r.headers.contains(&("x-api-key".to_string(), "sk-x".to_string())));
        assert!(r
            .headers
            .contains(&("Authorization".to_string(), "Bearer sk-x".to_string())));
        assert!(r
            .headers
            .iter()
            .any(|(k, v)| k == "anthropic-version" && !v.is_empty()));
    }
```

Also update the two existing `build_test_request` tests that exercise the anthropic branch and the non-anthropic branches to the new 4-argument signature (the 4th argument is `anthropic_wire`):
- `test_request_anthropic_uses_x_api_key`: `build_test_request("anthropic", None, "sk-ant-x", true)`
- `test_request_openai_defaults_to_openai_base`: `build_test_request("openai", None, "sk-x", false)`
- `test_request_respects_base_url_override_and_trailing_slash`: add `, false` to both calls
- `test_request_uses_provider_default_base`: add `, false` to both calls inside it

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src-tauri/`): `cargo test apikeys`
Expected: compile errors — `InjectionScope` not found, `scope` field missing, `launch_pairs` not found, `build_test_request` arity mismatch.

- [ ] **Step 3: Implement the backend changes**

In `src-tauri/src/apikeys/mod.rs`:

Add above `ApiKey` (after the `KEYRING_SERVICE` const is fine):

```rust
/// Where an entry's env pairs are injected: into every new terminal, or only
/// into a terminal launched from this entry (model picker / settings ▶ Launch).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InjectionScope {
    #[default]
    Global,
    Launch,
}
```

Add the field to `ApiKey` (after `enabled`):

```rust
    #[serde(default)]
    pub scope: InjectionScope,
```

Change the filter line in `expand_env` from
`for k in keys.iter().filter(|k| k.enabled) {` to:

```rust
    for k in keys
        .iter()
        .filter(|k| k.enabled && k.scope == InjectionScope::Global)
    {
```

Add below `expand_env`:

```rust
/// Env pairs for a single entry — the launch-scoped injection path. Unlike
/// `expand_env`, a missing secret is an error: the user explicitly launched
/// this entry, so silence would misroute the CLI to default credentials.
pub fn launch_pairs(
    k: &ApiKey,
    secret_for: impl Fn(&str) -> Option<String>,
) -> AppResult<Vec<(String, String)>> {
    let secret = secret_for(&k.id)
        .ok_or_else(|| AppError::Msg(format!("no API key stored for \"{}\"", k.label)))?;
    let mut out = vec![(k.key_env_var.clone(), secret)];
    for (name, val) in &k.extra_env {
        out.push((name.clone(), val.clone()));
    }
    Ok(out)
}
```

Add a store method after `resolved_env`:

```rust
    /// Env pairs for one entry by id, secrets from the keychain. Used at
    /// terminal-spawn time for entry-launched terminals (any scope).
    pub fn launch_env(&self, id: &str) -> AppResult<Vec<(String, String)>> {
        let k = {
            let d = self.inner.lock();
            d.keys
                .iter()
                .find(|k| k.id == id)
                .cloned()
                .ok_or_else(|| AppError::Msg("key not found".to_string()))?
        };
        launch_pairs(&k, keychain_secret)
    }
```

Change `test_inputs` to also report whether the entry is Anthropic-wire — return type becomes `AppResult<(String, Option<String>, String, bool)>`; add before `drop(d);`:

```rust
        let anthropic_wire = k.key_env_var.starts_with("ANTHROPIC_");
```

and return `Ok((provider, base, secret, anthropic_wire))`.

Change `build_test_request` to take the flag and branch on it instead of `provider == "anthropic"`:

```rust
pub fn build_test_request(
    provider: &str,
    base_url: Option<&str>,
    secret: &str,
    anthropic_wire: bool,
) -> TestRequest {
    if anthropic_wire {
        let base = base_url
            .unwrap_or("https://api.anthropic.com")
            .trim_end_matches('/');
        TestRequest {
            url: format!("{base}/v1/models"),
            headers: vec![
                ("x-api-key".to_string(), secret.to_string()),
                ("Authorization".to_string(), format!("Bearer {secret}")),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ],
        }
    } else if provider == "openrouter" && base_url.is_none() {
```

(the doc comment above it should say Anthropic-wire entries — key env var starting with `ANTHROPIC_` — hit `<base>/v1/models` with both `x-api-key` and a bearer token, since compatible endpoints differ in which they accept; the rest of the function is unchanged).

In `src-tauri/src/commands.rs`:

`CreateTerminalArgs` gains (after `rows`):

```rust
    /// provider-key entry whose env is injected into this terminal only
    pub apikey_entry_id: Option<String>,
}
```

In `terminal_create`, replace the `env:` line inside `CreateOpts { ... }` and hoist the value above `pty.create`:

```rust
    let mut env = app.state::<ApiKeyStore>().resolved_env();
    if let Some(kid) = &args.apikey_entry_id {
        env.extend(app.state::<ApiKeyStore>().launch_env(kid)?);
    }
```

and inside `CreateOpts`: `env,` (the `env_remove` line is unchanged).

In `apikeys_test`, update the destructure and call:

```rust
    let (provider, base, secret, anthropic_wire) = store.test_inputs(&id)?;
    let req =
        crate::apikeys::build_test_request(&provider, base.as_deref(), &secret, anthropic_wire);
```

In `apikeys_import_env`, add to the `ApiKey { ... }` literal:

```rust
        scope: Default::default(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `src-tauri/`): `cargo test`
Expected: all tests pass, including the 6 new ones. Then `cargo check` for the full binary (confirms `commands.rs` wiring compiles).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/apikeys/mod.rs src-tauri/src/commands.rs
git commit -m "feat(apikeys): injection scope + per-launch env + anthropic-wire test probe"
```

---

### Task 2: Frontend presets, drift system, and launch plumbing

**Files:**
- Modify: `src/lib/apikey-presets.ts`
- Modify: `src/lib/apikey-presets.test.ts`
- Modify: `src/lib/ipc.ts` (`CreateTerminalOptions` ~line 27, `ApiKeyMeta` ~line 290)
- Modify: `src/state/apikeys.ts`
- Modify: `src/state/store.ts` (`createProjectTerminal` ~line 333)

- [ ] **Step 1: Verify provider endpoint + model ids against live docs**

Use WebFetch/WebSearch to confirm, and substitute into Step 3's preset code if they differ (these are the research snapshot as of 2026-07-11):

| Preset | Verify against | Values to confirm |
|---|---|---|
| deepseek-claude | https://api-docs.deepseek.com/guides/anthropic_api | base `https://api.deepseek.com/anthropic`; current chat model id for `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| kimi-claude | https://platform.moonshot.ai/docs (Claude Code / Anthropic API guide) | base `https://api.moonshot.ai/anthropic`; current kimi model id |
| glm-claude | https://docs.z.ai (Claude Code guide) | base `https://api.z.ai/api/anthropic`; current GLM model id |
| openrouter-claude | https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration | base `https://openrouter.ai/api`; whether a model env default is recommended |
| ollama-claude | https://docs.ollama.com/api/anthropic-compatibility | base `http://localhost:11434`; a sensible default local model id |

If a page is unreachable, keep the snapshot value — the drift/reset system exists precisely so these can be corrected in a later release.

- [ ] **Step 2: Write the failing vitest tests**

In `src/lib/apikey-presets.test.ts`, update existing `envConflicts` test fixtures to include `scope: 'global' as const`, then add:

```ts
const CLAUDE_CODE_PRESET_IDS = [
  'deepseek-claude',
  'kimi-claude',
  'glm-claude',
  'openrouter-claude',
  'ollama-claude',
]

describe('claude-code presets', () => {
  it.each(CLAUDE_CODE_PRESET_IDS)('%s is a launch-scoped anthropic-wire claude launcher', (id) => {
    const p = presetById(id)!
    expect(p.wire).toBe('anthropic')
    expect(p.scope).toBe('launch')
    expect(p.keyEnvVar).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(p.launchCommand).toBe('claude')
    expect(p.check).toEqual({ kind: 'binary', name: 'claude' })
    expect(p.installCommand).toBe('npm install -g @anthropic-ai/claude-code')
    expect(p.extraEnv.ANTHROPIC_BASE_URL).toMatch(/^https?:\/\//)
    expect(p.extraEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
  })

  it('every preset declares a scope and existing presets stay global', () => {
    for (const p of PROVIDER_PRESETS) expect(['global', 'launch']).toContain(p.scope)
    expect(presetById('anthropic')!.scope).toBe('global')
    expect(presetById('deepseek')!.scope).toBe('global')
  })
})

describe('presetEnvDrift', () => {
  it('flags changed and missing preset-defaulted vars, ignores user-added vars', () => {
    const p = presetById('deepseek-claude')!
    expect(presetEnvDrift('deepseek-claude', { ...p.extraEnv })).toEqual([])
    const changed = { ...p.extraEnv, ANTHROPIC_MODEL: 'something-else' }
    expect(presetEnvDrift('deepseek-claude', changed)).toEqual(['ANTHROPIC_MODEL'])
    const { ANTHROPIC_BASE_URL: _, ...missing } = p.extraEnv
    expect(presetEnvDrift('deepseek-claude', missing)).toEqual(['ANTHROPIC_BASE_URL'])
    const extra = { ...p.extraEnv, MY_CUSTOM: 'x' }
    expect(presetEnvDrift('deepseek-claude', extra)).toEqual([])
  })

  it('never flags empty preset defaults or unknown providers', () => {
    expect(presetEnvDrift('custom', { OPENAI_BASE_URL: 'https://x' })).toEqual([])
    expect(presetEnvDrift('nope', { A: 'b' })).toEqual([])
  })
})

describe('upgradeExtraEnv', () => {
  it('returns the same reference when nothing matches a legacy snapshot', () => {
    const env = { ANTHROPIC_MODEL: 'user-picked' }
    expect(upgradeExtraEnv('deepseek-claude', env)).toBe(env)
    expect(upgradeExtraEnv('unknown', env)).toBe(env)
  })
})

describe('envConflicts scope', () => {
  it('ignores launch-scoped entries', () => {
    const mk = (id: string, scope: 'global' | 'launch') => ({
      id,
      enabled: true,
      scope,
      keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
      extraEnv: {},
    })
    expect(envConflicts([mk('a', 'launch'), mk('b', 'launch')]).size).toBe(0)
    expect(envConflicts([mk('a', 'global'), mk('b', 'global')]).size).toBe(1)
  })
})
```

Add `presetEnvDrift, upgradeExtraEnv, PROVIDER_PRESETS` to the test file's imports as needed.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- --run`
Expected: FAIL — unknown preset ids, `scope` missing, `presetEnvDrift`/`upgradeExtraEnv` not exported.

- [ ] **Step 4: Implement `src/lib/apikey-presets.ts`**

`ProviderPreset` gains a required field (after `wire`):

```ts
  /** injection scope for entries created from this preset */
  scope: 'global' | 'launch'
```

Add `scope: 'global',` to every existing preset literal. Add the claude binary constants above `PROVIDER_PRESETS` so the new presets can share them:

```ts
const CLAUDE_CHECK: PresenceCheck = { kind: 'binary', name: 'claude' }
const CLAUDE_INSTALL = 'npm install -g @anthropic-ai/claude-code'
const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup'
```

(and use them in the existing `anthropic` preset). Append the new presets before `custom` (values from Step 1 verification):

```ts
  {
    id: 'deepseek-claude',
    name: 'DeepSeek (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-chat',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'kimi-claude',
    name: 'Kimi / Moonshot (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_MODEL: 'kimi-k2-turbo-preview',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2-turbo-preview',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'glm-claude',
    name: 'GLM / Z.ai (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7-air',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'openrouter-claude',
    name: 'OpenRouter (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'ollama-claude',
    name: 'Ollama local (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      ANTHROPIC_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
```

Change `envConflicts` to take and honor scope — the parameter type gains `scope: 'global' | 'launch'` and the loop's skip line becomes:

```ts
    if (!k.enabled || k.scope === 'launch') continue
```

Add the drift/upgrade helpers next to `LEGACY_LAUNCH_COMMANDS`:

```ts
/**
 * Historical extraEnv preset defaults, one snapshot per superseded release.
 * Entries whose stored extraEnv exactly matches a snapshot are auto-upgraded
 * to the current default on load — the user never chose those values.
 * Populate whenever a release changes a preset's extraEnv defaults.
 */
const LEGACY_EXTRA_ENV: Record<string, Record<string, string>[]> = {}

const envEquals = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/** Current defaults when the stored map is a stale preset snapshot; otherwise unchanged. */
export function upgradeExtraEnv(
  provider: string,
  extraEnv: Record<string, string>
): Record<string, string> {
  const preset = presetById(provider)
  if (!preset) return extraEnv
  return (LEGACY_EXTRA_ENV[provider] ?? []).some((snap) => envEquals(snap, extraEnv))
    ? { ...preset.extraEnv }
    : extraEnv
}

/**
 * Names of preset-defaulted env vars whose stored value differs from the
 * current default (missing counts as differing). Empty defaults and vars the
 * user added themselves are never flagged — this warns about endpoint/model
 * values that can go stale, nothing else.
 */
export function presetEnvDrift(provider: string, extraEnv: Record<string, string>): string[] {
  const preset = presetById(provider)
  if (!preset) return []
  return Object.entries(preset.extraEnv)
    .filter(([name, def]) => def !== '' && extraEnv[name] !== def)
    .map(([name]) => name)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- --run`
Expected: PASS.

- [ ] **Step 6: Thread scope + apikeyEntryId through ipc and state**

`src/lib/ipc.ts` — `CreateTerminalOptions` gains:

```ts
  /** provider-key entry whose env is injected into this terminal only */
  apikeyEntryId?: string
```

`ApiKeyMeta` gains (after `enabled`):

```ts
  /** 'global' = inject into every new terminal; 'launch' = only entry-launched terminals */
  scope: 'global' | 'launch'
```

`src/state/store.ts` — `createProjectTerminal` opts type gains `apikeyEntryId?: string` and the `ipc.terminals.create` call passes it:

```ts
  const record = await ipc.terminals.create({
    projectId,
    startupCommand,
    cwd: opts?.cwd,
    name: opts?.name,
    apikeyEntryId: opts?.apikeyEntryId,
  })
```

`src/state/apikeys.ts`:
- import `upgradeExtraEnv` from `../lib/apikey-presets`;
- in `load()`, upgrade both launch command and extraEnv (identity check works because `upgradeExtraEnv` returns the same reference when unchanged):

```ts
    for (const { hasValue: _, ...entry } of keys) {
      const launchCommand = upgradeLaunchCommand(entry.provider, entry.launchCommand)
      const extraEnv = upgradeExtraEnv(entry.provider, entry.extraEnv)
      if (launchCommand !== entry.launchCommand || extraEnv !== entry.extraEnv) {
        keys = await ipc.apikeys.save({ ...entry, launchCommand, extraEnv }, null)
      }
    }
```

- change `launchTerminal` to carry the entry id:

```ts
async function launchTerminal(
  projectId: string,
  name: string,
  startupCommand: string,
  opts?: { claudeSessionId?: string; apikeyEntryId?: string }
): Promise<void> {
  useWorkspace.getState().setProjectExpanded(projectId, true)
  await createProjectTerminal(projectId, { name, startupCommand, ...opts })
}
```

- `requestLaunch`'s direct-launch line becomes:

```ts
    await launchTerminal(projectId, entry.label, entry.launchCommand, { apikeyEntryId: entry.id })
```

- `confirmInstall`'s launch call becomes:

```ts
    await launchTerminal(
      p.projectId,
      p.entry.label,
      withInstall(p.installCommand, linked.startupCommand),
      { claudeSessionId: linked.sessionId, apikeyEntryId: p.entry.id }
    )
```

- [ ] **Step 7: Typecheck + full test run**

Run: `pnpm build` then `pnpm test -- --run`
Expected: typecheck passes (this catches every `envConflicts` caller and any `ApiKeyEntry` literal now missing `scope` — fix call sites it flags, e.g. `providers-section.tsx` compiles in Task 3 but `entryFromDraft` may need a temporary `scope: 'global'` if the build breaks before Task 3 lands; prefer landing Task 3's `providers-section.tsx` changes for `entryFromDraft`/`draftFromEntry`/`draftFromPreset` in that task and only patching what typecheck forces here, minimally). All tests pass.

Note: `apikeys_import_env` (backend) defaults scope to `global`, so `importEnv` needs no change.

- [ ] **Step 8: Commit**

```bash
git add src/lib/apikey-presets.ts src/lib/apikey-presets.test.ts src/lib/ipc.ts src/state/apikeys.ts src/state/store.ts
git commit -m "feat(apikeys): claude-code provider presets, injection scope, extra-env drift helpers"
```

---

### Task 3: Settings UI (scope + drift warnings), docs, final verification

**Files:**
- Modify: `src/components/apikeys/providers-section.tsx`
- Modify: `docs/multi-llm-provider-keys.md`
- Modify: `README.md` (features list, ~line 24 bullet)

- [ ] **Step 1: Wire scope through the draft form**

In `providers-section.tsx`:

`Draft` gains `scope: 'global' | 'launch'`. `draftFromPreset` sets `scope: p.scope`; `draftFromEntry` sets `scope: k.scope`; `entryFromDraft` includes `scope: d.scope`; `applyPreset` sets `scope: p.scope`.

In the Advanced section (after the "Launch command" `Field`), add:

```tsx
              <label className="block">
                <span className="text-xs text-muted">Inject env vars into</span>
                <select
                  value={draft.scope}
                  onChange={(e) =>
                    setDraft({ ...draft, scope: e.target.value as 'global' | 'launch' })
                  }
                  className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
                >
                  <option value="global">Every new terminal</option>
                  <option value="launch">Only terminals launched from this entry</option>
                </select>
              </label>
```

Entry rows: show the scope when it's launch-only — in the `{k.keyEnvVar} …` metadata line, append:

```tsx
                    {k.scope === 'launch' && ' · launch-only'}
```

- [ ] **Step 2: Drift warning + reset, and edit-form warnings**

Import `presetEnvDrift` from `../../lib/apikey-presets`. Add a handler near `onLaunch`:

```tsx
  const onResetDefaults = async (k: ApiKeyMeta): Promise<void> => {
    const preset = presetById(k.provider)
    if (!preset) return
    const { hasValue: _, ...entry } = k
    const defaults = Object.fromEntries(
      Object.entries(preset.extraEnv).filter(([, v]) => v !== '')
    )
    await save({ ...entry, extraEnv: { ...entry.extraEnv, ...defaults } }, null)
  }
```

In the entry-row JSX, after the existing `{note && …}` line:

```tsx
              {presetEnvDrift(k.provider, k.extraEnv).length > 0 && (
                <div className="mt-1 flex items-center gap-2 text-xs text-warning">
                  <span>
                    ⚠ {presetEnvDrift(k.provider, k.extraEnv).join(', ')} differ
                    {presetEnvDrift(k.provider, k.extraEnv).length === 1 ? 's' : ''} from the
                    preset default — provider endpoints and model ids go stale
                  </span>
                  <button
                    type="button"
                    onClick={() => void onResetDefaults(k)}
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-foreground/5"
                  >
                    Reset to defaults
                  </button>
                </div>
              )}
```

(If the theme lacks a `text-warning` token, use `text-danger` — check `src/themes/` for the token set and match what `conflictNote` uses if warning is absent.)

In the Advanced extra-env editor, under each pair row, warn when a preset-defaulted var was changed — after the pair's closing `</div>` inside the `.map`, add:

```tsx
                  {(() => {
                    const def = presetById(draft.provider)?.extraEnv[pair.name]
                    return def && def !== pair.value ? (
                      <div className="mb-1 text-xs text-warning">
                        Changed from the preset default ({def}) — make sure this value is still
                        valid for the provider
                      </div>
                    ) : null
                  })()}
```

Update the section intro paragraph to mention scope:

```tsx
      <p className="mb-2 text-xs text-muted">
        Keys are stored in the OS keychain and injected into terminals opened after saving —
        CLIs like claude, aider, and codex pick them up automatically. Launch-only entries
        (e.g. Claude Code on another provider) are injected only into terminals started from
        their ▶ Launch button or the model picker.
      </p>
```

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm build` then `pnpm test -- --run`
Expected: both pass. If Task 2 left a temporary `scope` patch in this file, replace it with the real wiring from Step 1.

- [ ] **Step 4: Update docs**

`docs/multi-llm-provider-keys.md`:
- In the **Status** header line, append: `; extended by the v3 launch-scoped Claude Code presets — see docs/superpowers/specs/2026-07-11-claude-code-third-party-models-design.md`.
- Replace the §9 blockquote compatibility note with:

```markdown
> Compatibility note: Claude Code speaks the **Anthropic** wire format. Providers with native
> Anthropic-compatible endpoints (DeepSeek, Kimi/Moonshot, GLM/Z.ai, OpenRouter, local Ollama)
> can back Claude Code directly via the launch-scoped "X (Claude Code)" presets, which inject
> `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` only into terminals launched from that entry.
> OpenAI-format-only providers (OpenAI, Groq, Mistral, xAI) still use a CLI that speaks their
> format (codex/aider) or a translating proxy.
```

- Add a new section after §9:

```markdown
## 9b. Claude Code on third-party models (launch-scoped entries)

Entries have an injection scope: **global** (default — env goes into every new terminal, the
v1 behavior) or **launch** (env goes only into terminals started from that entry's ▶ Launch
button or the model picker). The "X (Claude Code)" presets default to launch scope so a
DeepSeek/Kimi/GLM/OpenRouter/Ollama-backed Claude Code never hijacks normal `claude`
terminals, the ⌘⇧T/⌘⇧D shortcuts, or the active managed Claude account.

Preset `extraEnv` values (base URL, `ANTHROPIC_MODEL`, …) are fully initialised but editable.
Values matching a superseded release's defaults are silently upgraded on load
(`LEGACY_EXTRA_ENV`); values that differ from the current defaults show a per-entry warning
with one-click **Reset to defaults**.

Known limitations:
- Resuming a session from the Sessions tab (`claude --resume`) does not re-inject a
  launch-scoped entry's env — the resumed session runs on the default Claude credentials.
- On third-party backends Claude Code loses web search, prompt caching, and Anthropic
  thinking betas (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is preset to avoid header
  errors); tool-calling quality varies by model.
- The scope is per-terminal: any command run later in a launch-scoped terminal sees the
  injected env.
```

`README.md` — extend the **Bring-your-own-LLM keys** bullet's last sentence:

```markdown
  matching CLI — offering to install it first if it's missing. Launch-scoped "Claude Code"
  presets can point the `claude` CLI itself at Anthropic-compatible providers (DeepSeek,
  Kimi, GLM, OpenRouter, local Ollama) without affecting other terminals. See
  [docs/multi-llm-provider-keys.md](docs/multi-llm-provider-keys.md).
```

- [ ] **Step 5: Full verification**

Run: `pnpm build` ; `pnpm test -- --run` ; (from `src-tauri/`) `cargo test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/apikeys/providers-section.tsx docs/multi-llm-provider-keys.md README.md
git commit -m "feat(apikeys): scope + preset-drift UI for claude-code providers; document launch-scoped entries"
```
