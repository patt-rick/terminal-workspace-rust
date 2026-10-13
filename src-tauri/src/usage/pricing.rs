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

pub fn lookup<'a>(table: &'a RateTable, model: &str) -> Option<&'a Rates> {
    let lowered = model.trim().to_lowercase();
    let base = lowered.split('[').next().unwrap_or(&lowered);
    table.get(base)
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
        cache_savings: record.cache_read as f64 * (rates.input - rates.cache_read) * m,
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
