import Cocoa

// TokenDash Native Tray Helper for macOS 26+
// Communicates with Electron main process via stdin/stdout
// Protocol:
//   stdin commands:  "title:<text>\n"  "tooltip:<text>\n"  "quit\n"
//   stdout events:   "click:<screenX>,<screenY>\n"

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var readHandle: FileHandle?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Create status bar item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Add a small template icon (filled circle) before the title
        let icon = createTemplateIcon(size: NSSize(width: 18, height: 18))
        statusItem.button?.image = icon
        statusItem.button?.imagePosition = .imageLeft
        statusItem.button?.imageScaling = .scaleProportionallyDown

        statusItem.button?.title = "0.0M"
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

    @objc func handleClick(_ sender: Any?) {
        guard let _ = NSApp.currentEvent else { return }
        // Send click with screen coordinates so Electron can position the popover
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
                    statusItem.button?.title = title
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

        // Draw the TokenDash wavy line icon (from SVG, 64x64 viewBox scaled to size)
        // SVG coords use top-left origin; AppKit uses bottom-left, so flip Y: y = (64 - svgY)
        let sx = size.width / 64.0
        let sy = size.height / 64.0

        let path = NSBezierPath()
        // M6,32 H18
        path.move(to: NSPoint(x: 6 * sx, y: (64 - 32) * sy))
        path.line(to: NSPoint(x: 18 * sx, y: (64 - 32) * sy))
        // C21,32 22.5,34 24.5,39
        path.curve(to: NSPoint(x: 24.5 * sx, y: (64 - 39) * sy),
                   controlPoint1: NSPoint(x: 21 * sx, y: (64 - 32) * sy),
                   controlPoint2: NSPoint(x: 22.5 * sx, y: (64 - 34) * sy))
        // C27,45.5 30,50 34,50
        path.curve(to: NSPoint(x: 34 * sx, y: (64 - 50) * sy),
                   controlPoint1: NSPoint(x: 27 * sx, y: (64 - 45.5) * sy),
                   controlPoint2: NSPoint(x: 30 * sx, y: (64 - 50) * sy))
        // C38,50 40.5,42 44,22
        path.curve(to: NSPoint(x: 44 * sx, y: (64 - 22) * sy),
                   controlPoint1: NSPoint(x: 38 * sx, y: (64 - 50) * sy),
                   controlPoint2: NSPoint(x: 40.5 * sx, y: (64 - 42) * sy))
        // C46,11 49,8 52,8
        path.curve(to: NSPoint(x: 52 * sx, y: (64 - 8) * sy),
                   controlPoint1: NSPoint(x: 46 * sx, y: (64 - 11) * sy),
                   controlPoint2: NSPoint(x: 49 * sx, y: (64 - 8) * sy))
        // C55,8 57.5,13 60,22
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
