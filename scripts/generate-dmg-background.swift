import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: generate-dmg-background.swift <output.png>\n", stderr)
    exit(1)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let size = NSSize(width: 1200, height: 760)
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(size.width),
    pixelsHigh: Int(size.height),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bitmapFormat: [],
    bytesPerRow: 0,
    bitsPerPixel: 0
), let graphicsContext = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fputs("Unable to create DMG background canvas\n", stderr)
    exit(1)
}

NSGraphicsContext.current = graphicsContext
defer { NSGraphicsContext.current = nil }

NSColor(calibratedRed: 0.97, green: 0.965, blue: 0.94, alpha: 1).setFill()
NSRect(origin: .zero, size: size).fill()

let titleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 32, weight: .semibold),
    .foregroundColor: NSColor(calibratedRed: 0.12, green: 0.17, blue: 0.14, alpha: 1),
]
let subtitleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 20, weight: .medium),
    .foregroundColor: NSColor(calibratedRed: 0.27, green: 0.34, blue: 0.30, alpha: 1),
]

func drawCentered(_ text: String, centerX: CGFloat, y: CGFloat, attributes: [NSAttributedString.Key: Any]) {
    let rendered = NSString(string: text)
    let textSize = rendered.size(withAttributes: attributes)
    rendered.draw(at: NSPoint(x: centerX - textSize.width / 2, y: y), withAttributes: attributes)
}

drawCentered("Install TokenDash", centerX: 444, y: 654, attributes: titleAttributes)
drawCentered("Drag the app to Applications to finish installation", centerX: 444, y: 622, attributes: subtitleAttributes)

let accent = NSColor(calibratedRed: 0.16, green: 0.48, blue: 0.34, alpha: 1)
accent.setStroke()
let arrow = NSBezierPath()
arrow.lineWidth = 4
arrow.lineCapStyle = .round
arrow.move(to: NSPoint(x: 335, y: 510))
arrow.line(to: NSPoint(x: 535, y: 510))
arrow.stroke()

let arrowHead = NSBezierPath()
arrowHead.lineWidth = 3
arrowHead.lineCapStyle = .round
arrowHead.move(to: NSPoint(x: 515, y: 522))
arrowHead.line(to: NSPoint(x: 555, y: 510))
arrowHead.line(to: NSPoint(x: 515, y: 498))
arrowHead.stroke()

let footerAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 15, weight: .medium),
    .foregroundColor: NSColor(calibratedRed: 0.43, green: 0.48, blue: 0.44, alpha: 1),
]
drawCentered("1. Drag TokenDash to Applications", centerX: 475, y: 68, attributes: footerAttributes)

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Unable to encode DMG background PNG\n", stderr)
    exit(1)
}

do {
    try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try png.write(to: outputURL)
} catch {
    fputs("Unable to write DMG background: \(error)\n", stderr)
    exit(1)
}
