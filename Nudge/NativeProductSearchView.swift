import Combine
import SwiftUI
import UIKit

/// Product discovery uses the app's existing visual roles and product-detail route.
/// Ratings are supplied by the shared Nudge calculator, never derived from an OFF letter here.
@MainActor
struct NativeProductSearchView: View {
    @ObservedObject var model: NativeProductSearchModel
    let rating: (BarcodeProduct) -> NativeProductRating
    let onOpen: (BarcodeProduct) -> Void
    let onNavigate: (String) -> Void
    let onSaved: () -> Void
    var ratingLoader: NativeSearchRatingLoader? = nil
    var savedCount = 0
    var isSaved: (BarcodeProduct) -> Bool = { _ in false }
    var onToggleSave: (BarcodeProduct) -> Void = { _ in }
    var recipeSearch: ((String, Bool) -> [String: Any])? = nil
    var savedRecipeIDs = Set<String>()
    var onOpenRecipe: (String) -> Void = { _ in }
    var onToggleRecipeSaved: (String) -> Void = { _ in }

    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var searchFocused: Bool
    @State private var ratingRevision = 0
    @State private var guide: NativeNutritionGuide?
    @State private var placesPresented = false
    @State private var filtersPresented = false
    @State private var allAislesExpanded = false
    @State private var restoringPosition = true
    @State private var availableWidth: CGFloat = 0
    @State private var availableHeight: CGFloat = 0
    @State private var detailsExpanded = false
    @State private var savedRecipesOnly = false
    private var showsRecipes: Bool { recipeSearch != nil && model.scope == .recipe }

    private var hasSearchText: Bool { !model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var waitingForResults: Bool { model.loading || model.isDebouncing }
    private var showsResults: Bool { !model.isBrowsing || model.isDebouncing }
    private var matchingCategories: [ProductSearchCategory] {
        guard !showsRecipes, model.selectedCategory == nil else { return [] }
        return ProductSearchCategorySuggestions.suggestions(for: model.query)
    }

    private var selectionKey: String {
        "\(model.selectedCategory?.id ?? ""):\(model.submittedQuery):\(model.market.id):\(model.selectedPlace?.id ?? "all"):\(model.dietary.map(\.id).sorted()):\(model.nutrition.map(\.id).sorted()):\(model.nutritionMode.id)"
    }
    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top),
              count: textSize >= .xxxLarge || (availableWidth > 0 && availableWidth < 360) ? 1 : 2)
    }

    var body: some View {
        let _ = ratingRevision
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Color.clear.frame(height: 0).id("search-top")
                        .background { GeometryReader { geometry in Color.clear.preference(key: NativeSearchScrollAnchorKey.self, value: ["search-top": geometry.frame(in: .named("food-discovery-scroll"))]) } }
                    if showsRecipes {
                        recipeResults
                    } else if showsResults {
                        results
                    } else if searchFocused {
                        suggestions
                    } else {
                        discoveryRoutes
                        discoveryContent
                        sourceNote
                    }
                }
                .frame(maxWidth: 600)
                .padding(.horizontal, textSize.isAccessibilitySize ? 8 : 20)
                .padding(.top, 10)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity)
            }
            .coordinateSpace(name: "food-discovery-scroll")
            .scrollDismissesKeyboard(.interactively)
            .onPreferenceChange(NativeSearchScrollAnchorKey.self) { positions in
                guard !restoringPosition else { return }
                if let item = positions.filter({ $0.value.maxY > 0 && $0.value.minY < availableHeight }).min(by: { $0.value.minY < $1.value.minY }) { model.scrollAnchor = item.key }
            }
            .task {
                allAislesExpanded = model.allAislesExpanded
                if let anchor = model.scrollAnchor {
                    await Task.yield()
                    scroll.scrollTo(anchor, anchor: .top)
                }
                await Task.yield()
                restoringPosition = false
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    if !searchFocused && !showsResults && !showsRecipes { header }
                    searchField
                    if recipeSearch != nil { searchKindControl }
                    if !showsRecipes && searchFocused {
                        Button { searchFocused = false; onNavigate("describeFood") } label: {
                            Label("Describe something you ate", systemImage: "text.bubble")
                                .font(.subheadline).frame(minHeight: 44)
                        }.accessibilityIdentifier("product-search-describe-food")
                    }
                    if !showsRecipes && (!searchFocused || showsResults) { searchScope }
                }
                .frame(maxWidth: 600)
                .padding(.horizontal, textSize.isAccessibilitySize ? 8 : 20)
                .padding(.top, 4).padding(.bottom, 8)
                .frame(maxWidth: .infinity)
                .background(Color(uiColor: NudgeTheme.canvas))
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !searchFocused { navigation }
            }
            .onChange(of: searchFocused) { focused in
                if focused { scroll.scrollTo("search-top", anchor: .top) }
            }
            .onChange(of: model.ratingContextID) { _ in
                if showsRecipes { ratingLoader?.cancel() }
                else { synchronizeRatings(); ratingLoader?.reset() }
            }
            .onChange(of: model.sortOrder) { _ in synchronizeRatings() }
            .onChange(of: model.scope) { _ in
                if showsRecipes { ratingLoader?.cancel() } else { synchronizeRatings() }
                scroll.scrollTo("search-top", anchor: .top)
            }
            .onChange(of: model.savedIntentRevision) { _ in searchFocused = false; onSaved() }
            .onChange(of: allAislesExpanded) { model.allAislesExpanded = $0 }
            .onChange(of: selectionKey) { _ in scroll.scrollTo("search-top", anchor: .top) }
            .onChange(of: model.loading) { loading in
                guard !loading, !model.isDebouncing, !model.isBrowsing, !showsRecipes, UIAccessibility.isVoiceOverRunning else { return }
                let message = model.errorMessage ?? (model.products.isEmpty ? "No catalogue products found" : "\(model.products.count) products loaded")
                UIAccessibility.post(notification: .announcement, argument: message)
            }
        }
        .background {
            GeometryReader { geometry in
                Color.clear
                    .onAppear { availableWidth = geometry.size.width; availableHeight = geometry.size.height }
                    .onChange(of: geometry.size.width) { availableWidth = $0 }
                    .onChange(of: geometry.size.height) { availableHeight = $0 }
            }
        }
        .background(Color(uiColor: NudgeTheme.canvas).ignoresSafeArea())
        .foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .tint(Color(uiColor: NudgeTheme.accent))
        .buttonStyle(NativeSearchTouchButtonStyle())
        .searchControl("native-product-search")
        .onReceive(ratingLoader?.$revision.eraseToAnyPublisher() ?? Empty<Int, Never>().eraseToAnyPublisher()) {
            ratingRevision = $0
        }
        .onReceive(model.$products) {
            if !showsRecipes { ratingLoader?.synchronize(products: $0, resolveForSorting: model.sortOrder.usesRating) }
        }
        .onAppear { if !showsRecipes { synchronizeRatings() } }
        .onDisappear { ratingLoader?.cancel() }
        .sheet(isPresented: $placesPresented) {
            NativeSearchPlacesSheet(selected: model.selectedPlace) { model.setPlace($0) }
        }
        .sheet(isPresented: $filtersPresented) {
            NativeSearchFiltersSheet(dietary: model.dietary, nutrition: model.nutrition, mode: model.nutritionMode) { dietary, nutrition, mode in
                let browsing = model.isBrowsing
                model.setFilters(dietary: dietary, nutrition: nutrition, mode: mode)
                if browsing { model.browseFilteredProducts() }
            }
        }
        .sheet(item: $guide) { item in
            NativeNutritionGuideSheet(guide: item) { choice in
                model.setNutrition(model.nutrition.union([choice]))
                model.browseFilteredProducts()
            }
        }
    }

    private var header: some View {
        let layout = textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        return layout {
            Button { navigate("today") } label: {
                HStack(spacing: 6) {
                    Text("nudge").font(.system(.title, design: .default).weight(.heavy)).kerning(-1.5)
                    NudgeBrandMark()
                }
                .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                .frame(minHeight: 48)
            }
            .buttonStyle(NativeSearchTouchButtonStyle())
            .accessibilityLabel("Nudge, Today")
            if !textSize.isAccessibilitySize { Spacer(minLength: 0) }
            Button {
                searchFocused = false
                model.cancel()
                onSaved()
            } label: {
                Label("Saved (\(savedCount))", systemImage: "bookmark")
                    .font(.subheadline.weight(.semibold))
                    .multilineTextAlignment(.trailing)
                    .frame(minHeight: 48)
            }
            .buttonStyle(NativeSearchTouchButtonStyle())
            .foregroundStyle(Color(uiColor: NudgeTheme.accent))
            .searchControl("search-saved-foods")
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            searchInput
            if searchFocused {
                Button {
                    if hasSearchText { submit() } else { searchFocused = false }
                } label: {
                    Image(systemName: hasSearchText ? "magnifyingglass" : "keyboard.chevron.compact.down")
                        .font(.system(size: 22)).frame(width: 48, height: 56)
                }
                .accessibilityLabel(hasSearchText ? "Search" : "Close search keyboard")
                .accessibilityHint(hasSearchText ? "Searches this text and closes the keyboard" : "Keeps your search and results")
                .searchControl(hasSearchText ? "product-search-submit" : "product-search-dismiss")
            }
        }
    }

    private var searchInput: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                .accessibilityHidden(true)
            TextField("", text: Binding(get: { model.query }, set: model.updateLiveQuery), prompt: Text(showsRecipes ? "Recipe or ingredient" : "Food, brand or barcode").foregroundColor(Color(uiColor: NudgeTheme.muted)))
                .font(.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
                .onSubmit(submit)
                .frame(minWidth: 48, minHeight: 56)
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded { searchFocused = true })
                .accessibilityLabel(showsRecipes ? "Search recipes or ingredients" : "Search products, brands or barcode")
                .searchControl("product-search-input")
            if !model.query.isEmpty {
                Button {
                    model.clearLiveQuery()
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .frame(width: 48, height: 48)
                }
                .buttonStyle(NativeSearchTouchButtonStyle())
                .accessibilityLabel("Clear search")
                .searchControl("product-search-clear")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, model.query.isEmpty ? 14 : 2)
        .frame(minHeight: NudgeTheme.buttonHeight)
        .background {
            RoundedRectangle(cornerRadius: NudgeTheme.controlRadius)
                .fill(Color(uiColor: NudgeTheme.surface))
                .contentShape(Rectangle())
                .onTapGesture { searchFocused = true }
                .accessibilityHidden(true)
        }
        .overlay {
            RoundedRectangle(cornerRadius: NudgeTheme.controlRadius)
                .stroke(Color(uiColor: searchFocused ? NudgeTheme.accent : contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border), lineWidth: searchFocused || contrast == .increased ? 2 : 1)
        }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Recent searches & ideas" : "Suggestions")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                Spacer(minLength: 8)
                if model.hasRecentSearches && model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button("Clear") { model.clearRecentSearches() }
                        .font(.subheadline.weight(.semibold))
                        .accessibilityLabel("Clear recent searches")
                        .searchControl("product-search-clear-recents")
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 4)
            ForEach(model.suggestions, id: \.self) { suggestion in
                HStack(spacing: 0) {
                    Button { submit(suggestion) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "magnifyingglass").accessibilityHidden(true)
                            suggestionText(suggestion).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.body).padding(.leading, 16).padding(.vertical, 12)
                        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(NativeSearchTouchButtonStyle())
                    .accessibilityLabel("Search for \(suggestion)")
                    .searchControl("product-search-suggestion-" + suggestion)
                    Button {
                        model.updateLiveQuery(suggestion)
                        searchFocused = true
                    } label: {
                        Image(systemName: "arrow.up.left").frame(width: 48, height: 56)
                    }
                    .accessibilityLabel("Use \(suggestion) in search field")
                    .accessibilityHint("Keeps the keyboard open to refine this search")
                    .searchControl("product-search-refine-" + suggestion)
                }
                Divider().padding(.leading, 16)
            }
            if model.suggestions.isEmpty {
                Text("Type a food or brand to search. For a barcode, enter the number and tap Search on the keyboard.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .padding(16)
            }
        }
        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
        .searchControl("product-search-suggestions")
    }

    private func suggestionText(_ suggestion: String) -> Text {
        let query = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, let range = suggestion.range(of: query, options: .caseInsensitive) else {
            return Text(suggestion).fontWeight(.semibold)
        }
        return Text(String(suggestion[..<range.lowerBound])).fontWeight(.semibold)
            + Text(String(suggestion[range]))
            + Text(String(suggestion[range.upperBound...])).fontWeight(.semibold)
    }

    private var searchKindControl: some View {
        HStack(spacing: 8) {
            searchKindButton("Products", symbol: "barcode", scope: .product, selected: !showsRecipes)
            searchKindButton("Recipes", symbol: "book.closed", scope: .recipe, selected: showsRecipes)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Search library")
        .searchControl("search-kind-control")
    }

    private func searchKindButton(_ title: String, symbol: String, scope: NativeFoodSearchScope, selected: Bool) -> some View {
        Button { model.setScope(scope) } label: {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 48)
                .padding(.horizontal, 6)
                .foregroundStyle(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.muted))
                .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .searchControl("search-kind-" + scope.rawValue)
    }

    private var recipeResults: some View {
        let projection = recipeSearch?(model.query, savedRecipesOnly) ?? [:]
        let rows = (projection["rows"] as? [[String: Any]] ?? []).compactMap(NativeRecipeSearchItem.init)
        let libraryCount = projection["recipeCount"] as? Int ?? 0
        let excluded = projection["excludedCount"] as? Int ?? 0
        let reasons = projection["excludedReasons"] as? [String] ?? []
        return VStack(alignment: .leading, spacing: 12) {
            Text("Recipe library").font(.title2.bold()).accessibilityAddTraits(.isHeader)
            Text("\(libraryCount) recipes on this phone · search names or ingredients")
                .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Button { savedRecipesOnly.toggle() } label: {
                Label(savedRecipesOnly ? "Saved recipes" : "All recipes", systemImage: savedRecipesOnly ? "heart.fill" : "heart")
                    .font(.subheadline.weight(.semibold)).frame(minHeight: 48)
            }
            .accessibilityLabel(savedRecipesOnly ? "Show all recipes" : "Show saved recipes")
            .accessibilityValue(savedRecipesOnly ? "Saved recipes only" : "All recipes")
            .searchControl("search-recipes-saved-filter")
            if rows.isEmpty {
                Text(savedRecipesOnly ? "No saved recipes match" : "No recipes match")
                    .font(.headline)
                Text(model.query.isEmpty
                     ? (savedRecipesOnly ? "Tap Save on a recipe to keep it here." : "Your saved food requirements may exclude recipes in this library.")
                     : "Try another recipe name or ingredient.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .searchControl("search-recipes-empty")
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { recipe in
                        NativeProductSearchRow(id: "recipe-" + recipe.id, name: recipe.name,
                            imageURL: recipe.image, brandOrSource: recipe.subtitle,
                            rating: .init(value: recipe.score, subtitle: recipe.score == nil ? "Nutrition incomplete" : "Estimated Nudge rating"),
                            isSaved: savedRecipeIDs.contains(recipe.id),
                            onOpen: { searchFocused = false; model.cancel(); onOpenRecipe(recipe.id) },
                            onSave: { onToggleRecipeSaved(recipe.id) })
                        .id("recipe-" + recipe.id)
                    }
                }
            }
            if excluded > 0 {
                Text("\(excluded) \(excluded == 1 ? "recipe is" : "recipes are") hidden by your saved food requirements.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .searchControl("search-recipes-excluded")
                ForEach(reasons, id: \.self) { Text($0).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
            }
            Text("Recipe ideas and drafts are labelled in their details. Review ingredients, portions and preparation before adding to your diary.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }
        .searchControl("search-recipe-library")
    }

    private var searchScope: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Button { searchFocused = false; placesPresented = true } label: {
                        compactScopeLabel(model.selectedPlace?.title ?? "All places", symbol: "storefront")
                    }
                    .accessibilityLabel("Where to eat or shop, \(model.selectedPlace?.title ?? "All places")")
                    .searchControl("search-place-selector")
                    Menu {
                        Picker("Product market", selection: Binding(get: { model.market }, set: model.setMarket)) {
                            ForEach(ProductSearchMarket.allCases) { Text($0 == .unitedKingdom ? "UK listings" : "All indexed products").tag($0) }
                        }
                    } label: {
                        compactScopeLabel(model.market == .unitedKingdom ? "UK" : "All indexed products", symbol: "globe.europe.africa")
                    }
                    .accessibilityLabel(model.market == .unitedKingdom ? "Product market, UK listings" : "Product market, all indexed products")
                    .searchControl("product-search-market")
                    Button { searchFocused = false; filtersPresented = true } label: {
                        let count = model.dietary.count + model.nutrition.count
                        compactScopeLabel(count > 0 ? "Filters · \(count)" : "Filters", symbol: "slider.horizontal.3")
                    }
                    .searchControl("search-filters")
                    if showsResults { sortControl }
                }
            }
            .searchControl("search-scope-strip")
            .foregroundStyle(Color(uiColor: NudgeTheme.accent))
            if !searchFocused || model.selectedCategory != nil { activeFilters }
        }
    }

    private func compactScopeLabel(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.subheadline.weight(.semibold))
            .fixedSize(horizontal: !textSize.isAccessibilitySize, vertical: true)
            .frame(maxWidth: textSize.isAccessibilitySize ? max(180, availableWidth - 80) : nil)
            .padding(.horizontal, 12).frame(minHeight: 48)
            .background(Color(uiColor: NudgeTheme.surface), in: Capsule())
            .overlay(Capsule().stroke(Color(uiColor: contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border)))
    }

    private var activeFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if let place = model.selectedPlace {
                    filterChip("Place: \(place.title)", identifier: "search-chip-place") { model.setPlace(nil) }
                }
                if let category = model.selectedCategory {
                    filterChip("Aisle: \(category.title)", identifier: "search-chip-aisle") { model.clearCategory() }
                }
                ForEach(SearchDietaryRequirement.allCases.filter { model.dietary.contains($0) }) { choice in
                    filterChip(choice.title, identifier: "search-chip-diet-\(choice.id)") { model.setDietary(model.dietary.subtracting([choice])) }
                }
                ForEach(SearchNutritionChoice.allCases.filter { model.nutrition.contains($0) }) { choice in
                    filterChip(choice.title, identifier: "search-chip-nutrition-\(choice.id)") { model.setNutrition(model.nutrition.subtracting([choice])) }
                }
            }
        }
        .searchControl("search-filter-strip")
    }

    private func filterChip(_ title: String, identifier: String, remove: @escaping () -> Void) -> some View {
        Button(action: remove) {
            HStack(spacing: 10) {
                Text(title).font(.subheadline.weight(.semibold)).fixedSize(horizontal: !textSize.isAccessibilitySize, vertical: true)
                    .frame(maxWidth: textSize.isAccessibilitySize ? max(160, availableWidth - 120) : nil)
                Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).accessibilityHidden(true)
            }
            .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 48)
            .foregroundStyle(Color(uiColor: NudgeTheme.accent))
            .background(Color(uiColor: NudgeTheme.selectedSurface), in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(NativeSearchTouchButtonStyle())
        .accessibilityLabel("Remove filter: \(title)")
        .searchControl(identifier)
    }

    private var discoveryRoutes: some View {
        LazyVGrid(columns: textSize.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(NativeSearchDiscoveryRoute.allCases) { route in
                Button { model.discoveryRouteID = route.id } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: route.symbol).font(.system(size: 18)).accessibilityHidden(true)
                        Text(route == .aisles && model.isChainSelected ? "Catalogue products" : route.title).font(.subheadline.weight(.semibold))
                    }
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .padding(10)
                        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                        .background(Color(uiColor: model.discoveryRouteID == route.id ? NudgeTheme.selectedSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: model.discoveryRouteID == route.id ? NudgeTheme.accent : NudgeTheme.border), lineWidth: model.discoveryRouteID == route.id ? 2 : 1))
                }
                .buttonStyle(NativeSearchTouchButtonStyle())
                .accessibilityAddTraits(model.discoveryRouteID == route.id ? .isSelected : [])
                .searchControl("discovery-route-\(route.id)")
            }
        }
    }

    @ViewBuilder private var discoveryContent: some View {
        switch NativeSearchDiscoveryRoute(rawValue: model.discoveryRouteID) ?? .aisles {
        case .aisles:
            if model.isChainSelected { chainCatalogue } else { categories }
        case .women:
            VStack(alignment: .leading, spacing: 14) {
                Text("Women’s nutrition").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                Text("Explore your context, then choose an ordinary nutrition filter.").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                ForEach(Array(NativeNutritionGuide.allCases.enumerated()), id: \.element.id) { index, item in
                    discoveryOption(item.title, detail: item.summary, symbol: "heart", index: index, identifier: "nutrition-guide-\(item.id)") { guide = item }
                }
            }
        case .diet:
            VStack(alignment: .leading, spacing: 14) {
                Text("Dietary needs").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                Text("Choose free-from labels and food preferences. Every selected requirement must be supported.").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                ForEach(SearchDietaryRequirement.allCases) { item in
                    choiceRow(item.title, selected: model.dietary.contains(item), identifier: "discovery-diet-\(item.id)") {
                        model.setDietary(model.dietary.contains(item) ? model.dietary.subtracting([item]) : model.dietary.union([item]))
                    }
                }
                Button("Show matching foods") { model.browseFilteredProducts() }.buttonStyle(NudgeButtonStyle()).searchControl("discovery-diet-show")
            }
        case .nutrition:
            VStack(alignment: .leading, spacing: 14) {
                Text("Nutrition choices").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                Text("Based on recorded nutrients or wholegrain ingredients. Missing values remain unknown.").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                ForEach(SearchNutritionChoice.allCases) { item in
                    choiceRow(item.title, selected: model.nutrition.contains(item), identifier: "discovery-nutrition-\(item.id)") {
                        model.setNutrition(model.nutrition.contains(item) ? model.nutrition.subtracting([item]) : model.nutrition.union([item]))
                    }
                }
                ForEach(SearchNutritionMode.allCases) { mode in
                    choiceRow(mode.title, selected: model.nutritionMode == mode, identifier: "discovery-mode-\(mode.id)") { model.setNutritionMode(mode) }
                }
                Text("Dietary requirements always match all selections.").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                Button("Show matching foods") { model.browseFilteredProducts() }.buttonStyle(NudgeButtonStyle()).searchControl("discovery-nutrition-show")
            }
        }
    }

    private func choiceRow(_ title: String, selected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title).font(.body.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.system(size: 22)).accessibilityHidden(true)
            }
            .padding(16).frame(minHeight: 48)
            .foregroundStyle(Color(uiColor: NudgeTheme.accent))
            .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(NativeSearchTouchButtonStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
        .searchControl(identifier)
    }

    private func discoveryOption(_ title: String, detail: String, symbol: String, index: Int, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: symbol).font(.system(size: 24)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.headline)
                    Text(detail).font(.subheadline)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(18).frame(minHeight: 84)
            .foregroundStyle(Color(uiColor: NudgeTheme.discoveryInk(index)))
            .background(Color(uiColor: NudgeTheme.discoveryFill(index)), in: RoundedRectangle(cornerRadius: 20))
        }
        .buttonStyle(NativeSearchTouchButtonStyle())
        .searchControl(identifier)
    }

    private var chainCatalogue: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(model.selectedPlace?.title ?? "This place") products").font(.title2.weight(.bold))
            Text("Browse foods linked to this brand or retailer in Nudge’s catalogue. These can include packaged supermarket products. Current menus and local stock are not available.")
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Button("Browse catalogue products") { model.browseFilteredProducts() }.buttonStyle(NudgeButtonStyle())
            Button("Choose another place") { placesPresented = true }.buttonStyle(NudgeButtonStyle(variant: .secondary))
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 24))
        .searchControl("search-chain-catalogue")
    }

    private func scopeLabel(_ title: String, symbol: String) -> some View {
        HStack(alignment: .center, spacing: 8) {
            if !textSize.isAccessibilitySize {
                Image(systemName: symbol).font(.system(size: 22)).accessibilityHidden(true)
            }
            Text(title).font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.down").font(.system(size: 14, weight: .semibold)).accessibilityHidden(true)
        }
        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 48)
        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: NudgeTheme.controlRadius))
        .overlay(RoundedRectangle(cornerRadius: NudgeTheme.controlRadius)
            .stroke(Color(uiColor: contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border)))
        .contentShape(RoundedRectangle(cornerRadius: NudgeTheme.controlRadius))
    }

    private var categories: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                sourceCaption
                Text("Browse food aisles")
                    .font(.title2.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
            }
            LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                ForEach(Array(ProductSearchCategory.all.prefix(allAislesExpanded ? 28 : 8)), id: \.id) { category in
                    Button { select(category) } label: {
                        VStack(alignment: .leading, spacing: 22) {
                            Image(systemName: category.symbol)
                                .font(.system(size: 32, weight: .regular))
                                .frame(height: 40)
                                .accessibilityHidden(true)
                            Text(category.title)
                                .font(.headline)
                                .fixedSize(horizontal: false, vertical: true)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(Color(uiColor: NudgeTheme.discoveryInk(category.colourIndex)))
                        .padding(18)
                        .frame(maxWidth: .infinity, minHeight: 144, alignment: .topLeading)
                        .background(Color(uiColor: NudgeTheme.discoveryFill(category.colourIndex)), in: RoundedRectangle(cornerRadius: 24))
                        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color(uiColor: contrast == .increased ? NudgeTheme.strongBorder : NudgeTheme.border), lineWidth: 1))
                    }
                    .buttonStyle(NativeSearchTouchButtonStyle())
                    .accessibilityLabel(category.title)
                    .accessibilityHint("Browse products in Nudge’s catalogue")
                    .searchControl("search-category-\(category.id)")
                }
            }
            Button(allAislesExpanded ? "Show fewer aisles" : "Show all 28 aisles") { allAislesExpanded.toggle() }
                .buttonStyle(NudgeButtonStyle(variant: .secondary))
                .searchControl("search-show-all-aisles")
        }
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !matchingCategories.isEmpty { categorySuggestions }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(model.selectedCategory?.title ?? "Products")
                    .font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if !waitingForResults, !model.isRefinementPreview, !model.products.isEmpty {
                    Text(model.totalResults.map { "\($0.formatted()) matches" } ?? "\(model.products.count) matches")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                Button { searchFocused = false; model.showCategories(clearSupportContext: true) } label: {
                    Image(systemName: "square.grid.2x2").frame(width: 48, height: 48)
                }
                .accessibilityLabel("Back to browsing")
                .searchControl("search-all-categories")
            }

            if let correction = model.correction, !correction.isEmpty {
                Text(correction).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !model.products.isEmpty {
                // One evidence read supplies both rating order and its visible
                // badges. Avoid resolving the same public record again while
                // constructing each card after sorting.
                let ratings = model.sortOrder.usesRating
                    ? Dictionary(model.products.map { ($0.barcode, productRating($0)) }, uniquingKeysWith: { first, _ in first })
                    : [:]
                // Barcode identity survives an async rating changing the
                // ordering. Lazy cards retain visible-only lookup normally.
                LazyVStack(spacing: 0) {
                    ForEach(model.orderedProducts(rating: { ratings[$0.barcode] ?? productRating($0) }), id: \.barcode) { product in
                        productCard(product, resolvedRating: ratings[product.barcode]).frame(maxWidth: .infinity).id("product-" + product.barcode)
                            .onAppear { model.loadMoreIfNeeded(appearing: product.barcode) }
                            .background { GeometryReader { geometry in Color.clear.preference(key: NativeSearchScrollAnchorKey.self, value: ["product-" + product.barcode: geometry.frame(in: .named("food-discovery-scroll"))]) } }
                    }
                }
            }

            if waitingForResults {
                if model.products.isEmpty {
                    NativeProductSearchSkeletonRows(count: 6)
                        .searchControl("product-search-loading")
                } else {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Updating products…").font(.caption)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .accessibilityElement(children: .combine)
                    .searchControl("product-search-loading")
                }
            }

            if let error = model.errorMessage, !waitingForResults {
                errorState(error)
            } else if !waitingForResults && model.products.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.selectedPlace == nil ? "No products found" : "No catalogue products found").font(.headline)
                    Text(model.isChainSelected
                         ? "No matching products are recorded for this place and these filters yet. This does not describe its current menu. Try another food or choose All places."
                         : model.supportContext != nil
                         ? "No food ideas match these filters yet. Try another food or supermarket, or choose All foods. This does not mean other foods are unsuitable."
                         : model.store != nil
                         ? "Try all supermarkets, another category, product name or brand. Retailer listings may be incomplete."
                         : model.market == .unitedKingdom
                            ? "Try another category, product name or brand. Nudge’s UK catalogue is growing, so some products are not listed yet."
                            : "Try another category, product name or brand.")
                        .font(.body).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    if model.selectedPlace != nil {
                        Button("Search all places") { model.setPlace(nil) }
                            .buttonStyle(NudgeButtonStyle(variant: .secondary))
                            .searchControl("product-search-clear-store")
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 24))
                .searchControl("product-search-empty")
            }

            if let notice = model.notice, !notice.isEmpty {
                Text(notice).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                if model.isStale && !model.loading && model.errorMessage == nil { retryButton }
            }

            if model.hasMore && !waitingForResults && model.errorMessage == nil && !model.isStale {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let remaining = retrySeconds(at: context.date)
                    Button(remaining > 0 ? "Load more in \(remaining)s" : "Load more products") { model.loadMore() }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                        .disabled(remaining > 0)
                        .searchControl("product-search-more")
                }
            }
            if !waitingForResults {
                DisclosureGroup("About these results", isExpanded: $detailsExpanded) {
                    resultDetails.padding(.top, 12)
                }
                .font(.subheadline).searchControl("search-result-details")
            }
        }
    }

    private var categorySuggestions: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Categories")
                .font(.headline).accessibilityAddTraits(.isHeader)
                .padding(.bottom, 6)
            ForEach(matchingCategories) { category in
                Button { select(category) } label: {
                    HStack(spacing: 12) {
                        Text(category.title).frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).accessibilityHidden(true)
                    }
                    .font(.body).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(NativeSearchTouchButtonStyle())
                .accessibilityLabel("Browse \(category.title)")
                .accessibilityHint("Filters catalogue products to this category and keeps your other filters")
                .searchControl("search-category-suggestion-" + category.id)
                Divider().accessibilityHidden(true)
            }
        }
        .searchControl("search-category-suggestions")
    }

    private var resultDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let summary = model.filterCoverageSummary {
                Text(summary).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .searchControl("search-filter-coverage")
            }
            if !model.dietary.isEmpty {
                if let conflicts = model.dietaryConflictCount, conflicts > 0 {
                    Text("\(conflicts.formatted()) foods have conflicting source evidence for your dietary requirements.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .searchControl("search-dietary-conflicts")
                }
                if let unknown = model.dietaryUnknownCount, unknown > 0 {
                    Text("\(unknown.formatted()) foods need label confirmation and are not included as matches.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .searchControl("search-dietary-unknown")
                }
            }
            if model.nutrition.count > 1 {
                Text("Nutrition: \(model.nutritionMode.title.lowercased()) · dietary needs: match all")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            if let place = model.selectedPlace, !model.isBarcodeResult {
                Text(place.isSupermarket
                     ? "Products linked to \(place.title) by source brand or retailer information. Listings are not live branch stock."
                     : "Catalogue products linked to \(place.title) by source brand or retailer information. These may be packaged supermarket foods; current menus and local stock are not available.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    .searchControl("search-place-coverage")
                if let coverage = model.placeCoverageSummary {
                    Text(coverage).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
            }
            if model.isBarcodeResult {
                Text("An exact barcode identifies this product. Search filters do not establish its suitability.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            if model.sortOrder != .relevance {
                Text(model.sortOrder.usesRating
                     ? "Sorted within loaded products. Ratings update as nutrition arrives; unrated products appear last."
                     : "Sorted within loaded products.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            sourceNote
        }
    }

    private var sortControl: some View {
        Menu {
            Picker("Sort products", selection: Binding(get: { model.sortOrder }, set: model.setSortOrder)) {
                ForEach(NativeProductSearchSort.allCases) { order in Text(order.title).tag(order) }
            }
        } label: {
            compactScopeLabel(model.sortOrder == .relevance ? "Sort" : model.sortOrder.title, symbol: "arrow.up.arrow.down")
        }
        .accessibilityLabel("Sort products, \(model.sortOrder.title)")
        .searchControl("product-search-sort")
    }

    private func synchronizeRatings() {
        ratingLoader?.synchronize(products: model.products, resolveForSorting: model.sortOrder.usesRating)
    }

    private func productRating(_ product: BarcodeProduct) -> NativeProductRating {
        ratingLoader?.rating(for: product) ?? rating(product)
    }

    private func productCard(_ product: BarcodeProduct, resolvedRating: NativeProductRating? = nil) -> some View {
        NativeProductSearchRow(id: product.barcode, name: product.name, imageURL: product.displayImageURL,
                              barcode: product.barcode, brandOrSource: productSourceLabel(product),
                              rating: resolvedRating ?? productRating(product), isSaved: isSaved(product), onOpen: {
            searchFocused = false
            model.cancel()
            onOpen(product)
        }, onSave: { onToggleSave(product) })
        .onAppear { ratingLoader?.appear(product) }
        .onDisappear { ratingLoader?.disappear(product) }
    }

    private func productSourceLabel(_ product: BarcodeProduct) -> String {
        let brand = product.brand ?? "Product"
        guard let association = model.placeAssociation(for: product) else { return brand }
        return "\(brand) · \(association.displayReason)"
    }

    private func errorState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.products.isEmpty ? "Products could not be loaded" : "More products could not be loaded")
                .font(.headline)
            Text(message).font(.body)
            retryButton
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: NudgeTheme.errorSurface), in: RoundedRectangle(cornerRadius: 24))
        .searchControl("product-search-error")
    }

    private var retryButton: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = retrySeconds(at: context.date)
            Button(remaining > 0 ? "Try again in \(remaining)s" : "Try again") { model.retry() }
                .buttonStyle(NudgeButtonStyle(variant: .secondary))
                .disabled(remaining > 0)
                .searchControl("product-search-retry")
        }
    }

    private func retrySeconds(at date: Date) -> Int {
        max(0, Int(ceil((model.retryAt ?? .distantPast).timeIntervalSince(date))))
    }

    private var sourceNote: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Nudge catalogue").font(.caption.weight(.semibold))
                .searchControl("search-source-nudge")
            Text("\(model.isBarcodeResult ? "Exact barcode product from Nudge’s catalogue." : "Nudge’s growing catalogue currently covers a selection of UK-listed products.") Only the search filters shown above apply. Retailer listings are not live branch stock. Check current packaging for ingredients and allergens.")
                .font(.caption)
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
            if model.products.isEmpty || model.products.contains(where: { $0.sourceName == "Open Food Facts" }) {
                Link(destination: URL(string: "https://world.openfoodfacts.org")!) {
                    Text("Original product data: Open Food Facts").font(.caption)
                        .frame(minHeight: 48).contentShape(Rectangle())
                }
                .searchControl("search-original-source-off")
                Text("Product data: ODbL · Photos: contributors, CC BY-SA")
                    .font(.caption2)
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            if model.products.contains(where: { $0.sourceName == "Nudge community" }) {
                Text("Includes Nudge community facts reviewed against packaging photos.")
                    .font(.caption2).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var sourceCaption: some View {
        Text("NUDGE CATALOGUE")
            .font(.caption2.weight(.semibold)).tracking(0.8)
            .foregroundStyle(Color(uiColor: NudgeTheme.muted))
    }

    private var navigation: some View {
        HStack(alignment: .bottom, spacing: 2) {
            navigationItem("Today", symbol: "house", destination: "today")
            navigationItem("History", symbol: "clock.arrow.circlepath", destination: "history")
            navigationItem("Camera", symbol: "plus", destination: "camera")
            navigationItem("Search", symbol: "magnifyingglass", destination: "search")
            navigationItem("You", symbol: "person", destination: "you")
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: 600)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: NudgeTheme.surface).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Color(uiColor: NudgeTheme.border)).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Main navigation")
    }

    private func navigationItem(_ title: String, symbol: String, destination: String) -> some View {
        let selected = destination == "search"
        let camera = destination == "camera"
        return Button {
            if selected { model.showCategories() } else { navigate(destination) }
        } label: {
            VStack(spacing: 6) {
                if camera {
                    Image(systemName: symbol)
                        .font(.system(size: 27, weight: .regular))
                        .foregroundStyle(Color(uiColor: NudgeTheme.primaryText))
                        .frame(width: 47, height: 47)
                        .background(Color(uiColor: NudgeTheme.primaryFill), in: Circle())
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: 22, weight: selected ? .semibold : .regular))
                        .frame(height: 30)
                }
                Text(title).font(.caption2.weight(selected || camera ? .semibold : .regular))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 55, alignment: .bottom)
            .foregroundStyle(Color(uiColor: selected || camera ? NudgeTheme.accent : NudgeTheme.muted))
            .contentShape(Rectangle())
        }
        .buttonStyle(NativeSearchTouchButtonStyle())
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .searchControl("search-nav-\(destination)")
    }

    private func submit() {
        searchFocused = false
        if !showsRecipes { model.submit() }
    }

    private func submit(_ suggestion: String) {
        searchFocused = false
        model.submit(suggestion)
    }

    private func select(_ category: ProductSearchCategory) {
        searchFocused = false
        model.select(category)
    }

    private func navigate(_ destination: String) {
        searchFocused = false
        model.cancel()
        onNavigate(destination)
    }


}

private struct NativeRecipeSearchItem: Identifiable {
    let id: String
    let name: String
    let image: String?
    let subtitle: String
    let score: Int?
    init?(_ row: [String: Any]) {
        guard row["kind"] as? String == "recipe", let id = row["id"] as? String, !id.isEmpty,
              let name = row["name"] as? String, !name.isEmpty else { return nil }
        self.id = id; self.name = name; image = row["image"] as? String
        let details = row["subtitle"] as? String ?? "Recipe"
        subtitle = row["status"] as? String == "draft" ? "Draft · " + details : details
        score = (row["score"] as? Int).flatMap { (0...100).contains($0) ? $0 : nil }
    }
}

struct ProductSupportPhaseBadge: View {
    let context: ProductSupportContext

    var body: some View {
        Text(context.title)
            .font(.caption.weight(.bold))
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(Color(uiColor: NudgeTheme.supportInk(context)))
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(Color(uiColor: NudgeTheme.supportFill(context)), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel("Cycle or life stage: \(context.title)")
    }
}

struct ProductSupportReview: Identifiable {
    let name: String
    let barcode: String
    let tags: [ProductSupportTag]
    let selectedContext: ProductSupportContext?
    var id: String { barcode }
}

/// Evidence lives in its own sheet, separate from the nutrition rating and
/// portion/diary flow. Browsing this sheet does not change a saved profile.
struct ProductSupportReviewSheet: View {
    let review: ProductSupportReview
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(review.name).font(.title2.weight(.bold))
                    if let context = review.selectedContext {
                        ProductSupportPhaseBadge(context: context)
                            .searchControl("support-review-phase")
                        Text("Reasons for this stage").font(.headline)
                    }
                    Text("Each reason below explains why this food is an idea to explore. Evidence strength is shown for each reason. The Nudge % is a separate nutrition rating, not a score for symptom relief.")
                        .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    ForEach(review.tags) { tag in
                        VStack(alignment: .leading, spacing: 12) {
                            Text(tag.label).font(.headline).accessibilityAddTraits(.isHeader)
                            Text(tag.evidenceLabel).font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                            if let direction = tag.directionLabel {
                                Text(direction).font(.subheadline.weight(.semibold))
                            }
                            Text(tag.wording).font(.body)
                            Text("Explore this idea for").font(.caption.weight(.semibold))
                            LazyVGrid(columns: textSize.isAccessibilitySize
                                      ? [GridItem(.flexible(), alignment: .leading)]
                                      : [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: 8) {
                                ForEach(ProductSupportContext.allCases.filter { tag.contexts.contains($0.rawValue) }) { context in
                                    ProductSupportPhaseBadge(context: context)
                                        .searchControl("support-review-phase-\(tag.id)-\(context.rawValue)")
                                }
                            }
                            if tag.contexts.contains("follicular") || tag.contexts.contains("ovulation") {
                                Text("This idea applies across stages; it is not specific to one cycle phase.")
                                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }
                            Text(tag.foodDataLabel).font(.caption)
                                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            ForEach(Array(tag.limitations.enumerated()), id: \.offset) { _, limitation in
                                Text(limitation).font(.caption)
                                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }
                            if !tag.sources.isEmpty {
                                Text("Evidence sources").font(.subheadline.weight(.semibold))
                                ForEach(tag.sources) { source in
                                    if let url = source.safeURL {
                                        Link(destination: url) {
                                            Label(source.title, systemImage: "arrow.up.right.square")
                                                .font(.subheadline)
                                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                        }
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(18)
                        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 24))
                        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color(uiColor: NudgeTheme.border)))
                        .searchControl("support-review-reason-\(tag.id)")
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(20)
            }
            .background(Color(uiColor: NudgeTheme.canvas))
            .foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .navigationTitle("Why this food?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(uiColor: NudgeTheme.canvas), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }.buttonStyle(NativeSearchTouchButtonStyle())
                        .accessibilityIdentifier("product-support-review-done")
                }
            }
        }
        .tint(Color(uiColor: NudgeTheme.accent))
        .accessibilityIdentifier("product-support-review")
    }
}

/// Shared by search and better-product suggestions. Numeric labels and
/// VoiceOver retain meaning independently of the bright traffic-light fill.
struct NativeNudgeRatingBadge: View {
    let value: Int
    var compact = false
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        let tone = NativeProductRatingTone(value: value)
        let layout = compact && !textSize.isAccessibilitySize
            ? AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
        layout {
            Text("\(value)%").font((compact ? Font.headline : .title2).weight(.bold)).monospacedDigit()
            Text("Nudge rating").font(.caption.weight(.semibold))
        }
        .foregroundStyle(Color(uiColor: NudgeTheme.color(0x1B202A, 0x1B202A)))
        .padding(.horizontal, 12).padding(.vertical, compact ? 8 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: NudgeTheme.color(tone.fill, tone.fill)),
                    in: RoundedRectangle(cornerRadius: 12))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(value) percent Nudge rating, \(tone.label)")
    }
}

/// Keep the entire visible label tappable, including its minimum touch area.
struct NativeSearchTouchButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(minWidth: 48, minHeight: 48)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

extension View {
    /// Keep the real accessibility identifier attached to its rendered control.
    /// Debug geometry supports hosted SwiftUI layout tests without pretending
    /// UIKit subviews represent SwiftUI's separate accessibility tree.
    @ViewBuilder func searchControl(_ identifier: String) -> some View {
        #if DEBUG
        accessibilityIdentifier(identifier)
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(key: NativeSearchRenderGeometryKey.self,
                                           value: [identifier: geometry.frame(in: .global)])
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        #else
        accessibilityIdentifier(identifier)
        #endif
    }
}

#if DEBUG
struct NativeSearchRenderGeometryKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}
#endif

/// Live geometry only stores a public product identifier as a return anchor.
private struct NativeSearchScrollAnchorKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, newest in newest })
    }
}

#if DEBUG && targetEnvironment(simulator)
import CryptoKit

/// Actual Search controls over deterministic public-shaped fixtures. This entry
/// point has no account, diary, catalogue transport or device/release code path.
@MainActor
struct NativeSearchInteractionUITestFixture: View {
    @StateObject private var model: NativeProductSearchModel
    @State private var openedProduct: BarcodeProduct?
    @State private var productPresented = false
    @State private var openCount = 0
    @State private var saved = Set<String>()

    init() {
        do {
            let source = "https://images.openfoodfacts.org/nudge-search-interaction-fixture.jpg"
            let key = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
            let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("NudgeProductImages", isDirectory: true)
            let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
                UIColor.systemGray5.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            guard let data = image.jpegData(compressionQuality: 0.8) else { preconditionFailure("Fixture thumbnail could not be encoded") }
            try data.write(to: directory.appendingPathComponent(key + ".jpg"), options: .atomic)
            let products: [BarcodeProduct] = try (1...12).map { index in
                let barcode = String(91_000_000 + index)
                let object: [String: Any] = ["product": ["code": barcode,
                    "product_name": String(format: "Synthetic beans %02d", index), "brands": "Search test fixture",
                    "image_front_url": source, "quantity": "400 g"]]
                var product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: object), barcode: barcode)
                product.imageURL = source
                return product
            }
            _model = StateObject(wrappedValue: NativeProductSearchModel(search: { query in
                ProductSearchPage(query: query, products: products, hasMore: false)
            }, lookup: { barcode in
                guard let product = products.first(where: { $0.barcode == barcode }) else { throw BarcodeLookupError.notFound }
                return product
            }))
        } catch { preconditionFailure("Synthetic Search fixture could not be prepared: \(error)") }
    }

    var body: some View {
        NativeProductSearchView(model: model,
            rating: { _ in .init(value: 75, subtitle: "Nudge rating") },
            onOpen: { product in openedProduct = product; openCount += 1; productPresented = true },
            onNavigate: { _ in }, onSaved: {}, isSaved: { saved.contains($0.barcode) },
            onToggleSave: { product in
                if saved.contains(product.barcode) { saved.remove(product.barcode) } else { saved.insert(product.barcode) }
            })
        .sheet(isPresented: $productPresented) {
            VStack(spacing: 20) {
                Text(openedProduct?.name ?? "").font(.title2)
                    .accessibilityIdentifier("search-fixture-product-title")
                Text("\(openCount) product opens").accessibilityIdentifier("search-fixture-open-count")
                Button("Back to Search") { productPresented = false }
                    .frame(minWidth: 48, minHeight: 48).accessibilityIdentifier("search-fixture-close")
            }
            .padding().accessibilityIdentifier("search-fixture-product-detail")
        }
    }
}
#endif
