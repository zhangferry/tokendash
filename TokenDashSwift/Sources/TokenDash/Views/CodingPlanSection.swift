import SwiftUI

/// Coding Plan quota section. Each configured provider is one card, and every
/// quota window (5h / Weekly / MCP …) renders as a compact inline chip on a
/// single row — preserving all the information while collapsing the old
/// one-window-per-line layout.
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
                    .padding(.vertical, 10)
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
            // Title row: name + plan + freshness
            HStack(alignment: .firstTextBaseline) {
                Text(quota.displayName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let plan = quota.planName {
                    Text(plan)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color.tertiaryLabel)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.accentGreen.opacity(0.12))
                        .clipShape(Capsule())
                }
                Spacer()
                if quota.freshness == "stale" {
                    Text("stale")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color.cachedColor)
                }
            }

            if quota.status.state == "ok" && !quota.windows.isEmpty {
                // Inline window chips — all windows on one row (wrap if many).
                // Drop MCP/tool-call limits: not a general capability, low value.
                let shown = quota.windows.filter { !isMCPWindow($0) }
                FlowLayout(spacing: 8, lineSpacing: 6) {
                    ForEach(shown) { window in
                        windowChip(window)
                    }
                }
            } else if quota.status.state != "ok" {
                statusMessage(quota.status)
            } else {
                Text("No active limits reported.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.barTrackColor.opacity(1.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    /// One compact chip: short tag + percent, mini progress bar, reset countdown.
    private func windowChip(_ window: QuotaWindow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(shortWindowTag(window))
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color.secondaryLabel)
                Spacer(minLength: 0)
                if window.isUnlimited == true {
                    Text("∞").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.accentGreen)
                } else {
                    Text("\(Int(window.usedPercent.rounded()))%")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(usageColor(window.usedPercent))
                        .monospacedDigit()
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.barTrackColor.opacity(2.5))
                    if window.isUnlimited != true {
                        Capsule().fill(usageColor(window.usedPercent))
                            .frame(width: max(1.5, geo.size.width * CGFloat(window.usedPercent / 100)))
                            .animation(.easeOut(duration: 0.4), value: window.usedPercent)
                    }
                }
            }
            .frame(height: 4)
            // Reset countdown (or a spacer so chips stay aligned when absent).
            Text(resetLabel(window))
                .font(.system(size: 8))
                .foregroundStyle(Color.tertiaryLabel)
                .lineLimit(1)
        }
        .frame(width: 92)
    }

    private func resetLabel(_ window: QuotaWindow) -> String {
        if let iso = window.resetsAt, let c = formatResetCountdown(iso) { return c }
        return " "
    }

    /// MCP / tool-call limits aren't a general coding capability — hide them.
    private func isMCPWindow(_ w: QuotaWindow) -> Bool {
        let l = (w.id + " " + w.label).lowercased()
        return l.contains("mcp") || l.contains("time_limit") || l.contains("monthly-tool")
    }

    private func statusMessage(_ status: QuotaProviderStatus) -> some View {
        let msg: String = {
            switch status.state {
            case "auth_failed": return "Authentication failed — check credentials"
            case "upstream_unavailable": return "Provider unavailable right now"
            case "rate_limited": return "Provider throttled the request"
            case "timed_out": return "Provider timed out"
            case "malformed_response": return "Unexpected provider response"
            default: return status.message ?? "Unavailable"
            }
        }()
        return HStack(spacing: 5) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 9))
                .foregroundStyle(Color.cachedColor)
            Text(msg).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            Spacer()
        }
    }

    private func usageColor(_ usedPercent: Double) -> Color {
        if usedPercent >= 80 { return Color(red: 0.831, green: 0.247, blue: 0.247) }
        if usedPercent >= 50 { return Color.cachedColor }
        return Color.accentGreen
    }
}

/// Derive a short tag from a window: 5h / Wk / MCP / Opus.
func shortWindowTag(_ window: QuotaWindow) -> String {
    let l = (window.label + " " + window.id).lowercased()
    if l.contains("5-hour") || l.contains("5h") { return "5h" }
    if l.contains("weekly") || l.contains("7d") || l.contains("7-day") { return "Wk" }
    if l.contains("mcp") { return "MCP" }
    if l.contains("opus") { return "Opus" }
    if l.contains("primary") { return "Now" }
    // Fallback: first token of the label.
    return window.label.split(separator: " ").first.map(String.init) ?? window.label
}

// MARK: - Countdown (kept for potential detail expansion)

func formatResetCountdown(_ iso: String) -> String? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = formatter.date(from: iso)
    if date == nil { date = ISO8601DateFormatter().date(from: iso) }
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

/// Minimal left-to-right flow layout so window chips wrap onto a second line
/// only when a provider has more windows than fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0; y += lineHeight + lineSpacing; lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX; y += lineHeight + lineSpacing; lineHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
