import Foundation

// MARK: - Update types

struct UpdateInfo {
    let currentVersion: String
    let latestVersion: String
    let upToDate: Bool
    let asset: AssetInfo?
    let error: String?

    struct AssetInfo {
        let url: String
        let name: String
        let size: Int
    }
}

// MARK: - Update Service

actor UpdateService {
    private let repo = "zhangferry/tokendash"
    private let packageName = "@zhangferry-dev/tokendash"

    func checkForUpdates(currentVersion: String) async -> UpdateInfo {
        guard let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else {
            return UpdateInfo(currentVersion: currentVersion, latestVersion: currentVersion, upToDate: true, asset: nil, error: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return UpdateInfo(currentVersion: currentVersion, latestVersion: currentVersion, upToDate: true, asset: nil, error: "HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }

            struct GitHubRelease: Decodable {
                let tag_name: String
                let assets: [GitHubAsset]
            }
            struct GitHubAsset: Decodable {
                let name: String
                let browser_download_url: String
                let size: Int
            }

            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            let latest = release.tag_name.hasPrefix("v") ? String(release.tag_name.dropFirst()) : release.tag_name

            let isUpToDate = currentVersion == latest || compareVersions(currentVersion, latest) >= 0

            let dmgAsset = release.assets.first { $0.name.hasSuffix(".dmg") && $0.name.contains("arm64") }
                ?? release.assets.first { $0.name.hasSuffix(".dmg") }

            let asset = dmgAsset.map {
                UpdateInfo.AssetInfo(url: $0.browser_download_url, name: $0.name, size: $0.size)
            }

            return UpdateInfo(
                currentVersion: currentVersion,
                latestVersion: latest,
                upToDate: isUpToDate,
                asset: asset,
                error: nil
            )
        } catch {
            return UpdateInfo(currentVersion: currentVersion, latestVersion: currentVersion, upToDate: true, asset: nil, error: error.localizedDescription)
        }
    }

    func downloadUpdate(asset: UpdateInfo.AssetInfo, progress: @escaping (Double) -> Void) async -> Result<URL, Error> {
        guard let url = URL(string: asset.url) else {
            return .failure(UpdateError.invalidURL)
        }

        let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TokenDash Updates")
        try? FileManager.default.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
        let destURL = downloadsDir.appendingPathComponent(asset.name)

        do {
            // Use URLSession delegate-based download for progress reporting
            let (tempURL, response) = try await URLSession.shared.download(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return .failure(UpdateError.httpError((response as? HTTPURLResponse)?.statusCode ?? -1))
            }
            progress(1.0)
            try FileManager.default.moveItem(at: tempURL, to: destURL)
            return .success(destURL)
        } catch {
            return .failure(error)
        }
    }

    // MARK: - Private

    private func compareVersions(_ a: String, _ b: String) -> Int {
        let aParts = a.split(separator: ".").compactMap { Int($0) }
        let bParts = b.split(separator: ".").compactMap { Int($0) }
        for i in 0..<max(aParts.count, bParts.count) {
            let av = i < aParts.count ? aParts[i] : 0
            let bv = i < bParts.count ? bParts[i] : 0
            if av != bv { return av < bv ? -1 : 1 }
        }
        return 0
    }
}

enum UpdateError: LocalizedError {
    case invalidURL
    case httpError(Int)
    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid download URL"
        case .httpError(let code): return "HTTP error \(code)"
        }
    }
}
