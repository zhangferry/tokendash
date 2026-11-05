import SwiftUI
import Charts

/// Trailing window for the pulse chart's smoothed rate curve (seconds). Each
/// point on the curve = Σ token deltas in the past `pulseSmoothWindow` ÷ window.
private let pulseSmoothWindow: TimeInterval = 30

/// Feature flag: the Pulse tab + its 10s rate-sampling are hidden for the
/// energy-optimization release (sampling was a top CPU draw). Flip to true to
/// re-enable both the UI tab and the sampler.
private let pulseEnabled = false

struct HourlyChartView: View {
    let data: [TimeBucket]
    let pulseSamples: [TokenPulseSample]
    @Environment(AppState.self) private var state
    @Bindable private var settings = SettingsStore.shared
    @State private var hoveredBucketID: Date?
    @Namespace private var selectorAnimation

    private var range: SettingsStore.HourlyRange { settings.hourlyRange }

    private var now: Date { Date() }

    private var calendar: Calendar { Calendar.current }

    /// Effective range for rendering: the shared 5-minute base serves every
    /// range, but a legacy daemon (pre-1.9.0) leaves 60-minute buckets in the
    /// store — those only support Today, so fine-grained tabs fall back to it.
    private var effectiveRange: SettingsStore.HourlyRange {
        if range == .fifteenMinutes {
            // The realtime tab needs live 1-minute buckets; without them
            // (legacy daemon, fetch failure) it falls back to the 1D view.
            return state.realtimeBuckets.first?.minutes == 1 ? .fifteenMinutes : .oneDay
        }
        if range != .oneDay, data.first?.minutes == 60 {
            return .oneDay
        }
        return range
    }

    // MARK: - Data view model

    /// Buckets for the effective range, derived locally from the shared
    /// 5-minute base (no refetch on tab switch). Today shows elapsed hours
    /// only; fine-grained tabs show the full rolling window.
    private var displayBuckets: [TimeBucket] {
        if effectiveRange == .fifteenMinutes {
            return state.realtimeBuckets
        }
        if data.first?.minutes == 60 {
            // Legacy fallback already holds Today-shaped hour buckets.
            let currentHourStart = calendar.dateInterval(of: .hour, for: now)?.start ?? now
            return data.filter { $0.start <= currentHourStart }
        }
        var buckets = UsageBucketAggregator.reaggregate(data, to: effectiveRange, now: now)
        if effectiveRange == .oneDay {
            let currentHourStart = calendar.dateInterval(of: .hour, for: now)?.start ?? now
            buckets = buckets.filter { $0.start <= currentHourStart }
        }
        return buckets
    }

    private var currentBucketStart: Date? {
        UsageBucketAggregator.align(now, to: effectiveRange.bucketMinutes, calendar: calendar)
    }

    private var hoveredBucket: TimeBucket? {
        guard let hoveredBucketID else { return nil }
        return displayBuckets.first { $0.start == hoveredBucketID }
    }

    private var yAxisUpperBound: Int {
        let maximum = displayBuckets.map(\.tokens).max() ?? 0
        return max(1, Int(ceil(Double(maximum) * 1.15)))
    }

    private var xDomain: (min: Date, max: Date) {
        switch effectiveRange {
        case .oneDay:
            let start = calendar.startOfDay(for: now)
            return (start, start.addingTimeInterval(24 * 3600))
        case .threeHours, .fifteenMinutes:
            // Mirrors UsageBucketAggregator.reaggregate: complete coverage from
            // the bucket containing now−window through the in-progress bucket.
            let window: TimeInterval = effectiveRange == .threeHours ? 3 * 3600 : 15 * 60
            let minutes = effectiveRange.bucketMinutes
            let windowStart = UsageBucketAggregator.align(now.addingTimeInterval(-window), to: minutes, calendar: calendar)
            let windowEnd = UsageBucketAggregator.align(now, to: minutes, calendar: calendar)
                .addingTimeInterval(TimeInterval(minutes) * 60)
            return (windowStart, windowEnd)
        }
    }

    // MARK: - Layout

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.bottom, 10)

            if effectiveRange == .oneDay && data.allSatisfy({ $0.tokens == 0 }) {
                emptyChart
            } else {
                chartArea
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Text("ACTIVITY")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)

            Spacer()

            modeTabs
        }
    }

    /// Tabs write straight back to SettingsStore.hourlyRange — switching a
    /// tab persists the new default range while the chart re-derives from the
    /// shared 5-minute base instantly; a throttled refresh keeps it fresh.
    private var modeTabs: some View {
        HStack(spacing: 2) {
            ForEach(SettingsStore.HourlyRange.allCases) { range in
                Button {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        settings.hourlyRange = range
                    }
                    state.badgeUpdater?.realtimeRangeDidChange()
                    Task { @MainActor in
                        _ = await state.badgeUpdater?.refreshOnPopoverOpenIfNeeded()
                    }
                } label: {
                    Text(range.shortLabel)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(self.range == range ? Color.white : Color.secondaryLabel)
                        .padding(.horizontal, 11)
                        .frame(height: 24)
                        .background {
                            if self.range == range {
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.accentGreen)
                                    .matchedGeometryEffect(id: "hour-mode-selection", in: selectorAnimation)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(self.range == range ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Color.primary.opacity(0.055))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .fixedSize()
        .animation(.easeInOut(duration: 0.12), value: range)
    }

    // MARK: - Area chart

    private var chartArea: some View {
        Chart {
            ForEach(displayBuckets) { bucket in
                // Area fill
                AreaMark(
                    x: .value("Time", bucket.start),
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
                    x: .value("Time", bucket.start),
                    y: .value("Tokens", bucket.tokens)
                )
                .foregroundStyle(Color.accentGreen)
                .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)

                // Current-bucket dot with glow (uses Chart's own coordinate system)
                if bucket.start == currentBucketStart {
                    PointMark(
                        x: .value("Time", bucket.start),
                        y: .value("Tokens", bucket.tokens)
                    )
                    .foregroundStyle(Color.accentGreen.opacity(0.12))
                    .symbolSize(80)

                    PointMark(
                        x: .value("Time", bucket.start),
                        y: .value("Tokens", bucket.tokens)
                    )
                    .foregroundStyle(Color.accentGreen)
                    .symbolSize(20)
                }
            }

            if let hoveredBucket {
                RuleMark(x: .value("Selected time", hoveredBucket.start))
                    .foregroundStyle(.secondary.opacity(0.25))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))

                PointMark(
                    x: .value("Selected time", hoveredBucket.start),
                    y: .value("Selected tokens", hoveredBucket.tokens)
                )
                .foregroundStyle(Color.accentGreen)
                .symbolSize(34)
                .annotation(position: .top, spacing: 6) {
                    hoverLabel(for: hoveredBucket)
                }
            }
        }
        .chartXScale(domain: xDomain.min...xDomain.max)
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
            AxisMarks(values: xAxisValues) { value in
                if let date = value.as(Date.self) {
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                        .foregroundStyle(.primary.opacity(0.03))
                    AxisValueLabel {
                        Text(xAxisLabel(for: date))
                            .font(.system(size: 9, weight: date == currentBucketStart ? .semibold : .medium))
                            .foregroundStyle(timeLabelColor(for: date))
                            // Edge ticks sit near the domain boundary, where the
                            // axis gives the label a slot narrower than "HH:mm"
                            // and truncates it to "..". fixedSize renders the
                            // full time past the slot; the offset keeps the
                            // outer half inside the chart bounds.
                            .fixedSize(horizontal: true, vertical: false)
                            .offset(x: edgeLabelOffset(for: date))
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
                            updateHoveredBucket(at: location, proxy: proxy, geometry: geometry)
                        case .ended:
                            hoveredBucketID = nil
                        }
                    }
            }
        }
        .frame(height: 110)
    }

    // MARK: - X axis values & labels

    /// Fine-grained tabs: the first/last tick labels sit exactly on the plot
    /// edges, so their outer half gets clipped ("22:4.."). Nudge edge labels
    /// inward by half a label width; middle labels stay centered on their tick.
    private func edgeLabelOffset(for date: Date) -> CGFloat {
        guard effectiveRange != .oneDay else { return 0 }
        if date == xAxisValues.last { return -13 }
        if date == xAxisValues.first { return 13 }
        return 0
    }

    private var xAxisValues: [Date] {
        switch effectiveRange {
        case .oneDay:
            let start = calendar.startOfDay(for: now)
            return [0, 3, 6, 9, 12, 15, 18, 21].compactMap {
                calendar.date(byAdding: .hour, value: $0, to: start)
            }
        case .threeHours, .fifteenMinutes:
            let step: TimeInterval = effectiveRange == .threeHours ? 60 * 60 : 5 * 60
            var values: [Date] = []
            var cursor = xDomain.min
            while cursor <= xDomain.max {
                values.append(cursor)
                cursor = cursor.addingTimeInterval(step)
            }
            return values
        }
    }

    private func xAxisLabel(for date: Date) -> String {
        axisFormatter.string(from: date)
    }

    private func timeLabelColor(for date: Date) -> Color {
        if date == currentBucketStart { return Color.accentGreen }
        if date > now { return Color.futureLabelColor }
        return Color.tertiaryLabel
    }

    // MARK: - Hover

    private func updateHoveredBucket(
        at location: CGPoint,
        proxy: ChartProxy,
        geometry: GeometryProxy
    ) {
        guard let plotFrame = proxy.plotFrame else {
            hoveredBucketID = nil
            return
        }

        let frame = geometry[plotFrame]
        guard frame.contains(location) else {
            hoveredBucketID = nil
            return
        }

        let plotX = location.x - frame.minX
        guard let date: Date = proxy.value(atX: plotX) else {
            hoveredBucketID = nil
            return
        }

        let aligned = UsageBucketAggregator.align(date, to: effectiveRange.bucketMinutes, calendar: calendar)
        hoveredBucketID = displayBuckets.contains { $0.start == aligned } ? aligned : nil
    }

    private func hoverLabel(for bucket: TimeBucket) -> some View {
        VStack(spacing: 1) {
            Text(bucketLabel(for: bucket))
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

    /// Today buckets are hour-aligned, so "HH:mm" renders "HH:00" there and
    /// stays correct for sub-hour buckets on fine-grained tabs.
    private func bucketLabel(for bucket: TimeBucket) -> String {
        Self.minuteFormatter.string(from: bucket.start)
    }

    // MARK: - Formatting

    /// Cached POSIX formatters — building a DateFormatter inside axis-label
    /// closures would repeat on every hover-driven re-render.
    private static let hourAxisFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "H"
        return f
    }()

    private static let minuteFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    private var axisFormatter: DateFormatter {
        effectiveRange == .oneDay ? Self.hourAxisFormatter : Self.minuteFormatter
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

private struct TokenPulseChartView: View {
    let samples: [TokenPulseSample]
    @State private var hoverLocation: CGPoint?

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate
            Canvas { context, size in
                drawPulse(layout: PulseLayout(samples: samples, size: size), context: &context, phase: phase)
            }
        }
        .frame(height: 110)
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 8) {
                seriesLabel("Input", color: .accentGreen)
                seriesLabel("Output", color: .blue)
            }
            .padding(.top, 1)
            .padding(.trailing, 2)
        }
        .overlay(alignment: .bottomLeading) {
            Text("30m ago")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(Color.tertiaryLabel)
                .padding(.bottom, 1)
                .padding(.leading, 2)
        }
        .overlay(alignment: .bottomTrailing) {
            Text("now")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(Color.tertiaryLabel)
                .padding(.bottom, 1)
                .padding(.trailing, 2)
        }
        // Hover hit-testing covers the whole plot so the tooltip can follow the
        // cursor anywhere along the 30-minute window.
        .overlay {
            Color.clear
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let location):
                        hoverLocation = location
                    case .ended:
                        hoverLocation = nil
                    }
                }
        }
        // The tooltip floats above the cursor and must never steal hover events
        // from the clear overlay below, otherwise it flickers on/off.
        .overlay {
            GeometryReader { geo in
                if let hoverLocation {
                    let layout = PulseLayout(samples: samples, size: geo.size)
                    if let sample = layout.sample(atX: hoverLocation.x) {
                        let rate = layout.smoothedRate(for: sample)
                            ?? (input: sample.inputTokensPerSecond, output: sample.outputTokensPerSecond)
                        pulseTooltip(timestamp: sample.timestamp, input: rate.input, output: rate.output)
                            .position(
                                x: min(max(hoverLocation.x, 64), max(64, geo.size.width - 64)),
                                y: 16
                            )
                    }
                }
            }
            .allowsHitTesting(false)
        }
    }

    private func seriesLabel(_ label: String, color: Color) -> some View {
        HStack(spacing: 3) {
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
            Text(label)
                .foregroundStyle(Color.secondaryLabel)
        }
        .font(.system(size: 9, weight: .medium))
    }

    private func formatRate(_ rate: Double) -> String {
        let value = max(0, Int(rate.rounded()))
        return value < 1_000 ? "\(value)" : formatTokens(value)
    }

    private func pulseTimeString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: date)
    }

    private func pulseTooltip(timestamp: Date, input: Double, output: Double) -> some View {
        VStack(spacing: 1) {
            Text(pulseTimeString(timestamp))
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text("↑ \(formatRate(input))/s")
                    .foregroundStyle(Color.accentGreen)
                Text("↓ \(formatRate(output))/s")
                    .foregroundStyle(Color.blue)
            }
            .font(.system(size: 10, weight: .semibold))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6))
        .overlay {
            RoundedRectangle(cornerRadius: 6)
                .stroke(.primary.opacity(0.08), lineWidth: 0.5)
        }
    }

    private func drawPulse(layout: PulseLayout, context: inout GraphicsContext, phase: TimeInterval) {
        let size = layout.size

        context.stroke(
            Path { path in
                path.move(to: CGPoint(x: 0, y: layout.baselineY))
                path.addLine(to: CGPoint(x: size.width, y: layout.baselineY))
            },
            with: .color(Color.primary.opacity(0.10)),
            lineWidth: 0.5
        )

        guard !layout.samples.isEmpty else { return }

        let inputLine = smoothPath(through: layout.inputPoints)
        let outputLine = smoothPath(through: layout.outputPoints)

        var inputFill = inputLine
        if let first = layout.inputPoints.first, let last = layout.inputPoints.last {
            inputFill.addLine(to: CGPoint(x: last.x, y: layout.baselineY))
            inputFill.addLine(to: CGPoint(x: first.x, y: layout.baselineY))
            inputFill.closeSubpath()
        }

        var outputFill = outputLine
        if let first = layout.outputPoints.first, let last = layout.outputPoints.last {
            outputFill.addLine(to: CGPoint(x: last.x, y: layout.baselineY))
            outputFill.addLine(to: CGPoint(x: first.x, y: layout.baselineY))
            outputFill.closeSubpath()
        }

        context.fill(inputFill, with: .color(Color.accentGreen.opacity(0.45)))
        context.fill(outputFill, with: .color(Color.blue.opacity(0.45)))

        context.stroke(
            inputLine,
            with: .color(Color.accentGreen),
            style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
        )
        context.stroke(
            outputLine,
            with: .color(Color.blue),
            style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
        )

        let pulse = 0.5 + 0.5 * sin(phase * 3.2)
        let latestInput = layout.samples.last?.inputTokensPerSecond ?? 0
        let latestOutput = layout.samples.last?.outputTokensPerSecond ?? 0
        let activeEndPoint: CGPoint
        let activeColor: Color
        if latestOutput > latestInput {
            activeEndPoint = layout.outputPoints.last ?? CGPoint(x: size.width, y: layout.baselineY)
            activeColor = .blue
        } else {
            activeEndPoint = layout.inputPoints.last ?? CGPoint(x: size.width, y: layout.baselineY)
            activeColor = .accentGreen
        }
        context.fill(
            Path(ellipseIn: CGRect(
                x: activeEndPoint.x - 11 - CGFloat(pulse) * 3,
                y: activeEndPoint.y - 11 - CGFloat(pulse) * 3,
                width: 22 + CGFloat(pulse) * 6,
                height: 22 + CGFloat(pulse) * 6
            )),
            with: .color(activeColor.opacity(0.10))
        )
        context.fill(
            Path(ellipseIn: CGRect(
                x: activeEndPoint.x - 4.5,
                y: activeEndPoint.y - 4.5,
                width: 9,
                height: 9
            )),
            with: .color(activeColor)
        )
    }

    /// Smooth Catmull-Rom spline through the given points, rendered as a path of
    /// cubic Bézier segments. Tension 0.5 produces the gentle, continuous curve
    /// that the previous straight `addLine` joins were missing.
    private func smoothPath(through points: [CGPoint], tension: CGFloat = 0.5) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        guard points.count > 1 else { return path }
        if points.count == 2 {
            path.addLine(to: points[1])
            return path
        }
        let k = tension / 3
        for index in 0..<(points.count - 1) {
            let p0 = index == 0 ? points[0] : points[index - 1]
            let p1 = points[index]
            let p2 = points[index + 1]
            let p3 = index + 2 < points.count ? points[index + 2] : points[index + 1]
            let control1 = CGPoint(x: p1.x + (p2.x - p0.x) * k, y: p1.y + (p2.y - p0.y) * k)
            let control2 = CGPoint(x: p2.x - (p3.x - p1.x) * k, y: p2.y - (p3.y - p1.y) * k)
            path.addCurve(to: p2, control1: control1, control2: control2)
        }
        return path
    }
}

/// Pre-computed geometry for the pulse chart. The canvas renderer and the hover
/// hit-testing share one layout so a cursor position maps to exactly the sample
/// the eye sees on the curve.
private struct PulseLayout {
    let size: CGSize
    let topPadding: CGFloat = 8
    let bottomPadding: CGFloat = 22
    let baselineY: CGFloat
    let sharedPeakRate: Double
    let samples: [TokenPulseSample]
    let rates: [(input: Double, output: Double)]
    let inputPoints: [CGPoint]
    let outputPoints: [CGPoint]
    let windowStart: Date

    init(samples: [TokenPulseSample], size: CGSize) {
        let sorted = samples.sorted { $0.timestamp < $1.timestamp }
        self.samples = sorted
        self.size = size
        // Input rises above the baseline, output drops below it — two mirrored
        // translucent bands sharing one midline.
        let chartHeight = max(1, size.height - topPadding - bottomPadding)
        baselineY = topPadding + chartHeight * 0.52
        let upperHeight = chartHeight * 0.44
        let lowerHeight = chartHeight * 0.40
        let now = sorted.last?.timestamp ?? Date()
        windowStart = now.addingTimeInterval(-30 * 60)

        // Smoothed trailing-window rates — kills the 0↔spike jitter from batched
        // JSONL writes by spreading each response's tokens across the window.
        let rates = pulseSmoothedRates(for: sorted, window: pulseSmoothWindow)
        self.rates = rates
        sharedPeakRate = max(
            rates.map(\.input).max() ?? 0,
            rates.map(\.output).max() ?? 0,
            1
        )

        var inputs: [CGPoint] = []
        var outputs: [CGPoint] = []
        for (index, sample) in sorted.enumerated() {
            let elapsed = sample.timestamp.timeIntervalSince(windowStart)
            let x = size.width * CGFloat(max(0, min(1, elapsed / (30 * 60))))
            let rate = rates[index]
            let normalizedInput = log1p(rate.input) / log1p(sharedPeakRate)
            let normalizedOutput = log1p(rate.output) / log1p(sharedPeakRate)
            inputs.append(CGPoint(x: x, y: baselineY - upperHeight * CGFloat(normalizedInput)))
            outputs.append(CGPoint(x: x, y: baselineY + lowerHeight * CGFloat(normalizedOutput)))
        }
        inputPoints = inputs
        outputPoints = outputs
    }

    /// Smoothed (input, output) rate for a given sample, for the hover tooltip.
    func smoothedRate(for sample: TokenPulseSample) -> (input: Double, output: Double)? {
        guard let index = samples.firstIndex(where: { $0.timestamp == sample.timestamp }),
              index < rates.count else { return nil }
        return rates[index]
    }

    /// Map a horizontal position (0…width) to the nearest sample in time.
    func sample(atX x: CGFloat) -> TokenPulseSample? {
        guard !samples.isEmpty, size.width > 0 else { return nil }
        let fraction = max(0, min(1, x / size.width))
        let target = windowStart.addingTimeInterval(fraction * 30 * 60)
        return samples.min {
            abs($0.timestamp.timeIntervalSince(target)) < abs($1.timestamp.timeIntervalSince(target))
        }
    }
}
