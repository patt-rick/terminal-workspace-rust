# Custom model prices — design

Roadmap item 1.7: override a model's rates, or count one model as another.

## Why

The Usage page prices tokens from LiteLLM's public table. A model the table does not
know shows as **Unpriced** and adds nothing to the cost figures. That happens with a model
released after the last table update, with a model reached through another provider
(the "Use other models" terminals), and with internal names. The user may also want
different rates than the list price, such as a negotiated rate.

## What it is

A **Custom prices** section on the Usage page, under the Breakdown table. Each entry is
for one model and is one of:

- **Count as another model** — price this model with the rates of a model the table knows.
- **Set rates** — US dollars per million tokens for input and output, and optionally for
  cache reads and cache writes.

An entry wins over the table for that model. Removing it restores the table's rate, or
Unpriced.

## Rules

- **Keys.** An entry is keyed by the model name in lower case with any `[variant]` suffix
  removed, the same way the table is looked up. `Claude-X[1m]` and `claude-x` are one
  entry.
- **Set rates.** Input and output are required. A blank cache rate keeps the table's rate
  for that model; for a model the table does not know it is the input rate, which is what
  the table does for a model with no cache rates. A cache-write rate that is set covers
  both the 5-minute and the 1-hour kind. Fast-mode responses keep the table's multiplier
  for that model when it has one, otherwise 1. When adding an entry for a model the table
  knows, the editor fills in the table's input and output rates and leaves the cache
  rates blank, so the table's cache rates (including its 1-hour write rate) are kept.
  Rates are typed as plain decimals.
- **One entry per model.** Adding a second entry for a model is refused; the existing one
  is edited instead. A model that other entries are counted as cannot itself become a
  "count as" entry.
- **Count as.** The target is looked up after the "set rates" entries are applied, so a
  model can be counted as one the user priced by hand. Chains are not followed: a target
  that has a "count as" entry of its own is treated as unknown, even when the table
  prices it, and the editor refuses it. A target that is unknown leaves the model as it
  was. A "count as" entry wins over the table's own rate for that model.
- **Limits.** At most 200 entries; a rate must be a number from 0 to 1,000,000; a name is
  at most 200 characters. The backend leaves out an entry outside these instead of
  failing the request, so a bad stored entry can never take the page down; the frontend
  drops such entries when it loads settings and the editor refuses to save one.
- **Cache savings** never go below zero: a cache-read rate set above the input rate saves
  nothing.
- An entry is not renamed: the model field is locked while editing.
- Costs stay labelled as estimates. The footer's price note adds "N custom prices" when
  there are any.

## Storage

In the app settings as `usagePriceOverrides`, a map from key to entry:

```ts
type PriceOverride =
  | { kind: 'alias'; model: string }
  | { kind: 'rates'; input: number; output: number; cacheRead: number | null; cacheWrite: number | null }
```

The settings file is stored by the backend as opaque JSON, so no backend settings change
is needed. The entries travel with each summary request, the way the time boundaries do,
so the backend keeps no second copy.

## Backend

`src-tauri/src/usage/pricing.rs`:

- `base_name(model) -> String` — the key rule above; `lookup` uses it.
- `Override` — serde enum matching `PriceOverride` (tag `kind`, camelCase).
- `overrides_from_json(HashMap<String, Value>) -> HashMap<String, Override>` — the command
  takes the entries as raw JSON, so one with the wrong shape is dropped on its own.
- `usable_overrides(&HashMap<String, Override>) -> HashMap<String, Override>` — the
  entries inside the limits, under normalised keys.
- `apply_overrides(table, overrides) -> RateTable` — rates entries first, then aliases.
- `price_rows(table) -> Vec<PriceRow>` — model, input, output, cache read, cache write in
  dollars per million, sorted by name, for the editor.

`UsageStore::summary` takes the overrides and applies them to the loaded table before
folding. `usage_summary` gains an optional `overrides` argument. A new command
`usage_price_table` returns `price_rows` of the loaded table (without overrides).

## Frontend

- `src/lib/usage-prices.ts` (pure, tested): the types, `priceKey`, `sanitizePriceOverrides`,
  `parsePriceForm` (form strings to an entry or an error message), `describeOverride`.
- Settings: `usagePriceOverrides` and `setUsagePriceOverrides`.
- `useUsage.load` sends the current overrides with the summary request.
- `src/components/usage/usage-prices.tsx` — the section:
  - a list of entries: model, what it is priced as, **Edit**, **Remove**;
  - **Add** opens the editor: a model field (suggesting the models in the current
    breakdown), a two-way switch between the two kinds, then either a target field
    (suggesting the table's models, with their rates shown once chosen) or four number
    fields; **Save** and **Cancel**. Esc in the editor cancels the editor and does not
    close the page.
  - Saving or removing stores the settings and reloads the summary without a rescan.
- Breakdown table, model view: an Unpriced cell becomes a **Set price** button that opens
  the editor for that model; a model with an entry shows a small "custom" tag.
- The footer's unpriced-tokens line points at the section.

## Errors

| Case | What the user sees |
|---|---|
| Blank model, blank or non-numeric rate, negative rate | Message under the editor; nothing saved |
| Target not in the table and not hand-priced | Message under the editor; nothing saved |
| Target removed from the table later | The model goes back to what it was; the entry stays and is marked "target has no rate" |
| Price table could not be listed | Target field has no suggestions and any target is accepted; an unknown one leaves the model as it was |

## Testing

- Rust: `base_name`; `apply_overrides` (rates replace a table entry, price an unknown
  model, defaults for blank cache rates, kept fast multiplier, alias to a table model,
  alias to a hand-priced model, alias to an unknown model, no chains, key normalised);
  `validate_overrides` limits; a `fold` test where an override turns an unpriced bucket
  into a priced one; `price_rows` units and order.
- TypeScript: `priceKey`, `sanitizePriceOverrides`, `parsePriceForm`, `describeOverride`.
- In the app: an unpriced model gets a price through **Set price** and its row shows a
  cost; removing the entry returns it to Unpriced.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo test --lib`,
  `cargo check --no-default-features`.

## Not in this version

Per-date rates, separate 5-minute and 1-hour cache-write rates, a custom fast-mode
multiplier, import and export of entries.
