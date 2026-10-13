import { describe, expect, it } from 'vitest'
import {
  MAX_PRICE_OVERRIDES,
  aliasTargetMissing,
  describeOverride,
  formOf,
  parsePriceForm,
  priceKey,
  sanitizePriceOverrides,
  type PriceForm,
  type PriceOverrides,
} from './usage-prices'

const form = (patch: Partial<PriceForm>): PriceForm => ({
  model: 'new-model',
  kind: 'rates',
  target: '',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
  ...patch,
})

const KNOWN = ['claude-a', 'claude-b']

describe('priceKey', () => {
  it('lowercases and drops the variant, like the backend lookup', () => {
    expect(priceKey(' Claude-X[1m] ')).toBe('claude-x')
  })
})

describe('sanitizePriceOverrides', () => {
  it('keeps valid entries under normalised keys and targets', () => {
    expect(
      sanitizePriceOverrides({
        'Mine[1m]': { kind: 'rates', input: 3, output: 15, cacheRead: null, cacheWrite: 3.75 },
        other: { kind: 'alias', model: ' Claude-A ' },
      })
    ).toEqual({
      mine: { kind: 'rates', input: 3, output: 15, cacheRead: null, cacheWrite: 3.75 },
      other: { kind: 'alias', model: 'claude-a' },
    })
  })

  it('treats a missing cache rate as not set', () => {
    expect(sanitizePriceOverrides({ m: { kind: 'rates', input: 1, output: 2 } })).toEqual({
      m: { kind: 'rates', input: 1, output: 2, cacheRead: null, cacheWrite: null },
    })
  })

  it('drops entries the backend would not use', () => {
    expect(
      sanitizePriceOverrides({
        negative: { kind: 'rates', input: -1, output: 2 },
        huge: { kind: 'rates', input: 1, output: 2_000_000 },
        text: { kind: 'rates', input: '1', output: 2 },
        badCache: { kind: 'rates', input: 1, output: 2, cacheRead: Number.NaN },
        blankTarget: { kind: 'alias', model: ' ' },
        unknownKind: { kind: 'free' },
        notAnObject: 5,
        ' ': { kind: 'rates', input: 1, output: 2 },
        ['x'.repeat(201)]: { kind: 'rates', input: 1, output: 2 },
      })
    ).toEqual({})
  })

  it('is empty for anything that is not an object', () => {
    expect(sanitizePriceOverrides(null)).toEqual({})
    expect(sanitizePriceOverrides('x')).toEqual({})
    expect(sanitizePriceOverrides([])).toEqual({})
  })

  it('keeps at most the limit', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < MAX_PRICE_OVERRIDES + 20; i++) many[`m${i}`] = { kind: 'rates', input: 1, output: 1 }
    expect(Object.keys(sanitizePriceOverrides(many))).toHaveLength(MAX_PRICE_OVERRIDES)
  })
})

describe('parsePriceForm', () => {
  it('reads a rates form, leaving blank cache rates unset', () => {
    expect(parsePriceForm(form({ model: 'New-Model[1m]', input: '3', output: ' 15 ' }), KNOWN, {}, true)).toEqual({
      model: 'new-model',
      override: { kind: 'rates', input: 3, output: 15, cacheRead: null, cacheWrite: null },
    })
    expect(
      parsePriceForm(form({ input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' }), KNOWN, {}, true)
    ).toEqual({
      model: 'new-model',
      override: { kind: 'rates', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    })
  })

  it('reads a count-as form', () => {
    expect(parsePriceForm(form({ kind: 'alias', target: 'Claude-A' }), KNOWN, {}, true)).toEqual({
      model: 'new-model',
      override: { kind: 'alias', model: 'claude-a' },
    })
  })

  it('accepts a target the user priced by hand', () => {
    const existing: PriceOverrides = { mine: { kind: 'rates', input: 1, output: 2, cacheRead: null, cacheWrite: null } }
    expect(parsePriceForm(form({ kind: 'alias', target: 'mine' }), KNOWN, existing, true)).toHaveProperty('override')
  })

  it('accepts any target when the table could not be listed', () => {
    expect(parsePriceForm(form({ kind: 'alias', target: 'whatever' }), [], {}, true)).toHaveProperty('override')
  })

  it.each([
    ['a blank model', form({ model: ' ', input: '1', output: '2' })],
    ['a blank input rate', form({ output: '2' })],
    ['a blank output rate', form({ input: '1' })],
    ['a rate that is not a number', form({ input: 'abc', output: '2' })],
    ['a negative rate', form({ input: '-1', output: '2' })],
    ['a rate in hex', form({ input: '0x10', output: '2' })],
    ['a rate in exponent form', form({ input: '1e3', output: '2' })],
    ['a rate with a comma', form({ input: '1,5', output: '2' })],
    ['a bad cache rate', form({ input: '1', output: '2', cacheRead: 'x' })],
    ['a blank target', form({ kind: 'alias' })],
    ['a target that is the model itself', form({ kind: 'alias', target: 'NEW-MODEL' })],
    ['a target with no rate', form({ kind: 'alias', target: 'nowhere' })],
  ])('rejects %s', (_, bad) => {
    expect(parsePriceForm(bad, KNOWN, {}, true)).toHaveProperty('error')
  })

  it('rejects a target that is itself counted as another model', () => {
    const existing: PriceOverrides = { 'claude-a': { kind: 'alias', model: 'claude-b' } }
    expect(parsePriceForm(form({ kind: 'alias', target: 'claude-a' }), KNOWN, existing, true)).toHaveProperty('error')
  })

  it('refuses to add a second entry for a model, but edits the one it was opened for', () => {
    const existing: PriceOverrides = { 'new-model': { kind: 'alias', model: 'claude-a' } }
    const typed = form({ model: 'New-Model[1m]', input: '1', output: '2' })
    expect(parsePriceForm(typed, KNOWN, existing, true)).toHaveProperty('error')
    expect(parsePriceForm(typed, KNOWN, existing, false)).toHaveProperty('override')
  })

  it('refuses to count a model as another while something is counted as it', () => {
    const existing: PriceOverrides = { other: { kind: 'alias', model: 'claude-a' } }
    const chained = form({ model: 'claude-a', kind: 'alias', target: 'claude-b' })
    expect(parsePriceForm(chained, KNOWN, existing, true)).toHaveProperty('error')
    expect(parsePriceForm(form({ model: 'claude-a', input: '1', output: '2' }), KNOWN, existing, true)).toHaveProperty(
      'override'
    )
  })

  it('refuses a new entry past the limit but still allows editing one', () => {
    const full: PriceOverrides = {}
    for (let i = 0; i < MAX_PRICE_OVERRIDES; i++) full[`m${i}`] = { kind: 'alias', model: 'claude-a' }
    expect(parsePriceForm(form({ input: '1', output: '2' }), KNOWN, full, true)).toHaveProperty('error')
    expect(parsePriceForm(form({ model: 'm0', input: '1', output: '2' }), KNOWN, full, false)).toHaveProperty('override')
  })
})

describe('aliasTargetMissing', () => {
  it('flags a target with no rate, and a target that is itself counted as another', () => {
    expect(aliasTargetMissing('claude-a', KNOWN, {})).toBe(false)
    expect(aliasTargetMissing('gone', KNOWN, {})).toBe(true)
    expect(aliasTargetMissing('claude-a', KNOWN, { 'claude-a': { kind: 'alias', model: 'claude-b' } })).toBe(true)
  })

  it('does not flag an unknown target when there is no table to check', () => {
    expect(aliasTargetMissing('gone', [], {})).toBe(false)
  })
})

describe('describeOverride', () => {
  it('names the target of a count-as entry', () => {
    expect(describeOverride({ kind: 'alias', model: 'claude-a' })).toBe('Counted as claude-a')
  })

  it('lists the rates that are set', () => {
    expect(describeOverride({ kind: 'rates', input: 3, output: 15, cacheRead: null, cacheWrite: null })).toBe(
      '$3 in · $15 out per 1M'
    )
    expect(describeOverride({ kind: 'rates', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBe(
      '$3 in · $15 out · $0.3 cache read · $3.75 cache write per 1M'
    )
  })
})

describe('formOf', () => {
  const row = { model: 'claude-a', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

  it('starts from the entry being edited', () => {
    expect(formOf('m', { kind: 'alias', model: 'claude-a' }, row)).toMatchObject({ kind: 'alias', target: 'claude-a' })
    expect(
      formOf('m', { kind: 'rates', input: 1, output: 2, cacheRead: null, cacheWrite: 0.5 }, row)
    ).toMatchObject({ kind: 'rates', input: '1', output: '2', cacheRead: '', cacheWrite: '0.5' })
  })

  it('starts from the table input and output rates for a model it knows, and blank otherwise', () => {
    expect(formOf('claude-a', undefined, row)).toMatchObject({ input: '3', output: '15', cacheRead: '', cacheWrite: '' })
    expect(formOf('new', undefined, undefined)).toMatchObject({ model: 'new', input: '', output: '' })
  })
})
