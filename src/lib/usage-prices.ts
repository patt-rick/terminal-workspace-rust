// Custom model prices for the Usage page: the stored shape and the pure rules
// around it. The backend applies the entries; nothing here prices anything.

/** Rates are US dollars per million tokens. A null cache rate means "not set". */
export type PriceOverride =
  | { kind: 'alias'; model: string }
  | {
      kind: 'rates'
      input: number
      output: number
      cacheRead: number | null
      cacheWrite: number | null
    }

/** Keyed by `priceKey` of the model. */
export type PriceOverrides = Record<string, PriceOverride>

/** One model of the fetched price table, in dollars per million tokens. */
export interface PriceTableRow {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface PriceForm {
  model: string
  kind: 'alias' | 'rates'
  target: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
}

export const MAX_PRICE_OVERRIDES = 200
export const MAX_RATE = 1_000_000
const MAX_NAME_CHARS = 200

/** How a model name is matched: lower case, without a `[variant]` suffix. */
export function priceKey(model: string): string {
  return model.trim().toLowerCase().split('[')[0].trim()
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RATE
}

function sanitizeEntry(raw: unknown): PriceOverride | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (entry.kind === 'alias') {
    if (typeof entry.model !== 'string' || entry.model.length > MAX_NAME_CHARS) return null
    const model = priceKey(entry.model)
    return model ? { kind: 'alias', model } : null
  }
  if (entry.kind === 'rates') {
    const optional = (value: unknown): number | null | undefined =>
      value === null || value === undefined ? null : isRate(value) ? value : undefined
    const cacheRead = optional(entry.cacheRead)
    const cacheWrite = optional(entry.cacheWrite)
    if (!isRate(entry.input) || !isRate(entry.output)) return null
    if (cacheRead === undefined || cacheWrite === undefined) return null
    return { kind: 'rates', input: entry.input, output: entry.output, cacheRead, cacheWrite }
  }
  return null
}

/** Stored settings are untrusted: keep only entries the backend would use. */
export function sanitizePriceOverrides(raw: unknown): PriceOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: PriceOverrides = {}
  let count = 0
  for (const name of Object.keys(source).sort()) {
    if (count >= MAX_PRICE_OVERRIDES) break
    const key = priceKey(name)
    if (!key || name.length > MAX_NAME_CHARS || key in out) continue
    const entry = sanitizeEntry(source[name])
    if (!entry) continue
    out[key] = entry
    count += 1
  }
  return out
}

/**
 * Whether a "count as" entry points at nothing the backend can price: a model
 * that is itself counted as another, or one that is neither in the table nor
 * priced by hand. With no table to check against, only the first is known.
 */
export function aliasTargetMissing(
  target: string,
  known: string[],
  existing: PriceOverrides
): boolean {
  const entry = existing[target]
  if (entry?.kind === 'alias') return true
  if (entry?.kind === 'rates') return false
  return known.length > 0 && !known.includes(target)
}

// Plain decimals only: `Number` would also take "0x10" and "1e3".
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/

function parseRate(text: string): number | null | 'bad' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!DECIMAL.test(trimmed)) return 'bad'
  const value = Number(trimmed)
  return isRate(value) ? value : 'bad'
}

/**
 * `isNew` is whether the form is adding an entry (the model name was typed)
 * rather than editing the entry it was opened for.
 */
export function parsePriceForm(
  form: PriceForm,
  known: string[],
  existing: PriceOverrides,
  isNew: boolean
): { model: string; override: PriceOverride } | { error: string } {
  const model = priceKey(form.model)
  if (!model) return { error: 'Enter a model name.' }
  if (form.model.length > MAX_NAME_CHARS) return { error: 'That model name is too long.' }
  if (isNew && model in existing) {
    return { error: `${model} already has a custom price. Edit that one instead.` }
  }
  if (!(model in existing) && Object.keys(existing).length >= MAX_PRICE_OVERRIDES) {
    return { error: `At most ${MAX_PRICE_OVERRIDES} custom prices are kept. Remove one first.` }
  }

  if (form.kind === 'alias') {
    const target = priceKey(form.target)
    if (!target) return { error: 'Choose the model to count it as.' }
    if (form.target.length > MAX_NAME_CHARS) return { error: 'That model name is too long.' }
    if (target === model) return { error: 'A model cannot be counted as itself.' }
    const dependent = Object.keys(existing).find((key) => {
      const entry = existing[key]
      return entry.kind === 'alias' && entry.model === model
    })
    if (dependent) {
      return { error: `${dependent} is counted as ${model}, so ${model} needs rates of its own.` }
    }
    if (existing[target]?.kind === 'alias') {
      return { error: `${target} is itself counted as another model. Pick that model instead.` }
    }
    if (aliasTargetMissing(target, known, existing)) {
      return { error: `${target} has no rate. Pick a model from the list, or price it first.` }
    }
    return { model, override: { kind: 'alias', model: target } }
  }

  const input = parseRate(form.input)
  const output = parseRate(form.output)
  const cacheRead = parseRate(form.cacheRead)
  const cacheWrite = parseRate(form.cacheWrite)
  if (input === null || output === null) return { error: 'Enter the input and output rates.' }
  if (input === 'bad' || output === 'bad' || cacheRead === 'bad' || cacheWrite === 'bad') {
    return { error: 'Rates must be numbers from 0 to 1,000,000.' }
  }
  return { model, override: { kind: 'rates', input, output, cacheRead, cacheWrite } }
}

function rate(value: number): string {
  return `$${Number(value.toFixed(4))}`
}

export function describeOverride(o: PriceOverride): string {
  if (o.kind === 'alias') return `Counted as ${o.model}`
  const parts = [`${rate(o.input)} in`, `${rate(o.output)} out`]
  if (o.cacheRead !== null) parts.push(`${rate(o.cacheRead)} cache read`)
  if (o.cacheWrite !== null) parts.push(`${rate(o.cacheWrite)} cache write`)
  return `${parts.join(' · ')} per 1M`
}

/**
 * The editor's starting values: the entry being edited, else the table's
 * input and output rates for a model it knows (so a changed rate starts from
 * the real ones), else blank. The cache rates stay blank in that case: blank
 * keeps the table's rates, including its separate 1-hour cache-write rate.
 */
export function formOf(
  model: string,
  entry: PriceOverride | undefined,
  row: PriceTableRow | undefined
): PriceForm {
  const blank: PriceForm = {
    model,
    kind: 'rates',
    target: '',
    input: '',
    output: '',
    cacheRead: '',
    cacheWrite: '',
  }
  const text = (value: number | null): string => (value === null ? '' : String(Number(value.toFixed(6))))
  if (entry?.kind === 'alias') return { ...blank, kind: 'alias', target: entry.model }
  if (entry) {
    return {
      ...blank,
      input: text(entry.input),
      output: text(entry.output),
      cacheRead: text(entry.cacheRead),
      cacheWrite: text(entry.cacheWrite),
    }
  }
  return row ? { ...blank, input: text(row.input), output: text(row.output) } : blank
}
