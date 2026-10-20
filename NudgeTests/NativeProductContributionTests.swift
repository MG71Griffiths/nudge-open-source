import Foundation
import ImageIO
import UIKit
import XCTest
@testable import Nudge

@MainActor
final class NativeProductContributionTests: XCTestCase {
    private let owner = String(repeating: "a", count: 64)
    private let otherOwner = String(repeating: "b", count: 64)
    private let date = Date()

    private func draft(owner: String? = nil) -> ProductContributionRecord {
        var record = ProductContributionRecord(id: UUID(), ownerKey: owner ?? self.owner,
            createdAt: date, updatedAt: date, barcode: "5060003830306", productName: "Private draft title",
            countryCode: "GB", storeID: ProductSearchStore.sainsburys.rawValue)
        record.photos = [.init(role: .nutrition, data: Data([0xff, 0xd8, 0xff, 0xd9]))]
        record.consented = true
        return record
    }
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    private func service(owner: String? = nil, current: @escaping () async -> Bool = { true }) -> ProductContributionService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ContributionFixtureProtocol.self]
        return .init(session: URLSession(configuration: config), authorization: {
            .init(baseURL: URL(string: "https://contribution.test")!, token: "test-token", ownerKey: owner ?? self.owner, isCurrent: current)
        }, diagnostics: nil, analysisAllowed: { true })
    }
    private func image() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).jpegData(withCompressionQuality: 0.9) { context in
            UIColor.green.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
    }
    private func model(_ service: ProductContributionService, outbox: ProductContributionOutbox) -> ProductContributionModel {
        .init(context: .init(barcode: "5060003830306", productName: "Test pack", countryCode: "GB", store: .sainsburys), service: service, outbox: outbox)
    }

    func testSharingRequiresExplicitConsentAndOnlyContainsAllowlistedProductEvidence() throws {
        var record = draft()
        record.consented = false
        XCTAssertThrowsError(try record.body())
        record.consented = true
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: record.body()) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["id", "barcode", "marketCountry", "store", "consent", "photos"])
        XCTAssertNil(body["productName"]); XCTAssertNil(body["ownerKey"]); XCTAssertNil(body["diary"])
        let consent = try XCTUnwrap(body["consent"] as? [String: Any])
        XCTAssertEqual(consent["version"] as? String, "product-contribution-v1")
        XCTAssertEqual(consent["shareProductFacts"] as? Bool, true)
        XCTAssertEqual(consent["retainPhotosForReview"] as? Bool, true)
        let photos = try XCTUnwrap(body["photos"] as? [[String: Any]])
        XCTAssertEqual(photos.count, 1, "One nutrition photo can be submitted without inventing missing roles")
        XCTAssertEqual(photos[0]["role"] as? String, "nutrition")
        XCTAssertEqual(Set(photos[0].keys), ["role", "mimeType", "imageBase64"])
        record.countryCode = nil; record.storeID = nil
        let unknownMarket = try XCTUnwrap(JSONSerialization.jsonObject(with: record.body()) as? [String: Any])
        XCTAssertTrue(unknownMarket["marketCountry"] is NSNull)
        XCTAssertTrue(unknownMarket["store"] is NSNull)
    }

    func testContributionRejectsDuplicateRolesOversizeAndUnscopedInputs() throws {
        var record = draft()
        record.photos.append(record.photos[0]); XCTAssertThrowsError(try record.body())
        record = draft(); record.photos = [.init(role: .front, data: Data([0xff, 0xd8]) + Data(repeating: 0, count: 750_000))]
        XCTAssertThrowsError(try record.body())
        record = draft(); record.barcode = "../../private"; XCTAssertThrowsError(try record.body())
        record = draft(); record.countryCode = "Atlantis"; XCTAssertThrowsError(try record.body())
        record = draft(); record.storeID = "arbitrary text"; XCTAssertThrowsError(try record.body())
        record = draft(); record.photos = []; XCTAssertThrowsError(try record.body())
    }

    func testPhotoPreparationStripsLocationAndMetadataAndBoundsJPEG() throws {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(image() as CFData, nil))
        let original = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let bytes = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(bytes, "public.jpeg" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, original, [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLongitude: -0.1],
            kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFArtist: "Fixture private name"]
        ] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let prepared = try ProductContributionPhoto.prepare(bytes as Data)
        XCTAssertLessThanOrEqual(prepared.count, ProductContributionPhoto.maximumBytes)
        let clean = try XCTUnwrap(CGImageSourceCreateWithData(prepared as CFData, nil))
        let metadata = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(clean, 0, nil) as? [String: Any])
        XCTAssertNil(metadata[kCGImagePropertyGPSDictionary as String])
        XCTAssertNil((metadata[kCGImagePropertyTIFFDictionary as String] as? [String: Any])?[kCGImagePropertyTIFFArtist as String])
        XCTAssertThrowsError(try ProductContributionPhoto.prepare(Data("not an image".utf8)))
    }

    func testOutboxSurvivesRestartPartitionsOwnersAndPreservesNewerDrafts() async throws {
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let first = ProductContributionOutbox(directory: directory)
        var record = draft(); record.submissionAttempted = true
        try await first.save(record)
        let second = ProductContributionOutbox(directory: directory)
        let restored = try await second.records(owner: owner)
        XCTAssertEqual(restored.map(\.id), [record.id]); XCTAssertEqual(restored[0].photos, record.photos)
        XCTAssertTrue(restored[0].submissionAttempted)
        let otherRecords = try await second.records(owner: otherOwner)
        XCTAssertTrue(otherRecords.isEmpty)
        var newer = record; newer.updatedAt = record.updatedAt.addingTimeInterval(10); newer.productName = "New draft"
        try await second.save(newer); try await first.save(record)
        let retained = try await second.records(owner: owner)
        XCTAssertEqual(retained[0].productName, "New draft")
        XCTAssertNil(try String(contentsOf: directory.appendingPathComponent(owner).appendingPathComponent(record.id.uuidString.lowercased() + ".json")).range(of: "test-token"))
        try await second.remove(id: record.id, owner: otherOwner)
        let afterWrongOwnerDelete = try await first.records(owner: owner)
        XCTAssertEqual(afterWrongOwnerDelete.count, 1, "Another account cannot remove this draft")
        let expired = try await first.records(owner: owner, now: date.addingTimeInterval(31 * 86_400))
        XCTAssertTrue(expired.isEmpty)
    }

    func testQueuedStaleEditCannotResurrectDeletedDraft() async throws {
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ProductContributionOutbox(directory: directory)
        var record = draft()
        try await outbox.save(record)
        try await outbox.remove(id: record.id, owner: owner)
        try await outbox.save(record)
        let deleted = try await outbox.records(owner: owner)
        XCTAssertTrue(deleted.isEmpty, "An edit queued before removal cannot recreate private photos")
        // A still-open empty draft can legitimately receive a new photo later.
        record.updatedAt = Date().addingTimeInterval(1)
        try await outbox.save(record)
        let updated = try await outbox.records(owner: owner)
        XCTAssertEqual(updated.map(\.id), [record.id])
    }

    func testFullOutboxRefusesNewDraftWithoutEvictingPendingPhotos() async throws {
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ProductContributionOutbox(directory: directory)
        var ids: Set<UUID> = []
        for _ in 0..<ProductContributionOutbox.maximumEntries {
            let record = draft(); ids.insert(record.id); try await outbox.save(record)
        }
        do { try await outbox.save(draft()); XCTFail("A full outbox must fail visibly") }
        catch ProductContributionError.capacity { }
        let retained = try await outbox.records(owner: owner)
        XCTAssertEqual(Set(retained.map(\.id)), ids)
        XCTAssertTrue(retained.allSatisfy { !$0.photos.isEmpty })
    }

    func testCompletedPhotoFreeReceiptsDoNotUsePendingDraftSlots() async throws {
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ProductContributionOutbox(directory: directory)
        for _ in 0..<20 {
            var record = draft(); record.photos = []; record.submissionAttempted = true
            record.remote = ProductContributionStatus(id: record.id, barcode: record.barcode, status: .published,
                createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, expiresAt: 1_802_592_000_000,
                attempts: 1, nextRetryAt: nil, missingPhotoRoles: [], sourceLookup: "not_found", message: "Published", canRetry: false, canDelete: false)
            try await outbox.save(record)
        }
        let pending = draft(); try await outbox.save(pending)
        let retained = try await outbox.records(owner: owner)
        XCTAssertEqual(retained.count, 21)
        XCTAssertEqual(retained.first(where: { $0.id == pending.id })?.photos.map(\.data), pending.photos.map(\.data))
    }

    func testReceiptHistoryIsBoundedWithoutRemovingPendingPhotos() async throws {
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ProductContributionOutbox(directory: directory)
        let pending = draft(); try await outbox.save(pending)
        for _ in 0..<(ProductContributionOutbox.maximumReceipts + 2) {
            var record = draft(); record.photos = []; record.submissionAttempted = true
            record.remote = ProductContributionStatus(id: record.id, barcode: record.barcode, status: .rejected,
                createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, expiresAt: 1_802_592_000_000,
                attempts: 1, nextRetryAt: nil, missingPhotoRoles: [], sourceLookup: "not_found", message: "Not added", canRetry: false, canDelete: false)
            try await outbox.save(record)
        }
        let retained = try await outbox.records(owner: owner)
        XCTAssertEqual(retained.count, ProductContributionOutbox.maximumReceipts + 1)
        XCTAssertEqual(retained.first(where: { $0.id == pending.id })?.photos.map(\.data), pending.photos.map(\.data))
    }

    func testOutboxByteBudgetIncludesOtherAccountPartitionsWithoutEviction() async throws {
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let otherFolder = directory.appendingPathComponent(otherOwner)
        try FileManager.default.createDirectory(at: otherFolder, withIntermediateDirectories: true)
        let occupied = otherFolder.appendingPathComponent("private-pending-photos.bin")
        try Data().write(to: occupied)
        let handle = try FileHandle(forWritingTo: occupied)
        try handle.truncate(atOffset: UInt64(ProductContributionOutbox.maximumBytes)); try handle.close()
        let outbox = ProductContributionOutbox(directory: directory)
        do { try await outbox.save(draft()); XCTFail("All owner partitions share one disk bound") }
        catch ProductContributionError.capacity { }
        XCTAssertEqual(try occupied.resourceValues(forKeys: [.fileSizeKey]).fileSize, ProductContributionOutbox.maximumBytes)
        let current = try await outbox.records(owner: owner)
        XCTAssertTrue(current.isEmpty)
    }

    func testOwnerPartitionStableAcrossTokenRefreshAndSeparatedAcrossAccountsAndServers() throws {
        func jwt(_ subject: UUID, expires: Int) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: ["sub": subject.uuidString, "exp": expires])
            return "header." + data.base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_") + ".signature"
        }
        let id = UUID(), backend = URL(string: "https://contribution.test")!
        let original = try ProductContributionService.ownerKey(token: jwt(id, expires: 1), baseURL: backend)
        let refreshed = try ProductContributionService.ownerKey(token: jwt(id, expires: 2), baseURL: backend)
        XCTAssertEqual(original, refreshed)
        XCTAssertNotEqual(original, try ProductContributionService.ownerKey(token: jwt(UUID(), expires: 2), baseURL: backend))
        XCTAssertNotEqual(original, try ProductContributionService.ownerKey(token: jwt(id, expires: 2), baseURL: URL(string: "https://other.test")!))
        XCTAssertThrowsError(try ProductContributionService.ownerKey(token: "invalid token", baseURL: backend))
    }

    func testSubmitRetryReusesExactIDAndPhotoBodyAfterUnknownOutcome() async throws {
        ContributionFixtureProtocol.state.reset(mode: .fail)
        let service = service(); defer { service.session.invalidateAndCancel() }
        let record = draft()
        do { _ = try await service.submit(record); XCTFail("Failure must not look accepted") }
        catch ProductContributionError.unavailable { }
        ContributionFixtureProtocol.state.mode = .success
        let accepted = try await service.submit(record)
        XCTAssertEqual(accepted.id, record.id); XCTAssertEqual(accepted.status, .pendingReview)
        let requests = ContributionFixtureProtocol.state.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].body, requests[1].body, "A timeout retry must use the same idempotent body")
        XCTAssertEqual(requests[0].authorization, "Bearer test-token")
    }

    func testOwnerAndAccountChangeFencePreventsUpload() async throws {
        ContributionFixtureProtocol.state.reset()
        let wrong = service(owner: otherOwner); defer { wrong.session.invalidateAndCancel() }
        do { _ = try await wrong.submit(draft()); XCTFail("Wrong owner must not upload") }
        catch ProductContributionError.accountChanged { }
        let signedOut = service(current: { false }); defer { signedOut.session.invalidateAndCancel() }
        do { _ = try await signedOut.submit(draft()); XCTFail("Signed-out owner must not upload") }
        catch ProductContributionError.accountChanged { }
        XCTAssertTrue(ContributionFixtureProtocol.state.requests.isEmpty)
    }

    func testAIPermissionIsRequiredForSubmitAndRecheckedAfterAuthorization() async throws {
        ContributionFixtureProtocol.state.reset()
        let suite = "contribution-permission-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let permission = PhotoAnalysisPermission(defaults: defaults)
        var service = service(); defer { service.session.invalidateAndCancel() }
        service.analysisAllowed = { permission.allowed }
        do { _ = try await service.submit(draft()); XCTFail("Sharing consent does not grant AI permission") }
        catch ProductContributionError.analysisPermissionRequired { }
        permission.allow()
        service.authorization = {
            await Task.yield()
            permission.revoke()
            return .init(baseURL: URL(string: "https://contribution.test")!, token: "test-token", ownerKey: self.owner)
        }
        do { _ = try await service.submit(draft()); XCTFail("Revocation during authorization must prevent dispatch") }
        catch ProductContributionError.analysisPermissionRequired { }
        XCTAssertTrue(ContributionFixtureProtocol.state.requests.isEmpty)
        // Status and deletion remain available after AI permission is revoked.
        _ = try await service.list(owner: owner)
        try await service.delete(draft())
        XCTAssertEqual(ContributionFixtureProtocol.state.requests.map(\.method), ["GET", "DELETE"])
    }

    func testAccountChangeAfterUploadCannotAcknowledgeDraftForNewAccount() async throws {
        ContributionFixtureProtocol.state.reset()
        let fence = ContributionRevisionFence()
        let service = service(current: { await fence.check() }); defer { service.session.invalidateAndCancel() }
        do { _ = try await service.submit(draft()); XCTFail("Account revision changed while response was in flight") }
        catch ProductContributionError.accountChanged { }
        XCTAssertEqual(ContributionFixtureProtocol.state.requests.count, 1)
    }

    func testDeletedSubmissionTombstoneCannotBeMistakenForRetryableUpload() async throws {
        ContributionFixtureProtocol.state.reset(mode: .deleted)
        let service = service(); defer { service.session.invalidateAndCancel() }
        do { _ = try await service.submit(draft()); XCTFail("A deleted UUID must not be resurrected") }
        catch ProductContributionError.deleted { }
    }

    func testServiceRejectsWrongIdentityAndExposesRetryDelay() async throws {
        ContributionFixtureProtocol.state.reset(mode: .wrongIdentity)
        let service = service(); defer { service.session.invalidateAndCancel() }
        do { _ = try await service.submit(draft()); XCTFail("Different UUID must not acknowledge this draft") }
        catch ProductContributionError.invalidResponse { }
        ContributionFixtureProtocol.state.mode = .limited
        do { _ = try await service.submit(draft()); XCTFail("Throttling remains retryable without data loss") }
        catch ProductContributionError.retryLater(let seconds) { XCTAssertEqual(seconds, 120) }
    }

    func testModelDoesNotUploadUntilConsentAndKeepsThenPurgesPhotosOnAcknowledgement() async throws {
        ContributionFixtureProtocol.state.reset(mode: .fail)
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ProductContributionOutbox(directory: directory), service = service()
        defer { service.session.invalidateAndCancel() }
        let model = model(service, outbox: outbox)
        await model.load()
        await model.addPhoto(image(), role: .nutrition)
        await model.send()
        XCTAssertFalse(ContributionFixtureProtocol.state.requests.contains { $0.method == "POST" })
        model.edit(consent: true)
        let id = try XCTUnwrap(model.current?.id)
        await model.send()
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.current?.id, id); XCTAssertTrue(model.current?.submissionAttempted == true)
        let saved = try await ProductContributionOutbox(directory: directory).records(owner: owner)
        XCTAssertEqual(saved[0].id, id); XCTAssertFalse(saved[0].photos.isEmpty)
        ContributionFixtureProtocol.state.mode = .success
        await model.retry()
        XCTAssertNil(model.error); XCTAssertEqual(model.current?.remote?.status, .pendingReview)
        XCTAssertTrue(model.current?.photos.isEmpty == true)
        let accepted = try await outbox.records(owner: owner)
        XCTAssertEqual(accepted[0].id, id); XCTAssertTrue(accepted[0].photos.isEmpty)
        let posts = ContributionFixtureProtocol.state.requests.filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2); XCTAssertEqual(posts[0].body, posts[1].body)
        ContributionFixtureProtocol.state.mode = .fail
        await model.remove()
        XCTAssertEqual(model.current?.id, id)
        let afterFailedDelete = try await outbox.records(owner: owner)
        XCTAssertEqual(afterFailedDelete.count, 1, "Failed deletion must retain the local status")
        ContributionFixtureProtocol.state.mode = .success
        await model.remove()
        let afterDelete = try await outbox.records(owner: owner)
        XCTAssertTrue(afterDelete.isEmpty)
        XCTAssertNotEqual(model.current?.id, id)
    }

    func testStorageFailurePreventsUploadAndKeepsDraftEditable() async throws {
        ContributionFixtureProtocol.state.reset()
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ProductContributionOutbox(directory: directory), service = service()
        defer { service.session.invalidateAndCancel() }
        let model = model(service, outbox: outbox)
        await model.load()
        await model.addPhoto(image(), role: .front)
        model.edit(consent: true)
        // Replace only this test's directory with a file to cause a real write failure.
        try FileManager.default.removeItem(at: directory)
        try Data("blocked test path".utf8).write(to: directory)
        await model.send()
        XCTAssertNotNil(model.error); XCTAssertTrue(model.current?.editable == true)
        XCTAssertFalse(ContributionFixtureProtocol.state.requests.contains { $0.method == "POST" })
    }

    func testContributionDiagnosticsContainOnlyRouteStatusTimingAndNoProductIdentity() async throws {
        ContributionFixtureProtocol.state.reset(mode: .fail)
        let directory = directory(); defer { try? FileManager.default.removeItem(at: directory) }
        let diagnostics = AnalysisDiagnostics(directory: directory)
        var service = service(); service.diagnostics = diagnostics
        defer { service.session.invalidateAndCancel() }
        do { _ = try await service.submit(draft()); XCTFail("Fixture should fail") }
        catch ProductContributionError.unavailable { }
        diagnostics.record(stage: "product_contribution", outcome: "failed", metadata: [
            "route": "contribution_status", "elapsedMs": 10, "requestSent": false,
            "id": "private identifier", "barcode": "private barcode", "name": "private product",
            "country": "private country", "store": "private store", "photos": "private photo data"])
        let data = try diagnostics.exportData()
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(text.contains("private")); XCTAssertFalse(text.contains("test-token"))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try XCTUnwrap(document["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 3)
        let failed = try XCTUnwrap(events[1]["metadata"] as? [String: Any])
        XCTAssertEqual(failed["route"] as? String, "contribution_submit")
        XCTAssertEqual(failed["httpStatus"] as? Int, 503)
        XCTAssertEqual(failed["requestSent"] as? Bool, true)
        XCTAssertEqual(Set(failed.keys), ["route", "httpStatus", "requestSent", "elapsedMs"])
        XCTAssertTrue(AnalysisDiagnostics.safeMetadata(["route": "contribution/private-id", "elapsedMs": 600001, "requestSent": "yes"]).isEmpty)
    }

    func testCancelledRequestStaysCancelled() async throws {
        ContributionFixtureProtocol.state.reset(mode: .hang)
        let service = service(); defer { service.session.invalidateAndCancel() }
        let record = draft()
        let task = Task { try await service.submit(record) }
        try await Task.sleep(nanoseconds: 20_000_000)
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancel must propagate") }
        catch is CancellationError { }
    }
}

private final class ContributionFixtureProtocol: URLProtocol {
    enum Mode { case success, fail, wrongIdentity, limited, hang, deleted }
    struct Receipt { let method: String; let body: Data; let authorization: String? }
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Mode = .success
        private var values: [Receipt] = []
        var mode: Mode {
            get { lock.lock(); defer { lock.unlock() }; return value }
            set { lock.lock(); value = newValue; lock.unlock() }
        }
        var requests: [Receipt] { lock.lock(); defer { lock.unlock() }; return values }
        func reset(mode: Mode = .success) { lock.lock(); value = mode; values = []; lock.unlock() }
        func append(_ request: Receipt) { lock.lock(); values.append(request); lock.unlock() }
    }
    static let state = State()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let method = request.httpMethod ?? "GET", mode = Self.state.mode
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 8192); defer { buffer.deallocate() }
            while stream.hasBytesAvailable {
                let count = stream.read(buffer, maxLength: 8192)
                if count <= 0 { break }; body.append(buffer, count: count)
            }
        }
        Self.state.append(.init(method: method, body: body, authorization: request.value(forHTTPHeaderField: "Authorization")))
        if mode == .hang { return }
        let statusCode = mode == .fail ? 503 : mode == .limited ? 429 : mode == .deleted ? 410 : 200
        let response = HTTPURLResponse(url: request.url!, statusCode: statusCode, httpVersion: nil, headerFields: ["Content-Type": "application/json", "Retry-After": "120"])!
        var result: [String: Any]
        let payload = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        if method == "GET", request.url!.lastPathComponent == "product-contributions" { result = ["contributions": []] }
        else if method == "DELETE" { result = ["deleted": true, "id": request.url!.lastPathComponent] }
        else {
            let date = Int64(Date().timeIntervalSince1970 * 1000)
            result = ["contribution": [
                "id": mode == .wrongIdentity ? UUID().uuidString : payload["id"] as? String ?? request.url!.lastPathComponent,
                "barcode": payload["barcode"] as? String ?? "5060003830306", "status": "pending_review",
                "createdAt": date, "updatedAt": date, "expiresAt": date + 30 * 86_400_000,
                "attempts": 1, "nextRetryAt": NSNull(), "missingPhotoRoles": [], "sourceLookup": "not_found",
                "message": "Waiting for review.", "canRetry": false, "canDelete": true
            ], "replayed": false]
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: result)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

private actor ContributionRevisionFence {
    private var checks = 0
    func check() -> Bool { checks += 1; return checks == 1 }
}
