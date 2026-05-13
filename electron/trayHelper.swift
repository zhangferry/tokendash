import Cocoa

// TokenDash Native Tray Helper for macOS 26+
// Communicates with Electron main process via stdin/stdout
// Protocol:
//   stdin commands:  "title:<text>\n"  "tooltip:<text>\n"  "quit\n"
//   stdout events:   "click:<screenX>,<screenY>\n"

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var readHandle: FileHandle?
    var currentTitle = "0"

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        statusItem.button?.image = renderCombinedImage(title: currentTitle)
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.imageScaling = .scaleProportionallyDown
        statusItem.button?.isBordered = false
        statusItem.button?.title = ""
        statusItem.button?.toolTip = "TokenDash"

        // Set up click actions — both left and right click
        statusItem.button?.target = self
        statusItem.button?.action = #selector(handleClick(_:))
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        // Read commands from stdin
        readHandle = FileHandle.standardInput
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleStdin),
            name: .NSFileHandleDataAvailable,
            object: readHandle
        )
        readHandle?.waitForDataInBackgroundAndNotify()

        // Signal ready
        sendEvent("ready")
    }

    /// Render icon + title text into a single template image for the status bar.
    func renderCombinedImage(title: String) -> NSImage {
        let iconW: CGFloat = 18
        let iconH: CGFloat = 18
        let fontSize: CGFloat = 13
        let font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: .medium)
        let textAttrs: [NSAttributedString.Key: Any] = [.font: font]
        let textWidth = (title as NSString).size(withAttributes: textAttrs).width
        let padding: CGFloat = 4  // gap between icon and text

        let totalWidth = iconW + padding + textWidth
        // Status bar height is ~22pt; center vertically
        let totalHeight: CGFloat = 20

        let image = NSImage(size: NSSize(width: totalWidth, height: totalHeight))
        image.lockFocus()

        // Draw icon centered vertically
        let icon = createTemplateIcon(size: NSSize(width: iconW, height: iconH))
        let iconY = (totalHeight - iconH) / 2.0
        icon.draw(in: NSRect(x: 0, y: iconY, width: iconW, height: iconH))

        // Draw text centered vertically (baseline-adjusted)
        let textY = (totalHeight - fontSize) / 2.0 - 1
        (title as NSString).draw(at: NSPoint(x: iconW + padding, y: textY), withAttributes: textAttrs)

        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    @objc func handleClick(_ sender: Any?) {
        guard let _ = NSApp.currentEvent else { return }
        let loc = NSEvent.mouseLocation
        sendEvent("click:\(Int(loc.x)),\(Int(loc.y))")
    }

    @objc func handleStdin() {
        guard let data = readHandle?.availableData, data.count > 0 else {
            readHandle?.waitForDataInBackgroundAndNotify()
            return
        }

        if let line = String(data: data, encoding: .utf8) {
            for command in line.split(separator: "\n") {
                let cmd = command.trimmingCharacters(in: .whitespacesAndNewlines)
                if cmd.hasPrefix("title:") {
                    let title = String(cmd.dropFirst(6))
                    currentTitle = title
                    statusItem.button?.image = renderCombinedImage(title: title)
                } else if cmd.hasPrefix("tooltip:") {
                    let tooltip = String(cmd.dropFirst(8))
                    statusItem.button?.toolTip = tooltip
                } else if cmd == "quit" {
                    NSApp.terminate(nil)
                    return
                }
            }
        }

        readHandle?.waitForDataInBackgroundAndNotify()
    }

    func sendEvent(_ event: String) {
        print(event)
        fflush(stdout)
    }

    func createTemplateIcon(size: NSSize) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()

        let sx = size.width / 64.0
        let sy = size.height / 64.0

        let path = NSBezierPath()
        path.move(to: NSPoint(x: 6 * sx, y: (64 - 32) * sy))
        path.line(to: NSPoint(x: 18 * sx, y: (64 - 32) * sy))
        path.curve(to: NSPoint(x: 24.5 * sx, y: (64 - 39) * sy),
                   controlPoint1: NSPoint(x: 21 * sx, y: (64 - 32) * sy),
                   controlPoint2: NSPoint(x: 22.5 * sx, y: (64 - 34) * sy))
        path.curve(to: NSPoint(x: 34 * sx, y: (64 - 50) * sy),
                   controlPoint1: NSPoint(x: 27 * sx, y: (64 - 45.5) * sy),
                   controlPoint2: NSPoint(x: 30 * sx, y: (64 - 50) * sy))
        path.curve(to: NSPoint(x: 44 * sx, y: (64 - 22) * sy),
                   controlPoint1: NSPoint(x: 38 * sx, y: (64 - 50) * sy),
                   controlPoint2: NSPoint(x: 40.5 * sx, y: (64 - 42) * sy))
        path.curve(to: NSPoint(x: 52 * sx, y: (64 - 8) * sy),
                   controlPoint1: NSPoint(x: 46 * sx, y: (64 - 11) * sy),
                   controlPoint2: NSPoint(x: 49 * sx, y: (64 - 8) * sy))
        path.curve(to: NSPoint(x: 60 * sx, y: (64 - 22) * sy),
                   controlPoint1: NSPoint(x: 55 * sx, y: (64 - 8) * sy),
                   controlPoint2: NSPoint(x: 57.5 * sx, y: (64 - 13) * sy))

        path.lineWidth = 5 * sx
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor.black.setStroke()
        path.stroke()

        image.unlockFocus()
        image.isTemplate = true
        return image
    }
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApp.run()
