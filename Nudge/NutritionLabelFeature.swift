import AVFoundation
import CoreFoundation
import Foundation
import Security
import UIKit

/// Credentials never enter the web view or the bundled web storage.
struct BackendConfiguration: Codable {
    let baseURL: URL
    let token: String

    static func validatedURL(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              host != "example.invalid", parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443,
              parts.path.isEmpty || parts.path == "/" else { return nil }
        return parts.url
    }

    static func validToken(_ value: String) -> Bool {
        value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
    }
}

enum BackendCredentialStore {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "org.example.nudge.backend",
        kSecAttrAccount as String: "private-configuration-v1"
    ] }

    static func configuration() -> BackendConfiguration? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let configuration = try? JSONDecoder().decode(BackendConfiguration.self, from: data),
              BackendConfiguration.validatedURL(configuration.baseURL.absoluteString) != nil,
              BackendConfiguration.validToken(configuration.token) else { return nil }
        return configuration
    }

    static func save(_ configuration: BackendConfiguration) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(configuration),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw NutritionLabelService.ServiceError.credentialStorage }
        } else if status != errSecSuccess { throw NutritionLabelService.ServiceError.credentialStorage }
    }
}

/// Never follow a redirect with a private photo or credential.
final class LabelSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

struct CaptureTransportFailure: Error {
    let underlying: Error
    let retryAfter: TimeInterval?
    let manualRetryRequired: Bool
    init(underlying: Error, retryAfter: TimeInterval?, manualRetryRequired: Bool = false) {
        self.underlying = underlying; self.retryAfter = retryAfter
        self.manualRetryRequired = manualRetryRequired
    }
}

struct NutritionLabelService {
    static let maximumAnalysisResponseBytes = 262_144
    static func captureRequiresManualRetry(statusCode: Int, data: Data) -> Bool {
        guard statusCode == 503, data.count <= maximumAnalysisResponseBytes,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let flag = payload["manualRetryRequired"] as? NSNumber,
              CFGetTypeID(flag) == CFBooleanGetTypeID() else { return false }
        return flag.boolValue
    }
    // Reuse connections across scans without retaining cookies, HTTP responses
    // or a credential on the session. Authorization remains request-specific.
    static let catalogueSession = makeSession(resourceTimeout: 7)
    static let scoreSession = makeSession(resourceTimeout: 45)
    static let analysisSession = makeSession(resourceTimeout: 60)

    private static func makeSession(resourceTimeout: TimeInterval) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForResource = resourceTimeout
        return URLSession(configuration: configuration, delegate: LabelSessionDelegate(), delegateQueue: nil)
    }

    private final class ResponseTiming: @unchecked Sendable {
        private let lock = NSLock()
        private var received: (uptime: TimeInterval, status: Int)?
        func record(_ response: HTTPURLResponse) {
            lock.lock(); defer { lock.unlock() }
            received = (ProcessInfo.processInfo.systemUptime, response.statusCode)
        }
        func metadata(since start: TimeInterval, completedAt end: TimeInterval) -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            guard let received else { return [:] }
            return ["httpStatus": received.status,
                    "responseHeadersMs": max(0, Int((received.uptime - start) * 1000)),
                    "downloadMs": max(0, Int((end - received.uptime) * 1000))]
        }
    }
    struct AnalysisTimeouts {
        let request: TimeInterval
        let resource: TimeInterval
    }
    // Backend photo/voice budgets are both 45 seconds. Leave time
    // for upload and delivery; a local network timeout is not proof the AI timed out.
    static func analysisTimeouts(includesVoiceMemo: Bool) -> AnalysisTimeouts {
        AnalysisTimeouts(request: 55, resource: 60)
    }
    enum ServiceError: LocalizedError {
        case notConfigured, unauthenticated(Int), accountAuthentication, credentialStorage, imageTooLarge, voiceMemoInvalid, invalidResponse, photoPermissionRequired, productScorePermissionRequired, server(String), classified(code: String, message: String)

        var code: String {
            switch self {
            case .notConfigured: "notConfigured"
            case .unauthenticated: "unauthenticated"
            case .accountAuthentication: "signInRequired"
            case .photoPermissionRequired: "photoPermissionRequired"
            case .productScorePermissionRequired: "permission_required"
            case .classified(let code, _): code
            case .imageTooLarge: "upload_too_large"
            case .voiceMemoInvalid: "voice_invalid"
            case .invalidResponse: "response_invalid"
            default: "analysis"
            }
        }
        var errorDescription: String? {
            switch self {
            case .notConfigured: "Sign in to read your photos."
            case .photoPermissionRequired: "Allow AI analysis to read these photos."
            case .productScorePermissionRequired: "AI analysis is off. The available product facts are still shown."
            case .unauthenticated(let status): "The private backend device token was not accepted (HTTP \(status)). Check the saved device token in the label-photo connection."
            case .accountAuthentication: "Sign in again to read your photos."
            case .credentialStorage: "Nudge could not securely save the backend connection. Unlock the iPhone and try again."
            case .imageTooLarge: "Try a closer photo of the label."
            case .voiceMemoInvalid: "Redo or remove the voice note, then try again."
            case .invalidResponse: "The label service returned a response Nudge could not read."
            case .server(let message): message
            case .classified(_, let message): message
            }
        }
    }

    private struct FailureEnvelope: Decodable {
        let code: String
    }

    struct PublicFailure {
        let code: String, stage: String, message: String
    }
    static func publicFailure(_ error: Error) -> PublicFailure {
        if let retry = error as? CaptureTransportFailure { return publicFailure(retry.underlying) }
        let code: String
        if let error = error as? ServiceError { code = error.code }
        else if let error = error as? AccountError {
            switch error {
            case .signInRequired: code = "signInRequired"
            case .network: code = "analysis_connection"
            case .unavailable: code = "server_not_configured"
            case .storage: code = "account_storage"
            case .rateLimited: code = "quota_busy"
            default: code = "response_invalid"
            }
        } else if let error = error as? URLError {
            code = error.code == .timedOut ? "analysis_timeout" : "analysis_connection"
        } else { code = "analysis" }
        switch code {
        case "signInRequired", "notConfigured", "unauthenticated":
            return PublicFailure(code: code, stage: "authentication", message: "Sign in again to analyse your photos. Your captures are still here.")
        case "photoPermissionRequired", "permission_required":
            return PublicFailure(code: code, stage: "permission", message: "Allow AI analysis to read these photos.")
        case "account_storage":
            return PublicFailure(code: code, stage: "authentication", message: "Unlock your iPhone to access your account, then try again. Your photos are retained.")
        case "upstream_auth", "upstream_access", "upstream_model", "upstream_billing", "server_not_configured", "route_not_found", "request_invalid", "upstream_request", "upstream_redirect":
            return PublicFailure(code: code, stage: "configuration", message: "Photo analysis is temporarily unavailable. Your photos are retained; try again later.")
        case "quota_busy", "quota_exceeded", "upstream_rate_limit":
            return PublicFailure(code: code, stage: "quota", message: "Photo analysis is busy or its limit has been reached. Keep your photos and try again later.")
        case "upload_invalid", "upload_too_large", "invalid_image", "upstream_image":
            return PublicFailure(code: code, stage: "upload", message: "The photo upload could not be accepted. Your captures are retained. Try again or replace the affected photo.")
        case "voice_invalid", "voice_too_large":
            return PublicFailure(code: code, stage: "upload", message: "The voice note could not be accepted. Reopen the camera to redo or remove it, then try again.")
        case "voice_transcription_failed", "voice_transcription_empty", "voice_transcription_timeout":
            return PublicFailure(code: code, stage: "response", message: "The voice note could not be read. Your photos and note are retained. Try again, or reopen the camera to redo or remove the note.")
        case "upstream_refusal":
            return PublicFailure(code: code, stage: "response", message: "The analysis service declined this request. Your photos are retained; try another view or edit the food.")
        case "upstream_incomplete":
            return PublicFailure(code: code, stage: "response", message: "The analysis response was incomplete. Your photos are retained; try again.")
        case "result_too_large":
            return PublicFailure(code: code, stage: "response", message: "This result has too much detail. Try fewer photos or split the food into smaller meals. Your originals are retained.")
        case "response_invalid", "upstream_invalid_response":
            return PublicFailure(code: code, stage: "response", message: "The analysis response could not be read. Your photos are retained; try again.")
        case "label_unreadable":
            return PublicFailure(code: code, stage: "visual_evidence", message: "The result did not contain usable food or label evidence. Check the photo and try again.")
        case "upstream_timeout":
            return PublicFailure(code: code, stage: "connection", message: "Analysis timed out. Your photos are retained; try again.")
        case "analysis_timeout":
            return PublicFailure(code: code, stage: "connection", message: "The connection timed out before Nudge received the analysis. Your photos are retained; try again.")
        default:
            return PublicFailure(code: code, stage: "connection", message: "Analysis couldn’t connect. Your photos are retained; try again.")
        }
    }

    private static func classifiedCode(status: Int, data: Data) -> String {
        let code = data.count <= 4_096 ? (try? JSONDecoder().decode(FailureEnvelope.self, from: data).code) : nil
        let allowed: [Int: Set<String>] = [
            400:["upload_invalid","invalid_image","request_invalid","voice_invalid"], 404:["route_not_found"], 413:["upload_too_large","voice_too_large"], 415:["upload_invalid"],
            422:["label_unreadable","upstream_refusal","result_too_large","voice_transcription_empty"], 429:["quota_busy","quota_exceeded"],
            502:["voice_transcription_failed","upstream_auth","upstream_access","upstream_model","upstream_billing","upstream_rate_limit","upstream_request","upstream_image","upstream_redirect","upstream_network","upstream_invalid_response","upstream_unavailable","upstream_incomplete"],
            503:["server_not_configured","server_unavailable"], 504:["upstream_timeout","voice_transcription_timeout"]
        ]
        if let code, allowed[status]?.contains(code) == true { return code }
        switch status {
        case 400,415: return "upload_invalid"
        case 404: return "route_not_found"
        case 413: return "upload_too_large"
        case 422: return "response_invalid"
        case 429: return "quota_exceeded"
        case 504: return "upstream_timeout"
        default: return "server_unavailable"
        }
    }

    /// Customer-facing failures do not expose private operator setup details.
    static func errorForAccountHTTPResponse(statusCode: Int, data: Data) -> ServiceError? {
        if statusCode == 200 { return nil }
        if statusCode == 401 || statusCode == 403 { return .accountAuthentication }
        let code = classifiedCode(status: statusCode, data: data)
        let failure = publicFailure(ServiceError.classified(code: code, message: ""))
        return .classified(code: failure.code, message: failure.message)
    }

    /// The backend may classify a failure, but cannot supply text shown in the app.
    /// Ignore oversized/malformed bodies, unknown codes and code/status mismatches.
    static func errorForHTTPResponse(statusCode: Int, data: Data) -> ServiceError? {
        guard statusCode != 200 else { return nil }
        if statusCode == 401 || statusCode == 403 { return .unauthenticated(statusCode) }
        let code = data.count <= 4_096 ? (try? JSONDecoder().decode(FailureEnvelope.self, from: data).code) : nil
        let message: String
        switch (statusCode, code) {
        case (502, "upstream_auth"):
            message = "The server’s OpenAI API key was rejected. Replace its OPENAI_API_KEY server secret before retrying."
        case (502, "upstream_access"):
            message = "The server’s OpenAI project lacks permission for label analysis. Check its API-key permissions and model access."
        case (502, "upstream_model"):
            message = "The server’s configured OpenAI model is unavailable. Check its model name and project access."
        case (502, "upstream_billing"):
            message = "The server’s OpenAI project has no available API quota. Check that project’s billing and credit before retrying."
        case (502, "upstream_rate_limit"):
            message = "OpenAI is rate limiting this server. Wait before retrying label analysis."
        case (502, "upstream_request"):
            message = "OpenAI rejected the server’s analysis request. Check the backend request format and model settings."
        case (502, "upstream_image"):
            message = "OpenAI could not read this photo. Retake a clear, close photo of the nutrition or ingredients label and try again."
        case (502, "upstream_redirect"):
            message = "The analysis provider redirected the server request. Check the backend configuration before retrying."
        case (502, "upstream_network"):
            message = "The server could not reach OpenAI. Try again later."
        case (502, "upstream_invalid_response"):
            message = "The server received an unreadable response from OpenAI. Try again later."
        case (502, "upstream_incomplete"):
            message = "The analysis response was incomplete. Your photos can be retried."
        case (422, "upstream_refusal"):
            message = "The analysis service declined this request. Your photos are retained."
        case (502, "upstream_unavailable"):
            message = "OpenAI could not complete label analysis. Try again later."
        case (504, "upstream_timeout"):
            message = "OpenAI label analysis timed out. Try again later."
        case (422, "label_unreadable"):
            message = "No readable nutrition table or ingredients list was returned. Try a clearer photo."
        case (400, "upload_invalid"), (415, "upload_invalid"):
            message = "The server could not accept this photo upload. Retake or choose another photo; if it repeats, check the app and backend versions."
        case (400, "request_invalid"):
            message = "The server rejected the request address. Check the HTTPS origin in the private label-photo connection."
        case (413, "upload_too_large"):
            message = "This photo upload is too large. Retake it closer to the label."
        case (404, "route_not_found"):
            message = "The label service endpoint was not found. Check the private backend address and deployment."
        case (503, "server_not_configured"):
            message = "The label server is not fully configured. Check its server secrets and deployment before retrying."
        case (503, "server_unavailable"):
            message = "The label server is temporarily unavailable. Try again later; if it persists, check the backend deployment."
        case (429, "quota_busy"):
            message = "Another label is still being analysed. Wait for it to finish before retrying."
        case (429, "quota_exceeded"):
            message = "The private label analysis limit has been reached. Try again later."
        default:
            switch statusCode {
            case 300..<400:
                message = "The label service redirected this request. Check that the saved address is the direct HTTPS backend origin."
            case 400, 415:
                message = "The server rejected this photo upload. Choose a new photo; if it repeats, check the app and backend versions."
            case 404:
                message = "The label service endpoint was not found. Check the private backend address and deployment."
            case 413:
                message = "This photo upload is too large. Retake it closer to the label."
            case 422:
                message = "No usable label result was returned. Try a clearer photo."
            case 429:
                message = "Label analysis is busy or its request limit has been reached. Wait before retrying."
            case 502:
                message = "The server could not complete the AI request. Check its OpenAI configuration and service status before retrying."
            case 503:
                message = "The label server is unavailable. Check its configuration and deployment, or try again later."
            case 504:
                message = "Label analysis timed out. Try again later."
            default:
                message = "The label service returned an unexpected error. Try again later; if it persists, check the backend for the reported HTTP status."
            }
        }
        return .classified(code: classifiedCode(status: statusCode, data: data), message: "\(message) (HTTP \(statusCode))")
    }

    /// Both photos share the existing upload budget; no photo is written to disk.
    static func uploadBody(jpegData: Data, productJPEGData: Data? = nil) throws -> Data {
        guard !jpegData.isEmpty, jpegData.count <= 6_000_000 else { throw ServiceError.imageTooLarge }
        var body: [String: Any] = ["mimeType": "image/jpeg", "imageBase64": jpegData.base64EncodedString()]
        if let productJPEGData {
            guard !productJPEGData.isEmpty, productJPEGData.count <= 6_000_000 - jpegData.count else { throw ServiceError.imageTooLarge }
            body["productImage"] = ["mimeType": "image/jpeg", "imageBase64": productJPEGData.base64EncodedString()]
        }
        // Escaping '/' in JPEG base64 can exceed the server's bounded JSON body.
        let encoded = try JSONSerialization.data(withJSONObject: body, options: .withoutEscapingSlashes)
        guard encoded.count <= 8_001_024 else { throw ServiceError.imageTooLarge }
        return encoded
    }

    /// A bounded batch keeps classification on the server and photos in memory.
    static func uploadBody(images: [Data], photoIDs: [String]? = nil, captureRevision: Int? = nil, voiceMemo: VoiceMemoPayload? = nil, mealHints: NativeMealAnalysisHints? = nil) throws -> Data {
        guard (1...4).contains(images.count), images.allSatisfy({ !$0.isEmpty }),
              images.reduce(0, { $0 + $1.count }) <= 6_000_000 else { throw ServiceError.imageTooLarge }
        var body: [String: Any] = ["images": images.map { ["mimeType": "image/jpeg", "imageBase64": $0.base64EncodedString()] }]
        if let photoIDs, let captureRevision {
            guard photoIDs.count == images.count, Set(photoIDs).count == photoIDs.count,
                  photoIDs.allSatisfy({ UUID(uuidString: $0) != nil }), captureRevision >= 0 else { throw ServiceError.invalidResponse }
            body["photoIds"] = photoIDs
            body["captureRevision"] = captureRevision
        } else if photoIDs != nil || captureRevision != nil { throw ServiceError.invalidResponse }
        if let voiceMemo { body["voiceMemo"] = voiceMemo.uploadObject }
        if let mealHints {
            guard mealHints.isValid else { throw ServiceError.invalidResponse }
            body["mealHints"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(mealHints))
        }
        let encoded = try JSONSerialization.data(withJSONObject: body, options: .withoutEscapingSlashes)
        guard encoded.count <= (voiceMemo == nil ? 8_001_024 : 8_685_000) else { throw ServiceError.imageTooLarge }
        return encoded
    }

    /// Preserve additive extraction fields, including explicit unknown values,
    /// within the existing response budget before passing them to the web view.
    static func decodedResult(from data: Data, diagnosticID: UUID = UUID(), captureOperation: String? = nil) throws -> [String: Any] {
        var metadata: [String: Any] = ["attemptId":diagnosticID.uuidString, "responseBytes":data.count]
        if let captureOperation { metadata["captureOperation"] = captureOperation }
        guard data.count <= maximumAnalysisResponseBytes else {
            AnalysisDiagnostics.shared.record(stage:"native_parse", outcome:"body_too_large", metadata:metadata)
            throw ServiceError.invalidResponse
        }
        guard let object = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {
            AnalysisDiagnostics.shared.record(stage:"native_parse", outcome:"invalid_json", metadata:metadata)
            throw ServiceError.invalidResponse
        }
        guard let extraction = object["extraction"] as? [String:Any] else {
            AnalysisDiagnostics.shared.record(stage:"native_parse", outcome:"missing_extraction", metadata:metadata)
            throw ServiceError.invalidResponse
        }
        guard extraction["type"] as? String == "meal" || data.count <= 65_536 else {
            AnalysisDiagnostics.shared.record(stage:"native_parse", outcome:"body_too_large", metadata:metadata)
            throw ServiceError.invalidResponse
        }
        AnalysisDiagnostics.shared.record(stage:"native_parse", outcome:"parsed", metadata:metadata.merging(["resultType":extraction["type"] as? String ?? "unknown"]) { _,new in new })
        let nutrition = nutritionDiagnosticMetadata(extraction)
        AnalysisDiagnostics.shared.record(stage:"nutrition", outcome:(nutrition["missingNutrientCount"] as? Int) == 0 ? "calculated" : "incomplete", metadata:metadata.merging(nutrition) { _,new in new })
        // Audio is upload-only. Even an unexpected server echo cannot put it in
        // JavaScript, local History or the diary. The reviewed transcript stays.
        func withoutAudio(_ value: Any) -> Any {
            if let object = value as? [String: Any] {
                return object.reduce(into: [String: Any]()) { result, entry in
                    guard !["voicememo", "audiobase64", "audiodata"].contains(entry.key.lowercased()) else { return }
                    result[entry.key] = withoutAudio(entry.value)
                }
            }
            if let values = value as? [Any] { return values.map(withoutAudio) }
            return value
        }
        return withoutAudio(object) as? [String: Any] ?? [:]
    }

    /// Completeness counts only: no ingredient identities or nutrient amounts
    /// are diagnostic data. A supplied zero is known; absent/invalid is missing.
    static func nutritionDiagnosticMetadata(_ extraction: [String: Any]) -> [String: Any] {
        let kind = extraction["type"] as? String ?? "unknown"
        let food = kind == "meal" ? extraction["meal"] as? [String: Any] ?? [:] : extraction
        let nutrients = food["nutrients"] as? [String: Any] ?? [:]
        let keys = ["energyKcal", "protein", "carbohydrate", "sugars", "fat", "saturatedFat", "fibre", "salt"]
        func number(_ raw: Any?) -> Double? {
            guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue >= 0 else { return nil }
            return value.doubleValue
        }
        let values = keys.compactMap { key -> Double? in
            if let item = nutrients[key] as? [String: Any] {
                if ["unknown", "missing"].contains(item["status"] as? String ?? "") { return nil }
                return number(item["value"])
            }
            return number(nutrients[key])
        }
        let components = food["components"] as? [[String: Any]] ?? []
        let partial = keys.filter { key in
            guard let item = nutrients[key] as? [String: Any] else { return false }
            return number(item["value"]) == nil && number(item["knownSubtotal"]) != nil
                && (number(item["knownContributions"]) ?? 0) > 0
                && (number(item["unknownContributions"]) ?? 0) > 0
        }.count
        var metadata: [String: Any] = ["route":"photo_analysis", "resultType":kind,
            "knownNutrientCount":values.count, "missingNutrientCount":keys.count - values.count,
            "partialNutrientCount":partial,
            "zeroNutrientCount":values.filter { $0 == 0 }.count,
            "componentCount":min(40, components.count),
            "matchedComponentCount":min(40, components.filter { $0["sourceRecord"] is [String: Any] }.count),
            "missingAmountCount":min(40, components.filter { number($0["amountGrams"]) == nil }.count),
            "plantCount":min(200, (food["plants"] as? [Any])?.count ?? 0)]
        if let recipe = food["recipeCalculation"] as? [String: Any] {
            if let status = recipe["status"] as? String, ["ready", "needs_servings", "incomplete"].contains(status) { metadata["recipeStatus"] = status }
            let ingredients = recipe["batchComponents"] as? [[String: Any]] ?? []
            metadata["recipeIngredientCount"] = min(40, ingredients.count)
            metadata["recipeMissingAmountCount"] = min(40, ingredients.filter { number($0["amountGrams"]) == nil }.count)
        }
        return metadata
    }

    /// Only public product evidence crosses this boundary. Never forward an
    /// arbitrary web object containing diary entries, profile data or photos.
    static func productScoreBody(product: [String: Any]) throws -> Data {
        func text(_ raw: Any?, maximum: Int) -> String? {
            guard let raw = raw as? String, raw.utf8.count <= maximum else { return nil }
            let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
        func number(_ raw: Any?, maximum: Double = 100_000) -> Double? {
            guard let raw = raw as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID(),
                  raw.doubleValue.isFinite, (0...maximum).contains(raw.doubleValue) else { return nil }
            return raw.doubleValue
        }
        func texts(_ raw: Any?, maximumCount: Int, maximumLength: Int) -> [String]? {
            guard let raw = raw as? [Any], raw.count <= maximumCount else { return nil }
            let values = raw.compactMap { text($0, maximum: maximumLength) }
            return values.count == raw.count ? values : nil
        }
        guard let name = text(product["name"], maximum: 240) else { throw ServiceError.invalidResponse }
        var result: [String: Any] = ["name": name]
        for (key, maximum) in [("brand", 160), ("sourceName", 160), ("retrievedAt", 64), ("categoryTag", 160)] {
            if let value = text(product[key], maximum: maximum) { result[key] = value }
        }
        if let barcode = text(product["barcode"], maximum: 18),
           barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil { result["barcode"] = barcode }
        if let rawURL = text(product["sourceURL"], maximum: 2_048), let url = URLComponents(string: rawURL),
           url.scheme == "https", url.host != nil, url.user == nil, url.password == nil {
            result["sourceURL"] = rawURL
        }
        for key in ["basisUnit", "nutritionPreparation"] {
            let allowed = key == "basisUnit" ? ["g", "ml"] : ["as_sold", "prepared"]
            if let value = product[key] as? String, allowed.contains(value) { result[key] = value }
        }
        for key in ["categories", "categoriesTags", "countriesTags", "ingredientsAnalysisTags"] {
            if let values = texts(product[key], maximumCount: 60, maximumLength: 160) { result[key] = values }
        }
        if let fields = texts(product["unresolvedFields"], maximumCount: 7, maximumLength: 40),
           fields.allSatisfy({ ["identity", "nutrition", "preparation", "ingredients", "claims", "allergens", "other"].contains($0) }) {
            result["unresolvedFields"] = fields
        }
        let ingredientText = (product["ingredients"] as? [String: Any])?["text"] ?? product["ingredients"]
        if let value = text(ingredientText, maximum: 8_000) { result["ingredients"] = value }
        let reviewFlags = [product["ingredientsNeedsReview"], (product["ingredients"] as? [String: Any])?["needsReview"]]
            .compactMap { raw -> Bool? in
                guard let value = raw as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
                return value.boolValue
            }
        if !reviewFlags.isEmpty { result["ingredientsNeedsReview"] = reviewFlags.contains(true) }
        if let records = product["ingredientItems"] as? [[String: Any]], records.count <= 160 {
            result["ingredientItems"] = records.compactMap { record -> [String: Any]? in
                var item: [String: Any] = [:]
                if let id = text(record["id"], maximum: 160) { item["id"] = id }
                if let label = text(record["text"], maximum: 400) { item["text"] = label }
                guard !item.isEmpty else { return nil }
                if let percent = number(record["percent"], maximum: 100) { item["percent"] = percent }
                return item
            }
        }
        let supplied = product["nutrients"] as? [String: Any] ?? [:]
        let relations = ["lt", "lte", "eq", "gt", "gte", "approx", "<", "<=", "≤", "=", "~", ">", ">=", "≥"]
        var nutrients: [String: Any] = [:]
        for field in OpenFoodFactsParser.nutrientFields {
            let raw = supplied[field.key] as? [String: Any] ?? [:]
            var item: [String: Any] = ["value": NSNull(), "unit": field.unit, "status": "unknown"]
            let status = raw["status"] as? String ?? "supplied"
            if raw["unit"] == nil || raw["unit"] as? String == field.unit,
               ["supplied", "calculated", "estimated", "confirmed"].contains(status),
               raw["relation"] == nil || raw["relation"] is NSNull || relations.contains(raw["relation"] as? String ?? ""),
               let value = number(raw["value"], maximum: field.unit == "g" ? 100 : 5_000) {
                item["value"] = value
                item["status"] = status
                if let relation = raw["relation"] as? String, relations.contains(relation) {
                    item["relation"] = relation
                }
            }
            nutrients[field.key] = item
        }
        result["nutrients"] = nutrients
        if let raw = product["energyKj"] as? [String: Any], raw["unit"] as? String == "kJ",
           let value = number(raw["value"], maximum: 5_000), raw["status"] as? String == "supplied",
           raw["relation"] == nil || raw["relation"] is NSNull || relations.contains(raw["relation"] as? String ?? "") {
            var energy: [String: Any] = ["value": value, "unit": "kJ", "status": "supplied"]
            if let relation = raw["relation"] as? String, relations.contains(relation) { energy["relation"] = relation }
            result["energyKj"] = energy
        }
        if let raw = product["scoringFacts"] as? [String: Any], let source = text(raw["source"], maximum: 320) {
            var facts: [String: Any] = ["source": source]
            for key in ["isBeverage", "isCheese", "isWater", "isFatOilNutsSeeds", "isRedMeatProduct", "hasNonNutritiveSweeteners"] {
                if let value = raw[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() { facts[key] = value.boolValue }
                else { facts[key] = NSNull() }
            }
            facts["fvlPercent"] = NSNull()
            if let percent = raw["fvlPercent"] as? [String: Any], let value = number(percent["value"], maximum: 100),
               let kind = percent["source"] as? String, ["declared", "provider-2023"].contains(kind),
               let evidence = text(percent["evidence"], maximum: 800) {
                facts["fvlPercent"] = ["value": value, "source": kind, "evidence": evidence]
            }
            result["scoringFacts"] = facts
        }
        if let sources = product["nutrientSources"] as? [String: Any] {
            result["nutrientSources"] = Dictionary(uniqueKeysWithValues: (OpenFoodFactsParser.nutrientFields.map(\.key) + ["energyKj"]).compactMap { key in
                text(sources[key], maximum: 240).map { (key, $0) }
            })
        }
        let body = try JSONSerialization.data(withJSONObject: ["product": result], options: .withoutEscapingSlashes)
        guard body.count <= 65_536 else { throw ServiceError.invalidResponse }
        return body
    }

    static func decodedScoreResult(from data: Data) throws -> [String: Any] {
        guard data.count <= 65_536,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let score = object["score"] as? [String: Any],
              let status = score["status"] as? String, ["rated", "provisional", "estimated", "estimated_provisional", "unrated"].contains(status),
              ((score["methodId"] as? String == "nudge_nutrition_v0_3" && score["version"] as? String == "0.3") ||
               (score["methodId"] as? String == "nudge_nutrition_v0_4" && score["version"] as? String == "0.4")) else {
            throw ServiceError.invalidResponse
        }
        func integer(_ key: String, range: ClosedRange<Double>) -> Double? {
            guard let raw = score[key] as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID(),
                  raw.doubleValue.isFinite, raw.doubleValue.rounded() == raw.doubleValue,
                  range.contains(raw.doubleValue) else { return nil }
            return raw.doubleValue
        }
        func absent(_ key: String) -> Bool { score[key] == nil || score[key] is NSNull }
        if status != "unrated" {
            guard let category = score["category"] as? String,
                  ["general","cheese","red_meat","fats_nuts_seeds","beverage","water"].contains(category),
                  let raw = integer("rawScore", range: -17...59),
                  integer("rawLower", range: -100...100) == raw, integer("rawUpper", range: -100...100) == raw,
                  let grade = score["grade"] as? String,
                  let expected = ["A":100.0,"B":75.0,"C":50.0,"D":25.0,"E":0.0][grade],
                  integer("value", range: 0...100) == expected,
                  integer("displayLower", range: 0...100) == expected, integer("displayUpper", range: 0...100) == expected,
                  score["available"] as? Bool == true else { throw ServiceError.invalidResponse }
            let expectedGrade: String
            switch category {
            case "water": guard raw == 0 else { throw ServiceError.invalidResponse }; expectedGrade = "A"
            case "beverage": expectedGrade = raw <= 2 ? "B" : raw <= 6 ? "C" : raw <= 9 ? "D" : "E"
            default: expectedGrade = raw <= (category == "fats_nuts_seeds" ? -6 : 0) ? "A" : raw <= 2 ? "B" : raw <= 10 ? "C" : raw <= 18 ? "D" : "E"
            }
            guard grade == expectedGrade, (category == "beverage" || raw <= 55),
                  absent("baseFrequency"), absent("finalFrequency") else { throw ServiceError.invalidResponse }
            if status.hasPrefix("estimated") && score["estimated"] as? Bool != true { throw ServiceError.invalidResponse }
        } else {
            guard ["grade", "rawScore", "rawLower", "rawUpper", "displayLower", "displayUpper", "value"].allSatisfy(absent) else { throw ServiceError.invalidResponse }
        }
        // Only bounded public calculation evidence reaches WKWebView.
        let keys = Set(["status", "grade", "rawScore", "rawLower", "rawUpper", "value", "displayLower", "displayUpper", "band", "methodId", "version", "methodVersion", "methodStatus", "baseAlgorithmVersion", "components", "missingInputs", "missingFields", "reason", "explanation", "source", "sources", "evidence", "calculatedAt", "inputHash", "category", "negativePoints", "positivePoints", "positivePointsUpper", "countProteins", "promptVersion", "calculationBasis", "inputs", "model", "available", "completeness", "assumptions", "baseFrequency", "finalFrequency", "frequencyStatus", "personalSuitability", "sourceVersion", "sourceData", "model_version", "estimated", "scoreBasis", "reasonCodes", "quality", "inferredInputs", "inputFingerprint", "sourceInputs", "providerReference"])
        var result: [String: Any] = ["score": score.filter { keys.contains($0.key) || $0.key == "classifierVersion" }]
        if let marker = score["catalogueQualityHold"] {
            // This endpoint is authenticated, but it does not provide the full
            // catalogue envelope. Suppress local fallback while that envelope
            // is refreshed; never promote the marker to durable source proof.
            guard status == "unrated", score["available"] as? Bool == false,
                  let hold = marker as? [String: Any], hold["version"] as? String == "catalogue-quality-hold-v1",
                  let code = hold["barcode"] as? String, code.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil,
                  ["sourceFingerprint", "candidateSHA256"].allSatisfy({ (hold[$0] as? String)?.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil }),
                  ["runID", "reviewID"].allSatisfy({ (hold[$0] as? String)?.range(of: #"^[A-Za-z0-9_-]{8,80}$"#, options: .regularExpression) != nil }),
                  ["source_salt_sodium_conflict", "source_alcohol_not_represented", "source_identity_conflict"].contains(hold["reasonCode"] as? String ?? ""),
                  let source = hold["sourceFetchedAt"] as? NSNumber, let reviewed = hold["reviewedAt"] as? NSNumber,
                  CFGetTypeID(source) != CFBooleanGetTypeID(), CFGetTypeID(reviewed) != CFBooleanGetTypeID(),
                  source.doubleValue.isFinite, reviewed.doubleValue.isFinite, source.doubleValue > 0,
                  source.doubleValue.rounded() == source.doubleValue, reviewed.doubleValue.rounded() == reviewed.doubleValue,
                  reviewed.doubleValue >= source.doubleValue, reviewed.doubleValue <= Date().addingTimeInterval(60).timeIntervalSince1970 * 1000 else { throw ServiceError.invalidResponse }
            var safe = result["score"] as? [String: Any] ?? [:]
            safe["scoreBasis"] = "catalogue_quality_check"
            safe["catalogueCheckRequired"] = true; safe["catalogueCheckBarcode"] = code
            result["score"] = safe
        }
        if let calculated = object["calculatedAt"] as? NSNumber, CFGetTypeID(calculated) != CFBooleanGetTypeID(),
           calculated.doubleValue.isFinite, calculated.doubleValue > 0,
           calculated.doubleValue.rounded() == calculated.doubleValue,
           calculated.doubleValue <= Date().addingTimeInterval(60).timeIntervalSince1970 * 1000 {
            result["calculatedAt"] = calculated
        }
        if let marker = score["catalogueEnrichment"] {
            guard let evidence = marker as? [String: Any],
                  evidence["version"] as? String == "catalogue-enrichment-v1",
                  let fingerprint = evidence["sourceFingerprint"] as? String,
                  fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let expiry = evidence["expiresAt"] as? NSNumber, CFGetTypeID(expiry) != CFBooleanGetTypeID(),
                  expiry.doubleValue.isFinite, expiry.doubleValue.rounded() == expiry.doubleValue,
                  expiry.doubleValue > 0 else { throw ServiceError.invalidResponse }
            var safe = result["score"] as? [String: Any] ?? [:]
            safe["catalogueEnrichment"] = ["version": "catalogue-enrichment-v1", "sourceFingerprint": fingerprint, "expiresAt": expiry]
            result["score"] = safe
        }
        if let provider = score["provider"] as? [String: Any], provider["source"] as? String == "Open Food Facts",
           provider["version"] as? String == "2023", let code = provider["barcode"] as? String,
           code.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil,
           provider["sourceURL"] as? String == "https://world.openfoodfacts.org/product/" + code {
            let allowed = Set(["source", "version", "sourceURL", "barcode", "preparation", "estimated", "factsFingerprint"])
            var safe = result["score"] as? [String: Any] ?? [:]
            safe["provider"] = provider.filter { allowed.contains($0.key) }
            result["score"] = safe
        }
        if let evidence = score["classificationEvidence"] as? [String: Any] {
            var clean: [String: Any] = [:]
            if let version = evidence["version"] as? String, version.count <= 100 { clean["version"] = version }
            for key in ["resolutions", "conflicts"] { clean[key] = (evidence[key] as? [String] ?? []).filter { $0.count <= 160 }.prefix(12).map { $0 } }
            clean["evidence"] = (evidence["evidence"] as? [[String: Any]] ?? []).prefix(4).compactMap { item -> [String: String]? in
                guard let field = item["field"] as? String, ["name", "categoryTag", "categories", "categoriesTags", "ingredients"].contains(field),
                      let quote = item["quote"] as? String, quote.count <= 400 else { return nil }
                return ["field": field, "quote": quote]
            }
            var safeScore = result["score"] as? [String: Any] ?? [:]; safeScore["classificationEvidence"] = clean; result["score"] = safeScore
        }
        if let recovery = object["recovery"] as? [String: Any], recovery["version"] as? String == "food-recovery-v1",
           let status = recovery["status"] as? String, ["verified", "estimated", "unresolved", "conflict"].contains(status) {
            let recoveryKeys = Set(["version", "status", "addedFields", "conflicts", "provenance"])
            var clean = recovery.filter { recoveryKeys.contains($0.key) }
            for key in ["addedFields", "conflicts"] {
                clean[key] = (recovery[key] as? [String] ?? []).filter { $0.utf8.count <= 160 }.prefix(20).map { $0 }
            }
            let sourceKeys = Set(["provider", "url", "retrievedAt", "version", "verification", "licenceURL", "fields", "recordId"])
            clean["provenance"] = (recovery["provenance"] as? [[String: Any]] ?? []).prefix(8).map { item -> [String: Any] in
                var source: [String: Any] = [:]
                for key in sourceKeys where key != "fields" {
                    if let value = item[key] as? String, value.utf8.count <= 2_048 { source[key] = value }
                }
                if let fields = item["fields"] as? [String] { source["fields"] = fields.filter { $0.count <= 160 }.prefix(20).map { $0 } }
                return source
            }
            if let product = recovery["product"] as? [String: Any],
               let body = try? productScoreBody(product: product),
               let container = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                clean["product"] = container["product"]
            }
            if let estimate = recovery["estimate"] as? [String: Any], var estimatedScore = estimate["score"] as? [String: Any],
               let estimateStatus = estimatedScore["status"] as? String,
               ["estimated", "estimated_provisional"].contains(estimateStatus), estimatedScore["estimated"] as? Bool == true,
               estimatedScore["scoreBasis"] as? String == "sourced_composition" {
                // Validate the same fixed calculator result, then restore its
                // estimate label. No generic nutrient is promoted to label data.
                estimatedScore["status"] = estimateStatus == "estimated" ? "rated" : "provisional"
                if let bytes = try? JSONSerialization.data(withJSONObject: ["score": estimatedScore]),
                   let decoded = try? decodedScoreResult(from: bytes), var verified = decoded["score"] as? [String: Any] {
                    verified["status"] = estimateStatus
                    let recordKeys = Set(["id", "name", "source", "sourceVersion", "sourceURL", "basis", "valueStatus", "foodGroup", "nutrients", "preparation", "licenceURL"])
                    let rawRecord = estimate["sourceRecord"] as? [String: Any] ?? [:]
                    var record: [String: Any] = [:]
                    for key in recordKeys where key != "nutrients" {
                        if let value = rawRecord[key] as? String, value.utf8.count <= 2_048 { record[key] = value }
                    }
                    var values: [String: Any] = [:]
                    for field in OpenFoodFactsParser.nutrientFields {
                        guard let item = (rawRecord["nutrients"] as? [String: Any])?[field.key] as? [String: Any] else { continue }
                        var value: [String: Any] = ["value": NSNull(), "unit": field.unit, "status": "composition_estimate"]
                        if let n = item["value"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                           n.doubleValue >= 0, n.doubleValue <= (field.unit == "g" ? 100 : 5_000), item["unit"] as? String == field.unit { value["value"] = n }
                        if let relation = item["relation"] as? String, ["eq", "lt", "lte", "gt", "gte", "approx"].contains(relation) { value["relation"] = relation }
                        values[field.key] = value
                    }
                    record["nutrients"] = values
                    clean["estimate"] = ["score": verified, "sourceRecord": record]
                }
            }
            if let bytes = try? JSONSerialization.data(withJSONObject: clean), bytes.count <= 40_000 { result["recovery"] = clean }
        }
        return result
    }

    static func errorForScoreHTTPResponse(statusCode: Int) -> ServiceError? {
        switch statusCode {
        case 200: nil
        case 401, 403: .accountAuthentication
        case 429: .server("Product analysis is busy. Try again later.")
        case 400, 413, 415, 422: .server("There is not enough supported product information to calculate this rating.")
        default: .server("The product rating is unavailable right now. The available food facts are still shown.")
        }
    }

    /// Fetches only public barcode facts; never submits photos, profile or diary.
    /// No AI is invoked by this route. The direct provider lookup remains a fallback.
    static func catalogueLookupError(statusCode: Int, responseCode: String? = nil, retryAfter: String? = nil, at date: Date = Date()) -> Error? {
        switch statusCode {
        case 200: return nil
        case 401, 403: return ServiceError.accountAuthentication
        // This endpoint uses 404 for both a source miss and source failure. It
        // has already tried OFF; don't repeat that call or claim a proven miss.
        case 404: return responseCode == "product_not_found" ? BarcodeLookupError.notFound : BarcodeLookupError.server(503)
        case 429: return BarcodeLookupError.retryLater(OpenFoodFactsService.searchRetryAfter(retryAfter, at: date, fallback: 60))
        case 500...599: return BarcodeLookupError.server(statusCode)
        default: return BarcodeLookupError.invalidResponse
        }
    }

    func catalogueProductData(barcode: String) async throws -> (data: Data, retrievedAt: Date) {
        guard barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil else { throw ServiceError.invalidResponse }
        let manager = await NudgeAccountManager.shared
        let revision = await manager.revision
        let account = try await manager.authorization()
        let configuration: BackendConfiguration
        if let account { configuration = BackendConfiguration(baseURL: account.backendURL, token: account.token) }
        else if let saved = BackendCredentialStore.configuration() { configuration = saved }
        else { throw ServiceError.accountAuthentication }
        try Task.checkCancellation()
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent("v1/products/lookup"))
        request.httpMethod = "POST"
        request.timeoutInterval = 6
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        // Only clients with the typed community decoder may receive reviewed
        // facts here; older clients interpret this endpoint as OFF-only.
        request.setValue("reviewed-v1", forHTTPHeaderField: "X-Nudge-Catalogue-Source")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["barcode": barcode])
        let data: Data
        do {
            let (received, response) = try await BoundedHTTPData.load(request, session: Self.catalogueSession, maximumBytes: 196_608)
            let responseCode = (try? JSONSerialization.jsonObject(with: received) as? [String: Any])?["code"] as? String
            if let error = Self.catalogueLookupError(statusCode: response.statusCode, responseCode: responseCode, retryAfter: response.value(forHTTPHeaderField: "Retry-After")) { throw error }
            data = received
        } catch is BoundedHTTPData.Failure { throw ServiceError.invalidResponse }
        try Task.checkCancellation()
        guard await manager.revision == revision,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ServiceError.invalidResponse }
        return try Self.decodedCatalogueProductData(result, barcode: barcode, backendURL: configuration.baseURL, at: Date())
    }

    static func decodedCatalogueProductData(_ result: [String: Any], barcode: String, backendURL: URL, at date: Date) throws -> (data: Data, retrievedAt: Date) {
        guard let payload = result["providerPayload"] as? [String: Any],
              let product = payload["product"] as? [String: Any], product["code"] as? String == barcode else { throw ServiceError.invalidResponse }
        guard let fetched = result["fetchedAt"] as? NSNumber, CFGetTypeID(fetched) != CFBooleanGetTypeID(), fetched.doubleValue.isFinite else { throw ServiceError.invalidResponse }
        let retrievedAt = Date(timeIntervalSince1970: fetched.doubleValue / 1000)
        if result["source"] as? String == "Nudge community" {
            guard let metadata = result["reviewedMetadata"] as? [String: Any],
                  metadata["sourceKind"] as? String == "nudge_community",
                  let provenance = metadata["provenance"] as? [String: Any],
                  provenance["verification"] as? String == "reviewed_packaging_photos",
                  provenance["categoryReview"] as? String == "administrator_confirmed",
                  provenance["photosPublic"] as? Bool == false,
                  let reviewed = metadata["reviewedAt"] as? NSNumber, CFGetTypeID(reviewed) != CFBooleanGetTypeID(), reviewed == fetched,
                  let expires = metadata["expiresAt"] as? NSNumber, CFGetTypeID(expires) != CFBooleanGetTypeID(), expires.doubleValue > date.timeIntervalSince1970 * 1000 else { throw ServiceError.invalidResponse }
            let envelope: [String: Any] = ["version": "nudge-catalogue-index-v1", "products": [product], "ratings": [metadata]]
            guard let bound = try NudgeCatalogueService.products(envelope, at: date, trustedBackendURL: backendURL).first,
                  bound.sourceKind == "nudge_community", bound.hasTrustedCatalogueSource else { throw ServiceError.invalidResponse }
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(bound))
            return (try JSONSerialization.data(withJSONObject: ["nudgeCatalogueProduct": object]), retrievedAt)
        }
        if let source = result["source"] as? String, source != "Open Food Facts" { throw ServiceError.invalidResponse }
        guard result["reviewedMetadata"] == nil else { throw ServiceError.invalidResponse }
        if let score = result["catalogueRating"] as? [String: Any], score["catalogueQualityHold"] != nil {
            let row: [String: Any] = ["barcode": barcode, "method": score["methodId"] ?? NSNull(), "version": score["version"] ?? NSNull(),
                "classifierVersion": score["classifierVersion"] ?? NSNull(), "sourceRevision": product["last_modified_t"] ?? NSNull(),
                "fetchedAt": fetched, "expiresAt": fetched.doubleValue + 30 * 86_400_000, "calculatedAt": result["catalogueCalculatedAt"] ?? NSNull(),
                "sourceFingerprint": result["catalogueSourceFingerprint"] ?? NSNull(), "freshness": "stale", "score": score]
            let envelope: [String: Any] = ["version": "nudge-catalogue-index-v1", "products": [product], "ratings": [row]]
            guard let bound = try NudgeCatalogueService.products(envelope, at: date, trustedBackendURL: backendURL).first,
                  bound.catalogueRating?.qualityHold(for: bound, at: date) != nil else { throw ServiceError.invalidResponse }
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(bound))
            return (try JSONSerialization.data(withJSONObject: ["nudgeCatalogueProduct": object]), retrievedAt)
        }
        guard date.timeIntervalSince(retrievedAt) >= -60, date.timeIntervalSince(retrievedAt) < 30 * 86_400 else { throw ServiceError.invalidResponse }
        // Only the provider product crosses this branch. Raw OFF siblings may
        // not impersonate our authenticated, typed catalogue bridge above.
        return (try JSONSerialization.data(withJSONObject: ["product": product]), retrievedAt)
    }

    func scoreProduct(_ product: [String: Any]) async throws -> [String: Any] {
        guard PhotoAnalysisPermission().allowed else { throw ServiceError.productScorePermissionRequired }
        let body = try Self.productScoreBody(product: product)
        let manager = await NudgeAccountManager.shared
        let revision = await manager.revision
        let account = try await manager.authorization()
        let configuration: BackendConfiguration
        if let account { configuration = BackendConfiguration(baseURL: account.backendURL, token: account.token) }
        else if let saved = BackendCredentialStore.configuration() { configuration = saved }
        else { throw ServiceError.accountAuthentication }
        try Task.checkCancellation()
        guard await manager.revision == revision, PhotoAnalysisPermission().allowed else { throw CancellationError() }
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent("v1/products/score"))
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        let data: Data, http: HTTPURLResponse
        do {
            (data, http) = try await BoundedHTTPData.load(request, session: Self.scoreSession, maximumBytes: 65_536)
        } catch is BoundedHTTPData.Failure { throw ServiceError.invalidResponse }
        try Task.checkCancellation()
        guard await manager.revision == revision, PhotoAnalysisPermission().allowed else { throw CancellationError() }
        if account != nil, http.statusCode == 401 || http.statusCode == 403 { await manager.requireSignIn() }
        if let error = Self.errorForScoreHTTPResponse(statusCode: http.statusCode) { throw error }
        let result = try Self.decodedScoreResult(from: data)
        if let score = result["score"] as? [String: Any], score["catalogueCheckRequired"] as? Bool == true,
           score["catalogueCheckBarcode"] as? String != product["barcode"] as? String { throw ServiceError.invalidResponse }
        return result
    }

    func analyse(jpegData: Data, productJPEGData: Data? = nil) async throws -> [String: Any] {
        try await analyse(body: Self.uploadBody(jpegData: jpegData, productJPEGData: productJPEGData))
    }

    func analyse(images: [Data], photoIDs: [String]? = nil, captureRevision: Int? = nil, voiceMemo: VoiceMemoPayload? = nil, diagnosticID: UUID = UUID(), captureID: UUID? = nil, ownerKey: String? = nil, mealHints: NativeMealAnalysisHints? = nil, fastCapture: Bool = false) async throws -> [String: Any] {
        var body = try Self.uploadBody(images: images, photoIDs: photoIDs, captureRevision: captureRevision, voiceMemo: voiceMemo, mealHints: mealHints)
        if let captureID {
            var object = try JSONSerialization.jsonObject(with: body) as! [String: Any]
            object["captureId"] = captureID.uuidString.lowercased()
            body = try JSONSerialization.data(withJSONObject: object, options: .withoutEscapingSlashes)
        }
        return try await analyse(body: body, diagnosticID: diagnosticID, includesVoiceMemo: voiceMemo != nil, captureID: captureID, ownerKey: ownerKey, fastCapture: fastCapture)
    }

    func retrieveCapture(_ captureID: UUID, ownerKey: String) async throws -> [String: Any] {
        try await analyse(body: Data(), diagnosticID: captureID, captureID: captureID, ownerKey: ownerKey, retrieving: true)
    }

    func retryCapture(_ captureID: UUID, ownerKey: String) async throws -> [String: Any] {
        try await analyse(body: Data("{}".utf8), diagnosticID: captureID, captureID: captureID, ownerKey: ownerKey, retrieving: true, manualRetry: true)
    }

    static func captureRetryAfter(_ value: String?, at date: Date = Date(), fallback: TimeInterval = 60) -> TimeInterval {
        let clean = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let seconds = Double(clean), seconds.isFinite { return max(1, seconds) }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let until = formatter.date(from: clean) { return max(1, until.timeIntervalSince(date)) }
        return max(1, fallback)
    }

    func deleteCapture(_ captureID: UUID, ownerKey: String) async throws {
        _ = try await analyse(body: Data(), captureID: captureID, ownerKey: ownerKey, retrieving: true, deleting: true)
    }

    private func analyse(body: Data, diagnosticID: UUID = UUID(), includesVoiceMemo: Bool = false, captureID: UUID? = nil, ownerKey: String? = nil, retrieving: Bool = false, deleting: Bool = false, manualRetry: Bool = false, fastCapture: Bool = false) async throws -> [String: Any] {
        guard deleting || PhotoAnalysisPermission().allowed else { throw ServiceError.photoPermissionRequired }
        let manager = await NudgeAccountManager.shared
        let accountRevision = await manager.revision
        // An existing but expired/rejected account must throw here. It must not
        // silently borrow the developer's private token or spending allowance.
        let authorizationStarted = ProcessInfo.processInfo.systemUptime
        let account = try await manager.authorization()
        let authorizationMs = max(0, Int((ProcessInfo.processInfo.systemUptime - authorizationStarted) * 1000))
        let configuration: BackendConfiguration
        if let account { configuration = BackendConfiguration(baseURL: account.backendURL, token: account.token) }
        else if let privateConfiguration = BackendCredentialStore.configuration() { configuration = privateConfiguration }
        else { throw ServiceError.notConfigured }
        guard await manager.revision == accountRevision, deleting || PhotoAnalysisPermission().allowed else { throw CancellationError() }
        if let ownerKey {
            guard try ProductContributionService.ownerKey(token: configuration.token, baseURL: configuration.baseURL) == ownerKey else { throw CancellationError() }
        }
        let limits = Self.analysisTimeouts(includesVoiceMemo: includesVoiceMemo)
        let path = retrieving ? "v1/nutrition-label/jobs/" + captureID!.uuidString.lowercased() + (manualRetry ? "/retry" : "") : "v1/nutrition-label/analyse"
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent(path))
        request.httpMethod = deleting ? "DELETE" : manualRetry ? "POST" : retrieving ? "GET" : "POST"
        request.timeoutInterval = limits.request
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        // Older deployed services safely ignore this header. The new service
        // persists its validated policy before dispatch; legacy bodies stay valid.
        if fastCapture && !retrieving { request.setValue("fast-v1", forHTTPHeaderField: "X-Nudge-Capture-Policy") }
        request.httpBody = retrieving && !manualRetry ? nil : body
        let started = ProcessInfo.processInfo.systemUptime, responseTiming = ResponseTiming()
        let captureOperation = deleting ? "delete" : manualRetry ? "retry" : retrieving ? "retrieve" : "analyse"
        var metadata: [String:Any] = ["attemptId":diagnosticID.uuidString, "route":"photo_analysis",
            "captureOperation": captureOperation,
            "requestTimeoutMs":Int(limits.request * 1000), "resourceTimeoutMs":Int(limits.resource * 1000),
            "payloadBytes":body.count, "includesVoiceMemo":includesVoiceMemo, "authorizationMs":authorizationMs]
        AnalysisDiagnostics.shared.record(stage:"transport", outcome:"started", metadata:metadata)
        let response: HTTPURLResponse
        var data = Data()
        do {
            do {
                (data, response) = try await BoundedHTTPData.load(request, session: Self.analysisSession,
                    maximumBytes: Self.maximumAnalysisResponseBytes, onResponse: responseTiming.record)
            } catch BoundedHTTPData.Failure.bodyTooLarge {
                throw ServiceError.classified(code:"result_too_large", message:"")
            } catch BoundedHTTPData.Failure.invalidResponse {
                throw ServiceError.invalidResponse
            }
        } catch {
            metadata.merge(responseTiming.metadata(since: started, completedAt: ProcessInfo.processInfo.systemUptime)) { _, new in new }
            metadata["nativeElapsedMs"] = max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000))
            metadata["responseBytes"] = data.count
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                AnalysisDiagnostics.shared.record(stage:"transport", outcome:"cancelled", metadata:metadata)
                throw CancellationError()
            }
            let failure = Self.publicFailure(error)
            metadata["failureOrigin"] = "native_transport"
            if failure.code == "analysis_timeout" { metadata["timeoutSource"] = "native_transport" }
            AnalysisDiagnostics.shared.record(stage:"transport", outcome:failure.code, metadata:metadata)
            throw error
        }
        try Task.checkCancellation()
        guard await manager.revision == accountRevision, deleting || PhotoAnalysisPermission().allowed else { throw CancellationError() }
        let http = response
        metadata.merge(responseTiming.metadata(since: started, completedAt: ProcessInfo.processInfo.systemUptime)) { _, new in new }
        metadata["httpStatus"] = http.statusCode
        metadata["responseBytes"] = data.count
        metadata["nativeElapsedMs"] = max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000))
        if let payload = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
           let trace = payload["trace"] as? [String:Any] {
            metadata.merge(AnalysisDiagnostics.safeMetadata(trace)) { current, _ in current }
            if let usage = trace["usage"] as? [String: Any], usage["version"] as? Int == 1 {
                var totals = usage["totals"] as? [String: Any] ?? [:]
                totals["usageStatus"] = usage["status"]; totals["billingScope"] = usage["billingScope"]
                totals["priceVersion"] = usage["priceVersion"]
                if let observation = (usage["calls"] as? [[String: Any]])?.first(where: { $0["kind"] as? String == "observation" }) {
                    totals["reportedModel"] = observation["reportedModel"]
                    totals["providerRequestId"] = observation["providerRequestId"]
                }
                metadata.merge(AnalysisDiagnostics.safeMetadata(totals)) { current, _ in current }
            }
        }
        if http.statusCode == 504 {
            metadata["failureOrigin"] = "backend"
            metadata["timeoutSource"] = metadata["outcome"] as? String == "voice_transcription_timeout" ? "voice_transcription" : "backend_deadline"
        }
        AnalysisDiagnostics.shared.record(stage:"http_response", outcome:"received", metadata:metadata)
        if account != nil, http.statusCode == 401 || http.statusCode == 403 {
            await manager.requireSignIn()
        }
        let failure = account == nil ? Self.errorForHTTPResponse(statusCode: http.statusCode, data: data)
            : Self.errorForAccountHTTPResponse(statusCode: http.statusCode, data: data)
        if deleting, (200...299).contains(http.statusCode) || http.statusCode == 404 || http.statusCode == 410 { return [:] }
        if retrieving && !deleting && http.statusCode == 404 { return ["captureMissing": true] }
        if captureID != nil && !deleting && http.statusCode == 410,
           let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any], payload["code"] as? String == "capture_expired" {
            return ["captureExpired": true]
        }
        if http.statusCode == 202, captureID != nil,
           var pending = try JSONSerialization.jsonObject(with: data) as? [String: Any], pending["job"] is [String: Any] {
            pending["retryAfterSeconds"] = Self.captureRetryAfter(http.value(forHTTPHeaderField: "Retry-After"), fallback: 1)
            return pending
        }
        if let failure {
            if captureID != nil {
                let delay = http.value(forHTTPHeaderField: "Retry-After").map { Self.captureRetryAfter($0) }
                throw CaptureTransportFailure(underlying: failure, retryAfter: delay,
                    manualRetryRequired: !deleting && Self.captureRequiresManualRetry(statusCode: http.statusCode, data: data))
            }
            throw failure
        }
        return try Self.decodedResult(from: data, diagnosticID: diagnosticID, captureOperation: captureOperation)
    }
}

@MainActor
enum BackendConnectionPresenter {
    static func present(from presenter: UIViewController, completion: @escaping (Bool) -> Void) {
        let existing = BackendCredentialStore.configuration()
        let alert = UIAlertController(title: "Private label backend", message: "Enter your deployed HTTPS backend origin and its 64-character device token. Never enter your OpenAI API key here. The connection stays in this iPhone’s Keychain. Leave the token blank to keep it for the same server.", preferredStyle: .alert)
        alert.view.tintColor = NudgeTheme.accent
        alert.addTextField {
            $0.placeholder = "https://your-worker.workers.dev"
            $0.text = existing?.baseURL.absoluteString
            $0.keyboardType = .URL
            $0.autocapitalizationType = .none
            $0.autocorrectionType = .no
        }
        alert.addTextField {
            $0.placeholder = existing == nil ? "Private backend device token" : "Saved token · leave blank to keep"
            $0.isSecureTextEntry = true
            $0.autocapitalizationType = .none
            $0.autocorrectionType = .no
            $0.spellCheckingType = .no
            $0.textContentType = .password
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(false) })
        alert.addAction(UIAlertAction(title: "Save connection", style: .default) { _ in
            let rawURL = alert.textFields?[0].text ?? ""
            let rawToken = (alert.textFields?[1].text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let url = BackendConfiguration.validatedURL(rawURL)
            let sameOrigin = url?.host == existing?.baseURL.host
            let token = rawToken.isEmpty && sameOrigin ? existing?.token ?? "" : rawToken
            alert.textFields?[1].text = nil
            var message: String?
            if url == nil { message = "Use an HTTPS origin with no path, query, username or password." }
            else if !BackendConfiguration.validToken(token) { message = "Use the 64-character lowercase hexadecimal device token generated during backend setup. Your OpenAI API key belongs only in the server secret prompt." }
            else {
                do { try BackendCredentialStore.save(BackendConfiguration(baseURL: url!, token: token)) }
                catch { message = error.localizedDescription }
            }
            if let message {
                let failure = UIAlertController(title: "Connection not saved", message: message, preferredStyle: .alert)
                failure.view.tintColor = NudgeTheme.accent
                failure.addAction(UIAlertAction(title: "OK", style: .default) { _ in completion(false) })
                presenter.present(failure, animated: true)
            } else { completion(true) }
        })
        presenter.present(alert, animated: true)
    }
}

@MainActor
protocol NutritionLabelPickerDelegate: AnyObject {
    func labelPicker(_ picker: NutritionLabelPickerController, didChoose jpegData: Data)
    func labelPickerDidCancel(_ picker: NutritionLabelPickerController)
    func labelPicker(_ picker: NutritionLabelPickerController, didFail message: String)
}

@MainActor
final class NutritionLabelPickerController: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    enum PhotoKind: String {
        case product, label

        var title: String { self == .product ? "Photograph product front" : "Photograph the label" }
        var guidance: String {
            self == .product ? "Show the product name and brand clearly on the front of the pack." : "Show the complete ingredients list or nutrition table. Include the per-100-g/ml or serving heading if there is one."
        }
    }

    weak var delegate: NutritionLabelPickerDelegate?
    private weak var presenter: UIViewController?
    private var picker: UIImagePickerController?
    private weak var sourceSheet: UIAlertController?
    private var isCancelled = false
    let photoKind: PhotoKind

    init(photoKind: PhotoKind = .label) { self.photoKind = photoKind }

    func cancel() {
        isCancelled = true
        delegate = nil
        picker?.dismiss(animated: true)
        sourceSheet?.dismiss(animated: true)
    }

    func present(from presenter: UIViewController) {
        self.presenter = presenter
        let sheet = UIAlertController(title: photoKind.title, message: photoKind.guidance, preferredStyle: .actionSheet)
        sheet.view.tintColor = NudgeTheme.accent
        sourceSheet = sheet
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "Take photo", style: .default) { [weak self] _ in self?.open(.camera) })
        }
        sheet.addAction(UIAlertAction(title: "Choose from Photo Library", style: .default) { [weak self] _ in self?.open(.photoLibrary) })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self else { return }; self.delegate?.labelPickerDidCancel(self)
        })
        sheet.popoverPresentationController?.sourceView = presenter.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        presenter.present(sheet, animated: true)
    }

    private func open(_ source: UIImagePickerController.SourceType) {
        Task { [weak self] in
            guard let self, !isCancelled, let presenter else { return }
            if source == .camera {
                let status = AVCaptureDevice.authorizationStatus(for: .video)
                let allowed: Bool
                if status == .notDetermined { allowed = await AVCaptureDevice.requestAccess(for: .video) }
                else { allowed = status == .authorized }
                guard !isCancelled else { return }
                guard allowed else {
                    delegate?.labelPicker(self, didFail: "Camera access is off. Enable it for Nudge in iPhone Settings, or choose a photo from your library.")
                    return
                }
            }
            guard UIImagePickerController.isSourceTypeAvailable(source) else {
                delegate?.labelPicker(self, didFail: "This photo source is unavailable. Choose another source.")
                return
            }
            let picker = UIImagePickerController()
            picker.view.tintColor = NudgeTheme.accent
            picker.sourceType = source
            picker.mediaTypes = ["public.image"]
            picker.delegate = self
            picker.modalPresentationStyle = .fullScreen
            self.picker = picker
            presenter.present(picker, animated: true)
        }
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self, !isCancelled else { return }
            delegate?.labelPickerDidCancel(self)
        }
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        guard let image = info[.originalImage] as? UIImage,
              let data = Self.resizedJPEG(from: image, maximumBytes: photoKind == .product ? 1_500_000 : 4_500_000,
                                         maxDimension: photoKind == .product ? 1_600 : 2_400) else {
            picker.dismiss(animated: true) { [weak self] in
                guard let self, !isCancelled else { return }
                delegate?.labelPicker(self, didFail: "Nudge could not prepare that photo. Try another image.")
            }
            return
        }
        picker.dismiss(animated: true) { [weak self] in
            guard let self, !isCancelled else { return }
            delegate?.labelPicker(self, didChoose: data)
        }
    }

    /// Redrawing strips camera metadata. Scale 1 makes the bound pixels, not display points.
    static func resizedJPEG(from image: UIImage, maximumBytes: Int = 6_000_000, maxDimension: CGFloat = 2_400) -> Data? {
        guard image.size.width > 0, image.size.height > 0, maximumBytes > 0, maxDimension > 0 else { return nil }
        let scale = min(1, min(maxDimension, 2_400) / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, floor(image.size.width * scale)), height: max(1, floor(image.size.height * scale)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let resized = renderer.image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        for quality in [0.82, 0.68, 0.52] {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= min(maximumBytes, 6_000_000) { return data }
        }
        return nil
    }
}
