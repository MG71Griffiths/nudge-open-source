import SwiftUI
import UIKit

/// Search and Saved share the same square and reserved content areas. At
/// accessibility sizes the thumbnail shares the title row, leaving enough
/// space for the user's full text scaling and the complete missing-data label.
@MainActor
struct NativeProductGridCard: View {
    let id: String
    let name: String
    let imageURL: String?
    var barcode: String? = nil
    let brandOrSource: String
    let rating: NativeProductRating
    let isSaved: Bool
    let onOpen: () -> Void
    let onSave: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var textSize

    private var accessibleLayout: Bool { textSize.isAccessibilitySize }
    private var nameHeight: CGFloat { NativeProductGridMetrics.forSize(textSize).name }
    private var sourceHeight: CGFloat { NativeProductGridMetrics.forSize(textSize).source }
    private var ratingHeight: CGFloat { NativeProductGridMetrics.forSize(textSize).rating }
    private var ratingDetail: String {
        if rating.value != nil {
            return rating.subtitle.localizedCaseInsensitiveContains("estimated") ? "Estimated rating" : "Nudge rating"
        }
        if rating.subtitle.localizedCaseInsensitiveContains("unavailable") { return "Rating unavailable" }
        if rating.subtitle.localizedCaseInsensitiveContains("pending") || rating.subtitle.localizedCaseInsensitiveContains("queued") || rating.subtitle.localizedCaseInsensitiveContains("calculating") { return "Rating pending" }
        return "Nutrition incomplete"
    }

    var body: some View {
        GeometryReader { geometry in
            let side = geometry.size.width
            let inset: CGFloat = accessibleLayout ? 4 : 8
            let spacing: CGFloat = accessibleLayout ? 2 : 3
            let imageHeight = max(44, side - nameHeight - sourceHeight - ratingHeight - inset * 2 - spacing * 3)
            ZStack(alignment: .topTrailing) {
                Button(action: onOpen) {
                    VStack(alignment: .leading, spacing: spacing) {
                        if accessibleLayout {
                            HStack(alignment: .top, spacing: 8) {
                                nameLabel
                                // Save occupies the top of this same column.
                                NativeStoredFoodImage(source: imageURL ?? "", placeholder: "shippingbox", barcode: barcode, placeholderFont: .system(size: 22), maximumPixelSize: 384)
                                    .frame(width: 48, height: max(48, nameHeight - 52))
                                    .padding(.top, 52)
                            }
                            .frame(height: max(100, nameHeight), alignment: .top)
                        } else {
                            NativeStoredFoodImage(source: imageURL ?? "", placeholder: "shippingbox", barcode: barcode, maximumPixelSize: 384)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .frame(maxWidth: .infinity).frame(height: imageHeight)
                            nameLabel
                        }
                        Text(brandOrSource.isEmpty ? "Product" : brandOrSource)
                            .font(.caption2).foregroundStyle(Color(uiColor: NudgeTheme.muted)).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: sourceHeight, alignment: .leading)
                            .searchControl("grid-source-\(id)")
                        ratingArea.frame(height: ratingHeight)
                    }
                    .padding(inset)
                    .frame(width: side, height: side, alignment: .topLeading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(NativeSearchTouchButtonStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(name), \(brandOrSource). \(rating.value.map { "\($0) percent Nudge rating" } ?? "Not rated"). \(ratingDetail)")
                .accessibilityHint("Open food details and portion controls")
                .searchControl("search-product-\(id)")

                Button(action: onSave) {
                    Image(systemName: isSaved ? "bookmark.fill" : "bookmark")
                        // The symbol is decorative; the separate 48pt button
                        // and its complete VoiceOver label remain unchanged.
                        .font(.system(size: 22, weight: .semibold))
                        .searchControl("grid-save-symbol-\(id)")
                        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                        .frame(width: 48, height: 48)
                        .background(Color(uiColor: isSaved ? NudgeTheme.selectedSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: NudgeTheme.border)))
                }
                .buttonStyle(NativeSearchTouchButtonStyle()).padding(4)
                .accessibilityLabel("\(isSaved ? "Remove saved" : "Save") \(name)")
                .accessibilityValue(isSaved ? "Saved" : "Not saved")
                .accessibilityAddTraits(isSaved ? .isSelected : [])
                .searchControl("grid-save-\(id)")
            }
            .frame(width: side, height: side)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color(uiColor: contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border), lineWidth: contrast == .increased ? 2 : 1))
        }
        .aspectRatio(1, contentMode: .fit)
        .foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .searchControl("grid-card-\(id)")
    }

    private var nameLabel: some View {
        Text(name)
            .font((accessibleLayout ? Font.caption2 : .subheadline).weight(.semibold))
            .lineLimit(2, reservesSpace: true)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: nameHeight, alignment: .topLeading)
            .searchControl("grid-name-\(id)")
    }

    private var ratingArea: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(rating.value.map { "\($0)%" } ?? "Not rated")
                .font((accessibleLayout ? Font.caption2 : .caption).weight(.bold)).monospacedDigit().lineLimit(1)
            Text(ratingDetail).font(.caption2).lineLimit(accessibleLayout ? 2 : 1, reservesSpace: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.horizontal, accessibleLayout ? 4 : 7)
        .foregroundStyle(Color(uiColor: rating.value == nil ? NudgeTheme.ink : NudgeTheme.color(0x1B202A, 0x1B202A)))
        .background(Color(uiColor: rating.value == nil ? NudgeTheme.canvas : NudgeTheme.color(rating.tone.fill, rating.tone.fill)), in: RoundedRectangle(cornerRadius: 9))
        .searchControl("grid-rating-\(id)")
    }

}

/// Each Dynamic Type size has fixed card metrics. Reuse its UIFont/trait work
/// across every card and rating update without caching any product or score.
@MainActor
private enum NativeProductGridMetrics {
    struct Heights { let name: CGFloat; let source: CGFloat; let rating: CGFloat }
    private struct Key: Hashable { let size: DynamicTypeSize; let boldText: Bool }
    private static var cache: [Key: Heights] = [:]

    static func forSize(_ textSize: DynamicTypeSize) -> Heights {
        let key = Key(size: textSize, boldText: UIAccessibility.isBoldTextEnabled)
        if let cached = cache[key] { return cached }
        let category: UIContentSizeCategory
        switch textSize {
        case .xSmall: category = .extraSmall
        case .small: category = .small
        case .medium: category = .medium
        case .large: category = .large
        case .xLarge: category = .extraLarge
        case .xxLarge: category = .extraExtraLarge
        case .xxxLarge: category = .extraExtraExtraLarge
        case .accessibility1: category = .accessibilityMedium
        case .accessibility2: category = .accessibilityLarge
        case .accessibility3: category = .accessibilityExtraLarge
        case .accessibility4: category = .accessibilityExtraExtraLarge
        case .accessibility5: category = .accessibilityExtraExtraExtraLarge
        @unknown default: category = .large
        }
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        func lineHeight(_ style: UIFont.TextStyle) -> CGFloat {
            UIFont.preferredFont(forTextStyle: style, compatibleWith: traits).lineHeight
        }
        let caption = lineHeight(.caption2)
        let heights = Heights(name: ceil((textSize.isAccessibilitySize ? caption : lineHeight(.subheadline)) * 2),
                              source: ceil(caption),
                              rating: textSize.isAccessibilitySize ? ceil(caption * 3) : ceil(lineHeight(.caption1) + caption + 2))
        cache[key] = heights
        return heights
    }
}

/// A search result can be read and opened before its thumbnail or rating arrives.
/// The independent Save target never competes with the row's open action.
@MainActor
struct NativeProductSearchRow: View {
    let id: String
    let name: String
    let imageURL: String?
    var barcode: String? = nil
    let brandOrSource: String
    let rating: NativeProductRating
    let isSaved: Bool
    let onOpen: () -> Void
    let onSave: () -> Void
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.colorSchemeContrast) private var contrast

    private var ratingLabel: String {
        if let value = rating.value {
            return "\(value)/100 · \(rating.subtitle.localizedCaseInsensitiveContains("estimated") ? "Estimated" : "Nudge rating")"
        }
        if ["pending", "queued", "calculating"].contains(where: { rating.subtitle.localizedCaseInsensitiveContains($0) }) {
            return "Rating pending"
        }
        return rating.subtitle.localizedCaseInsensitiveContains("incomplete") ? "Nutrition incomplete" : "Not rated"
    }

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            Button(action: onOpen) {
                HStack(alignment: .center, spacing: 12) {
                    NativeStoredFoodImage(source: imageURL ?? "", placeholder: "shippingbox", barcode: barcode,
                                          placeholderFont: .system(size: 20), maximumPixelSize: 192)
                        .padding(4).frame(width: 56, height: 64)
                        .background(Color(uiColor: NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 10))
                        .searchControl("search-row-image-\(id)")
                    VStack(alignment: .leading, spacing: 4) {
                        Text(name).font(.subheadline.weight(.semibold))
                            .lineLimit(textSize.isAccessibilitySize ? nil : 2)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(brandOrSource.isEmpty ? "Product" : brandOrSource)
                            .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Circle().fill(Color(uiColor: NudgeTheme.color(rating.tone.fill, rating.tone.fill)))
                                .frame(width: 10, height: 10).accessibilityHidden(true)
                            Text(ratingLabel).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.ink))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .searchControl("search-row-rating-\(id)")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(NativeSearchTouchButtonStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name), \(brandOrSource). \(ratingLabel)")
            .accessibilityHint("Open food details and portion controls")
            .searchControl("search-product-\(id)")
            Button(action: onSave) {
                Image(systemName: isSaved ? "bookmark.fill" : "bookmark")
                    .font(.system(size: 20)).frame(width: 48, height: 48)
            }
            .buttonStyle(NativeSearchTouchButtonStyle())
            .accessibilityLabel("\(isSaved ? "Remove saved" : "Save") \(name)")
            .accessibilityValue(isSaved ? "Saved" : "Not saved")
            .accessibilityAddTraits(isSaved ? .isSelected : [])
            .searchControl("search-row-save-\(id)")
        }
        .background(Color(uiColor: NudgeTheme.surface))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(uiColor: contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border))
                .frame(height: contrast == .increased ? 2 : 1)
        }
        .searchControl("search-row-\(id)")
    }
}

/// One subtle animation covers all placeholders. No placeholder is a button or
/// an announced fake product; reduced motion and inactive scenes remain static.
struct NativeProductSearchSkeletonRows: View {
    var count = 6
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var phase: CGFloat = -1
    @ScaledMetric(relativeTo: .subheadline) private var titleHeight: CGFloat = 13
    @ScaledMetric(relativeTo: .caption) private var detailHeight: CGFloat = 10
    private var animates: Bool { !reduceMotion && scenePhase == .active }

    var body: some View {
        shapes
            .overlay {
                if animates {
                    GeometryReader { geometry in
                        LinearGradient(colors: [.clear, .white.opacity(0.32), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width)
                            .offset(x: phase * geometry.size.width)
                    }
                    .mask(shapes)
                }
            }
            .clipped()
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Finding products")
            .searchControl(animates ? "search-loading-shimmer" : "search-loading-static")
            .task(id: animates) {
                var transaction = Transaction(); transaction.disablesAnimations = true
                withTransaction(transaction) { phase = -1 }
                guard animates else { return }
                withAnimation(.linear(duration: 1.35).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }

    private var shapes: some View {
        VStack(spacing: 0) {
            ForEach(0..<max(1, min(count, 8)), id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 10).frame(width: 56, height: 64)
                    VStack(alignment: .leading, spacing: 9) {
                        RoundedRectangle(cornerRadius: 4).frame(height: titleHeight)
                        RoundedRectangle(cornerRadius: 4).frame(maxWidth: index.isMultiple(of: 2) ? 120 : 150).frame(height: detailHeight)
                        RoundedRectangle(cornerRadius: 4).frame(maxWidth: 100).frame(height: detailHeight)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Spacer().frame(width: 40)
                }
                .padding(.vertical, 12)
            }
        }
        .foregroundStyle(Color(uiColor: contrast == .increased ? .systemGray3 : .systemGray5))
    }
}
