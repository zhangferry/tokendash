import SwiftUI

/// Usage breakdown with a By Model / By Type toggle.
///
/// By Model shows per-model token share (Sonnet/Opus/Haiku/…), a dimension the
/// old single Input/Output/Cached breakdown lacked. By Type keeps that classic
/// split. Both share one compact bar-list renderer.
struct UsageSection: View {
    let summary: TodaySummary?
    let models: [ModelRow]
    @State private var mode: Mode = .model
    @Namespace private var selectorAnimation

    private enum Mode: String, CaseIterable, Identifiable {
        case model = "By Model"
        case type = "By Type"
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("USAGE")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Color.sectionTitleColor)
                Spacer()
                modeSelector
            }
            .padding(.bottom, 10)

            ZStack(alignment: .topLeading) {
                modelRows
                    .opacity(mode == .model ? 1 : 0)
                    .accessibilityHidden(mode != .model)
                typeRows
                    .opacity(mode == .type ? 1 : 0)
                    .accessibilityHidden(mode != .type)
            }
            .animation(.easeInOut(duration: 0.18), value: mode)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 6)
    }

    private var modeSelector: some View {
        HStack(spacing: 2) {
            ForEach(Mode.allCases) { option in
                Button {
                    withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
                        mode = option
                    }
                } label: {
                    Text(option.rawValue)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(mode == option ? Color.white : Color.secondaryLabel)
                        .padding(.horizontal, 11)
                        .frame(height: 24)
                        .background {
                            if mode == option {
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.accentGreen)
                                    .matchedGeometryEffect(
                                        id: "usage-mode-selection",
                                        in: selectorAnimation
                                    )
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mode == option ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Color.primary.opacity(0.055))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .fixedSize()
        .animation(.easeInOut(duration: 0.12), value: mode)
    }

    // MARK: - By Model

    @ViewBuilder private var modelRows: some View {
        if models.isEmpty {
            empty("No model usage today.")
        } else {
            let total = max(models.map(\.tokens).reduce(0, +), 1)
            VStack(spacing: 6) {
                ForEach(models) { row in
                    bar(color: modelColor(row.name),
                        label: row.name,
                        value: formatTokens(row.tokens),
                        pct: Double(row.tokens) / Double(total))
                }
            }
        }
    }

    // MARK: - By Type

    @ViewBuilder private var typeRows: some View {
        if let s = summary {
            let total = max(s.inputTokens + s.outputTokens + s.cacheReadTokens, 1)
            VStack(spacing: 6) {
                bar(color: .inputColor, label: "Input", value: formatTokens(s.inputTokens), pct: Double(s.inputTokens) / Double(total))
                bar(color: .outputColor, label: "Output", value: formatTokens(s.outputTokens), pct: Double(s.outputTokens) / Double(total))
                bar(color: .cachedColor, label: "Cached", value: formatTokens(s.cacheReadTokens), pct: Double(s.cacheReadTokens) / Double(total))
            }
        } else {
            empty("No usage yet.")
        }
    }

    // MARK: - Row renderer

    private func bar(color: Color, label: String, value: String, pct: Double) -> some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.secondaryLabel)
                .frame(width: 70, alignment: .leading)
                .lineLimit(1)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.barTrackColor)
                    Capsule().fill(color)
                        .frame(width: max(2, geo.size.width * CGFloat(pct)))
                        .animation(.easeOut(duration: 0.5), value: pct)
                }
            }
            .frame(height: 5)
            Text(value)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(minWidth: 44, alignment: .trailing)
                .monospacedDigit()
                .lineLimit(1).fixedSize()
            Text(formatPercent(pct * 100))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.tertiaryLabel)
                .frame(minWidth: 34, alignment: .trailing)
                .lineLimit(1).fixedSize()
        }
        .padding(.vertical, 2)
    }

    private func empty(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 10)
    }

    private func modelColor(_ name: String) -> Color {
        let n = name.lowercased()
        if n.contains("opus") { return Color.outputColor }
        if n.contains("haiku") { return Color.cachedColor }
        return Color.accentGreen // sonnet + others
    }
}
