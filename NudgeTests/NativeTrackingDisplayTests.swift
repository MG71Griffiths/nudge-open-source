import Foundation
import Testing
import UIKit
import SwiftUI
@testable import Nudge

struct NativeTrackingDisplayTests {
    @Test @MainActor func deferredHistoryScoreKeepsItsExactLabelNoteAndIdentity() async throws {
        let request = NativeHistoryScoreRequest(id: "synthetic-history-row", revision: "r1|2026-10-11", deferred: true)
        var scored: [String] = []
        let resolution = await NativeHistoryScoreResolution.resolve(request) { id in
            scored.append(id)
            return ["scoreDisplay": ["value": 50, "label": "Nudge score 50 out of 100 · Often", "frequency": "Often"],
                    "note": "Ready to log · Estimated", "presentationRefreshAt": 1_800_000_000.0]
        }
        let result = try #require(resolution)
        let value = try #require(result.matching(request))
        #expect(scored == [request.id])
        #expect((value["scoreDisplay"] as? [String: Any])?["label"] as? String == "Nudge score 50 out of 100 · Often")
        #expect(value["note"] as? String == "Ready to log · Estimated")
        #expect(result.refreshAt == 1_800_000_000)
        #expect(result.matching(.init(id: "different-row", revision: request.revision, deferred: true)) == nil)
        #expect(result.matching(.init(id: request.id, revision: "r2|2026-10-11", deferred: true)) == nil)
        #expect(result.matching(.init(id: request.id, revision: request.revision, deferred: false)) == nil)
    }

    @Test @MainActor func cancelledOffscreenHistoryRowDoesNotCalculateItsScore() async {
        var calls = 0
        let request = NativeHistoryScoreRequest(id: "offscreen", revision: "r1", deferred: true)
        let task = Task {
            await NativeHistoryScoreResolution.resolve(request) { _ in calls += 1; return [:] }
        }
        task.cancel()
        #expect(await task.value == nil)
        #expect(calls == 0)
    }

    @Test @MainActor func immediateHistoryScoresDoNotInvokeDeferredCalculation() async {
        var calls = 0
        let direct = NativeHistoryScoreRequest(id: "saved-entry", revision: "r1", deferred: false)
        let result = await NativeHistoryScoreResolution.resolve(direct) { _ in calls += 1; return [:] }
        #expect(result == nil)
        let missing = await NativeHistoryScoreResolution.resolve(.init(id: "", revision: "r1", deferred: true)) { _ in calls += 1; return [:] }
        #expect(missing == nil)
        #expect(calls == 0)
        #expect(NativeHistoryScoreResolution(request: direct, value: [:]).refreshAt == nil)
        #expect(NativeHistoryScoreResolution(request: direct, value: ["presentationRefreshAt": NSNull()]).refreshAt == nil)
        #expect(NativeHistoryScoreResolution(request: direct, value: ["presentationRefreshAt": Double.infinity]).refreshAt == nil)
    }

    @Test func historyRowsKeepIdentityWhenANewerScanArrivesOrAnotherIsDeleted() {
        let first: [String: Any] = ["id": "photo-a", "historyDay": "2026-10-11", "kind": "photo", "entry": ["day": "2026-10-01"]]
        let second: [String: Any] = ["id": "product-b", "historyDay": "2026-10-10", "kind": "product"]
        let before = NativeTrackingDisplay.historyGroups([first, second], filter: "all")
        let newest: [String: Any] = ["id": "photo-new", "historyDay": "2026-10-12"]
        let after = NativeTrackingDisplay.historyGroups([newest, first, second], filter: "all")
        #expect(after.map(\.day) == ["2026-10-12", "2026-10-11", "2026-10-10"])
        #expect(before[0].rows[0].id == after[1].rows[0].id)
        #expect(before[1].rows[0].id == after[2].rows[0].id)
        let removed = NativeTrackingDisplay.historyGroups([second], filter: "all")
        #expect(removed[0].rows[0].id == before[1].rows[0].id)
        let duplicate = NativeTrackingDisplay.identifiedRows([first, first])
        #expect(Set(duplicate.map(\.id)).count == 2)
    }

    @Test func historyGroupingPreservesInputOrderWithinEachCaptureDay() {
        let rows: [[String: Any]] = [
            ["id": "new", "historyDay": "2026-10-11"],
            ["id": "old", "historyDay": "2026-10-10"],
            ["id": "same", "historyDay": "2026-10-11"]
        ]
        let groups = NativeTrackingDisplay.historyGroups(rows, filter: "photos")
        #expect(groups.map(\.day) == ["2026-10-11", "2026-10-10"])
        #expect(groups[0].rows.compactMap { $0.value["id"] as? String } == ["new", "same"])
        let oldRow: [String: Any] = ["id": "legacy", "createdAt": "2026-10-11T12:00:00.000Z", "entry": ["day": "2026-10-02"]]
        #expect(NativeTrackingDisplay.historyGroups([oldRow], filter: "eaten")[0].day == "2026-10-02")
    }

    @Test func retainedPhotosLoadOffMainOnceAndDecodeOnlyRequestedThumbnailSize() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = NudgeDataStore(directory: folder), original = try thumbnailFixture()
        let references = try store.savePhotos([original])
        let reads = ThumbnailReads(data: original)
        let cache = NativeFoodImageCache(readData: { reference in
            await reads.record(reference, onMain: Thread.isMainThread)
            return store.photoData(for: reference)
        })
        async let left = cache.image(for: references[0], maximumPixelSize: 256)
        async let right = cache.image(for: references[0], maximumPixelSize: 256)
        let (first, second) = await (left, right)
        let firstImage = try #require(first?.cgImage), secondImage = try #require(second?.cgImage)
        #expect(firstImage.width == 256 && firstImage.height == 128)
        #expect(secondImage.width == 256)
        #expect(await reads.sources == [references[0]])
        #expect(await reads.ranOnMain == false)
        _ = await cache.image(for: references[0], maximumPixelSize: 256)
        #expect(await reads.sources.count == 1)
        let detail = await cache.image(for: references[0], maximumPixelSize: 768)
        #expect(detail?.cgImage?.width == 768)
        #expect(await reads.sources.count == 2)
        #expect(store.photoData(for: references[0]) == original)
    }

    @Test func thumbnailCacheEvictsByDecodedMemoryAndDoesNotMixSources() async throws {
        let original = try thumbnailFixture(), reads = ThumbnailReads(data: original)
        // A 256x128 RGBA image needs at least 128 KiB; compressed JPEG size
        // must not permit an unlimited decoded cache on photo-heavy histories.
        let cache = NativeFoodImageCache(maximumBytes: 180_000, maximumCount: 64, readData: { await reads.load($0) })
        _ = await cache.image(for: "first", maximumPixelSize: 256)
        _ = await cache.image(for: "second", maximumPixelSize: 256)
        _ = await cache.image(for: "second", maximumPixelSize: 256)
        #expect(await reads.sources == ["first", "second"])
        _ = await cache.image(for: "first", maximumPixelSize: 256)
        #expect(await reads.sources == ["first", "second", "first"])
    }

    @Test func thumbnailLoadsAreBoundedAndWarmImagesBypassBusyWork() async throws {
        let reads = GatedThumbnailReads(data: try thumbnailFixture())
        let cache = NativeFoodImageCache(maximumConcurrentLoads: 2, readData: { await reads.load($0) })
        #expect(await cache.image(for: "warm", maximumPixelSize: 256) != nil)
        let tasks = (0..<12).map { index in Task { await cache.image(for: "queued-\(index)", maximumPixelSize: 256) } }
        #expect(await thumbnailEventually { let work = await cache.workloadForTesting(); return work.active == 2 && work.queued == 10 })
        #expect(await reads.peak == 2)
        #expect(await reads.sources.count == 2)
        let warm = Task {
            let image = await cache.image(for: "warm", maximumPixelSize: 256)
            await reads.warmReturned()
            return image
        }
        #expect(await thumbnailEventually { await reads.didReturnWarm })
        #expect(await reads.sources.count == 2, "A cache hit must not wait behind disk/network reads")
        for task in tasks { task.cancel() }
        for task in tasks { #expect(await task.value == nil) }
        #expect(await thumbnailEventually { let work = await cache.workloadForTesting(); return work.pending == 0 && work.queued == 0 })
        await reads.releaseAll()
        #expect(await warm.value != nil)
        #expect(await thumbnailEventually { await cache.workloadForTesting().active == 0 })
        #expect(await reads.peak == 2)
    }

    @Test func cancellingOneThumbnailReaderKeepsTheOtherAndTheSharedCache() async throws {
        let reads = GatedThumbnailReads(data: try thumbnailFixture())
        let cache = NativeFoodImageCache(readData: { await reads.load($0) })
        let first = Task { await cache.image(for: "shared", maximumPixelSize: 256) }
        let second = Task { await cache.image(for: "shared", maximumPixelSize: 256) }
        #expect(await thumbnailEventually {
            let work = await cache.workloadForTesting(), count = await reads.sources.count
            return work.readers == 2 && count == 1
        })
        first.cancel()
        #expect(await first.value == nil, "A disappearing row must stop waiting immediately")
        #expect(await cache.workloadForTesting().readers == 1)
        await reads.release(0)
        #expect(await second.value?.cgImage?.width == 256)
        #expect(await cache.image(for: "shared", maximumPixelSize: 256) != nil)
        #expect(await reads.sources == ["shared"])
    }

    @Test func cancelledQueuedThumbnailsNeverReadAndDoNotBlockLaterVisibleRows() async throws {
        let reads = GatedThumbnailReads(data: try thumbnailFixture())
        let cache = NativeFoodImageCache(maximumConcurrentLoads: 1, readData: { await reads.load($0) })
        let first = Task { await cache.image(for: "visible-first", maximumPixelSize: 256) }
        #expect(await thumbnailEventually { await reads.sources.count == 1 })
        let gone = Task { await cache.image(for: "gone-offscreen", maximumPixelSize: 256) }
        #expect(await thumbnailEventually { await cache.workloadForTesting().queued == 1 })
        gone.cancel()
        #expect(await gone.value == nil)
        #expect(await thumbnailEventually { await cache.workloadForTesting().queued == 0 })
        let next = Task { await cache.image(for: "visible-next", maximumPixelSize: 256) }
        #expect(await thumbnailEventually { await cache.workloadForTesting().queued == 1 })
        await reads.release(0)
        #expect(await first.value != nil)
        #expect(await thumbnailEventually { await reads.sources.count == 2 })
        #expect(await reads.sources == ["visible-first", "visible-next"])
        await reads.release(1)
        #expect(await next.value != nil)
        #expect(await thumbnailEventually { let work = await cache.workloadForTesting(); return work.active == 0 && work.pending == 0 })
    }

    @Test func cancelledOldThumbnailFlightCannotFinishItsReplacement() async throws {
        let reads = GatedThumbnailReads(data: try thumbnailFixture())
        let cache = NativeFoodImageCache(maximumConcurrentLoads: 2, readData: { await reads.load($0) })
        let old = Task { await cache.image(for: "same-source", maximumPixelSize: 256) }
        #expect(await thumbnailEventually { await reads.sources.count == 1 })
        old.cancel()
        #expect(await old.value == nil)
        let replacement = Task { await cache.image(for: "same-source", maximumPixelSize: 256) }
        #expect(await thumbnailEventually { await reads.sources.count == 2 })
        await reads.release(0)
        #expect(await thumbnailEventually { await cache.workloadForTesting().active == 1 })
        #expect(await cache.workloadForTesting().pending == 1)
        #expect(await cache.workloadForTesting().readers == 1)
        await reads.release(1)
        #expect(await replacement.value != nil)
        #expect(await cache.workloadForTesting().pending == 0)
    }

    @Test func cachedDateFormatsKeepCalendarDatesAndFractionalTimestamps() throws {
        for day in ["2026-03-29", "2026-10-25", "2027-01-01"] {
            #expect(NativeTrackingDisplay.dayKey(NativeTrackingDisplay.date(day)) == day)
        }
        #expect(NativeTrackingDisplay.dateLabel("2026-10-11", format: "EEEE d MMMM") == "Sunday 11 October")
        #expect(NativeTrackingDisplay.dateLabel("2026-10-11", format: "d") == "11")
        let precise = try #require(NativeTrackingDisplay.timestamp("2026-10-11T12:00:00.125Z"))
        let whole = try #require(NativeTrackingDisplay.timestamp("2026-10-11T12:00:00Z"))
        #expect(abs(precise.timeIntervalSince(whole) - 0.125) < 0.001)
    }

    private func thumbnailFixture() throws -> Data {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1_600, height: 800), format: format).image { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 1_600, height: 800))
        }
        return try #require(image.jpegData(compressionQuality: 0.8))
    }

    @Test func unloggedUnknownAndConfirmedZeroRemainDifferent() {
        let unlogged: [String: Any] = ["key": "carbs", "title": "Carbs", "unit": "g", "value": 0, "target": 300, "recorded": false]
        let unknown = unlogged.merging(["recorded": true, "value": NSNull(), "unknown": 1], uniquingKeysWith: { _, value in value })
        let zero = unlogged.merging(["recorded": true], uniquingKeysWith: { _, value in value })
        #expect(NativeTrackingDisplay.valueLabel(unlogged) == "—")
        #expect(NativeTrackingDisplay.completion(unlogged) == "—")
        #expect(NativeTrackingDisplay.note(unlogged) == "No food logged")
        #expect(NativeTrackingDisplay.valueLabel(unknown) == "—")
        #expect(NativeTrackingDisplay.note(unknown) == "Nutrition unknown")
        #expect(NativeTrackingDisplay.valueLabel(zero) == "0 g")
        #expect(NativeTrackingDisplay.completion(zero) == "0%")
    }

    @Test func partialNutritionAndRoundingNeverAnnounceEarlyCompletion() {
        let partial: [String: Any] = ["key": "protein", "title": "Protein", "unit": "g", "value": 150, "rawValue": 149.96, "target": 150, "recorded": true, "unknown": 1]
        #expect(NativeTrackingDisplay.completion(partial) == "≥ 99%")
        #expect(NativeTrackingDisplay.note(partial) == "Known total · partial")
        let reached = partial.merging(["rawValue": 150, "unknown": 0], uniquingKeysWith: { _, value in value })
        #expect(NativeTrackingDisplay.completion(reached) == "100%")
        #expect(NativeTrackingDisplay.note(reached) == nil)
    }

    @Test func missingHistoricalTargetIsNeverComparedWithToday() {
        let historic: [String: Any] = ["key": "energy", "unit": "kcal", "value": 1800, "target": NSNull(), "targetKnown": false, "recorded": true]
        #expect(NativeTrackingDisplay.ratio(historic) == nil)
        #expect(NativeTrackingDisplay.valueLabel(historic) == "1,800 kcal")
        #expect(NativeTrackingDisplay.targetLabel(historic) == "Target not recorded")
        #expect(NativeTrackingDisplay.completion(historic) == "—")
    }

    @Test func overTargetEnergyIsNeutralAndPercentIsUncapped() {
        let energy: [String: Any] = ["key": "energy", "value": 3000, "target": 2500, "recorded": true, "unit": "kcal"]
        #expect(NativeTrackingDisplay.completion(energy) == "120%")
        #expect(NativeTrackingDisplay.note(energy) == "Over target")
        #expect(!NativeTrackingDisplay.description(energy).contains("goal reached"))
    }

    @Test func nonNumbersCannotBecomeZeroNutrition() {
        for value: Any in [NSNull(), true, false, "12", Double.nan, Double.infinity, -1] {
            #expect(NativeTrackingDisplay.number(value) == nil)
        }
        #expect(NativeTrackingDisplay.number(0) == 0)
        #expect(NativeTrackingDisplay.number(10.5) == 10.5)
    }

    @Test func futureDaysHideSuppliedIntakeAndDoNotFillRings() {
        let future: [String: Any] = ["key": "plants", "value": 10, "target": 30, "recorded": true, "future": true, "unit": "types"]
        #expect(NativeTrackingDisplay.ratio(future) == nil)
        #expect(NativeTrackingDisplay.valueLabel(future) == "—")
        #expect(NativeTrackingDisplay.note(future) == "Upcoming")
    }

    @Test func sourcePictureSurvivesJoinedHistoryAndDiaryRows() {
        let source = "https://images.openfoodfacts.org/images/products/123/front_en.jpg"
        let row: [String: Any] = ["product": ["imageURL": source], "entry": ["name": "Yoghurt"], "thumbnail": ""]
        #expect(NativeTrackingDisplay.imageSource(row) == source)
        let diary: [String: Any] = ["entry": ["sourceMeta": ["repertoireImage": source]]]
        #expect(NativeTrackingDisplay.imageSource(diary) == source)
    }

    @Test func entryPhotoWinsOverLinkedCataloguePictureAndStaysSpecificToTheEntry() {
        let product = "https://images.openfoodfacts.org/images/products/123/front_en.jpg"
        let first = "nudge-photo:11111111-1111-1111-1111-111111111111.jpg"
        let second = "nudge-photo:22222222-2222-2222-2222-222222222222.jpg"
        let row: [String: Any] = ["imageURL": product, "product": ["imageURL": product], "entry": ["sourceMeta": ["entryPhotos": ["", first], "entryThumbnail": "preview"]]]
        #expect(NativeTrackingDisplay.imageSource(row) == first)
        let other = row.merging(["entry": ["sourceMeta": ["entryPhotos": [second]]]], uniquingKeysWith: { _, latest in latest })
        #expect(NativeTrackingDisplay.imageSource(other) == second)
        let saved: [String: Any] = ["image": product, "draft": ["sourceMeta": ["entryThumbnail": "preview"]]]
        #expect(NativeTrackingDisplay.imageSource(saved) == "preview")
    }

    @Test func diaryGroupingRecognizesStoredMealNames() {
        #expect(NativeTrackingDisplay.mealSlot(["entry": ["slot": "Breakfast"]]) == "breakfast")
        #expect(NativeTrackingDisplay.mealSlot(["entry": ["slot": "Snacks"]]) == "snack")
        #expect(NativeTrackingDisplay.mealSlot(["entry": ["slot": "Lunch"]]) == "lunch")
    }

    @Test func zeroAndMissingTargetsRemainUnavailableWithReferenceAndLimitSemantics() {
        let invalid: [String: Any] = ["key": "salt", "value": 2, "target": 0, "recorded": true, "unit": "g", "targetRole": "limit"]
        #expect(NativeTrackingDisplay.ratio(invalid) == nil)
        #expect(NativeTrackingDisplay.completion(invalid) == "—")
        #expect(NativeTrackingDisplay.total(invalid) == "2 / — g")
        #expect(NativeTrackingDisplay.targetLabel(invalid) == "Target not set")
        let limit = invalid.merging(["target": 1], uniquingKeysWith: { _, latest in latest })
        #expect(NativeTrackingDisplay.completion(limit) == "200%")
        #expect(NativeTrackingDisplay.targetRoleLabel(limit) == "Upper limit")
        #expect(NativeTrackingDisplay.note(limit) == "Above upper limit")
        let reference = limit.merging(["targetRole": "reference"], uniquingKeysWith: { _, latest in latest })
        #expect(NativeTrackingDisplay.targetRoleLabel(reference) == "Reference amount")
        #expect(NativeTrackingDisplay.note(reference) == "Above reference amount")
        #expect(NativeTrackingDisplay.description(reference).contains("Reference amount"))
    }

    @Test func missingPictureUsesOnlyAnExplicitProductBarcode() {
        #expect(NativeTrackingDisplay.imageBarcode(["product": ["barcode": "01833317"]]) == "01833317")
        #expect(NativeTrackingDisplay.imageBarcode(["draft": ["barcode": "0227152001161"]]) == "0227152001161")
        #expect(NativeTrackingDisplay.imageBarcode(["entry": ["barcode": "10010010"]]) == "10010010")
        #expect(NativeTrackingDisplay.imageBarcode(["id": "12345678", "name": "12345678"]) == nil)
        #expect(NativeTrackingDisplay.imageBarcode(["barcode": "1234/../../image"]) == nil)
    }

    @Test func dailyPlantGuideAndAdultReferencesFillWithNeutralConsumptionSemantics() {
        let plant: [String: Any] = ["key": "plants", "title": "Plants today", "unit": "types", "value": 3, "target": 5,
                                   "targetKnown": true, "recorded": true, "targetRole": "guide"]
        #expect(NativeTrackingDisplay.ratio(plant) == 0.6)
        #expect(NativeTrackingDisplay.ringLabel(plant) == "60%")
        #expect(NativeTrackingDisplay.targetRoleLabel(plant) == "Daily variety guide")
        for (key, target) in [("sugars", 90.0), ("saturatedFat", 20.0)] {
            let item: [String: Any] = ["key": key, "unit": "g", "value": target / 2, "target": target,
                                      "recorded": true, "targetKnown": true, "targetRole": "reference", "referenceKind": "adult_label"]
            #expect(NativeTrackingDisplay.ratio(item) == 0.5)
            #expect(NativeTrackingDisplay.ringLabel(item) == "50%")
            #expect(NativeTrackingDisplay.note(item) == "Not a goal to reach")
            let atReference = item.merging(["value": target], uniquingKeysWith: { _, value in value })
            #expect(NativeTrackingDisplay.ringLabel(atReference) == "100%")
            #expect(NativeTrackingDisplay.note(atReference) == "At reference amount")
            let above = item.merging(["value": target * 1.2, "unknown": 1], uniquingKeysWith: { _, value in value })
            #expect(NativeTrackingDisplay.ringLabel(above) == "≥ 120%")
            #expect(NativeTrackingDisplay.note(above) == "Above reference amount · partial")
            #expect(NativeTrackingDisplay.color(above) == Color(uiColor: NudgeTheme.warningText))
            #expect(!NativeTrackingDisplay.description(above).contains("goal reached"))
        }
    }

    @Test func oldHistoryPictureHydratesFromPhoneCacheWithoutEditingFacts() async throws {
        let date = Date(), folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = "https://images.openfoodfacts.org/images/products/022/715/200/1161/front_en.6.400.jpg"
        let product = try imageProduct("0227152001161", image: source, date: date)
        let cache = ProductLookupCache(directory: folder)
        cache.write(product, now: date)
        let original = try Data(contentsOf: folder.appendingPathComponent(product.barcode + ".json"))
        let resolver = NativeCatalogueImageReferences(cache: cache, now: { date }, batch: { _ in
            Issue.record("A cached reference must not call the catalogue")
            return []
        })
        #expect(await resolver.source(for: product.barcode) == source)
        #expect(try Data(contentsOf: folder.appendingPathComponent(product.barcode + ".json")) == original)
    }

    @Test func visibleMissingPicturesShareBoundedCatalogueBatchesAndRemainReadOnly() async throws {
        let date = Date(), source = "https://images.openfoodfacts.org/images/products/022/715/200/1161/front_en.6.400.jpg"
        let records = try (0..<25).map { try imageProduct(String(10010000 + $0), image: source, date: date) }
        let calls = ImageReferenceCalls(records: records)
        let resolver = NativeCatalogueImageReferences(cache: nil, now: { date }, batch: { try await calls.load($0) })
        let found = await withTaskGroup(of: String?.self, returning: [String?].self) { group in
            for record in records { group.addTask { await resolver.source(for: record.barcode) } }
            var values: [String?] = []
            for await value in group { values.append(value) }
            return values
        }
        #expect(found.count == records.count)
        #expect(found.allSatisfy { $0 == source })
        let firstCalls = await calls.codes
        #expect(firstCalls.count == 2)
        #expect(firstCalls.allSatisfy { $0.count <= 20 })
        #expect(Set(firstCalls.flatMap { $0 }) == Set(records.map(\.barcode)))
        #expect(await resolver.source(for: records[0].barcode) == source)
        #expect(await calls.codes.count == 2)
        #expect(await resolver.source(for: "private-food-name") == nil)
        #expect(await calls.codes.count == 2)
    }

    @Test func missingOrWrongIdentityOrUntrustedImageDoesNotProduceAPicture() async throws {
        let date = Date()
        let wrong = try imageProduct("10010011", image: "https://images.openfoodfacts.org/example.jpg", date: date)
        let invalid = try imageProduct("10010010", image: "https://untrusted.example/private.jpg", date: date)
        let resolver = NativeCatalogueImageReferences(cache: nil, now: { date }, batch: { _ in [wrong, invalid] })
        #expect(await resolver.source(for: "10010010") == nil)
        let duplicated = NativeCatalogueImageReferences(cache: nil, now: { date }, batch: { _ in [wrong, wrong] })
        #expect(await duplicated.source(for: "10010011") == nil)
    }

    private func imageProduct(_ code: String, image: String, date: Date) throws -> BarcodeProduct {
        try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": ["code": code,
            "product_name": "Public image fixture", "image_front_url": image]]), barcode: code, retrievedAt: date)
    }
}

private func thumbnailEventually(_ condition: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}

private actor GatedThumbnailReads {
    let data: Data
    var sources: [String] = []
    var peak = 0
    var didReturnWarm = false
    private var active = 0
    private var held: [Int: CheckedContinuation<Data?, Never>] = [:]
    init(data: Data) { self.data = data }
    func load(_ source: String) async -> Data? {
        if source == "warm" { return data }
        let index = sources.count
        sources.append(source); active += 1; peak = max(peak, active)
        let result: Data? = await withCheckedContinuation { held[index] = $0 }
        active -= 1
        return result
    }
    func warmReturned() { didReturnWarm = true }
    func release(_ index: Int) { held.removeValue(forKey: index)?.resume(returning: data) }
    func releaseAll() {
        let continuations = Array(held.values); held.removeAll()
        for continuation in continuations { continuation.resume(returning: data) }
    }
}

private actor ThumbnailReads {
    let data: Data
    var sources: [String] = []
    var ranOnMain = false
    init(data: Data) { self.data = data }
    func record(_ source: String, onMain: Bool) {
        sources.append(source); ranOnMain = ranOnMain || onMain
    }
    func load(_ source: String) async -> Data {
        record(source, onMain: Thread.isMainThread)
        try? await Task.sleep(nanoseconds: 5_000_000)
        return data
    }
}

private actor ImageReferenceCalls {
    let records: [BarcodeProduct]
    var codes: [[String]] = []
    init(records: [BarcodeProduct]) { self.records = records }
    func load(_ codes: [String]) async throws -> [BarcodeProduct] {
        self.codes.append(codes)
        try await Task.sleep(nanoseconds: 10_000_000)
        return records.filter { codes.contains($0.barcode) }
    }
}
