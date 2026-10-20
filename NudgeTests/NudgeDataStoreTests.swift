import XCTest
import WebKit
import UIKit
@testable import Nudge

@MainActor
final class NudgeDataStoreTests: XCTestCase, WKNavigationDelegate {
    private var loaded: XCTestExpectation?
    private let key = "wmd-nudge-prototype-v1"
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true) }
    private func reply(_ store: NudgeDataStore, _ operation: String, _ key: String, _ value: String? = nil) throws -> [String: Any] {
        var body: [String: Any] = ["operation": operation, "key": key]
        if let value { body["value"] = value }
        let request = String(data: try JSONSerialization.data(withJSONObject: body), encoding: .utf8)!
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(store.handle(request).utf8)) as? [String: Any])
    }
    func testAtomicFilesSurviveReopenBeyondBrowserQuotaAndResetCannotResurrectLegacy() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = NudgeDataStore(directory: dir)
        let history = "{\"events\":[],\"fixture\":\"" + String(repeating: "a", count: 6_000_000) + "\"}"
        XCTAssertEqual(try reply(store, "import", "nudge-scan-history-v1", history)["ok"] as? Bool, true)
        let reopened = NudgeDataStore(directory: dir)
        XCTAssertEqual(try reply(reopened, "get", "nudge-scan-history-v1")["value"] as? String, history)
        XCTAssertEqual(try reply(store, "set", key, "{\"version\":1,\"entries\":[1]}")["ok"] as? Bool, true)
        XCTAssertEqual(try reply(store, "import", key, "{\"old\":true}")["value"] as? String, "{\"version\":1,\"entries\":[1]}")
        XCTAssertEqual(try reply(store, "remove", key)["ok"] as? Bool, true)
        let reset = try reply(reopened, "import", key, "{\"old\":true}")
        XCTAssertEqual(reset["exists"] as? Bool, true)
        XCTAssertTrue(reset["value"] is NSNull)
    }
    func testInvalidKeysPayloadsAndCorruptionNeverOverwriteRecords() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = NudgeDataStore(directory: dir)
        XCTAssertEqual(try reply(store, "set", "../other", "{}")["ok"] as? Bool, false)
        XCTAssertEqual(try reply(store, "set", key, "[]")["ok"] as? Bool, false)
        XCTAssertEqual(try reply(store, "set", key, "{\"version\":1}")["ok"] as? Bool, true)
        XCTAssertEqual(try reply(store, "set", key, "broken")["ok"] as? Bool, false)
        XCTAssertEqual(try reply(store, "get", key)["value"] as? String, "{\"version\":1}")
        let file = dir.appendingPathComponent(key + ".json")
        try Data("preserve corrupt evidence".utf8).write(to: file)
        XCTAssertEqual(try reply(store, "get", key)["error"] as? String, "corrupt_store")
        XCTAssertEqual(try reply(store, "set", key, "{}")["ok"] as? Bool, false)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "preserve corrupt evidence")
    }
    func testWriteFailureIsNotAcknowledgedAsSaved() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        try Data("not a directory".utf8).write(to: dir)
        XCTAssertEqual(try reply(NudgeDataStore(directory: dir), "set", key, "{}")["ok"] as? Bool, false)
    }
    func testBackupExclusionPreservesExistingNativePhotosAndLegacyBytes() throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let dir = root.appendingPathComponent("NudgeData"), legacy = root.appendingPathComponent("WebKit")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("Photos"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let records: [URL: Data] = [dir.appendingPathComponent(key + ".json"): Data("{\"version\":1,\"key\":\"\(key)\",\"value\":\"{\\\"fixture\\\":true}\"}".utf8),
            dir.appendingPathComponent("Photos/fixture.jpg"): Data([1, 2, 3]),
            legacy.appendingPathComponent("localstorage.sqlite"): Data("synthetic legacy bytes".utf8)]
        for (file, bytes) in records { try bytes.write(to: file) }
        let paths = try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted()
        let store = NudgeDataStore(directory: dir, legacyDirectory: legacy)
        try store.excludeExistingPrivateDataFromBackup()
        XCTAssertEqual(try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted(), paths)
        for (file, bytes) in records { XCTAssertEqual(try Data(contentsOf: file), bytes) }
        for folder in [dir, legacy] { XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true) }
        for value in ["{\"fixture\":1}", "{\"fixture\":2}"] {
            XCTAssertEqual(try reply(store, "set", key, value)["ok"] as? Bool, true)
            XCTAssertEqual(try reply(NudgeDataStore(directory: dir), "get", key)["value"] as? String, value)
            XCTAssertEqual(try dir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        }
    }
    func testBackupPreparationDoesNotCreateMissingLegacyDataAndPhotoFirstStoreIsExcluded() throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let dir = root.appendingPathComponent("NudgeData"), missing = root.appendingPathComponent("WebKit")
        let store = NudgeDataStore(directory: dir, legacyDirectory: missing)
        try store.excludeExistingPrivateDataFromBackup()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        let photo = Data([0xff, 0xd8, 3, 0xff, 0xd9])
        let ref = try XCTUnwrap(store.savePhotos([photo]).first)
        XCTAssertEqual(store.photoData(for: ref), photo)
        XCTAssertEqual(try dir.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }
    func testOriginalPhotosRetainIdentityAfterReopenAndRejectPaths() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let store = NudgeDataStore(directory: dir)
        let first = Data([0xff, 0xd8, 1, 0xff, 0xd9]), second = Data([0xff, 0xd8, 2, 0xff, 0xd9])
        let refs = try store.savePhotos([first, second])
        XCTAssertEqual(refs.count, 2)
        XCTAssertNotEqual(refs[0], refs[1])
        let reopened = NudgeDataStore(directory: dir)
        XCTAssertEqual(reopened.photoData(for: refs[0]), first)
        XCTAssertEqual(reopened.photoData(for: refs[1]), second)
        XCTAssertNil(reopened.photoData(for: "nudge-photo:../../outside.jpg"))
        XCTAssertNil(reopened.photoData(for: "file:///etc/passwd"))
        XCTAssertThrowsError(try store.savePhotos(Array(repeating: first, count: 5)))
        XCTAssertEqual(reopened.photoData(for: refs[0]), first)
    }
    private func evaluate(_ script: String, in web: WKWebView) throws -> Any? {
        let done = expectation(description: "JavaScript completes")
        var result: Any?, error: Error?
        web.evaluateJavaScript(script) { result = $0; error = $1; done.fulfill() }
        wait(for: [done], timeout: 30)
        if let error { throw error }; return result
    }
    func testRealWebViewMigratesBrowserDataAndWritesAfterBrowserQuotaIsFull() throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let web = NudgeWebConfiguration.makeWebView(dataStore: .nonPersistent(), nativeStore: NudgeDataStore(directory: dir))
        let fixture = """
        localStorage.setItem('wmd-nudge-prototype-v1', JSON.stringify({version:1, foodLog:{entries:[]}, focus:'sleep'}));
        localStorage.setItem('nudge-scan-history-v1', JSON.stringify({version:3,events:[]}));
        window.quotaReached=false;
        try { for(let i=0;i<50;i++) localStorage.setItem('quota-fixture-'+i,'a'.repeat(512*1024)); } catch(e) { window.quotaReached=e.name==='QuotaExceededError'; }
        """
        web.configuration.userContentController.addUserScript(WKUserScript(source: fixture, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene), controller = UIViewController()
        controller.view.addSubview(web); window.rootViewController = controller; window.makeKeyAndVisible()
        defer { web.stopLoading(); window.isHidden = true; previous?.makeKeyAndVisible() }
        loaded = expectation(description: "Bundled app loads")
        web.navigationDelegate = self; web.load(URLRequest(url: NudgeWebConfiguration.startURL)); wait(for: [loaded!], timeout: 40)
        XCTAssertEqual(try evaluate("window.quotaReached", in: web) as? Bool, true)
        XCTAssertEqual(try evaluate("NudgeStorage.native", in: web) as? Bool, true)
        XCTAssertEqual(try evaluate("JSON.parse(NudgeStorage.getItem('wmd-nudge-prototype-v1')).focus", in: web) as? String, "sleep")
        XCTAssertEqual(try evaluate("(()=>{const value=JSON.stringify({version:3,events:[],fixture:'x'.repeat(6*1024*1024)});NudgeStorage.setItem('nudge-scan-history-v1',value);return NudgeStorage.getItem('nudge-scan-history-v1')===value;})()", in: web) as? Bool, true)
        XCTAssertEqual(try evaluate("document.querySelectorAll('.storage-warning').length", in: web) as? Int, 0)
        XCTAssertTrue((try reply(NudgeDataStore(directory: dir), "get", "nudge-scan-history-v1")["value"] as? String)?.contains("fixture") == true)
        // Legacy source remains untouched and cannot resurrect after reset.
        XCTAssertEqual(try evaluate("(()=>{NudgeStorage.removeItem('wmd-nudge-prototype-v1');return NudgeStorage.getItem('wmd-nudge-prototype-v1')===null&&localStorage.getItem('wmd-nudge-prototype-v1')!==null;})()", in: web) as? Bool, true)
    }
}

@MainActor
final class NativeCaptureOutboxTests: XCTestCase {
    private func temporaryDirectory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    func testOriginalsAndAccountIdentitySurviveRestartWithoutUsingCacheStorage() throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let owner = String(repeating: "a", count: 64), other = String(repeating: "b", count: 64)
        let outbox = NativeCaptureOutbox(directory: directory)
        var record = NativeCaptureRecord(eventID: "scan-original", ownerKey: owner)
        record.photoIDs = [UUID().uuidString]; record.status = .queued
        let original = Data([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12] + Array("ftypM4A ".utf8)), durationSeconds: 2))
        let stored = try outbox.save(record, images: [original], voiceMemo: voice)
        let reopened = NativeCaptureOutbox(directory: directory)
        let restored = try XCTUnwrap(reopened.records(owner: owner).first)
        XCTAssertEqual(restored.id, stored.id); XCTAssertEqual(restored.submissionID, stored.submissionID)
        XCTAssertEqual(restored.createdAt, record.createdAt); XCTAssertEqual(try reopened.images(for: restored), [original])
        XCTAssertEqual(try reopened.voiceMemo(for: restored)?.audioData, voice.audioData)
        XCTAssertEqual(try reopened.voiceMemo(for: restored)?.durationSeconds, 2)
        XCTAssertTrue(try reopened.records(owner: other).isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(owner).appendingPathComponent(restored.photoFiles[0]).path))
    }
    func testFailedReplacementRetainsLastAcknowledgedManifestAndOriginal() throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NativeCaptureOutbox(directory: directory)
        var record = NativeCaptureRecord(eventID: "atomic-photo", ownerKey: "local-guest")
        record.photoIDs = [UUID().uuidString]
        let old = Data([0xff, 0xd8, 1, 0xff, 0xd9])
        record = try outbox.save(record, images: [old])
        var replacement = record; replacement.repairContext = Data(repeating: 1, count: 1_100_000)
        XCTAssertThrowsError(try outbox.save(replacement, images: [Data([0xff, 0xd8, 2, 0xff, 0xd9])]))
        let restored = try XCTUnwrap(outbox.records(owner: "local-guest").first)
        XCTAssertNil(restored.repairContext); XCTAssertEqual(try outbox.images(for: restored), [old])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("local-guest").path).count, 2)
    }
    func testFullOutboxRefusesAnotherAccountWithoutEvictingPendingOriginals() throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NativeCaptureOutbox(directory: directory, maximumBytes: 1_001_500)
        var first = NativeCaptureRecord(eventID: "first", ownerKey: "local-guest")
        first.photoIDs = [UUID().uuidString]; first.status = .retryableFailure
        let bytes = Data(repeating: 7, count: 1_000)
        let saved = try outbox.save(first, images: [bytes])
        var second = NativeCaptureRecord(eventID: "second", ownerKey: String(repeating: "a", count: 64)); second.photoIDs = [UUID().uuidString]
        XCTAssertThrowsError(try outbox.save(second, images: [bytes]))
        XCTAssertEqual(try outbox.images(for: saved), [bytes])
        XCTAssertEqual(try outbox.records(owner: "local-guest").count, 1)
    }
    func testBackoffIsBoundedJitteredAndHonoursRetryAfter() {
        let start = Date(timeIntervalSince1970: 100)
        XCTAssertEqual(NativeCaptureOutbox.retryDate(at: start, attempt: 1, jitter: 1), start.addingTimeInterval(5))
        XCTAssertEqual(NativeCaptureOutbox.retryDate(at: start, attempt: 2, jitter: 1), start.addingTimeInterval(10))
        XCTAssertEqual(NativeCaptureOutbox.retryDate(at: start, attempt: 2, retryAfter: 7200, jitter: 1), start.addingTimeInterval(7200))
        XCTAssertEqual(NativeCaptureOutbox.retryDate(at: start, attempt: 100, jitter: 1), start.addingTimeInterval(3600))
        XCTAssertEqual(NutritionLabelService.captureRetryAfter("7200", at: start), 7200)
        XCTAssertEqual(NutritionLabelService.captureRetryAfter("Thu, 01 Jan 1970 02:00:00 GMT", at: Date(timeIntervalSince1970: 0)), 7200)
    }
    func testExplicitGuestAdoptionPreservesCaptureAndRefusesAccountTransfers() throws {
        let directory = temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = NativeCaptureOutbox(directory: directory)
        var guest = NativeCaptureRecord(eventID: "guest-retry", ownerKey: "local-guest")
        guest.photoIDs = [UUID().uuidString]
        let photo = Data([0xff, 0xd8, 1, 0xff, 0xd9])
        guest = try outbox.save(guest, images: [photo])
        let claimed = try outbox.adoptGuest(guest, owner: String(repeating: "a", count: 64))
        XCTAssertEqual(claimed.id, guest.id); XCTAssertEqual(claimed.eventID, guest.eventID)
        XCTAssertEqual(claimed.createdAt, guest.createdAt); XCTAssertNotEqual(claimed.submissionID, guest.submissionID)
        XCTAssertEqual(try outbox.images(for: claimed), [photo]); XCTAssertTrue(try outbox.records(owner: "local-guest").isEmpty)
        XCTAssertThrowsError(try outbox.adoptGuest(claimed, owner: String(repeating: "b", count: 64)))
    }
}
