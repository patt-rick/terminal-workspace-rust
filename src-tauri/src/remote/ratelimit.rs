//! A tiny per-key token-bucket rate limiter, used to throttle `/pair` attempts
//! per client IP as defense in depth (R3.9). This sits in front of the pairing
//! logic's own 5-attempt hard cap; it blunts rapid-fire guessing before the cap
//! trips.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::Instant;

/// Most keys tracked at once, so a flood of distinct keys can't grow the map
/// without bound.
const MAX_KEYS: usize = 1024;

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
        if map.len() >= MAX_KEYS && !map.contains_key(key) {
            self.evict(&mut map, now);
        }
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

impl RateLimiter {
    /// Drop buckets that have refilled (idle keys behave exactly like new ones);
    /// if every key is still active, drop the least recently used.
    fn evict(&self, map: &mut HashMap<String, Bucket>, now: Instant) {
        map.retain(|_, b| {
            let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
            b.tokens + elapsed * self.refill_per_sec < self.capacity
        });
        if map.len() >= MAX_KEYS {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, b)| b.last)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
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
    fn key_count_stays_bounded() {
        let rl = RateLimiter::new(2.0, 0.0);
        let t = Instant::now();
        for i in 0..(MAX_KEYS * 3) {
            rl.check_at(&format!("ip{i}"), t + Duration::from_millis(i as u64));
        }
        assert!(rl.inner.lock().len() <= MAX_KEYS);
        // The newest key survived; the oldest was the one evicted.
        assert!(rl
            .inner
            .lock()
            .contains_key(&format!("ip{}", MAX_KEYS * 3 - 1)));
        assert!(!rl.inner.lock().contains_key("ip0"));
    }

    #[test]
    fn idle_buckets_are_dropped_first() {
        let rl = RateLimiter::new(1.0, 1.0);
        let t = Instant::now();
        for i in 0..MAX_KEYS {
            rl.check_at(&format!("ip{i}"), t);
        }
        // Ten seconds on, every bucket has refilled: all are idle, so all go.
        rl.check_at("late", t + Duration::from_secs(10));
        assert_eq!(rl.inner.lock().len(), 1);
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
