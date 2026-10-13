# Custom Model Prices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user price a model by hand, or count it as another model, on the Usage page.

**Architecture:** Entries live in the app settings and are sent with every summary request. The backend applies them to the loaded rate table before folding, so no price logic is duplicated in the frontend. A new section on the Usage page edits the entries.

**Tech Stack:** Rust (serde), Tauri 2 commands, React 19, Zustand settings store, Vitest.

Spec: `docs/superpowers/specs/2026-10-13-custom-model-prices-design.md`

---

## Files

- Modify: `src-tauri/src/usage/pricing.rs` — `base_name`, `Override`, `validate_overrides`, `apply_overrides`, `PriceRow`, `price_rows`.
- Modify: `src-tauri/src/usage/mod.rs` — `summary` takes overrides; `price_table`.
- Modify: `src-tauri/src/usage/aggregate.rs` — one test.
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` — `usage_summary` argument, `usage_price_table`.
- Create: `src/lib/usage-prices.ts`, `src/lib/usage-prices.test.ts`.
- Modify: `src/lib/ipc.ts`, `src/state/settings.ts`, `src/state/usage.ts`, `src/state/theme-shuffle.test.ts` (settings fixture).
- Create: `src/components/usage/usage-prices.tsx`.
- Modify: `src/components/usage/usage-breakdown.tsx`, `src/components/usage/usage-page.tsx`.
- Modify: `CHANGELOG.md`, `README.md`.

`commands.rs`, `lib.rs`, `ipc.ts` use CRLF line endings; keep them.

---

### Task 1: Overrides in the rate table (Rust, test first)

**Files:** `src-tauri/src/usage/pricing.rs`

- [ ] **Step 1: Write the failing tests** in the existing `tests` module:

```rust
    fn rates(input: f64, output: f64) -> Override {
        Override::Rates { input, output, cache_read: None, cache_write: None }
    }

    fn overrides(entries: &[(&str, Override)]) -> HashMap<String, Override> {
        entries.iter().cloned().map(|(k, v)| (k.to_string(), v)).collect()
    }

    #[test]
    fn base_name_lowercases_and_drops_the_variant() {
        assert_eq!(base_name(" Claude-X[1m] "), "claude-x");
    }

    #[test]
    fn hand_set_rates_price_an_unknown_model_per_million() {
        let t = apply_overrides(&table(), &overrides(&[("New-Model[1m]", rates(3.0, 15.0))]));
        let r = lookup(&t, "new-model").unwrap();
        assert!(close(r.input, 0.000003));
        assert!(close(r.output, 0.000015));
        assert!(close(r.cache_read, 0.000003));
        assert!(close(r.cache_write_5m, 0.000003));
        assert!(close(r.cache_write_1h, 0.000003));
        assert!(close(r.fast_multiplier, 1.0));
    }

    #[test]
    fn hand_set_rates_replace_the_table_and_keep_its_fast_multiplier() {
        let custom = Override::Rates { input: 1.0, output: 2.0, cache_read: Some(0.1), cache_write: Some(1.25) };
        let t = apply_overrides(&table(), &overrides(&[("claude-opus-5-5", custom)]));
        let r = &t["claude-opus-5-5"];
        assert!(close(r.input, 0.000001));
        assert!(close(r.cache_read, 0.0000001));
        assert!(close(r.cache_write_5m, 0.00000125));
        assert!(close(r.cache_write_1h, 0.00000125));
        assert!(close(r.fast_multiplier, 2.0));
    }

    #[test]
    fn a_model_can_be_counted_as_a_table_model_or_a_hand_priced_one() {
        let t = apply_overrides(
            &table(),
            &overrides(&[
                ("mine", rates(3.0, 15.0)),
                ("a", Override::Alias { model: "Claude-Plain".into() }),
                ("b", Override::Alias { model: "mine".into() }),
            ]),
        );
        assert_eq!(t["a"], t["claude-plain"]);
        assert_eq!(t["b"], t["mine"]);
    }

    #[test]
    fn an_unknown_target_and_a_chain_leave_the_model_as_it_was() {
        let t = apply_overrides(
            &table(),
            &overrides(&[
                ("a", Override::Alias { model: "nowhere".into() }),
                ("b", Override::Alias { model: "a".into() }),
                ("claude-plain", Override::Alias { model: "nowhere".into() }),
            ]),
        );
        assert!(!t.contains_key("a"));
        assert!(!t.contains_key("b"));
        assert_eq!(t["claude-plain"], table()["claude-plain"]);
    }

    #[test]
    fn overrides_outside_the_limits_are_rejected() {
        assert!(validate_overrides(&overrides(&[("m", rates(3.0, 15.0))])).is_ok());
        assert!(validate_overrides(&overrides(&[("m", rates(-1.0, 15.0))])).is_err());
        assert!(validate_overrides(&overrides(&[("m", rates(f64::NAN, 15.0))])).is_err());
        assert!(validate_overrides(&overrides(&[("m", rates(3.0, 2_000_000.0))])).is_err());
        assert!(validate_overrides(&overrides(&[(" ", rates(3.0, 15.0))])).is_err());
        assert!(validate_overrides(&overrides(&[("m", Override::Alias { model: "".into() })])).is_err());
        let many: HashMap<String, Override> = (0..201).map(|i| (format!("m{i}"), rates(1.0, 1.0))).collect();
        assert!(validate_overrides(&many).is_err());
    }

    #[test]
    fn price_rows_are_per_million_and_sorted() {
        let rows = price_rows(&table());
        assert_eq!(rows.iter().map(|r| r.model.as_str()).collect::<Vec<_>>(), ["claude-opus-5-5", "claude-plain"]);
        assert!((rows[0].input - 4.0).abs() < 1e-9);
        assert!((rows[0].output - 20.0).abs() < 1e-9);
        assert!((rows[0].cache_read - 0.2).abs() < 1e-9);
        assert!((rows[0].cache_write - 5.0).abs() < 1e-9);
    }
```

- [ ] **Step 2: Run** `cargo test --lib usage::pricing` — expected: does not compile (missing items).

- [ ] **Step 3: Implement** above `read_stored`; change `lookup` to use `base_name`:

```rust
/// How a model name is matched: lower case, without a `[variant]` suffix.
pub fn base_name(model: &str) -> String {
    let lowered = model.trim().to_lowercase();
    lowered.split('[').next().unwrap_or("").trim().to_string()
}

pub fn lookup<'a>(table: &'a RateTable, model: &str) -> Option<&'a Rates> {
    table.get(&base_name(model))
}

/// A user's price for one model. Rates are US dollars per million tokens.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Override {
    /// price the model as another one
    Alias { model: String },
    Rates {
        input: f64,
        output: f64,
        cache_read: Option<f64>,
        cache_write: Option<f64>,
    },
}

const MAX_OVERRIDES: usize = 200;
const MAX_NAME_CHARS: usize = 200;
const MAX_RATE_PER_MILLION: f64 = 1_000_000.0;

pub fn validate_overrides(overrides: &HashMap<String, Override>) -> Result<(), String> {
    if overrides.len() > MAX_OVERRIDES {
        return Err(format!("at most {MAX_OVERRIDES} custom prices are allowed"));
    }
    let name_ok = |name: &str| !base_name(name).is_empty() && name.chars().count() <= MAX_NAME_CHARS;
    let rate_ok = |rate: f64| rate.is_finite() && (0.0..=MAX_RATE_PER_MILLION).contains(&rate);
    for (name, entry) in overrides {
        let ok = name_ok(name)
            && match entry {
                Override::Alias { model } => name_ok(model),
                Override::Rates { input, output, cache_read, cache_write } => {
                    rate_ok(*input)
                        && rate_ok(*output)
                        && cache_read.map_or(true, rate_ok)
                        && cache_write.map_or(true, rate_ok)
                }
            };
        if !ok {
            return Err(format!("custom price for \"{name}\" is not valid"));
        }
    }
    Ok(())
}

/// The table with the user's prices on top. Hand-set rates go in first so a
/// model can be counted as one of them; a target that is unknown, or is only
/// another "count as" entry, leaves the model as it was.
pub fn apply_overrides(table: &RateTable, overrides: &HashMap<String, Override>) -> RateTable {
    const PER_TOKEN: f64 = 1e-6;
    let mut out = table.clone();
    for (name, entry) in overrides {
        let Override::Rates { input, output, cache_read, cache_write } = entry else {
            continue;
        };
        let key = base_name(name);
        let cache_write = cache_write.unwrap_or(*input) * PER_TOKEN;
        out.insert(
            key.clone(),
            Rates {
                input: input * PER_TOKEN,
                output: output * PER_TOKEN,
                cache_read: cache_read.unwrap_or(*input) * PER_TOKEN,
                cache_write_5m: cache_write,
                cache_write_1h: cache_write,
                fast_multiplier: table.get(&key).map_or(1.0, |r| r.fast_multiplier),
            },
        );
    }
    let priced = out.clone();
    for (name, entry) in overrides {
        let Override::Alias { model } = entry else {
            continue;
        };
        if let Some(target) = priced.get(&base_name(model)) {
            out.insert(base_name(name), target.clone());
        }
    }
    out
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    pub model: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// The table in dollars per million tokens, by name, for the price editor.
pub fn price_rows(table: &RateTable) -> Vec<PriceRow> {
    const PER_MILLION: f64 = 1e6;
    let mut rows: Vec<PriceRow> = table
        .iter()
        .map(|(model, r)| PriceRow {
            model: model.clone(),
            input: r.input * PER_MILLION,
            output: r.output * PER_MILLION,
            cache_read: r.cache_read * PER_MILLION,
            cache_write: r.cache_write_5m * PER_MILLION,
        })
        .collect();
    rows.sort_by(|a, b| a.model.cmp(&b.model));
    rows
}
```

- [ ] **Step 4: Run** `cargo test --lib usage::pricing` — expected: all pass, including the existing lookup test.

### Task 2: Summary and commands

**Files:** `src-tauri/src/usage/mod.rs`, `src-tauri/src/usage/aggregate.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Failing test** in `aggregate.rs` tests, next to `separates_models_and_projects_and_flags_unpriced`, reusing that module's ledger helper: build a ledger with one record of an unknown model, fold with the plain table (bucket `priced == false`, `cost_usd == 0.0`), then fold with `apply_overrides(&table, …Rates{input: 1.0, output: 2.0, ..})` and assert `priced == true` and `cost_usd` equals `input_tokens * 1e-6 + output_tokens * 2e-6`.

- [ ] **Step 2: `UsageStore::summary`** takes `overrides: &HashMap<String, pricing::Override>`; after `aggregate::validate` it calls `pricing::validate_overrides(overrides)?`, and folds with `pricing::apply_overrides(&prices.table, overrides)`. Add:

```rust
    /// The loaded rate table, without the user's prices, for the price editor.
    pub fn price_table(&self, now_ms: i64) -> Vec<pricing::PriceRow> {
        pricing::price_rows(&pricing::load(&self.prices_path, now_ms).table)
    }
```

Update the existing `summary` calls in `mod.rs` tests to pass `&HashMap::new()`.

- [ ] **Step 3: Commands.** `usage_summary` gains `overrides: Option<HashMap<String, crate::usage::pricing::Override>>` and passes `&overrides.unwrap_or_default()`. New:

```rust
/// The rate table the Usage page prices with, for choosing a model to count
/// another one as.
#[tauri::command]
pub async fn usage_price_table(app: AppHandle) -> AppResult<Vec<crate::usage::pricing::PriceRow>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::usage::UsageStore>()
            .price_table(crate::claude::creds::now_ms())
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))
}
```

Register `commands::usage_price_table` in `lib.rs` next to `usage_refresh_prices`.

- [ ] **Step 4: Run** `cargo test --lib usage` and `cargo check --no-default-features` — expected: pass.

### Task 3: Frontend helpers (test first)

**Files:** `src/lib/usage-prices.ts`, `src/lib/usage-prices.test.ts`

- [ ] **Step 1: Tests** covering:
  - `priceKey(' Claude-X[1m] ')` is `'claude-x'`.
  - `sanitizePriceOverrides` keeps valid alias and rates entries, re-keys them with `priceKey`, drops entries with a negative, non-finite or over-limit rate, a blank target, a blank key, a non-object, and returns `{}` for non-objects; keeps at most 200.
  - `parsePriceForm` returns `{ model, override }` for a valid rates form (blank cache fields become `null`) and for a valid alias form, and `{ error }` for: blank model, blank or non-numeric input or output, negative rate, alias to itself, alias target that is neither in the known list nor hand-priced (only when the known list is not empty).
  - `describeOverride` gives `Counted as claude-x` and `$3.00 in · $15.00 out per 1M` (adding cache rates when set).

- [ ] **Step 2: Implement**

```ts
export type PriceOverride =
  | { kind: 'alias'; model: string }
  | { kind: 'rates'; input: number; output: number; cacheRead: number | null; cacheWrite: number | null }
export type PriceOverrides = Record<string, PriceOverride>

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

export function priceKey(model: string): string
export function sanitizePriceOverrides(raw: unknown): PriceOverrides
export function parsePriceForm(
  form: PriceForm,
  known: string[],
  existing: PriceOverrides
): { model: string; override: PriceOverride } | { error: string }
export function describeOverride(o: PriceOverride): string
export function formOf(model: string, o: PriceOverride | undefined): PriceForm
```

- [ ] **Step 3: Run** `pnpm test` — expected: pass.

### Task 4: Settings, ipc, store

**Files:** `src/state/settings.ts`, `src/state/theme-shuffle.test.ts`, `src/lib/ipc.ts`, `src/state/usage.ts`

- [ ] `Settings.usagePriceOverrides: PriceOverrides` (default `{}`), read with `sanitizePriceOverrides` in `readStoredSettings` and `replaceAll`, included in `snapshot`, with `setUsagePriceOverrides(overrides)` that sets and commits. Add the field to the fixture in `theme-shuffle.test.ts`.
- [ ] `ipc.usage.summary(boundaries, overrides)` sends `{ boundaries, overrides }`; `ipc.usage.priceTable()` invokes `usage_price_table` and returns `UsagePriceRow[]` (`model`, `input`, `output`, `cacheRead`, `cacheWrite`).
- [ ] `useUsage.load` passes `useSettings.getState().usagePriceOverrides`.
- [ ] Run `pnpm typecheck && pnpm test`.

### Task 5: The section

**Files:** `src/components/usage/usage-prices.tsx`, `usage-breakdown.tsx`, `usage-page.tsx`

- [ ] `UsagePrices({ models, editing, onEdit })`: `models` are the model names in the current summary; `editing` is the model being edited (`''` for a new entry, `null` for none) and is owned by `History` so the Breakdown can open it. It loads `ipc.usage.priceTable()` once, lists entries (model, `describeOverride`, a "target has no rate" note for an alias whose target is neither in the table nor hand-priced, Edit, Remove), and renders the editor described in the spec with `<datalist>` suggestions. Save runs `parsePriceForm`, writes `setUsagePriceOverrides`, calls `useUsage.getState().load(false)` and closes the editor. Esc inside the editor cancels it and stops the event so the page stays open. When `editing` changes to a model, the editor scrolls into view and focuses its first empty field.
- [ ] `UsageBreakdown` gains `custom: Set<string>` (price keys with an entry) and `onSetPrice: (model: string) => void`. In the model view, an unpriced row's cost cell is a **Set price** button (it stops the row's click), and a row whose `priceKey(key)` is in `custom` shows a muted "custom" tag after the label.
- [ ] `History` owns `editing`, renders `<UsagePrices>` under the Breakdown, extends `priceNote` with `, N custom price(s)`, and the unpriced line ends with "Set a price for them under Custom prices."
- [ ] Run `pnpm typecheck && pnpm test && pnpm build`.

### Task 6: Docs and the app

- [ ] `CHANGELOG.md` → Added: "Usage page: custom prices. Set a model's rates per million tokens, or count it as another model, for models the price table does not know or where your rate differs."
- [ ] `README.md`: mention custom prices on the Usage line.
- [ ] In the running app (isolated profile): add an entry for a model in the breakdown, see its cost change; remove it; add a "count as" entry.
- [ ] Final checks: `pnpm typecheck`, `pnpm test`, `pnpm build`, `cargo test --lib`, `cargo check --no-default-features`.
- [ ] Commit only when the owner says so: docs first, then the feature.

## Changes made during the build

The plan review's findings were applied in the code, so it differs from the task text
above in these places. The spec is current.

- `validate_overrides` became `usable_overrides`: an entry outside the limits is left out
  instead of failing the summary, so a bad stored entry cannot lock the Usage page.
- A blank cache rate keeps the table's rate for a model the table knows.
- A target that has a "count as" entry of its own is treated as unknown in the backend and
  refused by the editor.
- `cost` clamps cache savings at zero.
- The fold test asserts the full cost, cache tokens included.
- `parsePriceForm` enforces the entry and name limits; `sanitizePriceOverrides` enforces
  the name limit; alias targets are stored normalised.
- `aliasTargetMissing` and `formOf(model, entry, row)` were added to `usage-prices.ts`;
  the editor is its own component mounted per model, with the model field locked when
  editing; the price table is re-read when the fetched time changes; the "target has no
  rate" note is skipped when the table could not be listed.
- The summary request reads the overrides at the call, so a price saved during a scan
  counts.
- In the Breakdown, the "custom" tag is a button that opens the entry.
- From the code review: `usage_summary` takes the entries as raw JSON and
  `overrides_from_json` drops a malformed one on its own; two stored names for one model
  resolve by name order; `parsePriceForm` takes `isNew` and refuses to add a second entry
  for a model, refuses to count a model as another while something is counted as it, and
  accepts plain decimals only; typing a model the table knows fills its input and output
  rates (cache rates stay blank so the table's are kept); focus returns to the section
  when the editor closes or a row is removed, so Esc still closes the page; the "custom"
  tag no longer gets clipped by a long model name.

## Spec coverage

| Spec section | Task |
|---|---|
| Rules, Backend | 1, 2 |
| Storage | 4 |
| Frontend helpers | 3 |
| Section, Breakdown, footer | 5 |
| Errors | 3 (form), 1 (limits), 5 (target note) |
| Testing | 1, 2, 3, 6 |
