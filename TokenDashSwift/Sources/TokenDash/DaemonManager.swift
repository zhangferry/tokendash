import Foundation

/// Manages the Node.js daemon process lifecycle.
@Observable class DaemonManager {
    private var process: Process?
    private let fileManager = FileManager.default

    var isRunning = false
    var port: Int?

    private var dataDir: String { NSHomeDirectory() + "/.tokendash" }
    private var pidPath: String { dataDir + "/daemon.pid" }
    private var portPath: String { dataDir + "/daemon.port" }
    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    private enum DaemonProbe: Equatable {
        case compatible
        case tokenDashVersionMismatch
        case unavailableOrForeign
    }

    // MARK: - Public

    func startDaemon() async throws -> Int {
        // Check if already running. The pid/port files are not enough: another
        // localhost service can occupy the same port, so verify TokenDash's API
        // identity before trusting a saved port.
        if let existingPort = readPortFile() {
            switch await probeDaemon(port: existingPort) {
            case .compatible:
                isRunning = true
                self.port = existingPort
                return existingPort
            case .tokenDashVersionMismatch:
                await cleanupIncompatibleDaemon(pid: readPidFile())
            case .unavailableOrForeign:
                // A stale PID can already belong to an unrelated process.
                // Never signal it unless both the API and process command
                // identify an old TokenDash daemon.
                cleanupFiles()
            }
        }

        // Find node binary
        let nodeURL = try findNode()

        // Find daemon script
        let daemonScript = try findDaemonScript()

        // Clean stale files
        cleanupFiles()
        ensureDataDir()

        // Launch process
        let proc = Process()
        proc.executableURL = nodeURL
        proc.arguments = [daemonScript, "--port", "3456"]
        proc.environment = ProcessInfo.processInfo.environment
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        self.process = proc

        // Wait for port file to appear (max 10s)
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let port = readPortFile(), await probeDaemon(port: port) == .compatible {
                isRunning = true
                self.port = port
                return port
            }
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5s
        }

        throw DaemonError.timeout
    }

    /// Quick liveness probe — true if the daemon we spawned is still running
    /// or a PID file points at a live process. Used by AppDelegate's health
    /// monitor to decide whether a restart is needed. Cheap (no network call).
    func isAlive() -> Bool {
        if let proc = process, proc.isRunning { return true }
        if let pid = readPidFile(), isProcessAlive(pid: pid) { return true }
        return false
    }

    func stopDaemon() {
        if let pid = readPidFile() {
            stopDaemonProcess(pid: pid)
        }
        process?.terminate()
        process = nil
        isRunning = false
        port = nil
        cleanupFiles()
    }

    // MARK: - Discovery

    private func findNode() throws -> URL {
        // Try common paths + nvm + volta + fnm
        let home = NSHomeDirectory()
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(home)/.nvm/versions/node/v24.13.0/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.local/share/fnm/node-versions/current/installation/bin/node",
        ]
        for path in candidates {
            if FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }

        // Try `which node` via shell (resolves nvm/volta/etc)
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-l", "-c", "which node"]
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus == 0 {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !path.isEmpty && FileManager.default.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }

        throw DaemonError.nodeNotFound
    }

    private func findDaemonScript() throws -> String {
        // In packaged app: <bundle>/Contents/Resources/server/dist/daemon.cjs
        let bundle = Bundle.main.bundlePath
        let packagedPath = bundle + "/Contents/Resources/server/dist/daemon.cjs"
        if FileManager.default.fileExists(atPath: packagedPath) { return packagedPath }

        // In development from repo root: look for dist/daemon.cjs relative to executable
        let execPath = ProcessInfo.processInfo.arguments[0]
        let execDir = (execPath as NSString).standardizingPath
        // execDir might be: /path/to/ccusage-dashboard/TokenDashSwift/.build/debug
        // daemon.cjs is at: /path/to/ccusage-dashboard/dist/daemon.cjs
        let candidates = [
            execDir + "/../../dist/daemon.cjs",          // .build/debug -> repo root
            execDir + "/../../../dist/daemon.cjs",        // .build -> repo root
            execDir + "/../../../../dist/daemon.cjs",     // TokenDashSwift -> repo root
        ]
        for path in candidates {
            let resolved = (path as NSString).standardizingPath
            if FileManager.default.fileExists(atPath: resolved) { return resolved }
        }

        throw DaemonError.daemonScriptNotFound
    }

    // MARK: - File helpers

    private func ensureDataDir() {
        try? fileManager.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
    }

    private func readPidFile() -> pid_t? {
        guard let data = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = pid_t(data.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return pid
    }

    private func readPortFile() -> Int? {
        guard let data = try? String(contentsOfFile: portPath, encoding: .utf8),
              let port = Int(data.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return port
    }

    private func isProcessAlive(pid: pid_t?) -> Bool {
        guard let pid = pid, pid > 0 else { return false }
        return kill(pid, 0) == 0
    }

    private func probeDaemon(port: Int) async -> DaemonProbe {
        do {
            let info = try await APIClient(port: port).getAppInfo(timeout: 1.0)
            guard info.packageName == APIClient.expectedPackageName else {
                return .unavailableOrForeign
            }
            let normalizedAppVersion = appVersion.replacingOccurrences(of: "^v", with: "", options: .regularExpression)
            if normalizedAppVersion == "dev" { return .compatible }
            let daemonVersion = info.version.replacingOccurrences(of: "^v", with: "", options: .regularExpression)
            return daemonVersion == normalizedAppVersion ? .compatible : .tokenDashVersionMismatch
        } catch {
            return .unavailableOrForeign
        }
    }

    private func cleanupIncompatibleDaemon(pid: pid_t?) async {
        if let pid, isProcessAlive(pid: pid), isTokenDashDaemonProcess(pid: pid) {
            await stopDaemonProcessAsync(pid: pid)
        }
        cleanupFiles()
    }

    private func isTokenDashDaemonProcess(pid: pid_t) -> Bool {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-p", String(pid), "-o", "command="]
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return false }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let command = String(data: data, encoding: .utf8) ?? ""
            return command.contains("daemon.cjs") && command.localizedCaseInsensitiveContains("tokendash")
        } catch {
            return false
        }
    }

    private func stopDaemonProcessAsync(pid: pid_t) async {
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if !isProcessAlive(pid: pid) { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        if isProcessAlive(pid: pid) {
            kill(pid, SIGKILL)
        }
    }

    private func stopDaemonProcess(pid: pid_t) {
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if !isProcessAlive(pid: pid) { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if isProcessAlive(pid: pid) {
            kill(pid, SIGKILL)
        }
    }

    private func cleanupFiles() {
        try? fileManager.removeItem(atPath: pidPath)
        try? fileManager.removeItem(atPath: portPath)
    }
}

enum DaemonError: LocalizedError {
    case nodeNotFound
    case daemonScriptNotFound
    case timeout

    var errorDescription: String? {
        switch self {
        case .nodeNotFound: return "Node.js not found. Install Node.js to use TokenDash."
        case .daemonScriptNotFound: return "Daemon script not found in app bundle."
        case .timeout: return "Daemon did not start within 10 seconds."
        }
    }
}
