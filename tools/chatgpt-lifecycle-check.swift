import Foundation

private final class FakeProtocol: URLProtocol, @unchecked Sendable {
    static let server = FakeServer()
    private let stateLock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.server.start(self) }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
    func send(_ body: Data, type: String? = "application/json", status: Int = 200) {
        stateLock.lock(); let active = !stopped; stateLock.unlock()
        guard active else { return }
        var headers = ["Content-Length": String(body.count), "x-request-id": "req_synthetic_lifecycle"]
        if let type { headers["Content-Type"] = type }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class FakeServer: @unchecked Sendable {
    private let lock = NSLock()
    private var refreshCount: [String: Int] = [:]
    private var pendingRefresh: [String: [FakeProtocol]] = [:]
    private var revoked: [String: [String]] = [:]
    private var pendingAnalysis: [String: [FakeProtocol]] = [:]
    private var analysisCount: [String: Int] = [:]
    private var analysisBodies: [String: [[String: Any]]] = [:]
    private var modelsCount: [String: Int] = [:]
    private var heldModels = Set<String>()
    private var pendingModels: [String: [FakeProtocol]] = [:]
    private var unexpected: [String] = []
    private func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data(), bytes = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&bytes, maxLength: bytes.count)
            if count <= 0 { break }; result.append(bytes, count: count)
        }
        return result
    }
    private func fields(_ request: URLRequest) -> [String: String] {
        var parts = URLComponents(); parts.percentEncodedQuery = String(decoding: body(request), as: UTF8.self)
        return Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    }
    func start(_ proto: FakeProtocol) {
        let request = proto.request, path = request.url?.path ?? ""
        if path == "/.well-known/openid-configuration" {
            proto.send(json(["issuer": "https://auth.openai.com", "authorization_endpoint": "https://auth.openai.com/api/accounts/authorize", "token_endpoint": "https://auth.openai.com/api/accounts/oauth/token", "jwks_uri": "https://auth.openai.com/.well-known/jwks.json", "revocation_endpoint": "https://auth.openai.com/api/accounts/oauth/revoke"]))
        } else if path == "/api/accounts/oauth/token" {
            let form = fields(request), client = form["client_id"] ?? "missing"
            lock.lock(); refreshCount[client, default: 0] += 1; pendingRefresh[client, default: []].append(proto)
            if form["grant_type"] != "refresh_token" || form["refresh_token"] != "old-" + client { unexpected.append("invalid refresh request for " + client) }
            lock.unlock()
        } else if path == "/api/accounts/oauth/revoke" {
            let form = fields(request), client = form["client_id"] ?? "missing"
            lock.lock(); revoked[client, default: []].append(form["token"] ?? "missing"); lock.unlock()
            proto.send(Data())
        } else if path == "/v1/models" {
            let access = request.value(forHTTPHeaderField: "Authorization") ?? "missing"
            lock.lock(); modelsCount[access, default: 0] += 1
            let held = heldModels.contains(access)
            if held { pendingModels[access, default: []].append(proto) }
            lock.unlock()
            if !held { proto.send(modelData()) }
        } else if path == "/v1/responses" {
            let access = request.value(forHTTPHeaderField: "Authorization") ?? "missing"
            let payload = (try? JSONSerialization.jsonObject(with: body(request))) as? [String: Any] ?? [:]
            lock.lock(); analysisCount[access, default: 0] += 1; pendingAnalysis[access, default: []].append(proto)
            analysisBodies[access, default: []].append(payload); lock.unlock()
        } else {
            lock.lock(); unexpected.append(path); lock.unlock()
            proto.send(json(["error": "unexpected endpoint"]), status: 500)
        }
    }
    func count(_ client: String) -> Int { lock.lock(); defer { lock.unlock() }; return refreshCount[client] ?? 0 }
    func modelCount(_ access: String) -> Int { lock.lock(); defer { lock.unlock() }; return modelsCount[access] ?? 0 }
    func analysisStarted(_ access: String) -> Bool { lock.lock(); defer { lock.unlock() }; return (analysisCount[access] ?? 0) > 0 }
    func analyses(_ access: String) -> Int { lock.lock(); defer { lock.unlock() }; return analysisCount[access] ?? 0 }
    func requests(_ access: String) -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return analysisBodies[access] ?? [] }
    func revocations(_ client: String) -> [String] { lock.lock(); defer { lock.unlock() }; return revoked[client] ?? [] }
    func errors() -> [String] { lock.lock(); defer { lock.unlock() }; return unexpected }
    private func modelData() -> Data {
        json(["models": [["slug": "test-vision-model", "display_name": "Test vision", "visibility": "list"],
                         ["slug": "other-vision-model", "display_name": "Other vision", "visibility": "list"]]])
    }
    func holdModels(_ access: String) { lock.lock(); heldModels.insert(access); lock.unlock() }
    func releaseModels(_ access: String, fail: Bool = false, onlyModel: String? = nil) {
        lock.lock(); let pending = pendingModels.removeValue(forKey: access) ?? []; heldModels.remove(access); lock.unlock()
        let data = onlyModel.map { json(["models": [["slug": $0, "display_name": $0, "visibility": "list"]]]) } ?? modelData()
        pending.forEach { $0.send(fail ? json(["error": "server_error"]) : data, status: fail ? 503 : 200) }
    }
    func releaseRefresh(_ client: String) {
        lock.lock(); let pending = pendingRefresh.removeValue(forKey: client) ?? []; lock.unlock()
        let response = json(["access_token": "new-access-" + client, "refresh_token": "new-refresh-" + client, "id_token": "deliberately-not-a-jwt", "token_type": "Bearer", "expires_in": 3600, "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"])
        pending.forEach { $0.send(response) }
    }
    func failRefresh(_ client: String, code: String) {
        lock.lock(); let pending = pendingRefresh.removeValue(forKey:client) ?? []; lock.unlock()
        pending.forEach { $0.send(json(["error":code]), status:400) }
    }
    func failAnalysis(_ access: String, code: String, status: Int) {
        lock.lock(); let pending = pendingAnalysis.removeValue(forKey:access) ?? []; lock.unlock()
        pending.forEach { $0.send(json(["error":["code":code]]), status:status) }
    }
    func releaseAnalysis(_ access: String, output: String = "Late result should not appear") {
        let event: [String: Any] = ["type": "response.completed", "response": ["status": "completed", "output": [["content": [["type": "output_text", "text": output]]]]]]
        releaseEvents(access, events: [event])
    }
    func releaseEvents(_ access: String, events: [[String: Any]]) {
        lock.lock(); let pending = pendingAnalysis.removeValue(forKey: access) ?? []; lock.unlock()
        let text = events.map { "data: " + String(decoding: json($0), as: UTF8.self) + "\n\n" }.joined()
        pending.forEach { $0.send(Data(text.utf8), type: "text/event-stream") }
    }
    func releaseRawAnalysis(_ access: String, data: Data, type: String?, status: Int = 200) {
        lock.lock(); let pending = pendingAnalysis.removeValue(forKey:access) ?? []; lock.unlock()
        pending.forEach { $0.send(data, type:type, status:status) }
    }
}

@MainActor private final class MemoryVault {
    var value: ChatGPTVault
    var saveCount = 0
    var failNextSave = false
    init(_ value: ChatGPTVault) { self.value = value }
    func save(_ value: ChatGPTVault) throws {
        if failNextSave { failNextSave = false; throw ChatGPTFailure.storage }
        self.value = value; saveCount += 1
    }
}

private enum TestFailure: Error { case failed(String) }

@main @MainActor struct LifecycleHarness {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw TestFailure.failed(message) }
    }
    static func eventually(_ message: String, _ condition: () -> Bool) async throws {
        for _ in 0..<400 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw TestFailure.failed("Timed out: " + message)
    }
    static func settle() async throws { try await Task.sleep(nanoseconds: 120_000_000) }
    private static func make(_ ids: [String], expired: Bool = true) -> (ChatGPTConnection, MemoryVault) {
        var value = ChatGPTVault(); value.hostID = "urn:uuid:00000000-0000-4000-8000-000000000001"; value.selectedID = ids[0]
        value.profiles = ids.map { ChatGPTProfile(clientID: $0, subject: "subject-" + $0, email: nil, accessToken: "old-access-" + $0, refreshToken: "old-" + $0, idToken: "previously-verified-" + $0, expiresAt: Date().addingTimeInterval(expired ? -60 : 3600), scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], welcomed: true) }
        let box = MemoryVault(value)
        return (connection(box), box)
    }
    private static func connection(_ box: MemoryVault) -> ChatGPTConnection {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FakeProtocol.self]
        let session = URLSession(configuration: config)
        return ChatGPTConnection(session: session, loadVault: { box.value }, saveVault: { try box.save($0) })
    }
    private static func binding(_ box: MemoryVault, id: String, modelID: String = "test-vision-model") -> ChatGPTCaptureBinding {
        let profile = box.value.profiles.first { $0.id == id }!
        return ChatGPTCaptureBinding(profileID:id, subject:profile.subject, connectionID:profile.connectionID!, modelID:modelID)
    }
    private static func captureRequest() -> [String: Any] {
        ["model":"attempted-model-override", "store":true, "stream":false, "instructions":"Extract visible food evidence only.",
         "input":[["role":"user", "content":[["type":"input_text", "text":"Read the visible label."],
             ["type":"input_image", "image_url":"data:image/jpeg;base64,/9j/2Q==", "detail":"high"]]]],
         "text":["format":["type":"json_schema", "name":"test", "strict":true, "schema":["type":"object", "properties":[:], "additionalProperties":false]]]]
    }
    private static func captureError(_ task: Task<String, Error>) async -> Error? {
        do { _ = try await task.value; return nil } catch { return error }
    }
    static func captureReasoningPolicy() async throws {
        try expect(ChatGPTCapturePolicy.reasoning(modelID: "gpt-6-astra") == ["effort": "low"], "Astra low policy missing")
        try expect(ChatGPTCapturePolicy.reasoning(modelID: "gpt-6-luna") == ["effort": "none"], "Luna none policy missing")
        for modelID in ["test-vision-model", "gpt-6-sol", "GPT-6-ASTRA", "gpt-6-astra-latest", " gpt-6-astra", "GPT-6-LUNA", "gpt-6-luna-latest", "gpt-6-luna "] {
            try expect(ChatGPTCapturePolicy.reasoning(modelID: modelID) == nil, "reasoning policy matched a different model")
        }
        for (index, modelID) in ["gpt-6-astra", "gpt-6-luna", "test-vision-model"].enumerated() {
            let id = "reasoning-valid-\(index)", (connection, box) = make(["reasoning-valid-\(index)"], expired: false)
            let choice = binding(box, id: id, modelID: modelID), access = "Bearer old-access-" + id
            var request = captureRequest()
            request["reasoning"] = ChatGPTCapturePolicy.reasoning(modelID: modelID)
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding: choice, request: request) { reports.append($0) } }
            try await eventually("reasoning policy reaches intercepted transport") { FakeProtocol.server.analyses(access) == 1 }
            let sent = FakeProtocol.server.requests(access)[0]
            try expect(sent["model"] as? String == modelID && sent["store"] as? Bool == false && sent["stream"] as? Bool == true,
                       "reasoning policy weakened pinned transport fields")
            try expect(sent["reasoning"] as? [String: String] == ChatGPTCapturePolicy.reasoning(modelID: modelID),
                       "transport changed reasoning policy or added it for an unknown model")
            try expect(NSDictionary(dictionary: sent["text"] as? [String: Any] ?? [:]).isEqual(to: request["text"] as? [String: Any] ?? [:]),
                       "reasoning policy changed strict output schema")
            try expect(NSArray(array: sent["input"] as? [Any] ?? []).isEqual(to: request["input"] as? [Any] ?? []),
                       "reasoning policy changed image evidence")
            FakeProtocol.server.releaseAnalysis(access, output: "{}")
            let output = try await task.value
            try expect(output == "{}", "reasoning policy rejected completed output")
            try expect(reports.last?["requestedReasoningEffort"] as? String == ChatGPTCapturePolicy.reasoning(modelID: modelID)?["effort"],
                       "diagnostics did not preserve the actual bounded request effort")
        }
        let id = "reasoning-invalid", (connection, box) = make(["reasoning-invalid"])
        let astra = binding(box, id: id, modelID: "gpt-6-astra")
        let malformed: [Any] = [
            NSNull(), "low", ["low"], [:] as [String: String], ["effort": "none"], ["effort": "medium"],
            ["effort": "low", "summary": "auto"], ["effort": 1], ["effort": true], ["effort": NSNull()]
        ]
        for value in malformed {
            var request = captureRequest(); request["reasoning"] = value
            do { _ = try await connection.analyseCapture(binding: astra, request: request); throw TestFailure.failed("invalid reasoning accepted") }
            catch let failure as ChatGPTFailure { try expect(failure == .unsupported, "wrong reasoning validation error") }
        }
        var spoofed = captureRequest(); spoofed["model"] = "gpt-6-astra"; spoofed["reasoning"] = ["effort": "low"]
        do { _ = try await connection.analyseCapture(binding: binding(box, id: id), request: spoofed); throw TestFailure.failed("supplied model bypassed pinned reasoning policy") }
        catch let failure as ChatGPTFailure { try expect(failure == .unsupported, "wrong unsupported-model error") }
        try expect(FakeProtocol.server.count(id) == 0 && FakeProtocol.server.analyses("Bearer old-access-" + id) == 0,
                   "invalid reasoning reached token refresh or inference")
        print("PASS exact Astra low and Luna none reasoning preserve pinned transport/schema/images and bounded diagnostics; other models omit tuning and malformed or spoofed options fail before HTTP")
    }
    static func captureDiagnosticFamilies() async throws {
        func request(version: Any?) -> [String: Any] {
            var value = captureRequest()
            var text = value["text"] as! [String: Any], format = text["format"] as! [String: Any]
            var schema = format["schema"] as! [String: Any]
            schema["properties"] = version.map { ["version": ["enum": $0]] } ?? [:]
            format["schema"] = schema; text["format"] = format; value["text"] = text
            return value
        }
        for version: Any in [[true], ["2"], [1, 2], [2, 2], [], [NSNull()], [2.5], "private-version"] {
            let metadata = ChatGPTCapturePolicy.diagnostics(request: request(version: version))
            try expect(metadata == ["promptVersion": "photo-instructions-2026-10-20-v1", "observationSchema": "photo_v1"],
                       "malformed schema version acquired a compact diagnostic family")
        }
        let cases: [(Any?, String, String)] = [
            (nil, "photo-instructions-2026-10-20-v1", "photo_v1"),
            ([1], "photo-instructions-2026-10-20-v1", "compact_photo_v1"),
            ([2], "photo-estimate-2026-10-20-v2", "compact_photo_v2"),
            ([3], "photo-estimate-2026-10-21-v4", "compact_photo_v3")
        ]
        for (index, item) in cases.enumerated() {
            let id = "diagnostic-family-\(index)", (connection, box) = make(["diagnostic-family-\(index)"], expired: false)
            let access = "Bearer old-access-" + id
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding: binding(box, id: id), request: request(version: item.0)) { reports.append($0) } }
            try await eventually("diagnostic family transport") { FakeProtocol.server.analyses(access) == 1 }
            FakeProtocol.server.releaseAnalysis(access, output: "{}")
            _ = try await task.value
            try expect(reports.count == 1 && reports[0]["promptVersion"] as? String == item.1 &&
                       reports[0]["observationSchema"] as? String == item.2, "transport recorded the wrong prompt/schema family")
        }
        print("PASS request schema selects fixed legacy/compact-v1/compact-v2/compact-v3 diagnostic families; malformed versions cannot copy arbitrary strings")
    }
    static func cancellationKeepsRotation() async throws {
        let id = "case1-A", (connection, box) = make(["case1-A"])
        connection.loadModels()
        try await eventually("case1 refresh starts") { FakeProtocol.server.count(id) == 1 }
        connection.cancel(); FakeProtocol.server.releaseRefresh(id)
        try await eventually("case1 replacement saved") { box.value.profiles[0].refreshToken == "new-refresh-" + id }
        try await settle()
        try expect(connection.result.isEmpty && connection.models.isEmpty && !connection.busy, "cancelled UI mutated")
        try expect(box.value.profiles[0].idToken == "previously-verified-" + id, "unvalidated refresh ID token accepted")
        try expect(FakeProtocol.server.modelCount("Bearer new-access-" + id) == 0, "cancelled UI fetched models")
        print("PASS cancellation during refresh preserves replacement and verified identity")
    }
    static func switchingSerializesPerClient() async throws {
        let a = "case2-A", b = "case2-B", (connection, box) = make(["case2-A", "case2-B"])
        connection.loadModels(); try await eventually("A refresh") { FakeProtocol.server.count(a) == 1 }
        connection.cancel(); connection.select(b); try await eventually("B refresh") { FakeProtocol.server.count(b) == 1 }
        connection.cancel(); connection.select(a); try await settle()
        try expect(FakeProtocol.server.count(a) == 1 && FakeProtocol.server.count(b) == 1, "duplicate rotating refresh started")
        FakeProtocol.server.releaseRefresh(b); FakeProtocol.server.releaseRefresh(a)
        try await eventually("both saved and selected models loaded") { box.value.profiles.allSatisfy { $0.refreshToken == "new-refresh-" + $0.id } && !connection.busy && !connection.models.isEmpty }
        try expect(connection.selectedID == a, "late task changed selected account")
        try expect(FakeProtocol.server.count(a) == 1 && FakeProtocol.server.count(b) == 1, "postcompletion duplicate refresh")
        try expect(FakeProtocol.server.modelCount("Bearer new-access-" + b) == 0, "cancelled B task fetched models")
        print("PASS A → B → A retains one refresh per client and selected account")
    }
    static func disconnectRevokesReplacement() async throws {
        let id = "case3-A", (connection, box) = make(["case3-A"])
        connection.loadModels(); try await eventually("case3 refresh") { FakeProtocol.server.count(id) == 1 }
        connection.disconnect()
        try expect(box.value.profiles[0].accessToken == nil && box.value.profiles[0].refreshToken == nil && box.value.profiles[0].idToken == nil, "disconnect did not synchronously clear vault")
        connection.cancel(); FakeProtocol.server.releaseRefresh(id)
        try await eventually("replacement revoked") { FakeProtocol.server.revocations(id) == ["new-refresh-" + id] }
        try await settle()
        try expect(box.value.profiles[0].refreshToken == nil && !connection.active!.connected, "late refresh reconnected account")
        try expect(connection.result.isEmpty && connection.models.isEmpty, "disconnect admitted late UI state")
        try expect(connection.revocationWarning == nil, "successful revoke warned")
        print("PASS disconnect clears immediately and revokes replacement after dismissal")
    }
    static func cancellationRejectsLateAnalysis() async throws {
        let id = "case4-A", (connection, _) = make(["case4-A"], expired: false)
        connection.loadModels(); try await eventually("case4 models") { !connection.busy && connection.canAnalyse }
        connection.analyse(jpeg: Data([0xff, 0xd8, 0xff, 0xd9]))
        let access = "Bearer old-access-" + id
        try await eventually("analysis starts") { FakeProtocol.server.analysisStarted(access) }
        connection.cancel(); FakeProtocol.server.releaseAnalysis(access); try await settle()
        try expect(connection.result.isEmpty && !connection.busy, "late analysis appeared after cancellation")
        print("PASS cancelled analysis cannot display late completion")
    }
    static func migrationAndExplicitSelection() async throws {
        let id = "case5-A", (connection, box) = make(["case5-A"], expired:false)
        let epoch = box.value.profiles[0].connectionID
        try expect(epoch != nil && box.saveCount == 1 && connection.cameraSelection == nil, "legacy migration or opt-in default changed")
        try expect(box.value.profiles[0].refreshToken == "old-" + id, "migration changed credentials")
        connection.loadModels(); try await eventually("case5 models") { connection.canAnalyse }
        try connection.enableCamera()
        let choice = connection.cameraSelection
        try expect(choice == binding(box, id:id), "camera not explicitly pinned")
        let restored = self.connection(box)
        try expect(restored.cameraSelection == choice && box.value.profiles[0].connectionID == epoch, "restart did not retain selection and epoch")
        let encoded = String(decoding:try JSONEncoder().encode(choice), as:UTF8.self)
        try expect(!encoded.contains("token") && !encoded.contains("old-access"), "binding serialized a credential")
        print("PASS legacy migration retains credentials; camera opt-in and binding persist without tokens")
    }
    static func concurrentCaptureIgnoresPreviewSwitch() async throws {
        let a = "case6-A", b = "case6-B", (connection, _) = make(["case6-A", "case6-B"], expired:false)
        connection.loadModels(); try await eventually("case6 models") { connection.canAnalyse }
        try connection.enableCamera(); let choice = connection.cameraSelection!
        let first = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        let second = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        let access = "Bearer old-access-" + a
        try await eventually("two captures") { FakeProtocol.server.analyses(access) == 2 }
        connection.cancel(); connection.select(b)
        try await eventually("case6 B selected") { connection.selectedID == b && !connection.busy }
        try expect(connection.cameraSelection?.profileID == b && connection.isCaptureBindingCurrent(choice), "shared account switch did not update only future camera photos")
        connection.selectModel("other-vision-model")
        try expect(connection.cameraSelection?.modelID == "other-vision-model", "shared model switch did not update future camera photos")
        for request in FakeProtocol.server.requests(access) {
            try expect(request["model"] as? String == choice.modelID && request["store"] as? Bool == false && request["stream"] as? Bool == true, "transport accepted routing override")
        }
        FakeProtocol.server.releaseAnalysis(access, output:"{\"type\":\"product\"}")
        let results = try await (first.value, second.value)
        try expect(results.0 == results.1 && results.0.contains("product"), "concurrent captures did not complete")
        try expect(FakeProtocol.server.analyses("Bearer old-access-" + b) == 0 && connection.result.isEmpty, "capture crossed account or preview result")
        print("PASS account/model selections update future photos while concurrent captures retain their pinned account/model")
    }
    static func combinedSetupReusesAuthorization() async throws {
        for expired in [false, true] {
            let id = expired ? "combined-expired" : "combined-ready", (connection, box) = make([expired ? "combined-expired" : "combined-ready"], expired: expired)
            connection.continueWithChatGPT()
            try expect(connection.cameraSelection == nil, "combined setup enabled camera before authorization/model readiness")
            if expired {
                try await eventually("combined saved grant refresh") { FakeProtocol.server.count(id) == 1 }
                FakeProtocol.server.releaseRefresh(id)
            }
            try await eventually("combined setup completes") { !connection.busy && connection.cameraSelection != nil }
            try expect(connection.canAnalyse && connection.cameraSelection == binding(box, id: id), "one action did not prepare both camera and preview")
            try expect(FakeProtocol.server.count(id) == (expired ? 1 : 0), "combined setup repeated authorization or refresh")
            let access = "Bearer " + (expired ? "new-access-" : "old-access-") + id
            let modelCalls = FakeProtocol.server.modelCount(access)
            try connection.disableCamera(); connection.continueWithChatGPT()
            try expect(connection.cameraSelection != nil && !connection.busy && FakeProtocol.server.modelCount(access) == modelCalls,
                       "ready saved connection required another model request or sign-in")
            let initial = connection.cameraSelection!
            connection.selectModel("other-vision-model")
            try expect(connection.cameraSelection?.modelID == "other-vision-model" && connection.isCaptureBindingCurrent(initial), "model choice invalidated queued binding")
            let restored = self.connection(box)
            restored.loadModels(); try await eventually("restored shared model") { restored.canAnalyse }
            try expect(restored.selectedModel == "other-vision-model" && restored.cameraSelection == connection.cameraSelection, "restart reset shared model to first catalogue entry")
        }
        print("PASS one action reuses saved authorization, waits for model readiness, and persists shared camera/preview model")
    }
    static func explicitOptOutAndLateSetup() async throws {
        let a = "optout-A", b = "optout-B", (connection, box) = make(["optout-A", "optout-B"], expired: false)
        connection.loadModels(); try await eventually("optout models") { connection.canAnalyse }
        try expect(connection.cameraSelection == nil, "ordinary model loading silently enabled camera")
        connection.continueWithChatGPT(); try await eventually("optout setup") { connection.cameraSelection != nil }
        try connection.disableCamera()
        connection.select(b); try await eventually("optout account switch") { !connection.busy && connection.selectedID == b }
        connection.selectModel("other-vision-model")
        connection.loadModels(); try await eventually("optout reload") { !connection.busy }
        try expect(connection.cameraSelection == nil && box.value.cameraSelection == nil, "account/model change or reload undid explicit opt-out")
        let restored = self.connection(box); restored.loadModels()
        try await eventually("optout restart") { restored.canAnalyse }
        try expect(restored.cameraSelection == nil, "restart silently migrated opt-out")
        for cancel in [false, true] {
            let access = "Bearer old-access-" + b, before = FakeProtocol.server.modelCount("Bearer old-access-" + b)
            let pending = self.connection(box)
            FakeProtocol.server.holdModels(access); pending.continueWithChatGPT()
            try await eventually("pending combined setup") { FakeProtocol.server.modelCount(access) == before + 1 }
            if cancel { pending.cancel() } else { try pending.disableCamera() }
            FakeProtocol.server.releaseModels(access); try await eventually("pending setup ends") { !pending.busy }
            try await settle()
            try expect(pending.cameraSelection == nil && box.value.cameraSelection == nil, "late setup crossed cancellation/opt-out fence")
        }
        try expect(box.value.profiles.first(where: { $0.id == a })?.refreshToken == "old-" + a, "opt-out changed other saved account")
        print("PASS explicit opt-out survives selection/loading/restart and wins over late setup; cancellation cannot enable camera")
    }
    static func sharedSelectionFailureIsAtomic() async throws {
        let a = "atomic-A", b = "atomic-B", (connection, box) = make(["atomic-A", "atomic-B"], expired: false)
        connection.continueWithChatGPT(); try await eventually("atomic setup") { connection.cameraSelection != nil }
        let choice = connection.cameraSelection, model = connection.selectedModel, available = connection.models
        let access = "Bearer old-access-" + b
        FakeProtocol.server.holdModels(access); connection.select(b)
        try await eventually("atomic candidate model request") { FakeProtocol.server.modelCount(access) == 1 }
        try expect(connection.selectedID == a && connection.cameraSelection == choice && connection.selectedModel == model, "pending switch prematurely changed shared selection")
        FakeProtocol.server.releaseModels(access, fail: true)
        try await eventually("atomic candidate fails") { !connection.busy }
        try expect(connection.selectedID == a && box.value.selectedID == a && connection.cameraSelection == choice && connection.models == available && connection.selectedModel == model, "failed catalogue request partially changed selection")
        box.failNextSave = true; connection.selectModel("other-vision-model")
        try expect(connection.selectedModel == model && connection.cameraSelection == choice && box.value.cameraSelection == choice, "failed model save changed displayed/persisted selection")
        box.failNextSave = true; connection.select(b)
        try await eventually("atomic account save fails") { !connection.busy }
        try expect(connection.selectedID == a && box.value.selectedID == a && connection.cameraSelection == choice && connection.models == available && connection.selectedModel == model, "failed account save partially changed selection")
        connection.selectModel("unknown-model")
        try expect(connection.selectedModel == model && connection.cameraSelection == choice, "unavailable model accepted")
        for profile in box.value.profiles { try expect(profile.refreshToken == "old-" + profile.id, "failed selection changed credential") }
        // Older releases allowed separate camera and preview accounts. Let the
        // user select the existing camera account to explicitly replace a removed
        // model, without first switching providers or signing in again.
        box.value.selectedID = b
        let legacy = self.connection(box); legacy.loadModels()
        try await eventually("legacy separate preview account") { legacy.canAnalyse }
        let previousModels = legacy.models, previousModel = legacy.selectedModel
        let oldAccess = "Bearer old-access-" + a
        for failSave in [true, false] {
            let previousCalls = FakeProtocol.server.modelCount(oldAccess)
            FakeProtocol.server.holdModels(oldAccess); legacy.select(a)
            try await eventually("legacy candidate catalogue") { FakeProtocol.server.modelCount(oldAccess) == previousCalls + 1 }
            box.failNextSave = failSave
            FakeProtocol.server.releaseModels(oldAccess, onlyModel: "other-vision-model")
            try await eventually("legacy candidate unavailable") { !legacy.busy }
            if failSave {
                try expect(legacy.selectedID == b && box.value.selectedID == b && legacy.models == previousModels && legacy.selectedModel == previousModel && legacy.cameraSelection == choice,
                           "failed legacy recovery save changed selected account or published candidate catalogue")
            } else {
                try expect(legacy.selectedID == a && box.value.selectedID == a && legacy.models.map(\.id) == ["other-vision-model"] && legacy.selectedModel == choice?.modelID && legacy.cameraSelection == choice && !legacy.canAnalyse,
                           "legacy recovery did not select existing camera account while retaining unavailable pinned model")
                try expect(legacy.message?.contains("Choose an available model") == true, "legacy recovery omitted actionable model selection guidance")
            }
        }
        legacy.selectModel("other-vision-model")
        try expect(legacy.canAnalyse && legacy.cameraSelection?.profileID == a && legacy.cameraSelection?.modelID == "other-vision-model" && legacy.isCaptureBindingCurrent(choice!),
                   "explicit legacy model repair rerouted or invalidated queued captures")
        print("PASS model/network/storage failures leave account, camera and preview selection atomic with credentials retained")
    }
    static func failedSetupAndUnavailableSavedModel() async throws {
        let id = "setup-failure", (connection, box) = make(["setup-failure"], expired: false)
        let access = "Bearer old-access-" + id
        FakeProtocol.server.holdModels(access); connection.continueWithChatGPT()
        try await eventually("combined failed setup request") { FakeProtocol.server.modelCount(access) == 1 }
        FakeProtocol.server.releaseModels(access, fail: true)
        try await eventually("combined failed setup settles") { !connection.busy }
        try expect(connection.cameraSelection == nil && box.value.cameraSelection == nil && connection.active?.connected == true, "failed setup enabled camera or lost reusable authorization")
        connection.continueWithChatGPT(); try await eventually("combined retry") { connection.cameraSelection != nil }
        let choice = connection.cameraSelection
        FakeProtocol.server.holdModels(access); connection.loadModels()
        try await eventually("changed catalogue request") { FakeProtocol.server.modelCount(access) == 3 }
        FakeProtocol.server.releaseModels(access, onlyModel: "other-vision-model")
        try await eventually("changed catalogue settles") { !connection.busy }
        try expect(connection.cameraSelection == choice && box.value.cameraSelection == choice && connection.selectedModel == choice?.modelID && !connection.canAnalyse, "catalogue removal silently replaced saved camera model")
        connection.selectModel("other-vision-model")
        try expect(connection.canAnalyse && connection.cameraSelection?.modelID == "other-vision-model" && connection.isCaptureBindingCurrent(choice!), "explicit replacement did not retain queued binding")
        try expect(FakeProtocol.server.count(id) == 0 && box.value.profiles[0].refreshToken == "old-" + id, "retry/model change repeated sign-in or changed authorization")
        print("PASS failed setup retains authorization for one-action retry; removed model requires explicit replacement without rerouting queued work")
    }
    static func captureCancellationSharesRefresh() async throws {
        let id = "case7-A", (connection, box) = make(["case7-A"])
        let choice = binding(box, id:id), epoch = box.value.profiles[0].connectionID
        let first = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        let second = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        connection.loadModels()
        try await eventually("case7 shared refresh") { FakeProtocol.server.count(id) == 1 }
        first.cancel(); connection.cancel(); try await settle()
        try expect(FakeProtocol.server.count(id) == 1, "concurrent capture/preview refreshed twice")
        FakeProtocol.server.releaseRefresh(id)
        let access = "Bearer new-access-" + id
        try await eventually("remaining capture submits") { FakeProtocol.server.analyses(access) == 1 }
        try expect(box.value.profiles[0].connectionID == epoch && connection.isCaptureBindingCurrent(choice), "refresh changed binding epoch")
        let cancelledError = await captureError(first)
        try expect(cancelledError is CancellationError, "cancelled capture returned a result")
        FakeProtocol.server.releaseAnalysis(access, output:"{}")
        let output = try await second.value
        try expect(output == "{}" && box.value.profiles[0].refreshToken == "new-refresh-" + id, "rotation or surviving capture lost")
        try expect(FakeProtocol.server.modelCount(access) == 0, "cancelled preview submitted models")
        print("PASS capture and preview share refresh; cancelled capture cannot discard rotation or cancel sibling")
    }
    static func disconnectCancelsCaptures() async throws {
        let id = "case8-A", (connection, box) = make(["case8-A"], expired:false)
        connection.loadModels(); try await eventually("case8 models") { connection.canAnalyse }
        try connection.enableCamera(); let choice = connection.cameraSelection!, access = "Bearer old-access-" + id
        let first = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        let second = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        try await eventually("case8 pending captures") { FakeProtocol.server.analyses(access) == 2 }
        connection.disconnect()
        try expect(box.value.profiles[0].refreshToken == nil && connection.cameraSelection == nil && !connection.isCaptureBindingCurrent(choice), "disconnect left local binding usable")
        let firstError = await captureError(first), secondError = await captureError(second)
        try expect(firstError as? ChatGPTFailure == .bindingChanged && secondError as? ChatGPTFailure == .bindingChanged, "disconnect did not reject both captures")
        FakeProtocol.server.releaseAnalysis(access, output:"late")
        try await eventually("case8 revoke") { FakeProtocol.server.revocations(id) == ["old-" + id] }
        print("PASS disconnect immediately invalidates camera selection and rejects all bound in-flight captures")
    }
    static func disconnectDuringCaptureRefresh() async throws {
        let id = "case9-A", (connection, box) = make(["case9-A"]), choice = binding(box, id:"case9-A")
        let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        try await eventually("case9 refresh") { FakeProtocol.server.count(id) == 1 }
        connection.disconnect(); FakeProtocol.server.releaseRefresh(id)
        try await eventually("case9 replacement revoke") { FakeProtocol.server.revocations(id) == ["new-refresh-" + id] }
        let error = await captureError(task)
        try expect(error as? ChatGPTFailure == .bindingChanged && box.value.profiles[0].refreshToken == nil, "late refresh revived capture")
        try expect(FakeProtocol.server.analyses("Bearer new-access-" + id) == 0, "disconnected capture submitted inference")
        print("PASS disconnect during capture refresh revokes replacement without sending inference")
    }
    static func disableOnlyAffectsFutureCaptures() async throws {
        let id = "case10-A", (connection, _) = make(["case10-A"], expired:false)
        connection.loadModels(); try await eventually("case10 models") { connection.canAnalyse }
        try connection.enableCamera(); let choice = connection.cameraSelection!, access = "Bearer old-access-" + id
        let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        try await eventually("case10 capture") { FakeProtocol.server.analyses(access) == 1 }
        try connection.disableCamera()
        try expect(connection.cameraSelection == nil && connection.isCaptureBindingCurrent(choice), "future selection toggle invalidated submitted capture")
        FakeProtocol.server.releaseAnalysis(access, output:"{}")
        let output = try await task.value
        try expect(output == "{}", "future selection toggle cancelled submitted capture")
        print("PASS disabling future ChatGPT camera use preserves submitted job binding")
    }
    static func rejectsUnsupportedAndStaleRequests() async throws {
        let id = "case11-A", (connection, box) = make(["case11-A"], expired:false), choice = binding(box, id:"case11-A")
        var audio = captureRequest(); audio["input"] = [["role":"user", "content":[["type":"input_audio", "input_audio":["data":"synthetic", "format":"wav"]]]]]
        do { _ = try await connection.analyseCapture(binding:choice, request:audio); throw TestFailure.failed("audio accepted") }
        catch let failure as ChatGPTFailure { try expect(failure == .unsupported, "wrong unsupported error") }
        var tools = captureRequest(); tools["tools"] = [["type":"web_search"]]
        do { _ = try await connection.analyseCapture(binding:choice, request:tools); throw TestFailure.failed("tools accepted") }
        catch let failure as ChatGPTFailure { try expect(failure == .unsupported, "wrong tool error") }
        var outputLimit = captureRequest(); outputLimit["max_output_tokens"] = 8192
        do { _ = try await connection.analyseCapture(binding:choice, request:outputLimit); throw TestFailure.failed("unsupported output limit accepted") }
        catch let failure as ChatGPTFailure { try expect(failure == .unsupported, "wrong output limit error") }
        box.value.profiles[0].connectionID = UUID()
        let reconnected = self.connection(box)
        do { _ = try await reconnected.analyseCapture(binding:choice, request:captureRequest()); throw TestFailure.failed("stale binding accepted") }
        catch let failure as ChatGPTFailure { try expect(failure == .bindingChanged, "wrong epoch error") }
        try expect(FakeProtocol.server.analyses("Bearer old-access-" + id) == 0, "invalid request reached inference")
        print("PASS audio/tools/output limits and stale registration epochs fail before HTTP without fallback")
    }
    static func temporaryFailureRetainsSelection() async throws {
        let id = "case12-A", (connection, box) = make(["case12-A"], expired:false)
        connection.loadModels(); try await eventually("case12 models") { connection.canAnalyse }
        try connection.enableCamera(); let choice = connection.cameraSelection!, access = "Bearer old-access-" + id
        let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        try await eventually("case12 inference") { FakeProtocol.server.analyses(access) == 1 }
        FakeProtocol.server.failAnalysis(access, code:"subscription_sharing_usage_unavailable", status:503)
        let error = await captureError(task)
        try expect(error as? ChatGPTFailure == .transient, "temporary usage failure treated as a limit or invalid grant")
        try expect(connection.cameraSelection == choice && connection.isCaptureBindingCurrent(choice) && box.value.profiles[0].refreshToken == "old-" + id, "temporary failure discarded choice or credentials")
        try await settle()
        try expect(FakeProtocol.server.analyses(access) == 1, "transport automatically retried paid inference")
        print("PASS temporary usage failure retains selection and credentials without automatic inference retry")
    }
    static func expiredGrantKeepsStaleChoice() async throws {
        let id = "case13-A", (_, box) = make(["case13-A"]), choice = binding(box, id:"case13-A")
        box.value.cameraSelection = choice
        let connection = self.connection(box)
        let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) }
        try await eventually("case13 refresh") { FakeProtocol.server.count(id) == 1 }
        FakeProtocol.server.failRefresh(id, code:"invalid_grant")
        let error = await captureError(task)
        try expect(error as? ChatGPTFailure == .bindingChanged && !connection.isCaptureBindingCurrent(choice), "invalid grant remained usable")
        try expect(connection.cameraSelection == choice && box.value.cameraSelection == choice, "expired grant silently switched camera to Nudge")
        try expect(box.value.profiles[0].refreshToken == nil && box.value.profiles[0].accessToken == nil, "terminal invalid grant not cleared")
        try expect(FakeProtocol.server.analyses("Bearer old-access-" + id) == 0, "invalid grant sent inference")
        print("PASS terminal invalid grant clears unusable credentials but retains stale camera choice without fallback")
    }
    static func unreadableSelectionFailsClosed() throws {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [FakeProtocol.self]
        let session = URLSession(configuration: config)
        var unreadableWrites = 0
        let unreadable = ChatGPTConnection(session:session, loadVault:{ throw ChatGPTFailure.storage }, saveVault:{ _ in unreadableWrites += 1 })
        func storageFailure(_ action: () throws -> Void) throws {
            do { try action(); throw TestFailure.failed("unreadable preference accepted") }
            catch let failure as ChatGPTFailure { try expect(failure == .storage, "wrong preference storage error") }
        }
        try storageFailure { _ = try unreadable.cameraSelectionForCapture() }
        try storageFailure { try unreadable.disableCamera() }
        try storageFailure { try unreadable.enableCamera() }
        try expect(unreadableWrites == 0, "unreadable vault was overwritten")

        var legacy = ChatGPTVault(); legacy.selectedID = "case14-A"
        legacy.profiles = [ChatGPTProfile(clientID:"case14-A", subject:"subject-case14-A", email:nil, accessToken:"synthetic-access", refreshToken:"synthetic-refresh", idToken:"synthetic-verified", expiresAt:Date().addingTimeInterval(3600), scopes:["resource.invoke", "chatgpt.tokens.use.direct"])]
        let before = try JSONEncoder().encode(legacy)
        var failedWrites = 0
        let failedMigration = ChatGPTConnection(session:session, loadVault:{ legacy }, saveVault:{ _ in failedWrites += 1; throw ChatGPTFailure.storage })
        try storageFailure { _ = try failedMigration.cameraSelectionForCapture() }
        try storageFailure { try failedMigration.disableCamera() }
        try expect(failedWrites == 1 && legacy.profiles[0].connectionID == nil, "failed migration retried a destructive save")
        let original = try JSONDecoder().decode(ChatGPTVault.self, from:before)
        try expect(legacy.profiles[0].refreshToken == original.profiles[0].refreshToken, "failed migration changed persisted credentials")
        print("PASS unreadable vault and failed migration block provider selection and cannot overwrite saved credentials")
    }
    static func terminalUsageSurvivesRejectedOutput() async throws {
        for (index, scenario) in ["completed", "empty", "refused", "incomplete", "failed", "missing", "duplicate", "http"].enumerated() {
            let id = "case15-\(index)", (connection, box) = make(["case15-\(index)"], expired: false)
            let choice = binding(box, id:id), access = "Bearer old-access-" + id, diagnosticID = UUID()
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding: choice, request: captureRequest(), diagnosticID: diagnosticID) { reports.append($0) } }
            try await eventually("terminal usage starts \(scenario)") { FakeProtocol.server.analyses(access) == 1 }
            let outcome = ["incomplete", "failed"].contains(scenario) ? scenario : "completed"
            var response: [String: Any] = ["status": outcome, "model": "gpt-4.1-mini-2025-04-14",
                "output": [["content": [["type": scenario == "refused" ? "refusal" : "output_text", "text": scenario == "empty" ? "" : "{}", "refusal": "private refusal"]]]],
                "usage": ["input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
                    "input_tokens_details": ["cached_tokens": 30, "cache_write_tokens": 0], "output_tokens_details": ["reasoning_tokens": 7]],
                "privateAccount": "private account"]
            if scenario == "missing" { response.removeValue(forKey: "usage") }
            let event: [String: Any] = ["type": "response." + outcome, "response": response]
            if scenario == "http" { FakeProtocol.server.failAnalysis(access, code: "subscription_sharing_usage_unavailable", status: 503) }
            else { FakeProtocol.server.releaseEvents(access, events: scenario == "duplicate" ? [event, event] : [event]) }
            let error = await captureError(task)
            try expect(["completed", "missing"].contains(scenario) ? error == nil : error is ChatGPTFailure, "usage changed output acceptance for \(scenario)")
            try expect(reports.count == 1, "usage must emit once even when parser throws")
            let report = reports[0]
            try expect(report["model"] as? String == choice.modelID && report["requestId"] as? String == diagnosticID.uuidString && report["attemptId"] as? String == diagnosticID.uuidString, "usage lost selection/correlation")
            try expect(report["promptVersion"] as? String == "photo-instructions-2026-10-20-v1" && report["providerRequestId"] as? String == "req_synthetic_lifecycle", "missing bounded prompt/provider evidence")
            if ["missing", "duplicate", "http"].contains(scenario) {
                try expect(report["usageStatus"] as? String == "unavailable" && report["inputTokens"] == nil, "unknown usage became zero or borrowed counts")
            } else {
                try expect(report["providerOutcome"] as? String == outcome && report["inputTokens"] as? Int == 100 && report["cacheWriteTokens"] as? Int == 0 && report["reasoningTokens"] as? Int == 7, "failed terminal lost reported usage")
                try expect(report["reportedModel"] as? String == "gpt-4.1-mini-2025-04-14", "reported model replaced by selection")
            }
            let encoded = try JSONSerialization.data(withJSONObject: report)
            try expect(!String(decoding: encoded, as: UTF8.self).contains("private"), "usage leaked provider content")
            try expect(FakeProtocol.server.analyses(access) == 1 && box.value.profiles[0].refreshToken == "old-" + id, "usage triggered retry or changed credential")
        }
        print("PASS terminal usage survives refusal/incomplete/failure/invalid text once, with missing and HTTP usage unknown")
    }
    static func cancelledOrDisconnectedUsageIsSuppressed() async throws {
        for disconnect in [false, true] {
            let id = disconnect ? "case16-disconnect" : "case16-cancel", (connection, box) = make([id], expired: false)
            let choice = binding(box, id:id), access = "Bearer old-access-" + id
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) { reports.append($0) } }
            try await eventually("usage cancellation starts") { FakeProtocol.server.analyses(access) == 1 }
            if disconnect { connection.disconnect() } else { task.cancel() }
            FakeProtocol.server.releaseAnalysis(access, output: "{}")
            let error = await captureError(task); try await settle()
            try expect(error != nil && reports.isEmpty, "cancelled or stale account emitted late usage callback")
        }
        print("PASS cancellation and account disconnect suppress late usage callbacks and results")
    }
    static func transportResponseDiagnostics() async throws {
        let completed = #"{"status":"completed","output":[{"content":[{"type":"output_text","text":"{}"}]}]}"#
        let cases: [(String, String, String?, String, String, ChatGPTFailure?)] = [
            ("json", #"{"status":"completed","output_text":"private food","usage":{"input_tokens":123}}"#, "application/json", "json", "unexpected_response_format", .incomplete),
            ("interrupted", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"private food\"}\n\n", "text/event-stream", "sse", "missing_terminal", .incomplete),
            ("named-cr", "\u{feff}: heartbeat\r\revent: response.completed\rdata: {\"response\":" + completed + "}\r\r", "text/event-stream; charset=utf-8", "sse", "none", nil),
            ("conflict", "event: response.failed\ndata: {\"type\":\"response.completed\",\"response\":" + completed + "}\n\n", "text/event-stream", "sse", "event_name_mismatch", .incomplete),
            ("unknown-code", "data: {\"type\":\"error\",\"code\":\"private unknown code\",\"message\":\"private message\"}\n\n", "text/event-stream", "sse", "provider_error", .incomplete),
            ("unsupported", "data: {\"type\":\"error\",\"code\":\"subscription_sharing_unsupported_capability\",\"message\":\"private message\"}\n\n", "text/event-stream", "sse", "provider_error", .unsupported),
            ("missing-header", "private response", nil, "missing", "missing_terminal", .incomplete)
        ]
        for (index, scenario) in cases.enumerated() {
            let (name, raw, contentType, format, parseFailure, expectedError) = scenario
            let id = "case17-\(index)", (connection, box) = make(["case17-\(index)"], expired:false)
            let choice = binding(box, id:id), access = "Bearer old-access-" + id, data = Data(raw.utf8)
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) { reports.append($0) } }
            try await eventually("diagnostic transport \(name)") { FakeProtocol.server.analyses(access) == 1 }
            FakeProtocol.server.releaseRawAnalysis(access, data:data, type:contentType)
            let error = await captureError(task)
            try expect(error as? ChatGPTFailure == expectedError && (expectedError != nil || error == nil), "response acceptance changed for \(name)")
            try expect(reports.count == 1, "diagnostics callback missing or duplicated for \(name)")
            let report = reports[0]
            try expect(report["responseFormat"] as? String == format && report["parseFailure"] as? String == parseFailure && report["responseBytes"] as? Int == data.count, "response shape diagnostics incorrect for \(name)")
            for key in ["authorizationMs", "responseHeadersMs", "downloadMs", "networkMs", "nativeElapsedMs"] {
                try expect((report[key] as? Int).map { (0...600_000).contains($0) } == true, "missing bounded timing \(key) for \(name)")
            }
            try expect((report["networkMs"] as! Int) >= (report["responseHeadersMs"] as! Int) && (report["nativeElapsedMs"] as! Int) >= (report["networkMs"] as! Int), "timings out of order for \(name)")
            if name == "interrupted" { try expect(report["streamTerminalCount"] as? Int == 0 && report["streamTextDeltaCount"] as? Int == 1, "interrupted stream lost event counts") }
            if name == "named-cr" { try expect(report["providerOutcome"] as? String == "completed" && report["streamTerminalCount"] as? Int == 1, "named CR terminal lost usage outcome") }
            if name == "unsupported" { try expect(report["providerErrorCode"] as? String == "subscription_sharing_unsupported_capability", "documented capability error not retained") }
            if name == "unknown-code" { try expect(report["providerErrorCode"] == nil, "unknown private code retained") }
            let text = String(decoding:try JSONSerialization.data(withJSONObject:report), as:UTF8.self)
            try expect(!text.contains("private") && !text.contains("Bearer") && !text.contains("old-access") && !text.contains("output_text"), "private response or credential diagnostic leakage")
            try expect(FakeProtocol.server.analyses(access) == 1 && box.value.profiles[0].refreshToken == "old-" + id, "diagnostic response changed credentials or retried inference")
        }
        print("PASS transport records safe format/rejection/count/timing diagnostics for JSON, interrupted/named/conflicting SSE, errors and missing headers")
    }
    static func missingHeaderStillRequiresCompletedSSE() async throws {
        func event(_ type: String, _ fields: [String: Any]) throws -> String {
            var item = fields; item["type"] = type
            return "event: " + type + "\ndata: " + String(decoding:try JSONSerialization.data(withJSONObject:item), as:UTF8.self) + "\n\n"
        }
        let output = "{\"synthetic\":\"" + String(repeating:"x",count:80_000) + "\"}"
        let part: [String: Any] = ["type":"output_text", "text":output]
        let message: [String: Any] = ["id":"msg_synthetic", "type":"message", "role":"assistant", "status":"completed", "content":[part]]
        let usage: [String: Any] = ["input_tokens":100, "output_tokens":20, "total_tokens":120]
        let response: [String: Any] = ["status":"completed", "model":"gpt-6-astra", "output":[message], "usage":usage]
        let terminal = try event("response.completed", ["response":response])
        var prefix = try event("response.created", ["response":["status":"in_progress"]])
        let bytes = Array(output.utf8)
        for start in stride(from:0, to:bytes.count, by:800) {
            prefix += try event("response.output_text.delta", ["delta":String(decoding:bytes[start..<min(start + 800,bytes.count)], as:UTF8.self)])
        }
        prefix += try event("response.output_text.done", ["text":output])
        prefix += try event("response.content_part.done", ["part":part])
        prefix += try event("response.output_item.done", ["output_index":0, "item":message])
        let completed = Data((prefix + terminal + "data: [DONE]\n\n").utf8)
        var absentOutput = response; absentOutput.removeValue(forKey:"output")
        var emptyOutput = response; emptyOutput["output"] = [] as [Any]
        let itemCompleted = Data((prefix + (try event("response.completed", ["response":absentOutput]))).utf8)
        let itemCompletedEmpty = Data((prefix + (try event("response.completed", ["response":emptyOutput]))).utf8)
        try expect(completed.count > 400_000 && completed.count < 500_000, "synthetic stream no longer represents observed response size")
        let refusal = try event("response.completed", ["response":["status":"completed", "output":[["content":[["type":"refusal","refusal":"private refusal"]]]], "usage":usage]])
        let failed = try event("response.failed", ["response":["status":"failed", "error":["code":"server_error","message":"private failure"], "usage":usage]])
        let cases: [(String, Data, String?, Int, String, ChatGPTFailure?)] = [
            ("complete", completed, nil, 200, "none", nil),
            ("item-absent", itemCompleted, nil, 200, "none", nil),
            ("item-empty", itemCompletedEmpty, nil, 200, "none", nil),
            ("item-explicit-sse", itemCompleted, "text/event-stream", 200, "none", nil),
            ("truncated", Data(prefix.utf8), nil, 200, "missing_terminal", .incomplete),
            ("refused", Data(refusal.utf8), nil, 200, "refused", .refused),
            ("duplicate", Data((terminal + terminal).utf8), nil, 200, "multiple_terminal", .incomplete),
            ("failed", Data(failed.utf8), nil, 200, "provider_error", .incomplete),
            ("json", Data(#"{"status":"completed","output_text":"private JSON"}"#.utf8), nil, 200, "missing_terminal", .incomplete),
            ("html", Data("<html><body>private HTML</body></html>".utf8), nil, 200, "missing_terminal", .incomplete),
            ("empty", Data(), nil, 200, "missing_terminal", .incomplete),
            ("explicit-json", completed, "application/json", 200, "unexpected_response_format", .incomplete),
            ("explicit-other", completed, "text/html", 200, "unexpected_response_format", .incomplete),
            ("http-error", completed, nil, 503, "none", .transient)
        ]
        for (index, scenario) in cases.enumerated() {
            let (name, data, contentType, status, expectedParse, expectedError) = scenario
            let id = "case18-\(index)", (connection, box) = make(["case18-\(index)"], expired:false)
            let choice = binding(box,id:id), access = "Bearer old-access-" + id
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) { reports.append($0) } }
            try await eventually("headerless \(name)") { FakeProtocol.server.analyses(access) == 1 }
            FakeProtocol.server.releaseRawAnalysis(access, data:data, type:contentType, status:status)
            if let expectedError { let error = await captureError(task); try expect(error as? ChatGPTFailure == expectedError, "headerless rejection changed for \(name)") }
            else { let text = try await task.value; try expect(text == output, "headerless completed output changed") }
            try expect(reports.count == 1, "headerless usage callback duplicated/missing for \(name)")
            let report = reports[0]
            try expect(report["responseFormat"] as? String == ChatGPTStreamResult.responseFormat(contentType) && report["parseFailure"] as? String == expectedParse, "headerless diagnostics incorrect for \(name)")
            if name.hasPrefix("item-") {
                try expect(report["finalOutputTextCount"] as? Int == 0 && report["streamOutputItemDoneCount"] as? Int == 1 && report["completedItemTextCount"] as? Int == 1 && report["finalOutputSource"] as? String == "output_item", "completed item source diagnostics incorrect for \(name)")
            }
            if ["complete","item-absent","item-empty","item-explicit-sse","refused","failed"].contains(name) {
                try expect(report["inputTokens"] as? Int == 100 && report["outputTokens"] as? Int == 20 && report["usageStatus"] as? String == "partial", "headerless terminal lost reported usage for \(name)")
            } else { try expect(report["usageStatus"] as? String == "unavailable" && report["inputTokens"] == nil, "headerless rejected response fabricated/borrowed usage for \(name)") }
            let logged = String(decoding:try JSONSerialization.data(withJSONObject:report), as:UTF8.self)
            try expect(!logged.contains("private") && !logged.contains(String(repeating:"x",count:64)) && !logged.contains("Bearer") && !logged.contains("old-access"), "headerless diagnostic leaked response or credential")
            try expect(FakeProtocol.server.analyses(access) == 1 && box.value.profiles[0].refreshToken == "old-" + id, "headerless handling retried or changed credentials")
        }
        for disconnect in [false,true] {
            let id = disconnect ? "case18-disconnect" : "case18-cancel", (connection,box) = make([disconnect ? "case18-disconnect" : "case18-cancel"], expired:false)
            let choice = binding(box,id:id), access = "Bearer old-access-" + id
            var reports: [[String: Any]] = []
            let task = Task { try await connection.analyseCapture(binding:choice, request:captureRequest()) { reports.append($0) } }
            try await eventually("headerless late callback") { FakeProtocol.server.analyses(access) == 1 }
            if disconnect { connection.disconnect() } else { task.cancel() }
            FakeProtocol.server.releaseRawAnalysis(access,data:itemCompleted,type:nil)
            let error = await captureError(task); try await settle()
            try expect(error != nil && reports.isEmpty, "headerless response crossed cancellation/account fence")
        }
        print("PASS missing header admits only completed strict SSE, preserves usage, rejects interrupted/refused/duplicate/failed/JSON/HTML/HTTP-error bodies and retains cancellation/account fences")
    }
    static func main() async {
        do {
            try await cancellationKeepsRotation()
            try await switchingSerializesPerClient()
            try await disconnectRevokesReplacement()
            try await cancellationRejectsLateAnalysis()
            try await migrationAndExplicitSelection()
            try await concurrentCaptureIgnoresPreviewSwitch()
            try await combinedSetupReusesAuthorization()
            try await explicitOptOutAndLateSetup()
            try await sharedSelectionFailureIsAtomic()
            try await failedSetupAndUnavailableSavedModel()
            try await captureCancellationSharesRefresh()
            try await disconnectCancelsCaptures()
            try await disconnectDuringCaptureRefresh()
            try await disableOnlyAffectsFutureCaptures()
            try await rejectsUnsupportedAndStaleRequests()
            try await temporaryFailureRetainsSelection()
            try await expiredGrantKeepsStaleChoice()
            try unreadableSelectionFailsClosed()
            try await terminalUsageSurvivesRejectedOutput()
            try await cancelledOrDisconnectedUsageIsSuppressed()
            try await transportResponseDiagnostics()
            try await missingHeaderStillRequiresCompletedSSE()
            try await captureReasoningPolicy()
            try await captureDiagnosticFamilies()
            try expect(FakeProtocol.server.errors().isEmpty, "unexpected mock request: \(FakeProtocol.server.errors())")
            print("PASS all 24 lifecycle scenarios; all HTTP intercepted; no browser, live network, or Keychain calls")
        } catch { print("FAIL \(error)"); exit(1) }
    }
}
