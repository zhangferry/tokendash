//! Coding Plan credentials, written to the cross-process bridge file that the
//! daemon's quota adapters read first (`~/.tokendash/credentials.json`).
//!
//! Linux has no Keychain, so the file is plaintext with `0600` permissions —
//! the same trade-off the macOS build documents for this bridge file.

use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};

use crate::paths;

/// Providers that accept a manually entered API key. Claude and Codex use their
/// own CLI credentials, which the daemon discovers on its own.
pub const EDITABLE_PROVIDERS: [&str; 3] = ["glm", "kimi", "minimax"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredential {
    pub api_key: String,
    /// Omitted when blank so the daemon keeps using the provider's default
    /// endpoint instead of reading an empty base URL.
    #[serde(default, skip_serializing_if = "is_blank")]
    pub base_url: Option<String>,
}

fn is_blank(value: &Option<String>) -> bool {
    value
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
}

pub type CredentialFile = std::collections::BTreeMap<String, ProviderCredential>;

fn read_all() -> Result<CredentialFile, String> {
    match fs::read_to_string(paths::credentials_path()) {
        Ok(raw) => serde_json::from_str::<CredentialFile>(&raw)
            .map_err(|error| format!("Invalid credentials file: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CredentialFile::new()),
        Err(error) => Err(format!("Failed to read credentials file: {error}")),
    }
}

fn write_all(credentials: &CredentialFile) -> Result<(), String> {
    paths::ensure_data_dir()
        .map_err(|error| format!("Failed to create data directory: {error}"))?;
    let path = paths::credentials_path();
    let serialized = serde_json::to_string_pretty(credentials)
        .map_err(|error| format!("Failed to serialize credentials: {error}"))?;
    fs::write(&path, format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write credentials: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to set credentials file permissions: {error}"))?;
    Ok(())
}

/// Saves one provider key, preserving every other entry in the file.
pub fn save_credential(
    provider: &str,
    api_key: &str,
    base_url: Option<String>,
) -> Result<(), String> {
    if !EDITABLE_PROVIDERS.contains(&provider) {
        return Err(format!("Unsupported provider: {provider}"));
    }
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    let mut credentials = read_all()?;
    credentials.insert(
        provider.to_string(),
        ProviderCredential {
            api_key: api_key.trim().to_string(),
            base_url: base_url
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        },
    );
    write_all(&credentials)
}

pub fn delete_credential(provider: &str) -> Result<(), String> {
    let mut credentials = read_all()?;
    if credentials.remove(provider).is_none() {
        return Ok(());
    }
    write_all(&credentials)
}

/// Returns the provider ids that currently have a stored key. The key material
/// itself never leaves this process, the popover only needs presence.
pub fn configured_providers() -> Result<Vec<String>, String> {
    let credentials = read_all()?;
    Ok(credentials
        .iter()
        .filter(|(_, entry)| !entry.api_key.is_empty())
        .map(|(provider, _)| provider.clone())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_round_trip_keeps_other_providers() {
        let mut file = CredentialFile::new();
        file.insert(
            "glm".to_string(),
            ProviderCredential {
                api_key: "glm-key".to_string(),
                base_url: None,
            },
        );
        let serialized = serde_json::to_string(&file).expect("serialize");
        let parsed: CredentialFile = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(parsed["glm"].api_key, "glm-key");
        assert_eq!(parsed["glm"].base_url, None);
    }

    #[test]
    fn blank_key_is_rejected() {
        let error = save_credential("glm", "   ", None).expect_err("blank key must fail");
        assert!(error.contains("cannot be empty"));
    }

    #[test]
    fn unknown_provider_is_rejected() {
        let error = save_credential("nope", "key", None).expect_err("unknown provider must fail");
        assert!(error.contains("Unsupported"));
    }

    #[test]
    fn base_url_is_omitted_when_empty() {
        let entry = ProviderCredential {
            api_key: "k".to_string(),
            base_url: Some(String::new()),
        };
        let value = serde_json::to_value(&entry).expect("serialize");
        assert!(value.get("apiKey").is_some());
        assert!(value.get("baseUrl").is_none());
    }
}
