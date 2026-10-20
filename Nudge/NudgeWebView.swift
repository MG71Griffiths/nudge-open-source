import Combine
import SwiftUI
import UIKit
import WebKit

@MainActor
final class WebStatus: ObservableObject {
    @Published var isLoading = true
    @Published var errorMessage: String?
}

/// The WKWebView is the app shell, not a zoomable document. Disable only its
/// ordinary page pinch; text scaling and OS accessibility Zoom are independent.
/// Camera lens and photo-viewer zoom use separate native views.
@MainActor
final class NudgeAppWebView: WKWebView {
    var storageBridge: NudgeStorageBridge?
    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.bouncesZoom = false
        scrollView.pinchGestureRecognizer?.isEnabled = false
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 1
        if pageZoom != 1 { pageZoom = 1 }
        if scrollView.zoomScale != 1 { scrollView.setZoomScale(1, animated: false) }
    }
}

/// A loading-screen Cancel can arrive before the previous camera's animated
/// dismissal finishes. Wait for UIKit, then resolve the presenter again rather
/// than presenting from a controller that is leaving the hierarchy.
@MainActor
enum NudgeCameraPresentation {
    static func whenReady(from root: UIViewController, attempts: Int = 60,
                          isCurrent: @escaping () -> Bool,
                          completion: @escaping (UIViewController?) -> Void) {
        guard isCurrent() else { return }
        guard attempts > 0 else { completion(nil); return }
        var controller = root
        while true {
            if controller.isBeingDismissed || controller.isBeingPresented {
                let retry = {
                    whenReady(from: root, attempts: attempts - 1, isCurrent: isCurrent, completion: completion)
                }
                if let transition = controller.transitionCoordinator,
                   transition.animate(alongsideTransition: nil, completion: { _ in retry() }) { return }
                // UIKit can briefly set the transition flag before exposing its
                // coordinator. Retry boundedly; never present during that gap.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.025, execute: retry)
                return
            }
            if let presented = controller.presentedViewController { controller = presented }
            else if let navigation = controller as? UINavigationController, let visible = navigation.visibleViewController { controller = visible }
            else if let tab = controller as? UITabBarController, let selected = tab.selectedViewController { controller = selected }
            else { break }
        }
        completion(controller.viewIfLoaded?.window == nil ? nil : controller)
    }
}

/// Only bundled pages run inside this web view. Public source links open in Safari.
@MainActor
enum NudgeWebConfiguration {
    static let scheme = "nudge-local"
    static let host = "localhost"
    static let startURL = URL(string: "nudge-local://localhost/index.html")!

    static func isLocal(_ url: URL) -> Bool {
        url.scheme == scheme && url.host == host && url.port == nil
            && url.user == nil && url.password == nil
    }

    static func makeWebView(messageHandler: WKScriptMessageHandler? = nil, dataStore: WKWebsiteDataStore? = nil, nativeStore: NudgeDataStore? = nil) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore ?? .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(BundledContentHandler(), forURLScheme: scheme)
        if let messageHandler {
            configuration.userContentController.add(messageHandler, name: "nudgeBarcode")
        }
        if nativeStore != nil {
            configuration.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(window, '__nudgePrivateStorage', {value:true});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let webView = NudgeAppWebView(frame: .zero, configuration: configuration)
        if let nativeStore {
            webView.storageBridge = NudgeStorageBridge(store: nativeStore)
            webView.uiDelegate = webView.storageBridge
        }
        webView.isOpaque = false
        let background = NudgeTheme.canvas
        webView.tintColor = NudgeTheme.accent
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        return webView
    }
}

struct NudgeWebView: UIViewRepresentable {
    let status: WebStatus
    var nativeSearch: NativeSearchRouter? = nil

    func makeCoordinator() -> Coordinator { Coordinator(status: status, nativeSearch: nativeSearch) }

    func makeUIView(context: Context) -> WKWebView {
        let webView = NudgeWebConfiguration.makeWebView(messageHandler: context.coordinator, nativeStore: .shared)
        if let nativeSearch {
            webView.configuration.userContentController.addUserScript(WKUserScript(
                source: "Object.defineProperty(window, '__nudgeNativeProductSearch', {value:true});",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
            nativeSearch.webView = webView
        }
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: NudgeWebConfiguration.startURL))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.cancelLabel()
        coordinator.cancelAccountRequest()
        coordinator.cancelSearchProductRefresh()
        uiView.stopLoading()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "nudgeBarcode")
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, BarcodeScannerViewControllerDelegate, NutritionLabelPickerDelegate, SmartFoodCameraDelegate {
        private let status: WebStatus
        private weak var nativeSearch: NativeSearchRouter?
        private let createdAt = Date()
        private let productService = OpenFoodFactsService.catalogueConnected
        private lazy var catalogueRatingEngine = NativeProductRatingEngine(catalogue: nil)
        private lazy var catalogueContextRules = NativeProductContextRules()
        private func productPayload(_ product: BarcodeProduct) throws -> Any {
            if let facts = catalogueContextRules.productFacts(product, ratingEngine: catalogueRatingEngine) { return facts }
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(product))
        }
        private let labelService = NutritionLabelService()
        private var lookupTask: Task<Void, Never>?
        private var productSearchTask: Task<Void, Never>?
        private var productSearchRequestID: String?
        private var searchProductRefreshTask: Task<Void, Never>?
        private var searchProductRefreshRequestID: String?
        private var searchProductRefreshDraftID: String?
        private var labelTask: Task<Void, Never>?
        private var labelPicker: NutritionLabelPickerController?
        private var smartCamera: SmartFoodCameraViewController?
        private var smartLookupTask: Task<Void, Never>?
        private var recallTask: Task<Void, Never>?
        private var recallRequestID: String?
        private var alternativesTask: Task<Void, Never>?
        private var alternativesRequestID: String?
        private var productScoreTask: Task<Void, Never>?
        private var productScoreRequestID: String?
        private var productScoreDraftID: String?
        private var productScoreGeneration = UUID()
        private var selectedLabelJPEG: Data?
        private var selectedProductJPEG: Data?
        private var selectedSmartImages: [Data] = []
        private var selectedVoiceMemo: VoiceMemoPayload?
        private var selectedPhotoIDs: [String] = []
        private var selectedCaptureRevision = 0
        private var captureGeneration = UUID()
        private var labelRequestID: String?
        private var labelDraftID: String?
        private var cameraSummary: CameraSummaryEnvelope?
        private var wantsCameraSummary = false
        private var barcodePhotoContext = false
        private var returnToQuickSummary = false
        private var accountTask: Task<Void, Never>?
        private var accountRequestID: String?
        weak var webView: WKWebView?

        init(status: WebStatus, nativeSearch: NativeSearchRouter? = nil) {
            self.status = status
            self.nativeSearch = nativeSearch
            super.init()
            AnalysisDiagnostics.shared.record(stage:"app", outcome:"started")
            NotificationCenter.default.addObserver(self, selector: #selector(updateTextScale), name: UIContentSizeCategory.didChangeNotification, object: nil)
        }
        deinit { NotificationCenter.default.removeObserver(self) }

        @objc private func updateTextScale() {
            let scale = UIFont.preferredFont(forTextStyle: .body).pointSize / 17
            webView?.evaluateJavaScript("document.documentElement.style.setProperty('--n-text-scale', '\(scale)');")
        }

        private func log(_ message: String) {
            #if DEBUG
            let seconds = Int(Date().timeIntervalSince(createdAt))
            print("[Nudge +\(seconds)s] \(message)")
            #endif
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            cancelProductScore()
            cancelProductSearch()
            cancelSearchProductRefresh()
            log("Local page load started")
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            log("Local page content received")
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if NudgeWebConfiguration.isLocal(url), navigationAction.targetFrame?.isMainFrame == true {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            // Only a tapped HTTPS link may leave the app. Do not load remote pages
            // into the same context as the user's local diary.
            if navigationAction.navigationType == .linkActivated, url.scheme == "https" {
                UIApplication.shared.open(url)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            status.errorMessage = nil
            status.isLoading = false
            updateTextScale()
            log("Local page load finished")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) { showLoadFailure(error) }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!,
                     withError error: Error) { showLoadFailure(error) }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            AnalysisDiagnostics.shared.record(stage: "ui_error", outcome: "render_failed")
            cancelProductScore()
            cancelProductSearch()
            cancelSearchProductRefresh()
            status.isLoading = false
            status.errorMessage = "The app’s display stopped. Reopen it to continue with your saved entries."
            log("Web content process stopped")
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  let frameURL = message.frameInfo.request.url, NudgeWebConfiguration.isLocal(frameURL),
                  message.name == "nudgeBarcode", let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            if action == "native-search-screen" {
                guard let screen = body["screen"] as? String, screen.count <= 40,
                      let active = body["active"] as? Bool else { return }
                nativeSearch?.receive(screen: screen, active: active)
                return
            }
            if action == "share-diagnostics" {
                guard let webView, let presenter = topViewController(from: webView.window?.rootViewController),
                      presenter.presentedViewController == nil else { return }
                AnalysisDiagnostics.presentShareSheet(from: presenter)
                return
            }
            if action == "app-diagnostic" {
                AnalysisDiagnostics.shared.recordWebEvent(body)
                return
            }
            if action == "search-diagnostic" {
                guard let outcome = body["outcome"] as? String,
                      ["invoked", "rendered", "filtered_empty", "no_matches", "timeout", "cancelled"].contains(outcome) else { return }
                let allowed = Set(["page", "queryLength", "queryTokenCount", "resultCount", "recipeCount", "productCount", "visibleCount", "filterCount", "filteredCount", "requirementsExcludedCount", "spellingCorrected", "aliasMatched", "alternativeQuery", "savedOnly", "searchScope", "cached", "stale"])
                var metadata = (body["metadata"] as? [String: Any] ?? [:]).filter { allowed.contains($0.key) }
                if let id = body["requestID"] as? String, !id.isEmpty, id.count <= 128 {
                    metadata["requestHash"] = AnalysisDiagnostics.fingerprint(id)
                }
                AnalysisDiagnostics.shared.record(stage: "search_ui", outcome: outcome, metadata: metadata)
                return
            }
            if action == "product-search" || action == "cancel-product-search" {
                guard let requestID = (body["requestID"] ?? body["requestId"]) as? String,
                      !requestID.isEmpty, requestID.count <= 128 else { return }
                if action == "cancel-product-search" {
                    if productSearchRequestID == requestID { cancelProductSearch() }
                } else { findProducts(body: body, requestID: requestID) }
                return
            }
            if action == "scan" { presentScanner() }
            guard let requestID = body["requestId"] as? String, !requestID.isEmpty, requestID.count <= 128 else { return }
            // Accounts have their own request lifecycle and never receive web
            // credentials or share the nutrition draft's request IDs.
            if action == "photo-permission-settings" {
                showPhotoPermissionSettings(requestID: requestID)
                return
            }
            if action == "account-status" || action == "account-open" {
                handleAccount(action: action, requestID: requestID)
                return
            }
            guard let draftID = body["draftId"] as? String, !draftID.isEmpty, draftID.count <= 128 else { return }
            if action == "cancel-search-product-refresh" {
                if searchProductRefreshRequestID == requestID, searchProductRefreshDraftID == draftID {
                    cancelSearchProductRefresh()
                }
                return
            }
            if action == "search-product-refresh", let barcode = body["barcode"] as? String,
               barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil {
                // Discovery snapshots are not fresh product labels. Resolve the
                // selected barcode without creating a camera/history event.
                cancelSearchProductRefresh()
                searchProductRefreshRequestID = requestID
                searchProductRefreshDraftID = draftID
                searchProductRefreshTask = Task { [weak self] in
                    guard let self else { return }
                    var event: [String: Any] = ["type": "search-product-refreshed", "requestId": requestID, "draftId": draftID]
                    do {
                        let product = try await productService.lookup(barcode: barcode)
                        try Task.checkCancellation()
                        event["product"] = try productPayload(product)
                    } catch is CancellationError { return }
                    catch { event["unavailable"] = true }
                    guard !Task.isCancelled, searchProductRefreshRequestID == requestID,
                          searchProductRefreshDraftID == draftID else { return }
                    searchProductRefreshTask = nil
                    searchProductRefreshRequestID = nil
                    searchProductRefreshDraftID = nil
                    sendEvent(event)
                }
                return
            }
            if action == "camera-summary-update" {
                guard let update = CameraSummaryEnvelope(body: body),
                      update.matches(request: labelRequestID, draft: labelDraftID, revision: selectedCaptureRevision) else { return }
                cameraSummary = update
                if wantsCameraSummary { smartCamera?.showProductSummary(update.summary) }
                return
            }
            if action == "product-score" {
                scoreProduct(body: body, requestID: requestID, draftID: draftID)
                return
            }
            if action == "cancel-product-score" {
                if productScoreRequestID == requestID, productScoreDraftID == draftID { cancelProductScore() }
                return
            }
            if action == "product-recalls" {
                findRecalls(requestID: requestID, draftID: draftID)
                return
            }
            if action == "product-alternatives" {
                findAlternatives(body: body, requestID: requestID, draftID: draftID)
                return
            }
            if action == "camera-resume" {
                resumeSmartCamera(requestID: requestID, draftID: draftID)
                return
            }
            if action == "barcode-retry", let barcode = body["barcode"] as? String,
               barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil {
                if labelDraftID != draftID { cancelLabel() }
                labelRequestID = requestID
                labelDraftID = draftID
                lookupSmartBarcode(barcode, requestID: requestID, draftID: draftID)
                return
            }
            if action == "smart-scan" {
                presentSmartCamera(requestID: requestID, draftID: draftID, photosOnly: body["repair"] as? Bool == true, requestedPanel: body["requestedPanel"] as? String)
                return
            }
            if action == "label-photo", let role = body["photoKind"] as? String,
               let photoKind = NutritionLabelPickerController.PhotoKind(rawValue: role) {
                presentLabelPicker(requestID: requestID, draftID: draftID, photoKind: photoKind)
            }
            if action == "analyse-label", draftID == labelDraftID { analyseSelectedLabel(requestID: requestID, draftID: draftID) }
            if action == "cancel-label", draftID == labelDraftID, requestID == labelRequestID { cancelLabel() }
            if action == "configure-label-backend", BackendCredentialStore.configuration() != nil {
                configureLabelBackend(requestID: requestID, draftID: draftID)
            }
        }

        func cancelAccountRequest() {
            accountTask?.cancel()
            accountTask = nil
            accountRequestID = nil
        }

        private func handleAccount(action: String, requestID: String) {
            cancelAccountRequest()
            accountRequestID = requestID
            sendAccountStatus(requestID: requestID)
            accountTask = Task { [weak self] in
                guard let self else { return }
                let manager = NudgeAccountManager.shared
                do { try await manager.loadConfiguration() }
                catch { /* The manager exposes a fixed unavailable status. */ }
                guard !Task.isCancelled, accountRequestID == requestID else { return }
                sendAccountStatus(requestID: requestID)
                guard action == "account-open", let webView,
                      let presenter = topViewController(from: webView.window?.rootViewController),
                      presenter.presentedViewController == nil else { return }
                var previousRevision = manager.revision
                AccountConnectionPresenter.present(from: presenter) { [weak self] in
                    guard let self else { return }
                    if manager.revision != previousRevision {
                        previousRevision = manager.revision
                        cancelProductScore()
                        labelTask?.cancel()
                        labelTask = nil
                        labelPicker?.cancel()
                        labelPicker = nil
                        smartLookupTask?.cancel()
                        smartLookupTask = nil
                        dismissSmartCamera()
                        selectedLabelJPEG = nil
                        selectedProductJPEG = nil
                        selectedSmartImages.removeAll()
                        selectedVoiceMemo = nil
                        selectedPhotoIDs.removeAll()
                        selectedCaptureRevision = 0
                        captureGeneration = UUID()
                        if let draftID = labelDraftID, let labelID = labelRequestID {
                            sendLabelEvent(["type": "authentication-changed"], requestID: labelID, draftID: draftID)
                        }
                    }
                    sendAccountStatus(requestID: requestID)
                }
            }
        }

        private func sendAccountStatus(requestID: String) {
            guard requestID == accountRequestID else { return }
            var status = NudgeAccountManager.shared.publicStatus()
            status["privateAccess"] = BackendCredentialStore.configuration() != nil
            status["photoAnalysisAllowed"] = PhotoAnalysisPermission().allowed
            let event: [String: Any] = ["type": "status", "requestId": requestID, "status": status]
            guard JSONSerialization.isValidJSONObject(event),
                  let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView?.evaluateJavaScript("window.NudgeAccount && window.NudgeAccount.receive(\(json));")
        }

        private func presentScanner() {
            guard let webView, let presenter = topViewController(from: webView.window?.rootViewController) else {
                sendEvent(["type": "error", "message": "The camera screen could not open. Try again."])
                return
            }
            guard presenter.presentedViewController == nil else { return }
            let scanner = BarcodeScannerViewController()
            scanner.delegate = self
            scanner.modalPresentationStyle = .fullScreen
            presenter.present(scanner, animated: true)
        }

        func barcodeScanner(_ scanner: BarcodeScannerViewController, didScan barcode: String) {
            scanner.dismiss(animated: true)
            lookupTask?.cancel()
            sendEvent(["type": "loading", "barcode": barcode])
            lookupTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let product = try await productService.lookup(barcode: barcode)
                    let object = try productPayload(product)
                    sendEvent(["type": "product", "product": object])
                } catch is CancellationError {
                    return
                } catch let error as BarcodeLookupError {
                    sendEvent(["type": "error", "barcode": barcode, "code": error.code, "message": error.message])
                } catch {
                    sendEvent(["type": "error", "barcode": barcode, "code": "invalidResponse", "message": "Open Food Facts returned a response Nudge could not read. Try again later."])
                }
            }
        }

        func barcodeScannerDidCancel(_ scanner: BarcodeScannerViewController) {
            scanner.dismiss(animated: true)
            sendEvent(["type": "cancelled"])
        }

        func barcodeScanner(_ scanner: BarcodeScannerViewController, didFail message: String) {
            scanner.dismiss(animated: true)
            sendEvent(["type": "error", "code": "camera", "message": message])
        }

        func cancelLabel() {
            recallTask?.cancel()
            recallTask = nil
            recallRequestID = nil
            cancelProductScore()
            alternativesTask?.cancel()
            alternativesTask = nil
            alternativesRequestID = nil
            smartLookupTask?.cancel()
            smartLookupTask = nil
            dismissSmartCamera()
            labelTask?.cancel()
            labelTask = nil
            selectedLabelJPEG = nil
            selectedProductJPEG = nil
            selectedSmartImages.removeAll()
            selectedVoiceMemo = nil
            selectedPhotoIDs.removeAll()
            selectedCaptureRevision = 0
            captureGeneration = UUID()
            labelPicker?.cancel()
            labelPicker = nil
            labelRequestID = nil
            labelDraftID = nil
            cameraSummary = nil
            wantsCameraSummary = false
            barcodePhotoContext = false
            returnToQuickSummary = false
        }

        private func cancelProductScore() {
            productScoreTask?.cancel()
            productScoreTask = nil
            productScoreRequestID = nil
            productScoreDraftID = nil
            productScoreGeneration = UUID()
        }

        private func scoreProduct(body: [String: Any], requestID: String, draftID: String) {
            // Duplicate delivery cannot spend twice. New drafts have their own
            // task generation, independent of camera/photo request IDs.
            if productScoreRequestID == requestID, productScoreDraftID == draftID { return }
            cancelProductScore()
            productScoreRequestID = requestID
            productScoreDraftID = draftID
            let generation = productScoreGeneration
            productScoreTask = Task { [weak self] in
                guard let self else { return }
                defer { if productScoreGeneration == generation { productScoreTask = nil } }
                var event: [String: Any]
                do {
                    guard let product = body["product"] as? [String: Any] else { throw NutritionLabelService.ServiceError.invalidResponse }
                    let result = try await labelService.scoreProduct(product)
                    event = ["type": "product-score", "result": result]
                } catch is CancellationError { return }
                catch {
                    let serviceError = error as? NutritionLabelService.ServiceError
                    let code: String
                    let message: String
                    if serviceError?.code == "permission_required" {
                        code = "permission_required"
                        message = "AI analysis is off. The available product facts are still shown."
                    } else if serviceError?.code == "signInRequired" || error is AccountError {
                        code = "signInRequired"
                        message = "Sign in to calculate this product rating."
                    } else {
                        code = "score_unavailable"
                        message = "The product rating is unavailable right now. The available food facts are still shown."
                    }
                    event = ["type": "product-score-error", "code": code, "error": message, "message": message]
                }
                guard !Task.isCancelled, productScoreGeneration == generation,
                      productScoreRequestID == requestID, productScoreDraftID == draftID else { return }
                event["requestId"] = requestID
                event["draftId"] = draftID
                sendEvent(event)
                if let result = event["result"] as? [String: Any],
                   let score = result["score"] as? [String: Any], score["catalogueCheckRequired"] as? Bool == true,
                   let code = score["catalogueCheckBarcode"] as? String,
                   let refreshed = try? await NudgeCatalogueService().batch([code]).first,
                   !Task.isCancelled, productScoreGeneration == generation {
                    // This response is authoritative only after catalogue source binding.
                    // Cache the refresh; the pending review keeps its unavailable sentinel.
                    ProductLookupCache.shared.write(refreshed, now: Date())
                }
            }
        }

        private func findRecalls(requestID: String, draftID: String) {
            recallTask?.cancel()
            recallRequestID = requestID
            recallTask = Task { [weak self] in
                guard let self else { return }
                let response = await FoodRecallService.shared.notices()
                guard !Task.isCancelled, recallRequestID == requestID else { return }
                sendEvent(["type": "product-recalls", "requestId": requestID, "draftId": draftID, "response": response])
                recallTask = nil
            }
        }

        private func findAlternatives(body: [String: Any], requestID: String, draftID: String) {
            guard let target = body["target"] as? String, target == "label" || target == "barcode" else { return }
            alternativesTask?.cancel()
            alternativesRequestID = requestID
            let nutrients = (body["nutrients"] as? [String: Double] ?? [:]).filter { $0.value.isFinite && $0.value >= 0 }
            alternativesTask = Task { [weak self] in
                guard let self else { return }
                defer { if alternativesRequestID == requestID { alternativesTask = nil } }
                var event: [String: Any]
                do {
                    let products = try await productService.alternatives(
                        barcode: body["barcode"] as? String,
                        categoryTag: body["categoryTag"] as? String,
                        retailer: body["retailer"] as? String,
                        referenceNutrients: nutrients,
                        basisUnit: body["basisUnit"] as? String,
                        nutritionPreparation: body["nutritionPreparation"] as? String)
                    event = ["type": "alternatives", "products": try products.map { try productPayload($0) }]
                } catch is CancellationError { return }
                catch { event = ["type": "alternatives-error", "message": "No comparisons available right now."] }
                guard !Task.isCancelled, alternativesRequestID == requestID else { return }
                event["requestId"] = requestID
                event["draftId"] = draftID
                if target == "label" { sendLabelEvent(event, requestID: requestID, draftID: draftID) }
                else { sendEvent(event) }
            }
        }

        private func dismissSmartCamera() {
            let camera = smartCamera
            smartCamera = nil
            camera?.closeCapture()
            camera?.dismiss(animated: true)
        }

        private func presentSmartCamera(requestID: String, draftID: String, photosOnly: Bool, requestedPanel: String? = nil) {
            if let camera = smartCamera, labelDraftID == draftID {
                labelTask?.cancel(); labelTask = nil
                smartLookupTask?.cancel(); smartLookupTask = nil
                captureGeneration = UUID()
                labelRequestID = requestID; labelDraftID = draftID
                cameraSummary = nil; wantsCameraSummary = false
                camera.prepareForLabelCapture(panel: requestedPanel)
                sendLabelEvent(["type":"capture-status", "photoCount":camera.capturedImages.count, "captureRevision":camera.captureSetRevision], requestID:requestID, draftID:draftID)
                if camera.presentingViewController == nil || camera.isBeingDismissed {
                    presentWhenReady(camera, requestID: requestID, draftID: draftID)
                }
                return
            }
            // A duplicate bridge message must not open another camera or upload.
            // Wait for explicit cancellation before accepting a new draft.
            if let smartCamera, !smartCamera.isShowingResult { return }
            let retained = labelDraftID == draftID ? selectedSmartImages : []
            let retainedIDs = labelDraftID == draftID ? selectedPhotoIDs : []
            let retainedRevision = labelDraftID == draftID ? selectedCaptureRevision : 0
            let retainedVoice = labelDraftID == draftID ? selectedVoiceMemo : nil
            cancelLabel()
            selectedSmartImages = retained
            selectedPhotoIDs = retainedIDs
            selectedCaptureRevision = retainedRevision
            selectedVoiceMemo = retainedVoice
            labelRequestID = requestID
            labelDraftID = draftID
            let camera = SmartFoodCameraViewController(photosOnly: photosOnly, images: retained, photoIDs: retainedIDs, revision: retainedRevision, voiceMemo: retainedVoice)
            if requestedPanel != nil { camera.prepareForLabelCapture(panel: requestedPanel) }
            camera.delegate = self
            smartCamera = camera
            presentWhenReady(camera, requestID: requestID, draftID: draftID)
        }

        private func resumeSmartCamera(requestID: String, draftID: String) {
            let retainedCamera = smartCamera
            smartCamera = nil
            cancelLabel()
            labelRequestID = requestID
            labelDraftID = draftID
            let camera = retainedCamera ?? SmartFoodCameraViewController()
            camera.prepareNextScan()
            camera.delegate = self
            smartCamera = camera
            if camera.presentingViewController == nil || camera.isBeingDismissed {
                presentWhenReady(camera, requestID: requestID, draftID: draftID)
            }
        }

        private func presentWhenReady(_ camera: SmartFoodCameraViewController, requestID: String, draftID: String) {
            let generation = captureGeneration
            let fail = { [weak self] in
                guard let self, camera === smartCamera else { return }
                camera.closeCapture()
                smartCamera = nil
                sendLabelEvent(["type": "error", "message": "Camera unavailable. Try again."], requestID: requestID, draftID: draftID)
            }
            guard let root = webView?.window?.rootViewController else { fail(); return }
            NudgeCameraPresentation.whenReady(from: root, isCurrent: { [weak self] in
                guard let self else { return false }
                return camera === smartCamera && generation == captureGeneration && requestID == labelRequestID && draftID == labelDraftID
            }) { presenter in
                guard let presenter else { fail(); return }
                camera.resumePresentation()
                presenter.present(camera, animated: true)
            }
        }

        private func showCameraResult(_ camera: SmartFoodCameraViewController) {
            camera.suspendForResult()
            camera.dismiss(animated: true)
        }

        func foodCamera(_ camera: SmartFoodCameraViewController, found barcode: String) {
            guard camera === smartCamera, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            wantsCameraSummary = true; barcodePhotoContext = true; returnToQuickSummary = true; cameraSummary = nil
            selectedSmartImages = camera.capturedImages
            selectedPhotoIDs = camera.capturedPhotoIDs
            selectedCaptureRevision = camera.captureSetRevision
            lookupSmartBarcode(barcode, requestID: requestID, draftID: draftID)
        }

        func foodCamera(_ camera: SmartFoodCameraViewController, summaryAction action: String, alternativeID: String?) {
            guard camera === smartCamera, let current = cameraSummary,
                  current.matches(request: labelRequestID, draft: labelDraftID, revision: selectedCaptureRevision),
                  ["expand", "next", "label", "retry", "alternative"].contains(action) else { return }
            if action == "alternative", !current.summary.alternatives.contains(where: { $0.id == alternativeID }) { return }
            wantsCameraSummary = false
            if action == "expand" || action == "alternative" { returnToQuickSummary = false; showCameraResult(camera) }
            if action == "label" || action == "retry" { returnToQuickSummary = true }
            var event: [String: Any] = ["type":"camera-summary-action", "action":action,
                "requestId":current.requestID, "draftId":current.draftID,
                "captureRevision":current.captureRevision, "analysisVersion":current.analysisVersion]
            if let alternativeID { event["alternativeId"] = alternativeID }
            sendEvent(event)
        }

        private func lookupSmartBarcode(_ barcode: String, requestID: String, draftID: String) {
            smartLookupTask?.cancel()
            wantsCameraSummary = smartCamera?.isShowingResult == false
            if wantsCameraSummary { smartCamera?.showProductSummary(.loading) }
            let started = Date()
            sendLabelEvent(["type": "barcode-loading", "barcode": barcode, "cameraSummary":wantsCameraSummary, "captureRevision":selectedCaptureRevision], requestID: requestID, draftID: draftID)
            smartLookupTask = Task { [weak self] in
                guard let self else { return }
                defer { if requestID == labelRequestID, draftID == labelDraftID { smartLookupTask = nil } }
                do {
                    let product = try await productService.lookup(barcode: barcode)
                    guard !Task.isCancelled, requestID == labelRequestID, draftID == labelDraftID else { return }
                    let object = try productPayload(product)
                    logAnalysis(stage: "catalogue", requestID: requestID, draftID: draftID, outcome: "matched", started: started)
                    sendLabelEvent(["type": "barcode-product", "barcode": barcode, "product": object, "cameraSummary":wantsCameraSummary, "captureRevision":selectedCaptureRevision], requestID: requestID, draftID: draftID)
                    let incomplete = product.basisUnit == "unknown" || ["energyKcal", "protein", "sugars", "saturatedFat", "salt"].contains { product.nutrients[$0]?.value == nil }
                    if incomplete && catalogueRatingEngine.validatedQualityHold(for: product) == nil { recoverCatalogueWithPhotos(requestID: requestID, draftID: draftID) }
                } catch is CancellationError { return }
                catch {
                    guard !Task.isCancelled, requestID == labelRequestID, draftID == labelDraftID else { return }
                    let failure = (error as? BarcodeLookupError) ?? .invalidResponse
                    logAnalysis(stage: "catalogue", requestID: requestID, draftID: draftID, outcome: failure.code, started: started)
                    sendLabelEvent(["type": "barcode-error", "barcode": barcode, "code": failure.code, "message": failure.message, "cameraSummary":wantsCameraSummary, "captureRevision":selectedCaptureRevision, "photoRecovery":!selectedSmartImages.isEmpty], requestID: requestID, draftID: draftID)
                    recoverCatalogueWithPhotos(requestID: requestID, draftID: draftID)
                }
            }
        }

        private func recoverCatalogueWithPhotos(requestID: String, draftID: String) {
            // A recorded note is sent only by explicit Analyse/retry, never an
            // automatic barcode/catalogue fallback.
            guard wantsCameraSummary, selectedVoiceMemo == nil, !selectedSmartImages.isEmpty, labelTask == nil, let camera = smartCamera else { return }
            camera.requestPhotoPermission { [weak self, weak camera] allowed in
                guard let self, let camera, allowed, camera === smartCamera,
                      requestID == labelRequestID, draftID == labelDraftID else { return }
                wantsCameraSummary = false
                showCameraResult(camera)
                analyseSmartImages(selectedSmartImages, requestID: requestID, draftID: draftID)
            }
        }

        private func logAnalysis(stage: String, requestID: String, draftID: String, outcome: String, started: Date, diagnosticID: UUID? = nil) {
            // Identifiers/counts only. Never log barcode, identity, nutrients, images, headers or tokens.
            let safe: (String) -> String = { String($0.filter { $0.isLetter || $0.isNumber || "-_:".contains($0) }.prefix(128)) }
            var metadata: [String:Any] = ["requestHash":AnalysisDiagnostics.fingerprint(requestID), "eventHash":AnalysisDiagnostics.fingerprint(draftID), "captureRevision":selectedCaptureRevision, "imageCount":selectedSmartImages.count, "elapsedMs":max(0,Int(Date().timeIntervalSince(started)*1000))]
            if let diagnosticID { metadata["attemptId"] = diagnosticID.uuidString }
            AnalysisDiagnostics.shared.record(stage:stage, outcome:outcome, metadata:metadata)
            log("Analysis stage=\(safe(stage)) request=\(safe(requestID)) event=\(safe(draftID)) revision=\(selectedCaptureRevision) images=\(selectedSmartImages.count) outcome=\(safe(outcome)) elapsedMs=\(Int(Date().timeIntervalSince(started) * 1000))")
        }

        func foodCamera(_ camera: SmartFoodCameraViewController, changedPhotoCount count: Int) {
            guard camera === smartCamera, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            labelTask?.cancel()
            labelTask = nil
            captureGeneration = UUID()
            selectedSmartImages = camera.capturedImages
            selectedVoiceMemo = camera.capturedVoiceMemo
            selectedPhotoIDs = camera.capturedPhotoIDs
            selectedCaptureRevision = camera.captureSetRevision
            cameraSummary = nil
            if wantsCameraSummary { wantsCameraSummary = false; camera.prepareForLabelCapture() }
            sendLabelEvent(["type": "capture-status", "photoCount": count, "captureRevision": camera.captureSetRevision], requestID: requestID, draftID: draftID)
        }

        func foodCameraDidChangeVoiceMemo(_ camera: SmartFoodCameraViewController) {
            // Same revision fence as photos. No audio or transcript crosses the
            // bridge; the memo is retained only in this native draft.
            foodCamera(camera, changedPhotoCount: camera.capturedImages.count)
        }

        func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data]) {
            guard camera === smartCamera, labelTask == nil, PhotoAnalysisPermission().allowed,
                  let requestID = labelRequestID, let draftID = labelDraftID else { return }
            selectedSmartImages = images
            selectedVoiceMemo = camera.capturedVoiceMemo
            selectedPhotoIDs = camera.capturedPhotoIDs
            selectedCaptureRevision = camera.captureSetRevision
            wantsCameraSummary = false
            showCameraResult(camera)
            analyseSmartImages(images, requestID: requestID, draftID: draftID)
        }

        private func analyseSmartImages(_ images: [Data], requestID: String, draftID: String) {
            guard labelTask == nil, PhotoAnalysisPermission().allowed, !images.isEmpty else { return }
            let generation = captureGeneration
            let captureRevision = selectedCaptureRevision
            let photoIDs = selectedPhotoIDs
            let voiceMemo = selectedVoiceMemo
            let thumbnail = images.first.flatMap { CameraHistoryThumbnail.dataURL(from: $0) }
            let preview = images.first.flatMap { UIImage(data: $0) }.flatMap {
                NutritionLabelPickerController.resizedJPEG(from: $0, maximumBytes: 180_000, maxDimension: 1_000)
            }.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
            let started = Date()
            let diagnosticID = UUID()
            logAnalysis(stage: "image_submission", requestID: requestID, draftID: draftID, outcome: "invoked", started: started, diagnosticID: diagnosticID)
            var loading: [String: Any] = ["type": "loading", "photoCount": images.count, "captureRevision":captureRevision, "photoRecovery":barcodePhotoContext]
            if let thumbnail { loading["thumbnail"] = thumbnail }
            if let preview { loading["photoPreview"] = preview }
            sendLabelEvent(loading, requestID: requestID, draftID: draftID)
            labelTask = Task { [weak self] in
                guard let self else { return }
                defer { if requestID == labelRequestID, draftID == labelDraftID, generation == captureGeneration { labelTask = nil } }
                do {
                    let response = try await labelService.analyse(images: images, photoIDs: photoIDs, captureRevision: captureRevision, voiceMemo: voiceMemo, diagnosticID: diagnosticID)
                    guard !Task.isCancelled, generation == captureGeneration, PhotoAnalysisPermission().allowed,
                          requestID == labelRequestID, draftID == labelDraftID else {
                        AnalysisDiagnostics.shared.record(stage:"structured_response", outcome:"cancelled", metadata:["attemptId":diagnosticID.uuidString])
                        return
                    }
                    var event: [String: Any] = ["type": "result", "result": response, "photoCount": images.count, "captureRevision": captureRevision]
                    if let thumbnail { event["thumbnail"] = thumbnail }
                    if let preview { event["photoPreview"] = preview }
                    logAnalysis(stage: "structured_response", requestID: requestID, draftID: draftID, outcome: "parsed", started: started, diagnosticID: diagnosticID)
                    if barcodePhotoContext, returnToQuickSummary, let extraction = response["extraction"] as? [String: Any],
                       extraction["type"] as? String == "product", let camera = smartCamera {
                        wantsCameraSummary = true
                        event["cameraSummary"] = true
                        event["analysisVersion"] = CameraProductSummary.text(extraction["analysisVersion"], limit: 160)
                        presentWhenReady(camera, requestID: requestID, draftID: draftID)
                    }
                    sendLabelEvent(event, requestID: requestID, draftID: draftID)
                } catch is CancellationError {
                    AnalysisDiagnostics.shared.record(stage:"structured_response", outcome:"cancelled", metadata:["attemptId":diagnosticID.uuidString])
                    return
                } catch {
                    guard !Task.isCancelled, generation == captureGeneration, requestID == labelRequestID, draftID == labelDraftID else {
                        AnalysisDiagnostics.shared.record(stage:"structured_response", outcome:"cancelled", metadata:["attemptId":diagnosticID.uuidString])
                        return
                    }
                    let failure = NutritionLabelService.publicFailure(error)
                    logAnalysis(stage: failure.stage, requestID: requestID, draftID: draftID, outcome: failure.code, started: started, diagnosticID: diagnosticID)
                    sendLabelEvent(["type": "error", "code": failure.code, "stage":failure.stage, "message": failure.message, "canRetryPhotos": true, "captureRevision":captureRevision], requestID: requestID, draftID: draftID)
                }
            }
        }

        func foodCameraDidCancel(_ camera: SmartFoodCameraViewController) {
            guard camera === smartCamera, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            cancelLabel()
            sendLabelEvent(["type": "cancelled"], requestID: requestID, draftID: draftID)
        }

        func foodCameraDidOpenHistory(_ camera: SmartFoodCameraViewController) {
            guard camera === smartCamera, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            cancelLabel()
            sendLabelEvent(["type": "camera-history"], requestID: requestID, draftID: draftID)
        }

        private func showPhotoPermissionSettings(requestID: String) {
            guard let webView, let presenter = topViewController(from: webView.window?.rootViewController),
                  presenter.presentedViewController == nil else { return }
            let permission = PhotoAnalysisPermission()
            let alert = UIAlertController(title: PhotoAnalysisPermission.title, message: PhotoAnalysisPermission.explanation, preferredStyle: .alert)
            alert.view.tintColor = NudgeTheme.accent
            alert.addAction(UIAlertAction(title: "Close", style: .cancel))
            alert.addAction(UIAlertAction(title: permission.allowed ? "Turn off" : PhotoAnalysisPermission.allowTitle, style: permission.allowed ? .destructive : .default) { [weak self] _ in
                guard let self else { return }
                if permission.allowed {
                    permission.revoke()
                    let draftID = labelDraftID
                    let oldRequestID = labelRequestID
                    cancelLabel()
                    if let draftID, let oldRequestID {
                        sendLabelEvent(["type": "cancelled"], requestID: oldRequestID, draftID: draftID)
                    }
                } else { permission.allow() }
                accountRequestID = requestID
                sendAccountStatus(requestID: requestID)
            })
            presenter.present(alert, animated: true)
        }

        private func requestLegacyPhotoPermission(requestID: String, draftID: String) {
            guard let webView, let presenter = topViewController(from: webView.window?.rootViewController),
                  presenter.presentedViewController == nil else { return }
            let alert = UIAlertController(title: PhotoAnalysisPermission.title, message: PhotoAnalysisPermission.explanation, preferredStyle: .alert)
            alert.view.tintColor = NudgeTheme.accent
            alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { [weak self] _ in
                guard let self, requestID == labelRequestID, draftID == labelDraftID else { return }
                sendLabelEvent(["type": "cancelled"], requestID: requestID, draftID: draftID)
            })
            alert.addAction(UIAlertAction(title: PhotoAnalysisPermission.allowTitle, style: .default) { [weak self] _ in
                guard let self, requestID == labelRequestID, draftID == labelDraftID else { return }
                PhotoAnalysisPermission().allow()
                analyseSelectedLabel(requestID: requestID, draftID: draftID)
            })
            presenter.present(alert, animated: true)
        }

        private func configureLabelBackend(requestID: String, draftID: String) {
            guard let webView, let presenter = topViewController(from: webView.window?.rootViewController),
                  presenter.presentedViewController == nil else { return }
            BackendConnectionPresenter.present(from: presenter) { [weak self] saved in
                if saved { self?.sendLabelEvent(["type": "configured"], requestID: requestID, draftID: draftID) }
            }
        }

        private func presentLabelPicker(requestID: String, draftID: String, photoKind: NutritionLabelPickerController.PhotoKind) {
            if labelDraftID != draftID { cancelLabel() }
            // A retake cancels old work but keeps both existing slots until a new
            // photo is selected. Cancelling the picker must not discard a draft.
            labelTask?.cancel()
            labelTask = nil
            labelPicker?.cancel()
            labelPicker = nil
            labelDraftID = draftID
            labelRequestID = requestID
            guard let webView, let presenter = topViewController(from: webView.window?.rootViewController),
                  presenter.presentedViewController == nil else {
                sendLabelEvent(["type": "error", "photoKind": photoKind.rawValue, "message": "The photo picker could not open. Try again."], requestID: requestID, draftID: draftID)
                return
            }
            let picker = NutritionLabelPickerController(photoKind: photoKind)
            picker.delegate = self
            labelPicker = picker
            picker.present(from: presenter)
        }

        func labelPicker(_ picker: NutritionLabelPickerController, didChoose jpegData: Data) {
            guard picker === labelPicker, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            if picker.photoKind == .product { selectedProductJPEG = jpegData }
            else { selectedLabelJPEG = jpegData }
            let preview = "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
            sendLabelEvent(["type": "selected", "photoKind": picker.photoKind.rawValue, "preview": preview, "bytes": jpegData.count], requestID: requestID, draftID: draftID)
            labelPicker = nil
        }

        func labelPickerDidCancel(_ picker: NutritionLabelPickerController) {
            guard picker === labelPicker, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            sendLabelEvent(["type": "cancelled", "photoKind": picker.photoKind.rawValue], requestID: requestID, draftID: draftID)
            labelPicker = nil
        }

        func labelPicker(_ picker: NutritionLabelPickerController, didFail message: String) {
            guard picker === labelPicker, let requestID = labelRequestID, let draftID = labelDraftID else { return }
            sendLabelEvent(["type": "error", "photoKind": picker.photoKind.rawValue, "message": message], requestID: requestID, draftID: draftID)
            labelPicker = nil
        }

        private func analyseSelectedLabel(requestID: String, draftID: String) {
            guard labelTask == nil, labelPicker == nil else { return }
            labelRequestID = requestID
            if !selectedSmartImages.isEmpty {
                guard PhotoAnalysisPermission().allowed else {
                    requestLegacyPhotoPermission(requestID: requestID, draftID: draftID)
                    return
                }
                analyseSmartImages(selectedSmartImages, requestID: requestID, draftID: draftID)
                return
            }
            guard let jpeg = selectedLabelJPEG else {
                sendLabelEvent(["type": "error", "message": "Choose a nutrition-label photo first."], requestID: requestID, draftID: draftID)
                return
            }
            guard PhotoAnalysisPermission().allowed else {
                requestLegacyPhotoPermission(requestID: requestID, draftID: draftID)
                return
            }
            let productJPEG = selectedProductJPEG
            sendLabelEvent(["type": "loading"], requestID: requestID, draftID: draftID)
            labelTask = Task { [weak self] in
                guard let self else { return }
                defer { if labelRequestID == requestID, labelDraftID == draftID { labelTask = nil } }
                do {
                    let response = try await labelService.analyse(jpegData: jpeg, productJPEGData: productJPEG)
                    guard !Task.isCancelled, labelRequestID == requestID, labelDraftID == draftID else { return }
                    sendLabelEvent(["type": "result", "result": response], requestID: requestID, draftID: draftID)
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled, labelRequestID == requestID, labelDraftID == draftID else { return }
                    sendLabelEvent(["type": "error", "code": (error as? NutritionLabelService.ServiceError)?.code ?? "analysis", "message": error.localizedDescription], requestID: requestID, draftID: draftID)
                }
            }
        }

        func cancelSearchProductRefresh() {
            searchProductRefreshTask?.cancel()
            searchProductRefreshTask = nil
            searchProductRefreshRequestID = nil
            searchProductRefreshDraftID = nil
        }

        private func cancelProductSearch() {
            if productSearchTask != nil, let id = productSearchRequestID {
                AnalysisDiagnostics.shared.record(stage: "search_response", outcome: "cancelled", metadata: ["requestHash": AnalysisDiagnostics.fingerprint(id)])
            }
            productSearchTask?.cancel()
            productSearchTask = nil
            productSearchRequestID = nil
        }

        private func findProducts(body: [String: Any], requestID: String) {
            cancelProductSearch()
            cancelSearchProductRefresh()
            productSearchRequestID = requestID
            let query = body["query"] as? String ?? ""
            let pageNumber = body["page"] as? NSNumber
            let page = pageNumber.flatMap { value -> Int? in
                guard CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.rounded() == value.doubleValue,
                      (1...Double(ProductSearchQuery.maximumPage)).contains(value.doubleValue) else { return nil }
                return value.intValue
            } ?? (body["page"] == nil ? 1 : 0)
            let started = Date()
            let trace: [String: Any] = ["requestHash": AnalysisDiagnostics.fingerprint(requestID), "page": page, "queryLength": min(query.count, 120), "queryTokenCount": min(query.split(whereSeparator: { $0.isWhitespace }).count, 40), "route": "product_search"]
            AnalysisDiagnostics.shared.record(stage: "search_request", outcome: "invoked", metadata: trace)
            productSearchTask = Task { [weak self] in
                guard let self else { return }
                defer { if productSearchRequestID == requestID { productSearchTask = nil } }
                var event: [String: Any]
                do {
                    let result = try await productService.search(query: query, page: page, diagnosticRequestID: requestID)
                    event = ["type": "results", "query": result.query.text, "page": result.query.page,
                             "products": try result.products.map { try productPayload($0) }, "hasMore": result.hasMore,
                             "cached": result.cached, "stale": result.stale, "retryAfterSeconds": result.retryAfterSeconds, "source": "Open Food Facts"]
                    if let code = result.fallbackCode { event["fallbackCode"] = code }
                    if let date = result.cachedAt { event["cachedAt"] = date }
                    if let status = result.httpStatus { event["httpStatus"] = status }
                    var metadata = trace
                    metadata.merge(["elapsedMs": max(0, Int(Date().timeIntervalSince(started) * 1000)), "resultCount": result.products.count, "cached": result.cached, "stale": result.stale, "retryAfterSeconds": result.retryAfterSeconds]) { _, new in new }
                    if let code = result.fallbackCode { metadata["fallbackCode"] = code }
                    if let status = result.httpStatus { metadata["httpStatus"] = status }
                    AnalysisDiagnostics.shared.record(stage: "search_response", outcome: result.stale ? "stale" : result.cached ? "cached" : result.products.isEmpty ? "no_matches" : "matched", metadata: metadata)
                } catch is CancellationError { return }
                catch {
                    let failure = error as? ProductSearchError ?? .unavailable
                    event = ["type": "error", "query": String(query.prefix(80)), "page": page,
                             "code": failure.code, "message": failure.message, "retryAfterSeconds": failure.retryAfterSeconds]
                    var metadata = trace
                    metadata.merge(["elapsedMs": max(0, Int(Date().timeIntervalSince(started) * 1000)), "retryAfterSeconds": failure.retryAfterSeconds]) { _, new in new }
                    if let status = failure.statusCode { metadata["httpStatus"] = status; event["httpStatus"] = status }
                    AnalysisDiagnostics.shared.record(stage: "search_response", outcome: failure.code, metadata: metadata)
                }
                guard !Task.isCancelled, productSearchRequestID == requestID else { return }
                event["requestID"] = requestID
                guard JSONSerialization.isValidJSONObject(event),
                      let data = try? JSONSerialization.data(withJSONObject: event),
                      let json = String(data: data, encoding: .utf8) else { return }
                guard let webView else {
                    AnalysisDiagnostics.shared.record(stage: "search_delivery", outcome: "delivery_failed", metadata: trace)
                    return
                }
                webView.evaluateJavaScript("(() => { if (typeof window.NudgeSearch?.receive !== 'function') return false; window.NudgeSearch.receive({detail: \(json)}); return true; })()") { value, error in
                    AnalysisDiagnostics.shared.record(stage: "search_delivery", outcome: error == nil && value as? Bool == true ? "delivered" : "delivery_failed", metadata: trace)
                }
            }
        }

        private func sendEvent(_ event: [String: Any]) {
            guard JSONSerialization.isValidJSONObject(event),
                  let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView?.evaluateJavaScript("window.NudgeBarcode && window.NudgeBarcode.receive(\(json));")
        }

        private func sendLabelEvent(_ event: [String: Any], requestID: String, draftID: String) {
            var event = event
            event["requestId"] = requestID
            event["draftId"] = draftID
            let metadata: [String:Any] = ["requestHash":AnalysisDiagnostics.fingerprint(requestID), "eventHash":AnalysisDiagnostics.fingerprint(draftID), "eventType":event["type"] as? String ?? ""]
            guard JSONSerialization.isValidJSONObject(event),
                  let data = try? JSONSerialization.data(withJSONObject: event),
                  let json = String(data: data, encoding: .utf8), let webView else {
                AnalysisDiagnostics.shared.record(stage:"ui_delivery", outcome:"delivery_failed", metadata:metadata)
                return
            }
            // An invocation acknowledgement distinguishes a valid API response
            // from a missing/broken web controller; no JS error text is persisted.
            webView.evaluateJavaScript("(() => { if (typeof window.NudgeLabel?.receive !== 'function') return false; window.NudgeLabel.receive(\(json)); return true; })()") { value, error in
                AnalysisDiagnostics.shared.record(stage:"ui_delivery", outcome:error == nil && value as? Bool == true ? "delivered" : "delivery_failed", metadata:metadata)
            }
        }

        private func topViewController(from root: UIViewController?) -> UIViewController? {
            if let navigation = root as? UINavigationController {
                return topViewController(from: navigation.visibleViewController)
            }
            if let tab = root as? UITabBarController {
                return topViewController(from: tab.selectedViewController)
            }
            if let presented = root?.presentedViewController {
                return topViewController(from: presented)
            }
            return root
        }

        private func showLoadFailure(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            status.isLoading = false
            status.errorMessage = "Nudge couldn’t open its local screens. Try again; no internet connection is needed."
            log("Local page load failed (code \((error as NSError).code))")
        }
    }
}
