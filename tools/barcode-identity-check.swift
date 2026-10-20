import Foundation

@main struct BarcodeIdentityCheck {
    static func main() {
        var passed = 0
        func check(_ name: String, _ condition: Bool) {
            guard condition else { print("FAIL \(name)"); exit(1) }
            passed += 1; print("PASS \(name)")
        }
        // GS1 General Specifications24.0 §5.2.2.4.1 Figures2–5. These
        // published vectors independently cover all four suppression branches.
        for (compressed, expanded) in [("01234558", "012345000058"), ("04567840", "045670000080"),
                                       ("03456703", "034000005673"), ("09847531", "098400000751")] {
            let identity = "0" + expanded
            check("published UPC-E expands \(compressed)", FoodBarcodeIdentity.decoded(compressed, symbology: .upce) == identity)
            check("UPC-A manual shares EAN13 key \(expanded)", FoodBarcodeIdentity.manual(expanded) == .accepted(identity))
            check("native EAN13 shares UPC-E key", FoodBarcodeIdentity.decoded(identity, symbology: .ean13) == identity)
            check("8digit entry requires explicit symbology", FoodBarcodeIdentity.manual(compressed) == .chooseEightDigitFormat(compressed))
            check("explicit UPC-E manual agrees", FoodBarcodeIdentity.manual(compressed, format: .upce) == .accepted(identity))
            for digit in 0...9 where String(digit) != String(compressed.last!) {
                let bad = String(compressed.dropLast()) + String(digit)
                check("wrong UPC-E check digit rejected", FoodBarcodeIdentity.decoded(bad, symbology: .upce) == nil && FoodBarcodeIdentity.manual(bad, format: .upce) == .invalid)
            }
        }
        // GS1 public check-digit example6291041500213; conventional EAN8,
        // UPC-A and GTIN14 examples exercise alternating parity by length.
        for code in ["6291041500213", "96385074", "036000291452", "10012345000017"] {
            check("valid GTIN \(code)", FoodBarcodeIdentity.validGTIN(code))
            for index in code.indices {
                var bad = code
                bad.replaceSubrange(index...index, with: String((Int(String(code[index]))! + 1) % 10))
                check("single-digit corruption fails checksum", !FoodBarcodeIdentity.validGTIN(bad))
            }
        }
        check("nonzero EAN13 identity unchanged", FoodBarcodeIdentity.decoded("6291041500213", symbology: .ean13) == "6291041500213")
        check("EAN8 identity unchanged", FoodBarcodeIdentity.decoded("96385074", symbology: .ean8) == "96385074")
        check("manual EAN8 explicit", FoodBarcodeIdentity.manual("96385074", format: .ean8) == .accepted("96385074"))
        check("GTIN14 not truncated", FoodBarcodeIdentity.manual("10012345000017") == .accepted("10012345000017"))
        check("printed space separator accepted", FoodBarcodeIdentity.manual("6 291041 500213") == .accepted("6291041500213"))
        for bad in ["", "6291041500214", "6291041500213\n", "６２９１０４１５００２１３", "123", "123456789012345", String(repeating: "1", count: 100), "https://6291041500213", "+6291041500213"] {
            check("invalid manual input rejected", FoodBarcodeIdentity.manual(bad) == .invalid)
        }
        for bad in ["123455", "0123455", "11234555", "01234558\n", "０1234558"] {
            check("UPC-E requires complete GS1 zero-system representation", FoodBarcodeIdentity.decoded(bad, symbology: .upce) == nil)
        }
        check("decoded numeric Code128 keeps existing lookup identity", FoodBarcodeIdentity.decoded("12345", symbology: .code128) == "12345")
        check("Code128 decoder proof cannot be claimed by manual input", FoodBarcodeIdentity.manual("12345") == .invalid)
        for bad in ["123", "1234567890123456789", "12345\n", "ABC123", "１２３４５"] {
            check("Code128 lookup bounds remain enforced", FoodBarcodeIdentity.decoded(bad, symbology: .code128) == nil)
        }
        print("SUMMARY: \(passed) passed, 0 failed; production Foundation helper only, no network/camera")
    }
}
