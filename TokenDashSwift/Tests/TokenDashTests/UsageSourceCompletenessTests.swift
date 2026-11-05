import XCTest
@testable import TokenDash

@MainActor
final class UsageSourceCompletenessTests: XCTestCase {
    func testLegacyPayloadAndUnknownPriceDecodeSeparately() throws {
        let base = "\"date\":\"2026-11-05\",\"inputTokens\":10,\"outputTokens\":20,\"cacheCreationTokens\":0,\"cacheReadTokens\":0,\"totalTokens\":30,\"totalCost\":0"
        let old = try JSONDecoder().decode(DailyEntry.self, from: Data("{\(base)}".utf8))
        let unknown = try JSONDecoder().decode(DailyEntry.self, from: Data("{\(base),\"costAvailable\":false}".utf8))
        XCTAssertNil(old.costAvailable)
        XCTAssertEqual(unknown.costAvailable, false)
    }

    func testMixedSourcesKeepHealthyUsageAndShowPartialState() async {
        let state = AppState()
        let api = PartialUsageAPI(agents: ["claude", "deepseek"], failing: ["deepseek"])
        let updater = BadgeUpdater(state: state, client: api)
        await updater.performFullUpdate(forceRefresh: true, forceQuota: true)

        XCTAssertEqual(state.todaySummary?.tokens, 1200)
        XCTAssertEqual(state.todaySummary?.cacheWriteTokens, 300)
        XCTAssertEqual(state.todaySummary?.cacheRate ?? -1, 60, accuracy: 0.0001)
        XCTAssertEqual(state.todaySummary?.costAvailable, false)
        XCTAssertTrue(state.errorMessage?.contains("deepseek") == true)
        XCTAssertTrue(state.tooltipText.contains("partial estimate"))
        XCTAssertEqual(state.models.first?.tokens, 1200, "Model totals must include cache writes")
        XCTAssertEqual(state.models.first?.costAvailable, false)
        XCTAssertEqual(state.trend.last?.costAvailable, false)
    }

    func testAllFailedRefreshPreservesPreviousSummaryAndBadge() async {
        let state = AppState()
        state.todaySummary = TodaySummary(tokens: 42, cost: 2, inputTokens: 20,
                                         outputTokens: 22, cacheReadTokens: 0, cacheRate: 0)
        state.tooltipText = "previous badge"
        let api = PartialUsageAPI(agents: ["deepseek"], failing: ["deepseek"])
        let updater = BadgeUpdater(state: state, client: api)

        await updater.performFullUpdate(forceRefresh: true, forceQuota: true)
        XCTAssertEqual(state.todaySummary?.tokens, 42)
        XCTAssertEqual(state.tooltipText, "previous badge")
        XCTAssertNotNil(state.errorMessage)

        await updater.performBadgeUpdate()
        XCTAssertEqual(state.tooltipText, "previous badge")
        XCTAssertEqual(state.todaySummary?.tokens, 42)
        XCTAssertNotNil(state.errorMessage)
    }

    func testUnknownPriceKeepsTokensAndPropagatesToModelsAndTrend() async {
        let state = AppState()
        let api = PartialUsageAPI(agents: ["deepseek"], priceAvailable: false)
        let updater = BadgeUpdater(state: state, client: api)
        await updater.performFullUpdate(forceRefresh: true, forceQuota: true)

        XCTAssertEqual(state.todaySummary?.tokens, 1200)
        XCTAssertEqual(state.todaySummary?.costAvailable, false)
        XCTAssertEqual(state.models.first?.costAvailable, false)
        XCTAssertEqual(state.trend.last?.costAvailable, false)
        XCTAssertNil(state.errorMessage, "Unknown pricing does not mean the usage source failed")
        XCTAssertTrue(state.tooltipText.contains("partial estimate"))
    }

    func testNoInstalledSourcesIsNotAllFailed() async {
        let state = AppState()
        let updater = BadgeUpdater(state: state, client: PartialUsageAPI(agents: []))
        await updater.performFullUpdate(forceRefresh: false, forceQuota: true)
        XCTAssertEqual(state.todaySummary?.tokens, 0)
        XCTAssertNil(state.errorMessage)
    }
}

private actor PartialUsageAPI: APIClientProtocol {
    let agents: [String]
    let failing: Set<String>
    let priceAvailable: Bool

    init(agents: [String], failing: Set<String> = [], priceAvailable: Bool = true) {
        self.agents = agents
        self.failing = failing
        self.priceAvailable = priceAvailable
    }

    func getAgents() async throws -> AgentsResponse {
        AgentsResponse(available: agents, default: agents.first)
    }

    func getDaily(agent: String, refresh: Bool) async throws -> DailyResponse {
        try check(agent)
        let model = ModelBreakdown(modelName: "deepseek-flash", inputTokens: 100,
                                   outputTokens: 200, cacheCreationTokens: 300,
                                   cacheReadTokens: 600, cost: 2,
                                   costAvailable: priceAvailable)
        return DailyResponse(daily: [DailyEntry(date: todayString(), inputTokens: 100,
                                               outputTokens: 200, cacheCreationTokens: 300,
                                               cacheReadTokens: 600, totalTokens: 1200,
                                               totalCost: 2, modelsUsed: ["deepseek-flash"],
                                               modelBreakdowns: [model], costAvailable: priceAvailable)])
    }

    func getBlocks(agent: String, refresh: Bool, granularity: BlocksGranularity) async throws -> BlocksResponse {
        try check(agent)
        return BlocksResponse(blocks: [])
    }

    func getProjects(agent: String, refresh: Bool) async throws -> ProjectsResponse {
        try check(agent)
        return ProjectsResponse(projects: [:])
    }

    func getQuota(refresh: Bool) async throws -> QuotaResponse { QuotaResponse(providers: []) }

    private func check(_ agent: String) throws {
        if failing.contains(agent) {
            throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing decoder"])
        }
    }
}
