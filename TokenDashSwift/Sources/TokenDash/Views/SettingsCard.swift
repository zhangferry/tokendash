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

/// A compact single-line row inside a SettingsCard.
struct SettingsRow<Trailing: View>: View {
    var icon: String? = nil
    let title: String
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
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            trailing
        }
        .padding(.vertical, 8)
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

/// Stable product-colored switch that does not inherit macOS accent blue.
struct ThemeSwitch: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(.spring(response: 0.24, dampingFraction: 0.82)) {
                isOn.toggle()
            }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? Color.accentGreen : Color.primary.opacity(0.16))
                Circle()
                    .fill(Color.white)
                    .padding(2)
                    .shadow(color: .black.opacity(0.16), radius: 1, y: 0.5)
            }
            .frame(width: 32, height: 18)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn ? "On" : "Off")
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
