import SwiftUI

struct AgentsSection: View {
    let agents: [AgentRow]

    private var totalTokens: Int {
        agents.map(\.total).reduce(0, +)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("AGENTS")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
                .padding(.bottom, 10)

            if agents.isEmpty {
                Text("No agent usage today.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 12)
            } else {
                VStack(spacing: 5) {
                    ForEach(agents) { row in
                        agentRow(row)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }

    private func agentRow(_ row: AgentRow) -> some View {
        let pct = totalTokens > 0 ? Double(row.total) / Double(totalTokens) * 100 : 0

        return HStack(spacing: 8) {
            Circle()
                .fill(agentColor(forKey: row.key))
                .frame(width: 6, height: 6)

            Text(row.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondaryLabel)
                .lineLimit(1)

            Spacer()

            Text(formatTokens(row.total))
                .font(.system(size: 12, weight: .semibold, design: .default))
                .foregroundStyle(.primary)
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()

            Text(formatPercent(pct))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.tertiaryLabel)
                .frame(minWidth: 36, alignment: .trailing)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.vertical, 3)
    }
}
