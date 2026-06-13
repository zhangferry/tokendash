import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with back button
            HStack(spacing: 8) {
                Button {
                    state.showSettings = false
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 22, height: 22)
                        .background(Color.primary.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                Text("Settings")
                    .font(.system(size: 15, weight: .bold))
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .border(width: 1, edges: .bottom, color: .primary.opacity(0.08))

            // Settings list
            VStack(alignment: .leading, spacing: 0) {
                // Check for updates
                settingsRow {
                    HStack {
                        Text("Check for updates")
                            .font(.system(size: 12, weight: .bold))
                        if state.updateAvailable != nil && !(state.updateAvailable?.upToDate ?? true) {
                            Text("NEW")
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.orange.opacity(0.2))
                                .clipShape(Capsule())
                                .foregroundStyle(.orange)
                        }
                    }
                    Text(state.updateMessage ?? "Check whether a newer build is available.")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                } trailing: {
                    Button(state.isCheckingUpdates ? "Checking..." : (state.updateAvailable != nil && state.isDownloading) ? "Downloading..." : "Check") {
                        checkUpdates()
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .disabled(state.isCheckingUpdates || state.isDownloading)
                }

                // Launch at login
                settingsRow {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Launch at login")
                            .font(.system(size: 12, weight: .bold))
                        Text("Keep TokenDash in the menu bar after sign in.")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                } trailing: {
                    Toggle("", isOn: Binding(
                        get: { state.isLaunchAtLoginEnabled },
                        set: { setLaunchAtLogin($0) }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }

                Spacer().frame(height: 8)

                // Quit
                settingsRow {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Quit TokenDash")
                            .font(.system(size: 12, weight: .bold))
                        Text("Close the app and stop background services.")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                } trailing: {
                    Button("Quit") {
                        NSApp.terminate(nil)
                    }
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)

            Spacer()

            // Version
            Text("Version \(state.appVersion)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.bottom, 13)
        }
    }

    // MARK: - Helpers

    private func settingsRow<Content: View, Trailing: View>(
        @ViewBuilder content: () -> Content,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(alignment: .center) {
            content()
            Spacer()
            trailing()
        }
        .padding(.vertical, 12)
        .border(width: 1, edges: .bottom, color: .primary.opacity(0.08))
    }

    private func checkUpdates() {
        state.isCheckingUpdates = true
        state.updateMessage = "Checking GitHub Releases..."
        Task {
            let service = UpdateService()
            let result = await service.checkForUpdates(currentVersion: state.appVersion)
            state.isCheckingUpdates = false
            state.updateAvailable = result
            if let error = result.error {
                state.updateMessage = error
            } else if result.upToDate {
                state.updateMessage = "You are up to date on version \(result.currentVersion)."
            } else if result.asset != nil {
                state.updateMessage = "Version \(result.latestVersion) is available."
            } else {
                state.updateMessage = "Version \(result.latestVersion) available, but no macOS DMG found."
            }
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            state.isLaunchAtLoginEnabled = enabled
        } catch {
            state.isLaunchAtLoginEnabled = !enabled
        }
    }
}

// MARK: - Edge border helper

extension View {
    func border(width: CGFloat, edges: Edge.Set, color: Color) -> some View {
        overlay(alignment: .top) {
            if edges.contains(.bottom) {
                Divider()
                    .background(color)
                    .frame(height: width)
                    .alignmentGuide(.bottom) { $0[.bottom] }
            }
        }
    }
}
