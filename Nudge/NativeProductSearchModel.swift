import Combine
import Foundation

/// Public discovery preferences, shared with scanned-product alternatives.
/// These are the user's selected filters, not inferred device location.
@MainActor
final class ProductSearchPreferences: ObservableObject {
    static let shared = ProductSearchPreferences(defaults: .standard)
    @Published private(set) var market: ProductSearchMarket
    @Published private(set) var store: ProductSearchStore?
    @Published private(set) var placeID: String?
    private let defaults: UserDefaults
    private static let marketKey = "nudge.search.market.v1"
    private static let storeKey = "nudge.search.store.v1"
    private static let placeKey = "nudge.search.place.v1"
    private static let searchesKey = "nudge.search.recent.v1"
    private struct RememberedSearch: Codable {
        let text: String
        var count: Int
        var usedAt: Date
    }
    private var searches: [RememberedSearch] = []

    init(defaults: UserDefaults) {
        self.defaults = defaults
        let selectedMarket = ProductSearchMarket.allCases.first { $0.id == defaults.string(forKey: Self.marketKey) } ?? .unitedKingdom
        market = selectedMarket
        let legacyStore = selectedMarket == .unitedKingdom
            ? ProductSearchStore.allCases.first { $0.id == defaults.string(forKey: Self.storeKey) } : nil
        store = legacyStore
        let restoredPlace = selectedMarket == .unitedKingdom
            ? SearchPlace.all.first { $0.id == defaults.string(forKey: Self.placeKey) } : nil
        placeID = restoredPlace?.id ?? SearchPlace.all.first { $0.store == legacyStore && $0.store != nil }?.id
        if let restoredPlace { store = restoredPlace.store }
        if let data = defaults.data(forKey: Self.searchesKey), data.count <= 16_384,
           let saved = try? JSONDecoder().decode([RememberedSearch].self, from: data), saved.count <= 24 {
            searches = saved.filter { Self.validSearch($0.text) && (1...10_000).contains($0.count)
                && (0..<(365 * 86_400)).contains(Date().timeIntervalSince($0.usedAt)) }
        }
    }

    func update(market: ProductSearchMarket, store: ProductSearchStore?, placeID: String? = nil) {
        self.market = market
        self.store = market == .unitedKingdom ? store : nil
        self.placeID = market == .unitedKingdom
            ? SearchPlace.all.first { $0.id == placeID }?.id ?? SearchPlace.all.first { $0.store == store && $0.store != nil }?.id : nil
        if let selected = self.placeID { defaults.set(selected, forKey: Self.placeKey) }
        else { defaults.removeObject(forKey: Self.placeKey) }
        defaults.set(market.id, forKey: Self.marketKey)
        if let selected = self.store { defaults.set(selected.id, forKey: Self.storeKey) }
        else { defaults.removeObject(forKey: Self.storeKey) }
    }

    /// Food-only search history stays on this device. It never enters support
    /// diagnostics or the shared public product catalogue.
    func rememberSearch(_ text: String, at date: Date = Date()) {
        guard Self.validSearch(text) else { return }
        if let index = searches.firstIndex(where: { $0.text.caseInsensitiveCompare(text) == .orderedSame }) {
            searches[index].count = min(10_000, searches[index].count + 1)
            searches[index].usedAt = date
        } else { searches.append(RememberedSearch(text: text, count: 1, usedAt: date)) }
        searches.sort { $0.usedAt > $1.usedAt }
        searches = Array(searches.prefix(24))
        if let data = try? JSONEncoder().encode(searches) { defaults.set(data, forKey: Self.searchesKey) }
    }

    func searchSuggestions(for text: String) -> [String] {
        let input = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = searches.filter { input.isEmpty || $0.text.localizedCaseInsensitiveContains(input) }
        let recent = matching.sorted { $0.usedAt > $1.usedAt }.prefix(4)
        let frequent = matching.sorted { $0.count == $1.count ? $0.usedAt > $1.usedAt : $0.count > $1.count }.prefix(4)
        var seen = Set<String>()
        return (Array(recent) + Array(frequent)).map(\.text).filter { seen.insert($0.lowercased()).inserted }
    }

    func clearRecentSearches() {
        searches.removeAll()
        defaults.removeObject(forKey: Self.searchesKey)
    }

    var recentSearchTerms: [String] { searches.sorted { $0.usedAt > $1.usedAt }.map(\.text) }

    private static func validSearch(_ text: String) -> Bool {
        (2...80).contains(text.count) && !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
            && text.range(of: #"^[0-9]+$"#, options: .regularExpression) == nil
    }
}

enum NativeProductSearchSort: String, CaseIterable, Identifiable {
    case relevance, ratingHighest, ratingLowest, nameAscending, nameDescending
    var id: String { rawValue }
    var title: String {
        switch self {
        case .relevance: "Relevance"
        case .ratingHighest: "Rating: high to low"
        case .ratingLowest: "Rating: low to high"
        case .nameAscending: "Name: A–Z"
        case .nameDescending: "Name: Z–A"
        }
    }
    var usesRating: Bool { self == .ratingHighest || self == .ratingLowest }
}

enum NativeFoodSearchScope: String, CaseIterable, Identifiable {
    case all, recipe, product
    var id: String { rawValue }
    var title: String {
        switch self { case .all: "All"; case .recipe: "Recipes"; case .product: "Products" }
    }
}

/// Search owns only public catalogue requests. It never saves food or logs intake.
@MainActor
final class NativeProductSearchModel: ObservableObject {
    typealias Search = (ProductSearchQuery) async throws -> ProductSearchPage
    typealias Lookup = (String) async throws -> BarcodeProduct
    typealias CachedSearch = (ProductSearchQuery) async -> ProductSearchPage?
    typealias Debounce = () async throws -> Void
    private typealias DiagnosticSearch = (ProductSearchQuery, String) async throws -> ProductSearchPage

    @Published var query = ""
    @Published private(set) var selectedPlace: SearchPlace?
    @Published private(set) var dietary: Set<SearchDietaryRequirement> = []
    @Published private(set) var nutrition: Set<SearchNutritionChoice> = []
    @Published private(set) var nutritionMode: SearchNutritionMode = .any
    @Published private(set) var savedIntentRevision = 0
    @Published private(set) var totalResults: Int?
    @Published private(set) var dietaryConflictCount: Int?
    @Published private(set) var dietaryUnknownCount: Int?
    @Published private(set) var discoveryCoverage: ProductSupportCoverage?
    @Published var discoveryRouteID = "aisles"
    var scrollAnchor: String?
    var allAislesExpanded = false
    var filterCoverageSummary: String? {
        guard let coverage = discoveryCoverage else { return nil }
        return coverage.complete ? "Filters checked against the indexed catalogue; source coverage remains incomplete."
            : "Filters checked for \(coverage.processed.formatted()) of \(coverage.total.formatted()) indexed foods. More matches may appear."
    }
    var isChainSelected: Bool { selectedPlace.map { !$0.isSupermarket } ?? false }
    @Published private(set) var placeCoverage: ProductSupportCoverage?
    @Published private(set) var placeEvidence: [String: ProductPlaceEvidence] = [:]
    var placeCoverageSummary: String? {
        guard let coverage = placeCoverage else { return nil }
        return coverage.complete ? nil : "Place associations checked for \(coverage.processed.formatted()) of \(coverage.total.formatted()) catalogue products. More matches may appear."
    }
    func placeAssociation(for product: BarcodeProduct) -> ProductPlaceAssociation? {
        guard let selectedPlace else { return nil }
        return placeEvidence[product.barcode]?.association(for: selectedPlace.id, product: product)
    }

    @Published private(set) var products: [BarcodeProduct] = [] {
        didSet {
            orderedCache = nil
            productSuggestionTerms = ProductSearchAutocomplete.productTerms(products)
        }
    }
    @Published private(set) var loading = false
    @Published private(set) var isDebouncing = false
    @Published private(set) var isRefinementPreview = false
    @Published private(set) var recentSearchRevision = 0
    var hasRecentSearches: Bool { !(preferences?.recentSearchTerms.isEmpty ?? true) }
    @Published private(set) var errorMessage: String?
    @Published private(set) var notice: String?
    @Published private(set) var hasMore = false
    @Published private(set) var selectedCategory: ProductSearchCategory?
    @Published private(set) var submittedQuery = ""
    @Published private(set) var correction: String?
    @Published private(set) var retryAt: Date?
    @Published private(set) var isStale = false
    @Published private(set) var market: ProductSearchMarket = .unitedKingdom
    @Published private(set) var store: ProductSearchStore?
    @Published private(set) var ratingContextID = UUID()
    @Published private(set) var sortOrder: NativeProductSearchSort = .relevance
    @Published private(set) var supportContext: ProductSupportContext?
    @Published private(set) var supportCoverage: ProductSupportCoverage?
    @Published private(set) var supportTags: [String: [ProductSupportTag]] = [:]

    @Published private(set) var scope: NativeFoodSearchScope = .all
    @Published private(set) var savedOnly = false
    @Published var minimumScore = 0
    @Published var mealFilter = "all"
    @Published var supportFilter = "all"

    var includesRemoteProducts: Bool { scope != .recipe && !savedOnly }
    var hasFoodFilters: Bool { minimumScore > 0 || supportFilter != "all" }
    var needsResolvedRatings: Bool { sortOrder.usesRating || minimumScore > 0 }

    var isBrowsing: Bool { target == nil }
    var isBarcodeResult: Bool {
        if case .barcode = target { return true }
        return false
    }
    var retrySeconds: Int { retryAt.map { max(0, Int(ceil($0.timeIntervalSince(now())))) } ?? 0 }
    var suggestions: [String] {
        ProductSearchAutocomplete.suggestions(for: query, recent: preferences?.recentSearchTerms ?? [], products: productSuggestionTerms)
    }

    private enum Target {
        case category(ProductSearchCategory)
        case text(String, alternate: String?)
        case barcode(String)
        case support
        case filtered
    }

    private let search: DiagnosticSearch
    private let lookup: Lookup
    private let cachedSearch: CachedSearch?
    private let debounce: Debounce
    private var typingTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var typingGeneration = 0
    private var liveQuery = false
    private var rememberSubmittedQuery = true
    private let now: () -> Date
    private let diagnostics: AnalysisDiagnostics?
    private let preferences: ProductSearchPreferences?
    private let catalogueEnabled: Bool
    private var usingCatalogue: Bool?
    private var target: Target?
    private var request: Task<Void, Never>?
    private var generation = 0
    private var pendingSubmission: String?
    private var loadedPage = 0
    private var firstPageDeliveredAt: Date?
    private var pageProducts: [Int: [BarcodeProduct]] = [:]
    private var pendingPage: Int?
    private var diagnosticID: String?
    private var startedAt = Date.distantPast
    private struct OrderedCache {
        let sort: NativeProductSearchSort
        let scores: [Int?]
        let products: [BarcodeProduct]
    }
    private var orderedCache: OrderedCache?
    private var productSuggestionTerms: [ProductSearchAutocomplete.Term] = []

    convenience init(service: OpenFoodFactsService = .catalogueConnected) {
        self.init(service: service, preferences: .shared)
    }

    convenience init(service: OpenFoodFactsService, preferences: ProductSearchPreferences?) {
        self.init(searchWithDiagnostics: { query, requestID in
            try await service.search(query: query, diagnosticRequestID: requestID)
        }, lookup: { try await service.lookup(barcode: $0) }, diagnostics: service.searchDiagnostics,
                  preferences: preferences, catalogueEnabled: service.catalogueSearch != nil,
                  cachedSearch: { await service.cachedSearchPage(query: $0) })
    }

    convenience init(search: @escaping Search, lookup: @escaping Lookup, now: @escaping () -> Date = Date.init,
                     diagnostics: AnalysisDiagnostics? = nil, preferences: ProductSearchPreferences? = nil,
                     cachedSearch: CachedSearch? = nil,
                     debounce: @escaping Debounce = { try await Task.sleep(for: .milliseconds(275)) }) {
        self.init(searchWithDiagnostics: { query, _ in try await search(query) }, lookup: lookup,
                  now: now, diagnostics: diagnostics, preferences: preferences, cachedSearch: cachedSearch, debounce: debounce)
    }

    private init(searchWithDiagnostics: @escaping DiagnosticSearch, lookup: @escaping Lookup,
                 now: @escaping () -> Date = Date.init, diagnostics: AnalysisDiagnostics? = nil,
                 preferences: ProductSearchPreferences? = nil, catalogueEnabled: Bool = false,
                 cachedSearch: CachedSearch? = nil,
                 debounce: @escaping Debounce = { try await Task.sleep(for: .milliseconds(275)) }) {
        self.search = searchWithDiagnostics
        self.lookup = lookup
        self.cachedSearch = cachedSearch
        self.debounce = debounce
        self.now = now
        self.diagnostics = diagnostics
        self.preferences = preferences
        self.catalogueEnabled = catalogueEnabled
        if let preferences { market = preferences.market; store = preferences.store; selectedPlace = SearchPlace.all.first { $0.id == preferences.placeID } }
    }

    deinit { request?.cancel(); typingTask?.cancel(); previewTask?.cancel() }

    /// Typing changes the literal query only. Place/dietary shortcuts and recent
    /// searches are committed by Return or a suggestion tap, never by a prefix.
    func updateLiveQuery(_ text: String) {
        guard text != query else { return }
        cancelTyping()
        query = text
        generation += 1
        request?.cancel(); request = nil; loading = false
        errorMessage = nil; notice = nil
        let clean = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard (2...80).contains(clean.count),
              !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              clean.unicodeScalars.contains(where: CharacterSet.letters.contains) else {
            reset(); query = text; submittedQuery = ""; selectedCategory = nil; target = nil
            return
        }
        // Existing rows already passed this exact market/place/dietary scope.
        // Keep only literal name/brand matches as a labelled, incomplete preview;
        // category/ingredient matches and a new scope must await their own page.
        let previousText = SearchDiscoveryParser.normalized(submittedQuery)
        let canRefine = includesRemoteProducts && liveQuery && !previousText.isEmpty
            && SearchDiscoveryParser.normalized(clean).hasPrefix(previousText)
        let matching = canRefine ? products.filter { Self.matchesPreview($0, text: clean) } : []
        reset(retainingResults: !matching.isEmpty)
        if !matching.isEmpty {
            products = matching; totalResults = nil
            isRefinementPreview = true
            notice = "Matches from your last results. Checking the full catalogue…"
        }
        query = text; submittedQuery = clean; selectedCategory = nil
        liveQuery = true; rememberSubmittedQuery = false
        pendingSubmission = clean
        target = .text(clean, alternate: nil)
        guard includesRemoteProducts else { return }
        startedAt = now(); diagnosticID = UUID().uuidString
        startCachePreview(page: 1, owner: generation)
        isDebouncing = true
        let owner = typingGeneration
        typingTask = Task { [weak self] in
            guard let self else { return }
            do { try await debounce(); try Task.checkCancellation() } catch { return }
            guard owner == typingGeneration else { return }
            typingTask = nil; isDebouncing = false
            run(page: 1)
        }
    }

    func clearLiveQuery() { showCategories() }

    func clearRecentSearches() {
        preferences?.clearRecentSearches()
        recentSearchRevision += 1
    }

    private func cancelTyping() {
        typingGeneration += 1
        typingTask?.cancel(); typingTask = nil; isDebouncing = false
        previewTask?.cancel(); previewTask = nil
    }

    private static func matchesPreview(_ product: BarcodeProduct, text: String) -> Bool {
        let tokens = SearchDiscoveryParser.normalized(text).split(separator: " ")
        guard let last = tokens.last else { return false }
        let words = SearchDiscoveryParser.normalized(product.name + " " + (product.brand ?? "")).split(separator: " ")
        return tokens.dropLast().allSatisfy { words.contains($0) } && words.contains { $0.hasPrefix(last) }
    }

    /// Cache reads and the request run independently: a slow disk read must not
    /// delay HTTP, nor overwrite a newer delivered response after it completes.
    private func startCachePreview(page: Int, owner: Int) {
        previewTask?.cancel(); previewTask = nil
        guard page == 1, let cachedSearch, let target,
              let query = try? query(for: target, page: page, market: market, store: store) else { return }
        previewTask = Task { [weak self] in
            let cached = await cachedSearch(query)
            guard let self, !Task.isCancelled, owner == generation, let cached else { return }
            accept(cached, page: page, refreshing: true)
            record(stage: "search_delivery", outcome: "cached", metadata: ["sourceRoute": "phone_cache"])
        }
    }

    func submit() { submit(query) }

    func submit(_ text: String, filters: [String: Any]? = nil) {
        let clean = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if filters == nil, commitCurrentLiveQuery(clean) { return }
        cancelTyping()
        if let filters {
            if let raw = filters["kind"] as? String, let choice = NativeFoodSearchScope(rawValue: raw) { scope = choice }
            if let value = filters["minimumScore"] as? Int, [0,25,50,75,100].contains(value) { minimumScore = value }
            if let value = filters["meal"] as? String, Self.mealOptions.contains(where: { $0.id == value }) { mealFilter = value }
            if let value = filters["support"] as? String, Self.supportOptions.contains(where: { $0.id == value }) { supportFilter = value }
        }
        if !includesRemoteProducts && loading { cancel(); errorMessage = nil; notice = nil }
        guard !clean.isEmpty else { showCategories(); return }
        guard !loading || pendingSubmission != clean || liveQuery else { return }
        let intent = SearchDiscoveryParser.parse(clean)
        if intent.opensSaved {
            // Navigation preserves the submitted search and any request already in progress.
            query = submittedQuery
            savedIntentRevision += 1
            return
        }
        let retaining = !liveQuery && clean == pendingSubmission && !products.isEmpty
        reset(retainingResults: retaining)
        pendingSubmission = clean
        if let place = intent.place { selectedPlace = place; store = place.store; market = .unitedKingdom; preferences?.update(market: market, store: store, placeID: selectedPlace?.id) }
        dietary.formUnion(intent.dietary); nutrition.formUnion(intent.nutrition)
        query = intent.text
        submittedQuery = intent.text
        selectedCategory = intent.category
        if clean.range(of: #"^[0-9]{8,14}$"#, options: .regularExpression) != nil {
            query = clean; submittedQuery = clean; target = .barcode(clean)
        } else if !intent.text.isEmpty {
            let prepared = ProductSearchSpelling.prepare(intent.text)
            correction = prepared.message
            target = .text(prepared.text, alternate: prepared.alternate)
        } else if let category = intent.category { target = .category(category) }
        else { target = .filtered }
        run(page: 1)
    }

    /// Search commits an already running, unchanged literal query. Keep its
    /// prefix mode for pagination; never relabel those rows as an exact search.
    /// Semantic shortcuts and corrections still take the explicit-submit path.
    private func commitCurrentLiveQuery(_ clean: String) -> Bool {
        let date = now()
        let recentlyDelivered = firstPageDeliveredAt.map { (0.0..<300.0).contains(date.timeIntervalSince($0)) } ?? false
        guard liveQuery, !isDebouncing, includesRemoteProducts, !clean.isEmpty,
              clean == pendingSubmission, clean == submittedQuery,
              selectedCategory == nil, errorMessage == nil, retrySeconds == 0,
              case .text(let text, let alternate) = target, text == clean, alternate == nil,
              (loading && request != nil) || (loadedPage > 0 && !products.isEmpty && !isStale && !isRefinementPreview
                && recentlyDelivered && products.allSatisfy { $0.catalogueSourceExpiresAt.map { $0 > date } ?? true }) else { return false }
        let intent = SearchDiscoveryParser.parse(clean)
        let prepared = ProductSearchSpelling.prepare(intent.text)
        guard !intent.opensSaved, intent.place == nil, intent.category == nil,
              intent.dietary.isEmpty, intent.nutrition.isEmpty,
              intent.text == SearchDiscoveryParser.normalized(clean),
              prepared.text == intent.text, prepared.alternate == nil else { return false }
        let wasUncommitted = !rememberSubmittedQuery
        cancelTyping()
        rememberSubmittedQuery = true
        if wasUncommitted, loadedPage > 0, !isStale, !isRefinementPreview, !products.isEmpty {
            preferences?.rememberSearch(submittedQuery, at: now())
            recentSearchRevision += 1
        }
        return true
    }

    func clearCategory() {
        guard selectedCategory != nil else { return }
        selectedCategory = nil
        target = submittedQuery.isEmpty ? .filtered : .text(submittedQuery, alternate: nil)
        reloadForScopeChange()
    }
    func clearTextQuery() {
        query = ""; submittedQuery = ""
        target = selectedCategory.map(Target.category) ?? .filtered
        reloadForScopeChange()
    }

    func setPlace(_ place: SearchPlace?) {
        guard selectedPlace != place else { return }
        selectedPlace = place; store = place?.store
        if place != nil { market = .unitedKingdom }
        preferences?.update(market: market, store: store, placeID: selectedPlace?.id)
        if place.map({ !$0.isSupermarket }) == true {
            selectedCategory = nil
            if target == nil { target = .filtered }
            if case .category = target { target = submittedQuery.isEmpty ? .filtered : .text(submittedQuery, alternate: nil) }
        }
        reloadForScopeChange()
    }
    func setDietary(_ value: Set<SearchDietaryRequirement>) { setFilters(dietary: value, nutrition: nutrition, mode: nutritionMode) }
    func setNutrition(_ value: Set<SearchNutritionChoice>) { setFilters(dietary: dietary, nutrition: value, mode: nutritionMode) }
    func setNutritionMode(_ value: SearchNutritionMode) { setFilters(dietary: dietary, nutrition: nutrition, mode: value) }
    func setFilters(dietary: Set<SearchDietaryRequirement>, nutrition: Set<SearchNutritionChoice>, mode: SearchNutritionMode) {
        guard self.dietary != dietary || self.nutrition != nutrition || nutritionMode != mode else { return }
        self.dietary = dietary; self.nutrition = nutrition; nutritionMode = mode
        reloadForScopeChange()
    }
    func browseFilteredProducts() {
        reset(); query = ""; submittedQuery = ""; selectedCategory = nil; supportContext = nil; target = .filtered
        run(page: 1)
    }

    func select(_ category: ProductSearchCategory) {
        guard ProductSearchCategory.all.contains(category) else { return }
        guard !loading || selectedCategory != category else { return }
        reset()
        query = ""
        submittedQuery = ""
        selectedCategory = category
        scope = .product
        savedOnly = false
        target = .category(category)
        run(page: 1)
    }

    func showCategories(clearSupportContext: Bool = false) {
        if clearSupportContext { supportContext = nil }
        reset()
        query = ""
        submittedQuery = ""
        selectedCategory = nil
        target = supportContext == nil ? nil : .support
        if target != nil { run(page: 1) }
    }

    func setSupportContext(_ context: ProductSupportContext?) {
        guard supportContext != context else { return }
        supportContext = context
        if target == nil || isBarcodeResult { showCategories(); return }
        if case .support = target, context == nil { showCategories(); return }
        reloadForScopeChange()
    }

    func tags(for product: BarcodeProduct) -> [ProductSupportTag] {
        let tags = supportTags[product.barcode] ?? []
        guard let context = supportContext else { return tags }
        // Lead with tags that explain this particular phase/life stage, before
        // general nutrition tags applying to every context. Preserve catalogue
        // order for equally specific tags; evidence and nutrition scores stay separate.
        return tags.enumerated().filter { $0.element.contexts.contains(context.rawValue) }
            .sorted {
                let left = Set($0.element.contexts).count, right = Set($1.element.contexts).count
                return left == right ? $0.offset < $1.offset : left < right
            }.map(\.element)
    }

    func setScope(_ scope: NativeFoodSearchScope) {
        guard self.scope != scope else { return }
        self.scope = scope
        updateProductDiscovery()
    }

    func setSavedOnly(_ saved: Bool) {
        guard savedOnly != saved else { return }
        savedOnly = saved
        updateProductDiscovery()
    }

    func clearFoodFilters() {
        minimumScore = 0; mealFilter = "all"; supportFilter = "all"
    }

    struct FilterOption: Identifiable { let id: String; let title: String }
    static let mealOptions: [FilterOption] = [FilterOption(id: "all", title: "All foods")]
    static let supportOptions: [FilterOption] = [("all","Any stage"),("period","Period"),("follicular","Follicular"),("ovulation","Ovulation"),("luteal","Luteal"),("perimenopause","Perimenopause"),("menopause","Menopause")].map { FilterOption(id:$0.0,title:$0.1) }

    private func updateProductDiscovery() {
        if !includesRemoteProducts {
            cancel()
            errorMessage = nil; notice = nil
        } else if target != nil && loadedPage == 0 && !loading {
            run(page: 1)
        }
    }

    /// Scope only affects catalogue discovery; an exact barcode still opens
    /// that product even when its country/retailer fields are incomplete.
    func setMarket(_ market: ProductSearchMarket) {
        guard self.market != market else { return }
        self.market = market
        if market == .allCountries { store = nil; selectedPlace = nil }
        preferences?.update(market: market, store: store, placeID: selectedPlace?.id)
        reloadForScopeChange()
    }

    func setStore(_ store: ProductSearchStore?) {
        guard market == .unitedKingdom, self.store != store else { return }
        self.store = store
        selectedPlace = SearchPlace.all.first { $0.store == store && $0.store != nil }
        preferences?.update(market: market, store: store, placeID: selectedPlace?.id)
        reloadForScopeChange()
    }

    func setSortOrder(_ order: NativeProductSearchSort) {
        guard sortOrder != order else { return }
        sortOrder = order
        if catalogueEnabled || supportContext != nil { reloadForScopeChange() }
    }

    /// Sort only the loaded result set. Score each product once per projection,
    /// never from the comparator; async rating revisions rebuild this order.
    /// Unknown ratings are last in either direction, with stable provider ties.
    func orderedProducts(rating: (BarcodeProduct) -> NativeProductRating) -> [BarcodeProduct] {
        guard sortOrder != .relevance else { return products }
        // Refresh score evidence on every projection, but only repeat the
        // potentially expensive locale-aware sort when its actual inputs change.
        // Typing, focus, sheet and layout updates do not change these inputs.
        let scores = sortOrder.usesRating ? products.map { rating($0).value } : []
        if let cached = orderedCache, cached.sort == sortOrder, cached.scores == scores { return cached.products }
        let ranked = products.enumerated().map { index, product in
            (index: index, product: product, score: sortOrder.usesRating ? scores[index] : nil)
        }
        let ordered = ranked.sorted { lhs, rhs in
            if sortOrder.usesRating {
                switch (lhs.score, rhs.score) {
                case (.some(let left), .some(let right)) where left != right:
                    return sortOrder == .ratingHighest ? left > right : left < right
                case (.some, .none): return true
                case (.none, .some): return false
                default: return lhs.index < rhs.index
                }
            }
            let comparison = lhs.product.name.localizedStandardCompare(rhs.product.name)
            if comparison == .orderedSame { return lhs.index < rhs.index }
            return sortOrder == .nameAscending ? comparison == .orderedAscending : comparison == .orderedDescending
        }.map(\.product)
        orderedCache = OrderedCache(sort: sortOrder, scores: scores, products: ordered)
        return ordered
    }

    private func reloadForScopeChange() {
        // Editing filters on the landing page stays local. Preserve the last
        // submitted target, not any unrelated text currently being typed.
        guard target != nil, !isBarcodeResult else { return }
        let previousCorrection = correction, wasLive = liveQuery
        reset()
        liveQuery = wasLive; rememberSubmittedQuery = !wasLive
        correction = previousCorrection
        run(page: 1)
    }

    func loadMore() {
        guard !loading, !isDebouncing, !isRefinementPreview, !isStale, hasMore, retrySeconds == 0 else { return }
        run(page: pendingPage ?? loadedPage + 1)
    }

    func retry() {
        guard !loading, target != nil, retrySeconds == 0 else { return }
        run(page: pendingPage ?? max(1, loadedPage))
    }

    /// Leaving the tab invalidates its request; a later Retry resumes its page.
    func cancel() {
        let wasLoading = loading || isDebouncing
        cancelTyping()
        if wasLoading { record(stage: "search_response", outcome: "cancelled") }
        generation += 1
        request?.cancel()
        request = nil
        loading = false
        if wasLoading { errorMessage = "Search paused. Try again to continue." }
        if isRefinementPreview { notice = "Matches from your last results. Search paused." }
    }

    private func reset(retainingResults: Bool = false) {
        cancelTyping()
        liveQuery = false; rememberSubmittedQuery = true; isRefinementPreview = false
        if loading { record(stage: "search_response", outcome: "cancelled") }
        generation += 1
        request?.cancel()
        request = nil
        loading = false
        if !retainingResults {
            products = []
            totalResults = nil; discoveryCoverage = nil; dietaryConflictCount = nil; dietaryUnknownCount = nil
            placeCoverage = nil; placeEvidence = [:]
            notice = nil; isStale = false
            supportCoverage = nil; supportTags = [:]
            usingCatalogue = nil
        }
        pendingSubmission = nil; scrollAnchor = nil
        errorMessage = nil
        correction = nil
        hasMore = false
        loadedPage = 0
        firstPageDeliveredAt = nil
        pageProducts = [:]
        pendingPage = nil
        diagnosticID = nil
        ratingContextID = UUID()
        if retrySeconds == 0 { retryAt = nil }
    }

    private func run(page: Int) {
        guard includesRemoteProducts, let target, (1...ProductSearchQuery.maximumPage).contains(page) else { return }
        let market = market
        let store = store
        generation += 1
        let owner = generation
        request?.cancel()
        pendingPage = page
        loading = true
        errorMessage = nil
        if isRefinementPreview { notice = "Matches from your last results. Checking the full catalogue…" }
        let requestID = UUID().uuidString
        diagnosticID = requestID
        startedAt = now()
        record(stage: "search_request", outcome: "started", metadata: ["aliasMatched": correction != nil])
        startCachePreview(page: page, owner: owner)
        request = Task { [weak self] in
            guard let self else { return }
            do {
                try Task.checkCancellation()
                switch target {
                case .filtered:
                    let result = try await search(scopedQuery(ProductSearchQuery(discoveryText: "", page: page, market: market, store: store)), requestID)
                    try Task.checkCancellation(); guard owner == generation else { return }
                    accept(result, page: page)
                case .support:
                    guard let context = supportContext else { throw ProductSearchError.invalidQuery }
                    let result = try await search(scopedQuery(ProductSearchQuery(supportContext: context, page: page, market: market, store: store)), requestID)
                    try Task.checkCancellation()
                    guard owner == generation else { return }
                    accept(result, page: page)
                case .barcode(let barcode):
                    let product = try await lookup(barcode)
                    try Task.checkCancellation()
                    guard owner == generation else { return }
                    products = [product]
                    hasMore = false
                    notice = nil
                    isStale = false
                    record(stage: "search_response", outcome: "matched", metadata: ["resultCount": 1])
                    finish(page: page)
                case .category(let category):
                    let result = try await search(scopedQuery(ProductSearchQuery(category: category, page: page, market: market, store: store)), requestID)
                    try Task.checkCancellation()
                    guard owner == generation else { return }
                    accept(result, page: page)
                case .text(let text, let alternate):
                    var result = try await search(scopedQuery(ProductSearchQuery(literalText: text, page: page, market: market, store: store)), requestID)
                    try Task.checkCancellation()
                    guard owner == generation else { return }
                    // Only a successful empty first page can try one equivalent
                    // spelling. Failures/limits never trigger another request.
                    if page == 1, result.products.isEmpty, !result.hasMore, !result.stale,
                       let alternate, alternate.caseInsensitiveCompare(text) != .orderedSame {
                        record(stage: "search_request", outcome: "started", metadata: ["alternativeQuery": true])
                        result = try await search(scopedQuery(ProductSearchQuery(literalText: alternate, page: page, market: market, store: store)), requestID)
                        try Task.checkCancellation()
                        guard owner == generation else { return }
                        self.target = .text(alternate, alternate: nil)
                    }
                    accept(result, page: page)
                }
            } catch {
                guard owner == generation else { return }
                previewTask?.cancel(); previewTask = nil
                loading = false
                request = nil
                if isRefinementPreview { notice = "Matches from your last results. The full catalogue could not be checked." }
                if error is CancellationError || (error as? URLError)?.code == .cancelled {
                    errorMessage = "Search paused. Try again to continue."
                    record(stage: "search_response", outcome: "cancelled")
                } else if let failure = error as? ProductSearchError {
                    errorMessage = nativeMessage(for: failure)
                    setRetry(seconds: failure.retryAfterSeconds)
                    record(stage: "search_response", outcome: failure.code,
                           metadata: ["retryAfterSeconds": failure.retryAfterSeconds])
                } else if let failure = error as? BarcodeLookupError {
                    errorMessage = nativeMessage(for: failure)
                    if failure == .rateLimited { setRetry(seconds: 60) }
                    record(stage: "search_response", outcome: failure.code)
                } else {
                    errorMessage = nativeMessage(for: ProductSearchError.unavailable)
                    record(stage: "search_response", outcome: "unavailable")
                }
                record(stage: "search_ui", outcome: "rendered", metadata: ["eventType": "error"])
            }
        }
    }

    private func accept(_ result: ProductSearchPage, page: Int, refreshing: Bool = false) {
        isRefinementPreview = false
        if page == 1 { pageProducts = [:]; usingCatalogue = result.catalogueCoverage != nil }
        if page == 1 { supportTags = [:] }
        totalResults = result.total
        placeCoverage = result.placeCoverage
        if page == 1 { placeEvidence = [:] }
        for (barcode, evidence) in result.placeEvidence { placeEvidence[barcode] = evidence }
        discoveryCoverage = result.discoveryCoverage
        dietaryConflictCount = result.dietaryConflictCount
        dietaryUnknownCount = result.dietaryUnknownCount
        supportCoverage = result.supportCoverage
        for product in result.products { supportTags[product.barcode] = result.supportTags[product.barcode] ?? [] }
        if !refreshing, rememberSubmittedQuery, page == 1, !result.products.isEmpty, !submittedQuery.isEmpty {
            preferences?.rememberSearch(submittedQuery, at: now())
            recentSearchRevision += 1
        }
        pageProducts[page] = result.products
        var seen = Set<String>()
        products = pageProducts.keys.sorted().flatMap { pageProducts[$0] ?? [] }
            .filter { seen.insert($0.barcode).inserted }
        hasMore = result.hasMore && page < ProductSearchQuery.maximumPage
        isStale = result.stale
        notice = result.stale
            ? "Showing previously loaded products. Product details may have changed."
            : result.catalogueCoverage == "partial" ? "From Nudge’s growing product catalogue. Coverage is not yet complete."
            : result.catalogueCoverage != nil ? "From Nudge’s product catalogue."
            : result.cached ? "Showing recently loaded products from Open Food Facts." : nil
        setRetry(seconds: result.retryAfterSeconds)
        record(stage: "search_response", outcome: result.stale ? "stale" : result.cached ? "cached" : result.products.isEmpty ? "no_matches" : "matched",
               metadata: ["resultCount": result.products.count, "cached": result.cached, "stale": result.stale,
                          "retryAfterSeconds": result.retryAfterSeconds])
        if !refreshing { finish(page: page) }
    }

    private func query(for target: Target, page: Int, market: ProductSearchMarket, store: ProductSearchStore?) throws -> ProductSearchQuery? {
        switch target {
        case .barcode: return nil
        case .filtered: return scopedQuery(try ProductSearchQuery(discoveryText: "", page: page, market: market, store: store))
        case .support:
            guard let supportContext else { return nil }
            return scopedQuery(try ProductSearchQuery(supportContext: supportContext, page: page, market: market, store: store))
        case .category(let category): return scopedQuery(try ProductSearchQuery(category: category, page: page, market: market, store: store))
        case .text(let text, _): return scopedQuery(try ProductSearchQuery(literalText: text, page: page, market: market, store: store))
        }
    }

    private func scopedQuery(_ original: ProductSearchQuery) -> ProductSearchQuery {
        var query = original
        query.sortOrder = sortOrder
        query.prefixMatch = liveQuery && !query.text.isEmpty
        query.supportContext = supportContext
        query.category = selectedCategory
        query.dietary = dietary; query.nutrition = nutrition; query.nutritionMode = nutritionMode
        query.placeID = selectedPlace?.id
        // Keep pagination on the source that supplied its first page. Mixing
        // two differently ordered catalogues would skip or duplicate results.
        query.cataloguePolicy = catalogueEnabled || selectedPlace != nil || !dietary.isEmpty || !nutrition.isEmpty || selectedCategory != nil || supportContext != nil ? .only : usingCatalogue.map { $0 ? .only : .skip } ?? .prefer
        return query
    }

    private func finish(page: Int) {
        previewTask?.cancel(); previewTask = nil
        record(stage: "search_delivery", outcome: "delivered")
        record(stage: "search_ui", outcome: "rendered", metadata: ["eventType": "result"])
        loadedPage = page
        if page == 1 { firstPageDeliveredAt = now() }
        pendingPage = nil
        loading = false
        errorMessage = nil
        request = nil
    }

    private func setRetry(seconds: Int) {
        if seconds > 0 {
            let until = now().addingTimeInterval(Double(min(seconds, 3600)))
            retryAt = max(retryAt ?? .distantPast, until)
        } else if retrySeconds == 0 { retryAt = nil }
    }

    private func record(stage: String, outcome: String, metadata: [String: Any] = [:]) {
        var safe: [String: Any] = ["route": "product_search", "screen": "search", "searchScope": "product",
            "page": pendingPage ?? max(1, loadedPage), "productCount": products.count, "visibleCount": products.count,
            "elapsedMs": max(0, min(600_000, Int(now().timeIntervalSince(startedAt) * 1000)))]
        if let diagnosticID { safe["requestHash"] = AnalysisDiagnostics.fingerprint(diagnosticID) }
        safe.merge(metadata) { _, new in new }
        diagnostics?.record(stage: stage, outcome: outcome, metadata: safe, now: now())
    }

    private func nativeMessage(for error: ProductSearchError) -> String {
        if supportContext != nil, error != .offline {
            return "Nudge’s tagged catalogue could not be loaded. Try again to keep this phase or life-stage filter."
        }
        switch error {
        case .invalidQuery: return "Enter a product or brand name using 2–80 characters, or choose a category."
        case .rateLimited, .providerRateLimited: return "Nudge’s product catalogue is limiting searches. Please wait before trying again."
        case .providerBusy: return "Nudge’s product catalogue is busy. Please wait before trying again."
        case .offline: return "You appear to be offline. Check your connection and try again."
        case .timeout: return "Nudge’s product catalogue took too long to respond. Try again."
        case .invalidResponse: return "Nudge could not read the product catalogue result. Try again."
        case .providerUnavailable, .unavailable: return "Products are unavailable right now. Please try again."
        }
    }

    private func nativeMessage(for error: BarcodeLookupError) -> String {
        switch error {
        case .notFound: return "Nudge’s catalogue does not have this barcode yet. Try a product or brand name."
        case .incompleteProduct: return "This barcode has no product name to confirm its identity. Try a product or brand name."
        case .invalidBarcode: return "Enter a grocery barcode with 8–14 digits."
        case .offline: return nativeMessage(for: ProductSearchError.offline)
        case .timeout: return nativeMessage(for: ProductSearchError.timeout)
        case .rateLimited: return nativeMessage(for: ProductSearchError.providerRateLimited(60))
        case .retryLater, .productReadDeferred: return error.message
        case .server: return nativeMessage(for: ProductSearchError.unavailable)
        case .invalidResponse: return nativeMessage(for: ProductSearchError.invalidResponse)
        }
    }
}

/// A small, preindexed vocabulary of queries, not product recommendations or
/// claims about stock, nutrition or scores. The 3 MB catalogue seed includes
/// source/score payloads; decoding it on a keystroke would delay the keyboard.
/// Result names and brands are indexed only when a bounded result page changes.
enum ProductSearchAutocomplete {
    struct Term {
        let text: String
        let key: String
        let words: [String]
        let identity: String
    }
    private static let phrases = [
        "Thai green curry", "Thai red curry", "Blueberry smoothie", "Berry smoothie", "Banana smoothie",
        "Chicken curry", "Vegetable curry", "Chickpea curry", "Lentil curry", "Green curry paste",
        "Greek yoghurt", "Natural yoghurt", "Plain yoghurt", "Soya yoghurt", "Coconut yoghurt",
        "Porridge oats", "Overnight oats", "Oat milk", "Soya milk", "Almond milk", "Coconut milk",
        "Whole milk", "Semi skimmed milk", "Kefir", "Pea protein", "Protein powder",
        "Peanut butter", "Almond butter", "Cashew butter", "Mixed nuts", "Mixed seeds", "Chia seeds", "Flaxseed",
        "Brown rice", "Basmati rice", "White rice", "Wholemeal bread", "Sourdough bread", "Rye bread",
        "Wholewheat pasta", "Gluten free bread", "Gluten free pasta", "Tomato pasta sauce",
        "Chicken breast", "Tinned tuna", "Tinned sardines", "Smoked salmon", "Tofu", "Eggs",
        "Sweet potato", "Red pepper", "Green beans", "Frozen vegetables", "Frozen berries", "Frozen mango",
        "Vegetable soup", "Tomato soup", "Lentil soup", "Hummus", "Salad dressing", "Olive oil",
        "Breakfast cereal", "Granola", "Dark chocolate", "Coffee", "Tea"
    ]
    // Familiar brands present in the bundled public seed. These complete a
    // query only; selecting one still performs the normal scoped search.
    private static let brands = ["Heinz", "Alpro", "Fage", "Yeo Valley", "Arla", "Kellogg's", "Weetabix", "Hovis", "Warburtons", "Barilla", "Oatly", "Biotiful", "Alpen", "Bertolli", "Bonne Maman"]
    private static let common = terms(phrases + ProductSearchSpelling.autocompleteTerms + brands + SearchPlace.all.map(\.title))

    private static func normalized(_ text: String) -> String { SearchDiscoveryParser.normalized(text) }
    private static func terms(_ values: [String]) -> [Term] {
        var seen = Set<String>()
        return values.compactMap { raw in
            let text = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard (1...80).contains(text.count), !raw.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                  text.unicodeScalars.contains(where: CharacterSet.letters.contains) else { return nil }
            let key = normalized(text), identity = normalized(ProductSearchSpelling.prepare(text).text)
            guard !key.isEmpty, seen.insert(identity).inserted else { return nil }
            return Term(text: text, key: key, words: key.split(separator: " ").map(String.init), identity: identity)
        }
    }
    static func productTerms(_ products: [BarcodeProduct]) -> [Term] {
        terms(products.prefix(200).flatMap { product -> [String] in
            let brands = (product.brand ?? "").split(separator: ",").prefix(3).map(String.init)
            return [product.name] + brands
        })
    }
    static func suggestions(for raw: String, recent: [String] = [], products: [Term] = []) -> [String] {
        let input = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard input.count <= 80, !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }) else { return [] }
        let history = terms(Array(recent.prefix(24)))
        guard !input.isEmpty else {
            var seen = Set<String>()
            var result: [String] = []
            for term in history + common where seen.insert(term.identity).inserted {
                result.append(term.text)
                if result.count == 6 { break }
            }
            return result
        }
        let key = normalized(input)
        guard key.unicodeScalars.contains(where: CharacterSet.letters.contains) else { return [] }
        let prepared = ProductSearchSpelling.prepare(input).text
        let corrections = normalized(prepared) == key ? [] : terms([prepared.lowercased()])
        let forms = ProductSearchSpelling.autocompleteForms(input).map { normalized($0).split(separator: " ").map(String.init) }
        func match(_ term: Term) -> Int? {
            var best: Int?
            for words in forms where !words.isEmpty {
                var available = term.words
                var matched = true
                for word in words {
                    guard let index = available.firstIndex(where: { $0.hasPrefix(word) }) else { matched = false; break }
                    available.remove(at: index)
                }
                guard matched else { continue }
                let phrase = words.joined(separator: " ")
                let rank = term.key == phrase ? 0 : term.key.hasPrefix(phrase) ? 1 : 2
                best = min(best ?? rank, rank)
            }
            return best
        }
        var ranked: [(term: Term, source: Int, match: Int, order: Int)] = []
        for (source, group) in [corrections, history, common, products].enumerated() {
            for (order, term) in group.enumerated() where term.key != key {
                if let rank = match(term) { ranked.append((term, source, rank, order)) }
            }
        }
        ranked.sort {
            if $0.source != $1.source { return $0.source < $1.source }
            if $0.match != $1.match { return $0.match < $1.match }
            return $0.order < $1.order
        }
        var seen = Set<String>()
        var result: [String] = []
        for item in ranked where seen.insert(item.term.identity).inserted {
            result.append(item.term.text)
            if result.count == 6 { break }
        }
        return result
    }
}

/// Whole-word equivalents and familiar grocery plurals. Quoted product names
/// are preserved. Suggestions never perform a catalogue request.
enum ProductSearchSpelling {
    private static let aliases = [
        "yogurt": "yoghurt", "yogurts": "yoghurt", "yoghurts": "yoghurt",
        "garbanzo": "chickpeas", "garbanzos": "chickpeas", "eggplant": "aubergine", "eggplants": "aubergines",
        "zucchini": "courgette", "zucchinis": "courgettes", "cilantro": "coriander", "soy": "soya",
        "chili": "chilli", "chilies": "chillies", "dhal": "dal", "dahl": "dal", "wholewheat": "wholemeal",
        "houmous": "hummus", "arugula": "rocket"
    ]
    private static let alternatives = [
        "yoghurt": "yogurt", "chickpeas": "garbanzo", "aubergine": "eggplant", "aubergines": "eggplants",
        "courgette": "zucchini", "courgettes": "zucchinis", "coriander": "cilantro", "soya": "soy",
        "chilli": "chili", "chillies": "chilies", "dal": "dhal", "wholemeal": "wholewheat",
        "hummus": "houmous", "rocket": "arugula"
    ]
    private static let foods = "yoghurt chickpeas aubergine courgette coriander cauliflower broccoli spinach lentils chicken salmon sardines mackerel turkey potatoes tomatoes carrots peppers cucumber cabbage lettuce asparagus avocado beetroot mushrooms quinoa porridge cereal granola almonds walnuts hazelnuts peanuts pistachios cashews butter cheese cheddar mozzarella parmesan ricotta milk soya tofu tempeh hummus tahini coconut banana apples oranges berries blueberries strawberries raspberries blackberries peaches apricots pineapple watermelon chocolate couscous spaghetti macaroni pasta noodles wholemeal flour bread sourdough sesame pumpkin sunflower beans raisins".split(separator: " ").map(String.init)
    private static let beanKinds = ["baked", "black", "kidney", "butter", "cannellini", "haricot", "pinto", "green", "broad", "soya"]
    private static let beanPlurals = Dictionary(uniqueKeysWithValues: beanKinds.map { ("\($0) bean", "\($0) beans") })
    private static let beanSingulars = Dictionary(uniqueKeysWithValues: beanKinds.map { ("\($0) beans", "\($0) bean") })
    private static let relatedFoods = beanKinds.map { "\($0.capitalized) beans" }
    static var autocompleteTerms: [String] {
        ProductSearchCategory.all.map(\.title) + relatedFoods + foods.map { $0.prefix(1).uppercased() + $0.dropFirst() }
    }
    static func autocompleteForms(_ input: String) -> [String] {
        let canonical = prepare(input).text.lowercased()
        var forms = [input.lowercased(), canonical]
        let words = canonical.split(whereSeparator: \.isWhitespace).map(String.init)
        if let last = words.last, last.count >= 2 {
            for alias in aliases.keys.sorted() where alias.hasPrefix(last) {
                forms.append((Array(words.dropLast()) + [aliases[alias]!]).joined(separator: " "))
            }
        }
        return Array(Set(forms)).sorted()
    }

    static func prepare(_ text: String) -> (text: String, alternate: String?, message: String?) {
        // The source does not stem every food name: “baked bean” can return an
        // empty page when “baked beans” matches. Limit canonicalisation to known
        // food phrases, so names such as “Bean Company” stay literal.
        var prepared = mapWords(mapWords(text, using: aliases), using: beanPlurals)
        if prepared.caseInsensitiveCompare("bean") == .orderedSame { prepared = "beans" }
        var alternate = mapWords(mapWords(prepared, using: alternatives), using: beanSingulars)
        if alternate.caseInsensitiveCompare("beans") == .orderedSame { alternate = "bean" }
        let changed = prepared != text
        return (prepared, alternate.caseInsensitiveCompare(prepared) == .orderedSame ? nil : alternate,
                changed ? "Equivalent food names are included: “\(text)” and “\(prepared)”." : nil)
    }

    static func suggestions(for raw: String) -> [String] {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2, text.count <= 80,
              text.range(of: #"^[0-9]+$"#, options: .regularExpression) == nil else { return [] }
        let normalized = prepare(text).text.lowercased()
        var seen = Set<String>()
        let choices = (normalized != text.lowercased() ? [normalized] : [])
            + ProductSearchCategory.all.map(\.title) + relatedFoods + foods
        return Array(choices.filter {
            let candidate = $0
            let matches = candidate.localizedCaseInsensitiveContains(normalized)
                || aliases.contains { alias, canonical in
                    alias.contains(text.lowercased()) && candidate.localizedCaseInsensitiveContains(canonical)
                }
            return matches && candidate.caseInsensitiveCompare(text) != .orderedSame
                && seen.insert($0.lowercased()).inserted
        }.prefix(5))
    }

    private static func mapWords(_ text: String, using replacements: [String: String]) -> String {
        let kinds = beanKinds.joined(separator: "|")
        let pattern = #""[^"]*"|“[^”]*”|‘[^’]*’|(?:^|\s)'[^']*'(?=\s|$)|\b(?:garbanzo|chickpeas)\s+beans?\b|\b(?:"# + kinds + #")\s+beans?\b|\b[A-Za-z]+\b"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return text }
        var result = text
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: result) else { continue }
            let word = String(result[range])
            if replacements["garbanzo"] == "chickpeas",
               word.range(of: #"^(garbanzo|chickpeas)\s+beans?$"#, options: [.regularExpression, .caseInsensitive]) != nil {
                result.replaceSubrange(range, with: "chickpeas")
            } else if let replacement = replacements[word.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")] {
                result.replaceSubrange(range, with: replacement)
            }
        }
        return result
    }
}
