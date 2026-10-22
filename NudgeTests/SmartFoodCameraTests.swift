import XCTest
import UIKit
import ImageIO
import PhotosUI
import UniformTypeIdentifiers
@testable import Nudge

final class SmartFoodCameraTests: XCTestCase {
    @MainActor
    func testStorageStatusBeforeViewLoadsPreservesDraftAndRendersWhenOpened() throws {
        let images = [Data([9])], photoIDs = [UUID().uuidString]
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(images: images, photoIDs: photoIDs, revision: 7, voiceMemo: voice)
        defer { camera.closeCapture() }
        XCTAssertFalse(camera.isViewLoaded)
        camera.setCaptureStorageError(nil)
        XCTAssertFalse(camera.isViewLoaded, "Acknowledging a durable save must not build or present the camera")
        camera.setCaptureStorageError("History could not be saved. Keep the camera open and try again.")
        XCTAssertFalse(camera.isViewLoaded)
        XCTAssertEqual(camera.capturedImages, images)
        XCTAssertEqual(camera.capturedPhotoIDs, photoIDs)
        XCTAssertEqual(camera.captureSetRevision, 7)
        XCTAssertEqual(camera.capturedVoiceMemo?.audioData, voice.audioData)

        camera.loadViewIfNeeded()
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let controls = descendants(camera.view)
        let status = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-status" } as? UILabel)
        let analyse = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-result" } as? UIButton)
        XCTAssertEqual(status.text, "History could not be saved. Keep the camera open and try again.")
        XCTAssertTrue(analyse.isEnabled, "The retained draft must remain available to retry")
        camera.setCaptureStorageError(nil)
        XCTAssertEqual(status.text, CameraPhotoGuidance.message(photoCount: 1).heading)
        XCTAssertTrue(analyse.isEnabled)
        XCTAssertEqual(camera.capturedPhotoIDs, photoIDs)
        XCTAssertEqual(camera.captureSetRevision, 7)
        XCTAssertEqual(camera.capturedVoiceMemo?.audioData, voice.audioData)
    }

    @MainActor
    func testShortCameraViewportKeepsPrimaryActionsVisibleWithoutScrolling() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene), parent = UIViewController()
        let jpeg = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        }.jpegData(compressionQuality: 0.8))
        window.rootViewController = parent; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        for count in 0...4 {
            let camera = SmartFoodCameraViewController(images: Array(repeating: jpeg, count: count))
            parent.addChild(camera); parent.view.addSubview(camera.view); camera.didMove(toParent: parent)
            parent.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: .large), forChild: camera)
            if #available(iOS 17.0, *) { camera.traitOverrides.preferredContentSizeCategory = .large; camera.view.traitOverrides.preferredContentSizeCategory = .large }
            parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700); camera.view.frame = parent.view.bounds
            parent.view.layoutIfNeeded(); camera.view.layoutIfNeeded(); camera.view.layoutIfNeeded()
            let views = descendants(camera.view), safeArea = camera.view.safeAreaLayoutGuide.layoutFrame
            for identifier in ["smart-camera-close", "smart-camera-history", "smart-camera-flash", "smart-camera-library", "smart-camera-capture", "smart-camera-voice", "smart-camera-result", "smart-camera-recents", "smart-camera-favourites"] {
                let control = try XCTUnwrap(views.first { $0.accessibilityIdentifier == identifier })
                let frame = control.convert(control.bounds, to: camera.view)
                XCTAssertTrue(safeArea.insetBy(dx: -0.5, dy: -0.5).contains(frame), "\(identifier), \(count) photos: \(frame) must fit initial safe viewport \(safeArea)")
                XCTAssertGreaterThanOrEqual(frame.height, 44)
            }
            for remove in views.compactMap({ $0 as? UIButton }).filter({ $0.accessibilityIdentifier?.hasPrefix("smart-camera-remove-") == true && !$0.isHidden }) {
                let centre = remove.convert(CGPoint(x: remove.bounds.midX, y: remove.bounds.midY), to: camera.view)
                XCTAssertTrue(camera.view.hitTest(centre, with: nil) === remove)
            }
            XCTAssertEqual(camera.view.subviews.first?.frame, camera.view.bounds)
            let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds: camera.view.bounds).image { camera.view.layer.render(in: $0.cgContext) })
            attachment.name = "Camera short viewport 320x700 \(count) photos"; attachment.lifetime = .keepAlways; add(attachment)
            camera.closeCapture(); camera.willMove(toParent: nil); camera.view.removeFromSuperview(); camera.removeFromParent()
        }
    }

    @MainActor
    func testOrderedGuidanceRemainsReadableAndUpdatesWhenThumbnailIsRemoved() throws {
        let jpeg = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 40))
        }.jpegData(compressionQuality: 0.8))
        let headings = ["Scan a barcode or take a photo", "1 photo ready", "2 photos ready", "3 photos ready", "4 photos ready"]
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        for count in 0...4 {
            let camera = SmartFoodCameraViewController(images: Array(repeating: jpeg, count: count))
            camera.loadViewIfNeeded(); defer { camera.closeCapture() }
            let controls = descendants(camera.view)
            let heading = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-status" } as? UILabel)
            let detail = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-hint" } as? UILabel)
            let counter = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-count" } as? UILabel)
            XCTAssertEqual(heading.text, headings[count])
            XCTAssertEqual(detail.text, CameraPhotoGuidance.message(photoCount: count).detail)
            XCTAssertEqual(counter.text, "\(count)/4")
            XCTAssertEqual(counter.accessibilityLabel, "\(count) of 4 photos")
            XCTAssertTrue(detail.isHidden)
            XCTAssertEqual(detail.alpha, 1); XCTAssertFalse(detail.accessibilityElementsHidden)
            XCTAssertEqual(heading.textColor, .white); XCTAssertEqual(detail.textColor, .white)
            XCTAssertEqual(heading.superview?.backgroundColor?.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)).cgColor.alpha, 1)
            XCTAssertFalse(controls.contains { $0.accessibilityIdentifier == "smart-camera-retake" })
            XCTAssertFalse(controls.compactMap { $0 as? UILabel }.contains { ($0.text ?? "").contains("Logging food for") })
            for identifier in ["smart-camera-recents", "smart-camera-favourites"] {
                let button = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == identifier } as? UIButton)
                XCTAssertTrue(button.isEnabled)
            }
            if count > 0 {
                let remove = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-remove-1" } as? UIButton)
                remove.sendActions(for: .touchUpInside)
                XCTAssertEqual(heading.text, headings[count - 1])
                XCTAssertEqual(camera.capturedImages.count, count - 1)
                XCTAssertNil(camera.presentedViewController)
            }
        }
    }

    @MainActor
    func testHistoryAndFoodLibraryKeepCameraDraftAndOriginalDestinationUntilClose() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        app.showFoodLibrary(mode: "recents", day: "2026-10-09", meal: "Dinner")
        let memo = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(images: [Data([1]), Data([2])], revision: 6, voiceMemo: memo)
        camera.loadViewIfNeeded()
        let ids = camera.capturedPhotoIDs
        let coordinator = NativeCaptureCoordinator(store: app)
        coordinator.prepare(camera)
        coordinator.foodCameraDidOpenHistory(camera)
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(app.selectedTab, "history")
        XCTAssertEqual(coordinator.loggingDay, "2026-10-09"); XCTAssertEqual(coordinator.loggingMeal, "Dinner")
        XCTAssertEqual(camera.capturedImages, [Data([1]), Data([2])]); XCTAssertEqual(camera.capturedPhotoIDs, ids)
        XCTAssertEqual(camera.captureSetRevision, 6); XCTAssertEqual(camera.capturedVoiceMemo?.audioData, memo.audioData)
        camera.resumePresentation()
        coordinator.foodCamera(camera, openFoodLibrary: "favourites")
        XCTAssertEqual(app.foodLibraryMode, "favourites")
        XCTAssertEqual(app.loggingDay, "2026-10-09"); XCTAssertEqual(app.loggingMeal, "Dinner")
        XCTAssertEqual(camera.capturedPhotoIDs, ids); XCTAssertEqual(camera.capturedVoiceMemo?.audioData, memo.audioData)
        coordinator.complete()
        XCTAssertNil(coordinator.camera); XCTAssertTrue(camera.capturedImages.isEmpty); XCTAssertNil(camera.capturedVoiceMemo)
    }

    @MainActor
    func testBarcodeDismissPreservesPhotosAndVoiceWithoutLoggingAnything() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let memo = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true, images: [Data([1])], revision: 4, voiceMemo: memo)
        let coordinator = NativeCaptureCoordinator(store: app)
        coordinator.prepare(camera); defer { coordinator.complete() }
        let ids = camera.capturedPhotoIDs
        camera.showProductSummary(try XCTUnwrap(CameraProductSummary(object: ["status":"ready", "compact":true, "name":"Product"])))
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let dismiss = try XCTUnwrap(descendants(camera.view).first { $0.accessibilityIdentifier == "camera-summary-dismiss" } as? UIButton)
        dismiss.sendActions(for: .touchUpInside)
        XCTAssertTrue(coordinator.camera === camera, "The result X must not dismiss the camera")
        XCTAssertEqual(camera.capturedImages, [Data([1])]); XCTAssertEqual(camera.capturedPhotoIDs, ids)
        XCTAssertEqual(camera.captureSetRevision, 4); XCTAssertEqual(camera.capturedVoiceMemo?.audioData, memo.audioData)
        XCTAssertFalse(camera.productLocked)
        XCTAssertTrue(app.review.isEmpty)
        XCTAssertTrue(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any] ?? []).isEmpty)
    }

    @MainActor
    func testSavingAnotherFoodPreservesDraftButSavingItsOwnPhotoResultCompletesIt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let coordinator = NativeCaptureCoordinator(store: app)
        let camera = SmartFoodCameraViewController(images: [Data([1])], revision: 4)
        coordinator.prepare(camera)
        coordinator.complete(ifReviewEventID: "unrelated-barcode-result")
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(camera.capturedImages, [Data([1])]); XCTAssertEqual(camera.captureSetRevision, 4)
        coordinator.complete(ifReviewEventID: nil)
        XCTAssertTrue(coordinator.camera === camera)
        coordinator.complete(ifReviewEventID: coordinator.photoEventID)
        XCTAssertNil(coordinator.camera); XCTAssertTrue(camera.capturedImages.isEmpty)

        let memo = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let voiceCamera = SmartFoodCameraViewController(voiceMemo: memo)
        coordinator.prepare(voiceCamera)
        coordinator.complete(ifReviewEventID: "another-food")
        XCTAssertTrue(coordinator.camera === voiceCamera)
        XCTAssertEqual(voiceCamera.capturedVoiceMemo?.audioData, memo.audioData)
        coordinator.complete()

        let emptyCamera = SmartFoodCameraViewController()
        coordinator.prepare(emptyCamera)
        coordinator.complete(ifReviewEventID: "barcode-without-photo-draft")
        XCTAssertTrue(coordinator.camera === emptyCamera, "Saving a previous result must leave the fresh camera ready")
        coordinator.complete()
    }

    func testSlowLookupDoesNotReleaseStationaryBarcodeRecognitionGate() {
        var gate = BarcodeRecognitionGate()
        let start = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(gate.observe("12345678", at: start))
        for second in 1...8 { gate.tick(paused: true, at: start.addingTimeInterval(Double(second))) }
        XCTAssertFalse(gate.observe("12345678", at: start.addingTimeInterval(8.1)))
        XCTAssertTrue(gate.observe("87654321", at: start.addingTimeInterval(8.2)), "A different pack is accepted immediately")
        gate.tick(paused: false, at: start.addingTimeInterval(8.5))
        XCTAssertFalse(gate.observe("87654321", at: start.addingTimeInterval(8.6)))
        gate.tick(paused: false, at: start.addingTimeInterval(9.7))
        XCTAssertFalse(gate.observe("87654321", at: start.addingTimeInterval(9.8)), "A timer never proves the pack left the camera")
        for frame in 0...8 { _ = gate.observe(nil, at: start.addingTimeInterval(10 + Double(frame) * 0.2)) }
        XCTAssertFalse(gate.observe("87654321", at: start.addingTimeInterval(11.7)), "Empty metadata never overrides the session latch")
        gate.allowExplicitRescan()
        XCTAssertTrue(gate.observe("87654321", at: start.addingTimeInterval(11.8)))
    }

    @MainActor
    func testUpwardSwipeAndOpenActionOnlyExpandPreparedProduct() throws {
        let card = CameraProductSummaryView()
        let swipe = try XCTUnwrap(card.gestureRecognizers?.compactMap { $0 as? UISwipeGestureRecognizer }.first)
        XCTAssertEqual(swipe.direction, .up)
        XCTAssertTrue(swipe.delegate === card)
        var actions: [String] = []
        card.onAction = { action, _ in actions.append(action) }
        for status in ["loading", "error", "needs_label", "ready"] {
            card.update(try XCTUnwrap(CameraProductSummary(object: ["status":status, "compact":true, "name":"Fixture food"])))
            _ = card.perform(NSSelectorFromString("expand"))
        }
        XCTAssertEqual(actions, ["expand"], "Loading and failed lookups cannot open a different or unfinished product")
        XCTAssertEqual(card.accessibilityCustomActions?.first?.name, "Open product")
    }

    @MainActor
    func testContinuousCompactSummaryKeepsCameraReadyForNextBarcodeAndShowsAlternatives() throws {
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        camera.loadViewIfNeeded()
        defer { camera.closeCapture() }
        let loading = try XCTUnwrap(CameraProductSummary(object: ["status":"loading", "compact":true, "name":"Finding your product…"]))
        camera.showProductSummary(loading)
        XCTAssertFalse(camera.productLocked, "The next distinct barcode must be accepted while this lookup is still loading")
        let summary = try XCTUnwrap(CameraProductSummary(object: ["status":"ready", "compact":true,
            "name":"Tomato and mozzarella salad", "brand":"Fixture", "score":25, "grade":"D",
            "scoreMethod":"nudge_nutrition_v0_4", "scoreVersion":"0.4",
            "warningText":"Contains milk · conflicts with your saved requirements.",
            "alternativesTitle":"Better at Sainsbury’s", "alternativesMessage":"Listed at Sainsbury’s",
            "alternatives":[["id":"barcode:1234000000029", "name":"Comparable salad", "brand":"Sainsbury’s", "score":75, "scoreText":"75%"]]]))
        camera.showProductSummary(summary)
        XCTAssertFalse(camera.productLocked, "Reading a result must not require a next button")
        func descendants(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(descendants) }
        let views = descendants(camera.view)
        XCTAssertNil(views.first { $0.accessibilityIdentifier == "camera-summary-dial" })
        XCTAssertFalse(views.compactMap { $0 as? UIButton }.contains { $0.configuration?.title == "Scan next" })
        XCTAssertEqual((views.first { $0.accessibilityIdentifier == "camera-summary-score" } as? UILabel)?.text, "25/100")
        XCTAssertNotNil(views.first { $0.accessibilityIdentifier == "camera-summary-alternatives" })
        XCTAssertTrue(views.compactMap { $0 as? UILabel }.contains { $0.text == "Better at Sainsbury’s" })
        XCTAssertTrue(views.compactMap { $0 as? UILabel }.contains { $0.text == summary.warningText })
        let error = try XCTUnwrap(CameraProductSummary(object: ["status":"error", "compact":true, "name":"Product unavailable", "primaryAction":"label"]))
        camera.showProductSummary(error)
        XCTAssertFalse(camera.productLocked, "An unavailable product must not block the next scan")
        camera.prepareForLabelCapture()
        XCTAssertTrue(camera.productLocked, "Photographing this label must prevent unrelated barcodes interrupting")
        XCTAssertEqual(camera.capturedImages.count, 0)
    }

    @MainActor
    func testCompactSummaryFitsPhoneAndCurrentScoreUsesGradeBands() throws {
        let parent = UIViewController(), card = CameraProductSummaryView()
        parent.loadViewIfNeeded(); parent.view.frame = CGRect(x:0,y:0,width:390,height:700)
        card.translatesAutoresizingMaskIntoConstraints = false; parent.view.addSubview(card)
        NSLayoutConstraint.activate([card.leadingAnchor.constraint(equalTo:parent.view.leadingAnchor,constant:12),
            card.trailingAnchor.constraint(equalTo:parent.view.trailingAnchor,constant:-12),
            card.bottomAnchor.constraint(equalTo:parent.view.bottomAnchor,constant:-20)])
        let summary = try XCTUnwrap(CameraProductSummary(object: ["status":"ready", "compact":true,
            "name":"Tomato and mozzarella salad", "score":50, "grade":"C", "scoreMethod":"nudge_nutrition_v0_4", "scoreVersion":"0.4",
            "scoreStatus":"estimated_provisional", "scoreConfidence":"low"]))
        card.update(summary); parent.view.layoutIfNeeded()
        card.setNeedsLayout(); card.layoutIfNeeded(); parent.view.layoutIfNeeded()
        XCTAssertEqual(summary.nutritionScore, 50); XCTAssertTrue(summary.isCurrentScore); XCTAssertFalse(summary.isRoughScore); XCTAssertNil(summary.grade)
        XCTAssertLessThan(card.bounds.height, 310, "The initial result must remain a small camera popup")
        XCTAssertGreaterThan(card.bounds.height, 100)
        func descendants(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(descendants) }
        XCTAssertEqual((descendants(card).first { $0.accessibilityIdentifier == "camera-summary-score" } as? UILabel)?.text, "50/100")
        let name = try XCTUnwrap(descendants(card).first { $0.accessibilityIdentifier == "camera-summary-name" } as? UILabel)
        let textHeight = name.sizeThatFits(CGSize(width:name.bounds.width,height:CGFloat.greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(name.bounds.height, textHeight - 1, "The full product name must wrap instead of clipping")
        let attachment = XCTAttachment(image: UIGraphicsImageRenderer(bounds:parent.view.bounds).image { parent.view.layer.render(in:$0.cgContext) })
        attachment.name = "Compact scanner result — synthetic salad fixture"; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor
    func testCrewArticulatesAndPausesWithoutAffectingAnalysisOrFabricatingCompletion() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene), parent = UIViewController()
        window.rootViewController = parent; window.makeKeyAndVisible()
        let crew = AnalysisCrewView(reducedMotion:false); crew.frame = CGRect(x:16,y:80,width:320,height:260)
        parent.view.addSubview(crew); parent.view.backgroundColor = NudgeTheme.canvas; parent.view.layoutIfNeeded()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        XCTAssertTrue(crew.assetAvailable); XCTAssertTrue(crew.animationRunning)
        func layers(_ layer: CALayer) -> [CALayer] { [layer] + (layer.sublayers ?? []).flatMap(layers) }
        let parts = layers(crew.layer)
        let artwork = try XCTUnwrap(parts.first { $0.sublayers?.contains(where: { $0.name == "crew-actor-0" }) == true })
        XCTAssertGreaterThan(artwork.affineTransform().a, 0.5, "Visible art must be scaled after the stage receives its layout")
        for name in ["crew-left-arm","crew-right-arm","crew-left-foot","crew-right-foot","crew-blink"] {
            XCTAssertTrue(parts.contains { $0.name == name && !($0.animationKeys() ?? []).isEmpty }, "The existing art must articulate, not just translate a static sticker")
        }
        let arm = try XCTUnwrap(parts.first { $0.name == "crew-left-arm" })
        try await Task.sleep(nanoseconds: 120_000_000)
        let start = try XCTUnwrap(arm.presentation()).transform
        try await Task.sleep(nanoseconds: 250_000_000)
        let end = try XCTUnwrap(arm.presentation()).transform
        XCTAssertNotEqual(start.m11,end.m11)
        var pauseChanges = 0; crew.onPauseChanged = { _ in pauseChanges += 1 }
        crew.togglePause(); XCTAssertFalse(crew.animationRunning); XCTAssertEqual(pauseChanges,1)
        let frozen = try XCTUnwrap(arm.presentation()).transform
        try await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertEqual(try XCTUnwrap(arm.presentation()).transform.m11,frozen.m11,accuracy:0.0001)
        crew.togglePause(); XCTAssertTrue(crew.animationRunning)
        crew.setBackgrounded(true); XCTAssertFalse(crew.animationRunning)
        crew.setBackgrounded(false); XCTAssertTrue(crew.animationRunning)
        crew.setReducedMotion(true); XCTAssertFalse(crew.animationRunning)
        for style in [UIUserInterfaceStyle.light,.dark] {
            window.overrideUserInterfaceStyle = style; parent.overrideUserInterfaceStyle = style
            parent.view.layoutIfNeeded()
            try await Task.sleep(nanoseconds: 120_000_000)
            let screenshot = UIGraphicsImageRenderer(bounds:parent.view.bounds).image { _ in parent.view.drawHierarchy(in:parent.view.bounds,afterScreenUpdates:true) }
            let attachment = XCTAttachment(image:screenshot); attachment.name = "Native crew reduced motion \(style.rawValue) — real original asset"; attachment.lifetime = .keepAlways; add(attachment)
        }
        crew.setReducedMotion(false); XCTAssertTrue(crew.animationRunning)
        crew.removeFromSuperview(); XCTAssertFalse(crew.animationRunning)
    }

    @MainActor
    func testCurrentSummaryKeepsFiftyAndSuppressesRetiredFrequencyAndGradeLabels() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene), parent = UIViewController()
        window.rootViewController = parent; window.makeKeyAndVisible(); parent.view.backgroundColor = NudgeTheme.canvas
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let base: [String:Any] = ["status":"ready","name":"Declared serving fixture","score":50,"grade":"C","scoreVersion":"0.4","scoreMethod":"nudge_nutrition_v0_4","frequencyStatus":"prototype_guidance","finalFrequency":"Weekly","primaryTitle":"View product"]
        for frequency in ["Weekly","Monthly"] {
            let summary = try XCTUnwrap(CameraProductSummary(object:base.merging(["finalFrequency":frequency],uniquingKeysWith:{_,new in new})))
            XCTAssertEqual(summary.nutritionScore,50); XCTAssertNil(summary.grade); XCTAssertNil(summary.finalFrequency)
            let card = CameraProductSummaryView(); card.translatesAutoresizingMaskIntoConstraints = false
            parent.view.addSubview(card)
            NSLayoutConstraint.activate([card.leadingAnchor.constraint(equalTo:parent.view.leadingAnchor,constant:18),card.trailingAnchor.constraint(equalTo:parent.view.trailingAnchor,constant:-18),card.topAnchor.constraint(equalTo:parent.view.safeAreaLayoutGuide.topAnchor,constant:16),card.bottomAnchor.constraint(lessThanOrEqualTo:parent.view.safeAreaLayoutGuide.bottomAnchor,constant:-16)])
            card.update(summary); parent.view.layoutIfNeeded()
            func descendants(_ view:UIView)->[UIView] { [view]+view.subviews.flatMap(descendants) }
            let views = descendants(card)
            XCTAssertEqual((views.first {$0.accessibilityIdentifier == "camera-summary-score"} as? UILabel)?.text,"50")
            XCTAssertEqual(views.first {$0.accessibilityIdentifier == "camera-summary-dial"}?.accessibilityLabel,"Nudge score 50 out of 100")
            XCTAssertNil(views.first {$0.accessibilityIdentifier == "camera-frequency-key"})
            for style in [UIUserInterfaceStyle.light,.dark] {
                window.overrideUserInterfaceStyle = style; parent.overrideUserInterfaceStyle = style; card.overrideUserInterfaceStyle = style
                parent.view.layoutIfNeeded()
                try await Task.sleep(nanoseconds: 120_000_000)
                let image = UIGraphicsImageRenderer(bounds:parent.view.bounds).image { _ in parent.view.drawHierarchy(in:parent.view.bounds,afterScreenUpdates:true) }
                let attachment = XCTAttachment(image:image); attachment.name = "Native fixed 50 \(frequency) \(style.rawValue) — fixture"; attachment.lifetime = .keepAlways; add(attachment)
            }
            card.removeFromSuperview()
        }
        for change: [String:Any] in [["score":54],["score":true],["grade":"B"]] {
            XCTAssertNil(CameraProductSummary(object:base.merging(change,uniquingKeysWith:{_,new in new}))?.nutritionScore)
        }
        let legacy = try XCTUnwrap(CameraProductSummary(object:base.merging([
            "scoreMethod":"nudge_nutrition_v0_3", "scoreVersion":"0.3"],uniquingKeysWith:{_,new in new})))
        XCTAssertEqual(legacy.nutritionScore, 50)
        XCTAssertEqual(legacy.grade, "C", "Recognized v0.3 records retain their original grade")
        XCTAssertNil(legacy.finalFrequency, "Retired frequency advice stays hidden for either recognized method")
        for status in ["incomplete","unsuitable","excluded","check_required","pending"] {
            XCTAssertNil(CameraProductSummary(object:base.merging(["frequencyStatus":status],uniquingKeysWith:{_,new in new}))?.finalFrequency)
        }
        let conflict = try XCTUnwrap(CameraProductSummary(object:base.merging(["warningText":"Contains peanuts"],uniquingKeysWith:{_,new in new})))
        let card = CameraProductSummaryView(); card.update(conflict)
        func descendants(_ view:UIView)->[UIView] { [view]+view.subviews.flatMap(descendants) }
        XCTAssertFalse(descendants(card).contains {$0.accessibilityIdentifier == "camera-summary-frequency"})
    }

    @MainActor
    func testCurrentCameraSummaryKeepsRatingBandsSeparateFromSafetyAndRejectsRetiredScores() throws {
        let base: [String:Any] = ["status":"ready","name":"Recognised food fixture","score":75,"grade":"B","scoreMethod":"nudge_nutrition_v0_4","scoreVersion":"0.4","scoreStatus":"estimated_provisional","scoreConfidence":"low","frequencyStatus":"check_required","warningText":"Contains peanuts. Check your allergy needs.","finalFrequency":"Daily","primaryTitle":"View product"]
        for (value,grade,tone) in [(0,"E","red"),(25,"D","amber"),(50,"C","green"),(75,"B","green"),(100,"A","green")] {
            let summary = try XCTUnwrap(CameraProductSummary(object:base.merging(["score":value,"grade":grade],uniquingKeysWith:{_,new in new})))
            XCTAssertEqual(summary.nutritionScore,value); XCTAssertEqual(summary.scoreTone,tone)
            XCTAssertFalse(summary.isRoughScore); XCTAssertTrue(summary.isCurrentScore); XCTAssertNil(summary.grade); XCTAssertNil(summary.finalFrequency)
            let card = CameraProductSummaryView(); card.update(summary)
            func descendants(_ view:UIView)->[UIView] { [view]+view.subviews.flatMap(descendants) }
            let views=descendants(card),labels=views.compactMap {$0 as? UILabel}
            XCTAssertEqual(labels.first {$0.accessibilityIdentifier == "camera-summary-score"}?.text,String(value))
            XCTAssertFalse(labels.contains {$0.text == "Rough estimate · Low confidence"})
            XCTAssertTrue(labels.contains {$0.text == "Contains peanuts. Check your allergy needs."})
            XCTAssertFalse(views.contains {$0.accessibilityIdentifier == "camera-summary-frequency"})
            XCTAssertEqual(views.first {$0.accessibilityIdentifier == "camera-summary-dial"}?.accessibilityLabel,"Nudge score \(value) out of 100")
        }
        for change: [String:Any] in [["score":true],["score":"75"],["score":84],["score":84.5],["score":0],["score":100],["score":Double.nan],["score":Double.infinity],["scoreVersion":"9"],["scoreMethod":"nudge_food_estimate_v2","scoreVersion":"2"],["scoreMethod":"nudge_food_estimate_v3","scoreVersion":"3"],["scoreMethod":"nudge_nutrition_v0_2","scoreVersion":"0.2"],["scoreMethod":"invented"]] {
            let summary=try XCTUnwrap(CameraProductSummary(object:base.merging(change,uniquingKeysWith:{_,new in new})))
            XCTAssertNil(summary.nutritionScore); XCTAssertNil(summary.finalFrequency)
        }
    }

    @MainActor
    func testCurrentSummaryDialFitsCameraAndAccessibleTextWithReachableActions() throws {
        let scene=try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap {$0 as? UIWindowScene}.first)
        let previous=scene.windows.first(where:\.isKeyWindow),window=UIWindow(windowScene:scene),parent=UIViewController(),camera=SmartFoodCameraViewController()
        parent.addChild(camera); parent.view.addSubview(camera.view); camera.didMove(toParent:parent)
        window.rootViewController=parent; window.makeKeyAndVisible()
        defer {camera.closeCapture();window.isHidden=true;previous?.makeKeyAndVisible()}
        let summary=try XCTUnwrap(CameraProductSummary(object:["status":"ready","name":"Berry smoothie with yoghurt and kefir","score":75,"grade":"B","scoreMethod":"nudge_nutrition_v0_4","scoreVersion":"0.4","scoreStatus":"estimated_provisional","scoreConfidence":"low","warningText":"Contains milk. Check your allergy needs.","primaryAction":"expand","primaryTitle":"View product"]))
        for (width,category,style) in [(CGFloat(390),UIContentSizeCategory.large,UIUserInterfaceStyle.light),(CGFloat(320),UIContentSizeCategory.accessibilityExtraExtraExtraLarge,UIUserInterfaceStyle.dark)] {
            parent.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory:category),forChild:camera)
            if #available(iOS 17.0,*) {camera.traitOverrides.preferredContentSizeCategory=category;camera.view.traitOverrides.preferredContentSizeCategory=category}
            parent.view.frame=CGRect(x:0,y:0,width:width,height:700);camera.view.frame=parent.view.bounds
            window.overrideUserInterfaceStyle=style;camera.overrideUserInterfaceStyle=style
            if #available(iOS 17.0,*) {camera.updateTraitsIfNeeded();func flush(_ v:UIView){v.updateTraitsIfNeeded();v.subviews.forEach(flush)};flush(camera.view)}
            camera.showProductSummary(summary);parent.view.layoutIfNeeded();camera.view.layoutIfNeeded()
            func descendants(_ v:UIView)->[UIView] {[v]+v.subviews.flatMap(descendants)}
            let views=descendants(camera.view),card=try XCTUnwrap(views.first {$0.accessibilityIdentifier=="camera-product-summary"}),dial=try XCTUnwrap(views.first {$0.accessibilityIdentifier=="camera-summary-dial"}),number=try XCTUnwrap(views.first {$0.accessibilityIdentifier=="camera-summary-score"} as? UILabel)
            XCTAssertEqual(camera.view.subviews.first?.frame,camera.view.bounds)
            XCTAssertEqual(number.text,"75");XCTAssertEqual(number.traitCollection.preferredContentSizeCategory,category)
            XCTAssertGreaterThan(dial.bounds.width,200);XCTAssertLessThanOrEqual(dial.bounds.width,240)
            XCTAssertTrue(dial.bounds.contains(number.frame),"\(category.rawValue): number \(number.frame) must fit dial \(dial.bounds)");XCTAssertGreaterThanOrEqual(number.frame.width,number.intrinsicContentSize.width)
            XCTAssertLessThanOrEqual(card.frame.maxX,width);XCTAssertLessThanOrEqual(card.frame.maxY,700)
            let scroll=try XCTUnwrap(card.subviews.compactMap {$0 as? UIScrollView}.first)
            scroll.setContentOffset(.zero,animated:false);scroll.layoutIfNeeded()
            let snapshot:()->UIImage={var image:UIImage!;camera.traitCollection.performAsCurrent {image=UIGraphicsImageRenderer(bounds:camera.view.bounds).image {camera.view.layer.render(in:$0.cgContext)}};return image}
            let image=XCTAttachment(image:snapshot());image.name="Current score 75 camera \(Int(width))px \(category.rawValue)";image.lifetime = .keepAlways;add(image)
            scroll.setContentOffset(CGPoint(x:0,y:max(0,scroll.contentSize.height-scroll.bounds.height)),animated:false);scroll.layoutIfNeeded()
            let action=try XCTUnwrap(views.first {$0.accessibilityIdentifier=="camera-summary-next"})
            XCTAssertTrue(card.bounds.contains(action.convert(CGPoint(x:action.bounds.midX,y:action.bounds.midY),to:card)))
        }
    }

    func testLibraryImportKeepsExistingPhotoIdentityAndSelectionOrder() throws {
        let existingID = UUID().uuidString
        var state = SmartCaptureState(images: [Data([7])], photoIDs: [existingID], revision: 12)
        XCTAssertEqual(state.librarySlotsAvailable, 3)
        let revision = try XCTUnwrap(state.beginLibraryImport())
        XCTAssertFalse(state.canCapture)
        XCTAssertFalse(state.canAnalyse)
        XCTAssertNil(state.beginLibraryImport(), "A second picker cannot overlap an import")
        XCTAssertTrue(state.finishLibraryImport([Data([2]), Data([3]), Data([4])], revision: revision))
        XCTAssertEqual(state.images, [Data([7]), Data([2]), Data([3]), Data([4])])
        XCTAssertEqual(state.photoIDs.first, existingID)
        XCTAssertEqual(Set(state.photoIDs).count, 4)
        XCTAssertTrue(state.photoIDs.allSatisfy { UUID(uuidString: $0) != nil })
        XCTAssertEqual(state.revision, 13)
        XCTAssertEqual(state.librarySlotsAvailable, 0)
        XCTAssertFalse(state.canImport)
        XCTAssertTrue(state.canAnalyse)
        XCTAssertFalse(state.finishLibraryImport([Data([8])], revision: revision), "A repeated callback cannot append twice")
    }

    func testLibraryCancellationAndRejectedFilesPreserveTheDraft() throws {
        var state = SmartCaptureState(images: [Data([1])], revision: 3)
        let photos = state.images, ids = state.photoIDs
        let originalArmed = state.armed
        let revision = try XCTUnwrap(state.beginLibraryImport())
        XCTAssertTrue(state.cancelLibraryImport(revision: revision))
        XCTAssertEqual(state.images, photos); XCTAssertEqual(state.photoIDs, ids)
        XCTAssertEqual(state.revision, 3); XCTAssertEqual(state.armed, originalArmed)
        for invalid in [[Data()], [Data(repeating: 0, count: 1_500_001)], Array(repeating: Data([9]), count: 4)] {
            let pending = try XCTUnwrap(state.beginLibraryImport())
            XCTAssertFalse(state.finishLibraryImport(invalid, revision: pending))
            XCTAssertEqual(state.images, photos); XCTAssertEqual(state.photoIDs, ids); XCTAssertEqual(state.revision, 3)
            XCTAssertTrue(state.canImport)
        }
        state.retake(at: 0)
        XCTAssertNil(state.beginLibraryImport(), "Retake keeps the selected photo until replacement or cancellation")
    }

    func testLibraryImportCannotReviveClosedOrChangedPhotoDrafts() throws {
        var state = SmartCaptureState(images: [Data([1])])
        let revision = try XCTUnwrap(state.beginLibraryImport())
        XCTAssertTrue(state.remove(at: 0))
        XCTAssertFalse(state.finishLibraryImport([Data([2])], revision: revision))
        XCTAssertTrue(state.images.isEmpty)
        let next = try XCTUnwrap(state.beginLibraryImport())
        state.close()
        XCTAssertFalse(state.finishLibraryImport([Data([3])], revision: next))
        XCTAssertFalse(state.canImport); XCTAssertTrue(state.images.isEmpty)
    }

    @MainActor
    func testSystemPhotoPickerOpensWithoutCameraAndCancelRetainsTheDraft() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root; window.makeKeyAndVisible()
        let jpeg = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100)).image { context in
            UIColor.green.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }.jpegData(compressionQuality: 0.8))
        let photoID = UUID().uuidString
        let camera = SmartFoodCameraViewController(images: [jpeg], photoIDs: [photoID], revision: 7)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let coordinator = NativeCaptureCoordinator(store: app, ownerKey: { "local-guest" })
        coordinator.prepare(camera)
        defer { coordinator.complete(); try? FileManager.default.removeItem(at: directory) }
        defer { camera.closeCapture(); root.dismiss(animated: false); window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        await withCheckedContinuation { continuation in root.present(camera, animated: false) { continuation.resume() } }
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let controls = descendants(camera.view)
        let library = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-library" } as? UIButton)
        XCTAssertTrue(library.isEnabled, "The simulator has no camera; Photos must still be reachable")
        library.sendActions(for: .touchUpInside)
        let close = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-close" } as? UIButton)
        XCTAssertTrue(close.isEnabled); XCTAssertTrue(camera.isCaptureInFlight)
        XCTAssertNil(coordinator.prepareFreshCamera(), "An in-flight import cannot be replaced by an empty camera")
        let priorTab = app.selectedTab, priorRoute = app.route
        coordinator.foodCameraDidOpenHistory(camera)
        coordinator.foodCamera(camera, openFoodLibrary: "favourites")
        XCTAssertEqual(app.selectedTab, priorTab); XCTAssertEqual(app.route, priorRoute)
        XCTAssertFalse(camera.isShowingResult, "Navigation must not suspend an in-flight import")
        XCTAssertTrue(coordinator.camera === camera)
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            MainActor.assumeIsolated { camera.presentedViewController is PHPickerViewController }
        }, object: nil)
        await fulfillment(of: [shown], timeout: 5)
        let picker = try XCTUnwrap(camera.presentedViewController as? PHPickerViewController)
        XCTAssertEqual(picker.configuration.selectionLimit, 3)
        XCTAssertEqual(picker.configuration.selection, .ordered)
        try await Task.sleep(nanoseconds: 400_000_000)
        picker.delegate?.picker(picker, didFinishPicking: [])
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            MainActor.assumeIsolated { camera.presentedViewController == nil && library.isEnabled }
        }, object: nil)
        await fulfillment(of: [dismissed], timeout: 5)
        XCTAssertEqual(camera.capturedImages, [jpeg])
        XCTAssertEqual(camera.capturedPhotoIDs, [photoID])
        XCTAssertEqual(camera.captureSetRevision, 7)
        XCTAssertTrue(close.isEnabled); XCTAssertFalse(camera.isCaptureInFlight)
    }

    @MainActor
    func testLibraryJPEGDownsamplesOrientsAndStripsPrivateMetadata() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 3_200, height: 1_600)).image { context in
            UIColor.green.setFill(); context.fill(CGRect(x: 0, y: 0, width: 3_200, height: 1_600))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
        defer { try? FileManager.default.removeItem(at: url) }
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(image.cgImage), [
            kCGImagePropertyOrientation: 6,
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 50.0, kCGImagePropertyGPSLongitude: 1.0],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2020:01:01 12:00:00"]
        ] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let rawPhoto = try Data(contentsOf: url)
        for jpeg in [try XCTUnwrap(CameraLibraryPhoto.jpeg(from: url)), try XCTUnwrap(CameraLibraryPhoto.jpeg(from: rawPhoto))] {
            XCTAssertLessThanOrEqual(jpeg.count, 1_500_000)
            let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
            let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
            XCTAssertEqual(properties[kCGImagePropertyPixelWidth as String] as? Int, 1_200)
            XCTAssertEqual(properties[kCGImagePropertyPixelHeight as String] as? Int, 2_400)
            XCTAssertNil(properties[kCGImagePropertyGPSDictionary as String])
            XCTAssertNil((properties[kCGImagePropertyExifDictionary as String] as? [String: Any])?[kCGImagePropertyExifDateTimeOriginal as String])
            let thumbnail = try XCTUnwrap(CameraLibraryPhoto.thumbnail(from: jpeg))
            XCTAssertEqual(thumbnail.width, 80); XCTAssertEqual(thumbnail.height, 160)
        }
        try Data("not an image".utf8).write(to: url)
        XCTAssertNil(CameraLibraryPhoto.jpeg(from: url))
    }

    @MainActor
    func testQuickSummaryRendersSharedScoresAlternativesAndRetainsCapturesAcrossDetail() throws {
        let jpeg = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100)).image { c in
            UIColor.systemPurple.setFill(); c.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }.jpegData(compressionQuality: 0.7))
        let photoID = UUID().uuidString
        let camera = SmartFoodCameraViewController(images: [jpeg], photoIDs: [photoID], revision: 4)
        camera.loadViewIfNeeded(); camera.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let candidate: [String: Any] = ["id":"fixture-alternative", "name":"Comparable oat snack", "brand":"Fixture retailer", "scoreText":"64 / 100"]
        for state in ["loading", "ready", "needs_label", "error"] {
            let object: [String: Any] = ["status":state, "name":"Isolated product fixture", "brand":"Test fixture", "scoreText":state == "ready" ? "26–36 / 100" : "", "bandText":"Monthly", "provisionalText":state == "ready" ? "Provisional" : "", "methodText":"Proposed beta", "primaryAction":state == "ready" ? "expand" : "label", "primaryTitle":state == "ready" ? "View product" : "Photograph the label", "alternatives":state == "ready" ? [candidate, candidate.merging(["id":"fixture-second", "scoreText":"72 / 100"],uniquingKeysWith: { _, value in value })] : []]
            let summary = try XCTUnwrap(CameraProductSummary(object: object))
            camera.showProductSummary(summary); camera.view.setNeedsLayout(); camera.view.layoutIfNeeded()
            func descendants(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(descendants) }
            let views = descendants(camera.view)
            let card = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "camera-product-summary" })
            XCTAssertFalse(card.isHidden)
            XCTAssertEqual(camera.view.subviews.first?.frame, camera.view.bounds)
            XCTAssertTrue(camera.productLocked, "Another barcode cannot replace the active summary")
            XCTAssertEqual(views.contains { $0.accessibilityIdentifier == "camera-summary-alternatives" }, state == "ready")
            XCTAssertTrue(views.contains { $0.accessibilityIdentifier == "camera-summary-next" })
            let screenshot = UIGraphicsImageRenderer(bounds: camera.view.bounds).image { camera.view.layer.render(in: $0.cgContext) }
            let attachment = XCTAttachment(image: screenshot); attachment.name = "Native quick summary \(state) — isolated fixture, no live camera"; attachment.lifetime = .keepAlways; add(attachment)
        }
        camera.suspendForResult()
        XCTAssertEqual(camera.capturedImages, [jpeg]); XCTAssertEqual(camera.capturedPhotoIDs, [photoID]); XCTAssertEqual(camera.captureSetRevision, 4)
        camera.prepareForLabelCapture()
        XCTAssertEqual(camera.capturedImages, [jpeg]); XCTAssertEqual(camera.captureSetRevision, 4)
        camera.prepareNextScan(); XCTAssertTrue(camera.capturedImages.isEmpty); XCTAssertFalse(camera.productLocked)
        camera.closeCapture()
    }

    func testQuickSummaryIdentityFenceAndBoundedUntrustedTransport() throws {
        let body: [String: Any] = ["requestId":"request-a","draftId":"scan-a","captureRevision":2,"analysisVersion":"analysis-v1","summary":["status":"ready","name":"Food","scoreText":"26–36 / 100","imageURL":"https://example.org/private.jpg","alternatives":[]]]
        let envelope = try XCTUnwrap(CameraSummaryEnvelope(body: body))
        XCTAssertTrue(envelope.matches(request: "request-a", draft: "scan-a", revision: 2))
        XCTAssertFalse(envelope.matches(request: "request-b", draft: "scan-a", revision: 2))
        XCTAssertFalse(envelope.matches(request: "request-a", draft: "scan-b", revision: 2))
        XCTAssertFalse(envelope.matches(request: "request-a", draft: "scan-a", revision: 3))
        XCTAssertNil(envelope.summary.imageURL)
        XCTAssertNil(CameraProductSummary(object: ["status":"success"])); XCTAssertNil(CameraSummaryEnvelope(body: [:]))
        XCTAssertNil(CameraProductSummary.thumbnailData("data:image/jpeg;base64," + Data([1,2]).base64EncodedString()))
        XCTAssertNil(CameraProductSummary.productImage("https://secret@images.openfoodfacts.org/x.jpg"))
        XCTAssertNotNil(CameraProductSummary.productImage("https://images.openfoodfacts.org/x.jpg"))
    }

    @MainActor
    func testQuickSummaryFitsNarrowAndAccessibilityLayoutsWithoutScalingCamera() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let parent = UIViewController()
        let camera = SmartFoodCameraViewController()
        parent.addChild(camera); parent.view.addSubview(camera.view); camera.didMove(toParent: parent)
        window.rootViewController = parent; window.makeKeyAndVisible()
        defer { camera.closeCapture(); window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        let summary = try XCTUnwrap(CameraProductSummary(object:["status":"ready","name":"Synthetic long product name for layout verification","brand":"Isolated test fixture","score":50,"grade":"C","scoreVersion":"0.4","scoreMethod":"nudge_nutrition_v0_4","frequencyStatus":"check_required","finalFrequency":NSNull(),"provisionalText":"Provisional","methodText":"Proposed beta","warningText":"Contains peanuts. Check your allergy needs.","primaryAction":"expand","primaryTitle":"View product","alternatives":[["id":"fixture-a","name":"Comparable snack","brand":"Fixture retailer","scoreText":"64 / 100"],["id":"fixture-b","name":"Another comparable snack","brand":"Fixture retailer","scoreText":"72 / 100"]]]))
        var normalNameSize: CGFloat = 0
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            parent.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: category), forChild: camera)
            if #available(iOS 17.0, *) {
                camera.traitOverrides.preferredContentSizeCategory = category
                camera.view.traitOverrides.preferredContentSizeCategory = category
            }
            parent.view.frame = CGRect(x:0,y:0,width:320,height:568); camera.view.frame = parent.view.bounds
            camera.overrideUserInterfaceStyle = category.isAccessibilityCategory ? .dark : .light
            window.overrideUserInterfaceStyle = camera.overrideUserInterfaceStyle
            if #available(iOS 17.0, *) {
                camera.updateTraitsIfNeeded()
                func flushTraits(_ view: UIView) { view.updateTraitsIfNeeded(); view.subviews.forEach(flushTraits) }
                flushTraits(camera.view)
            }
            camera.showProductSummary(summary); parent.view.layoutIfNeeded(); camera.view.layoutIfNeeded()
            func descendants(_ v:UIView)->[UIView] { [v]+v.subviews.flatMap(descendants) }
            let views=descendants(camera.view)
            let card=try XCTUnwrap(views.first { $0.accessibilityIdentifier == "camera-product-summary" })
            XCTAssertEqual(card.traitCollection.preferredContentSizeCategory,category)
            XCTAssertEqual(camera.traitCollection.userInterfaceStyle,category.isAccessibilityCategory ? .dark : .light)
            XCTAssertEqual(card.traitCollection.userInterfaceStyle,.light,"The barcode overlay keeps its light surface in either camera appearance")
            let name=try XCTUnwrap(views.first { $0.accessibilityIdentifier == "camera-summary-name" } as? UILabel)
            func components(_ color: UIColor, traits: UITraitCollection) -> [CGFloat] {
                var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
                XCTAssertTrue(color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha))
                return [red, green, blue, alpha]
            }
            let foreground = components(try XCTUnwrap(name.textColor), traits: name.traitCollection)
            let background = components(try XCTUnwrap(card.backgroundColor), traits: card.traitCollection)
            for (actual, expected) in zip(foreground, [CGFloat(0x25)/255, CGFloat(0x34)/255, CGFloat(0x52)/255, 1]) {
                XCTAssertEqual(actual, expected, accuracy: 0.001, "The product name remains explicit opaque navy")
            }
            for component in background { XCTAssertEqual(component, 1, accuracy: 0.001, "The result surface remains opaque white") }
            func luminance(_ rgba: [CGFloat]) -> CGFloat {
                let linear = rgba.prefix(3).map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
                return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
            }
            XCTAssertGreaterThanOrEqual((luminance(background) + 0.05) / (luminance(foreground) + 0.05), 4.5)
            XCTAssertEqual(name.alpha, 1)
            let expectedFont=UIFont.preferredFont(forTextStyle:.headline,compatibleWith:UITraitCollection(preferredContentSizeCategory:category))
            XCTAssertEqual(name.font.pointSize,expectedFont.pointSize,accuracy:0.1)
            if category.isAccessibilityCategory { XCTAssertGreaterThan(name.font.pointSize,normalNameSize) } else { normalNameSize = name.font.pointSize }
            XCTAssertEqual(camera.view.subviews.first?.frame,camera.view.bounds)
            XCTAssertGreaterThan(card.bounds.height,200); XCTAssertLessThanOrEqual(card.frame.maxX,320); XCTAssertLessThanOrEqual(card.frame.maxY,568)
            for button in views.compactMap({$0 as? UIButton}).filter({$0.accessibilityIdentifier?.hasPrefix("camera-summary-") == true}) { XCTAssertGreaterThanOrEqual(button.bounds.height,44) }
            for button in views.compactMap({$0 as? UIButton}) {
                guard button.accessibilityIdentifier?.hasPrefix("camera-summary-") == true,
                      let title=button.configuration?.title,!title.isEmpty else {continue}
                let insets=try XCTUnwrap(button.configuration?.contentInsets)
                let titleHeight=(title as NSString).boundingRect(with:CGSize(width:max(1,button.bounds.width-insets.leading-insets.trailing),height:.greatestFiniteMagnitude),options:[.usesLineFragmentOrigin,.usesFontLeading],attributes:[.font:expectedFont],context:nil).height
                XCTAssertGreaterThanOrEqual(button.bounds.height+0.5,ceil(titleHeight)+insets.top+insets.bottom,"The complete scaled \(button.accessibilityIdentifier ?? title) title must fit its touch target at \(category.rawValue)")
            }
            XCTAssertTrue(views.flatMap({$0.gestureRecognizers ?? []}).contains {$0 is UIPinchGestureRecognizer && $0.isEnabled},"Native lens pinch remains enabled outside app-shell WKWebView")
            let cardScroll=try XCTUnwrap(card.subviews.compactMap {$0 as? UIScrollView}.first)
            cardScroll.setContentOffset(.zero,animated:false); cardScroll.layoutIfNeeded()
            let snapshot: () -> UIImage = { var image: UIImage!; camera.traitCollection.performAsCurrent { image = UIGraphicsImageRenderer(bounds:camera.view.bounds).image {camera.view.layer.render(in:$0.cgContext)} }; return image }
            let attachment=XCTAttachment(image:snapshot())
            attachment.name="Native quick summary 320px \(category.rawValue) — isolated fixture"; attachment.lifetime = .keepAlways; add(attachment)
            cardScroll.setContentOffset(CGPoint(x:0,y:max(0,cardScroll.contentSize.height-cardScroll.bounds.height)),animated:false)
            cardScroll.layoutIfNeeded()
            let next=try XCTUnwrap(views.first {$0.accessibilityIdentifier == "camera-summary-next"})
            let nextCentre=next.convert(CGPoint(x:next.bounds.midX,y:next.bounds.midY),to:card)
            XCTAssertTrue(card.bounds.contains(nextCentre),"Primary actions remain reachable by scrolling larger text")
            let bottom=XCTAttachment(image:snapshot()); bottom.name="Native quick summary scrolled actions 320px \(category.rawValue)"; bottom.lifetime = .keepAlways; add(bottom)
        }
        camera.closeCapture()
    }

    @MainActor
    func testRescanTitleFitsBesideCloseAtNarrowWidthForCompactAndExpandedSummaries() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let parent = UIViewController(), content = UIViewController(), card = CameraProductSummaryView()
        parent.addChild(content); parent.view.addSubview(content.view); content.didMove(toParent: parent)
        window.rootViewController = parent; window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        card.translatesAutoresizingMaskIntoConstraints = false; content.view.addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: content.view.leadingAnchor, constant: 12),
            card.trailingAnchor.constraint(equalTo: content.view.trailingAnchor, constant: -12),
            card.topAnchor.constraint(equalTo: content.view.topAnchor),
            card.heightAnchor.constraint(lessThanOrEqualTo: content.view.heightAnchor)
        ])
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            parent.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: category), forChild: content)
            if #available(iOS 17.0, *) {
                content.traitOverrides.preferredContentSizeCategory = category
                content.view.traitOverrides.preferredContentSizeCategory = category
                content.updateTraitsIfNeeded()
                func flushTraits(_ view: UIView) { view.updateTraitsIfNeeded(); view.subviews.forEach(flushTraits) }
                flushTraits(content.view)
            }
            parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 568); content.view.frame = parent.view.bounds
            for compact in [true, false] {
                card.update(try XCTUnwrap(CameraProductSummary(object: ["status": "ready", "compact": compact, "name": "Fixture product"])))
                if #available(iOS 17.0, *) {
                    func flushTraits(_ view: UIView) { view.updateTraitsIfNeeded(); view.subviews.forEach(flushTraits) }
                    flushTraits(card)
                }
                parent.view.layoutIfNeeded(); card.setNeedsLayout(); card.layoutIfNeeded(); parent.view.layoutIfNeeded()
                let views = descendants(card)
                let rescan = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "camera-summary-rescan" } as? UIButton)
                let close = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "camera-summary-dismiss" } as? UIButton)
                XCTAssertEqual(rescan.traitCollection.preferredContentSizeCategory, category)
                let title = try XCTUnwrap(rescan.configuration?.title)
                let insets = try XCTUnwrap(rescan.configuration?.contentInsets)
                let font = UIFont.preferredFont(forTextStyle: .headline, compatibleWith: rescan.traitCollection)
                let textHeight = (title as NSString).boundingRect(with: CGSize(width: max(1, rescan.bounds.width - insets.leading - insets.trailing), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil).height
                XCTAssertGreaterThanOrEqual(rescan.bounds.height + 0.5, ceil(textHeight) + insets.top + insets.bottom, "The rescan title must fit at \(category.rawValue), compact=\(compact)")
                XCTAssertEqual(close.bounds.size, CGSize(width: 44, height: 44))
                XCTAssertTrue(try XCTUnwrap(rescan.superview).bounds.contains(rescan.frame), "The whole rescan target must fit inside its row")
            }
        }
    }

    func testPhotoFailuresDistinguishStageWithoutLeakingServerText() throws {
        for (status, code, stage) in [(502,"upstream_auth","configuration"),(413,"upload_too_large","upload"),(400,"invalid_image","upload"),(422,"result_too_large","response"),(422,"upstream_refusal","response"),(502,"upstream_incomplete","response"),(502,"upstream_invalid_response","response"),(422,"label_unreadable","visual_evidence"),(504,"upstream_timeout","connection"),(429,"quota_exceeded","quota")] {
            let data = try JSONSerialization.data(withJSONObject:["code":code,"message":"private secret health text"])
            let error = try XCTUnwrap(NutritionLabelService.errorForAccountHTTPResponse(statusCode: status, data: data))
            let failure = NutritionLabelService.publicFailure(error)
            XCTAssertEqual(failure.code, code); XCTAssertEqual(failure.stage, stage)
            XCTAssertFalse(failure.message.contains("private secret")); XCTAssertFalse(failure.message.contains("clearer photo"))
        }
        XCTAssertEqual(NutritionLabelService.publicFailure(URLError(.notConnectedToInternet)).stage,"connection")
        XCTAssertEqual(NutritionLabelService.publicFailure(NutritionLabelService.ServiceError.invalidResponse).stage,"response")
        XCTAssertEqual(NutritionLabelService.publicFailure(NutritionLabelService.ServiceError.accountAuthentication).stage,"authentication")
        XCTAssertEqual(NutritionLabelService.publicFailure(AccountError.network).stage,"connection")
        XCTAssertEqual(NutritionLabelService.publicFailure(AccountError.signInRequired).stage,"authentication")
        XCTAssertEqual(NutritionLabelService.publicFailure(AccountError.unavailable).stage,"configuration")
        XCTAssertEqual(NutritionLabelService.publicFailure(AccountError.invalidResponse).stage,"response")
        XCTAssertEqual(NutritionLabelService.publicFailure(AccountError.storage).code,"account_storage")
        XCTAssertEqual(NutritionLabelService.publicFailure(URLError(.timedOut)).code,"analysis_timeout")
    }
    @MainActor
    func testCameraReopenWaitsForDismissalAndIgnoresCancelledGeneration() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        root.view.backgroundColor = .black
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        for cancelled in [false, true] {
            let old = UIViewController()
            old.modalPresentationStyle = .fullScreen
            await withCheckedContinuation { continuation in root.present(old, animated: false) { continuation.resume() } }
            let ready = expectation(description: cancelled ? "Cancelled generation never reopens camera" : "Camera opens from stable root")
            ready.isInverted = cancelled
            var current = true
            old.dismiss(animated: true)
            NudgeCameraPresentation.whenReady(from: root, isCurrent: { current }) { presenter in
                XCTAssertTrue(presenter === root, "The dismissing camera cannot be the new presenter")
                XCTAssertFalse(old.isBeingDismissed)
                XCTAssertNil(old.presentingViewController)
                ready.fulfill()
            }
            if cancelled { current = false }
            await fulfillment(of: [ready], timeout: cancelled ? 1 : 3)
        }
    }

    func testCaptureStopsAfterOnePhotoUntilUserArmsAgain() throws {
        var state = SmartCaptureState()
        let first = try XCTUnwrap(state.beginCapture())
        XCTAssertNil(state.beginCapture(), "Duplicate camera callbacks must not start a second photo")
        XCTAssertTrue(state.finishCapture(Data([1, 2]), revision: first))
        XCTAssertFalse(state.canCapture)
        XCTAssertNil(state.beginCapture())
        state.arm()
        let second = try XCTUnwrap(state.beginCapture())
        XCTAssertTrue(state.finishCapture(Data([3]), revision: second))
        XCTAssertEqual(state.images.count, 2)
    }

    func testShutterAcknowledgementPrecedesJPEGAndRejectsStaleDuplicateAndFailedCallbacks() throws {
        var state = SmartCaptureState()
        XCTAssertFalse(state.acknowledgeShutter(revision: 0), "A button press without an exposure cannot flash")
        let first = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.acknowledgeShutter(revision: first + 1))
        XCTAssertTrue(state.acknowledgeShutter(revision: first))
        XCTAssertTrue(state.images.isEmpty, "The flash belongs to hardware exposure, before JPEG processing")
        XCTAssertFalse(state.acknowledgeShutter(revision: first), "One exposure produces one flash")
        XCTAssertTrue(state.finishCapture(Data([1]), revision: first))
        XCTAssertTrue(state.shutterAcknowledged, "JPEG completion must not produce a second flash")
        state.arm()
        let next = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.shutterAcknowledged)
        XCTAssertFalse(state.acknowledgeShutter(revision: first), "An earlier exposure cannot flash a fresh shutter")
        XCTAssertFalse(state.finishCapture(nil, revision: next))
        XCTAssertFalse(state.acknowledgeShutter(revision: next), "A failed capture has no success feedback")
        state.arm()
        let closing = try XCTUnwrap(state.beginCapture())
        state.close()
        XCTAssertFalse(state.acknowledgeShutter(revision: closing))
    }

    func testCaptureAndImportBlockLeavingUntilTheirAcceptedOrFailedCompletion() throws {
        var state = SmartCaptureState()
        XCTAssertTrue(state.canLeaveCapture)
        let exposure = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.canLeaveCapture)
        XCTAssertTrue(state.acknowledgeShutter(revision: exposure))
        XCTAssertFalse(state.canLeaveCapture, "A flash does not mean the photo has been saved")
        XCTAssertTrue(state.finishCapture(Data([1]), revision: exposure))
        XCTAssertTrue(state.canLeaveCapture)
        let importing = try XCTUnwrap(state.beginLibraryImport())
        XCTAssertFalse(state.canLeaveCapture)
        XCTAssertTrue(state.cancelLibraryImport(revision: importing))
        XCTAssertTrue(state.canLeaveCapture)
        state.arm()
        let failed = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.finishCapture(nil, revision: failed))
        XCTAssertTrue(state.canLeaveCapture, "A failed camera operation must not trap the user")
    }

    func testAnalysisRequiresPermissionAndCannotBeDuplicated() throws {
        var state = SmartCaptureState()
        XCTAssertNil(state.beginAnalysis(permission: true))
        let capture = try XCTUnwrap(state.beginCapture())
        XCTAssertTrue(state.finishCapture(Data([1]), revision: capture))
        XCTAssertNil(state.beginAnalysis(permission: false))
        let analysis = try XCTUnwrap(state.beginAnalysis(permission: true))
        XCTAssertNil(state.beginAnalysis(permission: true))
        state.arm()
        XCTAssertFalse(state.canCapture)
        XCTAssertFalse(state.finishAnalysis(revision: analysis + 1))
        XCTAssertTrue(state.finishAnalysis(revision: analysis))
        XCTAssertTrue(state.canAnalyse, "A failed request may be retried explicitly")
    }

    func testDurableSubmissionClearsDraftOnceAndRejectsStalePhotoAndAnalysisCallbacks() throws {
        var state = SmartCaptureState(images: [Data([1])], revision: 7)
        let analysis = try XCTUnwrap(state.beginAnalysis(permission: true))
        XCTAssertFalse(state.acceptSubmittedCapture(revision: analysis - 1))
        XCTAssertEqual(state.images, [Data([1])], "An acknowledgement for another revision cannot discard photos")
        XCTAssertTrue(state.acceptSubmittedCapture(revision: analysis))
        XCTAssertEqual(state.revision, 8)
        XCTAssertTrue(state.images.isEmpty); XCTAssertTrue(state.photoIDs.isEmpty)
        XCTAssertTrue(state.canCapture); XCTAssertTrue(state.canImport); XCTAssertFalse(state.canAnalyse)
        XCTAssertFalse(state.acceptSubmittedCapture(revision: analysis), "Only the accepted handoff may show Sent")
        XCTAssertFalse(state.finishAnalysis(revision: analysis))
        let next = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.finishCapture(Data([9]), revision: analysis), "An old photo completion cannot enter a fresh batch")
        XCTAssertTrue(state.capturing, "Ignoring a stale completion must not cancel the new shutter")
        XCTAssertTrue(state.finishCapture(Data([2]), revision: next))
        XCTAssertFalse(state.finishCapture(Data([2]), revision: next), "A successful photo may trigger feedback only once")
        XCTAssertFalse(state.acceptSubmittedCapture(revision: analysis))
        XCTAssertEqual(state.images, [Data([2])])
    }

    func testSubmissionResetRejectsPendingLibraryAndRetakeCompletions() throws {
        var picker = SmartCaptureState(images: [Data([1])], revision: 10)
        let importRevision = try XCTUnwrap(picker.beginLibraryImport())
        XCTAssertTrue(picker.acceptSubmittedCapture(revision: importRevision))
        XCTAssertFalse(picker.finishLibraryImport([Data([2])], revision: importRevision))
        XCTAssertTrue(picker.images.isEmpty); XCTAssertTrue(picker.canImport)

        var retake = SmartCaptureState(images: [Data([3])], revision: 10)
        retake.retake(at: 0)
        let oldPhoto = try XCTUnwrap(retake.beginCapture())
        retake.clearPhotos()
        let nextPhoto = try XCTUnwrap(retake.beginCapture())
        XCTAssertFalse(retake.finishCapture(Data([4]), revision: oldPhoto))
        XCTAssertTrue(retake.finishCapture(Data([5]), revision: nextPhoto))
        XCTAssertEqual(retake.images, [Data([5])])
    }

    @MainActor
    func testAcceptedSubmissionKeepsCameraOpenClearsVoiceAndDoesNotSaveAnEmptyDraft() async throws {
        final class Observer: SmartFoodCameraDelegate {
            var draftChanges = 0
            func foodCamera(_ camera: SmartFoodCameraViewController, found barcode: String) {}
            func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data]) {}
            func foodCameraDidOpenHistory(_ camera: SmartFoodCameraViewController) {}
            func foodCameraDidCancel(_ camera: SmartFoodCameraViewController) {}
            func foodCamera(_ camera: SmartFoodCameraViewController, changedPhotoCount count: Int) { draftChanges += 1 }
            func foodCameraDidChangeVoiceMemo(_ camera: SmartFoodCameraViewController) { draftChanges += 1 }
        }
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let jpeg = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
        }.jpegData(compressionQuality: 0.8))
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true, images: [jpeg], revision: 9, voiceMemo: voice)
        let observer = Observer(); camera.delegate = observer
        camera.loadViewIfNeeded()
        defer { camera.closeCapture() }
        camera.setCaptureStorageError("Could not save yet")
        XCTAssertFalse(camera.acceptSubmittedCapture(revision: 8))
        XCTAssertEqual(camera.capturedImages, [jpeg]); XCTAssertNotNil(camera.capturedVoiceMemo)
        XCTAssertTrue(camera.acceptSubmittedCapture(revision: 9))
        XCTAssertTrue(camera.capturedImages.isEmpty); XCTAssertTrue(camera.capturedPhotoIDs.isEmpty)
        XCTAssertNil(camera.capturedVoiceMemo); XCTAssertEqual(camera.captureSetRevision, 10)
        XCTAssertTrue(camera.delegate === observer); XCTAssertFalse(camera.isShowingResult)
        XCTAssertFalse(camera.productLocked); XCTAssertEqual(observer.draftChanges, 0)
        XCTAssertFalse(camera.acceptSubmittedCapture(revision: 9))
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let views = descendants(camera.view)
        let sent = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-sent" } as? UILabel)
        XCTAssertEqual(sent.text, "Analysing…"); XCTAssertFalse(sent.isHidden); XCTAssertFalse(sent.isUserInteractionEnabled)
        let feedback = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-capture-feedback" })
        XCTAssertEqual(feedback.backgroundColor, .white); XCTAssertFalse(feedback.isUserInteractionEnabled)
        XCTAssertFalse(feedback.isAccessibilityElement)
        XCTAssertTrue(views.filter { $0.accessibilityIdentifier?.hasPrefix("smart-camera-remove-") == true }.allSatisfy(\.isHidden))
        let library = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-library" } as? UIButton)
        let analyse = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-result" } as? UIButton)
        XCTAssertTrue(library.isEnabled); XCTAssertFalse(analyse.isEnabled)
        let status = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-status" } as? UILabel)
        XCTAssertEqual(status.text, CameraPhotoGuidance.message(photoCount: 0).heading)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertTrue(sent.isHidden, "Sent is brief and never blocks the next capture")
        XCTAssertEqual(observer.draftChanges, 0)
    }

    @MainActor
    func testShutterFlashIsVisibleBeforeProcessingAndCloseRemainsEnabled() throws {
        let camera = SmartFoodCameraViewController(photosOnly: true)
        camera.loadViewIfNeeded()
        func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
        let views = descendants(camera.view)
        let flash = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-capture-feedback" })
        let close = try XCTUnwrap(views.first { $0.accessibilityIdentifier == "smart-camera-close" } as? UIButton)
        let token = try XCTUnwrap(camera.beginPhotoCapture())
        XCTAssertTrue(close.isEnabled)
        XCTAssertEqual(flash.alpha, 0)
        camera.capturedShutter(token: token)
        XCTAssertGreaterThan(flash.alpha, 0, "The white overlay must remain committed before JPEG processing and persistence")
        XCTAssertFalse(flash.isUserInteractionEnabled)
        XCTAssertTrue(camera.view.subviews.last === flash)
        camera.finishPhoto(Data([1]), token: token)
        XCTAssertEqual(camera.capturedImages, [Data([1])])
        camera.closeCapture()
    }

    func testCloseRejectsPendingPhotoAndAnalysisAndErasesImages() throws {
        var state = SmartCaptureState()
        let pending = try XCTUnwrap(state.beginCapture())
        state.close()
        XCTAssertFalse(state.finishCapture(Data([1]), revision: pending))
        XCTAssertNil(state.beginCapture())
        state.arm()
        XCTAssertFalse(state.canCapture)
        var analysing = SmartCaptureState()
        let capture = try XCTUnwrap(analysing.beginCapture())
        XCTAssertTrue(analysing.finishCapture(Data([1]), revision: capture))
        let analysis = try XCTUnwrap(analysing.beginAnalysis(permission: true))
        analysing.close()
        XCTAssertTrue(analysing.images.isEmpty)
        XCTAssertFalse(analysing.finishAnalysis(revision: analysis))
    }

    func testReopenedBatchRetainsAllFourPhotosWithoutSilentlyDroppingAnAngle() throws {
        let photos = [Data([1]), Data([2]), Data([3]), Data([4])]
        var state = SmartCaptureState(images: photos)
        XCTAssertEqual(state.images, photos)
        XCTAssertFalse(state.canCapture)
        XCTAssertNil(state.beginCapture())
        XCTAssertTrue(state.canAnalyse)
    }

    func testExplicitRetakePreservesFourPhotosUntilSuccessfulReplacement() throws {
        let photos = [Data([1]), Data([2]), Data([3]), Data([4])]
        var state = SmartCaptureState(images: photos)
        state.allowLastPhotoRetake()
        let failed = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.finishCapture(nil, revision: failed))
        XCTAssertEqual(state.images, photos)
        state.arm()
        let capture = try XCTUnwrap(state.beginCapture())
        XCTAssertTrue(state.finishCapture(Data([5]), revision: capture))
        XCTAssertEqual(state.images, [Data([1]), Data([2]), Data([3]), Data([5])])
        XCTAssertFalse(state.canCapture)
        XCTAssertTrue(state.canAnalyse)
    }

    func testPhotoRemovalRetakeCancellationAndStaleAnalysis() throws {
        for count in [1, 2, 4] {
            var state = SmartCaptureState(images: (1...count).map { Data([UInt8($0)]) })
            let old = try XCTUnwrap(state.beginAnalysis(permission: true))
            XCTAssertTrue(state.remove(at: 0))
            XCTAssertEqual(state.images.count, count - 1)
            XCTAssertFalse(state.finishAnalysis(revision: old))
            XCTAssertTrue(state.canCapture)
            if count > 1 {
                let remaining = state.images
                state.retake(at: 0)
                state.cancelRetake()
                XCTAssertEqual(state.images, remaining)
                state.retake(at: 0)
                let revision = try XCTUnwrap(state.beginCapture())
                XCTAssertTrue(state.finishCapture(Data([99]), revision: revision))
                XCTAssertEqual(state.images[0], Data([99]))
                XCTAssertEqual(Array(state.images.dropFirst()), Array(remaining.dropFirst()))
            }
            state.clearPhotos()
            XCTAssertTrue(state.images.isEmpty)
            XCTAssertFalse(state.canAnalyse)
            XCTAssertTrue(state.canCapture)
        }
    }

    func testBarcodeCallbacksAreDeduplicatedAcrossResultPauseButLaterScansAreAllowed() {
        var gate = BarcodeRecognitionGate()
        let now = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(gate.observe("1001", at: now))
        XCTAssertFalse(gate.observe("1001", at: now.addingTimeInterval(0.5)))
        // A minute spent reading a result does not imply moving the camera away.
        gate.resume(at: now.addingTimeInterval(60))
        XCTAssertFalse(gate.observe(nil, at: now.addingTimeInterval(60.5)))
        XCTAssertFalse(gate.observe("1001", at: now.addingTimeInterval(60.7)))
        XCTAssertFalse(gate.observe(nil, at: now.addingTimeInterval(61.8)))
        XCTAssertFalse(gate.observe("1001", at: now.addingTimeInterval(62)))
        for frame in 0...8 { _ = gate.observe(nil, at: now.addingTimeInterval(63 + Double(frame) * 0.2)) }
        XCTAssertFalse(gate.observe("1001", at: now.addingTimeInterval(64.7)))
        gate.allowExplicitRescan()
        XCTAssertTrue(gate.observe("1001", at: now.addingTimeInterval(64.8)))
        XCTAssertTrue(gate.observe("1002", at: now.addingTimeInterval(65)))
        XCTAssertFalse(gate.observe("1002", at: now.addingTimeInterval(65.1)))
    }

    func testContinuousBarcodesProduceOneAcceptancePerSessionAndExplicitlyRescan() {
        var gate = BarcodeRecognitionGate()
        let start = Date(timeIntervalSince1970: 1_000)
        var accepted = 0
        if gate.observe("1001", at: start) { accepted += 1 }
        if gate.observe("1002", at: start.addingTimeInterval(0.1)) { accepted += 1 }
        for frame in 1...50 {
            let time = start.addingTimeInterval(Double(frame) * 0.1 + 0.1)
            if gate.observe("1001", at: time) { accepted += 1 }
            if gate.observe("1002", at: time) { accepted += 1 }
        }
        XCTAssertEqual(accepted, 2, "Alternating metadata from two stationary packs must not repeat flash, haptic or lookup")
        XCTAssertTrue(gate.observe("1003", at: start.addingTimeInterval(5.3)), "Previous pending lookups do not gate a distinct pack")
        for frame in 0...8 { _ = gate.observe(nil, at: start.addingTimeInterval(6.4 + Double(frame) * 0.2)) }
        XCTAssertFalse(gate.observe("1001", at: start.addingTimeInterval(8.1)))
        gate.allowExplicitRescan()
        XCTAssertTrue(gate.observe("1003", at: start.addingTimeInterval(8.2)))
        XCTAssertFalse(gate.observe("1001", at: start.addingTimeInterval(8.3)), "Explicit rescan only releases the latest product")
        XCTAssertFalse(gate.observe("1003", at: start.addingTimeInterval(8.4)))
    }

    func testHundredSlowCallbacksAndIntermittentMissesNeverDuplicateHeldBarcode() {
        var gate = BarcodeRecognitionGate()
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(gate.observe("1234000199991", at: start))
        for index in 1...100 {
            let now = start.addingTimeInterval(Double(index) * 2)
            _ = gate.observe(nil, at: now.addingTimeInterval(-0.1))
            gate.tick(paused: false, at: now)
            XCTAssertFalse(gate.observe("1234000199991", at: now), "Slow UI/persistence and a missed frame must not rearm the same pack")
        }
        gate.resume(at: start.addingTimeInterval(250))
        XCTAssertFalse(gate.observe("1234000199991", at: start.addingTimeInterval(251)), "Dismissing a result preserves the held-pack latch")
        XCTAssertTrue(gate.observe("1234000199992", at: start.addingTimeInterval(251.1)))
    }

    @MainActor
    func testHistoryThumbnailIsSmallRedrawnJPEGAndCannotContainFullCapture() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1_200, height: 900))
        let original = renderer.image { context in
            UIColor.purple.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1_200, height: 900))
        }
        let jpeg = try XCTUnwrap(original.jpegData(compressionQuality: 0.9))
        let url = try XCTUnwrap(CameraHistoryThumbnail.dataURL(from: jpeg))
        XCTAssertTrue(url.hasPrefix("data:image/jpeg;base64,"))
        XCTAssertLessThanOrEqual(url.utf8.count, 32_023)
        let data = try XCTUnwrap(Data(base64Encoded: String(url.dropFirst("data:image/jpeg;base64,".count))))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any])
        XCTAssertLessThanOrEqual(try XCTUnwrap(properties[kCGImagePropertyPixelWidth as String] as? Int), 240)
        XCTAssertLessThanOrEqual(try XCTUnwrap(properties[kCGImagePropertyPixelHeight as String] as? Int), 240)
        XCTAssertNil(properties[kCGImagePropertyGPSDictionary as String])
        XCTAssertNil(CameraHistoryThumbnail.dataURL(from: Data([0xff])))
    }

    @MainActor
    func testCameraOverlayKeepsFullScreenPreviewAndAccessiblePhotoActions() throws {
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100)).image { c in
            UIColor.systemPurple.setFill(); c.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }.jpegData(compressionQuality: 0.7)!
        for count in 0...4 {
            let camera = SmartFoodCameraViewController(images: Array(repeating: jpeg, count: count))
            camera.loadViewIfNeeded()
            camera.view.frame = CGRect(x: 0, y: 0, width: 430, height: 932)
            camera.view.setNeedsLayout(); camera.view.layoutIfNeeded()
            XCTAssertEqual(camera.view.subviews.first?.frame, camera.view.bounds, "Camera image must cover the entire view")
            func descendants(_ v: UIView) -> [UIView] { [v] + v.subviews.flatMap(descendants) }
            let controls = descendants(camera.view)
            XCTAssertFalse(controls.contains { $0.accessibilityIdentifier == "smart-camera-clear" || ($0 as? UIButton)?.title(for:.normal) == "Clear photos" }, "No hidden bulk-clear action or focus target may remain")
            let remove = controls.compactMap { $0 as? UIButton }.filter { $0.accessibilityIdentifier?.hasPrefix("smart-camera-remove-") == true && !$0.isHidden }
            XCTAssertEqual(remove.count, count)
            for button in remove {
                XCTAssertGreaterThanOrEqual(button.bounds.width, 44)
                XCTAssertGreaterThanOrEqual(button.bounds.height, 44)
                let centre = button.convert(CGPoint(x: button.bounds.midX, y: button.bounds.midY), to: camera.view)
                XCTAssertTrue(camera.view.hitTest(centre, with: nil) === button, "Removal action must be tappable outside thumbnail bounds")
            }
            let result = controls.first { $0.accessibilityIdentifier == "smart-camera-result" } as? UIButton
            XCTAssertEqual(result?.isEnabled, count > 0)
            let library = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-library" } as? UIButton)
            XCTAssertEqual(library.configuration?.title, "Photos")
            XCTAssertEqual(library.isEnabled, count < 4, "Choosing photos works even without a configured or permitted camera")
            XCTAssertGreaterThanOrEqual(library.bounds.height, 44)
            XCTAssertGreaterThanOrEqual(library.bounds.width, 44)
            let voice = try XCTUnwrap(controls.first { $0.accessibilityIdentifier == "smart-camera-voice" } as? UIButton)
            XCTAssertTrue(voice.isEnabled)
            XCTAssertGreaterThanOrEqual(voice.bounds.height, 44)
            XCTAssertGreaterThanOrEqual(voice.bounds.width, 44)
            XCTAssertNotNil(controls.first { $0.accessibilityIdentifier == "smart-camera-history" })
            let renderer = UIGraphicsImageRenderer(bounds: camera.view.bounds)
            let image = renderer.image { camera.view.layer.render(in: $0.cgContext) }
            let attachment = XCTAttachment(image: image)
            attachment.name = "Camera overlays \(count) photos — simulator without live camera"
            attachment.lifetime = .keepAlways
            add(attachment)
            camera.closeCapture()
        }
    }

    func testFailedPhotoNeedsExplicitRetry() throws {
        var state = SmartCaptureState()
        let capture = try XCTUnwrap(state.beginCapture())
        XCTAssertFalse(state.finishCapture(nil, revision: capture))
        XCTAssertFalse(state.canCapture)
        state.arm()
        XCTAssertNotNil(state.beginCapture())
    }

    func testFourPhotosAndSharedByteLimit() throws {
        var state = SmartCaptureState()
        for _ in 0..<4 {
            state.arm()
            let revision = try XCTUnwrap(state.beginCapture())
            XCTAssertTrue(state.finishCapture(Data(repeating: 0xff, count: 1_500_000), revision: revision))
        }
        state.arm()
        XCTAssertNil(state.beginCapture())
        let encoded = try NutritionLabelService.uploadBody(images: state.images)
        XCTAssertLessThanOrEqual(encoded.count, 8_001_024)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual((object["images"] as? [[String: String]])?.count, 4)
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(images: []))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(images: [Data()]))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(images: Array(repeating: Data([1]), count: 5)))
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(images: [Data(repeating: 0xff, count: 6_000_001)]))
    }

    func testAIPhotoPermissionIsRememberedAndRevocableWithoutTouchingDiary() throws {
        let suite = "nudge-camera-test-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("isolated diary fixture", forKey: "wmd-nudge-prototype-v1")
        let permission = PhotoAnalysisPermission(defaults: defaults)
        XCTAssertFalse(permission.allowed)
        permission.allow()
        XCTAssertTrue(PhotoAnalysisPermission(defaults: defaults).allowed)
        permission.revoke()
        XCTAssertFalse(PhotoAnalysisPermission(defaults: defaults).allowed)
        XCTAssertEqual(defaults.string(forKey: "wmd-nudge-prototype-v1"), "isolated diary fixture")
    }
}

extension SmartFoodCameraTests {
    @MainActor
    func testCaptureHapticPulsesOnceForSuccessfulPhotoAndRejectsStaleCallbacks() throws {
        for hardwareShutter in [true, false] {
            let camera = SmartFoodCameraViewController(photosOnly: true)
            camera.loadViewIfNeeded(); defer { camera.closeCapture() }
            let token = try XCTUnwrap(camera.beginPhotoCapture())
            XCTAssertEqual(camera.captureFeedbackCount, 0)
            camera.capturedShutter(token: UUID())
            XCTAssertEqual(camera.captureFeedbackCount, 0)
            if hardwareShutter {
                camera.capturedShutter(token: token)
                camera.capturedShutter(token: token)
                XCTAssertEqual(camera.captureFeedbackCount, 0, "Exposure flashes immediately but cannot yet confirm a saved photo")
            }
            camera.finishPhoto(Data([1]), token: token)
            XCTAssertEqual(camera.captureFeedbackCount, 1, "A successful photo produces one pulse with or without an exposure callback")
            camera.finishPhoto(Data([1]), token: token)
            camera.capturedShutter(token: token)
            XCTAssertEqual(camera.captureFeedbackCount, 1, "Late callbacks cannot pulse or capture again")
            XCTAssertEqual(camera.capturedImages.count, 1)
        }
        for hardwareShutter in [true, false] {
            let failed = SmartFoodCameraViewController(photosOnly: true)
            failed.loadViewIfNeeded(); defer { failed.closeCapture() }
            let token = try XCTUnwrap(failed.beginPhotoCapture())
            if hardwareShutter { failed.capturedShutter(token: token) }
            failed.finishPhoto(nil, token: token)
            XCTAssertEqual(failed.captureFeedbackCount, 0, "An unusable photo cannot produce a success pulse")
        }
        let dismissed = SmartFoodCameraViewController(photosOnly: true)
        dismissed.loadViewIfNeeded(); defer { dismissed.closeCapture() }
        let token = try XCTUnwrap(dismissed.beginPhotoCapture())
        XCTAssertTrue(dismissed.deferPhotoUntilAfterDismissal())
        dismissed.finishPhoto(Data([1]), token: token)
        XCTAssertEqual(dismissed.capturedImages.count, 1, "The deferred photo is still retained")
        XCTAssertEqual(dismissed.captureFeedbackCount, 0, "A dismissed camera cannot pulse later")
    }

    @MainActor
    func testCaptureHapticGeneratorStaysAttachedToTheCameraView() throws {
        guard #available(iOS 17.5, *) else { return }
        let camera = SmartFoodCameraViewController(photosOnly: true)
        camera.loadViewIfNeeded(); defer { camera.closeCapture() }
        let token = try XCTUnwrap(camera.beginPhotoCapture())
        let generators = camera.view.interactions.compactMap { $0 as? UIImpactFeedbackGenerator }
        XCTAssertEqual(generators.count, 1)
        XCTAssertTrue(generators.first?.view === camera.view, "Feedback belongs to the visible camera scene")
        camera.finishPhoto(Data([1]), token: token)
        _ = camera.beginPhotoCapture()
        XCTAssertEqual(camera.view.interactions.compactMap { $0 as? UIImpactFeedbackGenerator }.count, 1,
                       "Repeated photos reuse the prepared generator")
    }

    func testCameraHapticAudioPolicyOptsInRetriesAfterResetAndDoesNotBlockCapture() {
        final class Audio: CameraHapticAudioSession {
            enum Failure: Error { case interrupted }
            var allowHapticsAndSystemSoundsDuringRecording = false
            var interrupted = false
            var requests: [Bool] = []
            func setAllowHapticsAndSystemSoundsDuringRecording(_ allowed: Bool) throws {
                requests.append(allowed)
                if interrupted { throw Failure.interrupted }
                allowHapticsAndSystemSoundsDuringRecording = allowed
            }
        }
        let audio = Audio()
        XCTAssertTrue(CameraHapticAudioPolicy.prepare(audio))
        XCTAssertTrue(CameraHapticAudioPolicy.prepare(audio))
        XCTAssertEqual(audio.requests, [true], "An already-enabled session needs no repeated reconfiguration")
        audio.allowHapticsAndSystemSoundsDuringRecording = false; audio.interrupted = true
        XCTAssertFalse(CameraHapticAudioPolicy.prepare(audio), "A system error is nonfatal to capture")
        audio.interrupted = false
        XCTAssertTrue(CameraHapticAudioPolicy.prepare(audio), "The next start repairs a reset or interrupted audio session")
        XCTAssertEqual(audio.requests, [true, true, true])
    }

    @MainActor
    func testAnalyseSubmitsOnceWithoutIntakeAndCannotSubmitAReplacedBatch() throws {
        final class ChoiceObserver: SmartFoodCameraDelegate {
            var choices: [(Bool, [Data])] = []
            func foodCamera(_ camera: SmartFoodCameraViewController, found barcode: String) {}
            func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data]) { XCTFail("Analysis must explicitly preserve the no-intake intent") }
            func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data], addToEaten: Bool) { choices.append((addToEaten, images)) }
            func foodCameraDidOpenHistory(_ camera: SmartFoodCameraViewController) {}
            func foodCameraDidCancel(_ camera: SmartFoodCameraViewController) {}
            func foodCamera(_ camera: SmartFoodCameraViewController, changedPhotoCount count: Int) {}
        }
        let previousPermission = UserDefaults.standard.object(forKey: PhotoAnalysisPermission.key)
        UserDefaults.standard.set(true, forKey: PhotoAnalysisPermission.key)
        defer {
            if let previousPermission { UserDefaults.standard.set(previousPermission, forKey: PhotoAnalysisPermission.key) }
            else { UserDefaults.standard.removeObject(forKey: PhotoAnalysisPermission.key) }
        }
        do {
            let camera = SmartFoodCameraViewController(photosOnly: true, images: [Data([1])], revision: 9)
            let observer = ChoiceObserver(); camera.delegate = observer; camera.loadViewIfNeeded()
            defer { camera.closeCapture() }
            let oldRevision = camera.captureSetRevision
            XCTAssertTrue(camera.acceptSubmittedCapture(revision: oldRevision))
            let token = try XCTUnwrap(camera.beginPhotoCapture())
            camera.finishPhoto(Data([2]), token: token)
            camera.submitAnalysis(expectedRevision: oldRevision)
            XCTAssertTrue(observer.choices.isEmpty, "A stale action cannot submit the next photo batch")
            let currentRevision = camera.captureSetRevision
            func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
            let analyse = try XCTUnwrap(descendants(camera.view).first { $0.accessibilityIdentifier == "smart-camera-result" } as? UIButton)
            analyse.sendActions(for: .touchUpInside)
            camera.submitAnalysis(expectedRevision: currentRevision)
            XCTAssertEqual(observer.choices.count, 1)
            XCTAssertEqual(observer.choices.first?.0, false)
            XCTAssertEqual(observer.choices.first?.1, [Data([2])])
            XCTAssertNil(camera.presentedViewController, "Analyse dispatches directly without an intake choice sheet")
        }
    }
}
