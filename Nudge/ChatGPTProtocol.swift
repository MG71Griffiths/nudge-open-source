import Foundation
import CryptoKit
import Security
import CoreFoundation

/// The public-client contract is deliberately independent of Nudge's account,
/// backend, diary and scoring engine. Never log these objects or request URLs.
enum ChatGPTFailure: LocalizedError, Equatable {
    case invalidSignIn, cancelled, consent, storage, unavailable, expired, limit, incomplete, invalidPhoto
    case transient, unsupported, refused, bindingChanged
    var errorDescription: String? {
        switch self {
        case .invalidSignIn: return "ChatGPT sign-in could not be verified. Please start again."
        case .cancelled: return "ChatGPT sign-in was cancelled."
        case .consent: return "ChatGPT plan usage was not authorised. Continue with ChatGPT to grant access."
        case .storage: return "The ChatGPT connection could not be saved securely. Please try again."
        case .unavailable: return "ChatGPT could not complete this request. Check your connection and plan eligibility, then try again."
        case .expired: return "Reconnect this ChatGPT account to continue."
        case .limit: return "Your ChatGPT plan or Nudge usage limit was reached. Open Manage usage to review it."
        case .incomplete: return "ChatGPT did not finish the analysis. No result was saved. Please try again."
        case .invalidPhoto: return "Choose a food photo that Nudge can open."
        case .transient: return "ChatGPT is temporarily unavailable. Your connection has been kept. Please try again later."
        case .unsupported: return "This ChatGPT model could not accept this photo request. Choose a supported model and retry explicitly."
        case .refused: return "ChatGPT could not provide this analysis. No result was saved."
        case .bindingChanged: return "The ChatGPT connection selected for this scan has changed. Choose an account and retry this scan."
        }
    }
}

struct ChatGPTAttempt {
    static let issuer = "https://auth.openai.com"
    static let resource = "https://api.openai.com/v1"
    static let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    let state: String
    let nonce: String
    let verifier: String
    let redirect: URL
    let clientID: String?
    let created: Date

    init(port: UInt16, clientID: String? = nil, now: Date = Date()) throws {
        state = try Self.random(); nonce = try Self.random(); verifier = try Self.random()
        redirect = URL(string: "http://127.0.0.1:\(port)/auth/callback")!
        self.clientID = clientID; created = now
    }
    static func random() throws -> String {
        var data = Data(count: 32)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw ChatGPTFailure.invalidSignIn }
        return data.base64URL
    }
    var challenge: String { Data(SHA256.hash(data: Data(verifier.utf8))).base64URL }
    func authorizationURL(hostID: String, idToken: String? = nil) -> URL {
        var values = ["client_id": clientID ?? "dynamic_agent_client", "ext_agent_host_id": hostID,
                      "response_type": "code", "redirect_uri": redirect.absoluteString,
                      "scope": Self.scopes, "resource": Self.resource, "state": state,
                      "nonce": nonce, "code_challenge_method": "S256", "code_challenge": challenge]
        if clientID == nil { values["agent_name_hint"] = "Nudge" }
        else if let idToken { values["id_token_hint"] = idToken }
        var url = URLComponents(string: Self.issuer + "/api/accounts/authorize")!
        url.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return url.url!
    }
    func callback(_ url: URL, now: Date = Date()) throws -> (code: String, client: String) {
        guard now.timeIntervalSince(created) >= 0, now.timeIntervalSince(created) < 600,
              url.scheme == redirect.scheme, url.host == redirect.host, url.port == redirect.port,
              url.path == redirect.path, url.user == nil, url.password == nil, url.fragment == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            throw ChatGPTFailure.invalidSignIn
        }
        let keys = items.map(\.name)
        guard Set(keys).count == keys.count else { throw ChatGPTFailure.invalidSignIn }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard values["state"] == state else { throw ChatGPTFailure.invalidSignIn }
        if values["error"] != nil { throw ChatGPTFailure.consent }
        let issued = values["client_id"] ?? clientID ?? ""
        guard !issued.isEmpty, issued != "dynamic_agent_client", issued.count <= 512,
              clientID == nil || clientID == issued,
              let code = values["code"], !code.isEmpty, code.count <= 8192 else { throw ChatGPTFailure.invalidSignIn }
        return (code, issued)
    }
}

extension Data {
    fileprivate var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    fileprivate init?(base64URL: String) {
        let text = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        self.init(base64Encoded: text + String(repeating: "=", count: (4 - text.count % 4) % 4))
    }
}

struct ChatGPTIdentity: Equatable {
    let subject: String
    let email: String?
    /// RS256 is the algorithm advertised by production OIDC discovery. Fail closed
    /// on other algorithms; never trust a token's embedded key or remote key URL.
    static func verify(_ token: String, jwks: [String: Any], clientID: String, nonce: String?, now: Date = Date()) throws -> ChatGPTIdentity {
        let pieces = token.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard pieces.count == 3, token.utf8.count < 64_000,
              let headerData = Data(base64URL: pieces[0]), let payload = Data(base64URL: pieces[1]),
              let signature = Data(base64URL: pieces[2]),
              let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              header["alg"] as? String == "RS256", header["crit"] == nil,
              let kid = header["kid"] as? String,
              let allKeys = jwks["keys"] as? [[String: Any]] else { throw ChatGPTFailure.invalidSignIn }
        let keys = allKeys.filter { $0["kid"] as? String == kid && $0["kty"] as? String == "RSA" }
        guard keys.count == 1, let key = keys.first,
              key["use"] == nil || key["use"] as? String == "sig",
              key["alg"] == nil || key["alg"] as? String == "RS256",
              let modulus = (key["n"] as? String).flatMap(Data.init(base64URL:)), modulus.count >= 256,
              let exponent = (key["e"] as? String).flatMap(Data.init(base64URL:)), !exponent.isEmpty else { throw ChatGPTFailure.invalidSignIn }
        let der = sequence(integer(modulus) + integer(exponent))
        let attrs: [CFString: Any] = [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic]
        guard let publicKey = SecKeyCreateWithData(der as CFData, attrs as CFDictionary, nil),
              SecKeyVerifySignature(publicKey, .rsaSignatureMessagePKCS1v15SHA256,
                                    Data((pieces[0] + "." + pieces[1]).utf8) as CFData, signature as CFData, nil),
              let claims = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { throw ChatGPTFailure.invalidSignIn }
        let audiences = (claims["aud"] as? [String]) ?? (claims["aud"] as? String).map { [$0] } ?? []
        let notBefore = claims["nbf"].flatMap(numericDate)
        guard claims["iss"] as? String == ChatGPTAttempt.issuer, audiences.contains(clientID),
              audiences.count == 1 || claims["azp"] as? String == clientID,
              claims["azp"] == nil || claims["azp"] as? String == clientID,
              let expires = claims["exp"].flatMap(numericDate), expires > now.timeIntervalSince1970,
              let issued = claims["iat"].flatMap(numericDate), issued <= now.timeIntervalSince1970 + 5,
              claims["nbf"] == nil || notBefore != nil,
              (notBefore ?? 0) <= now.timeIntervalSince1970 + 5,
              let subject = claims["sub"] as? String, !subject.isEmpty,
              nonce == nil || claims["nonce"] as? String == nonce else { throw ChatGPTFailure.invalidSignIn }
        return ChatGPTIdentity(subject: subject, email: claims["email"] as? String)
    }
    private static func numericDate(_ value: Any) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }
    private static func length(_ n: Int) -> Data {
        if n < 128 { return Data([UInt8(n)]) }
        var n = n, bytes: [UInt8] = []
        while n > 0 { bytes.insert(UInt8(n & 255), at: 0); n >>= 8 }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }
    private static func integer(_ input: Data) -> Data {
        var bytes = Data(input.drop(while: { $0 == 0 }))
        if bytes.first.map({ $0 & 0x80 != 0 }) ?? true { bytes.insert(0, at: 0) }
        return Data([0x02]) + length(bytes.count) + bytes
    }
    private static func sequence(_ input: Data) -> Data { Data([0x30]) + length(input.count) + input }
}

struct ChatGPTProfile: Codable, Identifiable {
    var id: String { clientID }
    let clientID: String
    let subject: String
    var email: String?
    var accessToken: String?
    var refreshToken: String?
    var idToken: String?
    var expiresAt: Date
    var scopes: [String]
    var welcomed = false
    // Optional for decoding existing Keychain data; migration assigns and saves
    // an epoch once. Refresh preserves it; interactive reconnection replaces it.
    var connectionID: UUID?
    var connected: Bool { accessToken != nil && scopes.contains("chatgpt.tokens.use.direct") && scopes.contains("resource.invoke") }
    var label: String { (email ?? "ChatGPT account") + " · " + String(clientID.suffix(6)) }
}

struct ChatGPTVault: Codable {
    var hostID = "urn:uuid:" + UUID().uuidString.lowercased()
    var profiles: [ChatGPTProfile] = []
    var selectedID: String?
    var cameraSelection: ChatGPTCaptureBinding?
}

enum ChatGPTKeychain {
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "org.example.nudge.chatgpt", kSecAttrAccount as String: "connections-v1"] }
    static func load() throws -> ChatGPTVault {
        var query = query; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return ChatGPTVault() }
        guard status == errSecSuccess, let data = value as? Data,
              let vault = try? JSONDecoder().decode(ChatGPTVault.self, from: data) else { throw ChatGPTFailure.storage }
        return vault
    }
    static func save(_ vault: ChatGPTVault) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(vault),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; attributes.forEach { item[$0.key] = $0.value }; item[kSecAttrSynchronizable as String] = false
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw ChatGPTFailure.storage }
    }
}

struct ChatGPTStreamResult {
    private struct Event {
        let type: String?
        let item: [String: Any]
        let issue: String?
    }
    private struct Evaluation {
        var metadata: [String: Any]
        var text: String?
        var failure: ChatGPTFailure?
    }
    private static let terminals: Set<String> = ["response.completed", "response.incomplete", "response.failed"]
    private static let diagnosticErrorCodes: Set<String> = [
        "subscription_sharing_usage_limit_exceeded", "rate_limit_exceeded", "subscription_sharing_usage_unavailable",
        "subscription_sharing_unsupported_capability", "unsupported_capability", "invalid_token", "invalid_grant",
        "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused", "server_error"
    ]
    private static func safeErrorCode(_ item: [String: Any]) -> String? {
        let response = item["response"] as? [String: Any] ?? item
        let error = response["error"] as? [String: Any] ?? item
        guard let code = error["code"] as? String, diagnosticErrorCodes.contains(code) else { return nil }
        return code
    }
    /// SSE permits LF, CRLF and CR, an initial UTF-8 BOM, and a named event.
    /// Keep framing identical for output, usage and diagnostics. A conflicting
    /// JSON type and event name is ambiguous and must never admit output.
    private static func events(from data: Data) -> (events: [Event], issue: String?) {
        guard data.count <= 2_000_000 else { return ([], "response_too_large") }
        guard var source = String(data: data, encoding: .utf8) else { return ([], "invalid_encoding") }
        if source.first == "\u{feff}" { source.removeFirst() }
        source = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        var result: [Event] = []
        for frame in source.components(separatedBy: "\n\n") {
            var name: String?, lines: [String] = []
            for line in frame.components(separatedBy: "\n") {
                if line.isEmpty || line.hasPrefix(":") { continue }
                let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                let field = String(parts[0])
                var value = parts.count == 2 ? String(parts[1]) : ""
                if value.first == " " { value.removeFirst() }
                if field == "data" { lines.append(value) }
                if field == "event" { name = value.isEmpty ? nil : value }
            }
            let value = lines.joined(separator: "\n")
            if value.isEmpty || value == "[DONE]" { continue }
            guard let bytes = value.data(using: .utf8),
                  let item = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                result.append(Event(type: nil, item: [:], issue: "malformed_event")); continue
            }
            let type = item["type"] as? String
            if let name, let type, name != type {
                result.append(Event(type: nil, item: [:], issue: "event_name_mismatch")); continue
            }
            // An explicitly malformed type cannot be rescued by an event name.
            guard item["type"] == nil || (type != nil && type != ""),
                  let resolved = type ?? name, !resolved.isEmpty else {
                result.append(Event(type: nil, item: [:], issue: "malformed_event")); continue
            }
            result.append(Event(type: resolved, item: item, issue: nil))
        }
        return (result, nil)
    }

    static func responseFormat(_ contentType: String?) -> String {
        guard let contentType, !contentType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "missing" }
        let mediaType = contentType.split(separator: ";", maxSplits: 1).first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if mediaType == "text/event-stream" { return "sse" }
        if mediaType == "application/json" || mediaType.hasSuffix("+json") { return "json" }
        return "other"
    }

    /// Only fixed enums and bounded counts leave the parser. This is separate
    /// from text acceptance so rejected responses still explain their failure.
    static func diagnostics(from data: Data, contentType: String?, requireFinalOutput: Bool = true,
                            maximumCharacters: Int = 160_000) -> [String: Any] {
        let format = responseFormat(contentType)
        // A missing header is not evidence that the body completed. Inspect it
        // with the same strict SSE evaluator and retain the absent-header fact.
        if format == "sse" || format == "missing" {
            var metadata = evaluate(data, requireFinalOutput: requireFinalOutput, maximumCharacters: maximumCharacters).metadata
            metadata["responseFormat"] = format
            return metadata
        }
        var metadata: [String: Any] = ["responseFormat": format, "responseBytes": min(data.count, 2_000_000),
            "parseFailure": "unexpected_response_format", "streamEventCount": 0, "streamTerminalCount": 0,
            "streamTextDeltaCount": 0, "finalOutputTextCount": 0, "streamOutputItemDoneCount": 0,
            "completedItemTextCount": 0, "finalOutputSource": "none"]
        if data.count <= 2_000_000, format == "json",
           let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let code = safeErrorCode(item) {
            metadata["providerErrorCode"] = code
        }
        return metadata
    }

    /// Usage belongs to a terminal provider response, even if its food output
    /// cannot be accepted. Never interpret this metadata as successful analysis.
    /// Text, account fields and provider payloads stay out; absent is not zero.
    static func usage(from data: Data) -> [String: Any] {
        let unavailable: [String: Any] = ["billingScope": "chatgpt_plan", "usageStatus": "unavailable"]
        let decoded = events(from: data)
        guard decoded.issue == nil else { return unavailable }
        var terminal: [String: Any]?
        for event in decoded.events {
            guard event.issue == nil, let type = event.type, terminals.contains(type) else { continue }
            let item = event.item
            // Multiple terminals are ambiguous: do not double-count or select
            // a convenient usage record from an invalid stream.
            guard terminal == nil, let response = item["response"] as? [String: Any],
                  let outcome = response["status"] as? String, type == "response." + outcome else { return unavailable }
            var result = unavailable
            result["providerOutcome"] = outcome
            if let model = response["model"] as? String, isDiagnosticModel(model) { result["reportedModel"] = model }
            guard let usage = response["usage"] as? [String: Any] else { terminal = result; continue }
            func count(_ raw: Any?, maximum: Int = 10_000_000) -> Int? {
                guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
                      (0...Double(maximum)).contains(number.doubleValue) else { return nil }
                return number.intValue
            }
            for (key, destination) in [("input_tokens", "inputTokens"), ("output_tokens", "outputTokens"), ("total_tokens", "totalTokens")] {
                if let value = count(usage[key], maximum: key == "total_tokens" ? 20_000_000 : 10_000_000) { result[destination] = value }
            }
            for (details, key, destination) in [("input_tokens_details", "cached_tokens", "cachedInputTokens"),
                                               ("input_tokens_details", "cache_write_tokens", "cacheWriteTokens"),
                                               ("output_tokens_details", "reasoning_tokens", "reasoningTokens")] {
                if let values = usage[details] as? [String: Any], let value = count(values[key]) { result[destination] = value }
            }
            if let input = result["inputTokens"] as? Int, let output = result["outputTokens"] as? Int,
               let total = result["totalTokens"] as? Int, input + output != total {
                return result.filter { ["billingScope", "usageStatus", "providerOutcome", "reportedModel"].contains($0.key) }
            }
            if let input = result["inputTokens"] as? Int,
               (result["cachedInputTokens"] as? Int ?? 0) + (result["cacheWriteTokens"] as? Int ?? 0) > input {
                result.removeValue(forKey: "cachedInputTokens"); result.removeValue(forKey: "cacheWriteTokens")
            }
            if let reasoning = result["reasoningTokens"] as? Int, let output = result["outputTokens"] as? Int, reasoning > output {
                result.removeValue(forKey: "reasoningTokens")
            }
            let fields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"]
            result["usageStatus"] = fields.allSatisfy { result[$0] != nil } ? "reported" : fields.contains { result[$0] != nil } ? "partial" : "unavailable"
            terminal = result
        }
        return terminal ?? unavailable
    }
    static func isDiagnosticModel(_ value: String) -> Bool {
        value.range(of: #"\A(?:gpt-[a-zA-Z0-9.-]{1,60}|o[1-9](?:-[a-zA-Z0-9.-]{1,40})?)\z"#, options: .regularExpression) != nil
    }
    /// We buffer a bounded SSE response and display only a completed result. An
    /// HTTP 200 or a text delta never establishes that the request succeeded.
    /// Preview also needs finalized text; requireFinalOutput further limits
    /// capture to one text block. Neither mode promotes provisional deltas.
    static func text(from data: Data, requireFinalOutput: Bool = false, maximumCharacters: Int = 30_000) throws -> String {
        let result = evaluate(data, requireFinalOutput: requireFinalOutput, maximumCharacters: maximumCharacters)
        if let failure = result.failure { throw failure }
        guard let text = result.text else { throw ChatGPTFailure.incomplete }
        return text
    }
    private static func evaluate(_ data: Data, requireFinalOutput: Bool, maximumCharacters: Int) -> Evaluation {
        let decoded = events(from: data)
        var result = Evaluation(metadata: ["responseBytes": min(data.count, 2_000_000), "parseFailure": "none",
            "streamEventCount": min(decoded.events.count, 100_000), "streamTerminalCount": 0,
            "streamTextDeltaCount": 0, "finalOutputTextCount": 0, "streamOutputItemDoneCount": 0,
            "completedItemTextCount": 0, "finalOutputSource": "none"])
        func reject(_ reason: String, failure: ChatGPTFailure = .incomplete) {
            guard result.failure == nil else { return }
            result.failure = failure; result.metadata["parseFailure"] = reason
        }
        if let issue = decoded.issue { reject(issue); return result }
        var complete = false, finalOutput: String?
        var terminalCount = 0, deltaCount = 0, finalTextCount = 0
        var itemDoneCount = 0, itemTextCount = 0, finalSource = "none"
        var completedItems: [(id: String, index: Int, text: String)] = []
        var completedItemIssue: String?
        func outputIndex(_ raw: Any?) -> Int? {
            guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
                  (0...100_000).contains(number.doubleValue) else { return nil }
            return number.intValue
        }
        for event in decoded.events {
            if let issue = event.issue { reject(issue); continue }
            guard let type = event.type else { reject("malformed_event"); continue }
            let item = event.item
            if terminals.contains(type) { terminalCount += 1 }
            if type == "response.output_text.delta" { deltaCount += 1 }
            if type == "response.output_item.done" {
                itemDoneCount += 1
                if let message = item["item"] as? [String: Any], message["type"] as? String == "message",
                   message["role"] as? String == "assistant", message["status"] as? String == "completed" {
                    itemTextCount += (message["content"] as? [[String: Any]] ?? [])
                        .filter { $0["type"] as? String == "output_text" && $0["text"] is String }.count
                }
            }
            if type == "response.completed", let response = item["response"] as? [String: Any] {
                let messages = response["output"] as? [[String: Any]] ?? []
                finalTextCount += messages.flatMap { $0["content"] as? [[String: Any]] ?? [] }
                    .filter { $0["type"] as? String == "output_text" && $0["text"] is String }.count
            }
            // Counts describe the entire received stream, while the first
            // rejection remains the one that prevents accepting its output.
            guard result.failure == nil else { continue }
            if type == "response.failed" || type == "error" || type == "response.incomplete" {
                let response = item["response"] as? [String: Any] ?? item
                let error = response["error"] as? [String: Any] ?? item
                if let code = safeErrorCode(item) { result.metadata["providerErrorCode"] = code }
                reject("provider_error", failure: failure(code: error["code"] as? String)); continue
            }
            if type == "response.refusal.delta" || type == "response.refusal.done" { reject("refused", failure: .refused); continue }
            guard !complete else { reject(type == "response.completed" ? "multiple_terminal" : "event_after_terminal"); continue }
            if type == "response.content_part.done", let part = item["part"] as? [String: Any],
               part["type"] as? String == "refusal" { reject("refused", failure: .refused); continue }
            if type == "response.output_item.done" {
                guard let message = item["item"] as? [String: Any] else { completedItemIssue = "terminal_mismatch"; continue }
                let content = message["content"] as? [[String: Any]] ?? []
                guard !content.contains(where: { $0["type"] as? String == "refusal" }) else { reject("refused", failure: .refused); continue }
                // Reasoning is not assistant food output. Other item types cannot
                // establish the single completed message required by capture.
                if message["type"] as? String == "reasoning" { continue }
                guard message["type"] as? String == "message", message["role"] as? String == "assistant",
                      message["status"] as? String == "completed",
                      let id = message["id"] as? String, !id.isEmpty, id.count <= 512,
                      id == id.trimmingCharacters(in: .whitespacesAndNewlines),
                      let index = outputIndex(item["output_index"]) else { completedItemIssue = "terminal_mismatch"; continue }
                let texts = content.filter { $0["type"] as? String == "output_text" }.compactMap { $0["text"] as? String }
                guard content.count == 1, texts.count == 1 else {
                    completedItemIssue = texts.count > 1 ? "multiple_final_output" : "missing_final_output"; continue
                }
                // Never select a convenient last item or concatenate repeated
                // messages. IDs and indexes identify one completed item only.
                guard completedItems.isEmpty else { completedItemIssue = "multiple_final_output"; continue }
                completedItems.append((id, index, texts[0]))
            }
            if type == "response.completed" {
                guard let response = item["response"] as? [String: Any], response["status"] as? String == "completed",
                      response["error"] == nil || response["error"] is NSNull,
                      response["incomplete_details"] == nil || response["incomplete_details"] is NSNull else { reject("terminal_mismatch"); continue }
                complete = true
                guard response["output"] == nil || response["output"] is [[String: Any]] else { reject("terminal_mismatch"); continue }
                let messages = response["output"] as? [[String: Any]] ?? []
                let content = messages.flatMap { $0["content"] as? [[String: Any]] ?? [] }
                guard !content.contains(where: { $0["type"] as? String == "refusal" }) else { reject("refused", failure: .refused); continue }
                let messageItems = messages.filter { $0["type"] as? String == "message" || $0["content"] != nil }
                guard messageItems.allSatisfy({ message in
                    (message["role"] == nil || message["role"] as? String == "assistant") &&
                    (message["status"] == nil || message["status"] as? String == "completed")
                }) else { reject("terminal_mismatch"); continue }
                if let issue = completedItemIssue { reject(issue); continue }
                let texts = content.filter { $0["type"] as? String == "output_text" }.compactMap { $0["text"] as? String }
                if messages.isEmpty, let completedItem = completedItems.first {
                    finalOutput = completedItem.text; finalSource = "output_item"
                    continue
                }
                if requireFinalOutput && texts.count != 1 {
                    reject(texts.isEmpty ? "missing_final_output" : "multiple_final_output"); continue
                }
                if let completedItem = completedItems.first {
                    guard messageItems.count == 1 else { reject("multiple_final_output"); continue }
                    guard texts.count == 1, texts[0] == completedItem.text,
                          messages.indices.contains(completedItem.index) else { reject("terminal_mismatch"); continue }
                    let message = messages[completedItem.index]
                    guard message["id"] == nil || message["id"] as? String == completedItem.id,
                          let parts = message["content"] as? [[String: Any]], parts.count == 1,
                          parts[0]["type"] as? String == "output_text", parts[0]["text"] as? String == completedItem.text else { reject("terminal_mismatch"); continue }
                }
                if !texts.isEmpty { finalOutput = texts.joined(separator: "\n"); finalSource = "response" }
            }
        }
        result.metadata["streamTerminalCount"] = min(terminalCount, 100_000)
        result.metadata["streamTextDeltaCount"] = min(deltaCount, 100_000)
        result.metadata["finalOutputTextCount"] = min(finalTextCount, 100_000)
        result.metadata["streamOutputItemDoneCount"] = min(itemDoneCount, 100_000)
        result.metadata["completedItemTextCount"] = min(itemTextCount, 100_000)
        guard result.failure == nil else { return result }
        let text = (finalOutput ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !complete { reject("missing_terminal") }
        else if finalOutput == nil { reject("missing_final_output") }
        else if text.isEmpty { reject("empty_output") }
        else if text.count > maximumCharacters { reject("output_too_large") }
        else { result.text = text; result.metadata["finalOutputSource"] = finalSource }
        return result
    }
    static func failure(code: String?) -> ChatGPTFailure {
        if ["subscription_sharing_usage_limit_exceeded", "rate_limit_exceeded"].contains(code) { return .limit }
        if code == "subscription_sharing_usage_unavailable" { return .transient }
        if ["unsupported_capability", "subscription_sharing_unsupported_capability"].contains(code) { return .unsupported }
        if ["invalid_token", "invalid_grant", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].contains(code) { return .expired }
        return .incomplete
    }
}
