import XCTest
import UIKit
@testable import Nudge

/// Every manager in this suite uses memory credentials and a fake transport.
/// There is no reference to .shared, KeychainAccountSessionStore or URLSession.
/// Scheduling waits allow simulator startup/load; they do not test network latency.
@MainActor final class AccountFeatureTests: XCTestCase {
    private let instant = Date(timeIntervalSince1970: 1_800_000_000)
    private let provider = URL(string: "https://nudge-test-project.supabase.co")!
    private let userID = "11111111-2222-4333-8444-555555555555"
    private let address = "person@example.test"

    private final class MemoryStore: AccountSessionStore {
        var value: AccountSession?
        var failLoad = false
        var failSave = false
        var failClear = false
        var saves = 0
        var clears = 0
        // Represents unrelated data. The account store exposes no way to edit it.
        let unrelated = ["diary": "ManiLife 30 g; 185.7 kcal; 7.9 g protein", "privateOwner": "unchanged"]
        init(_ value: AccountSession? = nil) { self.value = value }
        func load() throws -> AccountSession? { if failLoad { throw AccountError.storage }; return value }
        func save(_ session: AccountSession) throws {
            if failSave { throw AccountError.storage }
            value = session; saves += 1
        }
        func clear() throws {
            if failClear { throw AccountError.storage }
            value = nil; clears += 1
        }
    }

    private final class FakeTransport: AccountHTTPTransport {
        var requests: [URLRequest] = []
        var limits: [Int] = []
        var handler: (URLRequest) async throws -> AccountHTTPResponse
        init(_ handler: @escaping (URLRequest) async throws -> AccountHTTPResponse) { self.handler = handler }
        func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse {
            requests.append(request); limits.append(maximumBytes)
            return try await handler(request)
        }
    }

    private func response(_ object: [String: Any], status: Int = 200) throws -> AccountHTTPResponse {
        AccountHTTPResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: object))
    }

    private func config(deletion: Bool = true) throws -> AccountHTTPResponse {
        try response(["enabled": true, "provider": "supabase", "url": provider.absoluteString,
                      "publishableKey": "sb_publishable_test_public_key_only", "deletionAvailable": deletion])
    }

    private func selected(expired: Bool = false) -> AccountSession {
        AccountSession(accessToken: "header.old.signature", refreshToken: "old_refresh_token",
                       expiresAt: instant.addingTimeInterval(expired ? -10 : 3_600), userID: userID,
                       email: address, providerURL: provider)
    }

    private func providerSession(email: String? = nil, token: String = "header.new.signature") throws -> AccountHTTPResponse {
        try response(["access_token": token, "refresh_token": "new_refresh_token", "token_type": "bearer",
                      "expires_in": 3_600, "expires_at": instant.timeIntervalSince1970 + 3_600,
                      "user": ["id": userID, "email": email ?? address]])
    }

    private func assertThrows(_ expected: AccountError? = nil, _ operation: () async throws -> Void,
                              file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected an account failure", file: file, line: line) }
        catch {
            if let expected { XCTAssertEqual(error as? AccountError, expected, file: file, line: line) }
        }
    }

    func testDisabledConfigurationIsGenuineUnavailableAndNoSessionReturnsNil() async throws {
        let store = MemoryStore()
        let network = FakeTransport { _ in try self.response(["enabled": false]) }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        let authorization = try await manager.authorization()
        XCTAssertNil(authorization)
        XCTAssertTrue(network.requests.isEmpty)
        try await manager.loadConfiguration()
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "unavailable")
        XCTAssertEqual(manager.publicStatus()["available"] as? Bool, false)
        await assertThrows(.unavailable) { try await manager.sendCode(email: self.address) }
        XCTAssertEqual(network.requests.count, 1)
        XCTAssertEqual(network.requests[0].url?.path, "/v1/account/config")
        XCTAssertNil(network.requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(store.saves, 0)
    }

    func testInvalidConfigurationNeverReceivesCredentialsOrOTP() async throws {
        let badConfigurations: [[String: Any]] = [
            ["url": "http://nudge-test-project.supabase.co", "publishableKey": "sb_publishable_test_public_key_only"],
            ["url": "https://nudge-test-project.supabase.co.attacker.test", "publishableKey": "sb_publishable_test_public_key_only"],
            ["url": "https://user@nudge-test-project.supabase.co", "publishableKey": "sb_publishable_test_public_key_only"],
            ["url": "https://nudge-test-project.supabase.co/auth", "publishableKey": "sb_publishable_test_public_key_only"],
            ["url": provider.absoluteString, "publishableKey": "sb_secret_never_accept_server_secret"]
        ]
        for bad in badConfigurations {
            let network = FakeTransport { _ in try self.response(bad.merging(["enabled": true, "provider": "supabase", "deletionAvailable": true]) { old, _ in old }) }
            let manager = NudgeAccountManager(store: MemoryStore(selected()), transport: network, now: { self.instant })
            await assertThrows(.invalidResponse) { _ = try await manager.authorization() }
            XCTAssertEqual(network.requests.count, 1)
            XCTAssertEqual(network.requests[0].url?.host, NudgeAccountManager.backendURL.host)
            XCTAssertNil(network.requests[0].value(forHTTPHeaderField: "Authorization"))
        }
    }

    func testCodeRequestAndVerificationUseDocumentedRESTAndOnlyVerifiedIdentitySignsIn() async throws {
        let store = MemoryStore()
        let network = FakeTransport { request in
            switch request.url?.path {
            case "/v1/account/config": return try self.config()
            case "/auth/v1/otp": return try self.response([:])
            case "/auth/v1/verify": return try self.providerSession()
            default: throw AccountError.invalidResponse
            }
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        try await manager.loadConfiguration()
        try await manager.sendCode(email: "  \(address)  ")
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedOut")
        XCTAssertNil(store.value)
        XCTAssertEqual(manager.pendingEmail, address)
        try await manager.verifyCode("123456")
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedIn")
        XCTAssertEqual(manager.publicStatus()["email"] as? String, address)
        XCTAssertEqual(manager.revision, 1)
        XCTAssertNil(manager.pendingEmail)
        XCTAssertEqual(store.saves, 1)
        XCTAssertEqual(store.value?.refreshToken, "new_refresh_token")
        let authorization = try await manager.authorization()
        XCTAssertEqual(authorization?.token, "header.new.signature")
        XCTAssertEqual(authorization?.backendURL, NudgeAccountManager.backendURL)
        for request in network.requests.dropFirst() {
            XCTAssertEqual(request.value(forHTTPHeaderField: "apikey"), "sb_publishable_test_public_key_only")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        }
        let otp = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(network.requests[1].httpBody)) as? [String: Any])
        XCTAssertEqual(otp["email"] as? String, address)
        XCTAssertEqual(otp["create_user"] as? Bool, true)
        let verify = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(network.requests[2].httpBody)) as? [String: Any])
        XCTAssertEqual(verify["type"] as? String, "email")
        XCTAssertEqual(verify["token"] as? String, "123456")
        let statusData = try JSONSerialization.data(withJSONObject: manager.publicStatus())
        let statusText = String(decoding: statusData, as: UTF8.self)
        XCTAssertFalse(statusText.contains("signature"))
        XCTAssertFalse(statusText.contains("refresh"))
        XCTAssertFalse(statusText.contains("123456"))
    }

    func testMismatchedVerifiedUserCannotSignInAndProviderErrorTextIsNeverShown() async throws {
        let store = MemoryStore()
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/auth/v1/otp" { return try self.response([:]) }
            return try self.providerSession(email: "different@example.test")
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        try await manager.loadConfiguration()
        try await manager.sendCode(email: address)
        await assertThrows(.invalidResponse) { try await manager.verifyCode("123456") }
        XCTAssertNil(store.value)
        network.handler = { _ in try self.response(["message": "PRIVATE_PROVIDER_ERROR", "token": "SECRET"], status: 400) }
        await assertThrows(.invalidCode) { try await manager.verifyCode("123456") }
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedOut")
        XCTAssertEqual(manager.revision, 0)
    }

    func testRestoredSessionIsValidatedBeforeSignedInStatusWithoutChangingRevision() async throws {
        let store = MemoryStore(selected())
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            XCTAssertEqual(request.url?.path, "/auth/v1/user")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer header.old.signature")
            return try self.response(["id": self.userID, "email": self.address])
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "checking")
        try await manager.loadConfiguration()
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedIn")
        XCTAssertEqual(manager.revision, 0)
        XCTAssertEqual(store.saves, 0)
    }

    func testConcurrentExpiredAuthorizationRotatesOnceAndAtomicallyStoresBothTokens() async throws {
        let store = MemoryStore(selected(expired: true))
        var release: CheckedContinuation<Void, Never>?
        let started = expectation(description: "refresh started")
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            XCTAssertEqual(request.url?.path, "/auth/v1/token")
            XCTAssertEqual(request.url?.query, "grant_type=refresh_token")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            await withCheckedContinuation { release = $0; started.fulfill() }
            return try self.providerSession()
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        let first = Task { try await manager.authorization() }
        await fulfillment(of: [started], timeout: 10)
        let second = Task { try await manager.authorization() }
        await Task.yield()
        release?.resume()
        let firstAuthorization = try await first.value
        let secondAuthorization = try await second.value
        XCTAssertEqual(firstAuthorization?.token, "header.new.signature")
        XCTAssertEqual(secondAuthorization?.token, "header.new.signature")
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/auth/v1/token" }.count, 1)
        XCTAssertEqual(store.saves, 1)
        XCTAssertEqual(store.value?.accessToken, "header.new.signature")
        XCTAssertEqual(store.value?.refreshToken, "new_refresh_token")
        XCTAssertEqual(manager.revision, 0)
    }

    func testCancelledVerificationCannotRestoreAccount() async throws {
        let store = MemoryStore()
        var release: CheckedContinuation<Void, Never>?
        let started = expectation(description: "verify started")
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/auth/v1/otp" { return try self.response([:]) }
            await withCheckedContinuation { release = $0; started.fulfill() }
            return try self.providerSession()
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        try await manager.sendCode(email: address)
        let verify = Task { try await manager.verifyCode("123456") }
        await fulfillment(of: [started], timeout: 10)
        manager.cancelSignIn()
        release?.resume()
        do { try await verify.value; XCTFail("Cancelled verification saved a session") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(store.value)
        XCTAssertEqual(manager.revision, 0)
    }

    func testConfigurationWaitersUseLatestRotatedSession() async throws {
        let store = MemoryStore(selected(expired: true))
        var releaseConfiguration: CheckedContinuation<Void, Never>?
        let started = expectation(description: "configuration started")
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" {
                await withCheckedContinuation { releaseConfiguration = $0; started.fulfill() }
                return try self.config()
            }
            XCTAssertEqual(request.url?.path, "/auth/v1/token")
            return try self.providerSession()
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        let first = Task(priority: .high) { try await manager.authorization() }
        await fulfillment(of: [started], timeout: 10)
        let second = Task(priority: .low) { try await manager.authorization() }
        let statusLoad = Task { try await manager.loadConfiguration() }
        await Task.yield()
        releaseConfiguration?.resume()
        let firstResult = try await first.value
        let secondResult = try await second.value
        try await statusLoad.value
        XCTAssertEqual(firstResult?.token, "header.new.signature")
        XCTAssertEqual(secondResult?.token, "header.new.signature")
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/v1/account/config" }.count, 1)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/auth/v1/token" }.count, 1)
        XCTAssertEqual(store.saves, 1)
        XCTAssertEqual(store.value?.refreshToken, "new_refresh_token")
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedIn")
        XCTAssertEqual(manager.revision, 0)
    }

    func testLateRefreshCannotRestoreAfterSignOutAndOfflineLogoutIsTruthful() async throws {
        let store = MemoryStore(selected(expired: true))
        let unrelated = store.unrelated
        var release: CheckedContinuation<Void, Never>?
        let started = expectation(description: "refresh started")
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/v1/account/logout" { throw URLError(.notConnectedToInternet) }
            await withCheckedContinuation { release = $0; started.fulfill() }
            return try self.providerSession()
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        let refresh = Task { try await manager.authorization() }
        await fulfillment(of: [started], timeout: 10)
        let notice = try await manager.signOut()
        XCTAssertTrue(notice.contains("Server sign-out could not be confirmed"))
        release?.resume()
        do { _ = try await refresh.value; XCTFail("Late refresh restored session") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(store.value)
        let authorization = try await manager.authorization()
        XCTAssertNil(authorization)
        XCTAssertEqual(store.unrelated, unrelated)
        XCTAssertEqual(manager.revision, 1)
        XCTAssertEqual(store.saves, 0)
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedOut")
    }

    func testRevokedAccountPersistsReauthenticationMarkerAcrossRelaunch() async throws {
        let store = MemoryStore(selected(expired: true))
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            return try self.response(["error": "invalid_grant"], status: 400)
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        await assertThrows(.signInRequired) { _ = try await manager.authorization() }
        XCTAssertEqual(store.value?.reauthenticationRequired, true)
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedOut")
        XCTAssertEqual(manager.revision, 0)
        let restarted = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        let before = network.requests.count
        await assertThrows(.signInRequired) { _ = try await restarted.authorization() }
        XCTAssertEqual(network.requests.count, before)
        try await restarted.loadConfiguration()
        XCTAssertEqual(restarted.publicStatus()["state"] as? String, "signedOut")
        XCTAssertEqual(restarted.publicStatus()["available"] as? Bool, true)
    }

    func testTemporaryRefreshFailurePreservesSelectedAccountAndNeverReturnsNil() async throws {
        let store = MemoryStore(selected(expired: true))
        let original = store.value
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            throw URLError(.timedOut)
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        await assertThrows(.network) { _ = try await manager.authorization() }
        await assertThrows(.network) { _ = try await manager.authorization() }
        XCTAssertEqual(store.value, original)
        XCTAssertEqual(store.clears, 0)
        XCTAssertEqual(manager.revision, 0)
    }

    func testExpiredSignOutRefreshesOnceBeforeRevokingAndClearsLocally() async throws {
        let store = MemoryStore(selected(expired: true))
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/auth/v1/token" { return try self.providerSession() }
            XCTAssertEqual(request.url?.path, "/v1/account/logout")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer header.new.signature")
            XCTAssertNil(store.value, "Local credentials must already be cleared before revocation")
            return try self.response(["ok": true])
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        let notice = try await manager.signOut()
        XCTAssertEqual(notice, "Signed out. Your local diary is unchanged.")
        XCTAssertNil(store.value)
        XCTAssertEqual(store.saves, 1)
        XCTAssertEqual(store.clears, 1)
        XCTAssertEqual(manager.revision, 1)
    }

    func testChangedProviderDoesNotReceivePreviousProviderTokens() async throws {
        let store = MemoryStore(selected())
        let network = FakeTransport { _ in
            try self.response(["enabled": true, "provider": "supabase", "url": "https://another-project.supabase.co",
                               "publishableKey": "sb_publishable_test_public_key_only", "deletionAvailable": true])
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        await assertThrows(.unavailable) { _ = try await manager.authorization() }
        XCTAssertEqual(network.requests.count, 1)
        XCTAssertNil(network.requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertNotNil(store.value)
    }

    func testCredentialStorageFailureDoesNotEnablePrivateFallbackAndCanRetryAfterUnlock() async throws {
        let store = MemoryStore(selected())
        store.failLoad = true
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            return try self.response(["id": self.userID, "email": self.address])
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        await assertThrows(.storage) { _ = try await manager.authorization() }
        XCTAssertTrue(network.requests.isEmpty)
        store.failLoad = false
        try await manager.loadConfiguration()
        let authorization = try await manager.authorization()
        XCTAssertNotNil(authorization)
        store.failClear = true
        await assertThrows(.storage) { _ = try await manager.signOut() }
        XCTAssertNotNil(store.value)
        XCTAssertEqual(manager.revision, 0)
    }

    func testDeletionRequiresCapabilityAndConfirmedServerSuccessBeforeClearing() async throws {
        let store = MemoryStore(selected())
        var removedOwners: [String] = []
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config(deletion: false) }
            throw AccountError.invalidResponse
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant }, removeCaptures: { removedOwners.append($0) })
        await assertThrows(.deletionUnavailable) { try await manager.deleteAccount() }
        XCTAssertNotNil(store.value)
        XCTAssertEqual(network.requests.count, 1)
        network.handler = { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/auth/v1/user" { return try self.response(["id": self.userID, "email": self.address]) }
            XCTAssertEqual(request.url?.path, "/v1/account")
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer header.old.signature")
            return try self.response(["ok": false], status: 502)
        }
        try await manager.loadConfiguration()
        await assertThrows(.deletionFailed) { try await manager.deleteAccount() }
        XCTAssertNotNil(store.value)
        XCTAssertEqual(manager.revision, 0)
        XCTAssertTrue(removedOwners.isEmpty, "Failed server deletion must retain local captures")
        network.handler = { _ in try self.response(["ok": true]) }
        try await manager.deleteAccount()
        XCTAssertNil(store.value)
        XCTAssertEqual(manager.revision, 1)
        XCTAssertEqual(removedOwners, [try ProductContributionService.accountOwnerKey(userID: userID, baseURL: NudgeAccountManager.backendURL)])
        XCTAssertEqual(store.unrelated["diary"], "ManiLife 30 g; 185.7 kcal; 7.9 g protein")
    }

    func testOversizedConfigurationResponseIsRejectedEvenWithInjectedTransport() async throws {
        let network = FakeTransport { _ in AccountHTTPResponse(statusCode: 200, data: Data(repeating: 32, count: 8_193)) }
        let manager = NudgeAccountManager(store: MemoryStore(), transport: network, now: { self.instant })
        await assertThrows(.invalidResponse) { try await manager.loadConfiguration() }
        XCTAssertEqual(network.limits, [8_192])
    }

    func testCompleteSixToTenDigitCodesReachProviderWithoutLosingLeadingZeroes() async throws {
        for input in [" 001234\n", "\t00123456\r\n", "0012345678"] {
            let store = MemoryStore()
            var submitted: String?
            let network = FakeTransport { request in
                if request.url?.path == "/v1/account/config" { return try self.config() }
                if request.url?.path == "/auth/v1/otp" { return try self.response([:]) }
                XCTAssertEqual(request.url?.path, "/auth/v1/verify")
                let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
                submitted = body["token"] as? String
                XCTAssertEqual(body["type"] as? String, "email")
                return try self.providerSession()
            }
            let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
            try await manager.sendCode(email: address)
            try await manager.verifyCode(input)
            XCTAssertEqual(submitted, input.trimmingCharacters(in: .whitespacesAndNewlines))
            XCTAssertTrue(submitted?.hasPrefix("00") == true)
            XCTAssertEqual(network.requests.filter { $0.url?.path == "/auth/v1/verify" }.count, 1)
            XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedIn")
            XCTAssertEqual(store.saves, 1)
        }
    }

    func testMalformedCodeShowsFormatErrorWithoutProviderRequestOrCredentialMutation() async throws {
        let store = MemoryStore()
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            return try self.response([:])
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        try await manager.sendCode(email: address)
        let requestCount = network.requests.count
        for input in ["", "12345", "12345678901", "12 3456", "123456abc", "Code: 123456", "１２３４５６", "123456\n7", String(repeating: " ", count: 129) + "123456"] {
            await assertThrows(.invalidCodeFormat) { try await manager.verifyCode(input) }
        }
        XCTAssertEqual(network.requests.count, requestCount)
        XCTAssertEqual(store.saves, 0)
        XCTAssertNil(store.value)
        XCTAssertEqual(manager.pendingEmail, address)
        XCTAssertNotEqual(AccountError.invalidCodeFormat.localizedDescription, AccountError.invalidCode.localizedDescription)
    }

    private func control<T: UIView>(_ identifier: String, in view: UIView, as type: T.Type) throws -> T {
        func find(_ view: UIView) -> T? {
            if view.accessibilityIdentifier == identifier, let found = view as? T { return found }
            return view.subviews.lazy.compactMap { find($0) }.first
        }
        return try XCTUnwrap(find(view), "Missing native account control: \(identifier)")
    }

    func testRenderedVerifyTapSnapshotsEightDigitCodeAndShowsProgressWithoutRepainting() async throws {
        let store = MemoryStore()
        let loaded = expectation(description: "native form loaded")
        let started = expectation(description: "mock verification started")
        let finished = expectation(description: "native form signed in")
        var release: CheckedContinuation<Void, Never>?
        var submitted: String?
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/auth/v1/otp" { return try self.response([:]) }
            XCTAssertEqual(request.url?.path, "/auth/v1/verify")
            let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            submitted = body["token"] as? String
            await withCheckedContinuation { release = $0; started.fulfill() }
            return try self.providerSession()
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        try await manager.sendCode(email: address)
        var changes = 0
        let controller = AccountConnectionViewController(manager: manager) {
            changes += 1
            if changes == 1 { loaded.fulfill() } else { finished.fulfill() }
        }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 428, height: 926)
        await fulfillment(of: [loaded], timeout: 5)
        let field = try control("account-code", in: controller.view, as: UITextField.self)
        let verify = try control("account-verify", in: controller.view, as: UIButton.self)
        let feedback = try control("account-feedback", in: controller.view, as: UILabel.self)
        let activity = try control("account-progress", in: controller.view, as: UIActivityIndicatorView.self)
        _ = try control("account-form", in: controller.view, as: UIScrollView.self)
        field.text = " 00123456\n"
        let parent = field.superview
        verify.sendActions(for: .touchUpInside)
        XCTAssertEqual(feedback.text, "Verifying your code…")
        XCTAssertTrue(activity.isAnimating)
        XCTAssertFalse(verify.isEnabled)
        XCTAssertFalse(field.isEnabled)
        XCTAssertTrue(field.superview === parent)
        XCTAssertTrue(try control("account-verify", in: controller.view, as: UIButton.self) === verify)
        // A value changed after the tap must not replace the tap's input snapshot.
        field.text = "999999"
        verify.sendActions(for: .touchUpInside)
        await fulfillment(of: [started], timeout: 5)
        XCTAssertEqual(submitted, "00123456")
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/auth/v1/verify" }.count, 1)
        release?.resume()
        await fulfillment(of: [finished], timeout: 5)
        XCTAssertEqual(manager.publicStatus()["state"] as? String, "signedIn")
        XCTAssertEqual(feedback.text, "You’re signed in. Ready to scan.")
        XCTAssertFalse(activity.isAnimating)
    }

    func testRenderedVerifyErrorsRemainVisibleAndAllowCorrection() async throws {
        let store = MemoryStore()
        let loaded = expectation(description: "native form loaded")
        let malformed = expectation(description: "format feedback shown")
        let rejected = expectation(description: "provider feedback shown")
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return try self.config() }
            if request.url?.path == "/auth/v1/otp" { return try self.response([:]) }
            return try self.response(["message": "DO_NOT_DISPLAY_PROVIDER_TEXT"], status: 400)
        }
        let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
        try await manager.sendCode(email: address)
        var changes = 0
        let controller = AccountConnectionViewController(manager: manager) {
            changes += 1
            if changes == 1 { loaded.fulfill() }
            else if changes == 2 { malformed.fulfill() }
            else { rejected.fulfill() }
        }
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 428, height: 500)
        await fulfillment(of: [loaded], timeout: 5)
        let field = try control("account-code", in: controller.view, as: UITextField.self)
        field.text = "12 3456"
        try control("account-verify", in: controller.view, as: UIButton.self).sendActions(for: .touchUpInside)
        await fulfillment(of: [malformed], timeout: 5)
        let feedback = try control("account-feedback", in: controller.view, as: UILabel.self)
        XCTAssertEqual(feedback.text, AccountError.invalidCodeFormat.localizedDescription)
        XCTAssertFalse(feedback.isHidden)
        XCTAssertEqual(feedback.textColor, NudgeTheme.errorText)
        XCTAssertEqual(field.text, "12 3456")
        XCTAssertTrue(field.isEnabled)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/auth/v1/verify" }.count, 0)
        field.text = "00123456"
        try control("account-verify", in: controller.view, as: UIButton.self).sendActions(for: .touchUpInside)
        await fulfillment(of: [rejected], timeout: 5)
        XCTAssertEqual(feedback.text, AccountError.invalidCode.localizedDescription)
        XCTAssertEqual(field.text, "00123456")
        XCTAssertTrue(try control("account-verify", in: controller.view, as: UIButton.self).isEnabled)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/auth/v1/verify" }.count, 1)
        XCTAssertNil(store.value)
        XCTAssertEqual(manager.pendingEmail, address)
    }
    func testPositiveEnergyAccountScreensPreserveEmailCodeAndRecoveryAcrossAppearances() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        for state in ["email", "code", "unavailable"] {
            let network = FakeTransport { request in
                if request.url?.path == "/v1/account/config" { return state == "unavailable" ? try self.response(["enabled":false]) : try self.config() }
                return try self.response([:])
            }
            let store = MemoryStore()
            let manager = NudgeAccountManager(store: store, transport: network, now: { self.instant })
            if state == "code" { try await manager.sendCode(email: address) }
            let loaded = expectation(description: "themed account \(state) loaded")
            let controller = AccountConnectionViewController(manager: manager) { loaded.fulfill() }
            controller.loadViewIfNeeded()
            await fulfillment(of: [loaded], timeout: 5)
            let parent = UIViewController()
            parent.addChild(controller); parent.view.addSubview(controller.view); controller.didMove(toParent: parent)
            window.rootViewController = parent; window.makeKeyAndVisible()
            for style in [UIUserInterfaceStyle.light, .dark] {
                for large in [false, true] {
                    let traits = UITraitCollection(traitsFrom: [UITraitCollection(userInterfaceStyle: style), UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large)])
                    parent.setOverrideTraitCollection(traits, forChild: controller)
                    window.overrideUserInterfaceStyle = style
                    controller.overrideUserInterfaceStyle = style
                    parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
                    controller.view.frame = CGRect(x: 0, y: 0, width: 320, height: 700)
                    parent.view.layoutIfNeeded(); controller.view.setNeedsLayout(); controller.view.layoutIfNeeded()
                    try await Task.sleep(nanoseconds: 120_000_000)
                    controller.view.layoutIfNeeded()
                    let image = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { controller.view.layer.render(in: $0.cgContext) }
                    let screenshot = XCTAttachment(image: image); screenshot.name = "Positive native account \(state) \(style.rawValue) \(large ? "accessibility" : "standard") — mocked service"; screenshot.lifetime = .keepAlways; add(screenshot)
                    if large {
                        let scroll = try control("account-form", in: controller.view, as: UIScrollView.self)
                        scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height)), animated: false)
                        scroll.layoutIfNeeded()
                        let bottom = UIGraphicsImageRenderer(bounds: controller.view.bounds).image { controller.view.layer.render(in: $0.cgContext) }
                        let actions = XCTAttachment(image: bottom); actions.name = "Positive native account \(state) \(style.rawValue) accessibility scrolled actions — mocked service"; actions.lifetime = .keepAlways; add(actions)
                        scroll.setContentOffset(.zero, animated: false)
                    }
                    let identifier = state == "email" ? "account-send-code" : state == "code" ? "account-verify" : nil
                    if let identifier {
                        let button = try control(identifier, in: controller.view, as: NudgeButton.self)
                        XCTAssertGreaterThanOrEqual(button.frame.height, 56)
                        XCTAssertFalse(controller.view.subviews.contains(where: { $0.isFirstResponder }), "Themed entry must not open a keyboard")
                    }
                }
            }
            XCTAssertNil(store.value)
            XCTAssertEqual(store.saves, 0)
        }
    }

}
