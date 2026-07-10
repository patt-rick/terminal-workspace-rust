//! Per-project debounced filesystem watcher. Incrementally reconciles index
//! entries; forces a full rebuild on any .gitignore/exclude change or watcher
//! error/overflow. Non-fatal and silent, matching git/discover.rs.

use super::{apply_change, refresh_paths, IndexStatus, ProjectIndex};
use notify_debouncer_mini::notify::{Error as NotifyError, RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Keeps the debouncer (and its watch) alive; dropping it stops watching.
pub struct Handle {
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// Start a recursive, ~500ms-debounced watcher on `root` for `project_id`.
pub fn start(
    indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    project_id: String,
    root: PathBuf,
) -> Result<Handle, NotifyError> {
    let root_cb = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| match res {
            Ok(events) => {
                let mut need_rebuild = false;
                {
                    let mut map = indices.lock();
                    let Some(index) = map.get_mut(&project_id) else {
                        return;
                    };
                    for ev in &events {
                        let name = ev.path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                        if name == ".gitignore" || name == "exclude" {
                            need_rebuild = true;
                            break;
                        }
                        apply_change(index, &ev.path);
                    }
                }
                if need_rebuild {
                    if let Some(p) = indices.lock().get_mut(&project_id) {
                        p.status = IndexStatus::Stale;
                    }
                    refresh_paths(indices.clone(), project_id.clone(), root_cb.clone());
                }
            }
            Err(_errors) => {
                // Watcher error / overflow rescan: full rebuild in place.
                if let Some(p) = indices.lock().get_mut(&project_id) {
                    p.status = IndexStatus::Stale;
                }
                refresh_paths(indices.clone(), project_id.clone(), root_cb.clone());
            }
        },
    )?;
    debouncer.watcher().watch(&root, RecursiveMode::Recursive)?;
    Ok(Handle {
        _debouncer: debouncer,
    })
}
