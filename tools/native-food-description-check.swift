import Foundation

// Environment adapters are deliberately inert. Tests inject synthetic auth and
// intercepted HTTP; production transport and byte bounds are compiled unchanged.
struct PhotoAnalysisPermission { let allowed = false }
enum BackendCredentialStore { static func configuration() -> BackendConfiguration? { nil } }
@MainActor final class NudgeAccountManager {
    static let shared = NudgeAccountManager()
    var revision = 0
    struct Account { let backendURL: URL; let token: String }
    func authorization() async throws -> Account? { nil }
}

final class DescriptionHTTP: URLProtocol, @unchecked Sendable {
    static var status = 200
    static var body = Data()
    static var seen: [URLRequest] = []
    static var bodies: [Data] = []
    static var suspend = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen.append(request)
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var chunk = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&chunk, maxLength: chunk.count)
                if count <= 0 { break }
                body.append(contentsOf: chunk.prefix(count))
            }
        }
        Self.bodies.append(body)
        if Self.suspend { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status,
                                       httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct DescriptionChecks {
    static var checks = 0
    static func check(_ ok: @autoclosure () -> Bool, _ label: String) {
        checks += 1
        if !ok() { fatalError("Food description check failed: " + label) }
    }
    static func expectFailure(_ expected: NativeFoodDescriptionService.Failure,
                              _ operation: () async throws -> [String: Any]) async {
        do { _ = try await operation(); check(false, "expected failure") }
        catch let failure as NativeFoodDescriptionService.Failure {
            check(failure.localizedDescription == expected.localizedDescription, "friendly failure mapping")
        } catch { check(false, "unexpected failure type") }
    }
    static func expectCancellation(_ operation: () async throws -> [String: Any]) async {
        do { _ = try await operation(); check(false, "expected cancellation") }
        catch is CancellationError { check(true, "cancelled") }
        catch { check(false, "unexpected cancellation failure") }
    }
    static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DescriptionHTTP.self]
        let session = URLSession(configuration: config, delegate: LabelSessionDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let requestID = UUID(), text = "A serving of vegetable curry"
        let id = requestID.uuidString.lowercased()
        let base = URL(string: "https://unit.invalid")!
        var authCalls = 0
        var service = NativeFoodDescriptionService(session: session, analysisAllowed: { true }, authorize: {
            authCalls += 1
            return .init(baseURL: base, token: "synthetic-token")
        })
        let analyse = { try await service.analyse(description: text, requestID: requestID) }
        DescriptionHTTP.body = try JSONSerialization.data(withJSONObject: ["version": 1, "requestId": id, "entry": [:]])
        _ = try await analyse()
        check(DescriptionHTTP.seen.count == 1, "one request")
        let request = DescriptionHTTP.seen[0]
        check(request.url?.absoluteString == "https://unit.invalid/v1/food-description/analyse", "fixed endpoint")
        check(request.httpMethod == "POST", "POST")
        check(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token", "request scoped auth")
        check(request.value(forHTTPHeaderField: "Content-Type") == "application/json", "JSON type")
        let sent = try JSONSerialization.jsonObject(with: DescriptionHTTP.bodies[0]) as! [String: String]
        check(Set(sent.keys) == Set(["description", "requestId"]), "no diary/profile/photos exported")
        check(sent["description"] == text && sent["requestId"] == id, "matching input identity")
        let originalRequests = DescriptionHTTP.seen.count, originalAuth = authCalls
        for invalid in ["", "a", String(repeating: "a", count: 2001), "food\u{0000}text"] {
            await expectFailure(.invalidDescription) { try await service.analyse(description: invalid, requestID: requestID) }
        }
        check(DescriptionHTTP.seen.count == originalRequests && authCalls == originalAuth, "invalid inputs never authorise or transmit")
        var disabled = service; disabled.analysisAllowed = { false }
        await expectFailure(.permission) { try await disabled.analyse(description: text, requestID: requestID) }
        check(authCalls == originalAuth, "permission checked before auth")
        var stale = service
        stale.authorize = { .init(baseURL: base, token: "synthetic-token", isCurrent: { false }) }
        await expectCancellation { try await stale.analyse(description: text, requestID: requestID) }
        check(DescriptionHTTP.seen.count == originalRequests, "stale account never transmits")
        var checksOfRevision = 0
        stale.authorize = { .init(baseURL: base, token: "synthetic-token", isCurrent: {
            checksOfRevision += 1; return checksOfRevision == 1
        }) }
        await expectCancellation { try await stale.analyse(description: text, requestID: requestID) }
        check(checksOfRevision == 2, "account change rejects returned result")
        for (status, expected) in [(401, NativeFoodDescriptionService.Failure.signIn), (403, .signIn), (429, .limited), (422, .unresolved), (500, .unavailable), (302, .unavailable)] {
            DescriptionHTTP.status = status
            DescriptionHTTP.body = Data("private upstream error that must not appear".utf8)
            await expectFailure(expected, analyse)
        }
        DescriptionHTTP.status = 200
        DescriptionHTTP.body = try JSONSerialization.data(withJSONObject: ["version": 1, "requestId": UUID().uuidString, "entry": [:]])
        await expectFailure(.invalidResponse, analyse)
        DescriptionHTTP.body = Data(repeating: 97, count: 65_537)
        await expectFailure(.unavailable, analyse)
        DescriptionHTTP.suspend = true
        let task = Task { try await service.analyse(description: text, requestID: requestID) }
        try await Task.sleep(for: .milliseconds(30))
        task.cancel()
        await expectCancellation { try await task.value }
        DescriptionHTTP.suspend = false
        var insecure = service
        insecure.authorize = { .init(baseURL: URL(string: "http://unit.invalid")!, token: "synthetic-token") }
        let countBeforeInsecure = DescriptionHTTP.seen.count
        await expectFailure(.unavailable) { try await insecure.analyse(description: text, requestID: requestID) }
        check(DescriptionHTTP.seen.count == countBeforeInsecure, "non-HTTPS never transmits")
        let productionConfig = NativeFoodDescriptionService.session.configuration
        check(productionConfig.urlCache == nil && productionConfig.httpCookieStorage == nil && productionConfig.urlCredentialStorage == nil,
              "no durable HTTP cache or shared credentials")
        check(productionConfig.timeoutIntervalForRequest == 10 && productionConfig.timeoutIntervalForResource == 12, "bounded wait")
        print("DESCRIPTION_CHECK_RESULT {\"checks\":\(checks),\"groups\":[\"private transport\",\"validation\",\"account and permission\",\"failure mapping\",\"bounds and cancellation\"]}")
    }
}
