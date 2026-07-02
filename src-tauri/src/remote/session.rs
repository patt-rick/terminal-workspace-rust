//! Pairing-code lifecycle, session-token issuance/validation, and single-active-
//! session enforcement. All state is in memory only — never written to disk, so
//! an app restart ends any remote session (matches PTY non-restore semantics).

use base64::Engine;
use parking_lot::Mutex;
use rand::rngs::OsRng;
use rand::{Rng, RngCore};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::watch;

/// Pairing code lifetime.
const CODE_TTL: Duration = Duration::from_secs(300); // 5 minutes
/// Failed pairing attempts before the caller should tear the session down.
pub const MAX_FAILED: u32 = 5;

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    NoCode,
    Expired,
    TooManyAttempts,
    Wrong,
}

struct Inner {
    pairing_code: Option<String>,
    code_created: Instant,
    failed_attempts: u32,
    token: Option<String>,
    connected_since: Option<SystemTime>,
    /// Incremented on every new session and on reset; existing sockets watch it
    /// to self-evict when a newer client takes over.
    generation: u64,
}

pub struct SessionManager {
    inner: Mutex<Inner>,
    generation_tx: watch::Sender<u64>,
    generation_rx: watch::Receiver<u64>,
}

impl SessionManager {
    pub fn new() -> Self {
        let (generation_tx, generation_rx) = watch::channel(0u64);
        Self {
            inner: Mutex::new(Inner {
                pairing_code: None,
                code_created: Instant::now(),
                failed_attempts: 0,
                token: None,
                connected_since: None,
                generation: 0,
            }),
            generation_tx,
            generation_rx,
        }
    }

    /// Mint a fresh 6-digit code, resetting attempts and invalidating the old one.
    pub fn new_code(&self) -> String {
        let mut inner = self.inner.lock();
        let code = format!("{:06}", OsRng.gen_range(0..1_000_000u32));
        inner.pairing_code = Some(code.clone());
        inner.code_created = Instant::now();
        inner.failed_attempts = 0;
        code
    }

    pub fn current_code(&self) -> Option<String> {
        self.inner.lock().pairing_code.clone()
    }

    pub fn failed_attempts(&self) -> u32 {
        self.inner.lock().failed_attempts
    }

    /// Verify a pairing code. On success returns a fresh 256-bit token, consumes
    /// the code (single-use), and evicts any existing session.
    pub fn verify_pair(&self, code: &str) -> Result<String, PairError> {
        let mut inner = self.inner.lock();
        let Some(current) = inner.pairing_code.clone() else {
            return Err(PairError::NoCode);
        };
        if inner.failed_attempts >= MAX_FAILED {
            return Err(PairError::TooManyAttempts);
        }
        if inner.code_created.elapsed() > CODE_TTL {
            inner.pairing_code = None;
            return Err(PairError::Expired);
        }
        if code != current {
            inner.failed_attempts += 1;
            return Err(PairError::Wrong);
        }
        let token = random_token();
        inner.token = Some(token.clone());
        inner.pairing_code = None;
        inner.failed_attempts = 0;
        inner.connected_since = Some(SystemTime::now());
        inner.generation += 1;
        let generation = inner.generation;
        drop(inner);
        let _ = self.generation_tx.send(generation); // evict any prior session
        Ok(token)
    }

    /// Validate a token; returns the current generation if it matches.
    pub fn validate_token(&self, token: &str) -> Option<u64> {
        let inner = self.inner.lock();
        match &inner.token {
            Some(t) if t == token => Some(inner.generation),
            _ => None,
        }
    }

    pub fn subscribe_generation(&self) -> watch::Receiver<u64> {
        self.generation_rx.clone()
    }

    pub fn connected_since(&self) -> Option<SystemTime> {
        self.inner.lock().connected_since
    }

    /// Invalidate all pairing/token state and evict any live session.
    pub fn reset(&self) {
        let mut inner = self.inner.lock();
        inner.pairing_code = None;
        inner.token = None;
        inner.failed_attempts = 0;
        inner.connected_since = None;
        inner.generation += 1;
        let generation = inner.generation;
        drop(inner);
        let _ = self.generation_tx.send(generation);
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_then_validate_token() {
        let s = SessionManager::new();
        let code = s.new_code();
        let token = s.verify_pair(&code).expect("pairs");
        assert!(s.validate_token(&token).is_some());
        assert!(s.validate_token("nope").is_none());
    }

    #[test]
    fn code_is_single_use() {
        let s = SessionManager::new();
        let code = s.new_code();
        assert!(s.verify_pair(&code).is_ok());
        // Reusing the (now consumed) code fails.
        assert_eq!(s.verify_pair(&code), Err(PairError::NoCode));
    }

    #[test]
    fn wrong_code_counts_toward_the_cap() {
        let s = SessionManager::new();
        s.new_code();
        for _ in 0..MAX_FAILED {
            assert_eq!(s.verify_pair("000000_wrong"), Err(PairError::Wrong));
        }
        assert_eq!(s.failed_attempts(), MAX_FAILED);
        // Once capped, even a correct code is refused.
        assert_eq!(s.verify_pair("000000_wrong"), Err(PairError::TooManyAttempts));
    }

    #[test]
    fn new_pairing_bumps_generation_to_evict_prior_session() {
        let s = SessionManager::new();
        let c1 = s.new_code();
        let t1 = s.verify_pair(&c1).unwrap();
        let gen1 = s.validate_token(&t1).unwrap();
        let mut rx = s.subscribe_generation();

        let c2 = s.new_code();
        let t2 = s.verify_pair(&c2).unwrap();
        let gen2 = s.validate_token(&t2).unwrap();

        assert_ne!(gen1, gen2);
        // The watch reflects the newer generation (how a live socket self-evicts).
        assert!(rx.has_changed().unwrap());
        assert_eq!(*rx.borrow_and_update(), gen2);
        // The old token is no longer valid.
        assert!(s.validate_token(&t1).is_none());
    }

    #[test]
    fn reset_clears_everything() {
        let s = SessionManager::new();
        let code = s.new_code();
        let token = s.verify_pair(&code).unwrap();
        s.reset();
        assert!(s.validate_token(&token).is_none());
        assert!(s.current_code().is_none());
    }
}
