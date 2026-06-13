import SwiftUI

struct ActionButtons: View {
    @Environment(AppState.self) private var state
    @State private var isDashboardHovered = false
    @State private var isSettingsHovered = false

    var body: some View {
        HStack(spacing: 0) {
            Button {
                if let url = URL(string: "http://localhost:\(state.daemonPort)") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Label("Dashboard", systemImage: "chart.bar")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.primary.opacity(isDashboardHovered ? 0.65 : 0.45))
                    .frame(maxWidth: .infinity)
                    .frame(height: 32)
                    .background(isDashboardHovered ? Color.primary.opacity(0.04) : Color.clear)
            }
            .buttonStyle(.plain)
            .onHover { hovering in isDashboardHovered = hovering }

            Rectangle()
                .fill(Color.dividerColor)
                .frame(width: 0.5)

            Button {
                state.showSettings = true
            } label: {
                Label("Settings", systemImage: "gearshape")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.primary.opacity(isSettingsHovered ? 0.65 : 0.45))
                    .frame(maxWidth: .infinity)
                    .frame(height: 32)
                    .background(isSettingsHovered ? Color.primary.opacity(0.04) : Color.clear)
            }
            .buttonStyle(.plain)
            .onHover { hovering in isSettingsHovered = hovering }
        }
        .frame(height: 32)
    }
}
