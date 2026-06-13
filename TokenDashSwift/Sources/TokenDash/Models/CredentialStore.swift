import Foundation

/// Stores Coding Plan provider credentials so the Node daemon (separate process)
/// can read them. Written to ~/.tokendash/credentials.json with 0600 perms —
/// consistent with the daemon's existing port/pid files, and with how cc-switch
/// already persists these keys in ~/.claude/settings.json plaintext. The file is
/// the cross-process bridge; the daemon's quota adapters read it first.
struct ProviderCredential: Codable, Equatable {
    var apiKey: String
    var baseUrl: String?
}

enum CredentialStore {
    /// Providers that accept a manually-entered API key in-app.
    /// Claude and Codex use their own auth (keychain / app-server) and are excluded.
    static let editableProviders: [(id: String, name: String, hint: String)] = [
        ("glm", "GLM Coding Plan", "Zhipu / Z.ai plan token"),
        ("kimi", "Kimi Code", "Kimi access token"),
        ("minimax", "MiniMax Coding Plan", "Subscription Key (sk-)"),
    ]

    private static var url: URL {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tokendash")
        return dir.appendingPathComponent("credentials.json")
    }

    static func loadAll() -> [String: ProviderCredential] {
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONDecoder().decode([String: ProviderCredential].self, from: data)) ?? [:]
    }

    static func get(_ provider: String) -> ProviderCredential? {
        loadAll()[provider]
    }

    /// Insert/update one provider's credential, rewriting the whole file with
    /// restrictive perms so only the owner can read it.
    static func set(_ credential: ProviderCredential?, for provider: String) {
        var all = loadAll()
        if let credential {
            all[provider] = credential
        } else {
            all.removeValue(forKey: provider)
        }
        write(all)
    }

    private static func write(_ all: [String: ProviderCredential]) {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(all) else { return }
        try? data.write(to: url, options: .atomic)
        // Restrict to owner (0600).
        try? FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o600)], ofItemAtPath: url.path)
    }
}
