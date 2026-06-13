import SwiftUI

struct ProjectsSection: View {
    let projects: [ProjectRow]

    private var maxTokens: Int {
        projects.map(\.total).max() ?? 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PROJECTS")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Color.sectionTitleColor)
                .padding(.bottom, 10)

            if projects.isEmpty {
                Text("No project usage today.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 12)
            } else {
                VStack(spacing: 6) {
                    ForEach(projects) { row in
                        projectRow(row)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 6)
    }

    private func projectRow(_ row: ProjectRow) -> some View {
        let pct = maxTokens > 0 ? Double(row.total) / Double(maxTokens) : 0

        return HStack(spacing: 8) {
            Text(row.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondaryLabel)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 140, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.barTrackColor)
                    Capsule()
                        .fill(Color.accentGreenLight)
                        .frame(width: geo.size.width * CGFloat(pct))
                        .animation(.easeOut(duration: 0.6).delay(0.3), value: pct)
                }
            }
            .frame(height: 4)

            Text(formatTokens(row.total))
                .font(.system(size: 11, weight: .medium, design: .default))
                .foregroundStyle(.primary.opacity(0.5))
                .frame(width: 44, alignment: .trailing)
                .monospacedDigit()
        }
    }
}
