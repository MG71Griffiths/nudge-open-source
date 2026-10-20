import Foundation
import Darwin
import WebKit

/// Private diary data must not compete with thumbnails for WebKit's localStorage
/// quota. Each key is an atomic file; a successful reply means the write finished.
/// Tombstones distinguish a deliberate reset from a first-run legacy import.
final class NudgeDataStore: @unchecked Sendable {
    static let shared = NudgeDataStore()
    static let keys: Set<String> = ["wmd-nudge-prototype-v1", "nudge-scan-history-v1", "nudge-my-foods-v1", "nudge-food-catalogue-v1"]
    static let maximumValueBytes = 32 * 1024 * 1024
    private let directory: URL
    private let legacyDirectory: URL?
    private let lock = NSLock()
    private struct Record: Codable { let version: Int; let key: String; let value: String? }
    private enum Failure: String, Error { case invalid_request, invalid_json, corrupt_store, storage_limit, native_write }
    private struct FileStamp: Equatable {
        let size: Int
        let modifiedSeconds: Int
        let modifiedNanoseconds: Int
        let changedSeconds: Int
        let changedNanoseconds: Int
        let inode: UInt64
    }
    private struct ValidatedRecord {
        let stamp: FileStamp
        let record: Record
        let bytes: Int
        var access: UInt64
    }
    private var validatedRecords: [String: ValidatedRecord] = [:]
    private var cacheAccess: UInt64 = 0
    private static let validatedByteBudget = 8 * 1024 * 1024

    init(directory: URL? = nil, legacyDirectory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("NudgeData", isDirectory: true)
        self.legacyDirectory = legacyDirectory ?? (directory == nil ? FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("WebKit", isDirectory: true) : nil)
    }

    var captureDirectory: URL { directory.appendingPathComponent("Captures-v1", isDirectory: true) }

    /// Set backup metadata only; never rewrite or remove existing health records.
    /// Custom test stores never touch the production legacy WebKit directory.
    func excludeExistingPrivateDataFromBackup() throws {
        lock.lock(); defer { lock.unlock() }
        for folder in [directory, legacyDirectory].compactMap({ $0 }) {
            if FileManager.default.fileExists(atPath: folder.path) { try excludeFromBackup(folder) }
        }
    }

    private func excludeFromBackup(_ folder: URL) throws {
        var url = folder
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        try excludeFromBackup(directory)
    }

    private func url(_ key: String) -> URL { directory.appendingPathComponent(key + ".json") }

    /// Keep captured images beside private records, outside the JSON size budget.
    /// References contain no absolute container path, so they survive app updates.
    func savePhotos(_ photos: [Data]) throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        guard photos.count <= 4, photos.allSatisfy({ !$0.isEmpty && $0.count <= 20 * 1024 * 1024 }) else { throw Failure.storage_limit }
        guard !photos.isEmpty else { return [] }
        try prepareDirectory()
        let folder = directory.appendingPathComponent("Photos", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var written: [URL] = []
        do {
            for photo in photos {
                let url = folder.appendingPathComponent(UUID().uuidString + ".jpg")
                try photo.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                written.append(url)
            }
            return written.map { "nudge-photo:" + $0.lastPathComponent }
        } catch {
            for url in written { try? FileManager.default.removeItem(at: url) }
            throw error
        }
    }

    func photoData(for reference: String) -> Data? {
        guard reference.hasPrefix("nudge-photo:"), reference.hasSuffix(".jpg") else { return nil }
        let name = String(reference.dropFirst("nudge-photo:".count).dropLast(4))
        guard UUID(uuidString: name) != nil, name.count == 36 else { return nil }
        let file = directory.appendingPathComponent("Photos", isDirectory: true).appendingPathComponent(name + ".jpg")
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 20 * 1024 * 1024 else { return nil }
        return try? Data(contentsOf: file)
    }
    private func read(_ key: String) throws -> Record? {
        guard FileManager.default.fileExists(atPath: url(key).path) else { validatedRecords[key] = nil; return nil }
        let stamp = try fileStamp(key)
        guard stamp.size <= Self.maximumValueBytes * 2 else { validatedRecords[key] = nil; throw Failure.corrupt_store }
        cacheAccess &+= 1
        if var cached = validatedRecords[key], stamp.inode != 0, stamp == cached.stamp {
            cached.access = cacheAccess; validatedRecords[key] = cached
            return cached.record
        }
        // Atomic replacement, in-place editing or changed read permissions all
        // invalidate validation. Never let a warm cache hide a corrupt file.
        validatedRecords[key] = nil
        let data = try Data(contentsOf: url(key))
        guard data.count <= Self.maximumValueBytes * 2,
              let record = try? JSONDecoder().decode(Record.self, from: data),
              record.version == 1, record.key == key else { throw Failure.corrupt_store }
        if let value = record.value {
            guard value.utf8.count <= Self.maximumValueBytes,
                  let json = value.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: json)) is [String: Any] else { throw Failure.corrupt_store }
        }
        if try fileStamp(key) == stamp { remember(record, stamp: stamp) }
        return record
    }

    private func fileStamp(_ key: String) throws -> FileStamp {
        var attributes = stat()
        guard stat(url(key).path, &attributes) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        return FileStamp(size: Int(attributes.st_size),
            modifiedSeconds: attributes.st_mtimespec.tv_sec, modifiedNanoseconds: attributes.st_mtimespec.tv_nsec,
            changedSeconds: attributes.st_ctimespec.tv_sec, changedNanoseconds: attributes.st_ctimespec.tv_nsec,
            inode: attributes.st_ino)
    }
    private func remember(_ record: Record, stamp: FileStamp) {
        let bytes = record.value?.utf8.count ?? 0
        validatedRecords[record.key] = nil
        guard stamp.inode != 0, bytes <= Self.validatedByteBudget else { return }
        cacheAccess &+= 1
        validatedRecords[record.key] = ValidatedRecord(stamp: stamp, record: record, bytes: bytes, access: cacheAccess)
        while validatedRecords.values.reduce(0, { $0 + $1.bytes }) > Self.validatedByteBudget,
              let oldest = validatedRecords.min(by: { $0.value.access < $1.value.access })?.key {
            validatedRecords[oldest] = nil
        }
    }

    func handle(_ request: String) -> String {
        lock.lock(); defer { lock.unlock() }
        var response: [String: Any]
        do {
            guard request.utf8.count <= Self.maximumValueBytes * 2,
                  let data = request.data(using: .utf8),
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let operation = body["operation"] as? String, ["get", "set", "remove", "import"].contains(operation),
                  let key = body["key"] as? String, Self.keys.contains(key) else { throw Failure.invalid_request }
            response = try apply(operation: operation, key: key, suppliedValue: body["value"] as? String)
        } catch {
            response = ["ok": false, "error": (error as? Failure)?.rawValue ?? Failure.native_write.rawValue]
        }
        return reply(response)
    }
    /// JavaScriptCore can pass the existing string directly. Preserve the same
    /// validation and atomic acknowledgement without escaping a second envelope.
    func setValue(_ value: String, for key: String) -> String {
        lock.lock(); defer { lock.unlock() }
        do {
            guard Self.keys.contains(key) else { throw Failure.invalid_request }
            return reply(try apply(operation: "set", key: key, suppliedValue: value))
        } catch {
            return reply(["ok": false, "error": (error as? Failure)?.rawValue ?? Failure.native_write.rawValue])
        }
    }
    private func apply(operation: String, key: String, suppliedValue: String?) throws -> [String: Any] {
        // Do not overwrite an unreadable file, even if the UI has defaults.
        let previous = try read(key)
        if operation == "get" || (operation == "import" && previous != nil) {
            return ["ok": true, "exists": previous != nil, "value": previous?.value as Any? ?? NSNull()]
        }
        var value: String?
        if operation != "remove" {
            guard let text = suppliedValue else { throw Failure.invalid_request }
            guard text.utf8.count <= Self.maximumValueBytes else { throw Failure.storage_limit }
            guard let json = text.data(using: .utf8), (try? JSONSerialization.jsonObject(with: json)) is [String: Any] else { throw Failure.invalid_json }
            value = text
        }
        let record = Record(version: 1, key: key, value: value)
        let bytes = try JSONEncoder().encode(record)
        guard bytes.count <= Self.maximumValueBytes * 2 else { throw Failure.storage_limit }
        try prepareDirectory()
        try bytes.write(to: url(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        validatedRecords[key] = nil
        if let stamp = try? fileStamp(key) { remember(record, stamp: stamp) }
        return ["ok": true, "exists": true, "value": operation == "import" ? (value as Any? ?? NSNull()) : NSNull()]
    }
    private func reply(_ response: [String: Any]) -> String {
        return String(data: (try? JSONSerialization.data(withJSONObject: response)) ?? Data(), encoding: .utf8) ?? "{\"ok\":false,\"error\":\"native_write\"}"
    }
}

/// A reserved prompt is a synchronous RPC from our bundled main frame only.
/// The existing diary transaction rolls back unless persistence is acknowledged;
/// fire-and-forget script messages cannot satisfy that contract.
@MainActor
final class NudgeStorageBridge: NSObject, WKUIDelegate {
    static let marker = "__NUDGE_PRIVATE_STORAGE_V1__"
    private let store: NudgeDataStore
    private let queue = DispatchQueue(label: "com.nudge.private-storage", qos: .userInitiated)
    init(store: NudgeDataStore) { self.store = store }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard prompt == Self.marker, frame.isMainFrame,
              let source = frame.request.url, NudgeWebConfiguration.isLocal(source),
              let current = webView.url, NudgeWebConfiguration.isLocal(current),
              let request = defaultText else { completionHandler(nil); return }
        let store = self.store
        queue.async {
            let reply = store.handle(request)
            DispatchQueue.main.async { completionHandler(reply) }
        }
    }
}
