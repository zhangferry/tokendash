import Foundation

protocol DaemonProcess: AnyObject {
    var executableURL: URL? { get set }
    var arguments: [String]? { get set }
    var environment: [String: String]? { get set }
    var standardOutput: Any? { get set }
    var standardError: Any? { get set }
    var isRunning: Bool { get }

    func run() throws
    func terminate()
    func interrupt()
}

extension Process: DaemonProcess {}

enum DaemonProbe: Equatable {
    case compatible
    case tokenDashVersionMismatch
    case unavailableOrForeign
}

/// Manages the Node.js daemon process lifecycle.
@Observable class DaemonManager {
    private var process: (any DaemonProcess)?
    private let fileManager = FileManager.default
    private let dataDirOverride: String?
    private let nodeFinder: () throws -> URL
    private let daemonScriptFinder: () throws -> String
    private let processFactory: () -> any DaemonProcess
    private let probeOverride: ((Int) async -> DaemonProbe)?
    private let dashboardProbeOverride: ((Int) async -> Bool)?
    private let startupTimeout: TimeInterval
    private let pollIntervalNanoseconds: UInt64
    private let discoveryPorts: [Int]

    var isRunning = false
    var port: Int?

    private var dataDir: String { dataDirOverride ?? NSHomeDirectory() + "/.tokendash" }
    private var pidPath: String { dataDir + "/daemon.pid" }
    private var portPath: String { dataDir + "/daemon.port" }
    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    init(
        dataDir: String? = nil,
        nodeFinder: (() throws -> URL)? = nil,
        daemonScriptFinder: (() throws -> String)? = nil,
        processFactory: @escaping () -> any DaemonProcess = { Process() },
        probe: ((Int) async -> DaemonProbe)? = nil,
        dashboardProbe: ((Int) async -> Bool)? = nil,
        startupTimeout: TimeInterval = 10,
        pollIntervalNanoseconds: UInt64 = 500_000_000,
        discoveryPorts: [Int] = Array(3456...3475)
    ) {
        self.dataDirOverride = dataDir
        self.processFactory = processFactory
        self.probeOverride = probe
        self.dashboardProbeOverride = dashboardProbe
        self.startupTimeout = startupTimeout
        self.pollIntervalNanoseconds = pollIntervalNanoseconds
        self.discoveryPorts = discoveryPorts
        self.nodeFinder = nodeFinder ?? { try Self.findNode() }
        self.daemonScriptFinder = daemonScriptFinder ?? { try Self.findDaemonScript() }
    }

    // MARK: - Public

    func startDaemon() async throws -> Int {
        // Check if already running. The pid/port files are not enough: another
        // localhost service can occupy the same port, so verify TokenDash's API
        // identity before trusting a saved port.
        if let existingPort = readPortFile() {
            switch await probeDaemon(port: existingPort) {
            case .compatible:
                markRunning(port: existingPort)
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

        // If a previous retry wrote no usable port file but did leave a daemon
        // listening on a fallback port, reattach to it instead of spawning yet
        // another 3457/3458/... daemon.
        if let discoveredPort = await discoverCompatibleDaemonPort() {
            markRunning(port: discoveredPort)
            writePortFile(discoveredPort)
            return discoveredPort
        }

        // Find node binary
        let nodeURL = try nodeFinder()

        // Find daemon script
        let daemonScript = try daemonScriptFinder()

        // Clean stale files
        cleanupFiles()
        ensureDataDir()

        // Launch process
        let proc = processFactory()
        proc.executableURL = nodeURL
        proc.arguments = [daemonScript, "--port", "3456"]
        proc.environment = ProcessInfo.processInfo.environment
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        self.process = proc

        do {
            // Wait for port file to appear. If readiness does not happen, the
            // process started by THIS attempt must be torn down; otherwise each
            // retry leaves one more healthy daemon on 3456/3457/3458 while the
            // Swift app remains detached from the service.
            let deadline = Date().addingTimeInterval(startupTimeout)
            while Date() < deadline {
                if let port = readPortFile(), await probeDaemon(port: port) == .compatible {
                    markRunning(port: port)
                    return port
                }
                try await Task.sleep(nanoseconds: pollIntervalNanoseconds)
            }

            throw DaemonError.timeout
        } catch {
            await cleanupFailedLaunch(proc)
            throw error
        }
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

    private static func findNode() throws -> URL {
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

    private static func findDaemonScript() throws -> String {
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

    private func writePortFile(_ port: Int) {
        ensureDataDir()
        try? String(port).write(toFile: portPath, atomically: true, encoding: .utf8)
    }

    private func isProcessAlive(pid: pid_t?) -> Bool {
        guard let pid = pid, pid > 0 else { return false }
        return kill(pid, 0) == 0
    }

    private func probeDaemon(port: Int) async -> DaemonProbe {
        let apiProbe: DaemonProbe
        if let probeOverride {
            apiProbe = await probeOverride(port)
        } else {
            apiProbe = await probeAPIIdentity(port: port)
        }

        guard apiProbe == .compatible else { return apiProbe }

        // A development API server can expose the same package/version while
        // intentionally serving no built web client. Reusing it would enable
        // the Dashboard button but open a 404 page. Packaged daemons are only
        // compatible when both their API identity and HTML entrypoint work.
        let dashboardAvailable: Bool
        if let dashboardProbeOverride {
            dashboardAvailable = await dashboardProbeOverride(port)
        } else if probeOverride != nil {
            // Existing lifecycle tests that replace the complete API probe do
            // not need to stand up an HTTP server unless they exercise this
            // additional contract explicitly.
            dashboardAvailable = true
        } else {
            dashboardAvailable = await probeDashboard(port: port)
        }
        return dashboardAvailable ? .compatible : .unavailableOrForeign
    }

    private func probeAPIIdentity(port: Int) async -> DaemonProbe {
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

    func probeDashboard(port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return false }
        do {
            let request = URLRequest(url: url, timeoutInterval: 1.0)
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            return http.statusCode == 200 && http.mimeType == "text/html"
        } catch {
            return false
        }
    }

    private func markRunning(port: Int) {
        isRunning = true
        self.port = port
    }

    private func discoverCompatibleDaemonPort() async -> Int? {
        for port in discoveryPorts {
            if await probeDaemon(port: port) == .compatible {
                return port
            }
        }
        return nil
    }

    private func cleanupFailedLaunch(_ launchedProcess: any DaemonProcess) async {
        if launchedProcess.isRunning {
            launchedProcess.terminate()
            try? await Task.sleep(nanoseconds: 500_000_000)
            if launchedProcess.isRunning {
                launchedProcess.interrupt()
            }
        }
        if process === launchedProcess {
            process = nil
        }
        isRunning = false
        port = nil
        cleanupFiles()
    }

    /// Network probe — true if the daemon on the current port responds with
    /// our package identity. Used by the health monitor; more reliable than
    /// `isAlive()` (pid-file) across reattach, where self.process is nil and
    /// pid-file state can lag the actual listener.
    func isAliveViaProbe() async -> Bool {
        guard let port = port else { return false }
        return await probeDaemon(port: port) == .compatible
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
