//! Read/write `~/.claude/.credentials.json` — the Claude CLI's OAuth
//! credentials file. The `claudeAiOauth` block is handled as raw JSON so
//! fields this app doesn't know about survive a rewrite.

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const EXPIRY_BUFFER_MS: i64 = 5 * 60 * 1000;

/// Resolve the credentials file path. `config_dir_override` is
/// `$CLAUDE_CONFIG_DIR` when set (tested seam); callers pass the env var.
pub fn credentials_path_from(home: &Path, config_dir_override: Option<String>) -> PathBuf {
    match config_dir_override.filter(|s| !s.trim().is_empty()) {
        Some(dir) => PathBuf::from(dir).join(".credentials.json"),
        None => home.join(".claude").join(".credentials.json"),
    }
}

pub fn credentials_path(home: &Path) -> PathBuf {
    credentials_path_from(home, std::env::var("CLAUDE_CONFIG_DIR").ok())
}

/// The `claudeAiOauth` block, only when it exists and carries an accessToken.
/// Missing file / malformed JSON / unusable block all read as None — callers
/// treat "no credentials" and "unreadable credentials" the same way.
pub fn read_credentials_file(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    let block = root.get("claudeAiOauth")?.clone();
    block.get("accessToken")?.as_str().filter(|s| !s.is_empty())?;
    Some(block)
}

/// Replace the `claudeAiOauth` block, preserving unknown sibling keys.
/// Atomic tmp+rename, creating parent dirs as needed.
pub fn write_credentials_file(path: &Path, oauth_block: &Value) -> AppResult<()> {
    let mut root: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()));
    if !root.is_object() {
        root = Value::Object(Default::default());
    }
    root.as_object_mut()
        .expect("root forced to object above")
        .insert("claudeAiOauth".to_string(), oauth_block.clone());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::Msg(e.to_string()))?;
    }
    let s = serde_json::to_string_pretty(&root).map_err(|e| AppError::Msg(e.to_string()))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, s).map_err(|e| AppError::Msg(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(())
}

pub fn creds_str(block: &Value, key: &str) -> Option<String> {
    block.get(key)?.as_str().map(str::to_string)
}

pub fn creds_i64(block: &Value, key: &str) -> Option<i64> {
    block.get(key)?.as_i64()
}

/// True when the token should be refreshed before use. Unknown expiry fails
/// safe (refresh).
pub fn needs_refresh(expires_at_ms: Option<i64>, now_ms: i64) -> bool {
    match expires_at_ms {
        Some(exp) => now_ms >= exp - EXPIRY_BUFFER_MS,
        None => true,
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn path_defaults_to_home_dot_claude() {
        let p = credentials_path_from(Path::new("/home/u"), None);
        assert_eq!(p, Path::new("/home/u").join(".claude").join(".credentials.json"));
    }

    #[test]
    fn path_honors_claude_config_dir() {
        let p = credentials_path_from(Path::new("/home/u"), Some("/custom/dir".into()));
        assert_eq!(p, Path::new("/custom/dir").join(".credentials.json"));
    }

    #[test]
    fn read_returns_oauth_block() {
        let dir = tempdir().unwrap();
        let f = dir.path().join(".credentials.json");
        std::fs::write(&f, r#"{"claudeAiOauth":{"accessToken":"tok-a","expiresAt":123},"other":1}"#).unwrap();
        let v = read_credentials_file(&f).unwrap();
        assert_eq!(creds_str(&v, "accessToken").as_deref(), Some("tok-a"));
        assert_eq!(creds_i64(&v, "expiresAt"), Some(123));
    }

    #[test]
    fn read_missing_or_malformed_is_none() {
        let dir = tempdir().unwrap();
        assert!(read_credentials_file(&dir.path().join("nope.json")).is_none());
        let f = dir.path().join("bad.json");
        std::fs::write(&f, "{not json").unwrap();
        assert!(read_credentials_file(&f).is_none());
        let f2 = dir.path().join("empty-block.json");
        std::fs::write(&f2, r#"{"claudeAiOauth":{"expiresAt":1}}"#).unwrap();
        assert!(read_credentials_file(&f2).is_none()); // no accessToken -> unusable
    }

    #[test]
    fn write_preserves_unknown_siblings_and_creates_dirs() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("nested").join(".credentials.json");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(&f, r#"{"claudeAiOauth":{"accessToken":"old","weird":true},"sibling":{"keep":1}}"#).unwrap();
        let new_block: Value = serde_json::from_str(r#"{"accessToken":"new","refreshToken":"r1"}"#).unwrap();
        write_credentials_file(&f, &new_block).unwrap();
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        assert_eq!(after["claudeAiOauth"]["accessToken"], "new");
        assert_eq!(after["sibling"]["keep"], 1);           // sibling preserved
        assert!(after["claudeAiOauth"].get("weird").is_none()); // block replaced whole

        // Writing when no file exists yet also works.
        let f2 = dir.path().join("fresh").join(".credentials.json");
        write_credentials_file(&f2, &new_block).unwrap();
        let after2: Value = serde_json::from_str(&std::fs::read_to_string(&f2).unwrap()).unwrap();
        assert_eq!(after2["claudeAiOauth"]["refreshToken"], "r1");
    }

    #[test]
    fn needs_refresh_uses_buffer_and_fails_safe() {
        let now = 1_000_000_000;
        assert!(needs_refresh(None, now));                              // unknown expiry -> refresh
        assert!(needs_refresh(Some(now - 1), now));                     // expired
        assert!(needs_refresh(Some(now + EXPIRY_BUFFER_MS - 1), now));  // inside buffer
        assert!(!needs_refresh(Some(now + EXPIRY_BUFFER_MS + 1), now)); // comfortably valid
    }
}
