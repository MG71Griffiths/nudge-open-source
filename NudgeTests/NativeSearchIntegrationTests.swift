import XCTest
import WebKit
@testable import Nudge

private final class NativeSearchTestMessages: NSObject, WKScriptMessageHandler {
    var messages: [[String: Any]] = []
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any] { messages.append(body) }
    }
}

@MainActor
final class NativeSearchIntegrationTests: XCTestCase, WKNavigationDelegate {
    private var loaded: XCTestExpectation?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }

    private func web(native: Bool, messages: NativeSearchTestMessages) throws -> WKWebView {
        let web = NudgeWebConfiguration.makeWebView(messageHandler: messages, dataStore: .nonPersistent())
        web.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        if native {
            web.configuration.userContentController.addUserScript(WKUserScript(
                source: "Object.defineProperty(window,'__nudgeNativeProductSearch',{value:true});",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web.navigationDelegate = self
        loaded = expectation(description: "Bundled app loaded")
        web.load(URLRequest(url: NudgeWebConfiguration.startURL))
        wait(for: [loaded!], timeout: 15)
        loaded = nil
        return web
    }

    private func evaluate(_ script: String, _ web: WKWebView) throws -> Any? {
        let done = expectation(description: "JavaScript result")
        var result: Any?, failure: Error?
        web.evaluateJavaScript(script) { value, error in result = value; failure = error; done.fulfill() }
        wait(for: [done], timeout: 10)
        if let failure { throw failure }
        return result
    }

    private func product(name: String = "Test chickpeas", nutrients: Bool = true) throws -> BarcodeProduct {
        var fields: [String: Any] = ["code": "1234567890123", "product_name": name,
            "brands": "Fixture", "categories_tags": ["en:chickpeas"],
            "ingredients_text": "Chickpeas (100%)", "nutrition_data_per": "100g",
            "nutrition_data_prepared": "", "nutriscore_grade": "e"]
        if nutrients {
            fields["nutriments"] = ["energy-kcal_100g": 120, "energy-kj_100g": 502,
                "fat_100g": 2, "saturated-fat_100g": 0.2, "carbohydrates_100g": 15,
                "sugars_100g": 0.5, "fiber_100g": 6, "proteins_100g": 7, "salt_100g": 0.02]
        } else {
            fields["categories_tags"] = []; fields["ingredients_text"] = ""; fields["nutriscore_grade"] = "a"
        }
        return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": fields]),
            barcode: "1234567890123", retrievedAt: Date(timeIntervalSince1970: 1_791_331_200))
    }

    func testNativeRatingMatchesExistingWebCalculatorAndDoesNotMapProviderGrade() throws {
        let messages = NativeSearchTestMessages(), engine = NativeProductRatingEngine(catalogue: nil)
        let web = try web(native: false, messages: messages)
        defer { web.stopLoading() }
        for product in [try product(), try product(name: "Unidentified packaged food", nutrients: false)] {
            let json = try XCTUnwrap(String(data: JSONEncoder().encode(product), encoding: .utf8))
            let score = try XCTUnwrap(try evaluate("NudgeFoodDetailModel.score(\(json))", web) as? [String: Any])
            let expected = (score["value"] as? NSNumber)?.intValue
            XCTAssertEqual(engine.rating(for: product).value, expected)
            if product.nutriScoreGrade == "a" { XCTAssertNil(expected, "An A letter alone never becomes 100%") }
            if product.nutriScoreGrade == "e" { XCTAssertNotEqual(expected, 0, "Use Nudge facts, not the supplied E letter") }
        }
    }

    func testReturningFromDetailUsesExactCachedFactsWithoutChangingSnapshot() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let catalogue = ProductLookupCache(directory: directory)
        let now = Date(timeIntervalSince1970: 1_791_331_200)
        let engine = NativeProductRatingEngine(catalogue: catalogue, now: { now })
        var snapshot = try product(name: "Index chickpeas", nutrients: false)
        snapshot.searchProvider = "open_food_facts_search"
        snapshot.nutritionPreparation = nil
        XCTAssertNil(engine.rating(for: snapshot).value)
        let exact = try product()
        catalogue.write(exact, now: now)
        XCTAssertEqual(engine.rating(for: snapshot).value, NativeProductRatingEngine(catalogue: nil).rating(for: exact).value)
        XCTAssertEqual(snapshot.name, "Index chickpeas")
        XCTAssertNil(snapshot.nutrients["protein"]?.value)
    }

    func testNativeDiscoveryHandsOffToExistingReviewAndOnlyConfirmationLogsOnce() throws {
        let messages = NativeSearchTestMessages()
        let web = try web(native: true, messages: messages)
        defer { web.stopLoading() }
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(product()), encoding: .utf8))
        XCTAssertEqual(try evaluate("NudgeNativeSearch.navigate('search')", web) as? Bool, true)
        let initial = try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", web) as? String
        XCTAssertEqual(try evaluate("NudgeNativeSearch.openProduct(\(json))", web) as? Bool, true)
        XCTAssertEqual(try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", web) as? String, initial)
        XCTAssertEqual(try evaluate("NudgeBarcode.detail().product.barcode", web) as? String, "1234567890123")
        _ = try evaluate("NudgeBarcode.handleAction('detail-log','');", web)
        let saved = try XCTUnwrap(try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", web) as? String)
        XCTAssertNotEqual(saved, initial)
        _ = try evaluate("NudgeBarcode.handleAction('detail-log','');", web)
        XCTAssertEqual(try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", web) as? String, saved)
        XCTAssertEqual(try evaluate("NudgeNativeSearch.navigate('search')", web) as? Bool, true)
        XCTAssertEqual(try evaluate("NudgeNativeSearch.showSaved()", web) as? Bool, true)
        XCTAssertEqual(try evaluate("NudgeNativeSearch.usesNative()", web) as? Bool, false)
        _ = try evaluate("document.querySelector('.bottom-nav [data-value=search]').click()", web)
        XCTAssertEqual(try evaluate("NudgeNativeSearch.usesNative()", web) as? Bool, true)
        XCTAssertEqual(try evaluate("localStorage.getItem('wmd-nudge-prototype-v1')", web) as? String, saved)
        XCTAssertFalse(messages.messages.contains { $0["action"] as? String == "product-search" }, "Opening categories never prefetches products")
        XCTAssertTrue(messages.messages.contains { $0["action"] as? String == "native-search-screen" && $0["active"] as? Bool == true })
    }

    func testBrowserPreviewCannotInvokeNativeHandoff() throws {
        let web = try web(native: false, messages: NativeSearchTestMessages())
        defer { web.stopLoading() }
        XCTAssertEqual(try evaluate("NudgeNativeSearch.navigate('search')", web) as? Bool, false)
        XCTAssertEqual(try evaluate("NudgeNativeSearch.showSaved()", web) as? Bool, false)
        XCTAssertEqual(try evaluate("NudgeNativeSearch.usesNative()", web) as? Bool, false)
    }
}


@MainActor
final class NativeRecipeSearchIntegrationTests: XCTestCase {
    func testLocalRecipeSearchOpensExistingDetailsAndOnlyConfirmedEditsLogIntake() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = NudgeDataStore(directory: directory)
        let initial: [String: Any] = ["version": 1, "nutritionProfile": ["saved": true],
                                     "foodLog": ["entries": [], "savedRecipes": [], "plantGoal": 30],
                                     "cycleSupport": ["enabled": false]]
        let json = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: initial), encoding: .utf8))
        let request = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: ["operation": "set", "key": "wmd-nudge-prototype-v1", "value": json]), encoding: .utf8))
        XCTAssertTrue(disk.handle(request).contains("true"))
        let app = NativeAppStore(store: disk)
        XCTAssertTrue(app.ready, app.errorMessage ?? "Recipe runtime must load")
        app.navigate("search")
        app.search.setScope(.recipe)
        let file = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let before = try Data(contentsOf: file)
        let projection = app.project("search", ["kind": "recipe", "recipeLibraryOnly": true, "livePrefixMatch": true, "query": "wal"])
        let rows = try XCTUnwrap(projection["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.compactMap { $0["id"] as? String }, ["berry"])
        XCTAssertEqual(projection["loadedProductCount"] as? Int, 0)
        XCTAssertTrue(app.perform("openRecipe", ["id": "berry"]))
        XCTAssertEqual(app.route, "recipe"); XCTAssertEqual(app.recipeID, "berry")
        let detail = app.project("recipe", ["id": "berry"])
        XCTAssertEqual(detail["id"] as? String, "berry")
        XCTAssertNotNil(detail["ingredients"]); XCTAssertNotNil(detail["steps"])
        XCTAssertEqual(try Data(contentsOf: file), before, "Finding/opening recipes must not write intake")
        XCTAssertTrue(app.perform("recipeLog", ["id": "berry"]))
        XCTAssertTrue(app.reviewPresented)
        XCTAssertEqual(try Data(contentsOf: file), before, "Choose amount opens the full editable review")
        XCTAssertTrue(app.perform("reviewUpdate", ["name": "My berry breakfast", "portions": 0.5]))
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertTrue(app.perform("reviewConfirm"))
        let entries = try XCTUnwrap((app.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])
        XCTAssertEqual(entries.count, 1); XCTAssertEqual(entries[0]["name"] as? String, "My berry breakfast")
        XCTAssertTrue(app.perform("recipeFavourite", ["id": "berry"]))
        let favourites = app.project("search", ["kind": "recipe", "recipeLibraryOnly": true, "livePrefixMatch": true, "savedOnly": true])
        XCTAssertEqual((favourites["rows"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, ["berry"])
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])?.count, 1)
    }
}
