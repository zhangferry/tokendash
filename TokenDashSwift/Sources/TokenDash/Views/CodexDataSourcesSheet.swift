import SwiftUI

/// Modal sheet for configuring extra Codex-compatible data paths. The daemon
/// persists these paths to ~/.tokendash/settings.json and every dashboard API
/// reads from that same source of truth.
struct CodexDataSourcesSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var settings: AppSettingsResponse?
    @State private var draftText = ""
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var feedback: String?
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Codex Data Sources")
                    .font(.system(size: 14, weight: .bold))
                Spacer()
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 4)

            Text("Official Codex data is scanned by default. Add one or more custom Codex-compatible homes for non-official clients.")
                .font(.system(size: 10))
                .foregroundStyle(Color.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 18)
                .padding(.bottom, 12)

            if isLoading {
                ProgressView("Loading settings…")
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 180)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Custom paths")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Color.secondaryLabel)
                    TextEditor(text: $draftText)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(height: 96)
                        .scrollContentBackground(.hidden)
                        .background(Color.primary.opacity(0.04))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.dividerColor, lineWidth: 0.5))
                        .disabled(isSaving)
                    Text("Multiple paths are supported: put one path per line. Each home should contain sessions/ or archived_sessions/; direct transcript folders also work.")
                        .font(.system(size: 10))
                        .foregroundStyle(Color.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)

                    resolvedSources
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 12)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 8)
            } else if let feedback {
                Text(feedback)
                    .font(.system(size: 11, weight: .medium))
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
                            ProgressView().controlSize(.mini)
                            Text("Saving…")
                        }
                    } else {
                        Text("Save")
                    }
                }
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
                .disabled(isLoading || isSaving)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 16)
        }
        .frame(width: 380)
        .background(Color.popoverBackground)
        .onAppear { load() }
    }

    private var resolvedSources: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Resolved sources")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.secondaryLabel)
                Spacer()
                Text("\(settings?.codex.resolvedDataPaths.count ?? 0) paths")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.tertiaryLabel)
            }
            VStack(spacing: 0) {
                ForEach(settings?.codex.resolvedDataPaths ?? []) { source in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(source.readable ? Color.accentGreen : Color.secondary.opacity(0.35))
                            .frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(source.path)
                                .font(.system(size: 10, design: .monospaced))
                                .lineLimit(1)
                            Text("\(sourceLabel(source.kind)) · \(source.readable ? "readable" : "missing")")
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(Color.secondaryLabel)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(Color.dividerColor).frame(height: 0.5)
                    }
                }
            }
            .frame(maxHeight: 130)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func load() {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        feedback = nil
        Task { @MainActor in
            do {
                let client = APIClient(port: state.daemonPort)
                let next = try await client.getSettings()
                settings = next
                draftText = next.codex.customDataPaths.joined(separator: "\n")
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        errorMessage = nil
        feedback = nil
        let paths = parseDraftPaths(draftText)
        Task { @MainActor in
            do {
                let client = APIClient(port: state.daemonPort)
                let next = try await client.updateCodexDataPaths(paths)
                settings = next
                draftText = next.codex.customDataPaths.joined(separator: "\n")
                feedback = "Saved. Dashboard data is refreshing."
                state.badgeUpdater?.refreshNow()
                try? await Task.sleep(for: .milliseconds(600))
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }

    private func parseDraftPaths(_ value: String) -> [String] {
        value
            .split(whereSeparator: { $0 == "\n" || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func sourceLabel(_ kind: String) -> String {
        switch kind {
        case "official": return "Official"
        case "environment": return "Environment"
        default: return "Custom"
        }
    }
}
