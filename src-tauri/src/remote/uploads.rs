//! Images the phone attaches to a Claude prompt. The client sends the bytes
//! only; the server picks the folder, the name and the extension, so this is
//! not a filesystem endpoint (AC-3.10). Files live in
//! `<data dir>/remote-uploads` and are pruned on every upload.

use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const DIR_NAME: &str = "remote-uploads";
/// Largest decoded image accepted.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_FILES: usize = 50;
const MAX_TOTAL_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
}

impl ImageKind {
    fn ext(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Jpeg => "jpg",
        }
    }
    fn from_mime(mime: &str) -> Option<Self> {
        match mime.trim().to_ascii_lowercase().as_str() {
            "image/png" => Some(ImageKind::Png),
            "image/jpeg" | "image/jpg" => Some(ImageKind::Jpeg),
            _ => None,
        }
    }
}

/// The image type named by the file's magic bytes.
pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageKind::Jpeg)
    } else {
        None
    }
}

/// Decode and check an upload: PNG or JPEG only, the magic bytes must agree
/// with the declared type, and at most [`MAX_IMAGE_BYTES`] decoded.
pub fn decode(mime: &str, data_b64: &str) -> Result<(ImageKind, Vec<u8>), String> {
    let declared = ImageKind::from_mime(mime).ok_or("Only PNG and JPEG images can be sent.")?;
    // Reject an oversized payload before allocating for it.
    if data_b64.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4 {
        return Err(too_big());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim().as_bytes())
        .map_err(|_| "The image data was damaged in transit.".to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(too_big());
    }
    match sniff(&bytes) {
        Some(kind) if kind == declared => Ok((kind, bytes)),
        _ => Err("That file isn't a PNG or JPEG image.".into()),
    }
}

fn too_big() -> String {
    format!("Images must be {} MB or smaller.", MAX_IMAGE_BYTES / (1024 * 1024))
}

/// Delete expired uploads, then the oldest until `incoming` more bytes fit
/// within the file and size caps.
pub fn prune(dir: &Path, incoming: u64, now: SystemTime) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(now);
        if now.duration_since(modified).is_ok_and(|age| age > MAX_AGE) {
            let _ = std::fs::remove_file(e.path());
        } else {
            files.push((modified, meta.len(), e.path()));
        }
    }
    files.sort_by_key(|f| f.0);
    let mut total: u64 = files.iter().map(|f| f.1).sum::<u64>() + incoming;
    let mut count = files.len() + 1;
    for (_, len, path) in files {
        if count <= MAX_FILES && total <= MAX_TOTAL_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
            count -= 1;
        }
    }
}

/// Write the image as `<dir>/<uuid>.<ext>` after pruning; returns its path.
pub fn save(dir: &Path, kind: ImageKind, bytes: &[u8]) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    prune(dir, bytes.len() as u64, SystemTime::now());
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), kind.ext()));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// The path as the terminal's shell sees it: `/mnt/<drive>/…` in WSL, the
/// Windows path otherwise.
pub fn path_for_shell(path: &Path, shell: &str) -> Option<String> {
    let win = path.to_str()?;
    if crate::wsl::parse_shell_token(shell).is_some() {
        crate::wsl::win_to_wsl_path(win)
    } else {
        Some(win.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 0x10, b'J', b'F', b'I', b'F'];

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    #[test]
    fn sniffs_png_and_jpeg_only() {
        assert_eq!(sniff(PNG), Some(ImageKind::Png));
        assert_eq!(sniff(JPEG), Some(ImageKind::Jpeg));
        assert_eq!(sniff(b"GIF89a"), None);
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBP"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn decode_accepts_matching_type() {
        let (kind, bytes) = decode("image/png", &b64(PNG)).unwrap();
        assert_eq!((kind, bytes.as_slice()), (ImageKind::Png, PNG));
        assert_eq!(decode("image/jpeg", &b64(JPEG)).unwrap().0, ImageKind::Jpeg);
    }

    #[test]
    fn decode_rejects_other_types_and_mismatches() {
        assert!(decode("image/gif", &b64(b"GIF89a")).is_err());
        assert!(decode("image/webp", &b64(b"RIFF\0\0\0\0WEBP")).is_err());
        // Declared PNG, actually JPEG (and the reverse).
        assert!(decode("image/png", &b64(JPEG)).is_err());
        assert!(decode("image/jpeg", &b64(PNG)).is_err());
        // Declared PNG, actually a script.
        assert!(decode("image/png", &b64(b"#!/bin/sh\nrm -rf /")).is_err());
        assert!(decode("image/png", "not base64!").is_err());
    }

    #[test]
    fn decode_enforces_the_size_cap() {
        let mut ok = PNG.to_vec();
        ok.resize(MAX_IMAGE_BYTES, 0);
        assert!(decode("image/png", &b64(&ok)).is_ok());
        ok.push(0);
        assert!(decode("image/png", &b64(&ok)).unwrap_err().contains("5 MB"));
        // An absurd payload is refused without decoding it.
        let huge = "A".repeat(MAX_IMAGE_BYTES * 2);
        assert!(decode("image/png", &huge).unwrap_err().contains("5 MB"));
    }

    #[test]
    fn save_writes_a_fresh_name_with_the_sniffed_extension() {
        let dir = tempfile::tempdir().unwrap();
        let p = save(&dir.path().join(DIR_NAME), ImageKind::Jpeg, JPEG).unwrap();
        assert_eq!(p.extension().unwrap(), "jpg");
        assert!(uuid::Uuid::parse_str(p.file_stem().unwrap().to_str().unwrap()).is_ok());
        assert_eq!(std::fs::read(&p).unwrap(), JPEG);
    }

    fn touch(dir: &Path, name: &str, len: usize, age: Duration) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, vec![0u8; len]).unwrap();
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
        p
    }

    #[test]
    fn prune_drops_expired_files() {
        let dir = tempfile::tempdir().unwrap();
        let old = touch(dir.path(), "old.png", 10, Duration::from_secs(25 * 3600));
        let fresh = touch(dir.path(), "fresh.png", 10, Duration::from_secs(3600));
        prune(dir.path(), 10, SystemTime::now());
        assert!(!old.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn prune_evicts_oldest_beyond_the_file_cap() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<PathBuf> = (0..MAX_FILES)
            .map(|i| touch(dir.path(), &format!("{i}.png"), 1, Duration::from_secs(1000 - i as u64)))
            .collect();
        prune(dir.path(), 1, SystemTime::now());
        // Room for the incoming file: only the oldest goes.
        assert!(!paths[0].exists());
        assert!(paths[1..].iter().all(|p| p.exists()));
    }

    #[test]
    fn prune_evicts_oldest_beyond_the_size_cap() {
        let dir = tempfile::tempdir().unwrap();
        let chunk = 40 * 1024 * 1024;
        let a = touch(dir.path(), "a.png", chunk, Duration::from_secs(300));
        let b = touch(dir.path(), "b.png", chunk, Duration::from_secs(200));
        prune(dir.path(), MAX_IMAGE_BYTES as u64 * 5, SystemTime::now());
        assert!(!a.exists());
        assert!(b.exists());
    }

    #[test]
    fn shell_paths() {
        let p = Path::new(r"C:\Users\Patrick Ackom\AppData\Roaming\tw\remote-uploads\x.png");
        assert_eq!(
            path_for_shell(p, "wsl:Ubuntu").as_deref(),
            Some("/mnt/c/Users/Patrick Ackom/AppData/Roaming/tw/remote-uploads/x.png")
        );
        assert_eq!(
            path_for_shell(p, "wsl:").as_deref(),
            Some("/mnt/c/Users/Patrick Ackom/AppData/Roaming/tw/remote-uploads/x.png")
        );
        assert_eq!(
            path_for_shell(p, "powershell.exe").as_deref(),
            Some(r"C:\Users\Patrick Ackom\AppData\Roaming\tw\remote-uploads\x.png")
        );
    }
}
