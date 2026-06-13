import Foundation
import AppKit

/// Periodically fetches usage data from the API, updates the menu bar badge image
/// and refreshes the shared AppState for the popover.
@MainActor class BadgeUpdater {
    private let state: AppState
    private var apiClient: APIClient?
    private var timer: Timer?
    /// Heartbeat cadence (cheap — just checks the clock). Actual fetch cadence
    /// follows SettingsStore.refreshInterval so manual mode disables auto-refresh.
    private let tickInterval: TimeInterval = 5.0
    private var lastUpdate: Date = .distantPast

    init(state: AppState) {
        self.state = state
    }

    func start(port: Int) {
        self.apiClient = APIClient(port: port)
        self.state.daemonPort = port
        self.state.isDaemonReady = true
        update()
        timer = Timer.scheduledTimer(withTimeInterval: tickInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Trigger an immediate refresh (e.g. from the refresh button).
    func refreshNow() {
        update()
    }

    private func tick() {
        let interval = SettingsStore.shared.refreshInterval
        if interval == .manual { return }
        if Date().timeIntervalSince(lastUpdate) >= interval.rawValue {
            update()
        }
    }

    // MARK: - Update cycle

    private func update() {
        guard let api = apiClient else {
            NSLog("[TokenDash] update() called but apiClient is nil")
            return
        }
        lastUpdate = Date()
        let port = state.daemonPort
        // Use a regular Task (inherits MainActor) instead of Task.detached
        // This ensures state updates trigger SwiftUI observation correctly.
        Task { [weak self] in
            guard let self = self else { return }
            do {
                NSLog("[TokenDash] Fetching agents from port \(port)...")
                let agentsResp = try await api.getAgents()
                let agents = agentsResp.available.isEmpty ? ["claude"] : agentsResp.available
                NSLog("[TokenDash] Agents: \(agents)")

                NSLog("[TokenDash] Fetching daily/blocks/projects for \(agents.count) agents...")

                var dailyResults: [DailyResponse] = []
                var blockResults: [BlocksResponse] = []
                var projectResults: [ProjectsResponse] = []

                for agent in agents {
                    NSLog("[TokenDash] Fetching daily for \(agent)...")
                    do {
                        let d = try await api.getDaily(agent: agent)
                        dailyResults.append(d)
                        NSLog("[TokenDash] Got daily for \(agent): \(d.daily.count) days")
                    } catch {
                        NSLog("[TokenDash] FAILED daily for \(agent): \(error)")
                    }
                    do {
                        let b = try await api.getBlocks(agent: agent)
                        blockResults.append(b)
                    } catch {
                        NSLog("[TokenDash] FAILED blocks for \(agent): \(error)")
                    }
                    do {
                        let p = try await api.getProjects(agent: agent)
                        projectResults.append(p)
                    } catch {
                        NSLog("[TokenDash] FAILED projects for \(agent): \(error)")
                    }
                }
                NSLog("[TokenDash] Got \(dailyResults.count) daily, \(blockResults.count) blocks, \(projectResults.count) projects")

                // Compute summary
                let today = todayString()
                var totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0
                var totalCost = 0.0

                for data in dailyResults {
                    guard let entry = data.daily.first(where: { $0.date == today }) else { continue }
                    totalTokens += entry.totalTokens
                    totalInput += entry.inputTokens
                    totalOutput += entry.outputTokens
                    totalCacheRead += entry.cacheReadTokens
                    totalCost += entry.totalCost
                }

                let denom = Double(totalInput + totalCacheRead)
                let cacheRate = denom > 0 ? Double(totalCacheRead) / denom * 100 : 0

                let tokenStr = formatTokens(totalTokens)
                let tooltip = String(format: "TokenDash - %@ tokens today ($%.2f) | cache: %.1f%%", tokenStr, totalCost, cacheRate)
                let badgeImage = renderCombinedImage(title: tokenStr)
                let summary = TodaySummary(
                    tokens: totalTokens, cost: totalCost,
                    inputTokens: totalInput, outputTokens: totalOutput,
                    cacheReadTokens: totalCacheRead, cacheRate: cacheRate
                )
                let hourly = computeHourly(blocks: blockResults, today: today)
                let projectRows = computeProjects(projects: projectResults, today: today)

                NSLog("[TokenDash] Today: \(tokenStr) tokens, \(formatCost(totalCost)), cache \(formatPercent(cacheRate))")

                // Coding Plan quotas — independent of the daily usage fetch above.
                // Failures are isolated per-provider by the server, so a missing
                // credential never breaks the rest of the popover.
                var quotaSnapshots: [QuotaSnapshot] = []
                do {
                    let quotaResp = try await api.getQuota()
                    quotaSnapshots = quotaResp.providers
                    NSLog("[TokenDash] Quota: \(quotaSnapshots.count) providers")
                } catch {
                    NSLog("[TokenDash] Quota fetch failed (non-fatal): \(error)")
                }

                // Direct state update — we're on MainActor, observation will fire
                self.state.badgeImage = badgeImage
                self.state.tooltipText = tooltip
                self.state.todaySummary = summary
                self.state.cacheRate = cacheRate
                self.state.isLoading = false
                self.state.errorMessage = nil
                self.state.hourlyData = hourly
                self.state.projects = projectRows
                self.state.quotas = quotaSnapshots

                // Low-quota notifications (no-op if disabled in settings).
                NotificationService.shared.evaluate(quotas: quotaSnapshots)

            } catch {
                NSLog("[TokenDash] update() error: \(error.localizedDescription)")
                self.state.errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Data computation

    private func computeHourly(blocks: [BlocksResponse], today: String) -> [HourBucket] {
        var hourly = [Int](repeating: 0, count: 24)
        for resp in blocks {
            for block in resp.blocks {
                let prefix = String(block.startTime.prefix(10))
                guard prefix == today else { continue }
                let hourStr = block.startTime.count >= 13 ? String(block.startTime.prefix(13).suffix(2)) : ""
                if let h = Int(hourStr), h >= 0, h < 24 {
                    hourly[h] += block.totalTokens
                }
            }
        }
        let maxVal = hourly.max() ?? 0
        return (0..<24).map { h in
            HourBucket(hour: h, tokens: hourly[h], isPeak: hourly[h] > 0 && hourly[h] == maxVal)
        }
    }

    private func computeProjects(projects: [ProjectsResponse], today: String) -> [ProjectRow] {
        var totals: [String: (input: Int, output: Int, cached: Int, total: Int)] = [:]
        for resp in projects {
            for (path, entries) in resp.projects {
                let todayEntries = entries.filter { $0.date == today }
                guard !todayEntries.isEmpty else { continue }
                var t = totals[path] ?? (0, 0, 0, 0)
                for e in todayEntries {
                    t.input += e.inputTokens
                    t.output += e.outputTokens
                    t.cached += e.cacheReadTokens
                    t.total += e.totalTokens
                }
                totals[path] = t
            }
        }
        return totals.map { path, t in
            ProjectRow(name: formatProjectName(path), fullPath: path, input: t.input, output: t.output, cached: t.cached, total: t.total)
        }.sorted { $0.total > $1.total }.prefix(4).map { $0 }
    }

    // MARK: - Badge image rendering

    private func renderCombinedImage(title: String) -> NSImage {
        let iconW: CGFloat = 18, iconH: CGFloat = 18
        let fontSize: CGFloat = 13
        let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .medium)
        let textAttrs: [NSAttributedString.Key: Any] = [.font: font]
        let textWidth = (title as NSString).size(withAttributes: textAttrs).width
        let padding: CGFloat = 4
        let totalWidth = iconW + padding + textWidth
        let totalHeight: CGFloat = 20

        let image = NSImage(size: NSSize(width: totalWidth, height: totalHeight))
        image.lockFocus()

        // Draw icon
        let icon = createTemplateIcon(size: NSSize(width: iconW, height: iconH))
        let iconY = (totalHeight - iconH) / 2.0
        icon.draw(in: NSRect(x: 0, y: iconY, width: iconW, height: iconH))

        // Draw text
        let textY = (totalHeight - fontSize) / 2.0 - 1
        (title as NSString).draw(at: NSPoint(x: iconW + padding, y: textY), withAttributes: textAttrs)

        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    private func createTemplateIcon(size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()

        let sx = size.width / 64.0
        let sy = size.height / 64.0

        let path = NSBezierPath()
        path.move(to: NSPoint(x: 6 * sx, y: (64 - 32) * sy))
        path.line(to: NSPoint(x: 18 * sx, y: (64 - 32) * sy))
        path.curve(to: NSPoint(x: 24.5 * sx, y: (64 - 39) * sy),
                   controlPoint1: NSPoint(x: 21 * sx, y: (64 - 32) * sy),
                   controlPoint2: NSPoint(x: 22.5 * sx, y: (64 - 34) * sy))
        path.curve(to: NSPoint(x: 34 * sx, y: (64 - 50) * sy),
                   controlPoint1: NSPoint(x: 27 * sx, y: (64 - 45.5) * sy),
                   controlPoint2: NSPoint(x: 30 * sx, y: (64 - 50) * sy))
        path.curve(to: NSPoint(x: 44 * sx, y: (64 - 22) * sy),
                   controlPoint1: NSPoint(x: 38 * sx, y: (64 - 50) * sy),
                   controlPoint2: NSPoint(x: 40.5 * sx, y: (64 - 42) * sy))
        path.curve(to: NSPoint(x: 52 * sx, y: (64 - 8) * sy),
                   controlPoint1: NSPoint(x: 46 * sx, y: (64 - 11) * sy),
                   controlPoint2: NSPoint(x: 49 * sx, y: (64 - 8) * sy))
        path.curve(to: NSPoint(x: 60 * sx, y: (64 - 22) * sy),
                   controlPoint1: NSPoint(x: 55 * sx, y: (64 - 8) * sy),
                   controlPoint2: NSPoint(x: 57.5 * sx, y: (64 - 13) * sy))

        path.lineWidth = 5 * sx
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor.black.setStroke()
        path.stroke()

        image.unlockFocus()
        image.isTemplate = true
        return image
    }
}
