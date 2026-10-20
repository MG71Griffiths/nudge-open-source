import Foundation
import CryptoKit

/// Uptime is used only within this process. Restarted jobs never inherit a
/// fabricated capture-to-display duration from a wall-clock timestamp.
enum CaptureClock {
    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    static func milliseconds(since start: TimeInterval) -> Int {
        max(0, min(600_000, Int((now - start) * 1000)))
    }
}

@MainActor
final class CapturePerformance {
    static let shared = CapturePerformance()
    private struct Attempt {
        let id: UUID
        let started: TimeInterval
        let captureStarted: TimeInterval?
        let captureBasis: String?
        var ready = false
        var complete = false
        var visible = false
    }
    private var attempts: [String: Attempt] = [:]
    func begin(eventID: String, requestID: UUID, startedAt: TimeInterval? = nil,
               captureStartedAt: TimeInterval? = nil, captureBasis: String? = nil) {
        if attempts[eventID]?.id == requestID { return }
        if attempts.count >= 128, let oldest = attempts.min(by: { $0.value.started < $1.value.started })?.key {
            attempts.removeValue(forKey: oldest)
        }
        let started = startedAt ?? CaptureClock.now
        let capture = captureStartedAt.flatMap { $0.isFinite && $0 > 0 && $0 <= started ? $0 : nil }
        attempts[eventID] = Attempt(id: requestID, started: started, captureStarted: capture,
            captureBasis: capture == nil ? nil : captureBasis)
        record(eventID, outcome: "started")
    }
    func record(_ eventID: String, outcome: String, metadata: [String: Any] = [:]) {
        guard let attempt = attempts[eventID] else { return }
        var values = metadata
        values["requestId"] = attempt.id.uuidString
        values["elapsedMs"] = CaptureClock.milliseconds(since: attempt.started)
        values["timingVersion"] = 2
        if let capture = attempt.captureStarted {
            values["captureToResultMs"] = CaptureClock.milliseconds(since: capture)
            values["captureBasis"] = attempt.captureBasis
        }
        // Barcode acquisition starts at accepted decoding, without an Analyse
        // tap. Do not label that duration as a photo Analyse-tap measurement.
        if !["barcode_decode", "barcode_entry"].contains(attempt.captureBasis ?? "") {
            values["analyseToResultMs"] = CaptureClock.milliseconds(since: attempt.started)
        }
        AnalysisDiagnostics.shared.record(stage: "capture_performance", outcome: outcome, metadata: values)
    }
    func ready(eventID: String, complete: Bool, metadata: [String: Any]) {
        guard var attempt = attempts[eventID], !attempt.ready else { return }
        attempt.ready = true; attempt.complete = complete; attempts[eventID] = attempt
        record(eventID, outcome: "result_ready", metadata: metadata.merging(["completeNutrition": complete]) { _, new in new })
    }
    func visible(eventID: String) {
        guard var attempt = attempts[eventID], attempt.ready, !attempt.visible else { return }
        attempt.visible = true; attempts[eventID] = attempt
        record(eventID, outcome: "card_visible", metadata: ["completeNutrition": attempt.complete])
    }
    func isWaiting(_ eventID: String) -> Bool { attempts[eventID].map { !$0.ready } ?? false }
    func forget(_ eventID: String) { attempts.removeValue(forKey: eventID) }
}

/// Only count a nutrition panel when its complete frame is in the clipped
/// scroll viewport. Creating an eager VStack child is not proof of visibility.
enum CaptureResultVisibility {
    static func contains(panel: CGRect, viewport: CGRect) -> Bool {
        let values = [panel.minX, panel.minY, panel.width, panel.height,
                      viewport.minX, viewport.minY, viewport.width, viewport.height]
        guard values.allSatisfy(\.isFinite), panel.width > 0, panel.height > 0,
              viewport.width > 0, viewport.height > 0 else { return false }
        return viewport.insetBy(dx: -0.5, dy: -0.5).contains(panel)
    }
}

/// OCR is an input cache, not a nutrient/diary cache. Every hit is parsed and
/// calculated again against the current composition and parser versions.
/// Exact ordered image bytes + recognizer version identify the input; canonical
/// OCR facts are integrity checked. Photo IDs are rebound only after a match.
enum FoodTextCache {
    static let version = "vision-accurate-en-US-v1"
    private struct Entry: Codable {
        let version: String
        let created: Date
        let factsHash: String
        let pages: [FoodOCRPage]
    }
    static func key(images: [Data]) -> String {
        var digest = SHA256()
        digest.update(data: Data(version.utf8))
        for image in images {
            digest.update(data: Data(":\(image.count):".utf8))
            digest.update(data: image)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private static func encoded(_ pages: [FoodOCRPage]) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return try encoder.encode(pages)
    }
    private static func hash(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    static func load(directory: URL, key: String, photoIDs: [String], now: Date = Date()) -> [FoodOCRPage]? {
        let file = directory.appendingPathComponent(key + ".json")
        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 180_000,
              let data = try? Data(contentsOf: file), let item = try? JSONDecoder().decode(Entry.self, from: data),
              item.version == version, item.created <= now, now.timeIntervalSince(item.created) < 30 * 86_400,
              item.pages.count == photoIDs.count, FoodOCRLimits.valid(item.pages),
              item.pages.map(\.photoIndex) == Array(1...photoIDs.count),
              let facts = try? encoded(item.pages), hash(facts) == item.factsHash else { return nil }
        return item.pages.enumerated().map { index, page in
            FoodOCRPage(photoID: photoIDs[index], photoIndex: index + 1, lines: page.lines)
        }
    }
    static func save(pages: [FoodOCRPage], directory: URL, key: String, now: Date = Date()) {
        guard FoodOCRLimits.valid(pages), pages.contains(where: { !$0.lines.isEmpty }),
              let facts = try? encoded(pages), facts.count <= 160_000 else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var excluded = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
            try excluded.setResourceValues(values)
            let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
            let data = try encoder.encode(Entry(version: version, created: now, factsHash: hash(facts), pages: pages))
            try data.write(to: directory.appendingPathComponent(key + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
                .filter { $0.pathExtension == "json" }
                .sorted { (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast >
                          (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast }
            for file in files.dropFirst(16) { try? FileManager.default.removeItem(at: file) }
        } catch { /* Optional cache failure must not lose a capture. */ }
    }
}
