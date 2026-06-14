import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @Environment(AppState.self) private var state
    @Bindable var settings = SettingsStore.shared
    @Bindable var updater = UpdaterController.shared
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
        .task {
            syncLaunchAtLoginStatus()
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
                SettingsRow(icon: "power", title: "Launch at Login", showDivider: true) {
                    ThemeSwitch(isOn: Binding(
                        get: { state.isLaunchAtLoginEnabled },
                        set: { setLaunchAtLogin($0) }
                    ))
                }
                SettingsRow(icon: "arrow.clockwise", title: "Refresh Usage", showDivider: true) {
                    Picker("", selection: $settings.refreshInterval) {
                        ForEach(SettingsStore.RefreshInterval.allCases) { interval in
                            Text(interval.label).tag(interval)
                        }
                    }
                    .pickerStyle(.menu).controlSize(.small).frame(width: 110).labelsHidden()
                }
                SettingsRow(icon: "circle.lefthalf.filled", title: "Appearance", showDivider: false) {
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
                SettingsRow(icon: "key.fill", title: codingPlansTitle, showDivider: false) {
                    Button("Manage") { showCredentialSheet = true }
                        .font(.system(size: 11, weight: .medium))
                        .controlSize(.small)
                }
            }
        }
    }

    private var codingPlansTitle: String {
        let count = state.quotas.filter { $0.status.state == "ok" }.count
        guard count > 0 else { return "API Credentials" }
        return "API Credentials · \(count) Connected"
    }

    // MARK: - Notifications

    private var notificationsCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "Notifications")
            SettingsCard {
                SettingsRow(icon: "bell.badge", title: "Low Quota Alerts", showDivider: true) {
                    ThemeSwitch(isOn: $settings.lowQuotaNotificationsEnabled)
                        .onChange(of: settings.lowQuotaNotificationsEnabled) { _, enabled in
                            if enabled {
                                NotificationService.shared.requestAuthorization { granted in
                                    if !granted {
                                        settings.lowQuotaNotificationsEnabled = false
                                    }
                                }
                            }
                        }
                }
                SettingsRow(icon: "percent", title: "Alert Threshold", showDivider: false) {
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
                SettingsRow(icon: "tag", title: "Version \(state.appVersion)", showDivider: true) {
                    Button("Check for Updates") { UpdaterController.shared.checkForUpdates() }
                        .font(.system(size: 11, weight: .medium))
                        .controlSize(.small)
                        .disabled(!updater.canCheckForUpdates)
                }
                SettingsRow(icon: "checkmark.circle", title: "Automatic Update Checks", showDivider: true) {
                    ThemeSwitch(isOn: $settings.autoCheckUpdates)
                        .onChange(of: settings.autoCheckUpdates) { _, _ in
                            UpdaterController.shared.applyAutoCheck()
                        }
                }
                linkRow(icon: "globe", title: "GitHub Repository", url: "https://github.com/zhangferry/tokendash", divider: true)
                SettingsRow(icon: "xmark.circle", title: "Quit TokenDash", showDivider: false) {
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
            syncLaunchAtLoginStatus()
        } catch {
            syncLaunchAtLoginStatus()
            NSLog("[TokenDash] Failed to update launch at login: \(error.localizedDescription)")
        }
    }

    private func syncLaunchAtLoginStatus() {
        state.isLaunchAtLoginEnabled = SMAppService.mainApp.status == .enabled
    }
}
