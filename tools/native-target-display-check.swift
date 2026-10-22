import Foundation

@main
struct NativeTargetDisplayChecks {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }
    static var checks = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        checks += 1
        if !condition() { throw Failure(description: "Check failed: " + message) }
    }
    static func changed(_ value: [String: Any], _ patch: [String: Any]) -> [String: Any] {
        value.merging(patch, uniquingKeysWith: { _, new in new })
    }

    static func main() throws {
        let nutrients: [(String, Double, String, String)] = [
            ("energy", 2000, "kcal", "reference"), ("protein", 120, "g", "goal"),
            ("fibre", 30, "g", "goal"), ("carbs", 250, "g", "reference"),
            ("fat", 70, "g", "reference"), ("sugars", 90, "g", "reference"),
            ("saturatedFat", 20, "g", "reference"), ("salt", 6, "g", "limit")
        ]
        for (key, target, unit, role) in nutrients {
            let denominator = NativeTrackingDisplay.numberLabel(target, digits: unit == "kcal" ? 0 : 1) + " " + unit
            let unlogged: [String: Any] = ["key": key, "unit": unit, "target": target, "targetKnown": true, "targetRole": role, "value": 0, "recorded": false]
            try check(NativeTrackingDisplay.hasTarget(unlogged), key + ": a saved target exists before logging")
            try check(NativeTrackingDisplay.ratio(unlogged) == nil, key + ": unlogged intake is not zero progress")
            try check(NativeTrackingDisplay.summaryAmount(unlogged) == "— / " + denominator, key + ": known denominator remains visible before logging")
            try check(NativeTrackingDisplay.ringLabel(unlogged) == "—", key + ": no invented percentage before logging")
            try check(NativeTrackingDisplay.note(unlogged) == "No food logged", key + ": unlogged explanation")
            try check(NativeTrackingDisplay.description(unlogged).contains(denominator), key + ": target is announced accessibly")
            let unknown = changed(unlogged, ["recorded": true, "value": NSNull()])
            try check(NativeTrackingDisplay.hasTarget(unknown), key + ": target survives unknown intake")
            try check(NativeTrackingDisplay.summaryAmount(unknown) == "— / " + denominator, key + ": unknown intake retains known denominator")
            try check(NativeTrackingDisplay.ratio(unknown) == nil, key + ": unknown intake has no ratio")
            try check(NativeTrackingDisplay.ringLabel(unknown) == "—", key + ": unknown intake has no percentage")
            try check(NativeTrackingDisplay.note(unknown) == "Nutrition unknown", key + ": unknown explanation")
            let zero = changed(unknown, ["value": 0])
            try check(NativeTrackingDisplay.ratio(zero) == 0, key + ": recorded zero stays known")
            try check(NativeTrackingDisplay.completion(zero) == "0%", key + ": known zero progress")
            try check(NativeTrackingDisplay.summaryAmount(zero) == "0 / " + denominator, key + ": known zero numerator")
            let partial = changed(unknown, ["value": target / 2, "unknown": 1])
            try check(NativeTrackingDisplay.ratio(partial) == 0.5, key + ": partial known subtotal compares correctly")
            try check(NativeTrackingDisplay.completion(partial) == "≥ 50%", key + ": partial result stays qualified")
            try check(NativeTrackingDisplay.note(partial) == "Known total · partial", key + ": partial context")
            let future = changed(zero, ["future": true])
            try check(NativeTrackingDisplay.ratio(future) == nil, key + ": future progress is unavailable")
            try check(NativeTrackingDisplay.summaryAmount(future) == "— / " + denominator, key + ": future comparison keeps known target without intake")
            try check(NativeTrackingDisplay.note(future) == "Upcoming", key + ": future explanation")
        }

        let energy: [String: Any] = ["key": "energy", "title": "Energy", "recorded": true, "value": 300, "unit": "kcal", "target": NSNull(), "targetKnown": true]
        for reason in ["Add activity", "Add activity to estimate energy", "Target left unset", "Use your agreed nutrition plan"] {
            let item = changed(energy, ["targetReason": reason])
            try check(!NativeTrackingDisplay.hasTarget(item), reason + ": no invented target")
            try check(NativeTrackingDisplay.ratio(item) == nil, reason + ": no ratio")
            try check(NativeTrackingDisplay.summaryAmount(item) == "300 kcal", reason + ": recorded amount remains")
            try check(NativeTrackingDisplay.targetLabel(item) == reason, reason + ": target label")
            try check(NativeTrackingDisplay.note(item) == reason, reason + ": explanatory note")
            try check(NativeTrackingDisplay.description(item).contains(reason), reason + ": accessible reason")
        }
        let historical = changed(energy, ["target": 2000, "targetKnown": false, "targetReason": "Historical target not recorded"])
        try check(!NativeTrackingDisplay.hasTarget(historical), "Historical missing target does not use a current value")
        try check(NativeTrackingDisplay.summaryAmount(historical) == "300 kcal", "Historical missing denominator stays absent")
        try check(NativeTrackingDisplay.targetLabel(historical) == "Historical target not recorded", "Historical target reason")
        try check(NativeTrackingDisplay.ratio(historical) == nil, "Historical missing target never divides intake")
        let zeroTarget = changed(energy, ["target": 0, "targetReason": "No percentage for a zero target"])
        try check(!NativeTrackingDisplay.hasTarget(zeroTarget), "Zero target has no usable denominator")
        try check(NativeTrackingDisplay.ratio(zeroTarget) == nil, "No division by zero")
        try check(NativeTrackingDisplay.summaryAmount(zeroTarget) == "300 kcal", "Zero target retains saved amount")
        try check(NativeTrackingDisplay.targetLabel(zeroTarget) == "No percentage for a zero target", "Zero target reason")
        try check(NativeTrackingDisplay.targetLabel(changed(energy, ["targetReason": " \n"])) == "Target not set", "Blank reason uses fallback")

        for (key, target) in [("sugars", 90.0), ("saturatedFat", 20.0)] {
            let at: [String: Any] = ["key": key, "target": target, "value": target, "unit": "g", "recorded": true, "targetRole": "reference"]
            try check(NativeTrackingDisplay.targetRoleLabel(at) == "Reference amount", key + ": reference terminology")
            try check(NativeTrackingDisplay.note(at) == "At reference amount", key + ": no goal-reached praise")
            try check(NativeTrackingDisplay.note(changed(at, ["value": target * 1.2, "unknown": 1])) == "Above reference amount · partial", key + ": above-reference partial semantics")
            try check(NativeTrackingDisplay.note(changed(at, ["value": target * 0.5])) == "Not a goal to reach", key + ": reference is not a target to fill")
        }
        let salt: [String: Any] = ["key": "salt", "target": 6, "value": 12, "unit": "g", "recorded": true, "targetRole": "limit"]
        try check(NativeTrackingDisplay.targetRoleLabel(salt) == "Upper limit", "Salt retains upper-limit role")
        try check(NativeTrackingDisplay.note(salt) == "Above upper limit", "Salt above limit")
        try check(NativeTrackingDisplay.description(salt).contains("Upper limit: 6 g"), "Salt accessible comparison")
        let raw = changed(energy, ["target": 100, "value": 100, "rawValue": 99.95])
        try check(NativeTrackingDisplay.completion(raw) == "99%", "Rounded amount does not announce premature completion")
        for key in ["protein", "carbs", "fat"] {
            let logged: [String: Any] = ["key": key, "unit": "g", "recorded": true, "value": 12.5, "rawValue": 12.5, "target": NSNull(), "targetKnown": true]
            try check(NativeTrackingDisplay.hasLoggedAmount(logged), key + ": amount-only circle is active after logging")
            try check(!NativeTrackingDisplay.hasTarget(logged), key + ": active logged amount does not invent a target")
            try check(NativeTrackingDisplay.ratio(logged) == nil, key + ": active logged amount does not invent a percentage")
            try check(NativeTrackingDisplay.ringLabel(logged) == "12.5g", key + ": known amount remains visible")
            try check(NativeTrackingDisplay.hasLoggedAmount(changed(logged, ["unknown": 1])), key + ": partial known amount is active")
            try check(NativeTrackingDisplay.ringLabel(changed(logged, ["unknown": 1])) == "≥ 12.5g", key + ": partial amount remains qualified")
            try check(NativeTrackingDisplay.hasLoggedAmount(changed(logged, ["value": 0, "rawValue": 0])), key + ": recorded zero differs from no food")
            try check(!NativeTrackingDisplay.hasLoggedAmount(changed(logged, ["recorded": false])), key + ": no colour activation before logging")
            try check(!NativeTrackingDisplay.hasLoggedAmount(changed(logged, ["future": true])), key + ": future data never activates circle")
            try check(!NativeTrackingDisplay.hasLoggedAmount(changed(logged, ["value": NSNull(), "rawValue": NSNull()])), key + ": unknown nutrition never activates circle")
            let withTarget = changed(logged, ["target": 25])
            try check(NativeTrackingDisplay.ratio(withTarget) == 0.5, key + ": actual target restores proportional arc")
            try check(NativeTrackingDisplay.ringLabel(withTarget) == "50%", key + ": actual target restores percentage")
        }
        for invalid: Any in [NSNull(), true, false, Double.nan, Double.infinity, -1, "30"] {
            try check(NativeTrackingDisplay.number(invalid) == nil, "Invalid numeric values do not become nutrition")
            try check(!NativeTrackingDisplay.hasTarget(changed(energy, ["target": invalid])), "Invalid target is not shown as a denominator")
        }
        print("TARGET_DISPLAY_CHECK_RESULT {\"checks\":\(checks),\"groups\":[\"eight nutrients before logging\",\"unknown intake with known targets\",\"zero partial and future intake\",\"missing-input and manual-clear reasons\",\"historical and zero targets\",\"reference and limit semantics\",\"precision and invalid numbers\",\"active logged macro amounts without invented targets\"]}")
    }
}
