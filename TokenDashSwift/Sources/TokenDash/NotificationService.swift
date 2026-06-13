import Foundation
import UserNotifications

/// Fires a local macOS notification when a Coding Plan provider crosses the
/// configured usage threshold. Dedupes per (provider, window) so a sustained
/// high-usage state doesn't spam — it only notifies on the first crossing after
/// the app launches or after the window drops back below the threshold.
@MainActor final class NotificationService {
    static let shared = NotificationService()
    private var alertedKeys = Set<String>()

    /// True only inside a real .app bundle. In a bare-binary dev run (swift build
    /// → run .build/debug/TokenDash) there's no bundle identifier, and
    /// UNUserNotificationCenter.current() throws — so notifications are dev-only-off.
    private var isBundled: Bool { Bundle.main.bundleIdentifier != nil }

    /// Request notification permission (idempotent). Called once at launch.
    func requestAuthorization() {
        guard isBundled else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Inspect the latest quota snapshots; notify on threshold crossings.
    func evaluate(quotas: [QuotaSnapshot]) {
        guard isBundled else { return }
        let settings = SettingsStore.shared
        guard settings.lowQuotaNotificationsEnabled else { return }
        let threshold = Double(settings.lowQuotaThreshold)

        for quota in quotas where quota.status.state == "ok" {
            for window in quota.windows where window.isUnlimited != true {
                let key = "\(quota.provider):\(window.id)"
                if window.usedPercent >= threshold {
                    if !alertedKeys.contains(key) {
                        alertedKeys.insert(key)
                        fire(title: "\(quota.displayName) quota at \(Int(window.usedPercent.rounded()))%",
                             body: "\(window.label) has crossed the \(threshold)% threshold.",
                             identifier: "tokendash.quota.\(key)")
                    }
                } else {
                    // Dropped back below — clear so a future re-crossing notifies again.
                    alertedKeys.remove(key)
                }
            }
        }
    }

    private func fire(title: String, body: String, identifier: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
}
