import Foundation

// Runs against the production filter/exporter with synthetic content only.
@main struct StreamDiagnosticsCheck {
    static func main() throws {
        var passed = 0
        func check(_ value: Bool, _ name: String) {
            guard value else { print("FAIL \(name)"); exit(1) }
            passed += 1
        }
        let safe: [String: Any] = ["responseFormat": "sse", "parseFailure": "missing_terminal",
            "streamEventCount": 120, "streamTerminalCount": 0, "streamTextDeltaCount": 90,
            "finalOutputTextCount": 0, "streamOutputItemDoneCount": 2, "completedItemTextCount": 1,
            "finalOutputSource": "output_item", "responseBytes": 6000, "authorizationMs": 200,
            "responseHeadersMs": 500, "downloadMs": 36000, "networkMs": 36500, "nativeElapsedMs": 36700]
        check(NSDictionary(dictionary: AnalysisDiagnostics.safeMetadata(safe)).isEqual(to: safe), "fixed stream metadata")
        for key in ["streamEventCount", "streamTerminalCount", "streamTextDeltaCount", "streamOutputItemDoneCount", "completedItemTextCount", "finalOutputTextCount"] {
            for invalid: Any in [-1, true, 0.5, 100001, Double.infinity, "private text"] {
                check(AnalysisDiagnostics.safeMetadata([key: invalid]).isEmpty, "bounded stream counts")
            }
        }
        for key in ["responseFormat", "parseFailure", "finalOutputSource", "providerErrorCode"] {
            for invalid: Any in ["private food", "server_error\n", ["message": "private token"], 1] {
                check(AnalysisDiagnostics.safeMetadata([key: invalid]).isEmpty, "fixed enums")
            }
        }
        for code in ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable", "subscription_sharing_unsupported_capability", "server_error"] {
            check(AnalysisDiagnostics.safeMetadata(["providerErrorCode":code])["providerErrorCode"] as? String == code, "safe provider error")
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let diagnostics = AnalysisDiagnostics(directory: directory)
        var attempted = safe
        attempted["message"] = "private food"; attempted["body"] = "private response"
        attempted["headers"] = ["Authorization": "private token"]
        diagnostics.record(stage: "capture_performance", outcome: "usage_received", metadata: attempted)
        let exported = try diagnostics.exportData()
        let document = try JSONSerialization.jsonObject(with: exported) as! [String: Any]
        let metadata = (document["events"] as! [[String: Any]]).last!["metadata"] as! [String: Any]
        check(NSDictionary(dictionary: metadata).isEqual(to: safe), "persisted export")
        check(!String(decoding: exported, as: UTF8.self).contains("private"), "no provider or credential content")
        print("\(passed) stream diagnostic checks passed")
    }
}
