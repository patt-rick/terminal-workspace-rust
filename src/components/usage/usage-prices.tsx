import { useEffect, useMemo, useRef, useState } from 'react'
import { ipc } from '../../lib/ipc'
import { useSettings } from '../../state/settings'
import { useUsage } from '../../state/usage'
import {
  aliasTargetMissing,
  describeOverride,
  formOf,
  parsePriceForm,
  priceKey,
  type PriceForm,
  type PriceOverrides,
  type PriceTableRow,
} from '../../lib/usage-prices'

const FIELD =
  'rounded-md border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted focus:border-accent read-only:text-muted'
const LINK = 'text-link hover:underline'

const RATE_FIELDS: { name: 'input' | 'output' | 'cacheRead' | 'cacheWrite'; label: string; optional: boolean }[] = [
  { name: 'input', label: 'Input', optional: false },
  { name: 'output', label: 'Output', optional: false },
  { name: 'cacheRead', label: 'Cache read', optional: true },
  { name: 'cacheWrite', label: 'Cache write', optional: true },
]

/**
 * The form for one entry. The section mounts a fresh one per model, so its
 * starting values are read once and are not disturbed by a reload underneath.
 */
function PriceEditor({
  model,
  models,
  table,
  overrides,
  onSave,
  onCancel,
}: {
  /** '' for a new entry */
  model: string
  models: string[]
  table: PriceTableRow[]
  overrides: PriceOverrides
  onSave: (form: PriceForm, isNew: boolean) => string | null
  onCancel: () => void
}) {
  const key = priceKey(model)
  // Whether this form was opened for an entry that is already stored.
  const existing = key in overrides
  const isNew = model === ''
  const [form, setForm] = useState<PriceForm>(() =>
    formOf(key, overrides[key], table.find((r) => r.model === key))
  )
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const el = root.current
    el?.scrollIntoView({ block: 'nearest' })
    el?.querySelector<HTMLInputElement>(model === '' ? 'input[name=model]' : 'input[name=input], input[name=target]')?.focus()
  }, [model])

  const patch = (change: Partial<PriceForm>): void => {
    setError(null)
    setForm((f) => ({ ...f, ...change }))
  }
  const target = table.find((r) => r.model === priceKey(form.target))

  // A typed name the table knows: start from its real rates, unless the user
  // has already entered some.
  const fillFromTable = (): void => {
    if (!isNew || form.input.trim() || form.output.trim()) return
    const row = table.find((r) => r.model === priceKey(form.model))
    if (!row || priceKey(form.model) in overrides) return
    const known = formOf(form.model, undefined, row)
    setForm((f) => ({ ...f, input: known.input, output: known.output }))
  }

  return (
    <form
      ref={root}
      onSubmit={(e) => {
        e.preventDefault()
        setError(onSave(form, isNew))
      }}
      onKeyDown={(e) => {
        // Esc closes this form, not the whole Usage page behind it.
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      className="flex flex-col gap-3 rounded-md border border-border p-3 text-xs"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-muted">
          Model
          <input
            name="model"
            value={form.model}
            onChange={(e) => patch({ model: e.target.value })}
            onBlur={fillFromTable}
            readOnly={existing}
            list="usage-price-models"
            placeholder="model name"
            autoComplete="off"
            spellCheck={false}
            className={FIELD}
          />
          <datalist id="usage-price-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div role="group" aria-label="Kind of price" className="flex rounded-md border border-border">
          {(
            [
              { id: 'rates', label: 'Set rates' },
              { id: 'alias', label: 'Count as another model' },
            ] as const
          ).map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => patch({ kind: k.id })}
              aria-pressed={form.kind === k.id}
              className={`px-2.5 py-1 ${
                form.kind === k.id ? 'bg-foreground/10 text-foreground' : 'text-muted hover:text-foreground'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {form.kind === 'rates' ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-3">
            {RATE_FIELDS.map((f) => (
              <label key={f.name} className="flex w-28 flex-col gap-1 text-muted">
                {f.label}
                <input
                  name={f.name}
                  value={form[f.name]}
                  onChange={(e) => patch({ [f.name]: e.target.value } as Partial<PriceForm>)}
                  inputMode="decimal"
                  placeholder={f.optional ? 'optional' : '0.00'}
                  autoComplete="off"
                  className={FIELD}
                />
              </label>
            ))}
          </div>
          <span className="text-[11px] text-muted">
            US dollars per million tokens. A blank cache rate keeps the price table's rate for this
            model, or uses the input rate when the table does not know it.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="flex max-w-md flex-col gap-1 text-muted">
            Count as
            <input
              name="target"
              value={form.target}
              onChange={(e) => patch({ target: e.target.value })}
              list="usage-price-table"
              placeholder="a model with a rate"
              autoComplete="off"
              spellCheck={false}
              className={FIELD}
            />
            <datalist id="usage-price-table">
              {table.map((r) => (
                <option key={r.model} value={r.model} />
              ))}
            </datalist>
          </label>
          {target && (
            <span className="text-[11px] text-muted">
              {describeOverride({
                kind: 'rates',
                input: target.input,
                output: target.output,
                cacheRead: target.cacheRead,
                cacheWrite: target.cacheWrite,
              })}
            </span>
          )}
        </div>
      )}

      {error && <span className="text-warning">{error}</span>}
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1 font-medium text-accent-foreground hover:opacity-90"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1 text-foreground hover:bg-foreground/5"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * The user's own model prices: a rate set by hand, or one model counted as
 * another. The backend applies them; saving here stores them in the settings
 * and re-reads the summary.
 */
export function UsagePrices({
  models,
  editing,
  onEdit,
  tableStamp,
}: {
  /** model names in the current summary, offered when adding an entry */
  models: string[]
  /** the model whose entry is open, '' for a new one, null for none */
  editing: string | null
  onEdit: (model: string | null) => void
  /** changes when the price table was fetched again */
  tableStamp: number | null
}) {
  const overrides = useSettings((s) => s.usagePriceOverrides)
  const setOverrides = useSettings((s) => s.setUsagePriceOverrides)
  const [table, setTable] = useState<PriceTableRow[]>([])
  const root = useRef<HTMLElement>(null)

  // Closing the editor or removing a row unmounts whatever had focus. Take it
  // back here, so the keyboard still reaches the page (Esc closes it).
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && editing === null) root.current?.focus()
    wasEditing.current = editing !== null
  }, [editing])

  useEffect(() => {
    let live = true
    ipc.usage
      .priceTable()
      .then((rows) => {
        if (live) setTable(rows)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [tableStamp])

  const known = useMemo(() => table.map((r) => r.model), [table])
  const suggestions = useMemo(() => [...new Set(models.map(priceKey))].sort(), [models])
  const keys = Object.keys(overrides).sort()

  const store = (next: PriceOverrides): void => {
    setOverrides(next)
    void useUsage.getState().load(false)
  }

  // The model field is locked while editing, so an entry is never renamed.
  const save = (form: PriceForm, isNew: boolean): string | null => {
    const parsed = parsePriceForm(form, known, overrides, isNew)
    if ('error' in parsed) return parsed.error
    store({ ...overrides, [parsed.model]: parsed.override })
    onEdit(null)
    return null
  }

  const remove = (key: string): void => {
    const next = { ...overrides }
    delete next[key]
    store(next)
    if (editing !== null && priceKey(editing) === key) onEdit(null)
    root.current?.focus()
  }

  return (
    <section ref={root} tabIndex={-1} className="flex flex-col gap-2 outline-none">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-foreground">Custom prices</h2>
        {editing === null && (
          <button type="button" onClick={() => onEdit('')} className={`text-xs ${LINK}`}>
            Add
          </button>
        )}
      </div>
      {keys.length === 0 && editing === null && (
        <p className="text-xs text-muted">
          None. Set a model's rates, or count it as another model, when the price table does not
          know it or your rate differs.
        </p>
      )}
      {keys.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {keys.map((key) => {
              const entry = overrides[key]
              const broken = entry.kind === 'alias' && aliasTargetMissing(entry.model, known, overrides)
              return (
                <tr key={key} className="border-b border-border/50">
                  <td className="w-2/5 max-w-0 truncate py-2 text-foreground" title={key}>
                    {key}
                  </td>
                  <td className="py-2 pl-4 text-muted">
                    {describeOverride(entry)}
                    {broken && <span className="text-warning"> · target has no rate</span>}
                  </td>
                  <td className="w-px whitespace-nowrap py-2 pl-4 text-right">
                    <button type="button" onClick={() => onEdit(key)} className={LINK}>
                      Edit
                    </button>
                    <button type="button" onClick={() => remove(key)} className={`ml-3 ${LINK}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {editing !== null && (
        <PriceEditor
          key={editing}
          model={editing}
          models={suggestions}
          table={table}
          overrides={overrides}
          onSave={save}
          onCancel={() => onEdit(null)}
        />
      )}
    </section>
  )
}
