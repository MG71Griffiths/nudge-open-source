import XCTest
import Combine
import SwiftUI
import UIKit
@testable import Nudge

/// Hosted native screens use only synthetic records in a temporary native store.
/// Rendering must neither fetch products nor write confirmed diary data.
@MainActor
final class NativeAppScreensTests: XCTestCase {
    private var controls: [String: CGRect] = [:]

    func testHostedReviewSheetDismissesToTheSameHistoryScrollPosition() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let fixture = try NativeScreenFixture()
        defer { window.isHidden = true; previous?.makeKeyAndVisible(); try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        for index in 0..<16 {
            XCTAssertTrue(store.perform("recordHistory", ["id": "sheet-list-\(index)", "kind": "meal", "status": "ready",
                "name": "Synthetic saved meal \(index)", "extraction": ["type": "meal", "productName": "Synthetic saved meal \(index)",
                "meal": ["name": "Synthetic saved meal \(index)", "components": []], "nutrients": [String: Any]()]]))
        }
        let before = try Dictionary(uniqueKeysWithValues: fixture.original.keys.map { ($0, try XCTUnwrap(fixture.read($0))) })
        store.navigate("history")
        let host = UIHostingController(rootView: NativeAppShell(store: store).environment(\.dynamicTypeSize, .large))
        window.rootViewController = host; window.makeKeyAndVisible()
        await layout(host.view)
        let originalScroll = try XCTUnwrap(scrollViews(host.view).max(by: { $0.contentSize.height < $1.contentSize.height }))
        let maximumOffset = originalScroll.contentSize.height - originalScroll.bounds.height + originalScroll.adjustedContentInset.bottom
        XCTAssertGreaterThan(maximumOffset, 150, "The fixture must exercise a scrolled History list")
        originalScroll.setContentOffset(CGPoint(x: 0, y: min(240, maximumOffset)), animated: false)
        await layout(host.view)
        let originalOffset = originalScroll.contentOffset.y
        let entry = try XCTUnwrap(((store.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])?.first)
        store.openRecent(["entry": entry])
        for _ in 0..<100 where host.presentedViewController == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        let sheet = try XCTUnwrap(host.presentedViewController, "The shell must present a native review sheet")
        await layout(sheet.view)
        XCTAssertNotNil(sheet.sheetPresentationController)
        XCTAssertTrue(scrollViews(host.view).contains { $0 === originalScroll }, "Opening review must keep the History list mounted")
        XCTAssertTrue(store.perform("reviewUpdate", ["name": "Unsaved sheet-only edit"]))
        attach(sheet.view, "Native shell review sheet", UITraitCollection(preferredContentSizeCategory: .large))
        store.reviewPresented = false
        for _ in 0..<100 where host.presentedViewController != nil { try await Task.sleep(nanoseconds: 10_000_000) }
        await layout(host.view)
        XCTAssertNil(host.presentedViewController)
        XCTAssertEqual(store.selectedTab, "history")
        XCTAssertNil(store.route)
        XCTAssertTrue(scrollViews(host.view).contains { $0 === originalScroll }, "Dismissal must restore the identical list instance")
        XCTAssertEqual(originalScroll.contentOffset.y, originalOffset, accuracy: 1)
        for (key, value) in before { XCTAssertEqual(try fixture.read(key), value, "Sheet presentation and cancellation cannot save draft edits") }
    }

    func testReviewSheetReturnsToItsListAndDoesNotSaveDismissedDrafts() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        let entry = try XCTUnwrap(((store.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])?.first)
        store.showFoodLibrary(mode: "recents", day: "2026-10-11", meal: "Lunch")
        store.openRecent(["entry": entry])
        XCTAssertTrue(store.reviewPresented)
        XCTAssertEqual(store.presentationRoute, "foodLibrary", "The underlying list must stay mounted")
        XCTAssertTrue(store.perform("reviewUpdate", ["name": "Unsaved sheet edit", "quantity": 2]))
        store.openRecent(["entry": entry])
        XCTAssertEqual(store.presentationRoute, "foodLibrary", "Replacing the review must not make review its own return route")
        XCTAssertTrue(store.perform("reviewUpdate", ["name": "Another unsaved edit"]))
        store.reviewPresented = false // Same binding used by interactive dismissal.
        XCTAssertEqual(store.route, "foodLibrary")
        XCTAssertFalse(store.reviewPresented)
        store.reviewPresented = false
        XCTAssertEqual(store.route, "foodLibrary", "A late sheet dismissal cannot close the destination screen")
        for key in fixture.original.keys {
            XCTAssertEqual(try fixture.read(key), fixture.original[key], "Closing or replacing a review cannot save draft edits")
        }
    }

    func testReviewHeartUsesCurrentDraftWithoutLoggingAndSavedReviewKeepsReturnRoute() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        let entry: [String: Any] = ["name": "Synthetic sheet meal", "portions": 1, "proteinPerPortion": 10,
                                   "plants": [], "ferments": [], "sourceMeta": ["repertoireId": "deleted-old-favourite"]]
        XCTAssertTrue(store.perform("setReview", ["kind": "entry", "entry": entry, "confirmationId": "sheet-heart"]))
        XCTAssertTrue(store.perform("reviewUpdate", ["name": "My edited sheet meal"]))
        let beforeCount = store.savedCount
        XCTAssertFalse(store.isReviewSaved)
        XCTAssertTrue(store.toggleReviewSaved(), store.errorMessage ?? "Save failed")
        XCTAssertTrue(store.isReviewSaved)
        XCTAssertEqual(store.savedCount, beforeCount + 1)
        let saved = try XCTUnwrap((store.foods["foods"] as? [[String: Any]])?.first { $0["sourceKey"] as? String == "draft:sheet-heart" })
        XCTAssertEqual((saved["draft"] as? [String: Any])?["name"] as? String, "My edited sheet meal")
        store.route = "saved"
        store.openSaved(saved)
        XCTAssertTrue(store.reviewPresented)
        XCTAssertEqual(store.presentationRoute, "saved")
        XCTAssertTrue(store.isReviewSaved)
        store.openSaved(saved)
        XCTAssertEqual(store.presentationRoute, "saved")
        XCTAssertTrue(store.toggleReviewSaved(), store.errorMessage ?? "Remove failed")
        XCTAssertFalse(store.isReviewSaved)
        XCTAssertEqual(store.savedCount, beforeCount)
        store.reviewPresented = false
        XCTAssertEqual(store.route, "saved")
        for key in fixture.original.keys where key != "nudge-my-foods-v1" {
            XCTAssertEqual(try fixture.read(key), fixture.original[key], "The favourite action cannot log, edit or delete an eaten meal")
        }
    }

    func testReviewHeartRemovesOnlyTheSelectedSavedPortionWithSharedBarcode() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        for (key, amount) in [("small", 100), ("large", 250)] {
            let entry: [String: Any] = ["name": "Synthetic portion " + key, "barcode": "1234567890123", "portions": 1,
                                       "portionAmount": amount, "portionUnit": "g", "proteinPerPortion": 10,
                                       "plants": [], "ferments": []]
            XCTAssertTrue(store.perform("setReview", ["kind": "entry", "entry": entry, "confirmationId": "variant-" + key]))
            XCTAssertTrue(store.perform("reviewSaveFood"))
        }
        let foods = store.foods["foods"] as? [[String: Any]] ?? []
        let small = try XCTUnwrap(foods.first { $0["sourceKey"] as? String == "draft:variant-small" })
        let large = try XCTUnwrap(foods.first { $0["sourceKey"] as? String == "draft:variant-large" })
        let originalLarge = try JSONSerialization.data(withJSONObject: large, options: [.sortedKeys])
        XCTAssertEqual((small["draft"] as? [String: Any])?["barcode"] as? String, "1234567890123")
        XCTAssertEqual((large["draft"] as? [String: Any])?["barcode"] as? String, "1234567890123")
        XCTAssertNotEqual((small["draft"] as? [String: Any])?["portionAmount"] as? Int,
                          (large["draft"] as? [String: Any])?["portionAmount"] as? Int)
        store.openSaved(small)
        XCTAssertTrue(store.isReviewSaved)
        XCTAssertTrue(store.toggleReviewSaved())
        let after = store.foods["foods"] as? [[String: Any]] ?? []
        XCTAssertEqual(after.count, foods.count - 1)
        XCTAssertFalse(after.contains { $0["id"] as? String == small["id"] as? String })
        let retained = try XCTUnwrap(after.first { $0["id"] as? String == large["id"] as? String })
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: retained, options: [.sortedKeys]), originalLarge)
        XCTAssertFalse(store.isReviewSaved, "The removed portion cannot inherit another portion’s heart")
        for key in fixture.original.keys where key != "nudge-my-foods-v1" {
            XCTAssertEqual(try fixture.read(key), fixture.original[key])
        }
    }

    func testSavingReviewCancelsLateAlternativeOpeningWithoutReopeningTheSheet() async throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        var pending: CheckedContinuation<BarcodeProduct, Error>?
        let store = NativeAppStore(store: fixture.persistence, lookupProduct: { _ in
            try await withCheckedThrowingContinuation { pending = $0 }
        })
        defer { pending?.resume(throwing: CancellationError()); store.cancelLoading() }
        let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": [
            "code": "1234567890123", "product_name": "Synthetic pending alternative", "brands": "Fixture",
            "ingredients_text": "Oats", "nutriments": ["proteins_100g": 10]]]), barcode: "1234567890123")
        let entry: [String: Any] = ["name": "Synthetic current meal", "portions": 1, "proteinPerPortion": 10,
                                   "plants": [], "ferments": []]
        XCTAssertTrue(store.perform("setReview", ["kind": "entry", "entry": entry, "confirmationId": "before-alternative"]))
        store.route = "review"
        store.openProduct(product)
        for _ in 0..<100 where pending == nil { try await Task.sleep(nanoseconds: 1_000_000) }
        let suspended = try XCTUnwrap(pending)
        XCTAssertTrue(store.loading)
        XCTAssertTrue(store.perform("reviewConfirm"))
        XCTAssertEqual(store.route, "diary")
        XCTAssertFalse(store.loading)
        let savedHistory = try JSONSerialization.data(withJSONObject: store.history, options: [.sortedKeys])
        let savedDiary = try fixture.read("wmd-nudge-prototype-v1")
        pending = nil
        // A provider that returns after cancellation would otherwise open its
        // retained snapshot through the existing non-cancellation error path.
        suspended.resume(throwing: URLError(.timedOut))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.route, "diary")
        XCTAssertFalse(store.reviewPresented)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: store.history, options: [.sortedKeys]), savedHistory)
        XCTAssertEqual(try fixture.read("wmd-nudge-prototype-v1"), savedDiary)
    }

    func testConfirmedMealShowsOnlySelectedIngredientsAndAnExplicitEditControl() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        let selected = ["Blueberries", "Brazil nuts", "Kefir"]
        let meal: [String: Any] = ["name": "Smoothie", "components": [], "ingredients": [["name": "Banana"]], "plants": [],
                                  "nutrients": [String: Any](), "userIngredientSelection": ["source": "user", "names": selected],
                                  "userPortion": ["source": "user", "amount": 500, "unit": "ml"]]
        XCTAssertTrue(store.perform("setReview", ["kind": "analysis", "confirmationId": "synthetic-selected-ingredients",
                                                 "extraction": ["type": "meal", "productName": "Smoothie", "meal": meal, "nutrients": [String: Any]()]]))
        let model = store.project("reviewModel")
        XCTAssertEqual(model["ingredients"] as? String, selected.joined(separator: ", "))
        let builder = try XCTUnwrap(model["mealBuilder"] as? [String: Any])
        XCTAssertEqual(builder["confirmed"] as? Bool, true)
        XCTAssertTrue((builder["allIngredients"] as? [[String: Any]])?.contains(where: { $0["name"] as? String == "Banana" }) == true,
                      "The catalogue remains available for an explicit edit")

        for width: CGFloat in [320, 390] {
            for large in [false, true] {
                controls = [:]
                let root = ScrollView {
                    NativeMealIngredientPicker(model: builder, canAnalyse: true, isAnalysing: false, statusMessage: nil,
                                               onDraftChange: { _ in XCTFail("Rendering cannot edit the meal") }, onApply: { false },
                                               onAnalyse: { XCTFail("Rendering cannot start analysis"); return false },
                                               onSearch: { _ in XCTFail("A closed editor cannot search the catalogue"); return [:] })
                        .padding(20)
                }
                .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                .onPreferenceChange(NativeTrackingRenderGeometryKey.self) { [weak self] in self?.controls = $0 }
                let host = UIHostingController(rootView: root)
                let parent = UIViewController()
                parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
                let traits = UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large)
                parent.setOverrideTraitCollection(traits, forChild: host)
                window.rootViewController = parent; window.makeKeyAndVisible()
                parent.view.frame = CGRect(x: 0, y: 0, width: width, height: 844)
                host.view.frame = parent.view.bounds
                await layout(host.view)
                for name in selected { assertControl("native-meal-confirmed-ingredient-" + name, in: host.view) }
                assertControl("native-meal-edit-ingredients", in: host.view)
                XCTAssertNil(controls["native-meal-ingredient-search"], "Search is opened by Edit, not by reanalysis completion")
                XCTAssertNil(controls["native-meal-ingredient-Banana"], "Unselected guesses must stay out of the summary")
                XCTAssertNil(controls["native-meal-confirmed-ingredient-Banana"])
                assertHorizontalFit(host.view, name: "Confirmed ingredients")
                attach(host.view, "Confirmed ingredients \(Int(width))px " + (large ? "AX5" : "standard"), traits)
                host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
            }
        }
        for key in fixture.original.keys {
            XCTAssertEqual(try fixture.read(key), fixture.original[key], "Viewing confirmed ingredients must not rewrite saved food")
        }
    }

    func testAddFoodChooserDefersNavigationAndPreservesDiaryDestination() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        store.route = "diary"; store.diaryDay = "2026-09-22"
        store.showAddFood()
        XCTAssertTrue(store.addFoodPresented)
        XCTAssertEqual(store.loggingDay, "2026-09-22")
        XCTAssertEqual(store.loggingMeal, "")
        store.chooseAddFood("invalid")
        XCTAssertTrue(store.addFoodPresented)
        store.chooseAddFood("history")
        XCTAssertFalse(store.addFoodPresented)
        XCTAssertEqual(store.route, "diary", "Wait for sheet dismissal before navigating")
        store.completeAddFoodSelection()
        XCTAssertEqual(store.route, "foodLibrary")
        XCTAssertEqual(store.foodLibraryMode, "recents")
        XCTAssertEqual(store.loggingDay, "2026-09-22")
        XCTAssertEqual(store.loggingMeal, "")
        store.showAddFood(day: "2026-09-23")
        store.chooseAddFood("favourites"); store.completeAddFoodSelection()
        XCTAssertEqual(store.foodLibraryMode, "favourites")
        XCTAssertEqual(store.loggingDay, "2026-09-23")
        XCTAssertEqual(store.loggingMeal, "")
        store.showAddFood(); store.addFoodPresented = false; store.completeAddFoodSelection()
        XCTAssertEqual(store.route, "foodLibrary", "Cancelling must not open the camera")
        XCTAssertNil(store.capture.camera)
        store.showAmbassadors()
        XCTAssertTrue(store.ambassadorsPresented)
        for key in fixture.original.keys {
            XCTAssertEqual(try fixture.read(key), fixture.original[key], "Choosing a source must not change existing food records")
        }
    }

    func testRecipeChoicesFitSmallScreenAndUpdateOnlyTheSelectedDraftShare() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }

        for large in [false, true] {
            let fixture = try NativeScreenFixture()
            defer { try? FileManager.default.removeItem(at: fixture.directory) }
            let store = NativeAppStore(store: fixture.persistence)
            XCTAssertTrue(store.ready, store.errorMessage ?? "Shared recipe runtime must load")
            let quote = "400 g chicken breast (or tofu)"
            let ingredients: [[String: Any]] = ["chicken breast", "tofu"].map { name in
                ["name": name, "amount": NSNull(), "unit": NSNull(), "preparation": "raw",
                 "photoIndex": 1, "evidence": "Recipe ingredient could not be linked to the printed text."]
            }
            let batch: [[String: Any]] = ingredients.map { ingredient in
                ["name": ingredient["name"]!, "amountGrams": NSNull(), "recordId": NSNull(),
                 "sourceRecord": NSNull(), "nutrients": [String: Any](), "recipeIngredient": ingredient,
                 "preparation": "raw", "photoIndex": 1, "evidence": quote]
            }
            let original: [[String: Any]] = [["name": "Synthetic recipe", "amountGrams": NSNull(),
                                             "recordId": NSNull(), "sourceRecord": NSNull(), "nutrients": [String: Any]()]]
            let meal: [String: Any] = [
                "name": "Synthetic recipe with an ingredient alternative", "components": batch,
                "compositionVersion": "synthetic-choice-fixture", "portionMode": "estimated_serving",
                "basis": "perPortion", "nutrients": [String: Any](), "ingredients": [], "plants": [],
                "recipeEvidence": ["photoIndex": 1, "componentIndexes": [0], "servings": 4,
                                   "servingsEvidence": "Serves 4", "text": "Shopping list\n" + quote,
                                   "ingredients": ingredients],
                "recipeCalculation": ["version": "recipe-composition-v1", "servings": 4,
                                      "photoIndex": 1, "componentIndexes": [0], "batchComponents": batch,
                                      "applied": true, "originalPlateComponents": original,
                                      "selectedFraction": 1, "fractionSource": "recipe"]
            ]
            XCTAssertTrue(store.perform("setReview", ["kind": "analysis", "confirmationId": "synthetic-choice-review",
                                                      "extraction": ["type": "meal", "productName": "Synthetic recipe",
                                                                     "meal": meal, "nutrients": [String: Any]()]]))
            XCTAssertTrue(store.perform("reviewUpdate", ["recipeFraction": 0.25]))
            let model = store.project("reviewModel")
            let choices = try XCTUnwrap(model["recipeChoices"] as? [[String: Any]])
            XCTAssertEqual(choices.count, 1, "One printed either/or line must produce one choice")
            let choice = try XCTUnwrap(choices.first)
            let choiceID = try XCTUnwrap(choice["id"] as? String)
            let options = try XCTUnwrap(choice["options"] as? [[String: Any]])
            XCTAssertEqual(options.count, 2)
            XCTAssertEqual(choice["selected"] as? String, "", "Rendering must not silently choose an ingredient")
            let optionIDs = try options.map { try XCTUnwrap($0["id"] as? String) }
            let identifiers = optionIDs.map { "native-review-recipe-choice-" + choiceID + "-" + $0 }

            controls = [:]
            let root = NativeFoodReviewView(store: store)
                .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                .onPreferenceChange(NativeTrackingRenderGeometryKey.self) { [weak self] in self?.controls = $0 }
            let host = UIHostingController(rootView: root)
            let parent = UIViewController()
            parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
            let traits = UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large)
            parent.setOverrideTraitCollection(traits, forChild: host)
            window.rootViewController = parent; window.makeKeyAndVisible()
            parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844)
            host.view.frame = parent.view.bounds
            await layout(host.view)
            let scroll = try XCTUnwrap(scrollViews(host.view).max(by: { $0.contentSize.height < $1.contentSize.height }))
            // Lazy grids publish their actual hit frames when brought into view.
            for offset in stride(from: CGFloat(0), through: min(scroll.contentSize.height, 8_000), by: 300) {
                if identifiers.allSatisfy({ controls[$0] != nil }) { break }
                scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
                await layout(host.view)
            }
            for identifier in identifiers {
                assertControl(identifier, in: host.view)
                let frame = try XCTUnwrap(controls[identifier])
                XCTAssertGreaterThanOrEqual(frame.width, 48 - 0.001)
                XCTAssertGreaterThanOrEqual(frame.height, 48 - 0.001)
            }
            assertHorizontalFit(host.view, name: "Recipe choices 320px " + (large ? "AX5" : "standard"))
            attach(host.view, "Recipe choices 320px " + (large ? "AX5" : "standard"), traits)

            XCTAssertTrue(store.perform("reviewUpdate", ["recipeChoice": ["id": choiceID, "value": optionIDs[0]]]))
            let selected = store.project("reviewModel")
            let components = try XCTUnwrap(selected["components"] as? [[String: Any]])
            XCTAssertEqual(components.count, 1, "The unselected protein must not be counted as a second ingredient")
            XCTAssertEqual((components[0]["amountGrams"] as? NSNumber)?.doubleValue, 100)
            let protein = try XCTUnwrap((selected["nutrients"] as? [[String: Any]])?.first(where: { $0["key"] as? String == "protein" }))
            let quarterProtein = try XCTUnwrap(protein["value"] as? NSNumber).doubleValue
            XCTAssertGreaterThan(quarterProtein, 0)
            XCTAssertTrue(store.perform("reviewUpdate", ["recipeFraction": 0.5]))
            let half = store.project("reviewModel")
            let halfProtein = try XCTUnwrap((half["nutrients"] as? [[String: Any]])?.first(where: { $0["key"] as? String == "protein" })?["value"] as? NSNumber).doubleValue
            XCTAssertEqual(halfProtein, quarterProtein * 2, accuracy: 0.0001)
            XCTAssertTrue(store.perform("reviewUpdate", ["recipeChoice": ["id": choiceID, "value": optionIDs[1]]]))
            let changed = store.project("reviewModel")
            let changedComponents = try XCTUnwrap(changed["components"] as? [[String: Any]])
            XCTAssertEqual(changedComponents.count, 1)
            XCTAssertEqual((changedComponents[0]["amountGrams"] as? NSNumber)?.doubleValue, 200)
            XCTAssertNotEqual(changedComponents[0]["recordId"] as? String, components[0]["recordId"] as? String)
            XCTAssertEqual((changed["recipe"] as? [String: Any])?["selectedFraction"] as? Double, 0.5)
            await layout(host.view)
            assertHorizontalFit(host.view, name: "Updated recipe choice")
            XCTAssertNil(store.errorMessage)
            for key in fixture.original.keys {
                XCTAssertEqual(try fixture.read(key), fixture.original[key], "Recipe choices update the draft; rendering and selection must not save diary, History or favourites")
            }
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
    }

    func testNativeScreensRenderAtBothWidthsAppearancesAndAccessibilitySizes() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }

        for width: CGFloat in [320, 390] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                for large in [false, true] {
                    let fixture = try NativeScreenFixture()
                    defer { try? FileManager.default.removeItem(at: fixture.directory) }
                    let store = NativeAppStore(store: fixture.persistence)
                    XCTAssertTrue(store.ready, store.errorMessage ?? "Shared domain runtime must load")
                    XCTAssertNil(store.errorMessage)
                    let today = store.project("today", ["day": NativeAppStore.day])
                    let rings = try XCTUnwrap(today["rings"] as? [[String: Any]])
                    XCTAssertEqual(rings.count, 6)
                    XCTAssertEqual(Set(rings.compactMap { $0["key"] as? String }), Set(["protein", "energy", "carbs", "fat", "fibre", "plants"]))
                    XCTAssertEqual((today["weekRings"] as? [String: Any])?.count, 7)
                    let compact = try XCTUnwrap(today["compactMetrics"] as? [[String: Any]])
                    XCTAssertEqual(compact.count, 9)
                    XCTAssertEqual(Set(compact.compactMap { $0["key"] as? String }), Set(["energy", "protein", "fibre", "carbs", "fat", "sugars", "saturatedFat", "salt", "plants"]))
                    XCTAssertEqual((today["carbs"] as? [String: Any])?["unknown"] as? Int, 1,
                                   "A missing meal carbohydrate must remain a partial total")
                    let history = store.project("history", ["filter": "all"])
                    XCTAssertEqual((history["rows"] as? [[String: Any]])?.count, 2,
                                   "Linked scan and consumed entry must appear once")
                    let entry = try XCTUnwrap(((store.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])?.first)
                    // Render the immutable saved-intake draft directly. Opening
                    // its linked catalogue result intentionally performs live
                    // recovery/recall checks, exercised with injected services
                    // in the separate product-context tests.
                    XCTAssertTrue(store.perform("setReview", ["kind": "entry", "entry": entry, "entryId": entry["id"] ?? ""]))
                    XCTAssertNil(store.errorMessage)
                    let screens: [(String, AnyView)] = [
                        ("Add food", AnyView(NativeAddFoodChooser(store: store))),
                        ("Today", AnyView(NativeTodayView(store: store))),
                        ("Diary", AnyView(NativeDiaryView(store: store))),
                        ("History", AnyView(NativeHistoryView(store: store))),
                        ("My foods", AnyView(NativeMyFoodsView(store: store))),
                        ("Profile", AnyView(NativeProfileView(store: store))),
                        ("Cycle", AnyView(NativeCycleView(store: store))),
                        ("Settings", AnyView(NativeSettingsView(store: store))),
                        ("Food review", AnyView(NativeFoodReviewView(store: store)))
                    ]
                    for (name, screen) in screens {
                        controls = [:]
                        let root = screen
                            .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                            .environment(\.colorScheme, style == .dark ? .dark : .light)
                            .onPreferenceChange(NativeTrackingRenderGeometryKey.self) { [weak self] in self?.controls = $0 }
                        let host = UIHostingController(rootView: root)
                        let parent = UIViewController()
                        parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
                        let traits = UITraitCollection(traitsFrom: [
                            UITraitCollection(userInterfaceStyle: style),
                            UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large),
                            UITraitCollection(accessibilityContrast: large ? .high : .normal)
                        ])
                        parent.setOverrideTraitCollection(traits, forChild: host)
                        window.rootViewController = parent; window.overrideUserInterfaceStyle = style
                        window.makeKeyAndVisible(); host.overrideUserInterfaceStyle = style
                        parent.view.frame = CGRect(x: 0, y: 0, width: width, height: 844)
                        host.view.frame = parent.view.bounds
                        await layout(host.view)
                        let label = "\(name) \(Int(width))px-\(style == .dark ? "dark" : "light")-\(large ? "AX5" : "standard")"
                        assertHorizontalFit(host.view, name: label)
                        XCTAssertNil(store.errorMessage, "\(label) must project without a JavaScript exception")
                        switch name {
                        case "Today":
                            assertControl("native-today", in: host.view)
                            assertControl("today-diary", in: host.view)
                            assertControl("today-cycle", in: host.view)
                        case "Diary":
                            assertControl("native-diary", in: host.view)
                            assertControl("diary-back", in: host.view)
                            assertControl("diary-date", in: host.view)
                            assertControl("diary-previous-day", in: host.view)
                            XCTAssertEqual(controls.keys.filter { $0.hasPrefix("add-food-") }, ["add-food-today"],
                                           "The date has one Add food action, without meal category sections")
                            for identifier in controls.keys.filter({ $0.hasPrefix("diary-day-") }) {
                                assertControl(identifier, in: host.view)
                            }
                        case "History":
                            assertControl("native-history", in: host.view)
                            for key in ["all", "scanned", "photos", "eaten"] { assertControl("history-filter-\(key)", in: host.view) }
                            if !large {
                                assertControl("history-favourite-native-fixture-scan", in: host.view)
                                assertControl("history-alternatives-native-fixture-scan", in: host.view)
                                XCTAssertGreaterThanOrEqual(controls["history-alternatives-native-fixture-scan"]?.height ?? 0, 44)
                            }
                        case "Food review":
                            for identifier in ["native-review-close", "native-review-favourite", "native-review-menu", "native-review-confirm", "native-review-portion-shortcut"] {
                                assertControl(identifier, in: host.view)
                                XCTAssertGreaterThanOrEqual(controls[identifier]?.height ?? 0, 44)
                            }
                        case "My foods":
                            assertControl("native-my-foods", in: host.view)
                            assertControl("my-foods-search", in: host.view)
                        default: break
                        }
                        let pinnedHeader = controls["native-review-header"]
                        let pinnedFooter = controls["native-review-footer"]
                        attach(host.view, label + " top", traits)
                        if let scroll = scrollViews(host.view).max(by: { $0.contentSize.height < $1.contentSize.height }), scroll.contentSize.height > scroll.bounds.height + 10 {
                            let bottom = max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                            if name == "Food review", !large {
                                scroll.setContentOffset(CGPoint(x: 0, y: min(620, bottom)), animated: false)
                                await layout(host.view)
                                assertHorizontalFit(host.view, name: label + " nutrition")
                                attach(host.view, label + " nutrition", traits)
                            }
                            scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
                            await layout(host.view)
                            assertHorizontalFit(host.view, name: label + " bottom")
                            attach(host.view, label + " bottom", traits)
                            if name == "Food review" {
                                let header = try XCTUnwrap(controls["native-review-header"])
                                let footer = try XCTUnwrap(controls["native-review-footer"])
                                XCTAssertEqual(header.minY, try XCTUnwrap(pinnedHeader).minY, accuracy: 1, "Review header must stay visible while scrolling")
                                XCTAssertEqual(footer.minY, try XCTUnwrap(pinnedFooter).minY, accuracy: 1, "Logging action must stay visible while scrolling")
                            }
                        }
                        host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
                    }
                    XCTAssertNil(store.errorMessage)
                    for key in fixture.original.keys {
                        XCTAssertEqual(try fixture.read(key), fixture.original[key],
                                       "Read-only screen rendering must not mutate any persisted record")
                    }
                }
            }
        }
    }

    func testMyFoodsCompactRowsOpenFullReviewWithSeparateSaveAndDiaryActions() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        let food = try XCTUnwrap((store.foods["foods"] as? [[String: Any]])?.first)
        let id = try XCTUnwrap(food["id"] as? String)
        for large in [false, true] {
            store.route = "saved"
            for review in [false, true] {
                if review { store.openSaved(food) }
                controls = [:]
                let screen = review ? AnyView(NativeFoodReviewView(store: store)) : AnyView(NativeMyFoodsView(store: store))
                let root = screen.environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                    .onPreferenceChange(NativeTrackingRenderGeometryKey.self) { [weak self] in self?.controls = $0 }
                let host = UIHostingController(rootView: root), parent = UIViewController()
                parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
                let traits = UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large)
                parent.setOverrideTraitCollection(traits, forChild: host)
                window.rootViewController = parent; window.makeKeyAndVisible()
                parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844); host.view.frame = parent.view.bounds
                await layout(host.view)
                if review {
                    XCTAssertEqual(store.review["savedFoodId"] as? String, id)
                    XCTAssertNil(store.review["entryId"], "Opening a saved food cannot edit an eaten diary entry")
                    assertControl("native-review-save-changes", in: host.view)
                    assertControl("native-review-confirm", in: host.view)
                    XCTAssertGreaterThanOrEqual(try XCTUnwrap(controls["native-review-save-changes"]).height, 44)
                } else {
                    assertControl("my-foods-row-" + id, in: host.view)
                    let row = try XCTUnwrap(controls["my-foods-row-" + id])
                    XCTAssertGreaterThanOrEqual(row.height, 44)
                    if !large { XCTAssertLessThan(row.height, 140, "Saved foods should be compact tappable rows") }
                }
                attach(host.view, (review ? "Saved food full editor" : "My foods compact list") + (large ? " AX5" : " regular"), traits)
                host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
            }
            store.dismissReview()
        }
        for (key, value) in fixture.original {
            XCTAssertEqual(try fixture.read(key), value, "Browsing or closing My foods cannot write edits or diary entries")
        }
    }

    private func assertControl(_ identifier: String, in view: UIView, file: StaticString = #filePath, line: UInt = #line) {
        guard let frame = controls[identifier] else { XCTFail("Control missing: \(identifier)", file: file, line: line); return }
        XCTAssertGreaterThan(frame.width, 0, file: file, line: line)
        XCTAssertGreaterThan(frame.height, 0, file: file, line: line)
        let viewport = view.convert(view.bounds, to: nil)
        XCTAssertGreaterThanOrEqual(frame.minX, viewport.minX - 1, "\(identifier) must fit horizontally", file: file, line: line)
        XCTAssertLessThanOrEqual(frame.maxX, viewport.maxX + 1, "\(identifier) must fit horizontally", file: file, line: line)
        let navigationControls = ["today-diary", "today-cycle", "today-targets", "diary-back", "diary-date", "diary-previous-day", "diary-next-day"]
        if navigationControls.contains(identifier) || identifier.hasPrefix("history-filter-") || identifier.hasPrefix("history-favourite-") || identifier.hasPrefix("diary-day-") {
            XCTAssertGreaterThanOrEqual(frame.width, 48 - 0.001, "\(identifier) needs a generous touch width", file: file, line: line)
            XCTAssertGreaterThanOrEqual(frame.height, 48 - 0.001, "\(identifier) needs a generous touch height", file: file, line: line)
        }
    }
    private func assertHorizontalFit(_ view: UIView, name: String, file: StaticString = #filePath, line: UInt = #line) {
        let scrolls = scrollViews(view)
        XCTAssertFalse(scrolls.isEmpty, "\(name) must allow vertical scrolling", file: file, line: line)
        for scroll in scrolls where scroll.bounds.width > 40 {
            XCTAssertLessThanOrEqual(scroll.contentSize.width, scroll.bounds.width + 1,
                                    "\(name): content must fit the phone width", file: file, line: line)
        }
    }
    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
    private func scrollViews(_ view: UIView) -> [UIScrollView] { descendants(view).compactMap { $0 as? UIScrollView }.filter { !($0 is UITextView) } }
    private func layout(_ view: UIView) async {
        view.setNeedsLayout(); view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 180_000_000)
        view.layoutIfNeeded()
    }
    private func attach(_ view: UIView, _ name: String, _ traits: UITraitCollection) {
        traits.performAsCurrent {
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { view.layer.render(in: $0.cgContext) }
            let attachment = XCTAttachment(image: image)
            attachment.name = name + " — isolated synthetic records"
            attachment.lifetime = .keepAlways; add(attachment)
        }
    }
}

@MainActor
private final class NativeScreenFixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NativeScreens-" + UUID().uuidString, isDirectory: true)
    let persistence: NudgeDataStore
    var original: [String: String] = [:]
    init() throws {
        persistence = NudgeDataStore(directory: directory)
        let day = NativeAppStore.day
        let earlier = NativeTrackingDisplay.dayKey(Calendar.current.date(byAdding: .day, value: -18, to: Date())!)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
            UIColor.systemOrange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
        }.jpegData(compressionQuality: 0.2)!
        let thumbnail = "data:image/jpeg;base64," + image.base64EncodedString()
        let nutrients: [String: Any] = ["energyKcal": 500, "protein": 30, "carbohydrate": 60, "fat": 15, "fibre": 9, "sugars": 3, "saturatedFat": 2, "salt": 0.5]
        let snapshot: [String: Any] = nutrients.mapValues { value in ["portion": value, "portionStatus": "calculated", "per100Status": "unknown", "unit": "g"] }
        let entry: [String: Any] = ["id": "native-fixture-entry", "name": "Chickpea and roasted vegetable lunch with a long food name", "day": day, "slot": "Lunch", "portions": 1, "portionAmount": 350, "portionUnit": "g", "plants": ["chickpea", "pepper", "tomato"], "ferments": [], "energyPerPortion": 500, "proteinPerPortion": 30, "fibrePerPortion": 9, "nutritionSnapshot": snapshot, "source": "Label", "sourceMeta": ["entryKind": "product-consumption", "productScanEventId": "native-fixture-scan", "confirmationId": "native-fixture-confirmation", "plantKnowledge": "known", "repertoireImage": thumbnail]]
        let partial: [String: Any] = ["id": "native-fixture-partial", "name": "Meal with some nutrition still unknown", "day": day, "slot": "Dinner", "portions": 1, "portionAmount": 100, "portionUnit": "g", "plants": ["pea"], "ferments": [], "energyPerPortion": NSNull(), "proteinPerPortion": NSNull(), "fibrePerPortion": NSNull(), "source": "Manual entry", "sourceMeta": ["repertoireImage": thumbnail]]
        let profile: [String: Any] = ["saved": true, "schemaVersion": 2, "choiceVersion": 2, "age": 55, "weight": 78, "height": 185, "sex": "male", "activity": "moderate", "care": "none", "goal": "muscle", "goals": ["muscle"], "trainingTypes": ["weight_training"], "sessions": 3, "tracking": ["protein", "calories", "carbs", "fat", "fibre", "plants"], "target": 150, "calorieTarget": 2750, "carbTarget": 325, "fatTarget": 90, "fibreTarget": 30, "weeklyPlantTarget": 30, "dailyPlantTarget": NSNull(), "targetModes": ["protein": "manual", "calories": "automatic", "carbs": "automatic", "fat": "automatic", "fibre": "automatic", "plants": "automatic"], "targetHistory": [["id": "fixture-targets", "effectiveFrom": "2026-01-01", "targets": ["protein": 150, "calories": 2750, "carbs": 325, "fat": 90, "fibre": 30, "plants": 30, "dailyPlants": NSNull()]]]]
        let main: [String: Any] = ["version": 1, "foodLog": ["entries": [entry, partial], "savedRecipes": [], "plantGoal": 30], "nutritionProfile": profile, "cycleSupport": ["enabled": true, "start": earlier, "length": 28, "regularity": "regular", "contraception": "none", "checkins": [], "focus": ["Energy"]], "avoidMilk": false, "motionEnabled": true, "focus": "food", "goal": 5]
        let product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": ["code": "10000001", "product_name": "Fixture chickpeas", "ingredients_text": "Chickpeas, water", "categories_tags": ["en:chickpeas"], "nutriments": ["energy-kcal_100g": 120, "proteins_100g": 6, "carbohydrates_100g": 15, "fat_100g": 2, "fiber_100g": 5, "sugars_100g": 1, "saturated-fat_100g": 0.2, "salt_100g": 0.1]]]), barcode: "10000001")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(product)) as? [String: Any])
        let history: [String: Any] = ["version": 3, "events": [["id": "native-fixture-scan", "kind": "product", "status": "ready", "createdAt": day + "T12:00:00Z", "updatedAt": day + "T12:00:00Z", "barcode": "10000001", "name": "Fixture chickpeas", "thumbnail": thumbnail, "product": object, "entryId": "native-fixture-entry"]], "favourites": [], "deleted": [], "generations": [:]]
        let foods: [String: Any] = ["version": 1, "foods": [["id": "fixture-saved", "name": "My usual chickpea lunch with roasted vegetables", "draft": entry, "image": thumbnail, "sourceKey": "entry:native-fixture-entry", "updatedAt": day + "T12:00:00Z"]]]
        for (key, value) in ["wmd-nudge-prototype-v1": main, "nudge-scan-history-v1": history, "nudge-my-foods-v1": foods] {
            let text = String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
            let request = String(data: try JSONSerialization.data(withJSONObject: ["operation": "set", "key": key, "value": text]), encoding: .utf8)!
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(persistence.handle(request).utf8)) as? [String: Any])
            XCTAssertEqual(result["ok"] as? Bool, true)
            original[key] = text
        }
    }
    func read(_ key: String) throws -> String? {
        let request = String(data: try JSONSerialization.data(withJSONObject: ["operation": "get", "key": key]), encoding: .utf8)!
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(persistence.handle(request).utf8)) as? [String: Any])
        return result["value"] as? String
    }
}


@MainActor
final class NativeTodaySwipeTests: XCTestCase {
    func testRepairSnapshotStaysFrozenWhenDiaryChangesBeforeQueueWrite() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        let initial = store.captureRepairContext(["entryId": "native-fixture-entry"])
        let snapshot = try XCTUnwrap(initial["queuedEntrySnapshot"] as? [String: Any])
        XCTAssertTrue(store.perform("setReview", ["kind": "entry", "entryId": "native-fixture-entry"]))
        XCTAssertTrue(store.perform("reviewUpdate", ["name": "Edited during photo loading"]))
        XCTAssertTrue(store.perform("reviewConfirm"))
        let frozen = try XCTUnwrap(store.captureRepairContext(initial)["queuedEntrySnapshot"] as? [String: Any])
        XCTAssertTrue(NSDictionary(dictionary: frozen).isEqual(to: snapshot))
        let fresh = try XCTUnwrap(store.captureRepairContext(["entryId": "native-fixture-entry"])["queuedEntrySnapshot"] as? [String: Any])
        XCTAssertEqual(fresh["name"] as? String, "Edited during photo loading")
        XCTAssertNotEqual(frozen["name"] as? String, fresh["name"] as? String)
    }

    func testMissingRepairSnapshotCannotBeReplacedByAnIntakeRestoredDuringPhotoRead() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        XCTAssertTrue(store.perform("historyDelete", ["id": "native-fixture-scan", "keepIntake": false]))
        let initial = store.captureRepairContext(["entryId": "native-fixture-entry"])
        XCTAssertTrue(initial["queuedEntrySnapshot"] is NSNull, "A stale review freezes the missing intake, not a future lookup")
        XCTAssertTrue(store.perform("historyUndo"))
        let entries = (store.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []
        XCTAssertTrue(entries.contains { $0["id"] as? String == "native-fixture-entry" })
        XCTAssertTrue(store.captureRepairContext(initial)["queuedEntrySnapshot"] is NSNull)
        XCTAssertNotNil(store.captureRepairContext(["entryId": "native-fixture-entry"])["queuedEntrySnapshot"] as? [String: Any], "A separate new request can deliberately use the restored intake")
    }

    func testSwipePolicyLetsVerticalAndDiagonalScrollingPass() {
        for velocity in [CGPoint(x: 0, y: -600), CGPoint(x: -90, y: -500), CGPoint(x: -200, y: 200), CGPoint(x: 3, y: 0), CGPoint(x: 500, y: 0)] {
            XCTAssertFalse(NativeFoodSwipePolicy.begins(velocity: velocity, revealed: false))
        }
        XCTAssertTrue(NativeFoodSwipePolicy.begins(velocity: CGPoint(x: -500, y: 10), revealed: false))
        XCTAssertTrue(NativeFoodSwipePolicy.begins(velocity: CGPoint(x: 500, y: 10), revealed: true))
        XCTAssertTrue(NativeFoodSwipePolicy.reveals(offset: -60, velocity: 0))
        XCTAssertFalse(NativeFoodSwipePolicy.reveals(offset: -20, velocity: 0))
        XCTAssertFalse(NativeFoodSwipePolicy.reveals(offset: -80, velocity: 600))
    }
    func testRevealingNeverDeletesAndOnlyExplicitVisibleDeleteInvokesAction() {
        let controller = NativeFoodSwipeController(content: AnyView(Text("Synthetic food").frame(height: 90)))
        controller.loadViewIfNeeded(); controller.view.frame = CGRect(x: 0, y: 0, width: 320, height: 90)
        controller.view.layoutIfNeeded()
        var deletions = 0; controller.onDelete = { deletions += 1 }
        controller.setRevealed(false, animated: false)
        controller.deleteButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(deletions, 0)
        XCTAssertTrue(controller.deleteButton.accessibilityElementsHidden)
        controller.setRevealed(true, animated: false)
        XCTAssertEqual(deletions, 0, "A full swipe can only reveal Delete")
        XCTAssertFalse(controller.deleteButton.accessibilityElementsHidden)
        XCTAssertEqual(controller.host.view.transform.tx, -NativeFoodSwipePolicy.actionWidth)
        XCTAssertGreaterThanOrEqual(controller.deleteButton.bounds.width, 44)
        XCTAssertGreaterThanOrEqual(controller.deleteButton.bounds.height, 44)
        controller.deleteButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(deletions, 1)
        controller.setRevealed(false, animated: false)
        XCTAssertEqual(controller.host.view.transform.tx, 0)
    }
}


@MainActor
final class NativeCapturePollingPresentationTests: XCTestCase {
    func testRemotePollingHasStableVisiblePhaseButRetainsFailureDeadline() {
        var record = NativeCaptureRecord(eventID: "synthetic-poll", ownerKey: "local-guest")
        record.remoteAccepted = true; record.status = .queued
        record.nextAttemptAt = Date(timeIntervalSince1970: 1_800_000_000)
        let queued = NativeCaptureCoordinator.historyProcessingFields(for: record)
        XCTAssertEqual(queued, ["processingState": "processing", "nextAttemptAt": ""])
        record.status = .processing
        XCTAssertEqual(NativeCaptureCoordinator.historyProcessingFields(for: record), queued)
        record.status = .queued; record.nextAttemptAt = record.nextAttemptAt?.addingTimeInterval(3)
        XCTAssertEqual(NativeCaptureCoordinator.historyProcessingFields(for: record), queued)
        record.status = .retryableFailure
        XCTAssertEqual(NativeCaptureCoordinator.historyProcessingFields(for: record)["nextAttemptAt"], ISO8601DateFormatter().string(from: record.nextAttemptAt!))
        XCTAssertEqual(NativeCaptureCoordinator.historyProcessingFields(for: record)["processingState"], "retryableFailure")
        record.remoteAccepted = false; record.status = .queued
        XCTAssertEqual(NativeCaptureCoordinator.historyProcessingFields(for: record)["processingState"], "queued", "A new unsent capture still reports queued")
    }
    func testDurableFuturePollingDatesDoNotRewriteOrRepublishHistory() throws {
        let fixture = try NativeScreenFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let store = NativeAppStore(store: fixture.persistence)
        let outbox = store.captureOutbox
        let coordinator = NativeCaptureCoordinator(store: store,
            lookup: { _, _ in XCTFail("A future photo poll must never start a barcode lookup"); throw CancellationError() },
            analysePhotos: { _, _, _, _, _ in XCTFail("A future poll must not upload photos"); throw CancellationError() },
            permissionAllowed: { true }, accountRevision: { 7 }, outbox: outbox, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.suspendPending() }
        var record = NativeCaptureRecord(eventID: "synthetic-future-poll", ownerKey: "local-guest")
        record.status = .queued; record.remoteAccepted = true; record.historyGeneration = 0
        record.nextAttemptAt = Date().addingTimeInterval(3_600); record.serverRetryAt = record.nextAttemptAt
        record.loggingDay = NativeAppStore.day; record.loggingMeal = "Lunch"
        record = try outbox.save(record)
        coordinator.resumePending()
        let saved = try XCTUnwrap(try fixture.read("nudge-scan-history-v1"))
        var publications = 0
        let subscription = store.$history.dropFirst().sink { _ in publications += 1 }
        defer { subscription.cancel() }
        for _ in 0..<5 {
            record.nextAttemptAt = record.nextAttemptAt?.addingTimeInterval(3); record.serverRetryAt = record.nextAttemptAt
            record = try outbox.save(record)
            coordinator.resumePending()
            XCTAssertEqual(try fixture.read("nudge-scan-history-v1"), saved)
        }
        XCTAssertEqual(publications, 0, "Transport poll dates must not invalidate Today, History or scores")
        XCTAssertEqual(try outbox.record(eventID: record.eventID, owner: "local-guest")?.nextAttemptAt, record.nextAttemptAt, "The actual retry deadline remains durable")
        record.status = .retryableFailure; record.errorCode = "analysis_timeout"
        record = try outbox.save(record); coordinator.resumePending()
        XCTAssertEqual(publications, 1, "A real failure must still appear immediately")
        let event = try XCTUnwrap(store.project("captureState", ["id": record.eventID])["event"] as? [String: Any])
        XCTAssertEqual(event["processingState"] as? String, "retryableFailure")
        XCTAssertEqual(event["nextAttemptAt"] as? String, ISO8601DateFormatter().string(from: record.nextAttemptAt!))
    }
}
