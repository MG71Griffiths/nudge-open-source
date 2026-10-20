import SwiftUI
import WebKit

/// Discovery and the existing review screens share one live app/session. Native
/// Search never reads or writes a second diary, nor replaces stored snapshots.
@MainActor
final class NativeSearchRouter: ObservableObject {
    @Published private(set) var isPresented = false
    @Published var errorMessage: String?
    let model = NativeProductSearchModel()
    let ratings = NativeProductRatingEngine()
    lazy var ratingLoader = NativeSearchRatingLoader(engine: ratings)
    weak var webView: WKWebView?
    private var opening = false

    func receive(screen: String, active: Bool) {
        let show = screen == "search" && active
        if isPresented && !show { model.cancel(); ratingLoader.cancel() }
        isPresented = show
        errorMessage = nil
    }

    func open(_ product: BarcodeProduct) {
        guard !opening, let data = try? JSONEncoder().encode(product),
              let json = String(data: data, encoding: .utf8) else { return }
        opening = true
        call("openProduct(\(json))") { [weak self] in self?.opening = false }
    }

    func navigate(_ destination: String) {
        guard ["today", "history", "camera", "search", "you"].contains(destination) else { return }
        call("navigate('\(destination)')")
    }

    func showSaved() { call("showSaved()") }

    private func call(_ method: String, completion: (() -> Void)? = nil) {
        guard let webView, NudgeWebConfiguration.isLocal(webView.url ?? NudgeWebConfiguration.startURL) else {
            errorMessage = "Nudge is still opening. Please try again."; completion?(); return
        }
        errorMessage = nil
        webView.evaluateJavaScript("window.NudgeNativeSearch?.\(method) === true") { [weak self] value, error in
            completion?()
            if error != nil || value as? Bool != true {
                self?.errorMessage = "This screen could not open. Please try again."
                AnalysisDiagnostics.shared.record(stage: "ui_error", outcome: "render_failed")
            }
        }
    }
}

/// Local routes into the real catalogue aisles, not guessed product matches.
/// Build the tiny taxonomy index once; typing never reads a catalogue or diary.
enum ProductSearchCategorySuggestions {
    private struct Entry {
        let category: ProductSearchCategory
        let terms: [[String]]
    }
    private static let genericWords: Set<String> = ["and", "&", "the", "of", "food", "foods", "product", "products", "based", "their"]
    private static func words(_ text: String) -> [String] {
        SearchDiscoveryParser.normalized(text).split(separator: " ").map(String.init)
            .filter { !genericWords.contains($0) }
    }
    private static let index: [Entry] = ProductSearchCategory.all.map { category in
        let terms = [category.title] + category.tags.map { $0.replacingOccurrences(of: "en:", with: "") }
        return Entry(category: category, terms: terms.map(words).filter { !$0.isEmpty })
    }

    static func suggestions(for raw: String) -> [ProductSearchCategory] {
        let input = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...80).contains(input.count),
              !input.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              input.unicodeScalars.contains(where: CharacterSet.letters.contains) else { return [] }
        let forms = [words(input), words(ProductSearchSpelling.prepare(input).text)].filter { !$0.isEmpty }
        guard !forms.isEmpty else { return [] }
        func rank(_ term: [String], query: [String]) -> Int? {
            if term == query { return 0 }
            // Every typed word must match a different taxonomy word. Only
            // prefixes match, so arbitrary substrings do not suggest an aisle.
            var available = term
            let allMatch = query.allSatisfy { word in
                guard let found = available.firstIndex(where: { $0.hasPrefix(word) }) else { return false }
                available.remove(at: found)
                return true
            }
            if allMatch { return 1 }
            // A brand or qualifier can precede a known category: “Heinz beans”
            // still offers Beans & pulses, without treating Heinz as a filter.
            if term.count == 1, let word = term.first,
               query.contains(where: { $0.count >= 3 && word.hasPrefix($0) }) { return 2 }
            return nil
        }
        return index.enumerated().compactMap { order, entry -> (Int, Int, ProductSearchCategory)? in
            let scores = forms.flatMap { query in entry.terms.compactMap { rank($0, query: query) } }
            guard let score = scores.min() else { return nil }
            return (score, order, entry.category)
        }.sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }
            .prefix(4).map { $0.2 }
    }
}
