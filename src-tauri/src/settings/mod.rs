use crate::error::AppResult;
use parking_lot::Mutex;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// Persists the UI settings blob (theme id, editor + terminal prefs, layout
/// widths) as opaque JSON. The frontend owns the schema; Rust only stores it,
/// so settings can evolve without touching this file. Atomic tmp+rename writes.
pub struct SettingsStore {
    path: PathBuf,
    cache: Mutex<Option<Value>>,
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self {
        let initial = read_file(&path);
        Self {
            path,
            cache: Mutex::new(initial),
        }
    }

    pub fn get(&self) -> Option<Value> {
        self.cache.lock().clone()
    }

    pub fn set(&self, value: Value) -> AppResult<()> {
        write_atomic(&self.path, &value)?;
        *self.cache.lock() = Some(value);
        Ok(())
    }
}

fn read_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_atomic(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
