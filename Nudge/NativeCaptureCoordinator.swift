import UIKit
import Network

/// Owns capture and account lifetimes independently of any rendered screen.
@MainActor
final class NativeCaptureCoordinator: NSObject, SmartFoodCameraDelegate {
    private weak var store: NativeAppStore?
    // Transient milestones avoid rewriting the entire History store for each
    // visual update. Durable job state supplies the fallback after relaunch.
    private var analysisStages: [String: (owner: String, stage: NativeAnalysisStage)] = [:]
    private var latestAnalysisID: String?
    func analysisStage(for id: String) -> NativeAnalysisStage? {
        guard let value = analysisStages[id], value.owner == ownerKey() else { return nil }
        return value.stage
    }
    var latestAnalysisStage: NativeAnalysisStage? { latestAnalysisID.flatMap { analysisStage(for: $0) } }
    private func setAnalysisStage(_ stage: NativeAnalysisStage, for record: NativeCaptureRecord) {
        guard record.ownerKey == ownerKey() else { return }
        store?.objectWillChange.send()
        analysisStages[record.eventID] = (record.ownerKey, stage)
    }
    private(set) var camera: SmartFoodCameraViewController?
    private struct DeferredCameraDraft {
        let camera: SmartFoodCameraViewController
        let eventID: String
        let day: String
        let meal: String
        let repair: [String: Any]?
        let owner: String?
        let account: Int
    }
    private var deferredCameras: [ObjectIdentifier: DeferredCameraDraft] = [:]
    private(set) var loggingDay = ""
    private(set) var loggingMeal = ""
    private var generation = UUID()
    private var eventID = UUID().uuidString
    private(set) var photoEventID = UUID().uuidString
    private var persistedPhotoRevision: Int?
    private var repairReview: [String: Any]?
    private var barcodePending = false
    private var barcodeGeneration: UUID?
    typealias PhotoAnalysis = ([Data], [String], Int, VoiceMemoPayload?, UUID) async throws -> [String: Any]
    private let analysePhotos: PhotoAnalysis?
    typealias TextRecognition = ([Data], [String]) async throws -> FoodOCRResult
    private let recognizeText: TextRecognition
    typealias ChatGPTAnalysis = (ChatGPTCaptureBinding, [String: Any], UUID) async throws -> String
    private let cameraSelection: @MainActor () throws -> ChatGPTCaptureBinding?
    private let chatGPTBindingCurrent: @MainActor (ChatGPTCaptureBinding) -> Bool
    private let analyseChatGPT: ChatGPTAnalysis
    private let permissionAllowed: () -> Bool
    private let accountRevision: @MainActor () -> Int
    private var photoTasks: [String: Task<Void, Never>] = [:]
    private var photoTaskTokens: [String: UUID] = [:]
    private var activeBarcodeJobs: [String: String] = [:]
    private var backgroundTasks: [String: UIBackgroundTaskIdentifier] = [:]
    private let service = NutritionLabelService()
    typealias CaptureDeletion = (UUID, String) async throws -> Void
    private let deleteCapture: CaptureDeletion?
    private var photoCaptureIDs: [String: UUID] = [:]
    let outbox: NativeCaptureOutbox
    private let ownerKey: @MainActor () -> String?
    private var retryTimer: Timer?
    private var monitor: NWPathMonitor?
    private var activeIDs = Set<UUID>()
    private var storageBlocked = false
    private var applicationActive = true
    private var automaticRetriesPaused = false
    typealias ProductLookup = (String, UUID) async throws -> BarcodeProduct
    private let lookup: ProductLookup
    private let productContext: NativeProductContextModel
    private let dismissForNavigation: (UIViewController, @escaping () -> Void) -> Void
    private var contextTask: Task<Void, Never>?
    private var scannedProduct: [String: Any]?
    private var alternatives: NativeProductAlternativesSnapshot?
    private(set) var scanSummary: CameraProductSummary?

    init(store: NativeAppStore, lookup: @escaping ProductLookup = { barcode, diagnosticID in
        try await OpenFoodFactsService.catalogueConnected.lookup(barcode: barcode, diagnosticID: diagnosticID)
    }, productContext: NativeProductContextModel? = nil,
         analysePhotos: PhotoAnalysis? = nil,
         recognizeText: @escaping TextRecognition = { images, ids in try await VisionFoodTextRecognizer.recognize(images: images, photoIDs: ids) },
         permissionAllowed: @escaping () -> Bool = { PhotoAnalysisPermission().allowed },
         cameraSelection: @escaping @MainActor () throws -> ChatGPTCaptureBinding? = { try ChatGPTConnection.shared.cameraSelectionForCapture() },
         chatGPTBindingCurrent: @escaping @MainActor (ChatGPTCaptureBinding) -> Bool = { ChatGPTConnection.shared.isCaptureBindingCurrent($0) },
         analyseChatGPT: @escaping ChatGPTAnalysis = { binding, request, id in
             try await ChatGPTConnection.shared.analyseCapture(binding: binding, request: request, diagnosticID: id) { metadata in
                 AnalysisDiagnostics.shared.record(stage: "capture_performance", outcome: "usage_received", metadata: metadata)
             }
         },
         accountRevision: @escaping @MainActor () -> Int = { NudgeAccountManager.shared.revision },
         outbox: NativeCaptureOutbox? = nil, ownerKey: (@MainActor () -> String?)? = nil, deleteCapture: CaptureDeletion? = nil,
         dismissForNavigation: @escaping (UIViewController, @escaping () -> Void) -> Void = { controller, completion in
             if controller.presentingViewController == nil { completion() }
             else { controller.dismiss(animated: true, completion: completion) }
         }) {
        self.store = store; self.lookup = lookup; self.analysePhotos = analysePhotos; self.deleteCapture = deleteCapture
        self.recognizeText = recognizeText
        self.cameraSelection = cameraSelection; self.chatGPTBindingCurrent = chatGPTBindingCurrent; self.analyseChatGPT = analyseChatGPT
        self.dismissForNavigation = dismissForNavigation
        self.outbox = outbox ?? store.captureOutbox
        self.ownerKey = ownerKey ?? { NudgeAccountManager.shared.captureOwnerKey }
        self.permissionAllowed = permissionAllowed; self.accountRevision = accountRevision
        self.productContext = productContext ?? NativeProductContextModel()
    }
    private func cancelContext(discardAlternatives: Bool = true) {
        contextTask?.cancel(); contextTask = nil; productContext.cancel()
        if discardAlternatives { alternatives = nil }
    }
    /// Shared lifecycle entry for presentation and isolated camera-flow tests.
    func prepare(_ selected: SmartFoodCameraViewController, repair: Bool = false) {
        generation = UUID(); cancelContext()
        store?.analysisFailure = nil; store?.missingProductBarcode = nil; store?.loading = false
        barcodePending = false; scannedProduct = nil; scanSummary = nil
        repairReview = repair ? store?.review : nil
        loggingDay = store?.loggingDay ?? ""
        loggingMeal = store?.loggingMeal ?? ""
        eventID = "native-scan:" + UUID().uuidString
        photoEventID = "native-photo:" + UUID().uuidString
        persistedPhotoRevision = nil
        camera?.closeCapture(); camera = selected; selected.delegate = self
    }


    private var root: UIViewController? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
    }
    private func present(_ action: @escaping (UIViewController) -> Void) {
        guard let root else { store?.errorMessage = "This screen could not open. Please try again."; return }
        NudgeCameraPresentation.whenReady(from: root, isCurrent: { true }) { presenter in
            if let presenter { action(presenter) }
        }
    }
    func start(repair: Bool = false) {
        guard camera?.isCaptureInFlight != true else { return }
        guard let selected = prepareFreshCamera(repair: repair) else { resume(); return }
        present { [weak self] presenter in
            guard self?.camera === selected else { return }
            selected.resumePresentation(); presenter.present(selected, animated: true)
        }
    }
    /// Ordinary opening always starts a new batch. Suspended photos remain a
    /// durable History draft, accessible only through an explicit Retry.
    @discardableResult func prepareFreshCamera(repair: Bool = false) -> SmartFoodCameraViewController? {
        guard camera?.isCaptureInFlight != true else { return nil }
        if let previous = camera,
           !previous.capturedImages.isEmpty || previous.capturedVoiceMemo != nil,
           persistedPhotoRevision != previous.captureSetRevision,
           savePhotos(previous, status: .draft) == nil {
            // A failed save must never turn a fresh-camera request into loss of
            // the only in-memory originals. Resume them so saving can be retried.
            return nil
        }
        let selected = SmartFoodCameraViewController(photosOnly: repair, continuousBarcodeScanning: !repair)
        prepare(selected, repair: repair)
        return selected
    }
    func resume() {
        if camera == nil, let (key, pending) = deferredCameras.first(where: {
            !$0.value.camera.isCaptureInFlight && ($0.value.owner == nil || $0.value.owner == ownerKey()) && $0.value.account == accountRevision()
        }) {
            deferredCameras[key] = nil
            prepareRetry(pending.camera, eventID: pending.eventID, repair: pending.repair)
            loggingDay = pending.day; loggingMeal = pending.meal
        }
        guard let camera else { start(); return }
        generation = UUID()
        if camera.capturedImages.isEmpty && camera.capturedVoiceMemo == nil {
            loggingDay = store?.loggingDay ?? ""; loggingMeal = store?.loggingMeal ?? ""
        }
        store?.loading = false; store?.analysisFailure = nil
        camera.analysisFailed("Your photos are ready. Review or retry analysis.")
        present { [weak self] presenter in
            guard self?.camera === camera else { return }
            camera.resumePresentation(); presenter.present(camera, animated: true)
        }
    }
    func foodCameraAnalysisServiceText(_ camera: SmartFoodCameraViewController) -> String {
        if camera.capturedVoiceMemo != nil { return "This capture includes a voice note and uses Nudge’s service for photos and audio." }
        // A saved job keeps its provider even after settings change.
        if let owner = ownerKey(), let saved = try? outbox.record(eventID: photoEventID, owner: owner), saved.attempts > 0,
           saved.captureRevision == camera.captureSetRevision {
            return saved.chatGPTBinding == nil ? "Uses Nudge’s service for this saved capture." : "Uses the ChatGPT account originally chosen for this saved capture."
        }
        return store?.photoAnalysisServiceText ?? "Uses Nudge’s service"
    }
    func cancelAnalysis() { generation = UUID(); store?.loading = false; resume() }
    func foodCamera(_ camera: SmartFoodCameraViewController, found barcode: String) {
        let decodedAt = CaptureClock.now
        guard self.camera === camera else { return }
        cancelContext(); generation = UUID(); barcodeGeneration = generation
        scannedProduct = nil; scanSummary = nil; repairReview = nil
        // A repeated observation cannot create another pending lookup for the
        // same pack/destination, even if a camera callback is delivered twice.
        do {
            let pending = try ownerKey().flatMap { owner in
                try outbox.records(owner: owner).first {
                    $0.barcode == barcode && [.queued, .processing, .retryableFailure].contains($0.status) &&
                    $0.loggingDay == loggingDay && $0.loggingMeal == loggingMeal && isCurrent($0)
                }
            }
            eventID = pending?.eventID ?? "native-scan:" + UUID().uuidString
            if pending == nil, saveBarcode(barcode, eventID: eventID, decodedAt: decodedAt,
                captureBasis: camera.lastBarcodeWasManual ? "barcode_entry" : "barcode_decode") == nil { return }
        } catch { store?.errorMessage = "Saved scans could not be opened. Try again."; return }
        barcodePending = true; store?.missingProductBarcode = nil
        if let object = historyState(eventID)["event"] as? [String: Any], let product = object["product"] as? [String: Any], !product.isEmpty {
            scannedProduct = product; refreshSummary()
        } else {
            camera.showProductSummary(CameraProductSummary(object: ["status":"loading", "compact":true, "name":"Finding your product…"])!)
        }
        // Each accepted scan has its own durable job. A later scan changes only
        // the visible card; queued lookups keep running and finish in History.
        automaticRetriesPaused = false
        resumePending()
    }
    private func presentsBarcode(_ record: NativeCaptureRecord) -> Bool {
        camera != nil && eventID == record.eventID && barcodeGeneration == generation
    }
    private func presentScannedProduct(_ product: [String: Any], record: NativeCaptureRecord) {
        guard presentsBarcode(record), let camera else { return }
        let current = generation
        scannedProduct = product; refreshSummary()
        let profile = store?.state["nutritionProfile"] as? [String: Any] ?? [:]
        let avoidMilk = store?.state["avoidMilk"] as? Bool == true
        contextTask = Task { [weak self] in
            guard let self, generation == current else { return }
            await productContext.load(product: product, profile: profile, avoidMilk: avoidMilk,
                selectedStore: ProductSearchPreferences.shared.store,
                automaticallyFindAlternatives: (scanSummary?.nutritionScore ?? 100) < 50,
                onAlternativesChange: { [weak self] snapshot in
                    guard let self, generation == current, self.camera === camera else { return }
                    alternatives = snapshot; refreshSummary()
                }, onRecallAssessment: { [weak self] assessment in
                    guard let self, generation == current, self.camera === camera else { return }
                    scannedProduct?["recallAssessment"] = assessment; refreshSummary()
                })
        }
    }
    private func presentScanFailure(_ error: Error, record: NativeCaptureRecord) {
        guard presentsBarcode(record), let camera else { return }
        if error as? BarcodeLookupError == .notFound { store?.missingProductBarcode = record.barcode }
        let summary = CameraProductSummary(object: ["status":"error", "compact":true, "name":"Scan saved", "message":error as? BarcodeLookupError == .notFound ? "Photograph the label to identify this product." : "Saved — waiting for connection", "primaryAction":"label"])!
        scanSummary = summary; camera.showProductSummary(summary)
    }
    private func refreshSummary() {
        guard let product = scannedProduct, let store, let camera else { return }
        let model = store.scannedProductModel(product), score = model["score"] as? [String: Any] ?? [:]
        let allergy = model["allergies"] as? [String: Any] ?? [:]
        var warnings = [allergy["warning"] as? String ?? ""]
        if let recall = product["recallAssessment"] as? [String: Any], ["matched", "potential_match"].contains(recall["status"] as? String ?? "") {
            warnings.append(recall["message"] as? String ?? "Possible product recall. Open the product for details.")
        }
        var payload: [String: Any] = ["status":"ready", "compact":true,
            "name":product["name"] ?? "Your product", "brand":product["brand"] ?? "",
            "imageURL":model["image"] ?? product["imageURL"] ?? "",
            "score":score["value"] ?? NSNull(), "grade":score["grade"] ?? "",
            "scoreMethod":score["methodId"] ?? "", "scoreVersion":score["version"] ?? "",
            "scoreStatus":score["status"] ?? "", "scoreConfidence":score["confidence"] ?? "",
            "provisionalText":score["methodId"] as? String == "nudge_nutrition_v0_4" ? "" : score["estimated"] as? Bool == true ? "Estimated rating" : score["status"] as? String == "provisional" ? "Provisional rating" : "",
            "warningText":warnings.filter { !$0.isEmpty }.joined(separator: " ")]
        if CameraProductSummary.numericScore(score["value"]) == nil {
            payload["message"] = "More label information is needed to calculate a rating."
        } else if score["methodId"] as? String == "nudge_nutrition_v0_4" {
            payload["message"] = score["reason"] as? String ?? ""
        }
        if let value = CameraProductSummary.numericScore(score["value"]), value < 50, let alternatives {
            payload["alternativesTitle"] = alternatives.selectedStore.map { "Better at \($0.title)" } ?? "Better alternatives"
            payload["alternativesMessage"] = alternatives.message
            payload["alternatives"] = alternatives.rows.compactMap { row -> [String: Any]? in
                guard let candidate = row["product"] as? [String: Any], let id = row["identity"] as? String,
                      let rating = CameraProductSummary.numericScore(row["value"]) else { return nil }
                return ["id":id, "name":candidate["name"] ?? "Product", "brand":row["retailer"] ?? candidate["brand"] ?? "",
                    "score":rating, "scoreText":"\(rating)%", "imageURL":row["imageURL"] ?? candidate["imageURL"] ?? ""]
            }
        }
        guard let summary = CameraProductSummary(object: payload) else { return }
        scanSummary = summary; camera.showProductSummary(summary)
    }
    func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data]) {
        foodCamera(camera, analyse: images, addToEaten: false)
    }
    func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data], addToEaten: Bool) {
        guard self.camera === camera, photoTasks[photoEventID] == nil,
              permissionAllowed(), !images.isEmpty, images == camera.capturedImages else { return }
        let revision = camera.captureSetRevision
        let originatingReview = repairReview?["confirmationId"] as? String
        guard let record = savePhotos(camera, status: .queued, addToEaten: addToEaten) else { return }
        assert(record.eventID == photoEventID)
        // Originals, voice, destination and History have been committed before
        // the camera forgets this batch. The next capture gets a new identity.
        photoEventID = "native-photo:" + UUID().uuidString
        persistedPhotoRevision = nil
        repairReview = nil; cancelContext(); barcodePending = false
        generation = UUID(); scannedProduct = nil; scanSummary = nil
        camera.dismissProductSummary()
        _ = camera.acceptSubmittedCapture(revision: revision)
        store?.loading = false; store?.analysisFailure = nil
        automaticRetriesPaused = false
        resumePending()
        // The durable job owns analysis now. Close the capture screen while
        // History keeps reporting progress; adding to the diary is separate.
        self.camera = nil
        camera.closeCapture()
        dismissForNavigation(camera) { [weak self] in
            guard let store = self?.store else { return }
            if let originatingReview, !originatingReview.isEmpty, store.route == "review",
               store.review["confirmationId"] as? String == originatingReview { store.dismissReview() }
            store.acknowledgeAnalysis(showHistory: store.route != "review")
        }
    }
    private func historyGeneration(id: String) -> Int {
        (store?.history["generations"] as? [String: Any])?[id] as? Int ?? 0
    }
    private func finishPhotoAnalysis(id: String, token: UUID, captureID: UUID) {
        guard photoTaskTokens[id] == token else { return }
        let waitingForServer = ownerKey().flatMap { try? outbox.record(eventID: id, owner: $0) }
            .map { $0.status == .queued && $0.remoteAccepted } ?? false
        if !waitingForServer && (id != latestAnalysisID || analysisStage(for: id) != .complete) {
            analysisStages.removeValue(forKey: id)
        }
        photoTasks.removeValue(forKey: id); photoTaskTokens.removeValue(forKey: id)
        activeBarcodeJobs = activeBarcodeJobs.filter { $0.value != id }
        activeIDs.remove(captureID); photoCaptureIDs.removeValue(forKey: id)
        if let background = backgroundTasks.removeValue(forKey: id), background != .invalid {
            UIApplication.shared.endBackgroundTask(background)
        }
        store?.analysingCount = photoTasks.count
        schedulePending()
    }
    private func interruptPhotoAnalysis(id: String, token: UUID) {
        guard photoTaskTokens[id] == token, let selectedTask = photoTasks[id] else { return }
        selectedTask.cancel()
        if let owner = ownerKey(), var record = try? outbox.record(eventID: id, owner: owner) {
            if record.status != .deleted, historyGeneration(id: id) == record.historyGeneration,
               historyState(id)["deleted"] as? Bool != true {
                record.status = .retryableFailure; record.errorCode = "analysis_interrupted"
                record.attempts = 6; record.nextAttemptAt = nil
                _ = persist(record)
            }
            finishPhotoAnalysis(id: id, token: token, captureID: record.id)
        } else {
            photoTasks.removeValue(forKey: id); photoTaskTokens.removeValue(forKey: id)
            activeBarcodeJobs = activeBarcodeJobs.filter { $0.value != id }
            if let captureID = photoCaptureIDs.removeValue(forKey: id) { activeIDs.remove(captureID) }
            if let background = backgroundTasks.removeValue(forKey: id), background != .invalid { UIApplication.shared.endBackgroundTask(background) }
            store?.analysingCount = photoTasks.count
        }
    }
    private func backgroundLeaseExpired(id: String, token: UUID) {
        guard photoTaskTokens[id] == token else { return }
        photoTasks[id]?.cancel()
        if let owner = ownerKey(), let record = try? outbox.record(eventID: id, owner: owner) {
            requeue(record)
            finishPhotoAnalysis(id: id, token: token, captureID: record.id)
        }
    }
    func cancelAllPhotoAnalyses() {
        automaticRetriesPaused = true; retryTimer?.invalidate(); retryTimer = nil
        for (id, token) in Array(photoTaskTokens) { interruptPhotoAnalysis(id: id, token: token) }
        analysisStages.removeAll(); latestAnalysisID = nil
        store?.objectWillChange.send()
    }
    /// Preparing a retained scan is separate from presentation so a failed
    /// analysis keeps its identity, repair context and destination together.
    func prepareRetry(_ selected: SmartFoodCameraViewController, eventID: String, repair: [String: Any]? = nil) {
        prepare(selected)
        photoEventID = eventID
        repairReview = repair
        persistedPhotoRevision = nil
    }
    func retryPhotos(_ images: [Data], eventID: String, repair: [String: Any]? = nil) {
        if let camera, photoEventID == eventID, !camera.capturedImages.isEmpty {
            if let repair { repairReview = repair }
            resume(); return
        }
        do {
            let saved = try ownerKey().flatMap { try outbox.record(eventID: eventID, owner: $0) }
            if let saved {
                guard saved.status != .deleted, historyState(eventID)["deleted"] as? Bool != true,
                      saved.historyGeneration == historyGeneration(id: eventID) else { return }
            }
            let selected: SmartFoodCameraViewController
            if let saved {
                selected = SmartFoodCameraViewController(photosOnly: true, images: try outbox.images(for: saved), photoIDs: saved.photoIDs,
                    revision: saved.captureRevision, voiceMemo: try outbox.voiceMemo(for: saved))
            } else { selected = SmartFoodCameraViewController(images: images) }
            prepareRetry(selected, eventID: eventID, repair: repair ?? saved?.repairContext.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })
            if let saved {
                loggingDay = saved.loggingDay ?? loggingDay; loggingMeal = saved.loggingMeal ?? loggingMeal
                persistedPhotoRevision = saved.captureRevision
            }
            resume()
        } catch { store?.analysisFailure = "This saved capture could not be opened. Its originals have been kept. Try again." }
    }
    func foodCamera(_ camera: SmartFoodCameraViewController, changedPhotoCount count: Int) {
        guard self.camera === camera else { return }
        generation = UUID()
        _ = savePhotos(camera, status: .draft)
    }
    func foodCameraDidChangeVoiceMemo(_ camera: SmartFoodCameraViewController) { foodCamera(camera, changedPhotoCount: camera.capturedImages.count) }
    func foodCameraDidCancel(_ camera: SmartFoodCameraViewController) {
        guard self.camera === camera else { return }
        if camera.deferPhotoUntilAfterDismissal() {
            deferredCameras[ObjectIdentifier(camera)] = DeferredCameraDraft(camera: camera, eventID: photoEventID,
                day: loggingDay, meal: loggingMeal, repair: repairReview, owner: ownerKey(), account: accountRevision())
            generation = UUID(); cancelContext(); store?.loading = false
            self.camera = nil; repairReview = nil; scannedProduct = nil; scanSummary = nil; barcodePending = false
            persistedPhotoRevision = nil; loggingDay = ""; loggingMeal = ""
            camera.dismiss(animated: true)
            return
        }
        if (!camera.capturedImages.isEmpty || camera.capturedVoiceMemo != nil) && persistedPhotoRevision != camera.captureSetRevision,
           savePhotos(camera, status: .draft) == nil, persistedPhotoRevision != camera.captureSetRevision {
            camera.setCaptureStorageError("These photos or voice note could not be saved. Keep the camera open and try again.")
            if camera.presentedViewController == nil {
                let alert = UIAlertController(title: "Capture not saved", message: "Keep these photos or voice note open and try saving again, or discard the unsaved changes. Any earlier saved capture remains in History.", preferredStyle: .alert)
                alert.view.tintColor = NudgeTheme.accent
                alert.addAction(UIAlertAction(title: "Keep capture", style: .cancel))
                alert.addAction(UIAlertAction(title: "Discard unsaved changes", style: .destructive) { [weak self, weak camera, weak alert] _ in
                    guard let self, let camera, self.camera === camera else { return }
                    if let alert { alert.dismiss(animated: true) { self.closeCamera(camera) } }
                    else { self.closeCamera(camera) }
                })
                camera.present(alert, animated: true)
            }
            return
        }
        closeCamera(camera)
    }
    func foodCameraDidFinishDeferredPhoto(_ camera: SmartFoodCameraViewController) {
        let key = ObjectIdentifier(camera)
        guard let pending = deferredCameras[key] else { return }
        guard pending.account == accountRevision() else {
            camera.closeCapture(); deferredCameras[key] = nil; return
        }
        guard let currentOwner = ownerKey() else {
            store?.analysisFailure = "Unlock your iPhone, then return to photos to save this capture."
            return
        }
        guard pending.owner == nil || pending.owner == currentOwner else {
            camera.closeCapture(); deferredCameras[key] = nil; return
        }
        if !camera.capturedImages.isEmpty || camera.capturedVoiceMemo != nil {
            guard savePhotoDraft(images: camera.capturedImages, photoIDs: camera.capturedPhotoIDs,
                revision: camera.captureSetRevision, voiceMemo: camera.capturedVoiceMemo,
                eventID: pending.eventID, day: pending.day, meal: pending.meal, repair: pending.repair,
                status: .draft, storageError: camera.setCaptureStorageError) != nil else {
                // Retain the only in-memory original after a disk failure. An
                // explicit Return to photos can recover it; normal open is fresh.
                store?.analysisFailure = "This photo could not be saved. Return to photos to retry saving it."
                return
            }
        }
        if camera.lastPhotoCaptureFailed { store?.errorMessage = "This photo could not be captured. Please take it again." }
        camera.closeCapture(); deferredCameras[key] = nil
    }
    private func closeCamera(_ camera: SmartFoodCameraViewController) {
        complete()
    }
    /// Saving another food while browsing History or the library leaves this draft alone.
    func complete(ifReviewEventID sourceID: String?) {
        guard camera != nil else { return }
        let submittedDraft = sourceID == photoEventID
        guard submittedDraft else { return }
        complete()
    }
    /// A successful save or explicit Close ends the draft; navigation only suspends it.
    func complete() {
        generation = UUID(); cancelContext(); store?.loading = false
        camera?.closeCapture(); camera?.dismiss(animated: true); camera = nil
        repairReview = nil; scannedProduct = nil; scanSummary = nil; barcodePending = false
        persistedPhotoRevision = nil
        loggingDay = ""; loggingMeal = ""
    }
    private func suspendForNavigation(_ selected: SmartFoodCameraViewController, afterDismiss: @escaping () -> Void) {
        generation = UUID(); cancelContext(discardAlternatives: false); store?.loading = false
        let suspendedGeneration = generation
        if barcodePending, scanSummary == nil {
            selected.dismissProductSummary(); barcodePending = false
        }
        selected.suspendForResult()
        // SwiftUI must not present/dismiss the review sheet while its UIKit
        // camera is still leaving. A replaced/closed camera cannot navigate later.
        dismissForNavigation(selected) { [weak self, weak selected] in
            guard let self, let selected, self.camera === selected,
                  self.generation == suspendedGeneration else { return }
            afterDismiss()
        }
    }
    func foodCameraDidOpenHistory(_ camera: SmartFoodCameraViewController) {
        guard self.camera === camera, !camera.isCaptureInFlight else { return }
        suspendForNavigation(camera) { [weak self] in self?.store?.navigate("history") }
    }
    func foodCamera(_ camera: SmartFoodCameraViewController, openFoodLibrary mode: String) {
        guard self.camera === camera, !camera.isCaptureInFlight, ["recents", "favourites"].contains(mode) else { return }
        let day = loggingDay, meal = loggingMeal
        suspendForNavigation(camera) { [weak self] in self?.store?.showFoodLibrary(mode: mode, day: day, meal: meal) }
    }
    func foodCamera(_ camera: SmartFoodCameraViewController, summaryAction action: String, alternativeID: String?) {
        guard self.camera === camera, !camera.isCaptureInFlight else { return }
        if action == "next" {
            generation = UUID(); cancelContext()
            scannedProduct = nil; scanSummary = nil; repairReview = nil
            eventID = "native-scan:" + UUID().uuidString; barcodePending = false
            camera.dismissProductSummary()
        } else if action == "label" {
            generation = UUID(); cancelContext()
            if let scannedProduct { repairReview = ["kind":"product", "product":scannedProduct, "eventId":eventID] }
            barcodePending = false; camera.prepareForLabelCapture()
        } else if action == "alternative", let id = alternativeID,
                  let row = alternatives?.rows.first(where: { $0["identity"] as? String == id }),
                  let product = row["product"] as? [String: Any] {
            suspendForNavigation(camera) { [weak self] in self?.store?.openProductFacts(product) }
        } else if action == "expand", let product = scannedProduct {
            let id = eventID, day = loggingDay, meal = loggingMeal
            suspendForNavigation(camera) { [weak self] in
                self?.store?.openScannedProduct(product, eventID: id, day: day, meal: meal)
            }
        }
    }
    func showAccount() {
        present { [weak self] presenter in
            let previous = NudgeAccountManager.shared.revision
            AccountConnectionPresenter.present(from: presenter) {
                guard let self else { return }
                if previous != NudgeAccountManager.shared.revision {
                    self.cancelAllPhotoAnalyses()
                    self.automaticRetriesPaused = false
                    self.store?.cancelProductRecovery()
                    self.generation = UUID(); self.cancelContext(); self.store?.loading = false
                    self.camera?.closeCapture(); self.camera = nil
                }
                self.resumePending()
                self.store?.objectWillChange.send()
            }
        }
    }
    func showDiagnostics() { present { AnalysisDiagnostics.presentShareSheet(from: $0) } }
    func showAISettings() {
        present { [weak self] presenter in
            let permission = PhotoAnalysisPermission()
            let alert = UIAlertController(title: PhotoAnalysisPermission.title, message: PhotoAnalysisPermission.explanation, preferredStyle: .alert)
            alert.view.tintColor = NudgeTheme.accent
            alert.addAction(UIAlertAction(title: "Close", style: .cancel))
            alert.addAction(UIAlertAction(title: permission.allowed ? "Turn off" : PhotoAnalysisPermission.allowTitle, style: permission.allowed ? .destructive : .default) { _ in
                if permission.allowed {
                    self?.cancelAllPhotoAnalyses()
                    self?.store?.cancelProductRecovery(); permission.revoke(); self?.generation = UUID(); self?.cancelContext()
                    self?.store?.loading = false; self?.camera?.closeCapture(); self?.camera = nil
                } else { permission.allow(); self?.automaticRetriesPaused = false }
                self?.resumePending()
                self?.store?.objectWillChange.send()
            })
            presenter.present(alert, animated: true)
        }
    }
}

extension NativeCaptureCoordinator {
    private func historyState(_ id: String) -> [String: Any] { store?.project("captureState", ["id": id]) ?? [:] }
    private func isCurrent(_ record: NativeCaptureRecord) -> Bool {
        guard ownerKey() == record.ownerKey, historyState(record.eventID)["deleted"] as? Bool != true,
              let current = try? outbox.record(eventID: record.eventID, owner: record.ownerKey) else { return false }
        return current.status != .deleted && current.submissionID == record.submissionID && current.chatGPTBinding == record.chatGPTBinding && historyGeneration(id: record.eventID) == record.historyGeneration
    }
    @discardableResult private func syncHistory(_ record: NativeCaptureRecord) -> Bool {
        let state = historyState(record.eventID)
        guard state["deleted"] as? Bool != true, historyGeneration(id: record.eventID) == record.historyGeneration else { return false }
        var event: [String: Any] = ["id": record.eventID, "kind": record.barcode == nil ? "meal" : "product",
            "status": record.historyStatus, "createdAt": ISO8601DateFormatter().string(from: record.createdAt),
            "name": record.barcode == nil ? "Food analysis" : "Barcode scan", "barcode": record.barcode ?? "",
            "thumbnail": record.thumbnail, "photoCount": record.photoFiles.count, "message": record.message,
            "captureOwnerKey": record.ownerKey, "captureID": record.id.uuidString,
            "errorCode": record.errorCode ?? "", "generation": record.historyGeneration ?? 0,
            "loggingDay": record.loggingDay ?? "", "loggingMeal": record.loggingMeal ?? "", "photos": record.photoReferences ?? []]
        if let bytes = record.repairContext, let repair = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            event["repairEntryId"] = repair["entryId"]; event["repairProduct"] = repair["product"]
            event["repairPortion"] = (repair["draft"] as? [String: Any])?["portion"]
            event["repairEntrySnapshot"] = repair["queuedEntrySnapshot"]
        }
        if let choice = record.addToEaten { event["addToEaten"] = choice }
        if let state = record.diaryAddState { event["diaryAddState"] = state }
        if let previous = state["event"] as? [String: Any],
           previous["product"] is [String: Any] || previous["extraction"] is [String: Any],
           let name = previous["name"] as? String, !name.isEmpty { event["name"] = name }
        for (key, value) in Self.historyProcessingFields(for: record) { event[key] = value }
        if let previous = state["event"] as? [String: Any], Self.historySnapshotMatches(event, previous: previous) { return true }
        return store?.perform("recordHistory", event) == true
    }
    /// Polling is transport bookkeeping, not a new visible analysis phase. Keep
    /// its due date solely in the durable outbox so normal three-second polls
    /// cannot rewrite and republish the entire History archive twice each time.
    nonisolated static func historyProcessingFields(for record: NativeCaptureRecord) -> [String: String] {
        let polling = record.barcode == nil && record.remoteAccepted && record.status == .queued
        let retry = record.status == .retryableFailure ? record.nextAttemptAt : nil
        return ["processingState": polling ? NativeCaptureStatus.processing.rawValue : record.status.rawValue,
                "nextAttemptAt": retry.map { ISO8601DateFormatter().string(from: $0) } ?? ""]
    }
    /// Match the stored representation after the caller checks its deletion
    /// generation. Generation is transport-only; History owns creation time and
    /// omits empty optional fields when it cleans a record.
    nonisolated static func historySnapshotMatches(_ event: [String: Any], previous: [String: Any]) -> Bool {
        var stored = event
        stored.removeValue(forKey: "generation")
        stored["createdAt"] = previous["createdAt"]
        for key in ["loggingDay", "loggingMeal"] where previous[key] == nil && stored[key] as? String == "" {
            stored.removeValue(forKey: key)
        }
        if previous["photos"] == nil, (stored["photos"] as? [String])?.isEmpty == true { stored.removeValue(forKey: "photos") }
        let matchingFields = previous.filter { stored[$0.key] != nil }
        return NSDictionary(dictionary: stored).isEqual(to: matchingFields)
    }
    @discardableResult private func persist(_ record: NativeCaptureRecord) -> NativeCaptureRecord? {
        do {
            var record = record
            // Network callbacks may carry an older intake choice. A pending
            // Today deletion must survive every late retry/status response.
            if let current = try outbox.record(eventID: record.eventID, owner: record.ownerKey), current.submissionID == record.submissionID {
                record.addToEaten = current.addToEaten; record.diaryAddState = current.diaryAddState
            }
            let saved = try outbox.save(record)
            guard syncHistory(saved) else { return nil }
            return saved
        } catch {
            store?.errorMessage = "This capture could not be saved. Keep the camera open and try again."
            return nil
        }
    }
    private func saveBarcode(_ barcode: String, eventID: String, createdAt: Date = Date(), decodedAt: TimeInterval? = nil,
                             captureBasis: String = "barcode_decode") -> NativeCaptureRecord? {
        guard let owner = ownerKey() else { store?.errorMessage = "Unlock your iPhone to save this capture."; return nil }
        var record = NativeCaptureRecord(eventID: eventID, ownerKey: owner)
        record.historyGeneration = historyGeneration(id: eventID)
        record.loggingDay = loggingDay; record.loggingMeal = loggingMeal
        record.createdAt = createdAt; record.barcode = barcode; record.status = .queued
        guard let saved = persist(record) else { return nil }
        if let decodedAt {
            CapturePerformance.shared.begin(eventID: saved.eventID, requestID: saved.submissionID,
                startedAt: decodedAt, captureStartedAt: decodedAt, captureBasis: captureBasis)
        }
        let cached = ProductLookupCache.shared.read(barcode: barcode, now: Date(), allowStale: true).flatMap { store?.productObject($0) }
            ?? store?.project("captureCachedProduct", ["barcode": barcode])["product"] as? [String: Any]
        if let cached, store?.perform("recordHistory", ["id": saved.eventID, "name": cached["name"] ?? "Barcode scan", "product": cached]) == true {
            let nutrition = NutritionLabelService.nutritionDiagnosticMetadata(cached)
            if (nutrition["missingNutrientCount"] as? Int) == 0 && (nutrition["partialNutrientCount"] as? Int ?? 0) == 0 {
                CapturePerformance.shared.ready(eventID: saved.eventID, complete: true,
                    metadata: nutrition.merging(["route": "product_lookup", "cached": true]) { _, new in new })
            }
        }
        return saved
    }
    private func savePhotos(_ camera: SmartFoodCameraViewController, status: NativeCaptureStatus, addToEaten: Bool? = nil) -> NativeCaptureRecord? {
        let saved = savePhotoDraft(images: camera.capturedImages, photoIDs: camera.capturedPhotoIDs,
            revision: camera.captureSetRevision, voiceMemo: camera.capturedVoiceMemo,
            eventID: photoEventID, day: loggingDay, meal: loggingMeal, repair: repairReview,
            status: status, addToEaten: addToEaten, captureStartedAt: camera.captureStartedAt,
            analysisSubmittedAt: camera.analysisSubmittedAt,
            storageError: camera.setCaptureStorageError)
        if saved != nil { persistedPhotoRevision = camera.captureSetRevision }
        if status == .queued, let saved {
            CapturePerformance.shared.record(saved.eventID, outcome: "prepared", metadata: camera.captureTimingMetadata)
        }
        return saved
    }
    /// Reopening a source review must reuse its unfinished refinement. Review
    /// confirmation IDs change on each opening, so they are never job identity.
    nonisolated static func mealRefinementSourceIdentity(_ repair: [String: Any]) -> String? {
        for field in ["entryId", "eventId"] {
            if let value = repair[field] as? String, !value.isEmpty { return field + ":" + value }
        }
        let photos = Set((repair["photos"] as? [String] ?? []).filter {
            $0.range(of: #"^nudge-photo:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jpg$"#, options: .regularExpression) != nil
        }).sorted()
        return photos.isEmpty ? nil : "photos:" + photos.joined(separator: ",")
    }
    nonisolated static func matchesUnfinishedMealRefinement(_ record: NativeCaptureRecord, owner: String, source: String,
                                                          hints: NativeMealAnalysisHints, day: String, meal: String) throws -> Bool {
        guard record.ownerKey == owner, record.barcode == nil,
              [.queued, .processing, .retryableFailure, .needsUserInput].contains(record.status),
              let savedHints = record.mealHints, Set(savedHints.ingredients) == Set(hints.ingredients), savedHints.portion == hints.portion,
              record.loggingDay == day, record.loggingMeal == meal, let context = record.repairContext else { return false }
        guard let repair = try JSONSerialization.jsonObject(with: context) as? [String: Any] else {
            throw NativeCaptureOutbox.Failure.invalidRecord
        }
        return mealRefinementSourceIdentity(repair) == source
    }
    /// Reanalyse the retained originals directly, leaving confirmed intake
    /// untouched until the separate diary action is used on the new result.
    @discardableResult func enqueueSavedPhotoAnalysis(images: [Data], repair: [String: Any], day: String, meal: String) -> Bool {
        guard permissionAllowed(), !images.isEmpty, Self.mealRefinementSourceIdentity(repair) != nil else { return false }
        guard savePhotoDraft(images: images, photoIDs: images.map { _ in UUID().uuidString }, revision: 0, voiceMemo: nil,
            eventID: "native-photo:" + UUID().uuidString, day: day, meal: meal, repair: repair,
            status: .queued, addToEaten: false, storageError: { [weak self] message in
                if let message { self?.store?.analysisFailure = message }
            }) != nil else { return false }
        automaticRetriesPaused = false; resumePending()
        return true
    }
    /// A changed refinement is a fresh durable job. It does not open, replace
    /// or clear a camera draft that the user may already be composing.
    @discardableResult func enqueueMealRefinement(images: [Data], hints: NativeMealAnalysisHints, repair: [String: Any], day: String? = nil, meal: String? = nil, addToEaten: Bool = false, onQueued: ((String) -> Void)? = nil) -> Bool {
        guard permissionAllowed(), hints.isValid, !images.isEmpty else { return false }
        guard let owner = ownerKey(), let source = Self.mealRefinementSourceIdentity(repair) else {
            store?.analysisFailure = "Reopen this saved meal from History to analyse it again."
            return false
        }
        let day = day ?? store?.loggingDay ?? "", meal = meal ?? store?.loggingMeal ?? ""
        do {
            for var record in try outbox.records(owner: owner) {
                guard try Self.matchesUnfinishedMealRefinement(record, owner: owner, source: source, hints: hints, day: day, meal: meal),
                      historyState(record.eventID)["deleted"] as? Bool != true,
                      record.historyGeneration == nil || record.historyGeneration == historyGeneration(id: record.eventID) else { continue }
                if addToEaten && record.addToEaten != true {
                    record.addToEaten = true; record.diaryAddState = "pending"
                    record = try outbox.save(record)
                }
                guard syncHistory(record) else { return false }
                onQueued?(record.eventID)
                if record.status == .retryableFailure && (record.chatGPTBinding != nil || record.fastCaptureVersion == 1) {
                    return retryHistory(["id": record.eventID])
                }
                automaticRetriesPaused = false; resumePending()
                return true
            }
        } catch {
            store?.analysisFailure = "Saved analysis jobs could not be opened. Your photos and ingredients have been kept. Try again."
            return false
        }
        guard let saved = savePhotoDraft(images: images, photoIDs: images.map { _ in UUID().uuidString }, revision: 0, voiceMemo: nil,
            eventID: "native-photo:" + UUID().uuidString, day: day, meal: meal,
            repair: repair, hints: hints, status: .queued, addToEaten: addToEaten, storageError: { [weak self] message in
                if let message { self?.store?.analysisFailure = message }
            }) else { return false }
        onQueued?(saved.eventID)
        automaticRetriesPaused = false; resumePending()
        return true
    }
    private func savePhotoDraft(images: [Data], photoIDs: [String], revision: Int, voiceMemo: VoiceMemoPayload?,
                                eventID: String, day: String, meal: String, repair: [String: Any]?,
                                hints: NativeMealAnalysisHints? = nil, status: NativeCaptureStatus, addToEaten: Bool? = nil,
                                captureStartedAt: TimeInterval? = nil,
                                analysisSubmittedAt: TimeInterval? = nil,
                                storageError: (String?) -> Void) -> NativeCaptureRecord? {
        let submittedAt = analysisSubmittedAt ?? CaptureClock.now
        guard let owner = ownerKey() else {
            store?.errorMessage = "Unlock your iPhone to save these photos."
            storageError("Unlock your iPhone to save these photos."); return nil
        }
        do {
            var revokedCaptureID: UUID?
            var previous = try outbox.record(eventID: eventID, owner: owner) ?? outbox.records(owner: owner).first { $0.status == .deleted && $0.revokedEventID == eventID }
            if var revoked = previous, revoked.status == .deleted || revoked.historyGeneration != historyGeneration(id: eventID) {
                // Preserve deletion delivery separately; Undo's explicit retry is a new job.
                revoked.revokedEventID = eventID
                revoked.eventID = "deleted-capture:" + revoked.id.uuidString
                try outbox.save(revoked); revokedCaptureID = revoked.id; previous = nil
            }
            var record = previous ?? NativeCaptureRecord(eventID: eventID, ownerKey: owner)
            if previous == nil { record.createdAt = captureDate((historyState(eventID)["event"] as? [String: Any])?["createdAt"]) ?? Date() }
            record.historyGeneration = historyGeneration(id: eventID)
            record.loggingDay = day; record.loggingMeal = meal
            let changed = record.captureRevision != revision || record.photoFiles.count != images.count || record.photoIDs != photoIDs
            if changed {
                if previous != nil { record.submissionID = UUID() }
                record.attempts = 0; record.remoteAccepted = false; record.manualRetryRequested = false
                record.chatGPTBinding = nil
                record.nextAttemptAt = nil; record.serverRetryAt = nil; record.errorCode = nil
                record.cloudPreparationVersion = 1
            }
            // Pin only on an explicit first submission or a changed capture.
            // Loading/retrying an old nil binding must not change its provider.
            if status == .queued && (previous == nil || changed || previous?.status == .draft) {
                record.chatGPTBinding = voiceMemo == nil ? try cameraSelection() : nil
                record.fastCaptureVersion = 1; record.analysisStartedAt = Date()
                record.localAnalysis = nil
            }
            record.photoIDs = photoIDs; record.captureRevision = revision
            record.barcode = nil; record.status = status
            if changed { record.photoReferences = nil }
            if changed || record.thumbnail.isEmpty { record.thumbnail = images.first.flatMap { CameraHistoryThumbnail.dataURL(from: $0) } ?? "" }
            if let repair { record.repairContext = try JSONSerialization.data(withJSONObject: store?.captureRepairContext(repair) ?? repair) }
            if let addToEaten {
                record.addToEaten = addToEaten; record.diaryAddState = addToEaten ? "pending" : nil
            }
            if let hints { record.mealHints = hints }
            record = try outbox.save(record, images: changed || record.photoFiles.isEmpty ? images : nil, voiceMemo: voiceMemo)
            if record.photoReferences == nil {
                record.photoReferences = try store?.saveAnalysisPhotos(images) ?? []
                record = try outbox.save(record)
            }
            if let revokedCaptureID { retireRevokedTask(captureID: revokedCaptureID, eventID: eventID) }
            guard syncHistory(record) else {
                storageError("History could not be saved. Keep the camera open and try again."); return nil
            }
            if status == .queued {
                if let previousID = latestAnalysisID, !photoTasks.keys.contains(previousID) {
                    analysisStages.removeValue(forKey: previousID)
                }
                latestAnalysisID = record.eventID
                setAnalysisStage(.saved, for: record)
                CapturePerformance.shared.begin(eventID: record.eventID, requestID: record.submissionID, startedAt: submittedAt,
                    captureStartedAt: captureStartedAt, captureBasis: "photo_acquisition")
            }
            storageError(nil)
            return record
        } catch ChatGPTFailure.storage {
            let message = "Unlock your iPhone and reopen ChatGPT settings before analysing. Your photos are kept."
            store?.errorMessage = message; storageError(message); return nil
        } catch {
            store?.errorMessage = "These photos could not be saved. Keep the camera open and try again."
            storageError("These photos could not be saved. Keep the camera open and try again.")
            return nil
        }
    }
    private func complete(_ input: NativeCaptureRecord) {
        guard isCurrent(input), var record = try? outbox.record(eventID: input.eventID, owner: input.ownerKey) else { return }
        record.status = .complete; record.errorCode = nil; record.nextAttemptAt = nil; record.serverRetryAt = nil
        do {
            // Commit the completed analysis first. A local diary-write retry
            // must never upload these photos or run paid analysis again.
            record = try outbox.save(record)
            finishIntake(&record)
            var event: [String: Any] = ["id": record.eventID, "processingState": "complete", "errorCode": "", "nextAttemptAt": ""]
            if let choice = record.addToEaten { event["addToEaten"] = choice }
            if let state = record.diaryAddState { event["diaryAddState"] = state }
            if store?.perform("recordHistory", event) == true {
                setAnalysisStage(.complete, for: record)
            }
        } catch { store?.errorMessage = "The result is saved in History. Retry state could not be updated." }
    }
    private func finishIntake(_ record: inout NativeCaptureRecord) {
        guard record.addToEaten == true, record.diaryAddState == "pending", isCurrent(record) else { return }
        let outcome = store?.addCaptureToEaten(eventID: record.eventID, generation: record.historyGeneration ?? 0, ownerKey: record.ownerKey) ?? "saveFailed"
        switch outcome {
        case "added", "alreadyAdded": record.diaryAddState = "added"
        case "cancelled": record.diaryAddState = "cancelled"; record.addToEaten = false
        case "needsReview": record.diaryAddState = "needsReview"
        default: record.nextAttemptAt = Date().addingTimeInterval(10)
        }
        do { record = try outbox.save(record) }
        catch { storageBlocked = true; store?.errorMessage = "Your analysis is saved. Its diary status will be checked again when Nudge opens." }
    }
    @discardableResult func cancelAddToEaten(eventID: String) -> Bool {
        guard let owner = ownerKey(), var record = try? outbox.record(eventID: eventID, owner: owner), isCurrent(record) else { return false }
        record.addToEaten = false; record.diaryAddState = "cancelled"
        do {
            record = try outbox.save(record)
            // A visible pending row may have completed just before this tap.
            // Remove only this capture's newly added intake, never a repaired
            // pre-existing meal, and retain its replay claim.
            guard store?.removeCaptureIntakeIfAdded(eventID: eventID, generation: record.historyGeneration ?? 0, ownerKey: owner) == true else { return false }
            guard syncHistory(record) else { store?.errorMessage = "The pending food was cancelled. Today could not refresh; reopen it to check."; return false }
            return true
        } catch { store?.errorMessage = "This pending food could not be removed. Try again."; return false }
    }
    private func requeue(_ input: NativeCaptureRecord) {
        guard let current = try? outbox.record(eventID: input.eventID, owner: input.ownerKey), current.submissionID == input.submissionID,
              current.status == .processing, historyGeneration(id: input.eventID) == input.historyGeneration else { return }
        var record = current
        if record.chatGPTBinding != nil {
            record.status = .retryableFailure; record.errorCode = "chatgpt_interrupted"; record.nextAttemptAt = nil
        } else if record.fastCaptureVersion == 1 && !record.remoteAccepted {
            record.status = .retryableFailure; record.errorCode = "analysis_interrupted"; record.nextAttemptAt = nil
        } else { record.status = .queued; record.nextAttemptAt = Date().addingTimeInterval(5) }
        do { try outbox.save(record) } catch { return }
        if ownerKey() == record.ownerKey { _ = syncHistory(record) }
    }
    private func fail(_ input: NativeCaptureRecord, error: Error, diagnosticID: UUID? = nil) {
        guard isCurrent(input) else { return }
        var record = input
        CapturePerformance.shared.record(record.eventID, outcome: "failed")
        if record.chatGPTBinding != nil {
            switch error as? ChatGPTFailure {
            case .expired, .bindingChanged, .storage: record.errorCode = "chatgpt_account"
            case .limit, .consent: record.errorCode = "chatgpt_limit"
            case .unsupported: record.errorCode = "chatgpt_model"
            case .incomplete, .refused, .invalidPhoto: record.errorCode = "chatgpt_result"
            default: record.errorCode = "chatgpt_interrupted"
            }
            record.status = .retryableFailure; record.nextAttemptAt = nil; record.serverRetryAt = nil
            _ = persist(record)
            var metadata: [String: Any] = ["route": "chatgpt_photo_analysis"]
            if let diagnosticID { metadata["attemptId"] = diagnosticID.uuidString }
            AnalysisDiagnostics.shared.record(stage: "response", outcome: record.errorCode ?? "failed", metadata: metadata)
            return
        }
        if record.fastCaptureVersion == 1, record.barcode == nil,
           (error as? CaptureTransportFailure)?.manualRetryRequired == true {
            // A lost upload acknowledgement can hide a persisted failed job.
            // Remember acceptance so the next deliberate Retry uses /retry.
            record.remoteAccepted = true; record.manualRetryRequested = false
        }
        let failure = NutritionLabelService.publicFailure(error)
        let barcode = error as? BarcodeLookupError
        record.errorCode = barcode == .notFound ? "not_found" : barcode == .offline ? "analysis_connection" : barcode == .timeout ? "analysis_timeout" : (barcode?.retryAfterSeconds ?? 0) > 0 ? "quota_busy" : failure.code
        let needsInput = barcode == .notFound || barcode == .invalidBarcode || error is NativeCaptureOutbox.Failure ||
            ["signInRequired", "notConfigured", "unauthenticated", "photoPermissionRequired", "permission_required", "label_unreadable", "upload_invalid", "upload_too_large", "invalid_image", "upstream_image", "voice_invalid", "voice_too_large", "upstream_refusal", "result_too_large"].contains(failure.code)
        record.status = needsInput ? .needsUserInput : .retryableFailure
        let retryAfter = (error as? CaptureTransportFailure)?.retryAfter ?? barcode.map { Double($0.retryAfterSeconds) }
        record.serverRetryAt = retryAfter.flatMap { $0 > 0 ? Date().addingTimeInterval($0) : nil }
        record.nextAttemptAt = needsInput || record.attempts >= 6 || record.fastCaptureVersion == 1 ? nil : NativeCaptureOutbox.retryDate(at: Date(), attempt: record.attempts, retryAfter: retryAfter)
        _ = persist(record)
    }
    /// NWPath is only a retry trigger. A saved capture completes only after the
    /// authenticated service returns a validated result, including captive Wi-Fi.
    func resumePending() {
        applicationActive = true; storageBlocked = false
        if monitor == nil {
            let selected = NWPathMonitor(); monitor = selected
            selected.pathUpdateHandler = { [weak self] path in
                guard path.status == .satisfied else { return }
                Task { @MainActor [weak self] in self?.connectionReturned() }
            }
            selected.start(queue: DispatchQueue(label: "com.nudge.capture-connectivity"))
        }
        guard !automaticRetriesPaused, let owner = ownerKey(), store?.ready == true else { return }
        do {
            // Legacy barcode rows contain public input that can be recovered.
            // Legacy photo thumbnails are never promoted to usable originals.
            for event in store?.project("recoverableCaptures")["events"] as? [[String: Any]] ?? [] {
                guard let id = event["id"] as? String, let barcode = event["barcode"] as? String,
                      try outbox.record(eventID: id, owner: owner) == nil else { continue }
                _ = saveBarcode(barcode, eventID: id, createdAt: captureDate(event["createdAt"]) ?? Date())
            }
            for var record in try outbox.records(owner: owner) {
                if record.status == .deleted && record.deletionAcknowledged == true {
                    if !retainForUndo(record) { try outbox.remove(record) }
                    continue
                }
                if record.historyGeneration == nil { record.historyGeneration = historyGeneration(id: record.eventID); try outbox.save(record) }
                if (historyState(record.eventID)["deleted"] as? Bool == true || historyGeneration(id: record.eventID) != record.historyGeneration) && record.status != .deleted { markDeleted(record); continue }
                if record.barcode == nil && [.queued, .retryableFailure].contains(record.status) &&
                   (record.status == .queued || record.chatGPTBinding == nil && record.fastCaptureVersion != 1) && !permissionAllowed() {
                    record.status = .needsUserInput; record.errorCode = "photoPermissionRequired"; record.nextAttemptAt = nil
                    try outbox.save(record)
                } else if record.status == .needsUserInput && record.errorCode == "photoPermissionRequired" && permissionAllowed() {
                    record.status = .queued; record.errorCode = nil; record.nextAttemptAt = record.serverRetryAt
                    try outbox.save(record)
                }
                if record.status == .needsUserInput && ["signInRequired", "notConfigured", "unauthenticated"].contains(record.errorCode ?? "") && NudgeAccountManager.shared.publicStatus()["state"] as? String == "signedIn" {
                    record.status = .queued; record.nextAttemptAt = nil; try outbox.save(record)
                }
                if record.status == .processing && !activeIDs.contains(record.id) {
                    record.status = record.chatGPTBinding == nil && (record.fastCaptureVersion != 1 || record.remoteAccepted) ? .queued : .retryableFailure
                    if record.chatGPTBinding != nil { record.errorCode = "chatgpt_interrupted" }
                    record.nextAttemptAt = nil; try outbox.save(record)
                }
                if record.status != .complete && record.status != .deleted { _ = syncHistory(record) }
            }
        } catch { store?.errorMessage = "Saved captures could not be opened. They have been kept on this iPhone."; return }
        guard let records = try? outbox.records(owner: owner) else { return }
        for record in records where photoTasks.count < 2 && eligible(record) && (record.nextAttemptAt ?? .distantPast) <= Date() && !activeIDs.contains(record.id) {
            startPending(record)
        }
        schedulePending()
    }
    private func startPending(_ record: NativeCaptureRecord) {
        guard photoTasks[record.eventID] == nil else { return }
        if let barcode = record.barcode, record.status != .deleted {
            let key = record.ownerKey + ":" + barcode
            guard activeBarcodeJobs[key] == nil else { return }
            activeBarcodeJobs[key] = record.eventID
        }
        let id = record.eventID, token = UUID(), account = accountRevision()
        photoTaskTokens[id] = token; photoCaptureIDs[id] = record.id; activeIDs.insert(record.id)
        backgroundTasks[id] = UIApplication.shared.beginBackgroundTask(withName: "Nudge food analysis") { [weak self] in
            Task { @MainActor in self?.backgroundLeaseExpired(id: id, token: token) }
        }
        photoTasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { finishPhotoAnalysis(id: id, token: token, captureID: record.id) }
            await process(record, token: token, account: account)
        }
        store?.analysingCount = photoTasks.count
    }
    private func connectionReturned() {
        guard applicationActive, let owner = ownerKey(), let records = try? outbox.records(owner: owner) else { return }
        for var record in records where record.errorCode == "analysis_connection" && record.attempts < 6 {
            record.nextAttemptAt = record.serverRetryAt; _ = try? outbox.save(record)
        }
        resumePending()
    }
    func suspendPending() {
        // Existing uploads retain their OS background lease. No new work starts
        // while suspended; unfinished jobs and originals resume on next activation.
        applicationActive = false; retryTimer?.invalidate(); retryTimer = nil
    }
    private func eligible(_ record: NativeCaptureRecord) -> Bool {
        if record.status != .deleted && historyState(record.eventID)["deleted"] as? Bool == true { return false }
        return (record.status == .complete && record.addToEaten == true && record.diaryAddState == "pending" || record.status == .deleted && record.deletionAcknowledged != true || record.status == .queued || record.status == .retryableFailure && record.chatGPTBinding == nil && record.fastCaptureVersion != 1 && record.attempts < 6) &&
        (record.status == .complete || record.status == .deleted || record.barcode != nil || permissionAllowed()) && record.ownerKey == ownerKey()
    }
    private func barcodeWorkerAvailable(_ record: NativeCaptureRecord) -> Bool {
        guard record.status != .deleted, let barcode = record.barcode else { return true }
        return activeBarcodeJobs[record.ownerKey + ":" + barcode] == nil
    }
    private func schedulePending() {
        retryTimer?.invalidate(); retryTimer = nil
        guard applicationActive, !automaticRetriesPaused, !storageBlocked, photoTasks.count < 2, let owner = ownerKey(), let records = try? outbox.records(owner: owner),
              let next = records.filter({ eligible($0) && !activeIDs.contains($0.id) && barcodeWorkerAvailable($0) }).map({ $0.nextAttemptAt ?? Date() }).min() else { return }
        retryTimer = Timer.scheduledTimer(withTimeInterval: max(1, next.timeIntervalSinceNow), repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in self?.resumePending() }
        }
    }
    private func mayDeliver(_ record: NativeCaptureRecord, token: UUID, account: Int) -> Bool {
        guard photoTaskTokens[record.eventID] == token, !Task.isCancelled else { return false }
        guard isCurrent(record) else { return false }
        guard (record.barcode != nil || permissionAllowed()), accountRevision() == account else {
            interruptPhotoAnalysis(id: record.eventID, token: token); return false
        }
        return true
    }
    private func process(_ input: NativeCaptureRecord, token: UUID, account: Int) async {
        if input.status == .deleted {
            guard ownerKey() == input.ownerKey else { return }
            do {
                if input.chatGPTBinding != nil {
                    // Direct inference has no Nudge server capture to delete.
                    // Cancellation/deletion fences local delivery; no remote erasure is claimed.
                } else if let deleteCapture { try await deleteCapture(input.submissionID, input.ownerKey) }
                else { try await service.deleteCapture(input.submissionID, ownerKey: input.ownerKey) }
                guard photoTaskTokens[input.eventID] == token, !Task.isCancelled,
                      var current = try outbox.records(owner: input.ownerKey).first(where: { $0.id == input.id }),
                      current.status == .deleted, current.submissionID == input.submissionID else { return }
                current.deletionAcknowledged = true; current.nextAttemptAt = nil
                // Refetch by immutable ID after await: an explicit Undo retry
                // may already have renamed this tombstone's History identity.
                if retainForUndo(current) { try outbox.save(current) }
                else { try outbox.remove(current) }
            } catch {
                guard photoTaskTokens[input.eventID] == token, !Task.isCancelled,
                      var current = try? outbox.records(owner: input.ownerKey).first(where: { $0.id == input.id }),
                      current.status == .deleted, current.submissionID == input.submissionID else { return }
                current.attempts += 1
                current.nextAttemptAt = NativeCaptureOutbox.retryDate(at: Date(), attempt: current.attempts, retryAfter: (error as? CaptureTransportFailure)?.retryAfter)
                do { try outbox.save(current) } catch { storageBlocked = true }
            }
            return
        }
        guard isCurrent(input) else { return }
        if input.status == .complete { complete(input); return }
        var record = input; record.status = .processing; record.attempts += 1
        guard let saved = persist(record) else { storageBlocked = true; return }; record = saved
        setAnalysisStage(record.remoteAccepted ? .analysing : .saved, for: record)

        let diagnosticID = record.submissionID, began = CaptureClock.now
        let slowNotice = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled, let self, self.mayDeliver(record, token: token, account: account),
                  CapturePerformance.shared.isWaiting(record.eventID) else { return }
            CapturePerformance.shared.record(record.eventID, outcome: "still_analysing")
            _ = self.store?.perform("recordHistory", ["id": record.eventID, "message": "Still analysing — your photos are saved."])
        }
        var scanOutcome: String?
        defer {
            slowNotice.cancel()
            if record.barcode != nil, scanOutcome != "delivered" {
                AnalysisDiagnostics.shared.record(stage: "barcode_scan", outcome: scanOutcome ?? "cancelled", metadata: ["attemptId":diagnosticID.uuidString, "route":"product_lookup", "elapsedMs":CaptureClock.milliseconds(since: began)])
            }
        }
        do {
            if let barcode = record.barcode {
                setAnalysisStage(.analysing, for: record)
                AnalysisDiagnostics.shared.record(stage: "barcode_scan", outcome: "started", metadata: ["attemptId":diagnosticID.uuidString, "route":"product_lookup"])
                let product = try await lookup(barcode, diagnosticID)
                guard mayDeliver(record, token: token, account: account),
                      let object = finishMatchingBarcodeJobs(product, primary: record) else { requeue(record); return }
                // Only the current camera's event may update its card. Restored
                // duplicate rows never flash, navigate or open another result.
                if let visibleRecord = try? outbox.record(eventID: eventID, owner: record.ownerKey), visibleRecord.barcode == barcode {
                    presentScannedProduct(object, record: visibleRecord)
                }
                let score = store?.scannedProductModel(object)["score"] as? [String: Any] ?? [:]
                let catalogueScore = product.catalogueRating.flatMap { try? JSONSerialization.jsonObject(with: $0.scoreData) as? [String: Any] }
                let evidenceState = catalogueScore?["catalogueEnrichment"] == nil ? "none" :
                    (product.catalogueRating?.effectiveExpiresAt ?? .distantPast) > Date() ? "current" : "expired"
                scanOutcome = "delivered"
                AnalysisDiagnostics.shared.record(stage: "barcode_scan", outcome: "delivered", metadata: ["attemptId":diagnosticID.uuidString, "route":"product_lookup", "elapsedMs":CaptureClock.milliseconds(since: began), "hasCatalogueRating":product.catalogueRating != nil, "ratingAssigned":CameraProductSummary.numericScore(score["value"]) != nil, "ratingStatus":score["status"] ?? "unrated", "scoreBasis":score["scoreBasis"] ?? "none", "catalogueEvidence":evidenceState])
                return
            }
            let response: [String: Any]
            if record.remoteAccepted && record.manualRetryRequested {
                setAnalysisStage(.analysing, for: record)
                response = try await service.retryCapture(record.submissionID, ownerKey: record.ownerKey)
            }
            else if record.remoteAccepted {
                setAnalysisStage(.analysing, for: record)
                response = try await service.retrieveCapture(record.submissionID, ownerKey: record.ownerKey)
            }
            else {
                let input = try await outbox.analysisInput(for: record)
                guard mayDeliver(record, token: token, account: account) else { return }
                let frozenImages = record.fastCaptureVersion == 1 ? try await outbox.preparedCloudImages(for: record) : nil
                guard mayDeliver(record, token: token, account: account) else { return }
                var images = frozenImages ?? input.images
                guard !images.isEmpty else { throw NativeCaptureOutbox.Failure.missingOriginal }
                let attempt = frozenImages == nil && record.fastCaptureVersion == 1 && input.voiceMemo == nil && record.mealHints == nil
                    ? await localResponse(record: record, images: images, token: token, account: account) : nil
                guard mayDeliver(record, token: token, account: account) else { return }
                let local = attempt?.response
                if local == nil, frozenImages == nil, input.images.count == record.photoIDs.count,
                   record.cloudPreparationVersion == 1, let pages = attempt?.pages, !pages.isEmpty,
                   let context = record.repairContext.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                   let product = context["product"] as? [String: Any],
                   let barcode = product["barcode"] as? String, !barcode.isEmpty {
                    // Only an explicit known-product label repair supplies the
                    // intent needed to remove image margins. Generic meal and
                    // recipe captures retain their full visual context.
                    let prepared = await FoodTextImagePreparation.prepare(images: images, pages: pages,
                        eligiblePhotoIDs: Set(record.photoIDs))
                    guard mayDeliver(record, token: token, account: account) else { return }
                    images = prepared.images
                    CapturePerformance.shared.record(record.eventID, outcome: "prepared", metadata: [
                        "cropMs": prepared.elapsedMilliseconds, "croppedCount": prepared.croppedCount,
                        "cropOriginalBytes": prepared.originalBytes, "cropPreparedBytes": prepared.preparedBytes,
                        "cropTimedOut": prepared.timedOut])
                }
                if local == nil, frozenImages == nil, record.fastCaptureVersion == 1 {
                    // Freeze the exact upload bytes before dispatch. A lost
                    // acknowledgement must retry the same immutable payload,
                    // even if OCR/cropping would finish differently next time.
                    images = try await outbox.freezeCloudImages(for: record, images: images)
                    guard mayDeliver(record, token: token, account: account) else { return }
                }
                if local == nil && record.localAnalysis == true { record.localAnalysis = nil; record = try outbox.save(record) }
                if let local {
                    record.localAnalysis = true
                    record = try outbox.save(record)
                    response = local
                }
                else if let binding = record.chatGPTBinding {
                    guard record.hasValidAnalysisRoute, input.voiceMemo == nil, chatGPTBindingCurrent(binding), let store else { throw ChatGPTFailure.bindingChanged }
                    let request = try store.chatGPTPhotoRequest(record: record, images: images)
                    AnalysisDiagnostics.shared.record(stage: "image_submission", outcome: "started", metadata: ["attemptId": diagnosticID.uuidString, "route": "chatgpt_photo_analysis", "photoCount": images.count])
                    let inferenceStart = CaptureClock.now
                    setAnalysisStage(.analysing, for: record)
                    let text = try await analyseChatGPT(binding, request, diagnosticID)
                    guard mayDeliver(record, token: token, account: account) else { return }
                    setAnalysisStage(.saving, for: record)
                    CapturePerformance.shared.record(record.eventID, outcome: "inference_finished",
                        metadata: ["route": "chatgpt_photo_analysis", "inferenceMs": CaptureClock.milliseconds(since: inferenceStart), "upstreamCallCount": 1, "imageBytes": images.reduce(0) { $0 + $1.count }])
                    guard chatGPTBindingCurrent(binding) else { throw ChatGPTFailure.bindingChanged }
                    response = try store.finishChatGPTPhoto(text: text, record: record)
                    var metadata: [String: Any] = ["normalizationIssues": response["diagnosticEnums"] as? [String] ?? []]
                    let extraction = response["extraction"] as? [String: Any] ?? [:]
                    metadata["resultType"] = extraction["type"] as? String ?? "unknown"
                    metadata["attemptId"] = diagnosticID.uuidString; metadata["route"] = "chatgpt_photo_analysis"
                    AnalysisDiagnostics.shared.record(stage: "structured_response", outcome: "parsed", metadata: metadata)
                    let nutrition = NutritionLabelService.nutritionDiagnosticMetadata(extraction)
                    AnalysisDiagnostics.shared.record(stage: "nutrition", outcome: (nutrition["missingNutrientCount"] as? Int) == 0 ? "calculated" : "incomplete", metadata: metadata.merging(nutrition) { _, new in new })
                } else if let analysePhotos {
                    setAnalysisStage(.analysing, for: record)
                    response = try await analysePhotos(images, record.photoIDs, record.captureRevision, input.voiceMemo, record.submissionID)
                } else {
                    setAnalysisStage(.analysing, for: record)
                    response = try await service.analyse(images: images, photoIDs: record.photoIDs, captureRevision: record.captureRevision,
                        voiceMemo: input.voiceMemo, diagnosticID: diagnosticID, captureID: record.submissionID, ownerKey: record.ownerKey, mealHints: record.mealHints, fastCapture: record.fastCaptureVersion == 1)
                }
            }
            guard mayDeliver(record, token: token, account: account) else { return }
            if record.fastCaptureVersion == 1 && (response["captureExpired"] as? Bool == true || response["captureMissing"] as? Bool == true) {
                record.status = .retryableFailure
                record.errorCode = response["captureExpired"] as? Bool == true ? "captureExpired" : "analysis_interrupted"
                record.nextAttemptAt = nil; record.serverRetryAt = nil
                record.remoteAccepted = false; record.manualRetryRequested = false
                _ = persist(record); CapturePerformance.shared.record(record.eventID, outcome: "failed"); return
            }
            if response["captureExpired"] as? Bool == true {
                // The server's completed-result retention expired while this
                // phone was away. Retained originals can produce a fresh job.
                record.submissionID = UUID(); record.remoteAccepted = false; record.manualRetryRequested = false
                record.status = .queued; record.attempts = 0; record.nextAttemptAt = nil; record.serverRetryAt = nil
                _ = persist(record); return
            }
            if response["captureMissing"] as? Bool == true {
                record.remoteAccepted = false; record.manualRetryRequested = false; record.status = .queued; record.nextAttemptAt = nil
                _ = persist(record); return
            }
            if response["job"] != nil {
                record.remoteAccepted = true; record.manualRetryRequested = false; record.status = .queued; record.attempts = max(0, record.attempts - 1)
                record.nextAttemptAt = Date().addingTimeInterval(max(1, (response["retryAfterSeconds"] as? Double) ?? 1))
                record.serverRetryAt = record.nextAttemptAt
                _ = persist(record)
                return
            }
            guard var extraction = response["extraction"] as? [String: Any], extraction["type"] as? String != "unknown" else {
                CapturePerformance.shared.record(record.eventID, outcome: "label_unreadable")
                record.status = .needsUserInput; record.errorCode = "label_unreadable"; record.nextAttemptAt = nil; _ = persist(record); return
            }
            if record.fastCaptureVersion == 1 {
                extraction["fastCapture"] = ["version": 1, "requestId": record.submissionID.uuidString,
                    "captureRevision": record.captureRevision, "inputKind": extraction["inputKind"] as? String ?? (extraction["type"] as? String == "meal" ? "meal_photo" : "packaging")]
            }
            let repair = record.repairContext.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            setAnalysisStage(.saving, for: record)
            // Render the completed analysis milestone before synchronous local
            // validation/scoring and durable delivery; recheck cancellation.
            await Task.yield()
            guard mayDeliver(record, token: token, account: account) else { return }
            let bridgeStart = CaptureClock.now
            guard store?.receiveAnalysis(extraction, eventID: record.eventID, thumbnail: record.thumbnail, repair: repair,
                day: record.loggingDay, meal: record.loggingMeal, savedPhotos: record.photoReferences ?? [], openReview: false) == true else { requeue(record); return }
            complete(record)
            let nutrition = NutritionLabelService.nutritionDiagnosticMetadata(extraction)
            CapturePerformance.shared.ready(eventID: record.eventID,
                complete: (nutrition["missingNutrientCount"] as? Int) == 0 && (nutrition["partialNutrientCount"] as? Int ?? 0) == 0,
                metadata: nutrition.merging(["bridgeMs": CaptureClock.milliseconds(since: bridgeStart)]) { _, new in new })
            if record.chatGPTBinding != nil {
                AnalysisDiagnostics.shared.record(stage: "ui_delivery", outcome: "delivered", metadata: ["attemptId": diagnosticID.uuidString, "route": "chatgpt_photo_analysis", "elapsedMs": CaptureClock.milliseconds(since: began)])
            }
        } catch is CancellationError {
            if photoTaskTokens[record.eventID] == token {
                if isCurrent(record), accountRevision() == account {
                    CapturePerformance.shared.record(record.eventID, outcome: "cancelled")
                }
                requeue(record)
            }
        } catch {
            guard mayDeliver(record, token: token, account: account) else { return }
            fail(record, error: error, diagnosticID: diagnosticID)
            if record.barcode != nil { scanOutcome = "unavailable"; presentScanFailure(error, record: record) }
        }
    }
    private struct LocalCaptureAttempt {
        let response: [String: Any]?
        let pages: [FoodOCRPage]
    }
    private func localResponse(record: NativeCaptureRecord, images: [Data], token: UUID, account: Int) async -> LocalCaptureAttempt? {
        let started = CaptureClock.now
        do {
            let key = await Task.detached(priority: .userInitiated) { FoodTextCache.key(images: images) }.value
            guard mayDeliver(record, token: token, account: account) else { return nil }
            let directory = try outbox.foodTextCacheDirectory(owner: record.ownerKey)
            let ids = record.photoIDs
            let cached = await Task.detached(priority: .userInitiated) { FoodTextCache.load(directory: directory, key: key, photoIDs: ids) }.value
            guard mayDeliver(record, token: token, account: account) else { return nil }
            let pages: [FoodOCRPage]
            if let cached { pages = cached }
            else { pages = try await recognizeText(images, ids).pages }
            guard mayDeliver(record, token: token, account: account) else { return nil }
            let ocrMs = CaptureClock.milliseconds(since: started), calculationStart = CaptureClock.now
            let label = FoodLocalLabelParser.parse(pages: pages)
            guard let result = try store?.localFoodCapture(pages: pages, label: label, record: record) else { return nil }
            let usable = ["ready", "partial"].contains(result["status"] as? String ?? "") && result["extraction"] is [String: Any]
            CapturePerformance.shared.record(record.eventID, outcome: usable ? "local_result" : "local_fallback", metadata: [
                "route": "local_text", "ocrMs": ocrMs, "calculationMs": CaptureClock.milliseconds(since: calculationStart),
                "cacheState": cached == nil ? "miss" : "fresh", "imageBytes": images.reduce(0) { $0 + $1.count }, "upstreamCallCount": 0])
            if usable && cached == nil {
                // No suspension after the owner/deletion fence: account deletion
                // cannot interleave and recreate a removed owner's cache.
                FoodTextCache.save(pages: pages, directory: directory, key: key)
            }
            return LocalCaptureAttempt(response: usable ? result : nil, pages: pages)
        } catch {
            if mayDeliver(record, token: token, account: account) {
                CapturePerformance.shared.record(record.eventID, outcome: "local_fallback", metadata: ["ocrMs": CaptureClock.milliseconds(since: started)])
            }
            return nil
        }
    }
    private func finishMatchingBarcodeJobs(_ product: BarcodeProduct, primary: NativeCaptureRecord) -> [String: Any]? {
        guard let store, ownerKey() == primary.ownerKey, product.barcode == primary.barcode else { return nil }
        do {
            // Read the manifest list and published History once. There is no
            // suspension between these owner/deletion/generation fences and
            // the atomic History write, so another operation cannot interleave.
            let records = try outbox.records(owner: primary.ownerKey)
            let deleted = Set(store.history["deleted"] as? [String] ?? [])
            let generations = store.history["generations"] as? [String: Any] ?? [:]
            let existingIDs = Set((store.history["events"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String })
            let matches = records.filter {
                $0.barcode == primary.barcode && $0.ownerKey == primary.ownerKey &&
                [.queued, .processing, .retryableFailure].contains($0.status) &&
                !deleted.contains($0.eventID) && existingIDs.contains($0.eventID) &&
                $0.historyGeneration == (generations[$0.eventID] as? Int ?? 0)
            }
            guard let selected = matches.first(where: { $0.id == primary.id && $0.submissionID == primary.submissionID }) else { return nil }
            let batch = [selected] + matches.filter { $0.id != selected.id }.prefix(499)
            guard let object = store.recordScannedProducts(product, eventIDs: batch.map(\.eventID)) else { return nil }
            let nutrition = NutritionLabelService.nutritionDiagnosticMetadata(object)
            for var record in batch {
                record.status = .complete; record.errorCode = nil; record.nextAttemptAt = nil; record.serverRetryAt = nil
                // History already has one acknowledged complete batch. Do not
                // rewrite its full document for every retained outbox record.
                do { try outbox.save(record) }
                catch { storageBlocked = true; store.errorMessage = "Results are saved in History. Some retry records could not be updated; their originals are kept." }
                CapturePerformance.shared.ready(eventID: record.eventID,
                    complete: (nutrition["missingNutrientCount"] as? Int) == 0 && (nutrition["partialNutrientCount"] as? Int ?? 0) == 0,
                    metadata: nutrition.merging(["route": "product_lookup"]) { _, new in new })
            }
            return object
        } catch { return nil }
    }
    private func captureDate(_ raw: Any?) -> Date? {
        guard let value = raw as? String else { return nil }
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    /// Old barcode failures can be recovered without inventing a new scan.
    @discardableResult func retryHistory(_ event: [String: Any]) -> Bool {
        guard let id = event["id"] as? String, let owner = ownerKey(), historyState(id)["deleted"] as? Bool != true else { return false }
        if photoTasks[id] != nil { store?.notice = "This capture is already being analysed."; return true }
        do {
            var record = try outbox.record(eventID: id, owner: owner) ?? outbox.records(owner: owner).first { $0.status == .deleted && $0.revokedEventID == id }
            if let origin = event["captureOwnerKey"] as? String, !origin.isEmpty, origin != owner {
                if origin == "local-guest", owner != "local-guest",
                   let guest = try outbox.record(eventID: id, owner: "local-guest") {
                    record = try outbox.adoptGuest(guest, owner: owner)
                    guard let record, syncHistory(record) else { return true }
                } else {
                    store?.analysisFailure = "Sign in to the account that captured this food to retry it."
                    return true
                }
            }
            if record == nil, let barcode = event["barcode"] as? String, !barcode.isEmpty {
                record = saveBarcode(barcode, eventID: id, createdAt: captureDate(event["createdAt"]) ?? Date())
            }
            if let revoked = record, revoked.status == .deleted {
                record = try restoreAfterUndo(revoked, eventID: id)
            }
            guard var selected = record else { return false }
            if selected.status == .complete { store?.notice = "This capture has already finished."; return true }
            if selected.barcode == nil && (selected.status == .draft || selected.status == .needsUserInput) {
                let images = try outbox.images(for: selected)
                guard !images.isEmpty else { return false }
                let camera = SmartFoodCameraViewController(photosOnly: true, images: images, photoIDs: selected.photoIDs,
                    revision: selected.captureRevision, voiceMemo: try outbox.voiceMemo(for: selected))
                prepare(camera); photoEventID = selected.eventID; persistedPhotoRevision = selected.captureRevision
                loggingDay = selected.loggingDay ?? store?.loggingDay ?? ""
                loggingMeal = selected.loggingMeal ?? store?.loggingMeal ?? ""
                repairReview = selected.repairContext.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                present { camera.resumePresentation(); $0.present(camera, animated: true) }
                return true
            }
            if let original = selected.chatGPTBinding {
                // A deliberate Retry may use a renewed registration/model only
                // for the same account. It never falls back to another payer.
                if let current = try cameraSelection(), current.profileID == original.profileID, current.subject == original.subject, chatGPTBindingCurrent(current) {
                    selected.chatGPTBinding = current
                } else if !chatGPTBindingCurrent(original) {
                    fail(selected, error: ChatGPTFailure.bindingChanged)
                    store?.analysisFailure = "Reconnect the original ChatGPT account and choose it for camera photos in You, then retry."
                    return true
                }
            }
            if selected.fastCaptureVersion == 1 && selected.status == .retryableFailure && selected.errorCode == "captureExpired" {
                // Only this explicit retry may replace an expired server
                // tombstone. Background resume must never create paid work.
                selected.submissionID = UUID(); selected.remoteAccepted = false
                selected.manualRetryRequested = false; selected.serverRetryAt = nil
                selected.errorCode = nil
            }
            selected.manualRetryRequested = selected.remoteAccepted && selected.status == .retryableFailure
            selected.status = .queued; selected.attempts = 0; selected.analysisStartedAt = Date()
            selected.nextAttemptAt = selected.serverRetryAt.flatMap { $0 > Date() ? $0 : nil }
            guard persist(selected) != nil else { return true }
            store?.notice = "Saved — retrying this capture"
            CapturePerformance.shared.forget(selected.eventID)
            CapturePerformance.shared.begin(eventID: selected.eventID, requestID: selected.submissionID)
            automaticRetriesPaused = false; resumePending(); return true
        } catch ChatGPTFailure.storage {
            store?.analysisFailure = "Unlock your iPhone and reopen ChatGPT settings before retrying. Your photos are kept."
            return true
        } catch NativeCaptureOutbox.Failure.storageFull {
            store?.analysisFailure = "There is not enough space to retry. Your original capture is kept. Free some space and tap Retry now."
            return true
        } catch {
            store?.analysisFailure = "This saved capture could not be opened. Its files have been kept. Try again, or take another photo."
            return true
        }
    }
    private func retainForUndo(_ record: NativeCaptureRecord) -> Bool {
        let id = record.revokedEventID ?? record.eventID
        let undoIDs = (store?.history["undo"] as? [String: Any])?["ids"] as? [String] ?? []
        if undoIDs.contains(id) { return true }
        // Undo may survive restart. Keep revoked input until a deliberate new
        // retry has its own acknowledged copy, or until deletion is final.
        if historyState(id)["deleted"] as? Bool != true {
            let replacement = try? outbox.records(owner: record.ownerKey).first { $0.id != record.id && $0.eventID == id && $0.status != .deleted }
            return replacement == nil
        }
        return false
    }
    private func restoreAfterUndo(_ input: NativeCaptureRecord, eventID: String) throws -> NativeCaptureRecord {
        let images = try outbox.images(for: input), voice = try outbox.voiceMemo(for: input)
        guard !images.isEmpty else { throw NativeCaptureOutbox.Failure.missingOriginal }
        var revoked = input; revoked.revokedEventID = eventID
        revoked.eventID = "deleted-capture:" + input.id.uuidString
        try outbox.save(revoked)
        var restored = input
        restored.id = UUID(); restored.submissionID = UUID(); restored.eventID = eventID
        restored.historyGeneration = historyGeneration(id: eventID)
        restored.status = .queued; restored.attempts = 0; restored.remoteAccepted = false; restored.manualRetryRequested = false
        restored.nextAttemptAt = nil; restored.serverRetryAt = nil; restored.errorCode = nil
        restored.revokedEventID = nil; restored.deletionAcknowledged = nil; restored.localAnalysis = nil; restored.analysisStartedAt = Date()
        let saved = try outbox.save(restored, images: images, voiceMemo: voice)
        retireRevokedTask(captureID: input.id, eventID: eventID)
        if revoked.deletionAcknowledged == true { try outbox.remove(revoked) }
        return saved
    }
    private func retireRevokedTask(captureID: UUID, eventID: String) {
        guard let token = photoTaskTokens[eventID], photoCaptureIDs[eventID] == captureID else { return }
        photoTasks[eventID]?.cancel()
        finishPhotoAnalysis(id: eventID, token: token, captureID: captureID)
    }
    private func markDeleted(_ input: NativeCaptureRecord) {
        analysisStages.removeValue(forKey: input.eventID)
        do {
            if input.barcode != nil { try outbox.remove(input); return }
            // Cache text is private food content too. Purge this small owner
            // cache on deletion; Undo can reconstruct it from retained originals.
            if let cache = try? outbox.foodTextCacheDirectory(owner: input.ownerKey),
               FileManager.default.fileExists(atPath: cache.path) { try FileManager.default.removeItem(at: cache) }
            var record = input; record.status = .deleted; record.revokedEventID = input.eventID
            record.deletionAcknowledged = input.localAnalysis == true || input.chatGPTBinding != nil || input.attempts == 0 && !input.remoteAccepted
            record.nextAttemptAt = nil; record.attempts = 0
            // Original photos and voice stay private through persisted Undo.
            // The deleted status fences every automatic analysis path.
            try outbox.save(record)
        } catch { store?.errorMessage = "The capture was removed from History. Its private files could not yet be removed." }
    }
    func historyDeleted(_ id: String) {
        CapturePerformance.shared.forget(id)
        guard let owner = ownerKey(), let record = try? outbox.record(eventID: id, owner: owner) else { return }
        markDeleted(record)
        if let token = photoTaskTokens[id] { interruptPhotoAnalysis(id: id, token: token) }
        resumePending()
    }
}
