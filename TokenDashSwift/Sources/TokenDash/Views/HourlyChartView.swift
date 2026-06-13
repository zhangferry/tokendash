import SwiftUI
import Charts

struct HourlyChartView: View {
    let data: [HourBucket]
    @State private var hoveredHour: Int?

    private var currentHour: Int {
        let cal = Calendar.current
        return cal.component(.hour, from: Date())
    }

    private var elapsedData: [HourBucket] {
        data.filter { $0.hour <= currentHour }
    }

    private var hoveredBucket: HourBucket? {
        guard let hoveredHour else { return nil }
        return elapsedData.first { $0.hour == hoveredHour }
    }

    private var yAxisUpperBound: Int {
        let maximum = elapsedData.map(\.tokens).max() ?? 0
        return max(1, Int(ceil(Double(maximum) * 1.15)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("HOURLY")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
                .padding(.bottom, 10)

            if data.filter({ $0.tokens > 0 }).isEmpty {
                emptyChart
            } else {
                chartArea
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    // MARK: - Area chart

    private var chartArea: some View {
        Chart {
            ForEach(elapsedData) { bucket in
                // Area fill
                AreaMark(
                    x: .value("Hour", bucket.hour),
                    y: .value("Tokens", bucket.tokens)
                )
                .foregroundStyle(
                    .linearGradient(
                        colors: [Color.accentGreen.opacity(0.3), Color.accentGreen.opacity(0.02)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.catmullRom)

                // Line
                LineMark(
                    x: .value("Hour", bucket.hour),
                    y: .value("Tokens", bucket.tokens)
                )
                .foregroundStyle(Color.accentGreen)
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)

                // Current-hour dot with glow (uses Chart's own coordinate system)
                if bucket.hour == currentHour {
                    PointMark(
                        x: .value("Hour", bucket.hour),
                        y: .value("Tokens", bucket.tokens)
                    )
                    .foregroundStyle(Color.accentGreen.opacity(0.12))
                    .symbolSize(80)

                    PointMark(
                        x: .value("Hour", bucket.hour),
                        y: .value("Tokens", bucket.tokens)
                    )
                    .foregroundStyle(Color.accentGreen)
                    .symbolSize(20)
                }
            }

            if let hoveredBucket {
                RuleMark(x: .value("Selected hour", hoveredBucket.hour))
                    .foregroundStyle(.secondary.opacity(0.25))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))

                PointMark(
                    x: .value("Selected hour", hoveredBucket.hour),
                    y: .value("Selected tokens", hoveredBucket.tokens)
                )
                .foregroundStyle(Color.accentGreen)
                .symbolSize(34)
                .annotation(position: .top, spacing: 6) {
                    hoverLabel(for: hoveredBucket)
                }
            }
        }
        .chartXScale(domain: 0...23)
        .chartYScale(domain: 0...yAxisUpperBound)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                    .foregroundStyle(.primary.opacity(0.05))
                AxisValueLabel {
                    if let tokens = value.as(Int.self) {
                        Text(formatTokens(tokens))
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(Color.tertiaryLabel)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: [0, 3, 6, 9, 12, 15, 18, 21]) { value in
                if let hour = value.as(Int.self) {
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                        .foregroundStyle(.primary.opacity(0.03))
                    AxisValueLabel {
                        Text("\(hour)")
                            .font(.system(size: 9, weight: hour == currentHour ? .semibold : .medium))
                            .foregroundStyle(timeLabelColor(for: hour))
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            updateHoveredHour(at: location, proxy: proxy, geometry: geometry)
                        case .ended:
                            hoveredHour = nil
                        }
                    }
            }
        }
        .frame(height: 110)
    }

    private func timeLabelColor(for hour: Int) -> Color {
        if hour == currentHour { return Color.accentGreen }
        if hour > currentHour { return Color.futureLabelColor }
        return Color.tertiaryLabel
    }

    private func updateHoveredHour(
        at location: CGPoint,
        proxy: ChartProxy,
        geometry: GeometryProxy
    ) {
        guard let plotFrame = proxy.plotFrame else {
            hoveredHour = nil
            return
        }

        let frame = geometry[plotFrame]
        guard frame.contains(location) else {
            hoveredHour = nil
            return
        }

        let plotX = location.x - frame.minX
        guard let hour: Double = proxy.value(atX: plotX) else {
            hoveredHour = nil
            return
        }

        let nearestHour = Int(hour.rounded())
        hoveredHour = elapsedData.contains { $0.hour == nearestHour } ? nearestHour : nil
    }

    private func hoverLabel(for bucket: HourBucket) -> some View {
        VStack(spacing: 1) {
            Text(String(format: "%02d:00", bucket.hour))
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.secondary)
            Text("\(formatTokens(bucket.tokens)) tokens")
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

    // MARK: - Empty state

    private var emptyChart: some View {
        VStack(spacing: 6) {
            Text("No usage yet")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary.opacity(0.5))
            Text("Start a session to see your hourly breakdown.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }
}
