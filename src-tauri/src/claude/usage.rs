//! Anthropic OAuth usage endpoint: fetch + map to the frontend shape.
//! Endpoint/beta header verified against Agent-Orchestrator's
//! auth-usage-fetcher.ts.

use serde::Serialize;
use serde_json::Value;

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    /// 0-100 (may exceed 100 when over quota)
    pub utilization: f64,
    /// ISO timestamp, when known
    pub resets_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraUsage {
    pub is_enabled: Option<bool>,
    /// dollars (API reports cents)
    pub monthly_limit: Option<f64>,
    pub used_credits: Option<f64>,
    pub utilization: Option<f64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub five_hour: Option<UsageBucket>,
    pub seven_day: Option<UsageBucket>,
    pub extra_usage: Option<ExtraUsage>,
    pub fetched_at: i64,
}

/// Per-account entry in the usage rollup returned to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account_id: String,
    pub usage: Option<ClaudeUsage>,
    pub error: Option<String>,
}

fn map_bucket(v: Option<&Value>) -> Option<UsageBucket> {
    let b = v?;
    if b.is_null() {
        return None;
    }
    Some(UsageBucket {
        utilization: b.get("utilization")?.as_f64()?,
        resets_at: b
            .get("resets_at")
            .and_then(|r| r.as_str())
            .map(str::to_string),
    })
}

/// Map the raw usage response. Absent/null buckets map to None without
/// failing the rest (the live API emits explicit nulls for unprovisioned
/// blocks). Cents fields become dollars.
pub fn map_usage_response(v: &Value, now_ms: i64) -> ClaudeUsage {
    let extra = v
        .get("extra_usage")
        .filter(|e| !e.is_null())
        .map(|e| ExtraUsage {
            is_enabled: e.get("is_enabled").and_then(|x| x.as_bool()),
            monthly_limit: e
                .get("monthly_limit")
                .and_then(|x| x.as_f64())
                .map(|c| c / 100.0),
            used_credits: e
                .get("used_credits")
                .and_then(|x| x.as_f64())
                .map(|c| c / 100.0),
            utilization: e.get("utilization").and_then(|x| x.as_f64()),
        });
    ClaudeUsage {
        five_hour: map_bucket(v.get("five_hour")),
        seven_day: map_bucket(v.get("seven_day")),
        extra_usage: extra,
        fetched_at: now_ms,
    }
}

/// Raw usage fetch. 401 is surfaced distinctly so the caller can refresh
/// the token once and retry.
pub enum UsageFetch {
    Ok(Value),
    AuthFailed,
    Err(String),
}

pub async fn fetch_usage_raw(client: &reqwest::Client, access_token: &str) -> UsageFetch {
    let resp = client
        .get(USAGE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", OAUTH_BETA_HEADER)
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return UsageFetch::Err(e.to_string()),
    };
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return UsageFetch::AuthFailed;
    }
    if !status.is_success() {
        return UsageFetch::Err(format!("HTTP {status}"));
    }
    match resp.json::<Value>().await {
        Ok(v) => UsageFetch::Ok(v),
        Err(e) => UsageFetch::Err(format!("invalid usage response: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_buckets_and_converts_cents() {
        let v: Value = serde_json::from_str(
            r#"{
                "five_hour": {"utilization": 42.5, "resets_at": "2026-07-09T18:00:00Z"},
                "seven_day": {"utilization": 91.0, "resets_at": null},
                "extra_usage": {"is_enabled": true, "monthly_limit": 2500, "used_credits": 125, "utilization": 5.0}
            }"#,
        )
        .unwrap();
        let u = map_usage_response(&v, 777);
        assert_eq!(u.fetched_at, 777);
        let fh = u.five_hour.unwrap();
        assert_eq!(fh.utilization, 42.5);
        assert_eq!(fh.resets_at.as_deref(), Some("2026-07-09T18:00:00Z"));
        assert_eq!(u.seven_day.unwrap().resets_at, None);
        let ex = u.extra_usage.unwrap();
        assert_eq!(ex.monthly_limit, Some(25.0)); // cents -> dollars
        assert_eq!(ex.used_credits, Some(1.25));
    }

    #[test]
    fn null_and_missing_blocks_map_to_none() {
        let v: Value =
            serde_json::from_str(r#"{"five_hour": null, "extra_usage": null}"#).unwrap();
        let u = map_usage_response(&v, 1);
        assert!(u.five_hour.is_none());
        assert!(u.seven_day.is_none());
        assert!(u.extra_usage.is_none());

        // A bucket missing `utilization` maps to None rather than panicking.
        let v2: Value = serde_json::from_str(r#"{"five_hour": {"resets_at": "x"}}"#).unwrap();
        assert!(map_usage_response(&v2, 1).five_hour.is_none());
    }
}
