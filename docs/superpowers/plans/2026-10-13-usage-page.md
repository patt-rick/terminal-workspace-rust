# Usage Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Usage page that shows Claude Code token and cost history by day, model and project, plus pooled subscription limits across accounts.

**Architecture:** A new Rust module `src-tauri/src/usage/` scans Claude transcripts incrementally into a durable ledger (one record per API response, kept 100 days), prices records from a LiteLLM-derived rate table with a bundled fallback, and folds them into buckets for time boundaries the frontend sends. A React full-pane layer renders a hand-drawn SVG chart, totals, a breakdown table and a limits view built on the existing accounts store.

**Tech Stack:** Rust (serde, serde_json, parking_lot, reqwest, tempfile for tests), Tauri 2 commands and events, React 19, Zustand 5, Tailwind v4, Vitest.

Spec: `docs/superpowers/specs/2026-10-13-usage-page-design.md`

**Conventions for every task:**

- Rust tests run from `src-tauri/`: `cargo test --lib usage::`. If linking fails on this Windows machine, use `& "src-tauri/build-msvc.cmd" test --lib usage::` from the repo root in PowerShell (see README "Windows note").
- TypeScript tests run from the repo root: `pnpm test`.
- Commit messages follow the repo's conventional style and carry **no** `Co-Authored-By` trailer. The repo commits directly to `master`.
- Do not add comments unless they say something the code cannot (project rule).

---

## File Structure

**New (Rust):**
- `src-tauri/src/usage/mod.rs` — `UsageStore` managed state, `scan()` / `summary()`, wire types, project resolution.
- `src-tauri/src/usage/record.rs` — parse one transcript line; ISO timestamp parser.
- `src-tauri/src/usage/ledger.rs` — durable record set: FNV-1a hash, upsert, prune, load, save.
- `src-tauri/src/usage/scan.rs` — transcript roots, recursive file listing, incremental parse.
- `src-tauri/src/usage/pricing.rs` — rate table parse, lookup, cost, tiers, storing a fetched table.
- `src-tauri/src/usage/aggregate.rs` — boundary validation and folding records into buckets.
- `src-tauri/src/usage/prices-snapshot.json` — bundled Anthropic rates.

**New (frontend):**
- `src/lib/usage.ts` + `src/lib/usage.test.ts` — pure helpers.
- `src/state/usage.ts` — zustand store.
- `src/components/usage/share-bar.tsx`, `usage-chart.tsx`, `usage-totals.tsx`, `usage-breakdown.tsx`, `usage-limits.tsx`, `usage-page.tsx`.

**Modified:**
- `src-tauri/src/lib.rs` — declare `mod usage`, manage `UsageStore`, register three commands.
- `src-tauri/src/commands.rs` — `usage_scan`, `usage_summary`, `usage_refresh_prices`.
- `src/lib/ipc.ts` — wire types and `ipc.usage`.
- `src/app.tsx` — mount the page, shortcut, header button, terminal `active` gating.
- `src/components/claude-accounts/account-pill.tsx`, `accounts-popover.tsx` — "Usage" link.
- `README.md`, `CHANGELOG.md`.

---

### Task 1: Transcript line parser

**Files:**
- Create: `src-tauri/src/usage/record.rs`
- Create: `src-tauri/src/usage/mod.rs`
- Modify: `src-tauri/src/lib.rs` (module list near line 21)

- [ ] **Step 1: Declare the module**

In `src-tauri/src/lib.rs`, add `mod usage;` after `mod state;`:

```rust
mod settings;
mod state;
mod usage;
mod wsl;
```

Create `src-tauri/src/usage/mod.rs`:

```rust
//! Claude Code usage history: scan transcripts into a durable ledger, price
//! the records, and aggregate them for the Usage page.

pub mod record;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/usage/record.rs` with only the tests and the public signatures stubbed:

```rust
//! Parse one line of a Claude Code transcript into its usage numbers.

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    /// `"{message.id}:{requestId}"`; None when the line has neither.
    pub key: Option<String>,
    pub model: String,
    pub cwd: Option<String>,
    pub ts_ms: i64,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub output: u64,
    pub fast: bool,
}

pub fn parse_ts_ms(_s: &str) -> Option<i64> {
    None
}

pub fn parse_line(_line: &str) -> Option<ParsedLine> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"parentUuid":"x","isSidechain":false,"requestId":"req_1","type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","cwd":"C:\\repos\\app","sessionId":"s1","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":300,"cache_read_input_tokens":1000,"output_tokens":218,"cache_creation":{"ephemeral_1h_input_tokens":200,"ephemeral_5m_input_tokens":100},"service_tier":"standard","speed":"standard","fallback_credit":null}}}"#;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_ts_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts_ms("2024-02-29T12:00:00.000Z"), Some(1_709_208_000_000));
        assert_eq!(parse_ts_ms("2026-10-01T15:02:10.985Z"), Some(1_790_866_930_985));
        assert_eq!(parse_ts_ms("2026-10-13T10:34:07.5Z"), Some(1_791_887_647_500));
    }

    #[test]
    fn rejects_malformed_timestamps() {
        assert_eq!(parse_ts_ms(""), None);
        assert_eq!(parse_ts_ms("2026-10-01 15:02:10Z"), None);
        assert_eq!(parse_ts_ms("2026-10-01T15:02:10"), None);
        assert_eq!(parse_ts_ms("2026-13-01T15:02:10Z"), None);
        assert_eq!(parse_ts_ms("2026-10-01T15:02:10.Z"), None);
    }

    #[test]
    fn parses_a_real_shaped_line() {
        let p = parse_line(LINE).unwrap();
        assert_eq!(p.key.as_deref(), Some("msg_1:req_1"));
        assert_eq!(p.model, "claude-opus-5-5");
        assert_eq!(p.cwd.as_deref(), Some(r"C:\repos\app"));
        assert_eq!(p.ts_ms, 1_790_866_930_985);
        assert_eq!(p.input, 2);
        assert_eq!(p.cache_read, 1000);
        assert_eq!(p.cache_write_5m, 100);
        assert_eq!(p.cache_write_1h, 200);
        assert_eq!(p.output, 218);
        assert!(!p.fast);
    }

    #[test]
    fn tolerates_null_and_absent_fields() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"id":"msg_2","model":"claude-opus-5-5","usage":{"input_tokens":5,"output_tokens":null,"speed":null,"cache_creation":null}}}"#;
        let p = parse_line(line).unwrap();
        assert_eq!(p.key.as_deref(), Some("msg_2:"));
        assert_eq!(p.cwd, None);
        assert_eq!((p.input, p.cache_read, p.output), (5, 0, 0));
        assert_eq!((p.cache_write_5m, p.cache_write_1h), (0, 0));
        assert!(!p.fast);
    }

    #[test]
    fn cache_write_without_split_counts_as_five_minute() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","requestId":"r","message":{"model":"claude-opus-5-5","usage":{"cache_creation_input_tokens":70}}}"#;
        let p = parse_line(line).unwrap();
        assert_eq!(p.key.as_deref(), Some(":r"));
        assert_eq!((p.cache_write_5m, p.cache_write_1h), (70, 0));
    }

    #[test]
    fn fast_speed_is_flagged() {
        let line = LINE.replace(r#""speed":"standard""#, r#""speed":"fast""#);
        assert!(parse_line(&line).unwrap().fast);
    }

    #[test]
    fn line_with_neither_id_has_no_key() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1}}}"#;
        assert_eq!(parse_line(line).unwrap().key, None);
    }

    #[test]
    fn rejects_lines_that_are_not_usage() {
        assert!(parse_line("not json \"usage\"").is_none());
        assert!(parse_line(r#"{"type":"user","message":{"content":"hi"}}"#).is_none());
        let user = LINE.replace(r#""type":"assistant""#, r#""type":"user""#);
        assert!(parse_line(&user).is_none());
        let synthetic = LINE.replace("claude-opus-5-5", "<synthetic>");
        assert!(parse_line(&synthetic).is_none());
        let no_ts = LINE.replace(r#""timestamp":"2026-10-01T15:02:10.985Z","#, "");
        assert!(parse_line(&no_ts).is_none());
        let no_usage = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"id":"m","model":"x","content":"the word \"usage\" appears"}}"#;
        assert!(parse_line(no_usage).is_none());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `src-tauri/`): `cargo test --lib usage::record`
Expected: FAIL — `parses_timestamps`, `parses_a_real_shaped_line` and others fail because the stubs return `None`.

- [ ] **Step 4: Implement**

Replace the two stub functions in `record.rs` with:

```rust
use serde::Deserialize;

#[derive(Deserialize)]
struct RawLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    cwd: Option<String>,
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct RawUsage {
    input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation: Option<RawCacheCreation>,
    speed: Option<String>,
}

#[derive(Deserialize)]
struct RawCacheCreation {
    ephemeral_5m_input_tokens: Option<u64>,
    ephemeral_1h_input_tokens: Option<u64>,
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z` → epoch milliseconds.
pub fn parse_ts_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[b.len() - 1] != b'Z'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let frac = s.get(19..s.len() - 1)?;
    let ms = if frac.is_empty() {
        0
    } else {
        let digits = frac.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let mut value = 0i64;
        let mut count = 0;
        for c in digits.bytes().take(3) {
            value = value * 10 + i64::from(c - b'0');
            count += 1;
        }
        while count < 3 {
            value *= 10;
            count += 1;
        }
        value
    };
    Some(days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms)
}

pub fn parse_line(line: &str) -> Option<ParsedLine> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let raw: RawLine = serde_json::from_str(line).ok()?;
    if raw.kind.as_deref() != Some("assistant") {
        return None;
    }
    let message = raw.message?;
    let usage = message.usage?;
    let model = message
        .model
        .filter(|m| !m.is_empty() && m != "<synthetic>")?;
    let ts_ms = parse_ts_ms(raw.timestamp.as_deref()?)?;
    let key = match (message.id.as_deref(), raw.request_id.as_deref()) {
        (None, None) => None,
        (id, request) => Some(format!("{}:{}", id.unwrap_or(""), request.unwrap_or(""))),
    };
    let (cache_write_5m, cache_write_1h) = match usage.cache_creation {
        Some(split) => (
            split.ephemeral_5m_input_tokens.unwrap_or(0),
            split.ephemeral_1h_input_tokens.unwrap_or(0),
        ),
        None => (usage.cache_creation_input_tokens.unwrap_or(0), 0),
    };
    Some(ParsedLine {
        key,
        model,
        cwd: raw.cwd,
        ts_ms,
        input: usage.input_tokens.unwrap_or(0),
        cache_read: usage.cache_read_input_tokens.unwrap_or(0),
        cache_write_5m,
        cache_write_1h,
        output: usage.output_tokens.unwrap_or(0),
        fast: usage.speed.as_deref() == Some("fast"),
    })
}
```

Place the `use serde::Deserialize;` line directly under the module doc comment.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --lib usage::record`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/usage/mod.rs src-tauri/src/usage/record.rs
git commit -m "feat(usage): parse usage records from claude transcript lines"
```

---

### Task 2: Ledger

**Files:**
- Create: `src-tauri/src/usage/ledger.rs`
- Modify: `src-tauri/src/usage/mod.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/usage/mod.rs`, add:

```rust
pub mod ledger;
pub mod record;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/usage/ledger.rs`:

```rust
//! The durable usage history: one record per API response, keyed by a stable
//! hash of the response id. Claude Code deletes old transcripts, so this is
//! the only copy of history older than its retention window.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const RETENTION_MS: i64 = 100 * 24 * 60 * 60 * 1000;
const VERSION: u32 = 1;

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

pub fn fnv1a64(_bytes: &[u8]) -> u64 {
    0
}

pub fn corrupt_path(path: &Path) -> PathBuf {
    path.with_extension("corrupt.json")
}

impl Ledger {
    pub fn model_index(&mut self, _name: &str) -> u32 {
        0
    }

    pub fn project_index(&mut self, _source: &str, _dir: &str, _cwd: Option<&str>) -> u32 {
        0
    }

    pub fn upsert(&mut self, _key: u64, _record: Record) {}

    pub fn prune(&mut self, _now_ms: i64) {}

    pub fn history_start(&self) -> Option<i64> {
        None
    }

    pub fn load(_path: &Path) -> Ledger {
        Ledger::default()
    }

    pub fn save(&self, _path: &Path) -> AppResult<()> {
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
        l.dirty = false;
        l.prune(now);
        assert!(!l.records.contains_key(&1));
        assert!(l.records.contains_key(&2));
        assert!(l.dirty);
        assert_eq!(l.history_start(), Some(now - RETENTION_MS + 1));
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

        let back = Ledger::load(&path);
        assert_eq!(back.models, vec!["claude-opus-5-5".to_string()]);
        assert_eq!(back.projects, l.projects);
        assert_eq!(back.files, l.files);
        assert_eq!(back.records[&(u64::MAX - 7)], r);
        assert!(!back.dirty);
    }

    #[test]
    fn missing_file_loads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let l = Ledger::load(&dir.path().join("nope.json"));
        assert!(l.records.is_empty());
    }

    #[test]
    fn corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::write(&path, "{ not json").unwrap();
        let l = Ledger::load(&path);
        assert!(l.records.is_empty());
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(corrupt_path(&path)).unwrap(), "{ not json");
    }

    #[test]
    fn file_that_is_not_text_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::write(&path, [0xff, 0xfe]).unwrap();
        let l = Ledger::load(&path);
        assert!(l.records.is_empty());
        assert!(!path.exists());
        assert!(corrupt_path(&path).exists());
    }

    #[test]
    fn other_version_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-ledger-v1.json");
        fs::write(&path, r#"{"version":99,"models":[],"projects":[],"files":{},"records":[]}"#).unwrap();
        let l = Ledger::load(&path);
        assert!(l.records.is_empty());
        assert!(corrupt_path(&path).exists());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --lib usage::ledger`
Expected: FAIL — every test except `missing_file_loads_empty` fails against the stubs.

- [ ] **Step 4: Implement**

Replace `fnv1a64` and the `impl Ledger` block with:

```rust
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

    pub fn prune(&mut self, now_ms: i64) {
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

    /// A file that exists but cannot be understood is moved aside, never
    /// overwritten: it may hold history that exists nowhere else.
    pub fn load(path: &Path) -> Ledger {
        let raw = match fs::read(path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ledger::default(),
            Err(_) => {
                let _ = fs::rename(path, corrupt_path(path));
                return Ledger::default();
            }
        };
        let parsed = serde_json::from_slice::<LedgerFile>(&raw)
            .ok()
            .filter(|f| f.version == VERSION);
        let Some(file) = parsed else {
            let _ = fs::rename(path, corrupt_path(path));
            return Ledger::default();
        };
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
        Ledger {
            models: file.models,
            projects: file.projects,
            files: file.files,
            records,
            dirty: false,
        }
    }

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
        fs::write(&tmp, serde_json::to_string(&file)?)?;
        fs::rename(&tmp, path)?;
        Ok(())
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --lib usage::ledger`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/usage/mod.rs src-tauri/src/usage/ledger.rs
git commit -m "feat(usage): durable ledger of per-response usage records"
```

---

### Task 3: Incremental transcript scan

**Files:**
- Create: `src-tauri/src/usage/scan.rs`
- Modify: `src-tauri/src/usage/mod.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/usage/mod.rs`:

```rust
pub mod ledger;
pub mod record;
pub mod scan;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/usage/scan.rs`:

```rust
//! Find Claude transcripts and feed their usage lines into the ledger,
//! reading only bytes appended since the previous scan.

use super::ledger::{fnv1a64, FileState, Ledger, Record};
use super::record::parse_line;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const GUARD_LEN: u64 = 64;

pub struct Root {
    /// "" for this computer's home, else a WSL distro name.
    pub source: String,
    pub label: String,
    pub dir: PathBuf,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub label: String,
    /// "ok" | "missing" | "partial"
    pub status: &'static str,
    pub files: u32,
    pub skipped: u32,
}

pub fn roots(_home: &Path) -> Vec<Root> {
    Vec::new()
}

pub fn scan(
    _ledger: &mut Ledger,
    _roots: &[Root],
    _progress: &mut dyn FnMut(usize, usize),
) -> Vec<SourceReport> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(id: &str, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","requestId":"req_{id}","cwd":"C:\\repo","message":{{"id":"msg_{id}","model":"claude-opus-5-5","usage":{{"input_tokens":2,"cache_read_input_tokens":10,"output_tokens":{output}}}}}}}"#
        )
    }

    fn root_in(dir: &Path) -> Vec<Root> {
        vec![Root { source: String::new(), label: "This computer".into(), dir: dir.to_path_buf() }]
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn append(path: &Path, content: &str) {
        let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    fn run(ledger: &mut Ledger, roots: &[Root]) -> Vec<SourceReport> {
        scan(ledger, roots, &mut |_, _| {})
    }

    fn total_output(ledger: &Ledger) -> u64 {
        ledger.records.values().map(|r| r.output).sum()
    }

    #[test]
    fn missing_root_is_reported_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::default();
        let reports = run(&mut ledger, &root_in(&tmp.path().join("absent")));
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].status, "missing");
        assert_eq!(reports[0].files, 0);
    }

    #[test]
    fn walks_into_subagent_directories() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("C--repo/s1.jsonl"), &format!("{}\n", line("a", 5)));
        write(
            &tmp.path().join("C--repo/s1/subagents/agent-x.jsonl"),
            &format!("{}\n", line("b", 7)),
        );
        write(&tmp.path().join("C--repo/s1/subagents/agent-x.meta.json"), "{}");
        let mut ledger = Ledger::default();
        let reports = run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(reports[0].status, "ok");
        assert_eq!(reports[0].files, 2);
        assert_eq!(ledger.records.len(), 2);
        assert_eq!(total_output(&ledger), 12);
        assert_eq!(ledger.projects.len(), 1);
        assert_eq!(ledger.projects[0].dir, "C--repo");
        assert_eq!(ledger.projects[0].cwd.as_deref(), Some(r"C:\repo"));
    }

    #[test]
    fn repeated_lines_of_one_response_keep_the_largest_output() {
        let tmp = tempfile::tempdir().unwrap();
        let body = format!("{}\n{}\n{}\n", line("a", 16), line("a", 16), line("a", 394));
        write(&tmp.path().join("C--repo/s1.jsonl"), &body);
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 1);
        assert_eq!(total_output(&ledger), 394);
    }

    #[test]
    fn the_same_response_in_two_files_is_counted_once() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join("C--repo/s1/subagents/agent-a.jsonl"),
            &format!("{}\n", line("dup", 40)),
        );
        write(
            &tmp.path().join("C--repo/s1/subagents/agent-b.jsonl"),
            &format!("{}\n", line("dup", 40)),
        );
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 1);
        assert_eq!(total_output(&ledger), 40);
    }

    #[test]
    fn unchanged_file_is_not_read_again() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("C--repo/s1.jsonl"), &format!("{}\n", line("a", 5)));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        ledger.records.clear();
        ledger.dirty = false;
        run(&mut ledger, &root_in(tmp.path()));
        assert!(ledger.records.is_empty());
        assert!(!ledger.dirty);
    }

    #[test]
    fn grown_file_is_read_from_its_offset_only() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("C--repo/s1.jsonl");
        write(&path, &format!("{}\n", line("a", 5)));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        ledger.records.clear();
        append(&path, &format!("{}\n", line("b", 7)));
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 1);
        assert_eq!(total_output(&ledger), 7);
    }

    #[test]
    fn a_response_split_across_two_scans_is_one_record() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("C--repo/s1.jsonl");
        write(&path, &format!("{}\n", line("a", 16)));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        append(&path, &format!("{}\n", line("a", 394)));
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 1);
        assert_eq!(total_output(&ledger), 394);
    }

    #[test]
    fn rewritten_file_is_reread_without_double_counting() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("C--repo/s1.jsonl");
        write(&path, &format!("{}\n{}\n", line("a", 5), line("b", 7)));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        write(
            &path,
            &format!("{}\n{}\n{}\n", line("zz", 1), line("a", 5), line("c", 9)),
        );
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 4);
        assert_eq!(total_output(&ledger), 22);
    }

    #[test]
    fn unterminated_last_line_waits_for_the_next_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("C--repo/s1.jsonl");
        let full = line("b", 7);
        let (head, tail) = full.split_at(full.len() / 2);
        write(&path, &format!("{}\n{}", line("a", 5), head));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 1);
        append(&path, &format!("{tail}\n"));
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 2);
        assert_eq!(total_output(&ledger), 12);
    }

    #[test]
    fn keyless_lines_are_not_double_counted_on_reread() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("C--repo/s1.jsonl");
        let keyless = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"model":"claude-opus-5-5","usage":{"output_tokens":3}}}"#;
        write(&path, &format!("{keyless}\n{keyless}\n"));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 2);
        ledger.files.clear();
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.records.len(), 2);
    }

    #[test]
    fn file_state_for_deleted_files_is_dropped_but_records_stay() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("C--repo/s1.jsonl");
        write(&path, &format!("{}\n", line("a", 5)));
        let mut ledger = Ledger::default();
        run(&mut ledger, &root_in(tmp.path()));
        assert_eq!(ledger.files.len(), 1);
        fs::remove_file(&path).unwrap();
        run(&mut ledger, &root_in(tmp.path()));
        assert!(ledger.files.is_empty());
        assert_eq!(ledger.records.len(), 1);
    }

    #[test]
    fn progress_reports_done_and_total() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("C--repo/a.jsonl"), &format!("{}\n", line("a", 5)));
        write(&tmp.path().join("C--repo/b.jsonl"), &format!("{}\n", line("b", 5)));
        let mut ledger = Ledger::default();
        let mut seen = Vec::new();
        scan(&mut ledger, &root_in(tmp.path()), &mut |done, total| seen.push((done, total)));
        assert_eq!(seen, vec![(1, 2), (2, 2)]);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --lib usage::scan`
Expected: FAIL — 11 of 12 fail (empty reports, empty ledger). `unchanged_file_is_not_read_again` passes against the stub because it asserts that nothing was read; leave it as written.

- [ ] **Step 4: Implement**

Replace the `roots` and `scan` stubs with:

```rust
pub fn roots(home: &Path) -> Vec<Root> {
    let mut out = vec![Root {
        source: String::new(),
        label: "This computer".to_string(),
        dir: home.join(".claude").join("projects"),
    }];
    #[cfg(windows)]
    for distro in crate::wsl::list_distros().into_iter().filter(|d| d.running) {
        if let Some(distro_home) = crate::wsl::distro_home(&distro.name) {
            out.push(Root {
                source: distro.name.clone(),
                label: format!("WSL {}", distro.name),
                dir: crate::wsl::unc_path(&distro.name, &distro_home)
                    .join(".claude")
                    .join("projects"),
            });
        }
    }
    out
}

struct Listing {
    files: Vec<PathBuf>,
    skipped: u32,
}

/// None when the root itself cannot be read.
fn list_files(root: &Path) -> Option<Listing> {
    let top = fs::read_dir(root).ok()?;
    let mut listing = Listing { files: Vec::new(), skipped: 0 };
    let mut pending: Vec<fs::ReadDir> = vec![top];
    while let Some(entries) = pending.pop() {
        for entry in entries {
            let Ok(entry) = entry else {
                listing.skipped += 1;
                continue;
            };
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                listing.skipped += 1;
                continue;
            };
            if kind.is_dir() {
                match fs::read_dir(&path) {
                    Ok(inner) => pending.push(inner),
                    Err(_) => listing.skipped += 1,
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                listing.files.push(path);
            }
        }
    }
    listing.files.sort();
    Some(listing)
}

fn guard_at(file: &mut fs::File, offset: u64) -> std::io::Result<u64> {
    let len = offset.min(GUARD_LEN);
    file.seek(SeekFrom::Start(offset - len))?;
    let mut buf = vec![0u8; len as usize];
    file.read_exact(&mut buf)?;
    Ok(fnv1a64(&buf))
}

fn project_dir(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn scan_file(ledger: &mut Ledger, root: &Root, path: &Path) -> std::io::Result<()> {
    let meta = fs::metadata(path)?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let file_key = path.to_string_lossy().into_owned();
    let previous = ledger.files.get(&file_key).cloned();
    if let Some(prev) = &previous {
        if prev.size == size && prev.mtime_ms == mtime_ms {
            return Ok(());
        }
    }

    let mut file = fs::File::open(path)?;
    let mut start = 0u64;
    if let Some(prev) = &previous {
        if prev.offset > 0 && size >= prev.offset && guard_at(&mut file, prev.offset)? == prev.guard {
            start = prev.offset;
        }
    }
    file.seek(SeekFrom::Start(start))?;

    let dir = project_dir(&root.dir, path);
    let mut project: Option<u32> = None;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut buf: Vec<u8> = Vec::new();
    let mut offset = start;
    loop {
        buf.clear();
        let read = reader.read_until(b'\n', &mut buf)?;
        if read == 0 || buf.last() != Some(&b'\n') {
            break;
        }
        let line_start = offset;
        offset += read as u64;
        let Ok(text) = std::str::from_utf8(&buf) else {
            continue;
        };
        let Some(parsed) = parse_line(text.trim_end()) else {
            continue;
        };
        let project_index = match project {
            Some(index) => index,
            None => {
                let index = ledger.project_index(&root.source, &dir, parsed.cwd.as_deref());
                project = Some(index);
                index
            }
        };
        let key = match &parsed.key {
            Some(key) => fnv1a64(key.as_bytes()),
            None => fnv1a64(format!("{file_key}@{line_start}").as_bytes()),
        };
        let model = ledger.model_index(&parsed.model);
        ledger.upsert(
            key,
            Record {
                ts_ms: parsed.ts_ms,
                model,
                project: project_index,
                input: parsed.input,
                cache_read: parsed.cache_read,
                cache_write_5m: parsed.cache_write_5m,
                cache_write_1h: parsed.cache_write_1h,
                output: parsed.output,
                fast: parsed.fast,
            },
        );
    }

    let mut file = reader.into_inner();
    let guard = guard_at(&mut file, offset)?;
    ledger
        .files
        .insert(file_key, FileState { size, mtime_ms, offset, guard });
    ledger.dirty = true;
    Ok(())
}

pub fn scan(
    ledger: &mut Ledger,
    roots: &[Root],
    progress: &mut dyn FnMut(usize, usize),
) -> Vec<SourceReport> {
    let listings: Vec<Option<Listing>> = roots.iter().map(|r| list_files(&r.dir)).collect();
    let total: usize = listings.iter().flatten().map(|l| l.files.len()).sum();
    let mut done = 0usize;
    let mut reports = Vec::with_capacity(roots.len());

    for (root, listing) in roots.iter().zip(listings) {
        let Some(listing) = listing else {
            reports.push(SourceReport {
                label: root.label.clone(),
                status: "missing",
                files: 0,
                skipped: 0,
            });
            continue;
        };
        let mut skipped = listing.skipped;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for path in &listing.files {
            seen.insert(path.to_string_lossy().into_owned());
            if scan_file(ledger, root, path).is_err() {
                skipped += 1;
            }
            done += 1;
            progress(done, total);
        }
        let prefix = root.dir.to_string_lossy().into_owned();
        let before = ledger.files.len();
        ledger
            .files
            .retain(|file, _| !file.starts_with(&prefix) || seen.contains(file));
        if ledger.files.len() != before {
            ledger.dirty = true;
        }
        reports.push(SourceReport {
            label: root.label.clone(),
            status: if skipped > 0 { "partial" } else { "ok" },
            files: listing.files.len() as u32,
            skipped,
        });
    }
    reports
}
```

Note on `unchanged_file_is_not_read_again`: the second scan must leave `dirty` false, which holds because `scan_file` returns before touching the ledger when size and mtime match, and the `retain` removes nothing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --lib usage::scan`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/usage/mod.rs src-tauri/src/usage/scan.rs
git commit -m "feat(usage): incremental transcript scan into the ledger"
```

---

### Task 4: Pricing

**Files:**
- Create: `src-tauri/src/usage/pricing.rs`
- Create: `src-tauri/src/usage/prices-snapshot.json`
- Modify: `src-tauri/src/usage/mod.rs`

- [ ] **Step 1: Generate the bundled snapshot**

Run from the repo root (Git Bash). It downloads LiteLLM's table and keeps only Anthropic entries with numeric rates:

```bash
curl -sfL --max-time 60 https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json -o "$TEMP/litellm.new.json" && mv "$TEMP/litellm.new.json" "$TEMP/litellm.json"
node -e "const j=require(process.argv[1]);const o={};for(const[k,v]of Object.entries(j)){if(v&&v.litellm_provider==='anthropic'&&typeof v.input_cost_per_token==='number'&&typeof v.output_cost_per_token==='number'){const e={litellm_provider:'anthropic',input_cost_per_token:v.input_cost_per_token,output_cost_per_token:v.output_cost_per_token};for(const f of['cache_read_input_token_cost','cache_creation_input_token_cost','cache_creation_input_token_cost_above_1hr'])if(typeof v[f]==='number')e[f]=v[f];if(v.provider_specific_entry&&typeof v.provider_specific_entry.fast==='number')e.provider_specific_entry={fast:v.provider_specific_entry.fast};o[k]=e}}require('fs').writeFileSync(process.argv[2],JSON.stringify(o,null,2)+'\n');console.log(Object.keys(o).length,'entries')" "$TEMP/litellm.json" src-tauri/src/usage/prices-snapshot.json
```

Expected: prints a count of about 22 entries, and `src-tauri/src/usage/prices-snapshot.json` contains a `"claude-opus-5-5"` key. The download writes to a separate file first, so a failed download leaves any earlier `$TEMP/litellm.json` intact; if the download fails and that file exists, the `node` line still generates the snapshot from it. If there is no copy at all, stop and report it; do not hand-write rates.

- [ ] **Step 2: Declare the module**

In `src-tauri/src/usage/mod.rs`:

```rust
pub mod ledger;
pub mod pricing;
pub mod record;
pub mod scan;
```

- [ ] **Step 3: Write the failing tests**

Create `src-tauri/src/usage/pricing.rs`:

```rust
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

pub fn filter_anthropic(_doc: &Value) -> Map<String, Value> {
    Map::new()
}

pub fn parse_table(_entries: &Map<String, Value>) -> RateTable {
    RateTable::new()
}

pub fn lookup<'a>(_table: &'a RateTable, _model: &str) -> Option<&'a Rates> {
    None
}

pub fn cost(_rates: &Rates, _record: &Record) -> Cost {
    Cost::default()
}

pub fn load(_path: &Path, _now_ms: i64) -> Loaded {
    Loaded { table: RateTable::new(), tier: "bundled", fetched_at: None }
}

pub fn store_fetched(_path: &Path, _body: &str, _now_ms: i64) -> Result<bool, String> {
    Err("not implemented".to_string())
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cargo test --lib usage::pricing`
Expected: FAIL — 9 of 10 fail against the stubs. `unreadable_file_on_disk_falls_back_to_bundled` passes because the stub already answers "bundled"; leave it as written.

- [ ] **Step 5: Implement**

Replace the six stub functions with:

```rust
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --lib usage::pricing`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/usage/mod.rs src-tauri/src/usage/pricing.rs src-tauri/src/usage/prices-snapshot.json
git commit -m "feat(usage): model rate table with bundled fallback and cost arithmetic"
```

---

### Task 5: Aggregation

**Files:**
- Create: `src-tauri/src/usage/aggregate.rs`
- Modify: `src-tauri/src/usage/mod.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/usage/mod.rs`:

```rust
pub mod aggregate;
pub mod ledger;
pub mod pricing;
pub mod record;
pub mod scan;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/usage/aggregate.rs`:

```rust
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

pub fn validate(_boundaries: &[i64]) -> Result<(), String> {
    Ok(())
}

pub fn fold(_ledger: &Ledger, _table: &RateTable, _boundaries: &[i64]) -> Vec<SummaryBucket> {
    Vec::new()
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --lib usage::aggregate`
Expected: FAIL — `validates_boundaries` fails on the `is_err` cases and the fold tests fail on empty output.

- [ ] **Step 4: Implement**

Replace the `validate` and `fold` stubs with:

```rust
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --lib usage::aggregate`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/usage/mod.rs src-tauri/src/usage/aggregate.rs
git commit -m "feat(usage): fold ledger records into time buckets"
```

---

### Task 6: Store, commands and registration

**Files:**
- Modify: `src-tauri/src/usage/mod.rs`
- Modify: `src-tauri/src/commands.rs` (append at end of file)
- Modify: `src-tauri/src/lib.rs` (setup block near line 76; handler list near line 180)

- [ ] **Step 1: Write the failing tests**

Replace `src-tauri/src/usage/mod.rs` with the module list, the wire types, stubs and tests:

```rust
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

pub fn resolve_project(_entry: &ProjectEntry, _apps: &[AppProject]) -> UsageProject {
    UsageProject { label: String::new(), path: None, project_id: None, distro: None }
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

    pub fn scan(
        &self,
        _roots: &[scan::Root],
        _now_ms: i64,
        _progress: &mut dyn FnMut(usize, usize),
    ) -> ScanResult {
        ScanResult { sources: Vec::new(), scan_ms: 0 }
    }

    pub fn summary(
        &self,
        _boundaries: &[i64],
        _apps: &[AppProject],
        _now_ms: i64,
    ) -> Result<Summary, String> {
        Err("not implemented".to_string())
    }

    pub fn begin_price_attempt(&self, _force: bool) -> bool {
        false
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
        let result = store.scan(&roots(transcripts.path()), NOW, &mut |_, _| {});
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
```

`1_791_885_601_000` is `2026-10-13T10:00:01.000Z`: the surviving record is the later line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --lib usage::tests`
Expected: FAIL — 3 of 4 fail against the stubs. `summary_rejects_bad_boundaries` passes because the stub returns an error for everything; leave it as written.

Do not extend `scan_then_summary_end_to_end_and_persists` with more records while it compares buckets by exact equality: cost sums depend on map iteration order and can differ in the last bits between two loads.

- [ ] **Step 3: Implement the store**

In `src-tauri/src/usage/mod.rs`, replace `resolve_project` and the `scan`, `summary` and `begin_price_attempt` stubs with:

```rust
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
```

and inside `impl UsageStore`:

```rust
    fn with_ledger<T>(&self, f: impl FnOnce(&mut Ledger) -> T) -> T {
        let mut guard = self.ledger.lock();
        let ledger = guard.get_or_insert_with(|| Ledger::load(&self.ledger_path));
        f(ledger)
    }

    pub fn scan(
        &self,
        roots: &[scan::Root],
        now_ms: i64,
        progress: &mut dyn FnMut(usize, usize),
    ) -> ScanResult {
        let started = Instant::now();
        let sources = self.with_ledger(|ledger| {
            let sources = scan::scan(ledger, roots, progress);
            ledger.prune(now_ms);
            if ledger.dirty {
                match ledger.save(&self.ledger_path) {
                    Ok(()) => ledger.dirty = false,
                    Err(e) => eprintln!("usage: could not save ledger: {e}"),
                }
            }
            sources
        });
        ScanResult { sources, scan_ms: started.elapsed().as_millis() as u64 }
    }

    pub fn summary(
        &self,
        boundaries: &[i64],
        apps: &[AppProject],
        now_ms: i64,
    ) -> Result<Summary, String> {
        aggregate::validate(boundaries)?;
        let prices = pricing::load(&self.prices_path, now_ms);
        Ok(self.with_ledger(|ledger| Summary {
            buckets: aggregate::fold(ledger, &prices.table, boundaries),
            projects: ledger.projects.iter().map(|p| resolve_project(p, apps)).collect(),
            pricing: PricingInfo { tier: prices.tier, fetched_at: prices.fetched_at },
            history_start_ms: ledger.history_start(),
        }))
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib usage::`
Expected: PASS — all usage tests (8 + 10 + 12 + 10 + 5 + 4 = 49).

- [ ] **Step 5: Add the commands**

Append to `src-tauri/src/commands.rs`:

```rust
// ---- usage history ----

#[tauri::command]
pub async fn usage_scan(app: AppHandle) -> AppResult<crate::usage::ScanResult> {
    use tauri::Emitter;
    let home = home_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<crate::usage::UsageStore>();
        let roots = crate::usage::scan::roots(&home);
        let mut last_emit: Option<std::time::Instant> = None;
        store.scan(&roots, crate::claude::creds::now_ms(), &mut |done, total| {
            let due = last_emit.map_or(true, |at| at.elapsed().as_millis() >= 100);
            if due || done == total {
                last_emit = Some(std::time::Instant::now());
                let _ = app.emit("usage:scan-progress", json!({ "done": done, "total": total }));
            }
        })
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))
}

#[tauri::command]
pub async fn usage_summary(
    app: AppHandle,
    store: State<'_, StateStore>,
    boundaries: Vec<i64>,
) -> AppResult<crate::usage::Summary> {
    let apps: Vec<crate::usage::AppProject> = store
        .snapshot()
        .projects
        .into_iter()
        .map(|p| crate::usage::AppProject { id: p.id, name: p.name, path: p.path })
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::usage::UsageStore>()
            .summary(&boundaries, &apps, crate::claude::creds::now_ms())
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?
    .map_err(AppError::Msg)
}

/// Refresh the price table from the network. Never an error: a failed fetch
/// keeps whatever table is already on disk. Returns whether rates changed.
#[tauri::command]
pub async fn usage_refresh_prices(app: AppHandle, force: bool) -> AppResult<bool> {
    let store = app.state::<crate::usage::UsageStore>();
    if !store.begin_price_attempt(force) {
        return Ok(false);
    }
    let path = store.prices_path().to_path_buf();
    let client = http_client()?;
    let request = client
        .get(crate::usage::pricing::PRICES_URL)
        .timeout(std::time::Duration::from_secs(30));
    let body = match request.send().await {
        Ok(resp) if resp.status().is_success() => resp.text().await.ok(),
        _ => None,
    };
    let Some(body) = body else {
        return Ok(false);
    };
    Ok(
        crate::usage::pricing::store_fetched(&path, &body, crate::claude::creds::now_ms())
            .unwrap_or(false),
    )
}
```

`map_or(true, …)` is used instead of `Option::is_none_or` because the crate declares `rust-version = "1.77"` and `is_none_or` is newer.

- [ ] **Step 6: Register state and commands**

In `src-tauri/src/lib.rs`, after `app.manage(search::SearchStore::default());`:

```rust
            app.manage(usage::UsageStore::new(&data_dir));
```

In the `generate_handler!` list, after `commands::claude_accounts_usage,`:

```rust
            commands::usage_scan,
            commands::usage_summary,
            commands::usage_refresh_prices,
```

- [ ] **Step 7: Verify the whole crate builds and tests pass, with and without the default feature**

Run (from `src-tauri/`):

```bash
cargo test --lib
cargo check --no-default-features
```

Expected: all tests pass; `cargo check` finishes with no errors. Warnings about unused items in `usage` are not acceptable — if any appear, the item is unused and should be removed.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/usage/mod.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(usage): usage store with scan, summary and price refresh commands"
```

---

### Task 7: IPC types and bindings

**Files:**
- Modify: `src/lib/ipc.ts` (types after `ClaudeAccountUsage` near line 379; `ipc.usage` after the `claudeAccounts` block near line 588)

- [ ] **Step 1: Add the wire types**

In `src/lib/ipc.ts`, after the `ClaudeAccountUsage` interface:

```ts
export interface UsageSource {
  /** "This computer" or "WSL <distro>" */
  label: string
  status: 'ok' | 'missing' | 'partial'
  files: number
  skipped: number
}

export interface UsageScanResult {
  sources: UsageSource[]
  scanMs: number
}

export interface UsageSummaryBucket {
  /** index into the boundaries sent with the request */
  slot: number
  model: string
  /** index into UsageSummary.projects */
  project: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** API-equivalent estimate; 0 when unpriced */
  costUsd: number
  inputCostUsd: number
  cacheReadCostUsd: number
  cacheWriteCostUsd: number
  outputCostUsd: number
  cacheSavingsUsd: number
  priced: boolean
  responses: number
}

export interface UsageProject {
  label: string
  path: string | null
  projectId: string | null
  distro: string | null
}

export interface UsageSummary {
  buckets: UsageSummaryBucket[]
  projects: UsageProject[]
  pricing: { tier: 'fresh' | 'stale' | 'bundled'; fetchedAt: number | null }
  /** epoch millis of the oldest record kept; null when there is no history */
  historyStartMs: number | null
}
```

- [ ] **Step 2: Add the bindings**

In the `ipc` object, after the `claudeAccounts: { ... },` block:

```ts
  usage: {
    scan: () => invoke<UsageScanResult>('usage_scan'),
    summary: (boundaries: number[]) => invoke<UsageSummary>('usage_summary', { boundaries }),
    refreshPrices: (force = false) => invoke<boolean>('usage_refresh_prices', { force }),
    onScanProgress: (cb: (p: { done: number; total: number }) => void): Promise<UnlistenFn> =>
      listen<{ done: number; total: number }>('usage:scan-progress', (e) => cb(e.payload)),
  },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0 with no output from `tsc`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(usage): ipc types and bindings for usage commands"
```

---

### Task 8: Pure usage helpers

**Files:**
- Create: `src/lib/usage.ts`
- Create: `src/lib/usage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  OTHER_KEY,
  breakdown,
  buildBoundaries,
  filterBuckets,
  formatPercent,
  formatTokens,
  formatUsd,
  makeGroups,
  pooledWindow,
  series,
  totals,
} from './usage'
import type { ClaudeAccountUsage, UsageProject, UsageSummaryBucket } from './ipc'

const bucket = (over: Partial<UsageSummaryBucket>): UsageSummaryBucket => ({
  slot: 0,
  model: 'opus',
  project: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  costUsd: 0,
  inputCostUsd: 0,
  cacheReadCostUsd: 0,
  cacheWriteCostUsd: 0,
  outputCostUsd: 0,
  cacheSavingsUsd: 0,
  priced: true,
  responses: 0,
  ...over,
})

const projects: UsageProject[] = [
  { label: 'App', path: 'C:\\app', projectId: 'p1', distro: null },
  { label: 'App', path: '/mnt/c/app', projectId: 'p1', distro: 'Ubuntu' },
  { label: 'scratch', path: '/home/u/scratch', projectId: null, distro: 'Ubuntu' },
]

describe('buildBoundaries', () => {
  const now = new Date(2026, 9, 13, 10, 34, 7, 500)

  it('builds one slot per local day ending today', () => {
    for (const [period, days] of [['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const b = buildBoundaries(period, now)
      expect(b).toHaveLength(days + 1)
      for (const ms of b) {
        const d = new Date(ms)
        expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0])
      }
      for (let i = 1; i < b.length; i++) expect(b[i]).toBeGreaterThan(b[i - 1])
      expect(b[days - 1]).toBe(new Date(2026, 9, 13).getTime())
      expect(b[days]).toBe(new Date(2026, 9, 14).getTime())
      expect(b[0]).toBe(new Date(2026, 9, 13 - (days - 1)).getTime())
    }
  })

  it('builds 24 one-hour slots ending with the current hour', () => {
    const b = buildBoundaries('24h', now)
    expect(b).toHaveLength(25)
    for (let i = 1; i < b.length; i++) expect(b[i] - b[i - 1]).toBe(3_600_000)
    expect(b[23]).toBe(new Date(2026, 9, 13, 10).getTime())
    expect(b[24]).toBeGreaterThan(now.getTime())
    expect(b[23]).toBeLessThanOrEqual(now.getTime())
  })
})

describe('totals', () => {
  it('sums buckets using the spec definitions', () => {
    const t = totals([
      bucket({ input: 10, cacheRead: 100, cacheWrite: 20, output: 5, costUsd: 3, cacheSavingsUsd: 1, responses: 2,
               inputCostUsd: 1, cacheReadCostUsd: 0.5, cacheWriteCostUsd: 0.5, outputCostUsd: 1 }),
      bucket({ input: 1, cacheRead: 0, cacheWrite: 0, output: 4, priced: false, responses: 1 }),
    ])
    expect(t.processed).toBe(140)
    expect(t.cachedInput).toBe(100)
    expect(t.uncachedInput).toBe(31)
    expect(t.output).toBe(9)
    expect(t.input).toBe(11)
    expect(t.cacheWrite).toBe(20)
    expect(t.costUsd).toBe(3)
    expect(t.cacheSavingsUsd).toBe(1)
    expect(t.responses).toBe(3)
    expect(t.unpricedTokens).toBe(5)
    expect(t.costByType).toEqual({ input: 1, cacheRead: 0.5, cacheWrite: 0.5, output: 1 })
  })

  it('is all zeros for no buckets', () => {
    expect(totals([]).processed).toBe(0)
  })
})

describe('makeGroups', () => {
  it('groups by model name', () => {
    const g = makeGroups('model', projects)
    expect(g.keyOf(bucket({ model: 'haiku' }))).toBe('haiku')
    expect(g.labelOf('haiku')).toBe('haiku')
  })

  it('merges project rows that share an app project and keeps others apart', () => {
    const g = makeGroups('project', projects)
    expect(g.keyOf(bucket({ project: 0 }))).toBe(g.keyOf(bucket({ project: 1 })))
    expect(g.keyOf(bucket({ project: 2 }))).not.toBe(g.keyOf(bucket({ project: 0 })))
    expect(g.labelOf(g.keyOf(bucket({ project: 0 })))).toBe('App')
    expect(g.labelOf(g.keyOf(bucket({ project: 2 })))).toBe('scratch (WSL Ubuntu)')
  })
})

describe('breakdown', () => {
  const buckets = [
    bucket({ model: 'opus', input: 100, cacheRead: 300, output: 100, costUsd: 9 }),
    bucket({ model: 'opus', slot: 1, input: 0, cacheRead: 0, output: 500, costUsd: 1 }),
    bucket({ model: 'haiku', input: 1000, output: 1000, costUsd: 0, priced: false }),
  ]
  const g = makeGroups('model', projects)

  it('sorts by the metric and computes shares', () => {
    const byCost = breakdown(buckets, g, 'cost')
    expect(byCost.map((r) => r.key)).toEqual(['opus', 'haiku'])
    expect(byCost[0].costUsd).toBe(10)
    expect(byCost[0].share).toBe(1)
    const byTokens = breakdown(buckets, g, 'tokens')
    expect(byTokens.map((r) => r.key)).toEqual(['haiku', 'opus'])
    expect(byTokens[0].tokens).toBe(2000)
    expect(byTokens[0].share).toBeCloseTo(2 / 3)
  })

  it('computes cache hit rate and cost per million priced tokens', () => {
    const rows = breakdown(buckets, g, 'cost')
    const opus = rows.find((r) => r.key === 'opus')!
    expect(opus.cacheHitRate).toBeCloseTo(0.75)
    expect(opus.costPerMillion).toBeCloseTo(10_000)
    expect(opus.priced).toBe(true)
    const haiku = rows.find((r) => r.key === 'haiku')!
    expect(haiku.priced).toBe(false)
    expect(haiku.costPerMillion).toBeNull()
    expect(haiku.cacheHitRate).toBe(0)
  })
})

describe('series', () => {
  const g = makeGroups('model', projects)
  const buckets = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((model, i) =>
    bucket({ model, slot: i % 2, output: (i + 1) * 10 })
  )

  it('keeps the top five and folds the rest into Other', () => {
    const s = series(buckets, 2, g, 'tokens')
    expect(s.keys.map((k) => k.key)).toEqual(['g', 'f', 'e', 'd', 'c', OTHER_KEY])
    expect(s.keys[5].label).toBe('Other')
    expect(s.values).toHaveLength(2)
    expect(s.values[0]).toEqual([70, 0, 50, 0, 30, 10])
    expect(s.values[1]).toEqual([0, 60, 0, 40, 0, 20])
  })

  it('has no Other series when five or fewer groups exist', () => {
    const s = series(buckets.slice(0, 3), 2, g, 'tokens')
    expect(s.keys.map((k) => k.key)).toEqual(['c', 'b', 'a'])
  })
})

describe('filterBuckets', () => {
  it('keeps only the chosen group, or everything for null', () => {
    const g = makeGroups('model', projects)
    const buckets = [bucket({ model: 'a' }), bucket({ model: 'b' })]
    expect(filterBuckets(buckets, g, 'a')).toHaveLength(1)
    expect(filterBuckets(buckets, g, null)).toHaveLength(2)
  })
})

describe('pooledWindow', () => {
  const now = Date.parse('2026-10-13T10:00:00Z')
  const usage = (
    accountId: string,
    fiveHour: { utilization: number; resetsAt: string | null } | null,
    error: string | null = null
  ): ClaudeAccountUsage => ({
    accountId,
    usage: fiveHour === null && error ? null : { fiveHour, sevenDay: null, extraUsage: null, fetchedAt: now },
    error,
  })

  it('averages what is left across reporting accounts', () => {
    const w = pooledWindow(
      [
        usage('a', { utilization: 80, resetsAt: '2026-10-13T12:00:00Z' }),
        usage('b', { utilization: 20, resetsAt: '2026-10-13T11:00:00Z' }),
        usage('c', null, 'fetch failed'),
        usage('d', null),
      ],
      'fiveHour',
      now
    )
    expect(w.accounts.map((a) => a.accountId)).toEqual(['a', 'b'])
    expect(w.accounts[0].remaining).toBe(20)
    expect(w.meanRemaining).toBe(50)
    expect(w.nextReset).toEqual({ accountId: 'b', resetsAt: '2026-10-13T11:00:00Z', restores: 10 })
  })

  it('clamps over-quota accounts and ignores untouched or past resets', () => {
    const w = pooledWindow(
      [
        usage('a', { utilization: 130, resetsAt: '2026-10-13T09:00:00Z' }),
        usage('b', { utilization: 0, resetsAt: '2026-10-13T11:00:00Z' }),
      ],
      'fiveHour',
      now
    )
    expect(w.accounts[0].remaining).toBe(0)
    expect(w.meanRemaining).toBe(50)
    expect(w.nextReset).toBeNull()
  })

  it('has no mean when nobody reports', () => {
    const w = pooledWindow([usage('a', null)], 'fiveHour', now)
    expect(w.accounts).toEqual([])
    expect(w.meanRemaining).toBeNull()
  })
})

describe('formatting', () => {
  it('formats token counts', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_500)).toBe('1.5K')
    expect(formatTokens(12_345)).toBe('12.3K')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(18_200_000_000)).toBe('18.2B')
  })

  it('formats dollars', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(12.346)).toBe('$12.35')
    expect(formatUsd(1234.5)).toBe('$1,235')
  })

  it('formats percentages', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(0.756)).toBe('76%')
    expect(formatPercent(0.004)).toBe('<1%')
    expect(formatPercent(1)).toBe('100%')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/usage.test.ts`
Expected: FAIL — `Failed to resolve import "./usage"`.

- [ ] **Step 3: Implement**

Create `src/lib/usage.ts`:

```ts
// Pure helpers for the Usage page. No Tauri/ipc calls, so they run in plain
// vitest (same pattern as claude-accounts.ts).

import type { ClaudeAccountUsage, UsageProject, UsageSummaryBucket } from './ipc'

export type UsagePeriod = '24h' | '7d' | '30d' | '90d'
export type UsageMetric = 'cost' | 'tokens'
export type UsageDimension = 'model' | 'project'

export const OTHER_KEY = '__other'
const TOP_SERIES = 5
const HOUR_MS = 3_600_000
const PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const

/**
 * Slot i covers [b[i], b[i+1]). Days are built from calendar fields so a
 * daylight-saving day keeps its real length; hours step in milliseconds so the
 * repeated autumn hour does not produce a duplicate boundary.
 */
export function buildBoundaries(period: UsagePeriod, now: Date): number[] {
  if (period === '24h') {
    const intoHour =
      now.getMinutes() * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds()
    const start = now.getTime() - intoHour - 23 * HOUR_MS
    return Array.from({ length: 25 }, (_, i) => start + i * HOUR_MS)
  }
  const days = PERIOD_DAYS[period]
  return Array.from({ length: days + 1 }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1) + i).getTime()
  )
}

export const tokensOf = (b: UsageSummaryBucket): number =>
  b.input + b.cacheRead + b.cacheWrite + b.output

export interface UsageTotals {
  processed: number
  cachedInput: number
  uncachedInput: number
  input: number
  cacheWrite: number
  output: number
  costUsd: number
  cacheSavingsUsd: number
  responses: number
  unpricedTokens: number
  costByType: { input: number; cacheRead: number; cacheWrite: number; output: number }
}

export function totals(buckets: UsageSummaryBucket[]): UsageTotals {
  const t: UsageTotals = {
    processed: 0,
    cachedInput: 0,
    uncachedInput: 0,
    input: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
    responses: 0,
    unpricedTokens: 0,
    costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  }
  for (const b of buckets) {
    t.processed += tokensOf(b)
    t.cachedInput += b.cacheRead
    t.uncachedInput += b.input + b.cacheWrite
    t.input += b.input
    t.cacheWrite += b.cacheWrite
    t.output += b.output
    t.costUsd += b.costUsd
    t.cacheSavingsUsd += b.cacheSavingsUsd
    t.responses += b.responses
    if (!b.priced) t.unpricedTokens += tokensOf(b)
    t.costByType.input += b.inputCostUsd
    t.costByType.cacheRead += b.cacheReadCostUsd
    t.costByType.cacheWrite += b.cacheWriteCostUsd
    t.costByType.output += b.outputCostUsd
  }
  return t
}

export interface UsageGroups {
  keyOf: (b: UsageSummaryBucket) => string
  labelOf: (key: string) => string
}

/**
 * Model rows group by model id. Project rows merge every source of one app
 * project into a single row; directories the app does not know stay separate.
 */
export function makeGroups(dimension: UsageDimension, projects: UsageProject[]): UsageGroups {
  if (dimension === 'model') return { keyOf: (b) => b.model, labelOf: (key) => key }
  const keys = projects.map((p, i) => (p.projectId ? `id:${p.projectId}` : `ix:${i}`))
  const labels = new Map<string, string>()
  projects.forEach((p, i) => {
    if (labels.has(keys[i])) return
    labels.set(keys[i], !p.projectId && p.distro ? `${p.label} (WSL ${p.distro})` : p.label)
  })
  return {
    keyOf: (b) => keys[b.project] ?? `ix:${b.project}`,
    labelOf: (key) => labels.get(key) ?? key,
  }
}

export function filterBuckets(
  buckets: UsageSummaryBucket[],
  groups: UsageGroups,
  key: string | null
): UsageSummaryBucket[] {
  return key === null ? buckets : buckets.filter((b) => groups.keyOf(b) === key)
}

export interface BreakdownRow {
  key: string
  label: string
  costUsd: number
  tokens: number
  /** share of the active metric, 0-1 */
  share: number
  /** cache read / all input, 0-1 */
  cacheHitRate: number
  /** USD per million priced tokens; null when nothing was priced */
  costPerMillion: number | null
  priced: boolean
}

export function breakdown(
  buckets: UsageSummaryBucket[],
  groups: UsageGroups,
  metric: UsageMetric
): BreakdownRow[] {
  const acc = new Map<
    string,
    { costUsd: number; tokens: number; pricedTokens: number; cacheRead: number; allInput: number }
  >()
  for (const b of buckets) {
    const key = groups.keyOf(b)
    const row = acc.get(key) ?? { costUsd: 0, tokens: 0, pricedTokens: 0, cacheRead: 0, allInput: 0 }
    row.costUsd += b.costUsd
    row.tokens += tokensOf(b)
    if (b.priced) row.pricedTokens += tokensOf(b)
    row.cacheRead += b.cacheRead
    row.allInput += b.input + b.cacheRead + b.cacheWrite
    acc.set(key, row)
  }
  const value = (r: { costUsd: number; tokens: number }): number =>
    metric === 'cost' ? r.costUsd : r.tokens
  let sum = 0
  for (const r of acc.values()) sum += value(r)
  return [...acc.entries()]
    .map(([key, r]) => ({
      key,
      label: groups.labelOf(key),
      costUsd: r.costUsd,
      tokens: r.tokens,
      share: sum > 0 ? value(r) / sum : 0,
      cacheHitRate: r.allInput > 0 ? r.cacheRead / r.allInput : 0,
      costPerMillion: r.pricedTokens > 0 ? (r.costUsd / r.pricedTokens) * 1_000_000 : null,
      priced: r.pricedTokens > 0,
    }))
    .sort((a, b) => value(b) - value(a) || a.label.localeCompare(b.label))
}

export interface UsageSeries {
  keys: { key: string; label: string }[]
  /** values[slot][seriesIndex] */
  values: number[][]
}

export function series(
  buckets: UsageSummaryBucket[],
  slots: number,
  groups: UsageGroups,
  metric: UsageMetric
): UsageSeries {
  const value = (b: UsageSummaryBucket): number => (metric === 'cost' ? b.costUsd : tokensOf(b))
  const sums = new Map<string, number>()
  for (const b of buckets) {
    const key = groups.keyOf(b)
    sums.set(key, (sums.get(key) ?? 0) + value(b))
  }
  const ranked = [...sums.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
  const top = ranked.slice(0, TOP_SERIES)
  const keys = top.map((key) => ({ key, label: groups.labelOf(key) }))
  if (ranked.length > TOP_SERIES) keys.push({ key: OTHER_KEY, label: 'Other' })
  const index = new Map(top.map((key, i) => [key, i]))
  const values = Array.from({ length: slots }, () => keys.map(() => 0))
  for (const b of buckets) {
    if (b.slot < 0 || b.slot >= slots) continue
    const i = index.get(groups.keyOf(b)) ?? TOP_SERIES
    values[b.slot][i] += value(b)
  }
  return { keys, values }
}

export interface PooledAccount {
  accountId: string
  utilization: number
  /** 0-100 */
  remaining: number
  resetsAt: string | null
}

export interface PooledWindow {
  accounts: PooledAccount[]
  /** mean of `remaining` across reporting accounts; null when none report */
  meanRemaining: number | null
  /** soonest future reset among accounts that have used anything */
  nextReset: { accountId: string; resetsAt: string; restores: number } | null
}

export function pooledWindow(
  usages: ClaudeAccountUsage[],
  window: 'fiveHour' | 'sevenDay',
  nowMs: number
): PooledWindow {
  const accounts: PooledAccount[] = []
  for (const u of usages) {
    const w = u.usage?.[window]
    if (!w) continue
    accounts.push({
      accountId: u.accountId,
      utilization: w.utilization,
      remaining: Math.max(0, Math.min(100, 100 - w.utilization)),
      resetsAt: w.resetsAt,
    })
  }
  if (accounts.length === 0) return { accounts, meanRemaining: null, nextReset: null }
  const meanRemaining = accounts.reduce((sum, a) => sum + a.remaining, 0) / accounts.length
  let nextReset: PooledWindow['nextReset'] = null
  for (const a of accounts) {
    if (a.utilization <= 0 || !a.resetsAt) continue
    const at = Date.parse(a.resetsAt)
    if (Number.isNaN(at) || at <= nowMs) continue
    if (nextReset && Date.parse(nextReset.resetsAt) <= at) continue
    nextReset = {
      accountId: a.accountId,
      resetsAt: a.resetsAt,
      restores: (100 - a.remaining) / accounts.length,
    }
  }
  return { accounts, meanRemaining, nextReset }
}

const trim = (n: number): string => n.toFixed(1).replace(/\.0$/, '')

export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${trim(n / 1_000)}K`
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  if (n < 1000) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/** `ratio` is 0-1. */
export function formatPercent(ratio: number): string {
  if (ratio <= 0) return '0%'
  if (ratio < 0.01) return '<1%'
  return `${Math.round(ratio * 100)}%`
}

export function slotLabel(startMs: number, period: UsagePeriod): string {
  const d = new Date(startMs)
  return period === '24h'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/usage.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage.ts src/lib/usage.test.ts
git commit -m "feat(usage): pure helpers for boundaries, totals, series and pooled limits"
```

---

### Task 9: Usage store

**Files:**
- Create: `src/state/usage.ts`

- [ ] **Step 1: Write the store**

Create `src/state/usage.ts`:

```ts
import { create } from 'zustand'
import { ipc, type UsageScanResult, type UsageSummary } from '../lib/ipc'
import {
  buildBoundaries,
  type UsageDimension,
  type UsageMetric,
  type UsagePeriod,
} from '../lib/usage'

export type UsageView = UsageMetric | 'limits'

let requestSeq = 0

interface UsageState {
  open: boolean
  view: UsageView
  period: UsagePeriod
  dimension: UsageDimension
  /** breakdown row the chart and totals are filtered to */
  filterKey: string | null
  boundaries: number[]
  /** the period `boundaries` and `summary` were built for; lags `period` while loading */
  loadedPeriod: UsagePeriod
  summary: UsageSummary | null
  scan: UsageScanResult | null
  loading: boolean
  progress: { done: number; total: number } | null
  error: string | null

  openPage: () => void
  closePage: () => void
  togglePage: () => void
  setView: (view: UsageView) => void
  setPeriod: (period: UsagePeriod) => void
  setDimension: (dimension: UsageDimension) => void
  toggleFilter: (key: string) => void
  setProgress: (progress: { done: number; total: number }) => void
  /** `scan` re-reads transcripts first; a period change only re-aggregates. */
  load: (scan: boolean) => Promise<void>
  refresh: () => Promise<void>
}

export const useUsage = create<UsageState>((set, get) => ({
  open: false,
  view: 'cost',
  period: '7d',
  dimension: 'model',
  filterKey: null,
  boundaries: [],
  loadedPeriod: '7d',
  summary: null,
  scan: null,
  loading: false,
  progress: null,
  error: null,

  openPage: () => {
    if (get().open) return
    set({ open: true })
    void get().load(true)
    void ipc.usage
      .refreshPrices(false)
      .then((changed) => {
        if (changed && get().open) void get().load(false)
      })
      .catch(() => {})
  },

  closePage: () => set({ open: false }),

  togglePage: () => (get().open ? get().closePage() : get().openPage()),

  setView: (view) => set({ view }),

  setPeriod: (period) => {
    set({ period })
    void get().load(false)
  },

  setDimension: (dimension) => set({ dimension, filterKey: null }),

  toggleFilter: (key) => set((s) => ({ filterKey: s.filterKey === key ? null : key })),

  setProgress: (progress) => set({ progress }),

  load: async (scan) => {
    let seq = ++requestSeq
    set({ loading: true, error: null })
    try {
      if (scan) {
        // A scan result is always kept, and always followed by a summary, even
        // if another request started meanwhile: that request may have read the
        // ledger before this scan filled it.
        const result = await ipc.usage.scan()
        set({ scan: result })
        seq = ++requestSeq
      }
      const period = get().period
      const boundaries = buildBoundaries(period, new Date())
      const summary = await ipc.usage.summary(boundaries)
      if (seq !== requestSeq) return
      set({ boundaries, summary, loadedPeriod: period })
    } catch (e) {
      if (seq === requestSeq) set({ error: String(e) })
    } finally {
      if (seq === requestSeq) set({ loading: false, progress: null })
    }
  },

  refresh: async () => {
    await get().load(true)
    const changed = await ipc.usage.refreshPrices(true).catch(() => false)
    if (changed) await get().load(false)
  },
}))
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/state/usage.ts
git commit -m "feat(usage): zustand store for the usage page"
```

---

### Task 10: Chart, share bar, totals and breakdown components

Before writing these, invoke the `dataviz` skill and apply its guidance to the chart and share bar (colour separation, axis and legend treatment). The code below is the starting point; adjust visual details the skill calls for, and keep the props and data flow as written.

**Files:**
- Create: `src/components/usage/share-bar.tsx`
- Create: `src/components/usage/usage-chart.tsx`
- Create: `src/components/usage/usage-totals.tsx`
- Create: `src/components/usage/usage-breakdown.tsx`

- [ ] **Step 1: Share bar**

Create `src/components/usage/share-bar.tsx`:

```tsx
export interface ShareSegment {
  label: string
  value: number
  color: string
}

/** One horizontal bar split by share, with a legend of the non-zero parts. */
export function ShareBar({
  title,
  segments,
  format,
}: {
  title: string
  segments: ShareSegment[]
  format: (value: number) => string
}) {
  const shown = segments.filter((s) => s.value > 0)
  const sum = shown.reduce((acc, s) => acc + s.value, 0)
  if (sum <= 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs text-muted">{title}</div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full">
        {shown.map((s) => (
          <div
            key={s.label}
            style={{ width: `${(s.value / sum) * 100}%`, background: s.color }}
            title={`${s.label}: ${format(s.value)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {shown.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="text-foreground/80">{format(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Chart**

Create `src/components/usage/usage-chart.tsx`:

```tsx
import { useState } from 'react'
import { OTHER_KEY, slotLabel, type UsagePeriod, type UsageSeries } from '../../lib/usage'

const WIDTH = 960
const HEIGHT = 220
const LEFT = 52
const BOTTOM = 22
const TOP = 8
const TICKS = 4

export const SERIES_COLORS = [
  'var(--accent)',
  'var(--ansi-blue)',
  'var(--ansi-green)',
  'var(--ansi-magenta)',
  'var(--ansi-cyan)',
]
const OTHER_COLOR = 'var(--muted)'

export const seriesColor = (key: string, index: number): string =>
  key === OTHER_KEY ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length]

/** Stacked bars, one per slot. Hovering a bar swaps the legend to its values. */
export function UsageChart({
  data,
  boundaries,
  period,
  format,
}: {
  data: UsageSeries
  boundaries: number[]
  period: UsagePeriod
  format: (value: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const slots = data.values.length
  const slotTotals = data.values.map((row) => row.reduce((a, b) => a + b, 0))
  const max = Math.max(...slotTotals, 0)
  const plotWidth = WIDTH - LEFT
  const plotHeight = HEIGHT - TOP - BOTTOM
  const step = slots > 0 ? plotWidth / slots : plotWidth
  const barWidth = Math.max(1, step * 0.72)
  const labelEvery = Math.max(1, Math.ceil(slots / 8))
  const legendValues = hover === null ? null : data.values[hover]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="w-24 text-foreground/80">
          {hover === null ? 'Total' : slotLabel(boundaries[hover], period)}
        </span>
        {data.keys.map((k, i) => (
          <span key={k.key} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: seriesColor(k.key, i) }} />
            <span className="max-w-40 truncate">{k.label}</span>
            {legendValues && <span className="text-foreground/80">{format(legendValues[i])}</span>}
          </span>
        ))}
        {hover !== null && (
          <span className="ml-auto text-foreground/80">{format(slotTotals[hover])}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="Usage over time"
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: TICKS + 1 }, (_, i) => {
          const y = TOP + plotHeight - (plotHeight * i) / TICKS
          return (
            <g key={i}>
              <line x1={LEFT} x2={WIDTH} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
              <text x={LEFT - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--muted)">
                {format((max * i) / TICKS)}
              </text>
            </g>
          )
        })}
        {data.values.map((row, slot) => {
          const x = LEFT + slot * step + (step - barWidth) / 2
          let y = TOP + plotHeight
          return (
            <g key={slot} opacity={hover === null || hover === slot ? 1 : 0.45}>
              {row.map((value, i) => {
                const h = max > 0 ? (value / max) * plotHeight : 0
                y -= h
                return h > 0 ? (
                  <rect
                    key={data.keys[i].key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={h}
                    fill={seriesColor(data.keys[i].key, i)}
                  />
                ) : null
              })}
              {slot % labelEvery === 0 && (
                <text
                  x={LEFT + slot * step + step / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--muted)"
                >
                  {slotLabel(boundaries[slot], period)}
                </text>
              )}
              <rect
                x={LEFT + slot * step}
                y={TOP}
                width={step}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHover(slot)}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
```

- [ ] **Step 3: Totals**

Create `src/components/usage/usage-totals.tsx`:

```tsx
import { formatTokens, formatUsd, type UsageTotals as Totals } from '../../lib/usage'
import { ShareBar } from './share-bar'

const ink = (percent: number): string =>
  `color-mix(in srgb, var(--foreground) ${percent}%, var(--background))`

const TYPE_COLORS = { input: ink(60), cacheRead: ink(30), cacheWrite: ink(78), output: ink(100) }

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="text-lg font-medium text-foreground">{value}</span>
    </div>
  )
}

export function UsageTotals({ totals }: { totals: Totals }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Estimated cost" value={formatUsd(totals.costUsd)} />
        <Stat label="Processed tokens" value={formatTokens(totals.processed)} />
        <Stat label="Cached input" value={formatTokens(totals.cachedInput)} />
        <Stat label="Uncached input" value={formatTokens(totals.uncachedInput)} />
        <Stat label="Output" value={formatTokens(totals.output)} />
        <Stat label="Cache savings" value={formatUsd(totals.cacheSavingsUsd)} />
        <Stat label="Responses" value={totals.responses.toLocaleString('en-US')} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ShareBar
          title="Tokens by type"
          format={formatTokens}
          segments={[
            { label: 'Input', value: totals.input, color: TYPE_COLORS.input },
            { label: 'Cache read', value: totals.cachedInput, color: TYPE_COLORS.cacheRead },
            { label: 'Cache write', value: totals.cacheWrite, color: TYPE_COLORS.cacheWrite },
            { label: 'Output', value: totals.output, color: TYPE_COLORS.output },
          ]}
        />
        <ShareBar
          title="Cost by type"
          format={formatUsd}
          segments={[
            { label: 'Input', value: totals.costByType.input, color: TYPE_COLORS.input },
            { label: 'Cache read', value: totals.costByType.cacheRead, color: TYPE_COLORS.cacheRead },
            { label: 'Cache write', value: totals.costByType.cacheWrite, color: TYPE_COLORS.cacheWrite },
            { label: 'Output', value: totals.costByType.output, color: TYPE_COLORS.output },
          ]}
        />
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Breakdown**

Create `src/components/usage/usage-breakdown.tsx`:

```tsx
import {
  formatPercent,
  formatTokens,
  formatUsd,
  type BreakdownRow,
  type UsageDimension,
} from '../../lib/usage'

export function UsageBreakdown({
  rows,
  dimension,
  filterKey,
  onDimension,
  onToggle,
}: {
  rows: BreakdownRow[]
  dimension: UsageDimension
  filterKey: string | null
  onDimension: (dimension: UsageDimension) => void
  onToggle: (key: string) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
        <div className="flex rounded-md border border-border text-xs">
          {(['model', 'project'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDimension(d)}
              className={`px-2.5 py-1 capitalize ${
                dimension === d ? 'bg-foreground/10 text-foreground' : 'text-muted hover:text-foreground'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        {filterKey !== null && (
          <button
            type="button"
            onClick={() => onToggle(filterKey)}
            className="text-xs text-link hover:underline"
          >
            Clear filter
          </button>
        )}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-2 text-left font-normal capitalize">{dimension}</th>
            <th className="py-2 pl-4 text-right font-normal">Cost</th>
            <th className="py-2 pl-4 text-right font-normal">Share</th>
            <th className="py-2 pl-4 text-right font-normal">Tokens</th>
            <th className="py-2 pl-4 text-right font-normal">Cache hit</th>
            <th className="py-2 pl-4 text-right font-normal">$ / 1M tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              onClick={() => onToggle(r.key)}
              className={`cursor-pointer border-b border-border/50 hover:bg-foreground/5 ${
                filterKey === r.key ? 'bg-accent/10' : ''
              }`}
            >
              <td className="max-w-0 truncate py-2 text-foreground" title={r.label}>
                {r.label}
              </td>
              <td className="py-2 pl-4 text-right text-foreground">
                {r.priced ? formatUsd(r.costUsd) : <span className="text-muted">Unpriced</span>}
              </td>
              <td className="py-2 pl-4 text-right text-muted">{formatPercent(r.share)}</td>
              <td className="py-2 pl-4 text-right text-foreground">{formatTokens(r.tokens)}</td>
              <td className="py-2 pl-4 text-right text-muted">{formatPercent(r.cacheHitRate)}</td>
              <td className="py-2 pl-4 text-right text-muted">
                {r.costPerMillion === null ? '—' : formatUsd(r.costPerMillion)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/usage/share-bar.tsx src/components/usage/usage-chart.tsx src/components/usage/usage-totals.tsx src/components/usage/usage-breakdown.tsx
git commit -m "feat(usage): chart, totals and breakdown components"
```

---

### Task 11: Limits view

**Files:**
- Create: `src/components/usage/usage-limits.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/usage/usage-limits.tsx`:

```tsx
import { useEffect } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import {
  formatPlanName,
  formatResetsIn,
  sortAccounts,
  utilizationBarClass,
} from '../../lib/claude-accounts'
import { formatUsd, pooledWindow } from '../../lib/usage'
import type { ClaudeAccountMeta, ClaudeAccountUsage } from '../../lib/ipc'

const WINDOWS = [
  { id: 'fiveHour', title: '5-hour window' },
  { id: 'sevenDay', title: '7-day window' },
] as const

function PooledCard({
  title,
  window,
  accounts,
  usages,
}: {
  title: string
  window: 'fiveHour' | 'sevenDay'
  accounts: ClaudeAccountMeta[]
  usages: ClaudeAccountUsage[]
}) {
  const now = Date.now()
  const pooled = pooledWindow(usages, window, now)
  const nameOf = (id: string): string => accounts.find((a) => a.id === id)?.email ?? id
  const count = pooled.accounts.length

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {pooled.nextReset && (
          <span className="text-xs text-muted">
            Next reset in {formatResetsIn(pooled.nextReset.resetsAt, now)} ({nameOf(pooled.nextReset.accountId)})
            restores {Math.round(pooled.nextReset.restores)}%
          </span>
        )}
      </div>
      {pooled.meanRemaining === null ? (
        <div className="text-xs text-muted">No account reports this window.</div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-medium text-foreground">
              {Math.round(pooled.meanRemaining)}% left
            </span>
            {count > 1 && <span className="text-xs text-muted">average across {count} accounts</span>}
          </div>
          <div className="flex h-2.5 w-full gap-1">
            {pooled.accounts.map((a) => (
              <div
                key={a.accountId}
                className="h-full flex-1 overflow-hidden rounded-full bg-foreground/10"
                title={`${nameOf(a.accountId)}: ${Math.round(a.remaining)}% left`}
              >
                <div
                  className={`h-full rounded-full ${utilizationBarClass(a.utilization)}`}
                  style={{ width: `${a.remaining}%` }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

export function UsageLimits() {
  const accounts = useClaudeAccounts((s) => s.accounts)
  const activeAccountId = useClaudeAccounts((s) => s.activeAccountId)
  const usage = useClaudeAccounts((s) => s.usage)
  const refreshUsage = useClaudeAccounts((s) => s.refreshUsage)
  const addViaOauth = useClaudeAccounts((s) => s.addViaOauth)
  const loggingIn = useClaudeAccounts((s) => s.loggingIn)

  useEffect(() => {
    void refreshUsage(false).catch(() => {})
  }, [refreshUsage])

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-8 text-sm text-muted">
        <span>No Claude accounts yet. Log in to see subscription limits.</span>
        <button
          type="button"
          onClick={() => void addViaOauth()}
          disabled={loggingIn}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-foreground/5 disabled:opacity-50"
        >
          {loggingIn ? 'Waiting for browser…' : 'Log In'}
        </button>
      </div>
    )
  }

  const sorted = sortAccounts(accounts, activeAccountId)
  const usages = sorted.map((a) => usage[a.id]).filter((u): u is ClaudeAccountUsage => !!u)
  const now = Date.now()

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        {WINDOWS.map((w) => (
          <PooledCard key={w.id} title={w.title} window={w.id} accounts={sorted} usages={usages} />
        ))}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted">
            <th className="py-2 text-left font-normal">Account</th>
            <th className="py-2 pl-4 text-left font-normal">Plan</th>
            <th className="py-2 pl-4 text-right font-normal">5-hour used</th>
            <th className="py-2 pl-4 text-right font-normal">Resets in</th>
            <th className="py-2 pl-4 text-right font-normal">7-day used</th>
            <th className="py-2 pl-4 text-right font-normal">Resets in</th>
            <th className="py-2 pl-4 text-right font-normal">Extra usage</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => {
            const u = usage[a.id]
            const five = u?.usage?.fiveHour ?? null
            const seven = u?.usage?.sevenDay ?? null
            const extra = u?.usage?.extraUsage ?? null
            return (
              <tr key={a.id} className="border-b border-border/50">
                <td className="py-2 text-foreground">
                  {a.email}
                  {u?.error && <div className="text-danger">{u.error}</div>}
                </td>
                <td className="py-2 pl-4 text-muted">{formatPlanName(a.plan) || '—'}</td>
                <td className="py-2 pl-4 text-right text-foreground">
                  {five ? `${Math.round(five.utilization)}%` : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-muted">
                  {five ? formatResetsIn(five.resetsAt, now) || '—' : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-foreground">
                  {seven ? `${Math.round(seven.utilization)}%` : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-muted">
                  {seven ? formatResetsIn(seven.resetsAt, now) || '—' : '—'}
                </td>
                <td className="py-2 pl-4 text-right text-muted">
                  {extra?.isEnabled && extra.usedCredits !== null && extra.monthlyLimit !== null
                    ? `${formatUsd(extra.usedCredits)} / ${formatUsd(extra.monthlyLimit)}`
                    : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/usage/usage-limits.tsx
git commit -m "feat(usage): pooled limits view"
```

---

### Task 12: The page, and wiring it into the app

**Files:**
- Create: `src/components/usage/usage-page.tsx`
- Modify: `src/app.tsx` (imports near line 26; store reads near line 62; key handler near line 112; header near line 280; content row near line 307)
- Modify: `src/components/claude-accounts/account-pill.tsx:54`
- Modify: `src/components/claude-accounts/accounts-popover.tsx` (props near line 12; footer near line 119)

- [ ] **Step 1: Write the page**

Create `src/components/usage/usage-page.tsx`:

```tsx
import { useEffect, useMemo, useRef } from 'react'
import { ipc, isTauri } from '../../lib/ipc'
import { useUsage, type UsageView } from '../../state/usage'
import { useClaudeAccounts } from '../../state/claude-accounts'
import {
  breakdown,
  filterBuckets,
  formatTokens,
  formatUsd,
  makeGroups,
  series,
  totals,
  type UsagePeriod,
} from '../../lib/usage'
import { UsageChart } from './usage-chart'
import { UsageTotals } from './usage-totals'
import { UsageBreakdown } from './usage-breakdown'
import { UsageLimits } from './usage-limits'

const VIEWS: { id: UsageView; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'limits', label: 'Limits' },
]
const PERIODS: UsagePeriod[] = ['24h', '7d', '30d', '90d']

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-md border border-border text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`px-2.5 py-1 ${
            value === o.id ? 'bg-foreground/10 text-foreground' : 'text-muted hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function History() {
  const s = useUsage()
  const metric = s.view === 'tokens' ? 'tokens' : 'cost'
  const format = metric === 'cost' ? formatUsd : formatTokens
  const summary = s.summary

  const groups = useMemo(
    () => makeGroups(s.dimension, summary?.projects ?? []),
    [s.dimension, summary]
  )
  const rows = useMemo(
    () => breakdown(summary?.buckets ?? [], groups, metric),
    [summary, groups, metric]
  )
  const visible = useMemo(
    () => filterBuckets(summary?.buckets ?? [], groups, s.filterKey),
    [summary, groups, s.filterKey]
  )
  const slots = Math.max(0, s.boundaries.length - 1)
  const chart = useMemo(() => series(visible, slots, groups, metric), [visible, slots, groups, metric])
  const sums = useMemo(() => totals(visible), [visible])

  if (s.error) {
    return (
      <div className="flex flex-col items-start gap-3 py-8 text-sm">
        <span className="text-danger">{s.error}</span>
        <button
          type="button"
          onClick={() => void s.load(true)}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-foreground/5"
        >
          Retry
        </button>
      </div>
    )
  }
  if (!summary) {
    return (
      <div className="py-8 text-sm text-muted">
        Reading Claude Code history…
        {s.progress && ` ${s.progress.done} of ${s.progress.total} files`}
      </div>
    )
  }
  if (summary.historyStartMs === null) {
    return (
      <div className="py-8 text-sm text-muted">
        No Claude Code usage found in <code>~/.claude/projects</code>.
      </div>
    )
  }

  const startsLate = s.boundaries.length > 0 && summary.historyStartMs > s.boundaries[0]
  const troubled = (s.scan?.sources ?? []).filter((x) => x.status !== 'ok')
  const priceNote =
    summary.pricing.tier === 'bundled'
      ? 'rates bundled with the app'
      : `rates fetched ${new Date(summary.pricing.fetchedAt ?? 0).toLocaleDateString()}${
          summary.pricing.tier === 'stale' ? ' (could not refresh)' : ''
        }`

  return (
    <div className={`flex flex-col gap-6 ${s.loading ? 'opacity-60' : ''}`}>
      <UsageChart data={chart} boundaries={s.boundaries} period={s.loadedPeriod} format={format} />
      <UsageTotals totals={sums} />
      <UsageBreakdown
        rows={rows}
        dimension={s.dimension}
        filterKey={s.filterKey}
        onDimension={s.setDimension}
        onToggle={s.toggleFilter}
      />
      <footer className="flex flex-col gap-1 border-t border-border pt-3 text-[11px] text-muted">
        <span>
          Costs are estimates at list API rates, not your subscription bill ({priceNote}).
        </span>
        {startsLate && (
          <span>
            History starts {new Date(summary.historyStartMs).toLocaleDateString()}. Claude Code
            deletes older transcripts; Terminal Workspace keeps what it has seen for 100 days.
          </span>
        )}
        {sums.unpricedTokens > 0 && (
          <span>{formatTokens(sums.unpricedTokens)} tokens are from models with no known rate.</span>
        )}
        {troubled.map((x) => (
          <span key={x.label}>
            {x.label}: {x.status === 'missing' ? 'no Claude Code history found' : `${x.skipped} files could not be read`}.
          </span>
        ))}
      </footer>
    </div>
  )
}

/**
 * Full-pane layer over the terminals. It takes keyboard focus while open so
 * typing and Esc cannot reach an agent hidden underneath.
 */
export function UsagePage() {
  const view = useUsage((s) => s.view)
  const period = useUsage((s) => s.period)
  const loading = useUsage((s) => s.loading)
  const setView = useUsage((s) => s.setView)
  const setPeriod = useUsage((s) => s.setPeriod)
  const refresh = useUsage((s) => s.refresh)
  const closePage = useUsage((s) => s.closePage)
  const setProgress = useUsage((s) => s.setProgress)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.focus()
  }, [])

  useEffect(() => {
    if (!isTauri) return
    const unlisten = ipc.usage.onScanProgress(setProgress)
    return () => {
      void unlisten.then((off) => off())
    }
  }, [setProgress])

  return (
    <div
      ref={root}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          closePage()
        }
      }}
      className="absolute inset-0 z-20 overflow-y-auto bg-background outline-none"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-5">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-medium text-foreground">Usage</h1>
          <Segmented options={VIEWS} value={view} onChange={setView} label="Usage view" />
          {view !== 'limits' && (
            <Segmented
              options={PERIODS.map((p) => ({ id: p, label: p }))}
              value={period}
              onChange={setPeriod}
              label="Usage period"
            />
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() =>
              void (view === 'limits'
                ? useClaudeAccounts.getState().refreshUsage(true)
                : refresh())
            }
            disabled={loading}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={closePage}
            title="Close (Esc)"
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            ✕
          </button>
        </header>
        {view === 'limits' ? <UsageLimits /> : <History />}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire into `src/app.tsx`**

Add imports after `import { useWsl } from './state/wsl'`:

```tsx
import { useUsage } from './state/usage'
import { UsagePage } from './components/usage/usage-page'
```

After the `const toggleSettings = useUi((s) => s.toggleSettings)` line, add:

```tsx
  const usageOpen = useUsage((s) => s.open)
  const toggleUsage = useUsage((s) => s.togglePage)
```

In the `onKey` handler, add a branch **before** `if (!selectedProject) return` (directly after the `p`/`P` quick-open branch), so the shortcut works with no project selected:

```tsx
      if (e.shiftKey && (e.key === 'u' || e.key === 'U')) {
        e.preventDefault()
        toggleUsage()
        return
      }
```

In the same handler, stop `Ctrl+W` from closing a terminal hidden behind the page by changing its branch to:

```tsx
      } else if (key === 'w' && activeTerminalId && !usageOpen) {
```

and add `toggleUsage` and `usageOpen` to that effect's dependency array:

```tsx
  }, [selectedProject, activeTerminalId, toggleSidebar, toggleRightSidebar, requestTerminalClose, toggleUsage, usageOpen])
```

The sidebars stay clickable while the page is open, so picking a project or terminal there (or creating one with `Ctrl+T`) must reveal it. Add this effect after the `toggleUsage` line:

```tsx
  useEffect(() => {
    useUsage.getState().closePage()
  }, [selectedProject?.id, activeTerminalId])
```

In the header, add a button immediately before the Settings button (`onClick={() => openSettings()}`):

```tsx
          <button
            type="button"
            onClick={toggleUsage}
            title={`Usage (${kbd('⇧U')})`}
            className={`flex h-6 w-6 items-center justify-center rounded-md hover:bg-foreground/10 hover:text-foreground ${
              usageOpen ? 'text-foreground/80' : 'text-foreground/50'
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="6" y1="20" x2="6" y2="12" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="18" y1="20" x2="18" y2="9" />
            </svg>
          </button>
```

Change the content row (the `<div className="flex min-h-0 flex-1">` directly under `</header>`) to be a positioning parent, gate the terminals' `active` flag, and mount the page as its last child:

```tsx
        <div className="relative flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 overflow-hidden">
            {allTerminals.map((t) => (
              <TerminalPane
                key={t.id}
                terminalId={t.id}
                active={!usageOpen && t.project.id === selectedProject?.id && t.id === activeTerminalId}
                onBell={() => handleBell(t.project, t)}
              />
            ))}
```

and, just before that row's closing `</div>` (after the `{showFilePane && selectedProject && ( ... )}` block):

```tsx
          {usageOpen && <UsagePage />}
        </div>
      </main>
```

Why `active` is gated: `TerminalPane` focuses its terminal when `active` turns true (`terminal-pane.tsx:313-316`). Turning it false while the page is open, and true again on close, hands focus back to the terminal without new plumbing.

- [ ] **Step 3: Add the "Usage" link to the accounts popover**

In `src/components/claude-accounts/accounts-popover.tsx`, change the signature and add the store import:

```tsx
import { useUsage } from '../../state/usage'
```

```tsx
export function AccountsPopover({ onClose }: { onClose: () => void }) {
```

In the footer's non-logging-in branch, after the `API Key` button, add:

```tsx
            <button
              type="button"
              onClick={() => {
                onClose()
                useUsage.getState().openPage()
              }}
              className="text-link hover:underline"
            >
              Usage
            </button>
```

In `src/components/claude-accounts/account-pill.tsx`, pass the callback:

```tsx
            <AccountsPopover onClose={() => setOpen(false)} />
```

- [ ] **Step 4: Typecheck and run all frontend tests**

Run: `pnpm typecheck && pnpm test`
Expected: `tsc` exits 0; all test files pass (the previous 89 tests plus the 17 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/components/usage/usage-page.tsx src/app.tsx src/components/claude-accounts/accounts-popover.tsx src/components/claude-accounts/account-pill.tsx
git commit -m "feat(usage): usage page with shortcut, header button and focus handling"
```

---

### Task 13: Verify in the running app

**Files:** none (verification only; fix what it finds in the file the defect lives in, with a test where one applies).

- [ ] **Step 1: Launch**

Run: `pnpm tauri dev` (or `& "src-tauri/build-msvc.cmd" dev` if the linker environment is broken).

- [ ] **Step 2: Check each behaviour and record the result**

1. Press `Ctrl+Shift+U` with a project selected, and again with none selected. The page opens both times.
2. On first open the text "Reading Claude Code history… N of M files" counts up, then the chart appears. Close and reopen: it appears without the long wait.
3. Switch 24h / 7d / 30d / 90d. Each renders; 90d shows "History starts …" in the footer.
4. Switch Cost / Tokens. The Y axis and breakdown sort order change.
5. Click a breakdown row. Chart and totals narrow to it; "Clear filter" restores them. Switch Model / Project.
6. Open Limits. Both window cards and the account table show the same numbers as the accounts popover.
7. Start `claude` in a terminal, open the page, type letters and press `Esc`. Nothing reaches the terminal; the page closes; the terminal has focus again and accepts typing.
8. Click "Usage" in the accounts popover footer. The popover closes and the page opens.
   With the page open, click another terminal in the sidebar: the page closes and that
   terminal shows. Press `Ctrl+W` with the page open: no close-terminal prompt appears.
   On the Limits view, Refresh updates the account numbers.
9. Switch through all six built-in themes with the page open. Bars, text and share bars stay legible in each.
10. Compare one full day's token totals with `npx ccusage@latest daily` for the same day. Record both numbers. A difference in output tokens is expected if that tool keeps the first line of each response; input and cache totals should match closely.

- [ ] **Step 3: Confirm the ledger file**

Check the app data directory (`%APPDATA%\com.terminal-workspace.app` or the path in `TW_DATA_DIR`; confirm the identifier in `src-tauri/tauri.conf.json`) contains `usage-ledger-v1.json`, and note its size.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(usage): corrections from in-app verification"
```

Skip the commit if nothing changed.

---

### Task 14: Documentation and changelog

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)
- Modify: `README.md` (Features list; Architecture block; Keyboard shortcuts table)

- [ ] **Step 1: Changelog**

In `CHANGELOG.md`, under `## [Unreleased]`:

```markdown
### Added
- Usage page (`Ctrl/Cmd+Shift+U`): Claude Code token and estimated-cost history by day,
  model and project over 24 hours to 90 days, plus pooled 5-hour and 7-day limits across
  accounts. History is kept for 100 days, beyond Claude Code's own transcript cleanup.
```

If an `### Added` heading already exists under Unreleased, add only the bullet.

- [ ] **Step 2: README**

In the Features list, after the **Claude accounts.** bullet:

```markdown
- **Usage.** A full-pane page (⌘/Ctrl ⇧ U) with token and API-equivalent cost history by
  day, model and project, read from Claude's transcripts and kept for 100 days, plus pooled
  subscription limits across your accounts.
```

In the Architecture block, after the `claude/` line:

```
  usage/       transcript scan → durable usage ledger, model pricing, aggregation
```

In the Keyboard shortcuts table, after the `⌘/Ctrl P` row:

```markdown
| ⌘/Ctrl ⇧ U | Open the Usage page |
```

- [ ] **Step 3: Final full check**

Run:

```bash
pnpm typecheck && pnpm test
cd src-tauri && cargo test --lib && cargo check --no-default-features
```

Expected: everything passes.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(usage): changelog and readme for the usage page"
```

---

## Changes made during the build

The code as built differs from the task text above in these places. The spec is current.

- **Ledger loading (Task 2, Task 6).** `Ledger::load(path, now_ms)` returns a `Result`. A
  read error is returned, not treated as corruption; an unparseable file is moved to a
  uniquely named `corrupt-<time>` file and the `.bak.json` from the previous save is loaded.
  `save` flushes to disk and keeps the replaced ledger as the backup. `prune` is skipped
  when the clock is more than a day past the newest record. `UsageStore::scan` returns a
  `Result`.
- **Price refresh (Task 6).** `usage_refresh_prices` returns true whenever a table was
  stored, not only when rates changed, so the footer's fetch time updates. Responses
  declaring more than 32 MB are ignored.
- **Chart colours (Task 10).** Fixed `--chart-1..5` variables in `globals.css` replace the
  theme ANSI colours, and colours are assigned from the unfiltered ranking so a filtered
  series keeps its colour. Bars are capped at 44 units wide; grid lines are a faint mix of
  the foreground colour.
- **Closing the page (Task 12).** The `useEffect` in `app.tsx` was removed.
  `selectProject`, `setActiveTerminal` and `createProjectTerminal` in `src/state/store.ts`
  close the page instead. The terminal container and file pane are `inert` while it is open.
- **Not changed:** a summary requested during a scan waits for the scan, because both hold
  the ledger lock. Parsing outside the lock was considered and left for later.

## Spec coverage

| Spec section | Task |
|---|---|
| Record parsing, null tolerance, timestamp parser | 1 |
| Ledger, de-duplication rule, retention, failing safe | 2 |
| Roots, recursive walk, incremental parse, progress | 3, 6 |
| Pricing tiers, lookup, cost formula, fetch validation | 4, 6 |
| Bucketing and aggregation | 5, 8 |
| Wire contract, project rows | 6, 7 |
| Page layout, opening, focus, states, footer | 10, 12 |
| Limits view | 8, 11 |
| Error handling table | 2, 3, 4, 6, 12 |
| Testing | 1–6, 8, 13 |

