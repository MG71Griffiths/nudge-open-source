import Foundation
import Testing
@testable import Nudge

struct BarcodeFeatureTests {
    @Test
    func sodiumConversionUsesDeclaredUnitsAndNeverOverridesSalt() throws {
        func parse(_ nutrients: [String: Any], preparation: String = "as_sold", legacy: [String: Any] = [:]) throws -> BarcodeProduct {
            let raw: [String: Any] = ["product": ["code":"1001", "product_name":"Named dessert", "nutriments":legacy,
                "nutrition":["aggregated_set":["per":"100g", "preparation":preparation, "nutrients":nutrients]]]]
            return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: raw), barcode: "1001")
        }
        let mg = try parse(["sodium":["value":300, "unit":"mg", "source":"packaging"]])
        #expect(mg.nutrients["salt"]?.value == 0.75)
        #expect(mg.nutrients["salt"]?.status == "calculated")
        #expect(mg.nutrientSources["salt"] == "Calculated from source sodium (mg × 2.5 ÷ 1000)")
        #expect(try parse(["sodium":["value":0.3, "unit":"g"]]).nutrients["salt"]?.value == 0.75)
        #expect(try parse(["sodium":["value":300, "unit":"mg"], "salt":["value":1, "unit":"g"]]).nutrients["salt"]?.value == 1)
        #expect(try parse(["sodium":["value":300, "unit":"mg", "source":"estimate"]]).nutrients["salt"]?.value == nil)
        #expect(try parse([:], preparation: "prepared", legacy: ["sodium_100g":0.3]).nutrients["salt"]?.value == nil)
    }

    @Test
    func staleOfflineFactsMigrateDurablyWithoutBecomingFresh() throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-offline-cache-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let legacy = parent.appendingPathComponent("old-cache"), durable = parent.appendingPathComponent("support")
        let now = Date(timeIntervalSince1970: 1_000_000), product = try catalogueFixture()
        ProductLookupCache(directory: legacy).write(product, now: now)
        let migrated = ProductLookupCache(directory: durable, legacyDirectory: legacy), later = now.addingTimeInterval(45 * 86_400)
        #expect(migrated.read(barcode: "1001", now: later) == nil)
        #expect(migrated.read(barcode: "1001", now: later, allowStale: true) == product)
        try FileManager.default.removeItem(at: legacy)
        let reopened = ProductLookupCache(directory: durable)
        #expect(reopened.read(barcode: "1001", now: later, allowStale: true) == product)
        #expect(reopened.read(barcode: "1001", now: later) == nil)
        #expect(reopened.read(barcode: "../1001", now: later, allowStale: true) == nil)
    }

    @Test
    func textProductSearchUsesExplicitTextEndpointAndDoesNotAcceptHealthFilters() throws {
        let query = try ProductSearchQuery("  peanut   butter  ", page: 2)
        #expect(query.text == "peanut butter")
        #expect(query.url.host == "search.openfoodfacts.org")
        #expect(query.url.path == "/search")
        #expect(query.url.query == nil)
        #expect(query.parameters["q"] as? String == "peanut AND butter")
        #expect(query.parameters["page"] as? Int == 2)
        #expect(query.parameters["page_size"] as? Int == 20)
        #expect(query.parameters.keys.allSatisfy { !["profile", "cycle", "rating", "token"].contains($0) })
        let operators = try ProductSearchQuery("brands:milk OR *", page: 1)
        #expect(operators.parameters["q"] as? String == "brands\\:milk AND \"OR\" AND \\*")
        for query in ["", "a", "milk luteal", "50%+ dinner", "perimenopause", "milk\nbrand", String(repeating: "a", count: 81)] {
            #expect(throws: ProductSearchError.invalidQuery) { try ProductSearchQuery(query, page: 1) }
        }
        #expect(throws: ProductSearchError.invalidQuery) { try ProductSearchQuery("milk", page: 21) }
    }

    @Test
    func productSearchKeepsSourceFactsAndDeduplicatesWithoutInventingCounts() throws {
        let data = Data(#"{"count":42,"page":1,"products":[{"code":"1001","product_name":"Milk","serving_size":"200 ml","nutriments":{"calcium_100g":0.12},"image_front_url":"https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg"},{"code":"1001","product_name":"Duplicate"},{"code":"bad","product_name":"Invalid"}]}"#.utf8)
        let result = try ProductSearchPage.parse(data, query: ProductSearchQuery("milk", page: 1), retrievedAt: Date())
        #expect(result.products.count == 1)
        #expect(result.products.first?.imageURL != nil)
        #expect(result.products.first?.micronutrients?["calcium"]?.value == 120)
        #expect(result.products.first?.micronutrients?["iron"]?.value == nil)
        #expect(result.products.first?.servingAmount == 200)
        #expect(result.products.first?.basisUnit == "ml")
        #expect(result.products.first?.nutritionPreparation == "as_sold")
        #expect(result.hasMore)
        #expect(result.cached == false)
        #expect(throws: ProductSearchError.invalidResponse) {
            try ProductSearchPage.parse(data, query: ProductSearchQuery("milk", page: 2), retrievedAt: Date())
        }
        let last = try ProductSearchPage.parse(Data(#"{"count":40,"products":[]}"#.utf8), query: ProductSearchQuery("milk", page: 2), retrievedAt: Date())
        #expect(last.hasMore == false)
    }

    @Test
    func micronutrientsKeepUnitsPreparationAndUncertaintySeparate() throws {
        let json = Data(#"{"product":{"code":"1001","product_name":"Prepared meal","serving_size":"40 g","nutriments":{"iron_100g":0.004,"calcium_100g":0.2},"nutrition":{"aggregated_set":{"per":"100g","preparation":"prepared","nutrients":{"iron":{"value":2.2,"unit":"mg","source":"estimate"},"calcium":{"value":0.03,"unit":"g","source":"packaging","modifier":"lt"}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: json, barcode: "1001")
        #expect(product.micronutrients?["iron"]?.value == 2.2)
        #expect(product.micronutrients?["iron"]?.status == "estimated")
        #expect(product.micronutrients?["calcium"]?.value == 30)
        #expect(product.micronutrients?["calcium"]?.relation == "lt")
        #expect(product.nutritionPreparation == "prepared")
        #expect(product.servingPreparation == nil)
        for basis in ["serving", "unrecognised"] {
            let raw: [String:Any] = ["product":["code":"1001","product_name":"Unknown basis","nutriments":["iron_100g":0.003],
                "nutrition":["aggregated_set":["per":basis,"preparation":"as_sold","nutrients":["iron":["value":5,"unit":"mg"]]]]]]
            let item = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: raw), barcode: "1001")
            #expect(item.micronutrients?["iron"]?.value == nil)
        }
        let missingUnit = Data(#"{"product":{"code":"1001","product_name":"Unknown unit","nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"iron":{"value":5}}}}}}"#.utf8)
        #expect(try OpenFoodFactsParser.parse(data: missingUnit, barcode: "1001").micronutrients?["iron"]?.value == nil)
    }

    @Test
    func productSearchCacheAndRateLimitRemainBoundedAndRecover() async throws {
        let state = ProductSearchState(), now = Date(timeIntervalSince1970: 1000)
        let query = try ProductSearchQuery("milk", page: 1)
        await state.save(ProductSearchPage(query: query, products: [], hasMore: false), at: now)
        let cached = await state.cached(query, at: now.addingTimeInterval(ProductSearchState.freshLifetime - 1))
        #expect(cached?.cached == true)
        let expired = await state.cached(query, at: now.addingTimeInterval(ProductSearchState.freshLifetime))
        #expect(expired == nil)
        for _ in 0..<8 { try await state.reserve(at: now) }
        do { try await state.reserve(at: now); Issue.record("Ninth live search must wait") }
        catch { #expect(error as? ProductSearchError == .rateLimited(60)) }
        try await state.reserve(at: now.addingTimeInterval(60))
        await state.pause(seconds: 120, at: now.addingTimeInterval(60))
        do { try await state.reserve(at: now.addingTimeInterval(70)); Issue.record("Provider Retry-After must be respected") }
        catch { #expect(error as? ProductSearchError == .rateLimited(110)) }
        try await state.reserve(at: now.addingTimeInterval(180))
        await state.pause(seconds: 7200, at: now.addingTimeInterval(180), statusCode: 429)
        do { try await state.reserve(at: now.addingTimeInterval(3780)); Issue.record("Provider Retry-After longer than an hour must remain active") }
        catch { #expect(error as? ProductSearchError == .providerRateLimited(3600)) }
        try await state.reserve(at: now.addingTimeInterval(7380))
    }

    @Test
    func productSearchNetworkUsesSameParserThenCachesPublicFacts() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductSearchURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState())
        let result = try await service.search(query: "milk")
        #expect(result.products.count == 1)
        #expect(result.products.first?.name == "Source milk")
        #expect(result.products.first?.nutrients["protein"]?.value == 3.5)
        let cached = try await service.search(query: "MILK")
        #expect(cached.cached)
        #expect(cached.products == result.products)
        #expect(result.httpStatus == 200)
        #expect(cached.httpStatus == nil)
    }

    @Test
    func productSearchCachePersistsPublicPagesWithoutQueryTextAndExpiresSafely() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let now = Date(timeIntervalSince1970: 10_000)
        let query = try ProductSearchQuery("A private phrase not in product facts", page: 1)
        let product = try OpenFoodFactsParser.parse(data: Data(#"{"product":{"code":"1001","product_name":"Source milk"}}"#.utf8), barcode: "1001", retrievedAt: now)
        let first = ProductSearchState(directory: directory)
        await first.save(ProductSearchPage(query: query, products: [product], hasMore: true), at: now)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        #expect(files.first?.lastPathComponent.range(of: #"^[a-f0-9]{64}\.json$"#, options: .regularExpression) != nil)
        let stored = try String(contentsOf: #require(files.first), encoding: .utf8)
        #expect(!stored.contains(query.text))
        let reopened = ProductSearchState(directory: directory)
        let fresh = await reopened.cached(query, at: now.addingTimeInterval(3600))
        #expect(fresh?.cached == true)
        #expect(fresh?.stale == false)
        #expect(fresh?.products == [product])
        #expect(fresh?.hasMore == true)
        #expect(fresh?.cachedAt == ISO8601DateFormatter().string(from: now))
        #expect(await reopened.cached(query, at: now.addingTimeInterval(86_400)) == nil)
        let fallback = await reopened.cached(query, at: now.addingTimeInterval(86_400), allowingStale: true)
        #expect(fallback?.stale == true)
        #expect(await reopened.cached(query, at: now.addingTimeInterval(7 * 86_400), allowingStale: true) == nil)
        #expect(await ProductSearchState(directory: directory).cached(query, at: now.addingTimeInterval(-1), allowingStale: true) == nil)
    }

    @Test
    func productSearchBusyResponseHasCooldownAndStalePublicFallback() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductSearchURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let now = Date(timeIntervalSince1970: 100_000)
        let state = ProductSearchState()
        let service = OpenFoodFactsService(now: { now }, cache: nil, searchSession: session, searchState: state, searchDiagnostics: nil)
        do { _ = try await service.search(query: "busy"); Issue.record("503 must give an actionable pause") }
        catch { #expect(error as? ProductSearchError == .providerBusy(503, 45)) }
        // A different query is also paused; changing food names cannot bypass a provider limit.
        do { _ = try await service.search(query: "milk"); Issue.record("Provider cooldown must apply to other queries") }
        catch { #expect(error as? ProductSearchError == .providerBusy(503, 45)) }
        let query = try ProductSearchQuery("busy", page: 1)
        let product = try OpenFoodFactsParser.parse(data: Data(#"{"product":{"code":"1001","product_name":"Previously loaded milk"}}"#.utf8), barcode: "1001", retrievedAt: now.addingTimeInterval(-86_400))
        await state.save(ProductSearchPage(query: query, products: [product], hasMore: false), at: now.addingTimeInterval(-86_400))
        let fallback = try await service.search(query: "busy")
        #expect(fallback.cached && fallback.stale)
        #expect(fallback.fallbackCode == "providerBusy")
        #expect(fallback.retryAfterSeconds == 45)
        #expect(fallback.httpStatus == 503)
        #expect(fallback.products == [product])
        // A successful fresh cache hit remains available during the same pause.
        await state.save(ProductSearchPage(query: try ProductSearchQuery("milk", page: 1), products: [product], hasMore: false), at: now)
        #expect(try await service.search(query: "milk").cached)
    }

    @Test
    func productSearchDistinguishesRemoteLimitsOfflineTimeoutAndUnreadableData() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductSearchURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        for (query, expected) in [("limited", ProductSearchError.providerRateLimited(90)), ("offline", .offline), ("timeout", .timeout), ("unreadable", .invalidResponse)] {
            let service = OpenFoodFactsService(cache: nil, searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil)
            do { _ = try await service.search(query: query); Issue.record("The failure must be identified") }
            catch { #expect(error as? ProductSearchError == expected) }
        }
        #expect(ProductSearchError.rateLimited(20).statusCode == nil)
        #expect(ProductSearchError.providerRateLimited(20).statusCode == 429)
        #expect(ProductSearchError.providerBusy(503, 45).message.contains("45 seconds"))
    }

    @Test
    func productSearchRetryAfterUnderstandsSecondsAndHTTPDates() throws {
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-05T10:00:00Z"))
        #expect(OpenFoodFactsService.searchRetryAfter("120", at: now, fallback: 60) == 120)
        #expect(OpenFoodFactsService.searchRetryAfter("Mon, 05 Oct 2026 10:02:00 GMT", at: now, fallback: 60) == 120)
        #expect(OpenFoodFactsService.searchRetryAfter("invalid", at: now, fallback: 60) == 60)
        #expect(OpenFoodFactsService.searchRetryAfter("999999", at: now, fallback: 60) == 999999)
        #expect(OpenFoodFactsService.searchRetryAfter("7200", at: now, fallback: 60) == 7200)
        #expect(OpenFoodFactsService.searchRetryAfter("Mon, 05 Oct 2026 12:00:00 GMT", at: now, fallback: 60) == 7200)
        #expect(OpenFoodFactsService.searchRetryAfter("-1", at: now, fallback: 60) == 1)
    }

    @Test
    func staleEmptySearchCacheDoesNotHideProviderFailure() async throws {
        let state = ProductSearchState(), now = Date(timeIntervalSince1970: 100_000)
        let query = try ProductSearchQuery("milk", page: 1)
        await state.save(ProductSearchPage(query: query, products: [], hasMore: false), at: now.addingTimeInterval(-86_400))
        #expect(await state.cached(query, at: now, allowingStale: true) == nil)
    }

    @Test
    func durableProductSearchCacheIsBoundedAndCorruptionIsAMiss() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = ProductSearchState(directory: directory), now = Date(timeIntervalSince1970: 100_000)
        for index in 0..<26 {
            let page = ProductSearchPage(query: try ProductSearchQuery("milk \(index)", page: 1), products: [], hasMore: false)
            await state.save(page, at: now.addingTimeInterval(Double(index)))
        }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(files.count == 24)
        let reopened = ProductSearchState(directory: directory)
        #expect(await reopened.cached(try ProductSearchQuery("milk 0", page: 1), at: now.addingTimeInterval(30)) == nil)
        #expect(await reopened.cached(try ProductSearchQuery("milk 25", page: 1), at: now.addingTimeInterval(30)) != nil)
        for file in files { try Data("not JSON".utf8).write(to: file) }
        let corrupted = ProductSearchState(directory: directory)
        #expect(await corrupted.cached(try ProductSearchQuery("milk 25", page: 1), at: now.addingTimeInterval(30)) == nil)
    }

    @Test
    func dedicatedSearchRetainsBrandAllergenImagesAndIndexProvenance() throws {
        let json = Data(#"{"hits":[{"code":"1001","product_name":"Greek yoghurt","brands":["Example","Foods"],"stores":["Tesco"],"quantity":"500 g","allergens_tags":["en:milk"],"categories_tags":["en:yogurts"],"image_front_url":"https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg","last_indexed_datetime":"2024-10-26T08:42:37.639265","last_modified_t":1678720310,"nutriments":{"proteins_100g":4.5,"salt_100g":0.1}}],"page":1,"page_size":20,"page_count":500,"count":10000,"is_count_exact":false,"timed_out":false}"#.utf8)
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-05T10:00:00Z"))
        let page = try ProductSearchPage.parse(json, query: ProductSearchQuery("yoghurt", page: 1), retrievedAt: now)
        let product = try #require(page.products.first)
        #expect(product.brand == "Example, Foods")
        #expect(product.allergens == ["milk"])
        #expect(product.imageURL != nil)
        #expect(product.categories == ["en:yogurts"])
        #expect(product.nutrients["protein"]?.value == 4.5)
        #expect(product.nutrients["fibre"]?.value == nil)
        #expect(product.micronutrients?["calcium"]?.value == nil)
        #expect(product.searchProvider == "open_food_facts_search")
        #expect(product.searchIndexedAt == "2024-10-26T08:42:37Z")
        #expect(product.retrievedAt == "2026-10-05T10:00:00Z")
        #expect(page.hasMore)
    }

    @Test
    func dedicatedSearchRejectsPartialErrorsAndMismatchedPages() throws {
        let query = try ProductSearchQuery("milk", page: 1)
        for raw in [#"{"hits":[],"page":1,"page_size":20,"timed_out":true}"#,
                    #"{"hits":[],"page":1,"page_size":20,"errors":[{"status":400}]}"#,
                    #"{"hits":[],"page":2,"page_size":20}"#,
                    #"{"hits":[],"page":true,"page_size":20}"#,
                    #"{"hits":[],"page":1,"page_size":10}"#] {
            #expect(throws: (any Error).self) { try ProductSearchPage.parse(Data(raw.utf8), query: query, retrievedAt: Date()) }
        }
        let final = try ProductSearchPage.parse(Data(#"{"hits":[],"page":1,"page_size":20,"page_count":0,"count":0,"timed_out":false}"#.utf8), query: query, retrievedAt: Date())
        #expect(final.products.isEmpty && !final.hasMore)
        let limited = try ProductSearchPage.parse(Data(#"{"hits":[],"page":20,"page_size":20,"page_count":500,"count":10000,"is_count_exact":false}"#.utf8), query: ProductSearchQuery("milk", page: 20), retrievedAt: Date())
        #expect(!limited.hasMore)
    }

    @Test
    func indexSnapshotsCannotReplaceNewerBarcodeFactsOrStopDetailRefresh() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductSearchURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let state = ProductSearchState()
        let indexed = try await OpenFoodFactsService(cache: cache, searchSession: session, searchState: state, searchDiagnostics: nil).search(query: "milk")
        #expect(indexed.products.first?.searchProvider == "open_food_facts_search")
        #expect(cache.read(barcode: "1001", now: Date()) == nil)
        let current = try OpenFoodFactsParser.parse(data: Data(#"{"product":{"code":"1001","product_name":"Current milk","last_modified_t":1767225600,"nutriments":{"proteins_100g":3.7}}}"#.utf8), barcode: "1001")
        cache.write(current, now: Date())
        let refreshed = try await OpenFoodFactsService(cache: cache, searchSession: session, searchState: ProductSearchState(), searchDiagnostics: nil).search(query: "milk")
        #expect(refreshed.products.first == current)
        let cached = try await OpenFoodFactsService(cache: cache, searchSession: session, searchState: state, searchDiagnostics: nil).search(query: "milk")
        #expect(cached.cached && cached.products.first == current)
        // Even an accidental generic cache write must not replace the full fact record.
        cache.write(try #require(indexed.products.first), now: Date())
        #expect(cache.read(barcode: "1001", now: Date()) == current)
    }

    @Test
    func previousEmptySearchCacheCannotSuppressNewServiceResults() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let query = try ProductSearchQuery("milk", page: 1), now = Date()
        await ProductSearchState(directory: directory).save(ProductSearchPage(query: query, products: [], hasMore: false), at: now)
        let url = try #require(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        json["version"] = 1
        try JSONSerialization.data(withJSONObject: json).write(to: url)
        #expect(await ProductSearchState(directory: directory).cached(query, at: now.addingTimeInterval(1)) == nil)
    }

    @Test
    func parsesIdentityAllergensLiquidBasisAndSuppliedNutrients() throws {
        let json = """
        {
          "status": "success",
          "product": {
            "code": "5012345678900",
            "product_name": "Tomato juice",
            "brands": "Example Foods",
            "quantity": "750 ml",
            "product_quantity_unit": "ml",
            "ingredients_text": "Tomato juice, salt",
            "allergens_tags": ["en:celery"],
            "traces_tags": ["en:milk"],
            "nutriments": {
              "energy-kcal_100g": 24,
              "proteins_100g": 1.1,
              "carbohydrates_100g": 4.2,
              "sugars_100g": 3.5,
              "fat_100g": 0.2,
              "saturated-fat_100g": 0.0,
              "fiber_100g": 0.6,
              "salt_100g": 0.5
            }
          }
        }
        """
        let date = try #require(ISO8601DateFormatter().date(from: "2026-09-30T12:00:00Z"))
        let product = try OpenFoodFactsParser.parse(
            data: Data(json.utf8),
            barcode: "5012345678900",
            retrievedAt: date
        )

        #expect(product.name == "Tomato juice")
        #expect(product.brand == "Example Foods")
        #expect(product.packSize == "750 ml")
        #expect(product.basisUnit == "ml")
        #expect(product.allergens == ["celery"])
        #expect(product.traces == ["milk"])
        #expect(product.nutrients["protein"] == NutrientValue(value: 1.1, unit: "g", status: "supplied"))
        #expect(product.retrievedAt == "2026-09-30T12:00:00Z")
    }

    @Test
    func parsesManiLifeNutritionFromV36StructuredResponse() throws {
        // Captured from the app's projected v3.6 request for 5060560280040 on 1 October 2026.
        let json = """
        {
          "code":"5060560280040","errors":[],"status":"success","warnings":[],
          "product":{
            "allergens_tags":[],"brands":"ManiLife","code":"5060560280040",
            "ingredients_text":"Hi-oleic Peanuts (99.1%),Sea Salt (0.9%) ALLERGENS: See ingredients in bold. Made in a factory that handles dairy and other nuts.",
            "nutriments":{},"nutrition_data_per":"100g","product_name":"Deep roast crunchy",
            "product_name_en":"Deep roast crunchy","product_quantity":900,
            "product_quantity_unit":"g","quantity":"900g","traces_tags":[],
            "nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{
              "carbohydrates":{"source":"packaging","source_per":"100g","unit":"g","value":10.1},
              "energy-kcal":{"source":"packaging","source_per":"100g","unit":"kcal","value":619,"value_computed":618.7},
              "fat":{"source":"packaging","source_per":"100g","unit":"g","value":50.5},
              "fiber":{"source":"packaging","source_per":"100g","unit":"g","value":9.1},
              "proteins":{"source":"packaging","source_per":"100g","unit":"g","value":26.4},
              "salt":{"source":"packaging","source_per":"100g","unit":"g","value":0.9,"value_computed":0.885},
              "saturated-fat":{"source":"packaging","source_per":"100g","unit":"g","value":6},
              "sugars":{"source":"packaging","source_per":"100g","unit":"g","value":5.5}
            }}}
          },"result":{"id":"product_found","name":"Product found"}
        }
        """
        let product = try OpenFoodFactsParser.parse(data: Data(json.utf8), barcode: "5060560280040")

        #expect(product.name == "Deep roast crunchy")
        #expect(product.brand == "ManiLife")
        #expect(product.packSize == "900g")
        #expect(product.basisUnit == "g")
        #expect(product.nutrients["energyKcal"] == NutrientValue(value: 619, unit: "kcal", status: "supplied"))
        #expect(product.nutrients["protein"]?.value == 26.4)
        #expect(product.nutrients["carbohydrate"]?.value == 10.1)
        #expect(product.nutrients["sugars"]?.value == 5.5)
        #expect(product.nutrients["fat"]?.value == 50.5)
        #expect(product.nutrients["saturatedFat"]?.value == 6)
        #expect(product.nutrients["fibre"]?.value == 9.1)
        #expect(product.nutrients["salt"]?.value == 0.9)
        #expect(product.nutrients.values.allSatisfy { $0.status == "supplied" })
        #expect(PortionCalculator.scaled(per100: product.nutrients["energyKcal"]?.value, amount: 30) == 185.7)
        #expect(PortionCalculator.scaled(per100: product.nutrients["protein"]?.value, amount: 30) == 7.9)
    }

    @Test
    func missingValuesRemainUnknownRatherThanZero() throws {
        let json = """
        {
          "status": "success",
          "product": {
            "code": "5012345678900",
            "product_name": "Incomplete product",
            "nutriments": {"proteins_100g": 2.5}
          }
        }
        """
        let product = try OpenFoodFactsParser.parse(data: Data(json.utf8), barcode: "5012345678900")
        #expect(product.nutrients["protein"]?.value == 2.5)
        #expect(product.nutrients["protein"]?.status == "supplied")
        #expect(product.nutrients["energyKcal"]?.value == nil)
        #expect(product.nutrients["energyKcal"]?.status == "unknown")
        #expect(product.allergens == nil)
        #expect(product.traces == nil)
    }

    @Test
    func preservesOnlySourceSuppliedProductImagesAndRatings() throws {
        let data = Data(#"{"product":{"code":"1001","product_name":"Actual product","selected_images":{"front":{"display":{"en":"https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg"}}},"nutriscore_grade":"C","nova_group":3,"additives_tags":["en:e322","en:e322","en:e500-ii","made-up"],"nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        #expect(product.imageURL == "https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg")
        #expect(product.nutriScoreGrade == "c")
        #expect(product.novaGroup == 3)
        #expect(product.additiveTags == ["en:e322", "en:e500-ii"])
        #expect(product.nutritionPreparation == "as_sold")
        #expect(product.nutrients.values.allSatisfy { $0.value == nil })
        let invalid = Data(#"{"product":{"code":"1001","product_name":"Unrated","image_front_url":"https://untrusted.example/image.jpg","nutriscore_grade":"unknown","nova_group":4.5}}"#.utf8)
        let unrated = try OpenFoodFactsParser.parse(data: invalid, barcode: "1001")
        #expect(unrated.imageURL == nil)
        #expect(unrated.nutriScoreGrade == nil)
        #expect(unrated.novaGroup == nil)
        #expect(unrated.additiveTags == nil)
        #expect(unrated.nutritionPreparation == nil)
    }

    @Test
    func productImageSelectionSkipsURLsTheNativeLoaderCannotRender() throws {
        let valid = "https://images.openfoodfacts.org/images/products/1001/front_en.1.200.jpg"
        let fields: [String: Any] = ["code": "1001", "product_name": "Image fixture",
            "selected_images": ["front": ["display": ["en": "https://images.openfoodfacts.org/images/products/1001/front_en.1.400.jpg?blocked=true"],
                                            "small": ["en": valid]]]]
        let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": fields]), barcode: "1001")
        #expect(product.imageURL == valid)
        #expect(product.displayImageURL == valid)
    }

    @Test
    func productImageSelectionPrefersSmallSourceWithoutChangingItsProvenance() throws {
        let small = "https://images.openfoodfacts.org/images/products/1001/front_en.1.200.jpg"
        let display = small.replacingOccurrences(of: ".200.jpg", with: ".400.jpg")
        let thumb = small.replacingOccurrences(of: ".200.jpg", with: ".100.jpg")
        let selected: [String: Any] = ["front": ["display": ["en": display], "small": ["en": small], "thumb": ["en": thumb]]]
        for fields in [
            ["selected_images": selected, "image_front_url": display],
            ["image_front_url": display, "image_front_small_url": small]
        ] as [[String: Any]] {
            let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": fields.merging(["code": "1001", "product_name": "Image fixture"]) { old, _ in old }]), barcode: "1001")
            #expect(product.imageURL == small)
            #expect(product.displayImageURL == small)
        }
    }

    @Test
    func preparedNutritionNeverFillsMissingValuesFromAsSoldProfile() throws {
        let data = Data(#"{"product":{"code":"1001","product_name":"Meal kit","nutriments":{"proteins_100g":42,"energy_100g":4184},"nutrition":{"aggregated_set":{"per":"100g","preparation":"prepared","nutrients":{"salt":{"value":0.5,"unit":"g"}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        #expect(product.nutritionPreparation == "prepared")
        #expect(product.nutrients["salt"]?.value == 0.5)
        #expect(product.nutrients["protein"]?.value == nil)
        #expect(product.nutrients["energyKcal"]?.value == nil)
    }

    @Test
    func explicitMassBasisWinsOverLiquidPackHints() throws {
        let json = #"{"status":"success","product":{"code":"5012345678900","product_name":"Mass-based drink label","quantity":"1 l","serving_quantity":250,"serving_quantity_unit":"ml","nutrition":{"aggregated_set":{"per":"100g","nutrients":{"proteins":{"value":3,"unit":"g"}}}}}}"#
        let product = try OpenFoodFactsParser.parse(data: Data(json.utf8), barcode: "5012345678900")
        #expect(product.basisUnit == "g")
        #expect(product.servingAmount == nil)
    }

    @Test
    func derivesKcalFromSuppliedKilojoulesAndNormalisesLiquidServing() throws {
        let json = """
        {
          "status": "success",
          "product": {
            "code": "5012345678900",
            "product_name": "Test drink",
            "quantity": "1 l",
            "serving_quantity": 33,
            "serving_quantity_unit": "cl",
            "nutriments": {"energy_100g": 418.4}
          }
        }
        """
        let product = try OpenFoodFactsParser.parse(data: Data(json.utf8), barcode: "5012345678900")
        #expect(product.basisUnit == "ml")
        #expect(product.servingAmount == 330)
        #expect(product.nutrients["energyKcal"]?.value == 100)
        #expect(product.nutrients["energyKcal"]?.status == "calculated")
    }

    @Test
    func explicitLegacyNutritionBasisWinsBeforePackHintsWithoutMixingPreparedTables() throws {
        func parse(_ extra: [String: Any]) throws -> BarcodeProduct {
            let fields: [String: Any] = ["code": "1001", "product_name": "Synthetic basis fixture",
                "nutriments": ["proteins_100g": 7]]
            return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": fields.merging(extra, uniquingKeysWith: { _, new in new })]), barcode: "1001")
        }
        let liquid = try parse(["nutrition_data_per": "100ml"])
        #expect(liquid.basisUnit == "ml")
        #expect(liquid.nutrients["protein"]?.value == 7)
        let mass = try parse(["nutrition_data_per": "100g", "quantity": "1 l", "serving_quantity": 250, "serving_quantity_unit": "ml"])
        #expect(mass.basisUnit == "g")
        #expect(mass.servingAmount == nil, "A volume serving cannot become grams through a liquid pack hint")
        let prepared = try parse(["nutrition_data_per": "100ml", "nutrition": ["aggregated_set": ["preparation": "prepared", "per": "100g", "nutrients": ["salt": ["value": 0.5, "unit": "g"]]]]])
        #expect(prepared.basisUnit == "g")
        #expect(prepared.nutrients["protein"]?.value == nil)
        #expect(prepared.nutrients["salt"]?.value == 0.5)
        #expect(try parse(["nutrition_data_per": "100ml", "nutrition_data_prepared": "on"]).basisUnit == "g", "Prepared-only records cannot borrow an as-sold legacy denominator")
    }

    @Test
    func rejectsUnknownAndUnidentifiableProducts() throws {
        let notFound = Data(#"{"status":0}"#.utf8)
        #expect(throws: BarcodeLookupError.notFound) {
            try OpenFoodFactsParser.parse(data: notFound, barcode: "5012345678900")
        }
        for malformed in [#"{"status":"failure"}"#, #"{"status":"success"}"#, #"{"errors":[{"message":{"id":"server_error"}}]}"#] {
            #expect(throws: BarcodeLookupError.invalidResponse) {
                try OpenFoodFactsParser.parse(data: Data(malformed.utf8), barcode: "5012345678900")
            }
        }
        #expect(throws: BarcodeLookupError.notFound) {
            try OpenFoodFactsParser.parse(data: Data(#"{"status":"failure","errors":[{"message":{"id":"product_not_found"}}]}"#.utf8), barcode: "5012345678900")
        }

        let unnamed = Data(#"{"status":"success","product":{"code":"5012345678900"}}"#.utf8)
        #expect(throws: BarcodeLookupError.incompleteProduct) {
            try OpenFoodFactsParser.parse(data: unnamed, barcode: "5012345678900")
        }
    }

    @Test
    func calculatesGramAndMillilitrePortionsWithoutInventingMissingValues() {
        #expect(PortionCalculator.scaled(per100: 4.2, amount: 250) == 10.5)
        #expect(PortionCalculator.scaled(per100: 60, amount: 330) == 198)
        #expect(PortionCalculator.scaled(per100: nil, amount: 100) == nil)
        #expect(PortionCalculator.scaled(per100: 4.2, amount: 0) == nil)
    }
    @Test
    func parsesPrintedHouseholdServingAndRetailerWithoutInventingMass() throws {
        let data = Data(#"{"product":{"code":"00461498","product_name":"Peanut butter","brands":"Sainsbury's","serving_size":"1 tbsp (15 g)","categories_tags":["en:peanut-butters"],"stores_tags":["sainsbury-s"]}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "00461498")
        #expect(product.servingAmount == 15)
        #expect(product.servingLabel == "1 tbsp")
        #expect(product.retailer == "Sainsbury’s")
        #expect(product.categories == ["en:peanut-butters"])
        let noMass = Data(#"{"product":{"code":"00461498","product_name":"Peanut butter","serving_size":"1 tbsp"}}"#.utf8)
        #expect(try OpenFoodFactsParser.parse(data: noMass, barcode: "00461498").servingAmount == nil)
    }

    @Test
    func alternativePoolPreservesRetailersAndRequiresComparableEvidence() throws {
        func product(_ code: String, category: String = "en:peanut-butters", shop: String = "Sainsbury's", preparation: String = "as_sold", unit: String = "100g") throws -> BarcodeProduct {
            let value: [String: Any] = ["code": code, "product_name": code, "brands": shop,
                "categories_tags": [category], "labels_tags": ["en:vegan", "en:gluten-free"],
                "nutrition": ["aggregated_set": ["per": unit, "preparation": preparation, "nutrients": ["sugars": ["value": 2, "unit": "g"]]]]]
            return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": value]), barcode: code)
        }
        let options = try [product("1001"), product("1002", shop: "Tesco"), product("1003", preparation: "prepared"),
            product("1004", unit: "100ml"), product("1005", category: "en:chocolates"), product("1000")]
        let pool = FoodAlternatives.candidates(options + [options[0]], excluding: "1000", category: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "as_sold")
        #expect(pool.map(\.barcode) == ["1001", "1002"])
        #expect(pool[1].retailer == "Tesco")
        #expect(pool[0].labelsTags == ["en:vegan", "en:gluten-free"])
        #expect(pool.allSatisfy { $0.alternativeReason == nil })
        #expect(FoodAlternatives.candidates(options, excluding: nil, category: "en:peanut-butters", basisUnit: "g", nutritionPreparation: "unknown").isEmpty)
        #expect(FoodAlternatives.retailer(brand: "ManiLife", stores: ["tesco", "sainsbury-s"]) == nil)
        #expect(FoodAlternatives.canonicalRetailer("M&S Food") == "M&S")
        #expect(FoodAlternatives.validCategory("en:peanut-butters&stores_tags=anything") == false)
    }

    @Test
    func householdVolumesRequirePrintedPhysicalAmount() throws {
        let liquid = Data(#"{"product":{"code":"1001","product_name":"Oil","serving_size":"1 tablespoon (15 ml)"}}"#.utf8)
        let parsed = try OpenFoodFactsParser.parse(data: liquid, barcode: "1001")
        #expect(parsed.basisUnit == "ml")
        #expect(parsed.servingAmount == 15)
        for invalid in ["tbsp", "cups", "pieces"] {
            let raw: [String: Any] = ["product": ["code": "1001", "product_name": "Unknown serving", "serving_quantity": 1, "serving_quantity_unit": invalid]]
            let data = try JSONSerialization.data(withJSONObject: raw)
            #expect(try OpenFoodFactsParser.parse(data: data, barcode: "1001").servingAmount == nil)
        }
    }

    @Test
    func retailerSearchReturnsSourcedCandidatesForSharedScoreCalculation() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AlternativesURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let service = OpenFoodFactsService(productReadState: ProductReadState(), session: session, cache: nil, searchSession: session, searchState: ProductSearchState(),
            alternativesState: ProductAlternativesState(), catalogueLookup: { _ in throw NutritionLabelService.ServiceError.notConfigured })
        let products = try await service.alternatives(barcode: "1001", referenceNutrients: ["sugars": 10], basisUnit: "g", nutritionPreparation: "as_sold", selectedStore: .sainsburys)
        #expect(products.count == 1)
        #expect(products.first?.alternativeReason == nil)
        #expect(products.first?.nutrients["sugars"]?.value == 2)
        #expect(products.first?.retailer == "Sainsbury’s")
    }

    @Test
    func preservesDefensibleServingPackAndNutrientProvenance() throws {
        let data = Data(#"{"product":{"code":"1001","product_name":"Seed bread","quantity":"2 x 400 g","product_quantity":"800","product_quantity_unit":"g","serving_size":"2 thick slices (80 g)","countries_tags":["en:united-kingdom","invalid country"],"nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"proteins":{"value":10.3,"unit":"g","source":"packaging"}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        #expect(product.servingDescription == "2 thick slices (80 g)")
        #expect(product.servingLabel == "2 thick slices")
        #expect(product.servingAmount == 80)
        #expect(product.packAmount == 800)
        #expect(product.packUnit == "g")
        #expect(product.packPreparation == "as_sold")
        #expect(product.countriesTags == ["en:united-kingdom"])
        #expect(product.nutrientSources["protein"] == "packaging")
        #expect(product.nutrientSources["salt"] == nil)
    }

    @Test
    func ambiguousPackAndUnsupportedDensityStayUnknown() throws {
        for quantity in ["6 x 25 g", "6 pieces", "500 ml"] {
            let raw: [String: Any] = ["product": ["code": "1001", "product_name": "Mass-based label", "quantity": quantity,
                "nutrition": ["aggregated_set": ["per": "100g", "nutrients": [:]]]]]
            let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: raw), barcode: "1001")
            #expect(product.packAmount == nil)
            #expect(product.packUnit == nil)
        }
        let simple = Data(#"{"product":{"code":"1001","product_name":"Rice","quantity":"10 kg ℮"}}"#.utf8)
        let rice = try OpenFoodFactsParser.parse(data: simple, barcode: "1001")
        #expect(rice.packAmount == 10_000)
        let prepared = Data(#"{"product":{"code":"1001","product_name":"Dry soup","quantity":"100 g","nutrition":{"aggregated_set":{"per":"100g","preparation":"prepared","nutrients":{"salt":{"value":0.4,"unit":"g"}}}}}}"#.utf8)
        let soup = try OpenFoodFactsParser.parse(data: prepared, barcode: "1001")
        #expect(soup.nutritionPreparation == "prepared")
        #expect(soup.packPreparation == "as_sold")
    }

    @Test
    func preservesIngredientEvidenceWithoutTreatingTracesAsIngredients() throws {
        let text = "Hi-oleic Peanuts (99.1%), Sea Salt (0.9%). Made in a factory that handles other nuts."
        let raw: [String: Any] = ["product": ["code": "1001", "product_name": "Peanut spread", "ingredients_text": text,
            "ingredients": [["id": "en:peanuts", "text": "Hi-oleic Peanuts", "percent": 99.1, "vegan": "yes"],
                ["id": "en:sea-salt", "text": "Sea Salt", "percent": 0.9]],
            "allergens": "Peanuts", "allergens_tags": ["en:peanuts"],
            "ingredients_analysis_tags": ["en:vegan", "en:vegetarian", "en:vegan", "en:palm-oil-free"],
            "traces": "May contain sesame.", "traces_tags": ["en:sesame"]]]
        let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: raw), barcode: "1001")
        #expect(product.ingredients == text)
        #expect(product.allergensText == "Peanuts")
        #expect(product.tracesText == "May contain sesame.")
        #expect(product.ingredientItems?.map(\.id) == ["en:peanuts", "en:sea-salt"])
        #expect(product.ingredientItems?.first?.percent == 99.1)
        #expect(product.ingredientItems?.contains(where: { $0.id == "en:sesame" }) == false)
        #expect(product.ingredientsAnalysisTags == ["en:vegan", "en:vegetarian"])
    }

    @Test
    func retainsLeafIngredientsWithoutPromotingEstimatedPercentages() throws {
        let data = Data(#"{"product":{"code":"1001","product_name":"Seed bread","ingredients":[{"id":"en:flour-mixture","text":"Flours","ingredients":[{"id":"en:wheat-flour","text":"Wheat flour","percent_estimate":75},{"id":"en:oat-flour","text":"Oat flour","percent":10}]},{"id":"en:water","text":"Water","percent":200}]}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        #expect(product.ingredientItems?.map(\.id) == ["en:wheat-flour", "en:oat-flour", "en:water"])
        #expect(product.ingredientItems?[0].percent == nil)
        #expect(product.ingredientItems?[1].percent == 10)
        #expect(product.ingredientItems?[2].percent == nil)
        let unknown = Data(#"{"product":{"code":"1001","product_name":"Unknown", "allergens_tags":["en:peanuts"],"ingredients_analysis_tags":["en:vegan-status-unknown","en:vegetarian-status-unknown"]}}"#.utf8)
        let parsed = try OpenFoodFactsParser.parse(data: unknown, barcode: "1001")
        #expect(parsed.ingredientItems == nil)
        #expect(parsed.ingredientsAnalysisTags.isEmpty)
    }

    @Test
    func preservesVersionedNutriScoreComponentsAndExplicitUnknowns() throws {
        let raw = Data(#"{"product":{"code":"1001","product_name":"Rated food","nutriscore_grade":"a","nutriscore":{"2021":{"grade":"a","score":-3},"2023":{"category_available":1,"nutrients_available":1,"nutriscore_applicable":1,"nutriscore_computed":1,"grade":"d","score":13,"data":{"is_beverage":0,"is_cheese":0,"is_water":0,"is_fat_oil_nuts_seeds":0,"is_red_meat_product":0,"negative_points":16,"positive_points":3,"count_proteins":0,"count_proteins_reason":"negative_points_greater_than_or_equal_to_11","components":{"negative":[{"id":"salt","value":3.2,"unit":"g","points":15,"points_max":20}],"positive":[{"id":"fiber","value":null,"unit":"g","points":3,"points_max":5}]}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: raw, barcode: "1001")
        let score = try #require(product.nutriScore2023)
        #expect(score.methodId == "nutri-score-2023")
        #expect(score.version == "2023")
        #expect(score.computed == true)
        #expect(score.applicable == true)
        #expect(score.grade == "D")
        #expect(score.rawScore == 13)
        #expect(product.nutriScoreGrade == "d")
        #expect(score.isBeverage == false)
        #expect(score.countProteins == false)
        #expect(score.components?.negative.first?.value == 3.2)
        #expect(score.components?.positive.first?.value == nil)
        #expect(score.components?.positive.first?.points == 3)
        #expect(product.scoringFacts?.isBeverage == false)
        #expect(product.scoringFacts?.hasNonNutritiveSweeteners == nil)
        #expect(product.scoringFacts?.fvlPercent == nil)
    }

    @Test
    func scoringKeepsExactSourceKilojoulesWithoutInventingOrMixingPreparation() throws {
        let declared = Data(#"{"product":{"code":"1001","product_name":"Food","nutriments":{"energy_100g":900},"nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"energy-kj":{"value":335.1,"unit":"kJ","source":"packaging"},"energy-kcal":{"value":80,"unit":"kcal","source":"packaging"}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: declared, barcode: "1001")
        #expect(product.energyKj == .supplied(335.1, unit: "kJ"))
        #expect(product.nutrients["energyKcal"]?.value == 80)
        #expect(product.nutrientSources["energyKj"] == "packaging")
        let encoded = try JSONEncoder().encode(product)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let body = try NutritionLabelService.productScoreBody(product: object)
        let request = try #require(JSONSerialization.jsonObject(with: body) as? [String: [String: Any]])
        #expect((request["product"]?["energyKj"] as? [String: Any])?["value"] as? Double == 335.1)
        #expect((request["product"]?["nutrientSources"] as? [String: String])?["energyKj"] == "packaging")
        let cases: [(String, String?)] = [
            (#"{"product":{"code":"1001","product_name":"Food","nutriments":{"energy-kcal_100g":80}}}"#, nil),
            (#"{"product":{"code":"1001","product_name":"Food","nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"energy-kj":{"value_computed":335,"unit":"kJ"}}}}}}"#, "calculated"),
            (#"{"product":{"code":"1001","product_name":"Food","nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"energy":{"value":335,"unit":"kJ","source":"packaging"}}}}}}"#, "supplied"),
            (#"{"product":{"code":"1001","product_name":"Food","nutriments":{"energy_100g":335,"energy_unit":"kcal"}}}"#, nil),
            (#"{"product":{"code":"1001","product_name":"Food","nutriments":{"energy_100g":900},"nutrition":{"aggregated_set":{"per":"100g","preparation":"prepared","nutrients":{"energy-kcal":{"value":80,"unit":"kcal"}}}}}}"#, nil),
            (#"{"product":{"code":"1001","product_name":"Food","nutrition":{"aggregated_set":{"per":"100g","nutrients":{"energy-kj":{"value":335,"unit":"kJ","source":"estimate"}}}}}}"#, "estimated")
        ]
        for (json, expectedStatus) in cases {
            let parsed = try OpenFoodFactsParser.parse(data: Data(json.utf8), barcode: "1001")
            #expect(parsed.energyKj?.status == expectedStatus)
            if expectedStatus == nil { #expect(parsed.nutrientSources["energyKj"] == nil) }
            let facts = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(parsed)) as? [String: Any])
            let projected = try #require(JSONSerialization.jsonObject(with: NutritionLabelService.productScoreBody(product: facts)) as? [String: [String: Any]])
            if expectedStatus == "supplied" {
                #expect((projected["product"]?["energyKj"] as? [String: Any])?["value"] as? Double == 335)
            } else {
                #expect(projected["product"]?["energyKj"] == nil, "Keeping estimated/computed kJ provenance must not promote it to exact scoring input")
            }
        }
    }

    @Test
    func nutrientBoundsSurviveSourceParsingAndScoringProjection() throws {
        let raw = Data(#"{"product":{"code":"1001","product_name":"Bounded food","nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"energy-kj":{"value":335,"unit":"kJ","source":"packaging","modifier":"<"},"salt":{"value":0.1,"unit":"g","modifier":"<="}}}},"nutriments":{"sugars_100g":0.5,"sugars_modifier":"<"}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: raw, barcode: "1001")
        #expect(product.energyKj?.relation == "<")
        #expect(product.nutrients["energyKcal"]?.relation == "<")
        #expect(product.nutrients["salt"]?.relation == "<=")
        #expect(product.nutrients["sugars"]?.relation == "<")
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(product)) as? [String: Any])
        let upload = try NutritionLabelService.productScoreBody(product: object)
        let sent = try #require(JSONSerialization.jsonObject(with: upload) as? [String: [String: Any]])
        #expect((sent["product"]?["energyKj"] as? [String: Any])?["relation"] as? String == "<")
        #expect((sent["product"]?["nutrients"] as? [String: [String: Any]])?["salt"]?["relation"] as? String == "<=")
        let unsupported: [String: Any] = ["name": "Unsupported", "energyKj": ["value": 100, "unit": "kJ", "status": "supplied", "relation": "unclear"],
            "nutrients": ["salt": ["value": 1, "unit": "g", "relation": "unclear"]]]
        let rejected = try #require(JSONSerialization.jsonObject(with: NutritionLabelService.productScoreBody(product: unsupported)) as? [String: [String: Any]])
        #expect(rejected["product"]?["energyKj"] == nil)
        #expect((rejected["product"]?["nutrients"] as? [String: [String: Any]])?["salt"]?["value"] is NSNull)
    }

    @Test
    func scoringPercentagesRequireDeclaredEvidenceAndNeverUseProviderEstimates() throws {
        for source in ["packaging", "manufacturer", "estimate"] {
            let raw: [String: Any] = ["product": ["code": "1001", "product_name": "Vegetables",
                "nutrition": ["aggregated_set": ["per": "100g", "nutrients": [
                    "fruits-vegetables-legumes": ["value": 80, "unit": "%", "source": source]]]]]]
            let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: raw), barcode: "1001")
            if source == "estimate" { #expect(product.scoringFacts == nil) }
            else { #expect(product.scoringFacts?.fvlPercent?.value == 80) }
        }
        for modifier in ["<", "<=", "~", ">=", ">", "unclear"] {
            let raw: [String: Any] = ["product": ["code": "1001", "product_name": "Bounded percentage",
                "nutrition": ["aggregated_set": ["per": "100g", "nutrients": [
                    "fruits-vegetables-legumes": ["value": 80, "unit": "%", "source": "packaging", "modifier": modifier]]]]]]
            let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: raw), barcode: "1001")
            #expect(product.scoringFacts?.fvlPercent == nil)
        }
        let data = Data(#"{"product":{"code":"1001","product_name":"Unknown mix","nutriscore":{"2023":{"category_available":1,"data":{"is_beverage":0,"components":{"negative":[],"positive":[{"id":"fruits_vegetables_legumes","value":80,"unit":"%","points":2,"points_max":5}]}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        #expect(product.scoringFacts?.isBeverage == false)
        #expect(product.scoringFacts?.isCheese == nil)
        #expect(product.scoringFacts?.fvlPercent == nil)
        let raw: [String: Any] = ["name": "Evidence only", "scoringFacts": ["source": "Printed declaration", "isWater": false, "isCheese": "false", "isBeverage": 0,
            "fvlPercent": ["value": 100, "source": "estimate", "evidence": "guessed"], "privateNote": "secret"]]
        let upload = try NutritionLabelService.productScoreBody(product: raw)
        let sent = try #require(JSONSerialization.jsonObject(with: upload) as? [String: [String: Any]])
        let facts = try #require(sent["product"]?["scoringFacts"] as? [String: Any])
        #expect(facts["isWater"] as? Bool == false)
        #expect(facts["isCheese"] is NSNull)
        #expect(facts["isBeverage"] is NSNull)
        #expect(facts["fvlPercent"] is NSNull)
        #expect(facts["privateNote"] == nil)
    }

    @Test
    func neverPromotesOldUnknownOrUncomputedNutriScores() throws {
        func product(_ record: [String: Any]) throws -> BarcodeProduct {
            let data = try JSONSerialization.data(withJSONObject: ["product": ["code": "1001", "product_name": "Food", "nutriscore": record]])
            return try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        }
        #expect(try product(["2021": ["grade": "a", "score": -3]]).nutriScore2023 == nil)
        for flag in [0, "false", NSNull(), 2] as [Any] {
            let score = try #require(product(["2023": ["nutriscore_computed": flag, "nutriscore_applicable": 1,
                "category_available": 1, "nutrients_available": 1, "grade": "a", "score": 0]]).nutriScore2023)
            #expect(score.grade == nil)
            #expect(score.rawScore == nil)
            #expect(score.isCheese == nil)
        }
        let missing = try #require(product(["2023": [:]]).nutriScore2023)
        #expect(missing.computed == nil)
        #expect(missing.applicable == nil)
        let malformed = try product(["2023": ["nutriscore_computed": 1, "nutriscore_applicable": 1,
            "category_available": 1, "nutrients_available": 1, "grade": "a", "score": true]])
        #expect(malformed.nutriScore2023?.grade == nil)
        #expect(malformed.nutriScore2023?.rawScore == nil)
    }

    @Test
    func productScoreUploadStripsPrivateContextAndPreservesMissingNutrients() throws {
        let raw: [String: Any] = ["name": "Food", "brand": "Maker", "barcode": "1001", "basisUnit": "g",
            "nutritionPreparation": "as_sold", "ingredients": ["text": "Peanuts (99%), salt", "needsReview": true, "privateNote": "secret"],
            "ingredientsNeedsReview": false,
            "ingredientItems": [["id": "en:peanuts", "text": "Peanuts", "percent": 99, "privateNote": "secret"]],
            "nutrients": ["salt": ["value": 1.0, "unit": "g", "status": "supplied", "token": "secret"],
                          "sugars": ["value": 0.1, "unit": "g", "relation": "lt"],
                          "fat": ["value": 77, "unit": "g", "status": "unknown"]],
            "diary": ["entries": [1, 2]], "profile": ["email": "private@example.test"],
            "token": "secret", "imageBase64": "privatePhoto", "notes": "private"]
        let body = try NutritionLabelService.productScoreBody(product: raw)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(object.keys) == ["product"])
        let sent = try #require(object["product"] as? [String: Any])
        #expect(sent["name"] as? String == "Food")
        #expect(sent["ingredients"] as? String == "Peanuts (99%), salt")
        #expect(sent["ingredientsNeedsReview"] as? Bool == true)
        let nutrients = try #require(sent["nutrients"] as? [String: [String: Any]])
        #expect(nutrients["salt"]?["value"] as? Double == 1)
        #expect(nutrients["sugars"]?["relation"] as? String == "lt")
        #expect(nutrients["protein"]?["value"] is NSNull)
        #expect(nutrients["fat"]?["value"] is NSNull)
        #expect(nutrients["protein"]?["status"] as? String == "unknown")
        let json = try #require(String(data: body, encoding: .utf8))
        for forbidden in ["secret", "privatePhoto", "private@example.test", "privateNote", "diary", "profile", "token"] {
            #expect(!json.contains(forbidden))
        }
    }

    @Test
    func productScoreUploadDoesNotPromoteUnrecognisedNutrientStatuses() throws {
        for status in ["extracted", "invented", "unknown", "estimated", "calculated", "confirmed", "supplied"] {
            let raw: [String: Any] = ["name": "Food", "nutrients": ["salt": ["value": 0.83, "unit": "g", "status": status]]]
            let body = try NutritionLabelService.productScoreBody(product: raw)
            let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: [String: Any]])
            let nutrients = try #require(object["product"]?["nutrients"] as? [String: [String: Any]])
            if ["extracted", "invented", "unknown"].contains(status) {
                // The web adapter must establish label provenance before supplying facts.
                #expect(nutrients["salt"]?["value"] is NSNull)
                #expect(nutrients["salt"]?["status"] as? String == "unknown")
            } else {
                #expect(nutrients["salt"]?["value"] as? Double == 0.83)
                #expect(nutrients["salt"]?["status"] as? String == status)
            }
        }
    }

    @Test
    func productScoreUploadRejectsWrongUnitsBooleansAndOversizedIdentity() throws {
        let raw: [String: Any] = ["name": "Food", "energyKj": ["value": 6_000, "unit": "kJ", "status": "supplied"],
            "nutrients": ["salt": ["value": 500, "unit": "mg"],
            "protein": ["value": true], "fat": ["value": -1], "sugars": ["value": 101, "unit": "g"],
            "energyKcal": ["value": 5_001, "unit": "kcal"]]]
        let body = try NutritionLabelService.productScoreBody(product: raw)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: [String: Any]])
        let nutrients = try #require(object["product"]?["nutrients"] as? [String: [String: Any]])
        for key in ["salt", "protein", "fat", "sugars", "energyKcal"] { #expect(nutrients[key]?["value"] is NSNull) }
        #expect(object["product"]?["energyKj"] == nil)
        #expect(throws: (any Error).self) { try NutritionLabelService.productScoreBody(product: ["name": String(repeating: "x", count: 241)]) }
        #expect(throws: (any Error).self) { try NutritionLabelService.productScoreBody(product: ["name": " "]) }
    }

    @Test
    func fixedScoreV03PreservesGradeAndRejectsContinuousScoresOrFrequencyPolicies() throws {
        func data(_ score: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: ["score":score]) }
        let base: [String: Any] = ["methodId":"nudge_nutrition_v0_3","version":"0.3","status":"provisional","available":true,"category":"general","grade":"C","rawScore":8,"rawLower":8,"rawUpper":8,"value":50,"displayLower":50,"displayUpper":50,"baseFrequency": NSNull(), "finalFrequency": NSNull(),"frequencyStatus":"pending","completeness":"provisional_no_unverified_plant_bonus","sourceData":["url":"https://example.org/fixture"],"missingInputs":["qualifying fruit, vegetable and legume percentage"]]
        let decoded = try #require(try NutritionLabelService.decodedScoreResult(from:data(base))["score"] as? [String: Any])
        #expect(decoded["grade"] as? String == "C"); #expect(decoded["value"] as? Int == 50)
        #expect(decoded["sourceData"] != nil); #expect(decoded["finalFrequency"] is NSNull)
        for changes: [String: Any] in [["value":54],["grade":"B"],["value":true],["rawScore":1.5],["rawScore":true],["displayUpper":75],["category":"unsupported"],["baseFrequency":"Daily"],["methodId":"nudge_nutrition_v0_2","version":"0.2"],["available":false]] {
            #expect(throws: (any Error).self) { try NutritionLabelService.decodedScoreResult(from:data(base.merging(changes,uniquingKeysWith:{_,new in new}))) }
        }
        let zero = base.merging(["status":"rated","grade":"E","rawScore":19,"rawLower":19,"rawUpper":19,"value":0,"displayLower":0,"displayUpper":0,"baseFrequency": NSNull(), "finalFrequency": NSNull(),"completeness":"complete"],uniquingKeysWith:{_,new in new})
        #expect(try NutritionLabelService.decodedScoreResult(from:data(zero))["score"] != nil)
    }

    @Test
    func onlyOriginalEnteredServingNutritionOverridesPer100Rounding() throws {
        let raw: [String: Any] = ["code":"1001","product_name":"Serving fixture","serving_size":"1 wrap (273g)","serving_quantity":273,"serving_quantity_unit":"g","nutrition_data_per":"serving","nutriments":["energy-kcal_100g":252,"energy-kcal_serving":687.96,"energy-kcal_value":690,"energy-kcal_unit":"kcal","salt_100g":0.88,"salt_serving":2.4024,"salt_value":2.39,"salt_unit":"g"]]
        func parse(_ object: [String: Any]) throws -> BarcodeProduct { try OpenFoodFactsParser.parse(data:JSONSerialization.data(withJSONObject:["product":object]),barcode:"1001") }
        let product = try parse(raw)
        #expect(product.servingNutrients?["energyKcal"]?.value == 690)
        #expect(product.servingNutrients?["salt"]?.value == 2.39)
        #expect(product.servingNutrientSource?["url"] == product.sourceURL)
        #expect(product.servingPreparation == "as_sold")
        #expect(product.nutrients["salt"]?.value == 0.88)
        for change: [String: Any] in [["nutrition_data_per":"100g"],["serving_size":"1 wrap"],["serving_quantity":200],["nutrition":["aggregated_set":["per":"100g","preparation":"prepared","nutrients":[:]]]]] {
            #expect(try parse(raw.merging(change,uniquingKeysWith:{_,new in new})).servingNutrients == nil)
        }
        var derived = raw; derived["nutriments"] = ["salt_100g":0.88,"salt_serving":2.4024]
        #expect(try parse(derived).servingNutrients == nil)
    }

    @Test
    func scoreResponseContractRequiresKnownMethodAndConsistentRatingPresence() throws {
        let rated = Data(#"{"score":{"status":"rated","methodId":"nudge_nutrition_v0_3","version":"0.3","available":true,"category":"general","grade":"D","rawScore":13,"rawLower":13,"rawUpper":13,"displayLower":25,"displayUpper":25,"value":25,"baseFrequency":null,"finalFrequency":null,"components":{},"explanation":"Source-supported explanation.","token":"not-forwarded"},"token":"also-not-forwarded"}"#.utf8)
        let result = try NutritionLabelService.decodedScoreResult(from: rated)
        #expect(result["token"] == nil)
        #expect((result["score"] as? [String: Any])?["token"] == nil)
        #expect((result["score"] as? [String: Any])?["value"] as? Int == 25)
        let unrated = Data(#"{"score":{"status":"unrated","methodId":"nudge_nutrition_v0_3","version":"0.3","grade":null,"rawScore":null,"missingInputs":["fibre"],"reason":"Missing fibre"}}"#.utf8)
        #expect(try NutritionLabelService.decodedScoreResult(from: unrated)["score"] != nil)
        for invalid in [
            #"{"score":{"status":"rated","methodId":"nudge_label_v0_1","version":"1","grade":"D","rawScore":13}}"#,
            #"{"score":{"status":"rated","methodId":"nudge_nutrition_v0_2","version":"0.2","grade":"D","rawScore":13}}"#,
            #"{"score":{"status":"rated","methodId":"nudge_nutrition_v0_3","version":"0.3","grade":"D","rawScore":true}}"#,
            #"{"score":{"status":"unrated","methodId":"nudge_nutrition_v0_3","version":"0.3","grade":"A","rawScore":null}}"#,
            #"{"score":{"status":"rated","methodId":"nudge_nutrition_v0_3","version":"0.3","grade":"A","rawScore":1.5}}"#
        ] { #expect(throws: (any Error).self) { try NutritionLabelService.decodedScoreResult(from: Data(invalid.utf8)) } }
        var oversized = unrated
        oversized.append(Data(repeating: 32, count: 65_537 - oversized.count))
        #expect(throws: (any Error).self) { try NutritionLabelService.decodedScoreResult(from: oversized) }
        #expect(NutritionLabelService.errorForScoreHTTPResponse(statusCode: 200) == nil)
        #expect(NutritionLabelService.errorForScoreHTTPResponse(statusCode: 401)?.code == "signInRequired")
        #expect(NutritionLabelService.errorForScoreHTTPResponse(statusCode: 502)?.errorDescription?.contains("OpenAI") == false)
    }

    // A redownloadable catalogue is independent from user diary storage. Each
    // test gets a disposable folder; none uses the app's shared cache or keys.
    private func catalogueFixture(_ barcode: String = "1001", padding: Int = 0) throws -> BarcodeProduct {
        let value: [String: Any] = ["product": ["code": barcode, "product_name": "Catalogue fixture",
            "ingredients_text": padding == 0 ? "Chickpeas, water" : String(repeating: "x", count: padding),
            "nutrition": ["aggregated_set": ["per": "100g", "preparation": "as_sold", "nutrients": [
                "proteins": ["value": 6.7, "unit": "g", "source": "packaging"]]]]]]
        return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: value), barcode: barcode, retrievedAt: Date(timeIntervalSince1970: 1_000_000))
    }

    @Test
    func productCatalogueSurvivesReopeningAndPreservesUnknowns() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-catalogue-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory), now = Date(timeIntervalSince1970: 1_000_000)
        let product = try catalogueFixture()
        cache.write(product, now: now)
        let reopened = ProductLookupCache(directory: directory)
        for offset in [0.0, 1.0, 86_400.0, 7 * 86_400.0 - 1] {
            let cached = try #require(reopened.read(barcode: "1001", now: now.addingTimeInterval(offset)))
            #expect(cached == product)
            #expect(cached.nutrients["protein"]?.value == 6.7)
            #expect(cached.nutrients["salt"]?.value == nil)
            #expect(cached.nutrients["salt"]?.status == "unknown")
        }
        #expect(reopened.read(barcode: "1001", now: now.addingTimeInterval(7 * 86_400)) == nil)
        #expect(reopened.read(barcode: "1001", now: now.addingTimeInterval(-1)) == nil)
        #expect(reopened.read(barcode: "../1001", now: now) == nil)
        #expect(reopened.read(barcode: "1002", now: now) == nil)
    }

    @Test
    func productCatalogueRejectsMalformedMismatchedOrUntrustedEntries() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-catalogue-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory), now = Date(timeIntervalSince1970: 1_000_000)
        let product = try catalogueFixture(), url = directory.appendingPathComponent("1001.json")
        cache.write(product, now: now)
        let original = try Data(contentsOf: url)
        let envelope = try #require(JSONSerialization.jsonObject(with: original) as? [String: Any])
        for patch in [["version": 99], ["storedAt": true]] as [[String: Any]] {
            let changed = envelope.merging(patch, uniquingKeysWith: { _, new in new })
            try JSONSerialization.data(withJSONObject: changed).write(to: url)
            #expect(cache.read(barcode: "1001", now: now) == nil)
        }
        for patch in [["barcode": "1002"], ["sourceName": "Private diary"], ["retrievedAt": "invalid"],
                      ["retrievedAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(1))],
                      ["retrievedAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(-30 * 86_400))]] {
            var changed = envelope
            var cachedProduct = try #require(changed["product"] as? [String: Any])
            for (key, value) in patch { cachedProduct[key] = value }
            changed["product"] = cachedProduct
            try JSONSerialization.data(withJSONObject: changed).write(to: url)
            #expect(cache.read(barcode: "1001", now: now) == nil)
        }
        for invalid in [Data("{broken".utf8), Data(repeating: 32, count: 65_537)] {
            try invalid.write(to: url)
            #expect(cache.read(barcode: "1001", now: now) == nil)
        }
        cache.write(product, now: now)
        #expect(cache.read(barcode: "1001", now: now) == product, "A malformed cache must be replaceable without touching intake")
    }

    @Test
    func productCatalogueEvictsOldFactsWithinCountAndByteBounds() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nudge-catalogue-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let sentinel = directory.appendingPathComponent("unrelated.keep")
        try Data("keep".utf8).write(to: sentinel)
        let cache = ProductLookupCache(directory: directory), now = Date(timeIntervalSince1970: 1_000_000)
        for index in 0..<205 {
            let code = String(format: "%06d", index)
            cache.write(try catalogueFixture(code), now: now)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(Double(index))], ofItemAtPath: directory.appendingPathComponent(code + ".json").path)
        }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        #expect(files.count == 200)
        #expect(cache.read(barcode: "000000", now: now) == nil)
        #expect(cache.read(barcode: "000204", now: now) != nil)
        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep")
        for index in 0..<80 {
            let code = String(format: "%06d", 10_000 + index)
            cache.write(try catalogueFixture(code, padding: 53_000), now: now)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(Double(index + 1000))], ofItemAtPath: directory.appendingPathComponent(code + ".json").path)
        }
        let bounded = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey]).filter { $0.pathExtension == "json" }
        let bytes = try bounded.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }
        #expect(bounded.count <= 200)
        #expect(bytes <= 4_000_000)
        #expect(cache.read(barcode: "010079", now: now) != nil)
        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "keep")
    }

    @Test
    func providerEstimatesKeepEstimatedStatusForGramsKcalAndKilojoules() throws {
        let data = Data(#"{"product":{"code":"1001","product_name":"Estimated product","nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"proteins":{"value":5,"unit":"g","source":"estimate"},"energy-kcal":{"value":100,"unit":"kcal","source":"estimate"},"energy-kj":{"value":418.4,"unit":"kJ","source":"estimate"},"sugars":{"value_computed":2,"unit":"g","source":"packaging"}}}}}}"#.utf8)
        let product = try OpenFoodFactsParser.parse(data: data, barcode: "1001")
        #expect(product.nutrients["protein"]?.status == "estimated")
        #expect(product.nutrients["energyKcal"]?.status == "estimated")
        #expect(product.energyKj?.status == "estimated")
        #expect(product.nutrients["sugars"]?.status == "calculated")
        #expect(product.nutrients["salt"]?.value == nil)
        #expect(product.nutrients["salt"]?.status == "unknown")
        let derivedData = Data(#"{"product":{"code":"1001","product_name":"Estimated energy","nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"proteins":{"value_computed":5,"unit":"g","source":"estimate"},"energy-kj":{"value_computed":418.4,"unit":"kJ","source":"estimate"}}}}}}"#.utf8)
        let derived = try OpenFoodFactsParser.parse(data: derivedData, barcode: "1001")
        #expect(derived.nutrients["protein"]?.status == "estimated")
        #expect(derived.energyKj?.status == "estimated")
        #expect(derived.nutrients["energyKcal"]?.status == "estimated")
        #expect(derived.nutrients["energyKcal"]?.value == 100)
    }

    private var recoveryOuterScore: [String: Any] {
        ["methodId": "nudge_nutrition_v0_3", "version": "0.3", "status": "unrated", "available": false,
         "grade": NSNull(), "rawScore": NSNull(), "rawLower": NSNull(), "rawUpper": NSNull(), "value": NSNull(),
         "displayLower": NSNull(), "displayUpper": NSNull(), "missingInputs": ["fibre"], "classifierVersion": "fixture-classifier"]
    }

    private var recoveryEstimatedScore: [String: Any] {
        ["methodId": "nudge_nutrition_v0_3", "version": "0.3", "status": "estimated_provisional", "available": true,
         "category": "general", "grade": "C", "rawScore": 8, "rawLower": 8, "rawUpper": 8, "value": 50,
         "displayLower": 50, "displayUpper": 50, "baseFrequency": NSNull(), "finalFrequency": NSNull(),
         "completeness": "provisional_no_unverified_plant_bonus", "estimated": true, "scoreBasis": "sourced_composition"]
    }

    @Test
    func recoveryDecoderKeepsGenericEstimateSeparateAndStripsPrivateFields() throws {
        let recovery: [String: Any] = ["version": "food-recovery-v1", "status": "estimated", "token": "secret-top",
            "addedFields": ["categories"], "conflicts": [],
            "provenance": [["provider": "CoFID", "recordId": "cofid:test", "verification": "generic_estimate", "token": "secret-provenance"]],
            "product": ["name": "Chickpea soup", "barcode": "1001", "basisUnit": "g", "nutritionPreparation": "as_sold",
                "token": "secret-product", "imageBase64": "secret-photo",
                "nutrients": ["protein": ["value": 5, "unit": "g", "status": "supplied", "token": "secret-nutrient"]]],
            "estimate": ["score": recoveryEstimatedScore.merging(["token": "secret-score"], uniquingKeysWith: { _, new in new }),
                "sourceRecord": ["id": "cofid:test", "name": "Chickpea soup", "basis": "per100g", "source": "CoFID", "valueStatus": "composition_estimate",
                    "token": "secret-record", "nutrients": ["protein": ["value": 5, "unit": "g", "status": "composition_estimate", "token": "secret-source-nutrient"]]]]]
        let bytes = try JSONSerialization.data(withJSONObject: ["score": recoveryOuterScore, "recovery": recovery, "token": "secret-root"])
        let decoded = try NutritionLabelService.decodedScoreResult(from: bytes)
        let score = try #require(decoded["score"] as? [String: Any])
        #expect(score["value"] is NSNull)
        #expect(score["classifierVersion"] as? String == "fixture-classifier")
        let clean = try #require(decoded["recovery"] as? [String: Any])
        let exact = try #require(clean["product"] as? [String: Any])
        let facts = try #require(exact["nutrients"] as? [String: [String: Any]])
        #expect(facts["protein"]?["status"] as? String == "supplied")
        #expect(facts["fibre"]?["value"] is NSNull)
        #expect(facts["fibre"]?["status"] as? String == "unknown")
        let estimate = try #require(clean["estimate"] as? [String: Any])
        let estimated = try #require(estimate["score"] as? [String: Any])
        #expect(estimated["value"] as? Int == 50)
        #expect(estimated["status"] as? String == "estimated_provisional")
        #expect(estimated["estimated"] as? Bool == true)
        #expect(estimated["scoreBasis"] as? String == "sourced_composition")
        let source = try #require(estimate["sourceRecord"] as? [String: Any])
        #expect(source["id"] as? String == "cofid:test")
        #expect(source["basis"] as? String == "per100g")
        let sourceNutrients = try #require(source["nutrients"] as? [String: [String: Any]])
        #expect(sourceNutrients["protein"]?["value"] as? Int == 5)
        #expect(sourceNutrients["protein"]?["status"] as? String == "composition_estimate")
        let json = try #require(String(data: JSONSerialization.data(withJSONObject: decoded), encoding: .utf8))
        #expect(!json.contains("secret-"))
        #expect(!json.contains("imageBase64"))
    }

    @Test
    func recoveryDecoderBoundsMetadataAndRejectsForgedEstimates() throws {
        func decode(_ recovery: [String: Any]) throws -> [String: Any]? {
            let bytes = try JSONSerialization.data(withJSONObject: ["score": recoveryOuterScore, "recovery": recovery])
            return try NutritionLabelService.decodedScoreResult(from: bytes)["recovery"] as? [String: Any]
        }
        let input: [String: Any] = ["version": "food-recovery-v1", "status": "estimated",
            "addedFields": Array(repeating: "salt", count: 30) + [String(repeating: "x", count: 161)],
            "conflicts": Array(repeating: "nutrition", count: 30),
            "provenance": Array(repeating: ["provider": "CoFID", "recordId": "cofid:test"], count: 12)]
        let bounded = try #require(try decode(input))
        #expect((bounded["addedFields"] as? [String])?.count == 20)
        #expect((bounded["conflicts"] as? [String])?.count == 20)
        #expect((bounded["provenance"] as? [[String: Any]])?.count == 8)
        for patch in [["version": "unknown"], ["status": "verified-personal-diary"]] {
            #expect(try decode(input.merging(patch, uniquingKeysWith: { _, new in new })) == nil)
        }
        for changes: [String: Any] in [["value": 97], ["grade": "A"], ["estimated": false], ["status": "rated"], ["scoreBasis": "verified_label"], ["rawScore": true]] {
            var candidate = input
            candidate["estimate"] = ["score": recoveryEstimatedScore.merging(changes, uniquingKeysWith: { _, new in new })]
            let decoded = try #require(try decode(candidate))
            #expect(decoded["estimate"] == nil)
        }
        var oversized = input
        oversized["provenance"] = [["provider": String(repeating: "x", count: 41_000)]]
        let result = try decode(oversized)
        // Oversize metadata may be removed or truncated, but never forwarded unbounded.
        if let result { #expect(try JSONSerialization.data(withJSONObject: result).count <= 40_000) }
    }

    @Test
    func catalogueEnrichmentDecoderPreservesExpiryWithoutLiftingEstimatedInputsIntoProductFacts() throws {
        let marker: [String: Any] = ["version": "catalogue-enrichment-v1", "sourceFingerprint": String(repeating: "a", count: 64),
            "expiresAt": 1_900_000_000_000, "photo": "private-photo", "token": "private-token"]
        for basis in ["sourced_composition", "public_label_estimate"] {
            var score = recoveryEstimatedScore
            score["scoreBasis"] = basis; score["catalogueEnrichment"] = marker
            score["inputs"] = ["nutrients": ["protein": ["value": 20, "status": "composition_estimate"]]]
            let publication = Int(Date().timeIntervalSince1970 * 1000) - 10_000
            let decoded = try NutritionLabelService.decodedScoreResult(from: JSONSerialization.data(withJSONObject: ["score": score, "calculatedAt": publication]))
            let result = try #require(decoded["score"] as? [String: Any])
            let evidence = try #require(result["catalogueEnrichment"] as? [String: Any])
            #expect(evidence.count == 3)
            #expect(evidence["expiresAt"] as? Int == 1_900_000_000_000)
            #expect(result["scoreBasis"] as? String == basis)
            #expect(decoded["calculatedAt"] as? Int == publication)
            #expect(decoded["product"] == nil)
            #expect(decoded["nutrients"] == nil)
            #expect(decoded["recovery"] == nil)
            #expect(!String(decoding: try JSONSerialization.data(withJSONObject: decoded), as: UTF8.self).contains("private-"))
        }
        for change: [String: Any] in [["version": "unknown"], ["sourceFingerprint": "bad"], ["expiresAt": true], ["expiresAt": -1]] {
            var score = recoveryEstimatedScore
            score["catalogueEnrichment"] = marker.merging(change, uniquingKeysWith: { _, new in new })
            let payload = try JSONSerialization.data(withJSONObject: ["score": score])
            #expect(throws: NutritionLabelService.ServiceError.self) { try NutritionLabelService.decodedScoreResult(from: payload) }
        }
    }

}


private final class AlternativesURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let isSearch = url.path == "/api/v2/search"
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let correctSearch = query.contains { $0.name == "stores_tags" && $0.value == "sainsbury-s" }
            && query.contains { $0.name == "categories_tags" && $0.value == "en:peanut-butters" }
        let product: [String: Any] = ["code": isSearch ? "1002" : "1001", "product_name": "Peanut butter",
            "brands": "Sainsbury's", "categories_tags": ["en:peanut-butters"], "stores_tags": ["sainsbury-s"], "countries_tags": ["en:united-kingdom"],
            "nutriments": ["sugars_100g": isSearch ? 2 : 6]]
        let body: [String: Any] = isSearch ? ["products": correctSearch ? [product] : []] : ["product": product]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

private final class ProductSearchURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        let parameters = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let term = (parameters["q"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        if term == "offline" || term == "timeout" {
            client?.urlProtocol(self, didFailWithError: URLError(term == "offline" ? .notConnectedToInternet : .timedOut))
            return
        }
        let valid = url.host == "search.openfoodfacts.org" && url.path == "/search" && request.httpMethod == "POST"
            && ["milk", "busy", "limited", "unreadable"].contains(term)
            && request.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("Nudge/") == true
        let status = !valid ? 400 : (term == "busy" ? 503 : (term == "limited" ? 429 : 200))
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json", "Retry-After":term == "limited" ? "90" : "45"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let responseBody = term == "unreadable" ? "<html>Unreadable response</html>" : #"{"count":1,"page":1,"page_size":20,"page_count":1,"timed_out":false,"hits":[{"code":"1001","product_name":"Source milk","brands":["Source brand"],"last_indexed_datetime":"2024-10-26T08:42:37.639265","last_modified_t":1678720310,"nutriments":{"proteins_100g":3.5}}]}"#
        client?.urlProtocol(self, didLoad: Data(responseBody.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
