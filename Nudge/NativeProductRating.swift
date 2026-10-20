import Combine
import CoreFoundation
import Foundation
import JavaScriptCore

struct NativeProductRating: Equatable {
    let value: Int?
    let subtitle: String
    var tone: NativeProductRatingTone { NativeProductRatingTone(value: value) }
}

/// Display bands: below 25 red, 25–49 orange, and 50 or above green.
/// The badge uses bright, fixed fills with dark
/// text, so neither dark mode nor a provider's grade changes its meaning.
enum NativeProductRatingTone: Equatable {
    case red, amber, green, unknown
    init(value: Int?) {
        guard let value, (0...100).contains(value) else { self = .unknown; return }
        self = value < 25 ? .red : value < 50 ? .amber : .green
    }
    var label: String {
        switch self {
        case .red: "Red"
        case .amber: "Orange"
        case .green: "Green"
        case .unknown: "Not rated"
        }
    }
    var fill: UInt32 {
        switch self {
        case .red: 0xFF6574
        case .amber: 0xFF9F43
        case .green: 0xA8DC00 // Home plant-variety ring.
        case .unknown: 0xDFE4EF
        }
    }
}

/// Runs the same bundled, deterministic product calculator used by the detail
/// screen. No WebView, network, account state or second scoring formula.
@MainActor
final class NativeProductRatingEngine {
    private let context: JSContext?
    private let catalogue: ProductLookupCache?
    private let catalogueRead: ((String, Date) -> BarcodeProduct?)?
    private let now: () -> Date
    var recoveredScore: ((BarcodeProduct) -> [String: Any]?)?
    private struct CachedRating { let product: BarcodeProduct; let rating: NativeProductRating }
    private var cache: [String: CachedRating] = [:]

    init(bundle: Bundle = .main, catalogue: ProductLookupCache? = .shared, now: @escaping () -> Date = Date.init,
         catalogueRead: ((String, Date) -> BarcodeProduct?)? = nil) {
        self.catalogue = catalogue
        self.catalogueRead = catalogueRead
        self.now = now
        let runtime = JSContext()
        runtime?.evaluateScript("var window = globalThis;")
        var loaded = runtime != nil
        for path in ["core/nudge-score.js", "core/meal-score.js", "food-detail-model.js"] {
            guard let url = bundle.resourceURL?.appendingPathComponent("Web/" + path),
                  let script = try? String(contentsOf: url, encoding: .utf8) else { loaded = false; break }
            runtime?.evaluateScript(script, withSourceURL: url)
            if runtime?.exception != nil { loaded = false; break }
        }
        context = loaded ? runtime : nil
    }

    /// A discovery index is not an exact-product nutrition record. Its numeric
    /// fields omit preparation and inequalities; an unversioned provider letter
    /// cannot repair that missing evidence. Hydrate only when no current full record or safe
    /// index calculation exists, including when a full record remains unrated.
    func fullProductRequired(for product: BarcodeProduct) -> Bool {
        guard product.searchProvider != nil else { return false }
        return assessment(for: product).requiresFullProduct
    }

    nonisolated static func isCurrentFullProduct(_ full: BarcodeProduct, for snapshot: BarcodeProduct) -> Bool {
        guard full.barcode == snapshot.barcode, full.searchProvider == nil, full.hasTrustedCatalogueSource else { return false }
        guard let changed = snapshot.lastModifiedAt else { return true }
        func date(_ raw: String) -> Date? {
            let formatter = ISO8601DateFormatter()
            if let value = formatter.date(from: raw) { return value }
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: raw)
        }
        guard let changedAt = date(changed) else { return false }
        // A newly downloaded response can still contain an older catalogue
        // record. A retrieval timestamp cannot replace its modification time.
        guard let modified = full.lastModifiedAt, let verifiedAt = date(modified) else { return false }
        return verifiedAt >= changedAt
    }

    private func cachedFullProduct(for product: BarcodeProduct) -> BarcodeProduct? {
        let current: BarcodeProduct?
        if let catalogueRead { current = catalogueRead(product.barcode, now()) }
        else { current = catalogue?.read(barcode: product.barcode, now: now(), allowStale: true) }
        guard let current,
              current.hasCurrentScoringSource,
              Self.isCurrentFullProduct(current, for: product) else { return nil }
        return current
    }

    private func preferredFullProduct(_ candidate: BarcodeProduct, over existing: BarcodeProduct) -> BarcodeProduct {
        guard Self.isCurrentFullProduct(candidate, for: existing) else { return existing }
        // Source revision takes precedence over score age. Recalculating an
        // older label cannot make it replace a newer label's facts.
        guard Self.isCurrentFullProduct(existing, for: candidate) else { return candidate }
        guard candidate != existing else { return existing }
        // Equal source revisions can acquire usable provider evidence after a
        // parser correction, without receiving a precomputed catalogue score.
        if candidate.hasCurrentScoringSource != existing.hasCurrentScoringSource {
            return candidate.hasCurrentScoringSource ? candidate : existing
        }
        // A newer publication can also withdraw a previously available score.
        // Compare source-bound publications before asking whether either has a
        // number, so revoked/expired enrichment cannot survive on an old card.
        let candidatePublication = validatedCataloguePublication(for: candidate)
        let existingPublication = validatedCataloguePublication(for: existing)
        if candidate.catalogueSourceFingerprint != nil, candidate.catalogueSourceFingerprint == existing.catalogueSourceFingerprint {
            if validatedQualityHold(for: candidate) != nil { return candidate }
            if validatedQualityHold(for: existing) != nil { return existing }
        }
        if candidatePublication != nil, existingPublication != nil,
           let candidateRating = candidate.catalogueRating, let existingRating = existing.catalogueRating,
           candidateRating.calculatedAt != existingRating.calculatedAt {
            return candidateRating.calculatedAt > existingRating.calculatedAt ? candidate : existing
        }
        let candidateScore = candidatePublication.map { Self.presentation($0).value != nil && (candidate.catalogueRating?.effectiveExpiresAt ?? .distantPast) > now() } ?? false
        let existingScore = existingPublication.map { Self.presentation($0).value != nil && (existing.catalogueRating?.effectiveExpiresAt ?? .distantPast) > now() } ?? false
        if candidateScore != existingScore { return candidateScore ? candidate : existing }
        if candidateScore, let candidateRating = candidate.catalogueRating, let existingRating = existing.catalogueRating,
           candidateRating.calculatedAt != existingRating.calculatedAt {
            return candidateRating.calculatedAt > existingRating.calculatedAt ? candidate : existing
        }
        // Equal/undated source records without a newer validated score retain
        // the caller's record. A phone-cache read must not hide incoming facts.
        return existing
    }

    func rating(for product: BarcodeProduct) -> NativeProductRating {
        rating(for: product, fullProduct: nil)
    }

    /// The card and detail opener must choose the same public fact snapshot.
    /// This does not update the catalogue or any user-owned record.
    func preferredProduct(for product: BarcodeProduct, fullProduct: BarcodeProduct? = nil) -> BarcodeProduct {
        let recovered = fullProduct.flatMap { Self.isCurrentFullProduct($0, for: product) ? $0 : nil }
        let current = cachedFullProduct(for: product)
        // A later scan/detail lookup may have refreshed the durable catalogue.
        // Do not let this screen's earlier hydration hide those newer facts.
        var selected = Self.isCurrentFullProduct(product, for: product) ? product : nil
        for candidate in [recovered, current].compactMap({ $0 }) {
            selected = selected.map { preferredFullProduct(candidate, over: $0) } ?? candidate
        }
        var result = selected ?? product
        for pictureSource in [product, recovered, current].compactMap({ $0 }) {
            result = result.retainingPublicImage(from: pictureSource)
        }
        return result
    }

    func rating(for product: BarcodeProduct, fullProduct: BarcodeProduct?) -> NativeProductRating {
        assessment(for: product, fullProduct: fullProduct).rating
    }

    struct Assessment {
        let rating: NativeProductRating
        let requiresFullProduct: Bool
    }

    /// Select and validate the current public facts once for both the badge and
    /// hydration decision. Incomplete cards previously reread the cache up to
    /// three times while rendering, before any network request had even begun.
    func assessment(for product: BarcodeProduct, fullProduct: BarcodeProduct? = nil) -> Assessment {
        let selected = preferredProduct(for: product, fullProduct: fullProduct)
        if let hold = validatedQualityHold(for: selected) {
            return Assessment(rating: Self.presentation(hold), requiresFullProduct: false)
        }
        let result = ratingForSelectedProduct(selected)
        return Assessment(rating: result, requiresFullProduct: selected.searchProvider != nil && result.value == nil)
    }

    private func ratingForSelectedProduct(_ product: BarcodeProduct) -> NativeProductRating {
        let unknown = NativeProductRating(value: nil, subtitle: "Nutrition incomplete")
        if product.searchProvider != nil,
           !["as_sold", "prepared"].contains(product.nutritionPreparation ?? "") { return unknown }
        // Recovery is held separately from declared label facts. Resolve it
        // before a precomputed or memoized score, using the detail-screen core.
        if let result = recoveredScore?(product) { return Self.presentation(result) }
        // Async cards can rerender frequently. Compare the typed facts before
        // bridging to JSON/JavaScript; a changed record still recalculates.
        if let cached = cache[product.barcode], cached.product == product,
           product.catalogueRating.map({ $0.effectiveExpiresAt > now() }) ?? true { return cached.rating }
        if let prepared = catalogueRating(for: product) {
            if cache.count >= 300 { cache.removeAll(keepingCapacity: true) }
            cache[product.barcode] = CachedRating(product: product, rating: prepared)
            return prepared
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(product),
              let object = try? JSONSerialization.jsonObject(with: data), let context else { return unknown }
        context.exception = nil
        guard let result = context.objectForKeyedSubscript("NudgeFoodDetailModel")?
            .invokeMethod("score", withArguments: [object])?.toDictionary() as? [String: Any], context.exception == nil else { return unknown }
        let rating = Self.presentation(result)
        if cache.count >= 300 { cache.removeAll(keepingCapacity: true) }
        cache[product.barcode] = CachedRating(product: product, rating: rating)
        return rating
    }

    static func presentation(_ result: [String: Any]) -> NativeProductRating {
        let value = (result["value"] as? NSNumber).flatMap { number -> Int? in
            let n = number.doubleValue
            return CFGetTypeID(number) != CFBooleanGetTypeID() && n.isFinite && (0...100).contains(n) ? Int(n.rounded()) : nil
        }
        let status = result["status"] as? String ?? "unrated"
        guard let value, ["rated", "provisional", "estimated", "estimated_provisional"].contains(status) else {
            return .init(value: nil, subtitle: result["scoreBasis"] as? String == "catalogue_quality_hold" ? "Source needs checking" : "Nutrition incomplete")
        }
        if result["methodId"] as? String == "nudge_nutrition_v0_4" { return .init(value: value, subtitle: "Nudge score") }
        let estimated = result["estimated"] as? Bool == true || status.hasPrefix("estimated")
        return .init(value: value, subtitle: estimated ? "Estimated Nudge rating" : status == "provisional" ? "Provisional Nudge rating" : "Nudge rating")
    }

    func validatedDetailedCatalogueScore(for product: BarcodeProduct) -> [String: Any]? {
        guard let result = validatedCatalogueScore(for: product),
              ["rated", "provisional", "estimated", "estimated_provisional"].contains(result["status"] as? String ?? ""),
              context?.objectForKeyedSubscript("NudgeFoodDetailModel")?.invokeMethod("validScoreResult", withArguments: [result])?.toBool() == true else { return nil }
        return result
    }

    private func catalogueRating(for product: BarcodeProduct) -> NativeProductRating? {
        validatedCatalogueScore(for: product).map(Self.presentation)
    }

    private func validatedCatalogueScore(for product: BarcodeProduct) -> [String: Any]? {
        guard let result = validatedCataloguePublication(for: product),
              (product.catalogueRating?.effectiveExpiresAt ?? .distantPast) > now(),
              ["rated", "provisional", "estimated", "estimated_provisional"].contains(result["status"] as? String ?? ""),
              let value = result["value"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, (0...100).contains(value.doubleValue) else { return nil }
        return result
    }

    func validatedCataloguePublication(for product: BarcodeProduct) -> [String: Any]? {
        guard let saved = product.catalogueRating, let context,
              saved.fetchedAt <= now().addingTimeInterval(60), saved.expiresAt > now() || saved.qualityHold(for: product, at: now()) != nil,
              saved.calculatedAt >= saved.fetchedAt, saved.calculatedAt <= now().addingTimeInterval(60),
              saved.snapshotFingerprint == ProductCatalogueRating.fingerprint(product),
              let config = context.objectForKeyedSubscript("NudgeScoreCore")?.objectForKeyedSubscript("CONFIG")?.toDictionary(),
              config["methodId"] as? String == saved.method, config["version"] as? String == saved.version,
              config["classifierVersion"] as? String == saved.classifierVersion,
              let result = try? JSONSerialization.jsonObject(with: saved.scoreData) as? [String: Any] else { return nil }
        if result["catalogueQualityHold"] != nil, saved.qualityHold(for: product, at: now()) == nil { return nil }
        let detailed = result["methodId"] as? String == saved.method
            && result["version"] as? String == saved.version
            && result["classifierVersion"] as? String == saved.classifierVersion
            && context.objectForKeyedSubscript("NudgeFoodDetailModel")?.invokeMethod("validScoreResult", withArguments: [result])?.toBool() == true
        guard detailed else { return nil }
        return result
    }

    func validatedQualityHold(for product: BarcodeProduct) -> [String: Any]? {
        guard product.catalogueRating?.qualityHold(for: product, at: now()) != nil else { return nil }
        return validatedCataloguePublication(for: product)
    }
}

/// Resolves result pages containing visible public-product cards. Search results render immediately;
/// nutrition arrives independently, with no AI call or diary/profile mutation.
@MainActor
final class NativeSearchRatingLoader: ObservableObject {
    typealias Lookup = (BarcodeProduct) async throws -> BarcodeProduct
    typealias BatchLookup = ([BarcodeProduct]) async throws -> [BarcodeProduct]
    @Published private(set) var revision = 0
    private struct Active {
        let token: UUID
        let generation: Int
        let task: Task<Void, Never>
    }
    private let engine: NativeProductRatingEngine
    private let lookup: Lookup
    private let batchLookup: BatchLookup?
    private let now: () -> Date
    private let spacing: TimeInterval
    private let diagnostics: AnalysisDiagnostics?
    private var visible: [String: BarcodeProduct] = [:]
    private var sortingProducts: [String: BarcodeProduct] = [:]
    private var queue: [String] = []
    private var active: [String: Active] = [:]
    private var completed = Set<String>()
    private var failed = Set<String>()
    private var providerRetries = Set<String>()
    private var resolved: [String: BarcodeProduct] = [:]
    private var resolvedAt: [String: Date] = [:]
    private var resolvedOrder: [String] = []
    private var generation = 0
    private var starts: [Date] = []
    private var lastStart = Date.distantPast
    private var cooldownUntil = Date.distantPast
    private var wake: Task<Void, Never>?
    private var suspended = false
    private var loadedProducts: [BarcodeProduct] = []
    private var queuedAt: [String: Date] = [:]
    private var batchTask: Task<Void, Never>?
    private var batchToken: UUID?
    private var batchBarcodes = Set<String>()

    convenience init(engine: NativeProductRatingEngine, service: OpenFoodFactsService = .catalogueConnected) {
        self.init(engine: engine, lookup: { try await service.lookupForSearchRating(snapshot: $0) },
                  batchLookup: { try await service.lookupForSearchRatings(snapshots: $0) },
                  diagnostics: service.searchDiagnostics)
    }

    init(engine: NativeProductRatingEngine, lookup: @escaping Lookup, batchLookup: BatchLookup? = nil,
         now: @escaping () -> Date = Date.init, minimumRequestSpacing: TimeInterval = 4.1,
         diagnostics: AnalysisDiagnostics? = nil) {
        self.engine = engine
        self.lookup = lookup
        self.batchLookup = batchLookup
        self.now = now
        self.spacing = max(0, minimumRequestSpacing)
        self.diagnostics = diagnostics
    }

    deinit {
        wake?.cancel()
        batchTask?.cancel()
        for job in active.values { job.task.cancel() }
    }

    func rating(for product: BarcodeProduct) -> NativeProductRating {
        let assessment = engine.assessment(for: product, fullProduct: currentResolved(for: product))
        let existing = assessment.rating
        guard assessment.requiresFullProduct else { return existing }
        if failed.contains(product.barcode) { return .init(value: nil, subtitle: "Rating unavailable") }
        if cooldownUntil > now() { return .init(value: nil, subtitle: "Rating queued · waiting for source") }
        if active[product.barcode] != nil || batchBarcodes.contains(product.barcode) || queue.contains(product.barcode) {
            return .init(value: nil, subtitle: "Calculating Nudge rating")
        }
        return .init(value: nil, subtitle: "Nudge rating unavailable")
    }

    func evidenceDidChange() {
        // Cards and rating ordering refresh together when detail recovery ends.
        revision += 1
    }

    func appear(_ product: BarcodeProduct) {
        suspended = false
        visible[product.barcode] = product
        enqueue(product)
        pump()
    }

    func disappear(_ product: BarcodeProduct) {
        visible.removeValue(forKey: product.barcode)
        guard sortingProducts[product.barcode] == nil else { return }
        queue.removeAll { $0 == product.barcode }
        if active[product.barcode] == nil && !batchBarcodes.contains(product.barcode) { queuedAt.removeValue(forKey: product.barcode) }
        // A request already in flight can fill the public cache. Scrolling or
        // async reordering should not repeatedly cancel and restart it. Query
        // replacement and leaving Search still cancel through synchronize/reset.
    }

    func synchronize(products: [BarcodeProduct], resolveForSorting: Bool = false) {
        let current = Dictionary(products.map { ($0.barcode, $0) }, uniquingKeysWith: { first, _ in first })
        loadedProducts = products
        if !batchBarcodes.isEmpty, batchBarcodes.isDisjoint(with: current.keys) { invalidateBatch(reason: "query_changed") }
        // Only an explicit rating sort extends the bounded hydration queue to
        // the loaded result set. Otherwise keep requests near visible cards.
        sortingProducts = resolveForSorting ? current : [:]
        for (barcode, previous) in visible {
            guard let product = current[barcode] else { disappear(previous); continue }
            visible[barcode] = product
        }
        for (barcode, job) in active where current[barcode] == nil { job.task.cancel() }
        if resolveForSorting { for product in products { enqueue(product) } }
        pump()
    }

    /// A new submitted search allows a previously failed product to be retried.
    /// Global pacing and provider cooldown survive query/filter changes.
    func reset() {
        generation += 1
        invalidateBatch(reason: "query_changed")
        wake?.cancel(); wake = nil
        for job in active.values { job.task.cancel() }
        completed.removeAll(); failed.removeAll(); providerRetries.removeAll(); queue.removeAll(); queuedAt.removeAll()
        suspended = false
        for product in visible.values { enqueue(product) }
        for product in sortingProducts.values { enqueue(product) }
        revision += 1
        pump()
    }

    func cancel() {
        generation += 1
        invalidateBatch(reason: "screen_left")
        suspended = true
        wake?.cancel(); wake = nil
        for job in active.values { job.task.cancel() }
        visible.removeAll(); sortingProducts.removeAll(); queue.removeAll(); loadedProducts.removeAll(); queuedAt.removeAll()
        revision += 1
    }

    private func currentResolved(for product: BarcodeProduct) -> BarcodeProduct? {
        guard let full = resolved[product.barcode], let storedAt = resolvedAt[product.barcode],
              (0..<(7 * 86_400)).contains(now().timeIntervalSince(storedAt)),
              NativeProductRatingEngine.isCurrentFullProduct(full, for: product) else { return nil }
        return full
    }

    private func enqueue(_ product: BarcodeProduct) {
        let barcode = product.barcode
        if resolved[barcode] != nil, currentResolved(for: product) == nil { completed.remove(barcode) }
        guard !completed.contains(barcode), completed.count < 400,
              !batchBarcodes.contains(barcode),
              !queue.contains(barcode), currentResolved(for: product) == nil,
              engine.fullProductRequired(for: product) else { return }
        queue.append(barcode)
        if queuedAt[barcode] == nil { queuedAt[barcode] = now() }
    }

    private func candidate(_ barcode: String) -> BarcodeProduct? {
        visible[barcode] ?? sortingProducts[barcode]
    }

    private func pump() {
        if batchLookup != nil { pumpBatch(); return }
        guard !suspended, active.count < 2 else { return }
        queue.removeAll { candidate($0) == nil || completed.contains($0) }
        guard let index = queue.firstIndex(where: { active[$0] == nil }) else { return }
        let currentTime = now()
        starts.removeAll { currentTime.timeIntervalSince($0) >= 60 }
        var earliest = max(lastStart.addingTimeInterval(spacing), cooldownUntil)
        // OFF allows 15 product reads/minute/IP. Discovery uses at most 12,
        // leaving headroom for explicit scans; the transport also gates all reads.
        if starts.count >= 12, let first = starts.first { earliest = max(earliest, first.addingTimeInterval(60)) }
        if earliest > currentTime {
            guard wake == nil else { return }
            let delay = min(60, max(0.01, earliest.timeIntervalSince(currentTime)))
            wake = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
                guard let self else { return }
                self.wake = nil
                self.revision += 1
                self.pump()
            }
            return
        }
        let barcode = queue.remove(at: index)
        guard let snapshot = candidate(barcode) else { pump(); return }
        // Recheck after waiting: an opened card or another scan may have already
        // filled the durable public cache. Such hits use no request allowance.
        guard engine.fullProductRequired(for: snapshot) else { revision += 1; pump(); return }
        let owner = generation, token = UUID()
        starts.append(currentTime); lastStart = currentTime
        record("started", token: token)
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let full = try await lookup(snapshot)
                try Task.checkCancellation()
                guard NativeProductRatingEngine.isCurrentFullProduct(full, for: snapshot) else {
                    throw BarcodeLookupError.invalidResponse
                }
                finish(barcode: barcode, token: token, owner: owner, result: .success(full))
            } catch {
                finish(barcode: barcode, token: token, owner: owner, result: .failure(error))
            }
        }
        active[barcode] = Active(token: token, generation: owner, task: task)
        revision += 1
        pump()
    }

    /// A visible card hydrates its result page in one supported exact-code
    /// request. No per-card spacing or individual-request fallback is needed;
    /// the service enforces the shared search allowance and provider pauses.
    private func pumpBatch() {
        guard !suspended, batchTask == nil, let batchLookup else { return }
        queue.removeAll { candidate($0) == nil || completed.contains($0) }
        guard let anchor = queue.first, let anchorProduct = candidate(anchor) else { return }
        if cooldownUntil > now() {
            guard wake == nil else { return }
            let delay = min(60, max(0.01, cooldownUntil.timeIntervalSince(now())))
            wake = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
                guard let self else { return }
                self.wake = nil; self.revision += 1; self.pump()
            }
            return
        }
        let page: [BarcodeProduct]
        if let index = loadedProducts.firstIndex(where: { $0.barcode == anchor }) {
            let start = index / ProductSearchQuery.pageSize * ProductSearchQuery.pageSize
            page = Array(loadedProducts[start..<min(start + ProductSearchQuery.pageSize, loadedProducts.count)])
        } else { page = [anchorProduct] }
        let snapshots = page.filter { !completed.contains($0.barcode) && currentResolved(for: $0) == nil && engine.fullProductRequired(for: $0) }
        guard !snapshots.isEmpty else { queue.removeFirst(); revision += 1; pumpBatch(); return }
        let requested = Set(snapshots.map(\.barcode)), token = UUID(), owner = generation, began = now()
        let wait = max(0, Int(began.timeIntervalSince(queuedAt[anchor] ?? began) * 1000))
        queue.removeAll { requested.contains($0) }
        batchBarcodes = requested; batchToken = token
        batchDiagnostic("started", token: token, metadata: ["batchSize": snapshots.count, "queueWaitMs": wait, "queueDepth": queue.count])
        batchTask = Task { [weak self] in
            guard let self else { return }
            let result: Result<[BarcodeProduct], Error>
            do {
                let records = try await batchLookup(snapshots)
                try Task.checkCancellation()
                result = .success(records)
            } catch { result = .failure(error) }
            finishBatch(snapshots: snapshots, token: token, owner: owner, began: began, queueWait: wait, result: result)
        }
        revision += 1
    }

    private func finishBatch(snapshots: [BarcodeProduct], token: UUID, owner: Int, began: Date, queueWait: Int,
                             result: Result<[BarcodeProduct], Error>) {
        guard batchToken == token, owner == generation else { return }
        batchTask = nil; batchToken = nil; batchBarcodes.removeAll()
        let received = now()
        var metadata: [String: Any] = ["batchSize": snapshots.count, "queueWaitMs": queueWait,
                                      "lookupMs": max(0, Int(received.timeIntervalSince(began) * 1000))]
        switch result {
        case .success(let records):
            let grouped = Dictionary(grouping: records, by: \.barcode)
            var found = 0
            for snapshot in snapshots {
                let code = snapshot.barcode
                completed.insert(code); queuedAt.removeValue(forKey: code)
                guard let matches = grouped[code], matches.count == 1,
                      let full = matches.first, NativeProductRatingEngine.isCurrentFullProduct(full, for: snapshot) else {
                    failed.insert(code); continue
                }
                found += 1; failed.remove(code)
                resolved[code] = full; resolvedAt[code] = now()
                resolvedOrder.removeAll { $0 == code }; resolvedOrder.append(code)
                // Keep the delivered facts ready, but score only cards that are
                // displayed (or explicitly requested by rating sort). A batch
                // commonly includes a whole page beyond the visible rows.
            }
            while resolvedOrder.count > 200 {
                let expired = resolvedOrder.removeFirst()
                resolved.removeValue(forKey: expired); resolvedAt.removeValue(forKey: expired)
                if !failed.contains(expired) { completed.remove(expired) }
            }
            metadata["resolvedCount"] = found; metadata["missingCount"] = snapshots.count - found
            metadata["calculationMs"] = max(0, Int(now().timeIntervalSince(received) * 1000))
            batchDiagnostic("completed", token: token, metadata: metadata)
        case .failure(let error):
            let searchError = error as? ProductSearchError
            let barcodeError = error as? BarcodeLookupError
            var localWait = false
            if case .rateLimited = searchError { localWait = true }
            if case .productReadDeferred = barcodeError { localWait = true }
            let seconds = searchError?.retryAfterSeconds ?? barcodeError?.retryAfterSeconds ?? 0
            let cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
            if seconds > 0 {
                cooldownUntil = max(cooldownUntil, now().addingTimeInterval(Double(seconds)))
                metadata["retryAfterSeconds"] = seconds
                metadata["waitReason"] = localWait ? "read_budget" : "provider_cooldown"
                if let status = searchError?.statusCode { metadata["httpStatus"] = status }
                for snapshot in snapshots {
                    if localWait || providerRetries.insert(snapshot.barcode).inserted {
                        if candidate(snapshot.barcode) != nil { enqueue(snapshot) }
                    } else { completed.insert(snapshot.barcode); failed.insert(snapshot.barcode) }
                }
                batchDiagnostic("deferred", token: token, metadata: metadata)
            } else if cancelled {
                for snapshot in snapshots where candidate(snapshot.barcode) != nil { enqueue(snapshot) }
                metadata["cancelReason"] = "task_cancelled"
                batchDiagnostic("cancelled", token: token, metadata: metadata)
            } else {
                for snapshot in snapshots { completed.insert(snapshot.barcode); failed.insert(snapshot.barcode) }
                // A broken connection must not fan out into every loaded page.
                cooldownUntil = max(cooldownUntil, now().addingTimeInterval(30))
                batchDiagnostic("failed", token: token, metadata: metadata)
            }
        }
        revision += 1
        pumpBatch()
    }

    private func invalidateBatch(reason: String) {
        if let token = batchToken { batchDiagnostic("cancelled", token: token, metadata: ["batchSize": batchBarcodes.count, "cancelReason": reason]) }
        batchTask?.cancel(); batchTask = nil; batchToken = nil; batchBarcodes.removeAll()
    }

    private func batchDiagnostic(_ outcome: String, token: UUID, metadata: [String: Any]) {
        var fields = metadata
        fields["requestHash"] = AnalysisDiagnostics.fingerprint(token.uuidString)
        fields["route"] = "product_score"; fields["screen"] = "search"; fields["ratingPath"] = "batch"
        diagnostics?.record(stage: "rating_batch", outcome: outcome, metadata: fields, now: now())
    }

    private func finish(barcode: String, token: UUID, owner: Int, result: Result<BarcodeProduct, Error>) {
        guard active[barcode]?.token == token else { return }
        active.removeValue(forKey: barcode)
        guard owner == generation else { pump(); return }
        switch result {
        case .success(let full):
            completed.insert(barcode); failed.remove(barcode)
            resolved[barcode] = full; resolvedAt[barcode] = now()
            resolvedOrder.removeAll { $0 == barcode }; resolvedOrder.append(barcode)
            while resolvedOrder.count > 200 {
                let expired = resolvedOrder.removeFirst()
                resolved.removeValue(forKey: expired); resolvedAt.removeValue(forKey: expired)
                if !failed.contains(expired) { completed.remove(expired) }
            }
            record(engine.rating(for: full).value == nil ? "incomplete" : "calculated", token: token)
        case .failure(let error):
            if error is CancellationError || (error as? URLError)?.code == .cancelled {
                record("cancelled", token: token)
                if let product = candidate(barcode) { enqueue(product) }
            } else {
                let failure = error as? BarcodeLookupError
                let localDeferral: Bool
                if case .productReadDeferred = failure { localDeferral = true } else { localDeferral = false }
                let providerThrottle: Bool
                switch failure {
                case .rateLimited, .retryLater: providerThrottle = true
                default: providerThrottle = false
                }
                if localDeferral || providerThrottle {
                    let wait = max(1, failure?.retryAfterSeconds ?? 60)
                    cooldownUntil = max(cooldownUntil, now().addingTimeInterval(Double(wait)))
                    record(failure?.code ?? "rateLimited", token: token, retryAfter: wait,
                           statusCode: providerThrottle ? 429 : nil)
                    // A local budget wait sent no provider request. A real 429
                    // gets one automatic retry per product/submitted query;
                    // another 429 remains unavailable until an explicit retry.
                    if localDeferral || providerRetries.insert(barcode).inserted {
                        if let product = candidate(barcode) { enqueue(product) }
                    } else {
                        completed.insert(barcode); failed.insert(barcode)
                    }
                } else {
                    completed.insert(barcode); failed.insert(barcode)
                    record(failure?.code ?? "unavailable", token: token)
                }
                // A transport/provider failure stops the queue instead of
                // sending the next twenty products into the same failure.
                if !localDeferral && !providerThrottle,
                   ![BarcodeLookupError.notFound, .incompleteProduct, .invalidBarcode, .invalidResponse].contains(where: { $0 == failure }) {
                    cooldownUntil = max(cooldownUntil, now().addingTimeInterval(60))
                }
            }
        }
        revision += 1
        pump()
    }

    private func record(_ outcome: String, token: UUID, retryAfter: Int? = nil, statusCode: Int? = nil) {
        var metadata: [String: Any] = ["route": "product_score", "screen": "search", "operation": "calculate",
                                      "requestHash": AnalysisDiagnostics.fingerprint(token.uuidString)]
        if let retryAfter { metadata["retryAfterSeconds"] = retryAfter }
        if let statusCode { metadata["httpStatus"] = statusCode }
        diagnostics?.record(stage: "catalogue", outcome: outcome,
            metadata: metadata, now: now())
    }
}
