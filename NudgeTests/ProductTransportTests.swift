import Foundation
import XCTest
@testable import Nudge

final class ProductTransportTests: XCTestCase {
    func testPlaceEvidenceRequiresCanonicalIdentityAndExactSourceBinding() throws {
        let date = Date(timeIntervalSince1970: 200_000)
        var root = catalogueFixture(date: date)
        var rating = try XCTUnwrap((root["ratings"] as? [[String: Any]])?.first)
        rating["sourceFingerprint"] = String(repeating: "a", count: 64)
        root["ratings"] = [rating]
        let product = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        let place = try XCTUnwrap(SearchPlace.all.first { $0.id == "greggs" })
        let coverage: [String: Any] = ["version": "uk-places-2026-10-09-v1-associations-v1", "processed": 10, "total": 20, "complete": false]
        let association: [String: Any] = ["placeID": place.id, "relation": "brand", "confidence": "source_metadata", "field": "brands", "value": "Greggs"]
        let evidence: [String: Any] = ["barcode": product.barcode, "sourceFingerprint": String(repeating: "a", count: 64), "version": coverage["version"]!, "source": "Open Food Facts", "menuAvailable": false, "stockConfirmed": false, "associations": [association]]
        let selected: [String: Any] = ["id": place.id, "title": place.title, "groups": place.groups.map(\.rawValue), "menuAvailable": false]
        let places: [String: Any] = ["selected": selected, "coverage": coverage, "evidence": [evidence]]
        root["places"] = places
        let checked = try NudgeCatalogueService.placeMetadata(root, products: [product], selectedID: place.id)
        XCTAssertEqual(checked.coverage?.processed, 10)
        XCTAssertEqual(checked.evidence[product.barcode]?.association(for: place.id, product: product)?.displayReason, "Brand match")
        XCTAssertEqual(try NudgeCatalogueService.products(root, at: date).first?.nutrients, product.nutrients)
        var missing = root; missing.removeValue(forKey: "places")
        XCTAssertThrowsError(try NudgeCatalogueService.placeMetadata(missing, products: [product], selectedID: place.id))
        for field in ["sourceFingerprint", "barcode", "version", "menuAvailable", "stockConfirmed"] {
            var changed = evidence
            changed[field] = field == "menuAvailable" || field == "stockConfirmed" ? true : "different"
            var invalidPlaces = places; invalidPlaces["evidence"] = [changed]
            var invalid = root; invalid["places"] = invalidPlaces
            XCTAssertThrowsError(try NudgeCatalogueService.placeMetadata(invalid, products: [product], selectedID: place.id), field)
        }
        var candidate = association; candidate["relation"] = "title_candidate"; candidate["confidence"] = "candidate"; candidate["field"] = "product_name"
        var changed = evidence; changed["associations"] = [candidate]
        var candidatePlaces = places; candidatePlaces["evidence"] = [changed]
        root["places"] = candidatePlaces
        XCTAssertThrowsError(try NudgeCatalogueService.placeMetadata(root, products: [product], selectedID: place.id), "Name-only matches are review candidates, not confirmed place results")
    }

    func testPlacePagesRetainEvidenceOfflineWithoutCachingIncompleteEmptyCoverage() async throws {
        let date = Date(timeIntervalSince1970: 200_000)
        var product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        product.catalogueSourceFingerprint = String(repeating: "a", count: 64)
        var query = try ProductSearchQuery(discoveryText: "")
        query.placeID = "greggs"
        let association = ProductPlaceAssociation(placeID: "greggs", relation: "brand", confidence: "source_metadata", field: "brands", value: "Greggs")
        let evidence = ProductPlaceEvidence(barcode: product.barcode, sourceFingerprint: product.catalogueSourceFingerprint!, version: "test-v1", associations: [association])
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        var page = ProductSearchPage(query: query, products: [product], hasMore: false)
        page.catalogueCoverage = "partial"
        page.placeCoverage = .init(version: "test-v1", processed: 2, total: 20, complete: false)
        page.placeEvidence = [product.barcode: evidence]
        await ProductSearchState(directory: folder).save(page, at: date)
        let state = ProductSearchState(directory: folder)
        let fresh = await state.cached(query, at: date.addingTimeInterval(1))
        XCTAssertNil(fresh)
        let cached = await state.cached(query, at: date.addingTimeInterval(1), allowingStale: true)
        let offline = try XCTUnwrap(cached)
        XCTAssertTrue(offline.stale)
        XCTAssertEqual(offline.placeEvidence[product.barcode], evidence)
        var other = query; other.placeID = "costa"
        let otherPage = await state.cached(other, at: date.addingTimeInterval(1), allowingStale: true)
        XCTAssertNil(otherPage)
    }

    func testIncompleteSupportPagesRefreshAndOnlyNonemptyPagesRemainAsStaleFallback() async throws {
        let date = Date(timeIntervalSince1970: 200_000)
        let product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let query = try ProductSearchQuery(supportContext: .perimenopause)
        for products in [[product], []] {
            let folder = directory.appendingPathComponent(String(products.count))
            var page = ProductSearchPage(query: query, products: products, hasMore: false)
            page.catalogueCoverage = "complete"
            page.supportCoverage = .init(version: "test-v1", processed: 25, total: 100, complete: false)
            let memory = ProductSearchState(directory: folder)
            await memory.save(page, at: date)
            let disk = ProductSearchState(directory: folder)
            for state in [memory, disk] {
                let fresh = await state.cached(query, at: date.addingTimeInterval(1))
                XCTAssertNil(fresh, "An incomplete tag index must not hide new matches behind fresh cache")
                let fallback = await state.cached(query, at: date.addingTimeInterval(1), allowingStale: true)
                if products.isEmpty { XCTAssertNil(fallback, "Incomplete empty results cannot mask an outage") }
                else {
                    XCTAssertTrue(fallback?.stale == true)
                    XCTAssertEqual(fallback?.products, products)
                }
            }
        }
        // Completed empty searches keep the existing five-minute discovery TTL.
        var complete = ProductSearchPage(query: query, products: [], hasMore: false)
        complete.catalogueCoverage = "complete"
        complete.supportCoverage = .init(version: "test-v1", processed: 100, total: 100, complete: true)
        let state = ProductSearchState()
        await state.save(complete, at: date)
        let fresh = await state.cached(query, at: date.addingTimeInterval(299))
        XCTAssertEqual(fresh?.products.count, 0)
        XCTAssertFalse(fresh?.stale ?? true)
        let expired = await state.cached(query, at: date.addingTimeInterval(300))
        XCTAssertNil(expired)
        // Ordinary product searches remain cached while catalogue tags are backfilled.
        let ordinaryQuery = try ProductSearchQuery(literalText: "chickpeas")
        var ordinary = ProductSearchPage(query: ordinaryQuery, products: [product], hasMore: false)
        ordinary.supportCoverage = .init(version: "test-v1", processed: 25, total: 100, complete: false)
        await state.save(ordinary, at: date)
        let ordinaryCached = await state.cached(ordinaryQuery, at: date.addingTimeInterval(1))
        XCTAssertEqual(ordinaryCached?.products, [product])
        XCTAssertFalse(ordinaryCached?.stale ?? true)
    }

    func testSupportMetadataIsSeparateFromNutritionAndValidatesSourcesAndCoverage() throws {
        let date = Date(timeIntervalSince1970: 200_000)
        var root = catalogueFixture(date: date)
        let original = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        root["support"] = ["version": "support-test-v1", "processed": 8, "total": 20, "complete": false]
        root["supportTags"] = [["barcode": original.barcode, "tags": [supportWireTag()]]]
        let metadata = try NudgeCatalogueService.supportMetadata(root, barcodes: [original.barcode], required: true)
        XCTAssertEqual(metadata.coverage?.processed, 8)
        let tag = try XCTUnwrap(metadata.tags[original.barcode]?.first)
        XCTAssertEqual(tag.directionLabel, "Studies include no clear benefit.")
        XCTAssertEqual(tag.foodDataLabel, "Matched using the product’s reported food type or ingredients.")
        let unchanged = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        XCTAssertEqual(unchanged.nutrients, original.nutrients)
        XCTAssertEqual(unchanged.catalogueRating, original.catalogueRating)
        var malformed = root
        malformed.removeValue(forKey: "support")
        XCTAssertThrowsError(try NudgeCatalogueService.supportMetadata(malformed, barcodes: [original.barcode], required: true))
        XCTAssertNil(try NudgeCatalogueService.supportMetadata(malformed, barcodes: [original.barcode], required: false).coverage)
        malformed = root
        malformed["support"] = ["version": "bad", "processed": 21, "total": 20, "complete": false]
        XCTAssertThrowsError(try NudgeCatalogueService.supportMetadata(malformed, barcodes: [original.barcode], required: true))
        for address in ["javascript:alert(1)", "http://example.test/research", "https://user:pass@example.test/research"] {
            var badTag = supportWireTag()
            badTag["sources"] = [["id": "source", "title": "Source", "url": address]]
            malformed = root
            malformed["supportTags"] = [["barcode": original.barcode, "tags": [badTag]]]
            XCTAssertThrowsError(try NudgeCatalogueService.supportMetadata(malformed, barcodes: [original.barcode], required: true))
        }
        malformed = root; malformed["supportTags"] = []
        XCTAssertThrowsError(try NudgeCatalogueService.supportMetadata(malformed, barcodes: [original.barcode], required: true))
        malformed["products"] = []
        XCTAssertEqual(try NudgeCatalogueService.supportMetadata(malformed, barcodes: [], required: true).coverage?.version, "support-test-v1")
    }

    func testStructuredSearchCannotFallBackToPublicSearchIncludingExplicitSkip() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnexpectedSupportPublicRequest.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let support = try ProductSearchQuery(supportContext: .luteal)
        var place = try ProductSearchQuery(discoveryText: "coffee"); place.placeID = "greggs"
        var dietary = try ProductSearchQuery(discoveryText: "bread"); dietary.dietary = [.gluten]
        var nutrition = try ProductSearchQuery(discoveryText: "yoghurt"); nutrition.nutrition = [.calcium]
        for original in [support, place, dietary, nutrition] {
        var query = original
        query.cataloguePolicy = .skip
        let empty = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState(), catalogueSearch: { request in
            XCTAssertEqual(request.cataloguePolicy, .only)
            XCTAssertEqual(request.supportContext, original.supportContext)
            XCTAssertEqual(request.placeID, original.placeID)
            XCTAssertEqual(request.dietary, original.dietary)
            XCTAssertEqual(request.nutrition, original.nutrition)
            var page = ProductSearchPage(query: request, products: [], hasMore: false)
            page.catalogueCoverage = "partial"
            page.supportCoverage = .init(version: "test-v1", processed: 0, total: 10, complete: false)
            return page
        })
        let emptyPage = try await empty.search(query: query)
        XCTAssertTrue(emptyPage.products.isEmpty)
        let failed = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState(), catalogueSearch: { _ in
            throw ProductSearchError.invalidResponse
        })
        do { _ = try await failed.search(query: query); XCTFail("A failed tag search cannot broaden") }
        catch ProductSearchError.invalidResponse { }
        let absent = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState())
        do { _ = try await absent.search(query: query); XCTFail("Tag filtering requires Nudge catalogue") }
        catch ProductSearchError.unavailable { }
        }
    }

    func testLivePrefixFlagIsExplicitAndDoesNotChangeMarketStoreOrSort() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogueWireFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = NudgeCatalogueService(session: session, now: { Date(timeIntervalSince1970: 200_000) }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "public-test-token")
        }, diagnostics: nil)
        for prefix in [true, false] {
            var query = try ProductSearchQuery(literalText: prefix ? "live-prefix-fixture" : "fixture", store: .sainsburys)
            query.prefixMatch = prefix; query.sortOrder = .ratingHighest
            let page = try await service.search(query)
            XCTAssertEqual(page.products.map(\.barcode), ["12340001"])
        }
    }

    func testSearchStageTimingsAreNumericAndContainNoQueryOrCredentials() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let diagnostics = AnalysisDiagnostics(directory: folder)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogueWireFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = NudgeCatalogueService(session: session, now: { Date(timeIntervalSince1970: 200_000) }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "public-test-token")
        }, diagnostics: diagnostics)
        var query = try ProductSearchQuery(literalText: "fixture", store: .sainsburys)
        query.sortOrder = .ratingHighest
        let page = try await service.search(query)
        XCTAssertEqual(page.products.count, 1)
        XCTAssertNil(page.discoveryCoverage)
        XCTAssertNil(page.supportCoverage, "Omitted aggregates remain unknown rather than fabricated zero coverage")
        let events = try diagnosticEvents(diagnostics)
        let http = try XCTUnwrap(events.first { $0["stage"] as? String == "search_http" }?["metadata"] as? [String: Any])
        for key in ["authorizationMs", "networkMs", "responseHeadersMs", "downloadMs", "responseBytes"] {
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(http[key] as? Int), 0, key)
        }
        let parse = try XCTUnwrap(events.first { $0["stage"] as? String == "native_parse" }?["metadata"] as? [String: Any])
        XCTAssertEqual(parse["productCount"] as? Int, 1)
        XCTAssertNotNil(parse["elapsedMs"])
        let rendered = String(data: try diagnostics.exportData(), encoding: .utf8) ?? ""
        for privateValue in ["fixture", "public-test-token", "catalogue.example.test", "12340001"] { XCTAssertFalse(rendered.contains(privateValue)) }
    }

    func testDiscoveryFiltersSendCanonicalAisleAndReturnExclusionCounts() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogueWireFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = NudgeCatalogueService(session: session, now: { Date(timeIntervalSince1970: 200_000) }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "public-test-token")
        }, diagnostics: nil)
        let bakery = try XCTUnwrap(ProductSearchCategory.all.first { $0.id == "bakery" })
        var query = try ProductSearchQuery(category: bakery, store: .sainsburys)
        query.dietary = [.gluten, .milk]; query.nutrition = [.iron, .calcium]; query.nutritionMode = .all
        query.sortOrder = .ratingHighest
        let page = try await service.search(query)
        XCTAssertEqual(page.products.map(\.barcode), ["12340001"])
        XCTAssertEqual(page.total, 1)
        XCTAssertEqual(page.dietaryConflictCount, 2)
        XCTAssertEqual(page.dietaryUnknownCount, 3)
        XCTAssertEqual(page.discoveryCoverage?.processed, 10)
    }

    func testSupportSearchSendsNoProfileAndCanBrowseWithoutWords() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogueWireFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = NudgeCatalogueService(session: session, now: { Date(timeIntervalSince1970: 200_000) }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "public-test-token")
        }, diagnostics: nil)
        var query = try ProductSearchQuery(supportContext: .perimenopause, store: .sainsburys)
        query.sortOrder = .ratingHighest
        let page = try await service.search(query)
        XCTAssertEqual(page.products.map(\.barcode), ["12340001"])
        XCTAssertEqual(page.supportCoverage?.version, "support-test-v1")
        XCTAssertEqual(page.supportTags["12340001"]?.first?.id, "flax-candidate")
    }

    func testProductReadBudgetIsSharedAndHonoursProviderPause() async throws {
        let state = ProductReadState(), date = Date(timeIntervalSince1970: 10_000)
        for _ in 0..<15 { try await state.reserve(at: date) }
        do { try await state.reserve(at: date.addingTimeInterval(10)); XCTFail("A sixteenth product read must wait") }
        catch BarcodeLookupError.productReadDeferred(let seconds) { XCTAssertEqual(seconds, 50) }
        try await state.reserve(at: date.addingTimeInterval(60))
        await state.pause(seconds: 120, at: date.addingTimeInterval(60))
        do { try await state.reserve(at: date.addingTimeInterval(120)); XCTFail("Provider pause applies even with local allowance") }
        catch BarcodeLookupError.productReadDeferred(let seconds) { XCTAssertEqual(seconds, 60) }
        try await state.reserve(at: date.addingTimeInterval(180))
    }

    func testProduct429PropagatesRetryAfterAndStopsOtherDirectReads() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let state = ProductReadState(), date = Date()
        let service = OpenFoodFactsService(productReadState: state, session: session, now: { date }, cache: nil,
            catalogueLookup: { _ in throw NutritionLabelService.ServiceError.accountAuthentication })
        do { _ = try await service.lookup(barcode: "10042900"); XCTFail("Provider throttle must remain explicit") }
        catch BarcodeLookupError.retryLater(let seconds) { XCTAssertEqual(seconds, 120) }
        do { _ = try await service.lookup(barcode: "10010010"); XCTFail("Other direct reads share the provider pause") }
        catch BarcodeLookupError.productReadDeferred(let seconds) { XCTAssertEqual(seconds, 120) }
    }

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BoundedFixtureProtocol.self]
        return URLSession(configuration: configuration)
    }

    func testChunkedResponseMatchesBytesAndRemainsBoundedWithoutContentLength() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let request = URLRequest(url: URL(string: "https://example.test/chunks")!)
        let (data, response) = try await BoundedHTTPData.load(request, session: session, maximumBytes: 4096)
        XCTAssertEqual(data, Data(repeating: 65, count: 4096))
        XCTAssertEqual(response.statusCode, 200)
        do {
            _ = try await BoundedHTTPData.load(request, session: session, maximumBytes: 4095)
            XCTFail("An unbounded transfer must be rejected while receiving chunks")
        } catch BoundedHTTPData.Failure.bodyTooLarge { }
    }

    func testAdvertisedOversizeAndCancellationAreNotSuccessfulEmptyResponses() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        do {
            _ = try await BoundedHTTPData.load(URLRequest(url: URL(string: "https://example.test/oversize")!), session: session, maximumBytes: 100)
            XCTFail("Advertised oversize must be rejected before reading")
        } catch BoundedHTTPData.Failure.bodyTooLarge { }
        let task = Task { try await BoundedHTTPData.load(URLRequest(url: URL(string: "https://example.test/hang")!), session: session, maximumBytes: 100) }
        try await Task.sleep(nanoseconds: 30_000_000)
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancellation must throw") }
        catch is CancellationError { }
    }

    func testSearchRatingUsesOnePublicRequestThenReusesExactProductCache() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        let service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, cache: cache, catalogueLookup: { _ in
            XCTFail("Search-card hydration must not wait for account and backend lookup")
            throw BarcodeLookupError.notFound
        })
        var snapshot = try OpenFoodFactsParser.parse(data: Data(#"{"product":{"code":"10010010","product_name":"Fixture chickpeas"}}"#.utf8), barcode: "10010010")
        snapshot.searchProvider = "open_food_facts_search"
        let exact = try await service.lookupForSearchRating(snapshot: snapshot)
        XCTAssertNil(exact.searchProvider)
        XCTAssertEqual(exact.nutrients["protein"]?.value, 7)
        let second = try await service.lookupForSearchRating(snapshot: snapshot)
        XCTAssertEqual(exact, second)
        XCTAssertEqual(cache.read(barcode: snapshot.barcode, now: Date()), exact)
    }

    func testSelectedRetailerMakesOneScopedRequestAndCachesCandidates() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let state = ProductSearchState()
        let service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, cache: nil, searchSession: session, searchState: state,
            alternativesState: ProductAlternativesState(), catalogueLookup: { _ in
                XCTFail("Known review category does not need another barcode lookup")
                throw BarcodeLookupError.notFound
            })
        for _ in 0..<3 {
            let products = try await service.alternatives(categoryTag: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
            XCTAssertEqual(products.map(\.barcode), ["1002"], "Reject wrong-store, unlisted and non-UK candidates")
        }
        // One actual request consumed one slot. Cached opens consumed no more.
        for _ in 0..<7 { try await state.reserve(at: Date()) }
        do { try await state.reserve(at: Date()); XCTFail("Only the ninth request should exceed the shared budget") }
        catch ProductSearchError.rateLimited { }
    }

    func testNudgeAlternativesUseCatalogueDespiteOFFPauseWithoutConsumingItsBudget() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnexpectedProductSource.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let date = Date(timeIntervalSince1970: 200_000), searches = ProductSearchState()
        await searches.pause(seconds: 120, at: date, statusCode: 429, route: .alternatives)
        var product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        product.categories = ["en:peanut-butters"]; product.nutritionPreparation = "as_sold"; product.countriesTags = ["en:united-kingdom"]; product.stores = ["sainsbury-s"]
        let probe = CatalogueAlternativesProbe(products: [product])
        let service = OpenFoodFactsService(now: { date }, cache: nil, searchSession: session, searchState: searches,
            searchDiagnostics: nil, alternativesState: ProductAlternativesState(), catalogueAlternatives: { category, store in
                try await probe.load(category: category, store: store)
            })
        for _ in 0..<3 {
            let result = try await service.alternatives(categoryTag: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
            XCTAssertEqual(result.map(\.barcode), [product.barcode])
        }
        let calls = await probe.calls
        XCTAssertEqual(calls, 1, "Repeated detail openings use the Nudge candidate cache")
        let category = await probe.category, store = await probe.store
        XCTAssertEqual(category, "en:peanut-butters"); XCTAssertEqual(store, .sainsburys)
    }

    func testUnselectedShopKeepsYeastSpreadAlternativesAcrossTheUK() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnexpectedProductSource.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let date = Date(timeIntervalSince1970: 200_000)
        var product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        product.categories = ["en:yeast-extract-spreads"]; product.nutritionPreparation = "as_sold"
        product.countriesTags = ["en:united-kingdom"]; product.stores = ["Sainsbury’s"]
        for retailer in [nil, "Unrecognised shop"] as [String?] {
            let probe = CatalogueAlternativesProbe(products: [product])
            let service = OpenFoodFactsService(now: { date }, cache: nil, searchSession: session,
                searchDiagnostics: nil, alternativesState: ProductAlternativesState(), catalogueAlternatives: { category, store in
                    let products = try await probe.load(category: category, store: store)
                    // A real shop-scoped catalogue response excludes products
                    // without that listing. An absent choice must stay absent.
                    return products.filter { product in store.map { chosen in product.stores.contains(where: chosen.contains(sourceStore:)) } ?? true }
                })
            for _ in 0..<2 {
                let result = try await service.alternatives(categoryTag: "en:yeast-extract-spreads", retailer: retailer,
                    basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: nil)
                XCTAssertEqual(result.map(\.barcode), [product.barcode])
            }
            let store = await probe.store, category = await probe.category, calls = await probe.calls
            XCTAssertNil(store, "No chosen shop must not silently become Heron Foods")
            XCTAssertEqual(category, "en:yeast-extract-spreads")
            XCTAssertEqual(calls, 1, "Successful UK candidates can be reused on reopening History")
        }
    }

    func testAlternativesRetainExplicitShopAndRecognisedLegacyRetailerScope() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnexpectedProductSource.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let cases: [(ProductSearchStore?, String?, ProductSearchStore)] = [
            (nil, "en:sainsbury-s", .sainsburys), (.heronFoods, nil, .heronFoods), (.boots, "Tesco", .boots)
        ]
        for (selected, retailer, expected) in cases {
            let probe = CatalogueAlternativesProbe(products: [])
            let service = OpenFoodFactsService(cache: nil, searchSession: session, searchDiagnostics: nil,
                alternativesState: ProductAlternativesState(), catalogueAlternatives: { category, store in
                    try await probe.load(category: category, store: store)
                })
            _ = try await service.alternatives(categoryTag: "en:yeast-extract-spreads", retailer: retailer,
                basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: selected)
            let store = await probe.store
            XCTAssertEqual(store, expected)
        }
    }

    func testNewShopCandidatePoolsCannotReplaceTheUnfilteredUKCache() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnexpectedProductSource.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let date = Date(timeIntervalSince1970: 200_000)
        func candidate(_ barcode: String, store: String) throws -> BarcodeProduct {
            let raw: [String: Any] = ["code": barcode, "product_name": "Synthetic spread",
                "categories_tags": ["en:yeast-extract-spreads"], "countries_tags": ["en:united-kingdom"],
                "stores": store, "nutrition_data_per": "100g", "nutriments": ["proteins_100g": 20]]
            return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": raw]), barcode: barcode, retrievedAt: date)
        }
        let product = try candidate("12340001", store: "Sainsbury’s")
        let heron = try candidate("12340002", store: "Heron Foods")
        let boots = try candidate("12340003", store: "Boots")
        let probe = CatalogueAlternativesProbe(products: [product, heron, boots])
        let service = OpenFoodFactsService(now: { date }, cache: nil, searchSession: session,
            searchDiagnostics: nil, alternativesState: ProductAlternativesState(), catalogueAlternatives: { category, store in
                let products = try await probe.load(category: category, store: store)
                return products.filter { product in store.map { chosen in product.stores.contains(where: chosen.contains(sourceStore:)) } ?? true }
            })
        let scopes: [(ProductSearchStore?, [String])] = [(.heronFoods, [heron.barcode]), (nil, [product.barcode, heron.barcode, boots.barcode]), (.boots, [boots.barcode])]
        for _ in 0..<2 {
            for (store, codes) in scopes {
                let result = try await service.alternatives(categoryTag: "en:yeast-extract-spreads", basisUnit: "g",
                    nutritionPreparation: "as_sold", selectedStore: store)
                XCTAssertEqual(result.map(\.barcode), codes)
            }
        }
        let calls = await probe.calls
        XCTAssertEqual(calls, 3, "Each shop and the whole UK retain separate reusable pools")
    }

    func testNudgeAlternativesDoNotFanOutToOFFOnEmptyFailureOrCancellation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnexpectedProductSource.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        for failure in [nil, ProductSearchError.unavailable, .offline, .invalidResponse] {
            let probe = CatalogueAlternativesProbe(products: [], failure: failure)
            let service = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState(),
                searchDiagnostics: nil, alternativesState: ProductAlternativesState(), catalogueAlternatives: { category, store in
                    try await probe.load(category: category, store: store)
                })
            do {
                let result = try await service.alternatives(categoryTag: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
                XCTAssertNil(failure); XCTAssertTrue(result.isEmpty)
            } catch { XCTAssertEqual(error as? ProductSearchError, failure) }
            let calls = await probe.calls; XCTAssertEqual(calls, 1)
        }
        let cancelled = OpenFoodFactsService(cache: nil, searchSession: session, searchDiagnostics: nil,
            alternativesState: ProductAlternativesState(), catalogueAlternatives: { _, _ in throw CancellationError() })
        do { _ = try await cancelled.alternatives(categoryTag: "en:peanut-butters"); XCTFail("Must preserve cancellation") }
        catch is CancellationError { }
    }

    func testNudgeAlternativesNeverBorrowAnExplicitOFFCandidateCache() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let candidates = ProductAlternativesState()
        let explicitOFF = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState(),
            searchDiagnostics: nil, alternativesState: candidates)
        let offResult = try await explicitOFF.alternatives(categoryTag: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
        XCTAssertEqual(offResult.map(\.barcode), ["1002"])
        var nudge = explicitOFF
        let probe = CatalogueAlternativesProbe(products: [])
        nudge.catalogueAlternatives = { category, store in try await probe.load(category: category, store: store) }
        let result = try await nudge.alternatives(categoryTag: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
        XCTAssertTrue(result.isEmpty, "Nudge empty results must not borrow OFF matches")
        let calls = await probe.calls; XCTAssertEqual(calls, 1)
        let again = try await explicitOFF.alternatives(categoryTag: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
        XCTAssertEqual(again, offResult, "Explicit OFF consumers retain their separate cache")
    }

    func testAlternativesWireRequestUsesNudgeCategoryStoreAndHighestRating() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogueWireFixture.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let service = NudgeCatalogueService(session: session, now: { Date(timeIntervalSince1970: 200_000) }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "public-test-token")
        }, diagnostics: nil)
        let result = try await service.alternatives(category: "en:peanut-butters", store: .sainsburys)
        XCTAssertEqual(result.map(\.barcode), ["12340001"])
    }

    func testEmptyAlternativesAreRetriedAndExplicitRefreshInvalidatesOnlySavedPools() async throws {
        let cache = ProductAlternativesState(), date = Date()
        let empty = CatalogueAlternativesProbe(products: [])
        for _ in 0..<2 {
            _ = try await cache.load(key: "empty", at: date) { try await empty.load(category: "en:yeast-extract-spreads", store: nil) }
        }
        let emptyCalls = await empty.calls
        XCTAssertEqual(emptyCalls, 2, "An empty catalogue result must not be held for ten minutes")
        let product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        let successful = CatalogueAlternativesProbe(products: [product])
        for _ in 0..<2 {
            _ = try await cache.load(key: "success", at: date) { try await successful.load(category: "en:yeast-extract-spreads", store: nil) }
        }
        let cachedCalls = await successful.calls
        XCTAssertEqual(cachedCalls, 1)
        await cache.invalidate()
        _ = try await cache.load(key: "success", at: date) { try await successful.load(category: "en:yeast-extract-spreads", store: nil) }
        let refreshedCalls = await successful.calls
        XCTAssertEqual(refreshedCalls, 2)
    }

    func testAlternativesReadSecondCataloguePageAndRetainFirstPageOnOptionalFailure() async throws {
        for host in ["paged.example.test", "second-page-fails.example.test"] {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [CatalogueWireFixture.self]
            let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
            let service = NudgeCatalogueService(session: session, now: { Date(timeIntervalSince1970: 200_000) }, authorization: {
                .init(baseURL: URL(string: "https://" + host)!, token: "public-test-token")
            }, diagnostics: nil)
            let products = try await service.alternatives(category: "en:peanut-butters", store: .sainsburys)
            XCTAssertEqual(products.map(\.barcode), host == "paged.example.test" ? ["12340001", "12340002"] : ["12340001"])
        }
    }

    private let batchDate = Date(timeIntervalSince1970: 2_000)

    private func batchSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BatchFactsFixtureProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func batchSnapshot(_ code: String, modified: Int? = 1_000) throws -> BarcodeProduct {
        var record: [String: Any] = ["code": code, "product_name": "Index fixture"]
        if let modified { record["last_modified_t"] = modified }
        var product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": record]), barcode: code, retrievedAt: batchDate)
        product.searchProvider = "open_food_facts_search"
        return product
    }

    func testBatchProductionSessionHasBoundedTotalDeadline() {
        let configuration = OpenFoodFactsService().searchSession.configuration
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 15)
        XCTAssertEqual(configuration.timeoutIntervalForResource, 20)
    }

    func testBatchHydratesTwentyExactRecordsWithOneSearchSlotAndNoProductReads() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let reads = ProductReadState(), searches = ProductSearchState()
        for _ in 0..<15 { try await reads.reserve(at: batchDate) }
        let service = OpenFoodFactsService(productReadState: reads, session: session, now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: searches, alternativesState: ProductAlternativesState(), catalogueLookup: { _ in
                XCTFail("Batch hydration uses a single public search, without account lookup")
                throw BarcodeLookupError.notFound
            })
        let snapshots = try (0..<20).map { try batchSnapshot(String(30_010_000 + $0)) }
        let records = try await service.lookupForSearchRatings(snapshots: snapshots)
        XCTAssertEqual(records.map(\.barcode), snapshots.map(\.barcode))
        XCTAssertTrue(records.allSatisfy { $0.searchProvider == nil && $0.nutritionPreparation == "as_sold" })
        XCTAssertEqual(records[0].nutrients["protein"]?.value, 7)
        XCTAssertEqual(records[0].nutrients["sugars"]?.relation, "<")
        XCTAssertEqual(records[0].retrievedAt, "1970-01-01T00:33:20Z")
        // The repeat is served by the bounded fact pool, even without disk cache.
        let repeated = try await service.lookupForSearchRatings(snapshots: Array(snapshots.reversed()))
        XCTAssertEqual(repeated.map(\.barcode), snapshots.reversed().map(\.barcode))
        for _ in 0..<7 { try await searches.reserve(at: batchDate) }
        do { try await searches.reserve(at: batchDate); XCTFail("Exactly one shared search allowance was consumed") }
        catch ProductSearchError.rateLimited { }
    }

    func testBatchReusesVerifiedIndividualCacheWithoutAnySearchAllowance() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory), searches = ProductSearchState()
        let service = OpenFoodFactsService(session: session, now: { self.batchDate }, cache: cache, searchSession: session,
            searchState: searches, alternativesState: ProductAlternativesState())
        let snapshot = try batchSnapshot("20010001")
        let first = try await service.lookupForSearchRatings(snapshots: [snapshot])
        XCTAssertEqual(first.count, 1)
        // A new pool cannot hide an accidental second request.
        var nextService = service; nextService.alternativesState = ProductAlternativesState()
        for _ in 0..<7 { try await searches.reserve(at: batchDate) }
        let repeated = try await nextService.lookupForSearchRatings(snapshots: [snapshot])
        XCTAssertEqual(repeated, first)
        XCTAssertEqual(cache.read(barcode: snapshot.barcode, now: batchDate), first.first)
    }

    func testBatchRejectsWrongDuplicatesStaleFutureAndMalformedFactsButKeepsValidPartialRecords() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(session: session, now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: ProductSearchState(), alternativesState: ProductAlternativesState())
        let codes = (1...7).map { String(40_000_000 + $0) } + ["0000000000000"]
        let result = try await service.lookupForSearchRatings(snapshots: codes.map { try batchSnapshot($0) })
        XCTAssertEqual(result.map(\.barcode), ["40000006", "40000007"])
        XCTAssertNil(result[0].nutrients["protein"]?.value, "A retrieved full record may still have unknown nutrients")
        XCTAssertEqual(result[1].nutrients["protein"]?.value, 7)
        XCTAssertFalse(result.contains { $0.barcode == "00000000" }, "Provider code normalisation cannot change identity")
    }

    func testNewerSnapshotCannotReuseAnOlderBatchPoolOrRecord() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let searches = ProductSearchState()
        let service = OpenFoodFactsService(session: session, now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: searches, alternativesState: ProductAlternativesState())
        let first = try await service.lookupForSearchRatings(snapshots: [batchSnapshot("20020001")])
        XCTAssertEqual(first.count, 1)
        let changed = try await service.lookupForSearchRatings(snapshots: [batchSnapshot("20020001", modified: 1_600)])
        XCTAssertTrue(changed.isEmpty, "The source response at 1500 is older than the changed index")
        for _ in 0..<6 { try await searches.reserve(at: batchDate) }
        do { try await searches.reserve(at: batchDate); XCTFail("Two distinct snapshot revisions each made one request") }
        catch ProductSearchError.rateLimited { }
    }

    func testBatchPreservesV2AsSoldModifiersAndLiquidBasisWithoutUsingPreparedNutrients() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(session: session, now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: ProductSearchState(), alternativesState: ProductAlternativesState())
        let products = try await service.lookupForSearchRatings(snapshots: [batchSnapshot("20040001")])
        let product = try XCTUnwrap(products.first)
        XCTAssertEqual(product.basisUnit, "ml")
        XCTAssertEqual(product.nutritionPreparation, "as_sold")
        XCTAssertEqual(product.nutrients["protein"]?.value, 4)
        XCTAssertEqual(product.nutrients["protein"]?.relation, "<")
        XCTAssertEqual(product.servingAmount, 250)
        XCTAssertNil(product.nutrients["fibre"]?.value, "Prepared-only values cannot fill missing as-sold nutrition")
    }

    func testBatchRejectsInvalidOversizedAndDuplicateInputsBeforeQuota() async throws {
        let searches = ProductSearchState()
        let service = OpenFoodFactsService(now: { self.batchDate }, cache: nil, searchState: searches, alternativesState: ProductAlternativesState())
        let snapshot = try batchSnapshot("20030001")
        do { _ = try await service.lookupForSearchRatings(snapshots: Array(repeating: snapshot, count: 21)); XCTFail("At most one page is allowed") }
        catch BarcodeLookupError.invalidResponse { }
        do { _ = try await service.lookupForSearchRatings(snapshots: [snapshot, snapshot]); XCTFail("Inputs must have distinct exact identities") }
        catch BarcodeLookupError.invalidResponse { }
        var encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        encoded["barcode"] = "2003|all"
        let invalid = try JSONDecoder().decode(BarcodeProduct.self, from: JSONSerialization.data(withJSONObject: encoded))
        do { _ = try await service.lookupForSearchRatings(snapshots: [invalid]); XCTFail("Query syntax is not a barcode") }
        catch BarcodeLookupError.invalidBarcode { }
        let empty = try await service.lookupForSearchRatings(snapshots: [])
        XCTAssertTrue(empty.isEmpty)
        for _ in 0..<8 { try await searches.reserve(at: batchDate) }
    }

    func testBatch429PausesSharedSearchBudgetAndNeverFallsBackToIndividualReads() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let searches = ProductSearchState(), reads = ProductReadState()
        let service = OpenFoodFactsService(productReadState: reads, session: session, now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: searches, alternativesState: ProductAlternativesState())
        do { _ = try await service.lookupForSearchRatings(snapshots: [batchSnapshot("50042900")]); XCTFail("Provider throttle must remain explicit") }
        catch ProductSearchError.providerRateLimited(let seconds) { XCTAssertEqual(seconds, 120) }
        do { try await searches.reserve(at: batchDate.addingTimeInterval(30)); XCTFail("Other search paths must honour the same provider pause") }
        catch ProductSearchError.providerRateLimited(let seconds) { XCTAssertEqual(seconds, 90) }
        for _ in 0..<15 { try await reads.reserve(at: batchDate) }
    }

    func testHTTP200TimeoutAndErrorEnvelopesAreNeverCachedAsEmptyFacts() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let searches = ProductSearchState()
        let service = OpenFoodFactsService(now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: searches, alternativesState: ProductAlternativesState())
        for _ in 0..<2 {
            do { _ = try await service.lookupForSearchRatings(snapshots: [batchSnapshot("70010001")]); XCTFail("HTTP200 timed-out facts remain unavailable") }
            catch ProductSearchError.timeout { }
        }
        for code in ["70010002", "70010003"] {
            do { _ = try await service.lookupForSearchRatings(snapshots: [batchSnapshot(code)]); XCTFail("Error envelopes cannot become empty successful pools") }
            catch BarcodeLookupError.invalidResponse { }
        }
        for _ in 0..<4 { try await searches.reserve(at: batchDate) }
        do { try await searches.reserve(at: batchDate); XCTFail("The timed-out result was retried, rather than cached") }
        catch ProductSearchError.rateLimited { }
    }

    func testBatchResponseBoundsCancellationAndReaderCoalescing() async throws {
        let session = batchSession(); defer { session.invalidateAndCancel() }
        let searches = ProductSearchState()
        let service = OpenFoodFactsService(session: session, now: { self.batchDate }, cache: nil, searchSession: session,
            searchState: searches, alternativesState: ProductAlternativesState())
        do { _ = try await service.lookupForSearchRatings(snapshots: [batchSnapshot("50020001")]); XCTFail("An oversized response must fail") }
        catch BarcodeLookupError.invalidResponse { }
        let snapshot = try batchSnapshot("60010001")
        let cancelled = Task { try await service.lookupForSearchRatings(snapshots: [snapshot]) }
        let remaining = Task { try await service.lookupForSearchRatings(snapshots: [snapshot]) }
        try await Task.sleep(nanoseconds: 30_000_000)
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("A cancelled reader cannot publish facts") }
        catch is CancellationError { }
        let records = try await remaining.value
        XCTAssertEqual(records.map(\.barcode), [snapshot.barcode], "Cancelling one reader must not cancel a shared request")
        for _ in 0..<6 { try await searches.reserve(at: batchDate) }
        do { try await searches.reserve(at: batchDate); XCTFail("Only the oversized request and one coalesced request consumed quota") }
        catch ProductSearchError.rateLimited { }
        var separate = service; separate.searchState = ProductSearchState()
        let hangingSnapshot = try batchSnapshot("60020001")
        let hanging = Task { try await separate.lookupForSearchRatings(snapshots: [hangingSnapshot]) }
        try await Task.sleep(nanoseconds: 30_000_000)
        hanging.cancel()
        do { _ = try await hanging.value; XCTFail("Cancelling the last reader must cancel the underlying request") }
        catch is CancellationError { }
    }
}

private actor CatalogueAlternativesProbe {
    let products: [BarcodeProduct]
    let failure: ProductSearchError?
    private(set) var calls = 0
    private(set) var category: String?
    private(set) var store: ProductSearchStore?
    init(products: [BarcodeProduct], failure: ProductSearchError? = nil) { self.products = products; self.failure = failure }
    func load(category: String, store: ProductSearchStore?) throws -> [BarcodeProduct] {
        calls += 1; self.category = category; self.store = store
        if let failure { throw failure }
        return products
    }
}

private final class BatchFactsFixtureProtocol: URLProtocol, @unchecked Sendable {
    private let stateLock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
        XCTAssertEqual(url.path, "/api/v2/search", "Batch failures must not fan out to individual product lookups")
        let codes = query.first { $0.name == "code" }?.value?.components(separatedBy: ",") ?? []
        XCTAssertEqual(codes, codes.sorted())
        let fields = Set((query.first { $0.name == "fields" }?.value ?? "").components(separatedBy: ","))
        XCTAssertTrue(["ingredients", "nutriments", "nutrition", "nutrition_data_per", "nutrition_data_prepared", "nutriscore", "last_modified_t"].allSatisfy(fields.contains))
        XCTAssertFalse(query.contains { $0.name == "api_version" }, "Use the supported v2 search without an undocumented v3 override")
        if codes.contains("60020001") { return }
        if codes.contains("60010001") {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) { [self] in
                stateLock.lock(); let active = !stopped; stateLock.unlock()
                if active { respond(codes: codes) }
            }
        } else { respond(codes: codes) }
    }
    private func respond(codes: [String]) {
        let url = request.url!
        if codes.contains("50042900") {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil,
                headerFields: ["Retry-After": "120"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self); return
        }
        let headers = codes.contains("50020001") ? ["Content-Length": "2000001"] : [:]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
        if codes.contains("50020001") { client?.urlProtocolDidFinishLoading(self); return }
        if let code = codes.first, code.hasPrefix("7001") {
            var errorEnvelope: [String: Any] = ["products": []]
            if code == "70010001" { errorEnvelope["timed_out"] = true }
            else if code == "70010002" { errorEnvelope["error"] = "Unavailable" }
            else { errorEnvelope["errors"] = [["message": "Unavailable"]] }
            client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: errorEnvelope))
            client?.urlProtocolDidFinishLoading(self); return
        }
        var records = codes.compactMap { code -> [String: Any]? in
            if code == "0000000000000" { return nil }
            var record: [String: Any] = ["code": code, "product_name": "Source chickpeas", "last_modified_t": 1_500,
                "nutrition_data_per": "100g", "nutriments": ["proteins_100g": 7, "sugars_100g": 0.5, "sugars_modifier": "<"]]
            if code == "40000002" { record["last_modified_t"] = 500 }
            if code == "40000003" { record.removeValue(forKey: "last_modified_t") }
            if code == "40000004" { record["last_modified_t"] = 2_001 }
            if code == "40000005" { record.removeValue(forKey: "product_name") }
            if code == "40000006" { record.removeValue(forKey: "nutriments") }
            if code == "20040001" {
                record["quantity"] = "250 ml"; record["product_quantity_unit"] = "ml"
                record["nutrition_data_per"] = "100ml"; record["nutrition_data"] = "on"; record["nutrition_data_prepared"] = "on"
                record["serving_size"] = "1 cup (250 ml)"; record["serving_quantity"] = 250; record["serving_quantity_unit"] = "ml"
                record["nutriments"] = ["proteins_100g": 4, "proteins_modifier": "<", "proteins_prepared_100g": 999, "fiber_prepared_100g": 99] as [String: Any]
            }
            return record
        }
        if codes.contains("40000001"), let duplicate = records.first(where: { $0["code"] as? String == "40000001" }) { records.append(duplicate) }
        if codes.contains("0000000000000") { records.append(["code": "00000000", "product_name": "Normalised different code", "last_modified_t": 1_500]) }
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["products": records]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
}

private final class BoundedFixtureProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        if url.path == "/hang" { return }
        if url.path.contains("10042900") {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 429, httpVersion: nil,
                headerFields: ["Retry-After": "120"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let header = url.path == "/oversize" ? ["Content-Length": "10000"] : [:]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: header)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if url.path == "/chunks" {
            for _ in 0..<4 { client?.urlProtocol(self, didLoad: Data(repeating: 65, count: 1024)) }
        } else if url.path == "/api/v2/search" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertTrue(items.contains { $0.name == "stores_tags" && $0.value == "sainsbury-s" })
            XCTAssertTrue(items.contains { $0.name == "countries_tags_en" && $0.value == "united-kingdom" })
            let products = [("1002", "sainsbury-s", "en:united-kingdom"), ("1003", "tesco", "en:united-kingdom"),
                            ("1004", "sainsbury-s", "en:france"), ("1005", "", "en:united-kingdom")].map { code, store, country in
                ["code": code, "product_name": "Peanut butter", "brands": "Sainsbury's",
                 "categories_tags": ["en:peanut-butters"], "stores_tags": [store], "countries_tags": [country],
                 "nutrition_data_per": "100g", "nutriments": ["sugars_100g": 2]] as [String: Any]
            }
            client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["products": products]))
        } else {
            client?.urlProtocol(self, didLoad: Data(#"{"product":{"code":"10010010","product_name":"Fixture chickpeas","nutriments":{"proteins_100g":7}}}"#.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

extension ProductTransportTests {
    func testBarcodeCatalogueAndPhoneCacheAvoidPublicRequestsAndCorrelateDiagnostics() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let date = Date(), cache = ProductLookupCache(directory: folder.appendingPathComponent("facts"))
        let diagnostics = AnalysisDiagnostics(directory: folder.appendingPathComponent("diagnostics"))
        let product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(session: session, now: { date }, cache: cache, searchDiagnostics: diagnostics,
            catalogueLookup: { _ in XCTFail("A catalogue hit must not trigger another backend lookup"); throw BarcodeLookupError.notFound },
            catalogueBatch: { codes in XCTAssertEqual(codes, [product.barcode]); return [product] })
        let firstID = UUID(), secondID = UUID()
        let first = try await service.lookup(barcode: product.barcode, diagnosticID: firstID)
        let second = try await service.lookup(barcode: product.barcode, diagnosticID: secondID)
        XCTAssertEqual(first, product)
        XCTAssertEqual(second, product)
        let events = try diagnosticEvents(diagnostics)
        XCTAssertEqual(events.map { $0["outcome"] as? String }, ["matched", "cache_hit"])
        let metadata = events.compactMap { $0["metadata"] as? [String: Any] }
        XCTAssertEqual(metadata.map { $0["sourceRoute"] as? String }, ["catalogue_batch", "phone_cache"])
        XCTAssertEqual(metadata.map { $0["attemptId"] as? String }, [firstID.uuidString, secondID.uuidString])
        XCTAssertEqual(metadata.last?["requestSent"] as? Bool, false)
        let rendered = String(data: try diagnostics.exportData(), encoding: .utf8) ?? ""
        XCTAssertFalse(rendered.contains(product.barcode)); XCTAssertFalse(rendered.contains(product.name))
    }

    func testBarcodeCatalogueMissUsesOneSuccessfulBackendFallbackAndCachesIt() async throws {
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let date = Date(), payload = Data(#"{"product":{"code":"10010010","product_name":"Public fixture"}}"#.utf8)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let cache = ProductLookupCache(directory: folder)
        let service = OpenFoodFactsService(session: session, now: { date }, cache: cache, searchDiagnostics: nil,
            catalogueLookup: { code in XCTAssertEqual(code, "10010010"); return (payload, date) }, catalogueBatch: { _ in [] })
        let found = try await service.lookup(barcode: "10010010")
        XCTAssertEqual(found.barcode, "10010010")
        XCTAssertEqual(cache.read(barcode: found.barcode, now: date), found)
    }

    func testBarcodeBackendUnavailableOrTimeoutDoesNotRepeatPublicSourceLookup() async throws {
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let errors: [Error] = [try XCTUnwrap(NutritionLabelService.catalogueLookupError(statusCode: 404)),
            try XCTUnwrap(NutritionLabelService.catalogueLookupError(statusCode: 503)),
            try XCTUnwrap(NutritionLabelService.catalogueLookupError(statusCode: 429, retryAfter: "120")),
            URLError(.timedOut), URLError(.networkConnectionLost), BarcodeLookupError.notFound]
        for (index, failure) in errors.enumerated() {
            let service = OpenFoodFactsService(session: session, cache: nil, searchDiagnostics: nil,
                catalogueLookup: { _ in throw failure }, catalogueBatch: { _ in [] })
            do { _ = try await service.lookup(barcode: "10010010"); XCTFail("A completed source failure must stop") }
            catch let error as BarcodeLookupError {
                let expected: [BarcodeLookupError] = [.server(503), .server(503), .retryLater(120), .timeout, .offline, .notFound]
                XCTAssertEqual(error, expected[index])
            }
        }
    }

    func testBarcodeWithoutCredentialsOrBackendConnectionCanUseDirectSource() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        for failure in [NutritionLabelService.ServiceError.accountAuthentication as Error, URLError(.cannotConnectToHost)] {
            let service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, cache: nil, searchDiagnostics: nil,
                catalogueLookup: { _ in throw failure }, catalogueBatch: { _ in [] })
            let product = try await service.lookup(barcode: "10010010")
            XCTAssertEqual(product.nutrients["protein"]?.value, 7)
        }
    }

    func testBarcodeCancellationStopsBeforeAnyFallback() async throws {
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        for failure in [CancellationError() as Error, URLError(.cancelled)] {
            let service = OpenFoodFactsService(session: session, cache: nil, searchDiagnostics: nil,
                catalogueLookup: { _ in XCTFail("Cancelled indexed lookup must not continue"); throw BarcodeLookupError.notFound },
                catalogueBatch: { _ in throw failure })
            do { _ = try await service.lookup(barcode: "10010010"); XCTFail("Cancellation must be preserved") }
            catch is CancellationError { }
            let legacy = OpenFoodFactsService(session: session, cache: nil, searchDiagnostics: nil,
                catalogueLookup: { _ in throw failure }, catalogueBatch: { _ in [] })
            do { _ = try await legacy.lookup(barcode: "10010010"); XCTFail("Cancelled legacy lookup must not call OFF") }
            catch is CancellationError { }
        }
    }

    private func diagnosticEvents(_ diagnostics: AnalysisDiagnostics) throws -> [[String: Any]] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: diagnostics.exportData()) as? [String: Any])
        return try XCTUnwrap(root["events"] as? [[String: Any]])
    }

    private func noSourceSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [UnexpectedProductSource.self]
        return URLSession(configuration: config)
    }

    func testSourceOutageOnlyPausesItsRouteWhile429AndAllowanceRemainShared() async throws {
        let date = Date(timeIntervalSince1970: 100_000), state = ProductSearchState()
        await state.pause(seconds: 60, at: date, statusCode: 503, route: .factsBatch)
        try await state.reserve(at: date, route: .discovery)
        for route in [ProductSourceRoute.factsBatch, .alternatives] {
            do { try await state.reserve(at: date, route: route); XCTFail("The same failed source host must wait") }
            catch ProductSearchError.providerBusy(let status, let seconds) { XCTAssertEqual(status, 503); XCTAssertEqual(seconds, 60) }
        }
        await state.pause(seconds: 120, at: date, statusCode: 429, route: .factsBatch)
        do { try await state.reserve(at: date, route: .discovery); XCTFail("A legitimate provider429 remains shared") }
        catch ProductSearchError.providerRateLimited(let seconds) { XCTAssertEqual(seconds, 120) }
        let budget = ProductSearchState()
        for index in 0..<8 { try await budget.reserve(at: date, route: index % 2 == 0 ? .factsBatch : .discovery) }
        do { try await budget.reserve(at: date, route: .alternatives); XCTFail("Route isolation cannot multiply the shared allowance") }
        catch ProductSearchError.rateLimited { }
    }

    func testCatalogueValidatesIdentityAgeRevisionAndPreparedOnlyFacts() throws {
        let date = Date(timeIntervalSince1970: 200_000)
        let root = catalogueFixture(date: date)
        let product = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        XCTAssertEqual(product.barcode, "12340001")
        XCTAssertEqual(product.nutrients["protein"]?.value, 7)
        XCTAssertNil(product.nutrients["carbs"]?.value)
        XCTAssertEqual(product.retrievedAt, ISO8601DateFormatter().string(from: date.addingTimeInterval(-100)))
        XCTAssertEqual(product.catalogueSourceExpiresAt, date.addingTimeInterval(100))
        var mismatch = root
        var entry = (root["ratings"] as! [[String: Any]])[0]; entry["sourceRevision"] = 101
        mismatch["ratings"] = [entry]
        XCTAssertTrue(try NudgeCatalogueService.products(mismatch, at: date).isEmpty)
        mismatch["ratings"] = root["ratings"]; mismatch["products"] = (root["products"] as! [[String: Any]]) + (root["products"] as! [[String: Any]])
        XCTAssertTrue(try NudgeCatalogueService.products(mismatch, at: date).isEmpty)
        var prepared = (root["products"] as! [[String: Any]])[0]
        prepared["nutrition_data"] = ""; prepared["nutrition_data_prepared"] = "on"
        prepared["nutriments"] = ["proteins_100g": 9, "proteins_prepared_100g": 1]
        mismatch = root; mismatch["products"] = [prepared]
        let unknown = try XCTUnwrap(NudgeCatalogueService.products(mismatch, at: date).first)
        XCTAssertNil(unknown.nutrients["protein"]?.value)
        XCTAssertNil(unknown.nutritionPreparation)
        prepared.removeValue(forKey: "nutrition_data"); mismatch["products"] = [prepared]
        XCTAssertNil(try NudgeCatalogueService.products(mismatch, at: date).first?.nutrients["protein"]?.value)
    }

    func testStaleCatalogueFactsRemainExplicitAndAreNeverWrittenAsFresh() async throws {
        let date = Date(timeIntervalSince1970: 200_000)
        var root = catalogueFixture(date: date)
        var metadata = (root["ratings"] as! [[String: Any]])[0]
        metadata["expiresAt"] = Int(date.addingTimeInterval(-10).timeIntervalSince1970 * 1000)
        root["ratings"] = [metadata]
        XCTAssertTrue(try NudgeCatalogueService.products(root, at: date).isEmpty)
        metadata["freshness"] = "stale"; root["ratings"] = [metadata]
        let product = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory.appendingPathComponent("facts"))
        cache.write(product, now: date)
        XCTAssertNil(cache.read(barcode: product.barcode, now: date))
        let query = try ProductSearchQuery(literalText: "fixture")
        var page = ProductSearchPage(query: query, products: [product], hasMore: false)
        page.catalogueCoverage = "partial"; page.stale = true
        let state = ProductSearchState(directory: directory.appendingPathComponent("queries"))
        await state.save(page, at: date)
        let reopened = ProductSearchState(directory: directory.appendingPathComponent("queries"))
        let cached = await reopened.cached(query, at: date.addingTimeInterval(1))
        XCTAssertTrue(cached?.stale == true)
        XCTAssertEqual(cached?.products.first?.retrievedAt, product.retrievedAt)
    }

    func testCatalogueSearchAndBatchDoNotConsumePublicAllowanceAndPinPagination() async throws {
        let date = Date(timeIntervalSince1970: 200_000), state = ProductSearchState()
        for _ in 0..<8 { try await state.reserve(at: date) }
        let product = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        let service = OpenFoodFactsService(now: { date }, cache: nil, searchState: state,
            catalogueSearch: { query in
                var page = ProductSearchPage(query: query, products: query.page == 1 ? [product] : [], hasMore: query.page == 1)
                page.catalogueCoverage = "partial"; return page
            }, catalogueBatch: { codes in codes.contains(product.barcode) ? [product] : [] })
        let first = try await service.search(query: ProductSearchQuery(literalText: "fixture"))
        XCTAssertEqual(first.products.map(\.barcode), [product.barcode])
        var second = try ProductSearchQuery(literalText: "fixture", page: 2); second.cataloguePolicy = .only
        let end = try await service.search(query: second)
        XCTAssertTrue(end.products.isEmpty); XCTAssertFalse(end.hasMore); XCTAssertEqual(end.catalogueCoverage, "partial")
        var snapshot = product; snapshot.searchProvider = "open_food_facts_search"
        let batch = try await service.lookupForSearchRatings(snapshots: [snapshot])
        XCTAssertEqual(batch.map(\.barcode), [product.barcode])
    }

    private func catalogueFixture(date: Date) -> [String: Any] {
        ["version": "nudge-catalogue-index-v1", "products": [["code": "12340001", "product_name": "Fixture chickpeas",
            "last_modified_t": 100, "countries_tags": ["en:united-kingdom"], "categories_tags": ["en:chickpeas"],
            "nutrition_data_per": "100g", "nutriments": ["proteins_100g": 7]]],
         "ratings": [["barcode": "12340001", "sourceRevision": 100,
            "fetchedAt": Int(date.addingTimeInterval(-100).timeIntervalSince1970 * 1000),
            "expiresAt": Int(date.addingTimeInterval(100).timeIntervalSince1970 * 1000)]]]
    }

    func testCorrectedImageSeedReplacesOnlyObsoletePublicCaches() async throws {
        let date = Date(timeIntervalSince1970: 200_000)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let oldFacts = ProductLookupCache(directory: folder.appendingPathComponent("NudgeFoodCatalogue-v1"))
        let oldPageURL = folder.appendingPathComponent("NudgeProductSearch")
        let original = try XCTUnwrap(NudgeCatalogueService.products(catalogueFixture(date: date), at: date).first)
        XCTAssertNil(original.imageURL)
        oldFacts.write(original, now: date)
        let query = try ProductSearchQuery(literalText: "fixture")
        await ProductSearchState(directory: oldPageURL).save(.init(query: query, products: [original], hasMore: false), at: date)
        // Unrelated durable user data must survive cache invalidation unchanged.
        let privateURL = folder.appendingPathComponent("NudgeDataStore.json")
        let savedUserData = Data(#"{"history":[{"id":"private-diary-fixture"}],"savedFoods":["private-favourite-fixture"]}"#.utf8)
        try savedUserData.write(to: privateURL)

        let bundleURL = folder.appendingPathComponent("Images.bundle")
        try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "test.nudge.image-cache"], format: .xml, options: 0)
            .write(to: bundleURL.appendingPathComponent("Info.plist"))
        let source = "https://images.openfoodfacts.org/images/products/022/715/200/1161/front_en.6.400.jpg"
        var root = catalogueFixture(date: date)
        var record = (root["products"] as! [[String: Any]])[0]
        record["image_front_url"] = source; root["products"] = [record]
        try JSONSerialization.data(withJSONObject: [root]).write(to: bundleURL.appendingPathComponent("NudgeCatalogueSeed.json"))
        let cache = ProductLookupCache(directory: folder.appendingPathComponent(ProductLookupCache.directoryName))
        let pages = ProductSearchState(directory: folder.appendingPathComponent(ProductSearchState.directoryName))
        let oldPage = await pages.cached(query, at: date)
        XCTAssertNil(oldPage, "Old disk pages must not reintroduce the image-less record")
        await NudgeCatalogueService.bootstrapPopularCache(bundle: try XCTUnwrap(Bundle(url: bundleURL)), cache: cache, at: date)
        let corrected = try XCTUnwrap(cache.read(barcode: original.barcode, now: date))
        XCTAssertEqual(corrected.imageURL, source)
        XCTAssertEqual(corrected.retrievedAt, original.retrievedAt)
        XCTAssertEqual(corrected.catalogueSourceExpiresAt, original.catalogueSourceExpiresAt)
        XCTAssertEqual(try Data(contentsOf: privateURL), savedUserData)
        XCTAssertNil(oldFacts.read(barcode: original.barcode, now: date)?.imageURL)
        XCTAssertNotEqual(ProductLookupCache.directoryName, oldFacts.directory.lastPathComponent)
        XCTAssertEqual(ProductLookupCache.shared.directory.lastPathComponent, ProductLookupCache.directoryName)
    }
}

private final class UnexpectedProductSource: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("This lookup must not repeat an OFF source request")
        client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
    }
    override func stopLoading() { }
}

extension ProductTransportTests {
    func testAuthenticatedCatalogueWireContractAndAccountRevisionFence() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogueWireFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let date = Date(timeIntervalSince1970: 200_000)
        let service = NudgeCatalogueService(session: session, now: { date }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "public-test-token")
        }, diagnostics: nil)
        var query = try ProductSearchQuery(literalText: "fixture", store: .sainsburys)
        query.sortOrder = .ratingHighest
        let page = try await service.search(query)
        XCTAssertEqual(page.catalogueCoverage, "partial")
        XCTAssertEqual(page.products.map(\.barcode), ["12340001"])
        XCTAssertFalse(page.stale)
        var scoped = query; scoped.placeID = "greggs"
        let chainPage = try await service.search(scoped)
        XCTAssertEqual(chainPage.placeEvidence["12340001"]?.associations.first?.placeID, "greggs")
        let products = try await service.batch(["12340001"])
        XCTAssertEqual(products.count, 1)
        var signedOut = service
        signedOut.authorization = { .init(baseURL: URL(string: "https://catalogue.example.test")!, token: "old-test-token", isCurrent: { false }) }
        do { _ = try await signedOut.search(query); XCTFail("Changed account ownership must cancel before sending") }
        catch is CancellationError { }
    }
}

private final class CatalogueWireFixture: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer public-test-token")
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let size = stream.read(&buffer, maxLength: buffer.count)
                if size <= 0 { break }
                body.append(buffer, count: size)
            }
        }
        let payload = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
        if request.url!.path == "/v1/products/search" {
            if payload["placeID"] == nil && payload["supportContext"] == nil {
                XCTAssertEqual(payload["includeCoverage"] as? Bool, false, "Ordinary searches skip whole-catalogue censuses")
            } else { XCTAssertNil(payload["includeCoverage"], "Required scoped evidence coverage remains enabled") }
            if payload["placeID"] != nil {
                XCTAssertEqual(payload["placeID"] as? String, "greggs")
                XCTAssertNil(payload["store"], "Canonical place scope replaces the legacy retailer field")
            } else if payload["aisle"] != nil {
                XCTAssertEqual(Set(payload.keys), Set(["aisle", "dietary", "nutrition", "nutritionMode", "market", "store", "page", "pageSize", "sort", "includeCoverage"]))
                XCTAssertEqual(payload["aisle"] as? String, "bakery")
                XCTAssertEqual(payload["dietary"] as? [String], ["gluten", "milk"])
                XCTAssertEqual(payload["nutrition"] as? [String], ["calcium", "iron"])
                XCTAssertEqual(payload["nutritionMode"] as? String, "all")
                XCTAssertNil(payload["categoryTags"], "Broad aisles use the indexed canonical identifier")
            } else if payload["categoryTags"] != nil {
                XCTAssertEqual(Set(payload.keys), Set(["categoryTags", "market", "store", "page", "pageSize", "sort", "includeCoverage"]))
                XCTAssertEqual(payload["categoryTags"] as? [String], ["en:peanut-butters"])
                XCTAssertTrue((1...2).contains(payload["page"] as? Int ?? 0)); XCTAssertEqual(payload["pageSize"] as? Int, 20)
            } else if payload["supportContext"] != nil {
                XCTAssertEqual(Set(payload.keys), Set(["supportContext", "market", "store", "page", "pageSize", "sort"]))
                XCTAssertEqual(payload["supportContext"] as? String, "perimenopause")
            } else {
                let prefix = payload["query"] as? String == "live-prefix-fixture"
                let keys = ["query", "market", "store", "page", "pageSize", "sort", "includeCoverage"] + (prefix ? ["prefixMatch"] : [])
                XCTAssertEqual(Set(payload.keys), Set(keys))
                if prefix { XCTAssertEqual(payload["prefixMatch"] as? Bool, true) }
                else { XCTAssertNil(payload["prefixMatch"]) }
            }
            XCTAssertEqual(payload["sort"] as? String, "ratingHighest")
            XCTAssertEqual(payload["market"] as? String, "unitedKingdom")
            if payload["placeID"] == nil { XCTAssertEqual(payload["store"] as? String, "sainsburys") }
        } else {
            XCTAssertEqual(request.url!.path, "/v1/products/batch")
            XCTAssertEqual(Set(payload.keys), ["codes"])
            XCTAssertEqual(payload["codes"] as? [String], ["12340001"])
        }
        var root: [String: Any] = ["version": "nudge-catalogue-index-v1", "page": 1, "hasMore": false,
            "support": ["version": "support-test-v1", "processed": 8, "total": 20, "complete": false],
            "supportTags": [["barcode": "12340001", "tags": [supportWireTag()]]],
            "catalogue": ["complete": false, "freshness": "current"],
            "products": [["code": "12340001", "product_name": "Fixture", "last_modified_t": 100,
                "countries_tags": ["en:united-kingdom"], "stores_tags": ["sainsbury-s"], "nutriments": ["proteins_100g": 7]]],
            "ratings": [["barcode": "12340001", "sourceRevision": 100, "fetchedAt": 199_900_000, "expiresAt": 200_100_000]]]
        if payload["includeCoverage"] as? Bool == false && payload["aisle"] == nil {
            root["support"] = NSNull()
            root["discovery"] = ["coverage": NSNull()]
            root["places"] = ["selected": NSNull(), "coverage": NSNull(), "evidence": []]
        }
        if payload["placeID"] != nil {
            let fingerprint = String(repeating: "a", count: 64)
            var rating = (root["ratings"] as! [[String: Any]])[0]; rating["sourceFingerprint"] = fingerprint; root["ratings"] = [rating]
            root["places"] = ["selected": ["id": "greggs", "title": "Greggs", "groups": ["cafe"], "menuAvailable": false],
                "coverage": ["version": "places-test-v1", "processed": 10, "total": 10, "complete": true],
                "evidence": [["barcode": "12340001", "sourceFingerprint": fingerprint, "version": "places-test-v1", "source": "Open Food Facts", "menuAvailable": false, "stockConfirmed": false,
                    "associations": [["placeID": "greggs", "relation": "brand", "confidence": "source_metadata", "field": "brands", "value": "Greggs"]]]]]
        }
        if payload["aisle"] != nil {
            var product = (root["products"] as! [[String: Any]])[0]
            product["categories_tags"] = ["en:breads"]; root["products"] = [product]
            root["total"] = 1
            root["discovery"] = ["excludedDietary": ["conflicting": 2, "unconfirmed": 3],
                "coverage": ["version": "discovery-test-v1", "processed": 10, "total": 20, "complete": false]]
        }
        if payload["categoryTags"] != nil {
            var product = (root["products"] as! [[String: Any]])[0]
            product["categories_tags"] = ["en:peanut-butters"]; root["products"] = [product]
            if request.url!.host != "catalogue.example.test" {
                let page = payload["page"] as? Int ?? 1
                root["hasMore"] = true // Still stop after the bounded second page.
                root["page"] = page
                if page == 2 {
                    if request.url!.host == "second-page-fails.example.test" {
                        client?.urlProtocol(self, didFailWithError: URLError(.timedOut)); return
                    }
                    product["code"] = "12340002"; root["products"] = [product]
                    // Catalogue facts require matching freshness/source metadata
                    // for this page's product identity, just like a real response.
                    var rating = (root["ratings"] as! [[String: Any]])[0]
                    rating["barcode"] = "12340002"; root["ratings"] = [rating]
                    root["supportTags"] = [["barcode": "12340002", "tags": [supportWireTag()]]]
                }
            }
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: root))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

private func supportWireTag() -> [String: Any] {
    ["id": "flax-candidate", "label": "Ground flax candidate", "contexts": ["perimenopause", "postmenopause"],
     "evidence": "research_only", "evidenceDirection": "mixed_or_null", "wording": "A food candidate; hot-flush trials include no clear benefit.",
     "foodDataConfidence": "source_reported_identity", "foodFamilies": ["flax"],
     "sources": [["id": "trial", "title": "Flax trial", "url": "https://pubmed.ncbi.nlm.nih.gov/21900849/"]],
     "limitations": ["Food match is separate from evidence of benefit."]]
}

private final class UnexpectedSupportPublicRequest: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("A Nudge phase-filtered search must never reach the public OFF service")
        client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
    }
    override func stopLoading() { }
}

extension ProductTransportTests {
    private func communityFixture(date: Date, backend: String = "https://catalogue.test") -> [String: Any] {
        var root = catalogueFixture(date: date)
        var product = (root["products"] as! [[String: Any]])[0]
        let reviewed = date.addingTimeInterval(-100)
        product["last_modified_t"] = Int(reviewed.timeIntervalSince1970)
        product["stores"] = "Sainsbury's"
        product["nutriscore_grade"] = "a"
        product["image_front_small_url"] = "https://images.openfoodfacts.org/images/products/123/400/01/front_en.1.400.jpg"
        var entry = (root["ratings"] as! [[String: Any]])[0]
        entry["sourceRevision"] = Int(reviewed.timeIntervalSince1970)
        entry["sourceKind"] = "nudge_community"; entry["sourceName"] = "Nudge community"
        entry["sourceURL"] = backend + "/v1/products/reviewed/12340001"
        entry["discoveryScope"] = "barcode_only"
        entry["observedAt"] = Int(reviewed.addingTimeInterval(-100).timeIntervalSince1970 * 1000)
        entry["reviewedAt"] = Int(reviewed.timeIntervalSince1970 * 1000)
        root["products"] = [product]; root["ratings"] = [entry]
        return root
    }

    func testCommunityFactsRequireAuthenticatedOriginAndRetainDistinctProvenance() throws {
        let date = Date(timeIntervalSince1970: 200_000), backend = URL(string: "https://catalogue.test")!
        let root = communityFixture(date: date)
        XCTAssertTrue(try NudgeCatalogueService.products(root, at: date).isEmpty, "Untrusted envelopes cannot claim a reviewed community source")
        XCTAssertTrue(try NudgeCatalogueService.products(root, at: date, trustedBackendURL: URL(string: "https://other.test")!).isEmpty)
        let product = try XCTUnwrap(NudgeCatalogueService.products(root, at: date, trustedBackendURL: backend).first)
        XCTAssertEqual(product.sourceName, "Nudge community")
        XCTAssertEqual(product.sourceKind, "nudge_community")
        XCTAssertEqual(product.sourceURL, "https://catalogue.test/v1/products/reviewed/12340001")
        XCTAssertTrue(product.hasTrustedCatalogueSource)
        XCTAssertEqual(product.nutrients["protein"]?.value, 7); XCTAssertNil(product.nutrients["carbs"]?.value)
        XCTAssertTrue(product.nutrientSources.values.allSatisfy { $0.hasPrefix("Nudge community:") })
        XCTAssertEqual(product.licenceName, ""); XCTAssertEqual(product.licenceURL, "")
        XCTAssertNil(product.imageURL, "Private contribution images are never public catalogue thumbnails")
        XCTAssertNil(product.nutriScoreGrade); XCTAssertNil(product.nutriScore2023)
        XCTAssertTrue(product.countriesTags.isEmpty); XCTAssertTrue(product.stores.isEmpty)
        XCTAssertEqual(product.communityProvenance?.reviewedAt, date.addingTimeInterval(-100))
        XCTAssertEqual(product.communityProvenance?.observedAt, date.addingTimeInterval(-200))
        let encoded = try XCTUnwrap(String(data: JSONEncoder().encode(product), encoding: .utf8))
        XCTAssertFalse(encoded.contains("Open Food Facts")); XCTAssertFalse(encoded.contains("ODbL"))
    }

    func testCommunityParserRejectsSpoofedSourceAndPublicationTimestamps() throws {
        let date = Date(timeIntervalSince1970: 200_000), backend = URL(string: "https://catalogue.test")!
        let root = communityFixture(date: date)
        let metadata = (root["ratings"] as! [[String: Any]])[0]
        let mutations: [(String, Any)] = [
            ("sourceName", "Open Food Facts"), ("sourceKind", "unreviewed_upload"),
            ("sourceURL", "https://catalogue.test.evil.test/v1/products/reviewed/12340001"),
            ("sourceURL", "https://catalogue.test/v1/products/reviewed/12340002"),
            ("sourceURL", "https://catalogue.test/v1/products/reviewed/12340001?private=photo"),
            ("reviewedAt", 199_901_000), ("observedAt", 200_001_000), ("discoveryScope", "uk_discovery")
        ]
        for (key, value) in mutations {
            var changed = root, entry = metadata; entry[key] = value; changed["ratings"] = [entry]
            XCTAssertTrue(try NudgeCatalogueService.products(changed, at: date, trustedBackendURL: backend).isEmpty, "Reject invalid \(key)")
        }
    }

    func testReviewedCommunityFactsCacheOfflineWithoutLosingTheirSource() async throws {
        let date = Date(timeIntervalSince1970: 200_000), backend = URL(string: "https://catalogue.test")!
        let product = try XCTUnwrap(NudgeCatalogueService.products(communityFixture(date: date), at: date, trustedBackendURL: backend).first)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        cache.write(product, now: date)
        let restored = try XCTUnwrap(ProductLookupCache(directory: directory).read(barcode: product.barcode, now: date.addingTimeInterval(1)))
        XCTAssertEqual(restored, product); XCTAssertTrue(restored.hasTrustedCatalogueSource)
        var fake = product; fake.sourceURL = "https://other.test/v1/products/reviewed/12340001"
        XCTAssertFalse(fake.hasTrustedCatalogueSource)
        cache.write(fake, now: date)
        XCTAssertEqual(cache.read(barcode: product.barcode, now: date), product, "Invalid provenance cannot replace the trusted snapshot")
        var offMasquerade = product; offMasquerade.sourceName = "Open Food Facts"
        XCTAssertFalse(offMasquerade.hasTrustedCatalogueSource)
    }

    func testCatalogueBatchPassesItsAuthenticatedOriginToCommunityParser() async throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CommunityCatalogueFixtureProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let date = Date(timeIntervalSince1970: 200_000)
        CommunityCatalogueFixtureProtocol.payload = try JSONSerialization.data(withJSONObject: communityFixture(date: date))
        let service = NudgeCatalogueService(session: session, now: { date }, authorization: {
            .init(baseURL: URL(string: "https://catalogue.test")!, token: "mock-auth")
        }, diagnostics: nil)
        let result = try await service.batch(["12340001"])
        XCTAssertEqual(result.count, 1); XCTAssertEqual(result.first?.sourceName, "Nudge community")
        XCTAssertTrue(result.first?.hasTrustedCatalogueSource == true)
    }
}

private final class CommunityCatalogueFixtureProtocol: URLProtocol {
    static var payload = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.payload)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

extension ProductTransportTests {
    func testOfficialRecallFetchCoalescesAcrossConsumersAndSurvivesCameraCancellation() async throws {
        let clock = RecallFixtureClock(), wire = RecallFixtureWire()
        let session = recallFixtureSession(wire)
        defer { session.invalidateAndCancel(); RecallFixtureProtocol.remove(wire.id) }
        let service = FoodRecallService(session: session, now: { clock.now() })
        let original = Task { await service.notices() }
        try await waitForRecallFixture { wire.requests.count == 1 }
        original.cancel()
        let following = (0..<8).map { _ in Task { await service.notices() } }
        // The injected clock is read at entry to notices(), so this barrier proves
        // every consumer reached the actor while the one HTTP response is held.
        try await waitForRecallFixture { clock.readCount >= 9 }
        XCTAssertEqual(wire.requests.count, 1)
        XCTAssertEqual(wire.cancellations, 0, "Dismissing a camera result must not abort the shared FSA request")
        wire.finish(body: try recallFixtureBody())
        let first = await original.value
        XCTAssertEqual(first["status"] as? String, "available")
        for task in following {
            let result = await task.value
            XCTAssertTrue((first as NSDictionary).isEqual(to: result))
        }
        let again = await service.notices()
        XCTAssertTrue((first as NSDictionary).isEqual(to: again))
        XCTAssertEqual(wire.requests.count, 1, "The cancelled initiating consumer still allows the successful feed to be cached")
        let notice = try XCTUnwrap((again["notices"] as? [[String: Any]])?.first)
        XCTAssertEqual(notice["title"] as? String, "Fixture food recall")
        XCTAssertEqual(notice["status"] as? String, "published")
        XCTAssertEqual((notice["productDetails"] as? [[String: Any]])?.first?["batchCode"] as? String, "TEST-BATCH")
        XCTAssertNil(notice["unexpectedServerField"], "Keep the existing official-notice field allowlist")
        let request = try XCTUnwrap(wire.requests.first)
        XCTAssertEqual(request.url?.host, "data.food.gov.uk")
        XCTAssertEqual(request.url?.path, "/food-alerts/id")
        XCTAssertEqual(request.url?.query, "_limit=100&_sort=-created&_view=full")
        XCTAssertNil(request.httpBody); XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertLessThanOrEqual(request.timeoutInterval, 15)
        let configuration = FoodRecallService.configuration()
        XCTAssertLessThanOrEqual(configuration.timeoutIntervalForResource, 18)
        XCTAssertLessThanOrEqual(configuration.timeoutIntervalForRequest, 15)
        XCTAssertNil(configuration.urlCache)
    }

    func testOfficialRecallSuccessExpiresAfterOneHourAndUnavailableRetriesAfterThirtySeconds() async throws {
        let clock = RecallFixtureClock(), wire = RecallFixtureWire()
        let session = recallFixtureSession(wire)
        defer { session.invalidateAndCancel(); RecallFixtureProtocol.remove(wire.id) }
        let service = FoodRecallService(session: session, now: { clock.now() })
        let firstTask = Task { await service.notices() }
        try await waitForRecallFixture { wire.requests.count == 1 }
        wire.finish(body: try recallFixtureBody())
        let first = await firstTask.value
        clock.advance(3599)
        let cached = await service.notices()
        XCTAssertEqual(cached["status"] as? String, "available")
        XCTAssertEqual(cached["checkedAt"] as? String, first["checkedAt"] as? String)
        XCTAssertEqual(wire.requests.count, 1)
        clock.advance(1)
        let refresh = Task { await service.notices() }
        try await waitForRecallFixture { wire.requests.count == 2 }
        wire.finish(status: 503, body: Data())
        let unavailable = await refresh.value
        XCTAssertEqual(unavailable["status"] as? String, "check_unavailable")
        XCTAssertNil(unavailable["notices"], "An expired successful feed must not become false current recall clearance")
        XCTAssertNotEqual(unavailable["checkedAt"] as? String, first["checkedAt"] as? String)
        clock.advance(29)
        for _ in 0..<8 {
            let repeated = await service.notices()
            XCTAssertTrue((unavailable as NSDictionary).isEqual(to: repeated))
        }
        XCTAssertEqual(wire.requests.count, 2, "Rapid scans share a brief explicit unavailable result")
        clock.advance(1)
        let retry = Task { await service.notices() }
        try await waitForRecallFixture { wire.requests.count == 3 }
        wire.finish(body: try recallFixtureBody(title: "Updated fixture recall"))
        let recovered = await retry.value
        XCTAssertEqual(recovered["status"] as? String, "available")
        XCTAssertEqual((recovered["notices"] as? [[String: Any]])?.first?["title"] as? String, "Updated fixture recall")
        XCTAssertEqual(wire.requests.count, 3)
    }

    func testOfficialRecallInvalidOrFailedFeedsNeverBecomeAnEmptyAvailableClearance() async throws {
        let bodies = [Data(#"{"items":[]}"#.utf8), Data(#"{"items":{}}"#.utf8), Data("not JSON".utf8),
                      try JSONSerialization.data(withJSONObject: ["items": Array(repeating: ["title": "Fixture"], count: 101)]),
                      Data(repeating: 32, count: 2_000_001)]
        for body in bodies + [Data()] {
            let clock = RecallFixtureClock(), wire = RecallFixtureWire()
            let session = recallFixtureSession(wire)
            defer { session.invalidateAndCancel(); RecallFixtureProtocol.remove(wire.id) }
            let service = FoodRecallService(session: session, now: { clock.now() })
            let task = Task { await service.notices() }
            try await waitForRecallFixture { wire.requests.count == 1 }
            if body.isEmpty { wire.fail(URLError(.notConnectedToInternet)) }
            else { wire.finish(body: body) }
            let result = await task.value
            XCTAssertEqual(result["status"] as? String, "check_unavailable")
            XCTAssertNil(result["notices"])
            XCTAssertNotNil(result["checkedAt"]); XCTAssertNotNil(result["scope"])
            clock.advance(1)
            let repeated = await service.notices()
            XCTAssertEqual(repeated["status"] as? String, "check_unavailable")
            XCTAssertEqual(wire.requests.count, 1)
        }
    }

    private func recallFixtureSession(_ wire: RecallFixtureWire) -> URLSession {
        RecallFixtureProtocol.register(wire)
        let configuration = FoodRecallService.configuration()
        configuration.protocolClasses = [RecallFixtureProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Recall-Test-Fixture": wire.id]
        return URLSession(configuration: configuration)
    }
    private func recallFixtureBody(title: String = "Fixture food recall") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["items": [["notation": "FSA-TEST", "title": title,
            "description": "Test-only official notice", "status": "published", "created": "2026-10-15T10:00:00Z",
            "problem": ["riskStatement": "Test-only risk"], "consumerAdvice": "Read the test notice",
            "productDetails": [["productName": "Fixture food", "batchCode": "TEST-BATCH"]],
            "alertURL": "https://alerts.food.gov.uk/alert/test", "unexpectedServerField": "omit"]]])
    }
    private func waitForRecallFixture(_ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        guard ready() else {
            XCTFail("Recall fixture did not reach the expected request/consumer barrier")
            throw URLError(.timedOut)
        }
    }
}

private final class RecallFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 200_000)
    private var reads = 0
    var readCount: Int { lock.lock(); defer { lock.unlock() }; return reads }
    func now() -> Date { lock.lock(); defer { lock.unlock() }; reads += 1; return value }
    func advance(_ seconds: TimeInterval) { lock.lock(); defer { lock.unlock() }; value.addTimeInterval(seconds) }
}
private final class RecallFixtureWire: @unchecked Sendable {
    let id = UUID().uuidString
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private var pending: [RecallFixtureProtocol] = []
    private var cancelled = 0
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    var cancellations: Int { lock.lock(); defer { lock.unlock() }; return cancelled }
    func receive(_ transport: RecallFixtureProtocol) {
        lock.lock(); defer { lock.unlock() }
        recorded.append(transport.request); pending.append(transport)
    }
    func cancel(_ transport: RecallFixtureProtocol) {
        lock.lock(); defer { lock.unlock() }
        if pending.contains(where: { $0 === transport }) { cancelled += 1; pending.removeAll { $0 === transport } }
    }
    private func takePending() -> [RecallFixtureProtocol] {
        lock.lock(); defer { lock.unlock() }
        let result = pending; pending = []; return result
    }
    func finish(status: Int = 200, body: Data) {
        for transport in takePending() {
            let response = HTTPURLResponse(url: transport.request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            transport.client?.urlProtocol(transport, didReceive: response, cacheStoragePolicy: .notAllowed)
            transport.client?.urlProtocol(transport, didLoad: body)
            transport.client?.urlProtocolDidFinishLoading(transport)
        }
    }
    func fail(_ error: Error) { for transport in takePending() { transport.client?.urlProtocol(transport, didFailWithError: error) } }
}
private final class RecallFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let registryLock = NSLock()
    private static var registry: [String: RecallFixtureWire] = [:]
    private var wire: RecallFixtureWire?
    static func register(_ wire: RecallFixtureWire) { registryLock.lock(); defer { registryLock.unlock() }; registry[wire.id] = wire }
    static func remove(_ id: String) { registryLock.lock(); defer { registryLock.unlock() }; registry.removeValue(forKey: id) }
    private static func find(_ id: String?) -> RecallFixtureWire? {
        registryLock.lock(); defer { registryLock.unlock() }; return id.flatMap { registry[$0] }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let fixture = Self.find(request.value(forHTTPHeaderField: "X-Recall-Test-Fixture")) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
        }
        wire = fixture; fixture.receive(self)
    }
    override func stopLoading() { wire?.cancel(self) }
}

// Build 22: production routing and exact backend null-response regressions.
extension ProductTransportTests {
    func testActualBackendNullCoverageResponseRemainsUnknownAndKeepsProductFacts() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BackendCoverageWireFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = NudgeCatalogueService(session: session, now: { BackendCoverageWireFixture.date }, authorization: {
            .init(baseURL: URL(string: "https://legacy-null.example.test")!, token: "synthetic-test-token")
        }, diagnostics: nil)
        let page = try await service.search(ProductSearchQuery(literalText: "beans"))
        XCTAssertEqual(page.products.map(\.barcode), ["5000000000001"])
        XCTAssertEqual(page.products.first?.nutrients["sugars"]?.value, 4)
        let rating = try XCTUnwrap(page.products.first?.catalogueRating)
        let score = try XCTUnwrap(JSONSerialization.jsonObject(with: rating.scoreData) as? [String: Any])
        XCTAssertEqual(score["value"] as? Int, 75)
        XCTAssertNil(page.supportCoverage)
        XCTAssertNil(page.discoveryCoverage)
        XCTAssertNil(page.placeCoverage)
        XCTAssertTrue(page.supportTags.isEmpty)
        XCTAssertFalse(page.stale)
    }

    func testNullAndScalarMetadataCannotAbortAndRequiredEvidenceStillRejects() async throws {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: BackendCoverageWireFixture.bytes) as? [String: Any])
        let invalid: [Any] = [NSNull(), true, 7, "not-an-object", [], ["unexpected"]]
        let coverage: [String: Any] = ["version": "test-v1", "processed": 1, "total": 1, "complete": true]
        let place = try XCTUnwrap(SearchPlace.all.first { $0.id == "greggs" })
        for raw in invalid {
            for field in ["support", "supportTags"] {
                var changed = root; changed["support"] = coverage; changed["supportTags"] = [["barcode": "5000000000001", "tags": []]]
                changed[field] = raw
                let optional = try NudgeCatalogueService.supportMetadata(changed, barcodes: ["5000000000001"], required: false)
                if field == "supportTags", let rows = raw as? [Any], rows.isEmpty { XCTAssertNotNil(optional.coverage) }
                else { XCTAssertNil(optional.coverage) }
                XCTAssertThrowsError(try NudgeCatalogueService.supportMetadata(changed, barcodes: ["5000000000001"], required: true))
            }
            var changed = root
            changed["places"] = ["selected": ["id": place.id, "title": place.title, "groups": place.groups.map(\.rawValue), "menuAvailable": false],
                "coverage": raw, "evidence": []]
            XCTAssertThrowsError(try NudgeCatalogueService.placeMetadata(changed, products: [], selectedID: place.id))
            XCTAssertNil(try NudgeCatalogueService.placeMetadata(changed, products: [], selectedID: nil).coverage)
        }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [BackendCoverageWireFixture.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        for index in invalid.indices {
            let service = NudgeCatalogueService(session: session, now: { BackendCoverageWireFixture.date }, authorization: {
                .init(baseURL: URL(string: "https://malformed-\(index).example.test")!, token: "synthetic-test-token")
            }, diagnostics: nil)
            let page = try await service.search(ProductSearchQuery(literalText: "beans"))
            XCTAssertEqual(page.products.count, 1); XCTAssertNil(page.discoveryCoverage); XCTAssertNil(page.supportCoverage)
        }
    }

    func testProductionCatalogueMissAndFailuresNeverCallAnyOFFLookup() async throws {
        XCTAssertEqual(OpenFoodFactsService.catalogueConnected.sourcePolicy, .catalogueOnly)
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let failures: [Error?] = [nil, ProductSearchError.timeout, ProductSearchError.offline,
            ProductSearchError.unavailable, NutritionLabelService.ServiceError.accountAuthentication, URLError(.cannotConnectToHost)]
        let expected: [BarcodeLookupError] = [.notFound, .timeout, .offline, .server(503), .server(503), .offline]
        for (index, failure) in failures.enumerated() {
            let service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, cache: nil,
                searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil,
                catalogueLookup: { _ in XCTFail("Production must not use the legacy server/OFF fallback"); throw BarcodeLookupError.notFound },
                catalogueBatch: { _ in if let failure { throw failure }; return [] })
            do { _ = try await service.lookup(barcode: "5000000000001"); XCTFail("A miss/outage must stay explicit") }
            catch let error as BarcodeLookupError { XCTAssertEqual(error, expected[index]) }
        }
    }

    func testProductionRatingsAndAlternativesNeverFallBackAfterMissOutageOrMissingAdapter() async throws {
        let date = BackendCoverageWireFixture.date
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: BackendCoverageWireFixture.bytes) as? [String: Any])
        let full = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        var snapshot = full; snapshot.searchProvider = "open_food_facts_search"
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        for failure in [nil, ProductSearchError.unavailable, ProductSearchError.offline] as [ProductSearchError?] {
            let service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, now: { date }, cache: nil,
                searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil, alternativesState: ProductAlternativesState(),
                catalogueBatch: { _ in if let failure { throw failure }; return [] },
                catalogueAlternatives: { _, _ in if let failure { throw failure }; return [] })
            do { let rows = try await service.lookupForSearchRatings(snapshots: [snapshot]); XCTAssertNil(failure); XCTAssertTrue(rows.isEmpty) }
            catch let error as ProductSearchError { XCTAssertEqual(error, failure) }
            do { _ = try await service.lookupForSearchRating(snapshot: snapshot); XCTFail("Missing facts cannot become an invented rating") }
            catch BarcodeLookupError.incompleteProduct { XCTAssertNil(failure) }
            catch let error as ProductSearchError { XCTAssertEqual(error, failure) }
            do { let rows = try await service.alternatives(categoryTag: "en:baked-beans", referenceProduct: full); XCTAssertNil(failure); XCTAssertTrue(rows.isEmpty) }
            catch let error as ProductSearchError { XCTAssertEqual(error, failure) }
        }
        let missing = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, cache: nil,
            searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil, alternativesState: ProductAlternativesState())
        do { _ = try await missing.lookupForSearchRatings(snapshots: [snapshot]); XCTFail("Missing catalogue adapter must fail closed") }
        catch ProductSearchError.unavailable { }
        do { _ = try await missing.alternatives(categoryTag: "en:baked-beans", referenceProduct: full); XCTFail("Missing adapter must not call OFF") }
        catch ProductSearchError.unavailable { }
    }

    func testProductionTextSearchOverridesLegacyPolicyAndRejectsPublicCache() async throws {
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let date = BackendCoverageWireFixture.date
        for policy in [ProductSearchQuery.CataloguePolicy.prefer, .skip, .only] {
            let state = ProductSearchState()
            var query = try ProductSearchQuery(literalText: "beans"); query.cataloguePolicy = policy
            await state.save(ProductSearchPage(query: query, products: [], hasMore: false), at: date)
            var service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, now: { date }, cache: nil,
                searchSession: session, searchState: state, searchDiagnostics: nil,
                catalogueSearch: { query in
                    XCTAssertEqual(query.cataloguePolicy, .only)
                    var page = ProductSearchPage(query: query, products: [], hasMore: false); page.catalogueCoverage = "partial"; return page
                })
            let publicCache = await service.cachedSearchPage(query: query); XCTAssertNil(publicCache)
            let page = try await service.search(query: query)
            XCTAssertTrue(page.products.isEmpty); XCTAssertEqual(page.catalogueCoverage, "partial")
            service.searchState = ProductSearchState()
            service.catalogueSearch = { _ in throw ProductSearchError.timeout }
            do { _ = try await service.search(query: query); XCTFail("Timeout must not call OFF") }
            catch ProductSearchError.timeout { }
            service.catalogueSearch = nil
            do { _ = try await service.search(query: query); XCTFail("Missing adapter must fail closed") }
            catch ProductSearchError.unavailable { }
        }
    }

    func testProductionRejectsLegacyProductCacheAndPreservesStaleCatalogueDatesOnOutage() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let date = BackendCoverageWireFixture.date, cache = ProductLookupCache(directory: folder)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: BackendCoverageWireFixture.bytes) as? [String: Any])
        let full = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        var legacy = full; legacy.catalogueSourceExpiresAt = nil; legacy.catalogueRating = nil
        cache.write(legacy, now: date)
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        var service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, now: { date }, cache: cache,
            searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil,
            catalogueLookup: { _ in XCTFail("Legacy source facts cannot trigger a provider lookup"); throw BarcodeLookupError.notFound },
            catalogueBatch: { _ in [] })
        do { _ = try await service.lookup(barcode: full.barcode); XCTFail("Legacy facts do not prove catalogue membership") }
        catch BarcodeLookupError.notFound { }
        let unresolved = try await service.lookupForSearchRatings(snapshots: [full]); XCTAssertTrue(unresolved.isEmpty)
        var stale = full; stale.catalogueSourceExpiresAt = date.addingTimeInterval(-1)
        cache.write(stale, now: date)
        service.catalogueBatch = { _ in throw ProductSearchError.offline }
        let preserved = try await service.lookup(barcode: full.barcode)
        XCTAssertEqual(preserved, stale)
        XCTAssertEqual(cache.read(barcode: full.barcode, now: date, allowStale: true), stale)
        XCTAssertNil(cache.read(barcode: full.barcode, now: date), "An outage cannot renew stale source dates")
    }

    func testCatalogueOnlyFlightCannotJoinAnExistingLegacySearch() async throws {
        let state = ProductSearchState(), firstID = UUID(), secondID = UUID()
        var legacy = try ProductSearchQuery(discoveryText: "beans"); legacy.cataloguePolicy = .skip
        let publicTask = await state.join(legacy, reader: firstID) { ProductSearchPage(query: legacy, products: [], hasMore: false) }
        _ = try await publicTask.value // Keep this flight registered until its reader leaves.
        var strict = legacy; strict.cataloguePolicy = .only
        let catalogueTask = await state.join(strict, reader: secondID) {
            var page = ProductSearchPage(query: strict, products: [], hasMore: false); page.catalogueCoverage = "partial"; return page
        }
        let page = try await catalogueTask.value
        XCTAssertEqual(page.catalogueCoverage, "partial")
        await state.leave(legacy, reader: firstID); await state.leave(strict, reader: secondID)
    }

    func testStaleOrMalformedNonemptyCatalogueBatchIsNotReportedAsMissingProduct() async throws {
        let date = BackendCoverageWireFixture.date
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: BackendCoverageWireFixture.bytes) as? [String: Any])
        var stale = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        stale.catalogueSourceExpiresAt = date.addingTimeInterval(-1)
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, now: { date }, cache: nil,
            searchSession: session, searchDiagnostics: nil, catalogueBatch: { _ in [stale] })
        do { _ = try await service.lookup(barcode: stale.barcode); XCTFail("Stale existing records cannot become missing products") }
        catch BarcodeLookupError.server(503) { }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [BackendCoverageWireFixture.self]
        let wire = URLSession(configuration: configuration); defer { wire.invalidateAndCancel() }
        let catalogue = NudgeCatalogueService(session: wire, now: { date }, authorization: {
            .init(baseURL: URL(string: "https://invalid-product.example.test")!, token: "synthetic-test-token")
        }, diagnostics: nil)
        do { _ = try await catalogue.batch([stale.barcode]); XCTFail("Malformed nonempty wire data is an invalid response") }
        catch ProductSearchError.invalidResponse { }
    }

    func testCatalogueCacheDiagnosticsKeepTheirActualProvider() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let diagnostics = AnalysisDiagnostics(directory: folder), state = ProductSearchState()
        let date = BackendCoverageWireFixture.date, query = try ProductSearchQuery(literalText: "beans")
        var page = ProductSearchPage(query: query, products: [], hasMore: false); page.catalogueCoverage = "partial"
        await state.save(page, at: date)
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, now: { date }, cache: nil,
            searchSession: session, searchState: state, searchDiagnostics: diagnostics)
        _ = try await service.search(query: query)
        let event = try XCTUnwrap(diagnosticEvents(diagnostics).first { $0["outcome"] as? String == "cached" })
        let metadata = try XCTUnwrap(event["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["sourceRoute"] as? String, "catalogue_search")
        XCTAssertEqual(metadata["searchProvider"] as? String, "nudge_catalogue")
        XCTAssertEqual(metadata["requestSent"] as? Bool, false)
    }

    func testProductionPreservesKnownCatalogueFactsAndCancelsWithoutFallback() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let date = BackendCoverageWireFixture.date, cache = ProductLookupCache(directory: folder)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: BackendCoverageWireFixture.bytes) as? [String: Any])
        let full = try XCTUnwrap(NudgeCatalogueService.products(root, at: date).first)
        cache.write(full, now: date)
        let session = noSourceSession(); defer { session.invalidateAndCancel() }
        var service = OpenFoodFactsService(sourcePolicy: .catalogueOnly, session: session, now: { date }, cache: cache,
            searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil,
            catalogueLookup: { _ in XCTFail("Known catalogue facts must not use legacy lookup"); throw BarcodeLookupError.notFound },
            catalogueBatch: { _ in throw ProductSearchError.offline })
        let cached = try await service.lookup(barcode: full.barcode)
        XCTAssertEqual(cached, full)
        let rated = try await service.lookupForSearchRatings(snapshots: [full]); XCTAssertEqual(rated, [full])
        service.cache = nil
        for failure in [CancellationError() as Error, URLError(.cancelled)] {
            service.catalogueBatch = { _ in throw failure }
            do { _ = try await service.lookup(barcode: full.barcode); XCTFail("Cancelled lookup must stop") }
            catch is CancellationError { }
            do { _ = try await service.lookupForSearchRatings(snapshots: [full]); XCTFail("Cancelled rating must stop") }
            catch is CancellationError { }
        }
    }
}

private final class BackendCoverageWireFixture: URLProtocol, @unchecked Sendable {
    static let date = Date(timeIntervalSince1970: 1_792_072_800)
    // Exact legacy response generated by real searchCatalogue + SQLite, compacted
    // without changing values. Canonical fixture: Backend/test/fixtures/catalogue-search-no-coverage-legacy-null.json.
    static let bytes = Data(#"{"version":"nudge-catalogue-index-v1","products":[{"code":"5000000000001","product_name":"Catalogue test beans","brands":"Test","ingredients_text":"Beans (60%), water, tomatoes, salt","nutriments":{"energy-kcal_100g":90,"proteins_100g":5,"carbohydrates_100g":14,"fat_100g":0.5,"saturated-fat_100g":0.1,"sugars_100g":4,"fiber_100g":4,"salt_100g":0.5},"categories_tags":["en:baked-beans"],"countries_tags":["en:united-kingdom"],"stores":"Tesco","last_modified_t":1700000000}],"ratings":[{"barcode":"5000000000001","method":"nudge_nutrition_v0_4","version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceRevision":1700000000,"sourceFingerprint":"f4349d6ae47ea185e3363ab749aba8be0ddc3f3bc0b6f46e1c8af67094be5d40","fetchedAt":1792072800000,"expiresAt":1794664800000,"calculatedAt":1792072800000,"freshness":"current","discoveryScope":"uk_discovery","score":{"status":"rated","methodStatus":"directional","grade":"B","rawScore":1,"rawLower":1,"rawUpper":1,"value":75,"displayLower":75,"displayUpper":75,"band":{"id":"green","label":"Green","interpretation":"Nudge directional nutrition score"},"methodId":"nudge_nutrition_v0_4","version":"0.4","methodVersion":"0.4","model_version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceVersion":"SPF-FAQ-2025-03-17/2023","baseAlgorithmVersion":"2023","category":"general","available":true,"label":"Nudge score","completeness":"nutrition_only","assumptions":["No unverified plant bonus; the qualifying plant percentage remains unknown."],"baseFrequency":null,"finalFrequency":null,"frequencyStatus":"not_provided","reasonCodes":["supported_nutrition_calculation","nudge_directional","no_unverified_plant_bonus"],"personalSuitability":"unchecked","components":{"negative":[{"id":"energy","label":"Energy","value":376.56,"unit":"kJ","points":1,"pointsLower":1,"pointsUpper":1,"pointsMax":10,"counted":true,"missing":false},{"id":"saturatedFat","label":"Saturated fat","value":0.1,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":10,"counted":true,"missing":false},{"id":"sugars","label":"Sugars","value":4,"unit":"g","points":1,"pointsLower":1,"pointsUpper":1,"pointsMax":15,"counted":true,"missing":false},{"id":"salt","label":"Salt","value":0.5,"unit":"g","points":2,"pointsLower":2,"pointsUpper":2,"pointsMax":20,"counted":true,"missing":false}],"positive":[{"id":"fvl","label":"Fruit, vegetables and legumes","value":null,"unit":"%","points":0,"pointsLower":0,"pointsUpper":5,"pointsMax":5,"counted":true,"missing":true},{"id":"fibre","label":"Fibre","value":4,"unit":"g","points":1,"pointsLower":1,"pointsUpper":1,"pointsMax":5,"counted":true,"missing":false},{"id":"protein","label":"Protein","value":5,"unit":"g","points":2,"pointsLower":2,"pointsUpper":2,"pointsMax":7,"counted":true,"missing":false}]},"negativePoints":4,"positivePoints":3,"countProteins":true,"missingInputs":["qualifying fruit, vegetable and legume percentage"],"missingFields":["qualifying fruit, vegetable and legume percentage"],"reason":"Based on energy, sugars, saturated fat and salt per 100 g.","explanation":"Based on energy, sugars, saturated fat and salt per 100 g. A practical guide based on available nutrition and food information. Our scoring improves over time.  No unverified plant bonus; the qualifying plant percentage remains unknown.","inputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":376.56,"energySource":"derived-kcal-times-4.184","sugars":4,"fat":0.5,"saturatedFat":0.1,"salt":0.5,"fibre":4,"protein":5,"carbohydrate":14,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":null,"fvlBounds":null,"fvlSource":null,"hasNonNutritiveSweeteners":null},"sources":[{"title":"Santé publique France · updated Nutri-Score 2023 nutrient model","url":"https://www.santepubliquefrance.fr/sites/default/files/rdd/document/FAQ-updatedAlgo-V11.pdf"}],"promptVersion":"nudge-label-evidence-7","calculationBasis":{"unit":"g","per":100,"preparation":"as_sold"},"classificationEvidence":{"version":"food-evidence-2026-10-11-v16","evidence":[],"resolutions":[],"conflicts":[]},"scoreBasis":"nudge_directional","inputFingerprint":"nudge_nutrition_v0_4:food-evidence-2026-10-11-v16:off2023-facts-v1:1109:b9aa76f1:80030a5f:{\"sodiumNormalized\":false,\"providerInputs\":{},\"sourceEstimateKeys\":[],\"providerEstimates\":true,\"sourceKind\":null,\"type\":null}","sourceInputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":376.56,"energySource":"derived-kcal-times-4.184","sugars":4,"fat":0.5,"saturatedFat":0.1,"salt":0.5,"fibre":4,"protein":5,"carbohydrate":14,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":null,"fvlBounds":null,"fvlSource":null,"hasNonNutritiveSweeteners":null},"positivePointsUpper":3,"inferredInputs":{"fvlPoints":{"value":0,"method":"no_unverified_bonus"}},"sourceData":{"source":"Open Food Facts","url":"https://world.openfoodfacts.org/product/5000000000001","retrievedAt":"2026-10-15T14:00:00.000Z","version":null,"nutrientSources":{"energyKcal":"Open Food Facts legacy nutriments","protein":"Open Food Facts legacy nutriments","carbohydrate":"Open Food Facts legacy nutriments","sugars":"Open Food Facts legacy nutriments","fat":"Open Food Facts legacy nutriments","saturatedFat":"Open Food Facts legacy nutriments","fibre":"Open Food Facts legacy nutriments","salt":"Open Food Facts legacy nutriments"}},"quality":{"extraction":null,"match":null,"portion":null,"evidence":null}}}],"page":1,"total":1,"hasMore":false,"catalogue":{"source":"Nudge catalogue","coverage":"imported_uk_subset","complete":false,"generatedAt":1792072800000,"freshness":"current","attribution":"Contains information from Open Food Facts, made available under the Open Database License (ODbL).","sourceURL":"https://world.openfoodfacts.org","licenceURL":"https://opendatacommons.org/licenses/odbl/1-0/","exportPath":"/v1/catalogue/export"},"places":{"selected":null,"coverage":null,"evidence":[{"barcode":"5000000000001","sourceFingerprint":"f4349d6ae47ea185e3363ab749aba8be0ddc3f3bc0b6f46e1c8af67094be5d40","evaluatedAt":1792072800000,"version":"uk-places-2026-10-09-v1-associations-v2","taxonomyVersion":"uk-places-2026-10-09-v1","source":"Open Food Facts","menuAvailable":false,"stockConfirmed":false,"associations":[{"placeID":"tesco","relation":"retailer","confidence":"source_metadata","field":"stores","value":"Tesco"}]}]},"discovery":{"excludedDietary":null,"coverage":null,"evidence":[{"barcode":"5000000000001","version":"food-discovery-2026-10-09-v4","aisles":["pulses"],"dietary":{"gluten":{"state":"unconfirmed","reason":"No explicit free-from label supplied.","source":"Open Food Facts","claim":null},"lactose":{"state":"unconfirmed","reason":"No explicit free-from label supplied.","source":"Open Food Facts","claim":null},"milk":{"state":"unconfirmed","reason":"No explicit free-from label supplied.","source":"Open Food Facts","claim":null},"wheat":{"state":"unconfirmed","reason":"No explicit free-from label supplied.","source":"Open Food Facts","claim":null},"peanut":{"state":"unconfirmed","reason":"No explicit free-from label supplied.","source":"Open Food Facts","claim":null},"soya":{"state":"unconfirmed","reason":"No explicit free-from label supplied.","source":"Open Food Facts","claim":null},"vegan":{"state":"unconfirmed","reason":"No explicit preference label supplied.","source":"Open Food Facts"},"vegetarian":{"state":"unconfirmed","reason":"No explicit preference label supplied.","source":"Open Food Facts"}},"nutrition":{"protein":{"state":"supported","value":5,"unit":"g","basis":"100g","preparation":"as_sold","threshold":12,"reason":"At least 12% of energy from protein; requires source energy.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4","energyKcal":90,"energyPercent":22.22222222222222},"fibre":{"state":"supported","value":4,"unit":"g","basis":"100g","preparation":"as_sold","threshold":{"per100g":3,"per100kcal":1.5},"reason":"At least 3g per 100g or 1.5g per 100kcal.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4","energyKcal":90,"gramsPer100Kcal":4.444444444444445},"highfibre":{"state":"supported","value":4,"unit":"g","basis":"100g","preparation":"as_sold","threshold":{"per100g":6,"per100kcal":3},"reason":"At least 6g per 100g or 3g per 100kcal.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4","energyKcal":90,"gramsPer100Kcal":4.444444444444445},"iron":{"state":"unconfirmed","value":null,"unit":"mg","basis":"100g","preparation":"as_sold","threshold":2.1,"reason":"15% of label reference value per 100g; not a personalised daily target.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4"},"calcium":{"state":"unconfirmed","value":null,"unit":"mg","basis":"100g","preparation":"as_sold","threshold":120,"reason":"15% of label reference value per 100g; not a personalised daily target.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4"},"vitd":{"state":"unconfirmed","value":null,"unit":"µg","basis":"100g","preparation":"as_sold","threshold":0.75,"reason":"15% of label reference value per 100g; not a personalised daily target.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4"},"wholegrain":{"state":"unconfirmed","reason":"No wholegrain ingredient evidence supplied.","source":"Open Food Facts","ruleVersion":"food-discovery-2026-10-09-v4"}},"sourceURL":"https://world.openfoodfacts.org/product/5000000000001","retrievedAt":1792072800000,"sources":{"claims":"https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32006R1924","references":"https://www.legislation.gov.uk/eur/2011/1169/annex/XIII"}}]},"support":null,"supportTags":[{"barcode":"5000000000001","tags":[{"id":"plant_food_option","label":"Plant food option","contexts":["period","follicular","ovulation","luteal","perimenopause","postmenopause"],"evidence":"established_nutrition","evidenceDirection":"general_nutrition","wording":"An option for a varied, plant-rich eating pattern.","foodDataConfidence":"source_reported_identity","foodFamilies":["cooked_beans_peas"],"sources":[{"id":"emas_pattern_2020","title":"EMAS Mediterranean diet and menopausal health position statement","url":"https://pubmed.ncbi.nlm.nih.gov/32682573/"},{"id":"nhs_fibre","title":"NHS dietary fibre guidance","url":"https://www.nhs.uk/live-well/eat-well/digestive-health/how-to-get-more-fibre-into-your-diet/"}],"limitations":["Identified food-family candidate; nutrient amounts and symptom benefit are not verified for this product.","No claim that this product changes hormones or treats a symptom.","Mixed products need substantial identifiable pulse content.","General nutrition relevance only; no special follicular or ovulatory effect is established."]},{"id":"magnesium_premenstrual_candidate","label":"Magnesium foods and premenstrual comfort","contexts":["luteal"],"evidence":"research_only","evidenceDirection":"mixed","wording":"Possible premenstrual fit; evidence for ordinary foods is indirect and mixed.","foodDataConfidence":"source_reported_identity","foodFamilies":["cooked_beans_peas"],"sources":[{"id":"nih_magnesium","title":"NIH magnesium fact sheet","url":"https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/"},{"id":"magnesium_pms_1998","title":"Walker et al. magnesium and premenstrual symptoms","url":"https://pubmed.ncbi.nlm.nih.gov/9861593/"},{"id":"magnesium_pms_2002","title":"Walker et al. magnesium dose response","url":"https://pubmed.ncbi.nlm.nih.gov/12018972/"}],"limitations":["Identified food-family candidate; nutrient amounts and symptom benefit are not verified for this product.","Do not infer magnesium deficiency, treat anxiety, or copy supplement doses.","Mixed products need substantial identifiable pulse content."]},{"id":"pulse_satisfying_candidate","label":"Pulses and satisfying meals","contexts":["luteal"],"evidence":"limited_food_evidence","evidenceDirection":"suggestive","wording":"A pulse-based option when you feel hungrier.","foodDataConfidence":"source_reported_identity","foodFamilies":["cooked_beans_peas"],"sources":[{"id":"pulses_satiety_2014","title":"Li et al. pulses and satiety","url":"https://pubmed.ncbi.nlm.nih.gov/24820437/"}],"limitations":["Identified food-family candidate; nutrient amounts and symptom benefit are not verified for this product.","Not a hunger-suppression or lower-intake promise; record gas and portion.","Mixed products need substantial identifiable pulse content."]},{"id":"folate_food_adequacy_candidate","label":"Folate food options","contexts":["period","follicular","ovulation","luteal","perimenopause","postmenopause"],"evidence":"plausible_indirect","evidenceDirection":"conditional","wording":"An everyday nutrition candidate; fatigue benefits are uncertain.","foodDataConfidence":"source_reported_identity","foodFamilies":["cooked_beans_peas"],"sources":[{"id":"nih_folate","title":"NIH folate fact sheet","url":"https://ods.od.nih.gov/factsheets/Folate-HealthProfessional/"}],"limitations":["Identified food-family candidate; nutrient amounts and symptom benefit are not verified for this product.","Not an instant energy boost, deficiency diagnosis or substitute for investigation of persistent fatigue.","Mixed products need substantial identifiable pulse content.","General nutrition relevance only; no special follicular or ovulatory effect is established."]}]}]}"#.utf8)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var data = Self.bytes
        if let host = request.url?.host, host.hasPrefix("malformed-"), let index = Int(host.dropFirst(10).split(separator: ".")[0]) {
            let invalid: [Any] = [NSNull(), true, 7, "not-an-object", [], ["unexpected"]]
            var root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            root["support"] = invalid[index]; root["discovery"] = ["coverage": invalid[index]]
            data = try! JSONSerialization.data(withJSONObject: root)
        }
        if request.url?.host == "invalid-product.example.test" {
            var root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            root["ratings"] = [] // A nonempty product without matching source evidence is unusable.
            data = try! JSONSerialization.data(withJSONObject: root)
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
