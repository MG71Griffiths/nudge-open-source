import Foundation
import UIKit

enum CameraCheckEnvironment {
    static let root = URL(fileURLWithPath: CommandLine.arguments[1])
    static let defaults = UserDefaults(suiteName: "test.nudge.camera." + UUID().uuidString)!
    static let blockedSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CameraCheckBlockedHTTP.self]
        return URLSession(configuration: config)
    }()
}
final class CameraCheckBlockedHTTP: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { preconditionFailure("Unexpected network request in coordinator checks") }
    override func stopLoading() {}
}
@MainActor final class CameraCheckAccountStore: AccountSessionStore {
    func load() throws -> AccountSession? { nil }
    func save(_ session: AccountSession) throws { preconditionFailure("Unexpected account write") }
    func clear() throws { preconditionFailure("Unexpected account mutation") }
}
@MainActor final class CameraCheckAccountTransport: AccountHTTPTransport {
    func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse {
        preconditionFailure("Unexpected account HTTP")
    }
}
private enum CameraCheckError: Error { case failed(String), timeout(String) }
@MainActor private final class CameraCheckState {
    var selection: ChatGPTCaptureBinding?
    var selectionDelay: TimeInterval = 0
    var valid: [ChatGPTCaptureBinding] = []
    var permission = true
    var revision = 0
    var owner = String(repeating: "a", count: 64)
    var ocrCalls = 0
    var ocrPages: [FoodOCRPage]?
    var holdOCR = false
    var pendingOCR: [Int: (CheckedContinuation<FoodOCRResult, Error>, [FoodOCRPage])] = [:]
    var chatCalls: [(ChatGPTCaptureBinding, [String: Any])] = []
    var ordinaryCalls = 0
    var ordinarySubmissionIDs: [UUID] = []
    var ordinaryInputs: [([Data], [String], Int, VoiceMemoPayload?)] = []
    var cacheOrdinaryResults = false
    var completedRemoteResults: [UUID: [String: Any]] = [:]
    var retrieveCalls: [UUID] = []
    var retryCalls: [UUID] = []
    var ordinaryFailure = false
    var ordinaryError: Error?
    var ordinaryEnvelope: [String: Any]?
    var voiceCalls = 0
    var deleteCalls = 0
    var pending: [Int: CheckedContinuation<String, Error>] = [:]
    var failImmediately = false
    let response: String
    init(response: String) { self.response = response }
    func analyse(_ binding: ChatGPTCaptureBinding, request: [String: Any]) async throws -> String {
        let index = chatCalls.count; chatCalls.append((binding, request))
        if failImmediately { throw ChatGPTFailure.limit }
        return try await withCheckedThrowingContinuation { pending[index] = $0 }
    }
    func finish(_ index: Int) { pending.removeValue(forKey: index)?.resume(returning: response) }
    func recognize(_ images: [Data], ids: [String]) async throws -> FoodOCRResult {
        let index = ocrCalls; ocrCalls += 1
        let pages = ids.enumerated().map { offset, id in FoodOCRPage(photoID: id, photoIndex: offset + 1, lines: ocrPages.flatMap { offset < $0.count ? $0[offset].lines : nil } ?? []) }
        if holdOCR { return try await withCheckedThrowingContinuation { pendingOCR[index] = ($0, pages) } }
        return FoodOCRResult(pages: pages, elapsedMilliseconds: 1)
    }
    func finishOCR(_ index: Int) {
        if let (continuation, pages) = pendingOCR.removeValue(forKey: index) { continuation.resume(returning: FoodOCRResult(pages: pages, elapsedMilliseconds: 1)) }
    }
    func cancelAll() {
        for key in Array(pending.keys) { pending.removeValue(forKey: key)?.resume(throwing: CancellationError()) }
        for key in Array(pendingOCR.keys) { pendingOCR.removeValue(forKey: key)?.0.resume(throwing: CancellationError()) }
    }
}
@MainActor private final class CameraCheckFixture {
    let state: CameraCheckState
    let app: NativeAppStore
    let outbox: NativeCaptureOutbox
    let coordinator: NativeCaptureCoordinator
    let owner = String(repeating: "a", count: 64)
    let image: Data
    init(_ name: String, response: String) throws {
        let directory = CameraCheckEnvironment.root.appendingPathComponent(name)
        let bundle = Bundle(url: CameraCheckEnvironment.root.appendingPathComponent("Check.bundle"))!
        state = CameraCheckState(response: response)
        app = NativeAppStore(store: NudgeDataStore(directory: directory), bundle: bundle,
            lookupProduct: { _ in throw CameraCheckError.failed("Unexpected lookup") })
        guard app.ready else { throw CameraCheckError.failed("Native runtime unavailable: " + (app.errorMessage ?? "unknown")) }
        outbox = app.captureOutbox
        let state = self.state
        coordinator = NativeCaptureCoordinator(store: app,
            lookup: { _, _ in throw CameraCheckError.failed("Unexpected barcode lookup") },
            analysePhotos: { images, photoIDs, revision, voice, submissionID in
                state.ordinaryCalls += 1; state.ordinarySubmissionIDs.append(submissionID)
                state.ordinaryInputs.append((images, photoIDs, revision, voice))
                if voice != nil { state.voiceCalls += 1 }
                if let error = state.ordinaryError { throw error }
                if state.ordinaryFailure { throw URLError(.networkConnectionLost) }
                let response: [String: Any] = state.ordinaryEnvelope ?? ["extraction": ["type":"product", "productName":"Synthetic ordinary label", "labelKind":"unreadable", "basis":"unknown", "nutrients":[:]]]
                if state.cacheOrdinaryResults {
                    // Match the real queue: a completed same-ID POST, GET or
                    // /retry returns the cached observation without rerunning.
                    if let cached = state.completedRemoteResults[submissionID] { return cached }
                    state.completedRemoteResults[submissionID] = response
                    return ["job": ["id": submissionID.uuidString, "status": "queued"], "retryAfterSeconds": 1]
                }
                return response
            }, recognizeText: { try await state.recognize($0, ids: $1) }, permissionAllowed: { state.permission }, cameraSelection: {
                if state.selectionDelay > 0 { Thread.sleep(forTimeInterval: state.selectionDelay) }
                return state.selection
            },
            chatGPTBindingCurrent: { state.valid.contains($0) }, analyseChatGPT: { binding, request, _ in try await state.analyse(binding, request: request) },
            accountRevision: { state.revision }, outbox: outbox, ownerKey: { state.owner },
            deleteCapture: { _, _ in state.deleteCalls += 1 },
            retrieveCapture: { id, _ in
                state.retrieveCalls.append(id)
                return state.completedRemoteResults[id] ?? ["captureMissing": true]
            }, retryCapture: { id, _ in
                state.retryCalls.append(id)
                return state.completedRemoteResults[id] ?? state.ordinaryEnvelope ?? ["extraction": ["type":"product", "productName":"Synthetic retried label", "labelKind":"unreadable", "basis":"unknown", "nutrients":[:]]]
            })
        app.capture = coordinator
        image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { ctx in
            UIColor.gray.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }.jpegData(compressionQuality: 0.5)!
    }
    func submit(voice: VoiceMemoPayload? = nil) -> String {
        let camera = SmartFoodCameraViewController(images: [image], photoIDs: [UUID().uuidString], revision: 1, voiceMemo: voice)
        coordinator.prepare(camera)
        let id = coordinator.photoEventID
        coordinator.foodCamera(camera, analyse: [image], addToEaten: false)
        return id
    }
    func record(_ id: String) throws -> NativeCaptureRecord { try outbox.record(eventID: id, owner: owner)! }
    func historyPresentationRow(_ id: String) throws -> [String: Any] {
        let projection = app.project("history", ["filter": "all", "presentation": true, "deferScores": true])
        guard let row = (projection["rows"] as? [[String: Any]])?.first(where: { $0["id"] as? String == id }) else {
            throw CameraCheckError.failed("Capture missing from actual native History presentation")
        }
        return row
    }
    func cacheCount() throws -> Int {
        let directory = try outbox.foodTextCacheDirectory(owner: owner)
        return (try? FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.count) ?? 0
    }
    func legacy(_ id: String, binding: ChatGPTCaptureBinding? = nil, status: NativeCaptureStatus = .queued) throws {
        var record = NativeCaptureRecord(eventID: id, ownerKey: owner)
        record.chatGPTBinding = binding; record.photoIDs = [UUID().uuidString]; record.captureRevision = 1
        record.historyGeneration = 0; record.status = status
        record.photoReferences = try app.saveAnalysisPhotos([image])
        _ = try outbox.save(record, images: [image])
        precondition(app.perform("recordHistory", ["id":id,"kind":"meal","status":"pending","processingState":status.rawValue,"captureOwnerKey":owner,"captureID":record.id.uuidString,"createdAt":"2026-10-15T12:00:00Z","generation":0]))
    }
    func stop() { coordinator.cancelAllPhotoAnalyses(); state.cancelAll(); coordinator.complete() }
}

@main struct ChatGPTCameraChecks {
    @MainActor static func main() async {
        _ = URLProtocol.registerClass(CameraCheckBlockedHTTP.self)
        var checks: [String] = []
        func expect(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw CameraCheckError.failed(name) }; checks.append(name)
        }
        func wait(_ name: String, _ predicate: @escaping @MainActor () throws -> Bool) async throws {
            for _ in 0..<250 { if try predicate() { return }; try await Task.sleep(nanoseconds: 20_000_000) }
            throw CameraCheckError.timeout(name)
        }
        let a = ChatGPTCaptureBinding(profileID:"synthetic-a",subject:"synthetic-subject-a",connectionID:UUID(),modelID:"synthetic-model-a")
        let b = ChatGPTCaptureBinding(profileID:"synthetic-b",subject:"synthetic-subject-b",connectionID:UUID(),modelID:"synthetic-model-b")
        do {
            let response = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
            let unknownResponse = #"{"version":3,"type":"unknown","photoConsistency":"uncertain","product":null,"meal":null}"#
            struct LabelFixture: Decodable { let pages: [FoodOCRPage] }
            let labelPages = try JSONDecoder().decode(LabelFixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3]))).pages
            do {
                let source: [String: Any] = ["extraction": ["type": "unknown"], "recoveryReason": "identity_conflict",
                    "observationDiagnostics": ["observedType": "product", "observedConsistency": "sameProduct", "proposedNutrientCount": 8, "foodName": "private food", "rawOutput": "private output"]]
                let metadata = NativeCaptureCoordinator.structuredResponseMetadata(source)
                try expect("Structured diagnostics copy only bounded recovery and observation fields", metadata["resultType"] as? String == "unknown" && metadata["recoveryReason"] as? String == "identity_conflict" && metadata["observedType"] as? String == "product" && metadata["observedConsistency"] as? String == "sameProduct" && metadata["proposedNutrientCount"] as? Int == 8 && metadata.count == 6)
                for (name, invalid) in [("boolean", true as Any), ("fraction", 1.5 as Any), ("negative", -1 as Any), ("large", 9 as Any), ("text", "8" as Any)] {
                    let value = NativeCaptureCoordinator.structuredResponseMetadata(["extraction": ["type": "private food"], "recoveryReason": "private prose",
                        "observationDiagnostics": ["observedType": "private food", "observedConsistency": "private prose", "proposedNutrientCount": invalid]])
                    try expect("Structured diagnostics reject unbounded enums and " + name + " counts", value.count == 2 && value["resultType"] as? String == "unknown")
                }
                let zero = NativeCaptureCoordinator.structuredResponseMetadata(["observationDiagnostics": ["proposedNutrientCount": 0]])
                try expect("A genuine zero nutrient observation remains measurable", zero["proposedNutrientCount"] as? Int == 0)
                try expect("Old adapters retain bounded subject recovery", NativeCaptureRecoveryReason.from(response: ["diagnosticEnums": ["subject_uncertain"]]) == .subjectUncertain && NativeCaptureRecoveryReason.from(response: ["diagnosticEnums": ["private food"]]) == nil)
                try expect("Unknown backend trace retains fixed uncertainty recovery", NativeCaptureRecoveryReason.from(response: ["extraction": ["type": "unknown"], "trace": ["normalizationIssues": ["subject_uncertain"], "subjectStatus": "uncertain"]]) == .subjectUncertain)
                try expect("Private or malformed backend trace cannot become recovery prose", NativeCaptureRecoveryReason.from(response: ["extraction": ["type": "unknown"], "trace": ["normalizationIssues": ["private food"], "subjectStatus": "private prose"]]) == nil)
                try expect("Known food is never downgraded by backend trace", NativeCaptureRecoveryReason.from(response: ["extraction": ["type": "meal"], "trace": ["normalizationIssues": ["subject_uncertain"], "subjectStatus": "uncertain"]]) == nil)
                for reason in [NativeCaptureRecoveryReason.subjectUncertain, .subjectUnidentified, .subjectTypeMismatch, .identityConflict] {
                    var record = NativeCaptureRecord(eventID: "synthetic-recovery", ownerKey: "synthetic-owner")
                    record.status = .needsUserInput; record.errorCode = reason.errorCode
                    let restored = try JSONDecoder().decode(NativeCaptureRecord.self, from: JSONEncoder().encode(record))
                    try expect("Recovery reason survives durable record decoding: " + reason.rawValue, restored.message == reason.message && restored.message.contains("Analyse"))
                }
            }
            do {
                let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { ctx in
                    UIColor.gray.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
                }.jpegData(compressionQuality: 0.5)!
                let camera = SmartFoodCameraViewController()
                camera.dismissProductSummary()
                try expect("An empty camera has no fabricated acquisition timestamp", camera.captureStartedAt == nil)
                guard let token = camera.beginPhotoCapture() else { throw CameraCheckError.failed("New camera could not accept synthetic capture") }
                camera.finishPhoto(image, token: token)
                try expect("An accepted new photo retains a monotonic acquisition timestamp", camera.captureStartedAt.map { $0 > 0 && $0 <= CaptureClock.now } == true)
                let retained = SmartFoodCameraViewController(images: [image], photoIDs: [UUID().uuidString], revision: 1)
                retained.dismissProductSummary()
                try expect("Restored photos have no invented current-process capture time", retained.captureStartedAt == nil)
                guard let next = retained.beginPhotoCapture() else { throw CameraCheckError.failed("Restored camera could not accept synthetic capture") }
                retained.finishPhoto(image, token: next)
                try expect("Mixing restored and new photos keeps full-set acquisition duration unknown", retained.capturedImages.count == 2 && retained.captureStartedAt == nil)
                camera.closeCapture(); retained.closeCapture()
            }
            do {
                let eventID = "synthetic-timing-anchor", requestID = UUID()
                let started = CaptureClock.now
                CapturePerformance.shared.begin(eventID: eventID, requestID: requestID, startedAt: started - 0.25,
                    captureStartedAt: started - 0.75, captureBasis: "photo_acquisition")
                CapturePerformance.shared.visible(eventID: eventID)
                CapturePerformance.shared.begin(eventID: eventID, requestID: requestID)
                CapturePerformance.shared.ready(eventID: eventID, complete: true, metadata: [:])
                CapturePerformance.shared.ready(eventID: eventID, complete: false, metadata: [:])
                CapturePerformance.shared.visible(eventID: eventID)
                CapturePerformance.shared.visible(eventID: eventID)
                let diagnostics = try JSONSerialization.jsonObject(with: AnalysisDiagnostics.shared.exportData()) as! [String: Any]
                let events = (diagnostics["events"] as? [[String: Any]] ?? []).filter {
                    ($0["metadata"] as? [String: Any])?["requestId"] as? String == requestID.uuidString
                }
                let elapsed = events.compactMap { ($0["metadata"] as? [String: Any])?["elapsedMs"] as? Int }
                try expect("Analyse timing includes work before durable-save acknowledgement", events.compactMap { $0["outcome"] as? String } == ["started", "result_ready", "card_visible"] && elapsed.count == 3 && elapsed.allSatisfy { $0 >= 249 } && elapsed == elapsed.sorted())
                let timings = events.compactMap { $0["metadata"] as? [String: Any] }
                try expect("Capture and Analyse clocks retain separate anchors across duplicate callbacks", timings.allSatisfy {
                    guard let capture = $0["captureToResultMs"] as? Int, let analyse = $0["analyseToResultMs"] as? Int else { return false }
                    return capture - analyse >= 499 && $0["timingVersion"] as? Int == 2
                } && timings.last?["completeNutrition"] as? Bool == true)
                CapturePerformance.shared.forget(eventID)
                let barcodeID = UUID()
                CapturePerformance.shared.begin(eventID: "synthetic-barcode-timing", requestID: barcodeID,
                    startedAt: started, captureStartedAt: started, captureBasis: "barcode_decode")
                CapturePerformance.shared.ready(eventID: "synthetic-barcode-timing", complete: false, metadata: [:])
                let barcodeDiagnostics = try JSONSerialization.jsonObject(with: AnalysisDiagnostics.shared.exportData()) as! [String: Any]
                let barcodeEvents = (barcodeDiagnostics["events"] as? [[String: Any]] ?? []).compactMap { $0["metadata"] as? [String: Any] }.filter { $0["requestId"] as? String == barcodeID.uuidString }
                try expect("Barcode duration starts at decoded code and never pretends there was an Analyse tap", barcodeEvents.count == 2 && barcodeEvents.allSatisfy { $0["captureBasis"] as? String == "barcode_decode" && $0["captureToResultMs"] is Int && $0["analyseToResultMs"] == nil })
                CapturePerformance.shared.forget("synthetic-barcode-timing")
                let viewport = CGRect(x: 10, y: 100, width: 300, height: 500)
                try expect("Offscreen or partly clipped nutrition never counts as a visible complete card",
                    !CaptureResultVisibility.contains(panel: CGRect(x: 20, y: 601, width: 280, height: 200), viewport: viewport)
                    && !CaptureResultVisibility.contains(panel: CGRect(x: 20, y: 550, width: 280, height: 200), viewport: viewport)
                    && !CaptureResultVisibility.contains(panel: .zero, viewport: viewport)
                    && !CaptureResultVisibility.contains(panel: CGRect(x: 20, y: 100, width: 280, height: 600), viewport: viewport)
                    && CaptureResultVisibility.contains(panel: CGRect(x: 20, y: 110, width: 280, height: 200), viewport: viewport))
            }
            for (name, status, payload, expected) in [
                ("true", 503, Data(#"{"manualRetryRequired":true}"#.utf8), true),
                ("false", 503, Data(#"{"manualRetryRequired":false}"#.utf8), false),
                ("number", 503, Data(#"{"manualRetryRequired":1}"#.utf8), false),
                ("string", 503, Data(#"{"manualRetryRequired":"true"}"#.utf8), false),
                ("malformed", 503, Data(#"{"manualRetryRequired":true"#.utf8), false),
                ("other status", 200, Data(#"{"manualRetryRequired":true}"#.utf8), false),
                ("oversized", 503, Data(repeating: 32, count: NutritionLabelService.maximumAnalysisResponseBytes + 1), false)
            ] {
                try expect("manual retry acknowledgement strictly validates " + name, NutritionLabelService.captureRequiresManualRetry(statusCode: status, data: payload) == expected)
            }
            do {
                let f = try CameraCheckFixture("history-progress-projection", response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                f.app.navigate("search")
                let empty = f.app.project("history", ["filter": "all", "presentation": true, "deferScores": true])
                try expect("History progress starts from a cached empty native projection", (empty["rows"] as? [Any])?.isEmpty == true)
                let revealRevision = f.app.analysisHistoryRevealRevision
                let id = f.submit()
                let queued = try f.historyPresentationRow(id)
                try expect("New camera logging stores date without meal category", f.app.loggingMeal.isEmpty && (try f.record(id).loggingMeal) == "")
                try expect("Saved photo advances first real milestone", f.coordinator.analysisStage(for: id) == .saved && f.coordinator.latestAnalysisStage == .saved)
                try expect("Durable camera queue opens History and requests the All filter",
                    f.app.selectedTab == "history" && f.app.route == nil &&
                    f.app.analysisHistoryRevealRevision == revealRevision + 1)
                try expect("Actual queued presentation replaces empty cache and supplies the progress bar",
                    queued["presentationOnly"] as? Bool == true && queued["scoreDeferred"] as? Bool == true &&
                    queued["status"] as? String == "pending" && queued["processingState"] as? String == "queued" &&
                    NativeHistoryAnalysisProgress(row: queued)?.isProcessing == false)
                try expect("Repeated queued projection retains its actual progress state",
                    NativeHistoryAnalysisProgress(row: try f.historyPresentationRow(id))?.title == "Queued for analysis")
                try await wait("progress fixture reaches held provider request") { f.state.chatCalls.count == 1 }
                let processing = try f.historyPresentationRow(id)
                try expect("Held provider fills two completed milestones", f.coordinator.analysisStage(for: id) == .analysing && NativeHistoryAnalysisProgress(row: processing, stage: f.coordinator.analysisStage(for: id))?.fraction == 0.5)
                try await Task.sleep(nanoseconds: 80_000_000)
                try expect("Waiting never advances the bar by elapsed time", f.coordinator.analysisStage(for: id) == .analysing)
                try expect("Actual processing projection invalidates the cached queued bar",
                    processing["status"] as? String == "pending" && processing["processingState"] as? String == "processing" &&
                    NativeHistoryAnalysisProgress(row: processing)?.isProcessing == true)
                try expect("History progress projection cannot confirm diary intake",
                    ((f.app.state["foodLog"] as? [String: Any])?["entries"] as? [Any])?.isEmpty == true)
                f.state.finish(0); try await wait("progress fixture completes") { try f.record(id).status == .complete }
                let ready = try f.historyPresentationRow(id)
                try expect("Only saved result completes last milestone", f.coordinator.latestAnalysisStage == .complete)
                try expect("Actual ready projection invalidates processing cache and removes the bar",
                    ready["status"] as? String == "ready" && ready["processingState"] as? String == "complete" &&
                    NativeHistoryAnalysisProgress(row: ready) == nil)
                try expect("Repeated completed presentation cannot revive cached progress",
                    NativeHistoryAnalysisProgress(row: try f.historyPresentationRow(id)) == nil)
            }
            do {
                let f = try CameraCheckFixture("history-progress-failure", response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]; f.state.failImmediately = true
                let id = f.submit()
                try expect("Failure fixture first caches a real queued progress row",
                    NativeHistoryAnalysisProgress(row: try f.historyPresentationRow(id)) != nil)
                try await wait("progress failure reaches terminal retry state") { try f.record(id).status == .retryableFailure }
                let failed = try f.historyPresentationRow(id)
                try expect("Failure clears live progress without completing it", f.coordinator.analysisStage(for: id) == nil && f.coordinator.latestAnalysisStage == nil)
                try expect("Actual failure projection invalidates pending progress without showing completion",
                    failed["status"] as? String == "failed" && failed["processingState"] as? String == "retryableFailure" &&
                    NativeHistoryAnalysisProgress(row: failed) == nil)
            }
            do {
                let f = try CameraCheckFixture("server-pending-progress", response: response); defer { f.stop() }
                f.state.ordinaryEnvelope = ["job": ["status": "pending"], "retryAfterSeconds": 600]
                let id = f.submit()
                try await wait("server accepts pending analysis") { try f.record(id).remoteAccepted && f.record(id).status == .queued }
                try await Task.sleep(nanoseconds: 80_000_000)
                let pending = try f.historyPresentationRow(id)
                try expect("Accepted server work retains half-filled progress between polls", f.coordinator.analysisStage(for: id) == .analysing && NativeHistoryAnalysisProgress(row: pending, stage: f.coordinator.analysisStage(for: id))?.fraction == 0.5)
                f.coordinator.cancelAllPhotoAnalyses()
                try expect("Cancellation clears pending milestones", f.coordinator.analysisStage(for: id) == nil)
            }
            do {
                let f = try CameraCheckFixture("pinning", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a,b]
                let first = f.submit()
                try expect("Analyse dismisses the camera after durable submission", f.coordinator.camera == nil && (try f.outbox.images(for: f.record(first))) == [f.image])
                try expect("Analyse acknowledges once without scheduling diary intake", f.app.analysisAcknowledgement == "Analysing… Track progress in History." && (try f.record(first).addToEaten) != true)
                try await wait("first direct starts") { f.state.chatCalls.count == 1 }
                f.state.selection = b
                let second = f.submit()
                try await wait("two direct requests start") { f.state.chatCalls.count == 2 }
                try expect("two concurrent jobs retain A/B bindings", try f.record(first).chatGPTBinding == a && f.record(second).chatGPTBinding == b)
                try expect("transport receives pinned bindings", f.state.chatCalls[0].0 == a && f.state.chatCalls[1].0 == b)
                try expect("active Retry is a no-op", f.coordinator.retryHistory(["id":first]) && f.state.chatCalls.count == 2)
                _ = try f.historyPresentationRow(first)
                f.state.finish(1)
                try await wait("second direct job finishes first") { try f.record(second).status == .complete }
                try expect("Concurrent completion cannot advance another job", f.coordinator.analysisStage(for: first) == .analysing && f.coordinator.analysisStage(for: second) == .complete)
                try expect("Out-of-order completion removes only that job's cached History progress",
                    NativeHistoryAnalysisProgress(row: try f.historyPresentationRow(first))?.isProcessing == true &&
                    NativeHistoryAnalysisProgress(row: try f.historyPresentationRow(second)) == nil)
                f.state.finish(0)
                try await wait("two direct jobs complete") { try f.record(first).status == .complete && f.record(second).status == .complete }
                try expect("direct route avoids ordinary transport", f.state.ordinaryCalls == 0)
                let count = f.state.chatCalls.count
                _ = f.coordinator.retryHistory(["id":first])
                try expect("completed Retry does not spend again", f.state.chatCalls.count == count)
                let rows = f.app.history["events"] as? [[String:Any]] ?? []
                try expect("both responses enter native History", rows.filter { [$0["id"] as? String].contains(first) || [$0["id"] as? String].contains(second) }.count == 2)
            }
            do {
                let f = try CameraCheckFixture("legacy", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                try f.legacy("legacy-ordinary"); f.coordinator.resumePending()
                try await wait("legacy ordinary completes") { try f.record("legacy-ordinary").status == .complete }
                try expect("nil legacy binding stays ordinary", f.state.ordinaryCalls == 1 && f.state.chatCalls.isEmpty)
                try expect("legacy queued jobs do not change to local routing", f.state.ocrCalls == 0)
            }
            do {
                let f = try CameraCheckFixture("disconnect", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let id = f.submit(); try await wait("disconnect request starts") { f.state.chatCalls.count == 1 }
                f.state.selection = b; f.state.valid = [b]; f.state.finish(0)
                try await wait("disconnected response blocked") { try f.record(id).status == .retryableFailure }
                try expect("late disconnected result not delivered", try f.record(id).errorCode == "chatgpt_account")
                f.coordinator.resumePending(); try await Task.sleep(nanoseconds:60_000_000)
                try expect("failure does not automatically respent", f.state.chatCalls.count == 1)
                _ = f.coordinator.retryHistory(["id":id])
                try expect("manual Retry rejects a different payer", f.state.chatCalls.count == 1 && (try f.record(id).chatGPTBinding) == a)
                let renewed = ChatGPTCaptureBinding(profileID:a.profileID,subject:a.subject,connectionID:UUID(),modelID:"replacement-model")
                f.state.selection = renewed; f.state.valid.append(renewed)
                f.state.selectionDelay = 0.04
                _ = f.coordinator.retryHistory(["id":id])
                f.state.selectionDelay = 0
                try await wait("explicit same-account Retry starts") { f.state.chatCalls.count == 2 }
                try expect("manual retry pins renewed same account", f.state.chatCalls[1].0 == renewed)
                let retryDiagnostics = try JSONSerialization.jsonObject(with: AnalysisDiagnostics.shared.exportData()) as! [String: Any]
                let requestID = try f.record(id).submissionID.uuidString
                let starts = (retryDiagnostics["events"] as? [[String: Any]] ?? []).filter {
                    $0["stage"] as? String == "capture_performance" && $0["outcome"] as? String == "started" &&
                    ($0["metadata"] as? [String: Any])?["requestId"] as? String == requestID
                }
                try expect("History Retry timing includes synchronous account lookup before durable queue acknowledgement", starts.count == 2 && ((starts.last?["metadata"] as? [String: Any])?["analyseToResultMs"] as? Int ?? 0) >= 39)
                f.state.finish(1); try await wait("retried job completes") { try f.record(id).status == .complete }
            }
            do {
                let f = try CameraCheckFixture("unknown-camera-same-account-retry", response: unknownResponse); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let id = f.submit(); try await wait("unknown direct request starts") { f.state.chatCalls.count == 1 }
                f.state.finish(0); try await wait("unknown result retains recovery") { try f.record(id).status == .needsUserInput }
                let previous = try f.record(id)
                let prepared = try await f.outbox.preparedCloudImages(for: previous)
                let row = f.app.project("historyItem", ["id": id])["row"] as! [String: Any]
                try expect("Uncertain result retains fixed recovery advice in native History", previous.errorCode == "photo_subject_uncertain" && row["message"] as? String == NativeCaptureRecoveryReason.subjectUncertain.message && (row["extraction"] == nil || row["extraction"] is NSNull))
                let diagnostics = try JSONSerialization.jsonObject(with: AnalysisDiagnostics.shared.exportData()) as! [String: Any]
                let observations = (diagnostics["events"] as? [[String: Any]] ?? []).filter { $0["stage"] as? String == "structured_response" }.compactMap { $0["metadata"] as? [String: Any] }
                try expect("Real bridge diagnostics preserve bounded pre-normalization evidence", observations.last?["recoveryReason"] as? String == "subject_uncertain" && observations.last?["observedType"] as? String == "unknown" && observations.last?["observedConsistency"] as? String == "uncertain" && observations.last?["proposedNutrientCount"] as? Int == 0)
                let renewed = ChatGPTCaptureBinding(profileID: a.profileID, subject: a.subject, connectionID: UUID(), modelID: "replacement-model")
                f.state.selection = renewed; f.state.valid = [renewed]
                f.app.openHistory(row)
                guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Unknown History row did not reopen saved camera") }
                try expect("Opening unknown History preserves the old binding without submitting", f.state.chatCalls.count == 1 && (try f.record(id).chatGPTBinding) == a && camera.capturedImages == [f.image])
                let reopenedDiagnostics = try JSONSerialization.jsonObject(with: AnalysisDiagnostics.shared.exportData()) as! [String: Any]
                let reopenedStarts = (reopenedDiagnostics["events"] as? [[String: Any]] ?? []).filter {
                    $0["stage"] as? String == "capture_performance" && $0["outcome"] as? String == "started" &&
                    ($0["metadata"] as? [String: Any])?["requestId"] as? String == previous.submissionID.uuidString
                }
                try expect("Opening unknown History starts no analysis timer before an explicit Analyse tap", reopenedStarts.count == 1)
                let retryStart = Date()
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                try await wait("camera explicit same-account Retry starts") { f.state.chatCalls.count == 2 }
                let retried = try f.record(id)
                let retriedPrepared = try await f.outbox.preparedCloudImages(for: retried)
                try expect("Reopened camera renews only the original account on explicit Analyse", f.state.chatCalls[1].0 == renewed && retried.chatGPTBinding == renewed && f.state.ordinaryCalls == 0)
                try expect("Camera retry preserves immutable dispatched photos and submission", retried.id == previous.id && retried.submissionID == previous.submissionID && retried.photoIDs == previous.photoIDs && retried.photoFiles == previous.photoFiles && retried.captureRevision == previous.captureRevision && retried.photoReferences == previous.photoReferences && retried.cloudPreparedSubmissionID == previous.cloudPreparedSubmissionID && prepared != nil && prepared == retriedPrepared && (try f.outbox.images(for: retried)) == [f.image])
                try expect("Camera retry retains remote state and restarts attempt timing", retried.remoteAccepted == previous.remoteAccepted && retried.manualRetryRequested == previous.manualRetryRequested && retried.analysisStartedAt.map { $0 >= retryStart } == true && retried.attempts == 1 && retried.errorCode == nil)
                let retryDiagnostics = try JSONSerialization.jsonObject(with: AnalysisDiagnostics.shared.exportData()) as! [String: Any]
                let starts = (retryDiagnostics["events"] as? [[String: Any]] ?? []).filter {
                    $0["stage"] as? String == "capture_performance" && $0["outcome"] as? String == "started" &&
                    ($0["metadata"] as? [String: Any])?["requestId"] as? String == previous.submissionID.uuidString
                }
                try expect("An unchanged camera retry gets a fresh performance start for the same submission", starts.count == 2)
                f.state.finish(1); try await wait("camera retried unknown remains recoverable") { try f.record(id).status == .needsUserInput }
            }
            for originalStillValid in [false, true] {
                let f = try CameraCheckFixture("unknown-camera-other-account-" + String(originalStillValid), response: unknownResponse); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let id = f.submit(); try await wait("other-account unknown request starts") { f.state.chatCalls.count == 1 }
                f.state.finish(0); try await wait("other-account unknown is saved") { try f.record(id).status == .needsUserInput }
                f.state.selection = b; f.state.valid = originalStillValid ? [a, b] : [b]
                f.app.openHistory(try f.historyPresentationRow(id))
                guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Other-account recovery camera missing") }
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                if originalStillValid {
                    try await wait("valid original account camera retry starts") { f.state.chatCalls.count == 2 }
                    try expect("A different selected payer cannot replace a valid original binding", f.state.chatCalls[1].0 == a && (try f.record(id).chatGPTBinding) == a && f.state.ordinaryCalls == 0)
                    f.state.finish(1); try await wait("original payer camera retry ends") { try f.record(id).status == .needsUserInput }
                } else {
                    try await Task.sleep(nanoseconds: 60_000_000)
                    try expect("An invalid original account blocks camera retry without a different payer or fallback", f.state.chatCalls.count == 1 && f.state.ordinaryCalls == 0 && (try f.record(id).chatGPTBinding) == a && (try f.record(id).status) == .needsUserInput && f.app.analysisFailure?.contains("original ChatGPT account") == true && camera.capturedImages == [f.image])
                }
            }
            do {
                let f = try CameraCheckFixture("legacy-unknown-camera-provider", response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let id = "legacy-unknown"
                try f.legacy(id, status: .needsUserInput)
                f.app.openHistory(try f.historyPresentationRow(id))
                guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Legacy unknown camera missing") }
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                try await wait("legacy unknown camera retry completes") { try f.record(id).status == .complete }
                try expect("Legacy unknown camera keeps its original ordinary provider and policy", f.state.ordinaryCalls == 1 && f.state.chatCalls.isEmpty && f.state.ocrCalls == 0 && (try f.record(id).chatGPTBinding) == nil && (try f.record(id).fastCaptureVersion) == nil)
            }
            do {
                let f = try CameraCheckFixture("unknown-camera-retained-remote", response: response); defer { f.stop() }
                let id = "retained-remote-unknown"
                try f.legacy(id, status: .needsUserInput)
                var previous = try f.record(id)
                previous.remoteAccepted = true; previous.fastCaptureVersion = 1; previous.cloudPreparationVersion = 1
                previous.serverRetryAt = Date().addingTimeInterval(3600); previous.attempts = 5
                previous = try f.outbox.save(previous)
                let prepared = try await f.outbox.freezeCloudImages(for: previous, images: [f.image])
                previous = try f.record(id)
                f.state.selection = a; f.state.valid = [a]
                f.app.openHistory(try f.historyPresentationRow(id))
                guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Retained remote camera missing") }
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                let retried = try f.record(id)
                let retriedPrepared = try await f.outbox.preparedCloudImages(for: retried)
                try expect("Unchanged camera retry preserves accepted remote work, frozen input and server backoff", retried.status == .queued && retried.remoteAccepted && !retried.manualRetryRequested && retried.chatGPTBinding == nil && retried.submissionID == previous.submissionID && retried.cloudPreparedSubmissionID == previous.cloudPreparedSubmissionID && retried.nextAttemptAt == previous.serverRetryAt && prepared == retriedPrepared && f.state.chatCalls.isEmpty && f.state.ordinaryCalls == 0)
            }
            do {
                let f = try CameraCheckFixture("completed-remote-unknown-camera", response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]; f.state.cacheOrdinaryResults = true
                f.state.ordinaryEnvelope = ["extraction": ["type": "unknown"], "trace": ["normalizationIssues": ["subject_uncertain"], "subjectStatus": "uncertain"]]
                let memo = VoiceMemoPayload(audioData: Data([0,0,0,12]) + Data("ftypM4A ".utf8), durationSeconds: 2)!
                let id = f.submit(voice: memo)
                try await wait("ordinary unknown is retrieved and saved") { try f.record(id).status == .needsUserInput }
                var previous = try f.record(id)
                previous.repairContext = try JSONSerialization.data(withJSONObject: ["syntheticContext": true])
                previous.mealHints = NativeMealAnalysisHints(ingredients: ["Carrot"])
                previous.serverRetryAt = Date().addingTimeInterval(3600)
                previous = try f.outbox.save(previous)
                let originalVoice = try f.outbox.voiceMemo(for: previous)
                let prepared = try await f.outbox.preparedCloudImages(for: previous)
                let row = try f.historyPresentationRow(id)
                let savedRow = f.app.project("historyItem", ["id": id])["row"] as! [String: Any]
                try expect("Ordinary backend uncertainty persists fixed recovery in History", previous.remoteAccepted && previous.errorCode == "photo_subject_uncertain" && savedRow["message"] as? String == NativeCaptureRecoveryReason.subjectUncertain.message)
                f.coordinator.resumePending(); f.app.openHistory(row)
                guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Remote unknown did not reopen camera") }
                try expect("Opening completed unknown does not retrieve, resubmit or change its identity", f.state.ordinaryCalls == 1 && f.state.retrieveCalls == [previous.submissionID] && f.state.retryCalls.isEmpty && (try f.record(id).submissionID) == previous.submissionID)
                f.state.ordinaryEnvelope = nil
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                try await wait("explicit camera retry creates a fresh successful server job") { try f.record(id).status == .complete }
                let retried = try f.record(id), retriedVoice = try f.outbox.voiceMemo(for: retried)
                let retriedPrepared = try await f.outbox.preparedCloudImages(for: retried)
                try expect("Completed unknown retry bypasses same-ID server cache with exactly one fresh upload", retried.submissionID != previous.submissionID && f.state.ordinarySubmissionIDs == [previous.submissionID, retried.submissionID] && f.state.retrieveCalls == [previous.submissionID, retried.submissionID] && f.state.retryCalls.isEmpty && f.state.completedRemoteResults[previous.submissionID]?["extraction"] is [String: Any])
                try expect("Fresh unknown submission retains owner, ordinary provider and original photo identities", retried.id == previous.id && retried.eventID == previous.eventID && retried.ownerKey == previous.ownerKey && retried.chatGPTBinding == nil && f.state.chatCalls.isEmpty && retried.photoIDs == previous.photoIDs && retried.photoFiles == previous.photoFiles && retried.captureRevision == previous.captureRevision && retried.photoReferences == previous.photoReferences && (try f.outbox.images(for: retried)) == [f.image])
                try expect("Fresh unknown submission retains voice, context and ingredient hints byte for byte", retried.voiceFile == previous.voiceFile && retried.voiceDuration == previous.voiceDuration && retriedVoice?.audioData == originalVoice?.audioData && retriedVoice?.durationSeconds == originalVoice?.durationSeconds && retried.repairContext == previous.repairContext && retried.mealHints == previous.mealHints && f.state.ordinaryInputs.count == 2 && f.state.ordinaryInputs[0].0 == f.state.ordinaryInputs[1].0 && f.state.ordinaryInputs[0].3?.audioData == f.state.ordinaryInputs[1].3?.audioData)
                try expect("Fresh unknown submission uses current policy and independently freezes identical photos", retried.fastCaptureVersion == 1 && retried.cloudPreparedSubmissionID == retried.submissionID && prepared != nil && prepared == retriedPrepared && retried.serverRetryAt == nil && !retried.manualRetryRequested && retried.addToEaten == false)
            }
            do {
                let f = try CameraCheckFixture("camera-accepted-transport-retry", response: response); defer { f.stop() }
                let id = "camera-accepted-transport-retry"
                try f.legacy(id, status: .retryableFailure)
                var previous = try f.record(id)
                previous.remoteAccepted = true; previous.fastCaptureVersion = 1
                previous.errorCode = "analysis_connection"; previous.serverRetryAt = Date().addingTimeInterval(3600)
                previous = try f.outbox.save(previous)
                let camera = SmartFoodCameraViewController(images: [f.image], photoIDs: previous.photoIDs, revision: previous.captureRevision)
                f.coordinator.prepareRetry(camera, eventID: id)
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                var retried = try f.record(id)
                try expect("Camera transport retry retains accepted identity and enforces server backoff", retried.submissionID == previous.submissionID && retried.remoteAccepted && retried.manualRetryRequested && retried.nextAttemptAt == previous.serverRetryAt && f.state.ordinaryCalls == 0 && f.state.retrieveCalls.isEmpty && f.state.retryCalls.isEmpty)
                // Advance this synthetic job past its backoff; the real dispatch
                // must use /retry, not GET or a duplicate fresh upload.
                retried.nextAttemptAt = .distantPast; retried.serverRetryAt = .distantPast
                _ = try f.outbox.save(retried); f.coordinator.resumePending()
                try await wait("accepted camera retry reaches retry endpoint") { try f.record(id).status == .complete }
                try expect("Camera transport retry calls the same-ID retry endpoint once", f.state.retryCalls == [previous.submissionID] && f.state.retrieveCalls.isEmpty && f.state.ordinaryCalls == 0 && (try f.record(id).submissionID) == previous.submissionID)
            }
            for errorCode in ["signInRequired", "photoPermissionRequired"] {
                let f = try CameraCheckFixture("unknown-no-rotation-" + errorCode, response: response); defer { f.stop() }
                try f.legacy(errorCode, status: .needsUserInput)
                var previous = try f.record(errorCode)
                previous.remoteAccepted = true; previous.errorCode = errorCode; previous.serverRetryAt = Date().addingTimeInterval(3600)
                previous = try f.outbox.save(previous)
                f.app.openHistory(try f.historyPresentationRow(errorCode))
                guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Auth/permission camera missing") }
                f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                let retried = try f.record(errorCode)
                try expect("Camera does not replace accepted auth/permission work: " + errorCode, retried.submissionID == previous.submissionID && retried.remoteAccepted && !retried.manualRetryRequested && retried.fastCaptureVersion == nil && retried.nextAttemptAt == previous.serverRetryAt && f.state.ordinaryCalls == 0 && f.state.retrieveCalls.isEmpty && f.state.retryCalls.isEmpty)
            }
            for status in [NativeCaptureStatus.retryableFailure, .needsUserInput, .queued] {
                let f = try CameraCheckFixture("legacy-direct-policy-" + status.rawValue, response: status == .queued ? response : unknownResponse); defer { f.stop() }
                let luna = ChatGPTCaptureBinding(profileID: a.profileID, subject: a.subject, connectionID: a.connectionID, modelID: "gpt-6-luna")
                f.state.selection = luna; f.state.valid = [luna]
                let id = "legacy-direct-" + status.rawValue
                try f.legacy(id, binding: luna, status: status)
                let previous = try f.record(id)
                if status == .queued {
                    f.coordinator.resumePending()
                } else {
                    if status == .needsUserInput {
                        f.app.openHistory(try f.historyPresentationRow(id))
                        guard let camera = f.coordinator.camera else { throw CameraCheckError.failed("Legacy direct camera missing") }
                        try expect("Opening legacy direct recovery does not promote or submit", (try f.record(id).fastCaptureVersion) == nil && f.state.chatCalls.isEmpty)
                        f.coordinator.foodCamera(camera, analyse: camera.capturedImages, addToEaten: false)
                    } else { _ = f.coordinator.retryHistory(["id": id]) }
                }
                try await wait("legacy direct request starts") { f.state.chatCalls.count == 1 }
                let submitted = try f.record(id)
                let policy = ChatGPTCapturePolicy.diagnostics(request: f.state.chatCalls[0].1)
                try expect("Only explicit legacy direct retry adopts compact Luna policy: " + status.rawValue, status == .queued ? submitted.fastCaptureVersion == nil && policy["observationSchema"] == "photo_v1" && policy["requestedReasoningEffort"] == nil : submitted.fastCaptureVersion == 1 && policy["observationSchema"] == "compact_photo_v3" && policy["requestedReasoningEffort"] == "none")
                try expect("Legacy policy preserves payer and original saved capture: " + status.rawValue, submitted.chatGPTBinding == luna && submitted.submissionID == previous.submissionID && submitted.photoIDs == previous.photoIDs && submitted.photoFiles == previous.photoFiles && (try f.outbox.images(for: submitted)) == [f.image] && f.state.ordinaryCalls == 0)
                f.state.finish(0)
                try await wait("legacy direct policy response is delivered") { try f.record(id).status == (status == .queued ? .complete : .needsUserInput) }
            }
            do {
                let f = try CameraCheckFixture("permissions", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]; f.state.failImmediately = true
                let id = f.submit(); try await wait("usage limit is actionable") { try f.record(id).status == .retryableFailure }
                f.state.permission = false; f.coordinator.resumePending()
                f.state.permission = true; f.coordinator.resumePending(); try await Task.sleep(nanoseconds:80_000_000)
                try expect("permission revoke/grant does not auto-respend", f.state.chatCalls.count == 1 && (try f.record(id).status) == .retryableFailure)
                try expect("usage limit has stable public code", try f.record(id).errorCode == "chatgpt_limit")
            }
            do {
                let f = try CameraCheckFixture("voice", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let memo = VoiceMemoPayload(audioData: Data([0,0,0,12]) + Data("ftypM4A ".utf8), durationSeconds:2)!
                let camera = SmartFoodCameraViewController(images:[f.image],voiceMemo:memo)
                try expect("voice route is disclosed before Analyse", f.coordinator.foodCameraAnalysisServiceText(camera).contains("Nudge’s service"))
                let id = f.submit(voice:memo)
                try await wait("voice ordinary result") { try f.record(id).status == .complete }
                try expect("voice capture uses ordinary transport with audio", f.state.voiceCalls == 1 && f.state.chatCalls.isEmpty)
                try expect("voice capture has no ChatGPT binding", try f.record(id).chatGPTBinding == nil)
                try expect("voice capture bypasses photo-only OCR", f.state.ocrCalls == 0)
            }
            do {
                let f = try CameraCheckFixture("deletion", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let id = f.submit(); try await wait("delete request starts") { f.state.chatCalls.count == 1 }
                try expect("History delete commits", f.app.perform("historyDelete",["id":id]))
                f.state.finish(0); try await Task.sleep(nanoseconds:80_000_000)
                try expect("direct deletion never calls ordinary remote deletion", f.state.deleteCalls == 0)
                try expect("deleted capture retains private originals for Undo", try f.record(id).status == .deleted && !f.record(id).photoFiles.isEmpty)
                try expect("History Undo commits", f.app.perform("historyUndo"))
                _ = f.coordinator.retryHistory(["id":id])
                try await wait("Undo retry explicitly resubmits") { f.state.chatCalls.count == 2 }
                try expect("Undo retry retains original account", f.state.chatCalls[1].0 == a)
                f.state.finish(1); try await wait("Undo retry completes") { try f.record(id).status == .complete }
            }
            do {
                let f = try CameraCheckFixture("refinement", response:response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                let hints = NativeMealAnalysisHints(ingredients:["Carrot"],portion:.init(amount:150,unit:"g"))
                var id = ""
                try expect("ingredient refinement queues", f.coordinator.enqueueMealRefinement(images:[f.image],hints:hints,repair:["eventId":"synthetic-original"],day:"2026-10-15",meal:"Dinner",onQueued:{id=$0}))
                try await wait("refinement request starts") { f.state.chatCalls.count == 1 }
                try expect("refinement retains selected hints and destination", try f.record(id).mealHints == hints && f.record(id).loggingMeal == "Dinner")
                let request = try JSONSerialization.data(withJSONObject:f.state.chatCalls[0].1)
                let text = String(decoding:request,as:UTF8.self)
                try expect("refinement sends ingredient hints only", text.contains("untrustedMealHints") && text.contains("Carrot") && !text.contains("synthetic-original"))
                try expect("ingredient refinement preserves selected provider", f.state.ocrCalls == 0)
                f.state.finish(0); try await wait("refinement completes") { try f.record(id).status == .complete }
            }
            do {
                let f = try CameraCheckFixture("saved-photo-direct-analysis", response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]
                PhotoAnalysisPermission().allow()
                let first = f.submit()
                try await wait("saved photo initial request") { f.state.chatCalls.count == 1 }
                f.state.finish(0); try await wait("saved photo initial completion") { try f.record(first).status == .complete }
                guard let row = f.app.project("historyItem", ["id": first])["row"] as? [String: Any] else { throw CameraCheckError.failed("saved photo row") }
                let previous = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                f.app.openHistory(row)
                f.app.cancelProductRecovery()
                try expect("Saved photo review exposes retained originals", f.app.reviewHasPhotos && f.app.route == "review")
                try expect("Opening a completed History result replays saved analysis without a new photo request", f.state.chatCalls.count == 1 && f.state.ordinaryCalls == 0 && f.coordinator.camera == nil)
                let revealRevision = f.app.analysisHistoryRevealRevision
                f.app.reanalyseReviewPhotos()
                f.app.reanalyseReviewPhotos()
                try await wait("saved photo direct request") { f.state.chatCalls.count == 2 }
                let records = try f.outbox.records(owner: f.owner)
                let newest = records.first { $0.eventID != first }!
                try expect("Saved photo Analyse queues once and dismisses without a camera", records.count == 2 && f.coordinator.camera == nil && f.app.route != "review")
                try expect("Saved photo Analyse opens History with its real pending bar",
                    f.app.selectedTab == "history" && f.app.route == nil &&
                    f.app.analysisHistoryRevealRevision == revealRevision + 1 &&
                    NativeHistoryAnalysisProgress(row: try f.historyPresentationRow(newest.eventID)) != nil)
                try expect("Saved photo analysis retains originals and separate diary intent", try f.outbox.images(for: newest) == [f.image] && newest.addToEaten != true)
                let unchanged = f.app.project("historyItem", ["id": first])["row"] as! [String: Any]
                try expect("Reanalysis keeps the previous saved observation unchanged", try JSONSerialization.data(withJSONObject: unchanged, options: [.sortedKeys]) == previous)
                f.state.finish(1); try await wait("saved photo direct completion") { try f.record(newest.eventID).status == .complete }
            }
            do {
                let f = try CameraCheckFixture("ordinary-refinement-retry", response: response); defer { f.stop() }
                f.state.ordinaryFailure = true
                let hints = NativeMealAnalysisHints(ingredients: ["Carrot"], portion: .init(amount: 150, unit: "g"))
                let repair: [String: Any] = ["eventId": "synthetic-original"]
                var id = ""
                guard f.coordinator.enqueueMealRefinement(images: [f.image], hints: hints, repair: repair, day: "2026-10-15", meal: "Dinner", onQueued: { id = $0 }) else {
                    throw CameraCheckError.failed("ordinary refinement setup")
                }
                try await wait("ordinary refinement failure saved") { try f.record(id).status == .retryableFailure }
                let submissionID = try f.record(id).submissionID
                f.coordinator.suspendPending(); f.coordinator.resumePending()
                try await Task.sleep(nanoseconds: 60_000_000)
                try expect("failed ordinary refinement background resume does not respend", f.state.ordinaryCalls == 1 && (try f.record(id).status) == .retryableFailure)
                f.state.permission = false; f.coordinator.resumePending()
                f.state.permission = true; f.coordinator.resumePending()
                try await Task.sleep(nanoseconds: 60_000_000)
                try expect("failed ordinary refinement permission recovery does not respend", f.state.ordinaryCalls == 1 && (try f.record(id).status) == .retryableFailure)
                f.state.ordinaryFailure = false
                var resumedID = ""
                try expect("same-hints explicit Analyse reuses failed ordinary refinement", f.coordinator.enqueueMealRefinement(images: [f.image], hints: hints, repair: repair, day: "2026-10-15", meal: "Dinner", onQueued: { resumedID = $0 }) && resumedID == id)
                try await wait("explicit ordinary refinement completes") { try f.record(id).status == .complete }
                f.coordinator.resumePending(); try await Task.sleep(nanoseconds: 60_000_000)
                try expect("explicit ordinary refinement retries exactly once with retained context", f.state.ordinarySubmissionIDs == [submissionID, submissionID] && f.state.ordinaryCalls == 2 && f.state.chatCalls.isEmpty && f.state.ocrCalls == 0 && (try f.record(id).mealHints) == hints && (try f.record(id).loggingMeal) == "Dinner")
            }
            do {
                let f = try CameraCheckFixture("local-label", response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]; f.state.ocrPages = labelPages
                let first = f.submit()
                try await wait("local label completes") { try f.record(first).status == .complete }
                try expect("supported local label makes no cloud request", f.state.chatCalls.isEmpty && f.state.ordinaryCalls == 0 && f.state.ocrCalls == 1)
                try expect("validated local OCR cached privately", try f.cacheCount() == 1)
                let second = f.submit()
                try await wait("cached label completes") { try f.record(second).status == .complete }
                try expect("repeat image reuses OCR without another recognition", f.state.ocrCalls == 1 && f.state.chatCalls.isEmpty && f.state.ordinaryCalls == 0)
                try expect("cache reuse retains new capture identity", first != second && (try f.record(first).photoIDs) != f.record(second).photoIDs)
                let stored = [first, second].compactMap { f.app.project("historyItem", ["id": $0])["row"] as? [String: Any] }
                try expect("local label retains complete nutrition in History", stored.count == 2 && stored.allSatisfy {
                    let nutrients = ($0["extraction"] as? [String: Any])?["nutrients"] as? [String: [String: Any]]
                    return nutrients?.count == 8 && nutrients?.values.allSatisfy { $0["value"] is NSNumber } == true
                })
                try expect("deleting local capture commits", f.app.perform("historyDelete", ["id": first]))
                try await Task.sleep(nanoseconds: 60_000_000)
                try expect("deletion purges private OCR text", try f.cacheCount() == 0)
            }
            do {
                let f = try CameraCheckFixture("local-product-review", response: response); defer { f.stop() }
                f.state.ocrPages = labelPages
                let id = f.submit(); try await wait("local review fixture completes") { try f.record(id).status == .complete }
                let row = f.app.project("historyItem", ["id": id])["row"] as! [String: Any]
                f.app.openHistory(row)
                let marker = (f.app.review["extraction"] as? [String: Any])?["fastCapture"] as? [String: Any]
                try expect("local product fast marker survives real review normalization", marker?["version"] as? Int == 1)
                let product: [String: Any] = ["name": "Synthetic label", "basisUnit": "g", "nutritionPreparation": "as_sold", "nutrients": ["energyKcal": ["value": 200, "unit": "kcal", "status": "supplied"]]]
                guard f.app.perform("recordHistory", ["id": id, "product": product]) else { throw CameraCheckError.failed("product history setup") }
                f.app.openHistory(f.app.project("historyItem", ["id": id])["row"] as! [String: Any])
                try expect("product History source marker prevents automatic recovery", f.app.review["extraction"] == nil && f.app.project("productRecovery")["needsRecovery"] as? Bool == true && f.app.productRecoveryMessage == "Available nutrition is shown. Tap Retry to request further verification." && !f.app.recoveringProduct)
                PhotoAnalysisPermission(defaults: CameraCheckEnvironment.defaults).revoke()
                f.app.retryProductRecovery()
                try expect("explicit product recovery Retry reaches permission gate", f.app.productRecoveryMessage?.hasPrefix("AI analysis is off.") == true && !f.app.recoveringProduct)
                guard f.app.perform("reviewConfirm") else { throw CameraCheckError.failed("synthetic product confirmation: " + (f.app.errorMessage ?? "unknown")) }
                f.app.openHistory(f.app.project("historyItem", ["id": id])["row"] as! [String: Any])
                try expect("confirmed linked product History stays quiet", f.app.review["entryId"] is String && f.app.project("productRecovery").isEmpty && !f.app.recoveringProduct && f.app.productRecoveryMessage == nil)
            }
            for scenario in ["cancel", "delete", "retake", "owner"] {
                let f = try CameraCheckFixture("ocr-" + scenario, response: response); defer { f.stop() }
                f.state.selection = a; f.state.valid = [a]; f.state.ocrPages = labelPages; f.state.holdOCR = true
                let id = f.submit(); try await wait("held OCR starts") { f.state.pendingOCR.count == 1 }
                switch scenario {
                case "cancel": f.coordinator.cancelAllPhotoAnalyses()
                case "delete": try expect("delete during OCR commits", f.app.perform("historyDelete", ["id": id]))
                case "retake":
                    let revised = SmartFoodCameraViewController(images: [f.image], photoIDs: [UUID().uuidString], revision: 2)
                    f.coordinator.prepareRetry(revised, eventID: id)
                    f.coordinator.foodCamera(revised, changedPhotoCount: 1)
                default: f.state.owner = String(repeating: "b", count: 64); f.state.revision += 1
                }
                f.state.finishOCR(0); try await Task.sleep(nanoseconds: 100_000_000)
                try expect(scenario + " prevents late OCR delivery", try f.record(id).status != .complete)
                try expect(scenario + " prevents late cache writes and provider fallback", try f.cacheCount() == 0 && f.state.chatCalls.isEmpty && f.state.ordinaryCalls == 0)
            }
            do {
                let f = try CameraCheckFixture("local-ordinary", response: response); defer { f.stop() }
                f.state.ocrPages = labelPages
                let id = f.submit(); try await wait("ordinary selection gets local result") { try f.record(id).status == .complete }
                try expect("ordinary selection local result retains local-only marker", try f.record(id).localAnalysis == true && f.state.ordinaryCalls == 0 && f.state.chatCalls.isEmpty)
                try expect("local-only ordinary capture deletion commits", f.app.perform("historyDelete", ["id": id]))
                try await Task.sleep(nanoseconds: 60_000_000)
                try expect("local-only ordinary deletion makes no remote request", f.state.deleteCalls == 0)
            }
            do {
                let f = try CameraCheckFixture("ordinary-manual-retry", response: response); defer { f.stop() }
                f.state.ordinaryFailure = true
                let id = f.submit(); try await wait("ordinary fast failure saved") { try f.record(id).status == .retryableFailure }
                f.coordinator.resumePending(); try await Task.sleep(nanoseconds: 60_000_000)
                try expect("ordinary fast failure does not automatically respend", f.state.ordinaryCalls == 1)
                f.state.permission = false; f.coordinator.resumePending()
                f.state.permission = true; f.coordinator.resumePending(); try await Task.sleep(nanoseconds: 60_000_000)
                try expect("ordinary fast failure permission revoke/grant cannot respend", f.state.ordinaryCalls == 1 && (try f.record(id).status) == .retryableFailure)
                f.state.ordinaryFailure = false
                _ = f.coordinator.retryHistory(["id": id]); try await wait("ordinary explicit Retry completes") { try f.record(id).status == .complete }
                try expect("ordinary explicit Retry starts one new request", f.state.ordinaryCalls == 2)
            }
            do {
                let directory = CameraCheckEnvironment.root.appendingPathComponent("cache-unit")
                let images = [Data([1,2]), Data([3])], key = FoodTextCache.key(images: images), now = Date()
                FoodTextCache.save(pages: labelPages, directory: directory, key: key, now: now)
                let hit = FoodTextCache.load(directory: directory, key: key, photoIDs: ["new-photo"], now: now.addingTimeInterval(1))
                try expect("cache rebinds photo ID with one-based index", hit?.first?.photoID == "new-photo" && hit?.first?.photoIndex == 1)
                try expect("cache key distinguishes order and image boundaries", key != FoodTextCache.key(images: Array(images.reversed())) && key != FoodTextCache.key(images: [Data([1,2,3])]))
                try expect("expired and future-dated cache facts are not reused", FoodTextCache.load(directory: directory, key: key, photoIDs: ["new-photo"], now: now.addingTimeInterval(31 * 86_400)) == nil && FoodTextCache.load(directory: directory, key: key, photoIDs: ["new-photo"], now: now.addingTimeInterval(-1)) == nil)
                let file = directory.appendingPathComponent(key + ".json")
                var object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
                object["factsHash"] = "tampered"
                try JSONSerialization.data(withJSONObject: object).write(to: file)
                try expect("cache corruption fails closed", FoodTextCache.load(directory: directory, key: key, photoIDs: ["new-photo"], now: now.addingTimeInterval(1)) == nil)
                for index in 0..<20 { FoodTextCache.save(pages: labelPages, directory: directory, key: FoodTextCache.key(images: [Data([UInt8(index)])]), now: now) }
                try expect("private cache is bounded to sixteen entries", try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.count <= 16)
            }
            do {
                let f = try CameraCheckFixture("ordinary-restart", response: response); defer { f.stop() }
                try f.legacy("restarted-fast-job", status: .processing)
                var record = try f.record("restarted-fast-job"); record.fastCaptureVersion = 1; record.attempts = 1
                _ = try f.outbox.save(record); f.coordinator.resumePending()
                try await Task.sleep(nanoseconds: 60_000_000)
                try expect("interrupted new fast job is manual after restart", try f.record(record.eventID).status == .retryableFailure && f.state.ordinaryCalls == 0 && f.state.ocrCalls == 0)
                _ = f.coordinator.retryHistory(["id": record.eventID]); try await wait("restart explicit Retry completes") { try f.record(record.eventID).status == .complete }
                try expect("restart recovery requires one explicit new request", f.state.ordinaryCalls == 1)
            }
            do {
                let f = try CameraCheckFixture("lost-upload-acknowledgement", response: response); defer { f.stop() }
                f.state.ordinaryError = CaptureTransportFailure(underlying: URLError(.networkConnectionLost), retryAfter: 3600, manualRetryRequired: true)
                let id = f.submit(); try await wait("lost upload acknowledgement is saved") { try f.record(id).status == .retryableFailure }
                let identity = try f.record(id).submissionID
                try expect("lost upload acknowledgement retains remote acceptance", try f.record(id).remoteAccepted && !f.record(id).manualRetryRequested)
                f.coordinator.suspendPending(); f.coordinator.resumePending()
                try await Task.sleep(nanoseconds: 60_000_000)
                try expect("lost upload acknowledgement never automatically resumes paid work", f.state.ordinaryCalls == 1 && (try f.record(id).status) == .retryableFailure)
                _ = f.coordinator.retryHistory(["id": id])
                let retry = try f.record(id)
                try expect("explicit lost-ack Retry selects retry route under server backoff", retry.status == .queued && retry.remoteAccepted && retry.manualRetryRequested && retry.submissionID == identity && (retry.nextAttemptAt ?? .distantPast) > Date() && f.state.ordinaryCalls == 1)
            }
            for key in ["captureMissing", "captureExpired"] {
                let f = try CameraCheckFixture("ordinary-" + key, response: response); defer { f.stop() }
                f.state.ordinaryEnvelope = [key: true]
                let id = f.submit(); try await wait("missing result saved for retry") { try f.record(id).status == .retryableFailure }
                let identity = try f.record(id).submissionID
                f.coordinator.resumePending(); try await Task.sleep(nanoseconds: 60_000_000)
                try expect(key + " does not automatically launch fresh paid work", try f.record(id).submissionID == identity && f.state.ordinaryCalls == 1)
                f.state.ordinaryEnvelope = nil
                _ = f.coordinator.retryHistory(["id": id])
                try await wait(key + " explicit Retry completes") { try f.record(id).status == .complete }
                let retriedIdentity = try f.record(id).submissionID
                f.coordinator.resumePending(); try await Task.sleep(nanoseconds: 60_000_000)
                try expect(key + " explicit Retry makes one request with the correct submission identity", f.state.ordinaryCalls == 2 && f.state.ordinarySubmissionIDs == [identity, retriedIdentity] && (key == "captureExpired" ? retriedIdentity != identity : retriedIdentity == identity))
            }
            let result:[String:Any] = ["passed":true,"checkCount":checks.count,"checks":checks,"phoneActions":0,"realNetworkRequests":0,"realCredentials":false,"productionCoordinatorStoreOutbox":true,"limits":["Synthetic Catalyst coordinator execution, not simulator or phone interaction.","Environmental singleton setup isolated in generated copies; see source-evidence.json."]]
            let data = try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys])
            try data.write(to:CameraCheckEnvironment.root.appendingPathComponent("receipt.json"))
            print(String(decoding:data,as:UTF8.self)); exit(0)
        } catch {
            print("FAIL after \(checks.count) checks: \(error)"); exit(1)
        }
    }
}
