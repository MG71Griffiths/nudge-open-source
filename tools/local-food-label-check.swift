import Foundation

private enum CheckError: Error { case failed(String), unexpected }
private final class CheckCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0
    func add() { lock.lock(); stored += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return stored }
}

@main struct LocalFoodLabelChecks {
    static func line(_ id: String, _ y: Double, _ pieces: [(String, Double, Double)], confidence: Double = 0.99) -> FoodOCRLine {
        var text = "", words: [FoodOCRWord] = []
        let height = 0.025
        for (piece, x, width) in pieces {
            if !text.isEmpty { text += " " }
            let offset = text.utf16.count
            let regex = try! NSRegularExpression(pattern: #"\S+"#)
            for match in regex.matches(in: piece, range: NSRange(location: 0, length: piece.utf16.count)) {
                words.append(FoodOCRWord(text: (piece as NSString).substring(with: match.range), start: offset + match.range.location,
                    length: match.range.length, box: FoodOCRBox(x: x + width * Double(match.range.location) / Double(piece.utf16.count), y: y,
                    width: width * Double(match.range.length) / Double(piece.utf16.count), height: height)))
            }
            text += piece
        }
        let left = pieces.map { $0.1 }.min()!, right = pieces.map { $0.1 + $0.2 }.max()!
        return FoodOCRLine(id: id, text: text, confidence: confidence, box: FoodOCRBox(x: left, y: y, width: right - left, height: height), words: words)
    }
    static func page(values: [String: String] = [:], omit: Set<String> = [], dual: Bool = false, reverse: Bool = false,
                     basis: String = "Per 100g", extra: [FoodOCRLine] = []) -> FoodOCRPage {
        let rows = [("Energy", "200kcal"), ("Fat", "10g"), ("of which saturates", "3g"), ("Carbohydrate", "20g"),
                    ("of which sugars", "5g"), ("Fibre", "2g"), ("Protein", "6g"), ("Salt", "0.5g")]
        var lines = [line("heading", 0.94, [("Nutrition information", 0.08, 0.7)])]
        let selectedX = reverse ? 0.72 : 0.49
        var columns = [(basis, selectedX - 0.03, 0.14)]
        if dual { columns.append(("Per serving", reverse ? 0.40 : 0.70, 0.18)) }
        lines.append(line("basis", 0.88, columns.sorted { $0.1 < $1.1 }))
        for (index, pair) in rows.enumerated() where !omit.contains(pair.0) {
            var pieces = [(pair.0, 0.04, 0.31), (values[pair.0] ?? pair.1, selectedX, 0.08)]
            if dual { pieces.append((pair.0 == "Energy" ? "999kcal" : "99g", reverse ? 0.44 : 0.75, 0.08)) }
            lines.append(line("row\(index)", 0.82 - Double(index) * 0.065, pieces.sorted { $0.1 < $1.1 }))
        }
        return FoodOCRPage(photoID: "synthetic-photo", photoIndex: 1, lines: lines + extra)
    }
    static func changed(_ page: FoodOCRPage, lines: [FoodOCRLine]) -> FoodOCRPage { FoodOCRPage(photoID: page.photoID, photoIndex: page.photoIndex, lines: lines) }
    static func parse(_ page: FoodOCRPage) -> FoodLocalLabel? { FoodLocalLabelParser.parse(pages: [page]) }

    static func main() async {
        var checks: [String] = []
        func expect(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw CheckError.failed(name) }; checks.append(name)
        }
        do {
            let basic = page(), coldStart = DispatchTime.now().uptimeNanoseconds
            let result = parse(basic)
            let coldMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - coldStart) / 1_000_000
            try expect("explicit supported table gives all eight fields", result?.nutrients.count == 8 && result?.nutrients.values.allSatisfy { $0.value != nil } == true)
            try expect("values and selected basis remain unchanged", result?.nutrients["energyKcal"]?.value == 200 && result?.basis == "per100g")
            try expect("per-serving column is never mixed into per100", parse(page(dual: true))?.nutrients["fat"]?.value == 10)
            try expect("column position rather than first number selects reversed columns", parse(page(dual: true, reverse: true))?.nutrients["fat"]?.value == 10)
            let ri = page(extra: [line("ri-heading", 0.88, [("%RI", 0.80, 0.09)])])
            try expect("reference intake header does not replace nutrition column", parse(ri)?.nutrients["protein"]?.value == 6)
            try expect("per100ml is kept as volume basis", parse(page(basis: "Per 100ml"))?.basis == "per100ml")
            try expect("missing fibre stays null", parse(page(omit: ["Fibre"]))?.nutrients["fibre"]?.value == nil)
            try expect("observed zero is retained as zero", parse(page(values: ["Fibre": "0g"]))?.nutrients["fibre"]?.value == 0)
            try expect("decimal commas preserve precision", parse(page(values: ["Salt": "0,125g"]))?.nutrients["salt"]?.value == 0.125)
            try expect("mg conversion is ordinary code", parse(page(values: ["Salt": "500mg"]))?.nutrients["salt"]?.value == 0.5)
            let sodium = page(omit: ["Salt"], extra: [line("sodium", 0.36, [("Sodium", 0.04, 0.25), ("200mg", 0.49, 0.08)])])
            try expect("sodium converts to salt with declared factor", parse(sodium)?.nutrients["salt"]?.value == 0.5 && parse(sodium)?.evidence.contains { $0.field == "salt" && $0.conversion == "sodium_mg_to_salt_g_multiply_2.5_divide_1000" } == true)
            let contradiction = page(extra: [line("sodium", 0.28, [("Sodium", 0.04, 0.25), ("900mg", 0.49, 0.08)])])
            try expect("contradictory sodium and salt reject table", parse(contradiction) == nil)
            let less = parse(page(values: ["Salt": "<0.5g"]))
            try expect("inequality never becomes exact intake", less?.nutrients["salt"]?.value == nil && less?.nutrients["salt"]?.relation == "<")
            try expect("inequality bound and original quote remain evidence", less?.evidence.contains { $0.field == "salt" && $0.boundValue == 0.5 && $0.text.contains("<0.5g") } == true)
            try expect("inclusive inequality remains a bound", parse(page(values: ["Salt": "≤0,5g"]))?.evidence.contains { $0.field == "salt" && $0.relation == "<=" && $0.boundValue == 0.5 } == true)
            try expect("ASCII inequality remains a bound", parse(page(values: ["Salt": "<=0.5g"]))?.nutrients["salt"]?.relation == "<=")
            let kj = parse(page(values: ["Energy": "836.8kJ"]))
            try expect("kJ converts to kcal without rounding", abs((kj?.nutrients["energyKcal"]?.value ?? 0) - 200) < 0.000001 && kj?.energyKj?.value == 836.8)
            let paired = changed(basic, lines: basic.lines.filter { $0.id != "row0" } + [line("energy", 0.82, [("Energy", 0.04, 0.25), ("836.8kJ", 0.43, 0.08), ("200kcal", 0.56, 0.10)])])
            try expect("printed kcal takes precedence over equivalent kJ", parse(paired)?.nutrients["energyKcal"]?.value == 200 && parse(paired)?.energyKj?.value == 836.8)
            let wrongEnergy = changed(basic, lines: basic.lines.filter { $0.id != "row0" } + [line("energy", 0.82, [("Energy", 0.04, 0.25), ("836.8kJ", 0.43, 0.08), ("800kcal", 0.56, 0.10)])])
            try expect("conflicting energy units reject table", parse(wrongEnergy) == nil)
            let split = changed(basic, lines: basic.lines.filter { $0.id != "row1" } + [line("fat-name", 0.755, [("Fat", 0.04, 0.20)]), line("fat-value", 0.755, [("10g", 0.49, 0.08)])])
            try expect("separate OCR fragments align by row position", parse(split)?.nutrients["fat"]?.value == 10)
            try expect("two per100 headings fail closed", parse(page(extra: [line("other-basis", 0.88, [("Per 100g", 0.73, 0.15)])])) == nil)
            let unknownColumns = changed(basic, lines: basic.lines.filter { $0.id != "row1" } + [line("fat", 0.755, [("Fat", 0.04, 0.20), ("10g", 0.49, 0.08), ("2g", 0.63, 0.08)])])
            try expect("unheaded second numeric column fails closed", parse(unknownColumns) == nil)
            let crossed = page(dual: true)
            let crossedRow = changed(crossed, lines: crossed.lines.filter { $0.id != "row1" } + [line("crossed", 0.755, [("Fat", 0.04, 0.2), ("10", 0.54, 0.02), ("g", 0.74, 0.01)])])
            try expect("numeric value and unit cannot span separate columns", parse(crossedRow) == nil)
            let missingWordBox = changed(basic, lines: basic.lines.map { $0.id == "row1" ? FoodOCRLine(id: $0.id, text: $0.text, confidence: $0.confidence, box: $0.box, words: $0.words.filter { $0.text != "10g" }) : $0 })
            try expect("selected numeric evidence requires its own OCR word geometry", parse(missingWordBox) == nil)
            try expect("per-serving-only table defers", parse(page(basis: "Per serving")) == nil)
            try expect("table without nutrition context defers", parse(changed(basic, lines: basic.lines.filter { $0.id != "heading" })) == nil)
            try expect("front photo without a table defers", parse(FoodOCRPage(photoID: "front", photoIndex: 1, lines: [line("front", 0.8, [("Synthetic spread 100g", 0.1, 0.7)])])) == nil)
            try expect("dashboard totals are not a nutrition table", parse(FoodOCRPage(photoID: "dashboard", photoIndex: 1, lines: [line("daily", 0.8, [("Daily nutrition", 0.1, 0.7)]), line("kcal", 0.7, [("Energy 2100kcal", 0.1, 0.7)])])) == nil)
            let low = changed(basic, lines: basic.lines.map { $0.id == "row1" ? FoodOCRLine(id: $0.id, text: $0.text, confidence: 0.5, box: $0.box, words: $0.words) : $0 })
            try expect("low-confidence nutrient rows defer", parse(low) == nil)
            try expect("implausible per100 value defers", parse(page(values: ["Fat": "999g"])) == nil)
            try expect("ambiguous comma thousands separator defers", parse(page(values: ["Energy": "1,234kJ"])) == nil)
            let second = FoodOCRPage(photoID: "other", photoIndex: 2, lines: basic.lines)
            try expect("multiple nutrition panels are never silently combined", FoodLocalLabelParser.parse(pages: [basic, second]) == nil)
            try expect("label plus possible plated-meal photo defers", FoodLocalLabelParser.parse(pages: [basic, FoodOCRPage(photoID: "plate", photoIndex: 2, lines: [])]) == nil)
            let preparation = page(extra: [line("prep", 0.91, [("As prepared", 0.4, 0.25)])])
            try expect("adjacent preparation heading is preserved", parse(preparation)?.nutritionPreparation == "prepared")
            try expect("ambiguous distant preparation wording defers", parse(page(extra: [line("prep", 0.2, [("As prepared", 0.4, 0.25)])])) == nil)
            let recipe = page(extra: [line("ingredients", 0.2, [("Ingredients", 0.1, 0.3)]), line("serves", 0.16, [("Serves 4", 0.1, 0.3)])])
            try expect("recipe page nutrition is not packaged label evidence", parse(recipe) == nil)
            let inlineRecipe = page(extra: [line("ingredients", 0.2, [("Ingredients: 100g flour", 0.1, 0.7)]), line("serves", 0.16, [("Serves: 4", 0.1, 0.3)])])
            try expect("inline ingredients and recipe yield defer label interpretation", parse(inlineRecipe) == nil)
            let inlineMethod = page(extra: [line("ingredients", 0.2, [("Ingredients: flour", 0.1, 0.7)]), line("method", 0.16, [("Method: mix ingredients", 0.1, 0.7)])])
            try expect("inline recipe method cannot become packaged nutrition", parse(inlineMethod) == nil)
            try expect("bare cooked table heading cannot become as-sold facts", parse(page(basis: "Per 100g cooked")) == nil)
            try expect("bare prepared table heading cannot become as-sold facts", parse(page(basis: "Per 100g prepared")) == nil)
            let invalidBox = FoodOCRLine(id: "bad", text: "x", confidence: 1, box: FoodOCRBox(x: .nan, y: 0.4, width: 0.1, height: 0.1), words: [])
            try expect("nonfinite OCR geometry is rejected", parse(page(extra: [invalidBox])) == nil)
            let invalidWord = FoodOCRLine(id: "bad", text: "word", confidence: 1, box: FoodOCRBox(x: 0.1, y: 0.3, width: 0.1, height: 0.02), words: [FoodOCRWord(text: "forged", start: 0, length: 4, box: FoodOCRBox(x: 0.1, y: 0.3, width: 0.1, height: 0.02))])
            try expect("word evidence must exactly match UTF16 source range", parse(page(extra: [invalidWord])) == nil)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(less!)) as! [String: Any]
            let encodedNutrients = encoded["nutrients"] as! [String: [String: Any]]
            try expect("JSON emits explicit null rather than absent or zero", encodedNutrients["salt"]?["value"] is NSNull)

            let empty = FoodOCRPage(photoID: "synthetic", photoIndex: 1, lines: [])
            let success = try await VisionFoodTextRecognizer.recognize(images: [Data([1])], photoIDs: ["synthetic"], timeout: 0.5) { _, _, _ in [empty] }
            try expect("bounded recognizer returns monotonic duration", success.pages == [empty] && success.elapsedMilliseconds >= 0)
            let timeoutCancels = CheckCounter(), started = DispatchTime.now().uptimeNanoseconds
            do {
                _ = try await VisionFoodTextRecognizer.recognize(images: [Data([1])], photoIDs: ["synthetic"], timeout: 0.03) { _, _, control in
                    try control.install { timeoutCancels.add() }; Thread.sleep(forTimeInterval: 0.30); return [empty]
                }
                throw CheckError.unexpected
            } catch FoodOCRFailure.timeout {}
            try expect("timeout does not wait for blocked OCR worker", DispatchTime.now().uptimeNanoseconds - started < 200_000_000)
            try expect("timeout cancels underlying request exactly once", timeoutCancels.value == 1)
            let began = CheckCounter(), cancelled = CheckCounter()
            let task = Task {
                try await VisionFoodTextRecognizer.recognize(images: [Data([1])], photoIDs: ["synthetic"], timeout: 1) { _, _, control in
                    try control.install { cancelled.add() }; began.add(); Thread.sleep(forTimeInterval: 0.3); return [empty]
                }
            }
            for _ in 0..<100 where began.value == 0 { try await Task.sleep(nanoseconds: 1_000_000) }
            let cancelStart = DispatchTime.now().uptimeNanoseconds; task.cancel()
            do { _ = try await task.value; throw CheckError.unexpected } catch is CancellationError {}
            try expect("task cancellation returns without waiting for OCR", DispatchTime.now().uptimeNanoseconds - cancelStart < 200_000_000 && cancelled.value == 1)
            let invalidCalls = CheckCounter()
            do {
                _ = try await VisionFoodTextRecognizer.recognize(images: [Data()], photoIDs: ["synthetic"], timeout: 1) { _, _, _ in invalidCalls.add(); return [empty] }
                throw CheckError.unexpected
            } catch FoodOCRFailure.invalidInput {}
            try expect("invalid input is rejected before worker starts", invalidCalls.value == 0)
            // Let both intentionally uncooperative synthetic workers finish;
            // a double-resume bug would trap here rather than being hidden by exit.
            try await Task.sleep(nanoseconds: 350_000_000)
            try expect("late worker results do not resume cancelled callers twice", cancelled.value == 1 && timeoutCancels.value == 1)
            var samples: [Double] = []
            for _ in 0..<100 {
                let start = DispatchTime.now().uptimeNanoseconds
                guard parse(basic)?.nutrients["energyKcal"]?.value == 200 else { throw CheckError.failed("benchmark parse") }
                samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
            }
            samples.sort()
            let receipt: [String: Any] = ["passed": true, "count": checks.count, "checks": checks, "realImages": 0, "networkRequests": 0,
                "syntheticParserTiming": ["samples": 100, "coldMs": coldMilliseconds, "p50Ms": samples[49], "p95Ms": samples[94], "scope": "Same synthetic OCR table; Foundation parser only, no OCR, images, network, UI or held-out benchmark."],
                "limitations": ["Synthetic OCR geometry and injected worker; no claim about real Vision accuracy, device timing or five-second performance."]]
            let data = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("receipt.json"))
            let fixture: [String: Any] = ["pages": try JSONSerialization.jsonObject(with: JSONEncoder().encode([basic])),
                "label": try JSONSerialization.jsonObject(with: JSONEncoder().encode(result!))]
            try JSONSerialization.data(withJSONObject: fixture, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("local-label-ocr.json"))
            let splitFixture: [String: Any] = ["pages": try JSONSerialization.jsonObject(with: JSONEncoder().encode([split])),
                "label": try JSONSerialization.jsonObject(with: JSONEncoder().encode(parse(split)!))]
            try JSONSerialization.data(withJSONObject: splitFixture, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("local-label-ocr-split.json"))
            print(String(decoding: data, as: UTF8.self))
        } catch { print("FAIL after \(checks.count) checks: \(error)"); exit(1) }
    }
}
