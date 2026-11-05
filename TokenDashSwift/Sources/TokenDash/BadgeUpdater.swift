import Foundation
import AppKit

/// Periodically fetches usage data from the API, updates the menu bar badge image
/// and refreshes the shared AppState for the popover.
///
/// Refresh is driven by a three-state machine (`RefreshMode`) instead of a fixed
/// high-frequency timer:
/// - `.dormant`  — popover closed: fresh badge totals every 30s plus a
///                 configurable background refresh of detail data.
/// - `.active`   — popover open: immediate fresh detail data, then a 60s fresh
///                 detail refresh while the user is looking at the popover.
/// - `.suspended`— system sleep / low power: all data timers stopped.
@MainActor class BadgeUpdater {
    private let state: AppState
    private var apiClient: (any APIClientProtocol)?

    enum RefreshMode { case dormant, active, suspended }
    private(set) var mode: RefreshMode = .dormant

    // Cadences (seconds). The badge refresh parses only changed usage files via
    // the daemon's usage index, so it stays cheap while reflecting live agent use.
    // Detail data also refreshes while the popover is visible.
    private let dormantInterval: TimeInterval = 30
    private let activePulseInterval: TimeInterval = 10.0
    private let activeDetailInterval: TimeInterval
    private let backgroundFullIntervalOverride: TimeInterval?
    private var backgroundFullInterval: TimeInterval {
        backgroundFullIntervalOverride ?? SettingsStore.shared.refreshInterval.rawValue
    }
    private let popoverRefreshInterval: TimeInterval
    private let now: () -> Date

    /// Realtime tab cadence (seconds): 1-minute buckets refresh once a minute
    /// while the popover is open. Cache-served against the daemon's 60s 1m key.
    private let realtimeInterval: TimeInterval = 60
    private var realtimeTimer: Timer?

    /// Feature flag matching HourlyChartView.pulseEnabled — hides the 10s pulse
    /// sampler for the energy-optimization release.
    private let pulseEnabled = false

    private var dormantTimer: Timer?
    private var pulseTimer: Timer?
    private var activeDetailTimer: Timer?
    private var backgroundFullTimer: Timer?
    private var pendingFreshPopoverRefresh = false

    private var activeAgents: [String] = []
    private var isPulseSampling = false
    private var lastPulseObservation: (
        date: String,
        timestamp: Date,
        totalTokens: Int,
        inputTokens: Int,
        outputTokens: Int
    )?

    init(
        state: AppState,
        client: (any APIClientProtocol)? = nil,
        now: @escaping () -> Date = Date.init,
        backgroundFullInterval: TimeInterval? = nil,
        popoverRefreshInterval: TimeInterval = 30 * 60,
        activeDetailInterval: TimeInterval = 60
    ) {
        self.state = state
        self.apiClient = client
        self.now = now
        self.backgroundFullIntervalOverride = backgroundFullInterval
        self.popoverRefreshInterval = popoverRefreshInterval
        self.activeDetailInterval = activeDetailInterval
    }

    func start(port: Int) {
        applyPort(port)
        // Prime detail state once on launch so the first popover open isn't
        // empty — dormant mode afterwards only refreshes the badge. All
        // cache-served (warm-up has filled daily/blocks/projects), and quota
        // runs async so it never blocks this initial paint.
        Task { await self.performFullUpdate(forceRefresh: false, forceQuota: false) }
        scheduleBackgroundFull()
        setMode(.dormant)   // app launches with popover hidden
    }

    /// Hot-switch to a new daemon port after restart, preserving the current mode.
    func updatePort(_ port: Int) {
        let resumeMode = mode
        applyPort(port)
        NSLog("[TokenDash] BadgeUpdater switched to port \(port)")
        mode = .suspended     // force setMode to rebuild timers against new port
        setMode(resumeMode)
    }

    private func applyPort(_ port: Int) {
        self.apiClient = APIClient(port: port)
        self.state.daemonPort = port
        self.state.isDaemonReady = true
        self.state.errorMessage = nil
    }

    // MARK: - Mode state machine

    func setMode(_ newMode: RefreshMode) {
        if newMode == .suspended {
            stopBackgroundFull()
        } else {
            scheduleBackgroundFull()
        }
        mode = newMode
        stopDataTimers()
        updateRealtimeTimer()
        switch newMode {
        case .dormant:
            scheduleDormant()
            Task { await self.performBadgeUpdate() }   // immediate refresh on entry
        case .active:
            Task { await self.refreshOnPopoverOpenIfNeeded() }
            scheduleActiveDetail()
            if pulseEnabled {
                samplePulse()  // prime a pulse baseline immediately, don't wait 10s
                schedulePulse()
            }
        case .suspended:
            break   // all data timers stopped; daemon healthCheck (AppDelegate) keeps running
        }
        NSLog("[TokenDash] BadgeUpdater mode → \(newMode)")
    }

    private func scheduleDormant() {
        let t = Timer(timeInterval: dormantInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.performBadgeUpdate() }
        }
        RunLoop.main.add(t, forMode: .common)
        dormantTimer = t
    }

    private func schedulePulse() {
        let t = Timer(timeInterval: activePulseInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.samplePulse() }
        }
        RunLoop.main.add(t, forMode: .common)
        pulseTimer = t
    }

    private func scheduleActiveDetail() {
        let t = Timer(timeInterval: activeDetailInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.performActiveDetailRefresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        activeDetailTimer = t
    }

    private func scheduleBackgroundFull() {
        guard backgroundFullTimer == nil else { return }
        let t = Timer(timeInterval: backgroundFullInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.performBackgroundRefresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        backgroundFullTimer = t
    }

    private func stopBackgroundFull() {
        backgroundFullTimer?.invalidate()
        backgroundFullTimer = nil
    }

    private func stopDataTimers() {
        dormantTimer?.invalidate(); dormantTimer = nil
        pulseTimer?.invalidate(); pulseTimer = nil
        activeDetailTimer?.invalidate(); activeDetailTimer = nil
    }

    /// Runs the 1-minute realtime poll only while the popover is open and the
    /// 15M tab is selected — closed popover, other tabs, and system sleep all
    /// stop it, keeping the energy profile visibility-driven.
    private func updateRealtimeTimer() {
        let shouldRun = mode == .active && SettingsStore.shared.hourlyRange == .fifteenMinutes
        realtimeTimer?.invalidate()
        realtimeTimer = nil
        guard shouldRun else { return }
        Task { await self.fetchRealtimeBlocks() }   // prime immediately
        let t = Timer(timeInterval: realtimeInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.fetchRealtimeBlocks() }
        }
        RunLoop.main.add(t, forMode: .common)
        realtimeTimer = t
    }

    /// Called by the chart tabs when the selected range changes so the
    /// realtime poll starts or stops right away (and refreshes once if live).
    func realtimeRangeDidChange() {
        updateRealtimeTimer()
    }

    /// Fetches only the 1-minute blocks for the realtime tab. Cache-served
    /// (refresh:false), silent on failure, and never touches detail state —
    /// daily/projects/quota keep their own cadences.
    private func fetchRealtimeBlocks() async {
        guard let api = apiClient else { return }
        let agents = activeAgents.isEmpty ? ["claude"] : activeAgents
        var results: [BlocksResponse] = []
        for agent in agents {
            if let b = try? await api.getBlocks(agent: agent, refresh: false, granularity: .oneMin) {
                results.append(b)
            }
        }
        guard !results.isEmpty else { return }
        let aggregation = UsageBucketAggregator.aggregate(
            results, now: Date(), bucketMinutes: 1,
            window: UsageBucketAggregator.realtimeWindow(now: Date()))
        guard aggregation.granularityMatched else {
            NSLog("[TokenDash] realtime blocks granularity mismatch — keeping previous data")
            return
        }
        state.realtimeBuckets = aggregation.buckets
    }

    func stop() {
        stopDataTimers()
        realtimeTimer?.invalidate(); realtimeTimer = nil
        stopBackgroundFull()
    }

    func applyRefreshIntervalChange() {
        stopBackgroundFull()
        if mode != .suspended {
            scheduleBackgroundFull()
        }
    }

    /// Manual refresh (refresh button) — force everything, including external quota.
    func refreshNow() {
        Task {
            await self.performFullUpdate(
                forceRefresh: true, forceQuota: true, recordRefreshTime: true)
        }
    }

    /// Full detail refresh for the background timer. Automatic work remains
    /// cache-aware; only the user's refresh action bypasses daemon caches.
    func performBackgroundRefresh() async {
        await performFullUpdate(
            forceRefresh: false, forceQuota: false, recordRefreshTime: true)
    }

    /// Full detail refresh while the popover is visible. It bypasses usage caches
    /// so live coding-agent activity is reflected without waiting for the
    /// low-power background cadence, but quota remains cached to avoid repeated
    /// upstream calls.
    func performActiveDetailRefresh() async {
        await performFullUpdate(forceRefresh: true, forceQuota: false)
    }

    /// Returns true when opening the popover triggered its allowed automatic
    /// refresh. The throttle is based on the most recent full detail refresh,
    /// regardless of whether it came from a manual click, the background timer,
    /// or a previous popover open.
    func refreshOnPopoverOpenIfNeeded() async -> Bool {
        if state.isRefreshing {
            pendingFreshPopoverRefresh = true
            return false
        }
        let currentTime = now()
        let throttle: TimeInterval = SettingsStore.shared.hourlyRange == .oneDay
            ? popoverRefreshInterval
            : min(popoverRefreshInterval, 5 * 60)
        if let lastUpdatedAt = state.lastUpdatedAt,
           currentTime.timeIntervalSince(lastUpdatedAt) < throttle {
            return false
        }
        await performFullUpdate(
            forceRefresh: false, forceQuota: false, recordRefreshTime: true)
        return true
    }

    // MARK: - dormant: cheap badge update (cache-served)

    /// Updates only today's total tokens + cost for the menu bar badge. This
    /// bypasses the daemon response cache because the badge is the primary live
    /// signal that coding-agent usage is still moving. The daemon usage index
    /// reparses only changed files, and this still avoids blocks/projects/quota.
    func performBadgeUpdate() async {
        guard let api = apiClient else { return }
        do {
            let agentsResp = try await api.getAgents()
            let agents = agentsResp.available
            self.activeAgents = agents

            let today = todayString()
            var totalTokens = 0
            var totalCost = 0.0
            var costAvailable = true
            var status = UsageFetchStatus()
            for agent in agents {
                do {
                    let d = try await api.getDaily(agent: agent, refresh: true)
                    status.succeeded()
                    for failure in d.sourceErrors ?? [] { status.failed(failure.agent) }
                    if let entry = d.daily.first(where: { $0.date == today }) {
                        totalTokens += entry.totalTokens
                        totalCost += entry.totalCost
                        costAvailable = costAvailable && entry.costAvailable != false
                    }
                } catch {
                    status.failed(agent)
                }
            }
            try status.requireSuccess(sourceCount: agents.count)
            costAvailable = costAvailable && status.failedSources.isEmpty

            let tokenStr = formatTokens(totalTokens)
            self.state.badgeImage = Self.renderBadgeImage(title: tokenStr)
            let costLabel = costAvailable ? formatCost(totalCost) : "partial estimate"
            self.state.tooltipText = "TokenDash - \(tokenStr) tokens today (\(costLabel))"
                + (status.warning.map { " | \($0)" } ?? "")
            self.state.errorMessage = status.warning
        } catch {
            NSLog("[TokenDash] badge update error: \(error.localizedDescription)")
            self.state.errorMessage = error.localizedDescription
        }
    }

    // MARK: - Full detail refresh

    /// Refreshes daily, blocks, projects, quota, and all derived popover data.
    /// `forceRefresh` bypasses the daemon usage cache; `forceQuota` bypasses
    /// the quota cache. Both are reserved for an explicit manual refresh.
    /// `recordRefreshTime` lets cache-aware scheduled work advance its throttle
    /// without treating the launch warm-up as a completed automatic refresh.
    func performFullUpdate(
        forceRefresh: Bool,
        forceQuota: Bool,
        recordRefreshTime: Bool? = nil
    ) async {
        guard let api = apiClient else {
            NSLog("[TokenDash] performFullUpdate called but apiClient is nil")
            return
        }
        guard !state.isRefreshing else { return }
        let shouldRecordRefreshTime = recordRefreshTime ?? forceRefresh
        state.isRefreshing = true
        if state.todaySummary == nil {
            state.isLoading = true
        }
        defer {
            state.isLoading = false
            state.isRefreshing = false
            if shouldRecordRefreshTime {
                pendingFreshPopoverRefresh = false
            } else if pendingFreshPopoverRefresh && mode == .active {
                pendingFreshPopoverRefresh = false
                Task { await self.refreshOnPopoverOpenIfNeeded() }
            }
        }
        do {
            let agentsResp = try await api.getAgents()
            let agents = agentsResp.available
            self.activeAgents = agents

            var dailyResults: [DailyResponse] = []
            var blockResults: [BlocksResponse] = []
            var projectResults: [ProjectsResponse] = []
            var status = UsageFetchStatus()

            for agent in agents {
                // A forced refresh uses fresh daemon data; launch and cached
                // detail paths can reuse the daemon's existing results.
                do {
                    let d = try await api.getDaily(agent: agent, refresh: forceRefresh)
                    dailyResults.append(d)
                    status.succeeded()
                    for failure in d.sourceErrors ?? [] { status.failed(failure.agent) }
                } catch { status.failed(agent) }
                // One 5-minute base serves every chart range (PRD v1.9.1).
                do {
                    let b = try await api.getBlocks(agent: agent, refresh: forceRefresh, granularity: .fiveMin)
                    blockResults.append(b)
                    for failure in b.sourceErrors ?? [] { status.failed(failure.agent) }
                } catch { status.failed(agent) }
                do {
                    let p = try await api.getProjects(agent: agent, refresh: forceRefresh)
                    projectResults.append(p)
                    for failure in p.sourceErrors ?? [] { status.failed(failure.agent) }
                } catch { status.failed(agent) }
            }
            try status.requireSuccess(sourceCount: agents.count)

            let today = todayString()
            var totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
            var totalCost = 0.0
            var costAvailable = status.failedSources.isEmpty
            for data in dailyResults {
                guard let entry = data.daily.first(where: { $0.date == today }) else { continue }
                totalTokens += entry.totalTokens
                totalInput += entry.inputTokens
                totalOutput += entry.outputTokens
                totalCacheRead += entry.cacheReadTokens
                totalCacheWrite += entry.cacheCreationTokens
                totalCost += entry.totalCost
                costAvailable = costAvailable && entry.costAvailable != false
            }
            let denom = Double(totalInput + totalCacheRead + totalCacheWrite)
            let cacheRate = denom > 0 ? Double(totalCacheRead) / denom * 100 : 0
            let tokenStr = formatTokens(totalTokens)
            let badgeImage = Self.renderBadgeImage(title: tokenStr)
            let summary = TodaySummary(
                tokens: totalTokens, cost: totalCost,
                inputTokens: totalInput, outputTokens: totalOutput,
                cacheReadTokens: totalCacheRead, cacheRate: cacheRate, costAvailable: costAvailable,
                cacheWriteTokens: totalCacheWrite)
            if pulseEnabled, dailyResults.count == agents.count {
                self.recordPulseObservation(
                    totalTokens: totalTokens, inputTokens: totalInput, outputTokens: totalOutput,
                    date: today, at: Date())
            }
            let (computedBuckets, granularityMatched) = computeBuckets(blocks: blockResults)
            let computedProjects = computeProjects(projects: projectResults, today: today)
            // Stale-while-revalidate fallback: if this fetch came back without
            // today data (e.g. daemon warm-up still running), keep the previous
            // view rather than show an empty chart. The next refresh replaces it.
            // Only retain data of the SAME granularity — an empty fine-grained
            // rolling window is a legitimate state (quiet hours) and must show
            // as a zero line, not freeze the previous buckets forever.
            let sameGranularity = state.hourlyData.first?.minutes == computedBuckets.first?.minutes
            let hourly = (computedBuckets.allSatisfy { $0.tokens == 0 }
                          && sameGranularity
                          && state.hourlyData.contains { $0.tokens > 0 })
                ? state.hourlyData : computedBuckets
            let projectRows = (computedProjects.isEmpty && !state.projects.isEmpty)
                ? state.projects : computedProjects
            let modelRows = computeModels(daily: dailyResults, today: today, complete: status.failedSources.isEmpty)
            let trendPoints = computeTrend(daily: dailyResults, complete: status.failedSources.isEmpty)

            // Detail state (cache-served, instant) — painted BEFORE quota so the
            // popover isn't blocked on upstream quota calls (which can take 1-2s).
            self.state.badgeImage = badgeImage
            let costLabel = costAvailable ? formatCost(totalCost) : "partial estimate"
            self.state.tooltipText = "TokenDash - \(tokenStr) tokens today (\(costLabel)) | cache: \(formatPercent(cacheRate))"
                + (status.warning.map { " | \($0)" } ?? "")
            self.state.todaySummary = summary
            self.state.cacheRate = cacheRate
            self.state.errorMessage = status.warning
            if !granularityMatched {
                NSLog("[TokenDash] blocks granularity mismatch — fell back to Today view")
            }
            self.state.hourlyData = hourly
            self.state.projects = projectRows
            self.state.models = modelRows
            self.state.trend = trendPoints

            // Quota refreshes async (upstream calls can take 1-2s); don't block
            // the detail paint. A manual refresh (forceQuota) still awaits so the
            // user sees the result of their explicit refresh.
            if forceQuota {
                await self.refreshQuota(force: true)
            } else {
                Task { await self.refreshQuota(force: false) }
            }
            // Launch warm-up intentionally does not advance the throttle. Timed,
            // popover, and manual refreshes do, even when the automatic paths are
            // cache-served.
            if shouldRecordRefreshTime {
                self.state.lastUpdatedAt = now()
            }
        } catch {
            NSLog("[TokenDash] full update error: \(error.localizedDescription)")
            self.state.errorMessage = error.localizedDescription
        }
    }

    /// Refresh Coding Plan quotas independently so it never blocks the detail
    /// paint (upstream provider calls can take 1-2s). `force` bypasses the 60s
    /// cache — used by the manual refresh button.
    private func refreshQuota(force: Bool) async {
        guard let api = apiClient else { return }
        do {
            let quotaResp = try await api.getQuota(refresh: force)
            let merged = retainUsableQuotas(quotaResp.providers, previous: state.quotas)
            state.quotas = merged
            NotificationService.shared.evaluate(quotas: merged)
        } catch {
            NSLog("[TokenDash] Quota fetch failed (non-fatal): \(error)")
        }
    }

    // MARK: - Pulse sampling (active only)

    /// Samples today's cumulative token count every activePulseInterval. This
    /// optional automatic path remains cache-aware like all non-manual refreshes.
    private func samplePulse() {
        guard let api = apiClient, !isPulseSampling else { return }
        isPulseSampling = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.isPulseSampling = false }
            do {
                let agents: [String]
                if self.activeAgents.isEmpty {
                    let resp = try await api.getAgents()
                    agents = resp.available.isEmpty ? ["claude"] : resp.available
                } else {
                    agents = self.activeAgents
                }
                let today = todayString()
                var totalTokens = 0, inputTokens = 0, outputTokens = 0, ok = 0
                for agent in agents {
                    do {
                        let r = try await api.getDaily(agent: agent, refresh: false)
                        if let e = r.daily.first(where: { $0.date == today }) {
                            totalTokens += e.totalTokens
                            inputTokens += e.inputTokens
                            outputTokens += e.outputTokens
                        }
                        ok += 1
                    } catch {
                        NSLog("[TokenDash] Pulse sample failed for \(agent): \(error)")
                    }
                }
                guard ok == agents.count else { return }
                self.recordPulseObservation(
                    totalTokens: totalTokens, inputTokens: inputTokens, outputTokens: outputTokens,
                    date: today, at: Date())
            } catch {
                NSLog("[TokenDash] Pulse sampling failed: \(error)")
            }
        }
    }

    private func recordPulseObservation(
        totalTokens: Int, inputTokens: Int, outputTokens: Int, date: String, at timestamp: Date
    ) {
        guard let previous = lastPulseObservation, previous.date == date else {
            lastPulseObservation = (date, timestamp, totalTokens, inputTokens, outputTokens)
            if let latest = state.pulseSamples.last,
               !Calendar.current.isDate(latest.timestamp, inSameDayAs: timestamp) {
                state.pulseSamples = []
                TokenPulseHistoryStore.shared.save([], now: timestamp)
            }
            return
        }
        let elapsed = timestamp.timeIntervalSince(previous.timestamp)
        guard elapsed > 0 else { return }
        // A lower total means the source was reset or reparsed. Reset the
        // baseline instead of drawing a false negative spike.
        let delta = totalTokens >= previous.totalTokens ? totalTokens - previous.totalTokens : 0
        let inputDelta = inputTokens >= previous.inputTokens ? inputTokens - previous.inputTokens : 0
        let outputDelta = outputTokens >= previous.outputTokens ? outputTokens - previous.outputTokens : 0
        let sample = TokenPulseSample(
            timestamp: timestamp,
            tokenDelta: delta,
            tokensPerSecond: Double(delta) / elapsed,
            inputDelta: inputDelta,
            outputDelta: outputDelta,
            inputTokensPerSecond: Double(inputDelta) / elapsed,
            outputTokensPerSecond: Double(outputDelta) / elapsed
        )
        let cutoff = timestamp.addingTimeInterval(-30 * 60)
        state.pulseSamples = (state.pulseSamples + [sample])
            .filter { $0.timestamp >= cutoff }
            .suffix(360)
            .map { $0 }
        TokenPulseHistoryStore.shared.save(state.pulseSamples, now: timestamp)
        lastPulseObservation = (date, timestamp, totalTokens, inputTokens, outputTokens)
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

    /// Blocks are always fetched at the finest granularity; every chart range
    /// derives from this one base locally, so switching tabs needs no refetch.
    private func computeBuckets(blocks: [BlocksResponse]) -> (buckets: [TimeBucket], matched: Bool) {
        let result = UsageBucketAggregator.aggregate(blocks, now: Date())
        guard result.granularityMatched else {
            // Legacy daemon ignored granularity — keep Today-shaped buckets so
            // the chart detects them and renders the Today view.
            return (UsageBucketAggregator.legacyHourBuckets(blocks, now: Date()), false)
        }
        return (result.buckets, true)
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
    /// that the summary loop discards), including cache reads and cache writes.
    private func computeModels(daily: [DailyResponse], today: String, complete: Bool) -> [ModelRow] {
        var totals: [String: (tokens: Int, cost: Double, costAvailable: Bool)] = [:]
        for data in daily {
            guard let entry = data.daily.first(where: { $0.date == today }) else { continue }
            for b in entry.modelBreakdowns ?? [] {
                let name = shortModelName(b.modelName)
                var t = totals[name] ?? (0, 0, complete)
                t.tokens += b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens
                t.cost += b.cost
                t.costAvailable = t.costAvailable && b.costAvailable != false
                totals[name] = t
            }
        }
        return totals.map { name, t in
            ModelRow(name: name, tokens: t.tokens, cost: t.cost, costAvailable: t.costAvailable)
        }.sorted { $0.tokens > $1.tokens }.prefix(5).map { $0 }
    }

    /// Last 7 days (oldest → newest) aggregated cost + tokens across all agents.
    private func computeTrend(daily: [DailyResponse], complete: Bool) -> [TrendPoint] {
        var byDate: [String: (tokens: Int, cost: Double, costAvailable: Bool)] = [:]
        for data in daily {
            for entry in data.daily {
                var t = byDate[entry.date] ?? (0, 0, complete)
                t.tokens += entry.totalTokens
                t.cost += entry.totalCost
                t.costAvailable = t.costAvailable && entry.costAvailable != false
                byDate[entry.date] = t
            }
        }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: Date())
        return (0..<7).reversed().map { i in
            guard let d = cal.date(byAdding: .day, value: -i, to: todayStart) else {
                return TrendPoint(date: "", tokens: 0, cost: 0)
            }
            let key = fmt.string(from: d)
            let t = byDate[key] ?? (0, 0, complete)
            return TrendPoint(date: key, tokens: t.tokens, cost: t.cost, costAvailable: t.costAvailable)
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
