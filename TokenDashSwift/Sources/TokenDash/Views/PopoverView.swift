import SwiftUI

struct PopoverView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        Group {
            if state.showSettings {
                SettingsView()
            } else {
                mainContent
            }
        }
        .frame(width: 380)
        .background(Color.popoverBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var mainContent: some View {
        VStack(spacing: 0) {
            HeaderView(summary: state.todaySummary, cacheRate: state.cacheRate)

            if let error = state.errorMessage {
                errorBanner(error)
            }

            HourlyChartView(data: state.hourlyData)
                .sectionDivider()

            BreakdownSection(summary: state.todaySummary)
                .sectionDivider()

            ProjectsSection(projects: state.projects)
                .sectionDivider()

            CodingPlanSection(quotas: state.quotas)

            ActionButtons()
                .frame(height: 32)
                .topDivider()
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10))
            Text("Unable to fetch data. Retrying...")
                .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(.red.opacity(0.8))
        .padding(.horizontal, 18)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.04))
    }
}

// MARK: - Divider helpers

extension View {
    func sectionDivider() -> some View {
        self.overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.dividerColor)
                .frame(height: 0.5)
                .padding(.horizontal, 20)
        }
    }

    func topDivider() -> some View {
        self.overlay(alignment: .top) {
            Rectangle()
                .fill(Color.dividerColor)
                .frame(height: 0.5)
        }
    }
}
