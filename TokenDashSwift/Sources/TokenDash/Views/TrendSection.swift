import SwiftUI
import Charts

/// 7-day TOKEN bar chart (today highlighted) with a weekly total + daily avg.
///
/// Token, not cost: cost tracks tokens near-linearly so a cost line added no
/// information, and tokens are the more meaningful unit for coding work.
struct TrendSection: View {
    let trend: [TrendPoint]
    @State private var hoveredDate: String?

    private var weekTokens: Int { trend.map(\.tokens).reduce(0, +) }
    private var activeDays: Int { max(trend.filter { $0.tokens > 0 }.count, 1) }
    private var dailyAvg: Int { weekTokens / activeDays }
    private var todayKey: String { todayString() }
    private var hoveredPoint: TrendPoint? {
        guard let hoveredDate else { return nil }
        return trend.first { $0.date == hoveredDate }
    }

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
        Chart {
            ForEach(trend) { point in
                BarMark(
                    x: .value("Day", point.date),
                    y: .value("Tokens", point.tokens)
                )
                .foregroundStyle(point.date == todayKey ? Color.accentGreen : Color.accentGreen.opacity(0.3))
                .cornerRadius(2)
            }
        }
        .chartXAxis {
            AxisMarks { value in
                AxisValueLabel {
                    if let date = value.as(String.self) {
                        Text(weekdayShort(date))
                            .font(.system(size: 9))
                    }
                }
            }
        }
        .chartYAxis(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                ZStack(alignment: .topLeading) {
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                updateHoveredDate(at: location, proxy: proxy, geometry: geometry)
                            case .ended:
                                hoveredDate = nil
                            }
                        }

                    if let hoveredPoint,
                       let plotFrame = proxy.plotFrame,
                       let plotX = proxy.position(forX: hoveredPoint.date) {
                        let frame = geometry[plotFrame]
                        let tooltipX = min(
                            max(frame.minX + plotX, 42),
                            geometry.size.width - 42
                        )
                        hoverLabel(for: hoveredPoint)
                            .fixedSize()
                            .position(x: tooltipX, y: 16)
                            .allowsHitTesting(false)
                    }
                }
            }
        }
        .frame(height: 54)
    }

    private func updateHoveredDate(
        at location: CGPoint,
        proxy: ChartProxy,
        geometry: GeometryProxy
    ) {
        guard let plotFrame = proxy.plotFrame else {
            hoveredDate = nil
            return
        }

        let frame = geometry[plotFrame]
        guard frame.contains(location) else {
            hoveredDate = nil
            return
        }

        let plotX = location.x - frame.minX
        hoveredDate = proxy.value(atX: plotX, as: String.self)
    }

    private func hoverLabel(for point: TrendPoint) -> some View {
        VStack(spacing: 1) {
            Text(shortDate(point.date))
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.secondary)
            Text("\(formatTokens(point.tokens)) tokens")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(.primary.opacity(0.08), lineWidth: 0.5)
        }
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

func shortDate(_ yyyy_mm_dd: String) -> String {
    let parse = DateFormatter()
    parse.dateFormat = "yyyy-MM-dd"
    guard let date = parse.date(from: yyyy_mm_dd) else { return yyyy_mm_dd }
    let output = DateFormatter()
    output.dateFormat = "MMM d"
    return output.string(from: date)
}
