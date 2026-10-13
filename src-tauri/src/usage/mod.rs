//! Claude Code usage history: scan transcripts into a durable ledger, price
//! the records, and aggregate them for the Usage page.

pub mod aggregate;
pub mod ledger;
pub mod pricing;
pub mod record;
pub mod scan;

use aggregate::SummaryBucket;
use ledger::{Ledger, ProjectEntry};
use parking_lot::Mutex;
use scan::SourceReport;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PRICE_RETRY: Duration = Duration::from_secs(60 * 60);
const PRICE_FORCE_FLOOR: Duration = Duration::from_secs(60);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub sources: Vec<SourceReport>,
    pub scan_ms: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageProject {
    pub label: String,
    pub path: Option<String>,
    pub project_id: Option<String>,
    pub distro: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PricingInfo {
    pub tier: &'static str,
    pub fetched_at: Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub buckets: Vec<SummaryBucket>,
    pub projects: Vec<UsageProject>,
    pub pricing: PricingInfo,
    pub history_start_ms: Option<i64>,
}

/// An app project as the usage module needs it.
pub struct AppProject {
    pub id: String,
    pub name: String,
    pub path: String,
}

pub struct UsageStore {
    ledger_path: PathBuf,
    prices_path: PathBuf,
    ledger: Mutex<Option<Ledger>>,
    last_price_attempt: Mutex<Option<Instant>>,
}

fn last_segment(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\']).find(|s| !s.is_empty())
}

fn path_in_source(app_path: &str, source: &str) -> Option<String> {
    if source.is_empty() {
        return Some(app_path.to_string());
    }
    crate::wsl::project_root_in_distro(app_path, source)
}

pub fn resolve_project(entry: &ProjectEntry, apps: &[AppProject]) -> UsageProject {
    let matched = apps.iter().find(|app| {
        path_in_source(&app.path, &entry.source)
            .is_some_and(|p| crate::claude::encode_project_dir(&p) == entry.dir)
    });
    let label = match matched {
        Some(app) => app.name.clone(),
        None => entry
            .cwd
            .as_deref()
            .and_then(last_segment)
            .unwrap_or(&entry.dir)
            .to_string(),
    };
    UsageProject {
        label,
        path: entry.cwd.clone(),
        project_id: matched.map(|app| app.id.clone()),
        distro: (!entry.source.is_empty()).then(|| entry.source.clone()),
    }
}

impl UsageStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            ledger_path: data_dir.join("usage-ledger-v1.json"),
            prices_path: data_dir.join("usage-prices.json"),
            ledger: Mutex::new(None),
            last_price_attempt: Mutex::new(None),
        }
    }

    pub fn prices_path(&self) -> &Path {
        &self.prices_path
    }

    /// A ledger that fails to load is not cached, so the next call tries again
    /// and nothing is ever saved in its place.
    fn with_ledger<T>(&self, now_ms: i64, f: impl FnOnce(&mut Ledger) -> T) -> Result<T, String> {
        let mut guard = self.ledger.lock();
        if guard.is_none() {
            *guard = Some(Ledger::load(&self.ledger_path, now_ms)?);
        }
        Ok(f(guard.as_mut().expect("ledger loaded above")))
    }

    pub fn scan(
        &self,
        roots: &[scan::Root],
        now_ms: i64,
        progress: &mut dyn FnMut(usize, usize),
    ) -> Result<ScanResult, String> {
        let started = Instant::now();
        let sources = self.with_ledger(now_ms, |ledger| {
            let sources = scan::scan(ledger, roots, progress);
            ledger.prune(now_ms);
            if ledger.dirty {
                match ledger.save(&self.ledger_path) {
                    Ok(()) => ledger.dirty = false,
                    Err(e) => eprintln!("usage: could not save ledger: {e}"),
                }
            }
            sources
        })?;
        Ok(ScanResult { sources, scan_ms: started.elapsed().as_millis() as u64 })
    }

    pub fn summary(
        &self,
        boundaries: &[i64],
        apps: &[AppProject],
        now_ms: i64,
    ) -> Result<Summary, String> {
        aggregate::validate(boundaries)?;
        let prices = pricing::load(&self.prices_path, now_ms);
        self.with_ledger(now_ms, |ledger| Summary {
            buckets: aggregate::fold(ledger, &prices.table, boundaries),
            projects: ledger.projects.iter().map(|p| resolve_project(p, apps)).collect(),
            pricing: PricingInfo { tier: prices.tier, fetched_at: prices.fetched_at },
            history_start_ms: ledger.history_start(),
        })
    }

    /// Whether a price fetch may start now; records the attempt when it may.
    pub fn begin_price_attempt(&self, force: bool) -> bool {
        let mut last = self.last_price_attempt.lock();
        let wait = if force { PRICE_FORCE_FLOOR } else { PRICE_RETRY };
        if last.is_some_and(|at| at.elapsed() < wait) {
            return false;
        }
        *last = Some(Instant::now());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn line(id: &str, ts: &str, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","requestId":"req_{id}","cwd":"C:\\repos\\app","message":{{"id":"msg_{id}","model":"claude-opus-5-5","usage":{{"input_tokens":2,"output_tokens":{output}}}}}}}"#
        )
    }

    fn roots(dir: &Path) -> Vec<scan::Root> {
        vec![scan::Root { source: String::new(), label: "This computer".into(), dir: dir.to_path_buf() }]
    }

    const NOW: i64 = 1_791_887_647_500;
    const DAY_START: i64 = 1_791_849_600_000;

    #[test]
    fn resolves_projects_by_encoded_path_then_cwd_then_dir() {
        let apps = vec![AppProject {
            id: "p1".into(),
            name: "My App".into(),
            path: r"C:\repos\app".into(),
        }];
        let matched = resolve_project(
            &ProjectEntry { source: String::new(), dir: "C--repos-app".into(), cwd: Some(r"C:\repos\app".into()) },
            &apps,
        );
        assert_eq!(matched.label, "My App");
        assert_eq!(matched.project_id.as_deref(), Some("p1"));
        assert_eq!(matched.distro, None);

        let by_cwd = resolve_project(
            &ProjectEntry { source: "Ubuntu".into(), dir: "-home-u-other".into(), cwd: Some("/home/u/other".into()) },
            &apps,
        );
        assert_eq!(by_cwd.label, "other");
        assert_eq!(by_cwd.project_id, None);
        assert_eq!(by_cwd.distro.as_deref(), Some("Ubuntu"));

        let by_dir = resolve_project(
            &ProjectEntry { source: String::new(), dir: "C--gone".into(), cwd: None },
            &apps,
        );
        assert_eq!(by_dir.label, "C--gone");
    }

    #[test]
    fn scan_then_summary_end_to_end_and_persists() {
        let data = tempfile::tempdir().unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let file = transcripts.path().join("C--repos-app").join("s1.jsonl");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            format!(
                "{}\n{}\n",
                line("a", "2026-10-13T10:00:00.000Z", 16),
                line("a", "2026-10-13T10:00:01.000Z", 394)
            ),
        )
        .unwrap();

        let store = UsageStore::new(data.path());
        let result = store.scan(&roots(transcripts.path()), NOW, &mut |_, _| {}).unwrap();
        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.sources[0].status, "ok");
        assert!(data.path().join("usage-ledger-v1.json").exists());

        let apps = vec![AppProject { id: "p1".into(), name: "My App".into(), path: r"C:\repos\app".into() }];
        let summary = store
            .summary(&[DAY_START, DAY_START + 86_400_000], &apps, NOW)
            .unwrap();
        assert_eq!(summary.buckets.len(), 1);
        assert_eq!(summary.buckets[0].output, 394);
        assert_eq!(summary.buckets[0].responses, 1);
        assert!(summary.buckets[0].priced);
        assert_eq!(summary.projects[0].label, "My App");
        assert_eq!(summary.pricing.tier, "bundled");
        assert_eq!(summary.history_start_ms, Some(1_791_885_601_000));

        let reopened = UsageStore::new(data.path());
        let again = reopened
            .summary(&[DAY_START, DAY_START + 86_400_000], &apps, NOW)
            .unwrap();
        assert_eq!(again.buckets, summary.buckets);
    }

    #[test]
    fn an_unreadable_ledger_fails_scan_and_summary_without_replacing_it() {
        let data = tempfile::tempdir().unwrap();
        let ledger_path = data.path().join("usage-ledger-v1.json");
        fs::create_dir(&ledger_path).unwrap();
        let transcripts = tempfile::tempdir().unwrap();
        let store = UsageStore::new(data.path());
        assert!(store.scan(&roots(transcripts.path()), NOW, &mut |_, _| {}).is_err());
        assert!(store.summary(&[DAY_START, DAY_START + 1], &[], NOW).is_err());
        assert!(ledger_path.is_dir());
    }

    #[test]
    fn summary_rejects_bad_boundaries() {
        let data = tempfile::tempdir().unwrap();
        let store = UsageStore::new(data.path());
        assert!(store.summary(&[5], &[], NOW).is_err());
    }

    #[test]
    fn price_attempts_are_rate_limited() {
        let data = tempfile::tempdir().unwrap();
        let store = UsageStore::new(data.path());
        assert!(store.begin_price_attempt(false));
        assert!(!store.begin_price_attempt(false));
        assert!(!store.begin_price_attempt(true));
    }
}
