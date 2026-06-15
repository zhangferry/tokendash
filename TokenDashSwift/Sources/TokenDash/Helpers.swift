import Foundation
import SwiftUI
import AppKit

// MARK: - Adaptive Colors (Light / Dark)

extension Color {
    // Accent green
    static let accentGreen = Color(red: 0.176, green: 0.541, blue: 0.431)
    static let accentGreenLight = Color(red: 0.176, green: 0.541, blue: 0.431).opacity(0.5)
    // Breakdown colors
    static let inputColor = Color(red: 0.176, green: 0.541, blue: 0.431)
    static let outputColor = Color(red: 0.357, green: 0.494, blue: 0.898)
    static let cachedColor = Color(red: 0.831, green: 0.573, blue: 0.165)
    // Agent dot colors
    static let claudeAgentColor = Color(red: 0.176, green: 0.541, blue: 0.431)
    static let codexAgentColor = Color(red: 0.357, green: 0.494, blue: 0.898)
    static let openclawAgentColor = Color(red: 0.608, green: 0.427, blue: 0.843)
    static let opencodeAgentColor = Color(red: 0.608, green: 0.427, blue: 0.843)
    // Semantic adaptive colors
    static let sectionTitleColor: Color = .primary.opacity(0.4)
    static let dividerColor: Color = .primary.opacity(0.06)
    static let futureLabelColor: Color = .primary.opacity(0.15)
    static let barTrackColor: Color = .primary.opacity(0.04)
    static let secondaryLabel: Color = .primary.opacity(0.45)
    static let tertiaryLabel: Color = .primary.opacity(0.3)
    // Use the system semantic surface so appearance changes are resolved by
    // SwiftUI/AppKit instead of maintaining a parallel light/dark palette.
    static let popoverBackground = Color(nsColor: .windowBackgroundColor)
    static let headerBackground = Color(nsColor: .windowBackgroundColor)
}

// MARK: - Number formatting

func formatTokens(_ tokens: Int) -> String {
    if tokens >= 1_000_000 { return String(format: "%.1fM", Double(tokens) / 1_000_000) }
    if tokens >= 1_000 { return String(format: "%.1fK", Double(tokens) / 1_000) }
    if tokens > 0 { return String(tokens) }
    return "0"
}

func formatCost(_ cost: Double) -> String {
    let value = abs(cost)
    if value < 0.05 { return "$0" }
    if value < 10 { return String(format: "$%.2f", cost) }
    if value < 100 { return String(format: "$%.1f", cost) }
    return String(format: "$%.0f", cost)
}

func formatPercent(_ value: Double) -> String {
    String(format: "%.1f%%", value)
}

func formatProjectName(_ path: String) -> String {
    let parts = path.split(separator: "/").map(String.init)
    return parts.last ?? path
}

/// Shorten a model id for display: claude-sonnet-4-6 → "Sonnet 4", GLM-5.1 → "GLM-5.1".
func shortModelName(_ id: String) -> String {
    let lower = id.lowercased()
    let type: String
    if lower.contains("opus") { type = "Opus" }
    else if lower.contains("sonnet") { type = "Sonnet" }
    else if lower.contains("haiku") { type = "Haiku" }
    else { return id }  // non-Claude (GLM, gpt, …): show as-is
    // First version number (4, 4.6, 3.5, …)
    if let m = id.range(of: #"\d+(\.\d+)?"#, options: .regularExpression) {
        return "\(type) \(id[m])"
    }
    return type
}

func todayString() -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: Date())
}

func todayLabel() -> String {
    let f = DateFormatter()
    f.dateFormat = "MMM d, HH:mm"
    return f.string(from: Date())
}

func trimTrailingZero(_ value: String) -> String {
    var s = value
    if s.hasSuffix(".0") { s = String(s.dropLast(2)) }
    if let dot = s.lastIndex(of: ".") {
        let after = s.index(after: dot)
        let fraction = s[after...]
        let trimmed = fraction.replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
        if trimmed.isEmpty {
            s = String(s[..<dot])
        }
    }
    return s
}
