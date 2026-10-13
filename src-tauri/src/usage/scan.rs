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
