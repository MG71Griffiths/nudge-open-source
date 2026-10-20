import Foundation
import Vision
import ImageIO

enum FoodOCRFailure: Error { case invalidInput, unavailable, timeout, outputLimit }

/// Owns cancellation independently of the worker. A timed-out Vision call may
/// unwind later, but cannot hold the caller open or publish a second result.
final class FoodOCRRequestControl: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var cancelRequest: (@Sendable () -> Void)?
    func check() throws {
        lock.lock(); let cancelled = stopped; lock.unlock()
        if cancelled { throw CancellationError() }
    }
    func install(_ cancel: @escaping @Sendable () -> Void) throws {
        lock.lock()
        if stopped { lock.unlock(); cancel(); throw CancellationError() }
        cancelRequest = cancel; lock.unlock()
    }
    func clear() { lock.lock(); cancelRequest = nil; lock.unlock() }
    func cancel() {
        lock.lock(); stopped = true; let action = cancelRequest; cancelRequest = nil; lock.unlock()
        action?()
    }
}

enum VisionFoodTextRecognizer {
    private static let queue = DispatchQueue(label: "com.nudge.food-text", qos: .userInitiated, attributes: .concurrent)
    typealias Worker = @Sendable ([Data], [String], FoodOCRRequestControl) throws -> [FoodOCRPage]

    static func recognize(images: [Data], photoIDs: [String], timeout: TimeInterval = 2.0) async throws -> FoodOCRResult {
        try await recognize(images: images, photoIDs: photoIDs, timeout: timeout) { images, photoIDs, control in
            try perform(images: images, photoIDs: photoIDs, control: control)
        }
    }

    /// Worker injection exercises the production cancellation and timeout path
    /// without cameras, real photos, credentials or remote services.
    static func recognize(images: [Data], photoIDs: [String], timeout: TimeInterval, worker: @escaping Worker) async throws -> FoodOCRResult {
        guard (1...4).contains(images.count), images.count == photoIDs.count, Set(photoIDs).count == photoIDs.count,
              photoIDs.allSatisfy({ $0.range(of: #"^[A-Za-z0-9._-]{1,160}$"#, options: .regularExpression) != nil }),
              images.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }), images.reduce(0, { $0 + $1.count }) <= 6_000_000,
              timeout.isFinite, (0.01...5).contains(timeout) else { throw FoodOCRFailure.invalidInput }
        let job = Job()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard job.start(continuation) else { return }
                let timer = DispatchWorkItem { job.finish(.failure(FoodOCRFailure.timeout), cancel: true) }
                job.setTimer(timer)
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout, execute: timer)
                queue.async {
                    do {
                        try job.control.check()
                        let pages = try worker(images, photoIDs, job.control)
                        try job.control.check()
                        guard FoodOCRLimits.valid(pages), pages.map(\.photoID) == photoIDs,
                              pages.map(\.photoIndex) == Array(1...images.count) else { throw FoodOCRFailure.outputLimit }
                        job.finish(.success(FoodOCRResult(pages: pages, elapsedMilliseconds: job.elapsedMilliseconds)))
                    } catch { job.finish(.failure(error)) }
                }
            }
        } onCancel: { job.finish(.failure(CancellationError()), cancel: true) }
    }

    private final class Job: @unchecked Sendable {
        let control = FoodOCRRequestControl()
        private let began = DispatchTime.now().uptimeNanoseconds
        private let lock = NSLock()
        private var completion: CheckedContinuation<FoodOCRResult, Error>?
        private var settled: Result<FoodOCRResult, Error>?
        private var timer: DispatchWorkItem?
        var elapsedMilliseconds: Int { Int((DispatchTime.now().uptimeNanoseconds - began) / 1_000_000) }
        func start(_ continuation: CheckedContinuation<FoodOCRResult, Error>) -> Bool {
            lock.lock()
            if let settled { lock.unlock(); continuation.resume(with: settled); return false }
            completion = continuation; lock.unlock(); return true
        }
        func setTimer(_ value: DispatchWorkItem) {
            lock.lock()
            if settled != nil { lock.unlock(); value.cancel(); return }
            timer = value; lock.unlock()
        }
        func finish(_ result: Result<FoodOCRResult, Error>, cancel: Bool = false) {
            lock.lock()
            guard settled == nil else { lock.unlock(); return }
            settled = result; let continuation = completion; completion = nil
            let timeout = timer; timer = nil; lock.unlock()
            timeout?.cancel()
            if cancel { control.cancel() }
            continuation?.resume(with: result)
        }
    }

    private static func box(_ rect: CGRect) -> FoodOCRBox {
        FoodOCRBox(x: Double(rect.minX), y: Double(rect.minY), width: Double(rect.width), height: Double(rect.height))
    }
    private static func perform(images: [Data], photoIDs: [String], control: FoodOCRRequestControl) throws -> [FoodOCRPage] {
        var pages: [FoodOCRPage] = [], characters = 0
        let words = try NSRegularExpression(pattern: #"\S+"#)
        for (index, data) in images.enumerated() {
            try control.check()
            let page: FoodOCRPage = try autoreleasepool {
                guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                      CGImageSourceGetCount(source) == 1,
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                      let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                      width.intValue > 0, height.intValue > 0, width.intValue <= 10_000, height.intValue <= 10_000,
                      width.intValue * height.intValue <= 25_000_000 else { throw FoodOCRFailure.invalidInput }
                let orientation = CGImagePropertyOrientation(rawValue: (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1) ?? .up
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = false
                request.recognitionLanguages = ["en-US"]
                request.minimumTextHeight = 0.008
                try control.install { request.cancel() }
                defer { control.clear() }
                try VNImageRequestHandler(data: data, orientation: orientation, options: [:]).perform([request])
                try control.check()
                let observations = request.results ?? []
                guard observations.count <= FoodOCRLimits.maximumLinesPerPage else { throw FoodOCRFailure.outputLimit }
                var lines: [FoodOCRLine] = []
                for (lineIndex, observation) in observations.enumerated() {
                    guard let candidate = observation.topCandidates(1).first else { continue }
                    let text = candidate.string
                    guard !text.isEmpty, text.utf16.count <= 600, text.rangeOfCharacter(from: .controlCharacters) == nil else { throw FoodOCRFailure.outputLimit }
                    characters += text.utf16.count
                    guard characters <= FoodOCRLimits.maximumCharacters else { throw FoodOCRFailure.outputLimit }
                    var tokens: [FoodOCRWord] = []
                    let matches = words.matches(in: text, range: NSRange(location: 0, length: text.utf16.count))
                    guard matches.count <= 100 else { throw FoodOCRFailure.outputLimit }
                    for match in matches {
                        guard let range = Range(match.range, in: text), let rectangle = try candidate.boundingBox(for: range) else { continue }
                        // Accurate recognition supplies word-level guidance boxes.
                        // These locate columns; they are not pixel-accurate crop bounds.
                        tokens.append(FoodOCRWord(text: String(text[range]), start: match.range.location, length: match.range.length, box: box(rectangle.boundingBox)))
                    }
                    lines.append(FoodOCRLine(id: "p\(index + 1)-l\(lineIndex + 1)", text: text, confidence: Double(candidate.confidence), box: box(observation.boundingBox), words: tokens))
                }
                return FoodOCRPage(photoID: photoIDs[index], photoIndex: index + 1, lines: lines)
            }
            pages.append(page)
        }
        return pages
    }
}
