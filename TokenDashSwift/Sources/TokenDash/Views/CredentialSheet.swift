import SwiftUI

/// Modal sheet for entering Coding Plan API keys. Each provider gets a
/// SecureField; saving writes to CredentialStore (read by the daemon) and
/// triggers an immediate quota refresh so the connection status updates.
struct CredentialSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var keys: [String: String] = [:]
    @State private var savedFeedback: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Coding Plan Credentials")
                    .font(.system(size: 14, weight: .bold))
                Spacer()
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 4)

            Text("Keys are stored locally in ~/.tokendash/credentials.json and read by the local server only. They never leave your machine.")
                .font(.system(size: 10))
                .foregroundStyle(Color.secondaryLabel)
                .padding(.horizontal, 18)
                .padding(.bottom, 12)

            VStack(spacing: 0) {
                ForEach(CredentialStore.editableProviders, id: \.id) { provider in
                    providerRow(provider)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 14)

            if let feedback = savedFeedback {
                Text(feedback)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.accentGreen)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 8)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .controlSize(.small)
                Button("Save") { save() }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 16)
        }
        .frame(width: 360)
        .background(Color.popoverBackground)
        .onAppear { loadKeys() }
    }

    private func providerRow(_ provider: (id: String, name: String, hint: String)) -> some View {
        let existing = CredentialStore.get(provider.id)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(provider.name)
                    .font(.system(size: 12, weight: .semibold))
                if existing != nil {
                    Text("●")
                        .foregroundStyle(Color.accentGreen)
                        .font(.system(size: 10))
                }
                Spacer()
                if existing != nil {
                    Button("Remove") { remove(provider.id) }
                        .font(.system(size: 10))
                        .controlSize(.small)
                        .buttonStyle(.plain)
                        .foregroundStyle(.red.opacity(0.8))
                }
            }
            SecureField(provider.hint, text: Binding(
                get: { keys[provider.id] ?? "" },
                set: { keys[provider.id] = $0 }
            ))
            .font(.system(size: 12, design: .monospaced))
            .textFieldStyle(.roundedBorder)
            .controlSize(.small)
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            if provider.id != CredentialStore.editableProviders.last?.id {
                Rectangle().fill(Color.dividerColor).frame(height: 0.5)
            }
        }
    }

    private func loadKeys() {
        var k: [String: String] = [:]
        for provider in CredentialStore.editableProviders {
            if let cred = CredentialStore.get(provider.id) { k[provider.id] = cred.apiKey }
        }
        keys = k
    }

    private func save() {
        for provider in CredentialStore.editableProviders {
            let entered = keys[provider.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if entered.isEmpty {
                // Keep any existing credential unless the user explicitly removed it.
                continue
            }
            CredentialStore.set(ProviderCredential(apiKey: entered, baseUrl: nil), for: provider.id)
        }
        savedFeedback = "Saved. Refreshing quota…"
        // Re-fetch so the new provider's status shows up immediately.
        state.badgeUpdater?.refreshNow()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { dismiss() }
    }

    private func remove(_ provider: String) {
        CredentialStore.set(nil, for: provider)
        keys.removeValue(forKey: provider)
        state.badgeUpdater?.refreshNow()
        savedFeedback = "Removed."
    }
}
