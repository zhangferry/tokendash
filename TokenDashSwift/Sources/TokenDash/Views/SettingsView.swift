import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @Environment(AppState.self) private var state
    @Bindable var settings = SettingsStore.shared
    @State private var showCredentialSheet = false

    var body: some View {
        VStack(spacing: 0) {
            // Sticky header — stays fixed while the list scrolls below it.
            header

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    generalCard
                    codingPlansCard
                    notificationsCard
                    aboutCard
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .frame(width: 380)
        .background(Color.popoverBackground)
        .sheet(isPresented: $showCredentialSheet) {
            CredentialSheet()
        }
    }

    // MARK: - Sticky header

    private var header: some View {
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
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.popoverBackground)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.dividerColor).frame(height: 0.5)
        }
    }

    // MARK: - General (merged with Appearance)

    private var generalCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "General")
            SettingsCard {
                SettingsRow(icon: "power", title: "Launch at login",
                            subtitle: "Open in the menu bar after sign in.",
                            showDivider: true) {
                    Toggle("", isOn: Binding(
                        get: { state.isLaunchAtLoginEnabled },
                        set: { setLaunchAtLogin($0) }
                    ))
                    .toggleStyle(.switch).controlSize(.small).labelsHidden()
                }
                SettingsRow(icon: "arrow.clockwise", title: "Refresh interval",
                            subtitle: "Usage and quota re-fetch cadence.",
                            showDivider: true) {
                    Picker("", selection: $settings.refreshInterval) {
                        ForEach(SettingsStore.RefreshInterval.allCases) { interval in
                            Text(interval.label).tag(interval)
                        }
                    }
                    .pickerStyle(.menu).controlSize(.small).frame(width: 110).labelsHidden()
                }
                SettingsRow(icon: "circle.lefthalf.filled", title: "Theme",
                            subtitle: "Light, dark, or match system.",
                            showDivider: false) {
                    Picker("", selection: $settings.appearance) {
                        ForEach(SettingsStore.Appearance.allCases) { a in
                            Text(a.label).tag(a)
                        }
                    }
                    .pickerStyle(.menu).controlSize(.small).frame(width: 120).labelsHidden()
                }
            }
        }
    }

    // MARK: - Coding Plans (single Manage row; status lives in the main popover)

    private var codingPlansCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "Coding Plans")
            SettingsCard {
                SettingsRow(icon: "key.fill", title: "API credentials",
                            subtitle: codingPlansSubtitle, showDivider: false) {
                    Button("Manage") { showCredentialSheet = true }
                        .font(.system(size: 11, weight: .medium))
                        .controlSize(.small)
                }
            }
        }
    }

    private var codingPlansSubtitle: String {
        let count = state.quotas.filter { $0.status.state == "ok" }.count
        if count == 0 { return "No providers connected." }
        return "\(count) provider\(count > 1 ? "s" : "") connected."
    }

    // MARK: - Notifications

    private var notificationsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "Notifications")
            SettingsCard {
                SettingsRow(icon: "bell.badge", title: "Low quota alerts",
                            subtitle: "Notify when a provider crosses the threshold.",
                            showDivider: true) {
                    Toggle("", isOn: $settings.lowQuotaNotificationsEnabled)
                        .toggleStyle(.switch).controlSize(.small).labelsHidden()
                }
                SettingsRow(icon: "percent", title: "Threshold",
                            subtitle: "Usage percentage that triggers an alert.",
                            showDivider: false) {
                    Stepper("\(settings.lowQuotaThreshold)%", value: $settings.lowQuotaThreshold, in: 50...95, step: 5)
                        .font(.system(size: 11, weight: .medium))
                        .monospacedDigit()
                }
            }
        }
    }

    // MARK: - About & Updates (merged)

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "About & Updates")
            SettingsCard {
                SettingsRow(icon: "tag", title: "Version",
                            subtitle: state.appVersion,
                            showDivider: true) {
                    Button("Check for Updates") { UpdaterController.shared.checkForUpdates() }
                        .font(.system(size: 11, weight: .medium))
                        .controlSize(.small)
                }
                SettingsRow(icon: "checkmark.circle", title: "Automatically check",
                            subtitle: "Check for new releases in the background.",
                            showDivider: true) {
                    Toggle("", isOn: $settings.autoCheckUpdates)
                        .toggleStyle(.switch).controlSize(.small).labelsHidden()
                        .onChange(of: settings.autoCheckUpdates) { _, _ in
                            UpdaterController.shared.applyAutoCheck()
                        }
                }
                linkRow(icon: "globe", title: "GitHub Repository", url: "https://github.com/zhangferry/tokendash", divider: true)
                SettingsRow(icon: "xmark.circle", title: "Quit TokenDash",
                            subtitle: nil, showDivider: false) {
                    Button("Quit") { NSApp.terminate(nil) }
                        .font(.system(size: 11, weight: .medium))
                        .controlSize(.small)
                        .foregroundStyle(.red)
                }
            }
        }
    }

    private func linkRow(icon: String, title: String, url: String, divider: Bool) -> some View {
        Button {
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.accentGreen)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 10))
                    .foregroundStyle(Color.tertiaryLabel)
            }
            .padding(.vertical, 10)
            .overlay(alignment: .bottom) {
                if divider {
                    Rectangle().fill(Color.dividerColor).frame(height: 0.5).padding(.leading, 28)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Helpers

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
