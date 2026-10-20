import XCTest
import SwiftUI
import UIKit
@testable import Nudge

@MainActor
final class NudgeThemeTests: XCTestCase {
    private func contrast(_ foreground: UIColor, _ background: UIColor, _ traits: UITraitCollection) -> Double {
        func luminance(_ color: UIColor) -> Double {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            func linear(_ v: CGFloat) -> Double { v <= 0.04045 ? Double(v / 12.92) : pow(Double((v + 0.055) / 1.055), 2.4) }
            return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722
        }
        let values = [luminance(foreground), luminance(background)].sorted()
        return (values[1] + 0.05) / (values[0] + 0.05)
    }
    func testNativeSemanticTextAndMeaningfulGraphicsMeetContrastInBothAppearances() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            for (text, surface) in [(NudgeTheme.ink,NudgeTheme.canvas),(NudgeTheme.muted,NudgeTheme.canvas),(NudgeTheme.accent,NudgeTheme.surface),(NudgeTheme.accent,NudgeTheme.selectedSurface),(NudgeTheme.primaryText,NudgeTheme.primaryFill),(NudgeTheme.plantText,NudgeTheme.plantSurface),(NudgeTheme.errorText,NudgeTheme.errorSurface),(NudgeTheme.warningText,NudgeTheme.warningSurface)] {
                XCTAssertGreaterThanOrEqual(contrast(text, surface, traits), 4.5)
            }
            XCTAssertGreaterThanOrEqual(contrast(NudgeTheme.strongBorder, NudgeTheme.surface, traits), 3)
            XCTAssertGreaterThanOrEqual(contrast(NudgeTheme.progressFill, NudgeTheme.progressTrack, traits), 3)
        }
        XCTAssertNotEqual(NudgeTheme.canvas.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)), NudgeTheme.canvas.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)))
    }
    func testSharedNativeButtonHasWrappingTitlesDistinctDisabledAndPressedStates() {
        let button = NudgeButton("Photograph the nutrition and ingredients label", variant: .primary)
        button.frame = CGRect(x: 0, y: 0, width: 170, height: 56)
        button.updateConfiguration()
        XCTAssertEqual(button.configuration?.baseForegroundColor, NudgeTheme.primaryText)
        XCTAssertEqual(button.configuration?.background.backgroundColor, NudgeTheme.primaryFill)
        XCTAssertGreaterThan(button.intrinsicContentSize.height, 56)
        button.isHighlighted = true; button.updateConfiguration()
        XCTAssertEqual(button.transform.ty, 3)
        button.isHighlighted = false; button.isEnabled = false; button.updateConfiguration()
        XCTAssertEqual(button.configuration?.background.backgroundColor, NudgeTheme.progressTrack)
        XCTAssertEqual(button.layer.shadowOpacity, 0)
        XCTAssertEqual(button.transform, .identity)
    }
    func testNativeShellLoadingErrorAndCameraSnapshotsInBothAppearances() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        for style in [UIUserInterfaceStyle.light, .dark] {
            for large in [false, true] {
                let traits = UITraitCollection(traitsFrom: [UITraitCollection(userInterfaceStyle: style), UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large), UITraitCollection(accessibilityContrast: large ? .high : .normal)])
                for error in [nil, "The app’s display stopped. Reopen it to continue with your saved entries."] as [String?] {
                    let root = NudgeShellStatus(error: error, retry: {})
                        .environment(\.colorScheme, style == .dark ? .dark : .light)
                        .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                    let host = UIHostingController(rootView: root)
                    let shellParent = UIViewController()
                    shellParent.addChild(host); shellParent.view.addSubview(host.view); host.didMove(toParent: shellParent)
                    shellParent.setOverrideTraitCollection(traits, forChild: host)
                    window.rootViewController = shellParent; window.makeKeyAndVisible()
                    window.overrideUserInterfaceStyle = style
                    shellParent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
                    host.overrideUserInterfaceStyle = style
                    host.loadViewIfNeeded(); host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
                    shellParent.view.layoutIfNeeded(); host.view.setNeedsLayout(); host.view.layoutIfNeeded()
                    try await Task.sleep(nanoseconds: 120_000_000)
                    host.view.layoutIfNeeded()
                    attach(host.view, name: "Positive shell \(error == nil ? "loading" : "error") \(style.rawValue) \(large ? "accessibility" : "standard")", traits: traits)
                }
                let parent = UIViewController()
                let camera = SmartFoodCameraViewController()
                parent.addChild(camera); parent.view.addSubview(camera.view); camera.didMove(toParent: parent)
                parent.setOverrideTraitCollection(traits, forChild: camera)
                window.rootViewController = parent; window.makeKeyAndVisible()
                window.overrideUserInterfaceStyle = style
                parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
                camera.overrideUserInterfaceStyle = style
                camera.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
                parent.view.layoutIfNeeded(); camera.view.setNeedsLayout(); camera.view.layoutIfNeeded()
                try await Task.sleep(nanoseconds: 120_000_000)
                camera.view.layoutIfNeeded()
                func descendants(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(descendants) }
                let label = try XCTUnwrap(descendants(camera.view).first(where: { $0.accessibilityIdentifier == "smart-camera-status" }) as? UILabel)
                XCTAssertGreaterThanOrEqual(label.bounds.height, label.sizeThatFits(CGSize(width: label.bounds.width, height: .greatestFiniteMagnitude)).height - 1, "Camera status must wrap instead of clip")
                attach(camera.view, name: "Positive camera empty \(style.rawValue) \(large ? "accessibility" : "standard") — no live sensor", traits: traits)
                camera.closeCapture()
            }
        }
    }
    private func attach(_ view: UIView, name: String, traits: UITraitCollection) {
        traits.performAsCurrent {
            let image = UIGraphicsImageRenderer(bounds: view.bounds).image { view.layer.render(in: $0.cgContext) }
            let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
    }
}
