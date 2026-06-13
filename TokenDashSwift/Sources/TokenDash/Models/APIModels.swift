import Foundation

// MARK: - API Response Models (mirrors src/shared/types.ts)

struct AgentsResponse: Codable {
    let available: [String]
    let `default`: String?
}

struct DailyEntry: Codable {
    let date: String
    let inputTokens: Int
    let outputTokens: Int
    let cacheCreationTokens: Int
    let cacheReadTokens: Int
    let totalTokens: Int
    let totalCost: Double
    let modelsUsed: [String]?
    let modelBreakdowns: [ModelBreakdown]?
}

struct ModelBreakdown: Codable {
    let modelName: String
    let inputTokens: Int
    let outputTokens: Int
    let cacheCreationTokens: Int
    let cacheReadTokens: Int
    let cost: Double
}

struct DailyResponse: Codable {
    let daily: [DailyEntry]
}

struct BlockEntry: Codable {
    let startTime: String
    let totalTokens: Int
}

struct BlocksResponse: Codable {
    let blocks: [BlockEntry]
}

struct ProjectsResponse: Codable {
    let projects: [String: [DailyEntry]]
}

// MARK: - Quota (Coding Plan) Models

struct QuotaResponse: Codable {
    let providers: [QuotaSnapshot]
}

struct QuotaSnapshot: Codable, Identifiable {
    let provider: String
    let displayName: String
    let planName: String?
    let fetchedAt: String
    let freshness: String
    let windows: [QuotaWindow]
    let status: QuotaProviderStatus
    var id: String { provider }
}

struct QuotaWindow: Codable, Identifiable {
    let id: String
    let label: String
    let usedPercent: Double
    let remainingPercent: Double
    let used: Int?
    let limit: Int?
    let durationMins: Int?
    let resetsAt: String?
    let isUnlimited: Bool?
    let modelName: String?
}

struct QuotaProviderStatus: Codable {
    let state: String
    let message: String?
    let category: String?
}

// MARK: - Derived UI Models

struct TodaySummary {
    let tokens: Int
    let cost: Double
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheRate: Double
}

struct HourBucket: Identifiable {
    let hour: Int
    let tokens: Int
    let isPeak: Bool
    var id: Int { hour }
}

struct ProjectRow: Identifiable {
    let name: String
    let fullPath: String
    let input: Int
    let output: Int
    let cached: Int
    let total: Int
    var id: String { fullPath }
}
