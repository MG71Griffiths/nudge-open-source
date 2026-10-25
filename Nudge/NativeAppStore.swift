import Combine
import Foundation
import JavaScriptCore
import SwiftUI

/// A SwiftUI application session over the existing private records. Shared domain
/// calculators run offline in JavaScriptCore; no web screen or browser storage is used.
@MainActor
final class NativeAppStore: ObservableObject {
    @Published private(set) var state: [String: Any] = [:]
    @Published private(set) var history: [String: Any] = [:]
    @Published private(set) var foods: [String: Any] = [:]
    @Published private(set) var review: [String: Any] = [:]
    @Published var errorMessage: String?
    // Transient acknowledgements must not invalidate every screen. Errors remain observable.
    var notice: String?
    @Published private(set) var analysisAcknowledgement: String?
    @Published private(set) var analysisHistoryRevealRevision = 0
    private var analysisAcknowledgementTask: Task<Void, Never>?
    @Published var selectedTab = "today"
    @Published var route: String?
    @Published var recipeID: String?
    @Published var diaryDay = ""
    @Published private(set) var loggingDay = ""
    @Published private(set) var loggingMeal = ""
    @Published private(set) var foodLibraryMode = "recents"
    private var reviewReturnRoute: String?
    /// The list stays mounted while its review is presented as a sheet.
    var presentationRoute: String? { route == "review" ? reviewReturnRoute : route }
    var reviewPresented: Bool {
        get { route == "review" }
        set { if !newValue && route == "review" { dismissReview() } }
    }
    @Published var loading = false
    @Published private var activeAnalysisCount = 0
    var analysingCount: Int {
        get { activeAnalysisCount }
        set { if activeAnalysisCount != newValue { activeAnalysisCount = newValue } }
    }
    @Published var addFoodPresented = false
    @Published var foodDescription = ""
    @Published private(set) var describingFood = false
    @Published private(set) var foodDescriptionError: String?
    @Published private(set) var foodDescriptionNeedsSignIn = false
    @Published private(set) var foodDescriptionNeedsPermission = false
    private var foodDescriptionTask: Task<Void, Never>?
    private var foodDescriptionGeneration = UUID()
    private var foodDescriptionRequest = (text: "", id: UUID())
    private var foodDescriptionResult: [String: Any]?
    private let analyseDescription: (String, UUID) async throws -> [String: Any]
    @Published var ambassadorsPresented = false
    private var addFoodSource: String?
    @Published private var mealRefinementSubmissions: Set<String> = []
    @Published private var mealRefinementMessages: [String: String] = [:]
    private var mealRefinementReviewKey: String { review["confirmationId"] as? String ?? "" }
    private struct MealRefinementJob {
        let eventID: String
        let accountRevision: Int
    }
    @Published private var mealRefinementJobs: [String: MealRefinementJob] = [:]
    private var mealRefinementProgress: NativeMealRefinementProgress? {
        guard let job = mealRefinementJobs[mealRefinementReviewKey],
              job.accountRevision == NudgeAccountManager.shared.revision else { return nil }
        let event = (history["events"] as? [[String: Any]] ?? []).first { $0["id"] as? String == job.eventID }
        return NativeMealRefinementProgress(event: event)
    }
    var mealRefinementSubmitting: Bool {
        mealRefinementSubmissions.contains(mealRefinementReviewKey) || mealRefinementProgress?.isAnalysing == true
    }
    var mealRefinementMessage: String? {
        mealRefinementMessages[mealRefinementReviewKey] ?? mealRefinementProgress?.message
    }
    @Published private(set) var recoveringProduct = false
    @Published private(set) var productRecoveryMessage: String?
    @Published var contributionContext: NativeProductContributionContext?
    @Published var missingProductBarcode: String?
    @Published var analysisFailure: String?
    @Published private(set) var ready = false
    let search = NativeProductSearchModel()
    let ratings = NativeProductRatingEngine()
    lazy var ratingLoader = NativeSearchRatingLoader(engine: ratings)
    lazy var capture = NativeCaptureCoordinator(store: self)
    var captureOutbox: NativeCaptureOutbox { NativeCaptureOutbox(directory: persistence.captureDirectory) }
    private var context: JSContext?
    private let persistence: NudgeDataStore
    private var openTask: Task<Void, Never>?
    private var openGeneration = UUID()
    private var scoreTask: Task<Void, Never>?
    private var scoreGeneration = UUID()
    private var lastNutritionDiagnostic = ""
    private let now: () -> Date
    private let lookupProduct: (String) async throws -> BarcodeProduct
    private struct ScreenProjection {
        let operation: String
        let value: [String: Any]
        let createdAt: Date
        let evidenceExpiresAt: Date
        var accessedAt: UInt64
    }
    private var screenProjections: [String: ScreenProjection] = [:]
    private var projectionAccess: UInt64 = 0
    private var historyScoreGeneration: UInt64 = 0
    var historyScoreRevision: String { String(historyScoreGeneration) + "|" + currentDay }
    private var reviewRevision: UInt64 = 0
    #if DEBUG
    private(set) var projectionEvaluations: [String: Int] = [:]
    #endif

    var savedCount: Int { (foods["foods"] as? [[String: Any]])?.count ?? 0 }

    func isProductSaved(_ product: BarcodeProduct) -> Bool {
        (foods["foods"] as? [[String: Any]] ?? []).contains { food in
            food["sourceKey"] as? String == "product:" + product.barcode ||
            (food["draft"] as? [String: Any])?["barcode"] as? String == product.barcode
        }
    }

    func toggleProductSaved(_ product: BarcodeProduct) {
        guard let object = productObject(product) else { return }
        _ = perform("foodsToggleProduct", ["product": object])
    }

    private var reviewSavedFoodID: String? {
        let candidates = foods["foods"] as? [[String: Any]] ?? []
        let entry = review["entry"] as? [String: Any] ?? [:]
        let meta = entry["sourceMeta"] as? [String: Any] ?? [:]
        let product = review["product"] as? [String: Any] ?? [:]
        let barcode = product["barcode"] as? String ?? entry["barcode"] as? String ?? ""
        // An opened saved portion owns its heart state, even after removal.
        // Do not fall through to another variant with the same barcode.
        if let id = review["savedFoodId"] as? String, !id.isEmpty {
            return (candidates.first { $0["id"] as? String == id }
                ?? candidates.first { $0["sourceKey"] as? String == "saved:" + id })?["id"] as? String
        }
        if let id = meta["repertoireId"] as? String, !id.isEmpty,
           let match = candidates.first(where: { $0["id"] as? String == id })
                ?? candidates.first(where: { $0["sourceKey"] as? String == "saved:" + id }) {
            return match["id"] as? String
        }
        for (prefix, value) in [("entry:", review["entryId"]), ("entry:", entry["id"]),
                                ("analysis:", review["eventId"]), ("analysis:", meta["scanEventId"]),
                                ("analysis:", meta["productScanEventId"]), ("draft:", review["confirmationId"])] {
            if let value = value as? String, !value.isEmpty,
               let id = candidates.first(where: { $0["sourceKey"] as? String == prefix + value })?["id"] as? String { return id }
        }
        guard !barcode.isEmpty else { return nil }
        if let id = candidates.first(where: { $0["sourceKey"] as? String == "product:" + barcode })?["id"] as? String { return id }
        // Older product favourites are projected with a legacy marker. A bare
        // barcode match must not select a separately saved meal or portion.
        return candidates.first {
            ($0["legacyProduct"] != nil || $0["legacyKey"] != nil) &&
            (($0["draft"] as? [String: Any])?["barcode"] as? String) == barcode
        }?["id"] as? String
    }
    var isReviewSaved: Bool { reviewSavedFoodID != nil }
    /// Uses one existing reusable-food action; it never confirms an eaten meal.
    @discardableResult
    func toggleReviewSaved() -> Bool {
        if let id = reviewSavedFoodID { return perform("foodsDelete", ["id": id]) }
        return perform("reviewSaveFood")
    }

    static var day: String { dayKey(Date()) }
    static func dayKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year,.month,.day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 2000, c.month ?? 1, c.day ?? 1)
    }

    init(store: NudgeDataStore = .shared, bundle: Bundle = .main, now: @escaping () -> Date = Date.init,
         lookupProduct: @escaping (String) async throws -> BarcodeProduct = { try await OpenFoodFactsService.catalogueConnected.lookup(barcode: $0) },
         analyseDescription: @escaping (String, UUID) async throws -> [String: Any] = { try await NativeFoodDescriptionService().analyse(description: $0, requestID: $1) }) {
        self.persistence = store
        self.now = now
        self.lookupProduct = lookupProduct
        self.analyseDescription = analyseDescription
        self.diaryDay = Self.dayKey(now())
        self.loggingDay = Self.dayKey(now())
        load(bundle: bundle)
        if ready {
            let events = history["events"] as? [[String: Any]] ?? []
            var resumable = Set<String>()
            for owner in Set(events.compactMap { $0["captureOwnerKey"] as? String }.filter { !$0.isEmpty }) {
                do { resumable.formUnion(try captureOutbox.records(owner: owner).filter { $0.status != .deleted }.map(\.eventID)) }
                catch {
                    // Locked/unreadable media is not proof that an original is lost.
                    resumable.formUnion(events.filter { $0["captureOwnerKey"] as? String == owner }.compactMap { $0["id"] as? String })
                }
            }
            _ = perform("historyInterruptPending", ["resumableIDs": Array(resumable)])
        }
        ratings.recoveredScore = { [weak self] product in
            guard let self, let data = try? JSONEncoder().encode(product),
                  let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
            var payload: [String: Any] = ["product": object]
            if let score = self.ratings.validatedQualityHold(for: product) ?? self.ratings.validatedDetailedCatalogueScore(for: product), let prepared = product.catalogueRating {
                payload["catalogueScore"] = score
                payload["catalogueCalculatedAt"] = prepared.calculatedAt.timeIntervalSince1970 * 1000
            }
            return self.project("productRating", payload)["score"] as? [String: Any]
        }
    }

    private func load(bundle: Bundle) {
        clearScreenProjections()
        guard let runtime = JSContext() else { errorMessage = "Nudge could not start. Reopen the app to try again."; return }
        let storage: @convention(block) (String) -> String = { [persistence] request in persistence.handle(request) }
        let storageWrite: @convention(block) (String, String) -> String = { [persistence] key, value in persistence.setValue(value, for: key) }
        let date: @convention(block) () -> String = { [now] in Self.dayKey(now()) }
        let timestamp: @convention(block) () -> String = { [now] in ISO8601DateFormatter().string(from: now()) }
        let diagnostic: @convention(block) (String, String, String) -> Void = { stage, outcome, metadata in
            let object = metadata.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
            AnalysisDiagnostics.shared.record(stage: stage, outcome: outcome, metadata: object)
        }
        let analysisUUID: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        runtime.setObject(analysisUUID, forKeyedSubscript: "__nudgeChatGPTUUID" as NSString)
        runtime.setObject(storage, forKeyedSubscript: "nativeStorage" as NSString)
        runtime.setObject(storageWrite, forKeyedSubscript: "nativeStorageWrite" as NSString)
        runtime.setObject(date, forKeyedSubscript: "nativeToday" as NSString)
        runtime.setObject(timestamp, forKeyedSubscript: "nativeNow" as NSString)
        runtime.setObject(diagnostic, forKeyedSubscript: "nativeDiagnostic" as NSString)
        runtime.evaluateScript("var window=globalThis;var document={addEventListener:function(){},getElementById:function(){return null;}};var location={protocol:'native:'};")
        let paths = ["streaks.js", "recipe-catalogue-data.js", "recipe-catalogue.js", "core/food-log.js", "core/diary.js", "core/nutrition-profile.js", "core/product-evidence.js", "core/nudge-score.js", "core/food-composition.js", "core/meal-recovery-data.js", "core/meal-recovery.js", "core/recipe-composition.js", "core/meal-score.js", "core/text-food-analysis.js", "food-detail-model.js", "core/frequency-policy.js", "core/analysis-result.js", "core/chatgpt-analysis.js", "core/fast-food-capture.js", "scan-results.js", "today-goals.js", "cycle-support.js", "search-model.js", "diet.js", "scan-history.js", "repertoire.js", "native-review.js", "native-session.js", "food-catalogue.js"]
        for path in paths {
            guard let url = bundle.resourceURL?.appendingPathComponent("Web/" + path),
                  let script = try? String(contentsOf: url, encoding: .utf8) else {
                errorMessage = "A required Nudge component is missing. Your saved data is unchanged."; return
            }
            runtime.evaluateScript(script, withSourceURL: url)
            if runtime.exception != nil {
                #if DEBUG
                print("Native core failed loading \(path): \(runtime.exception?.toString() ?? "unknown")")
                #endif
                errorMessage = "Nudge could not open its food calculations. Your data is unchanged."; return
            }
        }
        context = runtime
        if let value = invoke("init", [["nativeHistory": true]]) { accept(value); ready = value["readFailed"] as? Bool != true }
        AnalysisDiagnostics.shared.record(stage: "app", outcome: "started", metadata: ["screen": "today"])
    }

    var photoAnalysisServiceText: String {
        do { _ = try ChatGPTConnection.shared.cameraSelectionForCapture() }
        catch { return "Unlock your iPhone and reopen ChatGPT settings before choosing the photo analysis service." }
        if let label = ChatGPTConnection.shared.cameraSelectionLabel {
            return "Uses ChatGPT: " + label + ". Photos and ingredient hints use this account’s plan."
        }
        return "Uses Nudge’s service for photo analysis."
    }

    /// Pure extraction bridge: no History mutation and no credentials or images
    /// enter JavaScript. Only validated, locally calculated output may be saved.
    private func chatGPTAdapter(_ method: String, _ input: [String: Any]) throws -> [String: Any] {
        guard let context else { throw ChatGPTFailure.incomplete }
        context.exception = nil
        let result = context.objectForKeyedSubscript("NudgeChatGPTAnalysis")?.invokeMethod(method, withArguments: [input])
        guard context.exception == nil, let value = result?.toDictionary() as? [String: Any] else {
            context.exception = nil
            throw ChatGPTFailure.incomplete
        }
        return value
    }
    private func chatGPTInput(for record: NativeCaptureRecord) throws -> [String: Any] {
        var input: [String: Any] = ["photoIds": record.photoIDs, "captureRevision": record.captureRevision]
        if record.fastCaptureVersion == 1 { input["analysisPolicy"] = ["version": 1, "mode": "fast"] }
        if let hints = record.mealHints { input["mealHints"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hints)) }
        return input
    }
    func chatGPTPhotoRequest(record: NativeCaptureRecord, images: [Data]) throws -> [String: Any] {
        guard record.chatGPTBinding != nil, record.hasValidAnalysisRoute, (1...4).contains(images.count),
              images.count == record.photoIDs.count, images.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }) else { throw ChatGPTFailure.invalidPhoto }
        let contract = try chatGPTAdapter("request", chatGPTInput(for: record))
        guard let instructions = contract["instructions"] as? String, let schema = contract["schema"] as? [String: Any] else { throw ChatGPTFailure.incomplete }
        var content: [[String: Any]] = []
        if let hints = contract["inputText"] as? String, !hints.isEmpty { content.append(["type": "input_text", "text": hints]) }
        for (index, image) in images.enumerated() {
            content.append(["type": "input_text", "text": "PHOTO \(index + 1)"])
            content.append(["type": "input_image", "image_url": "data:image/jpeg;base64," + image.base64EncodedString()])
        }
        var request: [String: Any] = ["instructions": instructions, "input": [["role": "user", "content": content]],
                "text": ["format": ["type": "json_schema", "name": "nudge_photo_analysis", "strict": true, "schema": schema]]]
        if record.fastCaptureVersion == 1, let binding = record.chatGPTBinding,
           let reasoning = ChatGPTCapturePolicy.reasoning(modelID: binding.modelID) {
            request["reasoning"] = reasoning
        }
        return request
    }
    func finishChatGPTPhoto(text: String, record: NativeCaptureRecord) throws -> [String: Any] {
        guard text.utf8.count <= 2_000_000 else { throw ChatGPTFailure.incomplete }
        var input = try chatGPTInput(for: record); input["text"] = text
        return try chatGPTAdapter("finish", input)
    }
    func localFoodCapture(pages: [FoodOCRPage], label: FoodLocalLabel?, record: NativeCaptureRecord) throws -> [String: Any] {
        guard let context, pages.count == record.photoIDs.count else { throw ChatGPTFailure.incomplete }
        var input = try chatGPTInput(for: record)
        input.removeValue(forKey: "analysisPolicy")
        input["requestId"] = record.submissionID.uuidString
        input["pages"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(pages))
        if let label { input["label"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(label)) }
        context.exception = nil
        let result = context.objectForKeyedSubscript("NudgeFastCapture")?.invokeMethod("localCapture", withArguments: [input])
        guard context.exception == nil, let value = result?.toDictionary() as? [String: Any],
              ["ready", "partial", "fallback"].contains(value["status"] as? String ?? "") else {
            context.exception = nil; throw ChatGPTFailure.incomplete
        }
        return value
    }

    func captureCardAppeared(eventID: String) {
        guard !eventID.isEmpty, review["eventId"] as? String == eventID else { return }
        CapturePerformance.shared.visible(eventID: eventID)
    }

    private func invoke(_ method: String, _ arguments: [Any]) -> [String: Any]? {
        guard let context else { return nil }
        #if DEBUG
        if method == "project", let operation = arguments.first as? String { projectionEvaluations[operation, default: 0] += 1 }
        #endif
        context.exception = nil
        // Mutations return only acknowledged changes. In particular, editing a
        // draft must not reread and bridge the entire history on every keystroke.
        let input = method == "perform" ? arguments + [true, true] : arguments
        let value = context.objectForKeyedSubscript("NudgeNativeSession")?.invokeMethod(method, withArguments: input)
        guard context.exception == nil, let result = value?.toDictionary() as? [String: Any] else {
            clearScreenProjections()
            #if DEBUG
            print("Native core \(method): \(context.exception?.toString() ?? "invalid result")")
            #endif
            let message = "This action could not finish. Your saved records have been kept."
            // Projections can run while SwiftUI renders. Never publish synchronously
            // from a failed body evaluation, and coalesce repeat failures.
            Task { @MainActor [weak self] in
                if self?.errorMessage != message { self?.errorMessage = message }
            }
            AnalysisDiagnostics.shared.record(stage: "ui_error", outcome: "render_failed")
            return nil
        }
        // A failed write can change an in-memory error or recovery journal even
        // when no durable record was acknowledged. Never hide that behind a hit.
        if method == "perform", result["ok"] as? Bool == false { clearScreenProjections() }
        if method == "perform", let operation = arguments.first as? String,
           ["historyRetry", "historyDismissUndo", "historyUndo"].contains(operation) {
            invalidateProjections(changed: ["history"])
        }
        return result
    }
    private func accept(_ value: [String: Any]) {
        invalidateProjections(changed: Set(["state", "history", "foods", "review"].filter { value[$0] != nil }))
        if let value = value["state"] as? [String: Any] { state = value }
        if let value = value["history"] as? [String: Any] { history = value }
        if let value = value["foods"] as? [String: Any] { foods = value }
        if let value = value["review"] as? [String: Any] { reviewRevision &+= 1; review = value }
        if let message = value["message"] as? String, !message.isEmpty { notice = message }
        if value["readFailed"] as? Bool == true { errorMessage = value["message"] as? String }
        if value["state"] != nil { reportNutritionCompleteness() }
    }
    private func invalidateProjections(changed: Set<String>) {
        guard !changed.isEmpty else { return }
        if !changed.isDisjoint(with: ["state", "history"]) { historyScoreGeneration &+= 1 }
        screenProjections = screenProjections.filter { _, cached in
            let dependencies: Set<String>
            switch cached.operation {
            case "reviewModel": dependencies = ["state", "review"]
            case "cycle": dependencies = ["state"]
            case "history": dependencies = ["state", "history", "foods"]
            default: dependencies = ["state", "history"]
            }
            return dependencies.isDisjoint(with: changed)
        }
    }
    /// A screen is valid until its acknowledged inputs, local day or evidence
    /// deadline change. Returning to the foreground explicitly drops derived
    /// views, rather than making every fifth second of scrolling a cache miss.
    func refreshPresentation() {
        clearScreenProjections()
        objectWillChange.send()
    }
    func releasePresentationMemory() {
        clearScreenProjections()
    }
    private func clearScreenProjections() {
        screenProjections.removeAll()
        historyScoreGeneration &+= 1
    }
    func project(_ operation: String, _ payload: [String: Any] = [:]) -> [String: Any] {
        // SwiftUI reevaluates bodies for navigation, camera and loading changes.
        // Reuse acknowledged screen data without re-scoring or bridging it, but
        // leave recovery, rating and record lookup operations uncached.
        guard ["today", "diary", "history", "historyScore", "reviewModel", "cycle", "pendingEaten"].contains(operation),
              operation != "history" || payload["presentation"] as? Bool == true,
              JSONSerialization.isValidJSONObject(payload),
              let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), encoded.count < 16_384,
              let signature = String(data: encoded, encoding: .utf8) else { return invoke("project", [operation, payload]) ?? [:] }
        let stamp = now(), key = operation + "|" + currentDay + "|" + signature
        projectionAccess &+= 1
        if var cached = screenProjections[key], stamp >= cached.createdAt, Date() < cached.evidenceExpiresAt {
            cached.accessedAt = projectionAccess; screenProjections[key] = cached
            return cached.value
        }
        var input = payload; input["nativeCache"] = true
        guard var result = invoke("project", [operation, input]) else { return [:] }
        let deadline = (result.removeValue(forKey: "nativeCacheUntil") as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } ?? .distantFuture
        if operation == "historyScore", deadline != .distantFuture {
            result["presentationRefreshAt"] = deadline.timeIntervalSince1970
        }
        if result["storageError"] as? Bool != true, result["readFailed"] as? Bool != true,
           result["operationError"] as? Bool != true,
           (result["operationError"] as? String ?? "").isEmpty, Date() < deadline {
            screenProjections[key] = ScreenProjection(operation: operation, value: result, createdAt: stamp,
                evidenceExpiresAt: deadline, accessedAt: projectionAccess)
            // Keep visible-row scores separately bounded, so scrolling does not
            // evict Today/Diary models or accumulate the whole archive in Swift.
            let rowScore = operation == "historyScore"
            let candidates = screenProjections.filter { ($0.value.operation == "historyScore") == rowScore }
            if candidates.count > (rowScore ? 64 : 8), let oldest = candidates.min(by: { $0.value.accessedAt < $1.value.accessedAt })?.key {
                screenProjections.removeValue(forKey: oldest)
            }
        }
        return result
    }
    @discardableResult
    func perform(_ operation: String, _ payload: [String: Any] = [:]) -> Bool {
        let confirmingDescription = operation == "reviewConfirm" && (review["confirmationId"] as? String ?? "").hasPrefix("typed-food:")
        if operation == "showSaved" {
            if route != "diary" { setLoggingDestination() }
            route = "saved"; return true
        }
        if operation == "openRecipe" { recipeID = payload["id"] as? String; route = "recipe"; return true }
        var input = payload
        if operation == "recipeLog" {
            input["confirmationId"] = UUID().uuidString
            input["day"] = loggingDay; input["slot"] = loggingMeal
        }
        guard let value = invoke("perform", [operation, input]) else { return false }
        accept(value)
        let ok = value["ok"] as? Bool == true
        if !ok {
            let message = value["message"] as? String ?? ""
            errorMessage = message.isEmpty ? "This change could not be saved. Please try again." : message
        }
        if ok && operation == "historyDelete", let id = payload["id"] as? String { capture.historyDeleted(id) }
        if ok && ["historyUndo", "historyDismissUndo"].contains(operation) { capture.resumePending() }
        if ok && operation == "reviewConfirm" {
            if confirmingDescription {
                foodDescription = ""; foodDescriptionResult = nil
                foodDescriptionRequest = ("", UUID())
            }
            let draft = project("reviewModel")["draft"] as? [String: Any] ?? [:]
            let destination = draft["day"] as? String ?? loggingDay
            cancelProductRecovery(); capture.complete(ifReviewEventID: review["eventId"] as? String)
            openDiary(day: destination)
            notice = "Saved to " + NativeTrackingDisplay.dateLabel(destination, format: "EEE d MMM yyyy")
        }
        if ok && operation == "recipeLog" {
            if route != "review" { reviewReturnRoute = route }
            route = "review"
        }
        return ok
    }
    func navigate(_ tab: String) {
        if tab == "camera" { startCamera(); return }
        if tab == "describeFood" { showFoodDescription(); return }
        guard ["today","history","search","you"].contains(tab) else { return }
        cancelFoodDescriptionAnalysis()
        cancelProductRecovery()
        openTask?.cancel(); openTask = nil; openGeneration = UUID(); loading = false
        route = nil; selectedTab = tab
        setLoggingDestination()
        if tab != "search" { search.cancel(); ratingLoader.cancel() }
        AnalysisDiagnostics.shared.record(stage: "navigation", outcome: "opened", metadata: ["screen": tab])
    }
    func showProfile() { navigate("you") }
    func showCycle() { route = "cycle" }
    func showAccount() { capture.showAccount() }
    func showDiagnostics() { capture.showDiagnostics() }
    func showAISettings() { capture.showAISettings() }
    var currentDay: String { Self.dayKey(now()) }
    private func setLoggingDestination(day: String? = nil, meal: String? = nil) {
        loggingDay = day ?? currentDay
        // Retain legacy destinations when reopening saved work; new logging is date-only.
        loggingMeal = ["Breakfast", "Lunch", "Dinner", "Snack"].contains(meal ?? "") ? meal! : ""
    }
    func openDiary(day: String) {
        cancelPendingReviewOpen()
        cancelProductRecovery()
        diaryDay = day; selectedTab = "today"; route = "diary"
        setLoggingDestination(day: day)
    }
    func closeDiary() { route = nil; selectedTab = "today"; setLoggingDestination() }
    func showFoodLibrary(mode: String, day: String? = nil, meal: String? = nil) {
        setLoggingDestination(day: day ?? (route == "diary" ? diaryDay : currentDay), meal: meal)
        foodLibraryMode = mode == "favourites" ? "favourites" : "recents"
        route = "foodLibrary"
    }
    func showAddFood(day: String? = nil, meal: String? = nil) {
        setLoggingDestination(day: day ?? (route == "diary" ? diaryDay : currentDay), meal: meal)
        addFoodSource = nil
        addFoodPresented = true
    }
    func chooseAddFood(_ source: String) {
        guard ["camera", "description", "favourites", "history"].contains(source), addFoodPresented else { return }
        addFoodSource = source
        addFoodPresented = false
    }
    /// UIKit camera presentation begins after the SwiftUI chooser has dismissed.
    func completeAddFoodSelection() {
        guard let source = addFoodSource else { return }
        addFoodSource = nil
        if source == "camera" { startCamera(day: loggingDay, meal: loggingMeal) }
        else if source == "description" { showFoodDescription(day: loggingDay) }
        else { showFoodLibrary(mode: source == "favourites" ? "favourites" : "recents", day: loggingDay, meal: loggingMeal) }
    }
    func showFoodDescription(day: String? = nil) {
        cancelPendingReviewOpen(); cancelProductRecovery(); cancelFoodDescriptionAnalysis()
        setLoggingDestination(day: day ?? (route == "diary" ? diaryDay : currentDay))
        route = "foodDescription"
        foodDescriptionError = nil; foodDescriptionNeedsSignIn = false; foodDescriptionNeedsPermission = false
    }
    func cancelFoodDescriptionAnalysis() {
        foodDescriptionTask?.cancel(); foodDescriptionTask = nil
        foodDescriptionGeneration = UUID(); describingFood = false
    }
    func analyseFoodDescription() {
        guard route == "foodDescription", !describingFood else { return }
        let text = foodDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard NativeFoodDescriptionService.validDescription(text) else {
            foodDescriptionError = NativeFoodDescriptionService.Failure.invalidDescription.localizedDescription; return
        }
        foodDescriptionError = nil; foodDescriptionNeedsSignIn = false; foodDescriptionNeedsPermission = false
        if foodDescriptionRequest.text != text {
            foodDescriptionRequest = (text, UUID()); foodDescriptionResult = nil
        }
        let requestID = foodDescriptionRequest.id
        let payload: [String: Any] = ["description": text, "requestId": requestID.uuidString.lowercased()]
        let day = loggingDay
        if let cached = foodDescriptionResult {
            openFoodDescriptionResult(cached, request: payload, day: day); return
        }
        let local = project("textFoodPreview", payload)
        if local["entry"] is [String: Any] {
            openFoodDescriptionResult(local, request: payload, day: day); return
        }
        guard PhotoAnalysisPermission().allowed else {
            foodDescriptionNeedsPermission = true
            foodDescriptionError = NativeFoodDescriptionService.Failure.permission.localizedDescription; return
        }
        let generation = UUID(); foodDescriptionGeneration = generation
        let revision = NudgeAccountManager.shared.revision
        describingFood = true
        foodDescriptionTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await analyseDescription(text, requestID)
                try Task.checkCancellation()
                guard foodDescriptionGeneration == generation, route == "foodDescription",
                      foodDescriptionRequest.text == text, NudgeAccountManager.shared.revision == revision,
                      PhotoAnalysisPermission().allowed else { throw CancellationError() }
                describingFood = false; foodDescriptionTask = nil
                openFoodDescriptionResult(result, request: payload, day: day)
            } catch {
                guard foodDescriptionGeneration == generation else { return }
                describingFood = false; foodDescriptionTask = nil
                guard !(error is CancellationError), !Task.isCancelled, route == "foodDescription" else { return }
                let failure = error as? NativeFoodDescriptionService.Failure ?? .unavailable
                foodDescriptionNeedsSignIn = if case .signIn = failure { true } else { false }
                foodDescriptionNeedsPermission = if case .permission = failure { true } else { false }
                foodDescriptionError = failure.localizedDescription
            }
        }
    }
    private func openFoodDescriptionResult(_ result: [String: Any], request: [String: Any], day: String) {
        let checked = project("textFoodValidate", ["result": result, "request": request])
        guard var entry = checked["entry"] as? [String: Any], let id = request["requestId"] as? String else {
            foodDescriptionError = NativeFoodDescriptionService.Failure.invalidResponse.localizedDescription; return
        }
        foodDescriptionResult = checked
        entry["day"] = day; entry["slot"] = ""
        setReview(["kind": "entry", "entry": entry, "day": day, "slot": "", "confirmationId": "typed-food:" + id])
    }
    func showAmbassadors() { ambassadorsPresented = true }
    func startCamera(repair: Bool = false, day: String? = nil, meal: String? = nil) {
        cancelFoodDescriptionAnalysis()
        cancelPendingReviewOpen()
        if repair {
            let draft = project("reviewModel")["draft"] as? [String: Any] ?? [:]
            setLoggingDestination(day: draft["day"] as? String, meal: draft["slot"] as? String)
        } else {
            setLoggingDestination(day: day ?? (route == "diary" ? diaryDay : currentDay), meal: meal)
        }
        cancelProductRecovery(); capture.start(repair: repair)
    }
    private var reviewPhotoReferences: [String] {
        Array((review["photos"] as? [String] ?? []).filter {
            $0.range(of: #"^nudge-photo:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jpg$"#, options: .regularExpression) != nil
        }.prefix(4))
    }
    var reviewHasPhotos: Bool { !reviewPhotoReferences.isEmpty }
    /// Snapshot the user's choices and original photos into the same durable
    /// queue as the camera. Completion never moves the current screen.
    func reanalyseReviewWithIngredients() {
        let key = mealRefinementReviewKey
        guard !key.isEmpty, !mealRefinementSubmitting else { return }
        if mealRefinementMessages.count > 20 { mealRefinementMessages = mealRefinementMessages.filter { mealRefinementSubmissions.contains($0.key) } }
        if mealRefinementJobs.count > 20 { mealRefinementJobs = mealRefinementJobs.filter { mealRefinementSubmissions.contains($0.key) } }
        mealRefinementJobs[key] = nil
        mealRefinementMessages[key] = nil
        guard PhotoAnalysisPermission().allowed else {
            mealRefinementMessages[key] = "AI analysis is off. Enable it in You → Settings to analyse your photos."
            return
        }
        let model = project("reviewModel")
        guard let builder = model["mealBuilder"] as? [String: Any],
              let names = builder["selected"] as? [String], !names.isEmpty else {
            mealRefinementMessages[key] = "Select the ingredients you know are in this meal first."
            return
        }
        var portion: NativeMealAnalysisHints.Portion?
        if let value = builder["portion"] as? [String: Any],
           let amount = value["amount"] as? Double, let unit = value["unit"] as? String {
            portion = .init(amount: amount, unit: unit)
        }
        let hints = NativeMealAnalysisHints(ingredients: names, portion: portion)
        let references = reviewPhotoReferences
        guard hints.isValid, !references.isEmpty else {
            mealRefinementMessages[key] = "Add a photo to analyse this meal with your selected ingredients."
            return
        }
        let repair = captureRepairContext(review), draft = model["draft"] as? [String: Any] ?? [:]
        let accountRevision = NudgeAccountManager.shared.revision
        mealRefinementSubmissions.insert(key); mealRefinementMessages[key] = "Preparing analysis…"
        Task { [weak self, persistence] in
            let images = await Task.detached(priority: .userInitiated) {
                references.compactMap { persistence.photoData(for: $0) }
            }.value
            guard let self else { return }
            defer { mealRefinementSubmissions.remove(key) }
            guard NudgeAccountManager.shared.revision == accountRevision, PhotoAnalysisPermission().allowed else {
                mealRefinementMessages[key] = "Your account or AI permission changed. Please try again."
                return
            }
            guard images.count == references.count else {
                mealRefinementMessages[key] = "These photos could not be opened. Add a new photo and try again."
                return
            }
            guard capture.enqueueMealRefinement(images: images, hints: hints, repair: repair,
                day: draft["day"] as? String, meal: draft["slot"] as? String, addToEaten: false, onQueued: { eventID in
                    self.mealRefinementJobs[key] = MealRefinementJob(eventID: eventID, accountRevision: accountRevision)
                }) else {
                mealRefinementMessages[key] = "This meal could not be queued. Your food and ingredient choices are unchanged."
                return
            }
            // Leave only the originating review after the durable queue write.
            // Another card opened during photo loading must remain untouched.
            mealRefinementMessages[key] = nil
            let originatingReviewStillOpen = route == "review" && mealRefinementReviewKey == key
            if originatingReviewStillOpen { dismissReview() }
            acknowledgeAnalysis(showHistory: originatingReviewStillOpen)
        }
    }
    func acknowledgeAnalysis(showHistory: Bool = true) {
        if showHistory {
            analysisHistoryRevealRevision += 1
            navigate("history")
        }
        analysisAcknowledgementTask?.cancel()
        analysisAcknowledgement = "Analysing… Track progress in History."
        analysisAcknowledgementTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self?.analysisAcknowledgement = nil
        }
    }
    func reanalyseReviewPhotos() {
        let references = reviewPhotoReferences
        guard !references.isEmpty, !loading else { return }
        guard PhotoAnalysisPermission().allowed else {
            analysisFailure = "AI analysis is off. Enable it in You → Settings to analyse your photos."
            return
        }
        cancelProductRecovery(); openTask?.cancel()
        let generation = UUID(), revision = reviewRevision, repair = review
        let accountRevision = NudgeAccountManager.shared.revision
        openGeneration = generation; loading = true; analysisFailure = nil
        openTask = Task { [weak self, persistence] in
            let images = await Task.detached(priority: .userInitiated) {
                references.compactMap { persistence.photoData(for: $0) }
            }.value
            guard let self, !Task.isCancelled, openGeneration == generation else { return }
            loading = false; openTask = nil
            guard reviewRevision == revision, route == "review", NudgeAccountManager.shared.revision == accountRevision else { return }
            guard images.count == references.count else {
                analysisFailure = "These saved photos could not be opened. The food is unchanged. Try again, or add new photos."
                return
            }
            let draft = repair["draft"] as? [String: Any] ?? [:]
            setLoggingDestination(day: draft["day"] as? String, meal: draft["slot"] as? String)
            guard capture.enqueueSavedPhotoAnalysis(images: images, repair: repair,
                day: loggingDay, meal: loggingMeal) else {
                analysisFailure = "These photos could not be queued. Your saved food is unchanged."
                return
            }
            dismissReview()
            acknowledgeAnalysis()
        }
    }
    func retryOpening() { context = nil; errorMessage = nil; load(bundle: .main) }
    private func cancelPendingReviewOpen() {
        guard openTask != nil else { return }
        openTask?.cancel(); openTask = nil; openGeneration = UUID(); loading = false
    }
    func cancelLoading() {
        if openTask != nil { cancelPendingReviewOpen() }
        else { capture.cancelAnalysis() }
    }
    func dismissReview() {
        cancelFoodDescriptionAnalysis()
        cancelProductRecovery(); route = route == "review" ? reviewReturnRoute : nil
        loading = false; openTask?.cancel(); openGeneration = UUID()
    }

    private func setReview(_ value: [String: Any]) {
        cancelProductRecovery()
        var input = value
        if input["entryId"] == nil {
            if input["day"] == nil { input["day"] = loggingDay }
            if input["slot"] == nil { input["slot"] = loggingMeal }
        }
        if input["confirmationId"] == nil { input["confirmationId"] = UUID().uuidString }
        if route != "review" { reviewReturnRoute = route }
        if perform("setReview", input) { route = "review"; recoverProductIfNeeded() }
    }
    func openProduct(_ snapshot: BarcodeProduct) {
        openTask?.cancel(); let generation = UUID(); openGeneration = generation
        // Catalogue search already supplies the full, source-bound record.
        // Re-fetching that same barcode delays opening a card for no new facts.
        // Older external discovery snippets still use the hydration path below.
        if snapshot.searchProvider == nil, snapshot.hasTrustedCatalogueSource,
           let expiry = snapshot.catalogueSourceExpiresAt, expiry > now() {
            openTask = nil; loading = false; analysisFailure = nil
            receiveProduct(ratings.preferredProduct(for: snapshot),
                           eventID: "search-product:" + UUID().uuidString, origin: "search")
            return
        }
        loading = true; analysisFailure = nil
        openTask = Task { [weak self] in
            guard let self else { return }
            var product = snapshot
            do {
                let fetched = try await lookupProduct(snapshot.barcode)
                product = ratings.preferredProduct(for: snapshot, fullProduct: fetched)
                ProductLookupCache.shared.write(product, now: Date())
            }
            catch is CancellationError { return }
            catch { /* Retain the source-labelled snapshot; missing facts remain missing. */ }
            guard !Task.isCancelled, openGeneration == generation else { return }
            loading = false; openTask = nil
            receiveProduct(product, eventID: "search-product:" + UUID().uuidString, origin: "search")
        }
    }
    func openProductFacts(_ facts: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: facts),
              let product = try? JSONDecoder().decode(BarcodeProduct.self, from: data) else {
            errorMessage = "This product could not be opened. Try finding it in Search."; return
        }
        openProduct(product)
    }
    func applyRecallAssessment(product: [String: Any], assessment: [String: Any]) {
        guard let current = review["product"] as? [String: Any],
              (current["barcode"] as? String ?? "") == (product["barcode"] as? String ?? ""),
              (current["name"] as? String ?? "") == (product["name"] as? String ?? ""),
              (current["brand"] as? String ?? "") == (product["brand"] as? String ?? ""),
              NativeProductContextRules.identity(product: current, profile: [:], avoidMilk: false) == NativeProductContextRules.identity(product: product, profile: [:], avoidMilk: false) else { return }
        if let value = invoke("perform", ["reviewRecall", ["barcode":current["barcode"] ?? "", "name":current["name"] ?? "", "brand":current["brand"] ?? "", "assessment":assessment]]) { accept(value) }
    }
    func productObject(_ product: BarcodeProduct) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(product), var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let score = ratings.validatedQualityHold(for: product) ?? ratings.validatedDetailedCatalogueScore(for: product), let catalogueRating = product.catalogueRating,
           let prepared = project("productWithCatalogueScore", ["product": object, "score": score,
                "expiresAt": catalogueRating.expiresAt.timeIntervalSince1970 * 1000,
                "calculatedAt": catalogueRating.calculatedAt.timeIntervalSince1970 * 1000])["product"] as? [String: Any] {
            object = prepared
        }
        return object
    }
    /// Scanning records an observation, never an eaten portion or a navigation.
    func recordScannedProduct(_ product: BarcodeProduct, eventID: String, origin: String? = nil) -> [String: Any]? {
        guard let object = productObject(product) else { return nil }
        var event: [String: Any] = ["id":eventID,"kind":"product","status":"ready","name":product.name,"barcode":product.barcode,"product":object]
        if let origin { event["origin"] = origin }
        guard perform("recordHistory", event) else { return nil }
        return object
    }
    func scannedProductModel(_ product: [String: Any]) -> [String: Any] {
        project("productScanModel", ["product": product])
    }
    /// Resolve a burst of pending observations with one acknowledged History
    /// write. Every original row keeps its identity, date, destination and media.
    func recordScannedProducts(_ product: BarcodeProduct, eventIDs: [String]) -> [String: Any]? {
        guard !eventIDs.isEmpty, eventIDs.count <= 500, Set(eventIDs).count == eventIDs.count,
              let object = productObject(product) else { return nil }
        guard perform("recordScannedProducts", ["eventIDs": eventIDs, "product": object]) else { return nil }
        return object
    }
    func openScannedProduct(_ product: [String: Any], eventID: String, day: String? = nil, meal: String? = nil) {
        if let day { setLoggingDestination(day: day, meal: meal) }
        setReview(["kind":"product","product":product,"eventId":eventID])
    }
    func receiveProduct(_ product: BarcodeProduct, eventID: String, origin: String? = nil) {
        guard let object = recordScannedProduct(product, eventID: eventID, origin: origin) else { return }
        openScannedProduct(object, eventID: eventID)
    }
    /// Capture the exact edited intake before a delayed analysis begins. A
    /// later result may update it only while this snapshot remains unchanged.
    func captureRepairContext(_ repair: [String: Any]) -> [String: Any] {
        // A photo read or queue write may run later. Never replace the frozen
        // consent snapshot with a newer edit made while that work was pending.
        // Even malformed existing snapshots stay fail-closed for review.
        if repair["queuedEntrySnapshot"] != nil { return repair }
        var value = repair
        if let id = repair["entryId"] as? String {
            let entry = ((state["foodLog"] as? [String: Any])?["entries"] as? [[String: Any]])?.first(where: { $0["id"] as? String == id })
            // Missing is also a frozen result. A restore during photo loading
            // cannot authorise overwriting a newer same-ID intake.
            if let entry { value["queuedEntrySnapshot"] = entry }
            else { value["queuedEntrySnapshot"] = NSNull() }
        }
        return value
    }
    /// Adds only the acknowledged capture result, without replacing an open
    /// draft or navigating. Diary and replay claim commit atomically together.
    func addCaptureToEaten(eventID: String, generation: Int, ownerKey: String) -> String {
        guard let value = invoke("perform", ["captureAddToEaten", ["eventID": eventID, "generation": generation, "ownerKey": ownerKey]]) else { return "saveFailed" }
        accept(value)
        return value["status"] as? String ?? "saveFailed"
    }
    /// A queued card may be swiped just as its result arrives. Remove only the
    /// newly-created intake claimed by that exact capture; preserve repairs.
    func removeCaptureIntakeIfAdded(eventID: String, generation: Int, ownerKey: String) -> Bool {
        guard let value = invoke("perform", ["captureRemoveIntake", ["eventID": eventID, "generation": generation, "ownerKey": ownerKey]]) else { return false }
        accept(value)
        if value["ok"] as? Bool != true {
            let message = value["message"] as? String ?? ""
            errorMessage = message.isEmpty ? "This food could not be removed. Try again." : message
        }
        return value["ok"] as? Bool == true
    }
    func saveAnalysisPhotos(_ photos: [Data]) throws -> [String] { try persistence.savePhotos(photos) }

    @discardableResult
    func receiveAnalysis(_ extraction: [String: Any], eventID: String, thumbnail: String?, repair: [String: Any]? = nil, day: String? = nil, meal: String? = nil, photos: [Data] = [], savedPhotos: [String] = [], openReview: Bool = true) -> Bool {
        let photoReferences: [String]
        do { photoReferences = savedPhotos.isEmpty ? try persistence.savePhotos(photos) : savedPhotos }
        catch { analysisFailure = "Your photos could not be saved. Return to the camera and try again."; return false }
        var event: [String: Any] = ["id":eventID,"kind":extraction["type"] as? String == "product" ? "product":"meal","status":"ready","name":extraction["productName"] as? String ?? (extraction["meal"] as? [String: Any])?["name"] as? String ?? "Your food","extraction":extraction,"thumbnail":thumbnail ?? "", "photos":photoReferences, "loggingDay":day ?? loggingDay, "loggingMeal":meal ?? loggingMeal]
        if let repair {
            event["repairEntryId"] = repair["entryId"]
            event["repairEntrySnapshot"] = repair["queuedEntrySnapshot"]
            event["repairProduct"] = repair["product"]
            event["repairPortion"] = (repair["draft"] as? [String: Any])?["portion"]
        }
        guard perform("recordHistory", event) else { return false }
        guard openReview else { return true }
        if let day { setLoggingDestination(day: day, meal: meal) }
        var input: [String: Any] = ["kind":"analysis","extraction":extraction,"eventId":eventID,"thumbnail":thumbnail ?? "", "photos":photoReferences, "day":loggingDay, "slot":loggingMeal]
        if let repair {
            input["entryId"] = repair["entryId"]; input["previousReview"] = repair
            input["previousProduct"] = repair["product"]
            if let product = repair["product"] as? [String: Any] {
                input["context"] = ["barcode": product["barcode"] ?? "", "source": "barcode-label"]
            }
        }
        setReview(input)
        return true
    }
    func openEntry(_ entry: [String: Any]) {
        guard let id = entry["id"] as? String else { return }
        if let source = project("historyItem", ["entryId":id])["row"] as? [String: Any] {
            openHistory(source); return
        }
        // A displayed summary may outlive a deletion. It must never become a
        // new intake draft assembled from the few fields left in the list.
        if entry["presentationOnly"] as? Bool == true { return }
        setReview(["kind":"entry","entry":entry,"entryId":id])
    }
    func openHistory(_ displayed: [String: Any]) {
        let event: [String: Any]
        if displayed["presentationOnly"] as? Bool == true {
            guard let id = displayed["id"] as? String,
                  let saved = project("historyItem", ["id":id])["row"] as? [String: Any] else { return }
            event = saved
        } else { event = displayed }
        let hasProduct = (event["product"] as? [String: Any])?.isEmpty == false
        let hasExtraction = event["extraction"] is [String: Any]
        if ["draft", "needsUserInput"].contains(event["processingState"] as? String ?? ""), capture.retryHistory(event) { return }
        if !hasProduct && !hasExtraction,
           event["status"] as? String != "pending", capture.retryHistory(event) { return }
        // A pending public refresh must not block the facts already saved offline.
        if event["status"] as? String == "pending", !hasProduct && !hasExtraction {
            notice = "Analysing in the background. Your result will appear here when ready."
            return
        }
        var repair: [String: Any] = [:]
        if let entryID = event["repairEntryId"] as? String, !entryID.isEmpty { repair["entryId"] = entryID }
        if let product = event["repairProduct"] as? [String: Any] { repair["product"] = product }
        if let portion = event["repairPortion"] as? [String: Any] { repair["draft"] = ["portion":portion] }
        if !repair.isEmpty, let extraction = event["extraction"] as? [String: Any] {
            var input: [String: Any] = ["kind":"analysis", "extraction":extraction,
                "eventId":event["id"] ?? "", "thumbnail":event["thumbnail"] ?? "", "photos":event["photos"] ?? [],
                "previousReview":repair]
            input["entryId"] = repair["entryId"]; input["previousProduct"] = repair["product"]
            if let product = repair["product"] as? [String: Any] {
                input["context"] = ["barcode":product["barcode"] ?? "", "source":"barcode-label"]
            }
            if let day = event["loggingDay"] as? String, !day.isEmpty { setLoggingDestination(day: day, meal: event["loggingMeal"] as? String) }
            setReview(input); return
        }
        let linked = event["entry"] as? [String: Any]
        if let linked {
            var value: [String: Any] = ["kind":"entry", "entry":linked, "entryId":linked["id"] ?? "", "eventId":event["id"] ?? "", "thumbnail":event["imageURL"] ?? event["thumbnail"] ?? "", "photos":event["photos"] ?? []]
            if let product = event["product"] as? [String: Any], !product.isEmpty {
                value["kind"] = "product"; value["product"] = product
            }
            // Meal snapshots reopen as exact saved intake; editing ingredients is explicit.
            setReview(value); return
        }
        let id = event["id"] as? String ?? UUID().uuidString
        if let day = event["loggingDay"] as? String, !day.isEmpty {
            setLoggingDestination(day: day, meal: event["loggingMeal"] as? String)
        }
        if let product = event["product"] as? [String: Any], !product.isEmpty {
            setReview(["kind":"product","product":product,"eventId":id,"thumbnail":event["thumbnail"] as? String ?? "", "photos":event["photos"] ?? []])
        } else if let extraction = event["extraction"] as? [String: Any] {
            setReview(["kind":"analysis","extraction":extraction,"eventId":id,"thumbnail":event["thumbnail"] as? String ?? "", "photos":event["photos"] ?? []])
        } else if let references = event["photos"] as? [String], !references.isEmpty {
            let images = references.compactMap { persistence.photoData(for: $0) }
            if !images.isEmpty { capture.retryPhotos(images, eventID: id, repair: repair.isEmpty ? nil : repair); return }
            analysisFailure = "This scan did not finish. Scan the food again to get a result."
        } else { analysisFailure = "This scan did not finish. Scan the food again to get a result." }
    }
    func cancelProductRecovery() {
        scoreTask?.cancel(); scoreTask = nil; scoreGeneration = UUID()
        recoveringProduct = false; productRecoveryMessage = nil
    }
    func openProductContribution(barcode: String, productName: String? = nil, isCorrection: Bool = false) {
        guard barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil else { return }
        analysisFailure = nil
        contributionContext = .init(barcode: barcode, productName: productName,
                                    countryCode: search.market == .unitedKingdom ? "GB" : nil, store: search.store, isCorrection: isCorrection)
    }

    func retryProductRecovery() { recoverProductIfNeeded(retry: true) }
    private func recoverProductIfNeeded(retry: Bool = false) {
        cancelProductRecovery()
        let request = project("productRecovery")
        guard request["blockedByQualityHold"] as? Bool != true, request["blockedByQualityCheck"] as? Bool != true else { return }
        guard let fingerprint = request["fingerprint"] as? String,
              let confirmation = request["confirmationId"] as? String,
              let facts = request["facts"] as? [String: Any] else { return }
        if !retry, let cached = request["cache"] as? [String: Any], let score = cached["result"] as? [String: Any],
           request["canApplyCache"] as? Bool == true {
            if let value = invoke("perform", ["productRecoveryApply", ["fingerprint":fingerprint, "confirmationId":confirmation, "result":score, "recovery":cached["recovery"] ?? NSNull(), "checkedAt":cached["checkedAt"] ?? "", "cacheReplay":true]]) { accept(value); ratingLoader.evidenceDidChange() }
            return
        }
        guard retry || request["needsRecovery"] as? Bool == true else { return }
        let sourceEvent = (review["eventId"] as? String).flatMap { project("historyItem", ["id": $0])["row"] as? [String: Any] }
        let sourceExtraction = review["extraction"] as? [String: Any] ?? sourceEvent?["extraction"] as? [String: Any]
        if !retry, (sourceExtraction?["fastCapture"] as? [String: Any])?["version"] as? Int == 1 {
            productRecoveryMessage = "Available nutrition is shown. Tap Retry to request further verification."
            return
        }
        guard PhotoAnalysisPermission().allowed else {
            productRecoveryMessage = "AI analysis is off. Available product facts are still shown. Enable it in You → Settings to recover missing information."
            return
        }
        let generation = scoreGeneration, accountRevision = NudgeAccountManager.shared.revision
        recoveringProduct = true
        scoreTask = Task { [weak self] in
            guard let self else { return }
            defer { if scoreGeneration == generation { scoreTask = nil; recoveringProduct = false } }
            do {
                let result = try await NutritionLabelService().scoreProduct(facts)
                guard !Task.isCancelled, scoreGeneration == generation,
                      NudgeAccountManager.shared.revision == accountRevision, PhotoAnalysisPermission().allowed,
                      review["confirmationId"] as? String == confirmation,
                      project("productRecovery")["fingerprint"] as? String == fingerprint else { return }
                let payload: [String: Any] = ["fingerprint":fingerprint, "confirmationId":confirmation, "result":result["score"] ?? NSNull(), "recovery":result["recovery"] ?? NSNull()]
                if let value = invoke("perform", ["productRecoveryApply", payload]) {
                    accept(value)
                    ratingLoader.evidenceDidChange()
                    if value["ok"] as? Bool != true { productRecoveryMessage = "The missing facts could not be verified. Your supplied facts are unchanged." }
                    else if (result["score"] as? [String: Any])?["status"] as? String == "unrated" { productRecoveryMessage = "Some information is still missing. Add a nutrition-label photo to improve this result." }
                    if value["ok"] as? Bool == true, (result["score"] as? [String: Any])?["catalogueCheckRequired"] as? Bool == true,
                       let barcode = facts["barcode"] as? String {
                        productRecoveryMessage = "Source information needs checking before a score can be shown."
                        if let refreshed = try? await NudgeCatalogueService().batch([barcode]).first,
                           !Task.isCancelled, scoreGeneration == generation,
                           review["confirmationId"] as? String == confirmation,
                           project("productRecovery")["fingerprint"] as? String == fingerprint {
                            ProductLookupCache.shared.write(refreshed, now: Date())
                            // Refresh public facts without silently replacing a user-edited review.
                            // Only an identical typed snapshot can gain durable catalogue authority here.
                            if let current = review["product"] as? [String: Any],
                               let data = try? JSONSerialization.data(withJSONObject: current),
                               let snapshot = try? JSONDecoder().decode(BarcodeProduct.self, from: data),
                               ProductCatalogueRating.fingerprint(snapshot) == ProductCatalogueRating.fingerprint(refreshed),
                               let object = productObject(refreshed) {
                                var next = review; next["product"] = object
                                if let update = invoke("perform", ["setReview", next]) { accept(update); ratingLoader.evidenceDidChange() }
                            }
                        }
                    }
                }
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, scoreGeneration == generation else { return }
                if let value = invoke("perform", ["productRecoveryFailed", ["fingerprint":fingerprint, "confirmationId":confirmation]]) { accept(value) }
                let code = (error as? NutritionLabelService.ServiceError)?.code
                productRecoveryMessage = code == "signInRequired" || error is AccountError
                    ? "Sign in in You → Account to recover missing information."
                    : "Missing information could not be checked just now. The available facts are still shown."
            }
        }
    }
    private func reportNutritionCompleteness() {
        guard !state.isEmpty, let m = invoke("project", ["nutritionTotals", [:]]) else { return }
        let metrics = ["protein", "energy", "carbs", "fibre", "fat"].compactMap { m[$0] as? [String: Any] }
        let known = metrics.filter { $0["value"] is NSNumber }.count
        let partial = metrics.filter { $0["value"] is NSNumber && (($0["unknown"] as? NSNumber)?.intValue ?? 0) > 0 }.count
        let details: [String: Any] = ["entryCount":m["entryCount"] ?? 0,"knownNutrientCount":known,"missingNutrientCount":metrics.count-known,"partialNutrientCount":partial]
        guard let data = try? JSONSerialization.data(withJSONObject: details, options: [.sortedKeys]), let signature = String(data: data, encoding: .utf8), signature != lastNutritionDiagnostic else { return }
        lastNutritionDiagnostic = signature
        AnalysisDiagnostics.shared.record(stage: "nutrition", outcome: known < metrics.count || partial > 0 ? "incomplete" : "calculated", metadata: details)
    }
    func openSaved(_ item: [String: Any]) {
        if route != "review" { reviewReturnRoute = route }
        if perform("openSaved", ["id": item["id"] as? String ?? "", "confirmationId":UUID().uuidString, "day":loggingDay, "slot":loggingMeal]) { route = "review" }
    }
    func openRecent(_ item: [String: Any]) {
        if let entry = item["entry"] as? [String: Any], let id = entry["id"] as? String {
            if route != "review" { reviewReturnRoute = route }
            if perform("openRecent", ["entryId":id,"confirmationId":UUID().uuidString,"day":loggingDay,"slot":loggingMeal]) { route = "review" }
        } else { openHistory(item) }
    }
}

/// Read-only presentation of a durable job. A queued request is not a completed
/// analysis; disappearance/deletion and failed requests must never look busy.
struct NativeMealRefinementProgress {
    let isAnalysing: Bool
    let message: String

    init(event: [String: Any]?) {
        guard let event else {
            isAnalysing = false
            message = "This analysis is no longer in History. Your ingredient choices are still here."
            return
        }
        let state = event["processingState"] as? String ?? ""
        let status = event["status"] as? String ?? ""
        if status == "ready" || state == "complete" {
            isAnalysing = false
            message = "Analysis finished. Your result is ready in History."
        } else if state == "processing" || (state == "queued" && event["message"] as? String == "Analysing…") {
            isAnalysing = true
            message = "Analysing… Your result will appear in History."
        } else if state == "queued" {
            isAnalysing = true
            message = "Queued for analysis. Your result will appear in History."
        } else if state == "retryableFailure" || status == "failed" {
            isAnalysing = false
            message = "Analysis is waiting to retry. Open History for its status or to retry now."
        } else if state == "needsUserInput" || status == "unknown" {
            isAnalysing = false
            message = "Analysis needs your attention. Open History for details. Your photos and ingredients are saved."
        } else {
            isAnalysing = false
            message = "Open History to check this analysis."
        }
    }
}
