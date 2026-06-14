import SwiftUI

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
    private var outsideClickMonitor: Any?
    private var mainContentHeight: CGFloat = 620

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide from Dock — menu bar only
        NSApp.setActivationPolicy(.accessory)

        if SettingsStore.shared.lowQuotaNotificationsEnabled {
            NotificationService.shared.requestAuthorization()
        }

        // Start Sparkle auto-updater (no-ops in dev runs without a bundle).
        UpdaterController.shared.start()

        // ── Status Item ──
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "0"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePopover)
        statusItem.button?.sendAction(on: [.leftMouseDown, .rightMouseDown])

        // ── Popover Window (arrowless, native shadow) ──
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
        panel.hidesOnDeactivate = true
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

        Task { @MainActor in
            do {
                NSLog("[TokenDash] Starting daemon...")
                let port = try await manager.startDaemon()
                NSLog("[TokenDash] Daemon ready on port \(port)")
                updater.start(port: port)
                NSLog("[TokenDash] BadgeUpdater started")
            } catch {
                NSLog("[TokenDash] Failed to start daemon: \(error.localizedDescription)")
                state.errorMessage = error.localizedDescription
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopOutsideClickMonitor()
        badgePollTimer?.invalidate()
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

            // Calculate fitting height from content when showing main view
            if !state.showSettings {
                let fittingSize = hosting.sizeThatFits(in: NSSize(width: 380, height: CGFloat.greatestFiniteMagnitude))
                if fittingSize.height > 100 {
                    mainContentHeight = min(fittingSize.height, 620)
                }
            }

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
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
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
