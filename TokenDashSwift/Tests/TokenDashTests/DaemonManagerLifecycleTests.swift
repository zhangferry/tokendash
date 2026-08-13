import Foundation
import Network
import XCTest
@testable import TokenDash

@MainActor
final class DaemonManagerLifecycleTests: XCTestCase {
    func testStartDaemonTerminatesSpawnedProcessWhenReadinessTimesOut() async throws {
        let process = FakeDaemonProcess()
        let dataDir = temporaryDataDir()
        let manager = DaemonManager(
            dataDir: dataDir.path,
            nodeFinder: { URL(fileURLWithPath: "/usr/bin/node") },
            daemonScriptFinder: { "/tmp/daemon.cjs" },
            processFactory: { process },
            probe: { _ in .unavailableOrForeign },
            startupTimeout: 0.01,
            pollIntervalNanoseconds: 1_000_000
        )

        do {
            _ = try await manager.startDaemon()
            XCTFail("startDaemon should time out when readiness probe never succeeds")
        } catch DaemonError.timeout {
            // expected
        }

        XCTAssertEqual(process.runCount, 1)
        XCTAssertEqual(process.terminateCount, 1, "timeout must terminate the daemon started by this attempt")
        XCTAssertFalse(process.isRunning)
        XCTAssertNil(manager.port)
        XCTAssertFalse(manager.isRunning)
    }

    func testStartDaemonReusesCompatibleDaemonDiscoveredOnFallbackPort() async throws {
        let process = FakeDaemonProcess()
        let dataDir = temporaryDataDir()
        let manager = DaemonManager(
            dataDir: dataDir.path,
            nodeFinder: { URL(fileURLWithPath: "/usr/bin/node") },
            daemonScriptFinder: { "/tmp/daemon.cjs" },
            processFactory: { process },
            probe: { port in port == 3457 ? .compatible : .unavailableOrForeign },
            startupTimeout: 0.01,
            pollIntervalNanoseconds: 1_000_000,
            discoveryPorts: [3456, 3457, 3458]
        )

        let port = try await manager.startDaemon()

        XCTAssertEqual(port, 3457)
        XCTAssertEqual(process.runCount, 0, "compatible existing TokenDash daemon should be reused instead of spawning another fallback daemon")
        XCTAssertTrue(manager.isRunning)
        XCTAssertEqual(manager.port, 3457)
    }

    func testStartDaemonRejectsApiCompatibleServiceWhenDashboardIsUnavailable() async throws {
        let process = FakeDaemonProcess()
        let dataDir = temporaryDataDir()
        try "3457".write(
            to: dataDir.appendingPathComponent("daemon.port"),
            atomically: true,
            encoding: .utf8
        )
        let manager = DaemonManager(
            dataDir: dataDir.path,
            nodeFinder: { URL(fileURLWithPath: "/usr/bin/node") },
            daemonScriptFinder: { "/tmp/daemon.cjs" },
            processFactory: { process },
            probe: { port in [3456, 3457].contains(port) ? .compatible : .unavailableOrForeign },
            dashboardProbe: { port in port == 3456 },
            startupTimeout: 0.01,
            pollIntervalNanoseconds: 1_000_000,
            discoveryPorts: [3456, 3457, 3458]
        )

        let port = try await manager.startDaemon()

        XCTAssertEqual(port, 3456, "the API-only service must be skipped in favor of a daemon that serves the dashboard")
        XCTAssertEqual(process.runCount, 0)
        XCTAssertTrue(manager.isRunning)
        XCTAssertEqual(manager.port, 3456)
        XCTAssertEqual(try String(contentsOf: dataDir.appendingPathComponent("daemon.port"), encoding: .utf8), "3456")
    }

    func testDashboardProbeRejects404AndAcceptsHtml() async throws {
        let manager = DaemonManager()
        let unavailableServer = try TestHTTPServer(
            statusLine: "404 Not Found",
            contentType: "text/html; charset=utf-8"
        )
        defer { unavailableServer.stop() }

        let unavailable = await manager.probeDashboard(port: unavailableServer.port)
        XCTAssertFalse(unavailable)

        let dashboardServer = try TestHTTPServer(
            statusLine: "200 OK",
            contentType: "text/html; charset=utf-8"
        )
        defer { dashboardServer.stop() }

        let available = await manager.probeDashboard(port: dashboardServer.port)
        XCTAssertTrue(available)
    }

    private func temporaryDataDir() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("tokendash-daemon-tests")
            .appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

private final class TestHTTPServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "tokendash.dashboard-probe-test")
    private(set) var port = 0

    init(statusLine: String, contentType: String) throws {
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { connection in
            connection.start(queue: DispatchQueue.global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4_096) { _, _, _, _ in
                let body = "<html><body>TokenDash</body></html>"
                let response = [
                    "HTTP/1.1 \(statusLine)",
                    "Content-Type: \(contentType)",
                    "Content-Length: \(body.utf8.count)",
                    "Connection: close",
                    "",
                    body,
                ].joined(separator: "\r\n")
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
        listener.start(queue: queue)

        guard ready.wait(timeout: .now() + 2) == .success else {
            listener.cancel()
            throw TestHTTPServerError.startupTimedOut
        }
        guard let assignedPort = listener.port else {
            listener.cancel()
            throw TestHTTPServerError.portUnavailable
        }
        port = Int(assignedPort.rawValue)
    }

    func stop() {
        listener.cancel()
    }
}

private enum TestHTTPServerError: Error {
    case portUnavailable
    case startupTimedOut
}

private final class FakeDaemonProcess: DaemonProcess {
    var executableURL: URL?
    var arguments: [String]?
    var environment: [String: String]?
    var standardOutput: Any?
    var standardError: Any?
    private(set) var isRunning = false
    private(set) var runCount = 0
    private(set) var terminateCount = 0
    private(set) var interruptCount = 0

    func run() throws {
        runCount += 1
        isRunning = true
    }

    func terminate() {
        terminateCount += 1
        isRunning = false
    }

    func interrupt() {
        interruptCount += 1
        isRunning = false
    }
}
