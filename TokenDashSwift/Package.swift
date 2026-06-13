// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TokenDash",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "TokenDash",
            path: "Sources/TokenDash"
        ),
    ]
)
