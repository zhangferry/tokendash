import XCTest
@testable import TokenDash

@MainActor
final class BadgeUpdaterModeTests: XCTestCase {

    // MARK: - dormant: badge 更新只强刷 daily，不拉 blocks/projects/quota

    func testDormantPerformBadgeUpdateForceRefreshesDailyButSkipsBlocksProjectsQuota() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performBadgeUpdate()

        let counts = await mock.snapshot()
        XCTAssertGreaterThan(counts.daily, 0, "Dormant badge refresh must fetch daily usage")
        let lastDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(lastDailyRefresh, true, "Menu bar tokens must bypass the daemon response cache to stay current")
        XCTAssertEqual(counts.blocks, 0, "Dormant mode must not fetch blocks")
        XCTAssertEqual(counts.projects, 0, "Dormant mode must not fetch projects")
        XCTAssertEqual(counts.quota, 0, "Dormant mode must not fetch quota")
    }

    // MARK: - active: 自动刷新详情与 quota 都走缓存

    func testActivePerformFullUpdateFetchesDetailsButCachesQuota() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performFullUpdate(forceRefresh: false, forceQuota: false, recordRefreshTime: true)
        // Detail state paints synchronously; quota refreshes async — give the
        // detached quota task a moment to run before asserting on it.
        try await Task.sleep(nanoseconds: 200_000_000)  // 0.2s

        let counts = await mock.snapshot()
        XCTAssertGreaterThan(counts.daily, 0)
        XCTAssertGreaterThan(counts.blocks, 0)
        XCTAssertGreaterThan(counts.projects, 0)
        XCTAssertGreaterThan(counts.quota, 0, "Active detail refresh must eventually fetch quota asynchronously")
        let lastQuotaRefresh = await mock.lastQuotaRefresh
        XCTAssertEqual(lastQuotaRefresh, false, "Automatic quota refresh must use the cache")
        let lastDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(lastDailyRefresh, false, "Automatic detail refresh must use the cache")
        XCTAssertNotNil(state.lastUpdatedAt, "Completed automatic refresh must record its throttle timestamp")
    }


    func testActiveModeSchedulesFreshDetailRefreshWhilePopoverIsOpen() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(
            state: state,
            client: mock,
            activeDetailInterval: 0.05
        )

        updater.setMode(.active)
        try await waitUntil {
            await mock.dailyCallCount >= 2
        }
        updater.stop()

        let counts = await mock.snapshot()
        XCTAssertGreaterThanOrEqual(counts.daily, 2, "An open popover must keep refreshing details without waiting for the background interval")
        let lastDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(lastDailyRefresh, true, "Active detail refresh must bypass the usage response cache")
    }

    // MARK: - 手动刷新：quota 强刷

    func testManualRefreshForceRefreshesQuota() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performFullUpdate(forceRefresh: true, forceQuota: true)

        let lastQuotaRefresh = await mock.lastQuotaRefresh
        XCTAssertEqual(lastQuotaRefresh, true, "Manual refresh must force a quota refresh")
        XCTAssertNotNil(state.lastUpdatedAt, "Completed manual refresh must record its timestamp")
        XCTAssertFalse(state.isRefreshing, "Completed manual refresh must clear the loading state")
    }

    func testCacheServedLaunchPrimeDoesNotThrottleFirstPopoverRefresh() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        var now = Date(timeIntervalSinceReferenceDate: 1_000)
        let updater = BadgeUpdater(
            state: state,
            client: mock,
            now: { now },
            popoverRefreshInterval: 30 * 60
        )

        await updater.performFullUpdate(forceRefresh: false, forceQuota: false)
        let launchCounts = await mock.snapshot()
        let launchDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(launchDailyRefresh, false, "launch warm-up must stay cache-served")
        XCTAssertNil(state.lastUpdatedAt, "cache-served launch warm-up must not start the popover fresh-data throttle")

        now.addTimeInterval(60)
        let refreshedOnOpen = await updater.refreshOnPopoverOpenIfNeeded()

        XCTAssertTrue(refreshedOnOpen, "the first popover open after launch must still perform a cache-aware refresh")
        let openedCounts = await mock.snapshot()
        XCTAssertGreaterThan(openedCounts.daily, launchCounts.daily)
        XCTAssertGreaterThan(openedCounts.blocks, launchCounts.blocks)
        XCTAssertGreaterThan(openedCounts.projects, launchCounts.projects)
        let openDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(openDailyRefresh, false, "popover open is automatic and must not bypass daemon caches")
        XCTAssertNotNil(state.lastUpdatedAt, "popover refresh should record the throttle timestamp")
    }

    func testPopoverOpenDuringLaunchWarmupQueuesFreshRefresh() async throws {
        let state = AppState()
        let mock = BlockingAPIClient()
        let updater = BadgeUpdater(
            state: state,
            client: mock,
            popoverRefreshInterval: 30 * 60
        )

        let launchTask = Task { await updater.performFullUpdate(forceRefresh: false, forceQuota: false) }
        await mock.waitUntilFirstDailyIsBlocked()
        updater.setMode(.active)

        let refreshedImmediately = await updater.refreshOnPopoverOpenIfNeeded()
        XCTAssertFalse(refreshedImmediately, "an in-flight launch warm-up cannot be interrupted synchronously")

        await mock.releaseFirstDaily()
        await launchTask.value
        try await waitUntil {
            await mock.dailyCallCount >= 2 && state.lastUpdatedAt != nil
        }

        let lastDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(lastDailyRefresh, false, "queued automatic popover refresh must stay cache-aware")
        XCTAssertNotNil(state.lastUpdatedAt, "queued popover refresh should record the throttle timestamp")
    }

    func testPopoverRefreshIsThrottledForThirtyMinutes() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        var now = Date(timeIntervalSinceReferenceDate: 1_000)
        let updater = BadgeUpdater(
            state: state,
            client: mock,
            now: { now },
            popoverRefreshInterval: 30 * 60
        )

        let refreshedInitially = await updater.refreshOnPopoverOpenIfNeeded()
        XCTAssertTrue(refreshedInitially)
        let firstCounts = await mock.snapshot()
        XCTAssertGreaterThan(firstCounts.daily, 0)
        let firstDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(firstDailyRefresh, false)

        now.addTimeInterval(29 * 60 + 59)
        let refreshedBeforeInterval = await updater.refreshOnPopoverOpenIfNeeded()
        XCTAssertFalse(refreshedBeforeInterval)
        let throttledCounts = await mock.snapshot()
        XCTAssertEqual(throttledCounts.daily, firstCounts.daily)

        now.addTimeInterval(2)
        let refreshedAfterInterval = await updater.refreshOnPopoverOpenIfNeeded()
        XCTAssertTrue(refreshedAfterInterval)
        let finalCounts = await mock.snapshot()
        XCTAssertGreaterThan(finalCounts.daily, firstCounts.daily)
    }

    func testBackgroundRefreshUsesCachedDetailsAndQuota() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performBackgroundRefresh()
        try await waitUntil { await mock.lastQuotaRefresh != nil }

        let lastDailyRefresh = await mock.lastDailyRefresh
        let lastQuotaRefresh = await mock.lastQuotaRefresh
        XCTAssertEqual(lastDailyRefresh, false, "Scheduled background refresh must reuse the detail cache")
        XCTAssertEqual(lastQuotaRefresh, false, "Scheduled background refresh must reuse the quota cache")
        XCTAssertNotNil(state.lastUpdatedAt)
        XCTAssertFalse(state.isRefreshing)
    }

    func testPopoverOpenAutoRefreshUsesMostRecentFullRefreshTime() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        var now = Date(timeIntervalSinceReferenceDate: 1_000)
        let updater = BadgeUpdater(
            state: state,
            client: mock,
            now: { now },
            popoverRefreshInterval: 30 * 60
        )

        await updater.performBackgroundRefresh()
        let backgroundCounts = await mock.snapshot()
        XCTAssertNotNil(state.lastUpdatedAt)

        now.addTimeInterval(10 * 60)
        let refreshedOnOpen = await updater.refreshOnPopoverOpenIfNeeded()

        XCTAssertFalse(refreshedOnOpen, "Automatic popover refresh must share the latest background or manual refresh throttle")
        let openedCounts = await mock.snapshot()
        XCTAssertEqual(openedCounts.daily, backgroundCounts.daily)
        XCTAssertEqual(openedCounts.blocks, backgroundCounts.blocks)
        XCTAssertEqual(openedCounts.projects, backgroundCounts.projects)
    }

    func testRefreshIntervalSettingsExposeDetailRefreshCadences() {
        XCTAssertEqual(
            SettingsStore.RefreshInterval.allCases.map(\.rawValue),
            [10 * 60, 30 * 60, 60 * 60].map(Double.init)
        )
        XCTAssertEqual(SettingsStore.RefreshInterval.oneHour.label, "1 hour (Low Power)")
        XCTAssertNil(SettingsStore.RefreshInterval(rawValue: 30), "legacy badge cadence should fall back to the one-hour default")
    }

    // MARK: - realtime (15M) tab

    func testRealtimeRangeChangePrimesOneMinuteFetchWhenActive() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)
        let original = SettingsStore.shared.hourlyRange
        defer { SettingsStore.shared.hourlyRange = original }

        updater.setMode(.active)
        // Let the popover-open detail refresh finish first so its .fiveMin
        // blocks call cannot race the realtime assertion below.
        try await waitUntil { !state.isRefreshing && state.lastUpdatedAt != nil }

        SettingsStore.shared.hourlyRange = .fifteenMinutes
        updater.realtimeRangeDidChange()
        try await waitUntil { state.realtimeBuckets.first?.minutes == 1 }

        let lastBlocksRefresh = await mock.lastBlocksRefresh
        XCTAssertEqual(lastBlocksRefresh, false, "Realtime polling must use cached responses (refresh=false)")
    }

    func testRealtimeFetchStaysOffOutsidePopover() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)
        let original = SettingsStore.shared.hourlyRange
        defer { SettingsStore.shared.hourlyRange = original }

        SettingsStore.shared.hourlyRange = .fifteenMinutes
        updater.setMode(.dormant)   // popover closed
        updater.realtimeRangeDidChange()
        try await Task.sleep(nanoseconds: 200_000_000)  // 0.2s

        let counts = await mock.snapshot()
        XCTAssertEqual(counts.blocks, 0, "Realtime data must not be polled while the popover is closed")
    }

    // MARK: - stale-while-revalidate vs empty fine-grained windows

    func testEmptyFiveMinuteBaseDoesNotFreezePreviousTodayBuckets() async throws {
        let state = AppState()
        // Simulate a populated legacy Today view (60-min buckets with usage).
        state.hourlyData = [TimeBucket](
            repeating: TimeBucket(start: Date(), minutes: 60, tokens: 100, isPeak: false),
            count: 24)
        let mock = MockAPIClient()   // returns empty blocks — daemon warm-up
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performFullUpdate(forceRefresh: false, forceQuota: false)

        XCTAssertEqual(
            state.hourlyData.first?.minutes, 5,
            "an empty 5-minute base must replace the mismatched legacy buckets, not keep them frozen")
        XCTAssertTrue(state.hourlyData.allSatisfy { $0.tokens == 0 })
    }

    // MARK: - hourly range granularity

    func testFullUpdateAlwaysFetchesFiveMinuteBase() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)
        let original = SettingsStore.shared.hourlyRange
        defer { SettingsStore.shared.hourlyRange = original }

        for range in [SettingsStore.HourlyRange.oneDay, .threeHours, .fifteenMinutes] {
            SettingsStore.shared.hourlyRange = range
            await updater.performFullUpdate(forceRefresh: false, forceQuota: false)
            let granularity = await mock.lastBlocksGranularity
            XCTAssertEqual(granularity, .fiveMin, "All ranges must share one 5-minute base (\(range))")
        }
    }

    func testFineGrainedRangeTightensPopoverThrottleToFiveMinutes() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        var now = Date(timeIntervalSinceReferenceDate: 1_000)
        let updater = BadgeUpdater(
            state: state, client: mock, now: { now }, popoverRefreshInterval: 30 * 60
        )
        let original = SettingsStore.shared.hourlyRange
        defer { SettingsStore.shared.hourlyRange = original }

        await updater.performFullUpdate(forceRefresh: true, forceQuota: false)
        let countsAfterFirst = await mock.snapshot().daily

        now.addTimeInterval(6 * 60)   // 6min：30min 节流内、5min 节流外
        SettingsStore.shared.hourlyRange = .fifteenMinutes
        let refreshed = await updater.refreshOnPopoverOpenIfNeeded()
        XCTAssertTrue(refreshed, "The 15M popover refresh throttle must tighten to 5 minutes")
        let countsAfterOpen = await mock.snapshot().daily
        XCTAssertGreaterThan(countsAfterOpen, countsAfterFirst)
    }
}

/// 计数型 mock — 记录每个端点被调用的次数与关键参数，供模式断言。
actor MockAPIClient: APIClientProtocol {
    private let quotaResponse: QuotaResponse
    private(set) var agents = 0
    private(set) var daily = 0
    private(set) var blocks = 0
    private(set) var projects = 0
    private(set) var quota = 0
    private(set) var lastQuotaRefresh: Bool? = nil
    private(set) var lastDailyRefresh: Bool? = nil
    private(set) var lastBlocksGranularity: BlocksGranularity? = nil
    var dailyCallCount: Int { daily }

    struct Snapshot {
        let agents: Int; let daily: Int; let blocks: Int
        let projects: Int; let quota: Int
    }

    init(quotaResponse: QuotaResponse = QuotaResponse(providers: [])) {
        self.quotaResponse = quotaResponse
    }

    func snapshot() -> Snapshot {
        Snapshot(agents: agents, daily: daily, blocks: blocks, projects: projects, quota: quota)
    }

    func getAgents() async throws -> AgentsResponse {
        agents += 1
        return AgentsResponse(available: ["claude"], default: "claude")
    }
    func getDaily(agent: String, refresh: Bool) async throws -> DailyResponse {
        daily += 1
        lastDailyRefresh = refresh
        return DailyResponse(daily: [])
    }
    private(set) var lastBlocksRefresh: Bool? = nil
    func getBlocks(agent: String, refresh: Bool, granularity: BlocksGranularity = .hour) async throws -> BlocksResponse {
        blocks += 1
        lastBlocksGranularity = granularity
        lastBlocksRefresh = refresh
        return BlocksResponse(blocks: [])
    }
    func getProjects(agent: String, refresh: Bool) async throws -> ProjectsResponse {
        projects += 1
        return ProjectsResponse(projects: [:])
    }
    func getQuota(refresh: Bool) async throws -> QuotaResponse {
        quota += 1
        lastQuotaRefresh = refresh
        return quotaResponse
    }
}


private func waitUntil(
    timeoutNanoseconds: UInt64 = 1_000_000_000,
    condition: @escaping () async -> Bool
) async throws {
    let start = DispatchTime.now().uptimeNanoseconds
    while DispatchTime.now().uptimeNanoseconds - start < timeoutNanoseconds {
        if await condition() { return }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("Timed out waiting for async condition")
}

actor BlockingAPIClient: APIClientProtocol {
    private(set) var dailyCallCount = 0
    private(set) var lastDailyRefresh: Bool? = nil
    private var shouldBlockFirstDaily = true
    private var firstDailyContinuation: CheckedContinuation<Void, Never>?
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []

    func waitUntilFirstDailyIsBlocked() async {
        if firstDailyContinuation != nil { return }
        await withCheckedContinuation { continuation in
            blockedWaiters.append(continuation)
        }
    }

    func releaseFirstDaily() {
        firstDailyContinuation?.resume()
        firstDailyContinuation = nil
    }

    func getAgents() async throws -> AgentsResponse {
        AgentsResponse(available: ["claude"], default: "claude")
    }

    func getDaily(agent: String, refresh: Bool) async throws -> DailyResponse {
        dailyCallCount += 1
        lastDailyRefresh = refresh
        if shouldBlockFirstDaily {
            shouldBlockFirstDaily = false
            await withCheckedContinuation { continuation in
                firstDailyContinuation = continuation
                let waiters = blockedWaiters
                blockedWaiters.removeAll()
                waiters.forEach { $0.resume() }
            }
        }
        return DailyResponse(daily: [])
    }

    func getBlocks(agent: String, refresh: Bool, granularity: BlocksGranularity = .hour) async throws -> BlocksResponse {
        BlocksResponse(blocks: [])
    }

    func getProjects(agent: String, refresh: Bool) async throws -> ProjectsResponse {
        ProjectsResponse(projects: [:])
    }

    func getQuota(refresh: Bool) async throws -> QuotaResponse {
        QuotaResponse(providers: [])
    }
}

