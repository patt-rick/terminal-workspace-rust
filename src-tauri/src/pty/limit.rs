//! Claude usage-limit detection from the raw PTY byte stream. Unlike
//! `detect.rs` (which parses OSC control sequences), the limit copy is plain
//! ground-state text the TUI paints and wraps at terminal width. This detector
//! normalizes that text — stripping ANSI/CSI/cursor escapes and collapsing
//! soft-wrap — into a bounded rolling tail, then matches a loose family of
//! phrases. A match only *suspects* a limit: the frontend orchestrator confirms
//! against the usage API and owns all episode/quiet-period state. This detector
//! merely avoids spamming identical suspicions.

/// Which limit a phrase points at. The orchestrator confirms via the usage API;
/// this classification is a hint only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind {
    /// A subscription window (5-hour / weekly) is exhausted.
    Window,
    /// Extra-usage credits are exhausted.
    Credits,
}

// Provisional patterns pending the Phase-0 spike — tune once the exact limit
// copy across CLI versions is recorded. Matched against the normalized
// (ANSI-stripped, soft-wrap-collapsed, lowercased) rolling tail, so entries are
// lowercase and use single spaces. Kept high-specificity on purpose: each match
// costs the orchestrator a forced usage sweep, so loose phrases like bare
// "resets" or "limit reached" (which fire on ordinary output — "connection
// resets", "api rate limit reached") are deliberately excluded. A miss degrades
// to "no auto-switch", never a crash.
const LIMIT_PATTERNS: &[(&str, LimitKind)] = &[
    ("credit balance is too low", LimitKind::Credits),
    ("insufficient credit", LimitKind::Credits),
    ("out of credit", LimitKind::Credits),
    ("reached your usage limit", LimitKind::Window),
    ("usage limit reached", LimitKind::Window),
    ("usage limit will reset", LimitKind::Window),
];

/// How much normalized tail to retain — a few KB so a phrase split across 8KiB
/// reads (or fattened by ANSI wrapping) still resolves within one window.
const TAIL_CAP: usize = 8192;

/// Escape-sequence stripper state, carried across chunk boundaries.
#[derive(Default)]
enum State {
    #[default]
    Ground,
    Esc,
    /// ESC [ … CSI parameters, until a final byte 0x40..=0x7E.
    Csi,
    /// ESC ] … OSC (or DCS/PM/APC), until BEL or ST.
    Osc,
    OscEsc,
    /// One byte of a two-byte sequence (charset designators, etc.) to swallow.
    SwallowOne,
}

#[derive(Default)]
pub struct LimitDetector {
    state: State,
    /// Normalized rolling tail: lowercased, ANSI-free, whitespace collapsed to
    /// single spaces (soft-wrap joined).
    tail: String,
    /// Pattern last emitted. Suppresses re-emit while the same phrase is still
    /// present; cleared when the tail no longer matches anything, re-arming for
    /// a later episode.
    last_match: Option<&'static str>,
}

impl LimitDetector {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<LimitKind> {
        self.normalize(bytes);
        self.detect()
    }

    /// Cross-episode reset: clear the dedup arming and the accumulated tail.
    /// The orchestrator calls this at an in-place relaunch so the resumed
    /// transcript repaint (which reprints the old limit message) can't keep the
    /// detector armed on that stale phrase and swallow the next genuine limit.
    pub fn reset(&mut self) {
        self.last_match = None;
        self.tail.clear();
        self.state = State::Ground;
    }

    fn normalize(&mut self, bytes: &[u8]) {
        let mut ground: Vec<u8> = Vec::with_capacity(bytes.len());
        for &b in bytes {
            match self.state {
                State::Ground => match b {
                    0x1b => self.state = State::Esc,
                    // Drop stray control bytes (BEL, backspace, etc.).
                    0x00..=0x06 | 0x08 | 0x0b..=0x1f | 0x7f => {}
                    _ => ground.push(b),
                },
                State::Esc => match b {
                    b'[' => self.state = State::Csi,
                    b']' | b'P' | b'X' | b'^' | b'_' => self.state = State::Osc,
                    b'(' | b')' | b'*' | b'+' | b'-' | b'.' | b'/' | b'#' | b'%' => {
                        self.state = State::SwallowOne
                    }
                    0x1b => {} // stay in Esc
                    _ => self.state = State::Ground, // two-byte escape: drop the final
                },
                State::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.state = State::Ground;
                    }
                }
                State::Osc => match b {
                    0x07 => self.state = State::Ground,
                    0x1b => self.state = State::OscEsc,
                    _ => {}
                },
                State::OscEsc => match b {
                    b'\\' => self.state = State::Ground,
                    0x1b => {}
                    _ => self.state = State::Osc,
                },
                State::SwallowOne => self.state = State::Ground,
            }
        }
        // Ground bytes may be split mid-UTF-8 across chunks; lossy decode keeps
        // ASCII patterns intact (a replacement char never occurs inside one).
        for ch in String::from_utf8_lossy(&ground).chars() {
            if ch.is_whitespace() {
                if !self.tail.ends_with(' ') {
                    self.tail.push(' ');
                }
            } else {
                for lc in ch.to_lowercase() {
                    self.tail.push(lc);
                }
            }
        }
        if self.tail.len() > TAIL_CAP {
            let mut cut = self.tail.len() - TAIL_CAP;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }
    }

    fn detect(&mut self) -> Vec<LimitKind> {
        match best_match(&self.tail) {
            Some((pat, kind)) => {
                if self.last_match == Some(pat) {
                    Vec::new()
                } else {
                    self.last_match = Some(pat);
                    vec![kind]
                }
            }
            None => {
                self.last_match = None;
                Vec::new()
            }
        }
    }
}

/// The freshest pattern present in `tail`: the one whose last occurrence ends
/// furthest right, ties broken by longer pattern then table order. Deterministic
/// for a given tail, so the dedup key is stable across repeated identical output.
fn best_match(tail: &str) -> Option<(&'static str, LimitKind)> {
    let mut best: Option<(&'static str, LimitKind, usize)> = None;
    for &(pat, kind) in LIMIT_PATTERNS {
        if let Some(start) = tail.rfind(pat) {
            let end = start + pat.len();
            let better = match best {
                None => true,
                Some((bpat, _, bend)) => end > bend || (end == bend && pat.len() > bpat.len()),
            };
            if better {
                best = Some((pat, kind, end));
            }
        }
    }
    best.map(|(pat, kind, _)| (pat, kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_across_chunk_boundary() {
        let mut d = LimitDetector::default();
        assert!(d.feed(b"You have reached your usage li").is_empty());
        assert_eq!(d.feed(b"mit for this 5-hour window"), vec![LimitKind::Window]);
    }

    #[test]
    fn matches_through_ansi_and_soft_wrap() {
        let mut d = LimitDetector::default();
        // CSI erase + SGR color, an explicit wrap (CR/LF + indent), and a
        // non-ASCII bullet, all around the phrase.
        let input = b"\x1b[2K\x1b[31mUsage limit\x1b[0m\r\n     reached \xe2\x88\x99 resets at 3pm";
        assert_eq!(d.feed(input), vec![LimitKind::Window]);
    }

    #[test]
    fn classifies_window_vs_credits() {
        let mut w = LimitDetector::default();
        assert_eq!(
            w.feed(b"Claude usage limit reached. Try again later."),
            vec![LimitKind::Window]
        );
        let mut c = LimitDetector::default();
        assert_eq!(
            c.feed(b"Your credit balance is too low to continue."),
            vec![LimitKind::Credits]
        );
    }

    #[test]
    fn no_false_match_on_ordinary_text() {
        let mut d = LimitDetector::default();
        assert!(d
            .feed(b"Compiling project... done in 3.2s\n> npm run build\n")
            .is_empty());
        assert!(d
            .feed(b"All tests passed. No issues found; nothing to report.")
            .is_empty());
    }

    #[test]
    fn benign_reset_and_rate_limit_lines_do_not_match() {
        // The narrowed patterns must ignore ordinary prose that mentions resets
        // or a non-Claude rate limit.
        let mut a = LimitDetector::default();
        assert!(a.feed(b"the counter resets at midnight").is_empty());
        let mut b = LimitDetector::default();
        assert!(b.feed(b"github api rate limit reached, retrying").is_empty());
    }

    #[test]
    fn no_duplicate_reemit_for_repeated_line() {
        let mut d = LimitDetector::default();
        assert_eq!(d.feed(b"usage limit reached\n"), vec![LimitKind::Window]);
        // The identical line repainting must not re-emit.
        assert!(d.feed(b"usage limit reached\n").is_empty());
    }

    #[test]
    fn reset_rearms_across_episode_without_flushing_8kb() {
        let mut d = LimitDetector::default();
        assert_eq!(d.feed(b"usage limit reached\n"), vec![LimitKind::Window]);
        // A repaint keeps the same phrase present, so it stays suppressed.
        assert!(d.feed(b"usage limit reached\n").is_empty());
        // The orchestrator resets at relaunch; the next genuine limit fires even
        // though the phrase is still identical.
        d.reset();
        assert_eq!(d.feed(b"usage limit reached\n"), vec![LimitKind::Window]);
    }

    #[test]
    fn rearms_after_phrase_scrolls_out_of_tail() {
        let mut d = LimitDetector::default();
        assert_eq!(d.feed(b"usage limit reached\n"), vec![LimitKind::Window]);
        // Push more than TAIL_CAP of unrelated output so the phrase (and any
        // pattern) leaves the window, re-arming the detector.
        let filler = "x ".repeat(TAIL_CAP);
        assert!(d.feed(filler.as_bytes()).is_empty());
        assert_eq!(d.feed(b"usage limit reached\n"), vec![LimitKind::Window]);
    }
}
