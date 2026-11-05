//! Usage data pulled from the daemon for the tray badge itself.
//!
//! The popover page fetches its own data (it shares the daemon origin), so this
//! module only covers what the Rust side needs while the panel is closed: the
//! today totals behind the badge and the background cache warm-up.

use std::time::Duration;

use serde::Deserialize;

use crate::http::ApiClient;

#[derive(Debug, Clone, PartialEq)]
pub struct TodayTotals {
    pub tokens: u64,
    pub cost: f64,
    pub cost_available: bool,
    pub failed_sources: Vec<String>,
}

impl Default for TodayTotals {
    fn default() -> Self {
        Self {
            tokens: 0,
            cost: 0.0,
            cost_available: true,
            failed_sources: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct AgentsResponse {
    available: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DailyResponse {
    daily: Vec<DailyEntry>,
    #[serde(default)]
    source_errors: Vec<SourceError>,
}

#[derive(Debug, Deserialize)]
struct SourceError {
    agent: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DailyEntry {
    date: String,
    total_tokens: u64,
    total_cost: f64,
    cost_available: Option<bool>,
}

/// Day key in the user's local timezone, matching how the web dashboard and the
/// macOS build decide which entry counts as "today".
pub fn today_key() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Sums today's totals across every available agent. Each request forces a
/// refresh: the daemon re-reads only files that changed since the last parse.
pub async fn fetch_today(port: u16) -> Result<TodayTotals, String> {
    let client = ApiClient::new(port, Duration::from_secs(20))?;
    let agents: AgentsResponse = client.get_json("/api/agents").await?;
    let today = today_key();
    let mut results = Vec::new();
    for agent in agents.available {
        let path = format!("/api/daily?agent={agent}&refresh=1");
        results.push((agent, client.get_json::<DailyResponse>(&path).await));
    }
    aggregate_today(&today, results)
}

fn aggregate_today(
    today: &str,
    results: Vec<(String, Result<DailyResponse, String>)>,
) -> Result<TodayTotals, String> {
    let source_count = results.len();
    let mut successes = 0;
    let mut totals = TodayTotals::default();
    for (agent, result) in results {
        match result {
            Ok(response) => {
                successes += 1;
                totals
                    .failed_sources
                    .extend(response.source_errors.into_iter().map(|error| error.agent));
                if let Some(entry) = response.daily.iter().find(|entry| entry.date == today) {
                    totals.tokens += entry.total_tokens;
                    totals.cost += entry.total_cost;
                    totals.cost_available &= entry.cost_available != Some(false);
                }
            }
            Err(error) => {
                eprintln!("[tokendash] Failed to read {agent} usage: {error}");
                totals.failed_sources.push(agent);
            }
        }
    }
    if source_count > 0 && successes == 0 {
        return Err("Failed to read usage from all sources; keeping previous data".to_string());
    }
    totals.failed_sources.sort();
    totals.failed_sources.dedup();
    totals.cost_available &= totals.failed_sources.is_empty();
    Ok(totals)
}

/// Refreshes the detail caches the popover reads on open, so the panel renders
/// with data instead of a spinner after an idle period.
pub async fn warm_detail(port: u16) -> Result<(), String> {
    let client = ApiClient::new(port, Duration::from_secs(60))?;
    let agents: AgentsResponse = client.get_json("/api/agents").await?;
    for agent in agents.available {
        for path in [
            format!("/api/blocks?agent={agent}&granularity=5m&refresh=1"),
            format!("/api/projects?agent={agent}&refresh=1"),
        ] {
            // Best effort per endpoint: one slow agent must not stop the rest.
            // 5m is the granularity the popover's chart base reads, so the cache
            // key the panel hits on open is the one being warmed here; `daily`
            // needs no pass because the badge loop refreshes it every 30s.
            let _ = client.get_json::<serde_json::Value>(&path).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_key_is_iso_shaped() {
        let key = today_key();
        assert_eq!(key.len(), 10);
        assert_eq!(key.matches('-').count(), 2);
    }

    #[test]
    fn daily_entry_reads_camel_case_payload() {
        let parsed: DailyResponse = serde_json::from_str(
            r#"{"daily":[{"date":"2026-10-17","totalTokens":1200,"totalCost":3.5}]}"#,
        )
        .expect("daemon payload parses");
        assert_eq!(parsed.daily[0].total_tokens, 1200);
        assert_eq!(parsed.daily[0].total_cost, 3.5);
        assert_eq!(parsed.daily[0].cost_available, None);
    }

    fn response(json: &str) -> Result<DailyResponse, String> {
        serde_json::from_str(json).map_err(|error| error.to_string())
    }

    #[test]
    fn one_failed_source_preserves_healthy_usage_and_marks_partial() {
        let totals = aggregate_today(
            "2026-11-05",
            vec![
                (
                    "claude".into(),
                    response(
                        r#"{"daily":[{"date":"2026-11-05","totalTokens":1200,"totalCost":3.5}]}"#,
                    ),
                ),
                ("deepseek".into(), Err("missing decoder".into())),
            ],
        )
        .unwrap();
        assert_eq!(totals.tokens, 1200);
        assert_eq!(totals.cost, 3.5);
        assert!(!totals.cost_available);
        assert_eq!(totals.failed_sources, vec!["deepseek"]);
    }

    #[test]
    fn all_failed_is_error_but_empty_sources_is_valid_empty_usage() {
        assert!(aggregate_today(
            "2026-11-05",
            vec![("deepseek".into(), Err("bad log".into()))]
        )
        .is_err());
        assert_eq!(
            aggregate_today("2026-11-05", vec![]).unwrap(),
            TodayTotals::default()
        );
    }

    #[test]
    fn unknown_price_is_not_treated_as_a_complete_zero_cost() {
        let totals = aggregate_today(
            "2026-11-05",
            vec![(
                "deepseek".into(),
                response(r#"{"daily":[{"date":"2026-11-05","totalTokens":900,"totalCost":0,"costAvailable":false}]}"#),
            )],
        )
        .unwrap();
        assert_eq!(totals.tokens, 900);
        assert!(!totals.cost_available);
        assert!(totals.failed_sources.is_empty());
    }
}
