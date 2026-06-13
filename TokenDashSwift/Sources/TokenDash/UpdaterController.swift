import Foundation
import Sparkle

/// Thin wrapper around Sparkle's standard updater. Sparkle owns the update
/// alert, progress, signature verification, install, and relaunch UI; this just
/// starts it and exposes the two actions the Settings card needs.
///
/// In a dev run (bare binary from .build/debug) there's no app bundle with
/// SUFeedURL, so Sparkle no-ops and logs — that's fine; it only matters in the
/// packaged .app where Info.plist carries SUFeedURL/SUPublicEDKey.
@MainActor final class UpdaterController {
    static let shared = UpdaterController()
    private var sparkle: SPUStandardUpdaterController?

    /// True only inside a real .app bundle. Sparkle needs SUFeedURL from
    /// Info.plist; in a bare-binary dev run it would throw, so skip it.
    private var isBundled: Bool { Bundle.main.bundleIdentifier != nil }

    func start() {
        guard sparkle == nil, isBundled else { return }
        sparkle = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        applyAutoCheck()
    }

    /// Sparkle presents its own update window.
    func checkForUpdates() {
        guard isBundled else { return }
        sparkle?.updater.checkForUpdates()
    }

    /// Sync the in-app toggle to Sparkle's auto-check flag.
    func applyAutoCheck() {
        guard isBundled else { return }
        sparkle?.updater.automaticallyChecksForUpdates = SettingsStore.shared.autoCheckUpdates
    }
}
