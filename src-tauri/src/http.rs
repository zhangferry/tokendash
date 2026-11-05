//! Minimal HTTP client for the local daemon. The daemon only ever listens on
//! 127.0.0.1 over plain HTTP, so the client is built without TLS features.

use std::time::Duration;

use serde::de::DeserializeOwned;

pub struct ApiClient {
    client: reqwest::Client,
    base: String,
}

impl ApiClient {
    pub fn new(port: u16, timeout: Duration) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            // Local daemon traffic must bypass system HTTP proxy settings.
            .no_proxy()
            .timeout(timeout)
            .build()
            .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
        Ok(Self {
            client,
            base: format!("http://127.0.0.1:{port}"),
        })
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "{path} returned HTTP {}",
                response.status().as_u16()
            ));
        }
        response
            .json::<T>()
            .await
            .map_err(|error| error.to_string())
    }

    /// Returns the status code plus a text body, used by identity probes that
    /// must inspect both the payload and the content type.
    pub async fn get_text(&self, path: &str) -> Result<(u16, String), String> {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|error| error.to_string())?;
        Ok((status, body))
    }
}
