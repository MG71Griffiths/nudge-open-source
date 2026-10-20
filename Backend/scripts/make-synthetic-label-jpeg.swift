// Offline, public test fixture only: deterministic pixels, no user photographs.
// Uses the same Apple ImageIO JPEG encoder family as UIImage.jpegData.
// Usage: swift -module-cache-path <writable-cache> make-synthetic-label-jpeg.swift <output.jpg>
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let width = 2400, height = 1800
precondition(CommandLine.arguments.count == 2, "Supply one output JPEG path")
let destinationURL = URL(fileURLWithPath: CommandLine.arguments[1])
var random: UInt32 = 0x4e554447 // fixed seed (NUDG), not cryptographic/private data
var pixels = [UInt8](repeating: 255, count: width * height * 4)
for y in 0..<height {
    for x in 0..<width {
        let offset = (y * width + x) * 4
        for channel in 0..<3 {
            random ^= random << 13
            random ^= random >> 17
            random ^= random << 5
            pixels[offset + channel] = UInt8(truncatingIfNeeded: random)
        }
    }
}
let data = Data(pixels) as CFData
let provider = CGDataProvider(data: data)!
let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.45,
                                               kCGImagePropertyOrientation: 1] as CFDictionary)
precondition(CGImageDestinationFinalize(destination), "Apple JPEG encoding failed")
let encoded = try Data(contentsOf: destinationURL)
let decoded = CGImageSourceCreateWithData(encoded as CFData, nil)!
let decodedImage = CGImageSourceCreateImageAtIndex(decoded, 0, nil)!
precondition(decodedImage.width == width && decodedImage.height == height, "JPEG dimensions changed")
precondition(encoded.count >= 1_000_000 && encoded.count <= 3_000_000, "Expected a 1–3 MB JPEG, got \(encoded.count) bytes")
print("Synthetic Apple ImageIO JPEG: \(width)×\(height), \(encoded.count) bytes; encoded and decoded locally.")
