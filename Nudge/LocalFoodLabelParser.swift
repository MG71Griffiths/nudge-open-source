import Foundation

/// Private OCR observations. Coordinates use Vision's normalized bottom-left origin.
/// Word ranges are UTF-16 offsets into the original line, never guessed spacing.
struct FoodOCRBox: Codable, Sendable, Equatable {
    let x: Double, y: Double, width: Double, height: Double
    var midX: Double { x + width / 2 }
    var midY: Double { y + height / 2 }
    var maxX: Double { x + width }
    var maxY: Double { y + height }
    var isValid: Bool {
        [x, y, width, height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 && maxX <= 1.000001 && maxY <= 1.000001
    }
    func union(_ other: Self) -> Self {
        Self(x: min(x, other.x), y: min(y, other.y), width: max(maxX, other.maxX) - min(x, other.x), height: max(maxY, other.maxY) - min(y, other.y))
    }
}
struct FoodOCRWord: Codable, Sendable, Equatable {
    let text: String
    let start: Int, length: Int
    let box: FoodOCRBox
}
struct FoodOCRLine: Codable, Sendable, Equatable {
    let id: String, text: String
    let confidence: Double
    let box: FoodOCRBox
    let words: [FoodOCRWord]
}
struct FoodOCRPage: Codable, Sendable, Equatable {
    let photoID: String
    let photoIndex: Int
    let lines: [FoodOCRLine]
}
struct FoodOCRResult: Codable, Sendable {
    let pages: [FoodOCRPage]
    let elapsedMilliseconds: Int
}

enum FoodOCRLimits {
    static let maximumPages = 4
    static let maximumLinesPerPage = 160
    static let maximumCharacters = 24_000
    static func valid(_ pages: [FoodOCRPage]) -> Bool {
        guard (1...maximumPages).contains(pages.count), Set(pages.map(\.photoID)).count == pages.count,
              Set(pages.map(\.photoIndex)).count == pages.count else { return false }
        var characters = 0
        for page in pages {
            guard (1...4).contains(page.photoIndex), page.photoID.range(of: #"^[A-Za-z0-9._-]{1,160}$"#, options: .regularExpression) != nil,
                  page.lines.count <= maximumLinesPerPage, Set(page.lines.map(\.id)).count == page.lines.count else { return false }
            for line in page.lines {
                guard !line.id.isEmpty, line.id.utf8.count <= 80, line.id.rangeOfCharacter(from: .controlCharacters) == nil,
                      !line.text.isEmpty, line.text.utf16.count <= 600, line.text.rangeOfCharacter(from: .controlCharacters) == nil,
                      line.confidence.isFinite, (0...1).contains(line.confidence), line.box.isValid, line.words.count <= 100 else { return false }
                characters += line.text.utf16.count
                var previousEnd = 0
                let source = line.text as NSString
                for word in line.words {
                    guard word.start >= previousEnd, word.length > 0, word.start <= source.length,
                          word.length <= source.length - word.start, word.box.isValid,
                          source.substring(with: NSRange(location: word.start, length: word.length)) == word.text,
                          word.box.x >= line.box.x - 0.035, word.box.maxX <= line.box.maxX + 0.035,
                          word.box.y >= line.box.y - 0.035, word.box.maxY <= line.box.maxY + 0.035 else { return false }
                    previousEnd = word.start + word.length
                }
            }
        }
        return characters <= maximumCharacters
    }
}

struct FoodLabelNutrient: Codable, Sendable, Equatable {
    let value: Double?
    let unit: String
    let relation: String?
    init(value: Double?, unit: String, relation: String? = nil) { self.value = value; self.unit = unit; self.relation = relation }
    private enum CodingKeys: String, CodingKey { case value, unit, relation }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let value { try container.encode(value, forKey: .value) } else { try container.encodeNil(forKey: .value) }
        try container.encode(unit, forKey: .unit)
        try container.encodeIfPresent(relation, forKey: .relation)
    }
}
struct FoodLabelEvidence: Codable, Sendable, Equatable {
    let field: String, photoID: String
    let photoIndex: Int
    let lineID: String, text: String, basisHeader: String, relation: String
    let lineIDs: [String], basisLineIDs: [String]
    let boundValue: Double?
    let printedUnit: String
    let conversion: String?
}
struct FoodLocalLabel: Codable, Sendable {
    let version: String
    let photoID: String
    let photoIndex: Int
    let basis: String, nutritionPreparation: String
    let nutrients: [String: FoodLabelNutrient]
    let energyKj: FoodLabelNutrient?
    let evidence: [FoodLabelEvidence]
}

/// Deliberately limited to clear, explicitly headed per-100-g/ml tables.
/// It does not identify a product, infer ingredients, or turn a bound into intake.
enum FoodLocalLabelParser {
    static let version = "local-food-label-v1"
    static let nutrientKeys = ["energyKcal", "protein", "carbohydrate", "sugars", "fat", "saturatedFat", "fibre", "salt"]
    private static let minimumConfidence = 0.85
    private struct Row {
        let lines: [FoodOCRLine]
        let text: String
        let words: [FoodOCRWord]
        let box: FoodOCRBox
        var confidence: Double { lines.map(\.confidence).min() ?? 0 }
        var id: String { lines[0].id }
        func bounds(_ range: NSRange) -> FoodOCRBox? {
            let selected = words.filter { NSIntersectionRange(NSRange(location: $0.start, length: $0.length), range).length > 0 }
            guard !selected.isEmpty else { return nil }
            let source = text as NSString
            for position in range.location..<NSMaxRange(range) {
                let scalar = source.substring(with: NSRange(location: position, length: 1))
                if scalar.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                guard selected.contains(where: { position >= $0.start && position < $0.start + $0.length }) else { return nil }
            }
            return selected.dropFirst().reduce(selected[0].box) { $0.union($1.box) }
        }
    }
    private struct Header { let row: Row; let range: NSRange; let box: FoodOCRBox; let basis: String }
    private struct Observation {
        let field: String, value: Double, unit: String, relation: String
        let row: Row, box: FoodOCRBox
    }
    private enum TableResult { case absent, ambiguous, found(FoodLocalLabel) }

    static func parse(pages: [FoodOCRPage]) -> FoodLocalLabel? {
        // OCR alone cannot establish that a second image is the same packaged
        // item rather than a prepared meal. Preserve that context for fallback.
        guard pages.count == 1, FoodOCRLimits.valid(pages) else { return nil }
        var selected: FoodLocalLabel?
        for page in pages {
            switch parse(page: page) {
            case .absent: continue
            case .ambiguous: return nil
            case .found(let label):
                // Even identical panels from different photos could be different products.
                guard selected == nil else { return nil }
                selected = label
            }
        }
        return selected
    }

    private static func matches(_ pattern: String, _ text: String) -> [NSTextCheckingResult] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        return regex.matches(in: text, range: NSRange(location: 0, length: text.utf16.count))
    }
    private static func text(_ value: String, _ range: NSRange) -> String { (value as NSString).substring(with: range) }
    private static func normalized(_ value: String) -> String {
        value.lowercased().replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func rows(_ page: FoodOCRPage) -> [Row] {
        var groups: [[FoodOCRLine]] = []
        for line in page.lines.sorted(by: { $0.box.midY == $1.box.midY ? $0.box.x < $1.box.x : $0.box.midY > $1.box.midY }) {
            if let index = groups.firstIndex(where: { group in
                guard let first = group.first else { return false }
                return abs(first.box.midY - line.box.midY) <= min(first.box.height, line.box.height) * 0.45
                    && !group.contains(where: { min($0.box.maxX, line.box.maxX) - max($0.box.x, line.box.x) > 0.015 })
            }) { groups[index].append(line) } else { groups.append([line]) }
        }
        return groups.map { group in
            let lines = group.sorted { $0.box.x < $1.box.x }
            var joined = "", words: [FoodOCRWord] = []
            for line in lines {
                if !joined.isEmpty { joined += " " }
                let offset = joined.utf16.count
                words += line.words.map { FoodOCRWord(text: $0.text, start: $0.start + offset, length: $0.length, box: $0.box) }
                joined += line.text
            }
            return Row(lines: lines, text: joined, words: words, box: lines.dropFirst().reduce(lines[0].box) { $0.union($1.box) })
        }
    }
    private static func field(_ label: String) -> String? {
        let value = normalized(label).replacingOccurrences(of: #"^[•*–-]\s*|\s*[:：]$"#, with: "", options: .regularExpression)
        switch value {
        case "energy", "energy value", "calories": return "energy"
        case "fat", "total fat": return "fat"
        case "saturates", "saturated fat", "saturated fats", "of which saturates", "of which saturated fat": return "saturatedFat"
        case "carbohydrate", "carbohydrates", "total carbohydrate", "total carbohydrates": return "carbohydrate"
        case "sugars", "sugar", "total sugars", "of which sugars": return "sugars"
        case "protein": return "protein"
        case "fibre", "fiber", "dietary fibre", "dietary fiber": return "fibre"
        case "salt": return "salt"
        case "sodium": return "sodium"
        default: return nil
        }
    }

    private static func parse(page: FoodOCRPage) -> TableResult {
        let allRows = rows(page)
        let hasIngredients = allRows.contains { !matches(#"^\s*(?:recipe\s+)?ingredients(?:\s*:|\s*$)"#, $0.text).isEmpty }
        if hasIngredients && allRows.contains(where: { !matches(#"\b(?:serves|makes)\s*:?\s*\d|^\s*(?:method|instructions)(?:\s*:|\s*$)"#, $0.text).isEmpty }) { return .absent }
        let hasNutritionHeading = allRows.contains { $0.confidence >= minimumConfidence && !matches(#"\bnutrition(?:al)?\s+(?:information|facts|values)|^\s*nutrition\s*$|\btypical\s+(?:nutritional\s+)?values\b"#, $0.text).isEmpty }
        var headers: [Header] = []
        for row in allRows {
            for match in matches(#"\b(?:per\s*)?100\s*(g|ml)\b"#, row.text) {
                guard row.confidence >= minimumConfidence, let box = row.bounds(match.range) else { continue }
                headers.append(Header(row: row, range: match.range, box: box, basis: normalized(text(row.text, match.range(at: 1))) == "g" ? "per100g" : "per100ml"))
            }
        }
        guard hasNutritionHeading, !headers.isEmpty else { return .absent }
        guard headers.count == 1 else { return .ambiguous }
        let header = headers[0]
        let preparationPattern = #"\b(?:as|when)\s+(?:prepared|cooked|consumed)|\breconstituted\b|\bdrained\b"#
        let preparationRows = allRows.filter { !matches(preparationPattern, $0.text).isEmpty }
        guard preparationRows.allSatisfy({ $0.confidence >= minimumConfidence && abs($0.box.midY - header.row.box.midY) <= 0.12 }) else { return .ambiguous }
        let prepared = !preparationRows.isEmpty
        // A bare cooked/prepared modifier may identify either the food or the
        // preparation basis. Defer rather than silently calling it "as sold".
        if !prepared && !matches(#"\b(?:cooked|prepared)\b"#, header.row.text).isEmpty { return .ambiguous }
        if prepared && allRows.contains(where: { abs($0.box.midY - header.row.box.midY) <= 0.12 && !matches(#"\bas\s+sold\b"#, $0.text).isEmpty }) { return .ambiguous }
        // Column anchors come from printed headings, never from the order of numbers.
        var anchors: [Double] = [header.box.midX]
        for row in allRows where abs(row.box.midY - header.row.box.midY) <= max(row.box.height, header.row.box.height) * 1.4 {
            for match in matches(#"\bper\s+(?:serving|portion|pack|scoop)\b|%\s*(?:ri|dv)|\b(?:ri|dv)\s*%|\breference\s+intake\b"#, row.text) {
                guard row.confidence >= minimumConfidence, let box = row.bounds(match.range) else { return .ambiguous }
                if !anchors.contains(where: { abs($0 - box.midX) < 0.025 }) { anchors.append(box.midX) }
            }
        }
        anchors.sort()
        guard anchors.count <= 4, let selected = anchors.firstIndex(of: header.box.midX) else { return .ambiguous }
        let left = selected > 0 ? (anchors[selected - 1] + anchors[selected]) / 2 : 0
        let right = selected + 1 < anchors.count ? (anchors[selected] + anchors[selected + 1]) / 2 : 1
        var observations: [String: Observation] = [:]
        for row in allRows where row.box.midY < header.row.box.midY - header.row.box.height * 0.35 {
            let numeric = matches(#"(?<![\w.,/+−-])((?:<=|>=|[<>≤≥])?\s*(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*(kcal|kj|mg|g)\b"#, row.text)
            guard let first = numeric.first else { continue }
            guard let named = field(text(row.text, NSRange(location: 0, length: first.range.location))) else { continue }
            // A questionable nutrient row makes this table unsupported, not guessed.
            guard row.confidence >= minimumConfidence else { return .ambiguous }
            var selectedValues: [Observation] = []
            for match in numeric {
                guard let box = row.bounds(match.range) else { return .ambiguous }
                let x = box.midX
                let lower = left + (selected > 0 ? 0.012 : 0), upper = right - (selected + 1 < anchors.count ? 0.012 : 0)
                if box.maxX <= lower || box.x >= upper { continue }
                // A number and unit spanning two columns are not one value.
                guard box.x >= lower, box.maxX <= upper else { return .ambiguous }
                guard abs(x - header.box.midX) <= 0.20 else { return .ambiguous }
                var printed = text(row.text, match.range(at: 1)).trimmingCharacters(in: .whitespaces)
                let relation: String
                if printed.hasPrefix("<=") { relation = "<="; printed.removeFirst(2) }
                else if printed.hasPrefix(">=") { relation = ">="; printed.removeFirst(2) }
                else if printed.hasPrefix("≤") { relation = "<="; printed.removeFirst() }
                else if printed.hasPrefix("≥") { relation = ">="; printed.removeFirst() }
                else if printed.hasPrefix("<") { relation = "<"; printed.removeFirst() }
                else if printed.hasPrefix(">") { relation = ">"; printed.removeFirst() }
                else { relation = "=" }
                printed = printed.trimmingCharacters(in: .whitespaces)
                // A comma followed by three digits can be a thousands separator.
                if !matches(#"^[1-9]\d*,\d{3}$"#, printed).isEmpty { return .ambiguous }
                guard let number = Double(printed.replacingOccurrences(of: ",", with: ".")), number.isFinite, number >= 0 else { return .ambiguous }
                let unit = normalized(text(row.text, match.range(at: 2)))
                guard named == "energy" ? ["kcal", "kj"].contains(unit) : ["g", "mg"].contains(unit) else { return .ambiguous }
                let key = named == "energy" ? (unit == "kj" ? "energyKj" : "energyKcal") : named
                let canonical = unit == "mg" ? number / 1000 : number
                guard canonical <= (key == "energyKj" ? 4200 : key == "energyKcal" ? 1000 : 100) else { return .ambiguous }
                selectedValues.append(Observation(field: key, value: number, unit: unit == "kj" ? "kJ" : unit, relation: relation, row: row, box: box))
            }
            // Two numbers with the same unit but no separate printed header are not one column.
            guard Set(selectedValues.map(\.field)).count == selectedValues.count else { return .ambiguous }
            for observation in selectedValues {
                guard observations[observation.field] == nil else { return .ambiguous }
                observations[observation.field] = observation
            }
        }
        guard observations["energyKcal"] != nil || observations["energyKj"] != nil,
              ["protein", "carbohydrate", "fat"].filter({ observations[$0] != nil }).count >= 2,
              observations.keys.filter({ $0 != "energyKj" }).count >= 4 else { return .ambiguous }
        if let kcal = observations["energyKcal"], let kj = observations["energyKj"], kcal.relation == "=", kj.relation == "=",
           abs(kcal.value - kj.value / 4.184) > max(2, kcal.value * 0.05) { return .ambiguous }
        func grams(_ item: Observation) -> Double { item.value / (item.unit == "mg" ? 1000 : 1) }
        if let sodium = observations["sodium"], grams(sodium) * 2.5 > 100 { return .ambiguous }
        if let salt = observations["salt"], let sodium = observations["sodium"], salt.relation == "=", sodium.relation == "=",
           abs(grams(salt) - grams(sodium) * 2.5) > max(0.01, grams(salt) * 0.05) { return .ambiguous }
        var nutrients = Dictionary(uniqueKeysWithValues: nutrientKeys.map { ($0, FoodLabelNutrient(value: nil, unit: $0 == "energyKcal" ? "kcal" : "g")) })
        var evidence: [FoodLabelEvidence] = []
        func nutrient(_ observation: Observation, field: String, multiplier: Double = 1, conversion: String? = nil) -> FoodLabelNutrient {
            let value = observation.value * multiplier
            evidence.append(FoodLabelEvidence(field: field, photoID: page.photoID, photoIndex: page.photoIndex, lineID: observation.row.id,
                text: observation.row.text, basisHeader: header.row.text, relation: observation.relation,
                lineIDs: observation.row.lines.map(\.id), basisLineIDs: header.row.lines.map(\.id),
                boundValue: observation.relation == "=" ? nil : value, printedUnit: observation.unit, conversion: conversion))
            return FoodLabelNutrient(value: observation.relation == "=" ? value : nil,
                unit: field == "energyKj" ? "kJ" : field == "energyKcal" ? "kcal" : "g", relation: observation.relation == "=" ? nil : observation.relation)
        }
        for key in nutrientKeys {
            if let item = observations[key] {
                nutrients[key] = nutrient(item, field: key, multiplier: item.unit == "mg" ? 0.001 : 1, conversion: item.unit == "mg" ? "mg_to_g_divide_1000" : nil)
            }
        }
        if observations["energyKcal"] == nil, let kj = observations["energyKj"] {
            nutrients["energyKcal"] = nutrient(kj, field: "energyKcal", multiplier: 1 / 4.184, conversion: "kJ_to_kcal_divide_4.184")
        }
        if observations["salt"] == nil, let sodium = observations["sodium"] {
            nutrients["salt"] = nutrient(sodium, field: "salt", multiplier: sodium.unit == "mg" ? 0.0025 : 2.5,
                conversion: sodium.unit == "mg" ? "sodium_mg_to_salt_g_multiply_2.5_divide_1000" : "sodium_g_to_salt_g_multiply_2.5")
        }
        let energyKj = observations["energyKj"].map { nutrient($0, field: "energyKj") }
        return .found(FoodLocalLabel(version: version, photoID: page.photoID, photoIndex: page.photoIndex, basis: header.basis,
            nutritionPreparation: prepared ? "prepared" : "as_sold", nutrients: nutrients, energyKj: energyKj, evidence: evidence))
    }
}
