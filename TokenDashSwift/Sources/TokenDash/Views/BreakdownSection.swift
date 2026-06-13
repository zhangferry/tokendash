import SwiftUI

/// Breakdown section with colored progress bars for Input / Output / Cached
struct BreakdownSection: View {
    let summary: TodaySummary?

    private var total: Int {
        guard let s = summary else { return 1 }
        return max(s.inputTokens + s.outputTokens + s.cacheReadTokens, 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("BREAKDOWN")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
                .padding(.bottom, 10)

            VStack(spacing: 8) {
                barRow(
                    color: .inputColor,
                    label: "Input",
                    value: summary?.inputTokens ?? 0
                )
                barRow(
                    color: .outputColor,
                    label: "Output",
                    value: summary?.outputTokens ?? 0
                )
                barRow(
                    color: .cachedColor,
                    label: "Cached",
                    value: summary?.cacheReadTokens ?? 0
                )
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 6)
    }

    private func barRow(color: Color, label: String, value: Int) -> some View {
        let pct = total > 0 ? Double(value) / Double(total) : 0

        return HStack(spacing: 8) {
            // Color dot
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)

            // Label
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondaryLabel)
                .frame(width: 52, alignment: .leading)

            // Progress bar
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.barTrackColor)
                    Capsule()
                        .fill(color)
                        .frame(width: geo.size.width * CGFloat(pct))
                        .animation(.easeOut(duration: 0.6).delay(0.3), value: pct)
                }
            }
            .frame(height: 6)

            // Value
            Text(formatTokens(value))
                .font(.system(size: 12, weight: .semibold, design: .default))
                .foregroundStyle(.primary)
                .frame(minWidth: 48, alignment: .trailing)
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()

            // Percentage
            Text(formatPercent(pct * 100))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.tertiaryLabel)
                .frame(minWidth: 36, alignment: .trailing)
                .lineLimit(1)
                .fixedSize()
        }
    }
}
