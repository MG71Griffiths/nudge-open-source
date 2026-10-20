import Foundation

/// Validate the identified symbology before lookup. Existing EAN-13 keys stay
/// unchanged; UPC-A/UPC-E use the implied leading zero emitted by iOS EAN-13.
/// GS1 General Specifications §5.2.2.3–4, §7.9:
/// https://ref.gs1.org/standards/genspecs/24.0.0/
enum FoodBarcodeIdentity {
    enum Symbology { case ean13, ean8, upce, code128 }
    enum ManualFormat { case ean8, upce }
    enum ManualResult: Equatable { case accepted(String), chooseEightDigitFormat(String), invalid }

    static func decoded(_ value: String, symbology: Symbology) -> String? {
        guard asciiDigits(value) else { return nil }
        switch symbology {
        case .ean13: return value.count == 13 && validGTIN(value) ? value : nil
        case .ean8: return value.count == 8 && validGTIN(value) ? value : nil
        case .upce: return expandedUPCE(value).map { "0" + $0 }
        // Code 128's symbol checksum was checked by the native decoder. These
        // existing numeric lookup identifiers are not assumed to be GTINs.
        case .code128: return (4...18).contains(value.count) ? value : nil
        }
    }

    static func manual(_ input: String, format: ManualFormat? = nil) -> ManualResult {
        guard input.utf8.count <= 64, input.utf8.allSatisfy({ (48...57).contains($0) || $0 == 32 || $0 == 45 }) else { return .invalid }
        let code = input.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
        if code.count == 8 {
            guard let format else { return .chooseEightDigitFormat(code) }
            guard let result = decoded(code, symbology: format == .ean8 ? .ean8 : .upce) else { return .invalid }
            return .accepted(result)
        }
        guard format == nil, [12, 13, 14].contains(code.count), validGTIN(code) else { return .invalid }
        return .accepted(code.count == 12 ? "0" + code : code)
    }

    static func validGTIN(_ code: String) -> Bool {
        guard [8, 12, 13, 14].contains(code.utf8.count), asciiDigits(code) else { return false }
        let digits = code.utf8.map { Int($0 - 48) }
        let sum = digits.dropLast().reversed().enumerated().reduce(0) { $0 + $1.element * ($1.offset.isMultiple(of: 2) ? 3 : 1) }
        return (10 - sum % 10) % 10 == digits.last!
    }

    private static func asciiDigits(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 18 && value.utf8.allSatisfy { (48...57).contains($0) }
    }
    private static func expandedUPCE(_ code: String) -> String? {
        // GS1 §5.2.2.4.1 requires D1=0. Require all eight printed digits;
        // never invent a missing number-system or check digit.
        guard code.count == 8, asciiDigits(code), code.first == "0" else { return nil }
        let c = code.map(String.init), payload: String
        switch c[6] {
        case "0", "1", "2": payload = c[0] + c[1] + c[2] + c[6] + "0000" + c[3] + c[4] + c[5] + c[7]
        case "3":
            guard ["3", "4", "5", "6", "7", "8", "9"].contains(c[3]) else { return nil }
            payload = c[0] + c[1] + c[2] + c[3] + "00000" + c[4] + c[5] + c[7]
        case "4":
            guard c[4] != "0" else { return nil }
            payload = c[0] + c[1] + c[2] + c[3] + c[4] + "00000" + c[5] + c[7]
        default:
            guard c[5] != "0" else { return nil }
            payload = c[0] + c[1] + c[2] + c[3] + c[4] + c[5] + "0000" + c[6] + c[7]
        }
        return validGTIN(payload) ? payload : nil
    }
}
