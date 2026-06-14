import SwiftUI

/// Modal sheet for entering Coding Plan API keys. Each provider gets a
/// SecureField; saving writes to CredentialStore (read by the daemon) and
/// triggers an immediate quota refresh so the connection status updates.
struct CredentialSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var keys: [String: String] = [:]
    @State private var savedFeedback: String?
    @State private var validationStates: [String: ValidationState] = [:]
    @State private var isSaving = false

    private enum ValidationState {
        case validating
        case valid
        case invalid(String)
    }

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
                    .disabled(isSaving)
                Button {
                    save()
                } label: {
                    if isSaving {
                        HStack(spacing: 5) {
                            ProgressView()
                                .controlSize(.mini)
                            Text("Validating…")
                        }
                    } else {
                        Text("Save")
                    }
                }
                    .controlSize(.small)
                    .keyboardShortcut(.defaultAction)
                    .disabled(isSaving)
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
                if case .valid = validationStates[provider.id] {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentGreen)
                        .font(.system(size: 11))
                } else if case .validating = validationStates[provider.id] {
                    ProgressView()
                        .controlSize(.mini)
                }
                Spacer()
                if existing != nil {
                    Button("Remove") { remove(provider.id) }
                        .font(.system(size: 10))
                        .controlSize(.small)
                        .buttonStyle(.plain)
                        .foregroundStyle(.red.opacity(0.8))
                        .disabled(isSaving)
                }
            }
            if case .invalid(let message) = validationStates[provider.id] {
                Text(message)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SecureField(provider.hint, text: Binding(
                get: { keys[provider.id] ?? "" },
                set: {
                    keys[provider.id] = $0
                    validationStates.removeValue(forKey: provider.id)
                }
            ))
            .font(.system(size: 12, design: .monospaced))
            .textFieldStyle(.roundedBorder)
            .controlSize(.small)
            .disabled(isSaving)
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
        guard !isSaving else { return }
        let proposed = CredentialStore.editableProviders.compactMap { provider -> (String, String)? in
            let token = keys[provider.id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return token.isEmpty ? nil : (provider.id, token)
        }

        guard !proposed.isEmpty else {
            dismiss()
            return
        }

        isSaving = true
        savedFeedback = nil
        validationStates = [:]

        Task { @MainActor in
            let client = APIClient(port: state.daemonPort)
            var allValid = true

            for (provider, token) in proposed {
                validationStates[provider] = .validating
                do {
                    let result = try await client.validateCredential(provider: provider, apiKey: token)
                    if result.valid {
                        validationStates[provider] = .valid
                    } else {
                        validationStates[provider] = .invalid(validationMessage(result.status))
                        allValid = false
                    }
                } catch {
                    validationStates[provider] = .invalid(error.localizedDescription)
                    allValid = false
                }
            }

            guard allValid else {
                isSaving = false
                return
            }

            for (provider, token) in proposed {
                CredentialStore.set(ProviderCredential(apiKey: token, baseUrl: nil), for: provider)
            }
            savedFeedback = "Credentials verified and saved."
            state.badgeUpdater?.refreshNow()
            try? await Task.sleep(for: .milliseconds(700))
            dismiss()
        }
    }

    private func remove(_ provider: String) {
        CredentialStore.set(nil, for: provider)
        keys.removeValue(forKey: provider)
        validationStates.removeValue(forKey: provider)
        state.badgeUpdater?.refreshNow()
        savedFeedback = "Removed."
    }

    private func validationMessage(_ status: QuotaProviderStatus) -> String {
        if let message = status.message, !message.isEmpty {
            return message
        }
        switch status.state {
        case "auth_failed": return "The token was rejected. Check it and try again."
        case "rate_limited": return "The provider is rate-limiting validation. Try again shortly."
        case "timed_out": return "Validation timed out. Check your connection and try again."
        case "upstream_unavailable": return "The provider is currently unavailable."
        case "malformed_response": return "The provider returned an unexpected response."
        default: return "Unable to validate this token."
        }
    }
}
