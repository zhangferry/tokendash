import Foundation

// MARK: - API Response Models (mirrors src/shared/types.ts)

struct AgentsResponse: Codable {
    let available: [String]
    let `default`: String?
}

struct AppInfoResponse: Codable {
    let packageName: String
    let version: String
    let dashboardUrl: String?
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


// MARK: - App Settings Models

struct AppSettingsResponse: Codable {
    let codex: CodexSettingsResponse
}

struct CodexSettingsResponse: Codable {
    let officialDataPaths: [String]
    let environmentDataPaths: [String]
    let customDataPaths: [String]
    let resolvedDataPaths: [CodexDataPathStatusResponse]
}

struct CodexDataPathStatusResponse: Codable, Identifiable {
    let path: String
    let kind: String
    let readable: Bool
    let sessionDirs: [String]
    var id: String { "\(kind):\(path)" }
}

struct CodexDataPathsRequest: Encodable {
    let paths: [String]
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

struct QuotaCredentialValidationResponse: Codable {
    let provider: String
    let valid: Bool
    let status: QuotaProviderStatus
}

// MARK: - Model + Trend UI models

/// One model's share of today's usage (aggregated across all agents).
struct ModelRow: Identifiable {
    let name: String
    let tokens: Int
    let cost: Double
    var id: String { name }
}

/// One day in the 7-day cost/token trend.
struct TrendPoint: Identifiable {
    let date: String   // "yyyy-MM-dd"
    let tokens: Int
    let cost: Double
    var id: String { date }
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

/// One five-second observation used by the 30-minute Token Pulse chart.
struct TokenPulseSample: Codable, Identifiable {
    let timestamp: Date
    let tokenDelta: Int
    let tokensPerSecond: Double
    let inputDelta: Int
    let outputDelta: Int
    let inputTokensPerSecond: Double
    let outputTokensPerSecond: Double
    var id: Date { timestamp }

    init(
        timestamp: Date,
        tokenDelta: Int,
        tokensPerSecond: Double,
        inputDelta: Int = 0,
        outputDelta: Int = 0,
        inputTokensPerSecond: Double = 0,
        outputTokensPerSecond: Double = 0
    ) {
        self.timestamp = timestamp
        self.tokenDelta = tokenDelta
        self.tokensPerSecond = tokensPerSecond
        self.inputDelta = inputDelta
        self.outputDelta = outputDelta
        self.inputTokensPerSecond = inputTokensPerSecond
        self.outputTokensPerSecond = outputTokensPerSecond
    }

    private enum CodingKeys: String, CodingKey {
        case timestamp, tokenDelta, tokensPerSecond
        case inputDelta, outputDelta, inputTokensPerSecond, outputTokensPerSecond
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        timestamp = try values.decode(Date.self, forKey: .timestamp)
        tokenDelta = try values.decode(Int.self, forKey: .tokenDelta)
        tokensPerSecond = try values.decode(Double.self, forKey: .tokensPerSecond)
        inputDelta = try values.decodeIfPresent(Int.self, forKey: .inputDelta) ?? 0
        outputDelta = try values.decodeIfPresent(Int.self, forKey: .outputDelta) ?? 0
        inputTokensPerSecond = try values.decodeIfPresent(Double.self, forKey: .inputTokensPerSecond) ?? 0
        outputTokensPerSecond = try values.decodeIfPresent(Double.self, forKey: .outputTokensPerSecond) ?? 0
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(timestamp, forKey: .timestamp)
        try values.encode(tokenDelta, forKey: .tokenDelta)
        try values.encode(tokensPerSecond, forKey: .tokensPerSecond)
        try values.encode(inputDelta, forKey: .inputDelta)
        try values.encode(outputDelta, forKey: .outputDelta)
        try values.encode(inputTokensPerSecond, forKey: .inputTokensPerSecond)
        try values.encode(outputTokensPerSecond, forKey: .outputTokensPerSecond)
    }
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
