use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Largest file the in-app editor loads as text (5 MB).
const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    /// path relative to the project root, forward slashes; "" = root
    pub path: String,
    pub is_directory: bool,
    /// true if ignored by git (gitignore / under an ignored dir)
    pub ignored: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReadResult {
    Text { content: String },
    Binary,
    TooLarge,
}

fn is_binary(bytes: &[u8]) -> bool {
    // A NUL byte in the first 8 KB is a strong binary signal (same heuristic
    // most editors use).
    bytes.iter().take(8000).any(|&b| b == 0)
}

fn rel_join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// List one directory (non-recursive), flagging gitignored entries rather than
/// hiding them — mirroring the Electron app's dimmed-but-visible behavior.
pub fn list(root: &Path, rel: &str) -> AppResult<Vec<FsEntry>> {
    let dir = root.join(rel);

    let mut entries: Vec<FsEntry> = Vec::new();
    for e in fs::read_dir(&dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let is_directory = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(FsEntry {
            name: name.clone(),
            path: rel_join(rel, &name),
            is_directory,
            ignored: false,
        });
    }

    // Names the ignore stack (gitignore, parents, global, excludes) admits at
    // depth 1; anything present on disk but absent here is ignored.
    let mut allowed: HashSet<String> = HashSet::new();
    let walker = ignore::WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .build();
    for result in walker {
        if let Ok(d) = result {
            if d.depth() == 0 {
                continue;
            }
            if let Some(n) = d.file_name().to_str() {
                allowed.insert(n.to_string());
            }
        }
    }
    for entry in &mut entries {
        if !allowed.contains(&entry.name) {
            entry.ignored = true;
        }
    }

    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn read_text(root: &Path, rel: &str) -> AppResult<ReadResult> {
    let path = root.join(rel);
    let meta = fs::metadata(&path)?;
    if meta.len() > MAX_TEXT_BYTES {
        return Ok(ReadResult::TooLarge);
    }
    let bytes = fs::read(&path)?;
    if is_binary(&bytes) {
        return Ok(ReadResult::Binary);
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text { content }),
        Err(_) => Ok(ReadResult::Binary),
    }
}

pub fn write_text(root: &Path, rel: &str, content: &str) -> AppResult<()> {
    let path = root.join(rel);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, content)?;
    Ok(())
}

pub fn create_file(root: &Path, rel: &str) -> AppResult<()> {
    let path = root.join(rel);
    if path.exists() {
        return Err(AppError::Msg("already exists".to_string()));
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, "")?;
    Ok(())
}

pub fn create_folder(root: &Path, rel: &str) -> AppResult<()> {
    fs::create_dir_all(root.join(rel))?;
    Ok(())
}

pub fn rename(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let to_path = root.join(to);
    if let Some(dir) = to_path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::rename(root.join(from), to_path)?;
    Ok(())
}

pub fn remove(root: &Path, rel: &str) -> AppResult<()> {
    let path = root.join(rel);
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Copy a file/dir to a sibling with a unique " copy" suffix; returns the new
/// relative path.
pub fn duplicate(root: &Path, rel: &str) -> AppResult<String> {
    let src = root.join(rel);
    let parent_rel = Path::new(rel).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();

    for n in 1..1000 {
        let suffix = if n == 1 { " copy".to_string() } else { format!(" copy {n}") };
        let candidate_name = format!("{stem}{suffix}{ext}");
        let candidate_rel = if parent_rel.is_empty() {
            candidate_name.clone()
        } else {
            format!("{parent_rel}/{candidate_name}")
        };
        let dest = root.join(&candidate_rel);
        if !dest.exists() {
            if src.is_dir() {
                copy_dir(&src, &dest)?;
            } else {
                fs::copy(&src, &dest)?;
            }
            return Ok(candidate_rel.replace('\\', "/"));
        }
    }
    Err(AppError::Msg("could not find a free copy name".to_string()))
}

fn copy_dir(src: &Path, dest: &Path) -> AppResult<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Write text to an absolute path the user picked via a native save dialog.
/// Used for exports (e.g. themes); the WebView2 `<a download>` mechanism does
/// not work in the Tauri webview, so saving goes through the backend.
pub fn write_text_abs(path: &str, content: &str) -> AppResult<()> {
    if let Some(dir) = Path::new(path).parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, content)?;
    Ok(())
}

/// Write pasted/dropped bytes to a temp file and return its absolute path.
pub fn save_temp_paste(bytes: &[u8], ext: &str) -> AppResult<String> {
    let dir = std::env::temp_dir().join("tw-paste");
    fs::create_dir_all(&dir)?;
    let name = format!("{}.{}", uuid::Uuid::new_v4(), ext.trim_start_matches('.'));
    let path: PathBuf = dir.join(name);
    fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_binary() {
        assert!(is_binary(b"abc\0def"));
        assert!(!is_binary(b"hello world"));
    }
}
