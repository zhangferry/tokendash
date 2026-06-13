import SwiftUI

/// Coding Plan quota section — shows the remaining balance of each configured
/// provider's subscription (Claude Code, Codex, GLM, MiniMax, Kimi). Replaces
/// the old per-agent token breakdown. Only providers that are configured
/// locally appear here; the server filters the rest out.
struct CodingPlanSection: View {
    let quotas: [QuotaSnapshot]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("CODING PLAN")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
                .padding(.bottom, 10)

            if quotas.isEmpty {
                Text("No coding plan configured.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 12)
            } else {
                VStack(spacing: 8) {
                    ForEach(quotas) { quota in
                        providerCard(quota)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    private func providerCard(_ quota: QuotaSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(quota.displayName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let plan = quota.planName {
                    Text(plan)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Color.tertiaryLabel)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.accentGreen.opacity(0.12))
                        .clipShape(Capsule())
                }
                Spacer()
                if let stale = freshnessLabel(quota.freshness) {
                    Text(stale)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color.cachedColor)
                }
            }

            if quota.status.state == "ok" || quota.windows.isEmpty == false {
                if quota.windows.isEmpty {
                    Text("No active limits reported.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                } else {
                    VStack(spacing: 6) {
                        ForEach(quota.windows) { window in
                            windowRow(window)
                        }
                    }
                }
            } else {
                statusRow(quota.status)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.barTrackColor)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func windowRow(_ window: QuotaWindow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(window.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.secondaryLabel)
                    .lineLimit(1)
                Spacer()
                Text(window.isUnlimited == true ? "Unlimited" : "\(Int(window.usedPercent.rounded()))% used")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(usageColor(window.usedPercent))
                    .monospacedDigit()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.barTrackColor.opacity(2.5))
                    if window.isUnlimited != true {
                        Capsule()
                            .fill(usageColor(window.usedPercent))
                            .frame(width: max(2, geo.size.width * CGFloat(window.usedPercent / 100)))
                            .animation(.easeOut(duration: 0.5), value: window.usedPercent)
                    }
                }
            }
            .frame(height: 5)
            if let resets = window.resetsAt, let countdown = formatResetCountdown(resets) {
                Text("resets \(countdown)")
                    .font(.system(size: 9))
                    .foregroundStyle(Color.tertiaryLabel)
            }
        }
    }

    private func statusRow(_ status: QuotaProviderStatus) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9))
                .foregroundStyle(Color.cachedColor)
            Text(statusMessage(status))
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
        }
    }

    private func statusMessage(_ status: QuotaProviderStatus) -> String {
        switch status.state {
        case "auth_failed": return "Authentication failed — check credentials"
        case "upstream_unavailable": return "Provider unavailable right now"
        case "rate_limited": return "Provider throttled the request"
        case "timed_out": return "Provider timed out"
        case "not_configured": return "Not configured"
        case "malformed_response": return "Unexpected provider response"
        default: return status.message ?? "Unavailable"
        }
    }

    private func usageColor(_ usedPercent: Double) -> Color {
        if usedPercent >= 80 { return Color(red: 0.831, green: 0.247, blue: 0.247) } // red
        if usedPercent >= 50 { return Color.cachedColor }                              // amber
        return Color.accentGreen                                                       // green
    }

    private func freshnessLabel(_ freshness: String) -> String? {
        switch freshness {
        case "stale": return "stale"
        default: return nil
        }
    }
}

// MARK: - Countdown

/// Format a reset countdown from an ISO timestamp.
/// < 1h → "in 34m", < 1d → "in 2h 34m", < 7d → "in 3d", else → "on Jun 18".
func formatResetCountdown(_ iso: String) -> String? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: iso)
    if date == nil {
        let fallback = ISO8601DateFormatter()
        date = fallback.date(from: iso)
    }
    guard let resetsAt = date else { return nil }

    let secs = resetsAt.timeIntervalSinceNow
    if secs <= 0 { return "soon" }
    let mins = Int(secs / 60)
    if mins < 60 { return "in \(mins)m" }
    let hours = mins / 60
    let remMins = mins % 60
    if hours < 24 { return remMins > 0 ? "in \(hours)h \(remMins)m" : "in \(hours)h" }
    let days = hours / 24
    if days < 7 { return "in \(days)d" }

    let df = DateFormatter()
    df.dateFormat = "MMM d"
    return "on \(df.string(from: resetsAt))"
}
