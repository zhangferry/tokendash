import Foundation

/// Tracks source health separately from valid empty usage responses.
struct UsageFetchStatus {
    private(set) var successes = 0
    private(set) var failedSources: Set<String> = []

    mutating func succeeded() { successes += 1 }
    mutating func failed(_ source: String) { failedSources.insert(source) }

    var warning: String? {
        guard !failedSources.isEmpty else { return nil }
        return "Partial usage: \(failedSources.sorted().joined(separator: ", ")) unavailable."
    }

    func requireSuccess(sourceCount: Int) throws {
        if sourceCount > 0 && successes == 0 {
            throw NSError(domain: "TokenDash", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Unable to fetch usage from any source. Retrying…"])
        }
    }
}
