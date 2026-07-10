//! Quick-open file search: a per-project, in-memory fuzzy index over file paths.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub mod watcher;

/// Placeholder so `pub mod watcher;` resolves; replaced in later tasks.
#[derive(Default)]
pub struct SearchStore {
    pub(crate) indices: Arc<Mutex<HashMap<String, ProjectIndex>>>,
    watchers: Arc<Mutex<HashMap<String, watcher::Handle>>>,
}

pub struct ProjectIndex;
