import Foundation
import CryptoKit

enum NativeCaptureStatus: String, Codable, Sendable {
    case draft, queued, processing, complete, retryableFailure, needsUserInput, deleted
}

/// Fixed recovery categories only. Provider prose and food content never become
/// persisted error codes or technical diagnostics.
enum NativeCaptureRecoveryReason: String {
    case subjectUncertain = "subject_uncertain"
    case subjectUnidentified = "subject_unidentified"
    case subjectTypeMismatch = "subject_type_mismatch"
    case identityConflict = "identity_conflict"

    var errorCode: String { "photo_" + rawValue }
    init?(errorCode: String?) {
        guard let errorCode, errorCode.hasPrefix("photo_") else { return nil }
        self.init(rawValue: String(errorCode.dropFirst(6)))
    }
    static func from(response: [String: Any]) -> Self? {
        if let raw = response["recoveryReason"] as? String, let reason = Self(rawValue: raw) { return reason }
        // Older adapters report normalization enums but no recovery field.
        let issues = response["diagnosticEnums"] as? [String] ?? []
        if let reason = [Self.subjectUncertain, .subjectUnidentified, .subjectTypeMismatch].first(where: { issues.contains($0.rawValue) }) {
            return reason
        }
        // The ordinary service keeps these same fixed categories in its trace.
        // Only a rejected observation may use them; never copy provider prose
        // or turn a successfully recovered meal into an input failure.
        guard (response["extraction"] as? [String: Any])?["type"] as? String == "unknown",
              let trace = response["trace"] as? [String: Any] else { return nil }
        let backendIssues = trace["normalizationIssues"] as? [String] ?? []
        if let reason = [Self.subjectUncertain, .subjectUnidentified, .subjectTypeMismatch].first(where: { backendIssues.contains($0.rawValue) }) {
            return reason
        }
        switch trace["subjectStatus"] as? String {
        case "uncertain": return .subjectUncertain
        case "unidentified": return .subjectUnidentified
        case "type_mismatch": return .subjectTypeMismatch
        default: return nil
        }
    }
    var message: String {
        switch self {
        case .subjectUncertain:
            return "Choose one meal or product. Keep only its photos, or take a closer photo, then tap Analyse."
        case .subjectUnidentified:
            return "The food could not be identified. Try a clearer photo, then tap Analyse. Your photos are saved."
        case .subjectTypeMismatch:
            return "These photos could not be matched to one food. Keep photos of the same meal or product, then tap Analyse."
        case .identityConflict:
            return "These photos may show different products. Keep one product’s photos, then tap Analyse."
        }
    }
}

/// User-confirmed meal ingredients supplement photo evidence; they never assert
/// an ingredient quantity. Only the overall portion is specified.
struct NativeMealAnalysisHints: Codable, Equatable, Sendable {
    struct Portion: Codable, Equatable, Sendable {
        var amount: Double
        var unit: String
    }
    var ingredients: [String]
    var portion: Portion? = nil
    var isValid: Bool {
        guard (1...40).contains(ingredients.count), Set(ingredients).count == ingredients.count,
              ingredients.allSatisfy({ (1...80).contains($0.count) && $0 == $0.trimmingCharacters(in: .whitespacesAndNewlines) && $0.rangeOfCharacter(from: .controlCharacters) == nil }) else { return false }
        guard let portion else { return true }
        return portion.amount.isFinite && (1...10_000).contains(portion.amount) && ["g", "ml"].contains(portion.unit)
    }
}

/// Private input and retry state. Tokens never enter this record or History.
struct NativeCaptureRecord: Codable, Sendable {
    var id = UUID()
    var submissionID = UUID()
    var eventID: String
    let ownerKey: String
    var createdAt = Date()
    var updatedAt = Date()
    var barcode: String?
    var photoIDs: [String] = []
    var captureRevision = 0
    var photoFiles: [String] = []
    var voiceFile: String?
    var voiceDuration: Double?
    var thumbnail = ""
    var status: NativeCaptureStatus = .draft
    var attempts = 0
    var nextAttemptAt: Date?
    var serverRetryAt: Date?
    var errorCode: String?
    var remoteAccepted = false
    var manualRetryRequested = false
    var repairContext: Data?
    var mealHints: NativeMealAnalysisHints?
    // Nil keeps every existing job on its original Nudge service route.
    var chatGPTBinding: ChatGPTCaptureBinding?
    // Additive opt-in: retained jobs keep the policy with which they were sent.
    var fastCaptureVersion: Int?
    // New submissions can freeze optional image preparation. Nil preserves old wire inputs.
    var cloudPreparationVersion: Int?
    // Once set, a missing prepared-input sidecar is an error, never a retry fallback.
    var cloudPreparedSubmissionID: UUID?
    var analysisStartedAt: Date?
    var localAnalysis: Bool?
    var hasValidAnalysisRoute: Bool {
        guard let binding = chatGPTBinding else { return true }
        return binding.isValid && barcode == nil && voiceFile == nil && !remoteAccepted && !manualRetryRequested
    }
    // Optional for existing manifests. Intake is an explicit, durable user choice.
    var addToEaten: Bool?
    var diaryAddState: String?
    var loggingDay: String?
    var loggingMeal: String?
    var photoReferences: [String]?
    var historyGeneration: Int?
    var revokedEventID: String?
    var deletionAcknowledged: Bool?

    init(eventID: String, ownerKey: String) {
        self.eventID = eventID; self.ownerKey = ownerKey; self.submissionID = id
    }

    var historyStatus: String {
        switch status {
        case .complete: return "ready"
        case .needsUserInput: return "unknown"
        case .retryableFailure: return "failed"
        default: return "pending"
        }
    }
    var message: String {
        switch status {
        case .draft: return "Saved — ready to analyse"
        case .queued: return remoteAccepted ? (analysisStartedAt.map { Date().timeIntervalSince($0) >= 5 } == true ? "Still analysing — your photos are saved." : "Analysing…") : "Queued for analysis"
        case .processing: return analysisStartedAt.map { Date().timeIntervalSince($0) >= 5 } == true ? "Still analysing — your photos are saved." : "Analysing…"
        case .retryableFailure:
            if chatGPTBinding != nil {
                switch errorCode {
                case "chatgpt_account": return "Reconnect the original ChatGPT account in You, then tap Retry. Your photos are saved."
                case "chatgpt_limit": return "Your ChatGPT allowance is unavailable. Check usage in You, then tap Retry when ready."
                case "chatgpt_model": return "Choose a compatible camera model for the same ChatGPT account in You, then tap Retry."
                case "chatgpt_result": return "ChatGPT did not return usable food evidence. Your photos are saved; tap Retry to try again."
                default: return "ChatGPT analysis was interrupted or unavailable. Your photos are saved. Tap Retry to use your plan again."
                }
            }
            return "Saved — tap Retry now to finish"
        case .needsUserInput:
            return NativeCaptureRecoveryReason(errorCode: errorCode)?.message ?? "Saved — more information needed"
        case .complete, .deleted: return ""
        }
    }
}

/// Immutable media files are committed before the atomic manifest. Interrupted
/// writes leave the last good manifest usable; pending originals never expire.
@MainActor
final class NativeCaptureOutbox {
    enum Failure: Error { case invalidRecord, storageFull, missingOriginal }
    static let maximumBytes = 200_000_000
    let directory: URL
    private let byteBudget: Int
    private struct CachedManifest {
        let size: Int
        let modified: Date?
        let inode: UInt64
        let record: NativeCaptureRecord
    }
    private var preparingCloudInputs: Set<UUID> = []
    private var reservedPreparationBytes = 0
    private var decodedManifests: [URL: CachedManifest] = [:]
    private func readManifest(_ file: URL, owner: String) throws -> NativeCaptureRecord {
        // Atomic replacement changes the inode, even if a quick update has the
        // same size/date. Other outbox instances remain visible to this cache.
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        let size = (attributes[.size] as? NSNumber)?.intValue ?? Int.max
        let modified = attributes[.modificationDate] as? Date
        let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
        guard size <= 1_000_000 else { throw Failure.invalidRecord }
        if let cached = decodedManifests[file], inode != 0, cached.inode == inode, cached.size == size, cached.modified == modified {
            return cached.record
        }
        let record = try JSONDecoder().decode(NativeCaptureRecord.self, from: Data(contentsOf: file))
        guard record.ownerKey == owner, file.deletingPathExtension().lastPathComponent == record.id.uuidString.lowercased(),
              record.eventID.count <= 120, record.photoFiles.count <= 4, record.mealHints?.isValid != false, record.hasValidAnalysisRoute,
              record.cloudPreparedSubmissionID == nil || record.cloudPreparedSubmissionID == record.submissionID else { throw Failure.invalidRecord }
        decodedManifests[file] = CachedManifest(size: size, modified: modified, inode: inode, record: record)
        return record
    }
    init(directory: URL, maximumBytes: Int = 200_000_000) { self.directory = directory; self.byteBudget = maximumBytes }

    private func folder(_ owner: String) throws -> URL {
        guard owner == "local-guest" || owner.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw Failure.invalidRecord }
        return directory.appendingPathComponent(owner, isDirectory: true)
    }
    private func manifest(_ record: NativeCaptureRecord) throws -> URL {
        try folder(record.ownerKey).appendingPathComponent(record.id.uuidString.lowercased() + ".json")
    }
    private func ownerTombstone(_ owner: String) throws -> URL {
        _ = try folder(owner)
        return directory.appendingPathComponent("deleted-owner-" + owner)
    }
    func foodTextCacheDirectory(owner: String) throws -> URL {
        guard !FileManager.default.fileExists(atPath: try ownerTombstone(owner).path) else { throw Failure.invalidRecord }
        return try folder(owner).appendingPathComponent("FoodTextCache-v1", isDirectory: true)
    }
    func records(owner: String) throws -> [NativeCaptureRecord] {
        let location = try folder(owner)
        if FileManager.default.fileExists(atPath: try ownerTombstone(owner).path) {
            if FileManager.default.fileExists(atPath: location.path) { try FileManager.default.removeItem(at: location) }
            return []
        }
        guard FileManager.default.fileExists(atPath: location.path) else { return [] }
        let files = try FileManager.default.contentsOfDirectory(at: location, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        let present = Set(files)
        decodedManifests = decodedManifests.filter { $0.key.deletingLastPathComponent() != location || present.contains($0.key) }
        return try files.map { try readManifest($0, owner: owner) }.sorted { $0.createdAt < $1.createdAt }
    }
    func record(eventID: String, owner: String) throws -> NativeCaptureRecord? {
        try records(owner: owner).first { $0.eventID == eventID }
    }
    @discardableResult
    func save(_ input: NativeCaptureRecord, images: [Data]? = nil, voiceMemo: VoiceMemoPayload? = nil) throws -> NativeCaptureRecord {
        var record = input
        if images != nil { record.voiceFile = nil; record.voiceDuration = nil }
        guard !record.eventID.isEmpty, record.eventID.count <= 120, record.mealHints?.isValid != false, record.hasValidAnalysisRoute,
              record.chatGPTBinding == nil || voiceMemo == nil else { throw Failure.invalidRecord }
        let location = try folder(record.ownerKey)
        guard !FileManager.default.fileExists(atPath: try ownerTombstone(record.ownerKey).path) else { throw Failure.invalidRecord }
        let recordFile = try manifest(record)
        let old = FileManager.default.fileExists(atPath: recordFile.path) ? try readManifest(recordFile, owner: record.ownerKey) : nil
        if let images, !images.isEmpty || voiceMemo != nil {
            let additional = images.reduce(0, { $0 + $1.count }) + (voiceMemo?.audioData.count ?? 0) + 1_000_000
            var used = 0
            if let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
                for case let file as URL in files {
                    let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                    if values.isRegularFile == true { used += values.fileSize ?? 0 }
                }
            }
            guard used + additional + reservedPreparationBytes <= byteBudget else { throw Failure.storageFull }
        }
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var backup = URLResourceValues(); backup.isExcludedFromBackup = true
        var root = directory; try root.setResourceValues(backup)
        var written: [URL] = []
        do {
            if let images {
                guard images.count <= 4, images.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }),
                      images.reduce(0, { $0 + $1.count }) <= 6_000_000, record.photoIDs.count == images.count else { throw Failure.invalidRecord }
                record.photoFiles = []
                for data in images {
                    let name = UUID().uuidString.lowercased() + ".jpg", file = location.appendingPathComponent(name)
                    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    written.append(file); record.photoFiles.append(name)
                }
                record.voiceFile = nil; record.voiceDuration = nil
                if let voiceMemo {
                    let name = UUID().uuidString.lowercased() + ".m4a", file = location.appendingPathComponent(name)
                    try voiceMemo.audioData.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    written.append(file); record.voiceFile = name; record.voiceDuration = voiceMemo.durationSeconds
                }
            }
            guard record.hasValidAnalysisRoute else { throw Failure.invalidRecord }
            if let old {
                let sameInput = old.submissionID == record.submissionID && old.captureRevision == record.captureRevision &&
                    old.photoIDs == record.photoIDs && old.photoFiles == record.photoFiles
                if !sameInput { record.cloudPreparedSubmissionID = nil }
                else if old.cloudPreparedSubmissionID == old.submissionID {
                    // Coordinator status updates can hold a pre-freeze value.
                    record.cloudPreparedSubmissionID = old.cloudPreparedSubmissionID
                }
            } else {
                // Undo creates a new capture by copying the retained record.
                record.cloudPreparedSubmissionID = nil
            }
            guard record.cloudPreparedSubmissionID == nil || record.cloudPreparedSubmissionID == record.submissionID else { throw Failure.invalidRecord }
            record.updatedAt = Date()
            let bytes = try JSONEncoder().encode(record)
            guard bytes.count <= 1_000_000 else { throw Failure.invalidRecord }
            try bytes.write(to: recordFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            for file in written { try? FileManager.default.removeItem(at: file) }
            throw error
        }
        decodedManifests.removeValue(forKey: recordFile)
        // Only media replaced by an acknowledged manifest can be removed.
        if let old {
            let retained = Set(record.photoFiles + [record.voiceFile].compactMap { $0 })
            for name in old.photoFiles + [old.voiceFile].compactMap({ $0 }) where !retained.contains(name) {
                if let file = try? media(name, owner: old.ownerKey) { try? FileManager.default.removeItem(at: file) }
            }
        }
        if record.status == .deleted || old.map({ $0.submissionID != record.submissionID || $0.captureRevision != record.captureRevision || $0.photoIDs != record.photoIDs || $0.photoFiles != record.photoFiles }) == true {
            try? purgePreparedCloudImages(for: record)
        }
        return record
    }
    private func media(_ name: String, owner: String) throws -> URL {
        guard name.range(of: "^[a-f0-9-]{36}\\.(jpg|m4a)$", options: .regularExpression) != nil else { throw Failure.invalidRecord }
        return try folder(owner).appendingPathComponent(name)
    }
    func images(for record: NativeCaptureRecord) throws -> [Data] {
        try record.photoFiles.map { name in
            let file = try media(name, owner: record.ownerKey)
            guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 1_500_000 else { throw Failure.missingOriginal }
            return try Data(contentsOf: file)
        }
    }
    func voiceMemo(for record: NativeCaptureRecord) throws -> VoiceMemoPayload? {
        guard let name = record.voiceFile else { return nil }
        let file = try media(name, owner: record.ownerKey)
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= VoiceMemoPayload.maximumBytes,
              let duration = record.voiceDuration, let memo = VoiceMemoPayload(audioData: try Data(contentsOf: file), durationSeconds: duration) else { throw Failure.missingOriginal }
        return memo
    }
    /// Reads the immutable originals away from the UI actor. Callers must
    /// recheck the submission/owner token after awaiting this snapshot.
    func analysisInput(for record: NativeCaptureRecord) async throws -> (images: [Data], voiceMemo: VoiceMemoPayload?) {
        let photos = try record.photoFiles.map { try media($0, owner: record.ownerKey) }
        let voice = try record.voiceFile.map { try media($0, owner: record.ownerKey) }
        let voiceLimit = VoiceMemoPayload.maximumBytes
        let input = try await Task.detached(priority: .userInitiated) {
            let images = try photos.map { file in
                guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 1_500_000 else { throw Failure.missingOriginal }
                return try Data(contentsOf: file)
            }
            let audio = try voice.map { file in
                guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= voiceLimit else { throw Failure.missingOriginal }
                return try Data(contentsOf: file)
            }
            return (images, audio)
        }.value
        let memo: VoiceMemoPayload?
        if let audio = input.1 {
            guard let duration = record.voiceDuration, let value = VoiceMemoPayload(audioData: audio, durationSeconds: duration) else { throw Failure.missingOriginal }
            memo = value
        } else { memo = nil }
        return (input.0, memo)
    }
    private struct PreparedCloudImages: Codable, Sendable {
        struct Image: Codable, Sendable {
            let originalFile: String
            let originalSHA256: String
            let preparedFile: String?
            let preparedSHA256: String
        }
        let version: Int
        let ownerKey: String
        let captureID: UUID
        let submissionID: UUID
        let captureRevision: Int
        let photoIDs: [String]
        let images: [Image]
    }
    nonisolated private static func imageDigest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    nonisolated private static func diskBytes(at directory: URL) throws -> Int {
        var used = 0
        if let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in files {
                let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                if values.isRegularFile == true { used += values.fileSize ?? 0 }
            }
        }
        return used
    }
    private func preparedCloudDirectory(for record: NativeCaptureRecord) throws -> URL {
        try folder(record.ownerKey).appendingPathComponent("PreparedCloud-v1", isDirectory: true)
            .appendingPathComponent(record.id.uuidString.lowercased(), isDirectory: true)
    }
    private func purgePreparedCloudImages(for record: NativeCaptureRecord) throws {
        let location = try preparedCloudDirectory(for: record)
        if FileManager.default.fileExists(atPath: location.path) { try FileManager.default.removeItem(at: location) }
    }
    @discardableResult
    private func requireCurrentCloudInput(_ input: NativeCaptureRecord) throws -> NativeCaptureRecord {
        guard !Task.isCancelled, !FileManager.default.fileExists(atPath: try ownerTombstone(input.ownerKey).path),
              let current = try record(eventID: input.eventID, owner: input.ownerKey), current.id == input.id,
              current.status != .deleted, current.submissionID == input.submissionID,
              current.captureRevision == input.captureRevision, current.photoIDs == input.photoIDs,
              current.photoFiles == input.photoFiles, current.voiceFile == input.voiceFile else { throw Failure.invalidRecord }
        return current
    }
    private func cloudSnapshot(for record: NativeCaptureRecord) throws -> PreparedCloudImages? {
        let current = try requireCurrentCloudInput(record)
        let required = current.cloudPreparedSubmissionID == record.submissionID
        let file = try preparedCloudDirectory(for: record).appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: file.path) else {
            guard !required else { throw Failure.missingOriginal }
            return nil
        }
        guard let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 16_384 else { throw Failure.invalidRecord }
        let snapshot = try JSONDecoder().decode(PreparedCloudImages.self, from: Data(contentsOf: file))
        guard snapshot.version == 1, snapshot.ownerKey == record.ownerKey, snapshot.captureID == record.id else { throw Failure.invalidRecord }
        // A new explicit submission has a new identity. A same-submission
        // mismatch is corruption, never permission to change its wire bytes.
        guard snapshot.submissionID == record.submissionID else {
            guard !required else { throw Failure.invalidRecord }
            return nil
        }
        guard snapshot.captureRevision == record.captureRevision, snapshot.photoIDs == record.photoIDs,
              snapshot.images.map(\.originalFile) == record.photoFiles, (1...4).contains(snapshot.images.count),
              snapshot.images.allSatisfy({ image in
                  image.originalSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
                  image.preparedSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
                  (image.preparedFile == nil || image.preparedFile!.range(of: "^[a-f0-9-]{36}\\.jpg$", options: .regularExpression) != nil)
              }) else { throw Failure.invalidRecord }
        return snapshot
    }
    private func markCloudPreparation(for record: NativeCaptureRecord) throws {
        var current = try requireCurrentCloudInput(record)
        if current.cloudPreparedSubmissionID == current.submissionID { return }
        current.cloudPreparedSubmissionID = current.submissionID
        _ = try save(current)
    }
    /// An already-dispatched submission must reuse byte-identical image input.
    /// A damaged snapshot fails closed; it never falls back to different bytes.
    func preparedCloudImages(for record: NativeCaptureRecord) async throws -> [Data]? {
        try requireCurrentCloudInput(record)
        guard let snapshot = try cloudSnapshot(for: record) else { return nil }
        let location = try preparedCloudDirectory(for: record)
        let sources = try snapshot.images.map { try media($0.originalFile, owner: record.ownerKey) }
        let result = try await Task.detached(priority: .userInitiated) {
            func read(_ file: URL) throws -> Data {
                guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 1_500_000 else { throw Failure.missingOriginal }
                let bytes = try Data(contentsOf: file)
                guard !bytes.isEmpty, bytes.count <= 1_500_000 else { throw Failure.missingOriginal }
                return bytes
            }
            return try zip(snapshot.images, sources).map { image, source in
                let original = try read(source)
                guard Self.imageDigest(original) == image.originalSHA256 else { throw Failure.missingOriginal }
                let bytes = try image.preparedFile.map { try read(location.appendingPathComponent($0)) } ?? original
                guard Self.imageDigest(bytes) == image.preparedSHA256 else { throw Failure.missingOriginal }
                return bytes
            }
        }.value
        try markCloudPreparation(for: record)
        return result
    }
    /// Freeze the first selected cloud input before any dispatch. Originals are
    /// referenced without copying; only changed JPEGs consume additional space.
    /// No worker recreates directories, so deletion during IO cannot resurrect
    /// an owner or a capture. The atomic sidecar is committed after the last fence.
    func freezeCloudImages(for record: NativeCaptureRecord, images: [Data]) async throws -> [Data] {
        if let frozen = try await preparedCloudImages(for: record) { return frozen }
        try requireCurrentCloudInput(record)
        guard (1...4).contains(images.count), images.count == record.photoIDs.count, images.count == record.photoFiles.count,
              images.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }), images.reduce(0, { $0 + $1.count }) <= 6_000_000,
              preparingCloudInputs.insert(record.id).inserted else { throw Failure.invalidRecord }
        // Reserve a bounded worst case before another capture can begin IO.
        // Unchanged photos are still references in the committed snapshot.
        let reservation = images.reduce(16_384) { $0 + $1.count }
        reservedPreparationBytes += reservation
        let competingReservations = reservedPreparationBytes - reservation
        defer { preparingCloudInputs.remove(record.id); reservedPreparationBytes -= reservation }
        let location = try preparedCloudDirectory(for: record)
        let sources = try record.photoFiles.map { try media($0, owner: record.ownerKey) }
        let root = directory, budget = byteBudget
        // Create before awaiting; a late writer only opens this existing path.
        try FileManager.default.createDirectory(at: location, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let entries = try await Task.detached(priority: .userInitiated) {
            var written: [URL] = []
            do {
                var entries: [PreparedCloudImages.Image] = [], additional = 16_384
                let originals = try sources.map { file -> Data in
                    guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0, size <= 1_500_000 else { throw Failure.missingOriginal }
                    let bytes = try Data(contentsOf: file)
                    guard !bytes.isEmpty, bytes.count <= 1_500_000 else { throw Failure.missingOriginal }
                    return bytes
                }
                for (original, prepared) in zip(originals, images) where original != prepared { additional += prepared.count }
                let used = try Self.diskBytes(at: root)
                guard used + additional + competingReservations <= budget else { throw Failure.storageFull }
                for index in images.indices {
                    let original = originals[index], prepared = images[index]
                    guard prepared.count <= original.count else { throw Failure.invalidRecord }
                    let name = original == prepared ? nil : UUID().uuidString.lowercased() + ".jpg"
                    if let name {
                        let file = location.appendingPathComponent(name)
                        try prepared.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); written.append(file)
                    }
                    entries.append(.init(originalFile: record.photoFiles[index], originalSHA256: Self.imageDigest(original),
                        preparedFile: name, preparedSHA256: Self.imageDigest(prepared)))
                }
                return entries
            } catch {
                for file in written { try? FileManager.default.removeItem(at: file) }
                throw error
            }
        }.value
        var committed = false
        defer {
            if !committed {
                for image in entries { if let name = image.preparedFile { try? FileManager.default.removeItem(at: location.appendingPathComponent(name)) } }
            }
        }
        try requireCurrentCloudInput(record)
        // Another outbox instance may have committed while the worker ran.
        if try cloudSnapshot(for: record) != nil {
            guard let existing = try await preparedCloudImages(for: record) else { throw Failure.invalidRecord }
            return existing
        }
        let snapshot = PreparedCloudImages(version: 1, ownerKey: record.ownerKey, captureID: record.id, submissionID: record.submissionID,
            captureRevision: record.captureRevision, photoIDs: record.photoIDs, images: entries)
        let bytes = try JSONEncoder().encode(snapshot)
        guard bytes.count <= 16_384 else { throw Failure.invalidRecord }
        try bytes.write(to: location.appendingPathComponent("manifest.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        committed = true
        try markCloudPreparation(for: record)
        return images
    }

    /// Explicit History retry can claim a local-only guest draft. Account-owned
    /// captures are never moved, and the source survives a failed destination write.
    func adoptGuest(_ input: NativeCaptureRecord, owner: String) throws -> NativeCaptureRecord {
        guard input.ownerKey == "local-guest", owner != "local-guest", !input.remoteAccepted,
              input.status != .deleted, input.status != .complete else { throw Failure.invalidRecord }
        _ = try folder(owner)
        if let existing = try record(eventID: input.eventID, owner: owner) {
            guard existing.id == input.id else { throw Failure.invalidRecord }
            try remove(input)
            return existing
        }
        var adopted = NativeCaptureRecord(eventID: input.eventID, ownerKey: owner)
        adopted.id = input.id; adopted.submissionID = UUID()
        adopted.createdAt = input.createdAt; adopted.barcode = input.barcode
        adopted.photoIDs = input.photoIDs; adopted.captureRevision = input.captureRevision
        adopted.chatGPTBinding = input.chatGPTBinding; adopted.fastCaptureVersion = input.fastCaptureVersion; adopted.analysisStartedAt = input.analysisStartedAt
        adopted.localAnalysis = input.localAnalysis
        adopted.thumbnail = input.thumbnail; adopted.repairContext = input.repairContext; adopted.mealHints = input.mealHints
        adopted.addToEaten = input.addToEaten; adopted.diaryAddState = input.diaryAddState
        adopted.loggingDay = input.loggingDay; adopted.loggingMeal = input.loggingMeal
        adopted.photoReferences = input.photoReferences; adopted.historyGeneration = input.historyGeneration
        adopted.status = input.status; adopted.errorCode = input.errorCode
        adopted.attempts = 0; adopted.remoteAccepted = false; adopted.manualRetryRequested = false
        adopted.nextAttemptAt = nil; adopted.serverRetryAt = nil
        let saved = try save(adopted, images: input.barcode == nil ? images(for: input) : nil, voiceMemo: voiceMemo(for: input))
        try remove(input)
        return saved
    }
    func remove(_ record: NativeCaptureRecord) throws {
        // Delete the manifest first: leftover media can never revive a capture.
        let file = try manifest(record)
        try FileManager.default.removeItem(at: file)
        decodedManifests.removeValue(forKey: file)
        try? purgePreparedCloudImages(for: record)
        for name in record.photoFiles + [record.voiceFile].compactMap({ $0 }) {
            if let file = try? media(name, owner: record.ownerKey) { try? FileManager.default.removeItem(at: file) }
        }
    }
    /// Called only after confirmed account deletion. The marker prevents late
    /// callbacks from recreating this owner's files; no other partition is touched.
    func removeOwner(_ owner: String) throws {
        guard owner != "local-guest" else { throw Failure.invalidRecord }
        let location = try folder(owner)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try Data("deleted".utf8).write(to: ownerTombstone(owner), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if FileManager.default.fileExists(atPath: location.path) { try FileManager.default.removeItem(at: location) }
        decodedManifests = decodedManifests.filter { $0.value.record.ownerKey != owner }
    }
    static func retryDate(at date: Date, attempt: Int, retryAfter: TimeInterval? = nil, jitter: Double = Double.random(in: 0.75...1.25)) -> Date {
        let delay = min(3600.0, 5 * pow(2, Double(max(0, min(attempt - 1, 10))))) * max(0.75, min(1.25, jitter))
        return date.addingTimeInterval(max(delay, retryAfter ?? 0))
    }
}
