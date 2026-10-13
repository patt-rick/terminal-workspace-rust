//! Parse one line of a Claude Code transcript into its usage numbers.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    /// `"{message.id}:{requestId}"`; None when the line has neither.
    pub key: Option<String>,
    pub model: String,
    pub cwd: Option<String>,
    pub ts_ms: i64,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub output: u64,
    pub fast: bool,
}

#[derive(Deserialize)]
struct RawLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    cwd: Option<String>,
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
struct RawUsage {
    input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation: Option<RawCacheCreation>,
    speed: Option<String>,
}

#[derive(Deserialize)]
struct RawCacheCreation {
    ephemeral_5m_input_tokens: Option<u64>,
    ephemeral_1h_input_tokens: Option<u64>,
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z` → epoch milliseconds.
pub fn parse_ts_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[b.len() - 1] != b'Z'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let frac = s.get(19..s.len() - 1)?;
    let ms = if frac.is_empty() {
        0
    } else {
        let digits = frac.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let mut value = 0i64;
        let mut count = 0;
        for c in digits.bytes().take(3) {
            value = value * 10 + i64::from(c - b'0');
            count += 1;
        }
        while count < 3 {
            value *= 10;
            count += 1;
        }
        value
    };
    Some(days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms)
}

pub fn parse_line(line: &str) -> Option<ParsedLine> {
    if !line.contains("\"usage\"") {
        return None;
    }
    let raw: RawLine = serde_json::from_str(line).ok()?;
    if raw.kind.as_deref() != Some("assistant") {
        return None;
    }
    let message = raw.message?;
    let usage = message.usage?;
    let model = message
        .model
        .filter(|m| !m.is_empty() && m != "<synthetic>")?;
    let ts_ms = parse_ts_ms(raw.timestamp.as_deref()?)?;
    let key = match (message.id.as_deref(), raw.request_id.as_deref()) {
        (None, None) => None,
        (id, request) => Some(format!("{}:{}", id.unwrap_or(""), request.unwrap_or(""))),
    };
    let (cache_write_5m, cache_write_1h) = match usage.cache_creation {
        Some(split) => (
            split.ephemeral_5m_input_tokens.unwrap_or(0),
            split.ephemeral_1h_input_tokens.unwrap_or(0),
        ),
        None => (usage.cache_creation_input_tokens.unwrap_or(0), 0),
    };
    Some(ParsedLine {
        key,
        model,
        cwd: raw.cwd,
        ts_ms,
        input: usage.input_tokens.unwrap_or(0),
        cache_read: usage.cache_read_input_tokens.unwrap_or(0),
        cache_write_5m,
        cache_write_1h,
        output: usage.output_tokens.unwrap_or(0),
        fast: usage.speed.as_deref() == Some("fast"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"parentUuid":"x","isSidechain":false,"requestId":"req_1","type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","cwd":"C:\\repos\\app","sessionId":"s1","message":{"id":"msg_1","model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":300,"cache_read_input_tokens":1000,"output_tokens":218,"cache_creation":{"ephemeral_1h_input_tokens":200,"ephemeral_5m_input_tokens":100},"service_tier":"standard","speed":"standard","fallback_credit":null}}}"#;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_ts_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts_ms("2024-02-29T12:00:00.000Z"), Some(1_709_208_000_000));
        assert_eq!(parse_ts_ms("2026-10-01T15:02:10.985Z"), Some(1_790_866_930_985));
        assert_eq!(parse_ts_ms("2026-10-13T10:34:07.5Z"), Some(1_791_887_647_500));
    }

    #[test]
    fn rejects_malformed_timestamps() {
        assert_eq!(parse_ts_ms(""), None);
        assert_eq!(parse_ts_ms("2026-10-01 15:02:10Z"), None);
        assert_eq!(parse_ts_ms("2026-10-01T15:02:10"), None);
        assert_eq!(parse_ts_ms("2026-13-01T15:02:10Z"), None);
        assert_eq!(parse_ts_ms("2026-10-01T15:02:10.Z"), None);
    }

    #[test]
    fn parses_a_real_shaped_line() {
        let p = parse_line(LINE).unwrap();
        assert_eq!(p.key.as_deref(), Some("msg_1:req_1"));
        assert_eq!(p.model, "claude-opus-5-5");
        assert_eq!(p.cwd.as_deref(), Some(r"C:\repos\app"));
        assert_eq!(p.ts_ms, 1_790_866_930_985);
        assert_eq!(p.input, 2);
        assert_eq!(p.cache_read, 1000);
        assert_eq!(p.cache_write_5m, 100);
        assert_eq!(p.cache_write_1h, 200);
        assert_eq!(p.output, 218);
        assert!(!p.fast);
    }

    #[test]
    fn tolerates_null_and_absent_fields() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"id":"msg_2","model":"claude-opus-5-5","usage":{"input_tokens":5,"output_tokens":null,"speed":null,"cache_creation":null}}}"#;
        let p = parse_line(line).unwrap();
        assert_eq!(p.key.as_deref(), Some("msg_2:"));
        assert_eq!(p.cwd, None);
        assert_eq!((p.input, p.cache_read, p.output), (5, 0, 0));
        assert_eq!((p.cache_write_5m, p.cache_write_1h), (0, 0));
        assert!(!p.fast);
    }

    #[test]
    fn cache_write_without_split_counts_as_five_minute() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","requestId":"r","message":{"model":"claude-opus-5-5","usage":{"cache_creation_input_tokens":70}}}"#;
        let p = parse_line(line).unwrap();
        assert_eq!(p.key.as_deref(), Some(":r"));
        assert_eq!((p.cache_write_5m, p.cache_write_1h), (70, 0));
    }

    #[test]
    fn fast_speed_is_flagged() {
        let line = LINE.replace(r#""speed":"standard""#, r#""speed":"fast""#);
        assert!(parse_line(&line).unwrap().fast);
    }

    #[test]
    fn line_with_neither_id_has_no_key() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1}}}"#;
        assert_eq!(parse_line(line).unwrap().key, None);
    }

    #[test]
    fn rejects_lines_that_are_not_usage() {
        assert!(parse_line("not json \"usage\"").is_none());
        assert!(parse_line(r#"{"type":"user","message":{"content":"hi"}}"#).is_none());
        let user = LINE.replace(r#""type":"assistant""#, r#""type":"user""#);
        assert!(parse_line(&user).is_none());
        let synthetic = LINE.replace("claude-opus-5-5", "<synthetic>");
        assert!(parse_line(&synthetic).is_none());
        let no_ts = LINE.replace(r#""timestamp":"2026-10-01T15:02:10.985Z","#, "");
        assert!(parse_line(&no_ts).is_none());
        let no_usage = r#"{"type":"assistant","timestamp":"2026-10-01T15:02:10.985Z","message":{"id":"m","model":"x","content":"the word \"usage\" appears"}}"#;
        assert!(parse_line(no_usage).is_none());
    }
}
