import SwiftUI

/// A grouped settings card: rounded rect with stacked rows separated by hairline
/// dividers. Gives the modern macOS-System-Settings look inside the popover
/// without Form's generous padding. Mirrors the visual language of the
/// CodingPlanSection provider cards.
struct SettingsCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(.horizontal, 12)
        .background(Color.barTrackColor.opacity(1.5))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

/// A single row inside a SettingsCard. Leading title/subtitle, trailing control.
struct SettingsRow<Trailing: View>: View {
    var icon: String? = nil
    let title: String
    var subtitle: String? = nil
    var showDivider: Bool = true
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.accentGreen)
                    .frame(width: 18)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.primary)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 10))
                        .foregroundStyle(Color.secondaryLabel)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            if showDivider {
                Rectangle()
                    .fill(Color.dividerColor)
                    .frame(height: 0.5)
                    .padding(.leading, icon != nil ? 28 : 0)
            }
        }
    }
}

/// A section header label above a card.
struct SettingsSectionHeader: View {
    let title: String
    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(Color.sectionTitleColor)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }
}
