//! Uploaded project icons: one small PNG per project in the app-data dir. The
//! webview crops and scales the picture before sending it, so this side only
//! checks that what arrives is a PNG of a sane size and keeps it.

use crate::error::{AppError, AppResult};
use base64::Engine;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Managed state: the directory the icon files live in.
pub struct ProjectIconDir(pub PathBuf);

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const MAX_BYTES: usize = 512 * 1024;

/// The id becomes a file name; refuse anything that could leave the directory.
fn icon_path(dir: &Path, project_id: &str) -> AppResult<PathBuf> {
    let safe = !project_id.is_empty()
        && project_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !safe {
        return Err(AppError::Msg("invalid project id".to_string()));
    }
    Ok(dir.join(format!("{project_id}.png")))
}

pub fn write(dir: &Path, project_id: &str, bytes: &[u8]) -> AppResult<()> {
    let path = icon_path(dir, project_id)?;
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(AppError::Msg("icon is not a PNG image".to_string()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(AppError::Msg("icon is too large".to_string()));
    }
    fs::create_dir_all(dir)?;
    let tmp = path.with_extension("png.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// A missing file is not an error: there is nothing left to delete.
pub fn delete(dir: &Path, project_id: &str) {
    if let Ok(path) = icon_path(dir, project_id) {
        let _ = fs::remove_file(path);
    }
}

/// The stored icons as `data:` URLs, for the ids whose file exists and reads.
pub fn read_all(dir: &Path, project_ids: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for id in project_ids {
        let Ok(path) = icon_path(dir, id) else { continue };
        let Ok(bytes) = fs::read(path) else { continue };
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        out.insert(id.clone(), format!("data:image/png;base64,{encoded}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra: usize) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend(std::iter::repeat(7u8).take(extra));
        bytes
    }

    #[test]
    fn writes_reads_replaces_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let icons = dir.path().join("project-icons");
        let ids = vec!["p-1".to_string(), "p-2".to_string()];

        write(&icons, "p-1", &png(4)).unwrap();
        let read = read_all(&icons, &ids);
        assert_eq!(read.len(), 1);
        let first = read["p-1"].clone();
        assert!(first.starts_with("data:image/png;base64,"));

        write(&icons, "p-1", &png(40)).unwrap();
        assert_ne!(read_all(&icons, &ids)["p-1"], first);
        assert!(!icons.join("p-1.png.tmp").exists());

        delete(&icons, "p-1");
        assert!(!icons.join("p-1.png").exists());
        assert!(read_all(&icons, &ids).is_empty());
        delete(&icons, "p-1");
    }

    #[test]
    fn refuses_what_is_not_a_small_png() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write(dir.path(), "p", b"<svg onload=alert(1)>").is_err());
        assert!(write(dir.path(), "p", &png(MAX_BYTES)).is_err());
        assert!(write(dir.path(), "p", &png(MAX_BYTES - PNG_SIGNATURE.len())).is_ok());
    }

    #[test]
    fn refuses_an_id_that_could_leave_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../x", "a/b", "a\\b", "", "a.b", "c:d"] {
            assert!(write(dir.path(), bad, &png(4)).is_err(), "{bad}");
            assert!(read_all(dir.path(), &[bad.to_string()]).is_empty());
        }
    }
}
