import SwiftUI
import Combine

/// Central observable state shared across all views.
/// Use `.shared` singleton to ensure App, AppDelegate, and BadgeUpdater all
/// reference the same instance — SwiftUI @State holds a class reference, so
/// changes propagate correctly.
@Observable class AppState {
    static let shared = AppState()

    // Connection
    var daemonPort: Int = 3456
    var isDaemonReady = false
    var errorMessage: String?

    // Badge
    var badgeImage: NSImage?
    var tooltipText: String = "TokenDash"

    // Popover data
    var isLoading = true
    var cacheRate: Double = 0
    var todaySummary: TodaySummary?
    var hourlyData: [HourBucket] = []
    var projects: [ProjectRow] = []
    var models: [ModelRow] = []
    var trend: [TrendPoint] = []
    var quotas: [QuotaSnapshot] = []

    // Settings
    var isLaunchAtLoginEnabled = false

    // Navigation
    var showSettings = false

    /// Lets the credential sheet trigger an immediate quota refresh after saving.
    @ObservationIgnored weak var badgeUpdater: BadgeUpdater?

    // Version
    var appVersion: String = {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }()
}
