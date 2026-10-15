//! Model rates and cost arithmetic. Rates come from LiteLLM's public price
//! table; costs are API-equivalent estimates, not subscription charges.

use super::ledger::Record;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub const PRICES_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const FRESH_MS: i64 = 24 * 60 * 60 * 1000;
const SNAPSHOT: &str = include_str!("prices-snapshot.json");

#[derive(Clone, Debug, PartialEq)]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub fast_multiplier: f64,
}

pub type RateTable = HashMap<String, Rates>;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cost {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub cache_savings: f64,
}

impl Cost {
    pub fn total(&self) -> f64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
}

pub struct Loaded {
    pub table: RateTable,
    /// "fresh" | "stale" | "bundled"
    pub tier: &'static str,
    pub fetched_at: Option<i64>,
}

/// The Anthropic entries of a LiteLLM document that have both basic rates.
pub fn filter_anthropic(doc: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(entries) = doc.as_object() else {
        return out;
    };
    for (name, entry) in entries {
        let is_anthropic = entry.get("litellm_provider").and_then(Value::as_str) == Some("anthropic");
        let has_rates = entry.get("input_cost_per_token").and_then(Value::as_f64).is_some()
            && entry.get("output_cost_per_token").and_then(Value::as_f64).is_some();
        if is_anthropic && has_rates {
            out.insert(name.clone(), entry.clone());
        }
    }
    out
}

pub fn parse_table(entries: &Map<String, Value>) -> RateTable {
    let mut table = RateTable::new();
    for (name, entry) in entries {
        let number = |field: &str| entry.get(field).and_then(Value::as_f64);
        let (Some(input), Some(output)) = (number("input_cost_per_token"), number("output_cost_per_token"))
        else {
            continue;
        };
        let cache_write_5m = number("cache_creation_input_token_cost").unwrap_or(input);
        let fast_multiplier = entry
            .get("provider_specific_entry")
            .and_then(|p| p.get("fast"))
            .and_then(Value::as_f64)
            .filter(|m| *m > 0.0)
            .unwrap_or(1.0);
        table.insert(
            name.trim().to_lowercase(),
            Rates {
                input,
                output,
                cache_read: number("cache_read_input_token_cost").unwrap_or(input),
                cache_write_5m,
                cache_write_1h: number("cache_creation_input_token_cost_above_1hr")
                    .unwrap_or(cache_write_5m),
                fast_multiplier,
            },
        );
    }
    table
}

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

pub const MAX_OVERRIDES: usize = 200;
const MAX_NAME_CHARS: usize = 200;
const MAX_RATE_PER_MILLION: f64 = 1_000_000.0;

fn name_ok(name: &str) -> bool {
    !base_name(name).is_empty() && name.chars().count() <= MAX_NAME_CHARS
}

fn rate_ok(rate: f64) -> bool {
    rate.is_finite() && (0.0..=MAX_RATE_PER_MILLION).contains(&rate)
}

/// The usable entries, keyed the way models are matched. An entry that is out
/// of range is left out rather than failing the request: a bad stored entry
/// must not take the Usage page down with it. Past the limit, the entries
/// that sort last are the ones dropped, so the result does not depend on map
/// order.
pub fn usable_overrides(overrides: &HashMap<String, Override>) -> HashMap<String, Override> {
    let mut entries: Vec<(String, &String, &Override)> = overrides
        .iter()
        .filter(|(name, entry)| {
            name_ok(name)
                && match entry {
                    Override::Alias { model } => name_ok(model),
                    Override::Rates { input, output, cache_read, cache_write } => {
                        rate_ok(*input)
                            && rate_ok(*output)
                            && cache_read.is_none_or(rate_ok)
                            && cache_write.is_none_or(rate_ok)
                    }
                }
        })
        .map(|(name, entry)| (base_name(name), name, entry))
        .collect();
    // By stored name within a key, so two names for one model always resolve
    // the same way (the first wins, as in the frontend).
    entries.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
    entries.dedup_by(|a, b| a.0 == b.0);
    entries.truncate(MAX_OVERRIDES);
    entries.into_iter().map(|(key, _, entry)| (key, entry.clone())).collect()
}

/// The entries of a settings object that have the expected shape. One that
/// does not (an unknown kind, a rate stored as text) is dropped on its own
/// instead of failing the whole request.
pub fn overrides_from_json(raw: HashMap<String, Value>) -> HashMap<String, Override> {
    raw.into_iter()
        .filter_map(|(name, value)| Some((name, serde_json::from_value(value).ok()?)))
        .collect()
}

/// The table with the user's prices on top.
///
/// Hand-set rates go in first, so a model can be counted as one of them. A
/// blank cache rate keeps the table's rate for that model, or the input rate
/// for a model the table does not know (what the table itself does for an
/// entry with no cache rates). A "count as" target that is unknown, or is
/// itself counted as something else, leaves the model as it was.
pub fn apply_overrides(table: &RateTable, overrides: &HashMap<String, Override>) -> RateTable {
    const PER_TOKEN: f64 = 1e-6;
    let overrides = usable_overrides(overrides);
    let mut out = table.clone();
    for (key, entry) in &overrides {
        let Override::Rates { input, output, cache_read, cache_write } = entry else {
            continue;
        };
        let known = table.get(key);
        let input = input * PER_TOKEN;
        let cache_write = cache_write.map(|rate| rate * PER_TOKEN);
        out.insert(
            key.clone(),
            Rates {
                input,
                output: output * PER_TOKEN,
                cache_read: cache_read
                    .map(|rate| rate * PER_TOKEN)
                    .or(known.map(|r| r.cache_read))
                    .unwrap_or(input),
                cache_write_5m: cache_write.or(known.map(|r| r.cache_write_5m)).unwrap_or(input),
                cache_write_1h: cache_write.or(known.map(|r| r.cache_write_1h)).unwrap_or(input),
                fast_multiplier: known.map_or(1.0, |r| r.fast_multiplier),
            },
        );
    }
    let priced = out.clone();
    for (key, entry) in &overrides {
        let Override::Alias { model } = entry else {
            continue;
        };
        let target = base_name(model);
        if matches!(overrides.get(&target), Some(Override::Alias { .. })) {
            continue;
        }
        if let Some(rates) = priced.get(&target) {
            out.insert(key.clone(), rates.clone());
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

pub fn cost(rates: &Rates, record: &Record) -> Cost {
    let m = if record.fast { rates.fast_multiplier } else { 1.0 };
    Cost {
        input: record.input as f64 * rates.input * m,
        cache_read: record.cache_read as f64 * rates.cache_read * m,
        cache_write: (record.cache_write_5m as f64 * rates.cache_write_5m
            + record.cache_write_1h as f64 * rates.cache_write_1h)
            * m,
        output: record.output as f64 * rates.output * m,
        // A hand-set cache rate above the input rate saves nothing; it is not a loss.
        cache_savings: record.cache_read as f64 * (rates.input - rates.cache_read).max(0.0) * m,
    }
}

fn read_stored(path: &Path) -> Option<(i64, Map<String, Value>)> {
    let raw = fs::read_to_string(path).ok()?;
    let doc: Value = serde_json::from_str(&raw).ok()?;
    let fetched_at = doc.get("fetchedAt")?.as_i64()?;
    let entries = doc.get("entries")?.as_object()?.clone();
    Some((fetched_at, entries))
}

fn bundled() -> RateTable {
    serde_json::from_str::<Value>(SNAPSHOT)
        .ok()
        .map(|doc| parse_table(&filter_anthropic(&doc)))
        .unwrap_or_default()
}

/// Best table available without touching the network.
pub fn load(path: &Path, now_ms: i64) -> Loaded {
    if let Some((fetched_at, entries)) = read_stored(path) {
        let table = parse_table(&entries);
        if !table.is_empty() {
            let tier = if now_ms - fetched_at < FRESH_MS { "fresh" } else { "stale" };
            return Loaded { table, tier, fetched_at: Some(fetched_at) };
        }
    }
    Loaded { table: bundled(), tier: "bundled", fetched_at: None }
}

/// Validate a fetched LiteLLM body and store its Anthropic entries. Returns
/// whether the rates differ from what was stored before.
pub fn store_fetched(path: &Path, body: &str, now_ms: i64) -> Result<bool, String> {
    let doc: Value = serde_json::from_str(body).map_err(|e| format!("price table is not JSON: {e}"))?;
    let entries = filter_anthropic(&doc);
    if parse_table(&entries).is_empty() {
        return Err("price table has no usable Anthropic entries".to_string());
    }
    let changed = read_stored(path).map(|(_, old)| old != entries).unwrap_or(true);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let stored = json!({ "fetchedAt": now_ms, "entries": entries });
    fs::write(&tmp, stored.to_string()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"{
      "sample_spec": {"litellm_provider": "one of many"},
      "claude-opus-5-5": {"litellm_provider":"anthropic","input_cost_per_token":0.000004,"output_cost_per_token":0.00002,"cache_read_input_token_cost":2e-7,"cache_creation_input_token_cost":0.000005,"cache_creation_input_token_cost_above_1hr":0.000008,"provider_specific_entry":{"fast":2}},
      "claude-plain": {"litellm_provider":"anthropic","input_cost_per_token":0.000001,"output_cost_per_token":0.000005},
      "claude-half": {"litellm_provider":"anthropic","input_cost_per_token":0.000001},
      "gpt-x": {"litellm_provider":"openai","input_cost_per_token":0.000001,"output_cost_per_token":0.000002}
    }"#;

    fn table() -> RateTable {
        parse_table(&filter_anthropic(&serde_json::from_str(DOC).unwrap()))
    }

    fn record(fast: bool) -> Record {
        Record {
            ts_ms: 0,
            model: 0,
            project: 0,
            input: 1000,
            cache_read: 10_000,
            cache_write_5m: 100,
            cache_write_1h: 200,
            output: 500,
            fast,
        }
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    #[test]
    fn keeps_only_anthropic_entries_with_both_rates() {
        let t = table();
        assert_eq!(t.len(), 2);
        assert!(t.contains_key("claude-opus-5-5"));
        assert!(t.contains_key("claude-plain"));
    }

    #[test]
    fn missing_cache_rates_fall_back() {
        let t = table();
        let plain = &t["claude-plain"];
        assert!(close(plain.cache_read, 0.000001));
        assert!(close(plain.cache_write_5m, 0.000001));
        assert!(close(plain.cache_write_1h, 0.000001));
        assert!(close(plain.fast_multiplier, 1.0));
        let opus = &t["claude-opus-5-5"];
        assert!(close(opus.cache_write_1h, 0.000008));
        assert!(close(opus.fast_multiplier, 2.0));
    }

    #[test]
    fn lookup_is_exact_after_lowercasing_and_stripping_a_variant() {
        let t = table();
        assert!(lookup(&t, "claude-opus-5-5").is_some());
        assert!(lookup(&t, "Claude-Opus-5-5").is_some());
        assert!(lookup(&t, "claude-opus-5-5[1m]").is_some());
        assert!(lookup(&t, "claude-opus-5").is_none());
        assert!(lookup(&t, "gpt-x").is_none());
    }

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
    fn blank_cache_rates_keep_the_table_rates_of_a_known_model() {
        let t = apply_overrides(&table(), &overrides(&[("claude-opus-5-5", rates(1.0, 2.0))]));
        let r = &t["claude-opus-5-5"];
        assert!(close(r.input, 0.000001));
        assert!(close(r.cache_read, 2e-7));
        assert!(close(r.cache_write_5m, 0.000005));
        assert!(close(r.cache_write_1h, 0.000008));
    }

    #[test]
    fn a_model_can_be_counted_as_a_table_model_or_a_hand_priced_one() {
        let t = apply_overrides(
            &table(),
            &overrides(&[
                ("mine", rates(3.0, 15.0)),
                ("a", Override::Alias { model: "Claude-Plain".into() }),
                ("b", Override::Alias { model: "mine".into() }),
                ("claude-opus-5-5", Override::Alias { model: "claude-plain".into() }),
            ]),
        );
        assert_eq!(t["a"], t["claude-plain"]);
        assert_eq!(t["b"], t["mine"]);
        assert_eq!(t["claude-opus-5-5"], t["claude-plain"]);
    }

    #[test]
    fn an_unknown_target_and_a_chain_leave_the_model_as_it_was() {
        let t = apply_overrides(
            &table(),
            &overrides(&[
                ("a", Override::Alias { model: "nowhere".into() }),
                ("b", Override::Alias { model: "a".into() }),
                ("claude-plain", Override::Alias { model: "nowhere".into() }),
                // The target is in the table but is itself counted as something else.
                ("claude-opus-5-5", Override::Alias { model: "claude-plain".into() }),
                ("c", Override::Alias { model: "claude-opus-5-5".into() }),
            ]),
        );
        assert!(!t.contains_key("a"));
        assert!(!t.contains_key("b"));
        assert!(!t.contains_key("c"));
        assert_eq!(t["claude-plain"], table()["claude-plain"]);
    }

    #[test]
    fn entries_outside_the_limits_are_left_out_not_fatal() {
        let usable = usable_overrides(&overrides(&[
            ("Good[1m]", rates(3.0, 15.0)),
            ("negative", rates(-1.0, 15.0)),
            ("nan", rates(f64::NAN, 15.0)),
            ("huge", rates(3.0, 2_000_000.0)),
            (" ", rates(3.0, 15.0)),
            ("blank-target", Override::Alias { model: "".into() }),
        ]));
        assert_eq!(usable.keys().collect::<Vec<_>>(), ["good"]);
        let many: HashMap<String, Override> = (0..250).map(|i| (format!("m{i:03}"), rates(1.0, 1.0))).collect();
        let kept = usable_overrides(&many);
        assert_eq!(kept.len(), MAX_OVERRIDES);
        assert!(kept.contains_key("m000") && !kept.contains_key("m249"));
    }

    #[test]
    fn two_names_for_one_model_resolve_the_same_way_every_time() {
        for _ in 0..20 {
            let usable = usable_overrides(&overrides(&[("a[1m]", rates(9.0, 9.0)), ("A", rates(1.0, 1.0))]));
            assert_eq!(usable["a"], rates(1.0, 1.0));
        }
    }

    #[test]
    fn a_malformed_entry_is_dropped_on_its_own() {
        let raw: HashMap<String, Value> = serde_json::from_str(
            r#"{"good":{"kind":"rates","input":3,"output":15},"text":{"kind":"rates","input":"3","output":15},"odd":{"kind":"free"},"n":5}"#,
        )
        .unwrap();
        let parsed = overrides_from_json(raw);
        assert_eq!(parsed.keys().collect::<Vec<_>>(), ["good"]);
    }

    #[test]
    fn a_cache_rate_above_the_input_rate_saves_nothing() {
        let custom = Override::Rates { input: 1.0, output: 2.0, cache_read: Some(5.0), cache_write: None };
        let t = apply_overrides(&table(), &overrides(&[("m", custom)]));
        assert!(close(cost(&t["m"], &record(false)).cache_savings, 0.0));
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

    #[test]
    fn an_entry_reads_from_the_settings_json() {
        let parsed: HashMap<String, Override> = serde_json::from_str(
            r#"{"a":{"kind":"alias","model":"b"},"c":{"kind":"rates","input":3,"output":15,"cacheRead":null,"cacheWrite":3.75}}"#,
        )
        .unwrap();
        assert_eq!(parsed["a"], Override::Alias { model: "b".into() });
        assert_eq!(
            parsed["c"],
            Override::Rates { input: 3.0, output: 15.0, cache_read: None, cache_write: Some(3.75) }
        );
    }

    #[test]
    fn prices_a_record_by_token_type() {
        let t = table();
        let c = cost(&t["claude-opus-5-5"], &record(false));
        assert!(close(c.input, 0.004));
        assert!(close(c.cache_read, 0.002));
        assert!(close(c.cache_write, 0.0021));
        assert!(close(c.output, 0.01));
        assert!(close(c.total(), 0.0181));
        assert!(close(c.cache_savings, 0.038));
    }

    #[test]
    fn fast_records_use_the_multiplier() {
        let t = table();
        let c = cost(&t["claude-opus-5-5"], &record(true));
        assert!(close(c.total(), 0.0362));
        assert!(close(c.cache_savings, 0.076));
    }

    #[test]
    fn bundled_snapshot_parses_and_is_used_when_nothing_is_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = load(&dir.path().join("usage-prices.json"), 1_000);
        assert_eq!(loaded.tier, "bundled");
        assert_eq!(loaded.fetched_at, None);
        assert!(!loaded.table.is_empty());
    }

    #[test]
    fn stored_table_is_fresh_then_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-prices.json");
        assert_eq!(store_fetched(&path, DOC, 1_000), Ok(true));
        let fresh = load(&path, 1_000 + FRESH_MS - 1);
        assert_eq!(fresh.tier, "fresh");
        assert_eq!(fresh.fetched_at, Some(1_000));
        assert_eq!(fresh.table.len(), 2);
        let stale = load(&path, 1_000 + FRESH_MS);
        assert_eq!(stale.tier, "stale");
    }

    #[test]
    fn storing_the_same_table_again_reports_no_change_but_updates_the_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-prices.json");
        assert_eq!(store_fetched(&path, DOC, 1_000), Ok(true));
        assert_eq!(store_fetched(&path, DOC, 2_000), Ok(false));
        assert_eq!(load(&path, 2_000).fetched_at, Some(2_000));
    }

    #[test]
    fn unusable_responses_are_rejected_and_keep_the_existing_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-prices.json");
        store_fetched(&path, DOC, 1_000).unwrap();
        assert!(store_fetched(&path, "<html>login</html>", 2_000).is_err());
        assert!(store_fetched(&path, r#"{"gpt-x":{"litellm_provider":"openai"}}"#, 2_000).is_err());
        assert_eq!(load(&path, 2_000).fetched_at, Some(1_000));
    }

    #[test]
    fn unreadable_file_on_disk_falls_back_to_bundled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-prices.json");
        fs::write(&path, "garbage").unwrap();
        assert_eq!(load(&path, 1_000).tier, "bundled");
    }
}
