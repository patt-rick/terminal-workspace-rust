//! Working/idle + bell detection from the raw PTY byte stream, so remote clients
//! learn a terminal is busy without a desktop pane parsing it. Ported from the
//! frontend heuristics (terminal-pane.tsx):
//!
//! - Agent TUIs (Claude Code) report turn activity through the window TITLE:
//!   while working it is prefixed with an animated braille spinner
//!   (U+2800–U+28FF) or the ✳ marker, resetting to a bare "✳ Claude Code" idle.
//! - OSC 9;4 (ConEmu progress) reports busy/idle.
//! - OSC 133 C/D (shell integration) brackets a running command.
//! - A standalone BEL is a bell.
//!
//! The parser is a small escape-sequence state machine that carries partial
//! sequences across chunk boundaries.

#[derive(Debug, PartialEq, Eq)]
pub enum DetectEvent {
    Working(bool),
    Bell,
    /// OSC 133;D carried an exit code — lets the UI distinguish "finished"
    /// from "failed" for plain shell commands.
    CommandDone { exit_code: Option<i32> },
    /// An explicit tool notification: OSC 9;<message> (iTerm2 style) or
    /// OSC 777;notify;<title>;<body>.
    Notify { message: String },
}

#[derive(Default)]
enum State {
    #[default]
    Ground,
    Esc,
    Osc,
    OscEsc,
}

#[derive(Default)]
pub struct ShellDetector {
    state: State,
    osc: Vec<u8>,
    working: bool,
}

// Guard against an unterminated OSC growing without bound.
const OSC_CAP: usize = 8192;

impl ShellDetector {
    /// Current working state (for the prompt-silence sweeper).
    pub fn is_working(&self) -> bool {
        self.working
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<DetectEvent> {
        let mut events = Vec::new();
        for &b in bytes {
            match self.state {
                State::Ground => match b {
                    0x1b => self.state = State::Esc,
                    0x07 => events.push(DetectEvent::Bell),
                    _ => {}
                },
                State::Esc => match b {
                    b']' => {
                        self.state = State::Osc;
                        self.osc.clear();
                    }
                    0x1b => {} // stay in Esc
                    _ => self.state = State::Ground, // CSI and other sequences: ignore
                },
                State::Osc => match b {
                    0x07 => {
                        self.finish_osc(&mut events);
                        self.state = State::Ground;
                    }
                    0x1b => self.state = State::OscEsc,
                    _ => self.push_osc(b),
                },
                State::OscEsc => match b {
                    b'\\' => {
                        self.finish_osc(&mut events);
                        self.state = State::Ground;
                    }
                    0x1b => {} // stay, still waiting for '\'
                    _ => {
                        // Not an ST: the ESC wasn't a terminator; resume the OSC.
                        self.state = State::Osc;
                        self.push_osc(b);
                    }
                },
            }
        }
        events
    }

    fn push_osc(&mut self, b: u8) {
        if self.osc.len() < OSC_CAP {
            self.osc.push(b);
        }
    }

    fn finish_osc(&mut self, events: &mut Vec<DetectEvent>) {
        let payload = std::mem::take(&mut self.osc);
        let s = String::from_utf8_lossy(&payload);
        let (code, rest) = match s.split_once(';') {
            Some((c, r)) => (c, r),
            None => (s.as_ref(), ""),
        };
        match code {
            "0" | "2" => {
                let working = title_indicates_work(rest);
                self.set_working(working, events);
            }
            "9" => {
                if let Some(working) = parse_conemu_progress(rest) {
                    self.set_working(working, events);
                } else if !rest.is_empty() && !rest.starts_with("4;") && rest != "4" {
                    // iTerm2-style plain notification: OSC 9;<message>.
                    events.push(DetectEvent::Notify {
                        message: rest.to_string(),
                    });
                }
            }
            "133" => {
                if rest.starts_with('C') {
                    self.set_working(true, events);
                } else if rest.starts_with('D') {
                    self.set_working(false, events);
                    // OSC 133;D;<exit-code> — surface success/failure.
                    let exit_code = rest[1..]
                        .strip_prefix(';')
                        .and_then(|c| c.split(';').next())
                        .and_then(|c| c.trim().parse::<i32>().ok());
                    events.push(DetectEvent::CommandDone { exit_code });
                }
            }
            "777" => {
                // OSC 777;notify;<title>;<body>
                let mut parts = rest.splitn(3, ';');
                if parts.next() == Some("notify") {
                    let title = parts.next().unwrap_or("");
                    let body = parts.next().unwrap_or("");
                    let message = if body.is_empty() {
                        title.to_string()
                    } else {
                        format!("{title}: {body}")
                    };
                    if !message.is_empty() {
                        events.push(DetectEvent::Notify { message });
                    }
                }
            }
            _ => {}
        }
    }

    fn set_working(&mut self, working: bool, events: &mut Vec<DetectEvent>) {
        if working != self.working {
            self.working = working;
            events.push(DetectEvent::Working(working));
        }
    }
}

fn is_braille(c: char) -> bool {
    ('\u{2800}'..='\u{28ff}').contains(&c)
}

/// Whether a window title indicates the agent is mid-task (see module docs).
fn title_indicates_work(title: &str) -> bool {
    let t = title.trim_start();
    let Some(first) = t.chars().next() else {
        return false;
    };
    if is_braille(first) {
        return true;
    }
    if first != '✳' {
        return false;
    }
    let task = t
        .trim_start_matches(|c: char| c == '✳' || is_braille(c) || c.is_whitespace())
        .trim();
    !task.is_empty() && !task.to_lowercase().starts_with("claude code")
}

/// OSC 9;4;<state>;<progress> — states 1/3/4 busy, 0/2 idle. `rest` is the text
/// after "9;" (i.e. starts with "4;").
fn parse_conemu_progress(rest: &str) -> Option<bool> {
    if !rest.starts_with("4;") {
        return None;
    }
    match rest.as_bytes().get(2) {
        Some(b'0') | Some(b'2') => Some(false),
        Some(b'1') | Some(b'3') | Some(b'4') => Some(true),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn osc(payload: &str) -> Vec<u8> {
        let mut v = vec![0x1b, b']'];
        v.extend_from_slice(payload.as_bytes());
        v.push(0x07); // BEL terminator
        v
    }

    #[test]
    fn braille_title_marks_working_then_idle() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed(&osc("2;\u{2809} Claude Code")), vec![DetectEvent::Working(true)]);
        // repeated working title is not re-emitted
        assert_eq!(d.feed(&osc("2;\u{280b} Claude Code")), vec![]);
        // back to the bare idle title
        assert_eq!(d.feed(&osc("2;✳ Claude Code")), vec![DetectEvent::Working(false)]);
    }

    #[test]
    fn marker_title_with_task_is_working() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed(&osc("2;✳ Compiling…")), vec![DetectEvent::Working(true)]);
    }

    #[test]
    fn plain_title_is_idle() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed(&osc("0;bash")), vec![]);
    }

    #[test]
    fn osc9_progress_toggles_working() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed(&osc("9;4;1;50")), vec![DetectEvent::Working(true)]);
        assert_eq!(d.feed(&osc("9;4;0")), vec![DetectEvent::Working(false)]);
    }

    #[test]
    fn osc133_brackets_command() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed(&osc("133;C")), vec![DetectEvent::Working(true)]);
        assert_eq!(
            d.feed(&osc("133;D;0")),
            vec![
                DetectEvent::Working(false),
                DetectEvent::CommandDone { exit_code: Some(0) }
            ]
        );
    }

    #[test]
    fn osc133_done_reports_failure_code_and_absent_code() {
        let mut d = ShellDetector::default();
        d.feed(&osc("133;C"));
        assert_eq!(
            d.feed(&osc("133;D;127")),
            vec![
                DetectEvent::Working(false),
                DetectEvent::CommandDone {
                    exit_code: Some(127)
                }
            ]
        );
        // No code at all.
        d.feed(&osc("133;C"));
        assert_eq!(
            d.feed(&osc("133;D")),
            vec![
                DetectEvent::Working(false),
                DetectEvent::CommandDone { exit_code: None }
            ]
        );
    }

    #[test]
    fn osc9_plain_message_is_a_notification_but_progress_is_not() {
        let mut d = ShellDetector::default();
        assert_eq!(
            d.feed(&osc("9;Build finished!")),
            vec![DetectEvent::Notify {
                message: "Build finished!".into()
            }]
        );
        // Progress form must not double as a notification.
        assert_eq!(d.feed(&osc("9;4;1;50")), vec![DetectEvent::Working(true)]);
    }

    #[test]
    fn osc777_notify_combines_title_and_body() {
        let mut d = ShellDetector::default();
        assert_eq!(
            d.feed(&osc("777;notify;Deploy;Production is live")),
            vec![DetectEvent::Notify {
                message: "Deploy: Production is live".into()
            }]
        );
        // Non-notify 777 payloads are ignored.
        assert_eq!(d.feed(&osc("777;other;x")), vec![]);
    }

    #[test]
    fn standalone_bell_is_detected_but_osc_bel_terminator_is_not() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed(b"\x07"), vec![DetectEvent::Bell]);
        // The BEL that terminates this OSC must NOT count as a bell.
        assert_eq!(d.feed(&osc("0;title")), vec![]);
    }

    #[test]
    fn sequence_split_across_chunks_is_handled() {
        let mut d = ShellDetector::default();
        assert_eq!(d.feed("\x1b]2;\u{2809} Cla".as_bytes()), vec![]);
        assert_eq!(d.feed("ude Code\x07".as_bytes()), vec![DetectEvent::Working(true)]);
    }

    #[test]
    fn st_terminated_osc_works() {
        // ESC \ terminator instead of BEL
        let mut d = ShellDetector::default();
        let mut seq = vec![0x1b, b']'];
        seq.extend_from_slice("2;\u{2809} x".as_bytes());
        seq.extend_from_slice(&[0x1b, b'\\']);
        assert_eq!(d.feed(&seq), vec![DetectEvent::Working(true)]);
    }
}
