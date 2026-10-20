import Combine
import Foundation
import JavaScriptCore
import SwiftUI

/// Public product context only. The shared domain rules own recall matching,
/// scoring, comparison basis and dietary eligibility; this view never logs food.
@MainActor
struct NativeProductContextView: View {
    let product: [String: Any]
    var profile: [String: Any] = [:]
    var avoidMilk = false
    var alternativesOnly = false
    var alternativesFirst = false
    var useSavedStore = true
    var selectedStore: ProductSearchStore? = nil
    var onRecallAssessment: ([String: Any]) -> Void = { _ in }
    let onOpen: ([String: Any]) -> Void
    @StateObject private var model = NativeProductContextModel()
    @ObservedObject private var searchPreferences = ProductSearchPreferences.shared

    private var shop: ProductSearchStore? { useSavedStore ? searchPreferences.store : selectedStore }
    private var identity: String { NativeProductContextRules.identity(product: product, profile: profile, avoidMilk: avoidMilk, selectedStore: shop) }
    private var current: Bool { model.identity == identity }
    private var recallFirst: Bool { !alternativesFirst || model.hasRecallWarning }
    private var ink: Color { Color(uiColor: NudgeTheme.ink) }
    private var muted: Color { Color(uiColor: NudgeTheme.muted) }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if current && !alternativesOnly && recallFirst { recall }
            if current && (model.canOfferAlternatives || alternativesOnly) { alternatives }
            if current && !alternativesOnly && !recallFirst { recall }
        }
        .foregroundStyle(ink)
        .task(id: identity) {
            await model.load(product: product, profile: profile, avoidMilk: avoidMilk, selectedStore: shop, forceAlternatives: alternativesOnly, onRecallAssessment: onRecallAssessment)
        }
        .onDisappear { model.cancel() }
    }

    private var recall: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(model.recallLoading ? "Checking recall notices…" : "Product recall notices", systemImage: "exclamationmark.shield")
                .font(.headline)
            if model.recallLoading { ProgressView().accessibilityLabel("Checking official food recall notices") }
            if !model.recallLoading || model.hasRecallWarning {
                Text(model.assessment["message"] as? String ?? "Recall check unavailable. Check the current official notices.")
                    .font(model.hasRecallWarning ? .headline : .subheadline)
                ForEach(Array(model.matches.enumerated()), id: \.offset) { _, match in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(match["title"] as? String ?? "Food recall notice").font(.headline)
                        if let risk = match["risk"] as? String, !risk.isEmpty { Text(risk) }
                        Text(match["advice"] as? String ?? "Read the official notice before consuming.")
                        ForEach(match["pending"] as? [String] ?? [], id: \.self) { Text($0).font(.subheadline) }
                        if let url = NativeProductContextRules.officialNoticeURL(match["url"]) {
                            Link(destination: url) {
                                Text("Read the official notice").font(.headline)
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                        }
                    }
                }
                if model.matches.isEmpty {
                    Link(destination: URL(string: "https://www.food.gov.uk/news-alerts/search/alerts")!) {
                        Text("FSA food alerts").frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                }
                if let checked = model.assessment["checkedAt"] as? String, let date = NativeProductContextRules.date(checked) {
                    Text("Checked \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(muted)
                }
                Text(model.assessment["scope"] as? String ?? "Latest 100 full FSA notices; not a complete historical or independent FSS search.")
                    .font(.caption).foregroundStyle(muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(uiColor: model.hasRecallWarning ? NudgeTheme.warningSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: model.hasRecallWarning ? NudgeTheme.warningText : NudgeTheme.border)))
        .tint(Color(uiColor: NudgeTheme.accent))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("native-product-recalls")
    }

    private var alternatives: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.selectedStore.map { "Better at \($0.title)" } ?? "Better alternatives").font(.title2.bold())
            Text(model.selectedStore.map { "Comparable UK products listed at \($0.title), with a higher Nudge rating. Your saved food requirements apply." } ?? "Comparable UK products with a higher Nudge rating. Your saved food requirements apply.")
                .font(.subheadline).foregroundStyle(muted)
            if !model.canOfferAlternatives {
                Text(model.alternativesSnapshot.message).font(.subheadline).foregroundStyle(muted)
            } else if model.alternativesSnapshot.status == .loading {
                ProgressView("Finding alternatives…").frame(minHeight: 44)
            } else if model.alternativesRequested {
                if model.rows.isEmpty { Text(model.alternativesSnapshot.message).font(.subheadline).foregroundStyle(muted) }
                if !model.rows.isEmpty { NativeProductAlternativesCarousel(rows: model.rows, onOpen: onOpen) }
                if !model.rows.isEmpty {
                    Text("From the Nudge catalogue · Availability in your shop is not confirmed.").font(.caption).foregroundStyle(muted)
                    if !model.alternativeSources.isEmpty { Text("Product data: " + model.alternativeSources.joined(separator: ", ")).font(.caption).foregroundStyle(muted) }
                }
                Button(model.rows.isEmpty ? "Try alternatives again" : "Refresh alternatives") { model.findAlternatives(refresh: true) }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary))
            } else {
                Button("Find alternatives") { model.findAlternatives() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
            }
        }.accessibilityIdentifier("native-product-alternatives")
    }
}

/// A small, horizontally browsable product shelf. Each card opens the complete
/// review; the context model remains the sole owner of eligibility and recalls.
struct NativeProductAlternativesCarousel: View {
    let rows: [[String: Any]]
    let onOpen: ([String: Any]) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView(.horizontal) {
            LazyHStack(alignment: .top, spacing: 12) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    card(row)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .alternativeCardControl("native-product-alternatives-carousel")
    }

    private func card(_ row: [String: Any]) -> some View {
        let product = row["product"] as? [String: Any] ?? [:]
        let name = product["name"] as? String ?? "Product"
        let brand = product["brand"] as? String ?? ""
        let barcode = product["barcode"] as? String
        let value = row["value"] as? Int
        let image = row["imageURL"] as? String ?? product["displayImageURL"] as? String ?? product["imageURL"] as? String ?? ""
        let accessibleName = [name, brand, value.map { "Nudge rating \($0) percent" } ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
        return Button { onOpen(product) } label: {
            VStack(alignment: .leading, spacing: 8) {
                NativeStoredFoodImage(source: image, placeholder: "shippingbox", barcode: barcode, maximumPixelSize: 384)
                    .frame(height: typeSize.isAccessibilitySize ? 136 : 100)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                Group {
                    if typeSize.isAccessibilitySize { Text(name).fixedSize(horizontal: false, vertical: true) }
                    else { Text(name).lineLimit(2, reservesSpace: true) }
                }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(brand.isEmpty ? " " : brand)
                    .font(.caption)
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                if let value { NativeNudgeRatingBadge(value: value, compact: true) }
            }
            .padding(12)
            .frame(width: typeSize.isAccessibilitySize ? 264 : 168, alignment: .leading)
            .foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibleName)
        .accessibilityHint("Opens product details")
        .alternativeCardControl("native-product-alternative-" + (barcode ?? name))
    }
}

private extension View {
    @ViewBuilder func alternativeCardControl(_ identifier: String) -> some View {
        #if DEBUG
        accessibilityIdentifier(identifier).background {
            GeometryReader { geometry in
                Color.clear.preference(key: NativeTrackingRenderGeometryKey.self, value: [identifier: geometry.frame(in: .global)])
            }.allowsHitTesting(false).accessibilityHidden(true)
        }
        #else
        accessibilityIdentifier(identifier)
        #endif
    }
}

/// A single read-only result shared by the full review and live scanner. It is
/// emitted only for the current product/profile/store request.
struct NativeProductAlternativesSnapshot {
    enum Status { case ineligible, notRequested, loading, ready, empty, failed }
    let status: Status
    let rows: [[String: Any]]
    let message: String
    let selectedStore: ProductSearchStore?
}

@MainActor
final class NativeProductContextModel: ObservableObject {
    typealias RecallFetch = () async -> [String: Any]
    typealias AlternativesFetch = (_ category: String, _ selectedStore: ProductSearchStore?, _ basis: String?, _ preparation: String?) async throws -> [[String: Any]]
    @Published private(set) var identity = ""
    @Published private(set) var assessment: [String: Any] = [:]
    @Published private(set) var recallLoading = false
    @Published private(set) var canOfferAlternatives = false
    @Published private(set) var selectedStore: ProductSearchStore?
    @Published private(set) var alternativesLoading = false
    @Published private(set) var alternativesRequested = false
    @Published private(set) var alternativesError: String?
    @Published private(set) var rows: [[String: Any]] = []
    private let rules: NativeProductContextRules
    private let fetchRecall: RecallFetch
    private let fetchAlternatives: AlternativesFetch
    private var product: [String: Any] = [:]
    private var profile: [String: Any] = [:]
    private var avoidMilk = false
    private var recallResponse: [String: Any] = [:]
    private var candidates: [[String: Any]] = []
    private var generation = 0
    private var alternativesTask: Task<Void, Never>?
    private var onAlternativesChange: ((NativeProductAlternativesSnapshot) -> Void)?
    var matches: [[String: Any]] { assessment["matches"] as? [[String: Any]] ?? [] }
    var hasRecallWarning: Bool { ["matched", "potential_match"].contains(assessment["status"] as? String ?? "") }
    var alternativeSources: [String] {
        Array(Set(rows.compactMap { ($0["product"] as? [String: Any])?["sourceName"] as? String }.filter { !$0.isEmpty })).sorted()
    }
    var alternativesSnapshot: NativeProductAlternativesSnapshot {
        let status: NativeProductAlternativesSnapshot.Status
        let message: String
        if !canOfferAlternatives { status = .ineligible; message = "Comparable alternatives need a supported nutrition rating and product category." }
        else if !alternativesRequested { status = .notRequested; message = "Find comparable products with a higher Nudge rating." }
        else if let error = alternativesError { status = .failed; message = error }
        else if alternativesLoading || recallLoading { status = .loading; message = selectedStore.map { "Finding better alternatives listed at \($0.title)…" } ?? "Finding better alternatives…" }
        else if rows.isEmpty { status = .empty; message = selectedStore.map { "No higher-rated alternatives with enough comparable product evidence are in the Nudge catalogue for \($0.title) yet." } ?? "No higher-rated alternatives with enough comparable nutrition and food-requirement evidence are in the Nudge catalogue yet." }
        else { status = .ready; message = selectedStore.map { "Listed at \($0.title) · Availability in this shop is not confirmed." } ?? "Comparable UK products · Availability in your shop is not confirmed." }
        return NativeProductAlternativesSnapshot(status: status, rows: rows, message: message, selectedStore: selectedStore)
    }

    convenience init() {
        let service = OpenFoodFactsService.catalogueConnected
        let rules = NativeProductContextRules()
        let ratingEngine = NativeProductRatingEngine(catalogue: nil)
        self.init(rules: rules, fetchRecall: { await FoodRecallService.shared.notices() },
                  fetchAlternatives: { category, selectedStore, basis, preparation in
            // Identity/category are already known. Avoid an unnecessary barcode
            // lookup which could replace reviewed evidence with an older record.
            let products = try await service.alternatives(categoryTag: category, basisUnit: basis, nutritionPreparation: preparation, selectedStore: selectedStore)
            return products.compactMap { rules.productFacts($0, ratingEngine: ratingEngine) }
        })
    }

    init(rules: NativeProductContextRules, fetchRecall: @escaping RecallFetch, fetchAlternatives: @escaping AlternativesFetch) {
        self.rules = rules; self.fetchRecall = fetchRecall; self.fetchAlternatives = fetchAlternatives
    }

    func load(product: [String: Any], profile: [String: Any], avoidMilk: Bool, selectedStore: ProductSearchStore? = nil, automaticallyFindAlternatives: Bool = true, forceAlternatives: Bool = false, onAlternativesChange: @escaping (NativeProductAlternativesSnapshot) -> Void = { _ in }, onRecallAssessment: ([String: Any]) -> Void = { _ in }) async {
        cancel(); let token = generation
        self.onAlternativesChange = onAlternativesChange
        self.product = product; self.profile = profile; self.avoidMilk = avoidMilk; self.selectedStore = selectedStore
        identity = NativeProductContextRules.identity(product: product, profile: profile, avoidMilk: avoidMilk, selectedStore: selectedStore)
        assessment = product["recallAssessment"] as? [String: Any] ?? [:]
        recallResponse = [:]; candidates = []; rows = []; alternativesError = nil; alternativesRequested = false
        canOfferAlternatives = rules.canOffer(product)
        recallLoading = true
        // Retain any existing warning in the visible panel while withdrawing a
        // previous no-match clearance from the review's frequency calculation.
        onRecallAssessment(["status": "checking", "matches": [], "message": "Checking current official recall notices."])
        // Low-rated scans need useful next choices without another tap. A saved
        // supermarket also supplies explicit shopping context. Keep a selected
        // shop's request scoped to source-confirmed listings in that shop.
        if automaticallyFindAlternatives && canOfferAlternatives && (forceAlternatives || selectedStore != nil || rules.isBelowFifty(product)) { findAlternatives() }
        else { publishAlternatives() }
        let response = await fetchRecall()
        guard !Task.isCancelled, generation == token else { return }
        recallResponse = response
        assessment = rules.assess(product: product, response: response)
        recallLoading = false
        rebuildRows()
        publishAlternatives()
        onRecallAssessment(assessment)
    }

    func findAlternatives(refresh: Bool = false) {
        guard canOfferAlternatives, !alternativesLoading, let category = rules.category(product) else { return }
        alternativesTask?.cancel()
        let token = generation, current = product, selectedStore = selectedStore
        alternativesLoading = true; alternativesRequested = true; alternativesError = nil; rows = []
        publishAlternatives()
        alternativesTask = Task { [weak self] in
            guard let self else { return }
            do {
                if refresh { await ProductAlternativesState.shared.invalidate() }
                try Task.checkCancellation()
                let response = try await fetchAlternatives(category, selectedStore, current["basisUnit"] as? String, current["nutritionPreparation"] as? String)
                guard !Task.isCancelled, generation == token else { return }
                candidates = response.filter { NativeProductContextRules.matchesScope($0, selectedStore: selectedStore) }
                rebuildRows()
                alternativesLoading = false
            } catch {
                guard !Task.isCancelled, generation == token else { return }
                alternativesLoading = false
                if error as? BarcodeLookupError == .rateLimited || ((error as? ProductSearchError)?.retryAfterSeconds ?? 0) > 0 {
                    alternativesError = "Your product result is ready. Alternatives are busy—try again later."
                } else { alternativesError = "Your product result is ready. Nudge catalogue alternatives couldn’t load just now. Try again later." }
            }
            if generation == token { alternativesTask = nil; publishAlternatives() }
        }
    }

    func cancel() {
        generation += 1; alternativesTask?.cancel(); alternativesTask = nil; alternativesLoading = false
        onAlternativesChange = nil; candidates = []; rows = []
    }

    private func publishAlternatives() { onAlternativesChange?(alternativesSnapshot) }

    private func rebuildRows() {
        // A later official feed also rechecks already fetched alternatives.
        // Do not briefly recommend a candidate while its recall check is pending.
        guard !recallLoading else { rows = []; return }
        rows = rules.select(current: product, candidates: candidates, profile: profile, avoidMilk: avoidMilk, selectedStore: selectedStore)
            .filter { row in
                guard let candidate = row["product"] as? [String: Any] else { return false }
                let status = rules.assess(product: candidate, response: recallResponse)["status"] as? String
                return status != "matched" && status != "potential_match"
            }
            .map { row in
                var scoped = row
                // Scope was checked against source stores, never the brand.
                if let selectedStore { scoped["retailer"] = selectedStore.title }
                if let candidate = row["product"] as? [String: Any] {
                    scoped["imageURL"] = candidate["displayImageURL"] ?? candidate["imageURL"]
                }
                return scoped
            }
    }
}

/// Executes the existing read-only product domain functions, with no WebView,
/// network bridge or storage. The complete source is loaded without extracting
/// or maintaining a second copy of the alternatives algorithm.
@MainActor
final class NativeProductContextRules {
    private let context: JSContext?
    var ready: Bool { context != nil }
    init(bundle: Bundle = .main, referenceDate: Date? = nil) {
        let runtime = JSContext(); runtime?.evaluateScript("var window = globalThis;")
        // Frozen public-wire regressions must exercise the same expiry checks
        // after their captured catalogue publication has naturally expired.
        if let referenceDate {
            runtime?.evaluateScript("Date.now = function() { return \(referenceDate.timeIntervalSince1970 * 1000); };")
        }
        var loaded = runtime != nil
        for path in ["core/nutrition-profile.js", "core/nudge-score.js", "core/meal-score.js", "food-detail-model.js", "food-evidence.js", "barcode.js"] {
            guard let url = bundle.resourceURL?.appendingPathComponent("Web/" + path), let source = try? String(contentsOf: url, encoding: .utf8) else { loaded = false; break }
            runtime?.evaluateScript(source, withSourceURL: url)
            if runtime?.exception != nil { loaded = false; break }
        }
        context = loaded ? runtime : nil
    }

    private func call(_ object: String, _ method: String, _ arguments: [Any]) -> JSValue? {
        guard let context else { return nil }; context.exception = nil
        let result = context.objectForKeyedSubscript(object)?.invokeMethod(method, withArguments: arguments)
        return context.exception == nil ? result : nil
    }
    /// Bind only a fresh, fully validated public result to the shared scoring
    /// fingerprint. Classification evidence can live in that result without
    /// changing declared source facts; raw transport metadata is never a score.
    func productFacts(_ product: BarcodeProduct, ratingEngine: NativeProductRatingEngine) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(product),
              var facts = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        if let score = ratingEngine.validatedQualityHold(for: product) ?? ratingEngine.validatedDetailedCatalogueScore(for: product),
           let saved = product.catalogueRating,
           let fingerprint = string(call("NudgeFoodDetailModel", "scoreFingerprint", [facts])) {
            facts["scoreResult"] = ["methodId": saved.method, "version": saved.version,
                "inputFingerprint": fingerprint, "result": score, "catalogueValidated": true,
                "catalogueExpiresAt": saved.expiresAt.timeIntervalSince1970 * 1000,
                "catalogueCalculatedAt": saved.calculatedAt.timeIntervalSince1970 * 1000]
        }
        // This display reference is outside typed provider facts and does not
        // rewrite imageURL or invalidate a prepared rating's source snapshot.
        if let image = product.displayImageURL { facts["displayImageURL"] = image }
        return facts
    }
    func canOffer(_ product: [String: Any]) -> Bool {
        guard let score = call("NudgeFoodDetailModel", "score", [product])?.toDictionary() else { return false }
        return category(product) != nil && call("NudgeAlternatives", "canOffer", [score])?.toBool() == true
    }
    func isBelowFifty(_ product: [String: Any]) -> Bool {
        guard let score = call("NudgeFoodDetailModel", "score", [product])?.toDictionary(),
              let supported = call("NudgeAlternatives", "supportedScore", [score])?.toDictionary(),
              let upper = supported["upper"] as? NSNumber else { return false }
        return upper.doubleValue < 50
    }
    func category(_ product: [String: Any]) -> String? { string(call("NudgeAlternatives", "category", [product])) }
    func retailer(_ product: [String: Any]) -> String? { string(call("NudgeAlternatives", "retailer", [product])) }
    private func string(_ result: JSValue?) -> String? {
        guard let result, result.isString else { return nil }; return result.toString()
    }
    func select(current: [String: Any], candidates: [[String: Any]], profile: [String: Any], avoidMilk: Bool, selectedStore: ProductSearchStore? = nil) -> [[String: Any]] {
        var options: [String: Any] = ["profile": profile, "avoidMilk": avoidMilk]
        if let selectedStore { options["preferredRetailer"] = selectedStore.title }
        return call("NudgeAlternatives", "select", [current, Array(candidates.prefix(40)), options])?.toArray() as? [[String: Any]] ?? []
    }
    func assess(product: [String: Any], response: [String: Any]) -> [String: Any] {
        var facts = product
        if (facts["packSize"] as? String ?? "").isEmpty {
            facts["packSize"] = product["quantity"]
            if (facts["packSize"] as? String ?? "").isEmpty,
               let amount = product["packAmount"] as? NSNumber, let unit = product["packUnit"] as? String, ["g", "ml"].contains(unit) {
                facts["packSize"] = "\(amount) \(unit)"
            }
        }
        if facts["batchCode"] == nil { facts["batchCode"] = (product["metadata"] as? [String: Any])?["batchCode"] }
        return call("NudgeFoodEvidence", "assessRecalls", [facts, response])?.toDictionary() as? [String: Any]
            ?? ["status": "check_unavailable", "message": "Recall check unavailable. Check the current official notices.", "matches": []]
    }

    nonisolated static func matchesScope(_ product: [String: Any], selectedStore: ProductSearchStore?) -> Bool {
        guard (product["countriesTags"] as? [String] ?? []).contains("en:united-kingdom") else { return false }
        return selectedStore.map { store in
            (product["stores"] as? [String] ?? []).contains(where: store.contains(sourceStore:))
        } ?? true
    }

    nonisolated static func identity(product: [String: Any], profile: [String: Any], avoidMilk: Bool, selectedStore: ProductSearchStore? = nil) -> String {
        let facts = product.filter { $0.key != "recallAssessment" }
        guard JSONSerialization.isValidJSONObject([facts, profile]), let data = try? JSONSerialization.data(withJSONObject: [facts, profile, avoidMilk, selectedStore?.rawValue ?? "all-uk"], options: [.sortedKeys]), let value = String(data: data, encoding: .utf8) else { return "invalid" }
        return value
    }
    nonisolated static func officialNoticeURL(_ value: Any?) -> URL? {
        guard let raw = value as? String, let url = URL(string: raw), url.scheme == "https", url.host == "alerts.food.gov.uk", url.user == nil, url.password == nil, url.port == nil else { return nil }
        return url
    }
    nonisolated static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}
