import SwiftUI

/// Merged header: big token count + cost + date + cache badge
struct HeaderView: View {
    let summary: TodaySummary?
    let cacheRate: Double

    var body: some View {
        HStack(alignment: .lastTextBaseline) {
            // Left: tokens + date
            VStack(alignment: .leading, spacing: 2) {
                if let s = summary, s.tokens > 0 {
                    Text(formatTokens(s.tokens))
                        .font(.system(size: 28, weight: .bold, design: .default))
                        .tracking(-0.5)
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                } else {
                    Text("—")
                        .font(.system(size: 28, weight: .bold, design: .default))
                        .foregroundStyle(Color.tertiaryLabel)
                }
                Text("Today · \(todayLabel())")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.secondaryLabel)
            }

            Spacer()

            // Right: cost + cache badge
            VStack(alignment: .trailing, spacing: 6) {
                if let s = summary {
                    Text(formatCost(s.cost))
                        .font(.system(size: 22, weight: .semibold, design: .default))
                        .monospacedDigit()
                        .foregroundStyle(Color.accentGreen)
                } else {
                    Text("—")
                        .font(.system(size: 22, weight: .semibold, design: .default))
                        .foregroundStyle(Color.tertiaryLabel)
                }
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.system(size: 8, weight: .semibold))
                    Text("cache \(formatPercent(cacheRate))")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .lineLimit(1)
                        .fixedSize()
                }
                .foregroundStyle(Color.accentGreen)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color.accentGreen.opacity(0.08))
                )
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(Color.headerBackground)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.dividerColor)
                .frame(height: 0.5)
        }
    }
}
