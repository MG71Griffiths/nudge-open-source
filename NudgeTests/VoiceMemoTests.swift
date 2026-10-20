import XCTest
import UIKit
import AVFoundation
@testable import Nudge

final class VoiceMemoTests: XCTestCase {
    private func payload(bytes: Int = 100, duration: Double = 1) throws -> VoiceMemoPayload {
        var data = Data(repeating: 0, count: bytes)
        data.replaceSubrange(4..<12, with: Data("ftypM4A ".utf8))
        return try XCTUnwrap(VoiceMemoPayload(audioData: data, durationSeconds: duration))
    }
    func testPermissionCallbackCannotStartRecordingAfterReleaseInterruptionOrNewHold() throws {
        var hold = VoiceMemoInteraction()
        let first = try XCTUnwrap(hold.begin())
        XCTAssertNil(hold.begin()); XCTAssertTrue(hold.active)
        XCTAssertFalse(hold.end())
        XCTAssertFalse(hold.permissionResolved(true, token: first)); XCTAssertFalse(hold.active)
        let next = try XCTUnwrap(hold.begin())
        XCTAssertFalse(hold.permissionResolved(true, token: first)); XCTAssertTrue(hold.active)
        XCTAssertTrue(hold.permissionResolved(true, token: next)); XCTAssertTrue(hold.recording)
        XCTAssertTrue(hold.end()); XCTAssertFalse(hold.active)
        XCTAssertFalse(hold.permissionResolved(true, token: next))
        let denied = try XCTUnwrap(hold.begin())
        XCTAssertFalse(hold.permissionResolved(false, token: denied)); XCTAssertFalse(hold.active)
    }
    func testUploadRequiresPhotosAndBoundsMemoWithoutChangingPhotoContract() throws {
        let photo = Data([1,2,3]), id = UUID().uuidString, memo = try payload()
        let original = try JSONSerialization.jsonObject(with: NutritionLabelService.uploadBody(images: [photo], photoIDs: [id], captureRevision: 7)) as! [String: Any]
        XCTAssertNil(original["voiceMemo"])
        let body = try NutritionLabelService.uploadBody(images: [photo], photoIDs: [id], captureRevision: 7, voiceMemo: memo)
        let value = try JSONSerialization.jsonObject(with: body) as! [String: Any]
        XCTAssertEqual(value["photoIds"] as? [String], [id]); XCTAssertEqual(value["captureRevision"] as? Int, 7)
        let voice = try XCTUnwrap(value["voiceMemo"] as? [String: Any])
        XCTAssertEqual(voice["mimeType"] as? String, "audio/mp4")
        XCTAssertEqual(voice["durationSeconds"] as? Double, 1)
        XCTAssertEqual(voice["audioBase64"] as? String, memo.audioData.base64EncodedString())
        XCTAssertThrowsError(try NutritionLabelService.uploadBody(images: [], voiceMemo: memo))
        let maximum = try payload(bytes: 512_000, duration: 60)
        let maximumBody = try NutritionLabelService.uploadBody(images: Array(repeating: Data(repeating: 1, count: 1_500_000), count: 4), voiceMemo: maximum)
        XCTAssertLessThanOrEqual(maximumBody.count, 8_685_000)
        for duration in [0, -1, 60.01, Double.nan, Double.infinity] {
            XCTAssertNil(VoiceMemoPayload(audioData: memo.audioData, durationSeconds: duration))
        }
        XCTAssertNil(VoiceMemoPayload(audioData: Data(repeating: 0, count: 512_001), durationSeconds: 1))
        XCTAssertNil(VoiceMemoPayload(audioData: Data("not-an-audio-container".utf8), durationSeconds: 1))
    }
    func testVoiceFailuresUseFixedActionableMessagesAndNeverProviderText() throws {
        let codes = [(400,"voice_invalid"), (413,"voice_too_large"), (502,"voice_transcription_failed"), (422,"voice_transcription_empty"), (504,"voice_transcription_timeout")]
        for (status, code) in codes {
            let error = try XCTUnwrap(NutritionLabelService.errorForAccountHTTPResponse(statusCode: status, data: JSONSerialization.data(withJSONObject: ["code":code,"message":"private provider transcript"])))
            let failure = NutritionLabelService.publicFailure(error)
            XCTAssertEqual(failure.code, code); XCTAssertTrue(failure.message.contains("voice note"))
            XCTAssertFalse(failure.message.contains("private provider transcript"))
            XCTAssertTrue(failure.message.contains("remove"))
        }
    }
    func testResponseCannotEchoAudioIntoWebHistoryButKeepsReviewTranscript() throws {
        let result = try NutritionLabelService.decodedResult(from: JSONSerialization.data(withJSONObject: [
            "extraction":["type":"meal","components":[["name":"Fixture","audioBase64":"private-audio"]]],
            "voiceMemo":["audioBase64":"private-audio"],
            "voiceNote":["text":"One portion","source":"user_voice","model":"gpt-4o-mini-transcribe"]
        ]))
        let text = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
        XCTAssertFalse(text.contains("private-audio")); XCTAssertNil(result["voiceMemo"])
        XCTAssertEqual((result["voiceNote"] as? [String: String])?["text"], "One portion")
    }
    @MainActor
    func testDraftRestoresPrivatelyRetainsForRetryAndDeletesOnRemoveAndDeinit() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let value = try payload()
        var draft: VoiceMemoDraft? = VoiceMemoDraft(payload: value, directory: directory)
        let first = try XCTUnwrap(draft?.fileURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.path))
        XCTAssertEqual(draft?.payload?.audioData, value.audioData)
        let attributes = try FileManager.default.attributesOfItem(atPath: first.path)
        #if targetEnvironment(simulator)
        // CoreSimulator does not expose Data Protection attributes. The app
        // writes with completeFileProtection; inspect when the filesystem does.
        if let protection = attributes[.protectionKey] as? FileProtectionType { XCTAssertEqual(protection, .complete) }
        #else
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .complete)
        #endif
        XCTAssertEqual(try first.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        draft?.interrupt(); XCTAssertEqual(draft?.payload?.audioData, value.audioData)
        draft?.remove(); XCTAssertFalse(FileManager.default.fileExists(atPath: first.path)); XCTAssertNil(draft?.payload)
        draft = VoiceMemoDraft(payload: value, directory: directory)
        let second = try XCTUnwrap(draft?.fileURL)
        draft = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }
    @MainActor
    func testSyntheticAACRoundTripPlaybackAndInterruption() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("synthetic-silence.m4a")
        var file: AVAudioFile? = try AVAudioFile(forWriting: url, settings: VoiceMemoDraft.recordingSettings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file!.processingFormat, frameCapacity: 11_025))
        buffer.frameLength = 11_025
        buffer.floatChannelData![0].initialize(repeating: 0, count: Int(buffer.frameLength))
        try file!.write(from: buffer); file = nil
        let audio = try AVAudioPlayer(contentsOf: url)
        XCTAssertEqual(audio.numberOfChannels, 1); XCTAssertGreaterThan(audio.duration, 0.4); XCTAssertLessThan(audio.duration, 0.7)
        let value = try XCTUnwrap(VoiceMemoPayload(audioData: Data(contentsOf: url), durationSeconds: audio.duration))
        let draft = VoiceMemoDraft(payload: value, directory: directory)
        try draft.togglePlayback(); XCTAssertTrue(draft.playing)
        draft.interrupt(); XCTAssertFalse(draft.playing); XCTAssertNotNil(draft.payload)
        draft.remove(); XCTAssertNil(draft.payload)
        let attachment = XCTAttachment(data: value.audioData, uniformTypeIdentifier: "public.mpeg-4-audio")
        attachment.name = "Synthetic silence AAC encoder fixture — no microphone or user audio"; attachment.lifetime = .keepAlways; add(attachment)
    }
    @MainActor private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
    @MainActor private func button(_ name: String, in camera: SmartFoodCameraViewController) throws -> UIButton {
        try XCTUnwrap(descendants(camera.view).first { $0.accessibilityIdentifier == name } as? UIButton)
    }
    @MainActor private func photo() throws -> Data {
        try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).image { c in UIColor.green.setFill(); c.fill(CGRect(x: 0,y: 0,width: 80,height: 80)) }.jpegData(compressionQuality: 0.8))
    }
    @MainActor
    func testCameraReleaseAndInterruptionCancelDelayedPermissionWithoutRecording() async throws {
        var permissions: [(Bool) -> Void] = []
        let camera = SmartFoodCameraViewController(images: [try photo()], voicePermissionRequest: { permissions.append($0) })
        camera.loadViewIfNeeded(); defer { camera.closeCapture() }
        let mic = try button("smart-camera-voice", in: camera)
        mic.sendActions(for: .touchDown)
        XCTAssertEqual(permissions.count, 1)
        mic.sendActions(for: .touchUpOutside); permissions[0](true)
        await Task.yield(); try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertNil(camera.capturedVoiceMemo)
        let status = try XCTUnwrap(descendants(camera.view).first { $0.accessibilityIdentifier == "smart-camera-voice-status" })
        XCTAssertTrue(status.isHidden)
        XCTAssertTrue(mic.accessibilityActivate(), "VoiceOver can start without holding")
        XCTAssertEqual(permissions.count, 2)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        permissions[1](true)
        await Task.yield(); try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(status.isHidden); XCTAssertNil(camera.capturedVoiceMemo)
        mic.sendActions(for: .touchDown); camera.closeCapture(); permissions[2](true)
        await Task.yield(); XCTAssertNil(camera.capturedVoiceMemo)
    }
    @MainActor
    func testRemovingFinalPhotoRetainsVoiceContextAndAdvancesCaptureRevision() throws {
        let memo = try payload(), camera = SmartFoodCameraViewController(images:[try photo()],revision:7,voiceMemo:memo)
        camera.loadViewIfNeeded(); defer { camera.closeCapture() }
        try button("smart-camera-remove-1",in:camera).sendActions(for:.touchUpInside)
        XCTAssertTrue(camera.capturedImages.isEmpty); XCTAssertTrue(camera.capturedPhotoIDs.isEmpty)
        XCTAssertEqual(camera.captureSetRevision,8)
        XCTAssertEqual(camera.capturedVoiceMemo?.audioData,memo.audioData)
        XCTAssertFalse(try button("smart-camera-result",in:camera).isEnabled)
        XCTAssertTrue(try button("smart-camera-library",in:camera).isEnabled)
    }

    @MainActor
    func testCameraMemoSurvivesReviewAndRetryButRedoNextScanAndCloseDeleteIt() throws {
        let jpeg = try photo(), memo = try payload(), id = UUID().uuidString
        let camera = SmartFoodCameraViewController(images: [jpeg], photoIDs: [id], revision: 4, voiceMemo: memo)
        camera.loadViewIfNeeded(); defer { camera.closeCapture() }
        camera.suspendForResult(); camera.prepareForLabelCapture(); camera.resumePresentation()
        XCTAssertEqual(camera.capturedVoiceMemo?.audioData, memo.audioData)
        XCTAssertEqual(camera.capturedPhotoIDs, [id]); XCTAssertEqual(camera.captureSetRevision, 4)
        try button("smart-camera-voice-redo", in: camera).sendActions(for: .touchUpInside)
        XCTAssertNil(camera.capturedVoiceMemo); XCTAssertEqual(camera.capturedImages, [jpeg]); XCTAssertEqual(camera.captureSetRevision, 5)
        for nextScan in [true, false] {
            let next = SmartFoodCameraViewController(images: [jpeg], voiceMemo: memo)
            next.loadViewIfNeeded()
            if nextScan { next.prepareNextScan() } else { next.closeCapture() }
            XCTAssertNil(next.capturedVoiceMemo); next.closeCapture()
        }
    }
    @MainActor
    func testCameraVoiceLayoutAtNarrowWidthAndLargestAccessibilityText() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene), parent = UIViewController()
        let camera = SmartFoodCameraViewController(images: [try photo()], voiceMemo: try payload())
        parent.addChild(camera); parent.view.addSubview(camera.view); camera.didMove(toParent: parent)
        window.rootViewController = parent; window.makeKeyAndVisible()
        defer { camera.closeCapture(); window.isHidden = true; previous?.makeKeyAndVisible() }
        for category in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
            parent.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: category), forChild: camera)
            if #available(iOS 17, *) { camera.traitOverrides.preferredContentSizeCategory = category; camera.view.traitOverrides.preferredContentSizeCategory = category }
            parent.view.frame = CGRect(x:0,y:0,width:320,height:568); camera.view.frame = parent.view.bounds
            parent.view.layoutIfNeeded(); camera.view.layoutIfNeeded()
            let mic = try button("smart-camera-voice", in: camera), shutter = try button("smart-camera-capture", in: camera)
            XCTAssertGreaterThan(mic.convert(mic.bounds, to: camera.view).midX, shutter.convert(shutter.bounds, to: camera.view).midX)
            for name in ["smart-camera-voice", "smart-camera-voice-play", "smart-camera-voice-redo", "smart-camera-voice-remove"] {
                let control = try button(name, in: camera)
                XCTAssertGreaterThanOrEqual(control.bounds.width, 44); XCTAssertGreaterThanOrEqual(control.bounds.height, 44)
                if name != "smart-camera-voice", let label = control.titleLabel {
                    XCTAssertLessThanOrEqual(label.frame.maxY, control.bounds.height + 1, "Large labels must stay inside their hit target")
                    XCTAssertGreaterThanOrEqual(label.frame.minY, -1)
                }
            }
            let notice = try XCTUnwrap(descendants(camera.view).first { $0.accessibilityIdentifier == "smart-camera-voice-notice" } as? UILabel)
            XCTAssertTrue(notice.text?.contains("photos") == true)
            XCTAssertGreaterThanOrEqual(notice.bounds.height, notice.font.lineHeight, "The sharing notice must not collapse")
            let voiceStatus = try XCTUnwrap(descendants(camera.view).first { $0.accessibilityIdentifier == "smart-camera-voice-status" } as? UILabel)
            XCTAssertGreaterThanOrEqual(voiceStatus.bounds.height, voiceStatus.font.lineHeight, "Recorded duration must remain visible")
            let screenshot = UIGraphicsImageRenderer(bounds: camera.view.bounds).image { camera.view.layer.render(in: $0.cgContext) }
            let attachment = XCTAttachment(image: screenshot); attachment.name = "Voice camera \(category.rawValue) — isolated fixture"; attachment.lifetime = .keepAlways; add(attachment)
            let scroll = try XCTUnwrap(camera.view.subviews.compactMap { $0 as? UIScrollView }.first)
            let analyse = try button("smart-camera-result", in: camera)
            scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height)), animated: false)
            camera.view.layoutIfNeeded()
            let frame = analyse.convert(analyse.bounds, to: camera.view)
            XCTAssertGreaterThanOrEqual(frame.minY, 0)
            XCTAssertLessThanOrEqual(frame.maxY, camera.view.bounds.height)
            let bottom = UIGraphicsImageRenderer(bounds: camera.view.bounds).image { camera.view.layer.render(in: $0.cgContext) }
            let footer = XCTAttachment(image: bottom); footer.name = "Voice camera accessible actions \(category.rawValue)"; footer.lifetime = .keepAlways; add(footer)
            scroll.setContentOffset(.zero, animated: false)
        }
    }
}
