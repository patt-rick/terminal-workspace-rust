use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub fetched_at: i64,
}
