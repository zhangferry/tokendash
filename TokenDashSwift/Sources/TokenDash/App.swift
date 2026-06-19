import SwiftUI
import ServiceManagement

@main
struct TokenDashApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

// MARK: - Arrowless popover panel

final class PopoverPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// MARK: - AppDelegate: full menu bar lifecycle

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var panel: PopoverPanel!
    var hosting: NSHostingController<AnyView>!
    let state = AppState.shared
    var daemonManager: DaemonManager?
    var badgeUpdater: BadgeUpdater?
    private var badgePollTimer: Timer?
    private var daemonHealthTimer: Timer?
    private var outsideClickMonitor: Any?
    private var mainContentHeight: CGFloat = 620

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide from Dock — menu bar only
        NSApp.setActivationPolicy(.accessory)

        // ── Status Item ──
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let initialBadge = BadgeUpdater.renderBadgeImage(title: "0K")
        state.badgeImage = initialBadge
        lastBadgeImage = initialBadge
        statusItem.button?.image = initialBadge
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.title = ""
        statusItem.button?.toolTip = "TokenDash - loading usage data"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // ── Popover Window (arrowless, native shadow) ──
        state.isLaunchAtLoginEnabled = SMAppService.mainApp.status == .enabled
        let rootView = AnyView(PopoverView().environment(state))
        hosting = NSHostingController(rootView: rootView)

        panel = PopoverPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 620),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        panel.animationBehavior = .default
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentViewController = hosting

        // ── Daemon + Badge ──
        let manager = DaemonManager()
        self.daemonManager = manager

        let updater = BadgeUpdater(state: state)
        self.badgeUpdater = updater
        state.badgeUpdater = updater

        badgePollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                self?.syncBadgeFromState()
            }
        }

        // Health monitor: if the daemon dies (crash, OOM kill, macOS sleep
        // reclaim), restart it automatically so the popover never gets stuck
        // on "Unable to fetch data". Cheap liveness check — no spawn if alive.
        daemonHealthTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            self?.checkDaemonHealth()
        }

        // Let AppKit finish installing the status item and panel before any
        // startup service work begins, so the very first click is responsive.
        DispatchQueue.main.async {
            if SettingsStore.shared.lowQuotaNotificationsEnabled {
                NotificationService.shared.requestAuthorization()
            }
            UpdaterController.shared.start()

            Task { @MainActor in
                await self.startDaemonWithRetry()
            }
        }
    }

    /// Spawn (or reattach to) the daemon with a few retries. If every attempt
    /// fails, the 30s health monitor keeps trying in the background.
    @MainActor private func startDaemonWithRetry(maxAttempts: Int = 3) async {
        guard let manager = daemonManager else { return }
        for attempt in 1...maxAttempts {
            do {
                NSLog("[TokenDash] Starting daemon (attempt \(attempt)/\(maxAttempts))...")
                let port = try await manager.startDaemon()
                NSLog("[TokenDash] Daemon ready on port \(port)")
                badgeUpdater?.start(port: port)
                NSLog("[TokenDash] BadgeUpdater started")
                return
            } catch {
                NSLog("[TokenDash] Daemon start attempt \(attempt) failed: \(error.localizedDescription)")
                state.isDaemonReady = false
                if attempt < maxAttempts {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                } else {
                    state.errorMessage = error.localizedDescription
                }
            }
        }
    }

    /// Periodic liveness check. Restarts the daemon if it has died and
    /// hot-switches the BadgeUpdater to the new port so the popover recovers
    /// without an app restart.
    func checkDaemonHealth() {
        guard let manager = daemonManager else { return }
        if manager.isAlive() { return }
        NSLog("[TokenDash] Health check: daemon not alive — restarting")
        state.isDaemonReady = false
        Task { @MainActor in
            do {
                let port = try await manager.startDaemon()
                badgeUpdater?.updatePort(port)
                NSLog("[TokenDash] Daemon restarted on port \(port)")
            } catch {
                NSLog("[TokenDash] Daemon restart failed: \(error.localizedDescription)")
                state.errorMessage = error.localizedDescription
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopOutsideClickMonitor()
        badgePollTimer?.invalidate()
        daemonHealthTimer?.invalidate()
        badgeUpdater?.stop()
        daemonManager?.stopDaemon()
    }

    // MARK: - Panel toggle

    @objc private func togglePopover() {
        if panel.isVisible {
            hidePopover()
        } else {
            guard let button = statusItem.button else { return }
            let buttonFrame = button.window?.convertToScreen(button.convert(button.bounds, to: nil)) ?? .zero

            let panelWidth: CGFloat = 380
            let panelHeight = mainContentHeight
            var panelX = buttonFrame.midX - panelWidth / 2
            let panelY = buttonFrame.minY - panelHeight

            // Keep panel on screen
            if let screen = button.window?.screen ?? NSScreen.main {
                let visibleFrame = screen.visibleFrame
                if panelX + panelWidth > visibleFrame.maxX {
                    panelX = visibleFrame.maxX - panelWidth - 4
                }
                if panelX < visibleFrame.minX {
                    panelX = visibleFrame.minX + 4
                }
            }

            panel.setFrame(NSRect(x: panelX, y: panelY, width: panelWidth, height: panelHeight), display: true)
            panel.orderFrontRegardless()
            panel.makeKey()
            startOutsideClickMonitor()
        }
    }

    private func hidePopover() {
        panel.orderOut(nil)
        stopOutsideClickMonitor()
    }

    private func startOutsideClickMonitor() {
        stopOutsideClickMonitor()
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.isVisible else { return }
            self.outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
                matching: [.leftMouseDown, .rightMouseDown]
            ) { [weak self] _ in
                DispatchQueue.main.async {
                    self?.hidePopover()
                }
            }
        }
    }

    private func stopOutsideClickMonitor() {
        guard let outsideClickMonitor else { return }
        NSEvent.removeMonitor(outsideClickMonitor)
        self.outsideClickMonitor = nil
    }

    // MARK: - Badge sync (timer-based, always reliable)

    private var lastBadgeImage: NSImage?

    private func syncBadgeFromState() {
        let newImage = state.badgeImage
        if newImage !== lastBadgeImage {
            lastBadgeImage = newImage
            if let image = newImage {
                statusItem.button?.image = image
                statusItem.button?.imagePosition = .imageOnly
                statusItem.button?.title = ""
            }
        }
        statusItem.button?.toolTip = state.tooltipText
    }
}
