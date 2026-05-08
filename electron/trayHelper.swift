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
        statusItem.button?.title = "$0"
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
        guard let event = NSApp.currentEvent else { return }
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
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApp.run()
