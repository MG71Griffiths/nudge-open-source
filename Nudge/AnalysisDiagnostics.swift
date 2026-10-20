import Foundation
import CryptoKit
import CoreFoundation
import UIKit

/// Small local support record, separate from food history. No free-form messages,
/// photos, food facts, account identifiers, URLs or credentials are accepted.
final class AnalysisDiagnostics: @unchecked Sendable {
    static let shared = AnalysisDiagnostics(deferredWrites: true)
    static let maximumEvents = 200
    static let maximumBytes = 262_144
    static let retention: TimeInterval = 7 * 24 * 60 * 60
    private let fileURL: URL
    private let lock = NSLock()
    private let deferredWrites: Bool
    private let writerQueue: DispatchQueue
    private let pendingLock = NSLock()
    private struct Event {
        let stage: String
        let outcome: String
        let metadata: [String: Any]
        let time: Date
    }
    private var pending: [Event] = []
    private var writerScheduled = false

    init(directory: URL? = nil, deferredWrites: Bool = false,
         writerQueue: DispatchQueue = DispatchQueue(label: "com.nudge.diagnostics", qos: .utility)) {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("NudgeDiagnostics", isDirectory: true)
        fileURL = base.appendingPathComponent("events.json")
        self.deferredWrites = deferredWrites
        self.writerQueue = writerQueue
    }

    static func fingerprint(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    // Web code may report only its own events, never impersonate an HTTP result
    // or a successful native analysis. Values remain fixed technical categories.
    private static let webOutcomes: [String: Set<String>] = [
        "storage": ["saved", "save_failed", "quota_exceeded", "storage_unavailable", "parse_failed", "recovered", "backup_exclusion_failed"],
        "nutrition": ["calculated", "incomplete"],
        "navigation": ["opened"],
        "lifecycle": ["started", "foregrounded", "backgrounded"],
        "ui_error": ["unhandled_error", "promise_rejection", "render_failed"]
    ]
    private static let screens: Set<String> = ["today", "history", "food", "rhythm", "together", "you", "ai", "meal", "review", "camera", "profile", "meal-scan", "meal-prompt", "meal-result", "food-week", "chocolate", "nudge-progress", "food-patterns", "food-entry", "barcode", "label-photo", "recipes", "search", "recipe-detail", "cacao", "rewards", "food-context", "food-fit", "meal-capture", "connections", "settings", "account", "cycle", "cycle-settings", "cycle-checkin", "unknown"]
    private static let stages: Set<String> = Set(["capture_performance", "app", "product_contribution", "catalogue", "rating_batch", "barcode_lookup", "barcode_scan", "image_submission", "authentication", "permission", "configuration", "quota", "upload", "response", "visual_evidence", "connection", "transport", "structured_response", "http_response", "native_parse", "photo_library", "ui_delivery", "search_request", "search_http", "search_response", "search_delivery", "search_ui"]).union(webOutcomes.keys)
    private static let outcomes: Set<String> = Set(["usage_received", "prepared", "result_ready", "card_visible", "still_analysing", "local_result", "local_fallback", "inference_finished", "chatgpt_account", "chatgpt_limit", "chatgpt_model", "chatgpt_result", "chatgpt_interrupted", "queued", "completed", "failed", "deferred", "cache_hit", "delivered", "delivery_failed", "started", "invoked", "matched", "parsed", "received", "cancelled", "invalid_json", "missing_extraction", "body_too_large", "imported", "partial_import", "import_failed", "invalidBarcode", "notFound", "incompleteProduct", "offline", "timeout", "rateLimited", "server", "invalidResponse", "notConfigured", "unauthenticated", "signInRequired", "photoPermissionRequired", "permission_required", "account_storage", "upstream_auth", "upstream_access", "upstream_model", "upstream_billing", "server_not_configured", "route_not_found", "request_invalid", "upstream_request", "upstream_redirect", "quota_busy", "quota_exceeded", "upstream_rate_limit", "upload_invalid", "upload_too_large", "invalid_image", "upstream_image", "upstream_refusal", "upstream_incomplete", "result_too_large", "response_invalid", "upstream_invalid_response", "label_unreadable", "upstream_timeout", "analysis_timeout", "analysis_connection", "upstream_network", "upstream_unavailable", "server_unavailable", "analysis", "voice_invalid", "voice_too_large", "voice_transcription_failed", "voice_transcription_empty", "voice_transcription_timeout", "invalidQuery", "unavailable", "providerBusy", "cached", "stale", "no_matches", "rendered", "filtered_empty"]).union(webOutcomes.values.flatMap { $0 })
    private static let issues: Set<String> = ["metadata_shape", "evidence_reference", "extraction_shape", "photo_reference", "output_json", "output_envelope", "output_shape", "result_size", "ingredient_evidence", "allergen_evidence", "claim_evidence", "ingredient_tree_evidence", "ingredient_tree_parent", "quantity_evidence", "date_evidence", "conflict_evidence",
        "evidence_id_missing", "evidence_id_duplicate", "evidence_text_missing",
        "meal_shape", "meal_quality_estimate", "meal_identity", "meal_portion_mode", "meal_subject", "meal_portion_selection",
        "meal_ingredients_shape", "meal_ingredient_text", "meal_plants_shape", "meal_plant_text",
        "meal_recipe_evidence", "meal_recipe_quantity", "meal_recipe_servings",
        "meal_portion", "meal_nutrients", "meal_components", "meal_unused_product_shape",
        "meal_plant_evidence", "meal_unused_product_fields", "subject_uncertain", "subject_unidentified", "subject_type_mismatch"]

    // Paths describe only the fixed recipe/plate schemas, never model values or
    // unexpected property names. Keep array positions within their schema bounds.
    private static let recipeSchemaReasons: Set<String> = ["type", "enum", "max_length", "markup", "control_character", "not_finite", "minimum", "maximum", "max_items", "missing_field", "unexpected_field", "empty_or_invalid_mapping"]
    private static let recipeSchemaPaths = [
        #"^\$(?:\.recipeEvidence)?(?:\.(?:photoIndex|text|servings|servingsEvidence)|\.componentIndexes(?:\[(?:[0-9]|[1-3][0-9])\])?|\.ingredients(?:\[(?:[0-9]|[1-3][0-9])\](?:\.(?:name|preparation|amount|unit|evidence))?)?)?$"#,
        #"^\$\.components(?:\[(?:[0-9]|[1-3][0-9])\](?:\.(?:name|preparation|amountGrams|evidence|photoIndex)|\.assumptions(?:\[[0-3]\])?)?)?$"#
    ]
    private static func recipeSchemaIssue(_ value: Any?) -> [String: Any]? {
        guard let issue = value as? [String: Any], let path = issue["path"] as? String,
              path.utf8.count <= 128, let reason = issue["reason"] as? String,
              recipeSchemaReasons.contains(reason), recipeSchemaPaths.contains(where: {
                  path.range(of: $0, options: .regularExpression).map { $0 == path.startIndex..<path.endIndex } ?? false
              }) else { return nil }
        var result: [String: Any] = ["path": path, "reason": reason]
        if reason == "control_character", let n = issue["codePoint"] as? NSNumber,
           CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
           n.doubleValue.rounded() == n.doubleValue, (0...31).contains(n.doubleValue) {
            result["codePoint"] = n.intValue
        }
        return result
    }

    static func safeMetadata(_ values: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        func allowed(_ key: String, _ choices: Set<String>) {
            if let value = values[key] as? String, choices.contains(value) { result[key] = value }
        }
        for key in ["attemptId", "requestId"] {
            if let raw = values[key] as? String, let id = UUID(uuidString: raw) { result[key] = id.uuidString }
        }
        for key in ["requestHash", "eventHash"] {
            if let raw = values[key] as? String, raw.range(of: "^[a-f0-9]{24}$", options: .regularExpression) != nil { result[key] = raw }
        }
        if let raw = values["providerRequestId"] as? String,
           raw.range(of: "^req_[a-zA-Z0-9_-]{1,100}$", options: .regularExpression) != nil { result["providerRequestId"] = raw }
        for key in ["model", "reportedModel"] {
            if let raw = values[key] as? String,
               raw.range(of: #"\A(?:gpt-[a-zA-Z0-9.-]{1,60}|o[1-9](?:-[a-zA-Z0-9.-]{1,40})?)\z"#, options: .regularExpression) != nil { result[key] = raw }
        }
        for (key, maximum) in ["streamEventCount":100_000, "streamTerminalCount":100_000, "streamTextDeltaCount":100_000, "streamOutputItemDoneCount":100_000, "completedItemTextCount":100_000, "finalOutputTextCount":100_000, "timingVersion":2, "analyseToResultMs":600_000, "captureToResultMs":600_000, "cropMs":600_000, "cropOriginalBytes":6_000_000, "cropPreparedBytes":6_000_000, "croppedCount":4, "captureMs":600_000, "timedImageCount":4, "ocrMs":600_000, "inferenceMs":600_000, "bridgeMs":600_000, "preparationMs":600_000, "inputTokens":10_000_000, "cachedInputTokens":10_000_000, "cacheWriteTokens":10_000_000, "reasoningTokens":10_000_000, "processingMs":600_000, "outputTokens":10_000_000, "totalTokens":20_000_000, "estimatedCostMicrousd":100_000_000, "status":599, "httpStatus":599, "submittedImageCount":4, "imageCount":4, "captureRevision":1_000_000, "elapsedMs":600_000, "nativeElapsedMs":600_000, "authorizationMs":600_000, "responseHeadersMs":600_000, "downloadMs":600_000, "transcriptionMs":600_000, "observationMs":600_000, "recheckMs":600_000, "queueWaitMs":600_000, "lookupMs":600_000, "networkMs":600_000, "calculationMs":600_000, "batchSize":100, "resolvedCount":100, "missingCount":100, "queueDepth":400, "activeCount":20, "responseBytes":10_000_000, "payloadBytes":20_000_000, "storedBytes":50_000_000, "entryCount":10_000, "imageBytes":20_000_000, "requestTimeoutMs":180_000, "resourceTimeoutMs":180_000, "backendDeadlineMs":180_000, "recipeIngredientCount":40, "recipeMissingAmountCount":40, "componentCount":40, "matchedComponentCount":40, "missingAmountCount":40, "plantCount":200, "knownNutrientCount":8, "missingNutrientCount":8, "partialNutrientCount":8, "zeroNutrientCount":8, "upstreamCallCount":2, "transcriptionCallCount":1, "page":20, "queryLength":120, "queryTokenCount":40, "resultCount":10_000, "recipeCount":10_000, "productCount":10_000, "visibleCount":10_000, "filterCount":8, "filteredCount":10_000, "requirementsExcludedCount":10_000, "retryAfterSeconds":3600] {
            if let n = values[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
               n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue, (0...Double(maximum)).contains(n.doubleValue) { result[key] = n.intValue }
        }
        for key in ["cropTimedOut", "completeNutrition", "visionInvoked", "automaticRecheck", "cached", "stale", "spellingCorrected", "aliasMatched", "alternativeQuery", "savedOnly", "includesVoiceMemo", "durable", "online", "requestSent", "hasCatalogueRating", "ratingAssigned"] {
            if let value = values[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() { result[key] = value.boolValue }
        }
        allowed("route", ["local_text", "chatgpt_photo_analysis", "photo_analysis", "product_score", "product_search", "product_lookup", "contribution_submit", "contribution_status", "contribution_list", "contribution_retry", "contribution_delete"])
        allowed("ratingPath", ["batch", "full_record", "cache", "catalogue"])
        allowed("sourceRoute", ["discovery", "facts_batch", "alternatives", "catalogue_search", "catalogue_batch", "phone_cache", "catalogue_fallback", "off_product"])
        allowed("gateReason", ["local_budget", "provider_pause", "route_outage"])
        allowed("waitReason", ["pacing", "provider_cooldown", "read_budget"])
        allowed("cancelReason", ["query_changed", "screen_left", "task_cancelled"])
        allowed("recipeStatus", ["ready", "needs_servings", "incomplete"])
        allowed("store", ["main", "history", "catalogue", "repertoire", "preferences", "unknown"])
        allowed("operation", ["read", "write", "remove", "import", "restore", "render", "calculate"])
        allowed("errorClass", ["quota", "security", "serialization", "invalid_json", "invalid_shape", "native_write", "unknown"])
        allowed("failureOrigin", ["native_transport", "backend", "provider", "web_storage", "web_runtime"])
        allowed("timeoutSource", ["native_transport", "backend_deadline", "voice_transcription"])
        for key in ["screen", "fromScreen", "toScreen"] { allowed(key, screens) }
        allowed("searchScope", ["all", "recipe", "product"])
        allowed("searchProvider", ["open_food_facts_search", "nudge_catalogue"])
        allowed("captureBasis", ["photo_acquisition", "barcode_decode", "barcode_entry"])
        allowed("cacheState", ["miss", "fresh", "stale"])
        allowed("fallbackCode", ["offline", "timeout", "rateLimited", "providerBusy", "unavailable", "invalidResponse"])
        allowed("billingScope", ["nudge_api", "chatgpt_plan"])
        allowed("usageStatus", ["reported", "partial", "unavailable"])
        allowed("responseFormat", ["sse", "json", "other", "missing"])
        allowed("finalOutputSource", ["response", "output_item", "none"])
        allowed("parseFailure", ["none", "invalid_encoding", "response_too_large", "malformed_event", "event_name_mismatch", "missing_terminal", "terminal_mismatch", "multiple_terminal", "event_after_terminal", "missing_final_output", "multiple_final_output", "empty_output", "output_too_large", "refused", "provider_error", "unexpected_response_format"])
        allowed("providerErrorCode", ["subscription_sharing_usage_limit_exceeded", "rate_limit_exceeded", "subscription_sharing_usage_unavailable", "unsupported_capability", "subscription_sharing_unsupported_capability", "invalid_token", "invalid_grant", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "server_error"])
        allowed("providerOutcome", ["completed", "incomplete", "failed", "received", "unknown", "http_error"])
        allowed("observationSchema", ["compact_photo_v1", "compact_photo_v2", "compact_photo_v3", "photo_v1"])
        allowed("promptVersion", ["photo-instructions-2026-10-20-v1", "photo-estimate-2026-10-20-v2", "photo-estimate-2026-10-20-v3"])
        allowed("priceVersion", ["openai-standard-2026-10-20"])
        allowed("analysisPolicy", ["fast_v1", "legacy"])
        allowed("endpoint", ["/v1/responses"])
        allowed("encoding", ["jpeg_base64"])
        allowed("parseStatus", ["not_started", "validating", "validated"])
        allowed("calculationStatus", ["not_started", "composition_matched", "composition_needs_review", "not_applicable"])
        allowed("recheckReason", ["none", "subject_unknown", "validation_invalid", "composition_unmatched"])
        allowed("recheckOutcome", ["not_needed", "recovered", "no_improvement", "failed", "skipped_deadline", "skipped_legacy", "skipped_fast_policy"])
        allowed("recipeRecheckDetail", ["invalid_output", "recipe_unreadable", "evidence_or_mapping_invalid", "coverage_unchanged", "side_not_preserved", "ingredient_or_quantity_not_preserved", "yield_not_preserved", "result_size", "recovered"])
        allowed("scoreReadiness", ["not_applicable", "available", "estimated_rough", "missing_components", "missing_amounts", "missing_nutrients", "unsupported_profile"])
        allowed("scoreBasis", ["none", "composition", "food_pattern", "model_nutrient_estimate"])
        allowed("voiceStatus", ["not_supplied", "transcribing", "transcribed", "failed"])
        allowed("subjectStatus", ["identified", "uncertain", "unidentified", "type_mismatch"])
        allowed("validationIssue", issues)
        allowed("outcome", outcomes)
        allowed("resultType", ["meal", "product", "unknown"])
        allowed("eventType", ["loading", "result", "error", "capture-status", "cancelled"])
        if let list = values["normalizationIssues"] as? [String] {
            result["normalizationIssues"] = Array(Set(list.filter { issues.contains($0) })).sorted().prefix(12).map { $0 }
        }
        for key in ["recipeValidationIssue", "recipeRecheckValidationIssue"] {
            if let issue = recipeSchemaIssue(values[key]) { result[key] = issue }
        }
        return result
    }

    @discardableResult
    func recordWebEvent(_ body: [String: Any], now: Date = Date()) -> Bool {
        guard body["action"] as? String == "app-diagnostic",
              let stage = body["stage"] as? String, let outcome = body["outcome"] as? String,
              Self.webOutcomes[stage]?.contains(outcome) == true else { return false }
        var metadata = Self.safeMetadata(body["metadata"] as? [String: Any] ?? [:])
        // Hash correlation IDs supplied separately; URLs and user content never
        // enter the file, even if the web caller sends an unexpected object.
        for (key, destination) in [("requestId", "requestHash"), ("eventId", "eventHash")] {
            if let value = body[key] as? String, !value.isEmpty, value.utf8.count <= 128 {
                metadata[destination] = Self.fingerprint(value)
            }
        }
        record(stage: stage, outcome: outcome, metadata: metadata, now: now)
        return true
    }

    enum ExportError: Error { case unreadable }

    /// Revalidate the file on export rather than trusting even our own stored
    /// bytes. A user report must never share arbitrary corrupted local content.
    func exportData(now: Date = Date()) throws -> Data {
        // A requested export includes every event already accepted by record().
        // Ordinary taps never wait for this queue or for filesystem IO.
        if deferredWrites { writerQueue.sync {} }
        lock.lock(); defer { lock.unlock() }
        var events: [[String: Any]] = []
        if FileManager.default.fileExists(atPath: fileURL.path) {
            let size = try fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= Self.maximumBytes,
                  let document = try JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any],
                  document["version"] as? Int == 1, let saved = document["events"] as? [[String: Any]], saved.count <= Self.maximumEvents else { throw ExportError.unreadable }
            events = saved.compactMap { event in
                guard let stamp = event["time"] as? NSNumber, CFGetTypeID(stamp) != CFBooleanGetTypeID(), stamp.doubleValue.isFinite,
                      stamp.doubleValue <= now.timeIntervalSince1970, stamp.doubleValue > now.timeIntervalSince1970 - Self.retention,
                      let stage = event["stage"] as? String, Self.stages.contains(stage),
                      let outcome = event["outcome"] as? String, Self.outcomes.contains(outcome) else { return nil }
                return ["time":stamp.doubleValue, "stage":stage, "outcome":outcome,
                        "metadata":Self.safeMetadata(event["metadata"] as? [String: Any] ?? [:])]
            }
        }
        let data = try JSONSerialization.data(withJSONObject: ["version":1, "diagnosticVersion":"nudge-diagnostics-2026-10-05-app-v2",
            "appVersion":Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "unknown",
            "build":Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "unknown", "events":events], options:[.sortedKeys])
        guard data.count <= Self.maximumBytes else { throw ExportError.unreadable }
        return data
    }

    @MainActor
    static func presentShareSheet(from presenter: UIViewController) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("NudgeSupport-" + UUID().uuidString, isDirectory:true)
        do {
            let data = try shared.exportData()
            try FileManager.default.createDirectory(at:folder, withIntermediateDirectories:true, attributes:[.posixPermissions:0o700])
            let file = folder.appendingPathComponent("Nudge-diagnostics.json")
            try data.write(to:file, options:[.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions:0o600], ofItemAtPath:file.path)
            let sheet = UIActivityViewController(activityItems:[file], applicationActivities:nil)
            sheet.completionWithItemsHandler = { _,_,_,_ in try? FileManager.default.removeItem(at:folder) }
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x:presenter.view.bounds.midX,y:presenter.view.bounds.maxY - 1,width:1,height:1)
            }
            presenter.present(sheet, animated:true)
        } catch {
            try? FileManager.default.removeItem(at:folder)
            let alert = UIAlertController(title:"Diagnostic report unavailable", message:"Nudge could not prepare the diagnostic report. Please try again.", preferredStyle:.alert)
            alert.addAction(UIAlertAction(title:"OK",style:.default))
            presenter.present(alert,animated:true)
        }
    }

    func record(stage: String, outcome: String, metadata: [String: Any] = [:], now: Date = Date()) {
        guard Self.stages.contains(stage), Self.outcomes.contains(outcome) else { return }
        // Sanitize before anything is retained or handed to the writer. The
        // bounded queue is disposable support data, never a diary transaction.
        let event = Event(stage: stage, outcome: outcome, metadata: Self.safeMetadata(metadata), time: now)
        guard deferredWrites else { persist([event]); return }
        pendingLock.lock()
        pending.append(event)
        if pending.count > Self.maximumEvents { pending.removeFirst(pending.count - Self.maximumEvents) }
        if !writerScheduled {
            writerScheduled = true
            writerQueue.async { [self] in
                pendingLock.lock()
                let batch = pending
                pending.removeAll(keepingCapacity: true)
                writerScheduled = false
                pendingLock.unlock()
                persist(batch)
            }
        }
        pendingLock.unlock()
    }

    private func persist(_ batch: [Event]) {
        guard let now = batch.map(\.time).max() else { return }
        lock.lock(); defer { lock.unlock() }
        do {
            let fm = FileManager.default
            var directory = fileURL.deletingLastPathComponent()
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
            try directory.setResourceValues(attributes)
            var events: [[String: Any]] = []
            let size = (try? fm.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.intValue ?? 0
            if size > 0, size <= Self.maximumBytes,
               let data = try? Data(contentsOf: fileURL),
               let document = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let saved = document["events"] as? [[String: Any]] {
                events = saved.compactMap { event in
                    guard let time = event["time"] as? Double, time <= now.timeIntervalSince1970,
                          time > now.timeIntervalSince1970 - Self.retention,
                          let stage = event["stage"] as? String, Self.stages.contains(stage),
                          let outcome = event["outcome"] as? String, Self.outcomes.contains(outcome) else { return nil }
                    return ["time":time, "stage":stage, "outcome":outcome, "metadata":Self.safeMetadata(event["metadata"] as? [String: Any] ?? [:])]
                }
            }
            events.append(contentsOf: batch.filter { $0.time <= now && $0.time.timeIntervalSince1970 > now.timeIntervalSince1970 - Self.retention }
                .map { ["time":$0.time.timeIntervalSince1970, "stage":$0.stage, "outcome":$0.outcome, "metadata":$0.metadata] })
            events = Array(events.suffix(Self.maximumEvents))
            var data: Data
            repeat {
                data = try JSONSerialization.data(withJSONObject: ["version":1, "diagnosticVersion":"nudge-diagnostics-2026-10-05-app-v2", "appVersion":Bundle.main.object(forInfoDictionaryKey:"CFBundleShortVersionString") as? String ?? "unknown", "build":Bundle.main.object(forInfoDictionaryKey:"CFBundleVersion") as? String ?? "unknown", "events":events], options: [.sortedKeys])
                if data.count > Self.maximumBytes { events.removeFirst() }
            } while data.count > Self.maximumBytes && !events.isEmpty
            try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
            try fm.setAttributes([.posixPermissions:0o600], ofItemAtPath:fileURL.path)
        } catch {
            // A full disk or locked device must never break food capture/saving.
        }
    }
}
