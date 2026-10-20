import Foundation
import Testing
import SwiftUI
import UIKit
import XCTest
@testable import Nudge

@MainActor
struct NativeProductContextTests {
    private func product(_ id: String, highScore: Bool = false) -> [String: Any] {
        func nutrient(_ value: Double, _ unit: String = "g") -> [String: Any] { ["value": value, "unit": unit, "status": "supplied"] }
        return ["barcode": id, "name": highScore ? "Synthetic oat bar" : "Synthetic sweet biscuit", "brand": "QA",
                "countriesTags": ["en:united-kingdom"], "stores": ["Sainsbury’s"],
                "categories": ["en:snacks", "en:cereal-bars"], "basisUnit": "g", "nutritionPreparation": "as_sold",
                "ingredients": "Oats, water", "sourceURL": "https://world.openfoodfacts.org/product/" + id,
                "sourceName": "Synthetic catalogue", "retrievedAt": "2026-10-07T10:00:00Z",
                "scoringFacts": ["fvlPercent": ["value": 0, "source": "declared", "evidence": "Synthetic test fixture"]],
                "nutrients": ["energyKcal": nutrient(highScore ? 200 : 400, "kcal"), "saturatedFat": nutrient(highScore ? 0.5 : 8),
                              "sugars": nutrient(highScore ? 3 : 30), "salt": nutrient(highScore ? 0.2 : 2),
                              "protein": nutrient(highScore ? 10 : 4), "fibre": nutrient(highScore ? 6 : 1)]]
    }
    private var available: [String: Any] { ["status": "available", "checkedAt": "2026-10-07T12:00:00Z", "notices": []] }
    private func recall(_ name: String) -> [String: Any] {
        ["status": "available", "notices": [["notation": "QA-1", "title": "Synthetic recall", "status": "Published",
          "alertURL": "https://alerts.food.gov.uk/news-alerts/alert/qa-1", "consumerAdvice": "Synthetic official advice",
          "productDetails": [["productName": name, "packSizeDescription": "100 g", "batchDescription": [["batchCode": "TEST-A"]]]]]]]
    }
    private func settle(_ condition: () -> Bool) async {
        for _ in 0..<200 { if condition() { return }; await Task.yield() }
    }

    @Test func bundledRulesRetainComparableScoresDietaryEvidenceAndInputs() throws {
        let rules = NativeProductContextRules()
        #expect(rules.ready)
        let current = product("100"), candidate = product("200", highScore: true)
        let before = try JSONSerialization.data(withJSONObject: [current, candidate], options: [.sortedKeys])
        #expect(rules.canOffer(current))
        #expect(rules.isBelowFifty(current))
        #expect(!rules.canOffer(candidate))
        #expect(!rules.isBelowFifty(candidate))
        #expect(rules.select(current: current, candidates: [candidate, candidate, current], profile: [:], avoidMilk: false).count == 1)
        #expect(rules.select(current: current, candidates: [candidate], profile: ["diet": "vegan"], avoidMilk: false).isEmpty)
        var labelled = candidate; labelled["labelsTags"] = ["en:vegan"]
        #expect(rules.select(current: current, candidates: [labelled], profile: ["diet": "vegan"], avoidMilk: false).count == 1)
        #expect(rules.select(current: current, candidates: [labelled], profile: [:], avoidMilk: true).isEmpty)
        var incompatible = candidate; incompatible["nutritionPreparation"] = "prepared"
        #expect(rules.select(current: current, candidates: [incompatible], profile: [:], avoidMilk: false).isEmpty)
        // Unknown plant share receives no bonus; the supplied nutrients still support a directional score.
        var unknownPlantShare = candidate; unknownPlantShare["scoringFacts"] = [:]
        let nutritionOnly = rules.select(current: current, candidates: [unknownPlantShare], profile: [:], avoidMilk: false)
        #expect(nutritionOnly.count == 1)
        #expect(nutritionOnly.first?["value"] as? Int == 100)
        let nutritionOnlyScore = nutritionOnly.first?["score"] as? [String: Any]
        #expect(nutritionOnlyScore?["rawScore"] as? Int == -5) // 2 energy - 3 fibre - 4 protein; no plant bonus.
        let plant = (nutritionOnlyScore?["components"] as? [[String: Any]])?.first { $0["id"] as? String == "fvl" }
        #expect(plant?["points"] as? Int == 0)
        #expect(plant?["value"] is NSNull)
        var incomplete = candidate
        var incompleteNutrients = incomplete["nutrients"] as? [String: Any] ?? [:]
        incompleteNutrients.removeValue(forKey: "salt"); incomplete["nutrients"] = incompleteNutrients
        #expect(rules.select(current: current, candidates: [incomplete], profile: [:], avoidMilk: false).isEmpty)
        #expect(try JSONSerialization.data(withJSONObject: [current, candidate], options: [.sortedKeys]) == before)
    }

    @Test func recallPreservesUnknownPackConditionsAndRestrictsOfficialLinks() {
        let rules = NativeProductContextRules()
        let product: [String: Any] = ["name": "Synthetic oat bar", "quantity": "100 g", "metadata": ["batchCode": "TEST-A"]]
        #expect(rules.assess(product: product, response: recall("Synthetic oat bar"))["status"] as? String == "matched")
        #expect(rules.assess(product: ["name": "Synthetic oat bar"], response: recall("Synthetic oat bar"))["status"] as? String == "potential_match")
        #expect(rules.assess(product: product, response: ["status": "check_unavailable"])["status"] as? String == "check_unavailable")
        #expect(NativeProductContextRules.officialNoticeURL("https://alerts.food.gov.uk/news-alerts/alert/qa") != nil)
        for url in ["http://alerts.food.gov.uk/qa", "https://alerts.food.gov.uk.evil.test/qa", "https://user@alerts.food.gov.uk/qa", "https://alerts.food.gov.uk:444/qa", "javascript:alert(1)"] {
            #expect(NativeProductContextRules.officialNoticeURL(url) == nil)
        }
    }

    @Test func alternativesReuseOnlyFreshSnapshotBoundCatalogueScoresAndRetainedPictures() async throws {
        let now = Date(), rules = NativeProductContextRules()
        let engine = NativeProductRatingEngine(catalogue: nil, now: { now })
        // The source omits salt, so neither active engine can calculate the
        // candidate from these facts. A retained, bound reviewed result may be
        // shown without filling the absent nutrient in the saved label.
        let raw: [String: Any] = ["code": "10000001", "product_name": "Falafel", "brands": "QA",
            "countries_tags": ["en:united-kingdom"], "stores": "Sainsbury's", "categories_tags": ["en:falafels"],
            "ingredients_text": "Chickpeas (60%), water", "nutrition_data_per": "100g",
            "nutriments": ["energy-kcal_100g": 200, "fat_100g": 2, "saturated-fat_100g": 0.5,
                "carbohydrates_100g": 30, "sugars_100g": 3, "proteins_100g": 10, "fiber_100g": 6]]
        let original = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": raw]), barcode: "10000001", retrievedAt: now)
        var current = product("100")
        current["name"] = "Falafel"; current["categories"] = ["en:falafels"]; current["ingredients"] = "Chickpeas (60%), water"
        current["scoringFacts"] = ["fvlPercent": ["value": 60, "source": "declared", "evidence": "Synthetic reference label"],
            "isBeverage": false, "isCheese": false, "isWater": false, "isFatOilNutsSeeds": false, "isRedMeatProduct": false]
        #expect(rules.canOffer(current))
        let withoutScore = try #require(rules.productFacts(original, ratingEngine: engine))
        #expect(rules.select(current: current, candidates: [withoutScore], profile: [:], avoidMilk: false).isEmpty)
        func prepared(expired: Bool = false, estimated: Bool = false) throws -> BarcodeProduct {
            var value = original
            let score: [String: Any] = ["methodId": ActiveScoringFixture.method, "version": ActiveScoringFixture.version, "methodVersion": ActiveScoringFixture.version,
                "classifierVersion": ActiveScoringFixture.classifier, "status": "rated", "available": true,
                "value": 100, "rawScore": 0, "category": "general", "grade": "A", "baseFrequency": NSNull(), "finalFrequency": NSNull(),
                "estimated": estimated, "calculationBasis": ["per": 100, "unit": "g", "preparation": "as_sold"]]
            value.catalogueRating = ProductCatalogueRating(method: ActiveScoringFixture.method, version: ActiveScoringFixture.version,
                classifierVersion: ActiveScoringFixture.classifier, sourceRevision: nil,
                fetchedAt: now.addingTimeInterval(-60), expiresAt: now.addingTimeInterval(expired ? -1 : 3600), calculatedAt: now,
                snapshotFingerprint: try #require(ProductCatalogueRating.fingerprint(value)),
                scoreData: try JSONSerialization.data(withJSONObject: score))
            value.retainedPublicImageURL = "https://images.openfoodfacts.org/images/products/10000001/front_en.1.400.jpg"
            return value
        }
        let candidate = try prepared()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let before = try encoder.encode(candidate)
        let facts = try #require(rules.productFacts(candidate, ratingEngine: engine))
        let selected = rules.select(current: current, candidates: [facts], profile: [:], avoidMilk: false, selectedStore: .sainsburys)
        #expect(selected.count == 1)
        #expect(selected.first?["value"] as? Int == 100)
        #expect(facts["imageURL"] == nil)
        #expect(facts["displayImageURL"] as? String == candidate.displayImageURL)
        #expect(candidate.displayImageURL != nil)
        #expect(try encoder.encode(candidate) == before)
        var changed = candidate; changed.labelsTags = ["en:vegan"]
        for invalid in [changed, try prepared(expired: true)] {
            let rejected = try #require(rules.productFacts(invalid, ratingEngine: engine))
            #expect(rejected["scoreResult"] == nil)
            #expect(rules.select(current: current, candidates: [rejected], profile: [:], avoidMilk: false).isEmpty)
        }
        let estimatedFacts = try #require(rules.productFacts(try prepared(estimated: true), ratingEngine: engine))
        #expect(((estimatedFacts["scoreResult"] as? [String: Any])?["result"] as? [String: Any])?["estimated"] as? Bool == true)
        let feed = available
        let model = NativeProductContextModel(rules: rules, fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in [facts] })
        await model.load(product: current, profile: [:], avoidMilk: false, selectedStore: .sainsburys)
        await settle { !model.alternativesLoading }
        #expect(model.rows.first?["imageURL"] as? String == candidate.displayImageURL)
    }

    @Test func alternativesAreOnDemandReadOnlyAndRecalledCandidatesAreExcluded() async {
        let current = product("100"), candidate = product("200", highScore: true), feed = recall("Synthetic oat bar")
        var fetches = 0, callbacks: [String] = []
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in fetches += 1; return [candidate] })
        await model.load(product: current, profile: [:], avoidMilk: false, automaticallyFindAlternatives: false) { callbacks.append($0["status"] as? String ?? "") }
        #expect(fetches == 0)
        #expect(callbacks == ["checking", "no_matching_notice_found"])
        model.findAlternatives()
        await settle { !model.alternativesLoading }
        #expect(fetches == 1)
        #expect(model.rows.isEmpty)
        #expect(model.alternativesError == nil)
    }

    @Test func failedAlternativesStayNonblockingUntilExplicitRetry() async {
        var fetches = 0
        let feed = available
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in fetches += 1; throw BarcodeLookupError.rateLimited })
        await model.load(product: product("100"), profile: [:], avoidMilk: false, automaticallyFindAlternatives: false)
        model.findAlternatives()
        await settle { !model.alternativesLoading }
        #expect(fetches == 1)
        #expect(model.alternativesError?.contains("busy") == true)
        #expect(model.alternativesError?.contains("product result is ready") == true)
        #expect(model.alternativesError?.contains("Open Food Facts") == false)
        for _ in 0..<10 { await Task.yield() }
        #expect(fetches == 1)
        model.findAlternatives()
        await settle { !model.alternativesLoading }
        #expect(fetches == 2)
    }

    @Test func catalogueAlternativesFailureDoesNotClaimProviderFailureOrEraseProductRecall() async {
        let feed = available
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in throw ProductSearchError.unavailable })
        await model.load(product: product("100"), profile: [:], avoidMilk: false, automaticallyFindAlternatives: false)
        let identity = model.identity, assessment = model.assessment as NSDictionary
        model.findAlternatives()
        await settle { !model.alternativesLoading }
        #expect(model.alternativesSnapshot.status == .failed)
        #expect(model.alternativesSnapshot.message.contains("product result is ready"))
        #expect(model.alternativesSnapshot.message.contains("Nudge catalogue"))
        #expect(!model.alternativesSnapshot.message.contains("Open Food Facts"))
        #expect(model.identity == identity)
        #expect(assessment.isEqual(to: model.assessment))
        #expect(model.canOfferAlternatives)
    }

    @Test func oldRecallAndAlternativeResponsesCannotReplaceNewProduct() async {
        let recallGate = RecallGate(), alternativeGate = AlternativesGate()
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { await recallGate.wait() }, fetchAlternatives: { _, _, _, _ in await alternativeGate.wait() })
        let first = product("100"), second = product("300"), candidate = product("200", highScore: true)
        var callbacks: [String] = []
        let loadFirst = Task { await model.load(product: first, profile: [:], avoidMilk: false, automaticallyFindAlternatives: false) { callbacks.append($0["status"] as? String ?? "") } }
        await settle { recallGate.pending.count == 1 }
        model.findAlternatives()
        await settle { alternativeGate.pending.count == 1 }
        let loadSecond = Task { await model.load(product: second, profile: ["diet": "vegan"], avoidMilk: false, automaticallyFindAlternatives: false) { callbacks.append($0["status"] as? String ?? "") } }
        await settle { recallGate.pending.count == 2 }
        #expect(recallGate.pending.count == 2)
        guard recallGate.pending.count == 2, alternativeGate.pending.count == 1 else { loadFirst.cancel(); loadSecond.cancel(); return }
        recallGate.pending[0].resume(returning: recall("Synthetic sweet biscuit"))
        alternativeGate.pending[0].resume(returning: [candidate])
        await loadFirst.value
        #expect(model.recallLoading)
        #expect(model.rows.isEmpty)
        #expect(callbacks == ["checking", "checking"])
        recallGate.pending[1].resume(returning: available)
        await loadSecond.value
        #expect(!model.recallLoading)
        #expect(callbacks == ["checking", "checking", "no_matching_notice_found"])
        #expect(model.rows.isEmpty)
    }

    @Test func selectedSupermarketAutomaticallyLoadsOnlyListedUKCandidates() async {
        let candidate = product("200", highScore: true), feed = available
        var otherStore = product("201", highScore: true); otherStore["stores"] = ["Tesco"]
        var wrongCountry = product("202", highScore: true); wrongCountry["countriesTags"] = ["en:france"]
        var brandOnly = product("203", highScore: true); brandOnly["brand"] = "Sainsbury’s"; brandOnly["stores"] = []
        var aliases = product("204", highScore: true); aliases["stores"] = ["en:sainsbury-s", "Tesco"]
        var requests: [(String, ProductSearchStore?, String?, String?)] = []
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { category, store, basis, preparation in
            requests.append((category, store, basis, preparation))
            return [candidate, otherStore, wrongCountry, brandOnly, aliases]
        })
        await model.load(product: product("100"), profile: [:], avoidMilk: false, selectedStore: .sainsburys)
        await settle { !model.alternativesLoading }
        #expect(requests.count == 1)
        #expect(requests.first?.0 == "en:cereal-bars")
        #expect(requests.first?.1 == .sainsburys)
        #expect(requests.first?.2 == "g")
        #expect(requests.first?.3 == "as_sold")
        #expect(model.selectedStore == .sainsburys)
        #expect(model.alternativesRequested)
        #expect(Set(model.rows.compactMap { ($0["product"] as? [String: Any])?["barcode"] as? String }) == ["200", "204"])
        #expect(model.rows.allSatisfy { $0["retailer"] as? String == ProductSearchStore.sainsburys.title })
    }

    @Test func lowRatedScanAutomaticallyPublishesAlternativesWithoutSelectingAStore() async {
        let feed = available, candidate = product("200", highScore: true)
        var snapshots: [NativeProductAlternativesSnapshot] = [], fetches = 0
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, store, _, _ in
            #expect(store == nil)
            fetches += 1
            return [candidate]
        })
        await model.load(product: product("100"), profile: [:], avoidMilk: false, onAlternativesChange: { snapshots.append($0) })
        await settle { !model.alternativesLoading }
        #expect(fetches == 1)
        #expect(snapshots.first?.status == .loading)
        #expect(snapshots.last?.status == .ready)
        #expect(snapshots.last?.rows.first?["identity"] as? String == "barcode:200")
        #expect((snapshots.last?.rows.first?["product"] as? [String: Any])?["barcode"] as? String == "200")
        #expect(snapshots.last?.message.contains("Availability") == true)
    }

    @Test func explicitHistoryAlternativesFindsOptionsForMiddleRatedProductsAndKeepsInputsUntouched() async throws {
        func nutrient(_ value: Double) -> [String: Any] { ["value": value, "unit": "g", "status": "supplied"] }
        var current = product("history-original", highScore: true)
        var nutrients = current["nutrients"] as! [String: Any]
        nutrients["saturatedFat"] = nutrient(3); nutrients["sugars"] = nutrient(10)
        nutrients["salt"] = nutrient(0.7)
        current["nutrients"] = nutrients
        let rules = NativeProductContextRules()
        #expect(rules.canOffer(current))
        #expect(!rules.isBelowFifty(current))
        let original = try JSONSerialization.data(withJSONObject: current, options: [.sortedKeys])
        let feed = available, candidate = product("better", highScore: true)
        var requests = 0
        let model = NativeProductContextModel(rules: rules, fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in
            requests += 1; return [candidate]
        })
        await model.load(product: current, profile: [:], avoidMilk: false, forceAlternatives: true)
        await settle { !model.alternativesLoading }
        #expect(requests == 1)
        #expect(model.rows.count == 1)
        #expect(try JSONSerialization.data(withJSONObject: current, options: [.sortedKeys]) == original)
    }

    @Test func ineligibleEmptyAndFailedScansPublishHonestNonblockingStates() async {
        let feed = available
        var snapshots: [NativeProductAlternativesSnapshot] = [], fetches = 0
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in
            fetches += 1
            if fetches == 1 { return [] }
            throw BarcodeLookupError.rateLimited
        })
        await model.load(product: product("100", highScore: true), profile: [:], avoidMilk: false, selectedStore: .sainsburys, onAlternativesChange: { snapshots.append($0) })
        #expect(fetches == 0)
        #expect(snapshots.last?.status == .ineligible)
        await model.load(product: product("101"), profile: [:], avoidMilk: false, selectedStore: .sainsburys, onAlternativesChange: { snapshots.append($0) })
        await settle { !model.alternativesLoading }
        #expect(snapshots.last?.status == .empty)
        #expect(snapshots.last?.message.contains(ProductSearchStore.sainsburys.title) == true)
        #expect(snapshots.last?.rows.isEmpty == true)
        model.findAlternatives()
        await settle { !model.alternativesLoading }
        #expect(snapshots.last?.status == .failed)
        #expect(snapshots.last?.message.contains("busy") == true)
        #expect(fetches == 2)
    }

    @Test func cancellingScanClearsAndDetachesAlternativesWithoutPublishingLateCallbacks() async {
        let gate = AlternativesGate(), feed = available
        var snapshots: [NativeProductAlternativesSnapshot] = []
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, _, _, _ in await gate.wait() })
        await model.load(product: product("100"), profile: [:], avoidMilk: false, onAlternativesChange: { snapshots.append($0) })
        await settle { gate.pending.count == 1 }
        let countBeforeCancel = snapshots.count
        model.cancel()
        #expect(model.rows.isEmpty)
        guard let pending = gate.pending.first else { return }
        pending.resume(returning: [product("200", highScore: true)])
        for _ in 0..<30 { await Task.yield() }
        #expect(model.rows.isEmpty)
        #expect(snapshots.count == countBeforeCancel)
    }

    @Test func scopedAlternativesStartAlongsideRecallButNeverDisplayBeforeRecallCompletes() async {
        let gate = RecallGate(), candidate = product("200", highScore: true)
        var requests = 0
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { await gate.wait() }, fetchAlternatives: { _, _, _, _ in requests += 1; return [candidate] })
        let loading = Task { await model.load(product: product("100"), profile: [:], avoidMilk: false, selectedStore: .sainsburys) }
        await settle { requests == 1 && gate.pending.count == 1 && !model.alternativesLoading }
        #expect(requests == 1)
        #expect(model.recallLoading)
        #expect(model.rows.isEmpty)
        guard let continuation = gate.pending.first else { loading.cancel(); return }
        continuation.resume(returning: available)
        await loading.value
        #expect(model.rows.count == 1)
    }

    @Test func switchingSupermarketRejectsLateCandidateResponse() async {
        let gate = AlternativesGate(), feed = available
        var requestedStores: [ProductSearchStore?] = []
        let model = NativeProductContextModel(rules: NativeProductContextRules(), fetchRecall: { feed }, fetchAlternatives: { _, store, _, _ in
            requestedStores.append(store)
            return await gate.wait()
        })
        let current = product("100")
        await model.load(product: current, profile: [:], avoidMilk: false, selectedStore: .sainsburys)
        await settle { gate.pending.count == 1 }
        let firstIdentity = model.identity
        await model.load(product: current, profile: [:], avoidMilk: false, selectedStore: .tesco)
        await settle { gate.pending.count == 2 }
        #expect(model.identity != firstIdentity)
        #expect(requestedStores == [.sainsburys, .tesco])
        guard gate.pending.count == 2 else { model.cancel(); return }
        gate.pending[0].resume(returning: [product("200", highScore: true)])
        var tesco = product("201", highScore: true); tesco["stores"] = ["Tesco"]
        gate.pending[1].resume(returning: [tesco])
        await settle { !model.alternativesLoading }
        #expect(model.rows.count == 1)
        #expect((model.rows.first?["product"] as? [String: Any])?["barcode"] as? String == "201")
    }

    @Test func recallUpdatesDontRestartIdentityButProfileAndEvidenceChangesDo() {
        let original = product("100"), profile: [String: Any] = ["diet": "mixed"]
        let identity = NativeProductContextRules.identity(product: original, profile: profile, avoidMilk: false)
        var updated = original; updated["recallAssessment"] = ["status": "checking"]
        #expect(identity == NativeProductContextRules.identity(product: updated, profile: profile, avoidMilk: false))
        updated["captureRevision"] = 2
        #expect(identity != NativeProductContextRules.identity(product: updated, profile: profile, avoidMilk: false))
        #expect(identity != NativeProductContextRules.identity(product: original, profile: ["diet": "vegan"], avoidMilk: false))
    }
}

/// The actual alternatives shelf is hosted with self-contained synthetic
/// pictures. No product lookup, profile, native store or phone records are used.
@MainActor
final class NativeAlternativeCardTests: XCTestCase {
    func testCardsFitPhoneWidthsAndLargeTextWithoutOpeningProducts() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        let image = try syntheticProductImage()
        let rows: [[String: Any]] = [
            ["value": 100, "product": ["barcode": "10000001", "name": "Yeast extract", "brand": "Synthetic Pantry", "imageURL": image]],
            ["value": 25, "product": ["barcode": "10000002", "name": "Organic yeast extract with added vitamins", "brand": "Synthetic Kitchen", "imageURL": image]]
        ]
        var openCount = 0
        for (width, large) in [(CGFloat(320), false), (CGFloat(390), false), (CGFloat(320), true)] {
            var frames: [String: CGRect] = [:]
            let root = ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Better alternatives").font(.title2.bold())
                    NativeProductAlternativesCarousel(rows: rows) { _ in openCount += 1 }
                    Text("Comparable UK products").font(.caption)
                }.padding(16)
            }
            .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
            .onPreferenceChange(NativeTrackingRenderGeometryKey.self) { frames = $0 }
            let host = UIHostingController(rootView: root), parent = UIViewController()
            parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
            let traits = UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large)
            parent.setOverrideTraitCollection(traits, forChild: host)
            window.rootViewController = parent; window.makeKeyAndVisible()
            parent.view.frame = CGRect(x: 0, y: 0, width: width, height: 844)
            host.view.frame = parent.view.bounds
            await layout(host.view)
            let viewport = try XCTUnwrap(frames["native-product-alternatives-carousel"])
            let first = try XCTUnwrap(frames["native-product-alternative-10000001"])
            assertUsableCard(first, in: viewport)
            let horizontal = descendants(host.view).compactMap { $0 as? UIScrollView }
                .first { $0.contentSize.width > $0.bounds.width + 1 }
            if width == 320 { XCTAssertNotNil(horizontal, "The remaining cards must be reachable by horizontal scrolling") }
            if let horizontal {
                XCTAssertLessThanOrEqual(horizontal.bounds.width, width - 32 + 1, "Only the shelf pans; it must not widen the page")
            }
            XCTAssertEqual(openCount, 0, "Rendering a shelf cannot open or log a product")
            attach(host.view, "Alternatives \(Int(width))pt \(large ? "AX5" : "regular") first card")

            // The second card must be reachable and fully fit the viewport even
            // when large text increases the product name and badge height.
            if let horizontal {
                horizontal.setContentOffset(CGPoint(x: max(0, horizontal.contentSize.width - horizontal.bounds.width), y: 0), animated: false)
            }
            await layout(host.view)
            let second = try XCTUnwrap(frames["native-product-alternative-10000002"])
            assertUsableCard(second, in: try XCTUnwrap(frames["native-product-alternatives-carousel"]))
            XCTAssertEqual(openCount, 0, "Browsing alternatives must not choose one")
            if large { attach(host.view, "Alternatives 320pt AX5 long name after scrolling") }
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
    }

    private func assertUsableCard(_ card: CGRect, in viewport: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertGreaterThanOrEqual(card.width, 44, file: file, line: line)
        XCTAssertGreaterThanOrEqual(card.height, 44, file: file, line: line)
        XCTAssertGreaterThanOrEqual(card.minX, viewport.minX - 1, file: file, line: line)
        XCTAssertLessThanOrEqual(card.maxX, viewport.maxX + 1, file: file, line: line)
        XCTAssertGreaterThanOrEqual(card.minY, viewport.minY - 1, file: file, line: line)
        XCTAssertLessThanOrEqual(card.maxY, viewport.maxY + 1, "A tall card must not be cropped by the shelf", file: file, line: line)
    }

    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
    private func layout(_ view: UIView) async {
        view.setNeedsLayout(); view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 200_000_000)
        view.layoutIfNeeded()
    }
    private func attach(_ view: UIView, _ name: String) {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { _ in view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func syntheticProductImage() throws -> String {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 96), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 96))
            UIColor.systemBrown.setFill(); UIBezierPath(roundedRect: CGRect(x: 12, y: 20, width: 40, height: 68), cornerRadius: 7).fill()
            UIColor.systemYellow.setFill(); context.fill(CGRect(x: 10, y: 11, width: 44, height: 14))
            UIColor.white.setFill(); context.fill(CGRect(x: 14, y: 44, width: 36, height: 28))
        }
        return "data:image/jpeg;base64," + (try XCTUnwrap(image.jpegData(compressionQuality: 0.8))).base64EncodedString()
    }
}

@MainActor private final class RecallGate {
    var pending: [CheckedContinuation<[String: Any], Never>] = []
    func wait() async -> [String: Any] { await withCheckedContinuation { pending.append($0) } }
}
@MainActor private final class AlternativesGate {
    var pending: [CheckedContinuation<[[String: Any]], Never>] = []
    func wait() async -> [[String: Any]] { await withCheckedContinuation { pending.append($0) } }
}

// Public catalogue wire captured by authenticated read-only search/batch on 2026-10-15T09:52:43.398535+00:00.
// Source facts: Open Food Facts (ODbL), served by Nudge's catalogue. This fixture
// contains three public products only; no phone History, account or profile data.
extension NativeProductContextTests {
    @Test func frozenMarmiteCatalogueWireRetainsAlternativesThroughNativeParsingAndSelection() async throws {
        let raw = #"""
{"version":"nudge-catalogue-index-v1","products":[{"code":"03422649","product_name":"Meridian Yeast Extract","product_name_en":"Meridian Yeast Extract","brands":"Meridian","quantity":"340g","product_quantity":340,"product_quantity_unit":"g","ingredients_text":"Yeast Extract","ingredients_text_en":"Yeast Extract","ingredients":[{"vegan":"yes","is_in_taxonomy":1,"percent_max":100,"ciqual_proxy_food_code":"11009","percent_min":100,"percent_estimate":100,"vegetarian":"yes","id":"en:yeast-extract","text":"Yeast Extract"}],"ingredients_analysis_tags":["en:palm-oil-free","en:vegan","en:vegetarian"],"allergens":null,"allergens_tags":[],"traces":"en:nuts,en:peanuts,en:sesame-seeds","traces_tags":["en:nuts","en:peanuts","en:sesame-seeds"],"nutriments":{},"nutrition":{"aggregated_set":{"per":"100g","preparation":"as_sold","nutrients":{"sugars":{"unit":"g","source_per":"100g","source":"packaging","value":1.7,"source_index":0},"sucrose":{"source_index":1,"value":0.1,"modifier":"~","source":"estimate","source_per":"100g","unit":"g"},"maltose":{"unit":"g","source":"estimate","source_per":"100g","source_index":1,"modifier":"~","value":2.2},"polyols":{"unit":"g","source_per":"100g","source":"estimate","modifier":"~","value":0,"source_index":1},"energy":{"value_computed":1160.6,"value":1161,"unit":"kJ","source_index":0,"source":"packaging","source_per":"100g"},"salt":{"value":0.8,"value_computed":0.8,"unit":"g","source_index":0,"source_per":"100g","source":"packaging"},"water":{"source_index":1,"value":5,"modifier":"~","source_per":"100g","source":"estimate","unit":"g"},"saturated-fat":{"unit":"g","source":"packaging","source_per":"100g","source_index":0,"value":0.1},"magnesium":{"source_index":1,"modifier":"~","value":0.15,"unit":"g","source_per":"100g","source":"estimate"},"carbohydrates":{"source":"packaging","source_per":"100g","unit":"g","source_index":0,"value":18.5},"vitamin-b12":{"unit":"g","source_per":"100g","source":"estimate","source_index":1,"modifier":"~","value":3.4e-07},"galactose":{"source_index":1,"modifier":"~","value":0,"unit":"g","source":"estimate","source_per":"100g"},"calcium":{"value":0.13,"modifier":"~","source_index":1,"source":"estimate","source_per":"100g","unit":"g"},"iodine":{"source_index":1,"modifier":"~","value":1e-05,"unit":"g","source":"estimate","source_per":"100g"},"vitamin-e":{"unit":"g","source_per":"100g","source":"estimate","modifier":"~","value":9.8e-05,"source_index":1},"phosphorus":{"unit":"g","source_per":"100g","source":"estimate","source_index":1,"modifier":"~","value":1.1},"proteins":{"value":48.6,"source_index":0,"source_per":"100g","source":"packaging","unit":"g"},"fat":{"source":"packaging","source_per":"100g","unit":"g","source_index":0,"value":0.3},"energy-kj":{"unit":"kJ","value_computed":1160.6,"value":1161,"source_per":"100g","source":"packaging","source_index":0},"added-sugars":{"value":0,"modifier":"~","source_index":1,"source_per":"100g","source":"estimate","unit":"g"},"vitamin-c":{"unit":"g","source":"estimate","source_per":"100g","modifier":"~","value":0.00025,"source_index":1},"iron":{"unit":"g","source":"estimate","source_per":"100g","modifier":"~","value":0.0041,"source_index":1},"potassium":{"unit":"g","source_per":"100g","source":"estimate","source_index":1,"modifier":"~","value":1.7},"vitamin-d":{"value":1.3e-07,"modifier":"~","source_index":1,"source_per":"100g","source":"estimate","unit":"g"},"fructose":{"modifier":"~","value":0.1,"source_index":1,"unit":"g","source_per":"100g","source":"estimate"},"zinc":{"unit":"g","source_per":"100g","source":"estimate","source_index":1,"modifier":"~","value":0.0084},"vitamin-b6":{"source_index":1,"value":0.00088,"modifier":"~","source":"estimate","source_per":"100g","unit":"g"},"pantothenic-acid":{"value":0.00514,"modifier":"~","source_index":1,"source":"estimate","source_per":"100g","unit":"g"},"copper":{"value":0.00039,"modifier":"~","source_index":1,"source":"estimate","source_per":"100g","unit":"g"},"selenium":{"source_index":1,"value":1e-05,"modifier":"~","source":"estimate","source_per":"100g","unit":"g"},"fruits-vegetables-nuts":{"unit":"%","source_per":"100g","source":"estimate","modifier":"~","value":0,"source_index":1},"fruits-vegetables-legumes":{"source":"estimate","source_per":"100g","unit":"%","source_index":1,"value":0,"modifier":"~"},"nova-group":{"source":"packaging","source_per":"100g","unit":null,"value":1,"source_index":0},"beta-carotene":{"source_index":1,"value":2.5e-06,"modifier":"~","source":"estimate","source_per":"100g","unit":"g"},"lactose":{"source_per":"100g","source":"estimate","unit":"g","source_index":1,"value":0.1,"modifier":"~"},"vitamin-pp":{"unit":"g","source_per":"100g","source":"packaging","source_index":0,"value":0.059000000000000004},"vitamin-b2":{"source":"estimate","source_per":"100g","unit":"g","source_index":1,"value":0.001,"modifier":"~"},"glucose":{"source_index":1,"modifier":"~","value":0.3,"unit":"g","source_per":"100g","source":"estimate"},"vitamin-b9":{"unit":"g","source_per":"100g","source":"estimate","source_index":1,"modifier":"~","value":0.000697},"starch":{"modifier":"~","value":3.7,"source_index":1,"unit":"g","source":"estimate","source_per":"100g"},"cholesterol":{"source_index":1,"modifier":"~","value":0.00035,"unit":"g","source_per":"100g","source":"estimate"},"manganese":{"source_per":"100g","source":"estimate","unit":"g","value":0.00089,"modifier":"~","source_index":1},"energy-kcal":{"source":"packaging","source_per":"100g","source_index":0,"unit":"kcal","value_computed":273.29999999999995,"value":278},"alcohol":{"value":0,"source_index":0,"unit":"% vol","source":"packaging","source_per":"100g"},"vitamin-b1":{"modifier":"~","value":0.0116,"source_index":1,"unit":"g","source_per":"100g","source":"estimate"},"phylloquinone":{"modifier":"~","value":4e-07,"source_index":1,"unit":"g","source_per":"100g","source":"estimate"},"vitamin-a":{"source":"estimate","source_per":"100g","unit":"g","value":1.05e-05,"modifier":"~","source_index":1},"fiber":{"source_index":0,"value":1.1,"source":"packaging","source_per":"100g","unit":"g"},"sodium":{"unit":"g","value":0.32,"value_computed":0.32,"source":"packaging","source_per":"100g","source_index":0}}},"input_sets":[{"nutrients":{"sodium":{"unit":"g","value_computed":0.32,"value_string":"0.32","value":0.32},"fiber":{"value":1.1,"value_string":"1.1","unit":"g"},"vitamin-pp":{"value":0.059000000000000004,"value_string":"0.059","unit":"g"},"energy-kcal":{"value_computed":273.29999999999995,"value_string":"278","value":278,"unit":"kcal"},"alcohol":{"value_string":"0","value":0,"unit":"% vol"},"nova-group":{"unit":null,"value_string":"1","value":1},"saturated-fat":{"unit":"g","value":0.1,"value_string":"0.1"},"energy-kj":{"unit":"kJ","value":1161,"value_computed":1160.6,"value_string":"1161"},"carbohydrates":{"value":18.5,"value_string":"18.5","unit":"g"},"fat":{"unit":"g","value":0.3,"value_string":"0.3"},"proteins":{"unit":"g","value_string":"48.6","value":48.6},"sugars":{"unit":"g","value":1.7,"value_string":"1.7"},"salt":{"unit":"g","value_computed":0.8,"value_string":"0.8","value":0.8}},"last_updated_t":1774627133,"per_quantity":100,"per":"100g","preparation":"as_sold","per_unit":"g","source":"packaging"},{"per_quantity":100,"per":"100g","nutrients":{"vitamin-c":{"unit":"g","modifier":"~","value":0.00025,"value_string":"0.00025"},"added-sugars":{"unit":"g","value":0,"modifier":"~","value_string":"0"},"iron":{"value_string":"0.0041","value":0.0041,"modifier":"~","unit":"g"},"potassium":{"modifier":"~","value":1.7,"value_string":"1.7","unit":"g"},"vitamin-d":{"value_string":"1.3e-07","modifier":"~","value":1.3e-07,"unit":"g"},"fructose":{"unit":"g","modifier":"~","value":0.1,"value_string":"0.1"},"phosphorus":{"modifier":"~","value":1.1,"value_string":"1.1","unit":"g"},"fat":{"value_string":"4.5","value":4.5,"modifier":"~","unit":"g"},"proteins":{"unit":"g","value_string":"40.4","modifier":"~","value":40.4},"energy-kj":{"value_string":"1400","value_computed":1403.9,"modifier":"~","value":1400,"unit":"kJ"},"vitamin-b12":{"unit":"g","value_string":"3.4e-07","value":3.4e-07,"modifier":"~"},"galactose":{"unit":"g","value_string":"0","value":0,"modifier":"~"},"calcium":{"value":0.13,"modifier":"~","value_string":"0.13","unit":"g"},"iodine":{"value_string":"1e-05","value":1e-05,"modifier":"~","unit":"g"},"vitamin-e":{"value":9.8e-05,"modifier":"~","value_string":"9.8e-05","unit":"g"},"sugars":{"modifier":"~","value":2.5,"value_string":"2.5","unit":"g"},"sucrose":{"unit":"g","value_string":"0.1","modifier":"~","value":0.1},"maltose":{"unit":"g","value":2.2,"modifier":"~","value_string":"2.2"},"polyols":{"value":0,"modifier":"~","value_string":"0","unit":"g"},"energy":{"modifier":"~","value":1400,"value_string":"1400","unit":"kJ"},"salt":{"modifier":"~","value":0.35,"value_string":"0.35","value_computed":0.3525,"unit":"g"},"water":{"value":5,"modifier":"~","value_string":"5","unit":"g"},"saturated-fat":{"unit":"g","value_string":"0.7","value":0.7,"modifier":"~"},"magnesium":{"value_string":"0.15","value":0.15,"modifier":"~","unit":"g"},"carbohydrates":{"value_string":"21.8","value":21.8,"modifier":"~","unit":"g"},"manganese":{"unit":"g","value_string":"0.00089","modifier":"~","value":0.00089},"energy-kcal":{"unit":"kcal","value":334,"modifier":"~","value_computed":334.3,"value_string":"334"},"alcohol":{"unit":"% vol","modifier":"~","value":0,"value_string":"0"},"vitamin-b1":{"unit":"g","value_string":"0.0116","value":0.0116,"modifier":"~"},"phylloquinone":{"unit":"g","value_string":"4e-07","modifier":"~","value":4e-07},"vitamin-a":{"modifier":"~","value":1.05e-05,"value_string":"1.05e-05","unit":"g"},"fiber":{"value_string":"22.5","modifier":"~","value":22.5,"unit":"g"},"sodium":{"value":0.141,"modifier":"~","value_computed":0.14,"value_string":"0.141","unit":"g"},"glucose":{"unit":"g","value_string":"0.3","modifier":"~","value":0.3},"vitamin-b9":{"modifier":"~","value":0.000697,"value_string":"0.000697","unit":"g"},"starch":{"unit":"g","modifier":"~","value":3.7,"value_string":"3.7"},"cholesterol":{"value_string":"0.00035","modifier":"~","value":0.00035,"unit":"g"},"fruits-vegetables-nuts":{"value":0,"modifier":"~","value_string":"0","unit":"%"},"fruits-vegetables-legumes":{"unit":"%","value":0,"modifier":"~","value_string":"0"},"beta-carotene":{"unit":"g","value":2.5e-06,"modifier":"~","value_string":"2.5e-06"},"lactose":{"unit":"g","value":0.1,"modifier":"~","value_string":"0.1"},"vitamin-pp":{"value":0.0185,"modifier":"~","value_string":"0.0185","unit":"g"},"vitamin-b2":{"value":0.001,"modifier":"~","value_string":"0.001","unit":"g"},"zinc":{"unit":"g","value_string":"0.0084","value":0.0084,"modifier":"~"},"vitamin-b6":{"value_string":"0.00088","modifier":"~","value":0.00088,"unit":"g"},"pantothenic-acid":{"unit":"g","modifier":"~","value":0.00514,"value_string":"0.00514"},"copper":{"unit":"g","value_string":"0.00039","modifier":"~","value":0.00039},"selenium":{"unit":"g","value":1e-05,"modifier":"~","value_string":"1e-05"}},"per_unit":"g","source":"estimate","preparation":"as_sold","source_description":"Estimate from ingredients"}]},"categories_tags":["en:plant-based-foods-and-beverages","en:plant-based-foods","en:spreads","en:plant-based-spreads","en:salted-spreads","en:yeast-extract-spreads"],"countries_tags":["en:united-kingdom"],"stores_tags":[],"stores":null,"labels_tags":[],"last_modified_t":1774627133,"data_quality_errors_tags":[],"data_quality_warnings_tags":["en:environmental-score-packaging-unspecified-shape","en:environmental-score-production-system-no-label"],"selected_images":{"front":{"display":{"en":"https://images.openfoodfacts.org/images/products/000/000/342/2649/front_en.4.400.jpg"},"small":{"en":"https://images.openfoodfacts.org/images/products/000/000/342/2649/front_en.4.200.jpg"}}},"lc":"en","image_front_url":"https://images.openfoodfacts.org/images/products/000/000/342/2649/front_en.4.400.jpg","image_front_small_url":"https://images.openfoodfacts.org/images/products/000/000/342/2649/front_en.4.200.jpg","image_url":"https://images.openfoodfacts.org/images/products/000/000/342/2649/front_en.4.400.jpg","nutriscore_grade":"a","nutrition_grades":"a","nutriscore":{"2021":{"nutriscore_computed":1,"grade":"b","category_available":1,"nutriscore_applicable":1,"score":0,"estimated":0,"data":{"fiber":1.1,"sodium":320,"is_beverage":0,"negative_points":6,"is_water":0,"saturated_fat":0.1,"proteins":48.6,"fiber_value":1.1,"is_fat":0,"sodium_points":3,"sugars_value":1.7,"saturated_fat_value":0.1,"energy_value":1161,"positive_points":6,"sodium_value":320,"fruits_vegetables_nuts_colza_walnut_olive_oils_points":0,"sugars_points":0,"energy_points":3,"fruits_vegetables_nuts_colza_walnut_olive_oils_value":0,"saturated_fat_points":0,"fruits_vegetables_nuts_colza_walnut_olive_oils":0,"fiber_points":1,"proteins_points":5,"proteins_value":48.6,"energy":1161,"sugars":1.7,"is_cheese":0},"preparation":"as_sold","nutrients_available":1},"2023":{"category_available":1,"grade":"a","nutriscore_computed":1,"nutrients_available":1,"data":{"positive_nutrients":["proteins","fiber","fruits_vegetables_legumes"],"negative_points":6,"positive_points_max":17,"is_water":0,"count_proteins_reason":"negative_points_less_than_11","is_beverage":0,"is_red_meat_product":0,"components":{"negative":[{"unit":"kJ","points_max":10,"value":1161,"points":3,"id":"energy"},{"unit":"g","points_max":15,"value":1.7,"points":0,"id":"sugars"},{"unit":"g","points":0,"id":"saturated_fat","points_max":10,"value":0.1},{"unit":"g","value":0.8,"points_max":20,"id":"salt","points":3}],"positive":[{"points":7,"id":"proteins","points_max":7,"value":48.6,"unit":"g"},{"unit":"g","id":"fiber","points":0,"value":1.1,"points_max":5},{"unit":"%","id":"fruits_vegetables_legumes","points":0,"value":0,"points_max":5}]},"positive_points":7,"negative_points_max":55,"count_proteins":1,"is_cheese":0,"is_fat_oil_nuts_seeds":0},"preparation":"as_sold","score":-1,"estimated":0,"nutriscore_applicable":1}},"nova_group":1,"additives_tags":[]},{"code":"5014284003010","product_name":"Yeast extract reduced salt savoury spread","brands":"Natex","quantity":"225 g","product_quantity":225,"product_quantity_unit":"g","ingredients_text":"Yeast Extract, Salt, Parsley Extract, Niacin, Riboflavin, Vitamin B12","ingredients_text_en":"Yeast Extract, Salt, Parsley Extract, Niacin, Riboflavin, Vitamin B12","ingredients":[{"id":"en:yeast-extract","text":"Yeast Extract","ciqual_proxy_food_code":"11009","is_in_taxonomy":1,"vegetarian":"yes","percent_estimate":94,"percent_min":88,"percent_max":100,"vegan":"yes"},{"percent_estimate":1.2,"percent_min":0,"is_in_taxonomy":1,"vegetarian":"yes","vegan":"yes","percent_max":2.4,"ciqual_food_code":"11058","id":"en:salt","text":"Salt"},{"percent_estimate":1.2,"percent_min":0,"is_in_taxonomy":1,"vegetarian":"yes","vegan":"yes","processing":"en:extract","percent_max":2.4,"id":"en:parsley","ciqual_proxy_food_code":"11014","text":"Parsley"},{"percent_max":2.4,"vegan":"maybe","vegetarian":"maybe","is_in_taxonomy":1,"percent_min":0,"percent_estimate":1.2,"text":"Niacin","id":"en:e375"},{"text":"Riboflavin","id":"en:e101","vegan":"maybe","percent_max":2.4,"percent_min":0,"percent_estimate":1.2,"vegetarian":"yes","is_in_taxonomy":1},{"percent_max":2.4,"vegan":"yes","vegetarian":"yes","is_in_taxonomy":1,"percent_min":0,"percent_estimate":1.19999999999999,"text":"Vitamin B12","id":"en:vitamin-b12"}],"ingredients_analysis_tags":["en:palm-oil-free","en:maybe-vegan","en:maybe-vegetarian"],"allergens_tags":[],"traces_tags":[],"nutriments":{},"nutrition":{"input_sets":[{"last_updated_t":1773888273,"per":"100g","nutrients":{"nova-group":{"value":3,"unit":null,"value_string":"3"},"fat":{"value":0.2,"unit":"g","value_string":"0.2"},"sugars":{"value_string":"0.6","unit":"g","value":0.6},"energy-kj":{"value_computed":1102.2,"unit":"kJ"},"saturated-fat":{"value_string":"0.1","unit":"g","value":0.1},"salt":{"value_computed":2.4,"value_string":"2.4","value":2.4,"unit":"g"},"energy-kcal":{"value":266,"unit":"kcal","value_string":"266","value_computed":259.4},"carbohydrates":{"value":15.7,"unit":"g","value_string":"15.7"},"proteins":{"value_string":"48.7","unit":"g","value":48.7},"sodium":{"value_string":"0.96","value_computed":0.96,"value":0.96,"unit":"g"}},"per_quantity":100,"source":"packaging","per_unit":"g","preparation":"as_sold"},{"per_quantity":100,"nutrients":{"vitamin-b12":{"modifier":"~","value":3.196e-07,"unit":"g","value_string":"3.196e-07"},"saturated-fat":{"value_string":"0.6592","value":0.6592,"unit":"g","modifier":"~"},"alcohol":{"value_string":"0","modifier":"~","unit":"% vol","value":0},"carbohydrates":{"value_string":"20.53376","modifier":"~","unit":"g","value":20.53376},"energy-kcal":{"modifier":"~","unit":"kcal","value":314.476,"value_computed":314.75836,"value_string":"314.476"},"water":{"value_string":"5.726324","modifier":"~","unit":"g","value":5.726324},"potassium":{"unit":"g","modifier":"~","value":1.6053788,"value_string":"1.6053788"},"energy-kj":{"value_computed":1321.82528,"value_string":"1318.16","value":1318.16,"modifier":"~","unit":"kJ"},"fruits-vegetables-nuts":{"value_string":"1.2","modifier":"~","value":1.2,"unit":"%"},"starch":{"value_string":"3.48232","value":3.48232,"modifier":"~","unit":"g"},"polyols":{"value":0,"unit":"g","modifier":"~","value_string":"0"},"vitamin-b6":{"value_string":"0.000829","unit":"g","modifier":"~","value":0.000829},"vitamin-b9":{"unit":"g","modifier":"~","value":0.000656788,"value_string":"0.000656788"},"lactose":{"value_string":"0.094","value":0.094,"modifier":"~","unit":"g"},"salt":{"modifier":"~","value":1.50968,"unit":"g","value_string":"1.50968","value_computed":1.505979},"iodine":{"unit":"g","modifier":"~","value":3.175e-05,"value_string":"3.175e-05"},"proteins":{"value_string":"38.02052","unit":"g","modifier":"~","value":38.02052},"cholesterol":{"value_string":"0.000329","value":0.000329,"modifier":"~","unit":"g"},"fructose":{"value":0.0976,"unit":"g","modifier":"~","value_string":"0.0976"},"sucrose":{"modifier":"~","unit":"g","value":0.094,"value_string":"0.094"},"selenium":{"value_string":"9.4072e-06","unit":"g","modifier":"~","value":9.4072e-06},"vitamin-d":{"modifier":"~","unit":"g","value":1.222e-07,"value_string":"1.222e-07"},"sodium":{"modifier":"~","unit":"g","value":0.6023916,"value_string":"0.6023916","value_computed":0.603872},"vitamin-pp":{"value_string":"0.01740812","value":0.01740812,"unit":"g","modifier":"~"},"fiber":{"value_string":"21.2016","unit":"g","modifier":"~","value":21.2016},"phosphorus":{"value_string":"1.034876","value":1.034876,"modifier":"~","unit":"g"},"fruits-vegetables-legumes":{"value":1.2,"unit":"%","modifier":"~","value_string":"1.2"},"vitamin-a":{"value_string":"9.882e-06","value":9.882e-06,"modifier":"~","unit":"g"},"vitamin-e":{"modifier":"~","value":0.00011288,"unit":"g","value_string":"0.00011288"},"beta-carotene":{"value_string":"6.295e-05","value":6.295e-05,"unit":"g","modifier":"~"},"energy":{"modifier":"~","value":1318.16,"unit":"kJ","value_string":"1318.16"},"added-sugars":{"value":0,"modifier":"~","unit":"g","value_string":"0"},"copper":{"value_string":"0.00036984","modifier":"~","unit":"g","value":0.00036984},"iron":{"modifier":"~","value":0.00391352,"unit":"g","value_string":"0.00391352"},"manganese":{"value_string":"0.00085844","modifier":"~","unit":"g","value":0.00085844},"vitamin-b1":{"value_string":"0.0109052","modifier":"~","value":0.0109052,"unit":"g"},"magnesium":{"value_string":"0.1415118","value":0.1415118,"modifier":"~","unit":"g"},"vitamin-c":{"modifier":"~","value":0.002359,"unit":"g","value_string":"0.002359"},"vitamin-b2":{"value_string":"0.0009424","value":0.0009424,"modifier":"~","unit":"g"},"phylloquinone":{"modifier":"~","value":1.5016e-05,"unit":"g","value_string":"1.5016e-05"},"zinc":{"value_string":"0.007906296","unit":"g","value":0.007906296,"modifier":"~"},"maltose":{"value_string":"2.068","unit":"g","value":2.068,"modifier":"~"},"glucose":{"value_string":"0.288","value":0.288,"unit":"g","modifier":"~"},"pantothenic-acid":{"value_string":"0.0048358","value":0.0048358,"modifier":"~","unit":"g"},"galactose":{"modifier":"~","value":0.0018,"unit":"g","value_string":"0.0018"},"sugars":{"value_string":"2.3614","modifier":"~","unit":"g","value":2.3614},"fat":{"modifier":"~","value":4.23756,"unit":"g","value_string":"4.23756"},"calcium":{"modifier":"~","value":0.1249756,"unit":"g","value_string":"0.1249756"}},"source_description":"Estimate from ingredients","per":"100g","source":"estimate","preparation":"as_sold","per_unit":"g"}],"aggregated_set":{"per":"100g","nutrients":{"energy-kj":{"source_per":"100g","source":"packaging","modifier":"~","unit":"kJ","value":1102.2,"source_index":0},"potassium":{"source_per":"100g","source":"estimate","source_index":1,"modifier":"~","value":1.6053788,"unit":"g"},"fruits-vegetables-nuts":{"source_index":1,"source":"estimate","source_per":"100g","unit":"%","value":1.2,"modifier":"~"},"starch":{"source":"estimate","source_index":1,"source_per":"100g","modifier":"~","unit":"g","value":3.48232},"vitamin-b9":{"source_per":"100g","source":"estimate","source_index":1,"value":0.000656788,"unit":"g","modifier":"~"},"polyols":{"source_per":"100g","source":"estimate","source_index":1,"unit":"g","value":0,"modifier":"~"},"vitamin-b6":{"source_per":"100g","source":"estimate","source_index":1,"modifier":"~","unit":"g","value":0.000829},"saturated-fat":{"source_per":"100g","source":"packaging","source_index":0,"value":0.1,"unit":"g"},"alcohol":{"source_index":1,"unit":"% vol","value":0,"modifier":"~","source":"estimate","source_per":"100g"},"vitamin-b12":{"source":"estimate","source_index":1,"value":3.196e-07,"modifier":"~","unit":"g","source_per":"100g"},"water":{"source_per":"100g","source_index":1,"source":"estimate","modifier":"~","value":5.726324,"unit":"g"},"carbohydrates":{"source_per":"100g","source":"packaging","source_index":0,"unit":"g","value":15.7},"energy-kcal":{"value":266,"unit":"kcal","source_index":0,"source":"packaging","source_per":"100g","value_computed":259.4},"vitamin-d":{"source_per":"100g","source_index":1,"source":"estimate","modifier":"~","unit":"g","value":1.222e-07},"vitamin-pp":{"source_index":1,"source":"estimate","source_per":"100g","value":0.01740812,"modifier":"~","unit":"g"},"fiber":{"source_per":"100g","source":"estimate","modifier":"~","value":21.2016,"unit":"g","source_index":1},"sodium":{"value_computed":0.96,"source_per":"100g","source":"packaging","source_index":0,"unit":"g","value":0.96},"phosphorus":{"source_per":"100g","source":"estimate","source_index":1,"value":1.034876,"modifier":"~","unit":"g"},"iodine":{"source":"estimate","source_index":1,"value":3.175e-05,"modifier":"~","unit":"g","source_per":"100g"},"salt":{"source_per":"100g","value_computed":2.4,"source":"packaging","source_index":0,"unit":"g","value":2.4},"lactose":{"modifier":"~","unit":"g","value":0.094,"source_per":"100g","source_index":1,"source":"estimate"},"proteins":{"source_per":"100g","value":48.7,"unit":"g","source_index":0,"source":"packaging"},"cholesterol":{"source_per":"100g","source_index":1,"source":"estimate","modifier":"~","value":0.000329,"unit":"g"},"nova-group":{"unit":null,"value":3,"source_index":0,"source":"packaging","source_per":"100g"},"sucrose":{"source":"estimate","value":0.094,"modifier":"~","unit":"g","source_index":1,"source_per":"100g"},"selenium":{"source":"estimate","source_index":1,"source_per":"100g","unit":"g","value":9.4072e-06,"modifier":"~"},"fructose":{"source_per":"100g","source":"estimate","value":0.0976,"modifier":"~","unit":"g","source_index":1},"copper":{"source":"estimate","source_index":1,"source_per":"100g","modifier":"~","value":0.00036984,"unit":"g"},"vitamin-e":{"source_per":"100g","source":"estimate","unit":"g","value":0.00011288,"modifier":"~","source_index":1},"vitamin-a":{"source_per":"100g","value":9.882e-06,"unit":"g","modifier":"~","source_index":1,"source":"estimate"},"fruits-vegetables-legumes":{"source":"estimate","value":1.2,"unit":"%","modifier":"~","source_index":1,"source_per":"100g"},"added-sugars":{"modifier":"~","unit":"g","value":0,"source_per":"100g","source":"estimate","source_index":1},"energy":{"source_per":"100g","source":"packaging","value":1102.2,"unit":"kJ","modifier":"~","source_index":0},"beta-carotene":{"source_per":"100g","source_index":1,"value":6.295e-05,"modifier":"~","unit":"g","source":"estimate"},"glucose":{"source_per":"100g","source_index":1,"unit":"g","modifier":"~","value":0.288,"source":"estimate"},"pantothenic-acid":{"source_per":"100g","source_index":1,"value":0.0048358,"unit":"g","modifier":"~","source":"estimate"},"galactose":{"source_index":1,"modifier":"~","value":0.0018,"unit":"g","source":"estimate","source_per":"100g"},"calcium":{"source":"estimate","source_index":1,"unit":"g","modifier":"~","value":0.1249756,"source_per":"100g"},"fat":{"source":"packaging","unit":"g","value":0.2,"source_index":0,"source_per":"100g"},"sugars":{"source_per":"100g","source":"packaging","source_index":0,"value":0.6,"unit":"g"},"iron":{"source_per":"100g","source":"estimate","source_index":1,"value":0.00391352,"modifier":"~","unit":"g"},"magnesium":{"value":0.1415118,"modifier":"~","unit":"g","source_per":"100g","source_index":1,"source":"estimate"},"vitamin-c":{"source_per":"100g","source":"estimate","unit":"g","modifier":"~","value":0.002359,"source_index":1},"vitamin-b1":{"modifier":"~","unit":"g","value":0.0109052,"source_index":1,"source":"estimate","source_per":"100g"},"manganese":{"source_per":"100g","modifier":"~","unit":"g","value":0.00085844,"source_index":1,"source":"estimate"},"maltose":{"source_per":"100g","source":"estimate","source_index":1,"unit":"g","value":2.068,"modifier":"~"},"zinc":{"source_index":1,"source":"estimate","source_per":"100g","value":0.007906296,"modifier":"~","unit":"g"},"phylloquinone":{"source":"estimate","source_index":1,"source_per":"100g","value":1.5016e-05,"unit":"g","modifier":"~"},"vitamin-b2":{"unit":"g","value":0.0009424,"modifier":"~","source_per":"100g","source":"estimate","source_index":1}},"preparation":"as_sold"}},"categories_tags":["en:spreads","en:salted-spreads","en:yeast-extract-spreads"],"countries_tags":["en:france","en:united-kingdom"],"labels_tags":["en:vegetarian-society-approved"],"last_modified_t":1773888274,"data_quality_errors_tags":[],"data_quality_warnings_tags":["en:nutrition-fructose-plus-glucose-plus-maltose-plus-lactose-plus-sucrose-greater-than-sugars","en:environmental-score-origins-of-ingredients-origins-are-100-percent-unknown","en:environmental-score-packaging-packaging-data-missing","en:environmental-score-production-system-no-label"],"selected_images":{"front":{"display":{"en":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_en.14.400.jpg","fr":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_fr.3.400.jpg"},"small":{"en":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_en.14.200.jpg","fr":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_fr.3.200.jpg"}}},"lc":"en","image_front_url":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_en.14.400.jpg","image_front_small_url":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_en.14.200.jpg","image_url":"https://images.openfoodfacts.org/images/products/501/428/400/3010/front_en.14.400.jpg","nutriscore_grade":"c","nutrition_grades":"c","nutriscore":{"2021":{"preparation":"as_sold","score":8,"data":{"sugars":0.6,"saturated_fat":0.1,"sugars_points":0,"saturated_fat_points":0,"sodium":960,"proteins_points":5,"fiber":21.2016,"sodium_points":10,"fruits_vegetables_nuts_colza_walnut_olive_oils_points":0,"proteins_value":48.7,"fiber_points":5,"fruits_vegetables_nuts_colza_walnut_olive_oils":1.2,"positive_points":5,"energy_value":1102.2,"proteins":48.7,"is_cheese":0,"is_beverage":0,"fiber_value":21.2,"negative_points":13,"sodium_value":960,"is_fat":0,"sugars_value":0.6,"is_water":0,"fruits_vegetables_nuts_colza_walnut_olive_oils_value":1.2,"energy":1102.2,"saturated_fat_value":0.1,"energy_points":3},"estimated":1,"grade":"c","nutriscore_applicable":1,"nutriscore_computed":1,"category_available":1,"nutrients_available":1},"2023":{"category_available":1,"nutrients_available":1,"preparation":"as_sold","data":{"is_beverage":0,"is_cheese":0,"positive_nutrients":["fiber","fruits_vegetables_legumes"],"is_fat_oil_nuts_seeds":0,"negative_points_max":55,"positive_points":5,"count_proteins":0,"components":{"negative":[{"unit":"kJ","id":"energy","value":1102.2,"points_max":10,"points":3},{"points":0,"points_max":15,"unit":"g","value":0.6,"id":"sugars"},{"points":0,"points_max":10,"id":"saturated_fat","value":0.1,"unit":"g"},{"points_max":20,"points":11,"value":2.4,"id":"salt","unit":"g"}],"positive":[{"id":"fiber","unit":"g","value":21.2,"points":5,"points_max":5},{"points_max":5,"points":0,"unit":"%","value":1.2,"id":"fruits_vegetables_legumes"}]},"is_red_meat_product":0,"is_water":0,"positive_points_max":10,"negative_points":14,"count_proteins_reason":"negative_points_greater_than_or_equal_to_11"},"score":9,"estimated":1,"grade":"c","nutriscore_applicable":1,"nutriscore_computed":1}},"nova_group":3,"additives_tags":[]},{"code":"50184453","product_name":"Yeast Extract","product_name_en":"Yeast Extract","brands":"Marmite","quantity":"250 gram","product_quantity":250,"product_quantity_unit":"g","ingredients_text":"yeast extract, barley, wheat, oats, rye, salt, vegetable juice concentrate, thiamin, riboflavin, niacin, vitamin B12, folic acid, natural flavouring, celery","ingredients_text_en":"yeast extract, barley, wheat, oats, rye, salt, vegetable juice concentrate, thiamin, riboflavin, niacin, vitamin B12, folic acid, natural flavouring, celery","ingredients":[{"ciqual_food_code":"11009","ciqual_proxy_food_code":"11009","id":"en:yeast-extract","is_in_taxonomy":1,"percent_estimate":54.21,"quantity_estimate":54.21,"text":"yeast extract","vegan":"yes","vegetarian":"yes"},{"id":"en:barley","is_in_taxonomy":1,"percent_estimate":16.69,"quantity_estimate":16.69,"text":"barley","vegan":"yes","vegetarian":"yes"},{"ciqual_food_code":"9410","ciqual_proxy_food_code":"9410","id":"en:wheat","is_in_taxonomy":1,"percent_estimate":8.38,"quantity_estimate":8.38,"text":"wheat","vegan":"yes","vegetarian":"yes"},{"ciqual_food_code":"9310","id":"en:oat","is_in_taxonomy":1,"percent_estimate":5.14,"quantity_estimate":5.14,"text":"oats","vegan":"yes","vegetarian":"yes"},{"ciqual_food_code":"9390","id":"en:rye","is_in_taxonomy":1,"percent_estimate":3.51,"quantity_estimate":3.51,"text":"rye","vegan":"yes","vegetarian":"yes"},{"ciqual_food_code":"11058","id":"en:salt","is_in_taxonomy":1,"percent_estimate":2.58,"quantity_estimate":2.58,"text":"salt","vegan":"yes","vegetarian":"yes"},{"id":"en:vegetable-juice","is_in_taxonomy":1,"percent_estimate":1.98,"processing":"en:concentrated","quantity_estimate":1.98,"text":"vegetable juice","vegan":"yes","vegetarian":"yes"},{"id":"en:thiamin","is_in_taxonomy":1,"percent_estimate":1.58,"quantity_estimate":1.58,"text":"thiamin","vegan":"yes","vegetarian":"yes"},{"id":"en:e101","is_in_taxonomy":1,"percent_estimate":1.29,"quantity_estimate":1.29,"text":"riboflavin","vegan":"maybe","vegetarian":"yes"},{"id":"en:e375","is_in_taxonomy":1,"percent_estimate":1.08,"quantity_estimate":1.08,"text":"niacin","vegan":"maybe","vegetarian":"maybe"},{"id":"en:vitamins","is_in_taxonomy":1,"percent_estimate":0.92,"quantity_estimate":0.92,"text":"vitamins","vegan":"yes","vegetarian":"yes"},{"id":"en:vitamin-b12","is_in_taxonomy":1,"percent_estimate":0.79,"quantity_estimate":0.79,"text":"vitamin B12","vegan":"yes","vegetarian":"yes"},{"id":"en:folic-acid","is_in_taxonomy":1,"percent_estimate":0.69,"quantity_estimate":0.69,"text":"folic acid","vegan":"yes","vegetarian":"yes"},{"id":"en:natural-flavouring","is_in_taxonomy":1,"percent_estimate":0.61,"quantity_estimate":0.61,"text":"natural flavouring","vegan":"maybe","vegetarian":"maybe"},{"ciqual_food_code":"20055","ecobalyse_code":"celery-eu","id":"en:celery","is_in_taxonomy":1,"percent_estimate":0.54,"quantity_estimate":0.54,"text":"celery","vegan":"yes","vegetarian":"yes"}],"ingredients_analysis_tags":["en:palm-oil-free","en:vegan","en:vegetarian"],"allergens_tags":["en:celery","en:gluten"],"traces_tags":[],"nutrition":{"aggregated_set":{"nutrients":{"added-sugars":{"modifier":"~","source":"estimate","source_index":1,"source_per":"100g","unit":"g","value":0},"carbohydrates":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":30},"choline":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0},"energy":{"source":"packaging","source_index":0,"source_per":"100g","unit":"kJ","value":1087,"value_computed":256},"energy-kcal":{"source":"packaging","source_index":0,"source_per":"100g","unit":"kcal","value":260,"value_computed":256},"fruits-vegetables-legumes":{"modifier":"~","source":"estimate","source_index":1,"source_per":"100g","unit":"%","value":0.54},"fruits-vegetables-nuts":{"modifier":"~","source":"estimate","source_index":1,"source_per":"100g","unit":"%","value":2.52},"nova-group":{"source":"packaging","source_index":0,"source_per":"100g","unit":null,"value":4},"proteins":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":34},"salt":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":10.8,"value_computed":10.6225},"saturated-fat":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0},"sodium":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":4.249,"value_computed":4.32},"starch":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0},"sugars":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":1.2},"vitamin-b1":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0.0077},"vitamin-b2":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0.0068},"vitamin-b9":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0.00125},"vitamin-pp":{"source":"packaging","source_index":0,"source_per":"100g","unit":"g","value":0.069}},"per":"100g","preparation":"as_sold"},"input_sets":[{"last_updated_t":1771443019,"nutrients":{"carbohydrates":{"unit":"g","value":30,"value_string":"30"},"choline":{"unit":"g","value":0,"value_string":"0"},"energy-kcal":{"unit":"kcal","value":260,"value_computed":256,"value_string":"260"},"nova-group":{"unit":null,"value":4,"value_string":"4"},"proteins":{"unit":"g","value":34,"value_string":"34"},"salt":{"unit":"g","value":10.8,"value_computed":10.6225,"value_string":"10.8"},"saturated-fat":{"unit":"g","value":0,"value_string":"0"},"sodium":{"unit":"g","value":4.249,"value_computed":4.32,"value_string":"4.249"},"starch":{"unit":"g","value":0,"value_string":"0"},"sugars":{"unit":"g","value":1.2,"value_string":"1.2"},"vitamin-b1":{"unit":"g","value":0.0077,"value_string":"0.0077"},"vitamin-b2":{"unit":"g","value":0.0068,"value_string":"0.0068"},"vitamin-b9":{"unit":"g","value":0.00125,"value_string":"0.00125"},"vitamin-pp":{"unit":"g","value":0.069,"value_string":"0.069"}},"per":"100g","per_quantity":100,"per_unit":"g","preparation":"as_sold","source":"packaging"},{"nutrients":{"added-sugars":{"modifier":"~","unit":"g","value":0,"value_string":"0"},"fruits-vegetables-legumes":{"modifier":"~","unit":"%","value":0.54,"value_string":"0.54"},"fruits-vegetables-nuts":{"modifier":"~","unit":"%","value":2.52,"value_string":"2.52"}},"per":"100g","per_quantity":100,"per_unit":"g","preparation":"as_sold","source":"estimate","source_description":"Estimate from ingredients"}]},"nutrition_data_per":"100g","serving_size":"8 gram","serving_quantity":8,"serving_quantity_unit":"g","categories_tags":["en:spreads","en:salted-spreads","en:yeast-extract-spreads"],"countries_tags":["en:netherlands"],"stores_tags":["Ah"],"labels_tags":["en:vegetarian","en:halal","en:vegan","en:european-vegetarian-union","en:european-vegetarian-union-vegan","en:halal-food-authority","en:vitamin-b-source"],"last_modified_t":1787420997,"data_quality_errors_tags":["en:nutrition-packaging-as-sold-100g-salt-does-not-match-sodium"],"data_quality_warnings_tags":["en:nutrition-salt-does-not-match-sodium","en:environmental-score-packaging-unscored-shape","en:environmental-score-production-system-no-label"],"selected_images":{"front":{"display":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_en.126.400.jpg","es":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_es.107.400.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_fr.106.400.jpg"},"small":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_en.126.200.jpg","es":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_es.107.200.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_fr.106.200.jpg"},"thumb":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_en.126.100.jpg","es":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_es.107.100.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_fr.106.100.jpg"}},"ingredients":{"display":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/ingredients_en.67.400.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/ingredients_fr.9.400.jpg"},"small":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/ingredients_en.67.200.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/ingredients_fr.9.200.jpg"},"thumb":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/ingredients_en.67.100.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/ingredients_fr.9.100.jpg"}},"nutrition":{"display":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/nutrition_en.41.400.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/nutrition_fr.52.400.jpg"},"small":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/nutrition_en.41.200.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/nutrition_fr.52.200.jpg"},"thumb":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/nutrition_en.41.100.jpg","fr":"https://images.openfoodfacts.org/images/products/000/005/018/4453/nutrition_fr.52.100.jpg"}},"packaging":{"display":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/packaging_en.133.400.jpg"},"small":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/packaging_en.133.200.jpg"},"thumb":{"en":"https://images.openfoodfacts.org/images/products/000/005/018/4453/packaging_en.133.100.jpg"}}},"lc":"nl","image_front_url":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_en.126.400.jpg","image_front_small_url":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_en.126.200.jpg","image_url":"https://images.openfoodfacts.org/images/products/000/005/018/4453/front_en.126.400.jpg","nutriscore_grade":"unknown","nutrition_grades":"unknown","nutriscore":{"2021":{"category_available":1,"data":{"energy":1087,"fiber":0,"fruits_vegetables_nuts_colza_walnut_olive_oils":2.52,"is_beverage":0,"is_cheese":0,"is_fat":0,"is_water":0,"proteins":34,"saturated_fat":0,"sodium":4249,"sugars":1.2},"estimated":0,"grade":"unknown","nutrients_available":0,"nutriscore_applicable":1,"nutriscore_computed":0,"preparation":"as_sold"},"2023":{"category_available":1,"data":{"energy":1087,"fiber":null,"fruits_vegetables_legumes":0.5,"is_beverage":0,"is_cheese":0,"is_fat_oil_nuts_seeds":0,"is_red_meat_product":0,"is_water":0,"proteins":34,"salt":10.8,"saturated_fat":0,"sugars":1.2},"estimated":0,"grade":"unknown","nutrients_available":0,"nutriscore_applicable":1,"nutriscore_computed":0,"preparation":"as_sold"}},"nova_group":4,"additives_tags":[]}],"ratings":[{"barcode":"03422649","method":"nudge_nutrition_v0_4","version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceRevision":1774627133,"sourceFingerprint":"0f6f112f8d86786521c0f2032ebc0bd0d05766b30352a42d5e78e0b54046e957","fetchedAt":1791866546481,"expiresAt":1794458546481,"calculatedAt":1791867270982,"freshness":"current","discoveryScope":"uk_discovery","score":{"status":"rated","methodStatus":"directional","grade":"A","rawScore":-1,"rawLower":-1,"rawUpper":-1,"value":100,"displayLower":100,"displayUpper":100,"band":{"id":"green","label":"Green","interpretation":"Nudge directional nutrition score"},"methodId":"nudge_nutrition_v0_4","version":"0.4","methodVersion":"0.4","model_version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceVersion":"SPF-FAQ-2025-03-17/2023","baseAlgorithmVersion":"2023","category":"general","available":true,"label":"Nudge score","completeness":"complete","assumptions":["Qualifying plant share uses the retained OFF 2023 component estimate; it is not a declared recipe percentage."],"baseFrequency":null,"finalFrequency":null,"frequencyStatus":"not_provided","reasonCodes":["supported_nutrition_calculation","nudge_directional"],"personalSuitability":"unchecked","components":{"negative":[{"id":"energy","label":"Energy","value":1161,"unit":"kJ","points":3,"pointsLower":3,"pointsUpper":3,"pointsMax":10,"counted":true,"missing":false},{"id":"saturatedFat","label":"Saturated fat","value":0.1,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":10,"counted":true,"missing":false},{"id":"sugars","label":"Sugars","value":1.7,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":15,"counted":true,"missing":false},{"id":"salt","label":"Salt","value":0.8,"unit":"g","points":3,"pointsLower":3,"pointsUpper":3,"pointsMax":20,"counted":true,"missing":false}],"positive":[{"id":"fvl","label":"Fruit, vegetables and legumes","value":0,"unit":"%","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":5,"counted":true,"missing":false},{"id":"fibre","label":"Fibre","value":1.1,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":5,"counted":true,"missing":false},{"id":"protein","label":"Protein","value":48.6,"unit":"g","points":7,"pointsLower":7,"pointsUpper":7,"pointsMax":7,"counted":true,"missing":false}]},"negativePoints":6,"positivePoints":7,"countProteins":true,"missingInputs":[],"missingFields":[],"reason":"Based on energy, sugars, saturated fat and salt per 100 g.","explanation":"Based on energy, sugars, saturated fat and salt per 100 g. A practical guide based on available nutrition and food information. Our scoring improves over time.  Qualifying plant share uses the retained OFF 2023 component estimate; it is not a declared recipe percentage.","inputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":1161,"energySource":"declared-kJ","sugars":1.7,"fat":0.3,"saturatedFat":0.1,"salt":0.8,"fibre":1.1,"protein":48.6,"carbohydrate":18.5,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":0,"fvlBounds":{"lower":0,"upper":0,"source":"off_2023_component_estimate"},"fvlSource":"off_2023_component_estimate","hasNonNutritiveSweeteners":null},"sources":[{"title":"Santé publique France · updated Nutri-Score 2023 nutrient model","url":"https://www.santepubliquefrance.fr/sites/default/files/rdd/document/FAQ-updatedAlgo-V11.pdf"}],"promptVersion":"nudge-label-evidence-7","calculationBasis":{"unit":"g","per":100,"preparation":"as_sold"},"classificationEvidence":{"version":"food-evidence-2026-10-11-v16","evidence":[],"resolutions":[],"conflicts":[]},"scoreBasis":"nudge_directional","inputFingerprint":"nudge_nutrition_v0_4:food-evidence-2026-10-11-v16:off2023-facts-v1:1296:7592d78c:4d3cf434:{\"sodiumNormalized\":false,\"providerInputs\":{\"fvlPercent\":0},\"sourceEstimateKeys\":[],\"providerEstimates\":true,\"sourceKind\":null,\"type\":null}","sourceInputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":1161,"energySource":"declared-kJ","sugars":1.7,"fat":0.3,"saturatedFat":0.1,"salt":0.8,"fibre":1.1,"protein":48.6,"carbohydrate":18.5,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":null,"fvlBounds":null,"fvlSource":null,"hasNonNutritiveSweeteners":null},"positivePointsUpper":7,"inferredInputs":{"fvlPercent":{"value":0,"unit":"%","status":"estimated","method":"off_2023_component","sourceURL":"https://world.openfoodfacts.org/product/03422649"}},"providerReference":{"source":"Open Food Facts","version":"2023","grade":"A","rawScore":-1,"estimated":false,"sourceURL":"https://world.openfoodfacts.org/product/03422649"},"sourceData":{"source":"Open Food Facts","url":"https://world.openfoodfacts.org/product/03422649","retrievedAt":"2026-10-13T04:42:26.481Z","version":null,"nutrientSources":{"energyKcal":"Open Food Facts structured nutrition","protein":"Open Food Facts structured nutrition","carbohydrate":"Open Food Facts structured nutrition","sugars":"Open Food Facts structured nutrition","fat":"Open Food Facts structured nutrition","saturatedFat":"Open Food Facts structured nutrition","fibre":"Open Food Facts structured nutrition","salt":"Open Food Facts structured nutrition","energyKj":"Open Food Facts nutrient energy"}},"quality":{"extraction":null,"match":null,"portion":null,"evidence":null}}},{"barcode":"5014284003010","method":"nudge_nutrition_v0_4","version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceRevision":1773888274,"sourceFingerprint":"485751f95f737fc9b69a5c9eac410dd2e4ddfac9bd7607825785398c57fe0ac4","fetchedAt":1791866546481,"expiresAt":1794458546481,"calculatedAt":1791867263935,"freshness":"current","discoveryScope":"uk_discovery","score":{"status":"rated","methodStatus":"directional","grade":"D","rawScore":14,"rawLower":14,"rawUpper":14,"value":25,"displayLower":25,"displayUpper":25,"band":{"id":"red","label":"Red","interpretation":"Nudge directional nutrition score"},"methodId":"nudge_nutrition_v0_4","version":"0.4","methodVersion":"0.4","model_version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceVersion":"SPF-FAQ-2025-03-17/2023","baseAlgorithmVersion":"2023","category":"general","available":true,"label":"Nudge score","completeness":"nutrition_only","assumptions":["Qualifying plant share uses the retained OFF 2023 component estimate; it is not a declared recipe percentage.","No unverified fibre bonus; the source amount remains unknown."],"baseFrequency":null,"finalFrequency":null,"frequencyStatus":"not_provided","reasonCodes":["supported_nutrition_calculation","nudge_directional"],"personalSuitability":"unchecked","components":{"negative":[{"id":"energy","label":"Energy","value":1112.944,"unit":"kJ","points":3,"pointsLower":3,"pointsUpper":3,"pointsMax":10,"counted":true,"missing":false},{"id":"saturatedFat","label":"Saturated fat","value":0.1,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":10,"counted":true,"missing":false},{"id":"sugars","label":"Sugars","value":0.6,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":15,"counted":true,"missing":false},{"id":"salt","label":"Salt","value":2.4,"unit":"g","points":11,"pointsLower":11,"pointsUpper":11,"pointsMax":20,"counted":true,"missing":false}],"positive":[{"id":"fvl","label":"Fruit, vegetables and legumes","value":1.2,"unit":"%","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":5,"counted":true,"missing":false},{"id":"fibre","label":"Fibre","value":null,"unit":"g","points":0,"pointsLower":0,"pointsUpper":5,"pointsMax":5,"counted":true,"missing":true,"assumption":"No positive bonus is used when the exact component points are unknown."},{"id":"protein","label":"Protein","value":48.7,"unit":"g","points":7,"pointsLower":7,"pointsUpper":7,"pointsMax":7,"counted":false,"missing":false,"reason":"Protein points are excluded when negative points reach 11 for this category."}]},"negativePoints":14,"positivePoints":0,"countProteins":false,"missingInputs":["fibre"],"missingFields":["fibre"],"reason":"Higher in salt.","explanation":"Higher in salt. A practical guide based on available nutrition and food information. Our scoring improves over time. Protein points are excluded when negative points reach 11 for this category. Qualifying plant share uses the retained OFF 2023 component estimate; it is not a declared recipe percentage. No unverified fibre bonus; the source amount remains unknown.","inputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":1112.944,"energySource":"derived-kcal-times-4.184","sugars":0.6,"fat":0.2,"saturatedFat":0.1,"salt":2.4,"fibre":null,"protein":48.7,"carbohydrate":15.7,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":1.2,"fvlBounds":{"lower":1.2,"upper":1.2,"source":"off_2023_component_estimate"},"fvlSource":"off_2023_component_estimate","hasNonNutritiveSweeteners":null},"sources":[{"title":"Santé publique France · updated Nutri-Score 2023 nutrient model","url":"https://www.santepubliquefrance.fr/sites/default/files/rdd/document/FAQ-updatedAlgo-V11.pdf"}],"promptVersion":"nudge-label-evidence-7","calculationBasis":{"unit":"g","per":100,"preparation":"as_sold"},"classificationEvidence":{"version":"food-evidence-2026-10-11-v16","evidence":[],"resolutions":[],"conflicts":[]},"scoreBasis":"nudge_directional","inputFingerprint":"nudge_nutrition_v0_4:food-evidence-2026-10-11-v16:off2023-facts-v1:1560:7674366c:f4f2a1c8:{\"sodiumNormalized\":false,\"providerInputs\":{\"fvlPercent\":1.2},\"sourceEstimateKeys\":[\"energyKj\",\"fibre\"],\"providerEstimates\":true,\"sourceKind\":null,\"type\":null}","sourceInputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":1112.944,"energySource":"derived-kcal-times-4.184","sugars":0.6,"fat":0.2,"saturatedFat":0.1,"salt":2.4,"fibre":null,"protein":48.7,"carbohydrate":15.7,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":null,"fvlBounds":null,"fvlSource":null,"hasNonNutritiveSweeteners":null},"positivePointsUpper":0,"inferredInputs":{"fvlPercent":{"value":1.2,"unit":"%","status":"estimated","method":"off_2023_component","sourceURL":"https://world.openfoodfacts.org/product/5014284003010"},"fibrePoints":{"value":0,"method":"no_unverified_bonus"}},"providerReference":{"source":"Open Food Facts","version":"2023","grade":"C","rawScore":9,"estimated":true,"sourceURL":"https://world.openfoodfacts.org/product/5014284003010"},"sourceData":{"source":"Open Food Facts","url":"https://world.openfoodfacts.org/product/5014284003010","retrievedAt":"2026-10-13T04:42:26.481Z","version":null,"nutrientSources":{"energyKcal":"Open Food Facts structured nutrition","protein":"Open Food Facts structured nutrition","carbohydrate":"Open Food Facts structured nutrition","sugars":"Open Food Facts structured nutrition","fat":"Open Food Facts structured nutrition","saturatedFat":"Open Food Facts structured nutrition","fibre":"estimate","salt":"Open Food Facts structured nutrition","energyKj":"Open Food Facts nutrient energy"}},"quality":{"extraction":null,"match":null,"portion":null,"evidence":null}}},{"barcode":"50184453","method":"nudge_nutrition_v0_4","version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceRevision":1787420997,"sourceFingerprint":"9cc013a3d0150df9ed95843e188b3f24a1fc6dd0371d50476ae26ef6d97564d0","fetchedAt":1791142077773,"expiresAt":1793734077773,"calculatedAt":1791964058726,"freshness":"current","discoveryScope":"barcode_only","score":{"status":"rated","methodStatus":"directional","grade":"E","rawScore":23,"rawLower":23,"rawUpper":23,"value":0,"displayLower":0,"displayUpper":0,"band":{"id":"red","label":"Red","interpretation":"Nudge directional nutrition score"},"methodId":"nudge_nutrition_v0_4","version":"0.4","methodVersion":"0.4","model_version":"0.4","classifierVersion":"food-evidence-2026-10-11-v16","sourceVersion":"SPF-FAQ-2025-03-17/2023","baseAlgorithmVersion":"2023","category":"general","available":true,"label":"Nudge score","completeness":"nutrition_only","assumptions":["No unverified plant bonus; the qualifying plant percentage remains unknown.","No unverified fibre bonus; the source amount remains unknown."],"baseFrequency":null,"finalFrequency":null,"frequencyStatus":"not_provided","reasonCodes":["supported_nutrition_calculation","nudge_directional","no_unverified_plant_bonus"],"personalSuitability":"unchecked","components":{"negative":[{"id":"energy","label":"Energy","value":1087,"unit":"kJ","points":3,"pointsLower":3,"pointsUpper":3,"pointsMax":10,"counted":true,"missing":false},{"id":"saturatedFat","label":"Saturated fat","value":0,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":10,"counted":true,"missing":false},{"id":"sugars","label":"Sugars","value":1.2,"unit":"g","points":0,"pointsLower":0,"pointsUpper":0,"pointsMax":15,"counted":true,"missing":false},{"id":"salt","label":"Salt","value":10.8,"unit":"g","points":20,"pointsLower":20,"pointsUpper":20,"pointsMax":20,"counted":true,"missing":false}],"positive":[{"id":"fvl","label":"Fruit, vegetables and legumes","value":null,"unit":"%","points":0,"pointsLower":0,"pointsUpper":5,"pointsMax":5,"counted":true,"missing":true},{"id":"fibre","label":"Fibre","value":null,"unit":"g","points":0,"pointsLower":0,"pointsUpper":5,"pointsMax":5,"counted":true,"missing":true,"assumption":"No positive bonus is used when the exact component points are unknown."},{"id":"protein","label":"Protein","value":34,"unit":"g","points":7,"pointsLower":7,"pointsUpper":7,"pointsMax":7,"counted":false,"missing":false,"reason":"Protein points are excluded when negative points reach 11 for this category."}]},"negativePoints":23,"positivePoints":0,"countProteins":false,"missingInputs":["qualifying fruit, vegetable and legume percentage","fibre"],"missingFields":["qualifying fruit, vegetable and legume percentage","fibre"],"reason":"Higher in salt.","explanation":"Higher in salt. A practical guide based on available nutrition and food information. Our scoring improves over time. Protein points are excluded when negative points reach 11 for this category. No unverified plant bonus; the qualifying plant percentage remains unknown. No unverified fibre bonus; the source amount remains unknown.","inputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":1087,"energySource":"declared-kJ","sugars":1.2,"fat":null,"saturatedFat":0,"salt":10.8,"fibre":null,"protein":34,"carbohydrate":30,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":null,"fvlBounds":null,"fvlSource":null,"hasNonNutritiveSweeteners":null},"sources":[{"title":"Santé publique France · updated Nutri-Score 2023 nutrient model","url":"https://www.santepubliquefrance.fr/sites/default/files/rdd/document/FAQ-updatedAlgo-V11.pdf"}],"promptVersion":"nudge-label-evidence-7","calculationBasis":{"unit":"g","per":100,"preparation":"as_sold"},"classificationEvidence":{"version":"food-evidence-2026-10-11-v16","evidence":[],"resolutions":[],"conflicts":[]},"scoreBasis":"nudge_directional","inputFingerprint":"nudge_nutrition_v0_4:food-evidence-2026-10-11-v16:off2023-facts-v1:2088:48174a30:d7634942:{\"sodiumNormalized\":false,\"providerInputs\":{},\"sourceEstimateKeys\":[],\"providerEstimates\":true,\"sourceKind\":null,\"type\":null}","sourceInputs":{"basisUnit":"g","nutritionPreparation":"as_sold","energyKj":1087,"energySource":"declared-kJ","sugars":1.2,"fat":null,"saturatedFat":0,"salt":10.8,"fibre":null,"protein":34,"carbohydrate":30,"nutrientBounds":{"sugars":null,"fat":null,"saturatedFat":null,"salt":null,"fibre":null,"protein":null,"carbohydrate":null},"positiveBounds":{"fibre":null,"protein":null},"fvlPercent":null,"fvlBounds":null,"fvlSource":null,"hasNonNutritiveSweeteners":null},"positivePointsUpper":0,"inferredInputs":{"fvlPoints":{"value":0,"method":"no_unverified_bonus"},"fibrePoints":{"value":0,"method":"no_unverified_bonus"}},"sourceData":{"source":"Open Food Facts","url":"https://world.openfoodfacts.org/product/50184453","retrievedAt":"2026-10-04T19:27:57.773Z","version":null,"nutrientSources":{"energyKcal":"Open Food Facts structured nutrition","protein":"Open Food Facts structured nutrition","carbohydrate":"Open Food Facts structured nutrition","sugars":"Open Food Facts structured nutrition","saturatedFat":"Open Food Facts structured nutrition","salt":"Open Food Facts structured nutrition","energyKj":"Open Food Facts nutrient energy"}},"quality":{"extraction":null,"match":null,"portion":null,"evidence":null}}}]}
"""#
        let envelope = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        let date = Date(timeIntervalSince1970: 1792057963.398535)
        let products = try NudgeCatalogueService.products(envelope, at: date,
            trustedBackendURL: URL(string: "https://configure-nudge-backend.invalid"))
        #expect(products.count == 3)
        let rules = NativeProductContextRules(referenceDate: date)
        let engine = NativeProductRatingEngine(catalogue: nil, now: { date })
        let marmite = try #require(products.first(where: { $0.barcode == "50184453" }))
        let current = try #require(rules.productFacts(marmite, ratingEngine: engine))
        let snapshot = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(marmite)) as? [String: Any])
        let original = try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        #expect(rules.canOffer(current))
        #expect(rules.canOffer(snapshot), "An equivalent saved raw snapshot also remains eligible")
        let candidates = FoodAlternatives.candidates(products, excluding: marmite.barcode,
            category: "en:yeast-extract-spreads", basisUnit: marmite.basisUnit, nutritionPreparation: marmite.nutritionPreparation)
        #expect(candidates.count == 2)
        let expected = ["03422649": 100, "5014284003010": 25]
        let facts = try candidates.map { candidate -> [String: Any] in
            #expect(candidate.catalogueRating != nil)
            let score = try #require(engine.validatedDetailedCatalogueScore(for: candidate))
            #expect(score["value"] as? Int == expected[candidate.barcode])
            let fact = try #require(rules.productFacts(candidate, ratingEngine: engine))
            #expect((fact["scoreResult"] as? [String: Any])?["catalogueValidated"] as? Bool == true)
            #expect(NativeProductContextRules.matchesScope(fact, selectedStore: nil))
            return fact
        }
        for reference in [current, snapshot] {
            let rows = rules.select(current: reference, candidates: facts, profile: [:], avoidMilk: false)
            #expect(Set(rows.compactMap { ($0["product"] as? [String: Any])?["barcode"] as? String }) == Set(expected.keys))
        }
        // Exercise the production bridge as well as the native parser/rules:
        // nil shop previously became Heron Foods before reaching the catalogue.
        let service = OpenFoodFactsService(now: { date }, cache: nil, searchDiagnostics: nil,
            alternativesState: ProductAlternativesState(), catalogueAlternatives: { category, store in
                #expect(category == "en:yeast-extract-spreads")
                #expect(store == nil, "An unselected shop must keep the whole UK catalogue")
                return products.filter { product in store.map { chosen in product.stores.contains(where: chosen.contains(sourceStore:)) } ?? true }
            })
        for (reference, force) in [(current, false), (snapshot, true)] {
            let model = NativeProductContextModel(rules: rules,
                fetchRecall: { ["status": "available", "notices": []] },
                fetchAlternatives: { category, store, basis, preparation in
                    let products = try await service.alternatives(categoryTag: category, basisUnit: basis,
                        nutritionPreparation: preparation, selectedStore: store)
                    return products.compactMap { rules.productFacts($0, ratingEngine: engine) }
                })
            await model.load(product: reference, profile: [:], avoidMilk: false, forceAlternatives: force)
            await settle { !model.alternativesLoading }
            #expect(model.alternativesSnapshot.status == .ready)
            #expect(Set(model.rows.compactMap { ($0["product"] as? [String: Any])?["barcode"] as? String }) == Set(expected.keys))
        }
        #expect(try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]) == original)
    }
}
