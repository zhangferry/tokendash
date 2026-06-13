import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @Environment(AppState.self) private var state
    @Bindable var settings = SettingsStore.shared
    @State private var showCredentialSheet = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                VStack(alignment: .leading, spacing: 0) {
                    generalCard
                    appearanceCard
                    codingPlansCard
                    notificationsCard
                    updatesCard
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

    // MARK: - Header

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
    }

    // MARK: - General

    private var generalCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "General")
            SettingsCard {
                SettingsRow(icon: "power", title: "Launch at login",
                            subtitle: "Keep TokenDash in the menu bar after sign in.",
                            showDivider: true) {
                    Toggle("", isOn: Binding(
                        get: { state.isLaunchAtLoginEnabled },
                        set: { setLaunchAtLogin($0) }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .labelsHidden()
                }
                SettingsRow(icon: "arrow.clockwise", title: "Refresh interval",
                            subtitle: "How often usage and quota are re-fetched.",
                            showDivider: false) {
                    Picker("", selection: $settings.refreshInterval) {
                        ForEach(SettingsStore.RefreshInterval.allCases) { interval in
                            Text(interval.label).tag(interval)
                        }
                    }
                    .pickerStyle(.menu)
                    .controlSize(.small)
                    .frame(width: 110)
                    .labelsHidden()
                }
            }
        }
    }

    // MARK: - Appearance

    private var appearanceCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "Appearance")
            SettingsCard {
                SettingsRow(icon: "circle.lefthalf.filled", title: "Theme",
                            subtitle: "Popover color scheme.",
                            showDivider: false) {
                    Picker("", selection: $settings.appearance) {
                        ForEach(SettingsStore.Appearance.allCases) { a in
                            Text(a.label).tag(a)
                        }
                    }
                    .pickerStyle(.menu)
                    .controlSize(.small)
                    .frame(width: 120)
                    .labelsHidden()
                }
            }
        }
    }

    // MARK: - Coding Plans

    private var codingPlansCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "Coding Plans")
            SettingsCard {
                ForEach(Array(providerRows.enumerated()), id: \.element.id) { index, row in
                    SettingsRow(icon: row.icon, title: row.name, subtitle: row.status, showDivider: index < providerRows.count - 1) {
                        EmptyView()
                    }
                }
                if !providerRows.isEmpty {
                    SettingsRow(icon: "key.fill", title: "Manage credentials",
                                subtitle: "Add or edit API keys for GLM / Kimi / MiniMax.",
                                showDivider: false) {
                        Button("Configure") { showCredentialSheet = true }
                            .font(.system(size: 11, weight: .medium))
                            .controlSize(.small)
                    }
                } else {
                    SettingsRow(icon: "key.fill", title: "Configure credentials",
                                subtitle: "Add an API key to enable a Coding Plan provider.",
                                showDivider: false) {
                        Button("Add") { showCredentialSheet = true }
                            .font(.system(size: 11, weight: .medium))
                            .controlSize(.small)
                    }
                }
            }
        }
    }

    private struct ProviderStatusRow: Identifiable {
        let id: String
        let name: String
        let icon: String
        let status: String
    }

    private var providerRows: [ProviderStatusRow] {
        guard !state.quotas.isEmpty else { return [] }
        return state.quotas.map { q in
            let isOk = q.status.state == "ok"
            return ProviderStatusRow(
                id: q.provider,
                name: q.displayName,
                icon: providerIcon(q.provider),
                status: isOk ? (q.planName.map { "\($0) · connected" } ?? "Connected") : "Check credentials"
            )
        }
    }

    private func providerIcon(_ provider: String) -> String {
        switch provider {
        case "claude": return "c.circle.fill"
        case "codex": return "o.circle.fill"
        case "glm": return "g.circle.fill"
        case "kimi": return "k.circle.fill"
        case "minimax": return "m.circle.fill"
        default: return "creditcard.fill"
        }
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
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .labelsHidden()
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

    // MARK: - Updates

    private var updatesCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "Updates")
            SettingsCard {
                SettingsRow(icon: "tag", title: "TokenDash",
                            subtitle: "Version \(state.appVersion)",
                            showDivider: true) { EmptyView() }
                SettingsRow(icon: "checkmark.circle", title: "Automatically check",
                            subtitle: "Check for new releases in the background.",
                            showDivider: true) {
                    Toggle("", isOn: $settings.autoCheckUpdates)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .labelsHidden()
                        .onChange(of: settings.autoCheckUpdates) { _, _ in
                            UpdaterController.shared.applyAutoCheck()
                        }
                }
                SettingsRow(icon: "arrow.triangle.2.circlepath", title: "Check for updates",
                            subtitle: "Sparkle verifies the signature and installs in place.",
                            showDivider: false) {
                    Button("Check") { UpdaterController.shared.checkForUpdates() }
                        .font(.system(size: 11, weight: .medium))
                        .controlSize(.small)
                }
            }
        }
    }

    // MARK: - About

    private var aboutCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsSectionHeader(title: "About")
            SettingsCard {
                SettingsRow(icon: "info.circle", title: "TokenDash",
                            subtitle: "Version \(state.appVersion)",
                            showDivider: true) { EmptyView() }
                linkRow(icon: "globe", title: "GitHub Repository", url: "https://github.com/zhangferry/tokendash", divider: true)
                linkRow(icon: "doc.text", title: "Release Notes", url: "https://github.com/zhangferry/tokendash/releases", divider: false)
                SettingsRow(icon: "xmark.circle", title: "Quit TokenDash",
                            subtitle: "Close the app and stop background services.",
                            showDivider: false) {
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
