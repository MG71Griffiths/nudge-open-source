import XCTest
import Combine
@testable import Nudge

@MainActor
final class NativeAppStoreTests: XCTestCase {
    func testNutritionRingShowsAmountsWithoutInventedTargets() {
        let partial: [String: Any] = ["key": "sugars", "unit": "g", "value": 18.0, "recorded": true, "unknown": 1]
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(partial), "≥ 18g")
        XCTAssertNil(NativeTrackingDisplay.ratio(partial), "A saved amount cannot invent a percentage or reference target")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["key": "saturatedFat", "unit": "g", "value": 6.3, "recorded": true]), "6.3g")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["key": "plants", "value": 4, "recorded": true]), "4")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["unit": "g", "value": 0, "recorded": true]), "0g")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["unit": "g", "recorded": true]), "—")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["unit": "g", "value": 0, "recorded": false]), "—")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["unit": "g", "value": 5, "recorded": true, "future": true]), "—")
        XCTAssertEqual(NativeTrackingDisplay.ringLabel(["unit": "g", "value": 25, "target": 20, "recorded": true]), "125%")
    }
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func seed(_ object: [String: Any], key: String = "wmd-nudge-prototype-v1", store: NudgeDataStore) throws -> String {
        let value = String(data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), encoding:.utf8)!
        let request = String(data:try JSONSerialization.data(withJSONObject:["operation":"set","key":key,"value":value]),encoding:.utf8)!
        let response=store.handle(request)
        XCTAssertTrue(response.contains("true"))
        return value
    }
    private func fixture() -> [String:Any] {
        ["version":1,"nutritionProfile":["saved":true,"age":55,"weight":78,"height":185,"sex":"male","activity":"moderate","care":"none","goal":"muscle"],"cycleSupport":["enabled":false],"foodLog":["entries":[],"savedRecipes":[],"plantGoal":30],"unknownFutureField":["keep":true]]
    }
    func testLoadsExistingStoresWithoutRewriting() throws {
        let disk=NudgeDataStore(directory:directory)
        _ = try seed(fixture(), store:disk)
        let file=directory.appendingPathComponent("wmd-nudge-prototype-v1.json"), before=try Data(contentsOf:file)
        let app=NativeAppStore(store:disk)
        XCTAssertTrue(app.ready, app.errorMessage ?? "No load error")
        XCTAssertNil(app.errorMessage)
        XCTAssertEqual(try Data(contentsOf:file),before)
        XCTAssertEqual((app.state["unknownFutureField"] as? [String:Bool])?["keep"],true)
        XCTAssertNotNil(app.project("today")["rings"])
        XCTAssertNotNil(app.project("profile")["profile"])
        XCTAssertEqual(try Data(contentsOf:file),before)
    }
    func testEditingDraftDoesNotRepublishSavedRecordsButConfirmationDoes() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        var stateChanges = 0, historyChanges = 0, foodsChanges = 0
        let subscriptions = [
            app.$state.dropFirst().sink { _ in stateChanges += 1 },
            app.$history.dropFirst().sink { _ in historyChanges += 1 },
            app.$foods.dropFirst().sink { _ in foodsChanges += 1 }
        ]
        defer { subscriptions.forEach { $0.cancel() } }
        let entry: [String: Any] = ["name":"Synthetic food", "day":NativeAppStore.day,
            "slot":"Lunch", "portions":1, "plants":[], "ferments":[], "proteinPerPortion":20]
        XCTAssertTrue(app.perform("setReview", ["kind":"entry", "entry":entry, "confirmationId":"incremental-edit"]))
        for index in 0..<20 {
            XCTAssertTrue(app.perform("reviewUpdate", ["name":"Synthetic food \(index)"]))
        }
        XCTAssertEqual(stateChanges, 0, "Typing must not rerender the diary")
        XCTAssertEqual(historyChanges, 0, "Typing must not rebridge the archive")
        XCTAssertEqual(foodsChanges, 0, "Typing must not rebuild saved foods")
        XCTAssertEqual((app.project("reviewModel")["draft"] as? [String:Any])?["name"] as? String, "Synthetic food 19")
        XCTAssertTrue(app.perform("reviewConfirm"), app.errorMessage ?? "Confirmation failed")
        XCTAssertEqual(stateChanges, 1)
        XCTAssertEqual(foodsChanges, 1)
        XCTAssertEqual(app.project("today")["entryCount"] as? Int, 1)
        let reopened = NativeAppStore(store: disk)
        XCTAssertEqual(reopened.project("today")["entryCount"] as? Int, 1)
    }
    func testScreenProjectionsReuseUnchangedDataAndInvalidateForDraftRecordsErrorsAndDay() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        var clock = Date()
        let app = NativeAppStore(store: disk, now: { clock })
        let presentation: [String: Any] = ["presentation":true]
        _ = app.project("today", presentation)
        _ = app.project("history", presentation)
        let todayCount = app.projectionEvaluations["today"], historyCount = app.projectionEvaluations["history"]
        app.notice = "Synthetic status"; app.loading = true; app.analysingCount = 2
        _ = app.project("today", presentation); _ = app.project("history", presentation)
        XCTAssertEqual(app.projectionEvaluations["today"], todayCount)
        XCTAssertEqual(app.projectionEvaluations["history"], historyCount)

        XCTAssertTrue(app.perform("setReview", ["kind":"entry", "entry":["name":"Synthetic food", "portions":1, "proteinPerPortion":10], "confirmationId":"projection-review"]))
        _ = app.project("reviewModel")
        let reviewCount = app.projectionEvaluations["reviewModel"]
        _ = app.project("reviewModel")
        XCTAssertEqual(app.projectionEvaluations["reviewModel"], reviewCount)
        XCTAssertTrue(app.perform("reviewUpdate", ["name":"Changed draft"]))
        XCTAssertEqual(app.project("reviewModel")["title"] as? String, "Changed draft")
        XCTAssertEqual(app.projectionEvaluations["reviewModel"], (reviewCount ?? 0) + 1)
        _ = app.project("history", presentation)
        XCTAssertEqual(app.projectionEvaluations["history"], historyCount, "Draft typing cannot invalidate the archive")

        XCTAssertTrue(app.perform("recordHistory", ["id":"cache-event", "kind":"product", "status":"ready", "name":"Synthetic product", "product":["name":"Synthetic product", "barcode":"12345678"]]))
        XCTAssertEqual((app.project("history", presentation)["rows"] as? [Any])?.count, 1)
        XCTAssertTrue(app.perform("historyDelete", ["id":"cache-event", "keepIntake":true]))
        XCTAssertEqual((app.project("history", presentation)["rows"] as? [Any])?.count, 0)
        XCTAssertTrue(app.perform("historyUndo"))
        XCTAssertEqual((app.project("history", presentation)["rows"] as? [Any])?.count, 1)
        let beforeError = app.projectionEvaluations["history"] ?? 0
        XCTAssertFalse(app.perform("profileSave", ["profile":["age":-1]]))
        _ = app.project("history", presentation)
        XCTAssertEqual(app.projectionEvaluations["history"], beforeError + 1, "Failed operations must expose current errors immediately")

        let beforeIdle = app.projectionEvaluations["history"] ?? 0
        clock.addTimeInterval(60)
        _ = app.project("history", presentation)
        XCTAssertEqual(app.projectionEvaluations["history"], beforeIdle, "Unchanged screens must not repeat work just because a timer elapsed")
        app.refreshPresentation()
        _ = app.project("history", presentation)
        XCTAssertEqual(app.projectionEvaluations["history"], beforeIdle + 1, "Foreground refresh checks current evidence")
        app.releasePresentationMemory()
        _ = app.project("history", presentation)
        XCTAssertEqual(app.projectionEvaluations["history"], beforeIdle + 2, "Memory pressure releases derived screens")
        let oldDay = app.project("today", presentation)["today"] as? String
        clock.addTimeInterval(86_400)
        XCTAssertNotEqual(app.project("today", presentation)["today"] as? String, oldDay)
        XCTAssertTrue(app.perform("reviewConfirm"))
        XCTAssertEqual(app.project("diary", ["day":oldDay ?? "", "presentation":true])["entryCount"] as? Int, 1)
        app.capture.cancelAllPhotoAnalyses()
    }

    func testDeferredHistoryScoresReuseVisibleResultsAndInvalidateWhenRecordsChange() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        XCTAssertTrue(app.perform("recordHistory", ["id":"visible-score", "kind":"product", "status":"ready",
            "name":"Synthetic oats", "product":["name":"Synthetic oats", "barcode":"12345678"]]))
        let row = try XCTUnwrap((app.project("history", ["presentation":true,"deferScores":true])["rows"] as? [[String:Any]])?.first)
        XCTAssertEqual(row["scoreDeferred"] as? Bool, true)
        XCTAssertNil(app.projectionEvaluations["historyScore"], "Opening History must not eagerly score unseen rows")
        let revision = app.historyScoreRevision
        let first = app.project("historyScore", ["id":"visible-score"])
        XCTAssertEqual(first["available"] as? Bool, true)
        let evaluations = app.projectionEvaluations["historyScore"]
        for _ in 0..<20 { _ = app.project("historyScore", ["id":"visible-score"]) }
        XCTAssertEqual(app.projectionEvaluations["historyScore"], evaluations)
        XCTAssertTrue(app.perform("setReview", ["kind":"entry", "entry":["name":"Synthetic draft", "portions":1], "confirmationId":"score-draft"]))
        XCTAssertEqual(app.historyScoreRevision, revision, "Draft editing cannot invalidate saved History scores")
        XCTAssertTrue(app.perform("historyDelete", ["id":"visible-score", "keepIntake":true]))
        XCTAssertNotEqual(app.historyScoreRevision, revision)
        XCTAssertEqual(app.project("historyScore", ["id":"visible-score"])["available"] as? Bool, false)
        let beforeForeground = app.historyScoreRevision
        app.refreshPresentation()
        XCTAssertNotEqual(app.historyScoreRevision, beforeForeground)
    }

    func testCompactDiaryRowsReopenExactSavedEvidenceAndCannotResurrectAfterDeletion() throws {
        let disk = NudgeDataStore(directory: directory)
        let photos = try disk.savePhotos([Data([1,2,3])])
        let entry: [String: Any] = ["id":"kept-intake", "name":"Synthetic meal", "day":NativeAppStore.day,
            "slot":"Lunch", "portions":1, "plants":["pea"], "ferments":[], "proteinPerPortion":23,
            "sourceMeta":["entryPhotos":photos, "confirmationId":"saved-confirmation"]]
        var initial = fixture(); initial["foodLog"] = ["entries":[entry], "savedRecipes":[], "plantGoal":30]
        _ = try seed(initial, store: disk)
        let before = try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json"))
        let app = NativeAppStore(store: disk)
        let row = try XCTUnwrap((app.project("today", ["presentation":true])["rows"] as? [[String: Any]])?.first)
        let summary = try XCTUnwrap(row["entry"] as? [String: Any])
        XCTAssertNil(summary["sourceMeta"])
        XCTAssertEqual(NativeTrackingDisplay.imageSource(row), photos.first)
        app.openEntry(summary)
        XCTAssertEqual(app.review["photos"] as? [String], photos)
        XCTAssertEqual((app.review["entry"] as? [String: Any])?["proteinPerPortion"] as? Int, 23)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json")), before)
        XCTAssertTrue(app.perform("diaryDelete", ["entryId":"kept-intake"]))
        app.dismissReview()
        app.openEntry(summary); app.openHistory(row)
        XCTAssertNotEqual(app.route, "review", "A stale rendered row must not recreate a deleted food")
        XCTAssertEqual(app.project("today")["entryCount"] as? Int, 0)
    }
    func testReanalysisPhotoReadCancellationAndMissingOriginalDoNotChangeSavedFood() async throws {
        let disk = NudgeDataStore(directory: directory)
        let photos = try disk.savePhotos([Data([1,2,3])])
        let entry: [String: Any] = ["id":"photo-intake", "name":"Synthetic photographed meal", "day":NativeAppStore.day,
            "slot":"Dinner", "portions":1, "plants":[], "ferments":[], "proteinPerPortion":20,
            "sourceMeta":["entryPhotos":photos, "confirmationId":"original-photo-confirmation"]]
        var initial = fixture(); initial["foodLog"] = ["entries":[entry], "savedRecipes":[], "plantGoal":30]
        _ = try seed(initial, store: disk)
        let app = NativeAppStore(store: disk)
        app.openEntry(entry)
        XCTAssertTrue(app.reviewHasPhotos)
        let original = try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json"))
        app.reanalyseReviewPhotos()
        app.navigate("search")
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertNil(app.capture.camera, "Leaving the draft must cancel its pending photo presentation")
        XCTAssertEqual(app.selectedTab, "search")
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json")), original)

        // A missing original must not silently submit the remaining subset.
        let filename = try XCTUnwrap(photos.first).replacingOccurrences(of: "nudge-photo:", with: "")
        try FileManager.default.removeItem(at: directory.appendingPathComponent("Photos").appendingPathComponent(filename))
        app.openEntry(entry)
        app.reanalyseReviewPhotos()
        try await settlePhoto { !app.loading }
        XCTAssertNotNil(app.analysisFailure)
        XCTAssertNil(app.capture.camera)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json")), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: disk.captureDirectory.path), "Reanalysis preparation must not submit or write a capture")
    }
    func testUnparseableStoreBlocksWritesAndPreservesBytes() throws {
        let file=directory.appendingPathComponent("wmd-nudge-prototype-v1.json"),bytes=Data("broken saved record".utf8)
        try bytes.write(to:file)
        let app=NativeAppStore(store:NudgeDataStore(directory:directory))
        XCTAssertFalse(app.ready)
        XCTAssertFalse(app.perform("settingsSave",["motionEnabled":false]))
        XCTAssertEqual(try Data(contentsOf:file),bytes)
    }
    func testConfirmedFoodUpdatesCarbsFatAndProteinExactlyOnceAndRestarts() throws {
        let disk=NudgeDataStore(directory:directory)
        _=try seed(fixture(),store:disk)
        let app=NativeAppStore(store:disk)
        let entry:[String:Any]=["name":"Synthetic whole dish","day":NativeAppStore.day,"slot":"Dinner","portions":1,"plants":["potato"],"ferments":[],"energyPerPortion":800,"proteinPerPortion":60,"fibrePerPortion":8,"nutritionSnapshot":["carbohydrate":["portion":100,"portionStatus":"calculated","unit":"g"],"fat":["portion":20,"portionStatus":"calculated","unit":"g"]]]
        XCTAssertTrue(app.perform("setReview",["kind":"entry","entry":entry,"confirmationId":"fixture-once"]))
        XCTAssertTrue(app.perform("reviewUpdate",["quantity":0.25]))
        XCTAssertTrue(app.perform("reviewConfirm"),app.errorMessage ?? "Confirmation failed")
        XCTAssertTrue(app.perform("reviewConfirm"))
        let entries=(app.state["foodLog"] as? [String:Any])?["entries"] as? [[String:Any]]
        XCTAssertEqual(entries?.count,1)
        let totals=app.project("today")
        XCTAssertEqual((totals["protein"] as? [String:Any])?["value"] as? Double,15)
        XCTAssertEqual((totals["carbs"] as? [String:Any])?["value"] as? Double,25)
        XCTAssertEqual((totals["fat"] as? [String:Any])?["value"] as? Double,5)
        let reopened=NativeAppStore(store:disk)
        XCTAssertEqual((reopened.project("today")["carbs"] as? [String:Any])?["value"] as? Double,25)
    }

    func testRecentFoodUsesDestinationWithoutMovingSourceAndEditCancelIsReadOnly() throws {
        let disk = NudgeDataStore(directory: directory)
        var initial = fixture()
        let entry: [String: Any] = ["id":"original", "name":"Synthetic lunch", "day":"2026-10-05", "slot":"Lunch",
            "portions":1, "plants":["chickpea"], "ferments":[], "energyPerPortion":400, "proteinPerPortion":20, "fibrePerPortion":8]
        initial["foodLog"] = ["entries":[entry], "savedRecipes":[], "plantGoal":30]
        _ = try seed(initial, store: disk)
        let now = ISO8601DateFormatter().date(from:"2026-10-11T12:00:00Z")!
        let app = NativeAppStore(store: disk, now: { now })
        XCTAssertEqual(app.loggingMeal, "")
        app.openDiary(day: "2026-10-09")
        app.showFoodLibrary(mode: "recents", day: "2026-10-09")
        app.openRecent(["entry":entry])
        let draft = try XCTUnwrap(app.project("reviewModel")["draft"] as? [String: Any])
        XCTAssertEqual(draft["day"] as? String, "2026-10-09")
        XCTAssertEqual(draft["slot"] as? String, "", "Logging a recent food uses no meal category")
        XCTAssertTrue(app.perform("reviewConfirm"), app.errorMessage ?? "Could not log recent")
        XCTAssertEqual(app.selectedTab, "today")
        XCTAssertEqual(app.route, "diary")
        XCTAssertEqual(app.diaryDay, "2026-10-09")
        let entries = try XCTUnwrap((app.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries.first { $0["id"] as? String == "original" }?["day"] as? String, "2026-10-05")
        XCTAssertEqual(entries.first { $0["id"] as? String == "original" }?["slot"] as? String, "Lunch")
        let added = try XCTUnwrap(entries.first { $0["id"] as? String != "original" })
        XCTAssertEqual(added["day"] as? String, "2026-10-09")
        XCTAssertEqual(added["slot"] as? String, "")
        XCTAssertEqual(app.project("today")["entryCount"] as? Int, 0)
        let file = directory.appendingPathComponent("wmd-nudge-prototype-v1.json"), before = try Data(contentsOf: file)
        app.openEntry(added)
        XCTAssertTrue(app.perform("reviewUpdate", ["day":"2026-10-04", "quantity":2]))
        app.dismissReview()
        XCTAssertEqual(app.route, "diary")
        XCTAssertEqual(try Data(contentsOf: file), before)
        let reopened = NativeAppStore(store: disk, now: { now })
        XCTAssertEqual((reopened.project("diary", ["day":"2026-10-09"])["entries"] as? [Any])?.count ??
                       (reopened.project("diary", ["day":"2026-10-09"])["rows"] as? [Any])?.count, 1)
        let original = try XCTUnwrap(entries.first { $0["id"] as? String == "original" })
        reopened.openEntry(original)
        XCTAssertEqual((reopened.project("reviewModel")["draft"] as? [String: Any])?["slot"] as? String, "Lunch")
        XCTAssertTrue(reopened.perform("reviewUpdate", ["quantity": 2]))
        XCTAssertTrue(reopened.perform("reviewConfirm"))
        let editedEntries = try XCTUnwrap((reopened.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])
        XCTAssertEqual(editedEntries.count, 2)
        XCTAssertEqual(editedEntries.first { $0["id"] as? String == "original" }?["slot"] as? String, "Lunch",
                       "Editing a saved amount must preserve its legacy data without exposing a meal selector")
    }

    private func photoResult(_ name: String) -> [String: Any] {
        ["extraction": ["type": "meal", "analysisId": "fixture-" + name,
            "meal": ["name": name, "components": []], "nutrients": [:]]]
    }

    private func photoRows(_ app: NativeAppStore) -> [[String: Any]] {
        app.project("history")["rows"] as? [[String: Any]] ?? []
    }

    private enum PhotoWaitError: Error { case timedOut }

    private func settlePhoto(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<600 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Synthetic background photo work did not settle", file: file, line: line)
        throw PhotoWaitError.timedOut
    }

    func testBackgroundPhotosCompleteOutOfOrderWithoutChangingNavigationReviewOrIntake() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let diaryFile = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let diaryBefore = try Data(contentsOf: diaryFile)
        let app = NativeAppStore(store: disk), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll(); app.cancelProductRecovery() }

        app.showFoodLibrary(mode: "recents", day: "2026-10-09", meal: "Dinner")
        let firstImages = [Data([1, 2]), Data([3, 4])]
        let firstCamera = SmartFoodCameraViewController(images: firstImages, revision: 6)
        coordinator.prepare(firstCamera)
        let firstID = coordinator.photoEventID
        coordinator.foodCamera(firstCamera, analyse: firstImages)
        try await settlePhoto { gate.pending[0] != nil }
        XCTAssertFalse(app.loading, "Background work must leave navigation available")
        XCTAssertEqual(app.analysingCount, 1)
        XCTAssertEqual(photoRows(app).first?["status"] as? String, "pending")
        app.navigate("search")
        XCTAssertEqual(app.selectedTab, "search")

        app.showFoodLibrary(mode: "recents", day: "2026-10-10", meal: "Lunch")
        let secondImages = [Data([5, 6])]
        let secondCamera = SmartFoodCameraViewController(images: secondImages, revision: 2)
        coordinator.prepare(secondCamera)
        let secondID = coordinator.photoEventID
        coordinator.foodCamera(secondCamera, analyse: secondImages)
        try await settlePhoto { gate.pending[1] != nil }
        XCTAssertNotEqual(firstID, secondID)
        XCTAssertEqual(app.analysingCount, 2)

        app.navigate("you")
        app.openEntry(["id":"unrelated-review", "name":"Unrelated review", "day":"2026-10-11", "slot":"Snack",
            "portions":1, "plants":[], "ferments":[], "energyPerPortion":80])
        let reviewBefore = try JSONSerialization.data(withJSONObject: app.review, options: [.sortedKeys])
        gate.resolve(1, .success(photoResult("Second meal")))
        try await settlePhoto { app.analysingCount == 1 }
        gate.resolve(0, .success(photoResult("First meal")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(app.selectedTab, "you")
        XCTAssertEqual(app.route, "review")
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: app.review, options: [.sortedKeys]), reviewBefore)
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore, "Analysis alone must never log food")

        let first = try XCTUnwrap(photoRows(app).first { $0["id"] as? String == firstID })
        let second = try XCTUnwrap(photoRows(app).first { $0["id"] as? String == secondID })
        XCTAssertEqual(first["status"] as? String, "ready"); XCTAssertEqual(second["status"] as? String, "ready")
        XCTAssertEqual(first["loggingDay"] as? String, "2026-10-09"); XCTAssertEqual(first["loggingMeal"] as? String, "Dinner")
        XCTAssertEqual(second["loggingDay"] as? String, "2026-10-10"); XCTAssertEqual(second["loggingMeal"] as? String, "Lunch")
        let references = try XCTUnwrap(first["photos"] as? [String])
        XCTAssertEqual(references.compactMap { disk.photoData(for: $0) }, firstImages)
        let restarted = NativeAppStore(store: disk)
        XCTAssertEqual(photoRows(restarted).count, 2)
        restarted.navigate("history")
        restarted.openHistory(try XCTUnwrap(photoRows(restarted).first { $0["id"] as? String == firstID }))
        let draft = try XCTUnwrap(restarted.project("reviewModel")["draft"] as? [String: Any])
        XCTAssertEqual(draft["day"] as? String, "2026-10-09")
        XCTAssertEqual(draft["slot"] as? String, "", "Logging a recent food uses no meal category")
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore)
    }

    func testSendDismissesCameraOnlyAfterDurableQueueAndKeepsAnalysisInHistory() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        var dismissals = 0
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" },
            dismissForNavigation: { _, completion in
                dismissals += 1
                XCTAssertEqual((app.history["events"] as? [[String: Any]])?.filter { $0["status"] as? String == "pending" }.count, 1)
                completion()
            })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let images = [Data([21, 22])]
        let camera = SmartFoodCameraViewController(images: images, revision: 4)
        coordinator.prepare(camera); let sentID = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: images)
        XCTAssertNil(coordinator.camera)
        XCTAssertEqual(dismissals, 1)
        XCTAssertEqual(app.analysisAcknowledgement, "Analysing… Track progress in History.")
        XCTAssertTrue(camera.capturedImages.isEmpty)
        XCTAssertNotEqual(coordinator.photoEventID, sentID)
        XCTAssertGreaterThan(camera.captureSetRevision, 4)
        XCTAssertFalse(app.loading)
        let original = try XCTUnwrap(coordinator.outbox.record(eventID: sentID, owner: "local-guest"))
        XCTAssertEqual(try coordinator.outbox.images(for: original), images)
        XCTAssertNotEqual(original.addToEaten, true, "Analyse must leave diary addition to its separate button")
        coordinator.foodCamera(camera, analyse: images)
        XCTAssertEqual(try coordinator.outbox.records(owner: "local-guest").count, 1, "A duplicate Send callback cannot submit the cleared batch again")
        try await settlePhoto { gate.pending[0] != nil }
        coordinator.complete(ifReviewEventID: sentID)
        XCTAssertNil(coordinator.camera, "Completion cannot reopen the dismissed camera")
        gate.resolve(0, .success(photoResult("Accepted batch")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertNil(coordinator.camera)
        XCTAssertEqual(dismissals, 1)
        XCTAssertTrue(camera.capturedImages.isEmpty)
        XCTAssertNil(app.route); XCTAssertTrue(app.review.isEmpty)
        coordinator.complete()
        let fresh = SmartFoodCameraViewController()
        coordinator.prepare(fresh)
        XCTAssertTrue(fresh.capturedImages.isEmpty, "A normal camera session does not restore submitted images")
    }

    func testFailedDraftStorageRetainsPhotoVoiceAndIdentityWithoutSubmitting() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let full = NativeCaptureOutbox(directory: directory.appendingPathComponent("full"), maximumBytes: 1)
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, outbox: full, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(images: [Data([1, 3, 5])], revision: 3, voiceMemo: voice)
        coordinator.prepare(camera); let id = coordinator.photoEventID, photoIDs = camera.capturedPhotoIDs
        coordinator.foodCamera(camera, analyse: camera.capturedImages)
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(camera.capturedImages, [Data([1, 3, 5])])
        XCTAssertEqual(camera.capturedVoiceMemo?.audioData, voice.audioData)
        XCTAssertEqual(camera.captureSetRevision, 3); XCTAssertEqual(camera.capturedPhotoIDs, photoIDs)
        XCTAssertEqual(coordinator.photoEventID, id); XCTAssertEqual(app.analysingCount, 0)
        XCTAssertTrue(gate.requests.isEmpty); XCTAssertTrue(try full.records(owner: "local-guest").isEmpty)
        XCTAssertNotNil(app.errorMessage)
        XCTAssertNil(app.analysisAcknowledgement, "Failed storage must not acknowledge a submitted analysis")
    }

    func testNormalCameraReopeningStartsEmptyPreservesDraftAndExplicitRetryRestoresIt() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(), ownerKey: { "local-guest" })
        defer { coordinator.complete() }
        app.showFoodLibrary(mode: "recents", day: "2026-10-09", meal: "Dinner")
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let images = [Data([7, 8, 9])]
        let original = SmartFoodCameraViewController(images: images, revision: 3, voiceMemo: voice)
        coordinator.prepare(original)
        let originalID = coordinator.photoEventID, photoIDs = original.capturedPhotoIDs
        coordinator.foodCamera(original, changedPhotoCount: 1)
        coordinator.foodCameraDidOpenHistory(original)
        app.showFoodLibrary(mode: "recents", day: "2026-10-10", meal: "Lunch")
        let fresh = try XCTUnwrap(coordinator.prepareFreshCamera())
        XCTAssertFalse(fresh === original)
        XCTAssertTrue(fresh.capturedImages.isEmpty); XCTAssertNil(fresh.capturedVoiceMemo)
        XCTAssertNotEqual(coordinator.photoEventID, originalID)
        XCTAssertEqual(coordinator.loggingDay, "2026-10-10"); XCTAssertEqual(coordinator.loggingMeal, "Lunch")
        let saved = try XCTUnwrap(coordinator.outbox.record(eventID: originalID, owner: "local-guest"))
        XCTAssertEqual(saved.status, .draft); XCTAssertEqual(saved.photoIDs, photoIDs)
        XCTAssertEqual(saved.loggingDay, "2026-10-09"); XCTAssertEqual(saved.loggingMeal, "Dinner")
        XCTAssertEqual(try coordinator.outbox.images(for: saved), images)
        XCTAssertEqual(try coordinator.outbox.voiceMemo(for: saved)?.audioData, voice.audioData)
        let history = try XCTUnwrap(photoRows(app).first { $0["id"] as? String == originalID })
        XCTAssertTrue(coordinator.retryHistory(history))
        let retry = try XCTUnwrap(coordinator.camera)
        XCTAssertEqual(retry.capturedImages, images); XCTAssertEqual(retry.capturedPhotoIDs, photoIDs)
        XCTAssertEqual(retry.capturedVoiceMemo?.audioData, voice.audioData)
        XCTAssertEqual(coordinator.photoEventID, originalID)
        XCTAssertEqual(coordinator.loggingDay, "2026-10-09"); XCTAssertEqual(coordinator.loggingMeal, "Dinner")
        coordinator.foodCameraDidCancel(retry)
        let afterClose = try XCTUnwrap(coordinator.prepareFreshCamera())
        XCTAssertTrue(afterClose.capturedImages.isEmpty); XCTAssertNil(afterClose.capturedVoiceMemo)
        XCTAssertEqual(try coordinator.outbox.images(for: saved), images)
        XCTAssertEqual(photoRows(app).count, 1, "Opening fresh does not invent an empty History draft")
    }

    func testFreshCameraRequestCannotDiscardAnUnpersistedDraftWhenStorageIsFull() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let full = NativeCaptureOutbox(directory: directory.appendingPathComponent("full"), maximumBytes: 1)
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(), outbox: full, ownerKey: { "local-guest" })
        defer { coordinator.complete() }
        let camera = SmartFoodCameraViewController(images: [Data([2, 4, 6])], revision: 8)
        coordinator.prepare(camera); let id = coordinator.photoEventID
        XCTAssertNil(coordinator.prepareFreshCamera())
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(camera.capturedImages, [Data([2, 4, 6])]); XCTAssertEqual(camera.captureSetRevision, 8)
        XCTAssertEqual(coordinator.photoEventID, id)
        XCTAssertTrue(try full.records(owner: "local-guest").isEmpty)
        XCTAssertNotNil(app.errorMessage)
    }

    func testMealRefinementQueuesHintsWithoutReplacingCameraDraftOrNavigation() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        app.showFoodLibrary(mode: "recents", day: "2026-10-09", meal: "Dinner")
        let camera = SmartFoodCameraViewController(images: [Data([99])], revision: 3)
        coordinator.prepare(camera); let draftID = coordinator.photoEventID, route = app.route
        let hints = NativeMealAnalysisHints(ingredients: ["Kefir", "Blueberries"], portion: .init(amount: 500, unit: "ml"))
        var queuedID: String?
        XCTAssertTrue(coordinator.enqueueMealRefinement(images: [Data([5, 7])], hints: hints, repair: ["entryId":"existing-meal"], onQueued: { id in
            queuedID = id
            XCTAssertNotNil(try? coordinator.outbox.record(eventID: id, owner: "local-guest"), "Progress only receives an identity after durable storage")
            XCTAssertTrue(gate.requests.isEmpty, "Publish queued identity before transport can complete")
        }))
        XCTAssertTrue(coordinator.camera === camera); XCTAssertEqual(camera.capturedImages, [Data([99])])
        XCTAssertEqual(coordinator.photoEventID, draftID); XCTAssertEqual(app.route, route)
        let record = try XCTUnwrap(coordinator.outbox.records(owner: "local-guest").first)
        XCTAssertEqual(queuedID, record.eventID)
        XCTAssertNotEqual(record.eventID, draftID); XCTAssertEqual(record.mealHints, hints)
        XCTAssertEqual(record.loggingDay, "2026-10-09"); XCTAssertEqual(record.loggingMeal, "Dinner")
        try await settlePhoto { gate.pending[0] != nil }
        gate.resolve(0, .success(photoResult("Refined smoothie")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(app.route, route); XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(camera.capturedImages, [Data([99])])
    }

    func testClosingUnpersistedVoiceOnlyDraftKeepsItsOriginalWhenStorageIsFull() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let full = NativeCaptureOutbox(directory: directory.appendingPathComponent("full"), maximumBytes: 1)
        let coordinator = NativeCaptureCoordinator(store: app, outbox: full, ownerKey: { "local-guest" })
        defer { coordinator.complete() }
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(voiceMemo: voice)
        coordinator.prepare(camera); let id = coordinator.photoEventID
        coordinator.foodCameraDidCancel(camera)
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(camera.capturedVoiceMemo?.audioData, voice.audioData)
        XCTAssertEqual(coordinator.photoEventID, id); XCTAssertNotNil(app.errorMessage)
        XCTAssertTrue(try full.records(owner: "local-guest").isEmpty)
    }

    func testReopenedMealReusesUnfinishedJobButChangedHintsAndCompletedJobsCreateNewAnalyses() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let hints = NativeMealAnalysisHints(ingredients: ["Kefir", "Blueberries"], portion: .init(amount: 500, unit: "ml"))
        var first = "", reopened = "", changed = "", afterCompletion = ""
        func enqueue(_ hints: NativeMealAnalysisHints, confirmation: String, callback: @escaping (String) -> Void) -> Bool {
            coordinator.enqueueMealRefinement(images: [Data([5, 7])], hints: hints,
                repair: ["entryId":"saved-smoothie", "confirmationId":confirmation], day: "2026-10-09", meal: "Dinner", onQueued: callback)
        }
        XCTAssertTrue(enqueue(hints, confirmation: "first-review") { first = $0 })
        try await settlePhoto { gate.pending[0] != nil }
        var reordered = hints; reordered.ingredients.reverse()
        XCTAssertTrue(enqueue(reordered, confirmation: "reopened-review") { reopened = $0 })
        XCTAssertEqual(first, reopened); XCTAssertEqual(try coordinator.outbox.records(owner: "local-guest").count, 1)
        XCTAssertEqual(gate.requests.count, 1, "Reopening the review must not start a duplicate paid request")
        var edited = hints; edited.ingredients.append("Walnuts")
        XCTAssertTrue(enqueue(edited, confirmation: "edited-review") { changed = $0 })
        XCTAssertNotEqual(changed, first)
        try await settlePhoto { gate.pending[1] != nil }
        gate.resolve(0, .success(photoResult("Original smoothie")))
        gate.resolve(1, .success(photoResult("Smoothie with walnuts")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(try coordinator.outbox.record(eventID: first, owner: "local-guest")?.status, .complete)
        XCTAssertTrue(enqueue(hints, confirmation: "later-review") { afterCompletion = $0 })
        XCTAssertNotEqual(afterCompletion, first); XCTAssertNotEqual(afterCompletion, changed)
        XCTAssertEqual(try coordinator.outbox.records(owner: "local-guest").count, 3)
        try await settlePhoto { gate.pending[2] != nil }
        gate.resolve(2, .success(photoResult("Fresh completed-source analysis")))
        try await settlePhoto { app.analysingCount == 0 }
    }

    func testUnfinishedRefinementIdentityUsesStableSourceOwnerHintsAndDestination() throws {
        let hints = NativeMealAnalysisHints(ingredients: ["Kefir", "Walnuts"], portion: .init(amount: 500, unit: "ml"))
        let firstPhoto = "nudge-photo:11111111-1111-4111-8111-111111111111.jpg"
        let secondPhoto = "nudge-photo:22222222-2222-4222-8222-222222222222.jpg"
        let sources: [[String: Any]] = [["entryId":"meal", "eventId":"scan"], ["eventId":"scan"], ["photos":[firstPhoto, secondPhoto]]]
        for source in sources {
            var firstReview = source; firstReview["confirmationId"] = "first"
            var reopened = source; reopened["confirmationId"] = "different"
            if reopened["photos"] != nil { reopened["photos"] = [secondPhoto, firstPhoto] }
            let identity = try XCTUnwrap(NativeCaptureCoordinator.mealRefinementSourceIdentity(reopened))
            var record = NativeCaptureRecord(eventID: "refinement", ownerKey: "local-guest")
            record.mealHints = hints; record.loggingDay = "2026-10-09"; record.loggingMeal = "Dinner"
            record.repairContext = try JSONSerialization.data(withJSONObject: firstReview)
            func matches(_ input: NativeCaptureRecord, owner: String = "local-guest", source: String? = nil,
                         candidate: NativeMealAnalysisHints? = nil, day: String = "2026-10-09", meal: String = "Dinner") throws -> Bool {
                try NativeCaptureCoordinator.matchesUnfinishedMealRefinement(input, owner: owner, source: source ?? identity,
                    hints: candidate ?? hints, day: day, meal: meal)
            }
            for status in [NativeCaptureStatus.queued, .processing, .retryableFailure, .needsUserInput] {
                record.status = status; XCTAssertTrue(try matches(record))
            }
            for status in [NativeCaptureStatus.draft, .complete, .deleted] {
                record.status = status; XCTAssertFalse(try matches(record))
            }
            record.status = .queued
            XCTAssertFalse(try matches(record, owner: "another-owner"))
            XCTAssertFalse(try matches(record, source: "eventId:another-food"))
            XCTAssertFalse(try matches(record, day: "2026-10-10"))
            XCTAssertFalse(try matches(record, meal: "Lunch"))
            var differentPortion = hints; differentPortion.portion?.amount = 250
            XCTAssertFalse(try matches(record, candidate: differentPortion))
            var differentIngredients = hints; differentIngredients.ingredients.append("Almonds")
            XCTAssertFalse(try matches(record, candidate: differentIngredients))
            record.repairContext = Data("broken".utf8)
            XCTAssertThrowsError(try matches(record))
        }
        XCTAssertNil(NativeCaptureCoordinator.mealRefinementSourceIdentity(["confirmationId":"volatile"]))
    }

    func testUnreadableOutboxBlocksRefinementWithoutQueuingAnotherJob() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, analysePhotos: gate.analyse,
            permissionAllowed: { true }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); gate.cancelAll() }
        let folder = app.captureOutbox.directory.appendingPathComponent("local-guest")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let corrupted = folder.appendingPathComponent(UUID().uuidString.lowercased() + ".json")
        let original = Data("unreadable-existing-job".utf8); try original.write(to: corrupted)
        let hints = NativeMealAnalysisHints(ingredients: ["Kefir"])
        var receivedCallback = false
        XCTAssertFalse(coordinator.enqueueMealRefinement(images: [Data([1])], hints: hints, repair: ["entryId":"meal"],
            onQueued: { _ in receivedCallback = true }))
        XCTAssertFalse(receivedCallback); XCTAssertTrue(gate.requests.isEmpty)
        XCTAssertEqual(try Data(contentsOf: corrupted), original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).count, 1)
        XCTAssertNotNil(app.analysisFailure)
    }

    func testBackgroundPhotoRetriesOneTransientFailureWithSameEvidenceAndSingleHistoryEvent() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let images = [Data([7, 8])]
        let camera = SmartFoodCameraViewController(images: images, revision: 3)
        coordinator.prepare(camera)
        let id = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: images)
        try await settlePhoto { gate.pending[0] != nil }
        gate.resolve(0, .failure(URLError(.timedOut)))
        try await settlePhoto { app.analysingCount == 0 }
        let deferred = try XCTUnwrap(coordinator.outbox.records(owner: "local-guest").first)
        XCTAssertEqual(deferred.status, .retryableFailure)
        XCTAssertGreaterThan(try XCTUnwrap(deferred.nextAttemptAt), deferred.updatedAt)
        XCTAssertTrue(coordinator.retryHistory(try XCTUnwrap(photoRows(app).first)))
        try await settlePhoto { gate.pending[1] != nil }
        XCTAssertEqual(gate.requests.count, 2)
        XCTAssertEqual(gate.requests[0].images, gate.requests[1].images)
        XCTAssertEqual(gate.requests[0].photoIDs, gate.requests[1].photoIDs)
        XCTAssertEqual(gate.requests[0].revision, gate.requests[1].revision)
        XCTAssertEqual(gate.requests[0].diagnosticID, gate.requests[1].diagnosticID)
        gate.resolve(1, .success(photoResult("Retried meal")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(photoRows(app).count, 1)
        XCTAssertEqual(photoRows(app).first?["id"] as? String, id)
        XCTAssertEqual(photoRows(app).first?["status"] as? String, "ready")
        XCTAssertNil(app.route); XCTAssertTrue(app.review.isEmpty); XCTAssertNil(app.errorMessage)
    }

    func testBackgroundPhotoPersistsBackoffAndRetainsPhotosForManualRetry() async throws {
        let disk = NudgeDataStore(directory: directory)
        let app = NativeAppStore(store: disk), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let camera = SmartFoodCameraViewController(images: [Data([9])])
        coordinator.prepare(camera); coordinator.foodCamera(camera, analyse: camera.capturedImages)
        try await settlePhoto { gate.pending[0] != nil }
        gate.resolve(0, .failure(URLError(.timedOut)))
        try await settlePhoto { app.analysingCount == 0 }
        let deferred = try XCTUnwrap(coordinator.outbox.records(owner: "local-guest").first)
        XCTAssertEqual(deferred.status, .retryableFailure)
        XCTAssertGreaterThan(try XCTUnwrap(deferred.nextAttemptAt), deferred.updatedAt)
        XCTAssertTrue(coordinator.retryHistory(try XCTUnwrap(photoRows(app).first)))
        try await settlePhoto { gate.pending[1] != nil }
        gate.resolve(1, .failure(URLError(.timedOut)))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(gate.requests.count, 2)
        let row = try XCTUnwrap(photoRows(app).first)
        XCTAssertEqual(row["status"] as? String, "failed")
        XCTAssertEqual(row["errorCode"] as? String, "analysis_timeout")
        XCTAssertEqual((row["photos"] as? [String] ?? []).compactMap { disk.photoData(for: $0) }, [Data([9])])
        XCTAssertNil(app.analysisFailure, "A background failure must not interrupt another screen with an alert")
    }

    func testBackgroundPhotoRejectsLateResponsesAndRetryAfterPermissionOrAccountChanges() async throws {
        for revokePermission in [true, false] {
            for failLate in [true, false] {
                let folder = directory.appendingPathComponent("\(revokePermission)-\(failLate)")
                let app = NativeAppStore(store: NudgeDataStore(directory: folder)), gate = NativePhotoAnalysisGate()
                var allowed = true, account = 7
                let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
                    analysePhotos: gate.analyse, permissionAllowed: { allowed }, accountRevision: { account }, ownerKey: { "local-guest" })
                defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
                let camera = SmartFoodCameraViewController(images: [Data([10])])
                coordinator.prepare(camera); coordinator.foodCamera(camera, analyse: camera.capturedImages)
                try await settlePhoto { gate.pending[0] != nil }
                if revokePermission { allowed = false } else { account += 1 }
                gate.resolve(0, failLate ? .failure(URLError(.timedOut)) : .success(photoResult("Obsolete meal")))
                try await settlePhoto { app.analysingCount == 0 }
                XCTAssertEqual(gate.requests.count, 1, "Revocation must prevent the automatic retry")
                XCTAssertEqual(photoRows(app).first?["status"] as? String, "failed", "Revocation must not leave a scan pending forever")
                XCTAssertEqual(photoRows(app).first?["errorCode"] as? String, "analysis_interrupted")
                XCTAssertNil(photoRows(app).first?["extraction"] as? [String: Any])
                XCTAssertTrue(app.review.isEmpty); XCTAssertNil(app.errorMessage)
            }
        }
    }

    func testDeletingPendingPhotoPreventsLateResultOrFailureFromRestoringIt() async throws {
        for failLate in [true, false] {
            let app = NativeAppStore(store: NudgeDataStore(directory: directory.appendingPathComponent("delete-\(failLate)")))
            let gate = NativePhotoAnalysisGate()
            let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
                analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
            defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
            let camera = SmartFoodCameraViewController(images: [Data([11])])
            coordinator.prepare(camera); let id = coordinator.photoEventID
            coordinator.foodCamera(camera, analyse: camera.capturedImages)
            try await settlePhoto { gate.pending[0] != nil }
            XCTAssertTrue(app.perform("historyDelete", ["id":id, "keepIntake":true]))
            XCTAssertTrue(app.perform("historyDismissUndo"))
            gate.resolve(0, failLate ? .failure(URLError(.timedOut)) : .success(photoResult("Deleted meal")))
            try await settlePhoto { app.analysingCount == 0 }
            XCTAssertTrue(photoRows(app).isEmpty)
            XCTAssertEqual(gate.requests.count, 1)
            XCTAssertTrue(app.review.isEmpty); XCTAssertNil(app.errorMessage)
        }
    }

    func testUndoOfDeletedPendingPhotoCannotAcceptRevokedUploadSuccessOrFailure() async throws {
        for failLate in [true, false] {
            for undoBeforeResponse in [true, false] {
                let app = NativeAppStore(store: NudgeDataStore(directory: directory.appendingPathComponent("undo-\(failLate)-\(undoBeforeResponse)")))
                let gate = NativePhotoAnalysisGate()
                let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
                    analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
                defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
                let camera = SmartFoodCameraViewController(images: [Data([17])])
                coordinator.prepare(camera); let id = coordinator.photoEventID
                coordinator.foodCamera(camera, analyse: camera.capturedImages)
                try await settlePhoto { gate.pending[0] != nil }
                let original = try XCTUnwrap(photoRows(app).first)
                XCTAssertTrue(app.perform("historyDelete", ["id": id, "keepIntake": true]))
                if undoBeforeResponse { XCTAssertTrue(app.perform("historyUndo")) }
                gate.resolve(0, failLate ? .failure(URLError(.timedOut)) : .success(photoResult("Revoked upload")))
                try await settlePhoto { app.analysingCount == 0 }
                if !undoBeforeResponse { XCTAssertTrue(app.perform("historyUndo")) }
                let restored = try XCTUnwrap(photoRows(app).first)
                XCTAssertEqual(restored["id"] as? String, id)
                XCTAssertEqual(restored["status"] as? String, "failed")
                XCTAssertEqual(restored["errorCode"] as? String, "analysis_interrupted")
                XCTAssertEqual(restored["createdAt"] as? String, original["createdAt"] as? String)
                XCTAssertEqual(restored["photos"] as? [String], original["photos"] as? [String])
                XCTAssertNil(restored["extraction"] as? [String: Any])
                XCTAssertEqual(gate.requests.count, 1, "An undone deletion must never retry the revoked upload")
                XCTAssertTrue(app.review.isEmpty); XCTAssertNil(app.errorMessage)
                XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
            }
        }
    }

    func testLateCancelledPhotoCannotFinishANewRetryWithSameHistoryIdentity() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let camera = SmartFoodCameraViewController(images: [Data([12])])
        coordinator.prepare(camera); let id = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: camera.capturedImages)
        try await settlePhoto { gate.pending[0] != nil }
        coordinator.cancelAllPhotoAnalyses()
        XCTAssertEqual(app.analysingCount, 0)
        let retryCamera = SmartFoodCameraViewController(images: [Data([13])])
        coordinator.prepareRetry(retryCamera, eventID: id)
        coordinator.foodCamera(retryCamera, analyse: retryCamera.capturedImages)
        try await settlePhoto { gate.pending[1] != nil }
        XCTAssertEqual(app.analysingCount, 1)
        gate.resolve(0, .success(photoResult("Cancelled old response")))
        try await settlePhoto { gate.completed.contains(0) }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(app.analysingCount, 1, "An obsolete defer must not end the newer retry")
        XCTAssertEqual(photoRows(app).first?["status"] as? String, "pending")
        gate.resolve(1, .success(photoResult("Current retry")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(photoRows(app).count, 1)
        XCTAssertEqual(photoRows(app).first?["name"] as? String, "Current retry")
        XCTAssertEqual(photoRows(app).first?["status"] as? String, "ready")
    }

    func testExplicitPhotoRetryRestoresSentBatchVoiceAndCaptureIDs() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let memo = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(images: [Data([14])], revision: 8, voiceMemo: memo)
        coordinator.prepare(camera); let id = coordinator.photoEventID, photoIDs = camera.capturedPhotoIDs
        coordinator.foodCamera(camera, analyse: camera.capturedImages)
        try await settlePhoto { gate.pending[0] != nil }
        gate.resolve(0, .failure(NutritionLabelService.ServiceError.invalidResponse))
        try await settlePhoto { app.analysingCount == 0 }
        coordinator.retryPhotos([Data([14])], eventID: id)
        let restored = try XCTUnwrap(coordinator.camera)
        XCTAssertFalse(restored === camera, "Sent batches are restored explicitly from the outbox")
        XCTAssertTrue(camera.capturedImages.isEmpty)
        XCTAssertNil(camera.capturedVoiceMemo)
        XCTAssertEqual(restored.capturedImages, [Data([14])])
        XCTAssertEqual(restored.capturedPhotoIDs, photoIDs)
        XCTAssertEqual(restored.captureSetRevision, 8)
        XCTAssertEqual(restored.capturedVoiceMemo?.audioData, memo.audioData)
        XCTAssertEqual(coordinator.photoEventID, id)
    }
    private func preparedCatalogueProduct(status: String = "rated", expires: Date? = nil,
                                          completeClientFacts: Bool = false, scoreValue: Int = 100,
                                          barcode: String = "1234000199991", name: String = "Fixture prepared product",
                                          scoreExtras: [String: Any] = [:]) throws -> BarcodeProduct {
        let date = Date(), expiry = expires ?? date.addingTimeInterval(3600)
        // Deliberately incomplete client facts exercise the prepared-score
        // bridge instead of passing through a coincidentally equal local score.
        let nutrients: [String: Any] = completeClientFacts ? ["energy-kcal_100g": 100, "proteins_100g": 7,
            "saturated-fat_100g": 0.1, "sugars_100g": 1, "salt_100g": 0.1, "fiber_100g": 3] : ["proteins_100g": 7]
        let fields: [String: Any] = ["code": barcode, "product_name": name,
            "categories_tags": completeClientFacts ? ["en:legumes"] : ["en:foods"], "nutrition_data_per": "100g", "nutriments": nutrients]
        var product = try OpenFoodFactsParser.parse(data: JSONSerialization.data(withJSONObject: ["product": fields]),
            barcode: barcode, retrievedAt: date.addingTimeInterval(-100))
        let probe = NativeAppStore(store: NudgeDataStore(directory: directory.appendingPathComponent("score-fixture")))
        let active = try XCTUnwrap(probe.scannedProductModel(["name": "Chickpeas", "nutrients": [:]])["score"] as? [String: Any])
        let method = try XCTUnwrap(active["methodId"] as? String), version = try XCTUnwrap(active["version"] as? String)
        let classifier = try XCTUnwrap(active["classifierVersion"] as? String)
        let result: [String: Any] = (["methodId": method, "methodVersion": version, "version": version,
            "classifierVersion": classifier, "status": status, "available": true,
            "value": scoreValue, "rawScore": scoreValue == 100 ? -1 : 30, "category": "general",
            "grade": scoreValue == 100 ? "A" : "E", "baseFrequency": NSNull(), "finalFrequency": NSNull()] as [String: Any])
            .merging(scoreExtras, uniquingKeysWith: { _, added in added })
        product.catalogueSourceExpiresAt = expiry
        product.catalogueRating = ProductCatalogueRating(method: method, version: version,
            classifierVersion: classifier, sourceRevision: nil, fetchedAt: date.addingTimeInterval(-100),
            expiresAt: expiry, calculatedAt: date.addingTimeInterval(-10),
            snapshotFingerprint: try XCTUnwrap(ProductCatalogueRating.fingerprint(product)),
            scoreData: try JSONSerialization.data(withJSONObject: result))
        return product
    }

    private func offlineScanContext() -> NativeProductContextModel {
        NativeProductContextModel(rules: NativeProductContextRules(),
            fetchRecall: { ["status": "available", "checkedAt": "2026-10-08T12:00:00Z", "notices": []] },
            fetchAlternatives: { _, _, _, _ in [] })
    }

    private func settleScan(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Synthetic camera work did not settle", file: file, line: line)
        throw PhotoWaitError.timedOut
    }

    func testCompactScansStayInCameraAndExplicitOpenReusesTheRecordedEvent() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let diaryFile = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let diaryBefore = try Data(contentsOf: diaryFile)
        let app = NativeAppStore(store: disk)
        app.navigate("history")
        let first = try preparedCatalogueProduct(name: "Synthetic first product")
        let second = try preparedCatalogueProduct(barcode: "1234000199992", name: "Synthetic second product")
        var requested: [String] = []
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in
            requested.append(barcode)
            return barcode == first.barcode ? first : second
        }, productContext: offlineScanContext(), accountRevision: { 7 }, ownerKey: { "local-guest" })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.foodCameraDidCancel(camera); app.cancelProductRecovery() }

        coordinator.foodCamera(camera, found: first.barcode)
        try await settleScan { coordinator.scanSummary?.name == first.name }
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(coordinator.scanSummary?.status, .ready)
        XCTAssertEqual(coordinator.scanSummary?.nutritionScore, 100)
        XCTAssertEqual(coordinator.scanSummary?.compact, true)
        XCTAssertEqual(app.selectedTab, "history")
        XCTAssertNil(app.route)
        XCTAssertTrue(app.review.isEmpty)
        XCTAssertFalse(app.loading)
        let firstRows = try XCTUnwrap(app.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(firstRows.count, 1)
        let firstID = try XCTUnwrap(firstRows.first?["id"] as? String)

        // Continuous recognition sends the next barcode on the same camera;
        // there is no intermediate dismissal or explicit next-screen action.
        coordinator.foodCamera(camera, found: second.barcode)
        try await settleScan { coordinator.scanSummary?.name == second.name }
        XCTAssertTrue(coordinator.camera === camera)
        XCTAssertEqual(app.selectedTab, "history")
        XCTAssertNil(app.route)
        XCTAssertTrue(app.review.isEmpty)
        XCTAssertEqual(requested, [first.barcode, second.barcode])
        let rows = try XCTUnwrap(app.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.compactMap { $0["id"] as? String }).count, 2)
        let secondRow = try XCTUnwrap(rows.first { ($0["product"] as? [String: Any])?["barcode"] as? String == second.barcode })
        let secondID = try XCTUnwrap(secondRow["id"] as? String)
        XCTAssertNotEqual(firstID, secondID)
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore)
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)

        coordinator.foodCamera(camera, summaryAction: "expand", alternativeID: nil)
        XCTAssertTrue(coordinator.camera === camera, "Opening a product preserves the capture draft")
        XCTAssertEqual(app.route, "review")
        XCTAssertEqual(app.review["eventId"] as? String, secondID)
        XCTAssertEqual((app.review["product"] as? [String: Any])?["barcode"] as? String, second.barcode)
        XCTAssertEqual((app.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, 100)
        XCTAssertEqual((app.project("history")["rows"] as? [Any])?.count, 2, "Opening a scan is not another scan")
        XCTAssertEqual(requested.count, 2, "Opening the prepared result must not fetch it again")
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore)
        let restarted = NativeAppStore(store: disk)
        XCTAssertEqual((restarted.project("history")["rows"] as? [Any])?.count, 2)
        XCTAssertEqual(((restarted.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }

    func testCameraNavigationWaitsForDismissalAndRejectsAReplacedCamera() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk), product = try preparedCatalogueProduct()
        app.navigate("today")
        var dismissals: [() -> Void] = []
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { _, _ in product },
            productContext: offlineScanContext(), ownerKey: { "local-guest" },
            dismissForNavigation: { _, completion in dismissals.append(completion) })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.complete(); app.cancelProductRecovery() }
        coordinator.foodCamera(camera, found: product.barcode)
        try await settleScan { coordinator.scanSummary?.status == .ready }
        let historyBefore = try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys])
        let diaryFile = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let diaryBefore = try Data(contentsOf: diaryFile)

        coordinator.foodCamera(camera, summaryAction: "expand", alternativeID: nil)
        coordinator.foodCamera(camera, summaryAction: "expand", alternativeID: nil)
        coordinator.foodCameraDidOpenHistory(camera)
        coordinator.foodCamera(camera, summaryAction: "next", alternativeID: nil)
        coordinator.foodCamera(camera, found: "1234000199992")
        XCTAssertEqual(dismissals.count, 1)
        XCTAssertEqual(coordinator.scanSummary?.name, product.name, "A queued barcode cannot replace the result while it opens")
        XCTAssertNil(app.route, "A new sheet must wait until UIKit finishes closing the camera")
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys]), historyBefore)
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore, "A swipe and tap only open the prepared result")
        dismissals.removeFirst()()
        XCTAssertTrue(app.reviewPresented)
        XCTAssertTrue(coordinator.camera === camera, "Navigation retains the existing capture draft")
        app.dismissReview()

        coordinator.foodCameraDidOpenHistory(camera)
        XCTAssertEqual(app.selectedTab, "today")
        XCTAssertEqual(dismissals.count, 1)
        dismissals.removeFirst()()
        XCTAssertEqual(app.selectedTab, "history")

        coordinator.foodCamera(camera, openFoodLibrary: "favourites")
        XCTAssertNil(app.route)
        XCTAssertEqual(dismissals.count, 1)
        dismissals.removeFirst()()
        XCTAssertEqual(app.route, "foodLibrary")
        XCTAssertEqual(app.foodLibraryMode, "favourites")

        coordinator.foodCamera(camera, summaryAction: "expand", alternativeID: nil)
        XCTAssertEqual(dismissals.count, 1)
        let staleDismissal = dismissals.removeFirst()
        let replacement = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(replacement)
        coordinator.foodCameraDidOpenHistory(replacement)
        XCTAssertEqual(dismissals.count, 1, "A replacement camera has its own navigation lifetime")
        staleDismissal()
        XCTAssertEqual(app.route, "foodLibrary", "A delayed old camera completion cannot reopen review")
        XCTAssertTrue(coordinator.camera === replacement)
        coordinator.foodCameraDidOpenHistory(replacement)
        XCTAssertEqual(dismissals.count, 1, "The old completion cannot unlock the replacement camera's pending navigation")
        dismissals.removeFirst()()
        XCTAssertEqual(app.selectedTab, "history")
        XCTAssertNil(app.route)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys]), historyBefore)
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore)
    }

    func testContinuousScansKeepEveryLookupAndOnlyNewestCardWhenResultsArriveOutOfOrder() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativeScanLookupGate()
        let first = try preparedCatalogueProduct(name: "First pending product")
        let second = try preparedCatalogueProduct(barcode: "1234000199992", name: "Newest product")
        let third = try preparedCatalogueProduct(barcode: "1234000199993", name: "Third queued product")
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) },
            productContext: offlineScanContext(), accountRevision: { 7 }, ownerKey: { "local-guest" })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll(); app.cancelProductRecovery() }
        coordinator.foodCamera(camera, found: first.barcode)
        coordinator.foodCamera(camera, found: second.barcode)
        try await settleScan { gate.pending.count == 2 }
        gate.resolve(second.barcode, .success(second))
        try await settleScan { coordinator.scanSummary?.name == second.name }
        gate.resolve(first.barcode, .success(first))
        try await settleScan { app.analysingCount == 0 }
        XCTAssertEqual(coordinator.scanSummary?.name, second.name)
        let rows = try XCTUnwrap(app.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2); XCTAssertTrue(rows.allSatisfy { $0["status"] as? String == "ready" })
        coordinator.foodCamera(camera, found: third.barcode)
        try await settleScan { gate.pending[third.barcode] != nil }
        coordinator.foodCameraDidOpenHistory(camera)
        gate.resolve(third.barcode, .success(third))
        try await settleScan { app.analysingCount == 0 }
        XCTAssertEqual(app.selectedTab, "history"); XCTAssertNil(app.route); XCTAssertTrue(app.review.isEmpty)
        XCTAssertEqual((app.project("history")["rows"] as? [[String: Any]])?.count, 3)
    }

    func testQueuedThirdBarcodeSurvivesBusyWorkersAndAccountChangeCannotDeliverOldScans() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativeScanLookupGate()
        var owner = "local-guest", account = 7
        let first = try preparedCatalogueProduct(name: "First pending product")
        let second = try preparedCatalogueProduct(barcode: "1234000199992", name: "Second pending product")
        let third = try preparedCatalogueProduct(barcode: "1234000199993", name: "Third queued product")
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) },
            productContext: offlineScanContext(), accountRevision: { account }, ownerKey: { owner })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll(); app.cancelProductRecovery() }
        coordinator.foodCamera(camera, found: first.barcode)
        coordinator.foodCamera(camera, found: second.barcode)
        coordinator.foodCamera(camera, found: third.barcode)
        try await settleScan { gate.pending.count == 2 }
        XCTAssertEqual(try coordinator.outbox.records(owner: owner).count, 3, "A busy worker pool must not drop a recognized barcode")
        gate.resolve(first.barcode, .success(first))
        try await settleScan { gate.pending[third.barcode] != nil }
        gate.resolve(third.barcode, .success(third))
        try await settleScan { coordinator.scanSummary?.name == third.name }
        let summary = coordinator.scanSummary?.name
        owner = String(repeating: "b", count: 64); account += 1
        gate.resolve(second.barcode, .success(second))
        try await settleScan { app.analysingCount == 0 }
        XCTAssertEqual(coordinator.scanSummary?.name, summary)
        let rows = try XCTUnwrap(app.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.filter { $0["status"] as? String == "ready" }.count, 2)
        XCTAssertFalse(rows.contains { ($0["product"] as? [String: Any])?["name"] as? String == second.name })
        XCTAssertTrue(try coordinator.outbox.records(owner: owner).isEmpty)
        XCTAssertNil(app.route); XCTAssertTrue(app.review.isEmpty)
    }

    func testCompactScannerIgnoresSuccessAndFailureFromAReplacedCamera() async throws {
        for failOld in [false, true] {
            let folder = directory.appendingPathComponent(failOld ? "late-failure" : "late-success")
            let disk = NudgeDataStore(directory: folder)
            _ = try seed(fixture(), store: disk)
            let app = NativeAppStore(store: disk), gate = NativeScanLookupGate()
            let first = try preparedCatalogueProduct(name: "Synthetic old camera product")
            let second = try preparedCatalogueProduct(barcode: "1234000199992", name: "Synthetic current camera product")
            let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) },
                productContext: offlineScanContext(), accountRevision: { 7 }, ownerKey: { "local-guest" })
            let oldCamera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
            let currentCamera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
            defer { coordinator.foodCameraDidCancel(currentCamera); gate.cancelAll(); app.cancelProductRecovery() }
            coordinator.prepare(oldCamera)
            coordinator.foodCamera(oldCamera, found: first.barcode)
            try await settleScan { gate.pending[first.barcode] != nil }
            coordinator.prepare(currentCamera)
            coordinator.foodCamera(currentCamera, found: second.barcode)
            try await settleScan { gate.pending[second.barcode] != nil }
            gate.resolve(second.barcode, .success(second))
            try await settleScan { coordinator.scanSummary?.name == second.name }
            let currentBefore = try JSONSerialization.data(withJSONObject: (app.project("history")["rows"] as? [[String: Any]] ?? []).filter { ($0["product"] as? [String: Any])?["barcode"] as? String == second.barcode }, options: [.sortedKeys])
            gate.resolve(first.barcode, failOld ? .failure(BarcodeLookupError.notFound) : .success(first))
            try await settleScan { gate.completed.count == 2 }
            for _ in 0..<20 { await Task.yield() }
            // A delegate delivery from the old controller is stale too.
            coordinator.foodCamera(oldCamera, found: first.barcode)
            XCTAssertEqual(gate.requested, [first.barcode, second.barcode])
            XCTAssertTrue(coordinator.camera === currentCamera)
            XCTAssertEqual(coordinator.scanSummary?.name, second.name)
            XCTAssertEqual(coordinator.scanSummary?.status, .ready)
            XCTAssertNil(app.missingProductBarcode)
            XCTAssertNil(app.route)
            XCTAssertTrue(app.review.isEmpty)
            XCTAssertEqual(try JSONSerialization.data(withJSONObject: (app.project("history")["rows"] as? [[String: Any]] ?? []).filter { ($0["product"] as? [String: Any])?["barcode"] as? String == second.barcode }, options: [.sortedKeys]), currentBefore)
            XCTAssertEqual((app.project("history")["rows"] as? [Any])?.count, 2)
            XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        }
    }

    func testClosingCompactCameraLetsSavedLookupFinishQuietlyInHistory() async throws {
        for failLate in [false, true] {
            let folder = directory.appendingPathComponent(failLate ? "cancel-failure" : "cancel-success")
            let disk = NudgeDataStore(directory: folder)
            _ = try seed(fixture(), store: disk)
            let file = folder.appendingPathComponent("wmd-nudge-prototype-v1.json"), before = try Data(contentsOf: file)
            let app = NativeAppStore(store: disk), gate = NativeScanLookupGate()
            let product = try preparedCatalogueProduct()
            let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) },
                productContext: offlineScanContext(), accountRevision: { 7 }, ownerKey: { "local-guest" })
            let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
            defer { coordinator.foodCameraDidCancel(camera); gate.cancelAll(); app.cancelProductRecovery() }
            coordinator.prepare(camera)
            coordinator.foodCamera(camera, found: product.barcode)
            try await settleScan { gate.pending[product.barcode] != nil }
            coordinator.foodCameraDidCancel(camera)
            gate.resolve(product.barcode, failLate ? .failure(BarcodeLookupError.notFound) : .success(product))
            try await settleScan { gate.completed.count == 1 }
            for _ in 0..<20 { await Task.yield() }
            XCTAssertNil(coordinator.camera)
            XCTAssertNil(coordinator.scanSummary)
            XCTAssertNil(app.route)
            XCTAssertNil(app.missingProductBarcode)
            XCTAssertTrue(app.review.isEmpty)
            XCTAssertFalse(app.loading)
            XCTAssertEqual((app.project("history")["rows"] as? [[String: Any]])?.first?["status"] as? String, failLate ? "unknown" : "ready")
            let restarted = NativeAppStore(store: disk)
            XCTAssertEqual((restarted.project("history")["rows"] as? [[String: Any]])?.first?["status"] as? String, failLate ? "unknown" : "ready")
            XCTAssertEqual(try Data(contentsOf: file), before)
        }
    }

    func testFreshCatalogueCardOpensImmediatelyWithoutRepeatingLookupOrLoggingIntake() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        var lookups = 0
        let app = NativeAppStore(store: disk, lookupProduct: { _ in
            lookups += 1
            throw URLError(.timedOut)
        })
        defer { app.cancelProductRecovery(); app.cancelLoading() }
        let product = try preparedCatalogueProduct()
        let beforeDiary = try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json"))
        app.openProduct(product)
        XCTAssertEqual(app.route, "review", "A full catalogue record must open before any asynchronous lookup")
        XCTAssertFalse(app.loading)
        XCTAssertEqual((app.review["product"] as? [String: Any])?["barcode"] as? String, product.barcode)
        XCTAssertEqual((app.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, 100)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(lookups, 0)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json")), beforeDiary)
    }

    func testFreshCatalogueOpenInvalidatesAnOlderHydrationAndExpiredSourceStillRefreshes() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let gate = NativeScanLookupGate()
        let app = NativeAppStore(store: disk, lookupProduct: { try await gate.wait($0) })
        defer { gate.cancelAll(); app.cancelProductRecovery(); app.cancelLoading() }
        let expired = try preparedCatalogueProduct(expires: Date().addingTimeInterval(-60), name: "Expired source")
        let fresh = try preparedCatalogueProduct(barcode: "1234000199992", name: "Current source")
        app.openProduct(expired)
        try await settleScan { gate.pending[expired.barcode] != nil }
        XCTAssertTrue(app.loading, "Expired source still receives a current lookup")
        app.openProduct(fresh)
        XCTAssertEqual(app.route, "review"); XCTAssertFalse(app.loading)
        XCTAssertEqual((app.review["product"] as? [String: Any])?["barcode"] as? String, fresh.barcode)
        let history = try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys])
        gate.resolve(expired.barcode, .success(expired))
        try await settleScan { gate.completed.contains(expired.barcode) }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual((app.review["product"] as? [String: Any])?["barcode"] as? String, fresh.barcode)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys]), history)
        XCTAssertEqual(gate.requested, [expired.barcode])
    }

    func testReceivedDetailedCatalogueScoreSurvivesReviewHistoryAndRestartWithoutLoggingIntake() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        defer { app.cancelProductRecovery() }
        let product = try preparedCatalogueProduct()
        let cardRating = app.ratings.rating(for: product)
        XCTAssertEqual(cardRating.value, 100)
        app.receiveProduct(product, eventID: "catalogue-bridge-fixture", origin: "search")
        app.cancelProductRecovery()
        let shown = try XCTUnwrap(app.review["product"] as? [String: Any])
        let bound = try XCTUnwrap(shown["scoreResult"] as? [String: Any])
        XCTAssertFalse((bound["inputFingerprint"] as? String ?? "").isEmpty)
        XCTAssertEqual((bound["result"] as? [String: Any])?["value"] as? Int, 100)
        XCTAssertEqual((app.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, cardRating.value)
        XCTAssertNil(((shown["nutrients"] as? [String: Any])?["fibre"] as? [String: Any])?["value"] as? Double,
                     "A prepared score cannot invent missing label nutrients")
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        let history = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        let stored = try XCTUnwrap((history["product"] as? [String: Any])?["scoreResult"] as? [String: Any])
        XCTAssertEqual((stored["result"] as? [String: Any])?["value"] as? Int, 100)
        let reopened = NativeAppStore(store: disk)
        defer { reopened.cancelProductRecovery() }
        let restored = try XCTUnwrap((reopened.project("history")["rows"] as? [[String: Any]])?.first)
        reopened.openHistory(restored)
        reopened.cancelProductRecovery()
        XCTAssertEqual((reopened.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, 100)
        XCTAssertEqual(((reopened.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }

    func testReadOnlyCatalogueScoreProjectionDoesNotWriteDiaryOrHistoryAndPreservesEstimatedResult() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        let product = try preparedCatalogueProduct()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(product)) as? [String: Any])
        let score = try XCTUnwrap(app.ratings.validatedDetailedCatalogueScore(for: product))
        let before = try Dictionary(uniqueKeysWithValues: FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: nil).map { ($0.lastPathComponent, try Data(contentsOf: $0)) })
        let expires = try XCTUnwrap(product.catalogueRating?.expiresAt.timeIntervalSince1970) * 1000
        XCTAssertNotNil(app.project("productWithCatalogueScore", ["product": object, "score": score, "expiresAt": expires])["product"])
        var estimated = score; estimated["status"] = "estimated"; estimated["estimated"] = true
        XCTAssertNotNil(app.project("productWithCatalogueScore", ["product": object, "score": estimated, "expiresAt": expires])["product"])
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), Set(before.keys))
        for file in files { XCTAssertEqual(try Data(contentsOf: file), before[file.lastPathComponent]) }
        XCTAssertTrue((app.project("history")["rows"] as? [Any] ?? []).isEmpty)
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }

    func testPreparedCatalogueScoreMatchesCardWhenLocalFactsWouldGiveDifferentProvisionalScore() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        defer { app.cancelProductRecovery() }
        let product = try preparedCatalogueProduct(completeClientFacts: true, scoreValue: 0)
        var withoutPrepared = product; withoutPrepared.catalogueRating = nil
        let local = NativeProductRatingEngine(catalogue: nil).rating(for: withoutPrepared)
        if product.catalogueRating?.method == "nudge_nutrition_v0_4" {
            XCTAssertNotNil(local.value, "Directional nutrient score remains usable without an unverified plant bonus")
            XCTAssertEqual(local.subtitle, "Nudge score")
        } else {
            XCTAssertNil(local.value)
            XCTAssertEqual(local.subtitle, "Nutrition incomplete", "Unknown ingredient contribution is not scored as zero")
        }
        XCTAssertNotEqual(local.value, 0)
        let card = app.ratings.rating(for: product)
        XCTAssertEqual(card.value, 0)
        app.receiveProduct(product, eventID: "prepared-provisional-fixture", origin: "search")
        app.cancelProductRecovery()
        let bound = try XCTUnwrap((app.review["product"] as? [String: Any])?["scoreResult"] as? [String: Any])
        XCTAssertEqual(bound["catalogueValidated"] as? Bool, true, "Recovery must not replay and strip the validated catalogue marker")
        XCTAssertEqual((app.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, card.value)
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        let reopened = NativeAppStore(store: disk)
        defer { reopened.cancelProductRecovery() }
        let history = try XCTUnwrap((reopened.project("history")["rows"] as? [[String: Any]])?.first)
        reopened.openHistory(history); reopened.cancelProductRecovery()
        XCTAssertEqual((reopened.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, card.value)
    }

    func testNewerPreparedCatalogueScoreSupersedesOlderRecoveryThroughNativeProjection() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let recoveryTime = Date().addingTimeInterval(-120)
        let app = NativeAppStore(store: disk, now: { recoveryTime })
        defer { app.cancelProductRecovery() }
        let incoming = try preparedCatalogueProduct()
        var original = incoming; original.catalogueRating = nil
        app.receiveProduct(original, eventID: "older-recovery-fixture")
        app.cancelProductRecovery()
        let request = app.project("productRecovery")
        let older = try preparedCatalogueProduct(scoreValue: 0)
        let result = try JSONSerialization.jsonObject(with: XCTUnwrap(older.catalogueRating).scoreData)
        XCTAssertTrue(app.perform("productRecoveryApply", ["fingerprint": request["fingerprint"] ?? "",
            "confirmationId": request["confirmationId"] ?? "", "result": result]))
        XCTAssertEqual(app.ratings.rating(for: original).value, 0, "The local recovery exists before the newer catalogue result arrives")
        XCTAssertEqual(app.ratings.rating(for: incoming).value, 100, "Native forwards validated score age so older recovery cannot win")
        app.receiveProduct(incoming, eventID: "new-catalogue-fixture", origin: "search")
        app.cancelProductRecovery()
        XCTAssertEqual((app.project("reviewModel")["score"] as? [String: Any])?["value"] as? Int, 100)
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }

    func testReceiveProductRejectsExpiredAndAlteredCatalogueScore() throws {
        for variant in ["expired", "changed"] {
            let folder = directory.appendingPathComponent(variant)
            let disk = NudgeDataStore(directory: folder)
            _ = try seed(fixture(), store: disk)
            let app = NativeAppStore(store: disk)
            defer { app.cancelProductRecovery() }
            var product = try preparedCatalogueProduct(status: variant == "estimated" ? "estimated" : "rated",
                expires: variant == "expired" ? Date().addingTimeInterval(-1) : nil)
            if variant == "changed" { product.ingredientsAnalysisTags = ["en:vegan"] }
            app.receiveProduct(product, eventID: "invalid-catalogue-" + variant)
            app.cancelProductRecovery()
            XCTAssertNil((app.review["product"] as? [String: Any])?["scoreResult"], "Reject \(variant) prepared result")
            XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        }
    }

    func testHistoryDeleteUndoRestoresIntakeOnce() throws {
        let disk=NudgeDataStore(directory:directory)
        var main=fixture()
        let entry:[String:Any]=["id":"e1","name":"Synthetic food","day":NativeAppStore.day,"slot":"Lunch","portions":1,"plants":[],"ferments":[],"energyPerPortion":100,"sourceMeta":["scanEventId":"s1","confirmationId":"c1"]]
        main["foodLog"]=["entries":[entry],"plantGoal":30,"savedRecipes":[]]
        _=try seed(main,store:disk)
        _=try seed(["version":3,"events":[["id":"s1","createdAt":"2026-10-07T12:00:00Z","status":"ready","kind":"meal","entryId":"e1","name":"Synthetic food","extraction":["type":"meal","meal":["name":"Synthetic food"],"nutrients":[:]]]],"deleted":[],"favourites":[],"generations":[:]],key:"nudge-scan-history-v1",store:disk)
        let app=NativeAppStore(store:disk)
        XCTAssertTrue(app.perform("historyDelete",["id":"s1","keepIntake":false]),app.errorMessage ?? "")
        XCTAssertEqual(((app.state["foodLog"] as? [String:Any])?["entries"] as? [Any])?.count,0)
        XCTAssertTrue(app.perform("historyUndo"))
        XCTAssertEqual(((app.state["foodLog"] as? [String:Any])?["entries"] as? [Any])?.count,1)
        XCTAssertEqual((app.project("history")["rows"] as? [Any])?.count,1)
        XCTAssertFalse(app.perform("historyUndo"))
        XCTAssertEqual(((app.state["foodLog"] as? [String:Any])?["entries"] as? [Any])?.count,1)
    }

    func testScanDeletionDismissKeepsIntakeAndPersistsAcrossRestart() throws {
        let disk = NudgeDataStore(directory: directory)
        var main = fixture()
        let entry: [String: Any] = ["id": "kept-food", "name": "Synthetic lunch", "day": NativeAppStore.day,
            "slot": "Lunch", "portions": 1, "plants": ["lentil"], "ferments": [], "energyPerPortion": 300,
            "proteinPerPortion": 20, "sourceMeta": ["scanEventId": "deleted-scan", "confirmationId": "kept-confirmation"]]
        main["foodLog"] = ["entries": [entry], "plantGoal": 30, "savedRecipes": []]
        _ = try seed(main, store: disk)
        let app = NativeAppStore(store: disk)
        XCTAssertTrue(app.perform("recordHistory", ["id": "deleted-scan", "kind": "meal", "status": "ready",
            "name": "Synthetic lunch", "entryId": "kept-food", "extraction": ["type": "meal", "meal": ["name": "Synthetic lunch"]]]))
        let diaryBefore = try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json"))
        let row = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        let deletion = try XCTUnwrap(NativeHistoryDeletion(row: row, filter: "all"))
        XCTAssertEqual(deletion.buttonTitle, "Delete scan")
        XCTAssertTrue(deletion.keepIntake)
        XCTAssertTrue(app.perform("historyDelete", ["id": deletion.id, "keepIntake": deletion.keepIntake]))
        XCTAssertNotNil(app.project("history")["undo"] as? [String: Any])
        XCTAssertTrue(app.perform("historyDismissUndo"))
        XCTAssertNil(app.project("history")["undo"] as? [String: Any])
        XCTAssertFalse(app.perform("historyUndo"), "Dismiss must not invoke or leave an available Undo")
        let restarted = NativeAppStore(store: disk)
        XCTAssertFalse(restarted.perform("historyUndo"))
        let remaining = try XCTUnwrap(restarted.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining.first?["id"] as? String, "diary:kept-food")
        XCTAssertEqual((restarted.project("today")["protein"] as? [String: Any])?["value"] as? Double, 20)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("wmd-nudge-prototype-v1.json")), diaryBefore,
                       "Deleting and dismissing a scan must not rewrite its diary entry")
        XCTAssertFalse(restarted.perform("recordHistory", ["id": "deleted-scan", "kind": "meal", "status": "ready", "name": "Late analysis"]),
                       "Late results cannot restore a dismissed scan")
    }

    func testLoggedFoodDeletionHasOneExplicitActionAndDismissNeverRestoresTotals() throws {
        let disk = NudgeDataStore(directory: directory)
        var main = fixture()
        main["foodLog"] = ["entries": [["id": "removed-food", "name": "Synthetic snack", "day": NativeAppStore.day,
            "slot": "Snack", "portions": 1, "plants": [], "ferments": [], "energyPerPortion": 100]], "plantGoal": 30, "savedRecipes": []]
        _ = try seed(main, store: disk)
        let app = NativeAppStore(store: disk)
        let row = try XCTUnwrap((app.project("history", ["filter": "eaten"])["rows"] as? [[String: Any]])?.first)
        let deletion = try XCTUnwrap(NativeHistoryDeletion(row: row, filter: "eaten"))
        XCTAssertEqual(deletion.buttonTitle, "Delete logged food")
        XCTAssertTrue(deletion.message.contains("daily totals"))
        XCTAssertFalse(deletion.keepIntake)
        XCTAssertTrue(app.perform("historyDelete", ["id": deletion.id, "keepIntake": deletion.keepIntake]))
        XCTAssertTrue(app.perform("historyDismissUndo"))
        let restarted = NativeAppStore(store: disk)
        XCTAssertFalse(restarted.perform("historyUndo"))
        XCTAssertEqual(((restarted.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        XCTAssertEqual((restarted.project("history")["rows"] as? [Any])?.count, 0)
    }

    func testHistoryDeletionPolicyDoesNotOfferCompetingDestructiveChoices() throws {
        let scan: [String: Any] = ["id": "s1", "name": "Synthetic scan"]
        let linked: [String: Any] = ["id": "s1", "name": "Synthetic scan", "entry": ["id": "e1", "name": "Synthetic food", "day": NativeAppStore.day]]
        for filter in ["all", "scanned", "photos"] {
            XCTAssertEqual(NativeHistoryDeletion(row: scan, filter: filter)?.buttonTitle, "Delete scan")
            XCTAssertTrue(try XCTUnwrap(NativeHistoryDeletion(row: linked, filter: filter)).keepIntake)
        }
        XCTAssertFalse(try XCTUnwrap(NativeHistoryDeletion(row: linked, filter: "eaten")).keepIntake)
        XCTAssertFalse(try XCTUnwrap(NativeHistoryDeletion(row: linked.merging(["legacy": true]) { _, new in new }, filter: "all")).keepIntake)
        XCTAssertNil(NativeHistoryDeletion(row: [:], filter: "all"))
    }
}

/// Intentionally does not observe cancellation: the coordinator must discard
/// a provider that replies after a scan is replaced or the camera is closed.
@MainActor
private final class NativeScanLookupGate {
    var pending: [String: CheckedContinuation<BarcodeProduct, Error>] = [:]
    var requested: [String] = []
    var completed: [String] = []
    func wait(_ barcode: String) async throws -> BarcodeProduct {
        requested.append(barcode)
        defer { completed.append(barcode) }
        return try await withCheckedThrowingContinuation { pending[barcode] = $0 }
    }
    func resolve(_ barcode: String, _ result: Result<BarcodeProduct, Error>) {
        pending.removeValue(forKey: barcode)?.resume(with: result)
    }
    func cancelAll() {
        let remaining = Array(pending.values); pending.removeAll()
        for continuation in remaining { continuation.resume(throwing: CancellationError()) }
    }
}

/// Deliberately ignores task cancellation to model a late network reply.
@MainActor
private final class NativePhotoAnalysisGate {
    struct Request {
        let images: [Data]
        let photoIDs: [String]
        let revision: Int
        let diagnosticID: UUID
        let voice: VoiceMemoPayload?
    }
    var requests: [Request] = []
    var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    var completed: [Int] = []
    func analyse(_ images: [Data], _ photoIDs: [String], _ revision: Int, _ voice: VoiceMemoPayload?, _ diagnosticID: UUID) async throws -> [String: Any] {
        let index = requests.count
        requests.append(Request(images: images, photoIDs: photoIDs, revision: revision, diagnosticID: diagnosticID, voice: voice))
        defer { completed.append(index) }
        return try await withCheckedThrowingContinuation { pending[index] = $0 }
    }
    func resolve(_ index: Int, _ result: Result<[String: Any], Error>) {
        pending.removeValue(forKey: index)?.resume(with: result)
    }
    func cancelAll() {
        let remaining = Array(pending.values); pending.removeAll()
        for continuation in remaining { continuation.resume(throwing: CancellationError()) }
    }
}

extension NativeAppStoreTests {
    func testOfflineBarcodeIsSavedBeforeLookupAndRetryReusesHistoryWithoutIntake() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk), product = try preparedCatalogueProduct()
        var requests = 0
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { _, _ in
            requests += 1
            let pending = app.project("history")["rows"] as? [[String: Any]] ?? []
            XCTAssertEqual(pending.count, 1, "Capture must exist before transport starts")
            if requests == 1 { throw URLError(.notConnectedToInternet) }
            return product
        }, productContext: offlineScanContext(), ownerKey: { "local-guest" })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.suspendPending(); coordinator.foodCameraDidCancel(camera); app.cancelProductRecovery() }
        coordinator.foodCamera(camera, found: product.barcode)
        try await settleScan { (app.project("history")["rows"] as? [[String: Any]])?.first?["status"] as? String == "failed" }
        let original = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        let reopened = NativeAppStore(store: disk)
        XCTAssertEqual((reopened.project("history")["rows"] as? [[String: Any]])?.first?["id"] as? String, original["id"] as? String)
        XCTAssertTrue(coordinator.retryHistory(original))
        try await settleScan { (app.project("history")["rows"] as? [[String: Any]])?.first?["status"] as? String == "ready" }
        let completed = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        XCTAssertEqual(completed["id"] as? String, original["id"] as? String)
        XCTAssertEqual(completed["createdAt"] as? String, original["createdAt"] as? String)
        XCTAssertEqual((app.project("history")["rows"] as? [Any])?.count, 1)
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }
    func testPhotoDraftOriginalSurvivesCameraClosureAndCannotMoveToAnotherAccount() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        var owner = String(repeating: "a", count: 64)
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(), ownerKey: { owner })
        let photo = Data([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
        let camera = SmartFoodCameraViewController(photosOnly: true, images: [photo])
        coordinator.prepare(camera); coordinator.foodCamera(camera, changedPhotoCount: 1)
        let row = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        coordinator.foodCameraDidCancel(camera)
        let restored = try XCTUnwrap(app.captureOutbox.records(owner: owner).first)
        XCTAssertEqual(try app.captureOutbox.images(for: restored), [photo])
        XCTAssertEqual(restored.status, .draft)
        owner = String(repeating: "b", count: 64)
        XCTAssertTrue(coordinator.retryHistory(row))
        XCTAssertTrue(app.analysisFailure?.contains("account that captured") == true)
        XCTAssertTrue(try app.captureOutbox.records(owner: owner).isEmpty)
    }
}

extension NativeAppStoreTests {
    func testResumingUnchangedDraftDoesNotRewriteHistoryOrRepublishIt() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        var record = NativeCaptureRecord(eventID: "unchanged-draft", ownerKey: "local-guest")
        record.historyGeneration = 0
        let originalDate = "2026-10-01T12:30:00.123Z"
        record.createdAt = ISO8601DateFormatter().date(from: "2026-10-01T12:30:00Z")!
        try app.captureOutbox.save(record)
        XCTAssertTrue(app.perform("recordHistory", ["id":record.eventID, "kind":"meal", "status":"pending",
            "name":"Food analysis", "createdAt":originalDate, "message":record.message,
            "captureOwnerKey":record.ownerKey, "captureID":record.id.uuidString, "processingState":"draft", "generation":0]))
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(), permissionAllowed: { false }, ownerKey: { "local-guest" })
        defer { coordinator.suspendPending() }
        let seededRow = try XCTUnwrap(app.project("captureState", ["id":record.eventID])["event"] as? [String: Any])
        // A legacy draft omits the explicit empty retry deadline. Its first
        // resume may normalise that field, but must preserve all other evidence.
        coordinator.resumePending()
        let warmedRow = try XCTUnwrap(app.project("captureState", ["id":record.eventID])["event"] as? [String: Any])
        var expectedWarmRow = seededRow
        expectedWarmRow["nextAttemptAt"] = ""
        expectedWarmRow["updatedAt"] = warmedRow["updatedAt"]
        XCTAssertTrue(NSDictionary(dictionary: warmedRow).isEqual(to: expectedWarmRow), "First resume may only normalise the empty retry deadline")
        let file = directory.appendingPathComponent("nudge-scan-history-v1.json"), before = try Data(contentsOf: file)
        var publications = 0
        let subscription = app.$history.dropFirst().sink { _ in publications += 1 }
        defer { subscription.cancel() }
        for _ in 0..<3 { coordinator.resumePending() }
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertEqual(publications, 0)
        record.errorCode = "label_unreadable"; record.status = .needsUserInput
        try app.captureOutbox.save(record); coordinator.resumePending()
        XCTAssertEqual(publications, 1, "A real capture-state change must still be published")
        let row = try XCTUnwrap((app.project("captureState", ["id":record.eventID])["event"] as? [String: Any]))
        XCTAssertEqual(row["processingState"] as? String, "needsUserInput")
        XCTAssertEqual(row["createdAt"] as? String, originalDate)
    }
    func testStaleProcessingAndLegacyBarcodeRecoverWithOriginalTimestamp() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let product = try preparedCatalogueProduct(), app = NativeAppStore(store: disk)
        let captured = "2026-10-01T12:30:00.123Z"
        XCTAssertTrue(app.perform("recordHistory", ["id": "legacy-offline", "kind": "product", "status": "failed", "barcode": product.barcode, "createdAt": captured]))
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { _, _ in product }, productContext: offlineScanContext(), ownerKey: { "local-guest" })
        defer { coordinator.suspendPending(); app.cancelProductRecovery() }
        coordinator.resumePending()
        try await settleScan { (app.project("history")["rows"] as? [[String: Any]])?.first?["status"] as? String == "ready" }
        for _ in 0..<20 { await Task.yield() }
        let row = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["id"] as? String, "legacy-offline"); XCTAssertEqual(row["createdAt"] as? String, captured)
        var interrupted = NativeCaptureRecord(eventID: "interrupted-process", ownerKey: "local-guest")
        interrupted.barcode = product.barcode; interrupted.status = .processing
        try app.captureOutbox.save(interrupted)
        coordinator.resumePending()
        try await settleScan { (app.project("history")["rows"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == "interrupted-process" && $0["status"] as? String == "ready" } }
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }
    func testDeletingPendingBarcodeRejectsLateResultAndRetainsDiary() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk), gate = NativeScanLookupGate(), product = try preparedCatalogueProduct()
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) }, productContext: offlineScanContext(), ownerKey: { "local-guest" })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.suspendPending(); coordinator.foodCameraDidCancel(camera); gate.cancelAll(); app.cancelProductRecovery() }
        coordinator.foodCamera(camera, found: product.barcode)
        try await settleScan { gate.pending[product.barcode] != nil }
        let row = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        let id = try XCTUnwrap(row["id"] as? String)
        XCTAssertTrue(app.perform("historyDelete", ["id": id, "keepIntake": true]))
        coordinator.historyDeleted(id)
        gate.resolve(product.barcode, .success(product))
        try await settleScan { gate.completed.count == 1 }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue((app.project("history")["rows"] as? [Any] ?? []).isEmpty)
        XCTAssertTrue(try app.captureOutbox.records(owner: "local-guest").isEmpty)
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }
}


extension NativeAppStoreTests {
    func testRestartPreservesDurablePendingButInterruptsOrphanPending() throws {
        let disk = NudgeDataStore(directory: directory), app = NativeAppStore(store: disk)
        var saved = NativeCaptureRecord(eventID: "durable-launch", ownerKey: "local-guest")
        saved.photoIDs = [UUID().uuidString]; saved.status = .processing; saved.historyGeneration = 0
        saved.loggingDay = "2026-10-09"; saved.loggingMeal = "Dinner"
        let images = [Data([1, 7, 9])]
        saved.photoReferences = try app.saveAnalysisPhotos(images)
        saved = try app.captureOutbox.save(saved, images: images)
        XCTAssertTrue(app.perform("recordHistory", ["id":saved.eventID, "kind":"meal", "status":"pending",
            "captureOwnerKey":"local-guest", "processingState":"processing", "photos":saved.photoReferences ?? [],
            "loggingDay":"2026-10-09", "loggingMeal":"Dinner"]))
        XCTAssertTrue(app.perform("recordHistory", ["id":"orphan-launch", "kind":"meal", "status":"pending",
            "captureOwnerKey":"local-guest", "processingState":"processing"]))
        let reopened = NativeAppStore(store: disk), rows = photoRows(reopened)
        XCTAssertEqual(rows.first { $0["id"] as? String == saved.eventID }?["status"] as? String, "pending")
        XCTAssertEqual(rows.first { $0["id"] as? String == "orphan-launch" }?["status"] as? String, "failed")
        let restored = try XCTUnwrap(reopened.captureOutbox.record(eventID: saved.eventID, owner: "local-guest"))
        XCTAssertEqual(try reopened.captureOutbox.images(for: restored), images)
        XCTAssertEqual(restored.loggingDay, "2026-10-09"); XCTAssertEqual(restored.loggingMeal, "Dinner")
        XCTAssertEqual(restored.photoReferences, saved.photoReferences)
        XCTAssertEqual(((reopened.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }
}


extension NativeAppStoreTests {
    func testPendingBarcodeRefreshStillOpensSavedProductWithoutAnotherLookup() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        let product: [String: Any] = ["name":"Offline product", "barcode":"12345678", "nutrients":[:]]
        XCTAssertTrue(app.perform("recordHistory", ["id":"offline-pending", "kind":"product", "status":"pending",
            "product":product, "barcode":"12345678", "captureOwnerKey":"local-guest", "processingState":"queued"]))
        let row = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        app.openHistory(row); app.cancelProductRecovery()
        XCTAssertEqual(app.review["eventId"] as? String, "offline-pending")
        XCTAssertEqual((app.review["product"] as? [String: Any])?["name"] as? String, "Offline product")
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
    }
}


@MainActor
private final class NativeCaptureDeletionGate {
    var pending: [Int: CheckedContinuation<Void, Error>] = [:]
    var requested: [UUID] = []
    var completed: [Int] = []
    func remove(_ id: UUID, _ owner: String) async throws {
        let index = requested.count; requested.append(id)
        defer { completed.append(index) }
        try await withCheckedThrowingContinuation { pending[index] = $0 }
    }
    func resolve(_ index: Int, _ result: Result<Void, Error>) { pending.removeValue(forKey: index)?.resume(with: result) }
    func cancelAll() { let values = Array(pending.values); pending.removeAll(); for value in values { value.resume(throwing: CancellationError()) } }
}
extension NativeAppStoreTests {
    func testDeleteUndoRetryKeepsVoiceAndLateDeleteFailureCannotRecreateOldIdentity() async throws {
        let disk = NudgeDataStore(directory: directory), app = NativeAppStore(store: disk)
        let photos = NativePhotoAnalysisGate(), deletions = NativeCaptureDeletionGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: photos.analyse, permissionAllowed: { true }, accountRevision: { 7 },
            ownerKey: { "local-guest" }, deleteCapture: deletions.remove)
        app.capture = coordinator
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); photos.cancelAll(); deletions.cancelAll() }
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0,0,0,12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        let camera = SmartFoodCameraViewController(images: [Data([2,4,6])], revision: 8, voiceMemo: voice)
        coordinator.prepare(camera); let id = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: camera.capturedImages)
        try await settlePhoto { photos.pending[0] != nil }
        let original = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
        XCTAssertTrue(app.perform("historyDelete", ["id":id, "keepIntake":true]))
        try await settlePhoto { deletions.pending[0] != nil }
        let revoked = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
        XCTAssertEqual(try coordinator.outbox.voiceMemo(for: revoked)?.audioData, voice.audioData)
        XCTAssertTrue(app.perform("historyUndo"))
        coordinator.complete() // Retrying no longer has an in-memory voice memo to rescue.
        let reopened = NativeAppStore(store: disk)
        let restoredRow = try XCTUnwrap(photoRows(reopened).first { $0["id"] as? String == id })
        XCTAssertTrue(coordinator.retryHistory(restoredRow))
        try await settlePhoto { photos.pending[1] != nil }
        XCTAssertEqual(photos.requests[1].voice?.audioData, voice.audioData)
        XCTAssertEqual(photos.requests[1].photoIDs, photos.requests[0].photoIDs)
        XCTAssertEqual(photos.requests[1].revision, 8)
        deletions.resolve(0, .failure(URLError(.timedOut)))
        try await settlePhoto { deletions.completed.contains(0) }
        let current = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
        XCTAssertNotEqual(current.id, original.id); XCTAssertNotEqual(current.submissionID, original.submissionID)
        XCTAssertEqual(current.createdAt, original.createdAt)
        XCTAssertEqual(try coordinator.outbox.records(owner: "local-guest").filter { $0.eventID == id }.count, 1)
        let tombstone = try XCTUnwrap(coordinator.outbox.records(owner: "local-guest").first { $0.id == original.id })
        XCTAssertEqual(tombstone.eventID, "deleted-capture:" + original.id.uuidString)
        XCTAssertEqual(tombstone.revokedEventID, id)
        photos.resolve(0, .success(photoResult("Obsolete deleted food")))
        photos.resolve(1, .success(photoResult("Current restored food")))
        try await settlePhoto { self.photoRows(app).first { $0["id"] as? String == id }?["status"] as? String == "ready" }
        XCTAssertEqual(photoRows(app).first { $0["id"] as? String == id }?["name"] as? String, "Current restored food")
        XCTAssertEqual(((app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        XCTAssertEqual(try NativeCaptureOutbox(directory: disk.captureDirectory).voiceMemo(for: current)?.audioData, voice.audioData)
    }
}


extension NativeAppStoreTests {
    func testUndoAfterRestartRetriesDurableVoiceAndDestinationWithFreshCoordinator() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let diaryFile = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let diaryBefore = try Data(contentsOf: diaryFile)
        let images = [Data([2, 4, 6]), Data([3, 5, 7])]
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0, 0, 0, 12]) + Data("ftypM4A ".utf8), durationSeconds: 3))
        var captured: NativeCaptureRecord?

        do {
            let app = NativeAppStore(store: disk)
            let photos = NativePhotoAnalysisGate(), deletions = NativeCaptureDeletionGate()
            let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
                analysePhotos: photos.analyse, permissionAllowed: { true }, accountRevision: { 7 },
                ownerKey: { "local-guest" }, deleteCapture: deletions.remove)
            app.capture = coordinator
            defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); photos.cancelAll(); deletions.cancelAll() }
            app.showFoodLibrary(mode: "recents", day: "2026-10-09", meal: "Dinner")
            let camera = SmartFoodCameraViewController(images: images, revision: 11, voiceMemo: voice)
            coordinator.prepare(camera)
            let id = coordinator.photoEventID
            coordinator.foodCamera(camera, analyse: images)
            try await settlePhoto { photos.pending[0] != nil }
            captured = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
            XCTAssertTrue(app.perform("historyDelete", ["id": id, "keepIntake": true]))
            try await settlePhoto { deletions.pending[0] != nil }
            deletions.resolve(0, .success(()))
            try await settlePhoto { app.analysingCount == 0 }
            XCTAssertEqual(try coordinator.outbox.record(eventID: id, owner: "local-guest")?.deletionAcknowledged, true)
            XCTAssertNotNil(app.project("history")["undo"] as? [String: Any])
            coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); photos.cancelAll()
            try await settlePhoto { photos.completed.contains(0) }
            XCTAssertNil(coordinator.camera)
        }

        let original = try XCTUnwrap(captured)
        let reopenedDisk = NudgeDataStore(directory: directory)
        let reopened = NativeAppStore(store: reopenedDisk), resumedPhotos = NativePhotoAnalysisGate()
        let freshCoordinator = NativeCaptureCoordinator(store: reopened, productContext: offlineScanContext(),
            analysePhotos: resumedPhotos.analyse, permissionAllowed: { true }, accountRevision: { 7 },
            ownerKey: { "local-guest" }, deleteCapture: { _, _ in
                XCTFail("The acknowledged deletion must not require another network request")
            })
        reopened.capture = freshCoordinator
        defer { freshCoordinator.cancelAllPhotoAnalyses(); freshCoordinator.complete(); resumedPhotos.cancelAll() }
        XCTAssertNil(freshCoordinator.camera)
        reopened.showFoodLibrary(mode: "recents", day: "2026-10-11", meal: "Lunch")
        XCTAssertTrue(reopened.perform("historyUndo"), "Undo must survive reopening both the store and coordinator")
        let row = try XCTUnwrap(photoRows(reopened).first { $0["id"] as? String == original.eventID })
        XCTAssertTrue(freshCoordinator.retryHistory(row))
        try await settlePhoto { resumedPhotos.pending[0] != nil }
        let request = try XCTUnwrap(resumedPhotos.requests.first)
        XCTAssertEqual(request.images, images)
        XCTAssertEqual(request.photoIDs, original.photoIDs)
        XCTAssertEqual(request.revision, 11)
        XCTAssertEqual(request.voice?.audioData, voice.audioData)
        XCTAssertEqual(request.voice?.durationSeconds, voice.durationSeconds)
        let restored = try XCTUnwrap(freshCoordinator.outbox.record(eventID: original.eventID, owner: "local-guest"))
        XCTAssertNotEqual(restored.submissionID, original.submissionID)
        XCTAssertEqual(restored.createdAt, original.createdAt)
        XCTAssertEqual(restored.loggingDay, "2026-10-09")
        XCTAssertEqual(restored.loggingMeal, "Dinner")
        resumedPhotos.resolve(0, .success(photoResult("Meal retried after restart")))
        try await settlePhoto { self.photoRows(reopened).first { $0["id"] as? String == original.eventID }?["status"] as? String == "ready" }
        let completed = try XCTUnwrap(photoRows(reopened).first { $0["id"] as? String == original.eventID })
        XCTAssertEqual(completed["loggingDay"] as? String, "2026-10-09")
        XCTAssertEqual(completed["loggingMeal"] as? String, "Dinner")
        XCTAssertEqual(photoRows(reopened).count, 1)
        XCTAssertNil(freshCoordinator.camera, "Retry must use saved originals without reopening the old camera")
        XCTAssertEqual(((reopened.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.count, 0)
        XCTAssertEqual(try Data(contentsOf: diaryFile), diaryBefore, "Restart, Undo and analysis must not write diary entries")
    }

    func testAwaitedDeleteFailurePreservesRenamedTombstoneAndUndoVoice() async throws {
        let disk = NudgeDataStore(directory: directory), app = NativeAppStore(store: disk)
        let deletions = NativeCaptureDeletionGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            permissionAllowed: { true }, ownerKey: { "local-guest" }, deleteCapture: deletions.remove)
        app.capture = coordinator
        defer { coordinator.cancelAllPhotoAnalyses(); deletions.cancelAll() }
        let voice = try XCTUnwrap(VoiceMemoPayload(audioData: Data([0,0,0,12]) + Data("ftypM4A ".utf8), durationSeconds: 2))
        var input = NativeCaptureRecord(eventID: "awaited-delete", ownerKey: "local-guest")
        input.status = .processing; input.attempts = 1; input.historyGeneration = 0
        input.photoIDs = [UUID().uuidString]
        input = try coordinator.outbox.save(input, images: [Data([9,8,7])], voiceMemo: voice)
        XCTAssertTrue(app.perform("recordHistory", ["id":input.eventID, "kind":"meal", "status":"pending", "captureOwnerKey":"local-guest"]))
        XCTAssertTrue(app.perform("historyDelete", ["id":input.eventID, "keepIntake":true]))
        try await settlePhoto { deletions.pending[0] != nil }
        var renamed = try XCTUnwrap(coordinator.outbox.record(eventID: input.eventID, owner: "local-guest"))
        renamed.eventID = "deleted-capture:" + input.id.uuidString
        try coordinator.outbox.save(renamed)
        deletions.resolve(0, .failure(URLError(.timedOut)))
        try await settlePhoto { app.analysingCount == 0 }
        let after = try XCTUnwrap(coordinator.outbox.records(owner: "local-guest").first { $0.id == input.id })
        XCTAssertEqual(after.eventID, renamed.eventID)
        XCTAssertNil(try coordinator.outbox.record(eventID: input.eventID, owner: "local-guest"))
        XCTAssertEqual(try coordinator.outbox.voiceMemo(for: after)?.audioData, voice.audioData)
        XCTAssertNotNil(after.nextAttemptAt)
    }
}

extension NativeAppStoreTests {
    func testCloseDuringPhotoSavesOriginalToOldDraftWithoutContaminatingFreshCamera() throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory))
        app.showFoodLibrary(mode: "recents", day: "2026-10-14", meal: "Lunch")
        let coordinator = NativeCaptureCoordinator(store: app, accountRevision: { 7 }, ownerKey: { "local-guest" })
        let old = SmartFoodCameraViewController(photosOnly: true)
        coordinator.prepare(old); old.loadViewIfNeeded()
        let id = coordinator.photoEventID, token = try XCTUnwrap(old.beginPhotoCapture())
        old.capturedShutter(token: token)
        coordinator.foodCameraDidCancel(old)
        XCTAssertNil(coordinator.camera, "Close dismisses without waiting for hardware or JPEG encoding")
        XCTAssertTrue(old.closingForDeferredPhoto)
        let fresh = try XCTUnwrap(coordinator.prepareFreshCamera())
        let freshID = coordinator.photoEventID
        let original = Data([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
        old.finishPhoto(original, token: token)
        let saved = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
        XCTAssertEqual(try coordinator.outbox.images(for: saved), [original])
        XCTAssertEqual(saved.loggingDay, "2026-10-14"); XCTAssertEqual(saved.loggingMeal, "Lunch")
        XCTAssertEqual(saved.status, .draft)
        XCTAssertTrue(coordinator.camera === fresh); XCTAssertEqual(coordinator.photoEventID, freshID)
        XCTAssertTrue(fresh.capturedImages.isEmpty)
        old.finishPhoto(Data([9]), token: token)
        XCTAssertEqual(try coordinator.outbox.images(for: saved), [original], "A late duplicate callback cannot replace the saved original")
        coordinator.complete()
    }

    func testFailedDeferredPhotoResolvesAndCannotEnterFreshOrDifferentAccountDraft() throws {
        for failCapture in [false, true] {
            let app = NativeAppStore(store: NudgeDataStore(directory: directory.appendingPathComponent(String(failCapture))))
            var account = 7
            let coordinator = NativeCaptureCoordinator(store: app, accountRevision: { account }, ownerKey: { "local-guest" })
            let old = SmartFoodCameraViewController(photosOnly: true)
            coordinator.prepare(old); old.loadViewIfNeeded()
            let token = try XCTUnwrap(old.beginPhotoCapture())
            coordinator.foodCameraDidCancel(old)
            if !failCapture { account += 1 }
            let fresh = try XCTUnwrap(coordinator.prepareFreshCamera())
            old.finishPhoto(failCapture ? nil : Data([1]), token: token)
            XCTAssertFalse(old.isCaptureInFlight)
            XCTAssertTrue(coordinator.camera === fresh); XCTAssertTrue(fresh.capturedImages.isEmpty)
            XCTAssertTrue(try coordinator.outbox.records(owner: "local-guest").isEmpty)
            if failCapture { XCTAssertTrue(app.errorMessage?.contains("could not be captured") == true) }
            coordinator.complete()
        }
    }

    func testQueuedBarcodeBurstUsesOneLookupAndOneCompletionPublicationPreservingAllRows() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativeScanLookupGate()
        let product = try preparedCatalogueProduct()
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) },
            productContext: offlineScanContext(), ownerKey: { "local-guest" })
        var ids = Set<String>()
        for index in 0..<42 {
            var record = NativeCaptureRecord(eventID: "burst-\(index)", ownerKey: "local-guest")
            record.barcode = product.barcode; record.status = .queued; record.historyGeneration = 0
            record.createdAt = Date(timeIntervalSince1970: 1_760_000_000 + Double(index))
            record.loggingDay = "2026-10-14"; record.loggingMeal = index % 2 == 0 ? "Lunch" : "Dinner"
            try coordinator.outbox.save(record); ids.insert(record.eventID)
        }
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.suspendPending(); gate.cancelAll(); app.cancelProductRecovery() }
        coordinator.resumePending()
        try await settleScan { gate.requested.count == 1 }
        let before = try XCTUnwrap(app.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(before.count, 42)
        var completePublications = 0
        let subscription = app.$history.dropFirst().sink { history in
            let rows = history["events"] as? [[String: Any]] ?? []
            if rows.count == 42 && rows.allSatisfy({ $0["status"] as? String == "ready" }) { completePublications += 1 }
        }
        defer { subscription.cancel() }
        gate.resolve(product.barcode, .success(product))
        try await settleScan { app.analysingCount == 0 }
        let after = try XCTUnwrap(app.project("history")["rows"] as? [[String: Any]])
        XCTAssertEqual(Set(after.compactMap { $0["id"] as? String }), ids)
        XCTAssertTrue(after.allSatisfy { $0["status"] as? String == "ready" })
        XCTAssertEqual(completePublications, 1)
        XCTAssertEqual(gate.requested.count, 1)
        for old in before {
            let updated = try XCTUnwrap(after.first { $0["id"] as? String == old["id"] as? String })
            XCTAssertEqual(updated["createdAt"] as? String, old["createdAt"] as? String)
            XCTAssertEqual(updated["loggingDay"] as? String, old["loggingDay"] as? String)
            XCTAssertEqual(updated["loggingMeal"] as? String, old["loggingMeal"] as? String)
        }
        XCTAssertTrue(try coordinator.outbox.records(owner: "local-guest").allSatisfy { $0.status == .complete })
        XCTAssertNil(coordinator.camera); XCTAssertNil(coordinator.scanSummary); XCTAssertNil(app.route)
    }

    func testRepeatedAcceptedBarcodeCallbacksReusePendingJobAndOwnerCancellationReleasesClaim() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativeScanLookupGate()
        let product = try preparedCatalogueProduct()
        var owner: String? = "local-guest"
        let coordinator = NativeCaptureCoordinator(store: app, lookup: { barcode, _ in try await gate.wait(barcode) },
            productContext: offlineScanContext(), ownerKey: { owner })
        let camera = SmartFoodCameraViewController(continuousBarcodeScanning: true)
        coordinator.prepare(camera)
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll(); app.cancelProductRecovery() }
        for _ in 0..<100 { coordinator.foodCamera(camera, found: product.barcode) }
        try await settleScan { gate.requested.count == 1 }
        XCTAssertEqual(try coordinator.outbox.records(owner: "local-guest").count, 1)
        let row = try XCTUnwrap((app.project("history")["rows"] as? [[String: Any]])?.first)
        owner = nil
        coordinator.cancelAllPhotoAnalyses()
        gate.resolve(product.barcode, .success(product))
        try await settleScan { gate.completed.count == 1 }
        owner = "local-guest"
        XCTAssertTrue(coordinator.retryHistory(row))
        try await settleScan { gate.requested.count == 2 }
        gate.resolve(product.barcode, .success(product))
        try await settleScan { app.analysingCount == 0 }
        XCTAssertEqual((app.project("history")["rows"] as? [[String: Any]])?.first?["status"] as? String, "ready")
        XCTAssertEqual(try coordinator.outbox.records(owner: "local-guest").count, 1)
    }
}

// Build 16: drive the real coordinator with delayed synthetic transport. These
// tests cover durable intake intent independently of visible camera/review UI.
extension NativeAppStoreTests {
    private func autoAddEntries(_ app: NativeAppStore) -> [[String: Any]] {
        (app.state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]] ?? []
    }

    func testAnalyseAndEatKeepsDestinationAndOpenDraftWhileAnalyseOnlyStaysInHistory() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        app.showFoodLibrary(mode: "recents", day: "2026-10-09", meal: "Dinner")
        let first = SmartFoodCameraViewController(images: [Data([1, 2])])
        coordinator.prepare(first); let eatenID = coordinator.photoEventID
        coordinator.foodCamera(first, analyse: first.capturedImages, addToEaten: true)
        try await settlePhoto { gate.pending[0] != nil }
        XCTAssertTrue(first.capturedImages.isEmpty, "Submission frees the camera immediately")
        XCTAssertEqual(try coordinator.outbox.record(eventID: eatenID, owner: "local-guest")?.diaryAddState, "pending")
        XCTAssertTrue(autoAddEntries(app).isEmpty)
        app.showFoodLibrary(mode: "recents", day: "2026-10-10", meal: "Lunch")
        let second = SmartFoodCameraViewController(images: [Data([3])])
        coordinator.prepare(second); let analysisID = coordinator.photoEventID
        coordinator.foodCamera(second, analyse: second.capturedImages, addToEaten: false)
        try await settlePhoto { gate.pending[1] != nil }
        app.navigate("search")
        XCTAssertTrue(app.perform("setReview", ["kind":"entry", "entry":["name":"Unrelated draft", "portions":1], "confirmationId":"unrelated-auto-add-draft"]))
        let reviewBefore = try JSONSerialization.data(withJSONObject: app.review, options: [.sortedKeys])
        gate.resolve(1, .success(photoResult("Analysis only")))
        try await settlePhoto { app.analysingCount == 1 }
        XCTAssertTrue(autoAddEntries(app).isEmpty)
        gate.resolve(0, .success(photoResult("Eaten meal")))
        try await settlePhoto { app.analysingCount == 0 }
        let entry = try XCTUnwrap(autoAddEntries(app).first)
        XCTAssertEqual(autoAddEntries(app).count, 1)
        XCTAssertEqual(entry["day"] as? String, "2026-10-09")
        XCTAssertEqual(entry["slot"] as? String, "Dinner")
        XCTAssertEqual((entry["sourceMeta"] as? [String: Any])?["scanEventId"] as? String, eatenID)
        XCTAssertEqual(app.selectedTab, "search")
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: app.review, options: [.sortedKeys]), reviewBefore)
        XCTAssertEqual(try coordinator.outbox.record(eventID: eatenID, owner: "local-guest")?.diaryAddState, "added")
        XCTAssertEqual(try coordinator.outbox.record(eventID: analysisID, owner: "local-guest")?.status, .complete)
        XCTAssertEqual(photoRows(app).count, 2)
        XCTAssertEqual(autoAddEntries(NativeAppStore(store: disk)).count, 1)
    }

    func testDeletingPendingEatenIntentKeepsAnalysisAndSurvivesLateRetryStatus() async throws {
        for failFirst in [false, true] {
            let disk = NudgeDataStore(directory: directory.appendingPathComponent("cancel-intent-\(failFirst)"))
            let app = NativeAppStore(store: disk), gate = NativePhotoAnalysisGate()
            let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
                analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
            defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
            let camera = SmartFoodCameraViewController(images: [Data([4])])
            coordinator.prepare(camera); let id = coordinator.photoEventID
            coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: true)
            try await settlePhoto { gate.pending[0] != nil }
            XCTAssertTrue(coordinator.cancelAddToEaten(eventID: id))
            gate.resolve(0, failFirst ? .failure(URLError(.timedOut)) : .success(photoResult("Cancelled intake")))
            try await settlePhoto { app.analysingCount == 0 }
            if failFirst {
                XCTAssertEqual(try coordinator.outbox.record(eventID: id, owner: "local-guest")?.diaryAddState, "cancelled", "A stale transport failure cannot re-enable auto-add")
                XCTAssertTrue(coordinator.retryHistory(try XCTUnwrap(photoRows(app).first)))
                try await settlePhoto { gate.pending[1] != nil }
                gate.resolve(1, .success(photoResult("Retried analysis only")))
                try await settlePhoto { app.analysingCount == 0 }
            }
            XCTAssertTrue(autoAddEntries(app).isEmpty)
            XCTAssertEqual(photoRows(app).first?["status"] as? String, "ready")
            let record = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
            XCTAssertEqual(record.status, .complete); XCTAssertEqual(record.addToEaten, false)
            XCTAssertEqual(record.diaryAddState, "cancelled")
            XCTAssertEqual(try coordinator.outbox.images(for: record), [Data([4])])
        }
    }

    func testAutoAddDiaryWriteFailureRetriesLocallyAndReplayCannotDuplicateOrResurrect() async throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let camera = SmartFoodCameraViewController(images: [Data([5, 6])])
        coordinator.prepare(camera); let id = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: true)
        try await settlePhoto { gate.pending[0] != nil }
        let diaryFile = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let original = try Data(contentsOf: diaryFile), corrupt = Data("synthetic interrupted storage".utf8)
        try corrupt.write(to: diaryFile, options: .atomic)
        gate.resolve(0, .success(photoResult("Locally retried meal")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(try Data(contentsOf: diaryFile), corrupt, "A failed diary save cannot overwrite unparseable storage")
        XCTAssertTrue(autoAddEntries(app).isEmpty)
        var record = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
        XCTAssertEqual(record.status, .complete); XCTAssertEqual(record.diaryAddState, "pending")
        XCTAssertNotNil(photoRows(app).first?["extraction"])
        try original.write(to: diaryFile, options: .atomic)
        record.nextAttemptAt = .distantPast; try coordinator.outbox.save(record)
        coordinator.resumePending()
        try await settlePhoto { app.analysingCount == 0 && self.autoAddEntries(app).count == 1 }
        XCTAssertEqual(gate.requests.count, 1, "A diary-write retry must not run analysis again")
        let entryID = try XCTUnwrap(autoAddEntries(app).first?["id"] as? String)

        // Simulate a close after the atomic diary/claim write but before the
        // outbox acknowledges it. A fresh app must recognise that same intake.
        record = try XCTUnwrap(coordinator.outbox.record(eventID: id, owner: "local-guest"))
        record.diaryAddState = "pending"; record.nextAttemptAt = .distantPast
        try coordinator.outbox.save(record); coordinator.suspendPending()
        let reopened = NativeAppStore(store: disk)
        var unexpectedUploads = 0
        let resumed = NativeCaptureCoordinator(store: reopened, productContext: offlineScanContext(), analysePhotos: { _, _, _, _, _ in
            unexpectedUploads += 1; return self.photoResult("Unexpected replacement")
        }, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { resumed.cancelAllPhotoAnalyses(); resumed.complete() }
        resumed.resumePending()
        try await settlePhoto { reopened.analysingCount == 0 }
        XCTAssertEqual(autoAddEntries(reopened).count, 1); XCTAssertEqual(autoAddEntries(reopened).first?["id"] as? String, entryID)
        XCTAssertEqual(try resumed.outbox.record(eventID: id, owner: "local-guest")?.diaryAddState, "added")
        XCTAssertEqual(unexpectedUploads, 0)
        XCTAssertTrue(reopened.perform("diaryDelete", ["entryId":entryID]))
        record = try XCTUnwrap(resumed.outbox.record(eventID: id, owner: "local-guest"))
        record.diaryAddState = "pending"; record.nextAttemptAt = .distantPast
        try resumed.outbox.save(record); resumed.resumePending()
        try await settlePhoto { reopened.analysingCount == 0 }
        XCTAssertTrue(autoAddEntries(reopened).isEmpty, "Replaying a completed capture cannot recreate deleted intake")
        XCTAssertEqual(try resumed.outbox.record(eventID: id, owner: "local-guest")?.diaryAddState, "cancelled")
        XCTAssertEqual(unexpectedUploads, 0)
    }

    func testAutoAddRejectsCancelledTaskAccountOwnerAndDeletedHistoryLateResults() async throws {
        for fence in ["task", "account", "owner", "deleted", "generation"] {
            let app = NativeAppStore(store: NudgeDataStore(directory: directory.appendingPathComponent("auto-add-\(fence)")))
            let gate = NativePhotoAnalysisGate(); var account = 7, owner = "local-guest"
            let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
                analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { account }, ownerKey: { owner })
            defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
            let camera = SmartFoodCameraViewController(images: [Data([7])])
            coordinator.prepare(camera); let id = coordinator.photoEventID
            coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: true)
            try await settlePhoto { gate.pending[0] != nil }
            switch fence {
            case "task": coordinator.cancelAllPhotoAnalyses()
            case "account": account += 1
            case "owner": owner = String(repeating: "a", count: 64)
            default:
                XCTAssertTrue(app.perform("historyDelete", ["id":id, "keepIntake":true]))
                if fence == "generation" { XCTAssertTrue(app.perform("historyUndo")) }
                else { XCTAssertTrue(app.perform("historyDismissUndo")) }
            }
            gate.resolve(0, .success(photoResult("Fenced late meal")))
            try await settlePhoto { gate.completed.contains(0) && app.analysingCount == 0 }
            XCTAssertTrue(autoAddEntries(app).isEmpty, fence)
            let fencedRow = photoRows(app).first { $0["id"] as? String == id }
            if fence == "deleted" {
                XCTAssertNil(fencedRow, "A late result cannot recreate deleted History")
            } else {
                let retainedRow = try XCTUnwrap(fencedRow, fence)
                // History serialises absent extraction as JSON null, which the
                // bridge represents as NSNull rather than Swift nil.
                let extraction = retainedRow["extraction"]
                XCTAssertTrue(extraction == nil || extraction is NSNull, "A fenced result must not save any extraction: \(fence)")
                XCTAssertNotEqual(retainedRow["status"] as? String, "ready", fence)
            }
            XCTAssertEqual(gate.requests.count, 1)
            if fence == "task" {
                XCTAssertTrue(coordinator.retryHistory(try XCTUnwrap(photoRows(app).first)))
                try await settlePhoto { gate.pending[1] != nil }
                XCTAssertEqual(try coordinator.outbox.record(eventID: id, owner: "local-guest")?.addToEaten, true)
                gate.resolve(1, .success(photoResult("Explicitly retried eaten meal")))
                try await settlePhoto { app.analysingCount == 0 }
                XCTAssertEqual(autoAddEntries(app).count, 1, "An explicit retry keeps the original intake choice")
                XCTAssertEqual(gate.requests[0].images, gate.requests[1].images)
                XCTAssertEqual(gate.requests[0].photoIDs, gate.requests[1].photoIDs)
            }
        }
    }
}


extension NativeAppStoreTests {
    func testPendingRowSwipeAfterAnalysisFinishedDeletesOnlyItsNewlyAddedFood() async throws {
        let app = NativeAppStore(store: NudgeDataStore(directory: directory)), gate = NativePhotoAnalysisGate()
        let coordinator = NativeCaptureCoordinator(store: app, productContext: offlineScanContext(),
            analysePhotos: gate.analyse, permissionAllowed: { true }, accountRevision: { 7 }, ownerKey: { "local-guest" })
        defer { coordinator.cancelAllPhotoAnalyses(); coordinator.complete(); gate.cancelAll() }
        let camera = SmartFoodCameraViewController(images: [Data([8])])
        coordinator.prepare(camera); let id = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: true)
        try await settlePhoto { gate.pending[0] != nil }
        // The user began swiping this pending row before the response arrived.
        gate.resolve(0, .success(photoResult("Food completed during swipe")))
        try await settlePhoto { app.analysingCount == 0 }
        XCTAssertEqual(autoAddEntries(app).count, 1)
        XCTAssertTrue(coordinator.cancelAddToEaten(eventID: id))
        XCTAssertTrue(autoAddEntries(app).isEmpty, "Completing during a swipe cannot leave the food behind")
        XCTAssertEqual(photoRows(app).first?["status"] as? String, "ready", "The analysis remains in History")
        XCTAssertTrue(coordinator.cancelAddToEaten(eventID: id), "Repeating the stale UI action is harmless")
        XCTAssertEqual(gate.requests.count, 1)
    }
}

extension NativeAppStoreTests {
    func testSavedFoodFullEditsUpdateExactVariantAndLeaveDiaryAndHistoryUntouched() throws {
        let disk = NudgeDataStore(directory: directory)
        _ = try seed(fixture(), store: disk)
        let app = NativeAppStore(store: disk)
        let eaten: [String: Any] = ["name": "Previously eaten meal", "portions": 1, "proteinPerPortion": 8, "plants": [], "ferments": []]
        XCTAssertTrue(app.perform("setReview", ["kind": "entry", "entry": eaten, "confirmationId": "unchanged-diary"]))
        XCTAssertTrue(app.perform("reviewConfirm"))
        let diaryURL = directory.appendingPathComponent("wmd-nudge-prototype-v1.json")
        let diaryBefore = try Data(contentsOf: diaryURL)
        let historyBefore = try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys])
        for (key, amount) in [("small", 100), ("large", 250)] {
            let entry: [String: Any] = ["name": "Synthetic saved " + key, "barcode": "1234567890123",
                "portions": 1, "portionAmount": amount, "portionUnit": "g", "proteinPerPortion": 10,
                "ingredients": ["text": "Oats, milk", "needsReview": false], "plants": ["oats"], "ferments": []]
            XCTAssertTrue(app.perform("setReview", ["kind": "entry", "entry": entry, "confirmationId": "saved-" + key]))
            XCTAssertTrue(app.perform("reviewSaveFood"))
        }
        let foods = try XCTUnwrap(app.foods["foods"] as? [[String: Any]])
        let small = try XCTUnwrap(foods.first { $0["sourceKey"] as? String == "draft:saved-small" })
        let large = try XCTUnwrap(foods.first { $0["sourceKey"] as? String == "draft:saved-large" })
        let selectedID = try XCTUnwrap(small["id"] as? String)
        let originalLarge = try JSONSerialization.data(withJSONObject: large, options: [.sortedKeys])
        let foodsURL = directory.appendingPathComponent("nudge-my-foods-v1.json")
        let beforeEdit = try Data(contentsOf: foodsURL)
        app.route = "saved"
        app.openSaved(small)
        XCTAssertTrue(app.reviewPresented)
        XCTAssertEqual(app.review["savedFoodId"] as? String, selectedID)
        XCTAssertTrue(app.perform("reviewUpdate", ["name": "Edited saved food", "ingredients": "Oats, kefir",
            "plants": ["oats", "banana"], "quantity": 2, "nutrient": ["key": "protein", "value": 22]]))
        XCTAssertEqual(try Data(contentsOf: foodsURL), beforeEdit, "Opening and editing a draft must not save it")
        XCTAssertTrue(app.perform("reviewSaveFood"))
        app.dismissReview()
        XCTAssertEqual(app.route, "saved")
        XCTAssertFalse(app.reviewPresented)
        let after = try XCTUnwrap(app.foods["foods"] as? [[String: Any]])
        XCTAssertEqual(after.count, foods.count, "Save changes updates the opened food rather than creating another")
        let updated = try XCTUnwrap(after.first { $0["id"] as? String == selectedID })
        let draft = try XCTUnwrap(updated["draft"] as? [String: Any])
        XCTAssertEqual(updated["sourceKey"] as? String, small["sourceKey"] as? String)
        XCTAssertEqual(updated["name"] as? String, "Edited saved food")
        XCTAssertEqual((draft["ingredients"] as? [String: Any])?["text"] as? String, "Oats, kefir")
        XCTAssertEqual(draft["plants"] as? [String], ["oats", "banana"])
        XCTAssertEqual((draft["portions"] as? NSNumber)?.doubleValue, 2)
        XCTAssertEqual((draft["proteinPerPortion"] as? NSNumber)?.doubleValue, 22)
        let retainedLarge = try XCTUnwrap(after.first { $0["id"] as? String == large["id"] as? String })
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: retainedLarge, options: [.sortedKeys]), originalLarge)
        XCTAssertEqual(try Data(contentsOf: diaryURL), diaryBefore)
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: app.history, options: [.sortedKeys]), historyBefore)

        let savedBytes = try Data(contentsOf: foodsURL)
        let reopened = NativeAppStore(store: disk)
        reopened.route = "saved"; reopened.openSaved(updated)
        XCTAssertEqual((reopened.project("reviewModel")["draft"] as? [String: Any])?["name"] as? String, "Edited saved food")
        XCTAssertTrue(reopened.perform("reviewUpdate", ["name": "Discard this draft"])); reopened.dismissReview()
        XCTAssertEqual(try Data(contentsOf: foodsURL), savedBytes, "Closing a later edit discards it")
        XCTAssertTrue(reopened.perform("foodsDelete", ["id": selectedID]))
        XCTAssertEqual(reopened.savedCount, foods.count - 1)
        XCTAssertEqual(try Data(contentsOf: diaryURL), diaryBefore, "Removing a saved food leaves previously eaten food intact")
    }
}
