import SwiftUI
import UIKit

/// Positive Energy v3.1 semantic roles from the approved tokens.json.
/// Camera scrims, system sheets and safety/score meanings remain independent.
enum NudgeTheme {
    // Light-only for this release. Retain the alternate tokens for a future
    // appearance review, without allowing system traits to recolour the app.
    static func color(_ light: UInt32, _: UInt32) -> UIColor {
        UIColor(red: CGFloat((light >> 16) & 255) / 255,
                green: CGFloat((light >> 8) & 255) / 255,
                blue: CGFloat(light & 255) / 255, alpha: 1)
    }
    static let canvas = color(0xF8F7F2, 0x1B202A)
    static let surface = color(0xFFFFFF, 0x282F3D)
    static let ink = color(0x253452, 0xF0F3FC)
    static let muted = color(0x677189, 0xBAC4DB)
    static let border = color(0xDFE4EF, 0x414C63)
    static let strongBorder = color(0x7C879C, 0x7D8BA9)
    static let accent = color(0x365ACB, 0xACBEFF)
    static let selectedSurface = color(0xE8EEFF, 0x344568)
    static let primaryFill = color(0xF3C950, 0xF3CE68)
    static let primaryText = color(0x26334E, 0x26334E)
    static let primaryEdge = color(0xC79A2D, 0xC09A3E)
    static let diaryAction = color(0x12633A, 0x12633A)
    static let diaryActionText = UIColor.white
    static let diaryActionEdge = color(0x0D4A2B, 0x0D4A2B)
    static let progressFill = color(0x5876CB, 0xA6B8ED)
    static let progressTrack = color(0xE6EAF5, 0x3D4A66)
    static let plantSurface = color(0xE2F1E9, 0x2B443B)
    static let plantText = color(0x30634D, 0xB5DFCA)
    static let plantAccent = color(0x6EA487, 0x92C9AD)
    static let errorText = color(0xA33232, 0xF0A8A8)
    static let errorSurface = color(0xFFF2EF, 0x412E34)
    static let warningText = color(0x6E4515, 0xF0CB9A)
    static let warningSurface = color(0xFFF1D8, 0x493821)
    static func frequencySurface(_ frequency: String) -> UIColor {
        switch frequency {
        case "Daily": color(0xDDF5E8, 0x1F4937)
        case "Weekly": color(0xFFE6A2, 0xFFC247)
        case "Monthly": color(0xFFE6E7, 0x5B2931)
        default: surface
        }
    }
    static func frequencyText(_ frequency: String) -> UIColor {
        switch frequency {
        case "Daily": color(0x12633A, 0x9DF0C5)
        case "Weekly": color(0x513400, 0x513400)
        case "Monthly": color(0xA62530, 0xFFB6BE)
        default: muted
        }
    }
    static let cameraScrim = UIColor.black.withAlphaComponent(0.72)
    static let cameraText = UIColor.white
    static let cameraBackground = color(0x1B202A, 0x1B202A)
    static let controlRadius: CGFloat = 18
    static let buttonHeight: CGFloat = 56
    static let primaryDepth: CGFloat = 4

    // Fixed tile colours preserve the original discovery palette in both themes.
    static func discoveryFill(_ index: Int) -> UIColor {
        let palette: [UInt32] = [0x9254E8, 0xFF6900, 0xFFBE00, 0xACBEFF, 0x20CDBB, 0xA8DC00]
        let value = palette[((index % palette.count) + palette.count) % palette.count]
        return color(value, value)
    }
    static func discoveryInk(_ index: Int) -> UIColor {
        ((index % 6) + 6) % 6 == 0 ? .white : color(0x1B202A, 0x1B202A)
    }
    static func supportFill(_ context: ProductSupportContext) -> UIColor {
        switch context {
        case .period: color(0xFF6900, 0xFF6900)
        case .follicular: color(0xA8DC00, 0xA8DC00)
        case .ovulation: color(0x20CDBB, 0x20CDBB)
        case .luteal: color(0x9254E8, 0x9254E8)
        case .perimenopause: color(0xFFBE00, 0xFFBE00)
        case .postmenopause: color(0x365ACB, 0x365ACB)
        }
    }
    static func supportInk(_ context: ProductSupportContext) -> UIColor {
        switch context {
        case .luteal, .postmenopause: .white
        default: color(0x1B202A, 0x1B202A)
        }
    }

    @MainActor static func navigation(_ navigation: UINavigationController) {
        navigation.view.tintColor = accent
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = canvas
        appearance.titleTextAttributes = [.foregroundColor: ink]
        appearance.largeTitleTextAttributes = [.foregroundColor: ink]
        appearance.shadowColor = border
        navigation.navigationBar.standardAppearance = appearance
        navigation.navigationBar.scrollEdgeAppearance = appearance
        navigation.navigationBar.compactAppearance = appearance
    }
}

enum NudgeButtonVariant { case primary, diary, secondary, destructive, camera }

/// Shared native action treatment. Uses real control state and Dynamic Type;
/// no fixed title height, animation or global gesture interception.
@MainActor
final class NudgeButton: UIButton {
    var variant: NudgeButtonVariant = .secondary { didSet { setNeedsUpdateConfiguration() } }
    private var measuredWidth: CGFloat = 0
    convenience init(_ title: String, variant: NudgeButtonVariant = .secondary, icon: String? = nil) {
        self.init(type: .system)
        self.variant = variant
        var config = UIButton.Configuration.plain()
        config.title = title
        config.image = icon.flatMap(UIImage.init(systemName:))
        config.imagePadding = 8
        configuration = config
        titleLabel?.numberOfLines = 0
        titleLabel?.adjustsFontForContentSizeCategory = true
        setContentCompressionResistancePriority(.required, for: .vertical)
        heightAnchor.constraint(greaterThanOrEqualToConstant: NudgeTheme.buttonHeight).isActive = true
    }
    override func updateConfiguration() {
        guard var config = configuration else { return }
        let diary = variant == .diary
        let primary = variant == .primary || diary
        let camera = variant == .camera
        config.baseForegroundColor = !isEnabled ? NudgeTheme.muted : diary ? NudgeTheme.diaryActionText : primary ? NudgeTheme.primaryText : variant == .destructive ? NudgeTheme.errorText : camera ? NudgeTheme.cameraText : NudgeTheme.accent
        config.background.backgroundColor = !isEnabled ? NudgeTheme.progressTrack : diary ? NudgeTheme.diaryAction : primary ? NudgeTheme.primaryFill : variant == .destructive ? NudgeTheme.errorSurface : camera ? NudgeTheme.cameraScrim : isSelected || isHighlighted || isFocused ? NudgeTheme.selectedSurface : NudgeTheme.surface
        config.cornerStyle = .fixed
        config.background.cornerRadius = NudgeTheme.controlRadius
        config.background.strokeWidth = primary || camera ? 0 : isSelected || isFocused || traitCollection.accessibilityContrast == .high ? 2 : 1
        config.background.strokeColor = isSelected || isFocused ? NudgeTheme.accent : traitCollection.accessibilityContrast == .high ? NudgeTheme.strongBorder : NudgeTheme.border
        config.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16)
        config.titleLineBreakMode = .byWordWrapping
        config.titleAlignment = .center
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { [weak self] input in
            var output = input
            output.font = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: self?.traitCollection)
            return output
        }
        configuration = config
        layer.shadowColor = (diary ? NudgeTheme.diaryActionEdge : NudgeTheme.primaryEdge).resolvedColor(with: traitCollection).cgColor
        layer.shadowOpacity = primary && isEnabled ? 1 : 0
        layer.shadowRadius = 0
        layer.shadowOffset = CGSize(width: 0, height: isHighlighted ? 1 : NudgeTheme.primaryDepth)
        transform = primary && isHighlighted ? CGAffineTransform(translationX: 0, y: 3) : .identity
    }
    override var intrinsicContentSize: CGSize {
        var size = super.intrinsicContentSize
        guard let title = configuration?.title, !title.isEmpty else { return size }
        let insets = configuration?.contentInsets ?? .zero
        let width = max(1, (bounds.width > 0 ? bounds.width : max(44, size.width)) - insets.leading - insets.trailing)
        let font = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: traitCollection)
        let textSize = (title as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil)
        size.height = max(NudgeTheme.buttonHeight, ceil(textSize.height) + insets.top + insets.bottom)
        return size
    }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        setNeedsUpdateConfiguration(); invalidateIntrinsicContentSize()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        if abs(measuredWidth - bounds.width) > 0.5 { measuredWidth = bounds.width; invalidateIntrinsicContentSize() }
    }
}

struct NudgeButtonStyle: ButtonStyle {
    var variant: NudgeButtonVariant = .primary
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorSchemeContrast) private var contrast
    func makeBody(configuration: Configuration) -> some View {
        let diary = variant == .diary
        let primary = variant == .primary || diary
        configuration.label
            .font(.headline).multilineTextAlignment(.center)
            .foregroundStyle(Color(uiColor: !enabled ? NudgeTheme.muted : diary ? NudgeTheme.diaryActionText : primary ? NudgeTheme.primaryText : NudgeTheme.accent))
            .padding(.horizontal, 20).padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: NudgeTheme.buttonHeight)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: NudgeTheme.controlRadius).fill(Color(uiColor: !enabled ? NudgeTheme.progressTrack : diary ? NudgeTheme.diaryAction : primary ? NudgeTheme.primaryFill : configuration.isPressed ? NudgeTheme.selectedSurface : NudgeTheme.surface))
                .shadow(color: primary && enabled ? Color(uiColor: diary ? NudgeTheme.diaryActionEdge : NudgeTheme.primaryEdge) : .clear, radius: 0, x: 0, y: configuration.isPressed ? 1 : NudgeTheme.primaryDepth))
            .overlay(RoundedRectangle(cornerRadius: NudgeTheme.controlRadius).stroke(Color(uiColor: contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border), lineWidth: primary ? 0 : 1))
            .offset(y: primary && configuration.isPressed ? 3 : 0)
    }
}
