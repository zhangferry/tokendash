import Foundation
import AppKit

/// Periodically fetches usage data from the API, updates the menu bar badge image
/// and refreshes the shared AppState for the popover.
@MainActor class BadgeUpdater {
    private let state: AppState
    private var apiClient: APIClient?
    private var timer: Timer?
    /// Heartbeat cadence (cheap — just checks the clock). Actual fetch cadence
    /// follows SettingsStore.refreshInterval.
    private let tickInterval: TimeInterval = 5.0
    private var lastUpdate: Date = .distantPast

    init(state: AppState) {
        self.state = state
    }

    func start(port: Int) {
        applyPort(port)
        ensureTimer()
        update()
    }

    /// Hot-switch to a new daemon port after the daemon has been restarted,
    /// without tearing down the polling timer. Clears any stale error so the
    /// popover recovers immediately once the daemon is back.
    func updatePort(_ port: Int) {
        applyPort(port)
        ensureTimer()
        NSLog("[TokenDash] BadgeUpdater switched to port \(port)")
        update()
    }

    private func applyPort(_ port: Int) {
        self.apiClient = APIClient(port: port)
        self.state.daemonPort = port
        self.state.isDaemonReady = true
        self.state.errorMessage = nil
    }

    private func ensureTimer() {
        guard timer == nil else { return }
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
                        let d = try await api.getDaily(agent: agent, refresh: true)
                        dailyResults.append(d)
                        NSLog("[TokenDash] Got daily for \(agent): \(d.daily.count) days")
                    } catch {
                        NSLog("[TokenDash] FAILED daily for \(agent): \(error)")
                    }
                    do {
                        let b = try await api.getBlocks(agent: agent, refresh: true)
                        blockResults.append(b)
                    } catch {
                        NSLog("[TokenDash] FAILED blocks for \(agent): \(error)")
                    }
                    do {
                        let p = try await api.getProjects(agent: agent, refresh: true)
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
                let badgeImage = Self.renderBadgeImage(title: tokenStr)
                let summary = TodaySummary(
                    tokens: totalTokens, cost: totalCost,
                    inputTokens: totalInput, outputTokens: totalOutput,
                    cacheReadTokens: totalCacheRead, cacheRate: cacheRate
                )
                let hourly = computeHourly(blocks: blockResults, today: today)
                let projectRows = computeProjects(projects: projectResults, today: today)
                let modelRows = computeModels(daily: dailyResults, today: today)
                let trendPoints = computeTrend(daily: dailyResults)

                NSLog("[TokenDash] Today: \(tokenStr) tokens, \(formatCost(totalCost)), cache \(formatPercent(cacheRate))")

                // Coding Plan quotas — independent of the daily usage fetch above.
                // Failures are isolated per-provider by the server, so a missing
                // credential never breaks the rest of the popover.
                var quotaSnapshots = self.state.quotas
                do {
                    let quotaResp = try await api.getQuota(refresh: true)
                    quotaSnapshots = self.retainUsableQuotas(quotaResp.providers, previous: self.state.quotas)
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
                self.state.models = modelRows
                self.state.trend = trendPoints
                self.state.quotas = quotaSnapshots

                // Low-quota notifications (no-op if disabled in settings).
                NotificationService.shared.evaluate(quotas: quotaSnapshots)

            } catch {
                NSLog("[TokenDash] update() error: \(error.localizedDescription)")
                self.state.errorMessage = error.localizedDescription
            }
        }
    }

    private func retainUsableQuotas(_ incoming: [QuotaSnapshot], previous: [QuotaSnapshot]) -> [QuotaSnapshot] {
        guard !incoming.isEmpty else { return previous }
        let previousByProvider = Dictionary(uniqueKeysWithValues: previous.map { ($0.provider, $0) })
        var retainedProviders = Set<String>()

        var merged = incoming.compactMap { snapshot -> QuotaSnapshot? in
            retainedProviders.insert(snapshot.provider)
            if snapshot.status.state == "ok", snapshot.freshness != "stale", !snapshot.windows.isEmpty {
                return snapshot
            }
            return previousByProvider[snapshot.provider]
        }

        for snapshot in previous where !retainedProviders.contains(snapshot.provider) {
            merged.append(snapshot)
        }
        return merged
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

    /// Aggregate today's per-model usage across all agents (uses modelBreakdowns
    /// that the summary loop discards). Token count = input + output + cacheRead.
    private func computeModels(daily: [DailyResponse], today: String) -> [ModelRow] {
        var totals: [String: (tokens: Int, cost: Double)] = [:]
        for data in daily {
            guard let entry = data.daily.first(where: { $0.date == today }) else { continue }
            for b in entry.modelBreakdowns ?? [] {
                let name = shortModelName(b.modelName)
                var t = totals[name] ?? (0, 0)
                t.tokens += b.inputTokens + b.outputTokens + b.cacheReadTokens
                t.cost += b.cost
                totals[name] = t
            }
        }
        return totals.map { name, t in
            ModelRow(name: name, tokens: t.tokens, cost: t.cost)
        }.sorted { $0.tokens > $1.tokens }.prefix(5).map { $0 }
    }

    /// Last 7 days (oldest → newest) aggregated cost + tokens across all agents.
    private func computeTrend(daily: [DailyResponse]) -> [TrendPoint] {
        var byDate: [String: (tokens: Int, cost: Double)] = [:]
        for data in daily {
            for entry in data.daily {
                var t = byDate[entry.date] ?? (0, 0)
                t.tokens += entry.totalTokens
                t.cost += entry.totalCost
                byDate[entry.date] = t
            }
        }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: Date())
        return (0..<7).reversed().map { i in
            guard let d = cal.date(byAdding: .day, value: -i, to: todayStart) else {
                return TrendPoint(date: "", tokens: 0, cost: 0)
            }
            let key = fmt.string(from: d)
            let t = byDate[key] ?? (0, 0)
            return TrendPoint(date: key, tokens: t.tokens, cost: t.cost)
        }
    }

    // MARK: - Badge image rendering

    static func renderBadgeImage(title: String) -> NSImage {
        let iconW: CGFloat = 18, iconH: CGFloat = 18
        let fontSize: CGFloat = 13
        let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .medium)
        let textAttrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.black,
        ]
        let textWidth = (title as NSString).size(withAttributes: textAttrs).width
        let padding: CGFloat = 4
        let totalWidth = iconW + padding + textWidth
        let totalHeight: CGFloat = 20

        let image = NSImage(size: NSSize(width: totalWidth, height: totalHeight))
        image.lockFocus()

        // Draw a compact circular token mark for menu bar legibility.
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

    private static func createTemplateIcon(size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()

        let inset = min(size.width, size.height) * 0.08
        let circleRect = NSRect(
            x: inset,
            y: inset,
            width: size.width - inset * 2,
            height: size.height - inset * 2
        )
        NSColor.black.setFill()
        NSBezierPath(ovalIn: circleRect).fill()

        // Cut the app icon's pulse line out of the circular token mark.
        let sx = size.width / 64.0
        let sy = size.height / 64.0
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 7 * sx, y: 32 * sy))
        path.line(to: NSPoint(x: 25 * sx, y: 32 * sy))
        path.line(to: NSPoint(x: 31 * sx, y: 47 * sy))
        path.line(to: NSPoint(x: 38 * sx, y: 17 * sy))
        path.line(to: NSPoint(x: 44 * sx, y: 32 * sy))
        path.line(to: NSPoint(x: 57 * sx, y: 32 * sy))
        path.lineWidth = 5.5 * sx
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current?.compositingOperation = .clear
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()

        image.unlockFocus()
        image.isTemplate = true
        return image
    }
}
