import XCTest
import JavaScriptCore
@testable import Nudge

/// Active publication fixtures follow the bundled method identity. Tests still
/// choose controlled scores to exercise provenance, expiry and source ordering;
/// historical snapshots and deliberately invalid versions remain explicit.
@MainActor
enum ActiveScoringFixture {
    private static let config: [String: Any] = {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Web/core/nudge-score.js"),
              let script = try? String(contentsOf: url, encoding: .utf8), let runtime = JSContext() else {
            XCTFail("Bundled score core is required for active publication fixtures"); return [:]
        }
        runtime.evaluateScript(script, withSourceURL: url)
        guard runtime.exception == nil,
              let config = runtime.objectForKeyedSubscript("NudgeScoreCore")?.objectForKeyedSubscript("CONFIG")?.toDictionary() as? [String: Any] else {
            XCTFail("Bundled score configuration could not be read"); return [:]
        }
        return config
    }()
    static var method: String { config["methodId"] as? String ?? "missing-test-method" }
    static var version: String { config["version"] as? String ?? "missing-test-version" }
    static var classifier: String { config["classifierVersion"] as? String ?? "missing-test-classifier" }
}

@MainActor
final class NativeSearchRatingLoaderTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_791_331_200)

    private func full(_ code: String = "10000001", complete: Bool = true) throws -> BarcodeProduct {
        var fields: [String: Any] = ["code": code, "product_name": complete ? "Fixture chickpeas" : "Unidentified packaged food",
            "brands": "Fixture", "categories_tags": complete ? ["en:chickpeas"] : [],
            "ingredients_text": complete ? "Chickpeas (100%)" : "", "nutrition_data_per": "100g",
            "nutriscore_grade": complete ? "e" : "a"]
        if complete {
            fields["nutriments"] = ["energy-kcal_100g": 120, "energy-kj_100g": 502,
                "fat_100g": 2, "saturated-fat_100g": 0.2, "carbohydrates_100g": 15,
                "sugars_100g": 0.5, "fiber_100g": 6, "proteins_100g": 7, "salt_100g": 0.02]
        }
        return try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": fields]),
            barcode: code, retrievedAt: date)
    }

    private func index(_ code: String = "10000001") throws -> BarcodeProduct {
        var product = try full(code)
        product.searchProvider = "open_food_facts_search"
        product.nutritionPreparation = nil
        return product
    }

    private func qualityHeldProduct() throws -> BarcodeProduct {
        var product = try full()
        product.lastModifiedAt = "2026-10-01T12:00:00Z"
        product.catalogueSourceFingerprint = String(repeating: "a", count: 64)
        product.catalogueSourceExpiresAt = date.addingTimeInterval(100)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let probe = NativeAppStore(store: NudgeDataStore(directory: directory))
        let active = try XCTUnwrap(probe.scannedProductModel(["name": "Fixture", "nutrients": [:]])["score"] as? [String: Any])
        let method = try XCTUnwrap(active["methodId"] as? String), version = try XCTUnwrap(active["version"] as? String)
        let classifier = try XCTUnwrap(active["classifierVersion"] as? String)
        let score: [String: Any] = ["methodId": method, "version": version, "classifierVersion": classifier,
            "status": "unrated", "available": false, "value": NSNull(), "grade": NSNull(), "rawScore": NSNull(),
            "category": "unknown", "scoreBasis": "catalogue_quality_hold", "reasonCodes": ["catalogue_quality_hold", "source_identity_conflict"],
            "catalogueQualityHold": ["version": "catalogue-quality-hold-v1", "barcode": product.barcode,
                "sourceFingerprint": product.catalogueSourceFingerprint!, "sourceFetchedAt": Int(date.timeIntervalSince1970 * 1000),
                "reviewedAt": Int(date.timeIntervalSince1970 * 1000), "runID": "test-run-0001", "reviewID": "test-review-0001",
                "reasonCode": "source_identity_conflict", "candidateSHA256": String(repeating: "b", count: 64)]]
        product.catalogueRating = .init(method: method, version: version, classifierVersion: classifier, sourceRevision: nil,
            fetchedAt: date, expiresAt: date.addingTimeInterval(100), calculatedAt: date,
            snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)), scoreData: try JSONSerialization.data(withJSONObject: score),
            qualityHoldOrigin: "https://nudge.example")
        return product
    }

    func testCatalogueQualityHoldBlocksLocalRecoveryAndPersistsAfterSourceTTL() throws {
        let held = try qualityHeldProduct(), engine = NativeProductRatingEngine(catalogue: nil, now: { self.date.addingTimeInterval(200) })
        var local = held; local.catalogueRating = nil
        XCTAssertEqual(engine.rating(for: local).value, 100, "The fixture genuinely exposes a local recalculation bypass")
        engine.recoveredScore = { _ in XCTFail("A source hold must precede recovered numeric evidence"); return nil }
        XCTAssertEqual(engine.rating(for: held), NativeProductRating(value: nil, subtitle: "Source needs checking"))
        XCTAssertFalse(engine.fullProductRequired(for: held))
        let restored = try JSONDecoder().decode(BarcodeProduct.self, from: JSONEncoder().encode(held))
        XCTAssertNotNil(engine.validatedQualityHold(for: restored))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let object = try XCTUnwrap(app.productObject(restored))
        XCTAssertEqual((app.scannedProductModel(object)["score"] as? [String: Any])?["scoreBasis"] as? String, "catalogue_quality_hold")
        XCTAssertTrue(app.perform("setReview", ["kind": "product", "product": object, "confirmationId": "held-fixture"]))
        XCTAssertEqual(app.project("productRecovery")["blockedByQualityHold"] as? Bool, true)
        XCTAssertEqual(app.project("productRecovery")["needsRecovery"] as? Bool, false)
    }

    func testHeldCardAssessmentReadsCatalogueOnceWithoutHydrationOrRecovery() throws {
        let held = try qualityHeldProduct(), card = try index()
        var reads = 0
        let engine = NativeProductRatingEngine(catalogue: nil, now: { self.date.addingTimeInterval(200) }, catalogueRead: { code, _ in
            XCTAssertEqual(code, held.barcode)
            reads += 1
            return held
        })
        engine.recoveredScore = { _ in XCTFail("A held source must not request recovered numeric evidence"); return nil }
        let assessment = engine.assessment(for: card)
        XCTAssertEqual(assessment.rating, NativeProductRating(value: nil, subtitle: "Source needs checking"))
        XCTAssertFalse(assessment.requiresFullProduct)
        XCTAssertEqual(reads, 1, "The hold and hydration decision share one selected catalogue snapshot")
        reads = 0
        XCTAssertFalse(engine.fullProductRequired(for: card))
        XCTAssertEqual(reads, 1)
    }

    func testCatalogueQualityHoldRejectsWrongSourceEditedFactsAndMissingOrigin() throws {
        let held = try qualityHeldProduct(), engine = NativeProductRatingEngine(catalogue: nil, now: { self.date })
        var changed = held; changed.catalogueSourceFingerprint = String(repeating: "c", count: 64)
        XCTAssertNil(engine.validatedQualityHold(for: changed)); XCTAssertEqual(engine.rating(for: changed).value, 100)
        changed = held; changed.categories = ["en:unrelated"]
        XCTAssertNil(engine.validatedQualityHold(for: changed))
        changed = held; changed.catalogueRating?.qualityHoldOrigin = nil
        XCTAssertNil(engine.validatedCataloguePublication(for: changed))
        let old = try XCTUnwrap(held.catalogueRating)
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: old.scoreData) as? [String: Any])
        for edit: [String: Any] in [["barcode": "99999999"], ["version": "invented"], ["reviewedAt": true], ["candidateSHA256": "invalid"]] {
            var result = original
            result["catalogueQualityHold"] = (result["catalogueQualityHold"] as! [String: Any]).merging(edit, uniquingKeysWith: { _, new in new })
            changed = held
            changed.catalogueRating = .init(method: old.method, version: old.version, classifierVersion: old.classifierVersion,
                sourceRevision: old.sourceRevision, fetchedAt: old.fetchedAt, expiresAt: old.expiresAt, calculatedAt: old.calculatedAt,
                snapshotFingerprint: old.snapshotFingerprint, scoreData: try JSONSerialization.data(withJSONObject: result), qualityHoldOrigin: old.qualityHoldOrigin)
            XCTAssertNil(engine.validatedCataloguePublication(for: changed))
        }
    }

    func testSameSourceCacheCannotReplaceQualityHoldWithUnmarkedNumericResponse() throws {
        let held = try qualityHeldProduct(), directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        cache.write(held, now: date)
        var unmarked = held; unmarked.catalogueRating = nil
        cache.write(unmarked, now: date.addingTimeInterval(200))
        let retained = try XCTUnwrap(cache.read(barcode: held.barcode, now: date.addingTimeInterval(200), allowStale: true))
        XCTAssertNotNil(retained.catalogueRating?.qualityHold(for: retained, at: date.addingTimeInterval(200)))
        XCTAssertFalse(cache.reserveMissingRatingRefresh(barcode: held.barcode, now: date.addingTimeInterval(400)))
        unmarked.catalogueSourceFingerprint = String(repeating: "c", count: 64)
        cache.write(unmarked, now: date.addingTimeInterval(500))
        XCTAssertNil(cache.read(barcode: held.barcode, now: date.addingTimeInterval(500), allowStale: true)?.catalogueRating)
    }

    func testAuthenticatedLookupRetainsExpiredHoldButIgnoresRawProviderImpersonation() throws {
        let held = try qualityHeldProduct(), rating = try XCTUnwrap(held.catalogueRating)
        let score = try XCTUnwrap(JSONSerialization.jsonObject(with: rating.scoreData) as? [String: Any])
        let raw: [String: Any] = ["code": held.barcode, "product_name": "Chickpeas", "nutrition_data_per": "100g",
            "nutriments": ["energy-kcal_100g": 100, "sugars_100g": 1, "saturated-fat_100g": 0.1, "salt_100g": 0.1, "proteins_100g": 7, "fiber_100g": 5]]
        let response: [String: Any] = ["providerPayload": ["product": raw], "fetchedAt": date.timeIntervalSince1970 * 1000,
            "catalogueRating": score, "catalogueSourceFingerprint": held.catalogueSourceFingerprint!, "catalogueCalculatedAt": date.timeIntervalSince1970 * 1000]
        let now = date.addingTimeInterval(31 * 86_400), backend = URL(string: "https://nudge.example")!
        let decoded = try NutritionLabelService.decodedCatalogueProductData(response, barcode: held.barcode, backendURL: backend, at: now)
        let wrapper = try XCTUnwrap(JSONSerialization.jsonObject(with: decoded.data) as? [String: Any])
        let typed = try JSONDecoder().decode(BarcodeProduct.self, from: JSONSerialization.data(withJSONObject: wrapper["nudgeCatalogueProduct"]!))
        XCTAssertNotNil(typed.catalogueRating?.qualityHold(for: typed, at: now))
        var ordinary = response; ordinary.removeValue(forKey: "catalogueRating")
        ordinary["providerPayload"] = ["product": raw, "nudgeCatalogueProduct": wrapper["nudgeCatalogueProduct"]!]
        XCTAssertThrowsError(try NutritionLabelService.decodedCatalogueProductData(ordinary, barcode: held.barcode, backendURL: backend, at: now))
        let fresh = try NutritionLabelService.decodedCatalogueProductData(ordinary, barcode: held.barcode, backendURL: backend, at: date)
        XCTAssertNil((try JSONSerialization.jsonObject(with: fresh.data) as? [String: Any])?["nudgeCatalogueProduct"])
    }

    func testScoreEndpointHoldBecomesTemporaryCheckWithoutInventingCatalogueAuthority() throws {
        let held = try qualityHeldProduct(), rating = try XCTUnwrap(held.catalogueRating)
        let score = try JSONSerialization.jsonObject(with: rating.scoreData)
        let decoded = try NutritionLabelService.decodedScoreResult(from: JSONSerialization.data(withJSONObject: ["score": score]))
        let result = try XCTUnwrap(decoded["score"] as? [String: Any])
        XCTAssertNil(result["catalogueQualityHold"])
        XCTAssertEqual(result["catalogueCheckRequired"] as? Bool, true)
        XCTAssertEqual(result["catalogueCheckBarcode"] as? String, held.barcode)
        XCTAssertEqual(result["scoreBasis"] as? String, "catalogue_quality_check")
        XCTAssertTrue(result["value"] is NSNull)
    }

    private func imageProduct(image: String? = nil, revision: String = "2026-10-01T12:00:00Z", rating: Bool = false) throws -> BarcodeProduct {
        var product = try full()
        product.imageURL = image; product.lastModifiedAt = revision
        if rating {
            product.catalogueSourceExpiresAt = date.addingTimeInterval(100)
            let score: [String: Any] = ["methodId": ActiveScoringFixture.method, "version": ActiveScoringFixture.version,
                "classifierVersion": ActiveScoringFixture.classifier, "status": "rated", "available": true,
                "value": 0, "rawScore": 30, "category": "general", "grade": "E", "baseFrequency": NSNull(), "finalFrequency": NSNull()]
            product.catalogueRating = ProductCatalogueRating(method: ActiveScoringFixture.method, version: ActiveScoringFixture.version,
                classifierVersion: ActiveScoringFixture.classifier, sourceRevision: nil, fetchedAt: date.addingTimeInterval(-100),
                expiresAt: date.addingTimeInterval(100), calculatedAt: date.addingTimeInterval(-10),
                snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)),
                scoreData: try JSONSerialization.data(withJSONObject: score))
        }
        return product
    }

    func testNewerSelectedProductKeepsExactPublicPictureWithoutChangingItsScoreEvidence() throws {
        let source = "https://images.openfoodfacts.org/images/products/10000001/front_en.1.400.jpg"
        let pictured = try imageProduct(image: source)
        let fresh = try imageProduct(revision: "2026-10-02T12:00:00Z", rating: true)
        let engine = NativeProductRatingEngine(catalogue: nil, now: { self.date })
        let selected = engine.preferredProduct(for: pictured, fullProduct: fresh)
        XCTAssertEqual(selected.lastModifiedAt, fresh.lastModifiedAt)
        XCTAssertNil(selected.imageURL, "The newer source still omitted an image; a retained display URL is kept separately")
        XCTAssertEqual(selected.displayImageURL, source)
        XCTAssertEqual(selected.catalogueRating, fresh.catalogueRating)
        XCTAssertEqual(ProductCatalogueRating.fingerprint(selected), ProductCatalogueRating.fingerprint(fresh))
        XCTAssertEqual(engine.validatedDetailedCatalogueScore(for: selected)?["value"] as? Int, 0)
        XCTAssertEqual(engine.rating(for: pictured, fullProduct: fresh).value, 0)
    }

    func testPublicImageSurvivesCacheRefreshRestartAndLateImageOnlyResponse() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = ProductLookupCache(directory: directory)
        let source = "https://images.openfoodfacts.org/images/products/10000001/front_en.1.400.jpg"
        let pictured = try imageProduct(image: source)
        let fresh = try imageProduct(revision: "2026-10-02T12:00:00Z", rating: true)
        cache.write(pictured, now: date); cache.write(fresh, now: date)
        let reopened = ProductLookupCache(directory: directory)
        let retained = try XCTUnwrap(reopened.read(barcode: fresh.barcode, now: date))
        XCTAssertEqual(retained.displayImageURL, source)
        XCTAssertEqual(retained.lastModifiedAt, fresh.lastModifiedAt)
        XCTAssertEqual(retained.catalogueRating, fresh.catalogueRating)
        XCTAssertEqual(NativeProductRatingEngine(catalogue: reopened, now: { self.date }).rating(for: fresh).value, 0)
        let nextImage = "https://images.openfoodfacts.org/images/products/10000001/front_en.2.400.jpg"
        let refreshedPicture = try imageProduct(image: nextImage, revision: "2026-10-03T12:00:00Z", rating: true)
        cache.write(refreshedPicture, now: date)
        XCTAssertEqual(cache.read(barcode: fresh.barcode, now: date)?.displayImageURL, nextImage)

        let isolated = ProductLookupCache(directory: directory.appendingPathComponent("late-picture"))
        isolated.write(fresh, now: date); isolated.write(pictured, now: date.addingTimeInterval(1))
        let filled = try XCTUnwrap(isolated.read(barcode: fresh.barcode, now: date.addingTimeInterval(1)))
        XCTAssertEqual(filled.displayImageURL, source, "A late picture can fill a missing display reference")
        XCTAssertEqual(filled.lastModifiedAt, fresh.lastModifiedAt, "A late picture cannot roll nutrition facts back")
        XCTAssertEqual(filled.catalogueRating, fresh.catalogueRating)
    }

    func testRetainedPicturesRejectDifferentProductsPacksPrivatePhotosAndWrongCDNIdentity() throws {
        let source = "https://images.openfoodfacts.org/images/products/10000001/front_en.1.400.jpg"
        let fresh = try imageProduct()
        let pictured = try imageProduct(image: source)
        func changed(_ fields: [String: Any]) throws -> BarcodeProduct {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(pictured)) as? [String: Any])
            for (key, value) in fields { object[key] = value }
            return try JSONDecoder().decode(BarcodeProduct.self, from: JSONSerialization.data(withJSONObject: object))
        }
        for incompatible in [try changed(["barcode": "10000002"]), try changed(["name": "Different variant"]),
                             try changed(["brand": "Different brand"]),
                             try changed(["imageURL": "data:image/jpeg;base64,private"]),
                             try changed(["imageURL": "https://images.openfoodfacts.org/images/products/10000002/front_en.1.400.jpg"]),
                             try changed(["sourceName": "Photo analysis"])] {
            XCTAssertNil(fresh.retainingPublicImage(from: incompatible).displayImageURL)
        }
        let onePack = try changed(["packSize": "400 g", "imageURL": NSNull()])
        XCTAssertNil(onePack.retainingPublicImage(from: try changed(["packSize": "800 g"])).displayImageURL)
        var fullCode = try full("5012345678901")
        fullCode.imageURL = "https://images.openfoodfacts.org/images/products/501/234/567/8901/front_en.1.400.jpg"
        var missing = fullCode; missing.imageURL = nil
        XCTAssertEqual(missing.retainingPublicImage(from: fullCode).displayImageURL, fullCode.imageURL)
    }

    func testHistoryImageProjectionUsesRetainedReferenceWithoutChangingStoredProduct() throws {
        let source = "https://images.openfoodfacts.org/images/products/10000001/front_en.1.400.jpg"
        let product = try imageProduct(rating: true).retainingPublicImage(from: imageProduct(image: source))
        let bytes = try JSONEncoder().encode(product)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(NativeTrackingDisplay.imageSource(["product": object]), source)
        XCTAssertEqual(NativeTrackingDisplay.imageIdentity(source: source, barcode: product.barcode),
                       NativeTrackingDisplay.imageIdentity(source: "", barcode: product.barcode))
        XCTAssertNotEqual(NativeTrackingDisplay.imageIdentity(source: source, barcode: product.barcode),
                          NativeTrackingDisplay.imageIdentity(source: source, barcode: "10000002"))
        XCTAssertNotEqual(NativeTrackingDisplay.imageIdentity(source: "data:image/jpeg;base64,private", barcode: product.barcode),
                          NativeTrackingDisplay.imageIdentity(source: "", barcode: product.barcode))
        XCTAssertEqual(try JSONDecoder().decode(BarcodeProduct.self, from: bytes), product)
    }

    private func settle(_ condition: @escaping () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Rating work did not settle")
    }

    func testRecoveredEvidenceOverridesMemoizedCardsAndRefreshesSorting() throws {
        let product = try full(complete: false)
        let engine = NativeProductRatingEngine(catalogue: nil)
        let before = engine.rating(for: product)
        var recovered: [String: Any]? = nil
        engine.recoveredScore = { candidate in candidate.barcode == product.barcode ? recovered : nil }
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { $0 })
        XCTAssertEqual(loader.rating(for: product), before)
        let revision = loader.revision
        recovered = ["value": 100, "status": "provisional", "estimated": false]
        loader.evidenceDidChange()
        XCTAssertGreaterThan(loader.revision, revision)
        XCTAssertEqual(loader.rating(for: product), .init(value: 100, subtitle: "Provisional Nudge rating"))
        XCTAssertEqual(loader.rating(for: product).tone, .green)
        recovered = ["value": 50, "status": "estimated_provisional", "estimated": true]
        XCTAssertEqual(loader.rating(for: product).subtitle, "Estimated Nudge rating")
        recovered = ["value": NSNull(), "status": "unrated"]
        XCTAssertNil(loader.rating(for: product).value, "Unknown cannot become a zero score")
        recovered = nil
        XCTAssertEqual(loader.rating(for: product), before, "Expired or incompatible recovery is discarded")
    }

    func testCardAssessmentReadsCurrentCatalogueOnceAndStillSeesNewEvidence() throws {
        let card = try index()
        var current: BarcodeProduct?
        var reads = 0
        let engine = NativeProductRatingEngine(catalogue: nil, now: { self.date }, catalogueRead: { code, _ in
            XCTAssertEqual(code, card.barcode)
            reads += 1
            return current
        })
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { $0 })
        XCTAssertNil(loader.rating(for: card).value)
        XCTAssertEqual(reads, 1, "A single card projection must not repeat public cache I/O for its hydration decision")
        current = try full()
        let expected = NativeProductRatingEngine(catalogue: nil, now: { self.date }).rating(for: try XCTUnwrap(current))
        reads = 0
        XCTAssertEqual(loader.rating(for: card), expected)
        XCTAssertEqual(reads, 1)
        current = nil
        reads = 0
        XCTAssertNil(loader.rating(for: card).value, "Removing current evidence cannot leave a stale cached badge")
        XCTAssertEqual(reads, 1)
    }

    func testBatchDeliveryDefersScoringUntilACardIsRequested() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        var calculated = Set<String>()
        engine.recoveredScore = { product in
            if product.searchProvider == nil { calculated.insert(product.barcode) }
            return nil
        }
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in throw BarcodeLookupError.notFound }, batchLookup: probe.lookup)
        defer { loader.cancel() }
        let cards = try (1...20).map { try index(String(10_000_000 + $0)) }
        loader.synchronize(products: cards); loader.appear(cards[0])
        try await settle { probe.calls.count == 1 }
        let revision = loader.revision
        probe.resolve(0, with: try cards.map { try full($0.barcode) })
        try await settle { loader.revision > revision }
        XCTAssertTrue(calculated.isEmpty, "Receiving a page of facts should not synchronously score twenty offscreen cards")
        XCTAssertNotNil(loader.rating(for: cards[0]).value)
        XCTAssertEqual(calculated, [cards[0].barcode])
        XCTAssertNotNil(loader.rating(for: cards[19]).value, "Scrolling can immediately use the already-delivered facts")
        XCTAssertEqual(calculated, [cards[0].barcode, cards[19].barcode])
        XCTAssertEqual(probe.calls.count, 1)
    }

    func testPrecomputedRatingRequiresCurrentVersionsFreshSourceAndUnchangedFacts() throws {
        var product = try full()
        let original = NativeProductRatingEngine(catalogue: nil, now: { self.date }).rating(for: product)
        XCTAssertNotEqual(original.value, 0)
        let score: [String: Any] = ["methodId": ActiveScoringFixture.method, "methodVersion": ActiveScoringFixture.version, "version": ActiveScoringFixture.version,
            "classifierVersion": ActiveScoringFixture.classifier, "status": "rated", "available": true,
            "value": 0, "rawScore": 30, "category": "general", "grade": "E", "baseFrequency": NSNull(), "finalFrequency": NSNull()]
        product.catalogueSourceExpiresAt = date.addingTimeInterval(100)
        let prepared = ProductCatalogueRating(method: ActiveScoringFixture.method, version: ActiveScoringFixture.version,
            classifierVersion: ActiveScoringFixture.classifier, sourceRevision: nil, fetchedAt: date,
            expiresAt: date.addingTimeInterval(100), calculatedAt: date,
            snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)),
            scoreData: try JSONSerialization.data(withJSONObject: score))
        product.catalogueRating = prepared
        XCTAssertEqual(NativeProductRatingEngine(catalogue: nil, now: { self.date }).rating(for: product).value, 0,
                       "Authenticated current matching precomputed result is used directly")
        product.imageURL = "https://images.openfoodfacts.org/images/products/fixture.jpg"
        XCTAssertNotEqual(NativeProductRatingEngine(catalogue: nil, now: { self.date }).rating(for: product).value, 0,
                          "Changed facts cannot retain a rating prepared for another snapshot")
        product.imageURL = nil
        XCTAssertNotEqual(NativeProductRatingEngine(catalogue: nil, now: { self.date.addingTimeInterval(101) }).rating(for: product).value, 0,
                          "Expired source evidence requires current local calculation")
        product.catalogueRating = ProductCatalogueRating(method: prepared.method, version: "old",
            classifierVersion: prepared.classifierVersion, sourceRevision: nil, fetchedAt: prepared.fetchedAt,
            expiresAt: prepared.expiresAt, calculatedAt: prepared.calculatedAt,
            snapshotFingerprint: prepared.snapshotFingerprint, scoreData: prepared.scoreData)
        XCTAssertNotEqual(NativeProductRatingEngine(catalogue: nil, now: { self.date }).rating(for: product).value, 0,
                          "Old scoring versions never become a current server rating")
    }

    func testDetailedCatalogueBridgeRequiresFreshBoundResultAndPreservesEstimateStatus() throws {
        let engine = NativeProductRatingEngine(catalogue: nil, now: { self.date })
        func prepared(status: String, estimated: Bool = false, expiry: Date? = nil) throws -> BarcodeProduct {
            var product = try full()
            let expires = expiry ?? date.addingTimeInterval(100)
            let score: [String: Any] = ["methodId": ActiveScoringFixture.method, "methodVersion": ActiveScoringFixture.version, "version": ActiveScoringFixture.version,
                "classifierVersion": ActiveScoringFixture.classifier, "status": status, "available": true,
                "estimated": estimated, "value": 0, "rawScore": 30, "category": "general", "grade": "E", "baseFrequency": NSNull(), "finalFrequency": NSNull()]
            product.catalogueSourceExpiresAt = expires
            product.catalogueRating = ProductCatalogueRating(method: ActiveScoringFixture.method, version: ActiveScoringFixture.version,
                classifierVersion: ActiveScoringFixture.classifier, sourceRevision: nil, fetchedAt: date.addingTimeInterval(-100),
                expiresAt: expires, calculatedAt: date.addingTimeInterval(-10),
                snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)),
                scoreData: try JSONSerialization.data(withJSONObject: score))
            return product
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        for status in ["rated", "provisional", "estimated", "estimated_provisional"] {
            let product = try prepared(status: status, estimated: status.hasPrefix("estimated"))
            let before = try encoder.encode(product)
            let accepted = try XCTUnwrap(engine.validatedDetailedCatalogueScore(for: product))
            XCTAssertEqual(accepted["status"] as? String, status)
            XCTAssertEqual(accepted["value"] as? Int, 0, "A real zero score remains a valid result")
            XCTAssertEqual(try encoder.encode(product), before)
            var changed = product
            changed.ingredientsAnalysisTags.append("en:vegan")
            XCTAssertNil(engine.validatedDetailedCatalogueScore(for: changed), "Changed facts invalidate the bound server result")
            XCTAssertNil(engine.validatedDetailedCatalogueScore(for: try prepared(status: status, expiry: date.addingTimeInterval(-1))))
            XCTAssertEqual(engine.validatedDetailedCatalogueScore(for: try prepared(status: status, estimated: true))?["estimated"] as? Bool, true, "A bound sourced estimate retains its estimate marker")
        }
        for status in ["estimated_rough", "unrated"] {
            XCTAssertNil(engine.validatedDetailedCatalogueScore(for: try prepared(status: status)))
        }
    }

    func testIncomingCatalogueRatingWinsOlderSameRevisionCacheWithoutOverridingNewerSourceFacts() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let catalogue = ProductLookupCache(directory: directory)
        let engine = NativeProductRatingEngine(catalogue: catalogue, now: { self.date })
        func prepared(value: Int, calculatedAgo: TimeInterval, revision: String = "2026-10-01T12:00:00Z",
                      classifier: String? = nil) throws -> BarcodeProduct {
            var product = try full(complete: false)
            product.lastModifiedAt = revision
            product.catalogueSourceExpiresAt = date.addingTimeInterval(100)
            let result: [String: Any] = ["methodId": ActiveScoringFixture.method, "version": ActiveScoringFixture.version,
                "classifierVersion": classifier ?? ActiveScoringFixture.classifier, "status": "rated", "available": true, "value": value,
                "rawScore": value == 100 ? -1 : 30, "category": "general", "grade": value == 100 ? "A" : "E",
                "baseFrequency": NSNull(), "finalFrequency": NSNull()]
            product.catalogueRating = ProductCatalogueRating(method: ActiveScoringFixture.method, version: ActiveScoringFixture.version,
                classifierVersion: classifier ?? ActiveScoringFixture.classifier, sourceRevision: nil, fetchedAt: date.addingTimeInterval(-100),
                expiresAt: date.addingTimeInterval(100), calculatedAt: date.addingTimeInterval(-calculatedAgo),
                snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)),
                scoreData: try JSONSerialization.data(withJSONObject: result))
            return product
        }
        let incoming = try prepared(value: 100, calculatedAgo: 10)
        let olderScore = try prepared(value: 0, calculatedAgo: 50)
        func replaceFixture(_ product: BarcodeProduct) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(product.barcode + ".json"))
            catalogue.write(product, now: date)
        }
        replaceFixture(olderScore)
        XCTAssertEqual(engine.rating(for: incoming).value, 100, "An older phone score cannot replace a newer incoming score for the same label")
        XCTAssertEqual(engine.rating(for: incoming, fullProduct: olderScore).value, 100, "Earlier screen hydration cannot hide the new score either")
        XCTAssertEqual(engine.preferredProduct(for: incoming, fullProduct: olderScore), incoming, "Detail opens use the identical selector")
        replaceFixture(try prepared(value: 0, calculatedAgo: 1, classifier: "food-evidence-2026-10-07-v5"))
        XCTAssertEqual(engine.rating(for: incoming).value, 100, "Only a current validated classifier may win a score-age comparison")
        replaceFixture(try prepared(value: 0, calculatedAgo: 5))
        XCTAssertEqual(engine.rating(for: incoming).value, 0, "A later valid recalculation of the same source revision is visible")
        replaceFixture(try prepared(value: 0, calculatedAgo: 50, revision: "2026-10-02T12:00:00Z"))
        XCTAssertEqual(engine.rating(for: incoming).value, 0, "Newer source facts win even when the older source score was calculated later")
        replaceFixture(try prepared(value: 0, calculatedAgo: 1, revision: "2026-09-30T12:00:00Z"))
        XCTAssertEqual(engine.rating(for: incoming).value, 100, "Recently calculated old source facts stay rejected")

        catalogue.write(incoming, now: date)
        catalogue.write(olderScore, now: date.addingTimeInterval(1))
        XCTAssertEqual(catalogue.read(barcode: incoming.barcode, now: date.addingTimeInterval(1)), incoming,
                       "A late same-revision response cannot roll the stored score back")
        let newerSource = try prepared(value: 0, calculatedAgo: 50, revision: "2026-10-02T12:00:00Z")
        catalogue.write(newerSource, now: date.addingTimeInterval(2))
        catalogue.write(incoming, now: date.addingTimeInterval(3))
        XCTAssertEqual(catalogue.read(barcode: incoming.barcode, now: date.addingTimeInterval(3)), newerSource,
                       "A later calculation of older source facts cannot roll stored label evidence back")
    }

    func testPrecomputedDetailedEstimatesAreReusedAndRetiredRoughV3FallsBackToFacts() throws {
        let detailed: [String: Any] = ["methodId": ActiveScoringFixture.method, "methodVersion": ActiveScoringFixture.version, "version": ActiveScoringFixture.version,
            "classifierVersion": ActiveScoringFixture.classifier, "available": true,
            "value": 0, "rawScore": 30, "category": "general", "grade": "E", "baseFrequency": NSNull(), "finalFrequency": NSNull()]
        let rough: [String: Any] = ["methodId": "nudge_food_estimate_v3", "methodVersion": "nudge_food_estimate_v3",
            "version": "3", "model_version": "3", "available": true, "status": "estimated_rough",
            "scoreBasis": "food_pattern", "confidence": "low", "value": 45,
            "grade": NSNull(), "rawScore": NSNull(), "baseFrequency": NSNull(), "finalFrequency": NSNull()]
        for status in ["estimated", "estimated_provisional", "estimated_rough"] {
            var score = status == "estimated_rough" ? rough : detailed
            score["status"] = status
            var product = try full()
            let engine = NativeProductRatingEngine(catalogue: nil, now: { self.date })
            XCTAssertEqual(engine.rating(for: product).value, 100)
            product.catalogueSourceExpiresAt = date.addingTimeInterval(100)
            product.catalogueRating = ProductCatalogueRating(method: ActiveScoringFixture.method, version: ActiveScoringFixture.version,
                classifierVersion: ActiveScoringFixture.classifier, sourceRevision: nil, fetchedAt: date,
                expiresAt: date.addingTimeInterval(100), calculatedAt: date,
                snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)),
                scoreData: try JSONSerialization.data(withJSONObject: score))
            let rating = engine.rating(for: product)
            XCTAssertEqual(rating.value, status == "estimated_rough" ? 100 : 0,
                           "Valid prepared estimates are reused; retired rough values fall back to current source facts")
            if status != "estimated_rough" {
                XCTAssertEqual(rating.subtitle, ActiveScoringFixture.method == "nudge_nutrition_v0_4" ? "Nudge score" : "Estimated Nudge rating")
            }
            XCTAssertEqual(engine.rating(for: product), rating, "Repeated renders reuse the accepted estimate")
        }
    }

    func testVisibleCardResolvesTwentyRatingsInOneBatchWithoutIndividualReadsOrSpacing() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in
            XCTFail("Batch discovery must not fan out into individual reads")
            throw BarcodeLookupError.notFound
        }, batchLookup: probe.lookup)
        let cards = try (1...40).map { try index(String(10_000_000 + $0)) }
        loader.synchronize(products: cards)
        for _ in 0..<3 { await Task.yield() }
        XCTAssertTrue(probe.calls.isEmpty)
        loader.appear(cards[0]); loader.appear(cards[1])
        try await settle { probe.calls.count == 1 }
        XCTAssertEqual(probe.calls[0].map(\.barcode), Array(cards.prefix(20)).map(\.barcode))
        XCTAssertEqual(loader.rating(for: cards[19]).subtitle, "Calculating Nudge rating")
        probe.resolve(0, with: try cards.prefix(20).map { try full($0.barcode) })
        try await settle { loader.rating(for: cards[19]).value != nil }
        XCTAssertTrue(cards.prefix(20).allSatisfy { loader.rating(for: $0).value != nil })
        XCTAssertNil(loader.rating(for: cards[20]).value)
        loader.appear(cards[19]); loader.disappear(cards[0]); loader.appear(cards[0])
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1, "Rerendering and scrolling reuse one page of facts")
        loader.appear(cards[20])
        try await settle { probe.calls.count == 2 }
        XCTAssertEqual(probe.calls[1].count, 20)
        probe.resolve(1, with: try cards.suffix(20).map { try full($0.barcode) })
        try await settle { loader.rating(for: cards[39]).value != nil }
        loader.cancel()
    }

    func testBatchRejectsMissingDuplicateForeignAndStaleFactsWithoutSingleReadFallback() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in
            XCTFail("Invalid batch facts cannot trigger single reads")
            throw BarcodeLookupError.notFound
        }, batchLookup: probe.lookup)
        var cards = try (1...5).map { try index(String(10_000_000 + $0)) }
        cards[2].lastModifiedAt = "2026-10-07T10:00:00Z"
        var stale = try full(cards[2].barcode)
        stale.lastModifiedAt = "2026-10-06T10:00:00Z"
        loader.synchronize(products: cards); loader.appear(cards[0])
        try await settle { probe.calls.count == 1 }
        probe.resolve(0, with: [try full(cards[0].barcode), try full(cards[1].barcode),
                               try full(cards[1].barcode), stale, try full("99999999"),
                               try full(cards[4].barcode, complete: false)])
        try await settle { loader.rating(for: cards[0]).value != nil }
        for card in cards[1...3] {
            XCTAssertNil(loader.rating(for: card).value)
            XCTAssertEqual(loader.rating(for: card).subtitle, "Rating unavailable")
            loader.appear(card)
        }
        XCTAssertEqual(loader.rating(for: cards[4]).subtitle, "Nutrition incomplete")
        XCTAssertNil(loader.rating(for: cards[4]).value, "Provider A cannot replace incomplete nutrition")
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1)
        loader.cancel()
    }

    func testNewQueryCancelsOldBatchAndCannotPublishItsLateFacts() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in throw BarcodeLookupError.notFound }, batchLookup: probe.lookup)
        let old = try index(), fresh = try index("10000002")
        loader.synchronize(products: [old]); loader.appear(old)
        try await settle { probe.calls.count == 1 }
        loader.synchronize(products: [fresh]); loader.reset(); loader.appear(fresh)
        try await settle { probe.calls.count == 2 }
        probe.resolve(0, with: [try full(old.barcode)])
        probe.resolve(1, with: [try full(fresh.barcode)])
        try await settle { loader.rating(for: fresh).value != nil }
        XCTAssertNil(loader.rating(for: old).value)
        loader.cancel()
    }

    func testBatchBudgetWaitSurvivesResetAndProviderThrottleRetriesOnlyOnce() async throws {
        var clock = date
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in throw BarcodeLookupError.notFound },
            batchLookup: probe.lookup, now: { clock })
        let card = try index()
        loader.synchronize(products: [card]); loader.appear(card)
        try await settle { probe.calls.count == 1 }
        probe.fail(0, with: ProductSearchError.rateLimited(30))
        try await settle { loader.rating(for: card).subtitle.contains("waiting for source") }
        loader.reset()
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1)
        clock = clock.addingTimeInterval(31); loader.appear(card)
        try await settle { probe.calls.count == 2 }
        probe.fail(1, with: ProductSearchError.providerRateLimited(90))
        try await settle { loader.rating(for: card).subtitle.contains("waiting for source") }
        clock = clock.addingTimeInterval(89); loader.appear(card)
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 2)
        clock = clock.addingTimeInterval(2); loader.appear(card)
        try await settle { probe.calls.count == 3 }
        probe.fail(2, with: ProductSearchError.providerRateLimited(60))
        try await settle { loader.rating(for: card).subtitle == "Rating unavailable" }
        clock = clock.addingTimeInterval(61); loader.appear(card)
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 3, "No unbounded automatic provider retry loop")
        loader.cancel()
    }

    func testRatingSortBatchesLoadedPagesSeriallyAndLeavingSortStopsOffscreenPages() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in throw BarcodeLookupError.notFound }, batchLookup: probe.lookup)
        let cards = try (1...45).map { try index(String(10_000_000 + $0)) }
        loader.synchronize(products: cards, resolveForSorting: true)
        try await settle { probe.calls.count == 1 }
        XCTAssertEqual(probe.calls[0].count, 20)
        probe.resolve(0, with: try cards.prefix(20).map { try full($0.barcode) })
        try await settle { probe.calls.count == 2 }
        XCTAssertEqual(probe.calls[1].count, 20)
        loader.synchronize(products: cards)
        probe.resolve(1, with: try cards[20..<40].map { try full($0.barcode) })
        try await settle { loader.rating(for: cards[39]).value != nil }
        XCTAssertEqual(probe.calls.count, 2, "Remaining offscreen pages stop when rating sorting is disabled")
        XCTAssertNil(loader.rating(for: cards[44]).value)
        loader.cancel()
    }

    func testEvictedBatchFactsCanBeHydratedAgainWithinSameSearch() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingBatchProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in throw BarcodeLookupError.notFound }, batchLookup: probe.lookup)
        let cards = try (1...220).map { try index(String(10_000_000 + $0)) }
        loader.synchronize(products: cards, resolveForSorting: true)
        for page in 0..<11 {
            try await settle { probe.calls.count == page + 1 }
            probe.resolve(page, with: try cards[(page * 20)..<(page * 20 + 20)].map { try full($0.barcode) })
        }
        try await settle { loader.rating(for: cards[219]).value != nil }
        loader.synchronize(products: cards)
        loader.appear(cards[0])
        try await settle { probe.calls.count == 12 }
        probe.resolve(11, with: try cards.prefix(20).map { try full($0.barcode) })
        try await settle { loader.rating(for: cards[0]).value != nil }
        loader.cancel()
    }

    func testOnlyVisibleUnknownCardsLoadWithTwoRequestsMaximumAndSharedScore() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil)
        let probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let cards = try (1...4).map { try index("1000000\($0)") }
        XCTAssertTrue(probe.calls.isEmpty)
        XCTAssertTrue(engine.fullProductRequired(for: cards[0]))
        XCTAssertNil(engine.rating(for: cards[0]).value, "An unproven index basis is never invented")
        for card in cards { loader.appear(card) }
        try await settle { probe.calls.count == 2 }
        XCTAssertEqual(probe.calls.map(\.barcode), Array(cards.prefix(2)).map(\.barcode))
        XCTAssertEqual(loader.rating(for: cards[0]).subtitle, "Calculating Nudge rating")
        loader.disappear(cards[3])
        let exact = try full()
        probe.resolve(cards[0].barcode, with: exact)
        try await settle { probe.calls.count == 3 }
        XCTAssertEqual(loader.rating(for: cards[0]), engine.rating(for: exact))
        XCTAssertNotNil(loader.rating(for: cards[0]).value)
        XCTAssertNotEqual(loader.rating(for: cards[0]).value, 0, "Provider E must not become 0%")
        XCTAssertNil(cards[0].nutritionPreparation, "Hydration does not mutate the index or diary snapshot")
        probe.resolve(cards[1].barcode, with: try full(cards[1].barcode))
        probe.resolve(cards[2].barcode, with: try full(cards[2].barcode))
        try await settle { loader.rating(for: cards[2]).value != nil }
        XCTAssertEqual(probe.calls.count, 3, "An offscreen queued product must not request facts")
        loader.cancel()
    }

    func testCancelledSearchCannotPublishLateResponse() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let card = try index()
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        loader.cancel()
        // The fixture intentionally ignores cancellation until its response.
        probe.resolve(card.barcode, with: try full())
        for _ in 0..<3 { await Task.yield() }
        XCTAssertNil(loader.rating(for: card).value)
        XCTAssertEqual(probe.calls.count, 1)
    }

    func testScrollingKeepsBoundedInFlightLookupAndReappearanceDoesNotRestartIt() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let card = try index()
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        loader.disappear(card)
        loader.synchronize(products: [card])
        probe.resolve(card.barcode, with: try full())
        try await settle { loader.rating(for: card).value != nil }
        loader.appear(card)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1, "Scrolling cannot cancel and refetch the same public nutrition")
        loader.cancel()
    }

    func testExplicitRatingSortResolvesLoadedOffscreenProductsWithinExistingConcurrencyLimit() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let cards = try (1...4).map { try index("1000000\($0)") }
        let model = NativeProductSearchModel(search: { query in
            ProductSearchPage(query: query, products: cards, hasMore: false)
        }, lookup: { _ in throw BarcodeLookupError.notFound })
        model.submit("chickpeas")
        try await settle { !model.loading }
        loader.synchronize(products: cards)
        for _ in 0..<3 { await Task.yield() }
        XCTAssertTrue(probe.calls.isEmpty, "Ordinary relevance discovery keeps offscreen hydration lazy")
        model.setSortOrder(.ratingHighest)
        loader.synchronize(products: cards, resolveForSorting: true)
        try await settle { probe.calls.count == 2 }
        XCTAssertEqual(probe.calls.count, 2)
        probe.resolve(cards[1].barcode, with: try full(cards[1].barcode))
        try await settle { probe.calls.count == 3 }
        XCTAssertEqual(model.orderedProducts(rating: loader.rating(for:)).first?.barcode, cards[1].barcode)
        probe.resolve(cards[0].barcode, with: try full(cards[0].barcode, complete: false))
        try await settle { probe.calls.count == 4 }
        probe.resolve(cards[2].barcode, with: try full(cards[2].barcode))
        probe.resolve(cards[3].barcode, with: try full(cards[3].barcode))
        try await settle { loader.rating(for: cards[3]).value != nil }
        XCTAssertEqual(model.orderedProducts(rating: loader.rating(for:)).map(\.barcode),
                       [cards[1].barcode, cards[2].barcode, cards[3].barcode, cards[0].barcode])
        model.setSortOrder(.ratingLowest)
        XCTAssertEqual(model.orderedProducts(rating: loader.rating(for:)).last?.barcode, cards[0].barcode)
        loader.synchronize(products: cards, resolveForSorting: true)
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 4, "Sorting again reuses delivered nutrition")
        loader.cancel(); model.cancel()
    }

    func testLeavingRatingSortStopsQueuedOffscreenLookups() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let cards = try (1...4).map { try index("1000000\($0)") }
        loader.synchronize(products: cards, resolveForSorting: true)
        try await settle { probe.calls.count == 2 }
        loader.synchronize(products: cards)
        probe.resolve(cards[0].barcode, with: try full(cards[0].barcode))
        probe.resolve(cards[1].barcode, with: try full(cards[1].barcode))
        try await settle { loader.rating(for: cards[1]).value != nil }
        XCTAssertEqual(probe.calls.count, 2, "Relevance/name sorting does not finish the offscreen queue")
        XCTAssertNil(loader.rating(for: cards[2]).value)
        loader.cancel()
    }

    func testOneTransportFailureStopsQueuedRequestsAndCooldownSurvivesReset() async throws {
        var clock = date
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, now: { clock }, minimumRequestSpacing: 0)
        let cards = try (1...3).map { try index("1000000\($0)") }
        for card in cards { loader.appear(card) }
        try await settle { probe.calls.count == 2 }
        probe.fail(cards[0].barcode, with: BarcodeLookupError.offline)
        probe.resolve(cards[1].barcode, with: try full(cards[1].barcode))
        try await settle { loader.rating(for: cards[0]).subtitle == "Rating unavailable" }
        XCTAssertEqual(probe.calls.count, 2)
        XCTAssertEqual(loader.rating(for: cards[2]).subtitle, "Rating queued · waiting for source")
        loader.reset()
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 2, "Changing a query must not bypass a provider cooldown")
        clock = clock.addingTimeInterval(61)
        loader.reset()
        try await settle { probe.calls.count == 4 }
        probe.resolve(cards[0].barcode, with: try full(cards[0].barcode))
        probe.resolve(cards[2].barcode, with: try full(cards[2].barcode))
        loader.cancel()
    }

    func testIncompleteFullRecordIsNotRetriedOrConvertedFromProviderA() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let card = try index()
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        let exact = try full(complete: false)
        probe.resolve(card.barcode, with: exact)
        try await settle { loader.rating(for: card).subtitle == "Nutrition incomplete" }
        XCTAssertNil(loader.rating(for: card).value)
        XCTAssertFalse(engine.fullProductRequired(for: exact))
        loader.disappear(card); loader.appear(card); loader.reset()
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1, "A complete lookup with incomplete nutrition must not loop")
        loader.cancel()
    }

    func testFreshExactCacheNeedsNoLookupAndOlderEvidenceCannotReplaceIndex() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let catalogue = ProductLookupCache(directory: directory)
        let engine = NativeProductRatingEngine(catalogue: catalogue, now: { self.date })
        var card = try index(), exact = try full()
        card.lastModifiedAt = "2026-10-01T12:00:00Z"
        exact.lastModifiedAt = "2026-09-30T12:00:00Z"
        catalogue.write(exact, now: date)
        XCTAssertTrue(engine.fullProductRequired(for: card))
        XCTAssertNil(engine.rating(for: card).value)
        XCTAssertFalse(NativeProductRatingEngine.isCurrentFullProduct(exact, for: card))
        exact.lastModifiedAt = "2026-10-01T12:00:00.000Z"
        catalogue.write(exact, now: date)
        XCTAssertFalse(engine.fullProductRequired(for: card))
        XCTAssertEqual(engine.rating(for: card), engine.rating(for: exact))
        XCTAssertFalse(NativeProductRatingEngine.isCurrentFullProduct(try full("99999999"), for: card))
        XCTAssertFalse(NativeProductRatingEngine.isCurrentFullProduct(card, for: card))
        exact.lastModifiedAt = nil
        XCTAssertFalse(NativeProductRatingEngine.isCurrentFullProduct(exact, for: card), "A recent fetch cannot date the underlying provider record")
        card.lastModifiedAt = "invalid-provider-date"
        XCTAssertFalse(NativeProductRatingEngine.isCurrentFullProduct(exact, for: card))
    }

    func testStaleOrWrongBarcodeHydrationDoesNotProduceRating() async throws {
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0)
        let card = try index(), second = try index("10000002"), third = try index("10000003")
        loader.appear(card); loader.appear(second); loader.appear(third)
        try await settle { probe.calls.count == 2 }
        probe.resolve(card.barcode, with: try full("99999999"))
        try await settle { loader.rating(for: card).subtitle == "Rating unavailable" && probe.calls.count == 3 }
        XCTAssertNil(loader.rating(for: card).value)
        XCTAssertEqual(probe.calls.last?.barcode, third.barcode, "One invalid source record must not pause other products")
        loader.disappear(card); loader.appear(card)
        XCTAssertEqual(probe.calls.count, 3, "The failed product cannot immediately retry")
        probe.resolve(second.barcode, with: try full(second.barcode))
        probe.resolve(third.barcode, with: try full(third.barcode))
        try await settle { loader.rating(for: third).value != nil }
        loader.cancel()
    }

    func testRollingRequestBudgetSurvivesDifferentQueriesAndResumesInNewWindow() async throws {
        var clock = date, calls = 0
        let engine = NativeProductRatingEngine(catalogue: nil)
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { snapshot in
            calls += 1
            return try self.full(snapshot.barcode)
        }, now: { clock }, minimumRequestSpacing: 0)
        for number in 1...12 {
            let card = try index(String(10_000_000 + number))
            loader.reset(); loader.appear(card)
            try await settle { loader.rating(for: card).value != nil }
            loader.disappear(card)
        }
        XCTAssertEqual(calls, 12)
        let last = try index("10000401")
        loader.reset(); loader.appear(last)
        for _ in 0..<3 { await Task.yield() }
        XCTAssertEqual(calls, 12)
        loader.reset()
        XCTAssertEqual(calls, 12)
        clock = clock.addingTimeInterval(61)
        loader.reset()
        try await settle { calls == 13 && loader.rating(for: last).value != nil }
        loader.cancel()
    }

    func testDefaultSpacingDoesNotBurstProductReads() async throws {
        var clock = date
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, now: { clock })
        let cards = try (1...2).map { try index("1000000\($0)") }
        loader.appear(cards[0]); loader.appear(cards[1])
        try await settle { probe.calls.count == 1 }
        clock = clock.addingTimeInterval(4.09)
        loader.appear(cards[1])
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1)
        clock = clock.addingTimeInterval(0.02)
        loader.appear(cards[1])
        try await settle { probe.calls.count == 2 }
        probe.resolve(cards[0].barcode, with: try full(cards[0].barcode))
        probe.resolve(cards[1].barcode, with: try full(cards[1].barcode))
        try await settle { loader.rating(for: cards[1]).value != nil }
        loader.cancel()
    }

    func testProviderRetryAfterIsHonouredAndOnlyOneAutomaticRetryIsAllowedPerQuery() async throws {
        var clock = date
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, now: { clock }, minimumRequestSpacing: 0)
        let card = try index()
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        probe.fail(card.barcode, with: BarcodeLookupError.retryLater(90))
        try await settle { loader.rating(for: card).subtitle == "Rating queued · waiting for source" }
        clock = clock.addingTimeInterval(89)
        loader.appear(card)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 1)
        clock = clock.addingTimeInterval(2)
        loader.appear(card)
        try await settle { probe.calls.count == 2 }
        probe.fail(card.barcode, with: BarcodeLookupError.retryLater(120))
        try await settle { loader.rating(for: card).subtitle == "Rating unavailable" }
        clock = clock.addingTimeInterval(121)
        loader.appear(card)
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 2, "Repeated provider throttling cannot create an automatic retry loop")
        loader.reset()
        try await settle { probe.calls.count == 3 }
        probe.resolve(card.barcode, with: try full())
        try await settle { loader.rating(for: card).value != nil }
        loader.cancel()
    }

    func testLocalBudgetDeferralDoesNotConsumeProviderRetryAndCooldownSurvivesReset() async throws {
        var clock = date
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, now: { clock }, minimumRequestSpacing: 0)
        let card = try index()
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        probe.fail(card.barcode, with: BarcodeLookupError.productReadDeferred(30))
        try await settle { loader.rating(for: card).subtitle == "Rating queued · waiting for source" }
        clock = clock.addingTimeInterval(31)
        loader.appear(card)
        try await settle { probe.calls.count == 2 }
        probe.fail(card.barcode, with: BarcodeLookupError.rateLimited)
        try await settle { loader.rating(for: card).subtitle == "Rating queued · waiting for source" }
        clock = clock.addingTimeInterval(61)
        loader.appear(card)
        try await settle { probe.calls.count == 3 }
        probe.fail(card.barcode, with: BarcodeLookupError.retryLater(90))
        try await settle { loader.rating(for: card).subtitle == "Rating unavailable" }
        loader.reset()
        for _ in 0..<4 { await Task.yield() }
        XCTAssertEqual(probe.calls.count, 3, "A new query cannot bypass the provider cooldown")
        clock = clock.addingTimeInterval(91)
        loader.appear(card)
        try await settle { probe.calls.count == 4 }
        probe.resolve(card.barcode, with: try full())
        try await settle { loader.rating(for: card).value != nil }
        loader.cancel()
    }

    func testRefreshedDetailCatalogueOverridesEarlierHydrationAndMemoryExpires() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var clock = date
        let catalogue = ProductLookupCache(directory: directory)
        let engine = NativeProductRatingEngine(catalogue: catalogue, now: { clock }), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, now: { clock }, minimumRequestSpacing: 0)
        var card = try index(), original = try full()
        card.lastModifiedAt = "2026-10-01T12:00:00Z"
        original.lastModifiedAt = "2026-10-01T12:00:00Z"
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        probe.resolve(card.barcode, with: original)
        try await settle { loader.rating(for: card).value != nil }
        var refreshed = try full(complete: false)
        refreshed.lastModifiedAt = "2026-10-02T12:00:00Z"
        catalogue.write(refreshed, now: clock)
        XCTAssertNil(loader.rating(for: card).value, "Detail's newer source facts supersede the earlier card score")
        XCTAssertEqual(loader.rating(for: card).subtitle, "Nutrition incomplete")
        clock = clock.addingTimeInterval(8 * 86_400)
        XCTAssertNil(catalogue.read(barcode: card.barcode, now: clock), "The normal public-cache freshness window has elapsed")
        XCTAssertEqual(catalogue.read(barcode: card.barcode, now: clock, allowStale: true), refreshed,
                       "Expired freshness does not discard newer source facts needed for offline display")
        XCTAssertFalse(engine.fullProductRequired(for: card), "A retained exact record does not need index hydration")
        XCTAssertNil(loader.rating(for: card).value, "The newer incomplete source still supersedes the earlier numeric score")
        // Isolate the transient hydration lifetime from intentionally retained
        // durable facts. This file belongs only to this synthetic fixture.
        try FileManager.default.removeItem(at: directory.appendingPathComponent(card.barcode + ".json"))
        XCTAssertNil(catalogue.read(barcode: card.barcode, now: clock, allowStale: true))
        loader.appear(card)
        try await settle { probe.calls.count == 2 }
        XCTAssertNil(loader.rating(for: card).value, "With no durable facts, expired in-memory hydration cannot restore the old score")
        probe.resolve(card.barcode, with: original)
        loader.cancel()
    }

    // Minimal public OFF v3.6 fixture captured 7 October 2026. The aggregate
    // carries per-100-ml preparation and inequality evidence omitted by search.
    func testRealStructuredMilkRecordHydratesWithSameCoreAndPreservesSourceBasis() async throws {
        let data = Data(#"""
        {
          "product": {
            "code": "5000316000256",
            "product_name": "Moo Milk chocolate flavoured",
            "categories_tags": [
              "en:beverages-and-beverages-preparations",
              "en:beverages",
              "en:dairies",
              "en:dairy-drinks",
              "en:milks-liquid-and-powder",
              "en:milks",
              "en:flavoured-milks",
              "en:chocolate-milks"
            ],
            "ingredients_text": "1% Fat _Milk_ (93%), Sugar, _Buttermilk_ Powder, Dark Chocolate Powder (Sugar, Cocoa Mass, Fat-reduced Cocoa Powder, Flavouring) (1.1%), Fat-reduced Cocoa Powder (0.9%), Stabilisers (Carrageenan, Xanthan Gum, Calcium Sulphate), Natural Flavouring.",
            "last_modified_t": 1774623654,
            "nutrition": {
              "aggregated_set": {
                "nutrients": {
                  "carbohydrates": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 8.9
                  },
                  "energy": {
                    "modifier": "~",
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "kJ",
                    "value": 249.5
                  },
                  "energy-kcal": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "kcal",
                    "value": 62.1414913957935,
                    "value_computed": 59
                  },
                  "energy-kj": {
                    "modifier": "~",
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "kJ",
                    "value": 249.5
                  },
                  "fat": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 0.8
                  },
                  "fiber": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 0.5
                  },
                  "proteins": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 3.8
                  },
                  "salt": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 0.0975,
                    "value_computed": 0.0975
                  },
                  "saturated-fat": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 0.6
                  },
                  "sugars": {
                    "source": "packaging",
                    "source_index": 0,
                    "source_per": "serving",
                    "unit": "g",
                    "value": 8.8
                  }
                },
                "per": "100ml",
                "preparation": "as_sold"
              }
            }
          }
        }
        """#.utf8)
        let exact = try OpenFoodFactsParser.parse(data: data, barcode: "5000316000256", retrievedAt: date)
        var card = exact
        card.searchProvider = "open_food_facts_search"; card.nutritionPreparation = nil
        let engine = NativeProductRatingEngine(catalogue: nil)
        let loader = NativeSearchRatingLoader(engine: engine, lookup: { _ in exact }, minimumRequestSpacing: 0)
        XCTAssertNil(loader.rating(for: card).value)
        loader.appear(card)
        try await settle { loader.rating(for: card).value != nil }
        XCTAssertEqual(loader.rating(for: card), engine.rating(for: exact))
        XCTAssertEqual(exact.basisUnit, "ml")
        XCTAssertEqual(exact.nutritionPreparation, "as_sold")
        XCTAssertEqual(exact.nutrients["protein"]?.value, 3.8)
        XCTAssertEqual(exact.energyKj?.relation, "~", "Computed energy remains approximate source evidence")
        XCTAssertNil(card.nutritionPreparation)
        loader.cancel()
    }

    func testSynchronizingNewResultsCancelsHiddenCardsAndDiagnosticsContainNoFoodIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let engine = NativeProductRatingEngine(catalogue: nil), probe = RatingLookupProbe()
        let loader = NativeSearchRatingLoader(engine: engine, lookup: probe.lookup, minimumRequestSpacing: 0,
            diagnostics: AnalysisDiagnostics(directory: directory))
        let card = try index("99992222")
        loader.appear(card)
        try await settle { probe.calls.count == 1 }
        loader.synchronize(products: [])
        probe.resolve(card.barcode, with: try full(card.barcode))
        for _ in 0..<4 { await Task.yield() }
        XCTAssertNil(loader.rating(for: card).value)
        let evidence = try String(contentsOf: directory.appendingPathComponent("events.json"), encoding: .utf8)
        XCTAssertFalse(evidence.contains(card.barcode))
        XCTAssertFalse(evidence.contains(card.name))
        XCTAssertFalse(evidence.contains("search_request"))
        XCTAssertTrue(evidence.contains("catalogue"))
        loader.cancel()
    }
}

@MainActor
private final class RatingBatchProbe {
    var calls: [[BarcodeProduct]] = []
    private var pending: [Int: CheckedContinuation<[BarcodeProduct], Error>] = [:]
    func lookup(_ products: [BarcodeProduct]) async throws -> [BarcodeProduct] {
        let number = calls.count
        calls.append(products)
        return try await withCheckedThrowingContinuation { pending[number] = $0 }
    }
    func resolve(_ number: Int, with products: [BarcodeProduct]) { pending.removeValue(forKey: number)?.resume(returning: products) }
    func fail(_ number: Int, with error: Error) { pending.removeValue(forKey: number)?.resume(throwing: error) }
}

@MainActor
private final class RatingLookupProbe {
    var calls: [BarcodeProduct] = []
    private var pending: [String: CheckedContinuation<BarcodeProduct, Error>] = [:]
    func lookup(_ product: BarcodeProduct) async throws -> BarcodeProduct {
        calls.append(product)
        return try await withCheckedThrowingContinuation { pending[product.barcode] = $0 }
    }
    func resolve(_ barcode: String, with product: BarcodeProduct) { pending.removeValue(forKey: barcode)?.resume(returning: product) }
    func fail(_ barcode: String, with error: Error) { pending.removeValue(forKey: barcode)?.resume(throwing: error) }
}
