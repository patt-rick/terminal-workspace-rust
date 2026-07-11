import { useEffect, useState } from 'react'
import { type ApiKeyEntry, type ApiKeyMeta } from '../../lib/ipc'
import {
  envConflicts,
  launchBlocker,
  nextLabel,
  PROVIDER_PRESETS,
  presetById,
} from '../../lib/apikey-presets'
import { useApiKeys } from '../../state/apikeys'
import { useWorkspace } from '../../state/store'
import { useUi } from '../../state/ui'

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface Draft {
  id: string
  provider: string
  label: string
  keyEnvVar: string
  extraEnv: { name: string; value: string }[]
  launchCommand: string
  enabled: boolean
  scope: 'global' | 'launch'
  /** write-only paste field; empty = keep the stored secret */
  secret: string
  hasValue: boolean
  /** UI-only: show label/env/launch fields (auto-on for custom) */
  advanced: boolean
}

const draftFromPreset = (presetId: string): Draft => {
  const p = presetById(presetId) ?? PROVIDER_PRESETS[0]
  return {
    id: crypto.randomUUID(),
    provider: p.id,
    label: p.name,
    keyEnvVar: p.keyEnvVar,
    extraEnv: Object.entries(p.extraEnv).map(([name, value]) => ({ name, value })),
    launchCommand: p.launchCommand,
    enabled: true,
    scope: p.scope,
    secret: '',
    hasValue: false,
    advanced: p.id === 'custom',
  }
}

const draftFromEntry = (k: ApiKeyMeta): Draft => ({
  id: k.id,
  provider: k.provider,
  label: k.label,
  keyEnvVar: k.keyEnvVar,
  extraEnv: Object.entries(k.extraEnv).map(([name, value]) => ({ name, value })),
  launchCommand: k.launchCommand ?? '',
  enabled: k.enabled,
  scope: k.scope,
  secret: '',
  hasValue: k.hasValue,
  advanced: false,
})

const entryFromDraft = (d: Draft): ApiKeyEntry => ({
  id: d.id,
  provider: d.provider,
  label: d.label.trim(),
  keyEnvVar: d.keyEnvVar.trim(),
  extraEnv: Object.fromEntries(
    d.extraEnv
      .map((p) => [p.name.trim(), p.value.trim()])
      .filter(([name, value]) => name && value)
  ),
  launchCommand: d.launchCommand.trim() || null,
  enabled: d.enabled,
  scope: d.scope,
})

/**
 * Provider API-key management, rendered as a section inside the Settings
 * modal. Keys are injected into terminals opened AFTER saving; secrets live in
 * the OS keychain and are never echoed back into the UI.
 */
export function ProvidersSection() {
  const keys = useApiKeys((s) => s.keys)
  const loaded = useApiKeys((s) => s.loaded)
  const detected = useApiKeys((s) => s.detected)
  const load = useApiKeys((s) => s.load)
  const save = useApiKeys((s) => s.save)
  const remove = useApiKeys((s) => s.remove)
  const setEnabled = useApiKeys((s) => s.setEnabled)
  const test = useApiKeys((s) => s.test)
  const detectEnv = useApiKeys((s) => s.detectEnv)
  const importEnv = useApiKeys((s) => s.importEnv)

  const requestLaunch = useApiKeys((s) => s.requestLaunch)

  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const closeSettings = useUi((s) => s.closeSettings)

  const onLaunch = async (k: ApiKeyMeta): Promise<void> => {
    if (!selectedProjectId || !k.launchCommand) return
    closeSettings()
    await requestLaunch(selectedProjectId, k)
  }

  const [draft, setDraft] = useState<Draft | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loaded) {
      void load()
      void detectEnv()
    }
  }, [loaded, load, detectEnv])

  const conflicts = envConflicts(keys)
  const labelOf = (id: string) => keys.find((k) => k.id === id)?.label ?? id

  /** Conflict note for one entry: which of its vars collide and who wins. */
  const conflictNote = (k: ApiKeyMeta): string | null => {
    if (!k.enabled) return null
    const vars = [k.keyEnvVar, ...Object.keys(k.extraEnv)]
    for (const v of vars) {
      const ids = conflicts.get(v)
      if (!ids || !ids.includes(k.id)) continue
      const winner = ids[ids.length - 1]
      return winner === k.id
        ? `${v} also set by ${ids
            .filter((i) => i !== k.id)
            .map(labelOf)
            .join(', ')} — this entry wins`
        : `${v} overridden by ${labelOf(winner)}`
    }
    return null
  }

  const canSave =
    !!draft &&
    !!draft.label.trim() &&
    ENV_VAR_RE.test(draft.keyEnvVar.trim()) &&
    (draft.hasValue || !!draft.secret.trim())

  const onSave = async (): Promise<void> => {
    if (!draft || !canSave) return
    setBusy(true)
    try {
      await save(entryFromDraft(draft), draft.secret.trim() || null)
      setDraft(null)
    } finally {
      setBusy(false)
    }
  }

  const onTest = async (id: string): Promise<void> => {
    setTestMsg((m) => ({ ...m, [id]: 'Testing…' }))
    try {
      const r = await test(id)
      setTestMsg((m) => ({
        ...m,
        [id]:
          r.status === 'ok'
            ? 'OK — key accepted'
            : r.status === 'authFailed'
              ? 'Auth failed — key rejected'
              : `Unreachable: ${r.message}`,
      }))
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: String(e) }))
    }
  }

  const onImport = async (envVar: string): Promise<void> => {
    const preset = PROVIDER_PRESETS.find((p) => p.keyEnvVar === envVar)
    await importEnv(envVar, preset?.id ?? 'custom', preset?.name ?? envVar, preset?.launchCommand || null)
  }

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
      scope: p.scope,
      advanced: draft.advanced || p.id === 'custom',
    })
  }

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          AI providers
        </div>
        <button
          type="button"
          onClick={() => setDraft(draftFromPreset('anthropic'))}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
        >
          + Add key
        </button>
      </div>

      <p className="mb-2 text-xs text-muted">
        Keys are stored in the OS keychain and injected into terminals opened after saving —
        CLIs like claude, aider, and codex pick them up automatically.
      </p>

      {/* key list */}
      <div className="flex flex-col gap-1">
        {keys.length === 0 && <div className="py-1 text-xs text-muted">No provider keys yet.</div>}
        {keys.map((k) => {
          const note = conflictNote(k)
          const blocker = !selectedProjectId ? 'Select a project first' : launchBlocker(k)
          return (
            <div key={k.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {k.label}
                    <span className="ml-2 text-xs text-muted">
                      {presetById(k.provider)?.name ?? k.provider}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted">
                    {k.keyEnvVar} {k.hasValue ? '= ••••••••' : '(no value stored)'}
                    {Object.keys(k.extraEnv).length > 0 &&
                      ` · +${Object.keys(k.extraEnv).length} env`}
                  </div>
                </div>
                <label className="flex items-center gap-1 text-xs text-muted" title="Inject into new terminals">
                  <input
                    type="checkbox"
                    checked={k.enabled}
                    onChange={(e) => void setEnabled(k.id, e.target.checked)}
                  />
                  Enabled
                </label>
                <button
                  type="button"
                  disabled={!!blocker}
                  onClick={() => void onLaunch(k)}
                  title={blocker ?? `Open a terminal running: ${k.launchCommand}`}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
                >
                  ▶ Launch
                </button>
                <button
                  type="button"
                  onClick={() => void onTest(k.id)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(draftFromEntry(k))}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(k.id)}
                  className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-foreground/5"
                >
                  Delete
                </button>
              </div>
              {testMsg[k.id] && <div className="mt-1 text-xs text-muted">{testMsg[k.id]}</div>}
              {note && <div className="mt-1 text-xs text-danger">⚠ {note}</div>}
            </div>
          )
        })}
      </div>

      {/* import from environment */}
      {detected.length > 0 && (
        <div className="mt-3 rounded-md border border-border p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            Found in your environment
          </div>
          {detected.map((d) => (
            <div key={d.envVar} className="flex items-center gap-2 py-1">
              <div className="min-w-0 flex-1 truncate text-xs text-foreground/80">
                {d.envVar} <span className="text-muted">({d.maskedTail})</span>
              </div>
              <button
                type="button"
                onClick={() => void onImport(d.envVar)}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
              >
                Import
              </button>
            </div>
          ))}
        </div>
      )}

      {/* add / edit form */}
      {draft && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="text-xs font-semibold text-foreground">
            {draft.hasValue ? `Edit "${draft.label}"` : 'Add provider key'}
          </div>
          <label className="block">
            <span className="text-xs text-muted">Provider preset</span>
            <select
              value={draft.provider}
              onChange={(e) => applyPreset(e.target.value)}
              className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">
              API key {draft.hasValue && '(leave blank to keep the current value)'}
            </span>
            <input
              type="password"
              value={draft.secret}
              placeholder={draft.hasValue ? '••••••••  (unchanged)' : 'sk-…'}
              onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              autoComplete="off"
              className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
            />
          </label>
          {!draft.advanced && (
            <p className="text-xs text-muted">
              Stored as {draft.keyEnvVar}
              {draft.launchCommand ? ` · launches ${draft.launchCommand}` : ''}
            </p>
          )}
          <button
            type="button"
            onClick={() => setDraft({ ...draft, advanced: !draft.advanced })}
            className="self-start text-xs text-link hover:underline"
          >
            {draft.advanced ? 'Hide advanced' : 'Advanced…'}
          </button>
          {draft.advanced && (
            <>
              <Field
                label="Label"
                value={draft.label}
                onChange={(v) => setDraft({ ...draft, label: v })}
                placeholder="DeepSeek (personal)"
              />
              <Field
                label="Key env var"
                value={draft.keyEnvVar}
                onChange={(v) => setDraft({ ...draft, keyEnvVar: v })}
                placeholder="OPENAI_API_KEY"
              />
              <Field
                label="Launch command (runs in the new terminal)"
                value={draft.launchCommand}
                onChange={(v) => setDraft({ ...draft, launchCommand: v })}
                placeholder="aider --model deepseek/deepseek-chat"
              />
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-muted">Extra env (base URLs etc. — not secret)</span>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({ ...draft, extraEnv: [...draft.extraEnv, { name: '', value: '' }] })
                    }
                    className="rounded border border-border px-2 py-0.5 text-xs hover:bg-foreground/5"
                  >
                    + Add pair
                  </button>
                </div>
                {draft.extraEnv.map((pair, i) => (
                  <div key={i} className="mb-1 flex items-center gap-1">
                    <input
                      type="text"
                      value={pair.name}
                      placeholder="OPENAI_BASE_URL"
                      onChange={(e) => {
                        const extraEnv = [...draft.extraEnv]
                        extraEnv[i] = { ...pair, name: e.target.value }
                        setDraft({ ...draft, extraEnv })
                      }}
                      className="w-2/5 rounded border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                    />
                    <input
                      type="text"
                      value={pair.value}
                      placeholder="https://…"
                      onChange={(e) => {
                        const extraEnv = [...draft.extraEnv]
                        extraEnv[i] = { ...pair, value: e.target.value }
                        setDraft({ ...draft, extraEnv })
                      }}
                      className="flex-1 rounded border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({ ...draft, extraEnv: draft.extraEnv.filter((_, j) => j !== i) })
                      }
                      className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-foreground/5"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            {!canSave &&
              !draft.advanced &&
              (!draft.label.trim() || !ENV_VAR_RE.test(draft.keyEnvVar.trim())) && (
                <span className="text-xs text-danger">Fix the label or env var under Advanced</span>
              )}
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave || busy}
              onClick={() => void onSave()}
              className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
      />
    </label>
  )
}
