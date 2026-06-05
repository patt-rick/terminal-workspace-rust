import { useState } from 'react'
import { useIdentity } from '../../state/identity'
import { ipc, type Account, type UnmappedBehavior } from '../../lib/ipc'

const blank = (): Account => ({
  id: crypto.randomUUID(),
  label: '',
  login: '',
  name: '',
  email: '',
})

export function AccountsModal() {
  const open = useIdentity((s) => s.accountsModalOpen)
  const close = useIdentity((s) => s.closeAccountsModal)
  const accounts = useIdentity((s) => s.accounts)
  const config = useIdentity((s) => s.config)
  const saveAccount = useIdentity((s) => s.saveAccount)
  const removeAccount = useIdentity((s) => s.removeAccount)
  const setConfig = useIdentity((s) => s.setConfig)

  const [draft, setDraft] = useState<Account | null>(null)
  const [globalMsg, setGlobalMsg] = useState<string | null>(null)

  if (!open) return null

  const startAdd = (): void => setDraft(blank())
  const startEdit = (a: Account): void => setDraft({ ...a })

  const canSave =
    !!draft && draft.label.trim() && draft.login.trim() && draft.name.trim() && draft.email.trim()

  const onSave = async (): Promise<void> => {
    if (!draft || !canSave) return
    await saveAccount({
      id: draft.id,
      label: draft.label.trim(),
      login: draft.login.trim(),
      name: draft.name.trim(),
      email: draft.email.trim(),
    })
    setDraft(null)
  }

  const onSetGlobal = async (a: Account): Promise<void> => {
    setGlobalMsg(null)
    try {
      await ipc.identity.applyGlobal(a.id)
      setGlobalMsg(`Global git identity set to ${a.label}.`)
    } catch (e) {
      setGlobalMsg(String(e))
    }
  }

  const setBehavior = (b: UnmappedBehavior): void => {
    void setConfig({ ...config, unmappedBehavior: b })
  }
  const setDefault = (id: string | null): void => {
    void setConfig({ ...config, defaultAccountId: id })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={close}
    >
      <div
        className="flex max-h-[80vh] w-[34rem] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">GitHub accounts</h2>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {/* account list */}
          <div className="space-y-1">
            {accounts.length === 0 && (
              <div className="py-2 text-xs text-muted">No accounts yet.</div>
            )}
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.label}</div>
                  <div className="truncate text-xs text-muted">
                    {a.login} · {a.email}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onSetGlobal(a)}
                  title="Set as global git identity"
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Set global
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(a)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void removeAccount(a.id)}
                  className="rounded border border-border px-2 py-1 text-xs text-danger hover:bg-foreground/5"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>

          {globalMsg && <div className="mt-2 text-xs text-muted">{globalMsg}</div>}

          {/* add / edit form */}
          {draft ? (
            <div className="mt-3 space-y-2 rounded-md border border-border p-3">
              <Field
                label="Label"
                value={draft.label}
                onChange={(v) => setDraft({ ...draft, label: v })}
                placeholder="Personal"
              />
              <Field
                label="GitHub login"
                value={draft.login}
                onChange={(v) => setDraft({ ...draft, login: v })}
                placeholder="octocat"
              />
              <Field
                label="Commit name (user.name)"
                value={draft.name}
                onChange={(v) => setDraft({ ...draft, name: v })}
                placeholder="Octo Cat"
              />
              <Field
                label="Commit email (user.email)"
                value={draft.email}
                onChange={(v) => setDraft({ ...draft, email: v })}
                placeholder="octocat@users.noreply.github.com"
              />
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canSave}
                  onClick={() => void onSave()}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={startAdd}
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-foreground/5"
            >
              + Add account
            </button>
          )}

          {/* behavior settings */}
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              When opening an unmapped repo
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={config.unmappedBehavior === 'ask'}
                onChange={() => setBehavior('ask')}
              />
              Always ask
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={config.unmappedBehavior === 'useDefault'}
                onChange={() => setBehavior('useDefault')}
              />
              Use default account
            </label>
            {config.unmappedBehavior === 'useDefault' && (
              <div className="mt-2">
                <label className="text-xs text-muted">Default account</label>
                <select
                  value={config.defaultAccountId ?? ''}
                  onChange={(e) => setDefault(e.target.value || null)}
                  className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
                >
                  <option value="">— none —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </div>
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
        className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
      />
    </label>
  )
}
