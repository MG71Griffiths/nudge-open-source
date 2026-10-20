import Foundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// Optional cloud-input preparation only. Saved photos, order and photo IDs
/// remain owned by the capture. OCR alone never authorises removal of context:
/// callers must identify photos from an explicit, known-product label repair.
enum FoodTextImagePreparation {
    struct Result: Sendable {
        let images: [Data]
        let croppedCount: Int
        let originalBytes: Int
        let preparedBytes: Int
        let elapsedMilliseconds: Int
        let timedOut: Bool
    }
    private static let queue = DispatchQueue(label: "com.nudge.label-image-preparation", qos: .userInitiated)
    private static let slots = DispatchSemaphore(value: 2)
    private static func claimSlot() -> Bool { slots.wait(timeout: .now()) == .success }
    typealias Worker = @Sendable ([Data], [FoodOCRPage], Set<String>, FoodOCRRequestControl) throws -> [Data]

    static func prepare(images: [Data], pages: [FoodOCRPage], eligiblePhotoIDs: Set<String> = [], timeout: TimeInterval = 0.75) async -> Result {
        await prepare(images: images, pages: pages, eligiblePhotoIDs: eligiblePhotoIDs, timeout: timeout) { images, pages, eligible, control in
            try perform(images: images, pages: pages, eligiblePhotoIDs: eligible, control: control)
        }
    }

    /// The injected worker is for bounded orchestration checks. Production
    /// decoding, orientation and pixel cropping are exercised separately.
    static func prepare(images: [Data], pages: [FoodOCRPage], eligiblePhotoIDs: Set<String>, timeout: TimeInterval,
                        worker: @escaping Worker) async -> Result {
        let job = Job(images: images)
        guard !Task.isCancelled, !eligiblePhotoIDs.isEmpty,
              (1...4).contains(images.count), images.count == pages.count,
              images.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }), images.reduce(0, { $0 + $1.count }) <= 6_000_000,
              FoodOCRLimits.valid(pages), pages.map(\.photoIndex) == Array(1...images.count),
              eligiblePhotoIDs.isSubset(of: Set(pages.map(\.photoID))),
              timeout.isFinite, (0.01...2).contains(timeout), claimSlot() else { return job.result() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard job.start(continuation) else { slots.signal(); return }
                let timer = DispatchWorkItem { job.finish(nil, timedOut: true, cancel: true) }
                job.setTimer(timer)
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout, execute: timer)
                queue.async {
                    defer { slots.signal() }
                    do {
                        try job.control.check()
                        let prepared = try worker(images, pages, eligiblePhotoIDs, job.control)
                        try job.control.check()
                        guard prepared.count == images.count, zip(prepared, images).allSatisfy({ !$0.0.isEmpty && $0.0.count <= $0.1.count }) else {
                            job.finish(nil); return
                        }
                        job.finish(prepared)
                    } catch { job.finish(nil) }
                }
            }
        } onCancel: { job.finish(nil, cancel: true) }
    }

    private final class Job: @unchecked Sendable {
        let control = FoodOCRRequestControl()
        private let originals: [Data]
        private let began = DispatchTime.now().uptimeNanoseconds
        private let lock = NSLock()
        private var completion: CheckedContinuation<Result, Never>?
        private var settled: Result?
        private var timer: DispatchWorkItem?
        init(images: [Data]) { originals = images }
        func result(_ prepared: [Data]? = nil, timedOut: Bool = false) -> Result {
            let images = prepared ?? originals
            return Result(images: images, croppedCount: zip(images, originals).filter { $0.0 != $0.1 }.count,
                originalBytes: originals.reduce(0) { $0 + $1.count }, preparedBytes: images.reduce(0) { $0 + $1.count },
                elapsedMilliseconds: Int((DispatchTime.now().uptimeNanoseconds - began) / 1_000_000), timedOut: timedOut)
        }
        func start(_ continuation: CheckedContinuation<Result, Never>) -> Bool {
            lock.lock()
            if let settled { lock.unlock(); continuation.resume(returning: settled); return false }
            completion = continuation; lock.unlock(); return true
        }
        func setTimer(_ value: DispatchWorkItem) {
            lock.lock()
            if settled != nil { lock.unlock(); value.cancel(); return }
            timer = value; lock.unlock()
        }
        func finish(_ images: [Data]?, timedOut: Bool = false, cancel: Bool = false) {
            lock.lock()
            guard settled == nil else { lock.unlock(); return }
            let output = result(images, timedOut: timedOut); settled = output
            let continuation = completion; completion = nil; let deadline = timer; timer = nil
            lock.unlock(); deadline?.cancel()
            if cancel { control.cancel() }
            continuation?.resume(returning: output)
        }
    }

    /// Conservative whole-text region, not individual OCR word crop bounds.
    /// The padded union keeps every recognised header, unit and column.
    static func cropRegion(for page: FoodOCRPage) -> FoodOCRBox? {
        guard FoodOCRLimits.valid([FoodOCRPage(photoID: page.photoID, photoIndex: 1, lines: page.lines)]),
              page.lines.count >= 5, page.lines.allSatisfy({ $0.confidence >= 0.9 }) else { return nil }
        func matches(_ pattern: String, _ value: String) -> Bool { value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        let text = page.lines.map(\.text).joined(separator: "\n")
        guard !matches(#"\b(?:serves|makes)\s*:?\s*\d|(?:^|\n)\s*(?:method|instructions|recipe)\b|\btoday['’]?s?\s+(?:total|goal)|\bdaily\s+(?:total|goal)"#, text),
              page.lines.contains(where: { matches(#"\bnutrition(?:al)?\s+(?:information|facts|values)|^\s*nutrition\s*$|\btypical\s+(?:nutritional\s+)?values\b"#, $0.text) }),
              page.lines.contains(where: { matches(#"\bper\s*(?:100\s*(?:g|ml)|serving|portion)\b"#, $0.text) }) else { return nil }
        let fields = [#"^\s*(?:energy|calories)\b"#, #"^\s*(?:total\s+)?fat\b"#, #"^\s*(?:of which\s+)?saturat(?:es|ed)\b"#,
                      #"^\s*(?:total\s+)?carbohydrates?\b"#, #"^\s*(?:of which\s+|total\s+)?sugars?\b"#,
                      #"^\s*(?:dietary\s+)?fib(?:re|er)\b"#, #"^\s*protein\b"#, #"^\s*(?:salt|sodium)\b"#]
        guard fields.filter({ pattern in page.lines.contains { matches(pattern, $0.text) } }).count >= 3 else { return nil }
        let boxes = page.lines.flatMap { [$0.box] + $0.words.map(\.box) }
        guard let first = boxes.first else { return nil }
        let union = boxes.dropFirst().reduce(first) { $0.union($1) }
        let padding = max(0.08, (page.lines.map { $0.box.height }.max() ?? 0) * 2)
        let left = max(0, union.x - padding), bottom = max(0, union.y - padding)
        let right = min(1, union.maxX + padding), top = min(1, union.maxY + padding)
        let region = FoodOCRBox(x: left, y: bottom, width: right - left, height: top - bottom)
        guard region.isValid, region.width * region.height <= 0.85, region.width >= 0.2, region.height >= 0.2 else { return nil }
        return region
    }

    private static func perform(images: [Data], pages: [FoodOCRPage], eligiblePhotoIDs: Set<String>, control: FoodOCRRequestControl) throws -> [Data] {
        var prepared = images
        let context = CIContext(options: [.cacheIntermediates: false])
        for (index, page) in pages.enumerated() {
            try control.check()
            guard eligiblePhotoIDs.contains(page.photoID), let region = cropRegion(for: page) else { continue }
            let candidate: Data? = try autoreleasepool {
                let data = images[index]
                guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                      CGImageSourceGetCount(source) == 1,
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, width <= 10_000, height <= 10_000, width * height <= 25_000_000,
                      let raw = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
                let orientation = (properties[kCGImagePropertyOrientation] as? Int) ?? 1
                guard (1...8).contains(orientation) else { return nil }
                try control.check()
                let oriented = CIImage(cgImage: raw).oriented(forExifOrientation: Int32(orientation)), extent = oriented.extent
                let left = floor(extent.minX + region.x * extent.width), bottom = floor(extent.minY + region.y * extent.height)
                let right = ceil(extent.minX + region.maxX * extent.width), top = ceil(extent.minY + region.maxY * extent.height)
                let pixels = CGRect(x: left, y: bottom, width: right - left, height: top - bottom).intersection(extent)
                guard pixels.width >= 320, pixels.height >= 320,
                      let cropped = context.createCGImage(oriented, from: pixels),
                      cropped.width == Int(pixels.width), cropped.height == Int(pixels.height) else { return nil }
                try control.check()
                let bytes = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
                CGImageDestinationAddImage(destination, cropped, [kCGImageDestinationLossyCompressionQuality: 0.95, kCGImagePropertyOrientation: 1] as [CFString: Any] as CFDictionary)
                guard CGImageDestinationFinalize(destination), bytes.length <= 1_500_000, bytes.length <= Int(Double(data.count) * 0.85) else { return nil }
                try control.check()
                return bytes as Data
            }
            if let candidate { prepared[index] = candidate }
        }
        return prepared
    }
}
