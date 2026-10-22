import Foundation

@main
struct NativeMeasurementChecks {
    static var checks = 0
    static func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        checks += 1
        if try !condition() { throw ProfileMeasurementFailure(message: "Check failed: \(message)") }
    }
    static func close(_ value: Double?, _ expected: Double, _ message: String) throws {
        try check(value.map { abs($0 - expected) < 0.000000001 } ?? false, message)
    }
    static func rejects(_ draft: ProfileMeasurementDraft, _ message: String) throws {
        do { _ = try draft.validatedValue() }
        catch let failure as ProfileMeasurementFailure {
            try check(!failure.message.isEmpty, message)
            return
        }
        throw ProfileMeasurementFailure(message: "Expected rejection: \(message)")
    }

    static func main() throws {
        var height = ProfileMeasurementDraft(kind: .height, value: nil, unit: .imperial)
        height.major = "5"; height.minor = "8"
        try close(height.validatedValue(), 172.72, "5 ft 8 in is 172.72 cm")
        height.minor = "8.5"
        try close(height.validatedValue(), 173.99, "Fractional inches")
        height.minor = "8,5"
        try close(height.validatedValue(), 173.99, "Decimal comma inches")
        height.major = " 5 "; height.minor = " 8.5 "
        try close(height.validatedValue(), 173.99, "Trim whitespace")

        var weight = ProfileMeasurementDraft(kind: .weight, value: nil, unit: .imperial)
        weight.major = "10"; weight.minor = "7.5"
        try close(weight.validatedValue(), 66.904874575, "10 st 7.5 lb is 66.904874575 kg")
        weight.minor = "7,5"
        try close(weight.validatedValue(), 66.904874575, "Decimal comma pounds")
        weight.minor = ".5"
        try close(weight.validatedValue(), 63.729727985, "Leading-decimal pounds")

        for kind in [ProfileMeasurementKind.height, .weight] {
            for unknown: Any? in [nil, NSNull(), true, false] {
                var draft = ProfileMeasurementDraft(kind: kind, value: unknown, unit: .metric)
                try check(draft.validatedValue() == nil, "Unknown is not zero")
                try check(draft.selectUnit(.imperial), "Unknown switches units")
                try check(draft.isEmpty && draft.validatedValue() == nil, "Unknown stays empty in imperial")
            }
            for original in [kind.bounds.lowerBound, kind.bounds.upperBound, kind == .height ? 182.123456789 : 74.123456789] {
                var draft = ProfileMeasurementDraft(kind: kind, value: original, unit: .metric)
                for _ in 0..<100 {
                    try check(draft.selectUnit(.imperial), "Switch to imperial")
                    try check(draft.validatedValue() == original, "Exact canonical value after imperial display")
                    try check(draft.selectUnit(.metric), "Switch to metric")
                    try check(draft.validatedValue() == original, "Exact canonical value after round trip")
                }
            }
            for raw in ["NaN", "infinity", "-1", "1e2", "7..5", "7,5,2", "12abc"] {
                var draft = ProfileMeasurementDraft(kind: kind, value: nil, unit: .metric)
                draft.major = raw
                try rejects(draft, "Malformed metric: \(raw)")
                try check(!draft.selectUnit(.imperial), "Invalid text cannot be converted away")
                try check(draft.unit == .metric && draft.major == raw, "Invalid edit is retained")
                try check(draft.validationError != nil, "Unit-switch rejection explains how to fix")
            }
            for raw in [Double.nan, .infinity, -.infinity, 0, kind.bounds.lowerBound - 0.01, kind.bounds.upperBound + 0.01, Double.greatestFiniteMagnitude] {
                let draft = ProfileMeasurementDraft(kind: kind, value: raw, unit: .imperial)
                try rejects(draft, "Invalid numeric source cannot become unknown")
            }
            let whole = kind == .height ? "5" : "10"
            for (major, minor) in [(whole, ""), ("", "2"), (whole + ".5", "2"), (whole, String(Int(kind.partsPerMajor))), (whole, "-1"), (whole, "NaN"), (whole, "1e0")] {
                var draft = ProfileMeasurementDraft(kind: kind, value: nil, unit: .imperial)
                draft.major = major; draft.minor = minor
                try rejects(draft, "Incomplete or invalid imperial input")
                try check(!draft.selectUnit(.metric), "Cannot switch incomplete imperial input")
                try check(draft.unit == .imperial && draft.major == major && draft.minor == minor, "Input retained after failed imperial switch")
            }
            var known = ProfileMeasurementDraft(kind: kind, value: kind.bounds.lowerBound, unit: .imperial)
            known.clear()
            try check(known.isEmpty && known.validatedValue() == nil, "Clear explicitly unsets both imperial fields")
            known.major = "  "; known.minor = "\n"
            try check(known.validatedValue() == nil, "Whitespace means unset")
        }
        var edited = ProfileMeasurementDraft(kind: .height, value: 180, unit: .metric)
        edited.major = "181.234"
        try check(edited.selectUnit(.imperial), "Valid edited metric converts")
        try check(edited.validatedValue() == 181.234, "Edited precision survives conversion")
        edited.major = "6"; edited.minor = "0"
        try close(edited.validatedValue(), 182.88, "Edit converted feet and inches")
        try check(edited.selectUnit(.metric), "Edited imperial converts")
        try close(edited.validatedValue(), 182.88, "Edited imperial retains exact canonical conversion")
        try check(ProfileMeasurementDraft.summary(172.72, kind: .height, unit: .imperial) == "5 ft 8 in", "Height summary uses preference")
        try check(ProfileMeasurementDraft.summary(66.904874575, kind: .weight, unit: .imperial) == "10 st 7.5 lb", "Weight summary uses preference")
        try check(ProfileMeasurementDraft.summary(NSNull(), kind: .weight, unit: .metric) == "Not set", "Unknown summary")
        print("MEASUREMENT_CHECK_RESULT {\"checks\":\(checks),\"groups\":[\"known conversions\",\"fractional and locale input\",\"unknown preservation\",\"exact repeated conversions\",\"bounds and malformed input\",\"partial imperial edits\",\"clear and preferred summary\"]}")
    }
}
