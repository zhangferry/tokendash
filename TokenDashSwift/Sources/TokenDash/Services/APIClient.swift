import Foundation

/// Lightweight HTTP client for the local TokenDash API.
actor APIClient {
    private let baseURL: String

    init(port: Int) {
        self.baseURL = "http://127.0.0.1:\(port)/api"
    }

    func getAgents() async throws -> AgentsResponse {
        try await fetch("/agents")
    }

    func getDaily(agent: String) async throws -> DailyResponse {
        try await fetch("/daily?agent=\(agent)")
    }

    func getBlocks(agent: String) async throws -> BlocksResponse {
        try await fetch("/blocks?agent=\(agent)")
    }

    func getProjects(agent: String) async throws -> ProjectsResponse {
        try await fetch("/projects?agent=\(agent)")
    }

    func getQuota() async throws -> QuotaResponse {
        try await fetch("/quota")
    }

    /// Health check — returns true if the API is responding.
    func healthCheck() async -> Bool {
        do {
            _ = try await getAgents()
            return true
        } catch {
            return false
        }
    }

    // MARK: - Private

    private func fetch<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw APIClientError.invalidURL
        }
        let t0 = CFAbsoluteTimeGetCurrent()
        let (data, response) = try await URLSession.shared.data(from: url)
        let t1 = CFAbsoluteTimeGetCurrent()
        let http = response as? HTTPURLResponse
        guard http?.statusCode == 200 else {
            throw APIClientError.httpError(http?.statusCode ?? -1)
        }
        let result = try JSONDecoder().decode(T.self, from: data)
        let t2 = CFAbsoluteTimeGetCurrent()
        NSLog("[TokenDash] fetch \(path): network=\(String(format: "%.0f", (t1-t0)*1000))ms decode=\(String(format: "%.0f", (t2-t1)*1000))ms size=\(data.count)B")
        return result
    }
}

enum APIClientError: LocalizedError {
    case invalidURL
    case httpError(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid API URL"
        case .httpError(let code): return "HTTP error \(code)"
        }
    }
}
