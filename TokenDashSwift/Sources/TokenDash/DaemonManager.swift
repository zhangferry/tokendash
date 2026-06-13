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

    // MARK: - Public

    func startDaemon() async throws -> Int {
        // Check if already running
        if let existingPort = readPortFile(), isProcessAlive(pid: readPidFile()) {
            isRunning = true
            self.port = existingPort
            return existingPort
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
            if let port = readPortFile() {
                isRunning = true
                self.port = port
                return port
            }
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5s
        }

        throw DaemonError.timeout
    }

    func stopDaemon() {
        if let pid = readPidFile() {
            kill(pid, SIGTERM)
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
