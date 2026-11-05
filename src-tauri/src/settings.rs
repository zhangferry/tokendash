//! Desktop-only preferences. Kept in the daemon's data directory so one file
//! describes the whole desktop experience and survives reinstalls.

use std::fs;
#[cfg(not(windows))]
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths;

/// Cadences mirror the macOS `RefreshInterval` cases so both platform builds
/// offer the same choices.
pub const REFRESH_CHOICES_SECS: [u64; 3] = [600, 1_800, 3_600];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    /// Background detail warm-up cadence while the popover is closed (seconds).
    pub background_refresh_secs: u64,
    /// `system` | `light` | `dark`
    pub appearance: String,
    /// `1d` | `3h` | `15m`
    pub hourly_range: String,
    pub launch_at_login: bool,
    pub low_quota_notifications: bool,
    pub low_quota_threshold_percent: u32,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            background_refresh_secs: 3_600,
            appearance: "system".to_string(),
            hourly_range: "1d".to_string(),
            launch_at_login: false,
            low_quota_notifications: true,
            low_quota_threshold_percent: 80,
        }
    }
}

impl DesktopSettings {
    /// Clamps every field to a value the app can act on. Settings arrive from
    /// the webview, so nothing is trusted as-is.
    pub fn normalized(mut self) -> Self {
        if !REFRESH_CHOICES_SECS.contains(&self.background_refresh_secs) {
            self.background_refresh_secs = DesktopSettings::default().background_refresh_secs;
        }
        if !["system", "light", "dark"].contains(&self.appearance.as_str()) {
            self.appearance = "system".to_string();
        }
        if !["1d", "3h", "15m"].contains(&self.hourly_range.as_str()) {
            self.hourly_range = "1d".to_string();
        }
        self.low_quota_threshold_percent = self.low_quota_threshold_percent.clamp(1, 100);
        self
    }
}

pub fn load() -> DesktopSettings {
    let Ok(raw) = fs::read_to_string(paths::settings_path()) else {
        return DesktopSettings::default();
    };
    serde_json::from_str::<DesktopSettings>(&raw)
        .map(DesktopSettings::normalized)
        .unwrap_or_default()
}

pub fn save(settings: &DesktopSettings) -> Result<DesktopSettings, String> {
    let normalized = settings.clone().normalized();
    paths::ensure_data_dir()
        .map_err(|error| format!("Failed to create data directory: {error}"))?;
    let serialized = serde_json::to_string_pretty(&normalized)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(paths::settings_path(), format!("{serialized}\n"))
        .map_err(|error| format!("Failed to write settings: {error}"))?;
    Ok(normalized)
}

// ---------------------------------------------------------------------------
// Launch at login (XDG autostart)
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
fn autostart_path() -> PathBuf {
    paths::home_dir()
        .join(".config")
        .join("autostart")
        .join("tokendash.desktop")
}

/// The executable to relaunch. AppImages run from a temporary mount, so the
/// original `$APPIMAGE` path has to win over the process path.
pub fn launch_exec() -> String {
    #[cfg(not(windows))]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return appimage.to_string_lossy().into_owned();
    }
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "tokendash-desktop".to_string())
}

/// Desktop entries decode string escapes before parsing Exec quoting. Escape
/// each layer separately so the executable remains one literal argument.
/// https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html
#[cfg(any(not(windows), test))]
fn quote_desktop_exec(executable: &str) -> Result<String, String> {
    if executable.contains(['=', '\0']) {
        return Err(
            "The launch-at-login path cannot contain an equals sign or NUL character".to_string(),
        );
    }
    let mut quoted = String::from("\"");
    for character in executable.chars() {
        match character {
            '\"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(character),
        }
    }
    quoted.push('\"');
    Ok(quoted
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t"))
}

#[cfg(not(windows))]
pub fn apply_autostart(enabled: bool) -> Result<(), String> {
    let path = autostart_path();
    if enabled {
        let executable = quote_desktop_exec(&launch_exec())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create launch-at-login directory: {error}"))?;
        }
        let entry = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=TokenDash\n\
             Comment=AI coding token usage in the system tray\n\
             Exec={}\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n",
            executable
        );
        fs::write(&path, entry)
            .map_err(|error| format!("Failed to write launch-at-login file: {error}"))?;
        return Ok(());
    }
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove launch-at-login file: {error}")),
    }
}

#[cfg(not(windows))]
pub fn is_autostart_enabled() -> bool {
    autostart_path().exists()
}

/// Run values are command lines, not shell expressions; quote exactly one
/// executable and reject values Windows cannot represent safely.
#[cfg(any(windows, test))]
fn windows_run_value(executable: &str) -> Result<String, String> {
    if executable.contains(['"', '\0', '\r', '\n']) || executable.encode_utf16().count() + 2 > 260 {
        return Err(
            "The Windows launch-at-login path is invalid or exceeds 260 characters".to_string(),
        );
    }
    Ok(format!("\"{executable}\""))
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
pub fn apply_autostart(enabled: bool) -> Result<(), String> {
    if !enabled && !is_autostart_enabled() {
        return Ok(());
    }
    let mut command = paths::command("reg.exe");
    if enabled {
        command.args([
            "add",
            RUN_KEY,
            "/v",
            "TokenDash",
            "/t",
            "REG_SZ",
            "/d",
            &windows_run_value(&launch_exec())?,
            "/f",
        ]);
    } else {
        command.args(["delete", RUN_KEY, "/v", "TokenDash", "/f"]);
    }
    let result = command
        .output()
        .map_err(|error| format!("Failed to update Windows launch-at-login settings: {error}"))?;
    if !result.status.success() {
        return Err("Failed to update Windows launch-at-login settings".to_string());
    }
    Ok(())
}

#[cfg(windows)]
pub fn is_autostart_enabled() -> bool {
    paths::command("reg.exe")
        .args(["query", RUN_KEY, "/v", "TokenDash"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_run_command_preserves_spaces_unicode_and_shell_characters() {
        assert_eq!(
            windows_run_value(r"C:\Users\用户\My Apps & Tools\TokenDash.exe").unwrap(),
            r#""C:\Users\用户\My Apps & Tools\TokenDash.exe""#
        );
        assert!(windows_run_value("bad\"name.exe").is_err());
        assert!(windows_run_value("a\0b").is_err());
        assert!(windows_run_value(&"x".repeat(259)).is_err());
    }

    #[test]
    fn desktop_exec_quotes_paths_with_spaces_and_reserved_characters() {
        assert_eq!(
            quote_desktop_exec("/home/user/My Apps/TokenDash's (stable);&.AppImage").unwrap(),
            "\"/home/user/My Apps/TokenDash's (stable);&.AppImage\""
        );
    }

    #[test]
    fn desktop_exec_escapes_both_parsing_layers_and_field_codes() {
        assert_eq!(
            quote_desktop_exec(r#"/tmp/a"b$c`d\e%f.AppImage"#).unwrap(),
            r#""/tmp/a\\"b\\$c\\`d\\\\e%%f.AppImage""#
        );
        assert_eq!(
            quote_desktop_exec("/tmp/a\nb\tc").unwrap(),
            r#""/tmp/a\nb\tc""#
        );
    }

    #[test]
    fn desktop_exec_rejects_invalid_executable_names() {
        assert!(quote_desktop_exec("/tmp/a=b.AppImage").is_err());
        assert!(quote_desktop_exec("/tmp/a\0b.AppImage").is_err());
    }

    #[test]
    fn normalization_rejects_unknown_choices() {
        let settings = DesktopSettings {
            background_refresh_secs: 7,
            appearance: "neon".to_string(),
            hourly_range: "99h".to_string(),
            launch_at_login: true,
            low_quota_notifications: false,
            low_quota_threshold_percent: 0,
        }
        .normalized();

        assert_eq!(settings.background_refresh_secs, 3_600);
        assert_eq!(settings.appearance, "system");
        assert_eq!(settings.hourly_range, "1d");
        assert_eq!(settings.low_quota_threshold_percent, 1);
        assert!(settings.launch_at_login);
    }

    #[test]
    fn defaults_match_the_macos_build() {
        let defaults = DesktopSettings::default();
        assert_eq!(defaults.background_refresh_secs, 3_600);
        assert_eq!(defaults.hourly_range, "1d");
        assert!(defaults.low_quota_notifications);
        assert_eq!(defaults.low_quota_threshold_percent, 80);
        assert!(!defaults.launch_at_login);
    }

    #[test]
    fn unknown_fields_fall_back_per_field() {
        let parsed: DesktopSettings =
            serde_json::from_str(r#"{"appearance":"dark"}"#).expect("partial settings parse");
        assert_eq!(parsed.appearance, "dark");
        assert_eq!(parsed.background_refresh_secs, 3_600);
    }
}
