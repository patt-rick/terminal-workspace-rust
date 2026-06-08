import { useEffect, useState } from 'react'
import { ipc, type Account, type UnmappedBehavior } from '../../lib/ipc'
import { addAccountViaGhAuth } from '../../lib/add-account'
import { useIdentity } from '../../state/identity'

const blank = (): Account => ({
  id: crypto.randomUUID(),
  label: '',
  login: '',
  name: '',
  email: '',
})

/**
 * Account management UI, rendered as a section inside the Settings modal:
 * add/edit/remove accounts, pick the default, choose unmapped-repo behavior,
 * set an account as the global git identity, and one-click import of the
 * accounts already logged in via the `gh` CLI.
 */
export function AccountsSection() {
  const accounts = useIdentity((s) => s.accounts)
  const config = useIdentity((s) => s.config)
  const loaded = useIdentity((s) => s.loaded)
  const load = useIdentity((s) => s.load)
  const saveAccount = useIdentity((s) => s.saveAccount)
  const removeAccount = useIdentity((s) => s.removeAccount)
  const importGhAccounts = useIdentity((s) => s.importGhAccounts)
  const setConfig = useIdentity((s) => s.setConfig)

  const [draft, setDraft] = useState<Account | null>(null)
  const [globalMsg, setGlobalMsg] = useState<string | null>(null)
  const [ghMsg, setGhMsg] = useState<string | null>(null)
  const [ghBusy, setGhBusy] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const startAdd = (): void => setDraft(blank())
  const startEdit = (a: Account): void => setDraft({ ...a })

  // GitHub logins are letters/digits/hyphens only; reject anything else so it
  // can't produce a malformed `https://<login>@github.com/...` origin URL.
  const loginValid = !!draft && /^[A-Za-z0-9-]+$/.test(draft.login.trim())
  const canSave =
    !!draft &&
    !!draft.label.trim() &&
    loginValid &&
    !!draft.name.trim() &&
    !!draft.email.trim()

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

  const onDetectGh = async (): Promise<void> => {
    setGhMsg(null)
    setGhBusy(true)
    try {
      const { added, total } = await importGhAccounts()
      if (added.length === 0) {
        setGhMsg(total === 0 ? 'No gh accounts found.' : 'All gh accounts already added.')
        return
      }
      setGhMsg(
        `Added ${added.length} account${added.length > 1 ? 's' : ''} from gh: ${added.join(
          ', '
        )}. Review the email fields below.`
      )
    } catch (e) {
      setGhMsg(String(e))
    } finally {
      setGhBusy(false)
    }
  }

  // Authenticate a brand-new account via the real `gh auth login` flow in a
  // terminal; the account is imported automatically when that terminal exits.
  const onAddViaGh = async (): Promise<void> => {
    setGhMsg(null)
    const err = await addAccountViaGhAuth()
    if (err) setGhMsg(err)
  }

  const setBehavior = (b: UnmappedBehavior): void => {
    void setConfig({ ...config, unmappedBehavior: b })
  }
  const setDefault = (id: string | null): void => {
    void setConfig({ ...config, defaultAccountId: id })
  }

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          GitHub accounts
        </div>
        <button
          type="button"
          onClick={() => void onDetectGh()}
          disabled={ghBusy}
          title="Add accounts you're already logged into via the GitHub CLI"
          className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
        >
          {ghBusy ? 'Detecting…' : 'Detect gh accounts'}
        </button>
      </div>

      {ghMsg && <div className="mb-2 text-xs text-muted">{ghMsg}</div>}

      {/* account list */}
      <div className="flex flex-col gap-1">
        {accounts.length === 0 && <div className="py-1 text-xs text-muted">No accounts yet.</div>}
        {accounts.map((a) => (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{a.label}</div>
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
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3">
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
          {draft.login.trim() && !loginValid && (
            <p className="text-[11px] text-danger">
              Login may contain only letters, numbers, and hyphens.
            </p>
          )}
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
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onAddViaGh()}
            title="Run `gh auth login` in a terminal, then import the account"
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            + Add account
          </button>
          <button
            type="button"
            onClick={startAdd}
            title="Enter the account details manually"
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-foreground/5"
          >
            Add manually
          </button>
        </div>
      )}

      {/* unmapped-repo behavior */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          When opening an unmapped repo
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground/80">
          <input
            type="radio"
            checked={config.unmappedBehavior === 'ask'}
            onChange={() => setBehavior('ask')}
          />
          Always ask
        </label>
        <label className="mt-1 flex items-center gap-2 text-sm text-foreground/80">
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
              className="mt-1 w-full rounded border border-border bg-field-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
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
