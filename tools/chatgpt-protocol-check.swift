import Foundation
import Security
import CryptoKit

// Standalone macOS harness. Only ephemeral keys and synthetic credentials;
// no network, Keychain API calls, app container reads, or real account tokens.
@main
struct ChatGPTProtocolSecurityCheck {
    static var passed = 0
    static var failed = 0
        static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let client = "test-nudge-client"
    static let nonce = "test-nonce"

    static func check(_ name: String, _ condition: Bool) {
        if condition { passed += 1; print("PASS \(name)") }
        else { failed += 1; print("FAIL \(name)") }
    }
    static func rejects(_ name: String, as expected: ChatGPTFailure, _ action: () throws -> Void) {
        do { try action(); failed += 1; print("FAIL \(name): accepted") }
        catch let error as ChatGPTFailure { check(name, error == expected) }
        catch { failed += 1; print("FAIL \(name): wrong error type") }
    }
    static func b64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
    static func length(_ bytes: [UInt8], _ cursor: inout Int) throws -> Int {
        guard cursor < bytes.count else { throw ChatGPTFailure.invalidSignIn }
        let value = Int(bytes[cursor]); cursor += 1
        if value < 128 { return value }
        let count = value & 127
        guard count > 0, count <= 4, cursor + count <= bytes.count else { throw ChatGPTFailure.invalidSignIn }
        var result = 0
        for _ in 0..<count { result = (result << 8) | Int(bytes[cursor]); cursor += 1 }
        return result
    }
    static func publicJWK(_ key: SecKey) throws -> [String: Any] {
        guard let publicKey = SecKeyCopyPublicKey(key),
              let encoded = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else {
            throw ChatGPTFailure.invalidSignIn
        }
        let bytes = [UInt8](encoded); var cursor = 0
        guard bytes[cursor] == 0x30 else { throw ChatGPTFailure.invalidSignIn }; cursor += 1
        let size = try length(bytes, &cursor)
        guard cursor + size == bytes.count else { throw ChatGPTFailure.invalidSignIn }
        func integer() throws -> Data {
            guard cursor < bytes.count, bytes[cursor] == 0x02 else { throw ChatGPTFailure.invalidSignIn }; cursor += 1
            let count = try length(bytes, &cursor)
            guard count > 0, cursor + count <= bytes.count else { throw ChatGPTFailure.invalidSignIn }
            let value = Data(bytes[cursor..<(cursor + count)]); cursor += count
            return Data(value.drop(while: { $0 == 0 }))
        }
        let modulus = try integer(), exponent = try integer()
        return ["kid":"test-key", "kty":"RSA", "use":"sig", "alg":"RS256", "n":b64(modulus), "e":b64(exponent)]
    }
    static func signed(_ key: SecKey, claims: [String: Any], header: [String: Any] = ["alg":"RS256", "kid":"test-key", "typ":"JWT"]) throws -> String {
        let input = try b64(json(header)) + "." + b64(json(claims))
        guard let signature = SecKeyCreateSignature(key, .rsaSignatureMessagePKCS1v15SHA256,
                                                    Data(input.utf8) as CFData, nil) as Data? else {
            throw ChatGPTFailure.invalidSignIn
        }
        return input + "." + b64(signature)
    }
    static func claims() -> [String: Any] {
        ["iss":ChatGPTAttempt.issuer, "aud":client, "sub":"synthetic-user", "nonce":nonce,
         "exp":now.timeIntervalSince1970 + 300, "iat":now.timeIntervalSince1970 - 30,
         "nbf":now.timeIntervalSince1970 - 30, "email":"synthetic@example.invalid"]
    }
    static func callback(_ attempt: ChatGPTAttempt, values: [URLQueryItem]? = nil, path: String? = nil) -> URL {
        var url = URLComponents(url: attempt.redirect, resolvingAgainstBaseURL: false)!
        if let path { url.path = path }
        url.queryItems = values ?? [URLQueryItem(name:"state", value:attempt.state),
                                  URLQueryItem(name:"code", value:"synthetic-code"),
                                  URLQueryItem(name:"client_id", value:client)]
        return url.url!
    }
    static func event(_ object: [String: Any]) throws -> String {
        "data: " + String(data:try json(object), encoding:.utf8)! + "\n\n"
    }
    static func stream(_ events: [[String: Any]]) throws -> Data {
        Data(try events.map(event).joined().utf8)
    }
    static func completed(_ text: String = "finished") -> [String: Any] {
        ["type":"response.completed", "response":["status":"completed", "output":[["type":"message", "content":[["type":"output_text", "text":text]]]]]]
    }

    static func main() throws {
        setbuf(stdout, nil)
        let attributes: [CFString: Any] = [kSecAttrKeyType:kSecAttrKeyTypeRSA,
                                          kSecAttrKeySizeInBits:2048,
                                          kSecUseDataProtectionKeychain:true,
                                          kSecPrivateKeyAttrs:[kSecAttrIsPermanent:false]]
        var creationError: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &creationError) else {
            print("SETUP FAILED: ephemeral SecKey creation \(String(describing: creationError?.takeRetainedValue()))")
            throw ChatGPTFailure.invalidSignIn
        }
        print("SETUP: ephemeral RSA key created")
        let jwk = try publicJWK(privateKey), jwks: [String: Any] = ["keys":[jwk]]
        print("SETUP: public JWK exported")
        let valid = try signed(privateKey, claims:claims())
        print("SETUP: synthetic RS256 token signed")
        func verify(_ token: String, keys: [String: Any]? = nil, selectedNonce: String? = nonce) throws -> ChatGPTIdentity {
            try ChatGPTIdentity.verify(token, jwks:keys ?? jwks, clientID:client, nonce:selectedNonce, now:now)
        }
        let identity = try verify(valid)
        check("RS256 valid signature and identity", identity.subject == "synthetic-user" && identity.email == "synthetic@example.invalid")
        var modified = claims(); modified["sub"] = "tampered-user"
        let pieces = valid.split(separator:".").map(String.init)
        let tampered = pieces[0] + "." + b64(try json(modified)) + "." + pieces[2]
        rejects("JWT payload tampering", as:.invalidSignIn) { _ = try verify(tampered) }
        var signature = pieces[2]; signature.replaceSubrange(signature.startIndex...signature.startIndex, with:signature.first == "A" ? "B" : "A")
        rejects("JWT signature tampering", as:.invalidSignIn) { _ = try verify(pieces[0] + "." + pieces[1] + "." + signature) }
        for algorithm in ["none", "HS256", "RS512"] {
            let token = try signed(privateKey, claims:claims(), header:["alg":algorithm, "kid":"test-key"])
            rejects("JWT rejects algorithm \(algorithm)", as:.invalidSignIn) { _ = try verify(token) }
        }
        let claimCases: [(String, String, Any?)] = [
            ("issuer", "iss", "https://attacker.invalid"), ("audience", "aud", "wrong-client"),
            ("nonce", "nonce", "wrong-nonce"), ("missing nonce", "nonce", nil),
            ("expired", "exp", now.timeIntervalSince1970 - 1), ("expiry boundary", "exp", now.timeIntervalSince1970),
            ("missing expiry", "exp", nil), ("string expiry", "exp", "1800000300"),
            ("future issued-at", "iat", now.timeIntervalSince1970 + 61), ("missing issued-at", "iat", nil),
            ("future not-before", "nbf", now.timeIntervalSince1970 + 61),
            ("empty subject", "sub", ""), ("missing subject", "sub", nil), ("numeric subject", "sub", 42)
        ]
        for (name, claim, value) in claimCases {
            var changed = claims(); changed[claim] = value
            let token = try signed(privateKey, claims:changed)
            rejects("JWT \(name)", as:.invalidSignIn) { _ = try verify(token) }
        }
        var multi = claims(); multi["aud"] = [client, "other-client"]
        let noParty = try signed(privateKey, claims:multi)
        rejects("JWT multi-audience requires azp", as:.invalidSignIn) { _ = try verify(noParty) }
        multi["azp"] = "other-client"
        let wrongParty = try signed(privateKey, claims:multi)
        rejects("JWT multi-audience wrong azp", as:.invalidSignIn) { _ = try verify(wrongParty) }
        multi["azp"] = client
        check("JWT multi-audience matching azp", try verify(signed(privateKey, claims:multi)).subject == identity.subject)
        rejects("JWT duplicate key id", as:.invalidSignIn) { _ = try verify(valid, keys:["keys":[jwk,jwk]]) }
        rejects("JWT absent key", as:.invalidSignIn) { _ = try verify(valid, keys:["keys":[]]) }
        for (name, value) in [("use", "enc"), ("alg", "HS256"), ("kty", "EC"), ("kid", "another-key")] {
            var changed = jwk; changed[name] = value
            rejects("JWK rejects \(name)", as:.invalidSignIn) { _ = try verify(valid, keys:["keys":[changed]]) }
        }
        let critical = try signed(privateKey, claims:claims(), header:["alg":"RS256", "kid":"test-key", "crit":["unknown"]])
        rejects("JWT critical extension", as:.invalidSignIn) { _ = try verify(critical) }
        rejects("JWT malformed serialization", as:.invalidSignIn) { _ = try verify("not.a.token") }
        var refresh = claims(); refresh["nonce"] = nil
        check("JWT refresh can explicitly omit nonce", try verify(signed(privateKey, claims:refresh), selectedNonce:nil).subject == identity.subject)

        let attempt = try ChatGPTAttempt(port:48481, now:now)
        let returned = try attempt.callback(callback(attempt), now:now)
        check("OAuth dynamic callback returns client and code", returned.code == "synthetic-code" && returned.client == client)
        let url = URLComponents(url:attempt.authorizationURL(hostID:"urn:uuid:synthetic-host"), resolvingAgainstBaseURL:false)!
        let authorization = Dictionary(uniqueKeysWithValues:url.queryItems!.map { ($0.name, $0.value ?? "") })
        check("OAuth PKCE challenge is SHA256", attempt.challenge == b64(Data(SHA256.hash(data:Data(attempt.verifier.utf8)))))
        check("OAuth required resource and scopes", authorization["resource"] == ChatGPTAttempt.resource && authorization["scope"] == ChatGPTAttempt.scopes)
        check("OAuth random secrets distinct", attempt.state != attempt.nonce && attempt.nonce != attempt.verifier && attempt.state.count == 43)
        let base = [URLQueryItem(name:"state", value:attempt.state), URLQueryItem(name:"code", value:"synthetic-code"), URLQueryItem(name:"client_id", value:client)]
        var badState = base; badState[0] = URLQueryItem(name:"state", value:"wrong-state")
        rejects("OAuth wrong state", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt, values:badState), now:now) }
        rejects("OAuth duplicate query key", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt, values:base + [base[0]]), now:now) }
        rejects("OAuth missing dynamic client", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt, values:Array(base.prefix(2))), now:now) }
        var dynamic = base; dynamic[2] = URLQueryItem(name:"client_id", value:"dynamic_agent_client")
        rejects("OAuth placeholder client not usable", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt, values:dynamic), now:now) }
        var noCode = base; noCode[1] = URLQueryItem(name:"code", value:"")
        rejects("OAuth empty code", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt, values:noCode), now:now) }
        rejects("OAuth wrong callback path", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt, path:"/elsewhere"), now:now) }
        rejects("OAuth expired attempt", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt), now:now.addingTimeInterval(600)) }
        rejects("OAuth future attempt", as:.invalidSignIn) { _ = try attempt.callback(callback(attempt), now:now.addingTimeInterval(-1)) }
        for (name, modify) in [
            ("host", { (c: inout URLComponents) in c.host = "attacker.invalid" }),
            ("scheme", { (c: inout URLComponents) in c.scheme = "https" }),
            ("port", { (c: inout URLComponents) in c.port = 48482 }),
            ("fragment", { (c: inout URLComponents) in c.fragment = "data" }),
            ("userinfo", { (c: inout URLComponents) in c.user = "user" })
        ] {
            var changed = URLComponents(url:callback(attempt), resolvingAgainstBaseURL:false)!; modify(&changed)
            rejects("OAuth rejects callback \(name)", as:.invalidSignIn) { _ = try attempt.callback(changed.url!, now:now) }
        }
        let known = try ChatGPTAttempt(port:48481, clientID:client, now:now)
        let knownValues = [URLQueryItem(name:"state", value:known.state), URLQueryItem(name:"code", value:"synthetic-code")]
        check("OAuth existing client callback may omit client", try known.callback(callback(known, values:knownValues), now:now).client == client)
        rejects("OAuth existing client cannot change", as:.invalidSignIn) {
            _ = try known.callback(callback(known, values:knownValues + [URLQueryItem(name:"client_id", value:"other-client")]), now:now)
        }
        rejects("OAuth explicit consent rejection", as:.consent) {
            _ = try attempt.callback(callback(attempt, values:[base[0], URLQueryItem(name:"error", value:"access_denied")]), now:now)
        }

        check("SSE completed final output", try ChatGPTStreamResult.text(from:stream([completed()])) == "finished")
        let delta: [String: Any] = ["type":"response.output_text.delta", "delta":"provisional"]
        check("SSE final output supersedes delta", try ChatGPTStreamResult.text(from:stream([delta,completed()])) == "finished")
        check("SSE CRLF accepted", try ChatGPTStreamResult.text(from:Data(try event(completed()).replacingOccurrences(of:"\n", with:"\r\n").utf8)) == "finished")
        rejects("SSE delta alone incomplete", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([delta])) }
        rejects("SSE DONE alone incomplete", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:Data("data: [DONE]\n\n".utf8)) }
        rejects("SSE response.failed", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([delta,["type":"response.failed", "response":["error":["code":"server_error"]]]])) }
        for code in ["subscription_sharing_usage_limit_exceeded", "rate_limit_exceeded"] {
            rejects("SSE limit \(code)", as:.limit) { _ = try ChatGPTStreamResult.text(from:stream([["type":"response.failed", "response":["error":["code":code]]]])) }
        }
        rejects("SSE temporary usage unavailable preserves connection", as:.transient) {
            _ = try ChatGPTStreamResult.text(from:stream([["type":"error", "code":"subscription_sharing_usage_unavailable"]]))
        }
        rejects("SSE unsupported capability requires changed request", as:.unsupported) {
            _ = try ChatGPTStreamResult.text(from:stream([["type":"error", "code":"unsupported_capability"]]))
        }
        rejects("SSE token expired", as:.expired) { _ = try ChatGPTStreamResult.text(from:stream([["type":"error", "code":"invalid_token"]])) }
        rejects("SSE response.incomplete", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([delta,["type":"response.incomplete", "response":["status":"incomplete"]]])) }
        rejects("SSE incorrect completed status", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([["type":"response.completed", "response":["status":"incomplete"]]])) }
        rejects("SSE duplicate completion", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([completed(),completed()])) }
        rejects("SSE failure after completion", as:.limit) { _ = try ChatGPTStreamResult.text(from:stream([completed(),["type":"error", "code":"rate_limit_exceeded"]])) }
        rejects("SSE empty completion", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([completed(" ")])) }
        rejects("SSE malformed JSON", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:Data("data: {bad}\n\n".utf8)) }
        rejects("SSE invalid UTF8", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:Data([0xff])) }
        rejects("SSE response body limit", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:Data(repeating:65, count:2_000_001)) }
        rejects("SSE completed text limit", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([completed(String(repeating:"a", count:30_001))])) }

        // Regression checks for malformed optional claims and terminal SSE ordering.
        var malformedNbf = claims(); malformedNbf["nbf"] = "tomorrow"
        rejects("JWT malformed optional nbf", as:.invalidSignIn) { _ = try verify(signed(privateKey, claims:malformedNbf)) }
        var booleanIat = claims(); booleanIat["iat"] = true
        rejects("JWT boolean iat", as:.invalidSignIn) { _ = try verify(signed(privateKey, claims:booleanIat)) }
        var wrongSingleParty = claims(); wrongSingleParty["azp"] = "another-client"
        rejects("JWT contradictory single-audience azp", as:.invalidSignIn) { _ = try verify(signed(privateKey, claims:wrongSingleParty)) }
        let emptyCompleted: [String: Any] = ["type":"response.completed", "response":["status":"completed", "output":[]]]
        rejects("capture rejects delta-only final completion", as:.incomplete) {
            _ = try ChatGPTStreamResult.text(from:stream([delta,emptyCompleted]), requireFinalOutput:true)
        }
        rejects("capture rejects final refusal", as:.refused) {
            _ = try ChatGPTStreamResult.text(from:stream([["type":"response.completed", "response":["status":"completed", "output":[["content":[["type":"refusal", "refusal":"no"]]]]]]]), requireFinalOutput:true)
        }
        rejects("capture rejects streaming refusal", as:.refused) {
            _ = try ChatGPTStreamResult.text(from:stream([["type":"response.refusal.delta", "delta":"no"]]), requireFinalOutput:true)
        }
        check("capture uses explicit structured output bound", try ChatGPTStreamResult.text(from:stream([completed(String(repeating:"a", count:40_000))]), requireFinalOutput:true, maximumCharacters:160_000).count == 40_000)
        rejects("SSE text after completion", as:.incomplete) {
            _ = try ChatGPTStreamResult.text(from:stream([emptyCompleted,delta]))
        }
        let usageEvent: [String: Any] = ["type":"response.completed", "response":["status":"completed",
            "usage":["input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":["cached_tokens":50],"text":"private food"],
            "account":"private account"]]
        let usage = ChatGPTStreamResult.usage(from:try stream([usageEvent]))
        check("plan usage is numeric and separate from API billing", usage["inputTokens"] as? Int == 100 && usage["cachedInputTokens"] as? Int == 50 && usage["billingScope"] as? String == "chatgpt_plan")
        check("usage excludes provider text and account fields", !String(decoding:try JSONSerialization.data(withJSONObject:usage),as:UTF8.self).contains("private"))
        check("missing usage is unavailable, never zero", ChatGPTStreamResult.usage(from:try stream([completed()]))["usageStatus"] as? String == "unavailable")
        let badUsage: [String: Any] = ["type":"response.completed","response":["status":"completed","usage":["input_tokens":100,"output_tokens":20,"total_tokens":999]]]
        check("contradictory usage is not reported", ChatGPTStreamResult.usage(from:try stream([badUsage]))["usageStatus"] as? String == "unavailable")
        let booleanUsage: [String: Any] = ["type":"response.completed","response":["status":"completed","usage":["input_tokens":true,"output_tokens":20,"total_tokens":21]]]
        check("boolean input usage is not a token count", ChatGPTStreamResult.usage(from:try stream([booleanUsage]))["inputTokens"] == nil)
        let fullUsage: [String: Any] = ["input_tokens":100,"output_tokens":20,"total_tokens":120,
            "input_tokens_details":["cached_tokens":30,"cache_write_tokens":0], "output_tokens_details":["reasoning_tokens":7]]
        for outcome in ["completed", "incomplete", "failed"] {
            let terminal: [String: Any] = ["type":"response." + outcome, "response":["status":outcome,"model":"gpt-4.1-mini-2025-04-14","usage":fullUsage,"text":"private content"]]
            let values = ChatGPTStreamResult.usage(from:try stream([terminal]))
            check("terminal \(outcome) retains reported usage", values["providerOutcome"] as? String == outcome && values["usageStatus"] as? String == "reported" && values["inputTokens"] as? Int == 100 && values["cacheWriteTokens"] as? Int == 0 && values["reasoningTokens"] as? Int == 7)
            check("terminal \(outcome) retains actual model without text", values["reportedModel"] as? String == "gpt-4.1-mini-2025-04-14" && values["text"] == nil)
        }
        check("duplicate terminal usage is unavailable", ChatGPTStreamResult.usage(from:try stream([usageEvent,usageEvent]))["usageStatus"] as? String == "unavailable")
        check("missing optional usage remains partial", usage["usageStatus"] as? String == "partial" && usage["cacheWriteTokens"] == nil && usage["reasoningTokens"] == nil)
        let excessive: [String: Any] = ["type":"response.completed","response":["status":"completed","usage":["input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":["cached_tokens":80,"cache_write_tokens":30],"output_tokens_details":["reasoning_tokens":21]]]]
        let partialUsage = ChatGPTStreamResult.usage(from:try stream([excessive]))
        check("contradictory detail counts are not reported", partialUsage["inputTokens"] as? Int == 100 && partialUsage["cachedInputTokens"] == nil && partialUsage["cacheWriteTokens"] == nil && partialUsage["reasoningTokens"] == nil && partialUsage["usageStatus"] as? String == "partial")
        for model in ["private account", "gpt-4.1-mini\n", "gpt-" + String(repeating:"x",count:61), "https://example.com/private"] {
            let event: [String: Any] = ["type":"response.failed","response":["status":"failed","model":model,"usage":fullUsage]]
            check("unsafe reported model is omitted \(model.count)", ChatGPTStreamResult.usage(from:try stream([event]))["reportedModel"] == nil)
        }
        // Real SSE framing and bounded rejection diagnostics, independently of
        // synthetic provider output or the downstream food schema.
        let normal = try event(completed("private food output"))
        for framing in ["", "\n", "\n\n\n\n", ": heartbeat\n\n", "event: response.completed\n\n", "data:\n\n"] {
            rejects("empty SSE framing cannot complete \(framing.utf8.count)", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:Data(framing.utf8), requireFinalOutput:true) }
            let report = ChatGPTStreamResult.diagnostics(from:Data(framing.utf8), contentType:"text/event-stream")
            check("empty SSE framing has no events \(framing.utf8.count)", report["streamEventCount"] as? Int == 0 && report["parseFailure"] as? String == "missing_terminal")
        }
        for ending in ["\n", "\r\n", "\r"] {
            let framed = Data(("\u{feff}: heartbeat\n\n" + normal + "data: [DONE]\n\n").replacingOccurrences(of:"\n", with:ending).utf8)
            check("SSE BOM and line ending \(Array(ending.utf8))", try ChatGPTStreamResult.text(from:framed, requireFinalOutput:true) == "private food output")
            let report = ChatGPTStreamResult.diagnostics(from:framed, contentType:"Text/Event-Stream; charset=utf-8")
            check("framing diagnostics match accepted text \(Array(ending.utf8))", report["parseFailure"] as? String == "none" && report["streamEventCount"] as? Int == 1 && report["streamTerminalCount"] as? Int == 1 && report["finalOutputTextCount"] as? Int == 1)
            check("framing diagnostics exclude private output \(Array(ending.utf8))", !String(decoding:try json(report), as:UTF8.self).contains("private"))
        }
        var named = completed(); named.removeValue(forKey:"type")
        let namedData = Data(("event: response.completed\n" + (try event(named))).utf8)
        check("SSE event name supplies absent JSON type", try ChatGPTStreamResult.text(from:namedData, requireFinalOutput:true) == "finished")
        check("named terminal usage retains outcome", ChatGPTStreamResult.usage(from:namedData)["providerOutcome"] as? String == "completed")
        let conflictingData = Data(("event: response.failed\n" + normal).utf8)
        rejects("SSE conflicting name and type rejected", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:conflictingData, requireFinalOutput:true) }
        check("SSE conflict diagnostic is fixed", ChatGPTStreamResult.diagnostics(from:conflictingData, contentType:"text/event-stream")["parseFailure"] as? String == "event_name_mismatch")
        check("SSE conflict cannot supply usage", ChatGPTStreamResult.usage(from:conflictingData)["providerOutcome"] == nil)
        var malformedNamed = named; malformedNamed["type"] = 42
        rejects("SSE named event cannot rescue malformed type", as:.incomplete) {
            _ = try ChatGPTStreamResult.text(from:Data(("event: response.completed\n" + (try event(malformedNamed))).utf8), requireFinalOutput:true)
        }
        let diagnosticCases: [(String, Data, String)] = [
            ("interrupted", try stream([delta]), "missing_terminal"),
            ("malformed", Data("data: {bad}\n\n".utf8), "malformed_event"),
            ("invalid encoding", Data([0xff]), "invalid_encoding"),
            ("oversized", Data(repeating:65,count:2_000_001), "response_too_large"),
            ("terminal mismatch", try stream([["type":"response.completed","response":["status":"incomplete"]]]), "terminal_mismatch"),
            ("duplicate", try stream([completed(),completed()]), "multiple_terminal"),
            ("post terminal", try stream([completed(),delta]), "event_after_terminal"),
            ("missing final", try stream([emptyCompleted]), "missing_final_output"),
            ("empty output", try stream([completed(" ")]), "empty_output"),
            ("oversized output", try stream([completed(String(repeating:"a",count:160_001))]), "output_too_large"),
            ("refused", try stream([["type":"response.refusal.delta","delta":"private refusal"]]), "refused"),
            ("unknown provider error", try stream([["type":"error","code":"private provider code","message":"private details"]]), "provider_error")
        ]
        for (name, data, expected) in diagnosticCases {
            let report = ChatGPTStreamResult.diagnostics(from:data, contentType:"text/event-stream")
            check("rejection diagnostics \(name)", report["parseFailure"] as? String == expected)
            check("rejection diagnostics contain no private text \(name)", !String(decoding:try json(report), as:UTF8.self).contains("private"))
        }
        let duplicateReport = ChatGPTStreamResult.diagnostics(from:try stream([completed(),completed(),delta]), contentType:"text/event-stream")
        check("diagnostic counts cover rejected stream", duplicateReport["streamEventCount"] as? Int == 3 && duplicateReport["streamTerminalCount"] as? Int == 2 && duplicateReport["streamTextDeltaCount"] as? Int == 1 && duplicateReport["finalOutputTextCount"] as? Int == 2)
        let unsupported = try stream([["type":"response.failed", "response":["status":"failed", "error":["code":"subscription_sharing_unsupported_capability","message":"private details","param":"private input"]]]])
        rejects("documented plan capability code mapped", as:.unsupported) { _ = try ChatGPTStreamResult.text(from:unsupported) }
        check("documented capability code retained without detail", ChatGPTStreamResult.diagnostics(from:unsupported, contentType:"text/event-stream")["providerErrorCode"] as? String == "subscription_sharing_unsupported_capability")
        for (header, expected) in [(nil,"missing"),("application/json","json"),("application/problem+json; charset=utf-8","json"),("text/html; private value","other"),("application/x-text/event-stream","other")] as [(String?, String)] {
            let report = ChatGPTStreamResult.diagnostics(from:try json(["error":["code":"server_error","message":"private message"],"output_text":"private food"]), contentType:header)
            check("response format category \(expected)", report["responseFormat"] as? String == expected && report["parseFailure"] as? String == (header == nil ? "missing_terminal" : "unexpected_response_format"))
            check("nonstream diagnostics contain no private values \(expected)", !String(decoding:try json(report), as:UTF8.self).contains("private"))
        }
        let doneOnly = try stream([["type":"response.output_text.done", "text":"private food"],emptyCompleted])
        rejects("output text done cannot replace final completed evidence", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:doneOnly, requireFinalOutput:true) }
        let headerless = try stream([delta,completed("{}")])
        let headerlessReport = ChatGPTStreamResult.diagnostics(from:headerless, contentType:nil)
        check("missing header uses strict SSE evaluator", headerlessReport["responseFormat"] as? String == "missing" && headerlessReport["parseFailure"] as? String == "none" && headerlessReport["streamTerminalCount"] as? Int == 1 && headerlessReport["finalOutputTextCount"] as? Int == 1)
        for (name, data, expected) in diagnosticCases {
            let report = ChatGPTStreamResult.diagnostics(from:data, contentType:nil)
            check("headerless rejection diagnostics \(name)", report["responseFormat"] as? String == "missing" && report["parseFailure"] as? String == expected)
        }
        for raw in ["", "<html><body>private HTML</body></html>", "{\"status\":\"completed\",\"output_text\":\"private JSON\"}"] {
            let report = ChatGPTStreamResult.diagnostics(from:Data(raw.utf8), contentType:nil)
            check("headerless nonstream rejected \(raw.count)", report["parseFailure"] as? String == "missing_terminal" && report["streamTerminalCount"] as? Int == 0)
            rejects("headerless nonstream is not completed SSE \(raw.count)", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:Data(raw.utf8), requireFinalOutput:true) }
        }
        // Some completed streams omit response.output in the terminal event.
        // A completed assistant item is final evidence; deltas and text/part
        // completion events alone are not, even alongside a completed terminal.
        func doneItem(_ text: String = "private final item", id: Any = "msg_synthetic", index: Any = 0,
                      messageChanges: [String: Any] = [:]) -> [String: Any] {
            var message: [String: Any] = ["id":id, "type":"message", "role":"assistant", "status":"completed",
                "content":[["type":"output_text", "text":text]]]
            messageChanges.forEach { message[$0.key] = $0.value }
            return ["type":"response.output_item.done", "output_index":index, "item":message]
        }
        let itemDone = doneItem()
        let omittedOutput: [String: Any] = ["type":"response.completed", "response":["status":"completed"]]
        let nullTerminalDetails: [String: Any] = ["type":"response.completed", "response":["status":"completed", "error":NSNull(), "incomplete_details":NSNull()]]
        let fullItemTerminal: [String: Any] = ["type":"response.completed", "response":["status":"completed", "output":[itemDone["item"]!]]]
        for (name, terminal, source, finalCount) in [
            ("omitted", omittedOutput, "output_item", 0), ("empty", emptyCompleted, "output_item", 0),
            ("null optional details", nullTerminalDetails, "output_item", 0), ("matching terminal", fullItemTerminal, "response", 1)
        ] {
            let data = try stream([delta,itemDone,terminal])
            check("completed item fallback \(name)", try ChatGPTStreamResult.text(from:data, requireFinalOutput:true) == "private final item")
            for header in [nil,"text/event-stream"] as [String?] {
                let report = ChatGPTStreamResult.diagnostics(from:data, contentType:header)
                check("completed item diagnostics \(name) \(header ?? "missing")", report["parseFailure"] as? String == "none" && report["finalOutputSource"] as? String == source && report["finalOutputTextCount"] as? Int == finalCount && report["streamOutputItemDoneCount"] as? Int == 1 && report["completedItemTextCount"] as? Int == 1)
                check("completed item diagnostics exclude private output \(name) \(header ?? "missing")", !String(decoding:try json(report),as:UTF8.self).contains("private"))
            }
        }
        let reasoning: [String: Any] = ["type":"response.output_item.done", "output_index":0, "item":["id":"rs_synthetic", "type":"reasoning", "summary":[]]]
        let itemAfterReasoning = doneItem(index:1)
        let reasoningTerminal: [String: Any] = ["type":"response.completed", "response":["status":"completed", "output":[reasoning["item"]!,itemAfterReasoning["item"]!]]]
        for terminal in [omittedOutput,reasoningTerminal] {
            let data = try stream([reasoning,itemAfterReasoning,terminal])
            check("reasoning is not completed assistant text", try ChatGPTStreamResult.text(from:data, requireFinalOutput:true) == "private final item")
            let report = ChatGPTStreamResult.diagnostics(from:data,contentType:nil)
            check("reasoning done count distinct from completed text", report["streamOutputItemDoneCount"] as? Int == 2 && report["completedItemTextCount"] as? Int == 1)
        }
        let acceptedLargeItem = try stream([doneItem(String(repeating:"a",count:40_000)),omittedOutput])
        check("item fallback respects capture text bound", try ChatGPTStreamResult.text(from:acceptedLargeItem,requireFinalOutput:true,maximumCharacters:160_000).count == 40_000)
        var missingID = itemDone["item"] as! [String: Any]; missingID.removeValue(forKey:"id")
        var missingIndex = itemDone; missingIndex.removeValue(forKey:"output_index")
        let refusalPart: [String: Any] = ["type":"refusal", "refusal":"private refusal"]
        var itemRejections: [(String, [[String: Any]], ChatGPTFailure)] = [
            ("no terminal", [itemDone], .incomplete),
            ("delta only", [delta,omittedOutput], .incomplete),
            ("text done only", [["type":"response.output_text.done","text":"private done"],omittedOutput], .incomplete),
            ("part done only", [["type":"response.content_part.done","part":["type":"output_text","text":"private part"]],omittedOutput], .incomplete),
            ("item added only", [["type":"response.output_item.added","output_index":0,"item":itemDone["item"]!],omittedOutput], .incomplete),
            ("reasoning only", [reasoning,omittedOutput], .incomplete),
            ("missing item", [["type":"response.output_item.done","output_index":0],omittedOutput], .incomplete),
            ("missing id", [["type":"response.output_item.done","output_index":0,"item":missingID],omittedOutput], .incomplete),
            ("missing index", [missingIndex,omittedOutput], .incomplete),
            ("duplicate item", [itemDone,itemDone,omittedOutput], .incomplete),
            ("duplicate id", [itemDone,doneItem(index:1),omittedOutput], .incomplete),
            ("duplicate index", [itemDone,doneItem(id:"msg_other"),omittedOutput], .incomplete),
            ("multiple messages", [itemDone,doneItem(id:"msg_other",index:1),omittedOutput], .incomplete),
            ("multiple terminal", [itemDone,omittedOutput,omittedOutput], .incomplete),
            ("item after terminal", [fullItemTerminal,itemDone], .incomplete),
            ("empty item text", [doneItem(" \n "),omittedOutput], .incomplete),
            ("oversized item text", [doneItem(String(repeating:"a",count:160_001)),omittedOutput], .incomplete),
            ("conflicting terminal text", [itemDone,completed("different final")], .incomplete),
            ("terminal wrong index", [doneItem(index:1),fullItemTerminal], .incomplete),
            ("nonempty terminal without text", [itemDone,["type":"response.completed","response":["status":"completed","output":[["type":"reasoning"]]]]], .incomplete),
            ("malformed terminal output", [itemDone,["type":"response.completed","response":["status":"completed","output":"private wrong type"]]], .incomplete),
            ("null terminal output", [itemDone,["type":"response.completed","response":["status":"completed","output":NSNull()]]], .incomplete),
            ("terminal status mismatch", [itemDone,["type":"response.completed","response":["status":"incomplete"]]], .incomplete),
            ("terminal error", [itemDone,["type":"response.completed","response":["status":"completed","error":["code":"server_error"]]]], .incomplete),
            ("terminal incomplete details", [itemDone,["type":"response.completed","response":["status":"completed","incomplete_details":["reason":"max_output_tokens"]]]], .incomplete),
            ("failed terminal", [itemDone,["type":"response.failed","response":["status":"failed"]]], .incomplete),
            ("incomplete terminal", [itemDone,["type":"response.incomplete","response":["status":"incomplete"]]], .incomplete),
            ("error after item", [itemDone,["type":"error","code":"server_error"],omittedOutput], .incomplete),
            ("error after terminal", [itemDone,omittedOutput,["type":"error","code":"server_error"]], .incomplete),
            ("refusal item", [doneItem(messageChanges:["content":[refusalPart]]),omittedOutput], .refused),
            ("mixed refusal item", [doneItem(messageChanges:["content":[["type":"output_text","text":"private final item"],refusalPart]]),omittedOutput], .refused),
            ("refusal part", [itemDone,["type":"response.content_part.done","part":refusalPart],omittedOutput], .refused),
            ("refusal delta", [itemDone,["type":"response.refusal.delta","delta":"private refusal"],omittedOutput], .refused),
            ("refusal done", [itemDone,["type":"response.refusal.done","refusal":"private refusal"],omittedOutput], .refused),
            ("refusal terminal", [itemDone,["type":"response.completed","response":["status":"completed","output":[["content":[refusalPart]]]]]], .refused)
        ]
        for (key, values) in [
            ("type", [NSNull(),"function_call"] as [Any]), ("role", [NSNull(),"user"] as [Any]),
            ("status", [NSNull(),"in_progress","incomplete"] as [Any]),
            ("content", [NSNull(),[],[["type":"output_text","text":42]],[["type":"output_text","text":"one"],["type":"output_text","text":"two"]],[["type":"unknown","text":"private"]]] as [Any])
        ] {
            for (index,value) in values.enumerated() { itemRejections.append(("invalid item \(key) \(index)",[doneItem(messageChanges:[key:value]),omittedOutput],.incomplete)) }
        }
        for (index,id) in (["", " ", " padded", String(repeating:"x",count:513), 42, NSNull()] as [Any]).enumerated() {
            itemRejections.append(("invalid id \(index)",[doneItem(id:id),omittedOutput],.incomplete))
        }
        for (index,value) in ([-1, 0.5, true, "0", 100_001, NSNull()] as [Any]).enumerated() {
            itemRejections.append(("invalid index \(index)",[doneItem(index:value),omittedOutput],.incomplete))
        }
        for (name, changes) in [("id",["id":"msg_other"]),("role",["role":"user"]),("status",["status":"incomplete"])] {
            let message = doneItem(messageChanges:changes)["item"]!
            itemRejections.append(("conflicting terminal \(name)",[itemDone,["type":"response.completed","response":["status":"completed","output":[message]]]],.incomplete))
        }
        for (name, events, failure) in itemRejections {
            let data = try stream(events)
            rejects("completed item rejects \(name)", as:failure) { _ = try ChatGPTStreamResult.text(from:data,requireFinalOutput:true,maximumCharacters:160_000) }
            let report = ChatGPTStreamResult.diagnostics(from:data,contentType:nil)
            check("rejected item has no accepted source \(name)", report["parseFailure"] as? String != "none" && report["finalOutputSource"] as? String == "none")
            check("rejected item diagnostics exclude text \(name)", !String(decoding:try json(report),as:UTF8.self).contains("private"))
        }
        rejects("preview also rejects delta-only completion", as:.incomplete) { _ = try ChatGPTStreamResult.text(from:stream([delta,emptyCompleted])) }
        let terminalOnlyReport = ChatGPTStreamResult.diagnostics(from:try stream([completed()]),contentType:nil)
        check("terminal-only path retained without item evidence", terminalOnlyReport["finalOutputSource"] as? String == "response" && terminalOnlyReport["streamOutputItemDoneCount"] as? Int == 0 && terminalOnlyReport["completedItemTextCount"] as? Int == 0)
        print("SUMMARY: \(passed) passed, \(failed) failed")
        if failed != 0 { exit(1) }
    }
}
