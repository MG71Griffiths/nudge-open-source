import AVFoundation
import CryptoKit
import ImageIO
import PhotosUI
import SwiftUI
import UIKit

struct NativeProductContributionContext: Identifiable {
    let id = UUID()
    let barcode: String
    var productName: String? = nil
    var countryCode: String? = nil
    var store: ProductSearchStore? = nil
    var isCorrection: Bool = false
}

enum ProductCorrectionField: String, Codable, CaseIterable, Identifiable {
    case identity, nutrition, ingredients, allergens, category
    var id: String { rawValue }
    var title: String {
        switch self {
        case .identity: "Name or brand"
        case .nutrition: "Nutrition values"
        case .ingredients: "Ingredients"
        case .allergens: "Allergen wording"
        case .category: "Food category"
        }
    }
}

struct ProductCorrection: Codable, Equatable {
    var fields: [ProductCorrectionField] = []
    var note: String = ""
    var valid: Bool {
        fields.count <= 5 && Set(fields).count == fields.count && note.unicodeScalars.count <= 600 && note.utf8.count <= 1200
        && note.range(of: #"[\x00-\x08\x0b\x0c\x0e-\x1f<>]"#, options: .regularExpression) == nil
        && (!fields.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}

enum ProductContributionPhotoRole: String, Codable, CaseIterable, Identifiable {
    case front, nutrition, ingredients
    var id: String { rawValue }
    var title: String {
        switch self { case .front: "Pack front"; case .nutrition: "Nutrition label"; case .ingredients: "Ingredients" }
    }
    var guidance: String {
        switch self {
        case .front: "Show the name, brand and pack size."
        case .nutrition: "Include the complete table and its per 100 g, per 100 ml or serving heading."
        case .ingredients: "Include the complete ingredients and allergen information."
        }
    }
}

struct ProductContributionPhoto: Codable, Equatable, Identifiable {
    let role: ProductContributionPhotoRole
    let data: Data
    var id: String { role.rawValue }
    static let maximumBytes = 750_000

    /// Thumbnail decoding bounds memory; drawing a fresh JPEG removes EXIF,
    /// location and other source metadata before a contribution can be saved.
    @MainActor static func prepare(_ input: Data) throws -> Data {
        guard input.count <= 20_000_000,
              let source = CGImageSourceCreateWithData(input as CFData, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1800,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary),
              let jpeg = NutritionLabelPickerController.resizedJPEG(from: UIImage(cgImage: cgImage), maximumBytes: maximumBytes, maxDimension: 1800) else {
            throw ProductContributionError.photoInvalid
        }
        return jpeg
    }
}

enum ProductContributionPhase: String, Codable {
    case queued, processing, pendingReview = "pending_review", needsPhotos = "needs_photos"
    case retryableError = "retryable_error", published, rejected
    var title: String {
        switch self {
        case .queued: "Waiting to be checked"
        case .processing: "Reading product information"
        case .pendingReview: "Waiting for review"
        case .needsPhotos: "More information needed"
        case .retryableError: "Ready to try again"
        case .published: "Added to the shared catalogue"
        case .rejected: "Not added to the catalogue"
        }
    }
}

struct ProductContributionStatus: Codable, Equatable, Identifiable {
    let id: UUID
    let barcode: String
    let status: ProductContributionPhase
    let createdAt: Int64
    let updatedAt: Int64
    let expiresAt: Int64
    let attempts: Int
    let nextRetryAt: Int64?
    let missingPhotoRoles: [ProductContributionPhotoRole]
    let sourceLookup: String
    let message: String
    let canRetry: Bool
    let canDelete: Bool
    var correction: ProductCorrection? = nil
    var pointsAwarded: Int? = nil
    var expired: Bool { Double(expiresAt) / 1000 <= Date().timeIntervalSince1970 }
}

struct ProductContributionRecord: Codable, Identifiable {
    let id: UUID
    let ownerKey: String
    let createdAt: Date
    var updatedAt: Date
    var barcode: String
    var productName: String?
    var countryCode: String?
    var storeID: String?
    var photos: [ProductContributionPhoto] = []
    var consented = false
    var submissionAttempted = false
    var remote: ProductContributionStatus? = nil
    var correction: ProductCorrection? = nil

    var isTerminalReceipt: Bool { photos.isEmpty && (remote?.status == .published || remote?.status == .rejected) }
    var editable: Bool { !submissionAttempted && remote == nil }
    var canSubmit: Bool { Self.validBarcode(barcode) && !photos.isEmpty && consented && remote == nil && (correction?.valid ?? true) }
    static func validBarcode(_ value: String) -> Bool { value.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil }
    static func validOwner(_ value: String) -> Bool { value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil }

    func body() throws -> Data {
        guard canSubmit, photos.count <= 3, Set(photos.map(\.role)).count == photos.count,
              photos.allSatisfy({ !$0.data.isEmpty && $0.data.count <= ProductContributionPhoto.maximumBytes
                && $0.data.starts(with: [0xff, 0xd8]) }),
              countryCode.map({ code in Locale.Region.isoRegions.contains { $0.identifier == code } }) ?? true,
              storeID.map({ ProductSearchStore(rawValue: $0) != nil }) ?? true else { throw ProductContributionError.invalidDraft }
        // This allowlist deliberately excludes names, diary facts, voice notes,
        // private meal pictures and account credentials.
        var body: [String: Any] = ["id": id.uuidString.lowercased(), "barcode": barcode,
            "marketCountry": countryCode as Any? ?? NSNull(), "store": storeID as Any? ?? NSNull(),
            "consent": ["version": "product-contribution-v1", "shareProductFacts": true, "retainPhotosForReview": true],
            "photos": photos.map { ["role": $0.role.rawValue, "mimeType": "image/jpeg", "imageBase64": $0.data.base64EncodedString()] }]
        if let correction { body["correction"] = ["fields": correction.fields.map(\.rawValue).sorted(), "note": correction.note] }
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
}

enum ProductContributionError: LocalizedError {
    case invalidDraft, photoInvalid, storage, capacity, accountChanged, signIn, analysisPermissionRequired, unavailable, invalidResponse, notFound, deleted, conflict, retryLater(Int)
    var errorDescription: String? {
        switch self {
        case .invalidDraft: "Add a valid barcode, at least one product photo and your sharing consent."
        case .photoInvalid: "That photo could not be prepared. Try a clearer photo of the pack."
        case .storage: "Nudge could not save this draft. Unlock your phone and try again before closing this screen."
        case .capacity: "Your pending contribution drafts are full. Finish or remove an old draft before adding another."
        case .accountChanged: "Your account changed. Reopen contributions before continuing."
        case .signIn: "Sign in to Nudge before sharing product information."
        case .analysisPermissionRequired: "Allow AI analysis before sending pack photos to Nudge and OpenAI. Your draft stays on this phone."
        case .unavailable: "The contribution service is unavailable. Your saved draft is still on this phone."
        case .invalidResponse: "Nudge could not confirm the response. Check the status or retry the same saved submission."
        case .notFound: "This contribution is no longer on the server. It may have expired or been removed."
        case .deleted: "This submission was removed. Start a new contribution to share new photos."
        case .conflict: "This submission already exists with different details. Start a new contribution for new photos."
        case .retryLater(let seconds): "Please wait \(seconds) seconds before trying again. Your draft is saved."
        }
    }
}

/// Separate protected drafts; no writes to diary/history or public caches.
actor ProductContributionOutbox {
    static let shared = ProductContributionOutbox()
    static let maximumEntries = 12
    static let maximumReceipts = 100
    static let maximumBytes = 40_000_000
    private let directory: URL
    private var removedAt: [String: Date] = [:]
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NudgeProductContributions-v1", isDirectory: true)
    }
    private func folder(_ owner: String) throws -> URL {
        guard ProductContributionRecord.validOwner(owner) else { throw ProductContributionError.accountChanged }
        return directory.appendingPathComponent(owner, isDirectory: true)
    }
    func records(owner: String, now: Date = Date()) throws -> [ProductContributionRecord] {
        let folder = try folder(owner)
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])
            .filter { $0.pathExtension == "json" }
        guard files.count <= Self.maximumEntries + Self.maximumReceipts else { throw ProductContributionError.storage }
        var records: [ProductContributionRecord] = []
        for file in files {
            guard let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 3_100_000,
                  let record = try? JSONDecoder().decode(ProductContributionRecord.self, from: Data(contentsOf: file)),
                  record.ownerKey == owner, record.id.uuidString.lowercased() == file.deletingPathExtension().lastPathComponent else {
                throw ProductContributionError.storage
            }
            if now.timeIntervalSince(record.createdAt) >= 30 * 86_400 { try FileManager.default.removeItem(at: file) }
            else { records.append(record) }
        }
        return records.sorted { $0.updatedAt > $1.updatedAt }
    }
    func save(_ record: ProductContributionRecord) throws {
        let folder = try folder(record.ownerKey)
        let identity = record.ownerKey + ":" + record.id.uuidString
        if let removed = removedAt[identity], record.updatedAt <= removed { return }
        let current = try records(owner: record.ownerKey)
        if let newer = current.first(where: { $0.id == record.id }), newer.updatedAt > record.updatedAt { return }
        let otherPending = current.filter { $0.id != record.id && !$0.isTerminalReceipt }
        guard record.isTerminalReceipt || otherPending.count < Self.maximumEntries else { throw ProductContributionError.capacity }
        let data = try JSONEncoder().encode(record)
        guard data.count <= 3_100_000 else { throw ProductContributionError.capacity }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var location = directory
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        try location.setResourceValues(excluded)
        // Account partitions share one bounded byte budget. Never evict another
        // person's pending contribution just to make room for a new draft.
        let destination = folder.appendingPathComponent(record.id.uuidString.lowercased() + ".json")
        var oldBytes = 0
        if let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in files where file != destination {
                let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                if values.isRegularFile == true { oldBytes += values.fileSize ?? 0 }
                guard oldBytes <= Self.maximumBytes else { throw ProductContributionError.capacity }
            }
        }
        guard oldBytes + data.count <= Self.maximumBytes else { throw ProductContributionError.capacity }
        // Only completed photo-free receipts may be retired. Pending drafts and
        // all unpublished local photos retain the existing 12-slot/40 MB guard.
        let receipts = current.filter { $0.id != record.id && $0.isTerminalReceipt }.sorted { $0.updatedAt < $1.updatedAt }
        if record.isTerminalReceipt && receipts.count >= Self.maximumReceipts {
            for old in receipts.prefix(receipts.count - Self.maximumReceipts + 1) {
                try remove(id: old.id, owner: old.ownerKey)
            }
        }
        try data.write(to: folder.appendingPathComponent(record.id.uuidString.lowercased() + ".json"), options: [.atomic, .completeFileProtection])
    }
    func remove(id: UUID, owner: String) throws {
        let url = try folder(owner).appendingPathComponent(id.uuidString.lowercased() + ".json")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        // UI edits can already be queued when a draft is removed. A stale
        // snapshot must not recreate it after the successful deletion.
        removedAt[owner + ":" + id.uuidString] = Date()
        if removedAt.count > 256 {
            removedAt = Dictionary(uniqueKeysWithValues: removedAt.sorted { $0.value > $1.value }.prefix(256).map { ($0.key, $0.value) })
        }
    }
}

struct ProductContributionService {
    struct Authorization {
        let baseURL: URL
        let token: String
        let ownerKey: String
        var isCurrent: () async -> Bool = { true }
    }
    private struct Envelope: Decodable { let contribution: ProductContributionStatus }
    private struct ListEnvelope: Decodable { let contributions: [ProductContributionStatus] }
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 25; config.timeoutIntervalForResource = 35
        return URLSession(configuration: config)
    }()
    var session: URLSession = Self.session
    var authorization: () async throws -> Authorization = Self.liveAuthorization
    var diagnostics: AnalysisDiagnostics? = .shared
    var analysisAllowed: () -> Bool = { PhotoAnalysisPermission().allowed }

    static func liveAuthorization() async throws -> Authorization {
        let manager = await NudgeAccountManager.shared
        let revision = await manager.revision
        let account = try await manager.authorization()
        let config: BackendConfiguration
        if let account { config = .init(baseURL: account.backendURL, token: account.token) }
        else if let owner = BackendCredentialStore.configuration() { config = owner }
        else { throw ProductContributionError.signIn }
        guard await manager.revision == revision else { throw ProductContributionError.accountChanged }
        let key = try ownerKey(token: config.token, baseURL: config.baseURL)
        return Authorization(baseURL: config.baseURL, token: config.token, ownerKey: key,
            isCurrent: { await manager.revision == revision })
    }
    /// The JWT subject is used only to partition local drafts. Server-side
    /// authentication is still authoritative; a token is never saved here.
    static func accountOwnerKey(userID: String, baseURL: URL) throws -> String {
        guard let uuid = UUID(uuidString: userID) else { throw ProductContributionError.signIn }
        return SHA256.hash(data: Data((baseURL.absoluteString + "|account:" + uuid.uuidString.lowercased()).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func ownerKey(token: String, baseURL: URL) throws -> String {
        let parts = token.split(separator: ".")
        let identity: String
        if parts.count == 3 {
            var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
            guard let bytes = Data(base64Encoded: encoded), bytes.count <= 8192,
                  let payload = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let subject = payload["sub"] as? String else { throw ProductContributionError.signIn }
            return try accountOwnerKey(userID: subject, baseURL: baseURL)
        } else {
            guard BackendConfiguration.validToken(token) else { throw ProductContributionError.signIn }
            identity = "private-owner:" + token
        }
        return SHA256.hash(data: Data((baseURL.absoluteString + "|" + identity).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func submit(_ record: ProductContributionRecord) async throws -> ProductContributionStatus {
        let data = try await request(method: "POST", path: "v1/product-contributions", owner: record.ownerKey, body: record.body())
        return try status(data, matching: record.id, barcode: record.barcode)
    }
    func refresh(_ record: ProductContributionRecord) async throws -> ProductContributionStatus {
        try status(await request(method: "GET", path: path(record.id), owner: record.ownerKey), matching: record.id, barcode: record.barcode)
    }
    func retry(_ record: ProductContributionRecord) async throws -> ProductContributionStatus {
        try status(await request(method: "POST", path: path(record.id) + "/retry", owner: record.ownerKey, body: Data("{}".utf8)), matching: record.id, barcode: record.barcode)
    }
    func list(owner: String) async throws -> [ProductContributionStatus] {
        let data = try await request(method: "GET", path: "v1/product-contributions", owner: owner)
        guard let result = try? JSONDecoder().decode(ListEnvelope.self, from: data), result.contributions.count <= 100,
              result.contributions.allSatisfy(Self.validStatus) else { throw ProductContributionError.invalidResponse }
        return result.contributions
    }
    func delete(_ record: ProductContributionRecord) async throws {
        let data = try await request(method: "DELETE", path: path(record.id), owner: record.ownerKey)
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], body["deleted"] as? Bool == true,
              (body["id"] as? String).flatMap(UUID.init(uuidString:)) == record.id else { throw ProductContributionError.invalidResponse }
    }
    private func path(_ id: UUID) -> String { "v1/product-contributions/" + id.uuidString.lowercased() }
    private func status(_ data: Data, matching id: UUID, barcode: String) throws -> ProductContributionStatus {
        guard let result = try? JSONDecoder().decode(Envelope.self, from: data), result.contribution.id == id,
              result.contribution.barcode == barcode, Self.validStatus(result.contribution) else { throw ProductContributionError.invalidResponse }
        return result.contribution
    }
    static func validStatus(_ value: ProductContributionStatus) -> Bool {
        ProductContributionRecord.validBarcode(value.barcode) && value.createdAt > 0 && value.updatedAt >= value.createdAt
            && value.expiresAt > value.createdAt && value.message.utf8.count <= 1000 && (0...10).contains(value.attempts)
            && value.missingPhotoRoles.count <= 3 && ["found", "found_other_market", "not_found", "unavailable", "not_checked"].contains(value.sourceLookup)
            && (value.correction?.valid ?? true) && (value.pointsAwarded.map { (0...1).contains($0) && value.status == .published } ?? true)
    }
    private func request(method: String, path: String, owner: String, body: Data? = nil) async throws -> Data {
        let began = Date()
        let route = method == "DELETE" ? "contribution_delete" : path.hasSuffix("/retry") ? "contribution_retry"
            : method == "POST" ? "contribution_submit" : path == "v1/product-contributions" ? "contribution_list" : "contribution_status"
        var sent = false, outcome = "failed"
        var httpStatus: Int?
        defer {
            var metadata: [String: Any] = ["route": route, "requestSent": sent,
                "elapsedMs": max(0, Int(Date().timeIntervalSince(began) * 1000))]
            if let httpStatus { metadata["httpStatus"] = httpStatus }
            diagnostics?.record(stage: "product_contribution", outcome: Task.isCancelled ? "cancelled" : outcome, metadata: metadata)
        }
        let needsAnalysis = method == "POST"
        guard !needsAnalysis || analysisAllowed() else { throw ProductContributionError.analysisPermissionRequired }
        let auth = try await authorization()
        guard auth.ownerKey == owner, await auth.isCurrent() else { throw ProductContributionError.accountChanged }
        try Task.checkCancellation()
        guard !needsAnalysis || analysisAllowed() else { throw ProductContributionError.analysisPermissionRequired }
        var request = URLRequest(url: auth.baseURL.appendingPathComponent(path), timeoutInterval: 25)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let response: (Data, HTTPURLResponse)
        sent = true
        diagnostics?.record(stage: "product_contribution", outcome: "started", metadata: ["route": route, "requestSent": true])
        do { response = try await BoundedHTTPData.load(request, session: session, maximumBytes: 200_000) }
        catch is CancellationError { outcome = "cancelled"; throw CancellationError() }
        catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { outcome = "cancelled"; throw CancellationError() }
            throw ProductContributionError.unavailable
        }
        try Task.checkCancellation()
        guard await auth.isCurrent() else { throw ProductContributionError.accountChanged }
        httpStatus = response.1.statusCode
        switch response.1.statusCode {
        case 200, 201, 202: outcome = "completed"; return response.0
        case 401, 403: throw ProductContributionError.signIn
        case 404: throw ProductContributionError.notFound
        case 410: throw ProductContributionError.deleted
        case 409: throw ProductContributionError.conflict
        case 429: throw ProductContributionError.retryLater(OpenFoodFactsService.searchRetryAfter(response.1.value(forHTTPHeaderField: "Retry-After"), at: Date(), fallback: 60))
        case 400, 413, 415, 422: throw ProductContributionError.invalidDraft
        default: throw ProductContributionError.unavailable
        }
    }
}

@MainActor
final class ProductContributionModel: ObservableObject {
    @Published private(set) var current: ProductContributionRecord?
    @Published private(set) var records: [ProductContributionRecord] = []
    @Published private(set) var loading = false
    @Published private(set) var busy = false
    @Published private(set) var submissionRemoved = false
    @Published private(set) var analysisAllowed = false
    @Published var error: String?
    @Published var notice: String?
    private let context: NativeProductContributionContext
    private let service: ProductContributionService
    private let outbox: ProductContributionOutbox
    private var owner: String?

    init(context: NativeProductContributionContext, service: ProductContributionService = .init(), outbox: ProductContributionOutbox = .shared) {
        self.context = context; self.service = service; self.outbox = outbox
        self.analysisAllowed = service.analysisAllowed()
    }
    func refreshPermission() { analysisAllowed = service.analysisAllowed() }
    func allowAnalysis() {
        PhotoAnalysisPermission().allow()
        refreshPermission()
        if analysisAllowed { error = nil }
    }
    func load() async {
        guard !loading, owner == nil else { return }
        loading = true; defer { loading = false }
        do {
            let auth = try await service.authorization()
            guard await auth.isCurrent() else { throw ProductContributionError.accountChanged }
            records = try await outbox.records(owner: auth.ownerKey)
            owner = auth.ownerKey
            current = records.first(where: { $0.barcode == context.barcode && !(context.isCorrection && $0.isTerminalReceipt) }) ?? newDraft(owner: auth.ownerKey)
            // Existing drafts remain usable if the owner-status read is offline.
            if let statuses = try? await service.list(owner: auth.ownerKey) {
                for status in statuses.prefix(ProductContributionOutbox.maximumEntries + ProductContributionOutbox.maximumReceipts) {
                    var record = records.first(where: { $0.id == status.id }) ?? ProductContributionRecord(
                        id: status.id, ownerKey: auth.ownerKey, createdAt: Date(timeIntervalSince1970: Double(status.createdAt) / 1000),
                        updatedAt: Date(), barcode: status.barcode, productName: nil, countryCode: nil, storeID: nil)
                    record.remote = status; record.correction = status.correction ?? record.correction; record.submissionAttempted = true; record.photos = []; record.updatedAt = Date()
                    try? await outbox.save(record)
                }
                records = try await outbox.records(owner: auth.ownerKey)
                if let id = current?.id, let saved = records.first(where: { $0.id == id }) { current = saved }
            }
        } catch {
            if current == nil { owner = nil }
            self.error = error.localizedDescription
        }
    }
    private func newDraft(owner: String, barcode: String? = nil, isCorrection: Bool? = nil) -> ProductContributionRecord {
        var record = ProductContributionRecord(id: UUID(), ownerKey: owner, createdAt: Date(), updatedAt: Date(),
            barcode: barcode ?? context.barcode, productName: context.productName.map { String($0.prefix(160)) },
            countryCode: context.countryCode, storeID: context.store?.rawValue)
        record.correction = (isCorrection ?? context.isCorrection) ? ProductCorrection() : nil
        return record
    }
    func startAnother() {
        guard let owner, !busy else { return }
        current = newDraft(owner: owner, barcode: current?.barcode, isCorrection: current?.correction != nil || current?.remote?.status == .published || context.isCorrection)
        error = nil; notice = nil; submissionRemoved = false
    }
    func select(_ record: ProductContributionRecord) {
        guard !busy, record.ownerKey == owner else { return }
        current = record; error = nil; notice = nil; submissionRemoved = false
    }
    func edit(barcode: String? = nil, country: String?? = nil, store: String?? = nil, consent: Bool? = nil) {
        guard var record = current, record.editable, !busy else { return }
        if let barcode { record.barcode = String(barcode.prefix(18)) }
        if let country { record.countryCode = country; if country != "GB" { record.storeID = nil } }
        if let store { record.storeID = store }
        if let consent { record.consented = consent }
        record.updatedAt = Date(); current = record
        Task { _ = await persist(record) }
    }
    func editCorrection(field: ProductCorrectionField? = nil, selected: Bool = false, note: String? = nil) {
        guard var record = current, record.editable, !busy else { return }
        var correction = record.correction ?? ProductCorrection()
        if let field {
            correction.fields.removeAll { $0 == field }
            if selected { correction.fields.append(field) }
        }
        if let note { correction.note = String(note.prefix(600)) }
        record.correction = correction; record.updatedAt = Date(); current = record
        Task { _ = await persist(record) }
    }
    func addPhoto(_ data: Data, role: ProductContributionPhotoRole, expectedID: UUID? = nil) async {
        guard var record = current, record.editable, !busy, expectedID == nil || record.id == expectedID else { return }
        do {
            let photo = try ProductContributionPhoto.prepare(data)
            record.photos.removeAll { $0.role == role }
            record.photos.append(.init(role: role, data: photo)); record.updatedAt = Date(); current = record
            _ = await persist(record)
        } catch { self.error = error.localizedDescription }
    }
    func removePhoto(_ role: ProductContributionPhotoRole) {
        guard var record = current, record.editable, !busy else { return }
        record.photos.removeAll { $0.role == role }; record.updatedAt = Date(); current = record
        Task { _ = await persist(record) }
    }
    @discardableResult private func persist(_ record: ProductContributionRecord) async -> Bool {
        do {
            if record.photos.isEmpty && record.remote == nil && !record.submissionAttempted && record.correction?.valid != true {
                try await outbox.remove(id: record.id, owner: record.ownerKey)
            } else { try await outbox.save(record) }
            records = try await outbox.records(owner: record.ownerKey)
            return true
        } catch { self.error = (error as? ProductContributionError)?.errorDescription ?? ProductContributionError.storage.errorDescription; return false }
    }
    func send() async {
        guard var record = current, record.canSubmit, !busy else { return }
        refreshPermission()
        guard analysisAllowed else { error = ProductContributionError.analysisPermissionRequired.localizedDescription; return }
        busy = true; error = nil; notice = nil; defer { busy = false }
        // Persist the immutable id and consent before dispatch. A timeout can be
        // retried with the same request, so it cannot create duplicate submissions.
        let wasAttempted = record.submissionAttempted
        record.submissionAttempted = true; record.updatedAt = Date(); current = record
        guard await persist(record) else {
            record.submissionAttempted = wasAttempted; current = record
            return
        }
        do {
            let status = try await service.submit(record)
            await accept(status, original: record)
        }
        catch {
            if case ProductContributionError.deleted = error { submissionRemoved = true }
            refreshPermission()
            self.error = error.localizedDescription
        }
    }
    func refresh() async {
        guard let record = current, record.submissionAttempted, !busy else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let status = try await service.refresh(record)
            await accept(status, original: record)
        }
        catch {
            if case ProductContributionError.deleted = error { submissionRemoved = true }
            refreshPermission()
            self.error = error.localizedDescription
        }
    }
    func retry() async {
        guard let record = current, !busy else { return }
        if record.remote == nil { await send(); return }
        guard record.remote?.canRetry == true else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let status = try await service.retry(record)
            await accept(status, original: record)
        }
        catch {
            if case ProductContributionError.deleted = error { submissionRemoved = true }
            refreshPermission()
            self.error = error.localizedDescription
        }
    }
    private func accept(_ status: ProductContributionStatus, original: ProductContributionRecord) async {
        var record = original
        record.remote = status; record.correction = status.correction ?? record.correction; record.submissionAttempted = true; record.photos = []; record.updatedAt = Date()
        guard await persist(record) else { return }
        current = record; notice = "Submission saved. You can check its progress here."
    }
    func remove() async {
        guard let record = current, !busy, record.remote?.canDelete != false else { return }
        busy = true; error = nil; notice = nil; defer { busy = false }
        do {
            if record.submissionAttempted {
                do { try await service.delete(record) }
                catch ProductContributionError.notFound { /* Already absent or expired. */ }
                catch ProductContributionError.deleted { /* A tombstone already removed it. */ }
            }
            try await outbox.remove(id: record.id, owner: record.ownerKey)
            records = try await outbox.records(owner: record.ownerKey)
            current = newDraft(owner: record.ownerKey, barcode: record.barcode)
            notice = record.submissionAttempted ? "Contribution removed." : "Draft removed."
            submissionRemoved = false
        } catch { self.error = error.localizedDescription }
    }
}

@MainActor
struct NativeProductContributionView: View {
    @StateObject private var model: ProductContributionModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var chosenRole: ProductContributionPhotoRole = .front
    @State private var libraryPresented = false
    @State private var libraryItem: PhotosPickerItem?
    @State private var cameraPresented = false
    @State private var deletePresented = false
    @State private var permissionPresented = false
    init(context: NativeProductContributionContext) {
        _model = StateObject(wrappedValue: ProductContributionModel(context: context))
    }
    private var countries: [String] {
        Locale.Region.isoRegions.map(\.identifier).sorted { countryName($0).localizedCaseInsensitiveCompare(countryName($1)) == .orderedAscending }
    }
    private func countryName(_ code: String) -> String { Locale.current.localizedString(forRegionCode: code) ?? code }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text(model.current?.correction != nil ? "Suggest a correction" : "Help complete this product").font(.largeTitle.bold())
                    Text("Share pack facts for Nudge’s catalogue. They appear for future scans after review; your diary stays unchanged.")
                        .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Text("Join Nudge ambassadors before sending to earn 1 point per useful, reviewed product. Repeat scans don’t earn points.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    if model.loading { ProgressView("Opening your drafts…") }
                    if let error = model.error { Text(error).foregroundStyle(Color(uiColor: NudgeTheme.warningText)).accessibilityIdentifier("contribution-error") }
                    if let notice = model.notice { Text(notice).foregroundStyle(Color(uiColor: NudgeTheme.plantText)) }
                    if !model.analysisAllowed {
                        Text("AI analysis is off. Nudge uses OpenAI to read the pack photos you choose for this contribution.")
                            .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        Button("Review AI permission") { permissionPresented = true }
                            .buttonStyle(NudgeButtonStyle(variant: .secondary))
                    }
                    if let record = model.current {
                        if record.editable { form(record) } else { status(record) }
                    } else if !model.loading {
                        Button("Try again") { Task { await model.load() } }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                    }
                    if !model.records.isEmpty {
                        Divider()
                        Text("Your contributions").font(.title2.bold())
                        ForEach(model.records) { record in
                            Button { model.select(record) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(record.productName ?? record.barcode).font(.headline)
                                        Text(record.remote?.status.title ?? (record.submissionAttempted ? "Submission awaiting confirmation" : "Saved draft")).font(.caption)
                                    }
                                    Spacer(); Image(systemName: "chevron.right")
                                }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 16))
                            }.buttonStyle(.plain).disabled(model.busy)
                        }
                    }
                }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: NudgeTheme.canvas)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .tint(Color(uiColor: NudgeTheme.accent))
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await model.load() }
            .onChange(of: scenePhase) { if $0 == .active { model.refreshPermission() } }
            .alert(PhotoAnalysisPermission.title, isPresented: $permissionPresented) {
                Button("Not now", role: .cancel) { }
                Button(PhotoAnalysisPermission.allowTitle) { model.allowAnalysis() }
            } message: { Text(PhotoAnalysisPermission.explanation) }
            .photosPicker(isPresented: $libraryPresented, selection: $libraryItem, matching: .images)
            .onChange(of: libraryItem) { item in
                let role = chosenRole, recordID = model.current?.id
                Task {
                    do {
                        guard let data = try await item?.loadTransferable(type: Data.self) else { return }
                        await model.addPhoto(data, role: role, expectedID: recordID)
                    } catch { model.error = ProductContributionError.photoInvalid.localizedDescription }
                    libraryItem = nil
                }
            }
            .sheet(isPresented: $cameraPresented) {
                ContributionCamera { data in
                    let role = chosenRole
                    cameraPresented = false
                    if let data { Task { await model.addPhoto(data, role: role) } }
                }.ignoresSafeArea()
            }
            .confirmationDialog("Remove this contribution?", isPresented: $deletePresented, titleVisibility: .visible) {
                Button("Remove contribution", role: .destructive) { Task { await model.remove() } }
            } message: { Text("An unsubmitted draft is removed from this phone. A pending shared contribution and its photos are also removed from Nudge.") }
        }.accessibilityIdentifier("native-product-contribution")
    }
    private func form(_ record: ProductContributionRecord) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if let name = record.productName { Text(name).font(.headline) }
            if let correction = record.correction {
                Text("What needs correcting?").font(.headline)
                ForEach(ProductCorrectionField.allCases) { field in
                    Toggle(field.title, isOn: Binding(get: { model.current?.correction?.fields.contains(field) == true }, set: { model.editCorrection(field: field, selected: $0) }))
                        .accessibilityIdentifier("contribution-correction-" + field.rawValue)
                }
                TextField("e.g. The pack says 8.2 g protein per 100 g", text: Binding(get: { model.current?.correction?.note ?? "" }, set: { model.editCorrection(note: $0) }), axis: .vertical)
                    .lineLimit(2...5).textFieldStyle(.roundedBorder).accessibilityIdentifier("contribution-correction-note")
                Text("Optional · Product facts only, up to 600 characters. Add clear pack photos to support the correction.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                if correction.note.utf8.count > 1200 || correction.note.unicodeScalars.count > 600 { Text("Please shorten the note.").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.warningText)) }
            } else {
                Button("Something is wrong? Suggest a correction") { model.editCorrection() }
                    .font(.subheadline).accessibilityIdentifier("contribution-start-correction")
            }
            TextField("Barcode", text: Binding(get: { model.current?.barcode ?? "" }, set: { model.edit(barcode: $0) }))
                .keyboardType(.numberPad).textFieldStyle(.roundedBorder).accessibilityIdentifier("contribution-barcode")
            Picker("Found in", selection: Binding(get: { model.current?.countryCode ?? "" }, set: { model.edit(country: .some($0.isEmpty ? nil : $0)) })) {
                Text("Country (optional)").tag("")
                ForEach(countries, id: \.self) { Text(countryName($0)).tag($0) }
            }
            Picker("Store", selection: Binding(get: { model.current?.storeID ?? "" }, set: { model.edit(store: .some($0.isEmpty ? nil : $0)) })) {
                Text("Store (optional)").tag("")
                ForEach(ProductSearchStore.allCases) { Text($0.title).tag($0.rawValue) }
            }
            ForEach(ProductContributionPhotoRole.allCases) { role in photoCard(role, record: record) }
            Toggle("Send these pack photos and proposed product facts for review", isOn: Binding(get: { model.current?.consented == true }, set: { model.edit(consent: $0) }))
                .accessibilityIdentifier("contribution-consent")
            Text("Only share pack photos you took or have permission to use. Keep people, receipts and personal details out of the frame. You keep your rights and allow Nudge to use the selected photos for this review.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Text("Nudge sends the selected pack photos to OpenAI to read the label. Your correction note is for Nudge’s reviewer. Photos and notes stay private for up to 30 days. Approved facts may appear in Nudge’s shared catalogue; this does not edit Open Food Facts. Your diary, voice notes and other photos are not included.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Text("Drafts stay on this phone for up to 30 days. Only tap Send for review when the photos show the product information you want to share.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Button("Send for review") { Task { await model.send() } }.buttonStyle(NudgeButtonStyle())
                .disabled(!record.canSubmit || !model.analysisAllowed || model.busy).accessibilityIdentifier("contribution-send")
            if !record.photos.isEmpty || record.correction?.valid == true { Button("Delete draft", role: .destructive) { deletePresented = true }.disabled(model.busy) }
        }.disabled(model.busy)
    }
    private func photoCard(_ role: ProductContributionPhotoRole, record: ProductContributionRecord) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(role.title).font(.headline)
            Text(role.guidance).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            if let photo = record.photos.first(where: { $0.role == role }), let image = UIImage(data: photo.data) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 170).clipShape(RoundedRectangle(cornerRadius: 12))
                Button("Remove photo") { model.removePhoto(role) }
            }
            HStack {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Take photo") {
                        chosenRole = role
                        Task {
                            let status = AVCaptureDevice.authorizationStatus(for: .video)
                            let allowed = status == .notDetermined ? await AVCaptureDevice.requestAccess(for: .video) : status == .authorized
                            if allowed { cameraPresented = true }
                            else { model.error = "Camera access is off. Choose a photo or enable camera access for Nudge in Settings." }
                        }
                    }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                Button("Choose photo") { chosenRole = role; libraryPresented = true }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary))
            }
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
    }
    private func status(_ record: ProductContributionRecord) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(record.productName ?? record.barcode).font(.headline)
            if model.busy { ProgressView("Saving your contribution…") }
            if let status = record.remote {
                Text(status.expired && status.status != .published ? "Retention period ended" : status.status.title).font(.title2.bold())
                Text(status.message).font(.subheadline)
                if let correction = status.correction ?? record.correction {
                    if !correction.fields.isEmpty { Text(correction.fields.map(\.title).joined(separator: " · ")).font(.subheadline) }
                    if !correction.note.isEmpty { Text(correction.note).font(.subheadline).textSelection(.enabled) }
                }
                if status.status == .published {
                    if let points = status.pointsAwarded {
                        Label(points == 1 ? "1 ambassador point earned" : "No ambassador point added", systemImage: points == 1 ? "star.fill" : "info.circle")
                            .font(.headline).foregroundStyle(Color(uiColor: NudgeTheme.plantText))
                        if points == 0 { Text("Points require joining before submission and useful new facts. Each product earns you at most one point.").font(.caption) }
                    }
                    Button("Suggest another correction") { model.startAnother() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                if status.sourceLookup == "found_other_market" {
                    Text("Existing product information lists a different country. The review will check the pack you shared.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                if !status.missingPhotoRoles.isEmpty { Text("Useful photos: " + status.missingPhotoRoles.map(\.title).joined(separator: ", ")).font(.subheadline) }
                if status.canRetry { Button("Retry checking") { Task { await model.retry() } }.buttonStyle(NudgeButtonStyle()) }
                Button("Check status") { Task { await model.refresh() } }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                if status.status == .needsPhotos || status.status == .rejected { Button("Add new photos in a new contribution") { model.startAnother() }.buttonStyle(NudgeButtonStyle(variant: .secondary)) }
                if status.canDelete { Button("Remove contribution", role: .destructive) { deletePresented = true } }
            } else {
                if model.submissionRemoved {
                    Text("Submission removed").font(.title2.bold())
                    Button("Start a new contribution") { model.startAnother() }.buttonStyle(NudgeButtonStyle())
                } else {
                    Text("Submission awaiting confirmation").font(.title2.bold())
                    Text("Your draft is saved. Retrying uses the same submission, so it cannot create a duplicate.")
                    Button("Retry sending") { Task { await model.retry() } }.buttonStyle(NudgeButtonStyle())
                    Button("Check status") { Task { await model.refresh() } }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                Button("Remove contribution", role: .destructive) { deletePresented = true }
            }
        }.disabled(model.busy)
    }
}

private struct ContributionCamera: UIViewControllerRepresentable {
    let completion: (Data?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let camera = UIImagePickerController(); camera.sourceType = .camera
        camera.mediaTypes = ["public.image"]; camera.delegate = context.coordinator
        return camera
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) { }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (Data?) -> Void
        init(completion: @escaping (Data?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let data = (info[.originalImage] as? UIImage).flatMap {
                NutritionLabelPickerController.resizedJPEG(from: $0, maximumBytes: ProductContributionPhoto.maximumBytes, maxDimension: 1800)
            }
            completion(data)
        }
    }
}
