import XCTest
@testable import TokenDash

@MainActor
final class BadgeUpdaterModeTests: XCTestCase {

    // MARK: - dormant: badge 更新只拉 daily，不拉 blocks/projects/quota

    func testDormantPerformBadgeUpdateSkipsBlocksProjectsQuota() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performBadgeUpdate()

        let counts = await mock.snapshot()
        XCTAssertGreaterThan(counts.daily, 0, "dormant badge 更新必须拉 daily")
        XCTAssertEqual(counts.blocks, 0, "dormant 不得拉 blocks")
        XCTAssertEqual(counts.projects, 0, "dormant 不得拉 projects")
        XCTAssertEqual(counts.quota, 0, "dormant 不得拉 quota")
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
        XCTAssertGreaterThan(counts.quota, 0, "active 详情刷新最终要拉 quota（异步）")
        let lastQuotaRefresh = await mock.lastQuotaRefresh
        XCTAssertEqual(lastQuotaRefresh, false, "非手动刷新时 quota 必须走缓存")
        let lastDailyRefresh = await mock.lastDailyRefresh
        XCTAssertEqual(lastDailyRefresh, false, "非手动刷新时详情必须走缓存")
        XCTAssertNotNil(state.lastUpdatedAt, "完成自动刷新后必须记录节流时间")
    }

    // MARK: - 手动刷新：quota 强刷

    func testManualRefreshForceRefreshesQuota() async throws {
        let state = AppState()
        let mock = MockAPIClient()
        let updater = BadgeUpdater(state: state, client: mock)

        await updater.performFullUpdate(forceRefresh: true, forceQuota: true)

        let lastQuotaRefresh = await mock.lastQuotaRefresh
        XCTAssertEqual(lastQuotaRefresh, true, "手动刷新必须强刷 quota")
        XCTAssertNotNil(state.lastUpdatedAt, "手动刷新完成后必须记录最近刷新时间")
        XCTAssertFalse(state.isRefreshing, "手动刷新完成后必须退出 loading 状态")
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
        XCTAssertEqual(lastDailyRefresh, false, "定时后台刷新必须复用详情缓存")
        XCTAssertEqual(lastQuotaRefresh, false, "定时后台刷新必须复用 quota 缓存")
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

        XCTAssertFalse(refreshedOnOpen, "打开菜单栏的自动刷新必须把最近一次后台/手动全量刷新也算进同一个节流周期")
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
}

/// 计数型 mock — 记录每个端点被调用的次数与关键参数，供模式断言。
actor MockAPIClient: APIClientProtocol {
    private(set) var agents = 0
    private(set) var daily = 0
    private(set) var blocks = 0
    private(set) var projects = 0
    private(set) var quota = 0
    private(set) var lastQuotaRefresh: Bool? = nil
    private(set) var lastDailyRefresh: Bool? = nil

    struct Snapshot {
        let agents: Int; let daily: Int; let blocks: Int
        let projects: Int; let quota: Int
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
    func getBlocks(agent: String, refresh: Bool) async throws -> BlocksResponse {
        blocks += 1
        return BlocksResponse(blocks: [])
    }
    func getProjects(agent: String, refresh: Bool) async throws -> ProjectsResponse {
        projects += 1
        return ProjectsResponse(projects: [:])
    }
    func getQuota(refresh: Bool) async throws -> QuotaResponse {
        quota += 1
        lastQuotaRefresh = refresh
        return QuotaResponse(providers: [])
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

    func getBlocks(agent: String, refresh: Bool) async throws -> BlocksResponse {
        BlocksResponse(blocks: [])
    }

    func getProjects(agent: String, refresh: Bool) async throws -> ProjectsResponse {
        ProjectsResponse(projects: [:])
    }

    func getQuota(refresh: Bool) async throws -> QuotaResponse {
        QuotaResponse(providers: [])
    }
}
