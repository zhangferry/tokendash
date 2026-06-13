// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "TokenDash",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.7.0"),
    ],
    targets: [
        .executableTarget(
            name: "TokenDash",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/TokenDash"
        ),
    ]
)
