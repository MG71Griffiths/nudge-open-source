import Foundation

/// A durable choice of account registration and model. Safe to put in a capture
/// manifest: credentials remain in the connection's private Keychain vault.
struct ChatGPTCaptureBinding: Codable, Equatable, Sendable {
    let profileID: String
    let subject: String
    let connectionID: UUID
    let modelID: String

    var isValid: Bool {
        func valid(_ value: String, maximum: Int) -> Bool {
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= maximum &&
                value.rangeOfCharacter(from: .controlCharacters) == nil
        }
        return valid(profileID, maximum: 512) && valid(subject, maximum: 512) && valid(modelID, maximum: 200)
    }
}

/// Optional request tuning for a verified model. Unknown models keep their
/// existing request contract rather than inheriting unsupported capabilities.
enum ChatGPTCapturePolicy {
    static func reasoning(modelID: String) -> [String: String]? {
        modelID == "gpt-6-astra" ? ["effort": "low"] : nil
    }

    /// Fixed diagnostic families only; never copy prompt text or caller labels.
    static func diagnostics(request: [String: Any]) -> [String: String] {
        let text = request["text"] as? [String: Any]
        let format = text?["format"] as? [String: Any]
        let schema = format?["schema"] as? [String: Any]
        let properties = schema?["properties"] as? [String: Any]
        let version = properties?["version"] as? [String: Any]
        let values = version?["enum"] as? [Any]
        let value = values?.count == 1 ? values?.first as? NSNumber : nil
        let number = value.flatMap { CFGetTypeID($0) == CFBooleanGetTypeID() ? nil : $0.doubleValue }
        return ["promptVersion": number == 3 ? "photo-estimate-2026-10-20-v3" : number == 2 ? "photo-estimate-2026-10-20-v2" : "photo-instructions-2026-10-20-v1",
                "observationSchema": number == 3 ? "compact_photo_v3" : number == 2 ? "compact_photo_v2" : number == 1 ? "compact_photo_v1" : "photo_v1"]
    }
}

/// The UI receives account identity and connection state, never OAuth tokens.
struct ChatGPTAccount: Identifiable, Equatable {
    let id: String
    let label: String
    let connected: Bool
}
