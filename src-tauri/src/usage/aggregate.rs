//! Fold ledger records into (slot, model, project) buckets for a list of
//! time boundaries supplied by the frontend.

use super::ledger::Ledger;
use super::pricing::{cost, lookup, RateTable};
use serde::Serialize;
use std::collections::HashMap;

const MAX_BOUNDARIES: usize = 200;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryBucket {
    pub slot: u32,
    pub model: String,
    pub project: u32,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub cost_usd: f64,
    pub input_cost_usd: f64,
    pub cache_read_cost_usd: f64,
    pub cache_write_cost_usd: f64,
    pub output_cost_usd: f64,
    pub cache_savings_usd: f64,
    pub priced: bool,
    pub responses: u64,
}

pub fn validate(boundaries: &[i64]) -> Result<(), String> {
    if boundaries.len() < 2 {
        return Err("at least two boundaries are required".to_string());
    }
    if boundaries.len() > MAX_BOUNDARIES {
        return Err(format!("at most {MAX_BOUNDARIES} boundaries are allowed"));
    }
    if boundaries.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err("boundaries must be strictly ascending".to_string());
    }
    Ok(())
}

/// Slot `i` covers `[boundaries[i], boundaries[i + 1])`.
pub fn fold(ledger: &Ledger, table: &RateTable, boundaries: &[i64]) -> Vec<SummaryBucket> {
    let rates: Vec<_> = ledger.models.iter().map(|m| lookup(table, m)).collect();
    let mut buckets: HashMap<(u32, u32, u32), SummaryBucket> = HashMap::new();

    for record in ledger.records.values() {
        let after = boundaries.partition_point(|b| *b <= record.ts_ms);
        if after == 0 || after == boundaries.len() {
            continue;
        }
        let slot = (after - 1) as u32;
        let Some(model) = ledger.models.get(record.model as usize) else {
            continue;
        };
        let rate = rates[record.model as usize];
        let bucket = buckets
            .entry((slot, record.model, record.project))
            .or_insert_with(|| SummaryBucket {
                slot,
                model: model.clone(),
                project: record.project,
                priced: rate.is_some(),
                ..SummaryBucket::default()
            });
        bucket.input += record.input;
        bucket.cache_read += record.cache_read;
        bucket.cache_write += record.cache_write_5m + record.cache_write_1h;
        bucket.output += record.output;
        bucket.responses += 1;
        if let Some(rate) = rate {
            let c = cost(rate, record);
            bucket.input_cost_usd += c.input;
            bucket.cache_read_cost_usd += c.cache_read;
            bucket.cache_write_cost_usd += c.cache_write;
            bucket.output_cost_usd += c.output;
            bucket.cost_usd += c.total();
            bucket.cache_savings_usd += c.cache_savings;
        }
    }

    let mut out: Vec<SummaryBucket> = buckets.into_values().collect();
    out.sort_by(|a, b| {
        (a.slot, &a.model, a.project).cmp(&(b.slot, &b.model, b.project))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::ledger::Record;
    use crate::usage::pricing::Rates;

    fn table() -> RateTable {
        let mut t = RateTable::new();
        t.insert(
            "priced".to_string(),
            Rates {
                input: 1.0,
                output: 10.0,
                cache_read: 0.1,
                cache_write_5m: 2.0,
                cache_write_1h: 3.0,
                fast_multiplier: 1.0,
            },
        );
        t
    }

    fn add(ledger: &mut Ledger, key: u64, ts_ms: i64, model: &str, project: u32) {
        let model = ledger.model_index(model);
        ledger.upsert(
            key,
            Record {
                ts_ms,
                model,
                project,
                input: 1,
                cache_read: 10,
                cache_write_5m: 1,
                cache_write_1h: 1,
                output: 2,
                fast: false,
            },
        );
    }

    #[test]
    fn validates_boundaries() {
        assert!(validate(&[1, 2]).is_ok());
        assert!(validate(&[]).is_err());
        assert!(validate(&[1]).is_err());
        assert!(validate(&[1, 1]).is_err());
        assert!(validate(&[2, 1]).is_err());
        let many: Vec<i64> = (0..=MAX_BOUNDARIES as i64).collect();
        assert!(validate(&many).is_err());
    }

    #[test]
    fn assigns_slots_with_half_open_ranges() {
        let mut ledger = Ledger::default();
        add(&mut ledger, 1, 999, "priced", 0);
        add(&mut ledger, 2, 1000, "priced", 0);
        add(&mut ledger, 3, 2000, "priced", 0);
        add(&mut ledger, 4, 2999, "priced", 0);
        add(&mut ledger, 5, 3000, "priced", 0);
        let buckets = fold(&ledger, &table(), &[1000, 2000, 3000]);
        assert_eq!(buckets.len(), 2);
        assert_eq!((buckets[0].slot, buckets[0].responses), (0, 1));
        assert_eq!((buckets[1].slot, buckets[1].responses), (1, 2));
    }

    #[test]
    fn sums_tokens_and_costs_per_bucket() {
        let mut ledger = Ledger::default();
        add(&mut ledger, 1, 1500, "priced", 0);
        add(&mut ledger, 2, 1600, "priced", 0);
        let b = &fold(&ledger, &table(), &[1000, 2000])[0];
        assert_eq!((b.input, b.cache_read, b.cache_write, b.output), (2, 20, 4, 4));
        assert!(b.priced);
        assert!((b.input_cost_usd - 2.0).abs() < 1e-9);
        assert!((b.cache_read_cost_usd - 2.0).abs() < 1e-9);
        assert!((b.cache_write_cost_usd - 10.0).abs() < 1e-9);
        assert!((b.output_cost_usd - 40.0).abs() < 1e-9);
        assert!((b.cost_usd - 54.0).abs() < 1e-9);
        assert!((b.cache_savings_usd - 18.0).abs() < 1e-9);
    }

    #[test]
    fn separates_models_and_projects_and_flags_unpriced() {
        let mut ledger = Ledger::default();
        add(&mut ledger, 1, 1500, "priced", 0);
        add(&mut ledger, 2, 1500, "mystery", 0);
        add(&mut ledger, 3, 1500, "priced", 1);
        let buckets = fold(&ledger, &table(), &[1000, 2000]);
        assert_eq!(buckets.len(), 3);
        let mystery = buckets.iter().find(|b| b.model == "mystery").unwrap();
        assert!(!mystery.priced);
        assert_eq!(mystery.cost_usd, 0.0);
        assert_eq!(mystery.output, 2);
        assert!(buckets.iter().any(|b| b.model == "priced" && b.project == 1));
    }

    #[test]
    fn output_is_sorted_by_slot_then_model_then_project() {
        let mut ledger = Ledger::default();
        add(&mut ledger, 1, 2500, "b", 0);
        add(&mut ledger, 2, 1500, "b", 1);
        add(&mut ledger, 3, 1500, "a", 0);
        add(&mut ledger, 4, 1500, "b", 0);
        let order: Vec<(u32, String, u32)> = fold(&ledger, &table(), &[1000, 2000, 3000])
            .into_iter()
            .map(|b| (b.slot, b.model, b.project))
            .collect();
        assert_eq!(
            order,
            vec![
                (0, "a".to_string(), 0),
                (0, "b".to_string(), 0),
                (0, "b".to_string(), 1),
                (1, "b".to_string(), 0),
            ]
        );
    }
}
