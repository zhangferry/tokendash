import SwiftUI
import Charts

/// 7-day cost + token sparklines. Uses the daily history the summary loop used
/// to discard. Compact: two thin lines with weekly totals.
struct TrendSection: View {
    let trend: [TrendPoint]

    private var weekCost: Double { trend.map(\.cost).reduce(0, +) }
    private var weekTokens: Int { trend.map(\.tokens).reduce(0, +) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("7-DAY TREND")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
                .padding(.bottom, 10)

            if trend.allSatisfy({ $0.tokens == 0 }) {
                Text("No history yet.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 10)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    costRow
                    tokensRow
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private var costRow: some View {
        HStack(spacing: 10) {
            metricLabel("Cost", formatCost(weekCost))
            Chart(trend) { point in
                LineMark(x: .value("Day", point.date), y: .value("Cost", point.cost))
                    .foregroundStyle(Color.accentGreen)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .interpolationMethod(.catmullRom)
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .frame(height: 26)
        }
    }

    private var tokensRow: some View {
        HStack(spacing: 10) {
            metricLabel("Tokens", formatTokens(weekTokens))
            Chart(trend) { point in
                LineMark(x: .value("Day", point.date), y: .value("Tokens", point.tokens))
                    .foregroundStyle(Color.outputColor)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .interpolationMethod(.catmullRom)
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .frame(height: 26)
        }
    }

    private func metricLabel(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 10)).foregroundStyle(Color.secondaryLabel)
            Text(value).font(.system(size: 12, weight: .semibold)).monospacedDigit().foregroundStyle(.primary)
        }
        .frame(width: 64, alignment: .leading)
    }
}
