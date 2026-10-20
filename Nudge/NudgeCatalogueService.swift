import CoreFoundation
import Foundation

enum ProductSupportContext: String, CaseIterable, Codable, Identifiable {
    case period, follicular, ovulation, luteal, perimenopause, postmenopause
    var id: String { rawValue }
    var title: String {
        switch self {
        case .period: "Period"
        case .follicular: "Follicular phase"
        case .ovulation: "Around ovulation"
        case .luteal: "Luteal phase"
        case .perimenopause: "Perimenopause"
        case .postmenopause: "Postmenopause"
        }
    }
    var explanation: String {
        switch self {
        case .follicular, .ovulation:
            "Everyday nutrition ideas, also useful throughout the cycle. These foods are not specific to this phase."
        default:
            "Food ideas based on nutrition and developing research. A match is a candidate to explore, not a promise of symptom relief."
        }
    }
}

/// Public research annotations are kept outside the scored product snapshot.
/// A tag never changes the product's nutrition rating or the user's profile.
struct ProductSupportCoverage: Codable, Equatable {
    let version: String
    let processed: Int
    let total: Int
    let complete: Bool
    var isValid: Bool { !version.isEmpty && version.count <= 120 && processed >= 0 && total >= processed }
    var summary: String {
        complete ? "Catalogue checked: \(processed.formatted()) products. Matches are research candidates."
            : "\(processed.formatted()) of \(total.formatted()) catalogue products checked. More food ideas may appear as this continues."
    }
}

struct ProductSupportTag: Codable, Equatable, Identifiable {
    struct Source: Codable, Equatable, Identifiable {
        let id: String
        let title: String
        let url: String
        var safeURL: URL? {
            guard let value = URL(string: url), value.scheme?.lowercased() == "https",
                  value.host != nil, value.user == nil, value.password == nil else { return nil }
            return value
        }
    }
    let id: String
    let label: String
    let contexts: [String]
    let evidence: String
    let evidenceDirection: String
    let wording: String
    let foodDataConfidence: String
    let foodFamilies: [String]
    let sources: [Source]
    let limitations: [String]

    var evidenceLabel: String {
        switch evidence {
        case "established", "established_general", "established_nutrition": "Established nutrition; timing may be indirect"
        case "moderate": "Moderate evidence"
        case "emerging", "early_food_trial", "limited", "limited_food_evidence": "Limited food evidence"
        case "low": "Low-certainty evidence"
        case "very_low": "Very low-certainty evidence"
        case "plausible", "indirect", "hypothesis", "mechanistic", "plausible_indirect": "Possible fit · indirect evidence"
        case "research_only": "Research hypothesis · unconfirmed"
        case "mixed", "mixed_null": "Mixed or inconclusive evidence"
        default: "Research candidate · \(evidence.replacingOccurrences(of: "_", with: " "))"
        }
    }
    var directionLabel: String? {
        switch evidenceDirection {
        case "null", "no_clear_benefit", "mixed_null", "mixed_or_null": "Studies include no clear benefit."
        case "mixed", "inconsistent": "Study findings are mixed."
        case "conditional": "Any benefit depends on the circumstances."
        case "very_preliminary": "Evidence is very preliminary."
        case "supportive_with_tolerance_cost": "Some supportive findings, with tolerability limitations."
        default: nil
        }
    }
    var foodDataLabel: String {
        switch foodDataConfidence {
        case "source_reported_nutrients": "Matched using nutrients reported by the product source."
        case "source_reported_identity": "Matched using the product’s reported food type or ingredients."
        default: "Product match needs review."
        }
    }
    var isValid: Bool {
        func bounded(_ text: String, _ limit: Int) -> Bool {
            !text.isEmpty && text.count <= limit && !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        }
        return bounded(id, 120) && bounded(label, 160) && bounded(wording, 1600)
            && bounded(evidence, 80) && bounded(evidenceDirection, 80) && bounded(foodDataConfidence, 100)
            && !contexts.isEmpty && contexts.count <= 6 && contexts.allSatisfy { ProductSupportContext(rawValue: $0) != nil }
            && foodFamilies.count <= 30 && foodFamilies.allSatisfy { bounded($0, 120) }
            && sources.count <= 15 && sources.allSatisfy { bounded($0.id, 120) && bounded($0.title, 300) && $0.url.count <= 2048 && $0.safeURL != nil }
            && limitations.count <= 20 && limitations.allSatisfy { bounded($0, 1600) }
    }
}

/// Reads Nudge's shared catalogue of public source facts. No diary, profile,
/// photos or account identifier is included in a search or barcode body.
struct NudgeCatalogueService {
    struct Authorization {
        let baseURL: URL
        let token: String
        var isCurrent: () async -> Bool = { true }
    }

    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 8
        return URLSession(configuration: configuration)
    }()

    var session: URLSession = Self.session
    var now: () -> Date = Date.init
    var authorization: () async throws -> Authorization = Self.liveAuthorization
    var diagnostics: AnalysisDiagnostics? = .shared

    /// Optional public popular-food seed. It is never allowed to replace a
    /// user's recent facts, or to reset the source retrieval/expiry clock.
    static func bootstrapPopularCache(bundle: Bundle = .main, cache: ProductLookupCache = .shared,
                                      at date: Date = Date()) async {
        guard let url = bundle.url(forResource: "NudgeCatalogueSeed", withExtension: "json") else { return }
        await Task.detached(priority: .utility) {
            let existing = (try? FileManager.default.contentsOfDirectory(at: cache.directory,
                includingPropertiesForKeys: nil)) ?? []
            guard !existing.contains(where: { $0.pathExtension == "json" }),
                  let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 8_000_000,
                  let bytes = try? Data(contentsOf: url),
                  let blocks = try? JSONSerialization.jsonObject(with: bytes) as? [[String: Any]], blocks.count <= 10 else { return }
            for block in blocks {
                guard !Task.isCancelled, let records = try? products(block, at: date) else { continue }
                for product in records where product.catalogueSourceExpiresAt.map({ $0 > date }) ?? false {
                    // A live scan may have populated this barcode during parsing.
                    if cache.read(barcode: product.barcode, now: date) == nil { cache.write(product, now: date) }
                }
            }
        }.value
    }

    private static func liveAuthorization() async throws -> Authorization {
        let manager = await NudgeAccountManager.shared
        let revision = await manager.revision
        let account = try await manager.authorization()
        let configuration: BackendConfiguration
        if let account { configuration = BackendConfiguration(baseURL: account.backendURL, token: account.token) }
        else if let saved = BackendCredentialStore.configuration() { configuration = saved }
        else { throw ProductSearchError.unavailable }
        try Task.checkCancellation()
        guard await manager.revision == revision else { throw CancellationError() }
        return Authorization(baseURL: configuration.baseURL, token: configuration.token,
                             isCurrent: { await manager.revision == revision })
    }

    func search(_ query: ProductSearchQuery) async throws -> ProductSearchPage {
        var body: [String: Any] = ["market": query.market == .unitedKingdom ? "unitedKingdom" : "allCountries",
            "page": query.page, "pageSize": ProductSearchQuery.pageSize, "sort": query.sortOrder.rawValue]
        // Aggregate catalogue censuses are not needed to render ordinary rows.
        // Scoped place/support pages retain their required evidence coverage.
        if query.placeID == nil && query.supportContext == nil { body["includeCoverage"] = false }
        if !query.text.isEmpty { body["query"] = query.text }
        if query.prefixMatch, !query.text.isEmpty { body["prefixMatch"] = true }
        if let category = query.category { body["aisle"] = category.id }
        if let placeID = query.placeID {
            guard SearchPlace.all.contains(where: { $0.id == placeID }) else { throw ProductSearchError.invalidQuery }
            body["placeID"] = placeID
        } else if let store = query.store { body["store"] = store.rawValue }
        if let context = query.supportContext { body["supportContext"] = context.rawValue }
        if !query.dietary.isEmpty { body["dietary"] = query.dietary.map(\.rawValue).sorted() }
        if !query.nutrition.isEmpty { body["nutrition"] = query.nutrition.map(\.rawValue).sorted(); body["nutritionMode"] = query.nutritionMode.rawValue }
        let response = try await request(path: "v1/products/search", route: "catalogue_search", body: body)
        let parsingStarted = now()
        guard let root = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              integer(root["page"]) == query.page, let hasMore = boolean(root["hasMore"]) else {
            throw ProductSearchError.invalidResponse
        }
        var products = try Self.products(root, at: now(), trustedBackendURL: response.backendURL).filter { product in
            query.matchesScope(product) && (query.category.map { !Set($0.tags).isDisjoint(with: product.categories) } ?? true)
        }
        let places = try Self.placeMetadata(root, products: products, selectedID: query.placeID)
        let support = try Self.supportMetadata(root, barcodes: Set(products.map(\.barcode)), required: query.supportContext != nil)
        if let context = query.supportContext {
            products = products.filter { support.tags[$0.barcode]?.contains(where: { $0.contexts.contains(context.rawValue) }) == true }
        }
        var page = ProductSearchPage(query: query, products: products, hasMore: hasMore)
        page.total = integer(root["total"])
        page.placeCoverage = places.coverage
        page.placeEvidence = places.evidence
        if let discovery = root["discovery"] as? [String: Any], let excluded = discovery["excludedDietary"] as? [String: Any] {
            page.dietaryConflictCount = integer(excluded["conflicting"]).flatMap { $0 >= 0 ? $0 : nil }
            page.dietaryUnknownCount = integer(excluded["unconfirmed"]).flatMap { $0 >= 0 ? $0 : nil }
        }
        if let discovery = root["discovery"] as? [String: Any], let coverage = discovery["coverage"] as? [String: Any],
           let data = try? JSONSerialization.data(withJSONObject: coverage),
           let decoded = try? JSONDecoder().decode(ProductSupportCoverage.self, from: data), decoded.isValid { page.discoveryCoverage = decoded }
        page.supportCoverage = support.coverage
        page.supportTags = support.tags
        page.stale = products.contains { $0.catalogueSourceExpiresAt.map({ $0 <= now() }) ?? false }
        page.catalogueCoverage = (root["catalogue"] as? [String: Any])?["complete"] as? Bool == true ? "complete" : "partial"
        diagnostics?.record(stage: "native_parse", outcome: "parsed", metadata: ["sourceRoute": "catalogue_search",
            "elapsedMs": max(0, Int(now().timeIntervalSince(parsingStarted) * 1000)),
            "responseBytes": response.data.count, "productCount": products.count])
        return page
    }

    static func placeMetadata(_ root: [String: Any], products: [BarcodeProduct], selectedID: String?)
        throws -> (coverage: ProductSupportCoverage?, evidence: [String: ProductPlaceEvidence]) {
        guard let selectedID else { return (nil, [:]) }
        guard let place = SearchPlace.all.first(where: { $0.id == selectedID }),
              let metadata = root["places"] as? [String: Any],
              let selected = metadata["selected"] as? [String: Any], selected["id"] as? String == selectedID,
              selected["title"] as? String == place.title,
              selected["groups"] as? [String] == place.groups.map(\.rawValue),
              boolean(selected["menuAvailable"]) == false,
              let rawCoverage = metadata["coverage"] as? [String: Any], let coverageData = try? JSONSerialization.data(withJSONObject: rawCoverage),
              let coverage = try? JSONDecoder().decode(ProductSupportCoverage.self, from: coverageData), coverage.isValid,
              let rawEvidence = metadata["evidence"] as? [[String: Any]], rawEvidence.count <= ProductSearchQuery.pageSize,
              let evidenceData = try? JSONSerialization.data(withJSONObject: rawEvidence), evidenceData.count <= 200_000,
              let rows = try? JSONDecoder().decode([ProductPlaceEvidence].self, from: evidenceData),
              Set(rows.map(\.barcode)).count == rows.count,
              rows.allSatisfy({ $0.isValid && $0.version == coverage.version }),
              rawEvidence.allSatisfy({ $0["source"] as? String == "Open Food Facts" && boolean($0["menuAvailable"]) == false && boolean($0["stockConfirmed"]) == false }) else {
            throw ProductSearchError.invalidResponse
        }
        let evidence = Dictionary(uniqueKeysWithValues: rows.map { ($0.barcode, $0) })
        guard products.allSatisfy({ product in
            guard let association = evidence[product.barcode]?.association(for: selectedID, product: product) else { return false }
            return !association.isCandidate && association.confidence == "source_metadata"
        }) else { throw ProductSearchError.invalidResponse }
        return (coverage, evidence.filter { item in products.contains { $0.barcode == item.key } })
    }

    static func supportMetadata(_ root: [String: Any], barcodes: Set<String>, required: Bool)
        throws -> (coverage: ProductSupportCoverage?, tags: [String: [ProductSupportTag]]) {
        struct Row: Decodable { let barcode: String; let tags: [ProductSupportTag] }
        // JSON null and scalar metadata are unknown, never serializable object roots.
        // Foundation raises an Objective-C exception for those roots; try? cannot catch it.
        guard let rawCoverage = root["support"] as? [String: Any],
              let rawTags = root["supportTags"] as? [[String: Any]] else {
            if required { throw ProductSearchError.invalidResponse }
            return (nil, [:])
        }
        guard let coverageData = try? JSONSerialization.data(withJSONObject: rawCoverage),
              let coverage = try? JSONDecoder().decode(ProductSupportCoverage.self, from: coverageData), coverage.isValid,
              let tagData = try? JSONSerialization.data(withJSONObject: rawTags), tagData.count <= 700_000,
              let rows = try? JSONDecoder().decode([Row].self, from: tagData), rows.count <= 20,
              Set(rows.map(\.barcode)).count == rows.count,
              rows.allSatisfy({ $0.tags.count <= 40 && $0.tags.allSatisfy(\.isValid) && Set($0.tags.map(\.id)).count == $0.tags.count }) else {
            if required { throw ProductSearchError.invalidResponse }
            return (nil, [:])
        }
        guard !required || barcodes.isSubset(of: Set(rows.map(\.barcode))) else { throw ProductSearchError.invalidResponse }
        return (coverage, Dictionary(uniqueKeysWithValues: rows.filter { barcodes.contains($0.barcode) }.map { ($0.barcode, $0.tags) }))
    }

    func batch(_ codes: [String]) async throws -> [BarcodeProduct] {
        guard codes.count <= 20, Set(codes).count == codes.count,
              codes.allSatisfy({ $0.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil }) else {
            throw BarcodeLookupError.invalidBarcode
        }
        guard !codes.isEmpty else { return [] }
        let response = try await request(path: "v1/products/batch", route: "catalogue_batch", body: ["codes": codes])
        guard let root = try JSONSerialization.jsonObject(with: response.data) as? [String: Any] else {
            throw ProductSearchError.invalidResponse
        }
        let allowed = Set(codes)
        let products = try Self.products(root, at: now(), trustedBackendURL: response.backendURL).filter { allowed.contains($0.barcode) }
        // Only a verified empty wire batch proves that a barcode is missing.
        // Invalid/nonmatching records must not open the new-product flow.
        if products.isEmpty, let records = root["products"] as? [[String: Any]], !records.isEmpty {
            throw ProductSearchError.invalidResponse
        }
        return products
    }

    func alternatives(category: String, store: ProductSearchStore?) async throws -> [BarcodeProduct] {
        guard FoodAlternatives.validCategory(category) else { throw ProductSearchError.invalidQuery }
        var body: [String: Any] = ["categoryTags": [category], "market": "unitedKingdom",
                                  "page": 1, "pageSize": 20, "sort": "ratingHighest", "includeCoverage": false]
        if let store { body["store"] = store.rawValue }
        var products: [BarcodeProduct] = []
        // A single twenty-product page can consist of the scanned pack and
        // duplicates/unsuitable variants. Read one further bounded page before
        // applying the shared nutrition and dietary comparison rules.
        for page in 1...2 {
            body["page"] = page
            do {
                let response = try await request(path: "v1/products/search", route: "catalogue_search", body: body)
                guard let root = try JSONSerialization.jsonObject(with: response.data) as? [String: Any] else { throw ProductSearchError.invalidResponse }
                products += try Self.products(root, at: now(), trustedBackendURL: response.backendURL)
                if root["hasMore"] as? Bool != true { break }
            } catch {
                if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
                if page == 1 { throw error }
                break // Keep the successful first page if an optional second page fails.
            }
        }
        var seen = Set<String>()
        return products.filter { product in
            seen.insert(product.barcode).inserted &&
            product.categories.contains(category) && product.countriesTags.contains("en:united-kingdom")
                && (store.map { chosen in product.stores.contains(where: chosen.contains(sourceStore:)) } ?? true)
        }
    }

    private final class ResponseTiming: @unchecked Sendable {
        private let lock = NSLock()
        private var headersAt: Date?
        func received(at date: Date) { lock.lock(); defer { lock.unlock() }; headersAt = date }
        func metadata(start: Date, end: Date) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            guard let headersAt else { return [:] }
            return ["responseHeadersMs": max(0, Int(headersAt.timeIntervalSince(start) * 1000)),
                    "downloadMs": max(0, Int(end.timeIntervalSince(headersAt) * 1000))]
        }
    }

    private func request(path: String, route: String, body: [String: Any]) async throws -> (data: Data, backendURL: URL) {
        let began = now()
        let credentials = try await authorization()
        try Task.checkCancellation()
        guard await credentials.isCurrent() else { throw CancellationError() }
        let authorizedAt = now()
        var request = URLRequest(url: credentials.baseURL.appendingPathComponent(path),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let networkStarted = now(), timing = ResponseTiming()
        do {
            let (data, response) = try await BoundedHTTPData.load(request, session: session, maximumBytes: 3_000_000,
                onResponse: { _ in timing.received(at: now()) })
            let receivedAt = now()
            try Task.checkCancellation()
            guard await credentials.isCurrent() else { throw CancellationError() }
            var metadata: [String: Any] = ["sourceRoute": route,
                "requestSent": true, "httpStatus": response.statusCode, "responseBytes": data.count,
                "authorizationMs": max(0, Int(authorizedAt.timeIntervalSince(began) * 1000)),
                "networkMs": max(0, Int(receivedAt.timeIntervalSince(networkStarted) * 1000)),
                "elapsedMs": max(0, Int(now().timeIntervalSince(began) * 1000))]
            metadata.merge(timing.metadata(start: networkStarted, end: receivedAt)) { _, new in new }
            diagnostics?.record(stage: "search_http", outcome: "received", metadata: metadata)
            guard response.statusCode == 200 else { throw ProductSearchError.unavailable }
            return (data, credentials.baseURL)
        } catch {
            if error is CancellationError || Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            if let known = error as? ProductSearchError { throw known }
            if error is BoundedHTTPData.Failure { throw ProductSearchError.invalidResponse }
            if let error = error as? URLError {
                if error.code == .timedOut { throw ProductSearchError.timeout }
                if [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code) {
                    throw ProductSearchError.offline
                }
            }
            throw ProductSearchError.unavailable
        }
    }

    static func products(_ root: [String: Any], at date: Date, trustedBackendURL: URL? = nil) throws -> [BarcodeProduct] {
        guard root["version"] as? String == "nudge-catalogue-index-v1",
              let records = root["products"] as? [[String: Any]], records.count <= 20,
              let ratings = root["ratings"] as? [[String: Any]], ratings.count <= 20 else {
            throw ProductSearchError.invalidResponse
        }
        let metadata = Dictionary(grouping: ratings, by: { $0["barcode"] as? String ?? "" })
        let identities = Dictionary(grouping: records, by: { $0["code"] as? String ?? "" })
        return records.compactMap { record in
            guard let code = record["code"] as? String, identities[code]?.count == 1,
                  let entries = metadata[code], entries.count == 1, let entry = entries.first,
                  let fetched = timestamp(entry["fetchedAt"]), let expires = timestamp(entry["expiresAt"]),
                  fetched <= date.addingTimeInterval(60), expires > fetched,
                  expires > date || entry["freshness"] as? String == "stale",
                  expires.timeIntervalSince(fetched) <= 31 * 86_400,
                  let bytes = try? JSONSerialization.data(withJSONObject: ["product": record]),
                  var product = try? OpenFoodFactsParser.parse(data: bytes, barcode: code, retrievedAt: fetched) else { return nil }
            product.catalogueSourceExpiresAt = expires
            if let fingerprint = entry["sourceFingerprint"] as? String, fingerprint.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil { product.catalogueSourceFingerprint = fingerprint }
            let recordRevision = integer(record["last_modified_t"]), revision = integer(entry["sourceRevision"])
            guard (record["last_modified_t"] == nil || record["last_modified_t"] is NSNull || recordRevision != nil),
                  recordRevision == revision,
                  recordRevision.map({ Double($0) <= date.timeIntervalSince1970 }) ?? true else { return nil }
            // OFF-shaped transport fields are also used for reviewed Nudge
            // facts. The wire shape alone must never grant OFF provenance.
            if entry["sourceKind"] as? String == "nudge_community" {
                guard let trustedBackendURL, let origin = ProductCommunityProvenance.origin(trustedBackendURL),
                      entry["sourceName"] as? String == "Nudge community",
                      entry["sourceURL"] as? String == origin + "/v1/products/reviewed/" + code,
                      entry["discoveryScope"] as? String == "barcode_only",
                      let observed = timestamp(entry["observedAt"]), observed.timeIntervalSince1970 > 0,
                      let reviewed = timestamp(entry["reviewedAt"]), observed <= reviewed, reviewed == fetched,
                      revision == Int(reviewed.timeIntervalSince1970), reviewed <= date.addingTimeInterval(60) else { return nil }
                product.sourceKind = "nudge_community"
                product.communityProvenance = .init(backendOrigin: origin, observedAt: observed, reviewedAt: reviewed)
                product.sourceName = "Nudge community"
                product.sourceURL = origin + "/v1/products/reviewed/" + code
                product.licenceName = ""; product.licenceURL = ""
                product.countriesTags = []; product.stores = []; product.retailer = nil
                product.imageURL = nil // Contribution photographs are private.
                product.nutrientSources = product.nutrientSources.mapValues { _ in "Nudge community: reviewed packaging photograph" }
                if product.servingNutrientSource != nil {
                    product.servingNutrientSource = ["title": "Nudge community: reviewed per-serving label values",
                        "url": product.sourceURL, "basis": "entered_per_serving"]
                }
                // Community photos do not establish an official provider score.
                product.nutriScoreGrade = nil; product.nutriScore2023 = nil; product.providerNutriScore = nil; product.scoringFacts = nil
            } else if let kind = entry["sourceKind"], !(kind is NSNull), kind as? String != "open_food_facts" { return nil }
            if let method = entry["method"] as? String, let version = entry["version"] as? String,
               let classifier = entry["classifierVersion"] as? String,
               let calculated = timestamp(entry["calculatedAt"]), calculated <= date.addingTimeInterval(60),
               calculated >= fetched, let score = entry["score"] as? [String: Any],
               let scoreData = try? JSONSerialization.data(withJSONObject: score), scoreData.count <= 32_768,
               let fingerprint = ProductCatalogueRating.fingerprint(product) {
                product.catalogueRating = ProductCatalogueRating(method: method, version: version,
                    classifierVersion: classifier, sourceRevision: revision, fetchedAt: fetched, expiresAt: expires,
                    calculatedAt: calculated, snapshotFingerprint: fingerprint, scoreData: scoreData)
                if score["catalogueQualityHold"] != nil {
                    product.catalogueRating?.qualityHoldOrigin = trustedBackendURL.flatMap(ProductCommunityProvenance.origin)
                    if product.catalogueRating?.qualityHold(for: product, at: date) == nil { product.catalogueRating = nil }
                }
            }
            return product
        }
    }

    private static func timestamp(_ raw: Any?) -> Date? {
        guard let milliseconds = integer(raw) else { return nil }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    }
    private static func integer(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue < Double(Int.max), number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.intValue
    }
    private func integer(_ raw: Any?) -> Int? { Self.integer(raw) }
    private static func boolean(_ raw: Any?) -> Bool? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    private func boolean(_ raw: Any?) -> Bool? { Self.boolean(raw) }
}
