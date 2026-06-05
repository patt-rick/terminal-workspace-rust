use serde::{Serialize, Serializer};

/// Error type returned from Tauri commands. Serializes to its display string so
/// the frontend receives a plain message it can surface in a toast / inline.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Msg(e.to_string())
    }
}

impl From<&str> for AppError {
    fn from(e: &str) -> Self {
        AppError::Msg(e.to_string())
    }
}

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError::Msg(e)
    }
}

pub type AppResult<T> = Result<T, AppError>;
