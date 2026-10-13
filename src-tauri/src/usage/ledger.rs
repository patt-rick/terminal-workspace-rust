//! The durable usage history: one record per API response, keyed by a stable
//! hash of the response id. Claude Code deletes old transcripts, so this is
//! the only copy of history older than its retention window.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const RETENTION_MS: i64 = 100 * 24 * 60 * 60 * 1000;
const VERSION: u32 = 1;
const CLOCK_SLACK_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub ts_ms: i64,
    pub model: u32,
    pub project: u32,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub output: u64,
    pub fast: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// "" for this computer's home, else a WSL distro name.
    pub source: String,
    /// Claude's encoded project directory name.
    pub dir: String,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileState {
    pub size: u64,
    pub mtime_ms: i64,
    pub offset: u64,
    pub guard: u64,
}

#[derive(Default)]
pub struct Ledger {
    pub models: Vec<String>,
    pub projects: Vec<ProjectEntry>,
    pub files: HashMap<String, FileState>,
    pub records: HashMap<u64, Record>,
    pub dirty: bool,
}

/// FNV-1a, written out because the ledger is persisted and the standard
/// hasher's output is not stable across Rust versions.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}


/// Where an unreadable ledger is set aside. The timestamp keeps a second
/// incident from replacing the first one's copy.
pub fn corrupt_path(path: &Path, now_ms: i64) -> PathBuf {
    path.with_extension(format!("corrupt-{now_ms}.json"))
}

pub fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("bak.json")
}

enum ReadError {
    Io(String),
    Unusable,
}

type RecordRow = (u64, i64, u32, u32, u64, u64, u64, u64, u64, u8);

#[derive(Serialize, Deserialize)]
struct LedgerFile {
    version: u32,
    models: Vec<String>,
    projects: Vec<ProjectEntry>,
    files: HashMap<String, FileState>,
    records: Vec<RecordRow>,
}

impl Ledger {
    pub fn model_index(&mut self, name: &str) -> u32 {
        if let Some(i) = self.models.iter().position(|m| m == name) {
            return i as u32;
        }
        self.models.push(name.to_string());
        self.dirty = true;
        (self.models.len() - 1) as u32
    }

    pub fn project_index(&mut self, source: &str, dir: &str, cwd: Option<&str>) -> u32 {
        if let Some(i) = self
            .projects
            .iter()
            .position(|p| p.source == source && p.dir == dir)
        {
            if self.projects[i].cwd.is_none() && cwd.is_some() {
                self.projects[i].cwd = cwd.map(str::to_string);
                self.dirty = true;
            }
            return i as u32;
        }
        self.projects.push(ProjectEntry {
            source: source.to_string(),
            dir: dir.to_string(),
            cwd: cwd.map(str::to_string),
        });
        self.dirty = true;
        (self.projects.len() - 1) as u32
    }

    /// One record per response: the largest output wins, and on a tie the
    /// later arrival wins.
    pub fn upsert(&mut self, key: u64, record: Record) {
        match self.records.get(&key) {
            Some(existing) if existing.output > record.output => {}
            Some(existing) if *existing == record => {}
            _ => {
                self.records.insert(key, record);
                self.dirty = true;
            }
        }
    }

    /// Drop records past retention. Skipped when the clock reads more than a
    /// day past the newest record: a clock jumped far forward would otherwise
    /// erase the whole history, and nothing new is arriving to make room for.
    pub fn prune(&mut self, now_ms: i64) {
        let Some(newest) = self.records.values().map(|r| r.ts_ms).max() else {
            return;
        };
        if now_ms - newest > CLOCK_SLACK_MS {
            return;
        }
        let cutoff = now_ms - RETENTION_MS;
        let before = self.records.len();
        self.records.retain(|_, r| r.ts_ms >= cutoff);
        if self.records.len() != before {
            self.dirty = true;
        }
    }

    pub fn history_start(&self) -> Option<i64> {
        self.records.values().map(|r| r.ts_ms).min()
    }

    fn read(path: &Path) -> Result<Option<Ledger>, ReadError> {
        let raw = match fs::read(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ReadError::Io(e.to_string())),
        };
        let file = serde_json::from_slice::<LedgerFile>(&raw)
            .ok()
            .filter(|f| f.version == VERSION)
            .ok_or(ReadError::Unusable)?;
        let records = file
            .records
            .into_iter()
            .map(|(key, ts_ms, model, project, input, cache_read, w5, w1, output, fast)| {
                (
                    key,
                    Record {
                        ts_ms,
                        model,
                        project,
                        input,
                        cache_read,
                        cache_write_5m: w5,
                        cache_write_1h: w1,
                        output,
                        fast: fast != 0,
                    },
                )
            })
            .collect();
        Ok(Some(Ledger {
            models: file.models,
            projects: file.projects,
            files: file.files,
            records,
            dirty: false,
        }))
    }

    /// The ledger may hold history that exists nowhere else, so loading never
    /// puts it at risk. A file that cannot be read at all is an error: nothing
    /// is loaded, so nothing can be saved over it. A file that reads but does
    /// not parse is moved aside under a unique name and the previous save is
    /// used in its place.
    pub fn load(path: &Path, now_ms: i64) -> Result<Ledger, String> {
        match Self::read(path) {
            Ok(Some(ledger)) => return Ok(ledger),
            Ok(None) => {}
            Err(ReadError::Io(e)) => return Err(format!("could not read the usage ledger: {e}")),
            Err(ReadError::Unusable) => {
                fs::rename(path, corrupt_path(path, now_ms))
                    .map_err(|e| format!("could not set aside an unreadable usage ledger: {e}"))?;
            }
        }
        match Self::read(&backup_path(path)) {
            Ok(Some(mut ledger)) => {
                ledger.dirty = true;
                Ok(ledger)
            }
            Ok(None) | Err(ReadError::Unusable) => Ok(Ledger::default()),
            Err(ReadError::Io(e)) => Err(format!("could not read the usage ledger backup: {e}")),
        }
    }

    /// Written to a temp file and flushed to disk before it replaces the
    /// ledger; the ledger it replaces is kept as the backup.
    pub fn save(&self, path: &Path) -> AppResult<()> {
        let mut records: Vec<RecordRow> = self
            .records
            .iter()
            .map(|(key, r)| {
                (
                    *key,
                    r.ts_ms,
                    r.model,
                    r.project,
                    r.input,
                    r.cache_read,
                    r.cache_write_5m,
                    r.cache_write_1h,
                    r.output,
                    u8::from(r.fast),
                )
            })
            .collect();
        records.sort_unstable_by_key(|row| (row.1, row.0));
        let file = LedgerFile {
            version: VERSION,
            models: self.models.clone(),
            projects: self.projects.clone(),
            files: self.files.clone(),
            records,
        };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        let mut out = fs::File::create(&tmp)?;
        out.write_all(serde_json::to_string(&file)?.as_bytes())?;
        out.sync_all()?;
        drop(out);
        if path.exists() {
            fs::rename(path, backup_path(path))?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ts_ms: i64, output: u64) -> Record {
        Record {
            ts_ms,
            model: 0,
            project: 0,
            input: 1,
            cache_read: 2,
            cache_write_5m: 3,
            cache_write_1h: 4,
            output,
            fast: false,
        }
    }

    #[test]
    fn fnv1a64_matches_reference_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn model_and_project_tables_dedupe() {
        let mut l = Ledger::default();
        assert_eq!(l.model_index("opus"), 0);
        assert_eq!(l.model_index("haiku"), 1);
        assert_eq!(l.model_index("opus"), 0);
        assert_eq!(l.project_index("", "C--repo", None), 0);
        assert_eq!(l.project_index("Ubuntu", "C--repo", Some("/mnt/c/repo")), 1);
        assert_eq!(l.project_index("", "C--repo", Some(r"C:\repo")), 0);
        assert_eq!(l.projects[0].cwd.as_deref(), Some(r"C:\repo"));
        assert_eq!(l.project_index("", "C--repo", Some(r"C:\other")), 0);
        assert_eq!(l.projects[0].cwd.as_deref(), Some(r"C:\repo"));
    }

    #[test]
    fn upsert_keeps_the_larger_output_and_the_later_on_a_tie() {
        let mut l = Ledger::default();
        l.upsert(1, rec(10, 16));
        l.upsert(1, rec(11, 394));
        assert_eq!(l.records[&1].output, 394);
        l.upsert(1, rec(12, 16));
        assert_eq!(l.records[&1].output, 394);
        assert_eq!(l.records[&1].ts_ms, 11);
        l.upsert(1, rec(13, 394));
        assert_eq!(l.records[&1].ts_ms, 13);
        assert_eq!(l.records.len(), 1);
    }

    #[test]
    fn upsert_marks_dirty_only_on_change() {
        let mut l = Ledger::default();
        l.upsert(1, rec(10, 5));
        assert!(l.dirty);
        l.dirty = false;
        l.upsert(1, rec(10, 5));
        assert!(!l.dirty);
        l.upsert(1, rec(10, 4));
        assert!(!l.dirty);
        l.upsert(2, rec(10, 5));
        assert!(l.dirty);
    }

    #[test]
    fn prune_drops_only_old_records() {
        let mut l = Ledger::default();
        let now = 1_000 * RETENTION_MS;
        l.upsert(1, rec(now - RETENTION_MS - 1, 1));
        l.upsert(2, rec(now - RETENTION_MS + 1, 1));
        l.upsert(3, rec(now, 1));
        l.dirty = false;
        l.prune(now);
        assert!(!l.records.contains_key(&1));
        assert!(l.records.contains_key(&2));
        assert!(l.records.contains_key(&3));
        assert!(l.dirty);
        assert_eq!(l.history_start(), Some(now - RETENTION_MS + 1));
    }

    #[test]
    fn prune_is_skipped_when_the_clock_is_far_past_the_newest_record() {
        let mut l = Ledger::default();
        let now = 1_000 * RETENTION_MS;
        l.upsert(1, rec(now - 2 * RETENTION_MS, 1));
        l.dirty = false;
        l.prune(now);
        assert_eq!(l.records.len(), 1);
        assert!(!l.dirty);
    }

    #[test]
    fn round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        let mut l = Ledger::default();
        let m = l.model_index("claude-opus-5-5");
        let p = l.project_index("", "C--repo", Some(r"C:\repo"));
        let mut r = rec(1_790_866_930_985, 218);
        r.model = m;
        r.project = p;
        r.fast = true;
        l.upsert(u64::MAX - 7, r.clone());
        l.files.insert(
            "a.jsonl".to_string(),
            FileState { size: 9, mtime_ms: 8, offset: 7, guard: u64::MAX },
        );
        l.save(&path).unwrap();

        let back = Ledger::load(&path, 5).unwrap();
        assert_eq!(back.models, vec!["claude-opus-5-5".to_string()]);
        assert_eq!(back.projects, l.projects);
        assert_eq!(back.files, l.files);
        assert_eq!(back.records[&(u64::MAX - 7)], r);
        assert!(!back.dirty);
    }

    #[test]
    fn missing_file_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let l = Ledger::load(&dir.path().join("nope.json"), 5).unwrap();
        assert!(l.records.is_empty());
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::write(&path, "{ not json").unwrap();
        let l = Ledger::load(&path, 5).unwrap();
        assert!(l.records.is_empty());
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(corrupt_path(&path, 5)).unwrap(), "{ not json");
    }

    #[test]
    fn file_that_is_not_text_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::write(&path, [0xff, 0xfe]).unwrap();
        let l = Ledger::load(&path, 5).unwrap();
        assert!(l.records.is_empty());
        assert!(!path.exists());
        assert!(corrupt_path(&path, 5).exists());
    }

    #[test]
    fn other_version_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::write(&path, r#"{"version":99,"models":[],"projects":[],"files":{},"records":[]}"#).unwrap();
        let l = Ledger::load(&path, 5).unwrap();
        assert!(l.records.is_empty());
        assert!(corrupt_path(&path, 5).exists());
    }

    #[test]
    fn a_ledger_that_cannot_be_read_is_an_error_and_is_left_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::create_dir(&path).unwrap();
        assert!(Ledger::load(&path, 5).is_err());
        assert!(path.is_dir());
    }

    #[test]
    fn save_keeps_the_previous_ledger_as_a_backup_that_load_falls_back_to() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        let mut l = Ledger::default();
        l.upsert(1, rec(10, 5));
        l.save(&path).unwrap();
        l.upsert(2, rec(20, 5));
        l.save(&path).unwrap();
        assert_eq!(Ledger::load(&backup_path(&path), 5).unwrap().records.len(), 1);

        fs::write(&path, "").unwrap();
        let recovered = Ledger::load(&path, 7).unwrap();
        assert_eq!(recovered.records.len(), 1);
        assert!(recovered.dirty);
        assert!(corrupt_path(&path, 7).exists());

        assert_eq!(Ledger::load(&path, 8).unwrap().records.len(), 1);
    }
}
