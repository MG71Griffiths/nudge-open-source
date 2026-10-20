import Foundation
import Testing
@testable import Nudge

struct NativeProductSearchDomainTests {
    @Test
    func categorySuggestionsResolveLocalVocabularyToRealCatalogueAisles() {
        for query in ["be", "bean", "beans", "baked bean", "Heinz beans", "garbanzo"] {
            #expect(ProductSearchCategorySuggestions.suggestions(for: query).first?.id == "pulses")
        }
        #expect(ProductSearchCategorySuggestions.suggestions(for: "yogurt").first?.id == "yoghurt")
        #expect(ProductSearchCategorySuggestions.suggestions(for: "seeds").first?.id == "nuts")
        #expect(Set(ProductSearchCategorySuggestions.suggestions(for: "cream").map(\.id)) == ["dairy", "icecream"])
        for query in ["ca", "ch", "milk", "ready meal", "frozen", "fruit"] {
            let suggestions = ProductSearchCategorySuggestions.suggestions(for: query)
            #expect(suggestions.count <= 4)
            #expect(Set(suggestions.map(\.id)).count == suggestions.count)
            #expect(suggestions.allSatisfy { ProductSearchCategory.all.contains($0) })
        }
        for query in ["", " ", "b", "eak", "Huel", "5063334012694", "---", "foods", "beans\u{0000}", String(repeating: "a", count: 81)] {
            #expect(ProductSearchCategorySuggestions.suggestions(for: query).isEmpty)
        }
    }

    @Test
    func livePrefixCacheNamespaceCannotBeImitatedByLiteralQueryPunctuation() throws {
        var live = try ProductSearchQuery(literalText: "bread")
        live.prefixMatch = true
        let literal = try ProductSearchQuery(literalText: "bread:prefix")
        #expect(live.key != literal.key)
        let exact = try ProductSearchQuery(literalText: "bread")
        #expect(live.key != exact.key)
        var sorted = live; sorted.sortOrder = .ratingHighest
        #expect(sorted.key != live.key)
        var filtered = live; filtered.dietary = [.gluten]
        #expect(filtered.key != live.key)
    }

    @Test
    func autocompleteCompletesFoodPhrasesAtWordBoundariesAndSpellingEquivalents() {
        #expect(ProductSearchAutocomplete.suggestions(for: "yog").first == "Yoghurt")
        #expect(ProductSearchAutocomplete.suggestions(for: "blueb").first == "Blueberry smoothie")
        #expect(ProductSearchAutocomplete.suggestions(for: "  thai   gre ").first == "Thai green curry")
        #expect(ProductSearchAutocomplete.suggestions(for: "smoothie blue").contains("Blueberry smoothie"))
        #expect(ProductSearchAutocomplete.suggestions(for: "yogurt").contains("yoghurt"))
        #expect(ProductSearchAutocomplete.suggestions(for: "baked bean").contains("baked beans"))
        #expect(ProductSearchAutocomplete.suggestions(for: "eak").isEmpty, "Only word prefixes match")
        #expect(ProductSearchAutocomplete.suggestions(for: "green green").isEmpty, "One candidate word cannot satisfy two query words")
    }

    @Test
    func autocompleteRanksRecentsDeduplicatesEquivalentsAndCapsResults() {
        let recent = ["Thai green curry with tofu", "Thai green curry", "THAI GREEN CURRY", "Yogurt", "Yoghurt"]
        let empty = ProductSearchAutocomplete.suggestions(for: "", recent: recent)
        #expect(Array(empty.prefix(4)) == ["Thai green curry with tofu", "Thai green curry", "Yogurt", "Thai red curry"])
        #expect(empty.count == 6)
        #expect(ProductSearchAutocomplete.suggestions(for: "thai", recent: recent).first == "Thai green curry with tofu")
        #expect(ProductSearchAutocomplete.suggestions(for: "yog", recent: recent).filter { ["yoghurt", "yogurt"].contains($0.lowercased()) }.count == 1)
        let single = ProductSearchAutocomplete.suggestions(for: "b")
        #expect(single.count == 6)
        #expect(single.allSatisfy { $0.lowercased().split(separator: " ").contains { $0.hasPrefix("b") } })
        #expect(ProductSearchAutocomplete.suggestions(for: "").count == 6, "New users get a useful shortlist")
    }

    @Test
    func autocompleteDoesNotSuggestForBarcodesUnknownTermsOrInvalidInput() {
        for query in ["5063334012694", "5063 3340 1269 4", "---", "zzqv", String(repeating: "a", count: 81), "milk\u{0000}"] {
            #expect(ProductSearchAutocomplete.suggestions(for: query, recent: ["Milk", "Thai green curry"]).isEmpty)
        }
        #expect(ProductSearchAutocomplete.suggestions(for: "\tblueb\n").first == "Blueberry smoothie")
    }

    @Test
    func bundledPlaceDirectoryHasAllEntitiesAndSharedSubwayIdentity() throws {
        let directory = SearchPlace.load()
        #expect(directory.count == 63)
        #expect(Set(directory.map(\.id)).count == 63)
        #expect(directory.filter { $0.groups.contains(.cafe) }.count == 18)
        #expect(directory.filter { $0.groups.contains(.restaurant) }.count == 29)
        #expect(directory.filter(\.isSupermarket).count == 17)
        let subway = try #require(directory.first { $0.id == "subway" })
        #expect(subway.groups == [.cafe, .restaurant])
        #expect(directory.filter { $0.id == "subway" }.count == 1)
        #expect(directory.filter(\.isSupermarket).allSatisfy { $0.store != nil })
        #expect(directory.allSatisfy { !$0.menuAvailable })
        #expect(directory.first { $0.id == "caffenero" }?.matches("Cafe Nero") == true)
        #expect(directory.first { $0.id == "cookscoffee" }?.matches("Esquires") == true)
        #expect(directory.first { $0.id == "gdk" }?.matches("GDK") == true)
    }

    @Test
    func unrelatedFoodNamesDoNotSilentlyBecomeAmbiguousPlaceScopes() {
        for input in ["BEAR fruit snacks", "BEAR fruit rolls", "Costa Rica coffee", "Costa Rica chocolate", "Chorizo de Leon", "Côte d’Or chocolate"] {
            let intent = SearchDiscoveryParser.parse(input)
            #expect(intent.place == nil, "Preserve unrelated words in \(input)")
            #expect(!intent.text.isEmpty)
        }
        #expect(SearchDiscoveryParser.parse("coffee at Costa").place?.id == "costa")
        #expect(SearchDiscoveryParser.parse("coffee at Costa").text == "coffee")
        #expect(SearchDiscoveryParser.parse("Greggs sausage roll").place?.id == "greggs")
        #expect(SearchDiscoveryParser.parse("Greggs sausage roll").text == "sausage roll")
        #expect(SearchDiscoveryParser.parse("Costa latte").text == "latte")
        #expect(SearchDiscoveryParser.parse("coffee at Bear").place?.id == "bear")
        #expect(SearchDiscoveryParser.parse("coffee at Bear").text == "coffee")
        #expect(SearchDiscoveryParser.parse("Cote Brasserie protein").place?.id == "cote")
        #expect(SearchDiscoveryParser.parse("Subway breakfast").place?.id == "subway")
        #expect(SearchDiscoveryParser.parse("Farm Foods vegetables").place?.store == .farmfoods)
    }

    @Test
    func canonicalPlacesHaveSeparatePageCacheIdentitiesFromLegacyStores() throws {
        var query = try ProductSearchQuery(discoveryText: "coffee", store: .tesco)
        let legacy = query.key
        query.placeID = "greggs"
        #expect(query.key != legacy)
        let greggs = query.key
        query.placeID = "costa"
        #expect(query.key != greggs)
        var withoutLegacyStore = try ProductSearchQuery(discoveryText: "coffee")
        withoutLegacyStore.placeID = "costa"
        #expect(withoutLegacyStore.key == query.key, "Canonical place replaces the legacy retailer constraint")
    }

    @Test
    func discoveryParsesScopeAndKeepsUnsupportedWordsVisible() {
        let yoghurt = SearchDiscoveryParser.parse("Tesco calcium yogurt unusualword")
        #expect(yoghurt.place?.store == .tesco)
        #expect(yoghurt.category?.id == "yoghurt")
        #expect(yoghurt.nutrition == [.calcium])
        #expect(yoghurt.text == "unusualword")
        let bread = SearchDiscoveryParser.parse("gluten-free wholemeal bread")
        #expect(bread.dietary == [.gluten]); #expect(bread.category?.id == "bakery"); #expect(bread.text == "wholemeal")
        let pret = SearchDiscoveryParser.parse("Pret A Manger breakfast")
        #expect(pret.place?.id == "pret"); #expect(pret.text == "breakfast"); #expect(pret.category == nil)
        let nandos = SearchDiscoveryParser.parse("Nando’s protein")
        #expect(nandos.place?.id == "nandos"); #expect(nandos.nutrition == [.protein]); #expect(nandos.text.isEmpty)
        #expect(SearchDiscoveryParser.parse("wishlist").opensSaved)
        #expect(!SearchDiscoveryParser.parse("wishlist salad dressing").opensSaved)
    }

    @Test
    func discoveryCombinationAndTextArePartOfCacheIdentity() throws {
        var first = try ProductSearchQuery(discoveryText: "wholemeal")
        first.category = ProductSearchCategory.all.first { $0.id == "bakery" }
        first.dietary = [.gluten, .milk]; first.nutrition = [.protein, .fibre]
        var second = first; second.nutritionMode = .all
        #expect(first.key != second.key)
        second = first; second.text = "rye"; #expect(first.key != second.key)
    }

    @Test
    func supportBrowseIsExplicitAndHasDistinctScopedCacheKeys() throws {
        let all = try ProductSupportContext.allCases.map { try ProductSearchQuery(supportContext: $0) }
        #expect(Set(all.map(\.key)).count == 6)
        #expect(all.allSatisfy { $0.text.isEmpty && $0.category == nil && $0.isDiscovery })
        let unfiltered = try ProductSearchQuery(literalText: "yoghurt")
        var scoped = unfiltered
        scoped.supportContext = .luteal
        #expect(scoped.key != unfiltered.key)
        var sorted = scoped; sorted.sortOrder = .ratingHighest
        #expect(sorted.key != scoped.key)
        #expect(try ProductSearchQuery(supportContext: .luteal, page: 2).key != all[3].key)
        #expect(try ProductSearchQuery(supportContext: .luteal, store: .sainsburys).key != all[3].key)
        #expect(try ProductSearchQuery(supportContext: .luteal, market: .allCountries).key != all[3].key)
        #expect(throws: ProductSearchError.invalidQuery) { try ProductSearchQuery(supportContext: .luteal, page: 0) }
        #expect(ProductSupportContext.follicular.explanation.contains("not specific"))
        #expect(ProductSupportContext.ovulation.explanation.contains("not specific"))
    }

    @Test
    func supportEvidenceSurvivesPublicPageCacheWithoutChangingNutrition() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let product = try searchProduct("10000001")
        let query = try ProductSearchQuery(supportContext: .luteal)
        var page = ProductSearchPage(query: query, products: [product], hasMore: false)
        page.catalogueCoverage = "partial"
        page.supportCoverage = .init(version: "test-v1", processed: 100, total: 100, complete: true)
        page.supportTags = [product.barcode: [supportTag()]]
        let now = Date()
        let state = ProductSearchState(directory: folder)
        await state.save(page, at: now)
        let restored = ProductSearchState(directory: folder)
        let cached = try #require(await restored.cached(query, at: now.addingTimeInterval(1)))
        #expect(cached.supportTags == page.supportTags)
        #expect(cached.supportCoverage == page.supportCoverage)
        #expect(cached.supportCoverage?.summary.contains("Catalogue checked:") == true)
        #expect(cached.products[0] == product)
        #expect(await restored.cached(try ProductSearchQuery(supportContext: .period), at: now) == nil)
    }

    @Test @MainActor
    func recentAndFrequentSearchesPersistLocallyWithoutBarcodes() throws {
        let name = "NudgeSearchPreferencesTests-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let preferences = ProductSearchPreferences(defaults: defaults)
        preferences.rememberSearch("beans")
        preferences.rememberSearch("yoghurt")
        preferences.rememberSearch("beans")
        preferences.rememberSearch("1234567890123")
        let restored = ProductSearchPreferences(defaults: defaults)
        #expect(restored.searchSuggestions(for: "bea") == ["beans"])
        #expect(Set(restored.searchSuggestions(for: "")) == ["beans", "yoghurt"])
    }

    @Test
    func ratingColoursUseRequestedThresholdsAndNeverColourMissingAsZero() {
        #expect(NativeProductRatingTone(value: nil) == .unknown)
        #expect(NativeProductRatingTone(value: -1) == .unknown)
        #expect(NativeProductRatingTone(value: 101) == .unknown)
        #expect(NativeProductRatingTone(value: 0) == .red)
        #expect(NativeProductRatingTone(value: 24) == .red)
        #expect(NativeProductRatingTone(value: 25) == .amber)
        #expect(NativeProductRatingTone(value: 49) == .amber)
        #expect(NativeProductRatingTone(value: 50) == .green)
        #expect(NativeProductRatingTone(value: 100) == .green)
        #expect(NativeProductRatingTone.green.fill == 0xA8DC00)
        #expect(NativeProductRatingTone.amber.fill == 0xFF9F43)
        func luminance(_ hex: UInt32) -> Double {
            let channels = [Double((hex >> 16) & 255), Double((hex >> 8) & 255), Double(hex & 255)]
                .map { $0 / 255 }.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        for tone in [NativeProductRatingTone.red, .amber, .green] {
            #expect((luminance(tone.fill) + 0.05) / (luminance(0x1B202A) + 0.05) >= 4.5,
                    "Bright fills retain readable normal-size dark text in both themes")
        }
    }

    @Test
    func categoriesMatchHandoverAndCannotInjectTaxonomySyntax() throws {
        let expected = ["fruit","vegetables","salad","dairy","eggs","cheese","yoghurt","meat","fish","alternatives","bakery","ready","pulses","pasta","rice","cereals","nuts","frozen","tins","snacks","desserts","icecream","chocolate","sauces","spreads","baking","juice","drinks"]
        #expect(ProductSearchCategory.all.map(\.id) == expected)
        #expect(Set(ProductSearchCategory.all.map(\.id)).count == 28)
        let chocolate = try #require(ProductSearchCategory.all.first { $0.id == "chocolate" })
        let query = try ProductSearchQuery(category: chocolate, market: .allCountries)
        #expect((query.parameters["q"] as? String)?.contains(#"categories_tags:"en:chocolates" OR categories_tags:"en:candies""#) == true)
        #expect(query.parameters["langs"] as? [String] == ["en"])
        #expect(query.parameters["fields"] as? [String] != nil)
        #expect(query.parameters["countries_tags"] == nil)
        let unapproved = ProductSearchCategory(id: chocolate.id, title: chocolate.title,
            tags: [#"en:chocolates" OR *"#], symbol: chocolate.symbol, colourIndex: chocolate.colourIndex)
        #expect(throws: ProductSearchError.invalidQuery) { try ProductSearchQuery(category: unapproved) }
        #expect(throws: ProductSearchError.invalidQuery) { try ProductSearchQuery(category: chocolate, page: 0) }
    }

    @Test
    func nativeTextIsLiteralAndDoesNotParseOrAddPreferenceFilters() throws {
        let query = try ProductSearchQuery(literalText: "  50%+ dinner  menopause  ", market: .allCountries)
        #expect(query.text == "50%+ dinner menopause")
        #expect(query.parameters["q"] as? String == "50%\\+ AND dinner AND menopause")
        let injected = try ProductSearchQuery(literalText: "categories_tags:milk OR *", market: .allCountries)
        #expect(injected.parameters["q"] as? String == "categories_tags\\:milk AND \"OR\" AND \\*")
        #expect(throws: ProductSearchError.invalidQuery) { try ProductSearchQuery(literalText: "milk\nbrand") }
        let milk = try #require(ProductSearchCategory.all.first { $0.id == "dairy" })
        #expect(try ProductSearchQuery(category: milk).key != ProductSearchQuery(literalText: "milk").key)
        #expect(try ProductSearchQuery(literalText: "milk").key != ProductSearchQuery("milk", page: 1).key)
    }

    @Test
    func discoveryCacheExpiresAfterFiveMinutesAndNeverRefreshesStaleEntries() async throws {
        let state = ProductSearchState()
        let category = ProductSearchCategory.all[0]
        let query = try ProductSearchQuery(category: category)
        let now = Date(timeIntervalSince1970: 100_000)
        let product = try searchProduct("10000001", categories: category.tags)
        await state.save(ProductSearchPage(query: query, products: [product], hasMore: true), at: now)
        #expect(await state.cached(query, at: now.addingTimeInterval(299))?.cached == true)
        #expect(await state.cached(query, at: now.addingTimeInterval(300)) == nil)
        let stale = try #require(await state.cached(query, at: now.addingTimeInterval(300), allowingStale: true))
        #expect(stale.stale)
        await state.save(stale, at: now.addingTimeInterval(300))
        #expect(await state.cached(query, at: now.addingTimeInterval(301)) == nil)
        #expect(await state.cached(try ProductSearchQuery(literalText: "Fruit"), at: now) == nil)
    }

    @Test
    func discoveryPreservesIncompleteProductsAndRejectsErrorOrWrongCategoryPages() throws {
        let category = try #require(ProductSearchCategory.all.first { $0.id == "yoghurt" })
        let query = try ProductSearchQuery(category: category)
        let page = try ProductSearchPage.parse(Data(#"{"hits":[{"code":"10000001","product_name":"Incomplete yoghurt","countries_tags":["en:united-kingdom"],"categories_tags":["en:yogurts"]}],"page":1,"page_count":1}"#.utf8), query: query, retrievedAt: Date())
        #expect(page.products.count == 1)
        #expect(page.products.first?.nutrients["protein"]?.value == nil)
        #expect(page.products.first?.allergens == nil)
        #expect(page.products.first?.searchProvider == "open_food_facts_search")
        let legacy = try ProductSearchPage.parse(Data(#"{"hits":[{"code":"10000001","product_name":"Yoghurt","countries_tags":["en:united-kingdom"],"categories_tags":["en:yogurts"],"nutriments":{"proteins_100g":4.2}}],"page":1}"#.utf8), query: query, retrievedAt: Date())
        #expect(legacy.products.first?.nutrients["protein"]?.value == 4.2)
        #expect(legacy.products.first?.nutritionPreparation == nil)
        for raw in [#"{"hits":[],"page":1,"error":"backend failed"}"#,
                    #"{"hits":[{"code":"10000001","product_name":"Bread","countries_tags":["en:united-kingdom"],"categories_tags":["en:breads"]}],"page":1}"#] {
            #expect(throws: ProductSearchError.invalidResponse) {
                try ProductSearchPage.parse(Data(raw.utf8), query: query, retrievedAt: Date())
            }
        }
    }

    @Test
    func spellingEquivalentsPreserveQuotedProductNamesAndDoNotExtractFilters() {
        #expect(ProductSearchSpelling.prepare("yogurt").text == "yoghurt")
        #expect(ProductSearchSpelling.prepare("YOGURTS").text == "yoghurt")
        #expect(ProductSearchSpelling.prepare("garbanzo beans").text == "chickpeas")
        #expect(ProductSearchSpelling.prepare("\"Soy Brand\" yogurt").text == "\"Soy Brand\" yoghurt")
        #expect(ProductSearchSpelling.prepare("\"chickpeas beans\" yogurt").text == "\"chickpeas beans\" yoghurt")
        #expect(ProductSearchSpelling.prepare("50% dinner milk").text == "50% dinner milk")
        #expect(ProductSearchSpelling.prepare("yoghurt").alternate == "yogurt")
        #expect(ProductSearchSpelling.suggestions(for: "yogu").contains("Yoghurt"))
        #expect(ProductSearchSpelling.suggestions(for: "yogurt").contains("yoghurt"))
        #expect(ProductSearchSpelling.suggestions(for: "12345678").isEmpty)
    }

    @Test
    func knownBeanPhrasesUseCataloguePluralsAndKeepLiteralBrands() {
        #expect(ProductSearchSpelling.prepare("baked bean").text == "baked beans")
        #expect(ProductSearchSpelling.prepare("Heinz BAKED BEAN").text == "Heinz baked beans")
        #expect(ProductSearchSpelling.prepare("red kidney bean").text == "red kidney beans")
        #expect(ProductSearchSpelling.prepare("bean").text == "beans")
        #expect(ProductSearchSpelling.prepare("beans").alternate == "bean")
        #expect(ProductSearchSpelling.prepare("baked beans").alternate == "baked bean")
        #expect(ProductSearchSpelling.prepare("Bean Company").text == "Bean Company")
        #expect(ProductSearchSpelling.prepare("bean soup").text == "bean soup")
        #expect(ProductSearchSpelling.prepare("\"Baked Bean\" Brand").text == "\"Baked Bean\" Brand")
        #expect(ProductSearchSpelling.prepare("\"Baked Bean\" Brand").alternate == nil)
        #expect(ProductSearchSpelling.suggestions(for: "baked bean").contains("baked beans"))
        #expect(ProductSearchSpelling.suggestions(for: "beans").contains("Baked beans"))
        #expect(ProductSearchSpelling.suggestions(for: "beans").contains("Kidney beans"))
        #expect(ProductSearchSpelling.suggestions(for: "beans").count <= 5)
    }
}

@MainActor
struct NativeProductSearchModelTests {
    @Test
    func liveTypingDebouncesLatestPrefixAndIgnoresCancelledResponses() async throws {
        let harness = SearchHarness(), delay = SearchDebounceHarness()
        let model = harness.model(debounce: { await delay.wait() })
        model.setStore(.tesco); model.setDietary([.gluten])
        model.updateLiveQuery("y")
        #expect(!model.isDebouncing && harness.queries.isEmpty)
        model.updateLiveQuery("yo")
        await eventually { delay.count == 1 }
        model.updateLiveQuery("yog")
        await eventually { delay.count == 2 }
        delay.release(0)
        for _ in 0..<10 { await Task.yield() }
        #expect(harness.queries.isEmpty)
        delay.release(1)
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].text == "yog" && harness.queries[0].prefixMatch)
        #expect(harness.queries[0].placeID == "tesco" && harness.queries[0].dietary == [.gluten])
        model.updateLiveQuery("marm")
        await eventually { delay.count == 3 }
        harness.succeed(0, products: [try searchProduct("10000001")])
        for _ in 0..<10 { await Task.yield() }
        #expect(model.products.isEmpty && model.isDebouncing)
        model.clearLiveQuery()
        delay.release(2)
        for _ in 0..<10 { await Task.yield() }
        #expect(harness.queries.count == 1 && model.query.isEmpty && model.isBrowsing)
        #expect(model.store == .tesco && model.dietary == [.gluten], "Clearing text must preserve chosen filters")
    }

    @Test
    func liveTypingDoesNotSavePrefixesAndReturnImmediatelyCommitsExactSearch() async throws {
        let suite = "search-live-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ProductSearchPreferences(defaults: defaults)
        let harness = SearchHarness(), delay = SearchDebounceHarness()
        let model = harness.model(preferences: preferences, debounce: { await delay.wait() })
        model.updateLiveQuery("yog")
        await eventually { delay.count == 1 }
        delay.release(0)
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [try searchProduct("10000001")])
        await eventually { !model.loading }
        #expect(preferences.recentSearchTerms.isEmpty)
        model.updateLiveQuery("yoghurt")
        await eventually { delay.count == 2 }
        model.submit()
        await eventually { harness.queries.count == 2 }
        #expect(!model.isDebouncing && !harness.queries[1].prefixMatch)
        delay.release(1)
        harness.succeed(1, products: [try searchProduct("10000002")])
        await eventually { !model.loading }
        #expect(harness.queries.count == 2)
        #expect(preferences.recentSearchTerms == ["yoghurt"] && model.hasRecentSearches)
        model.clearRecentSearches()
        #expect(preferences.recentSearchTerms.isEmpty && !model.hasRecentSearches)
    }

    @Test
    func searchCommitsMatchingLiveRequestWithoutRestartingItOrChangingScope() async throws {
        let suite = "search-live-commit-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ProductSearchPreferences(defaults: defaults)
        let harness = SearchHarness(), model = harness.model(preferences: preferences, debounce: {})
        model.setStore(.tesco); model.setDietary([.gluten]); model.setNutrition([.protein])
        model.updateLiveQuery("Huel")
        await eventually { harness.queries.count == 1 }
        let context = model.ratingContextID
        model.submit(); model.submit()
        #expect(model.loading && model.ratingContextID == context)
        #expect(preferences.recentSearchTerms.isEmpty, "An unfinished query is not a successful search")
        harness.succeed(0, products: [try searchProduct("10000001", name: "Huel Vanilla")])
        await eventually { !model.loading }
        #expect(harness.queries.count == 1 && model.products.first?.name == "Huel Vanilla")
        #expect(harness.queries[0].prefixMatch && harness.queries[0].placeID == "tesco")
        #expect(harness.queries[0].dietary == [.gluten] && harness.queries[0].nutrition == [.protein])
        #expect(preferences.recentSearchTerms == ["Huel"])
    }

    @Test
    func searchKeepsDeliveredLiveRowsScrollRatingsAndPrefixPagination() async throws {
        let harness = SearchHarness(), model = harness.model(debounce: {})
        model.updateLiveQuery("Huel")
        await eventually { harness.queries.count == 1 }
        let first = try searchProduct("10000001", name: "Huel Vanilla")
        harness.succeed(0, products: [first], hasMore: true)
        await eventually { !model.loading }
        let context = model.ratingContextID
        model.scrollAnchor = first.barcode
        model.submit(); model.submit()
        #expect(!model.loading && model.products == [first] && model.hasMore)
        #expect(model.ratingContextID == context && model.scrollAnchor == first.barcode)
        #expect(harness.queries.count == 1)
        model.loadMore()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].page == 2 && harness.queries[1].prefixMatch)
        #expect(harness.queries[1].text == harness.queries[0].text)
        harness.succeed(1, products: [try searchProduct("10000002", name: "Huel Chocolate")])
        await eventually { !model.loading }
        #expect(model.products.count == 2 && model.ratingContextID == context)
    }

    @Test
    func committingCachedPartialPreviewKeepsRefreshAndDoesNotDeclareItFresh() async throws {
        let harness = SearchHarness()
        let cached = try searchProduct("10000001", name: "Huel Previously Loaded")
        let model = harness.model(cachedSearch: { query in
            var page = ProductSearchPage(query: query, products: [cached], hasMore: true)
            page.cached = true; page.stale = true; page.catalogueCoverage = "partial"
            return page
        }, debounce: {})
        model.updateLiveQuery("Huel")
        await eventually { harness.queries.count == 1 && model.products == [cached] }
        model.submit()
        #expect(model.loading && model.isStale && model.products == [cached])
        #expect(model.notice?.contains("previously loaded") == true)
        let fresh = try searchProduct("10000002", name: "Huel Fresh")
        harness.succeed(0, products: [fresh])
        await eventually { !model.loading }
        #expect(harness.queries.count == 1 && model.products == [fresh] && !model.isStale)
    }

    @Test
    func completedLiveFailureOrStaleFallbackStillAllowsExplicitRetry() async throws {
        for stale in [false, true] {
            let harness = SearchHarness(), model = harness.model(debounce: {})
            model.updateLiveQuery("Huel")
            await eventually { harness.queries.count == 1 }
            if stale { harness.succeed(0, products: [try searchProduct("10000001")], stale: true) }
            else { harness.fail(0, error: ProductSearchError.timeout) }
            await eventually { !model.loading }
            let context = model.ratingContextID
            model.submit()
            await eventually { harness.queries.count == 2 }
            #expect(model.ratingContextID != context && !harness.queries[1].prefixMatch)
            harness.succeed(1, products: [try searchProduct("10000002")])
            await eventually { !model.loading }
            #expect(model.products.first?.barcode == "10000002" && model.errorMessage == nil && !model.isStale)
        }
    }

    @Test
    func completedEmptyLiveResultsDoNotSuppressAnExplicitSearch() async {
        let harness = SearchHarness(), model = harness.model(debounce: {})
        model.updateLiveQuery("Huel")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [])
        await eventually { !model.loading }
        model.submit()
        await eventually { harness.queries.count == 2 }
        #expect(!harness.queries[1].prefixMatch)
        harness.succeed(1, products: [])
        await eventually { !model.loading }
    }

    @Test
    func liveCommitStillAppliesExplicitSemanticScopesAndSpellingCorrections() async throws {
        for text in ["Tesco beans", "yogurt"] {
            let harness = SearchHarness(), model = harness.model(debounce: {})
            model.updateLiveQuery(text)
            await eventually { harness.queries.count == 1 }
            model.submit()
            await eventually { harness.queries.count == 2 }
            #expect(!harness.queries[1].prefixMatch)
            if text == "Tesco beans" {
                #expect(harness.queries[1].placeID == "tesco" && harness.queries[1].text == "beans")
            } else { #expect(harness.queries[1].text == "yoghurt") }
            harness.succeed(0, products: [try searchProduct("10000001", name: "Obsolete literal")])
            harness.succeed(1, products: [try searchProduct("10000002", name: "Explicit result")])
            await eventually { !model.loading }
            #expect(model.products.first?.barcode == "10000002")
        }
    }

    @Test
    func liveCommitCannotSkipExplicitScopeChanges() async throws {
        let harness = SearchHarness(), model = harness.model(debounce: {})
        model.updateLiveQuery("Huel")
        await eventually { harness.queries.count == 1 }
        model.submit("Huel", filters: ["kind": "recipe"])
        harness.succeed(0, products: [try searchProduct("10000001")])
        for _ in 0..<20 { await Task.yield() }
        #expect(model.scope == .recipe && !model.loading && model.products.isEmpty)
        #expect(harness.queries.count == 1)
    }

    @Test
    func committingCanonicalLiveQueryRetainsItsBoundedSpellingFallback() async throws {
        let harness = SearchHarness(), model = harness.model(debounce: {})
        model.updateLiveQuery("beans")
        await eventually { harness.queries.count == 1 }
        model.submit()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "beans" && !harness.queries[1].prefixMatch)
        harness.succeed(0, products: [try searchProduct("10000001", name: "Obsolete prefix")])
        harness.succeed(1, products: [])
        await eventually { harness.queries.count == 3 }
        #expect(harness.queries[2].text == "bean" && !harness.queries[2].prefixMatch)
        harness.succeed(2, products: [try searchProduct("10000002", name: "Current spelling result")])
        await eventually { !model.loading }
        #expect(model.products.first?.barcode == "10000002")
    }

    @Test
    func completedLiveReuseExpiresWithPageAgeOrSourceFacts() async throws {
        for sourceExpires in [false, true] {
            let harness = SearchHarness(), model = harness.model(debounce: {})
            model.updateLiveQuery("Huel")
            await eventually { harness.queries.count == 1 }
            var product = try searchProduct("10000001")
            if sourceExpires { product.catalogueSourceExpiresAt = harness.now.addingTimeInterval(10) }
            harness.succeed(0, products: [product])
            await eventually { !model.loading }
            harness.now.addTimeInterval(sourceExpires ? 11 : 301)
            model.submit()
            await eventually { harness.queries.count == 2 }
            #expect(!harness.queries[1].prefixMatch, "Aged rows or expired facts must be checked again")
            harness.succeed(1, products: [try searchProduct("10000002")])
            await eventually { !model.loading }
            #expect(model.products.first?.barcode == "10000002")
        }
    }

    @Test
    func leavingDuringTypingCancelsDelayAndCannotStartHiddenSearch() async {
        let harness = SearchHarness(), delay = SearchDebounceHarness()
        let model = harness.model(debounce: { await delay.wait() })
        model.updateLiveQuery("bread")
        await eventually { delay.count == 1 }
        model.cancel()
        delay.release(0)
        for _ in 0..<10 { await Task.yield() }
        #expect(!model.loading && !model.isDebouncing && harness.queries.isEmpty)
        #expect(model.submittedQuery == "bread" && model.errorMessage != nil)
        model.retry()
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].text == "bread" && harness.queries[0].prefixMatch)
        harness.succeed(0, products: [])
        await eventually { !model.loading }
    }

    @Test
    func clearingLiveTextReturnsToFilteredBrowseWithoutPrefixFlag() async {
        let harness = SearchHarness(), model = harness.model(debounce: {})
        model.setDietary([.gluten])
        model.updateLiveQuery("bread")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [])
        await eventually { !model.loading }
        model.clearTextQuery()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text.isEmpty && !harness.queries[1].prefixMatch)
        #expect(harness.queries[1].dietary == [.gluten])
        harness.succeed(1, products: [])
        await eventually { !model.loading }
    }

    @Test
    func selectingSuggestedCategoryUsesRealAisleAndPreservesOtherFiltersWhenCleared() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setStore(.tesco)
        model.setDietary([.gluten])
        model.setNutrition([.protein])
        model.setNutritionMode(.all)
        model.setSortOrder(.ratingHighest)
        let category = try #require(ProductSearchCategorySuggestions.suggestions(for: "beans").first)
        #expect(harness.queries.isEmpty, "Local suggestions never request products")
        model.select(category)
        await eventually { harness.queries.count == 1 }
        let request = harness.queries[0]
        #expect(request.category?.id == "pulses" && request.text.isEmpty && !request.prefixMatch)
        #expect(request.store == .tesco && request.placeID == "tesco" && request.market == .unitedKingdom)
        #expect(request.dietary == [.gluten] && request.nutrition == [.protein] && request.nutritionMode == .all)
        #expect(request.sortOrder == .ratingHighest)
        #expect(model.selectedCategory == category)
        harness.succeed(0, products: [])
        await eventually { !model.loading }
        model.clearCategory()
        await eventually { harness.queries.count == 2 }
        #expect(model.selectedCategory == nil && harness.queries[1].category == nil)
        #expect(harness.queries[1].placeID == "tesco" && harness.queries[1].dietary == [.gluten])
        #expect(harness.queries[1].nutrition == [.protein] && harness.queries[1].sortOrder == .ratingHighest)
        harness.succeed(1, products: [])
        await eventually { !model.loading }
    }

    @Test
    func exactScopedCacheAppearsDuringRefreshAndDoesNotLeakAcrossFilters() async throws {
        let harness = SearchHarness(), product = try searchProduct("10000001")
        var previewQueries: [ProductSearchQuery] = []
        let model = harness.model(cachedSearch: { query in
            previewQueries.append(query)
            guard query.dietary.isEmpty else { return nil }
            var page = ProductSearchPage(query: query, products: [product], hasMore: true)
            page.cached = true; page.stale = true
            return page
        })
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        #expect(model.products == [product] && model.loading && model.isStale)
        model.setDietary([.gluten])
        await eventually { harness.queries.count == 2 }
        #expect(model.products.isEmpty && previewQueries.last?.dietary == [.gluten])
        harness.succeed(0, products: [product])
        harness.succeed(1, products: [])
        await eventually { !model.loading }
        #expect(model.products.isEmpty)
    }

    @Test
    func sameExplicitQueryKeepsRowsWhileRefreshingAndPaginationAppends() async throws {
        let harness = SearchHarness(), model = harness.model()
        let first = try searchProduct("10000001"), second = try searchProduct("10000002")
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [first], hasMore: true)
        await eventually { !model.loading }
        model.submit("bread")
        #expect(model.products == [first] && model.loading)
        await eventually { harness.queries.count == 2 }
        harness.succeed(1, products: [first], hasMore: true)
        await eventually { !model.loading }
        model.loadMore()
        #expect(model.products == [first])
        await eventually { harness.queries.count == 3 }
        harness.succeed(2, products: [first, second])
        await eventually { !model.loading }
        #expect(model.products == [first, second])
    }

    @Test
    func catalogueDeliveryDoesNotWaitForDiskAndPersistsExactScopedPagesInOrder() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = DispatchQueue(label: "nudge-test-held-cache")
        queue.suspend()
        var held = true
        defer { if held { queue.resume() } }
        let state = ProductSearchState(directory: directory.appendingPathComponent("pages"), persistenceQueue: queue)
        let cache = ProductLookupCache(directory: directory.appendingPathComponent("products"))
        let now = Date(timeIntervalSince1970: 100_000), product = try searchProduct("10000001")
        var service = OpenFoodFactsService(now: { now }, cache: cache, searchState: state)
        service.catalogueSearch = { query in
            var page = ProductSearchPage(query: query, products: [product], hasMore: false)
            page.catalogueCoverage = "complete"
            return page
        }
        var query = try ProductSearchQuery(literalText: "bread")
        query.cataloguePolicy = .only; query.prefixMatch = true
        let page = try await service.search(query: query)
        #expect(page.products == [product])
        #expect(await service.cachedSearchPage(query: query)?.products == [product])
        #expect(!FileManager.default.fileExists(atPath: directory.path), "Delivery and immediate cached repeat precede disk maintenance")
        var exact = query; exact.prefixMatch = false
        #expect(await service.cachedSearchPage(query: exact) == nil)
        let updated = try searchProduct("10000001", name: "Current catalogue facts")
        var newer = page; newer.products = [updated]
        await state.saveForDelivery(newer, at: now.addingTimeInterval(1), productCache: cache)
        await state.saveForDelivery(page, at: now, productCache: cache)
        #expect(await state.cached(query, at: now.addingTimeInterval(1))?.products == [updated], "Late older pages cannot replace a newer queued page")
        queue.resume(); held = false
        await state.flushPersistence()
        let reopened = ProductSearchState(directory: directory.appendingPathComponent("pages"))
        #expect(await reopened.cached(query, at: now.addingTimeInterval(1))?.products == [updated])
        #expect(cache.read(barcode: product.barcode, now: now.addingTimeInterval(1)) == updated)
    }

    @Test
    func cachedTypingResultsArriveBeforeDebounceAndKeepExactScope() async throws {
        let harness = SearchHarness(), delay = SearchDebounceHarness()
        let product = try searchProduct("10000001", name: "Bread")
        var cachedQueries: [ProductSearchQuery] = []
        let model = harness.model(cachedSearch: { query in
            cachedQueries.append(query)
            var page = ProductSearchPage(query: query, products: [product], hasMore: true)
            page.cached = true
            return page
        }, debounce: { await delay.wait() })
        model.setStore(.tesco); model.setDietary([.gluten])
        model.updateLiveQuery("bread")
        await eventually { model.products == [product] && delay.count == 1 }
        #expect(model.isDebouncing && harness.queries.isEmpty)
        #expect(cachedQueries.first?.placeID == "tesco" && cachedQueries.first?.dietary == [.gluten])
        #expect(cachedQueries.first?.prefixMatch == true)
        model.loadMore()
        #expect(harness.queries.isEmpty, "Cached pagination cannot race the first live request")
        model.clearLiveQuery(); delay.release(0)
        for _ in 0..<10 { await Task.yield() }
        #expect(model.products.isEmpty && harness.queries.isEmpty)
    }

    @Test
    func slowCacheCannotDelayRequestOrReplaceFreshResponse() async throws {
        let harness = SearchHarness(), cache = SearchHarness()
        let model = harness.model(cachedSearch: { try? await cache.search($0) })
        model.submit("bread")
        await eventually { harness.queries.count == 1 && cache.queries.count == 1 }
        let current = try searchProduct("10000001", name: "Current bread")
        harness.succeed(0, products: [current])
        await eventually { !model.loading }
        cache.succeed(0, products: [try searchProduct("10000002", name: "Old bread")])
        for _ in 0..<10 { await Task.yield() }
        #expect(model.products == [current])
    }

    @Test
    func refinementKeepsOnlyMatchingRowsUntilFullScopedPageArrives() async throws {
        let harness = SearchHarness(), delay = SearchDebounceHarness()
        let model = harness.model(debounce: { await delay.wait() })
        model.setDietary([.gluten])
        model.updateLiveQuery("br")
        await eventually { delay.count == 1 }; delay.release(0)
        await eventually { harness.queries.count == 1 }
        let bread = try searchProduct("10000001", name: "Brown bread"), rice = try searchProduct("10000002", name: "Brown rice")
        harness.succeed(0, products: [bread, rice], hasMore: true)
        await eventually { !model.loading }
        model.updateLiveQuery("brown bre")
        #expect(model.products == [bread] && model.isDebouncing && model.isRefinementPreview)
        #expect(model.totalResults == nil && !model.hasMore)
        #expect(model.notice?.contains("last results") == true)
        await eventually { delay.count == 2 }; delay.release(1)
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].dietary == [.gluten] && model.products == [bread])
        harness.succeed(1, products: [bread, try searchProduct("10000003", name: "Brown bread rolls")])
        await eventually { !model.loading }
        #expect(!model.isRefinementPreview && model.products.count == 2)
        model.updateLiveQuery("brown bread r")
        await eventually { delay.count == 3 }
        model.setDietary([.milk])
        #expect(model.products.isEmpty && !model.isRefinementPreview)
        delay.release(2)
        await eventually { harness.queries.count == 3 }
        harness.succeed(2, products: [])
        await eventually { !model.loading }
    }

    @Test
    func failedRefinementKeepsPartialRowsAndReportsRetryStateHonestly() async throws {
        let harness = SearchHarness(), model = harness.model(debounce: {})
        model.updateLiveQuery("br")
        await eventually { harness.queries.count == 1 }
        let bread = try searchProduct("10000001", name: "Brown bread")
        harness.succeed(0, products: [bread])
        await eventually { !model.loading }
        model.updateLiveQuery("bread")
        await eventually { harness.queries.count == 2 }
        harness.fail(1, error: ProductSearchError.offline)
        await eventually { !model.loading }
        #expect(model.products == [bread] && model.isRefinementPreview)
        #expect(model.notice?.contains("could not be checked") == true)
        #expect(model.totalResults == nil && !model.hasMore && model.errorMessage != nil)
        model.retry()
        #expect(model.notice?.contains("Checking the full catalogue") == true)
        await eventually { harness.queries.count == 3 }
        harness.succeed(2, products: [bread])
        await eventually { !model.loading }
        #expect(!model.isRefinementPreview)
    }

    @Test
    func recipeTypingIsImmediateLocalAndProductsResumeLatestQuery() async throws {
        let harness = SearchHarness(), delay = SearchDebounceHarness()
        var cacheReads = 0
        let model = harness.model(cachedSearch: { _ in cacheReads += 1; return nil }, debounce: { await delay.wait() })
        model.setScope(.recipe)
        model.updateLiveQuery("smoothie")
        for _ in 0..<10 { await Task.yield() }
        #expect(model.query == "smoothie" && !model.isDebouncing && !model.loading)
        #expect(delay.count == 0 && cacheReads == 0 && harness.queries.isEmpty)
        model.setScope(.product)
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].text == "smoothie" && harness.queries[0].prefixMatch)
        harness.succeed(0, products: [])
        await eventually { !model.loading }
    }

    @Test
    func chainSelectionSearchesRealCatalogueAndPreservesActualFoodFilters() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setStore(.tesco)
        model.setDietary([.gluten]); model.setNutrition([.protein])
        let greggs = try #require(SearchPlace.all.first { $0.id == "greggs" })
        model.setPlace(greggs)
        await eventually { harness.queries.count == 1 }
        #expect(model.store == nil, "A chain must clear the prior supermarket context")
        #expect(harness.queries[0].placeID == "greggs")
        #expect(harness.queries[0].text.isEmpty)
        #expect(harness.queries[0].cataloguePolicy == .only)
        #expect(harness.queries[0].dietary == [.gluten]); #expect(harness.queries[0].nutrition == [.protein])
        harness.succeed(0, products: [])
        await eventually { !model.loading }
        #expect(model.errorMessage == nil, "Empty catalogue coverage is different from a failed request")
        model.submit("bread")
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "bread")
        harness.succeed(1, products: [])
        await eventually { !model.loading }
        let costa = try #require(SearchPlace.all.first { $0.id == "costa" })
        model.setPlace(costa)
        await eventually { harness.queries.count == 3 }
        #expect(harness.queries[2].placeID == "costa")
        #expect(harness.queries[2].text == "bread")
        harness.fail(2, error: ProductSearchError.unavailable)
        await eventually { !model.loading }
        #expect(model.errorMessage != nil)
        model.retry()
        await eventually { harness.queries.count == 4 }
        #expect(harness.queries[3].placeID == "costa")
        #expect(harness.queries[3].dietary == [.gluten])
        harness.succeed(3, products: [])
        await eventually { !model.loading }
        model.setPlace(nil)
        await eventually { harness.queries.count == 5 }
        #expect(harness.queries[4].placeID == nil)
        #expect(harness.queries[4].dietary == [.gluten])
        harness.succeed(4, products: [])
    }

    @Test
    func chainPreferenceSurvivesRestartWithoutRestoringPreviousSupermarket() async throws {
        let suite = "nudge-place-preferences-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ProductSearchPreferences(defaults: defaults)
        preferences.update(market: .unitedKingdom, store: .tesco)
        preferences.update(market: .unitedKingdom, store: nil, placeID: "subway")
        let restored = ProductSearchPreferences(defaults: defaults)
        #expect(restored.placeID == "subway"); #expect(restored.store == nil)
        let model = NativeProductSearchModel(search: { .init(query: $0, products: [], hasMore: false) }, lookup: { _ in throw BarcodeLookupError.notFound }, preferences: restored)
        #expect(model.selectedPlace?.id == "subway")
        #expect(model.isChainSelected)
        model.setMarket(.allCountries)
        #expect(restored.placeID == nil)
    }

    @Test
    func selectedStageShowsSpecificTagsBeforeGeneralNutritionWithoutChangingProducts() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setSupportContext(.luteal)
        await eventually { harness.queries.count == 1 }
        let product = try searchProduct("10000001")
        let tags = [
            supportTag("general", contexts: ProductSupportContext.allCases.map(\.rawValue)),
            supportTag("shared-first", contexts: ["luteal", "period"]),
            supportTag("specific", contexts: ["luteal"]),
            supportTag("other-phase", contexts: ["postmenopause"]),
            supportTag("shared-second", contexts: ["perimenopause", "luteal"])
        ]
        harness.succeed(0, products: [product], tags: [product.barcode: tags])
        await eventually { !model.loading }
        #expect(model.tags(for: product).map(\.id) == ["specific", "shared-first", "shared-second", "general"])
        #expect(model.supportTags[product.barcode] == tags, "Presentation does not rewrite the evidence")
        #expect(model.products == [product], "Support-tag ordering cannot change nutrition facts or ratings")
    }

    @Test
    func supportSelectionBrowsesWithoutProfileAndPreservesScopeSortPaginationAndRetry() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setStore(.sainsburys)
        model.setSortOrder(.ratingHighest)
        model.setSupportContext(.luteal)
        await eventually { harness.queries.count == 1 }
        #expect(!model.isBrowsing)
        #expect(harness.queries[0].text.isEmpty)
        #expect(harness.queries[0].supportContext == .luteal)
        #expect(harness.queries[0].store == .sainsburys)
        #expect(harness.queries[0].sortOrder == .ratingHighest)
        #expect(harness.queries[0].cataloguePolicy == .only)
        let product = try searchProduct("10000001")
        harness.succeed(0, products: [product], hasMore: true, tags: [product.barcode: [supportTag()]])
        await eventually { !model.loading }
        #expect(model.tags(for: product).count == 1)
        model.loadMore()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].page == 2)
        harness.fail(1, error: ProductSearchError.unavailable)
        await eventually { !model.loading }
        #expect(model.errorMessage?.contains("keep this phase") == true)
        model.retry()
        await eventually { harness.queries.count == 3 }
        #expect(harness.queries[2].supportContext == .luteal)
        #expect(harness.queries[2].page == 2)
        #expect(harness.queries[2].store == .sainsburys)
        #expect(harness.queries[2].sortOrder == .ratingHighest)
        harness.succeed(2, products: [])
        await eventually { !model.loading }
        #expect(model.tags(for: product).count == 1)
        model.setSupportContext(nil)
        #expect(model.isBrowsing)
        #expect(model.supportTags.isEmpty)
        #expect(model.supportCoverage == nil)
    }

    @Test
    func changingSupportContextRejectsLateResultsAndClearingCategoryCancelsOnce() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setSupportContext(.period)
        await eventually { harness.queries.count == 1 }
        model.setSupportContext(.postmenopause)
        await eventually { harness.queries.count == 2 }
        harness.succeed(1, products: [try searchProduct("10000002")])
        await eventually { !model.loading }
        harness.succeed(0, products: [try searchProduct("10000001")])
        await Task.yield()
        #expect(model.products.map(\.barcode) == ["10000002"])
        #expect(model.supportContext == .postmenopause)
        model.showCategories(clearSupportContext: true)
        #expect(model.isBrowsing)
        await Task.yield()
        #expect(harness.queries.count == 2)
    }

    @Test
    func supportContextIsKeptDuringSpellingRetryAndCategoryQueries() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setSupportContext(.perimenopause)
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [])
        await eventually { !model.loading }
        model.submit("yoghurt")
        await eventually { harness.queries.count == 2 }
        harness.succeed(1, products: [])
        await eventually { harness.queries.count == 3 }
        #expect(harness.queries[2].text == "yogurt")
        #expect(harness.queries[2].supportContext == .perimenopause)
        harness.succeed(2, products: [])
        await eventually { !model.loading }
        model.select(ProductSearchCategory.all[0])
        await eventually { harness.queries.count == 4 }
        #expect(harness.queries[3].supportContext == .perimenopause)
        #expect(harness.queries[3].category == ProductSearchCategory.all[0])
        harness.succeed(3, products: [])
        await eventually { !model.loading }
    }

    @Test
    func typedSavedIntentRestoresSearchAndPreservesPendingPagination() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setStore(.tesco)
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        let first = try searchProduct("10000001")
        harness.succeed(0, products: [first], hasMore: true)
        await eventually { !model.loading }
        let context = model.ratingContextID
        model.scrollAnchor = first.barcode
        model.loadMore()
        await eventually { harness.queries.count == 2 }

        // Reproduce the TextField binding, rather than calling submit with a separate string.
        model.query = "saved products"
        model.submit()
        #expect(model.savedIntentRevision == 1)
        #expect(model.query == "bread")
        #expect(model.submittedQuery == "bread")
        #expect(model.store == .tesco)
        #expect(model.products == [first])
        #expect(model.scrollAnchor == first.barcode)
        #expect(model.ratingContextID == context)
        #expect(model.loading)
        #expect(harness.queries.count == 2)
        #expect(harness.lookups.isEmpty)

        let second = try searchProduct("10000002")
        harness.succeed(1, products: [second])
        await eventually { !model.loading }
        #expect(model.products == [first, second], "Saved navigation does not cancel an existing search request")
        #expect(model.query == "bread")
        #expect(model.ratingContextID == context)
    }

    @Test
    func typedSavedIntentFromLandingRestoresEmptyQueryWithoutSearching() async {
        let harness = SearchHarness(), model = harness.model()
        model.query = "saved products"
        model.submit()
        await Task.yield()
        #expect(model.savedIntentRevision == 1)
        #expect(model.query.isEmpty)
        #expect(model.submittedQuery.isEmpty)
        #expect(model.isBrowsing)
        #expect(model.products.isEmpty)
        #expect(!model.loading)
        #expect(harness.queries.isEmpty)
        #expect(harness.lookups.isEmpty)
    }

    @Test
    func recipeAndSavedSearchStayLocalThenResumeProductDiscoveryForTheSubmittedFood() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.setScope(.recipe)
        model.submit("chickpeas")
        await Task.yield()
        #expect(harness.queries.isEmpty)
        #expect(model.submittedQuery == "chickpeas")
        model.setScope(.product)
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].text == "chickpeas")
        harness.succeed(0, products: [try searchProduct("10000001", name: "Chickpeas")])
        await eventually { !model.loading }
        model.setSavedOnly(true)
        model.submit("oats")
        model.minimumScore = 50; model.mealFilter = "breakfast"; model.supportFilter = "luteal"
        await Task.yield()
        #expect(harness.queries.count == 1)
        #expect(model.hasFoodFilters)
        #expect(model.needsResolvedRatings)
        model.setSavedOnly(false)
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "oats")
        #expect(!harness.queries[1].parameters.description.contains("luteal"), "Private stage selections stay local")
        harness.succeed(1, products: [try searchProduct("10000002", name: "Oats")])
        await eventually { !model.loading }
        model.clearFoodFilters()
        #expect(!model.hasFoodFilters)
        #expect(harness.queries.count == 2, "Changing local food filters must not make provider requests")
        #expect(harness.lookups.isEmpty)
    }

    @Test
    func parsedFilterOnlySearchAndLateProductResponsesCannotBreakRecipeScope() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.submit("", filters: ["kind":"recipe", "minimumScore":75, "meal":"dinner", "support":"period"])
        #expect(model.scope == .recipe)
        #expect(model.minimumScore == 75)
        #expect(model.mealFilter == "all", "Removed meal categories cannot apply a hidden filter")
        #expect(model.supportFilter == "period")
        #expect(harness.queries.isEmpty)
        model.submit("chickpeas", filters: ["kind":"all"])
        await eventually { harness.queries.count == 1 }
        model.setScope(.recipe)
        harness.succeed(0, products: [try searchProduct("10000001", name: "Obsolete result")])
        for _ in 0..<20 { await Task.yield() }
        #expect(!model.loading)
        #expect(model.products.isEmpty)
        #expect(model.errorMessage == nil)
        #expect(model.submittedQuery == "chickpeas")
        model.setScope(.all)
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "chickpeas")
        harness.succeed(1, products: [try searchProduct("10000002", name: "Current result")])
        await eventually { !model.loading }
        #expect(model.products.map(\.barcode) == ["10000002"])
        #expect(model.minimumScore == 75)
        #expect(model.supportFilter == "period")
    }

    @Test
    func selectedSupermarketPersistsAcrossModelsAndWorldScopeClearsIt() async throws {
        let suite = "nudge-search-preferences-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ProductSearchPreferences(defaults: defaults)
        var calls = 0
        func model(_ settings: ProductSearchPreferences) -> NativeProductSearchModel {
            NativeProductSearchModel(search: { query in
                calls += 1
                return ProductSearchPage(query: query, products: [], hasMore: false)
            }, lookup: { _ in throw BarcodeLookupError.notFound }, preferences: settings)
        }
        let first = model(preferences)
        first.setStore(.sainsburys)
        #expect(preferences.store == .sainsburys)
        let restored = model(ProductSearchPreferences(defaults: defaults))
        #expect(restored.market == .unitedKingdom)
        #expect(restored.store == .sainsburys)
        restored.setMarket(.allCountries)
        let world = ProductSearchPreferences(defaults: defaults)
        #expect(world.market == .allCountries)
        #expect(world.store == nil)
        #expect(calls == 0, "Persisting discovery choices never fetches products")
    }

    @Test
    func sortIsLocalStableAndReordersWhenRatingsArriveWithoutInventingUnknownValues() async throws {
        let harness = SearchHarness(), model = harness.model()
        let names = ["Yoghurt 10", "Apple", "Yoghurt 2", "Apple", "Banana"]
        let cards = try (1...5).map { try searchProduct("1000000\($0)", name: names[$0 - 1]) }
        model.submit("food")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: cards)
        await eventually { !model.loading }
        var scores = ["10000001": 70, "10000003": 90, "10000004": 70, "10000005": 0]
        var reads = 0
        func rating(_ product: BarcodeProduct) -> NativeProductRating {
            reads += 1
            return .init(value: scores[product.barcode], subtitle: "Fixture")
        }
        func order() -> [String] { model.orderedProducts(rating: rating).map(\.barcode) }
        let initial = cards.map(\.barcode)
        #expect(order() == initial)
        #expect(reads == 0)
        model.setSortOrder(.ratingHighest)
        #expect(order() == ["10000003", "10000001", "10000004", "10000005", "10000002"])
        #expect(reads == cards.count, "Score projection is linear, outside the sort comparator")
        scores["10000002"] = 95
        #expect(order().first == "10000002", "Newly delivered ratings update ordering")
        scores.removeValue(forKey: "10000002")
        model.setSortOrder(.ratingLowest)
        #expect(order() == ["10000005", "10000001", "10000004", "10000003", "10000002"])
        reads = 0
        model.setSortOrder(.nameAscending)
        #expect(order() == ["10000002", "10000004", "10000005", "10000003", "10000001"])
        model.setSortOrder(.nameDescending)
        #expect(order() == ["10000001", "10000003", "10000005", "10000002", "10000004"])
        #expect(reads == 0, "Name sorting does not need ratings")
        model.setSortOrder(.relevance)
        #expect(order() == initial)
        #expect(model.products.map(\.barcode) == initial, "Provider pagination stays intact")
        #expect(harness.queries.count == 1)
        #expect(harness.lookups.isEmpty)
    }

    @Test
    func typingAndSuggestionsNeverStartRequests() async {
        let harness = SearchHarness()
        let model = harness.model()
        #expect(model.isBrowsing)
        model.query = "yogurt"
        #expect(!model.suggestions.isEmpty)
        await Task.yield()
        #expect(harness.queries.isEmpty)
        #expect(harness.lookups.isEmpty)
        #expect(model.products.isEmpty)
    }

    @Test
    func selectingInstantSuggestionSubmitsExactlyOnce() async {
        let harness = SearchHarness(), model = harness.model()
        for query in ["b", "bl", "blueb"] {
            model.query = query
            #expect(!model.suggestions.isEmpty)
        }
        await Task.yield()
        #expect(harness.queries.isEmpty)
        #expect(harness.lookups.isEmpty)
        let suggestion = model.suggestions.first ?? ""
        #expect(suggestion == "Blueberry smoothie")
        model.submit(suggestion)
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries.first?.text == "blueberry smoothie")
        harness.succeed(0, products: [])
        await eventually { !model.loading }
        #expect(harness.queries.count == 1)
        #expect(harness.lookups.isEmpty)
    }

    @Test
    func autocompleteUsesRelevantLoadedProductNamesAndBrandsWithoutRequests() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.submit("food")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [
            try searchProduct("10000001", name: "Blueberry kefir", brand: "Fixture Dairy"),
            try searchProduct("10000002", name: "Steak slices", brand: "FIXTURE DAIRY")
        ])
        await eventually { !model.loading }
        model.query = "fixture d"
        #expect(model.suggestions == ["Fixture Dairy"])
        model.query = "blueberry k"
        #expect(model.suggestions == ["Blueberry kefir"])
        model.query = "tea"
        #expect(!model.suggestions.contains("Steak slices"))
        model.query = "unrelated zz"
        #expect(model.suggestions.isEmpty)
        await Task.yield()
        #expect(harness.queries.count == 1)
        #expect(harness.lookups.isEmpty)
    }

    @Test
    func cachedOrderingInvalidatesForAdditionalPagesAndReplacementFacts() async throws {
        let harness = SearchHarness(), model = harness.model()
        model.submit("food")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [try searchProduct("10000001", name: "Pear")], hasMore: true)
        await eventually { !model.loading }
        model.setSortOrder(.nameAscending)
        func orderedNames() -> [String] {
            model.orderedProducts(rating: { _ in Issue.record("Name sort should not resolve ratings"); return .init(value: nil, subtitle: "Unknown") }).map(\.name)
        }
        #expect(orderedNames() == ["Pear"])
        #expect(orderedNames() == ["Pear"])
        model.loadMore()
        await eventually { harness.queries.count == 2 }
        harness.succeed(1, products: [try searchProduct("10000002", name: "Apple")])
        await eventually { !model.loading }
        #expect(orderedNames() == ["Apple", "Pear"])
        model.submit("other food")
        await eventually { harness.queries.count == 3 }
        harness.succeed(2, products: [try searchProduct("10000001", name: "Banana")])
        await eventually { !model.loading }
        #expect(orderedNames() == ["Banana"], "Stable barcode identity cannot retain the prior query's name or ordering")
    }

    @Test
    func scopeChangesOnLandingStayLocalAndUKIsDefault() async {
        let harness = SearchHarness()
        let model = harness.model()
        #expect(model.market == .unitedKingdom)
        #expect(model.store == nil)
        model.setStore(.tesco)
        model.query = "Unsubmitted text"
        model.setMarket(.allCountries)
        #expect(model.store == nil)
        model.setStore(.tesco)
        #expect(model.store == nil, "World search cannot silently retain a UK supermarket")
        await Task.yield()
        #expect(model.query == "Unsubmitted text")
        #expect(model.isBrowsing)
        #expect(harness.queries.isEmpty)
        #expect(harness.lookups.isEmpty)
    }

    @Test
    func supermarketChangeRerunsSubmittedQueryAndRejectsOlderResults() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].market == .unitedKingdom)
        model.query = "Text still being typed"
        model.setStore(.tesco)
        model.setStore(.tesco)
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "bread")
        #expect(harness.queries[1].store == .tesco)
        #expect(harness.queries[1].page == 1)
        harness.succeed(1, products: [try searchProduct("10000002")])
        await eventually { !model.loading }
        harness.succeed(0, products: [try searchProduct("10000001")])
        await Task.yield()
        #expect(model.products.map(\.barcode) == ["10000002"])
        #expect(model.query == "Text still being typed")
        #expect(model.submittedQuery == "bread")
        #expect(harness.queries.count == 2)
    }

    @Test
    func scopeChangesResetPaginationWithoutLosingCategory() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        let category = ProductSearchCategory.all[0]
        model.setStore(.sainsburys)
        model.select(category)
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [try searchProduct("10000001")], hasMore: true)
        await eventually { !model.loading }
        model.loadMore()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].page == 2)
        #expect(harness.queries[1].store == .sainsburys)
        model.setMarket(.allCountries)
        await eventually { harness.queries.count == 3 }
        #expect(model.products.isEmpty)
        #expect(model.store == nil)
        #expect(model.selectedCategory == category)
        #expect(harness.queries[2].page == 1)
        #expect(harness.queries[2].category == category)
        #expect(harness.queries[2].market == .allCountries)
        #expect(harness.queries[2].store == nil)
        harness.succeed(2, products: [try searchProduct("10000003")])
        await eventually { !model.loading }
        harness.succeed(1, products: [try searchProduct("10000002")])
        await Task.yield()
        #expect(model.products.map(\.barcode) == ["10000003"])
    }

    @Test
    func exactBarcodeIsNotHiddenOrRepeatedWhenDiscoveryScopeChanges() async {
        let harness = SearchHarness()
        let model = harness.model()
        model.setStore(.tesco)
        model.submit("1234567890123")
        await eventually { !model.loading }
        #expect(model.isBarcodeResult)
        model.setStore(.aldi)
        model.setMarket(.allCountries)
        await Task.yield()
        #expect(harness.lookups == ["1234567890123"])
        #expect(harness.queries.isEmpty)
        #expect(model.products.map(\.barcode) == ["1234567890123"])
    }

    @Test
    func aSlowerCategoryCannotOverwriteLatestSelection() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        model.select(ProductSearchCategory.all[0])
        await eventually { harness.queries.count == 1 }
        model.select(ProductSearchCategory.all[1])
        await eventually { harness.queries.count == 2 }
        harness.succeed(1, products: [try searchProduct("10000002")])
        await eventually { !model.loading }
        harness.succeed(0, products: [try searchProduct("10000001")])
        await Task.yield()
        #expect(model.products.map(\.barcode) == ["10000002"])
        #expect(model.selectedCategory == ProductSearchCategory.all[1])
        #expect(model.errorMessage == nil)
    }

    @Test
    func paginationDeduplicatesAndPageFailureRetainsRowsForRetry() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        let first = try searchProduct("10000001"), second = try searchProduct("10000002")
        model.submit("cereal")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [first], hasMore: true)
        await eventually { !model.loading }
        model.loadMore()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].page == 2)
        harness.fail(1, error: ProductSearchError.offline)
        await eventually { !model.loading }
        #expect(model.products == [first])
        #expect(model.errorMessage != nil)
        #expect(model.hasMore)
        model.retry()
        await eventually { harness.queries.count == 3 }
        #expect(harness.queries[2].page == 2)
        harness.succeed(2, products: [first, second])
        await eventually { !model.loading }
        #expect(model.products == [first, second])
        #expect(model.errorMessage == nil)
        #expect(!model.hasMore)
    }

    @Test
    func leavingTabCancelsOwnershipAndCanResumeThePendingPage() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        model.cancel()
        #expect(!model.loading)
        #expect(model.errorMessage != nil)
        model.retry()
        await eventually { harness.queries.count == 2 }
        harness.succeed(0, products: [try searchProduct("10000001")])
        await Task.yield()
        #expect(model.products.isEmpty)
        harness.succeed(1, products: [try searchProduct("10000002")])
        await eventually { !model.loading }
        #expect(model.products.map(\.barcode) == ["10000002"])
        model.showCategories()
        #expect(model.isBrowsing)
        #expect(model.products.isEmpty)
        #expect(model.submittedQuery.isEmpty)
    }

    @Test
    func submittedBarcodeUsesLookupOnlyAndDoesNotSearchOnTyping() async {
        let harness = SearchHarness()
        let model = harness.model()
        model.query = "1234567890123"
        await Task.yield()
        #expect(harness.lookups.isEmpty)
        model.submit()
        await eventually { !model.loading }
        #expect(harness.lookups == ["1234567890123"])
        #expect(harness.queries.isEmpty)
        #expect(model.products.map(\.barcode) == ["1234567890123"])
        #expect(!model.hasMore)
    }

    @Test
    func aliasesHaveOneBoundedFallbackAndKeepOriginalSubmissionVisible() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        model.setStore(.waitrose)
        model.submit("yogurt")
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].text == "yoghurt")
        harness.succeed(0, products: [])
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "yogurt")
        #expect(harness.queries[1].market == .unitedKingdom)
        #expect(harness.queries[1].store == .waitrose)
        harness.succeed(1, products: [try searchProduct("10000001")], hasMore: true)
        await eventually { !model.loading }
        #expect(model.submittedQuery == "yogurt")
        #expect(model.correction?.contains("yoghurt") == true)
        model.loadMore()
        await eventually { harness.queries.count == 3 }
        #expect(harness.queries[2].text == "yogurt")
        #expect(harness.queries[2].page == 2)
        #expect(harness.queries[2].store == .waitrose)
        harness.succeed(2, products: [])
        await eventually { !model.loading }
    }

    @Test
    func beansSearchUsesPluralsWithoutTypingRequestsOrChangingStore() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        model.setStore(.sainsburys)
        model.query = "baked bean"
        #expect(model.suggestions.contains("baked beans"))
        #expect(harness.queries.isEmpty)
        model.submit()
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries[0].text == "baked beans")
        #expect(harness.queries[0].market == .unitedKingdom)
        #expect(harness.queries[0].store == .sainsburys)
        harness.succeed(0, products: [try searchProduct("10000001", name: "Baked beans")], hasMore: true)
        await eventually { !model.loading }
        #expect(model.query == "baked bean")
        #expect(model.submittedQuery == "baked bean")
        #expect(harness.queries.count == 1)
        model.loadMore()
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "baked beans")
        #expect(harness.queries[1].store == .sainsburys)
        #expect(harness.queries[1].page == 2)
        harness.succeed(1, products: [])
        await eventually { !model.loading }
        #expect(harness.queries.count == 2, "No alias request for a later empty page")
    }

    @Test
    func emptyBeansSearchTriesOnlyOneEquivalentAndNeverBroadensStore() async {
        let harness = SearchHarness()
        let model = harness.model()
        model.setStore(.sainsburys)
        model.submit("beans")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [])
        await eventually { harness.queries.count == 2 }
        #expect(harness.queries[1].text == "bean")
        #expect(harness.queries.allSatisfy { $0.market == .unitedKingdom && $0.store == .sainsburys })
        harness.succeed(1, products: [])
        await eventually { !model.loading }
        #expect(model.submittedQuery == "beans")
        #expect(harness.queries.count == 2)
        #expect(model.products.isEmpty)
        #expect(!model.hasMore)
    }

    @Test
    func providerCooldownIsRespectedWithoutTryingAliasOnFailure() async {
        let harness = SearchHarness()
        let model = harness.model()
        model.submit("yogurt")
        await eventually { harness.queries.count == 1 }
        harness.fail(0, error: ProductSearchError.providerRateLimited(45))
        await eventually { !model.loading }
        #expect(model.retrySeconds == 45)
        model.retry()
        await Task.yield()
        #expect(harness.queries.count == 1)
        harness.now = harness.now.addingTimeInterval(45)
        model.retry()
        await eventually { harness.queries.count == 2 }
        harness.fail(1, error: ProductSearchError.offline)
        await eventually { !model.loading }
        #expect(harness.queries.count == 2)
        #expect(model.retrySeconds == 0)
    }

    @Test
    func staleProductsAreShownWithNoticeAndRetryDelay() async throws {
        let harness = SearchHarness()
        let model = harness.model()
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [try searchProduct("10000001")], stale: true, retrySeconds: 30)
        await eventually { !model.loading }
        #expect(model.products.count == 1)
        #expect(model.notice?.contains("previously loaded") == true)
        #expect(model.retrySeconds == 30)
        #expect(model.errorMessage == nil)
        #expect(model.isStale)
    }

    @Test
    func rapidIdenticalSubmissionsShareOnePendingRequest() async {
        let harness = SearchHarness()
        let model = harness.model()
        model.submit("bread")
        model.submit("bread")
        await eventually { harness.queries.count == 1 }
        #expect(harness.queries.count == 1)
        harness.succeed(0, products: [])
        await eventually { !model.loading }
    }

    @Test
    func explicitResubmissionStartsNewRatingContextButPaginationDoesNot() async {
        let harness = SearchHarness()
        let model = harness.model()
        let landing = model.ratingContextID
        model.submit("bread")
        let initial = model.ratingContextID
        #expect(initial != landing)
        model.submit("bread")
        #expect(model.ratingContextID == initial, "Repeated taps while loading share work")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [], hasMore: true)
        await eventually { !model.loading }
        model.loadMore()
        #expect(model.ratingContextID == initial)
        await eventually { harness.queries.count == 2 }
        harness.succeed(1, products: [])
        await eventually { !model.loading }
        model.submit("bread")
        #expect(model.ratingContextID != initial, "A fresh explicit search can retry unavailable ratings")
        await eventually { harness.queries.count == 3 }
        harness.succeed(2, products: [])
        await eventually { !model.loading }
    }

    @Test
    func diagnosticsContainStagesAndCountsWithoutQueryOrProductContent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let diagnostics = AnalysisDiagnostics(directory: directory)
        let harness = SearchHarness()
        let model = harness.model(diagnostics: diagnostics)
        model.submit("Private Brand phrase")
        await eventually { harness.queries.count == 1 }
        harness.succeed(0, products: [try searchProduct("10000001")])
        await eventually { !model.loading }
        let data = try diagnostics.exportData(now: harness.now)
        let text = String(decoding: data, as: UTF8.self)
        #expect(!text.contains("Private Brand phrase"))
        #expect(!text.contains("10000001"))
        #expect(text.contains("search_request"))
        #expect(text.contains("search_response"))
        #expect(text.contains("search_delivery"))
        #expect(text.contains("search_ui"))
        #expect(text.contains("productCount"))
    }

    @Test
    func serviceInitializerCorrelatesHTTPAndModelDiagnosticsWithoutNetwork() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let diagnostics = AnalysisDiagnostics(directory: directory)
        let state = ProductSearchState()
        let now = Date()
        let query = try ProductSearchQuery(literalText: "Private Brand phrase")
        await state.save(ProductSearchPage(query: query, products: [try searchProduct("10000001")], hasMore: false), at: now)
        let submittedQuery = try ProductSearchQuery(literalText: SearchDiscoveryParser.parse("Private Brand phrase").text)
        #expect(query.key == submittedQuery.key)
        let cached = await state.cached(submittedQuery, at: now)
        #expect(cached?.products.count == 1)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SearchUnexpectedNetworkProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let networkAttempts = SearchUnexpectedNetworkProtocol.attempts.count
        let service = OpenFoodFactsService(now: { now }, cache: nil, searchSession: session, searchState: state, searchDiagnostics: diagnostics)
        let model = NativeProductSearchModel(service: service, preferences: nil)
        model.submit("Private Brand phrase")
        // This crosses the search-state actor twice and writes diagnostics to
        // disk. A fixed number of yields can expire in under 100 ms before the
        // service continuation resumes on a busy simulator.
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while model.loading, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(!model.loading)
        #expect(model.products.count == 1)
        #expect(SearchUnexpectedNetworkProtocol.attempts.count == networkAttempts)
        let data = try diagnostics.exportData()
        let document = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try #require(document["events"] as? [[String: Any]])
        let stages = Set(events.compactMap { $0["stage"] as? String })
        #expect(stages.isSuperset(of: ["search_request", "search_http", "search_response", "search_delivery", "search_ui"]))
        let httpEvents = events.filter { $0["stage"] as? String == "search_http" }
        #expect(httpEvents.count == 1)
        #expect(httpEvents.first?["outcome"] as? String == "cached")
        #expect((httpEvents.first?["metadata"] as? [String: Any])?["requestSent"] as? Bool == false)
        let hashes = events.compactMap { ($0["metadata"] as? [String: Any])?["requestHash"] as? String }
        #expect(hashes.count == events.count)
        #expect(Set(hashes).count == 1)
        #expect(!String(decoding: data, as: UTF8.self).contains("Private Brand phrase"))
    }

    @Test
    func identicalDiscoveryRequestsShareWorkAndOneReaderCanCancel() async throws {
        let harness = SearchHarness()
        let state = ProductSearchState()
        let query = try ProductSearchQuery(category: ProductSearchCategory.all[0])
        let first = UUID(), second = UUID()
        let firstTask = await state.join(query, reader: first) { try await harness.search(query) }
        let secondTask = await state.join(query, reader: second) { try await harness.search(query) }
        await eventually { harness.queries.count == 1 }
        await state.leave(query, reader: first)
        #expect(!secondTask.isCancelled)
        harness.succeed(0, products: [try searchProduct("10000001")])
        #expect(try await firstTask.value.products.count == 1)
        #expect(try await secondTask.value.products.count == 1)
        await state.leave(query, reader: second)
        #expect(harness.queries.count == 1)
    }
}

@MainActor
private final class SearchDebounceHarness {
    private(set) var count = 0
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
    func wait() async {
        let index = count; count += 1
        await withCheckedContinuation { waiting[index] = $0 }
    }
    func release(_ index: Int) { waiting.removeValue(forKey: index)?.resume() }
}

@MainActor
private final class SearchHarness {
    var queries: [ProductSearchQuery] = []
    var lookups: [String] = []
    var now = Date(timeIntervalSince1970: 100_000)
    private var pending: [Int: CheckedContinuation<ProductSearchPage, Error>] = [:]

    func model(diagnostics: AnalysisDiagnostics? = nil, preferences: ProductSearchPreferences? = nil,
               cachedSearch: NativeProductSearchModel.CachedSearch? = nil,
               debounce: @escaping NativeProductSearchModel.Debounce = { try await Task.sleep(for: .milliseconds(275)) }) -> NativeProductSearchModel {
        NativeProductSearchModel(search: { try await self.search($0) }, lookup: { barcode in
            self.lookups.append(barcode)
            return try searchProduct(barcode)
        }, now: { self.now }, diagnostics: diagnostics, preferences: preferences, cachedSearch: cachedSearch, debounce: debounce)
    }

    func search(_ query: ProductSearchQuery) async throws -> ProductSearchPage {
        let index = queries.count
        queries.append(query)
        return try await withCheckedThrowingContinuation { pending[index] = $0 }
    }

    func succeed(_ index: Int, products: [BarcodeProduct], hasMore: Bool = false,
                 stale: Bool = false, retrySeconds: Int = 0, tags: [String: [ProductSupportTag]] = [:]) {
        var page = ProductSearchPage(query: queries[index], products: products, hasMore: hasMore)
        page.stale = stale
        page.cached = stale
        page.retryAfterSeconds = retrySeconds
        page.supportTags = tags
        pending.removeValue(forKey: index)?.resume(returning: page)
    }

    func fail(_ index: Int, error: Error) { pending.removeValue(forKey: index)?.resume(throwing: error) }
}

private final class SearchNetworkAttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func increment() { lock.lock(); defer { lock.unlock() }; value += 1 }
}

/// A cache-only fixture must fail locally if it unexpectedly tries HTTP.
private final class SearchUnexpectedNetworkProtocol: URLProtocol, @unchecked Sendable {
    static let attempts = SearchNetworkAttemptCounter()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.attempts.increment()
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}

private func supportTag(_ id: String = "candidate", contexts: [String] = ["luteal", "postmenopause"]) -> ProductSupportTag {
    .init(id: id, label: "Calcium foods", contexts: contexts,
          evidence: "established_nutrition", evidenceDirection: "general_nutrition",
          wording: "Calcium contributes to maintaining bones.", foodDataConfidence: "source_reported_nutrients",
          foodFamilies: [], sources: [.init(id: "nhs", title: "Calcium", url: "https://www.nhs.uk/conditions/vitamins-and-minerals/calcium/")],
          limitations: ["Product data can be incomplete."])
}

private func searchProduct(_ barcode: String, categories: [String] = [], name: String? = nil, brand: String? = nil) throws -> BarcodeProduct {
    let data = try JSONSerialization.data(withJSONObject: ["product": ["code": barcode, "product_name": name ?? "Product \(barcode)", "categories_tags": categories, "brands": brand ?? ""]])
    return try OpenFoodFactsParser.parse(data: data, barcode: barcode, retrievedAt: Date(timeIntervalSince1970: 100_000))
}

@MainActor
private func eventually(_ condition: () -> Bool) async {
    for _ in 0..<500 {
        if condition() { return }
        await Task.yield()
    }
    #expect(condition(), "Expected asynchronous search state did not arrive")
}
