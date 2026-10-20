import Foundation
import UIKit
import ImageIO
import CoreImage
import UniformTypeIdentifiers

private enum FoodImageCheckFailure: Error { case failed(String) }

@main struct FoodTextImageChecks {
    @MainActor static func printedLabel(_ variant: String, textured: Bool = false) -> Data {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let size = CGSize(width: 2200, height: 2200)
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: size))
            if textured {
                var seed: UInt64 = 19
                for y in stride(from: 0, to: 2200, by: 8) {
                    for x in stride(from: 0, to: 2200, by: 8) where x < 220 || x > 1980 || y < 180 || y > 1800 {
                        seed = seed &* 6364136223846793005 &+ 1
                        UIColor(white: CGFloat((seed >> 32) & 255) / 255, alpha: 1).setFill()
                        ctx.fill(CGRect(x: x, y: y, width: 8, height: 8))
                    }
                }
            }
            func text(_ value: String, x: CGFloat, y: CGFloat, bold: Bool = false) {
                let font = bold ? UIFont.boldSystemFont(ofSize: 38) : UIFont.systemFont(ofSize: 38)
                (value as NSString).draw(at: CGPoint(x: x, y: y), withAttributes: [.font: font, .foregroundColor: UIColor.black])
            }
            text("Nutrition information", x: 430, y: 400, bold: true)
            text("Per 100g", x: 1080, y: 500, bold: true)
            text("Per serving", x: 1470, y: 500, bold: true)
            let rows = [("Energy", variant == "sodium" ? "837kJ" : "200kcal", "100kcal"),
                        ("Fat", "10g", "5g"), ("of which saturates", "3g", "1.5g"),
                        ("Carbohydrate", "20g", "10g"), ("of which sugars", "5g", "2.5g"),
                        ("Fibre", "2g", "1g"), ("Protein", "6g", "3g"),
                        (variant == "sodium" ? "Sodium" : "Salt", variant == "sodium" ? "240mg" : variant == "bound" ? "<0,1g" : "0,5g", "0.25g")]
            for (index, row) in rows.enumerated() {
                let y = CGFloat(620 + index * 105)
                text(row.0, x: 430, y: y); text(row.1, x: 1130, y: y); text(row.2, x: 1520, y: y)
            }
        }
        return image.pngData()!
    }

    static func syntheticPage(_ id: String = "label", index: Int = 1, confidence: Double = 0.99, extra: String? = nil) -> FoodOCRPage {
        var texts = ["Nutrition information", "Per 100g Per serving", "Energy 200kcal 100kcal", "Fat 10g 5g", "of which saturates 3g 1.5g", "Carbohydrate 20g 10g", "of which sugars 5g 2.5g", "Fibre 2g 1g", "Protein 6g 3g", "Salt 0.5g 0.25g"]
        if let extra { texts.append(extra) }
        return FoodOCRPage(photoID: id, photoIndex: index, lines: texts.enumerated().map { index, text in
            let top = index == 0 ? 400 : index == 1 ? 500 : 620 + (index - 2) * 105
            return FoodOCRLine(id: "line-\(index)", text: text, confidence: confidence,
                box: FoodOCRBox(x: 430 / 2200, y: 1 - Double(top + 48) / 2200, width: 1300 / 2200, height: 48 / 2200), words: [])
        })
    }

    static func dimensions(_ data: Data) -> (Int, Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return (image.width, image.height)
    }

    static func rotatedInput(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let raw = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let left = CIImage(cgImage: raw).oriented(forExifOrientation: 8), context = CIContext(options: [.cacheIntermediates: false])
        guard let pixels = context.createCGImage(left, from: left.extent) else { return nil }
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, pixels, [kCGImageDestinationLossyCompressionQuality: 0.95, kCGImagePropertyOrientation: 6] as [CFString: Any] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? bytes as Data : nil
    }

    static func pixelDifference(_ first: Data, _ second: Data) -> Double? {
        func pixels(_ data: Data) -> [UInt8]? {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                  let context = CGContext(data: nil, width: 96, height: 96, bitsPerComponent: 8, bytesPerRow: 384,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 96, height: 96))
            guard let buffer = context.data else { return nil }
            return Array(UnsafeBufferPointer(start: buffer.assumingMemoryBound(to: UInt8.self), count: 96 * 96 * 4))
        }
        guard let a = pixels(first), let b = pixels(second) else { return nil }
        return zip(a, b).reduce(0.0) { $0 + abs(Double($1.0) - Double($1.1)) } / Double(a.count)
    }

    @MainActor static func main() async {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        var checks: [String] = [], observations: [[String: Any]] = []
        func expect(_ name: String, _ value: @autoclosure () -> Bool) throws {
            guard value() else { throw FoodImageCheckFailure.failed(name) }; checks.append(name)
        }
        do {
            let page = syntheticPage()
            guard let jpeg = CameraLibraryPhoto.jpeg(from: printedLabel("columns", textured: true)),
                  let region = FoodTextImagePreparation.cropRegion(for: page) else { throw FoodImageCheckFailure.failed("crop fixture setup") }
            let disabled = await FoodTextImagePreparation.prepare(images: [jpeg], pages: [page])
            try expect("crop is disabled without explicit eligible photo ID", disabled.images == [jpeg] && disabled.croppedCount == 0)
            try expect("crop region preserves every header column and row with margin", page.lines.allSatisfy { region.x < $0.box.x && region.y < $0.box.y && region.maxX > $0.box.maxX && region.maxY > $0.box.maxY })
            try expect("low confidence preserves full context", FoodTextImagePreparation.cropRegion(for: syntheticPage(confidence: 0.5)) == nil)
            try expect("recipe context preserves full image", FoodTextImagePreparation.cropRegion(for: syntheticPage(extra: "Serves 4")) == nil)
            let front = FoodOCRPage(photoID: "label", photoIndex: 1, lines: Array(page.lines.prefix(1)))
            try expect("front-only image is never cropped", FoodTextImagePreparation.cropRegion(for: front) == nil)
            let cropped = await FoodTextImagePreparation.prepare(images: [jpeg], pages: [page], eligiblePhotoIDs: ["label"], timeout: 2)
            try expect("eligible text context crop makes meaningful byte saving", cropped.croppedCount == 1 && cropped.preparedBytes <= Int(Double(cropped.originalBytes) * 0.85) && !cropped.timedOut)
            let size = dimensions(cropped.images[0])
            let width = Int(ceil(region.maxX * 2200) - floor(region.x * 2200)), height = Int(ceil(region.maxY * 2200) - floor(region.y * 2200))
            try expect("crop retains native pixel scale without resizing", size?.0 == width && size?.1 == height)
            try jpeg.write(to: directory.appendingPathComponent("context-original.jpg"))
            try cropped.images[0].write(to: directory.appendingPathComponent("context-cropped.jpg"))
            guard let rotated = rotatedInput(jpeg) else { throw FoodImageCheckFailure.failed("EXIF fixture") }
            let oriented = await FoodTextImagePreparation.prepare(images: [rotated], pages: [page], eligiblePhotoIDs: ["label"], timeout: 2)
            try rotated.write(to: directory.appendingPathComponent("context-exif-source.jpg"))
            try oriented.images[0].write(to: directory.appendingPathComponent("context-exif-cropped.jpg"))
            try expect("EXIF rotation preserves upright text geometry", oriented.croppedCount == 1 && dimensions(oriented.images[0])?.0 == width && dimensions(oriented.images[0])?.1 == height && (pixelDifference(cropped.images[0], oriented.images[0]) ?? 255) < 4)
            let noSavings = await FoodTextImagePreparation.prepare(images: [CameraLibraryPhoto.jpeg(from: printedLabel("columns"))!], pages: [page], eligiblePhotoIDs: ["label"], timeout: 2)
            try expect("crop is discarded without meaningful byte savings", noSavings.croppedCount == 0)
            let invalid = FoodOCRPage(photoID: "label", photoIndex: 1, lines: page.lines + [FoodOCRLine(id: "invalid", text: "source", confidence: 1, box: FoodOCRBox(x: -0.1, y: 0.1, width: 0.1, height: 0.1), words: [])])
            try expect("invalid OCR geometry never crops", FoodTextImagePreparation.cropRegion(for: invalid) == nil)
            let mismatch = await FoodTextImagePreparation.prepare(images: [jpeg], pages: [page], eligiblePhotoIDs: ["unknown"])
            try expect("unmatched photo identity preserves original", mismatch.images == [jpeg])
            let many = await FoodTextImagePreparation.prepare(images: Array(repeating: jpeg, count: 5), pages: (0..<5).map { syntheticPage("p\($0)", index: $0 + 1) }, eligiblePhotoIDs: ["p0"])
            try expect("too many images bypass processing unchanged", many.images == Array(repeating: jpeg, count: 5))
            let began = ProcessInfo.processInfo.systemUptime
            let timeout = await FoodTextImagePreparation.prepare(images: [jpeg], pages: [page], eligiblePhotoIDs: ["label"], timeout: 0.02) { _, _, _, _ in
                Thread.sleep(forTimeInterval: 0.2); return [Data([1])]
            }
            try expect("timeout returns originals without waiting for blocked worker", timeout.timedOut && timeout.images == [jpeg] && ProcessInfo.processInfo.systemUptime - began < 0.15)
            try await Task.sleep(nanoseconds: 250_000_000)
            let pending = Task { await FoodTextImagePreparation.prepare(images: [jpeg], pages: [page], eligiblePhotoIDs: ["label"], timeout: 1) { _, _, _, _ in
                Thread.sleep(forTimeInterval: 0.2); return [Data([1])]
            } }
            try await Task.sleep(nanoseconds: 20_000_000)
            let cancelBegan = ProcessInfo.processInfo.systemUptime
            pending.cancel(); let cancelled = await pending.value
            try expect("in-flight cancellation returns originals without waiting for worker", cancelled.images == [jpeg] && !cancelled.timedOut && ProcessInfo.processInfo.systemUptime - cancelBegan < 0.15)
            try await Task.sleep(nanoseconds: 250_000_000)
            let pixelReceipt: [String: Any] = ["passed": true, "checkCount": checks.count, "checks": checks, "originalBytes": cropped.originalBytes, "croppedBytes": cropped.preparedBytes, "cropMs": cropped.elapsedMilliseconds, "EXIFMeanPixelDifference": pixelDifference(cropped.images[0], oriented.images[0]) ?? NSNull(), "actualVisionInvoked": false, "syntheticPrintedImages": true]
            try JSONSerialization.data(withJSONObject: pixelReceipt, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("pixel-receipt.json"))
            if CommandLine.arguments.contains("--pixel-only") { print("Pixel/crop checks passed: \(checks.count)"); return }
            for variant in ["columns", "sodium", "bound"] {
                let original = printedLabel(variant)
                guard let jpeg = CameraLibraryPhoto.jpeg(from: original) else { throw FoodImageCheckFailure.failed("production JPEG encoding") }
                try jpeg.write(to: directory.appendingPathComponent(variant + ".jpg"))
                let result = try await VisionFoodTextRecognizer.recognize(images: [jpeg], photoIDs: [variant], timeout: 5)
                try JSONEncoder().encode(result.pages).write(to: directory.appendingPathComponent(variant + "-ocr.json"))
                guard let label = FoodLocalLabelParser.parse(pages: result.pages) else { throw FoodImageCheckFailure.failed(variant + " actual OCR label parsing") }
                try expect(variant + " retains per100g column", label.basis == "per100g" && label.nutrients["fat"]?.value == 10 && label.nutrients["protein"]?.value == 6)
                switch variant {
                case "sodium":
                    try expect("actual OCR preserves kJ conversion", abs((label.nutrients["energyKcal"]?.value ?? 0) - 837 / 4.184) < 0.00001)
                    try expect("actual OCR preserves sodium mg conversion", abs((label.nutrients["salt"]?.value ?? 0) - 0.6) < 0.00001)
                case "bound": try expect("actual OCR keeps inequality unknown with bound evidence", label.nutrients["salt"]?.value == nil && label.evidence.contains { $0.field == "salt" && $0.boundValue == 0.1 })
                default: try expect("actual OCR preserves decimal comma", label.nutrients["salt"]?.value == 0.5)
                }
                observations.append(["fixture": variant, "jpegBytes": jpeg.count, "ocrMs": result.elapsedMilliseconds])
            }
            let receipt: [String: Any] = ["passed": true, "checks": checks, "checkCount": checks.count, "actualVisionInvoked": true,
                "observations": observations, "limits": ["Synthetic printed images, not held-out food labels or physical-device measurements.", "Production OCR executes with a five-second fixture allowance; this does not establish the app's two-second OCR coverage.", "No owner photos, accounts, network or phone operations."]]
            let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: directory.appendingPathComponent("receipt.json")); print(String(decoding: data, as: UTF8.self))
        } catch { let ns = error as NSError; print("FAIL after \(checks.count) checks: \(error); domain=\(ns.domain) code=\(ns.code) description=\(ns.localizedDescription)"); exit(1) }
    }
}
