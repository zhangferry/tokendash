//! Node daemon lifecycle: identity-checked port discovery, cold start, health
//! monitoring and shutdown.
//!
//! The daemon owns `~/.tokendash/daemon.port` and `~/.tokendash/daemon.pid`.
//! Those files are only hints: another local service could have taken the port,
//! so a daemon is trusted only after its HTTP identity (`/api/app-info` package
//! name) and its dashboard entrypoint both answer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::http::ApiClient;
use crate::paths;

pub const DEFAULT_PORT: u16 = 3456;
/// Same scan range the macOS build uses to reattach to a daemon that fell back
/// from 3456 to a higher port.
pub const DISCOVERY_PORTS: std::ops::Range<u16> = 3456..3476;
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const EXPECTED_PACKAGE_NAME: &str = "@zhangferry-dev/tokendash";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonProbe {
    Compatible,
    VersionMismatch,
    UnavailableOrForeign,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    package_name: String,
    version: String,
}

pub struct DaemonState {
    port: Mutex<Option<u16>>,
    child: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
    app_version: String,
    daemon_script: PathBuf,
    /// False when the script could not be located at all; the popover reports
    /// this instead of waiting forever for a daemon that cannot start.
    script_found: bool,
    node_path: Option<PathBuf>,
}

impl DaemonState {
    pub fn new(
        app_version: String,
        daemon_script: PathBuf,
        script_found: bool,
        node_path: Option<PathBuf>,
    ) -> Self {
        Self {
            port: Mutex::new(None),
            child: Mutex::new(None),
            error: Mutex::new(None),
            app_version,
            daemon_script,
            script_found,
            node_path,
        }
    }

    pub fn port(&self) -> Option<u16> {
        *self.port.lock().expect("daemon port lock poisoned")
    }

    pub fn error(&self) -> Option<String> {
        self.error
            .lock()
            .expect("daemon error lock poisoned")
            .clone()
    }

    fn set_error(&self, message: Option<String>) {
        *self.error.lock().expect("daemon error lock poisoned") = message;
    }

    fn set_port(&self, port: Option<u16>) {
        *self.port.lock().expect("daemon port lock poisoned") = port;
    }
}

// ---------------------------------------------------------------------------
// Discovery + start
// ---------------------------------------------------------------------------

/// Returns a listening daemon port, starting the daemon when none is reachable.
pub async fn ensure_started(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<DaemonState>();
    if let Some(port) = state.port() {
        if probe(port, &state.app_version).await == DaemonProbe::Compatible {
            return Ok(port);
        }
        state.set_port(None);
    }

    if !state.script_found {
        let message = "The bundled server script was not found. Reinstall TokenDash.".to_string();
        state.set_error(Some(message.clone()));
        return Err(message);
    }

    // A daemon may already run from a previous app launch or from `npm run dev`.
    if let Some(port) = read_port_file() {
        match probe(port, &state.app_version).await {
            DaemonProbe::Compatible => {
                state.set_port(Some(port));
                state.set_error(None);
                return Ok(port);
            }
            DaemonProbe::VersionMismatch => cleanup_incompatible_daemon(),
            DaemonProbe::UnavailableOrForeign => cleanup_files(),
        }
    }
    if let Some(port) = discover_compatible_port(&state.app_version).await {
        state.set_port(Some(port));
        state.set_error(None);
        let _ = paths::write_number(&paths::port_path(), port as u32);
        return Ok(port);
    }

    let Some(node) = state.node_path.clone() else {
        let message =
            "A supported Node.js 20.10 or later runtime was not found. Check TOKENDASH_NODE or install Node.js, then reopen TokenDash.".to_string();
        state.set_error(Some(message.clone()));
        return Err(message);
    };

    cleanup_files();
    paths::ensure_data_dir()
        .map_err(|error| format!("Failed to create data directory: {error}"))?;

    // Preserve startup failures from the headless GUI launch. Recreate this
    // small log per attempt so repeated restarts cannot grow it indefinitely.
    let mut log = fs::File::create(paths::data_dir().join("daemon.log"))
        .map_err(|error| format!("Failed to create server log: {error}"))?;
    let _ = writeln!(
        log,
        "node={}\nscript={}",
        node.display(),
        state.daemon_script.display()
    );
    let mut child = paths::command(&node)
        .arg(&state.daemon_script)
        .args(["--port", &DEFAULT_PORT.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|error| format!("Failed to start local server: {error}"))?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(port) = read_port_file() {
            if probe(port, &state.app_version).await == DaemonProbe::Compatible {
                *state.child.lock().expect("daemon child lock poisoned") = Some(child);
                state.set_port(Some(port));
                state.set_error(None);
                return Ok(port);
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let message = format!("The local server exited early (exit status {status}).");
                state.set_error(Some(message.clone()));
                cleanup_files();
                return Err(message);
            }
            Ok(None) => {}
            Err(error) => {
                let message = format!("Failed to check local server status: {error}");
                state.set_error(Some(message.clone()));
                return Err(message);
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    terminate_child(&mut child);
    cleanup_files();
    let message = "The local server did not become ready within 15 seconds.".to_string();
    state.set_error(Some(message.clone()));
    Err(message)
}

/// Cheap liveness check for the health monitor: the process we spawned is
/// running, or the pid file names a live process.
pub fn is_alive(app: &AppHandle) -> bool {
    let state = app.state::<DaemonState>();
    if let Some(child) = state
        .child
        .lock()
        .expect("daemon child lock poisoned")
        .as_mut()
    {
        if matches!(child.try_wait(), Ok(None)) {
            return true;
        }
    }
    read_pid_file()
        .map(paths::is_process_alive)
        .unwrap_or(false)
}

/// Network-level liveness, used where a pid file can lag the real listener.
pub async fn is_alive_via_probe(app: &AppHandle) -> bool {
    let state = app.state::<DaemonState>();
    match state.port() {
        Some(port) => probe(port, &state.app_version).await == DaemonProbe::Compatible,
        None => false,
    }
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<DaemonState>();
    if let Some(mut child) = state
        .child
        .lock()
        .expect("daemon child lock poisoned")
        .take()
    {
        terminate_child(&mut child);
    }
    if let Some(pid) = read_pid_file() {
        if is_tokendash_daemon_process(pid) {
            terminate_pid(pid);
        }
    }
    state.set_port(None);
    cleanup_files();
}

pub async fn probe(port: u16, app_version: &str) -> DaemonProbe {
    let Ok(client) = ApiClient::new(port, PROBE_TIMEOUT) else {
        return DaemonProbe::UnavailableOrForeign;
    };
    let Ok(info) = client.get_json::<AppInfo>("/api/app-info").await else {
        return DaemonProbe::UnavailableOrForeign;
    };
    if info.package_name != EXPECTED_PACKAGE_NAME {
        return DaemonProbe::UnavailableOrForeign;
    }
    let expected = normalize_version(app_version);
    if expected != "dev" && normalize_version(&info.version) != expected {
        return DaemonProbe::VersionMismatch;
    }
    // A development API server answers with the same identity but serves no
    // built web client (the Vite dev server owns `/`), so a debug build adopts
    // it. A packaged build must own both the API and the dashboard, otherwise
    // the Dashboard button would land on a 404 from a foreign local service.
    if cfg!(debug_assertions) || dashboard_available(port).await {
        DaemonProbe::Compatible
    } else {
        DaemonProbe::UnavailableOrForeign
    }
}

async fn dashboard_available(port: u16) -> bool {
    let Ok(client) = ApiClient::new(port, PROBE_TIMEOUT) else {
        return false;
    };
    match client.get_text("/").await {
        Ok((status, body)) => status == 200 && body.to_ascii_lowercase().contains("<html"),
        Err(_) => false,
    }
}

async fn discover_compatible_port(app_version: &str) -> Option<u16> {
    for port in DISCOVERY_PORTS {
        if probe(port, app_version).await == DaemonProbe::Compatible {
            return Some(port);
        }
    }
    None
}

fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches('v').to_string()
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

fn read_port_file() -> Option<u16> {
    paths::read_number(&paths::port_path()).and_then(|port| u16::try_from(port).ok())
}

fn read_pid_file() -> Option<u32> {
    paths::read_number(&paths::pid_path())
}

fn cleanup_files() {
    let _ = fs::remove_file(paths::pid_path());
    let _ = fs::remove_file(paths::port_path());
}

/// A stale pid may already belong to an unrelated process. Only signal it when
/// both the API identity and the process command line point at TokenDash.
fn cleanup_incompatible_daemon() {
    if let Some(pid) = read_pid_file() {
        if paths::is_process_alive(pid) && is_tokendash_daemon_process(pid) {
            terminate_pid(pid);
        }
    }
    cleanup_files();
}

fn is_tokendash_daemon_process(pid: u32) -> bool {
    #[cfg(windows)]
    let result = paths::command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"),
        ])
        .output();
    #[cfg(not(windows))]
    let result = paths::command("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = result else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    command.contains("daemon.cjs")
}

fn terminate_child(child: &mut Child) {
    #[cfg(windows)]
    {
        terminate_pid(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(not(windows))]
    terminate_unix_child(child);
}

#[cfg(not(windows))]
fn terminate_unix_child(child: &mut Child) {
    let _ = paths::command("kill")
        .args(["-TERM", &child.id().to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        // /T includes parser workers; graceful Unix signals do not exist on
        // Windows. taskkill is only used for our child or an identity checked pid.
        let _ = paths::command("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    terminate_unix_pid(pid);
}

#[cfg(not(windows))]
fn terminate_unix_pid(pid: u32) {
    let _ = paths::command("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !paths::is_process_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = paths::command("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

// ---------------------------------------------------------------------------
// Executable + script resolution
// ---------------------------------------------------------------------------

/// Locates the Node.js binary. A GUI launch inherits a minimal `PATH`, so the
/// version managers are scanned directly instead of relying on the shell.
pub fn find_node() -> Option<PathBuf> {
    let explicit = std::env::var_os("TOKENDASH_NODE").map(PathBuf::from);

    let home = paths::home_dir();
    #[cfg(not(windows))]
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
        PathBuf::from("/snap/bin/node"),
        home.join(".local/bin/node"),
        home.join(".volta/bin/node"),
        home.join("bin/node"),
    ];

    #[cfg(windows)]
    let mut candidates =
        windows_node_candidates(&home, |name| std::env::var_os(name).map(PathBuf::from));

    #[cfg(not(windows))]
    for base in [
        home.join(".nvm").join("versions").join("node"),
        home.join(".local")
            .join("share")
            .join("fnm")
            .join("node-versions"),
        home.join(".asdf").join("installs").join("nodejs"),
    ] {
        if let Some(latest) = latest_version_dir(&base) {
            candidates.push(latest.join("bin").join("node"));
            candidates.push(latest.join("installation").join("bin").join("node"));
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push(directory.join(if cfg!(windows) { "node.exe" } else { "node" }));
        }
    }

    select_node(explicit, candidates, supports_node_runtime)
}

/// Windows GUI launches cannot assume a shell has initialized nvm/fnm/Volta.
/// Paths are assembled without invoking cmd.exe, preserving spaces and Unicode.
#[cfg(any(windows, test))]
fn windows_node_candidates(home: &Path, env: impl Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["NVM_SYMLINK", "VOLTA_HOME"] {
        if let Some(base) = env(key) {
            candidates.push(base.join(if key == "VOLTA_HOME" {
                "bin/node.exe"
            } else {
                "node.exe"
            }));
        }
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = env(key) {
            candidates.push(base.join("nodejs/node.exe"));
        }
    }
    candidates.push(home.join(".volta/bin/node.exe"));
    let mut managed = vec![home.join(".nvm"), home.join(".fnm/node-versions")];
    if let Some(base) = env("NVM_HOME") {
        managed.push(base);
    }
    if let Some(base) = env("FNM_DIR") {
        managed.push(base.join("node-versions"));
    }
    if let Some(base) = env("APPDATA") {
        managed.push(base.join("nvm"));
    }
    if let Some(base) = env("LOCALAPPDATA") {
        candidates.push(base.join("Volta/bin/node.exe"));
        managed.push(base.join("fnm/node-versions"));
        managed.push(base.join("fnm_multishells"));
    }
    for base in managed {
        // Try every installed version, newest first: the newest folder can be
        // incomplete while another installed runtime remains usable.
        for version in version_dirs(&base) {
            candidates.push(version.join("node.exe"));
            candidates.push(version.join("installation/node.exe"));
        }
    }
    candidates
}

fn select_node(
    explicit: Option<PathBuf>,
    candidates: Vec<PathBuf>,
    supports: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    // An explicit override is authoritative: fail rather than silently choosing
    // a different runtime when the requested binary is missing or too old.
    if let Some(candidate) = explicit {
        return supports(&candidate).then_some(candidate);
    }
    candidates.into_iter().find(|candidate| supports(candidate))
}

fn supports_node_runtime(candidate: &Path) -> bool {
    if !is_executable(candidate) {
        return false;
    }
    let Ok(output) = paths::command(candidate).arg("--version").output() else {
        return false;
    };
    output.status.success() && supported_node_version(&String::from_utf8_lossy(&output.stdout))
}

fn supported_node_version(version: &str) -> bool {
    let Some(version) = version.trim().strip_prefix('v') else {
        return false;
    };
    let parts: Vec<u64> = match version.split('.').map(str::parse).collect() {
        Ok(parts) => parts,
        Err(_) => return false,
    };
    match parts.as_slice() {
        [major, minor, patch] => (*major, *minor, *patch) >= (20, 10, 0),
        _ => false,
    }
}

/// Highest version directory below `base` (e.g. `v22.11.0`), so an nvm user gets
/// the newest installed runtime instead of an arbitrary one.
#[cfg(not(windows))]
fn latest_version_dir(base: &Path) -> Option<PathBuf> {
    version_dirs(base).into_iter().next()
}

fn version_dirs(base: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<(Vec<u64>, PathBuf)> = fs::read_dir(base)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            (
                numeric_parts(&entry.file_name().to_string_lossy()),
                entry.path(),
            )
        })
        .collect();
    entries.sort_by(|left, right| right.0.cmp(&left.0));
    entries.into_iter().map(|(_, path)| path).collect()
}

fn numeric_parts(name: &str) -> Vec<u64> {
    name.split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Resolves `dist/daemon.cjs`: bundled resources in a packaged build, the repo
/// `dist/` directory when running from a source checkout.
pub fn find_daemon_script(app: &AppHandle) -> (PathBuf, bool) {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("server").join("dist").join("daemon.cjs");
        if packaged.is_file() {
            return (node_script_path(&packaged), true);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        let mut directory = executable.parent().map(Path::to_path_buf);
        // Walk up from target/debug (or target/release) towards the repo root.
        for _ in 0..6 {
            let Some(current) = directory else { break };
            candidates.push(current.join("dist").join("daemon.cjs"));
            directory = current.parent().map(Path::to_path_buf);
        }
    }
    // `cargo test` runs from `src-tauri/`; the build script keeps this path
    // valid for developer builds without hard-coding a machine location.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("dist")
            .join("daemon.cjs"),
    );

    for candidate in &candidates {
        if candidate.is_file() {
            return (canonicalize_lossy(candidate), true);
        }
    }
    (
        candidates
            .into_iter()
            .next()
            .unwrap_or_else(|| PathBuf::from("dist/daemon.cjs")),
        false,
    )
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    node_script_path(&canonical)
}

/// Tauri canonicalizes its Windows resource directory to a verbatim path.
/// Node resolves module filenames to ordinary drive/UNC paths; passing the
/// verbatim spelling can make an argv-vs-module entrypoint check disagree.
fn node_script_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(value) = path.to_str() {
        return PathBuf::from(normalize_windows_script_path(value));
    }
    path.to_path_buf()
}

#[cfg(any(windows, test))]
fn normalize_windows_script_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

pub fn record_startup_error(message: &str) {
    if paths::ensure_data_dir().is_ok() {
        let _ = fs::write(paths::data_dir().join("desktop-status.log"), message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_managers_try_each_installed_version_newest_first() {
        let root = std::env::temp_dir().join(format!(
            "tokendash-node-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let nvm = root.join("nvm");
        fs::create_dir_all(nvm.join("v9.0.0")).unwrap();
        fs::create_dir_all(nvm.join("v22.0.0")).unwrap();
        fs::create_dir_all(nvm.join("v24.0.0")).unwrap();
        let paths = windows_node_candidates(&root, |key| (key == "NVM_HOME").then(|| nvm.clone()));
        let selected = select_node(None, paths, |path| path == nvm.join("v22.0.0/node.exe"));
        assert_eq!(selected, Some(nvm.join("v22.0.0/node.exe")));
        assert_eq!(version_dirs(&nvm)[0], nvm.join("v24.0.0"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn windows_discovery_includes_standard_and_managed_installs() {
        let paths = windows_node_candidates(Path::new("profile"), |key| match key {
            "ProgramFiles" => Some(PathBuf::from("program-files")),
            "NVM_SYMLINK" => Some(PathBuf::from("nvm-current")),
            "LOCALAPPDATA" => Some(PathBuf::from("local-app-data")),
            _ => None,
        });
        assert!(paths.contains(&PathBuf::from("program-files/nodejs/node.exe")));
        assert!(paths.contains(&PathBuf::from("nvm-current/node.exe")));
        assert!(paths.contains(&PathBuf::from("local-app-data/Volta/bin/node.exe")));
        assert!(paths.contains(&PathBuf::from("profile/.volta/bin/node.exe")));
    }

    #[test]
    fn windows_script_paths_match_node_module_filename_spelling() {
        assert_eq!(
            normalize_windows_script_path(r"\\?\C:\Users\用户\My Apps\server\dist\daemon.cjs"),
            r"C:\Users\用户\My Apps\server\dist\daemon.cjs"
        );
        assert_eq!(
            normalize_windows_script_path(r"\\?\UNC\server\share\daemon.cjs"),
            r"\\server\share\daemon.cjs"
        );
        assert_eq!(
            normalize_windows_script_path(r"C:\Apps\daemon.cjs"),
            r"C:\Apps\daemon.cjs"
        );
    }

    #[test]
    fn version_normalization_ignores_the_v_prefix() {
        assert_eq!(normalize_version("v1.9.1"), "1.9.1");
        assert_eq!(normalize_version(" 1.9.1 "), "1.9.1");
    }

    #[test]
    fn numeric_parts_orders_versions() {
        assert_eq!(numeric_parts("v22.11.0"), vec![22, 11, 0]);
        assert_eq!(numeric_parts("v9.0.0"), vec![9, 0, 0]);
        assert!(numeric_parts("v22.11.0") > numeric_parts("v9.0.0"));
    }

    #[test]
    fn node_runtime_requires_at_least_node_twenty_ten() {
        for version in ["v20.10.0", "v21.0.0", "v22.11.0\n", "v24.1.0"] {
            assert!(supported_node_version(version));
        }
        for version in [
            "v18.20.0",
            "v19.9.0",
            "v20.0.0",
            "v20.9.9",
            "",
            "node 22",
            "vunknown",
            "v22",
            "v22.0.0.junk",
            "v22.0.junk",
        ] {
            assert!(!supported_node_version(version));
        }
    }

    #[test]
    fn node_selection_skips_old_system_runtime_for_version_manager() {
        let system = PathBuf::from("/usr/bin/node");
        let managed = PathBuf::from("/home/test/.nvm/versions/node/v22.11.0/bin/node");
        let selected = select_node(None, vec![system, managed.clone()], |path| {
            path == managed.as_path()
        });
        assert_eq!(selected, Some(managed));
    }

    #[test]
    fn unsupported_explicit_node_does_not_fall_back() {
        let explicit = PathBuf::from("/custom/node18");
        let fallback = PathBuf::from("/custom/node22");
        let selected = select_node(Some(explicit), vec![fallback.clone()], |path| {
            path == fallback.as_path()
        });
        assert_eq!(selected, None);
    }

    #[test]
    fn supported_explicit_node_takes_precedence() {
        let explicit = PathBuf::from("/custom/node20.10");
        let selected = select_node(Some(explicit.clone()), vec![], |_| true);
        assert_eq!(selected, Some(explicit));
    }

    #[test]
    fn discovery_range_matches_the_macos_build() {
        assert_eq!(DISCOVERY_PORTS.start, 3456);
        assert_eq!(DISCOVERY_PORTS.end, 3476);
    }
}
