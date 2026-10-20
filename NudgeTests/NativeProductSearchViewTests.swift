import XCTest
import SwiftUI
import UIKit
import CryptoKit
@testable import Nudge

/// Render the real SwiftUI screen with an injected catalogue, without network,
/// private app state, persisted foods, or product-image requests.
@MainActor
final class NativeProductSearchViewTests: XCTestCase {
    // SwiftUI accessibility is virtual, so UIView traversal cannot audit its
    // VoiceOver tree. These preferences inspect actual rendered geometry;
    // genuine assistive-technology coverage needs an external UI test/audit.
    private var renderedControls: [String: CGRect] = [:]

    func testDiscoveryLandingRestoresScreenshotSectionsAndFirstEightAisles() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let fixture = try CatalogueUIFixture()
        let model = fixture.model()
        var actions = 0
        let root = NativeProductSearchView(model: model,
            rating: { _ in NativeProductRating(value: nil, subtitle: "Nutrition incomplete") },
            onOpen: { _ in actions += 1 }, onNavigate: { _ in actions += 1 }, onSaved: { actions += 1 }, savedCount: 7)
            .environment(\.colorScheme, .light)
            .environment(\.dynamicTypeSize, .large)
            .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
        let host = UIHostingController(rootView: root)
        window.rootViewController = host; window.overrideUserInterfaceStyle = .light
        window.makeKeyAndVisible(); host.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        await layout(host.view)
        for identifier in ["search-saved-foods", "search-place-selector", "product-search-market", "search-filters"] +
            ["aisles", "women", "diet", "nutrition"].map({ "discovery-route-" + $0 }) {
            assertRenderedControl(identifier, in: host.view)
            let frame = try XCTUnwrap(renderedControls[identifier])
            XCTAssertGreaterThanOrEqual(frame.width + 0.001, 48)
            XCTAssertGreaterThanOrEqual(frame.height + 0.001, 48)
        }
        XCTAssertNil(renderedControls["search-scope-all"], "The restored landing starts with discovery routes")
        XCTAssertEqual(model.market, .unitedKingdom)
        XCTAssertEqual(model.discoveryRouteID, "aisles")
        attach(host.view, "Restored Search screenshot landing 390px", UITraitCollection(userInterfaceStyle: .light))
        await scrollToControl("search-category-fruit", in: host.view)
        let fruit = try XCTUnwrap(renderedControls["search-category-fruit"])
        let vegetables = try XCTUnwrap(renderedControls["search-category-vegetables"])
        XCTAssertEqual(fruit.minY, vegetables.minY, accuracy: 1, "The ordinary phone layout has two aisle columns")
        XCTAssertLessThan(fruit.maxX, vegetables.minX)
        for category in ProductSearchCategory.all.prefix(8) {
            await scrollToControl("search-category-" + category.id, in: host.view)
            assertRenderedControl("search-category-" + category.id, in: host.view)
        }
        await scrollToControl("search-show-all-aisles", in: host.view)
        assertRenderedControl("search-show-all-aisles", in: host.view)
        for category in ProductSearchCategory.all.dropFirst(8) {
            XCTAssertNil(renderedControls["search-category-" + category.id], "Remaining aisles require Show all")
        }
        XCTAssertEqual(ProductSearchCategory.all.count, 28)
        assertHorizontalFit(host.view)
        attach(host.view, "Restored Search first eight aisles and footer 390px", UITraitCollection(userInterfaceStyle: .light))
        XCTAssertTrue(fixture.requests.isEmpty); XCTAssertEqual(fixture.barcodeRequests, 0)
        XCTAssertEqual(actions, 0, "Browsing does not open or save food")
    }

    func testSquareCardsKeepRatingAndSeparateSaveInsideEqualBoundsAtNarrowAndLargeText() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let names = ["Short name", "A very long product name with a preparation and serving variant", "Unknown nutrition", "An estimated rating"]
        let ratings = [NativeProductRating(value: 75, subtitle: "Nudge rating"),
                       NativeProductRating(value: 0, subtitle: "Nudge rating"),
                       NativeProductRating(value: nil, subtitle: "Nutrition incomplete"),
                       NativeProductRating(value: 50, subtitle: "Estimated")]
        for width in [CGFloat(320), 390] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                for large in [false, true] {
                    renderedControls = [:]
                    var opened = 0, saved = 0
                    let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: large || width < 360 ? 1 : 2)
                    let root = ScrollView {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(0..<4) { index in
                                NativeProductGridCard(id: "fixture-\(index)", name: names[index], imageURL: nil,
                                    brandOrSource: index == 1 ? "A long brand and source name" : "Fixture source", rating: ratings[index],
                                    isSaved: index == 1, onOpen: { opened += 1 }, onSave: { saved += 1 })
                            }
                        }.padding(.horizontal, large ? 8 : 20).padding(.vertical, 20)
                    }
                    .background(Color(uiColor: NudgeTheme.canvas))
                    .environment(\.colorScheme, style == .dark ? .dark : .light)
                    .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                    .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
                    let host = UIHostingController(rootView: root)
                    window.rootViewController = host; window.overrideUserInterfaceStyle = style
                    window.makeKeyAndVisible(); host.view.frame = CGRect(x: 0, y: 0, width: width, height: 844)
                    await layout(host.view)
                    var expectedSide: CGFloat?
                    for index in 0..<4 {
                        let key = "fixture-\(index)"
                        await scrollToControl("grid-card-" + key, in: host.view)
                        let card = try XCTUnwrap(renderedControls["grid-card-" + key])
                        let badge = try XCTUnwrap(renderedControls["grid-rating-" + key])
                        let save = try XCTUnwrap(renderedControls["grid-save-" + key])
                        let saveSymbol = try XCTUnwrap(renderedControls["grid-save-symbol-" + key])
                        let name = try XCTUnwrap(renderedControls["grid-name-" + key])
                        let source = try XCTUnwrap(renderedControls["grid-source-" + key])
                        XCTAssertEqual(card.width, card.height, accuracy: 1, "Outer card must be square")
                        if let expectedSide { XCTAssertEqual(card.width, expectedSide, accuracy: 1) }
                        expectedSide = card.width
                        XCTAssertGreaterThanOrEqual(save.width + 0.001, 48); XCTAssertGreaterThanOrEqual(save.height + 0.001, 48)
                        XCTAssertLessThanOrEqual(saveSymbol.width, 44); XCTAssertLessThanOrEqual(saveSymbol.height, 44)
                        XCTAssertTrue(save.insetBy(dx: -1, dy: -1).contains(saveSymbol), "The bookmark symbol must fit its separate target at AX5")
                        XCTAssertGreaterThanOrEqual(badge.minY, card.minY - 1)
                        XCTAssertLessThanOrEqual(badge.maxY, card.maxY + 1, "Rating must remain inside card at AX5")
                        XCTAssertLessThanOrEqual(name.maxY, source.minY + 1, "Name and source reserve separate regions")
                        XCTAssertLessThanOrEqual(source.maxY, badge.minY + 1, "Source must not overlap the rating")
                        XCTAssertFalse(name.insetBy(dx: 1, dy: 1).intersects(save.insetBy(dx: 1, dy: 1)), "The independent Save button must not cover the product name")
                        XCTAssertLessThanOrEqual(save.maxX, card.maxX + 1)
                        assertHorizontalFit(host.view)
                        if index == 0 || index == 2 {
                            attach(host.view, "Square product cards \(Int(width))px-\(style == .dark ? "dark" : "light")-\(large ? "AX5" : "standard")-\(index)", UITraitCollection(userInterfaceStyle: style))
                        }
                    }
                    XCTAssertEqual(opened, 0); XCTAssertEqual(saved, 0)
                }
            }
        }
    }

    func testEvidenceSheetShowsNamedStagesAndBothReasonsWithoutHorizontalOverflow() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let general = ProductSupportTag(id: "fibre", label: "Fibre contribution",
            contexts: ProductSupportContext.allCases.map(\.rawValue), evidence: "established_nutrition",
            evidenceDirection: "supportive", wording: "A fibre-containing food to include as part of varied meals.",
            foodDataConfidence: "source_reported_nutrients", foodFamilies: ["flax"], sources: [], limitations: [])
        let candidate = ProductSupportTag(id: "flax", label: "Ground flax candidate", contexts: ["perimenopause"],
            evidence: "research_only", evidenceDirection: "mixed_or_null", wording: "Trials include no clear benefit.",
            foodDataConfidence: "source_reported_identity", foodFamilies: ["flax"], sources: [],
            limitations: ["This is an idea to explore, not an established treatment."])
        let review = ProductSupportReview(name: "Ground flaxseed", barcode: "10000001",
                                          tags: [general, candidate], selectedContext: .perimenopause)
        for style in [UIUserInterfaceStyle.light, .dark] {
            for large in [false, true] {
                renderedControls = [:]
                let root = ProductSupportReviewSheet(review: review)
                    .environment(\.colorScheme, style == .dark ? .dark : .light)
                    .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                    .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
                let host = UIHostingController(rootView: root)
                window.rootViewController = host; window.overrideUserInterfaceStyle = style
                window.makeKeyAndVisible()
                host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
                await layout(host.view)
                assertRenderedControl("support-review-phase", in: host.view)
                assertHorizontalFit(host.view)
                let label = "\(style == .dark ? "dark" : "light") — \(large ? "AX5" : "standard")"
                let traits = UITraitCollection(userInterfaceStyle: style)
                attach(host.view, "Food reasons sheet — \(label)", traits)
                // Each name remains visible and readable without depending on
                // colour, including phases that a general nutrition idea spans.
                for context in ProductSupportContext.allCases {
                    let identifier = "support-review-phase-fibre-\(context.rawValue)"
                    await scrollToControl(identifier, in: host.view)
                    assertRenderedControl(identifier, in: host.view)
                    assertHorizontalFit(host.view)
                }
                attach(host.view, "Food reasons named stages — \(label)", traits)
                for identifier in ["support-review-reason-fibre", "support-review-reason-flax"] {
                    await scrollToControl(identifier, in: host.view)
                    assertRenderedControl(identifier, in: host.view)
                    assertHorizontalFit(host.view)
                }
                attach(host.view, "Food reasons uncertainty — \(label)", traits)
            }
        }
    }

    func testDiscoverySheetsRemainReadableAt320WithLargestText() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for style in [UIUserInterfaceStyle.light, .dark] {
            for large in [false, true] {
                var changes = 0
                let fixtures: [(String, AnyView, [String])] = [
                    ("Place directory", AnyView(NativeSearchPlacesSheet(selected: nil, onSelect: { _ in changes += 1 })),
                     ["search-place-query", "search-place-all", "search-place-group-supermarket", "search-place-group-cafe", "search-place-group-restaurant"]),
                    ("Dietary and nutrition filters", AnyView(NativeSearchFiltersSheet(dietary: [.milk, .gluten], nutrition: [.calcium], mode: .all,
                        onApply: { _, _, _ in changes += 1 })),
                     ["filter-diet-milk", "filter-diet-wheat", "filter-nutrition-wholegrain", "filter-mode-any", "filter-mode-all", "filters-apply"]),
                    ("Women’s nutrition guide", AnyView(NativeNutritionGuideSheet(guide: .perimenopause, onChoose: { _ in changes += 1 })),
                     ["guide-choice-calcium", "guide-choice-vitd"])
                ]
                for (name, fixture, controls) in fixtures {
                    renderedControls = [:]
                    let root = fixture
                        .environment(\.colorScheme, style == .dark ? .dark : .light)
                        .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                        .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
                    let host = UIHostingController(rootView: root)
                    window.rootViewController = host; window.overrideUserInterfaceStyle = style
                    window.makeKeyAndVisible(); host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
                    await layout(host.view)
                    let traits = UITraitCollection(userInterfaceStyle: style)
                    attach(host.view, "\(name) 320px-\(style == .dark ? "dark" : "light")-\(large ? "AX5" : "standard")", traits)
                    for identifier in controls {
                        await scrollToControl(identifier, in: host.view)
                        assertRenderedControl(identifier, in: host.view)
                        assertHorizontalFit(host.view)
                        let frame = try XCTUnwrap(renderedControls[identifier])
                        XCTAssertGreaterThanOrEqual(frame.width + 0.001, 48)
                        XCTAssertGreaterThanOrEqual(frame.height + 0.001, 48)
                    }
                    attach(host.view, "\(name) final choices 320px-\(style == .dark ? "dark" : "light")-\(large ? "AX5" : "standard")", traits)
                }
                XCTAssertEqual(changes, 0, "Displaying filter drafts or guides must not change the search or create network work")
            }
        }
    }

    func testBrightRatingBadgesAtStandardAndLargestTextInBothAppearances() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for style in [UIUserInterfaceStyle.light, .dark] {
            for large in [false, true] {
                let root = ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        NativeNudgeRatingBadge(value: 25)
                        NativeNudgeRatingBadge(value: 55)
                        NativeNudgeRatingBadge(value: 90)
                        NativeNudgeRatingBadge(value: 75, compact: true)
                    }.padding(20)
                }
                .background(Color(uiColor: NudgeTheme.canvas))
                .environment(\.colorScheme, style == .dark ? .dark : .light)
                .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                let host = UIHostingController(rootView: root)
                window.rootViewController = host
                window.overrideUserInterfaceStyle = style
                window.makeKeyAndVisible()
                host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
                await layout(host.view)
                assertHorizontalFit(host.view)
                attach(host.view, "Bright RAG ratings — \(style == .dark ? "dark" : "light") — \(large ? "AX5" : "standard")",
                       UITraitCollection(userInterfaceStyle: style))
            }
        }
    }

    func testIndividualRatingFallbackLoadsVisibleRowsWithinReadBudget() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        renderedControls = [:]
        // This explicitly exercises the legacy individual fallback. Stay below
        // its 12/minute source budget; production 20-card batches have separate tests.
        let fixtureImage = try CatalogueUIImageFixture.cachedSource()
        let products = try (0..<10).map { index -> BarcodeProduct in
            let code = String(10000001 + index)
            var product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: [
                "product": ["code": code, "product_name": "Fixture yoghurt \(index)"]
            ]), barcode: code)
            product.searchProvider = "open_food_facts_search"
            product.imageURL = fixtureImage
            return product
        }
        let model = NativeProductSearchModel(search: { query in
            ProductSearchPage(query: query, products: products, hasMore: false)
        }, lookup: { _ in throw BarcodeLookupError.notFound })
        let engine = NativeProductRatingEngine(catalogue: nil)
        var requests = Set<String>()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { snapshot in
            requests.insert(snapshot.barcode)
            var full = snapshot
            full.searchProvider = nil
            return full
        }, minimumRequestSpacing: 0)
        defer { loader.cancel(); model.cancel() }
        let root = NativeProductSearchView(model: model, rating: engine.rating(for:),
            onOpen: { _ in }, onNavigate: { _ in }, onSaved: {}, ratingLoader: loader)
            .environment(\.dynamicTypeSize, .large)
            .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
        let host = UIHostingController(rootView: root)
        let parent = UIViewController()
        parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
        window.rootViewController = parent
        window.makeKeyAndVisible()
        parent.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        host.view.frame = parent.view.bounds
        model.submit("yoghurt")
        try await waitUntil { !model.loading }
        await layout(host.view)
        try await waitUntil { !requests.isEmpty }
        let firstViewportCount = requests.count
        XCTAssertLessThan(firstViewportCount, products.count,
                          "Initial rendering must not hydrate the entire result page before scrolling")
        await scrollToControl("search-product-10000010", in: host.view)
        try await waitUntil { requests.contains("10000010") }
        XCTAssertGreaterThan(requests.count, firstViewportCount, "Scrolling to a product starts its rating recovery")
        attach(host.view, "Native Search visible rating recovery — 390px", UITraitCollection(userInterfaceStyle: .light))
    }

    func testProductDiscoveryLayoutsAndStatesInBothAppearances() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }

        for width in [CGFloat(320), 390] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                for large in [false, true] {
                    renderedControls = [:]
                    let fixture = try CatalogueUIFixture()
                    let model = fixture.model()
                    var opened: [String] = []
                    var navigation: [String] = []
                    var saved = 0
                    let root = NativeProductSearchView(model: model,
                        rating: { product in
                            product.barcode == "10000001"
                                ? NativeProductRating(value: 75, subtitle: "Nudge nutrition score · fixture")
                                : NativeProductRating(value: nil, subtitle: "More label data needed")
                        }, onOpen: { opened.append($0.barcode) }, onNavigate: { navigation.append($0) }, onSaved: { saved += 1 })
                        .environment(\.colorScheme, style == .dark ? .dark : .light)
                        .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                        .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] frames in
                            self?.renderedControls = frames
                        }
                    let host = UIHostingController(rootView: root)
                    let parent = UIViewController()
                    parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
                    let traits = UITraitCollection(traitsFrom: [
                        UITraitCollection(userInterfaceStyle: style),
                        UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large),
                        UITraitCollection(accessibilityContrast: large ? .high : .normal)
                    ])
                    parent.setOverrideTraitCollection(traits, forChild: host)
                    window.rootViewController = parent
                    window.overrideUserInterfaceStyle = style
                    window.makeKeyAndVisible()
                    host.overrideUserInterfaceStyle = style
                    let size = CGRect(x: 0, y: 0, width: width, height: 844)
                    parent.view.frame = size; host.view.frame = size
                    parent.view.layoutIfNeeded()
                    await layout(host.view)
                    let label = "\(Int(width))px-\(style == .dark ? "dark" : "light")-\(large ? "AX5" : "standard")"

                    // Mounting and typing are local and cannot start product lookups.
                    XCTAssertTrue(fixture.requests.isEmpty)
                    XCTAssertTrue(model.isBrowsing)
                    assertSearchStructure(host.view, landing: true)
                    assertHorizontalFit(host.view)
                    attach(host.view, "Native Search landing \(label)", traits)
                    // At AX5 the first lazy grid row starts below the viewport.
                    // Let scrolling materialize it before inspecting its frame.
                    await scrollToControl("search-category-fruit", in: host.view)
                    assertRenderedControl("search-category-fruit", in: host.view)
                    if large {
                        attach(host.view, "Native Search category tiles \(label)", traits)
                    }

                    fixture.mode = .suspended
                    model.select(try XCTUnwrap(ProductSearchCategory.all.first { $0.id == "yoghurt" }))
                    try await waitUntil { fixture.pending != nil }
                    await layout(host.view)
                    XCTAssertTrue(model.loading)
                    XCTAssertTrue(model.products.isEmpty)
                    assertRenderedControl("product-search-loading", in: host.view)
                    if large { await scrollToControl("product-search-loading", in: host.view) }
                    attach(host.view, "Native Search loading \(label)", traits)

                    fixture.resolveProducts()
                    try await waitUntil { !model.loading }
                    await layout(host.view)
                    XCTAssertEqual(model.products.map(\.barcode), ["10000001", "10000002"])
                    XCTAssertTrue(model.hasMore)
                    assertSearchStructure(host.view, landing: false)
                    assertHorizontalFit(host.view)
                    if large { await scrollToControl("search-product-10000001", in: host.view) }
                    attach(host.view, "Native Search products rated-and-unknown \(label)", traits)
                    await scrollToControl("product-search-more", in: host.view)
                    assertRenderedControl("product-search-more", in: host.view)
                    attach(host.view, "Native Search products footer \(label)", traits)

                    fixture.mode = .failure
                    model.loadMore()
                    try await waitUntil { !model.loading }
                    await layout(host.view)
                    XCTAssertEqual(fixture.requests.last?.page, 2)
                    XCTAssertEqual(model.products.count, 2, "A later-page failure must leave visible products intact")
                    XCTAssertNotNil(model.errorMessage)
                    await scrollToControl("product-search-error", in: host.view)
                    assertRenderedControl("product-search-retry", in: host.view)
                    assertRenderedControl("product-search-error", in: host.view)
                    assertHorizontalFit(host.view)
                    attach(host.view, "Native Search later-page failure \(label)", traits)

                    // Retry resumes page two without losing or duplicating page one.
                    fixture.mode = .products
                    model.retry()
                    try await waitUntil { !model.loading }
                    XCTAssertEqual(fixture.requests.last?.page, 2)
                    XCTAssertEqual(model.products.count, 2)
                    XCTAssertNil(model.errorMessage)

                    fixture.mode = .failure
                    model.submit("Fixture first-page error")
                    try await waitUntil { !model.loading }
                    await layout(host.view)
                    XCTAssertTrue(model.products.isEmpty)
                    assertRenderedControl("product-search-error", in: host.view)
                    assertHorizontalFit(host.view)
                    if large { await scrollToControl("product-search-error", in: host.view) }
                    attach(host.view, "Native Search first-page error \(label)", traits)
                    if large {
                        await scrollToControl("product-search-retry", in: host.view)
                        attach(host.view, "Native Search first-page error actions \(label)", traits)
                    }

                    fixture.mode = .empty
                    model.submit("Fixture no matches")
                    try await waitUntil { !model.loading }
                    await layout(host.view)
                    XCTAssertTrue(model.products.isEmpty)
                    XCTAssertFalse(model.hasMore)
                    XCTAssertNil(model.errorMessage)
                    assertRenderedControl("product-search-empty", in: host.view)
                    assertHorizontalFit(host.view)
                    if large { await scrollToControl("product-search-empty", in: host.view) }
                    attach(host.view, "Native Search empty \(label)", traits)

                    XCTAssertTrue(opened.isEmpty, "Rendering never opens a product or logs intake")
                    XCTAssertTrue(navigation.isEmpty)
                    XCTAssertEqual(saved, 0)
                    XCTAssertEqual(fixture.barcodeRequests, 0)
                    model.cancel()
                    host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
                }
            }
        }
    }

    func testFocusedSearchHasLargeFieldAndSuggestionTargetsAtSmallAndAccessibleSizes() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for large in [false, true] {
            renderedControls = [:]
            let fixture = try CatalogueUIFixture()
            let model = fixture.model()
            model.query = "yog"
            let root = NativeProductSearchView(model: model,
                rating: { _ in NativeProductRating(value: nil, subtitle: "Nutrition incomplete") },
                onOpen: { _ in XCTFail("Typing must not open food") }, onNavigate: { _ in }, onSaved: {})
                .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
            let host = UIHostingController(rootView: root)
            window.rootViewController = host; window.makeKeyAndVisible()
            host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
            await layout(host.view)
            let input = try XCTUnwrap(descendants(host.view).compactMap { $0 as? UITextField }.first)
            XCTAssertTrue(input.becomeFirstResponder())
            await layout(host.view)
            for identifier in ["product-search-input", "product-search-clear", "product-search-submit"] + model.suggestions.map({ "product-search-suggestion-" + $0 }) {
                let frame = try XCTUnwrap(renderedControls[identifier], "Missing \(identifier)")
                XCTAssertGreaterThanOrEqual(frame.height + 0.01, 48)
                XCTAssertGreaterThanOrEqual(frame.width + 0.01, 48)
            }
            XCTAssertFalse(model.suggestions.isEmpty)
            XCTAssertNil(renderedControls["search-place-selector"], "Focus reserves room for suggestions above the keyboard")
            assertHorizontalFit(host.view)
            attach(host.view, "Focused Search 320px-\(large ? "AX5" : "standard")", UITraitCollection(userInterfaceStyle: .light))
            XCTAssertTrue(fixture.requests.isEmpty, "Typing must show instant suggestions without a catalogue request")
            input.resignFirstResponder()
        }
    }

    func testCompactSearchRowsKeepIndependentTargetsAndUnratedLabelsAtPhoneSizes() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for (width, large, dark) in [(CGFloat(320), false, false), (CGFloat(390), false, true), (CGFloat(320), true, false)] {
            renderedControls = [:]
            var opened = 0, saved = 0
            let root = ScrollView {
                VStack(spacing: 0) {
                    NativeProductSearchRow(id: "rated", name: "Roasted almond butter with a very long product name", imageURL: nil,
                        brandOrSource: "Example Foods", rating: .init(value: 75, subtitle: "Nudge rating"), isSaved: false,
                        onOpen: { opened += 1 }, onSave: { saved += 1 })
                    NativeProductSearchRow(id: "unknown", name: "Mixed berry yoghurt", imageURL: nil,
                        brandOrSource: "Example dairy", rating: .init(value: nil, subtitle: "Nutrition incomplete"), isSaved: true,
                        onOpen: { opened += 1 }, onSave: { saved += 1 })
                }.padding(.horizontal, large ? 8 : 20)
            }
            .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
            .environment(\.colorScheme, dark ? .dark : .light)
            .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
            let host = UIHostingController(rootView: root)
            window.rootViewController = host; window.overrideUserInterfaceStyle = dark ? .dark : .light
            window.makeKeyAndVisible(); host.view.frame = CGRect(x: 0, y: 0, width: width, height: 844)
            await layout(host.view)
            for id in ["rated", "unknown"] {
                await scrollToControl("search-row-" + id, in: host.view)
                let row = try XCTUnwrap(renderedControls["search-row-" + id])
                let open = try XCTUnwrap(renderedControls["search-product-" + id])
                let save = try XCTUnwrap(renderedControls["search-row-save-" + id])
                let rating = try XCTUnwrap(renderedControls["search-row-rating-" + id])
                XCTAssertGreaterThanOrEqual(open.height, 48)
                XCTAssertGreaterThanOrEqual(save.width, 48); XCTAssertGreaterThanOrEqual(save.height, 48)
                XCTAssertLessThanOrEqual(open.maxX, save.minX + 1, "Open and save must be separate targets")
                XCTAssertTrue(row.insetBy(dx: -1, dy: -1).contains(rating), "Rating must remain inside the row")
                XCTAssertTrue(row.insetBy(dx: -1, dy: -1).contains(save), "Save must remain inside the row")
                if !large { XCTAssertLessThan(row.height, 135, "Ordinary results must be compact rows") }
            }
            assertHorizontalFit(host.view)
            attach(host.view, "Compact Search rows \(Int(width))px-\(large ? "AX5" : "standard")-\(dark ? "dark" : "light")", UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
            XCTAssertEqual(opened, 0); XCTAssertEqual(saved, 0, "Rendering never opens or saves a product")
        }
    }

    func testLiveResultsKeepKeyboardAndFieldStableWithStaticLoadingPlaceholders() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        renderedControls = [:]
        let fixture = try CatalogueUIFixture(); fixture.mode = .suspended
        let model = fixture.model()
        var actions = 0
        let root = NativeProductSearchView(model: model,
            rating: { _ in .init(value: nil, subtitle: "Nutrition incomplete") },
            onOpen: { _ in actions += 1 }, onNavigate: { _ in actions += 1 }, onSaved: { actions += 1 })
            // SwiftUI exposes Reduce Motion as read-only. Exercise the same
            // static-placeholder branch through the writable scene phase;
            // real assistive-setting behavior still needs a device/UI audit.
            .environment(\.scenePhase, .inactive)
            .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
        let host = UIHostingController(rootView: root)
        window.rootViewController = host; window.makeKeyAndVisible()
        host.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        await layout(host.view)
        let input = try XCTUnwrap(descendants(host.view).compactMap { $0 as? UITextField }.first)
        XCTAssertTrue(input.becomeFirstResponder()); await layout(host.view)
        let before = try XCTUnwrap(renderedControls["product-search-input"])
        model.updateLiveQuery("Huel")
        try await waitUntil { fixture.pending != nil }
        await layout(host.view)
        XCTAssertTrue(input.isFirstResponder, "Live requests must keep the keyboard open")
        let during = try XCTUnwrap(renderedControls["product-search-input"])
        XCTAssertEqual(before.minY, during.minY, accuracy: 1)
        XCTAssertNotNil(renderedControls["search-loading-static"])
        XCTAssertNil(renderedControls["search-loading-shimmer"], "An inactive scene must suppress the sweeping animation")
        XCTAssertNil(renderedControls["search-product-10000001"], "Loading placeholders must not masquerade as products")
        attach(host.view, "Live Search grey placeholders and focused field", UITraitCollection(userInterfaceStyle: .light))
        fixture.resolveProducts()
        try await waitUntil { !model.loading }
        await layout(host.view)
        XCTAssertTrue(input.isFirstResponder)
        XCTAssertNotNil(renderedControls["search-row-10000001"], "Results remain visible while the keyboard is focused")
        XCTAssertNil(renderedControls["product-search-loading"])
        let after = try XCTUnwrap(renderedControls["product-search-input"])
        XCTAssertEqual(during.minY, after.minY, accuracy: 1)
        XCTAssertEqual(during.height, after.height, accuracy: 1)
        XCTAssertEqual(model.query, "Huel"); XCTAssertEqual(actions, 0)
        attach(host.view, "Live Search compact results and focused field", UITraitCollection(userInterfaceStyle: .light))
        input.resignFirstResponder()
        model.cancel()
    }

    func testLocalCategoriesAppearAbovePendingProductsWhileTyping() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        renderedControls = [:]
        let fixture = try CatalogueUIFixture(); fixture.mode = .suspended
        let model = fixture.model()
        var actions = 0
        let root = NativeProductSearchView(model: model,
            rating: { _ in .init(value: nil, subtitle: "Nutrition incomplete") },
            onOpen: { _ in actions += 1 }, onNavigate: { _ in actions += 1 }, onSaved: { actions += 1 })
            .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
        let host = UIHostingController(rootView: root)
        window.rootViewController = host; window.makeKeyAndVisible()
        host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
        await layout(host.view)
        let input = try XCTUnwrap(descendants(host.view).compactMap { $0 as? UITextField }.first)
        XCTAssertTrue(input.becomeFirstResponder())
        model.updateLiveQuery("beans")
        try await waitUntil { fixture.pending != nil }
        await layout(host.view)
        let category = try XCTUnwrap(renderedControls["search-category-suggestion-pulses"])
        let loading = try XCTUnwrap(renderedControls["product-search-loading"])
        XCTAssertLessThan(category.maxY, loading.minY, "Local categories precede product placeholders")
        XCTAssertGreaterThanOrEqual(category.height, 48)
        XCTAssertTrue(input.isFirstResponder)
        XCTAssertTrue(model.products.isEmpty, "Category routes need no returned products")
        assertHorizontalFit(host.view)
        attach(host.view, "Local category suggestions above loading products", UITraitCollection(userInterfaceStyle: .light))
        fixture.mode = .empty; fixture.resolveProducts()
        try await waitUntil { !model.loading }
        // AppShellGestureTests taps the actual category button and checks the
        // keyboard window. Calling model.select here would bypass that action.
        XCTAssertEqual(actions, 0)
        input.resignFirstResponder(); model.cancel()
    }

    func testRecipesAreDiscoverableAndLocalResultsRemainVisibleWithKeyboardAtLargeText() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for large in [false, true] {
            renderedControls = [:]
            let fixture = try CatalogueUIFixture(), model = fixture.model()
            var opened = 0, saved = 0
            let root = NativeProductSearchView(model: model,
                rating: { _ in .init(value: nil, subtitle: "Nutrition incomplete") },
                onOpen: { _ in XCTFail("Recipes must not open a product") }, onNavigate: { _ in }, onSaved: {},
                recipeSearch: { query, savedOnly in
                    let rows: [[String: Any]] = query.isEmpty || "berry".contains(query.lowercased())
                        ? [["kind": "recipe", "id": "berry", "name": "Berry, oat and yoghurt breakfast bowl", "subtitle": "Recipe · Breakfast · 5 min", "score": 75]] : []
                    return ["recipeCount": 4, "rows": rows, "excludedCount": 0]
                }, savedRecipeIDs: ["berry"], onOpenRecipe: { _ in opened += 1 }, onToggleRecipeSaved: { _ in saved += 1 })
                .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                .onPreferenceChange(NativeSearchRenderGeometryKey.self) { [weak self] in self?.renderedControls = $0 }
            let host = UIHostingController(rootView: root)
            window.rootViewController = host; window.makeKeyAndVisible()
            host.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
            await layout(host.view)
            for identifier in ["search-kind-product", "search-kind-recipe"] {
                let frame = try XCTUnwrap(renderedControls[identifier])
                XCTAssertGreaterThanOrEqual(frame.height, 48); XCTAssertGreaterThanOrEqual(frame.width, 48)
                assertRenderedControl(identifier, in: host.view)
            }
            model.setScope(.recipe)
            await layout(host.view)
            XCTAssertNotNil(renderedControls["search-recipe-library"])
            XCTAssertNil(renderedControls["search-place-selector"], "Product retailer filters must not imply recipe filtering")
            let field = try XCTUnwrap(descendants(host.view).compactMap { $0 as? UITextField }.first)
            XCTAssertTrue(field.becomeFirstResponder()); await layout(host.view)
            model.updateLiveQuery("ber")
            await layout(host.view)
            XCTAssertTrue(field.isFirstResponder)
            XCTAssertFalse(model.loading); XCTAssertFalse(model.isDebouncing)
            XCTAssertNotNil(renderedControls["search-row-recipe-berry"])
            XCTAssertNotNil(renderedControls["search-row-save-recipe-berry"])
            XCTAssertNil(renderedControls["product-search-loading"])
            XCTAssertTrue(fixture.requests.isEmpty, "Local recipe typing must not call the product catalogue")
            assertHorizontalFit(host.view)
            attach(host.view, "Search Recipes local results 320px-\(large ? "AX5" : "standard")", UITraitCollection(userInterfaceStyle: .light))
            XCTAssertEqual(opened, 0); XCTAssertEqual(saved, 0)
            field.resignFirstResponder(); model.cancel()
        }
    }

    private func assertSearchStructure(_ view: UIView, landing: Bool, file: StaticString = #filePath, line: UInt = #line) {
        assertRenderedControl("product-search-input", in: view, file: file, line: line)
        assertRenderedControl("product-search-market", in: view, file: file, line: line)
        assertRenderedControl("search-place-selector", in: view, file: file, line: line)
        assertRenderedControl("search-filters", in: view, file: file, line: line)
        for tab in ["today", "history", "camera", "search", "you"] {
            assertRenderedControl("search-nav-\(tab)", in: view, file: file, line: line)
        }
        if !landing {
            assertRenderedControl("search-all-categories", in: view, file: file, line: line)
            assertRenderedControl("product-search-sort", in: view, file: file, line: line)
        }
        let fields = descendants(view).compactMap { $0 as? UITextField }
        XCTAssertFalse(fields.isEmpty, "The native search field must remain a real editable control", file: file, line: line)
        for field in fields {
            XCTAssertGreaterThan(field.bounds.width, 44, file: file, line: line)
            XCTAssertGreaterThanOrEqual(field.bounds.height, field.font?.lineHeight ?? 0, file: file, line: line)
        }
    }

    private func assertHorizontalFit(_ view: UIView, file: StaticString = #filePath, line: UInt = #line) {
        let scrolls = descendants(view).compactMap { $0 as? UIScrollView }.filter { !($0 is UITextView) }
        XCTAssertFalse(scrolls.isEmpty, "Long category/result content must scroll", file: file, line: line)
        for scroll in scrolls where scroll.bounds.width > 40 {
            let frame = scroll.convert(scroll.bounds, to: nil)
            let isScopeStrip = ["search-scope-strip", "search-filter-strip"].contains { identifier in
                guard let strip = renderedControls[identifier] else { return false }
                return abs(frame.minY - strip.minY) < 2 && abs(frame.height - strip.height) < 2
            }
            if isScopeStrip { continue } // The deliberately horizontal filter chips are independently scrollable.
            XCTAssertLessThanOrEqual(scroll.contentSize.width, scroll.bounds.width + 1,
                                     "Rows, cards and vertical content must fit the phone width", file: file, line: line)
        }
    }

    private func assertRenderedControl(_ identifier: String, in view: UIView, file: StaticString = #filePath, line: UInt = #line) {
        guard let frame = renderedControls[identifier] else {
            XCTFail("Missing rendered control/state: \(identifier)", file: file, line: line)
            return
        }
        XCTAssertGreaterThan(frame.width, 0, file: file, line: line)
        XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
        if identifier.hasPrefix("search-nav-") || identifier.hasPrefix("search-category-") ||
            ["product-search-submit", "product-search-more", "product-search-retry", "search-all-categories",
             "product-search-market", "search-place-selector", "search-filters", "product-search-clear-store"].contains(identifier) {
            XCTAssertGreaterThanOrEqual(frame.width + 0.001, 48, "Action needs a usable tap width: \(identifier)", file: file, line: line)
            XCTAssertGreaterThanOrEqual(frame.height + 0.001, 48, "Action needs a usable tap height: \(identifier)", file: file, line: line)
        }
        // Scope chips are intentionally in a horizontal strip. Their 48pt
        // target size is checked above; offscreen chips remain reachable by pan.
        if ["product-search-market", "search-place-selector", "search-filters", "product-search-sort"].contains(identifier) || identifier.hasPrefix("search-chip-") { return }
        let viewport = view.convert(view.bounds, to: nil)
        XCTAssertGreaterThanOrEqual(frame.minX, viewport.minX - 1, "Control must fit the phone width: \(identifier)", file: file, line: line)
        XCTAssertLessThanOrEqual(frame.maxX, viewport.maxX + 1, "Control must fit the phone width: \(identifier)", file: file, line: line)
    }

    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }

    private func layout(_ view: UIView) async {
        view.setNeedsLayout(); view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 150_000_000)
        view.layoutIfNeeded()
    }

    private func scrollToControl(_ identifier: String, in view: UIView) async {
        guard let scroll = descendants(view).compactMap({ $0 as? UIScrollView }).max(by: { $0.contentSize.height < $1.contentSize.height }) else {
            XCTFail("No scrolling container for \(identifier)")
            return
        }
        if renderedControls[identifier] == nil {
            // LazyVGrid has no geometry for offscreen children. Traverse the
            // actual scroll view in bounded viewport steps, just as a user
            // would, and refresh its changing content extent each time.
            scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
            await layout(view)
            for _ in 0..<40 {
                if renderedControls[identifier] != nil { break }
                let maximum = max(-scroll.adjustedContentInset.top,
                    scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                let next = min(maximum, scroll.contentOffset.y + max(160, scroll.bounds.height * 0.55))
                if next <= scroll.contentOffset.y + 1 { break }
                scroll.setContentOffset(CGPoint(x: 0, y: next), animated: false)
                await layout(view)
            }
        }
        guard let frame = renderedControls[identifier] else {
            XCTFail("Control did not materialize while scrolling: \(identifier)")
            return
        }
        let viewport = scroll.convert(scroll.bounds, to: nil)
        let target = scroll.contentOffset.y + frame.minY - viewport.minY - 18
        let maximum = max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        scroll.setContentOffset(CGPoint(x: 0, y: min(maximum, max(-scroll.adjustedContentInset.top, target))), animated: false)
        await layout(view)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Injected catalogue did not settle")
    }

    private func attach(_ view: UIView, _ name: String, _ traits: UITraitCollection) {
        traits.performAsCurrent {
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
                view.layer.render(in: context.cgContext)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = name + " — isolated fixtures, no network"
            attachment.lifetime = .keepAlways
            add(attachment)
            // These renders contain only injected fixtures. Retain the PNGs
            // independently when simulator xcresult collection stalls.
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NUDGE-QA-NativeProductSearchViewTests", isDirectory: true)
            let filename = name.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? String($0) : "-" }.joined() + ".png"
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent(filename)
                try XCTUnwrap(image.pngData()).write(to: file, options: .atomic)
                print("NUDGE_QA_RENDER " + file.path)
            } catch { XCTFail("Could not retain isolated Search render: \(error)") }
        }
    }
}

@MainActor
private enum CatalogueUIImageFixture {
    /// BarcodeProduct deliberately rejects local asset paths. Seed a tiny public-
    /// image cache entry instead, so real cards never invoke barcode-image lookup
    /// or image transport. This cache belongs to the isolated hosted test app.
    static func cachedSource() throws -> String {
        let source = "https://images.openfoodfacts.org/nudge-ui-fixture-placeholder.jpg"
        let key = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NudgeProductImages", isDirectory: true)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.systemGray5.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let data = try XCTUnwrap(image.jpegData(compressionQuality: 0.8))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent(key + ".jpg"), options: .atomic)
        return source
    }
}

@MainActor
private final class CatalogueUIFixture {
    enum Mode { case suspended, products, failure, empty }
    var mode = Mode.empty
    var requests: [ProductSearchQuery] = []
    var barcodeRequests = 0
    var pending: CheckedContinuation<ProductSearchPage, Error>?
    private let products: [BarcodeProduct]

    init() throws {
        let fixtureImage = try CatalogueUIImageFixture.cachedSource()
        products = try [
            ["code": "10000001", "product_name": "Fixture natural yoghurt", "brands": "Example dairy", "quantity": "500 g"],
            ["code": "10000002", "product_name": "Fixture strawberry yoghurt with an intentionally longer product name", "brands": "Example incomplete record", "quantity": "4 × 125 g"]
        ].map { record in
            var product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": record]), barcode: record["code"]!)
            product.imageURL = fixtureImage
            return product
        }
    }

    func model() -> NativeProductSearchModel {
        NativeProductSearchModel(search: { [self] query in
            requests.append(query)
            switch mode {
            case .suspended:
                return try await withCheckedThrowingContinuation { pending = $0 }
            case .products:
                return ProductSearchPage(query: query, products: products, hasMore: query.page == 1)
            case .failure:
                throw ProductSearchError.unavailable
            case .empty:
                return ProductSearchPage(query: query, products: [], hasMore: false)
            }
        }, lookup: { [self] _ in
            barcodeRequests += 1
            throw ProductSearchError.unavailable
        })
    }

    func resolveProducts() {
        guard let query = requests.last else { return }
        let continuation = pending
        pending = nil
        continuation?.resume(returning: ProductSearchPage(query: query, products: products, hasMore: true))
    }
}
