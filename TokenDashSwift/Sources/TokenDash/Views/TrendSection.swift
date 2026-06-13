import SwiftUI
import Charts

/// 7-day TOKEN bar chart (today highlighted) with a weekly total + daily avg.
///
/// Token, not cost: cost tracks tokens near-linearly so a cost line added no
/// information, and tokens are the more meaningful unit for coding work.
struct TrendSection: View {
    let trend: [TrendPoint]

    private var weekTokens: Int { trend.map(\.tokens).reduce(0, +) }
    private var activeDays: Int { max(trend.filter { $0.tokens > 0 }.count, 1) }
    private var dailyAvg: Int { weekTokens / activeDays }
    private var todayKey: String { todayString() }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if trend.allSatisfy({ $0.tokens == 0 }) {
                Text("No history yet.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 10)
            } else {
                chart
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("7-DAY TOKENS")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
            Spacer()
            Text("\(formatTokens(weekTokens)) wk · \(formatTokens(dailyAvg))/day")
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(Color.secondaryLabel)
        }
    }

    private var chart: some View {
        Chart(trend) { point in
            BarMark(
                x: .value("Day", weekdayShort(point.date)),
                y: .value("Tokens", point.tokens)
            )
            .foregroundStyle(point.date == todayKey ? Color.accentGreen : Color.accentGreen.opacity(0.3))
            .cornerRadius(2)
        }
        .chartXAxis {
            AxisMarks { value in
                AxisValueLabel()
                    .font(.system(size: 9))
            }
        }
        .chartYAxis(.hidden)
        .frame(height: 54)
    }
}

/// "2026-06-13" → "Fri" (short weekday).
func weekdayShort(_ yyyy_mm_dd: String) -> String {
    let parse = DateFormatter()
    parse.dateFormat = "yyyy-MM-dd"
    guard let d = parse.date(from: yyyy_mm_dd) else { return "" }
    let out = DateFormatter()
    out.dateFormat = "EEE"
    return out.string(from: d)
}
