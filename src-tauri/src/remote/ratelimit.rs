//! A tiny per-key token-bucket rate limiter, used to throttle `/pair` attempts
//! per client IP as defense in depth (R3.9). This sits in front of the pairing
//! logic's own 5-attempt hard cap; it blunts rapid-fire guessing before the cap
//! trips.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::Instant;

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct RateLimiter {
    inner: Mutex<HashMap<String, Bucket>>,
    capacity: f64,
    refill_per_sec: f64,
}

impl RateLimiter {
    /// `capacity` = max burst; `refill_per_sec` = sustained rate.
    pub fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            capacity,
            refill_per_sec,
        }
    }

    /// Try to spend one token for `key`. Returns `true` if allowed, `false` if
    /// the bucket is empty (caller should reject with 429).
    pub fn check(&self, key: &str) -> bool {
        self.check_at(key, Instant::now())
    }

    /// Testable core: caller supplies the clock reading.
    fn check_at(&self, key: &str, now: Instant) -> bool {
        let mut map = self.inner.lock();
        let bucket = map.entry(key.to_string()).or_insert(Bucket {
            tokens: self.capacity,
            last: now,
        });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn allows_up_to_capacity_then_blocks() {
        let rl = RateLimiter::new(3.0, 1.0);
        let t = Instant::now();
        assert!(rl.check_at("ip", t));
        assert!(rl.check_at("ip", t));
        assert!(rl.check_at("ip", t));
        // Bucket now empty at the same instant.
        assert!(!rl.check_at("ip", t));
    }

    #[test]
    fn refills_over_time() {
        let rl = RateLimiter::new(2.0, 1.0);
        let t = Instant::now();
        assert!(rl.check_at("ip", t));
        assert!(rl.check_at("ip", t));
        assert!(!rl.check_at("ip", t));
        // One second later, one token is back.
        let t2 = t + Duration::from_secs(1);
        assert!(rl.check_at("ip", t2));
        assert!(!rl.check_at("ip", t2));
    }

    #[test]
    fn keys_are_independent() {
        let rl = RateLimiter::new(1.0, 0.1);
        let t = Instant::now();
        assert!(rl.check_at("a", t));
        assert!(!rl.check_at("a", t));
        // A different IP has its own bucket.
        assert!(rl.check_at("b", t));
    }
}
