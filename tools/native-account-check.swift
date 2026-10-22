import Foundation
import UIKit

// Compile-only environment dependencies. None opens files, Keychain or a real
// backend. The account manager and UIKit form/theme are exact shipping sources.
enum ProductSupportContext { case period, follicular, ovulation, luteal, perimenopause, postmenopause }
final class LabelSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
struct BackendConfiguration { let token: String; let baseURL: URL }
enum BackendCredentialStore { static func configuration() -> BackendConfiguration? { nil } }
enum ProductContributionService {
    static func accountOwnerKey(userID: String, baseURL: URL) throws -> String { "synthetic-account-" + userID }
    static func ownerKey(token: String, baseURL: URL) throws -> String { fatalError("Private backend credentials must not be used") }
}
struct NativeCaptureOutbox {
    init(directory: URL) { fatalError("The harness must not instantiate real capture storage") }
    func removeOwner(_ owner: String) throws { fatalError("The harness must not remove owner captures") }
}
enum NudgeDataStore {
    static var shared: NudgeDataStore { fatalError("The harness must not access owner files") }
    var captureDirectory: URL { fatalError("The harness must not access owner files") }
}

@MainActor private final class MemoryStore: AccountSessionStore {
    var value: AccountSession?
    var failSave = false
    var failLoad = false
    var saves = 0
    var clears = 0
    init(_ value: AccountSession? = nil) { self.value = value }
    func load() throws -> AccountSession? { if failLoad { throw AccountError.storage }; return value }
    func save(_ session: AccountSession) throws {
        if failSave { throw AccountError.storage }
        value = session; saves += 1
    }
    func clear() throws { value = nil; clears += 1 }
}
@MainActor private final class FakeTransport: AccountHTTPTransport {
    var requests: [URLRequest] = []
    var limits: [Int] = []
    var handler: (URLRequest) async throws -> AccountHTTPResponse
    init(_ handler: @escaping (URLRequest) async throws -> AccountHTTPResponse) { self.handler = handler }
    func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse {
        requests.append(request); limits.append(maximumBytes)
        return try await handler(request)
    }
}
@MainActor private final class Gate {
    var entered = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { entered = true; await withCheckedContinuation { continuation = $0 } }
    func release() { continuation?.resume(); continuation = nil }
}
private struct CheckFailure: Error { let message: String }

@main @MainActor private struct AccountChecks {
    static let instant = Date(timeIntervalSince1970: 1_800_000_000)
    static let provider = URL(string: "https://nudge-test-project.supabase.co")!
    static let userID = "11111111-2222-4333-8444-555555555555"
    static let address = "person@example.test"
    static var checks = 0
    static var groups: [String] = []
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        checks += 1
        guard condition() else { throw CheckFailure(message: message) }
    }
    static func error(_ expected: AccountError? = nil, _ work: () async throws -> Void) async throws {
        do { try await work() } catch {
            if let expected { try check(error as? AccountError == expected, "Unexpected account error") }
            else { try check(error is CancellationError, "Expected operation cancellation") }
            return
        }
        throw CheckFailure(message: "Operation unexpectedly succeeded")
    }
    static func until(_ condition: () -> Bool) async throws {
        for _ in 0..<1_000 { if condition() { return }; try await Task.sleep(nanoseconds: 1_000_000) }
        throw CheckFailure(message: "Synthetic operation did not reach its gate")
    }
    static func response(_ body: [String: Any], _ status: Int = 200) -> AccountHTTPResponse {
        AccountHTTPResponse(statusCode: status, data: try! JSONSerialization.data(withJSONObject: body))
    }
    static func config(_ enabled: Bool = true) -> AccountHTTPResponse {
        response(["enabled": enabled, "provider": "supabase", "url": provider.absoluteString,
                  "publishableKey": "sb_publishable_test_public_key_only", "deletionAvailable": true])
    }
    static func selected(_ expired: Bool = false) -> AccountSession {
        AccountSession(accessToken: "header.old.signature", refreshToken: "old_refresh_token", expiresAt: instant.addingTimeInterval(expired ? -10 : 3_600), userID: userID, email: address, providerURL: provider)
    }
    static func session(_ token: String = "header.new.signature", email: String = address) -> AccountHTTPResponse {
        response(["access_token": token, "refresh_token": "new_refresh_token", "token_type": "bearer",
                  "expires_in": 3_600, "expires_at": instant.timeIntervalSince1970 + 3_600,
                  "user": ["id": userID, "email": email]])
    }
    static func body(_ request: URLRequest) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
    }
    static func manager(_ store: MemoryStore, _ transport: FakeTransport) -> NudgeAccountManager {
        NudgeAccountManager(store: store, transport: transport, now: { instant })
    }
    static func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }
    static func control<T: UIView>(_ controller: UIViewController, _ id: String, as: T.Type) throws -> T {
        guard let item = views(controller.view).first(where: { $0.accessibilityIdentifier == id }) as? T else {
            throw CheckFailure(message: "Expected account control is absent: " + id)
        }
        return item
    }

    static func passwordSuccess() async throws {
        let store = MemoryStore(), network = FakeTransport { request in
            request.url?.path == "/v1/account/config" ? config() : session()
        }
        let account = manager(store, network)
        let password = "  Synthetic password 🥣  "
        try await account.signInWithPassword(email: " \n" + address + " \n", password: password)
        try check(network.requests.count == 2, "Password sign-in has one config lookup and one provider request")
        let request = network.requests[1]
        try check(request.url?.absoluteString == provider.absoluteString + "/auth/v1/token?grant_type=password", "Password grant URL")
        try check(request.httpMethod == "POST", "Password grant method")
        try check(body(request)["email"] as? String == address && body(request)["password"] as? String == password, "Email is trimmed; password is exact")
        try check(Set(body(request).keys) == ["email", "password"], "Only documented credentials are submitted")
        try check(request.value(forHTTPHeaderField: "Authorization") == nil && request.value(forHTTPHeaderField: "apikey") == "sb_publishable_test_public_key_only", "Provider publishable key only")
        try check(network.requests[0].httpBody == nil && network.requests[0].value(forHTTPHeaderField: "Authorization") == nil, "No password or session forwarded to backend configuration")
        try check(network.limits == [8_192, 65_536] && request.value(forHTTPHeaderField: "Cache-Control") == "no-store", "Bounded uncached transport")
        try check(store.saves == 1 && store.value?.email == address && account.revision == 1 && account.pendingEmail == nil, "Successful session installed once")
        let auth = try await account.authorization()
        try check(auth?.token == "header.new.signature" && network.requests.count == 2, "Installed session is immediately usable")
        let encoded = String(decoding: try JSONEncoder().encode(store.value), as: UTF8.self)
        try check(!encoded.contains(password) && !encoded.contains("password") && Set(account.publicStatus().keys) == ["state", "available", "email"], "Password is absent from session persistence and public status")
        groups.append("password request, exact input, bounded transport and durable session")
    }

    static func validationAndErrors() async throws {
        let network = FakeTransport { _ in throw CheckFailure(message: "Invalid input reached HTTP") }
        let store = MemoryStore(selected()), account = manager(store, network)
        for (email, password, expected) in [("not-email", "x", AccountError.invalidEmail), (address, "", .passwordRequired), (address, String(repeating: "🥣", count: 1_025), .passwordTooLong)] {
            try await error(expected) { try await account.signInWithPassword(email: email, password: password) }
        }
        try check(network.requests.isEmpty && store.saves == 0 && account.revision == 0, "Invalid inputs cannot mutate or send credentials")
        for (status, expected) in [(400, AccountError.invalidCredentials), (401, .invalidCredentials), (403, .invalidCredentials), (422, .invalidCredentials), (429, .rateLimited), (500, .unavailable), (302, .invalidResponse)] {
            let store = MemoryStore(selected())
            let network = FakeTransport { request in request.url?.path == "/v1/account/config" ? config() : response(["msg": "PRIVATE SERVER DETAIL", "error_description": "SECRET"], status) }
            let account = manager(store, network)
            try await error(expected) { try await account.signInWithPassword(email: address, password: "synthetic") }
            try check(store.value == selected() && store.saves == 0 && account.revision == 0, "Failed authentication preserves selected account")
            try check(!expected.localizedDescription.contains("PRIVATE") && !expected.localizedDescription.contains("SECRET"), "Provider detail never displayed")
        }
        for bad in [response(["enabled": false]), response(["enabled": true, "provider": "supabase", "url": "https://attacker.example.test", "publishableKey": "sb_publishable_test_public_key_only", "deletionAvailable": true])] {
            let network = FakeTransport { _ in bad }, account = manager(MemoryStore(), network)
            do { try await account.signInWithPassword(email: address, password: "synthetic"); throw CheckFailure(message: "Invalid provider accepted") }
            catch is AccountError { }
            try check(network.requests.count == 1 && network.requests[0].httpBody == nil, "Unvalidated provider never receives credentials")
        }
        groups.append("input bounds, uniform credentials errors and provider origin validation")
    }

    static func invalidResponsesAndStorage() async throws {
        for invalid in [session(email: "someone-else@example.test"), session("not-a-session-token"), response(["unexpected": true]), AccountHTTPResponse(statusCode: 200, data: Data(repeating: 65, count: 65_537))] {
            let store = MemoryStore(selected())
            let network = FakeTransport { request in request.url?.path == "/v1/account/config" ? config() : invalid }
            let account = manager(store, network)
            try await error(.invalidResponse) { try await account.signInWithPassword(email: address, password: "synthetic") }
            try check(store.value == selected() && account.revision == 0 && store.saves == 0, "Invalid session must not replace current credentials")
        }
        let store = MemoryStore(selected()), network = FakeTransport { request in request.url?.path == "/v1/account/config" ? config() : session() }
        let account = manager(store, network), owner = account.captureOwnerKey
        store.failSave = true
        try await error(.storage) { try await account.signInWithPassword(email: address, password: "synthetic") }
        try check(store.value == selected() && account.captureOwnerKey == owner && account.revision == 0, "Storage failure preserves credentials and capture ownership")
        store.failSave = false
        try await account.signInWithPassword(email: address, password: "synthetic")
        try check(store.value?.accessToken == "header.new.signature" && store.saves == 1, "Explicit retry after storage recovery succeeds once")
        let restoredNetwork = FakeTransport { request in
            request.url?.path == "/v1/account/config" ? config() : response(["id": userID, "email": address])
        }
        let restored = manager(store, restoredNetwork)
        let auth = try await restored.authorization()
        try check(auth?.token == "header.new.signature" && restoredNetwork.requests.last?.url?.path == "/auth/v1/user", "Persisted password session follows ordinary restored-session validation")
        groups.append("invalid responses, durable save failure and restored session validation")
    }

    static func cancellationAndSwitch() async throws {
        for mode in 0..<3 {
            let gate = Gate(), store = MemoryStore()
            let network = FakeTransport { request in
                if request.url?.path == "/v1/account/config" { return config() }
                if request.url?.path == "/auth/v1/otp" { return response([:]) }
                await gate.wait(); return session()
            }
            let account = manager(store, network)
            let task = Task { try await account.signInWithPassword(email: address, password: "synthetic") }
            try await until { gate.entered }
            if mode == 0 { account.cancelSignIn() }
            else if mode == 1 { task.cancel() }
            else { try await account.sendCode(email: address) }
            gate.release()
            try await error { try await task.value }
            try check(store.saves == 0 && store.value == nil && account.revision == 0, "Cancelled or switched password login cannot install a late result")
            try check(account.pendingEmail == (mode == 2 ? address : nil), "Password cancellation preserves the newest OTP operation")
        }
        let gate = Gate(), store = MemoryStore()
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            if body(request)["password"] as? String == "first" { await gate.wait(); return session("header.first.signature") }
            return session("header.second.signature")
        }
        let account = manager(store, network)
        let first = Task { try await account.signInWithPassword(email: address, password: "first") }
        try await until { gate.entered }
        try await account.signInWithPassword(email: address, password: "second")
        gate.release()
        try await error { try await first.value }
        try check(store.value?.accessToken == "header.second.signature" && store.saves == 1 && account.revision == 1, "Only latest password operation can commit")
        groups.append("task cancellation, dismissal generation and OTP/password operation races")
    }

    static func refreshAndSignOutRaces() async throws {
        let gate = Gate(), store = MemoryStore(selected(true))
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            if request.url?.query == "grant_type=refresh_token" { await gate.wait(); return session("header.refresh.signature") }
            return session("header.password.signature")
        }
        let account = manager(store, network)
        let refresh = Task { try await account.authorization() }
        try await until { gate.entered }
        try await account.signInWithPassword(email: address, password: "synthetic")
        gate.release()
        try await error { _ = try await refresh.value }
        try check(store.value?.accessToken == "header.password.signature" && store.saves == 1, "Late old refresh cannot overwrite newly selected password session")
        let signOutGate = Gate(), signOutStore = MemoryStore(selected())
        let signOutNetwork = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            if request.url?.path == "/auth/v1/token" { await signOutGate.wait(); return session() }
            return response([:])
        }
        let signOutManager = manager(signOutStore, signOutNetwork)
        let login = Task { try await signOutManager.signInWithPassword(email: address, password: "synthetic") }
        try await until { signOutGate.entered }
        _ = try await signOutManager.signOut()
        signOutGate.release()
        try await error { try await login.value }
        try check(signOutStore.value == nil && signOutStore.saves == 0 && signOutStore.clears == 1, "Sign-out cannot be undone by a late password response")
        groups.append("refresh/password and sign-out/password races")
    }

    static func otpRegression() async throws {
        for code in ["001234", "001234567", "0012345678"] {
            let store = MemoryStore(), network = FakeTransport { request in
                if request.url?.path == "/v1/account/config" { return config() }
                return request.url?.path == "/auth/v1/otp" ? response([:]) : session()
            }
            let account = manager(store, network)
            try await account.sendCode(email: address)
            try await account.verifyCode(" \n" + code + " \n")
            let otp = body(network.requests[1]), verify = body(network.requests[2])
            try check(otp["email"] as? String == address && otp["create_user"] as? Bool == true && otp["password"] == nil, "OTP signup remains supported")
            try check(verify["token"] as? String == code && verify["type"] as? String == "email" && verify["password"] == nil, "OTP lengths and leading zeros preserved")
            try check(store.saves == 1 && account.revision == 1 && account.pendingEmail == nil, "OTP shares guarded durable installation")
        }
        for code in ["12345", "12345678901", "123 456", "abcdef", "１２３４５６"] {
            try await error(.invalidCodeFormat) { _ = try NudgeAccountManager.normalizedCode(code) }
        }
        let store = MemoryStore(selected()), network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            return request.url?.path == "/auth/v1/otp" ? response([:]) : session()
        }
        let account = manager(store, network)
        try await account.sendCode(email: address); store.failSave = true
        try await error(.storage) { try await account.verifyCode("001234") }
        try check(store.value == selected() && account.revision == 0 && account.pendingEmail == address, "OTP storage failure also preserves previous selection")
        groups.append("existing OTP signup, complete codes and storage regression")
    }

    static func uiControls() async throws {
        let gate = Gate(), store = MemoryStore()
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            await gate.wait(); return response(["msg": "PRIVATE DETAIL"], 400)
        }
        let account = manager(store, network)
        var changes = 0
        let controller = AccountConnectionViewController(manager: account, onChange: { changes += 1 })
        controller.loadViewIfNeeded()
        try await until { changes == 1 }
        let email = try control(controller, "account-email", as: UITextField.self)
        try check((try? control(controller, "account-password", as: UITextField.self)) == nil, "Ordinary sign-in starts without a password field")
        let initialCodeButton = try control(controller, "account-send-code", as: UIButton.self)
        try check(initialCodeButton.isEnabled && initialCodeButton.configuration?.title == "Email me a code", "Email code is the default sign-in action")
        try control(controller, "account-use-password", as: UIButton.self).sendActions(for: .touchUpInside)
        let password = try control(controller, "account-password", as: UITextField.self)
        let button = try control(controller, "account-sign-in-password", as: UIButton.self)
        let codeButton = try control(controller, "account-use-code", as: UIButton.self)
        try check(password.isSecureTextEntry && password.textContentType == .password && email.textContentType == .username, "Visible secure password and autofill semantics")
        try check(password.autocorrectionType == .no && password.spellCheckingType == .no && password.smartQuotesType == .no && password.smartDashesType == .no, "Password editing does not autocorrect credentials")
        try check(button.isEnabled && codeButton.isEnabled && button.configuration?.title == "Sign in with password" && codeButton.configuration?.title == "Use an email code", "Explicit password screen retains email-code recovery")
        email.text = address; password.text = "  UI synthetic exact  "
        button.sendActions(for: .touchUpInside)
        try check(password.text == "" && !button.isEnabled && !codeButton.isEnabled, "Password cleared and buttons disabled immediately on submit")
        email.text = "later@example.test"
        button.sendActions(for: .touchUpInside)
        try await until { gate.entered }
        try check(network.requests.count == 2 && body(network.requests[1])["email"] as? String == address && body(network.requests[1])["password"] as? String == "  UI synthetic exact  ", "UI snapshots credentials before await and ignores duplicate busy submit")
        gate.release(); try await until { changes == 2 }
        let feedback = try control(controller, "account-feedback", as: UILabel.self)
        try check(password.text == "" && feedback.text == AccountError.invalidCredentials.localizedDescription && store.saves == 0, "Failed login clears password and displays uniform error")
        network.handler = { request in request.url?.path == "/auth/v1/otp" ? response([:]) : session() }
        let currentEmail = try control(controller, "account-email", as: UITextField.self)
        currentEmail.text = address; password.text = "never sent via OTP"
        try control(controller, "account-use-code", as: UIButton.self).sendActions(for: .touchUpInside)
        try check(password.text == "" && (try? control(controller, "account-password", as: UITextField.self)) == nil && network.requests.count == 2, "Choosing code mode clears password without sending a request")
        try control(controller, "account-send-code", as: UIButton.self).sendActions(for: .touchUpInside)
        try await until { changes == 3 }
        try check(password.text == "" && body(network.requests.last!)["password"] == nil && account.pendingEmail == address, "Switching to email code clears and never sends password")
        try control(controller, "account-change-email", as: UIButton.self).sendActions(for: .touchUpInside)
        try check(account.pendingEmail == nil && (try? control(controller, "account-password", as: UITextField.self)) == nil, "Changing email returns to passwordless entry")
        try control(controller, "account-use-password", as: UIButton.self).sendActions(for: .touchUpInside)
        let finalPassword = try control(controller, "account-password", as: UITextField.self)
        finalPassword.text = "dismissed synthetic"
        controller.presentationControllerDidDismiss(UIPresentationController(presentedViewController: controller, presenting: nil))
        try check(finalPassword.text == "", "Interactive dismissal clears password")
        groups.append("actual UIKit controls, secure autofill, submission, errors, OTP switch and dismissal")
    }

    static func passwordlessOnboardingControls() async throws {
        let sendGate = Gate(), verifyGate = Gate(), store = MemoryStore()
        var otpRequests = 0, acceptCode = false
        let network = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            if request.url?.path == "/auth/v1/otp" {
                otpRequests += 1
                if otpRequests == 1 { await sendGate.wait() }
                return response([:])
            }
            if request.url?.path == "/auth/v1/verify" {
                if acceptCode { await verifyGate.wait(); return session() }
                return response(["message": "PRIVATE DETAIL"], 400)
            }
            throw CheckFailure(message: "Passwordless controls requested an unexpected endpoint")
        }
        let account = manager(store, network)
        var changes = 0, signedIn = 0, callbackSawInstalledSession = false
        let controller = AccountConnectionViewController(manager: account, onSignedIn: {
            signedIn += 1
            callbackSawInstalledSession = store.saves == 1 && account.publicStatus()["state"] as? String == "signedIn"
        }, onChange: { changes += 1 })
        controller.loadViewIfNeeded()
        try await until { changes == 1 }
        try check(signedIn == 0 && store.saves == 0, "Loading onboarding does not complete sign-in or save credentials")
        let email = try control(controller, "account-email", as: UITextField.self)
        let send = try control(controller, "account-send-code", as: UIButton.self)
        email.text = " \n" + address + " \n"
        send.sendActions(for: .touchUpInside)
        try check(!send.isEnabled && !email.isEnabled, "Sending a code disables duplicate submission and email editing")
        email.text = "later@example.test"
        send.sendActions(for: .touchUpInside)
        try await until { sendGate.entered }
        try check(otpRequests == 1 && body(network.requests.last!)["email"] as? String == address && body(network.requests.last!)["create_user"] as? Bool == true, "Default signup snapshots the email and sends a single passwordless request")
        sendGate.release(); try await until { changes == 2 }
        let code = try control(controller, "account-code", as: UITextField.self)
        try check(code.textContentType == .oneTimeCode && code.placeholder == "6-digit code" && account.pendingEmail == address && signedIn == 0, "Six-digit email-code guidance and autofill appear without completing onboarding")
        code.text = "12 3456"
        try control(controller, "account-verify", as: UIButton.self).sendActions(for: .touchUpInside)
        try await until { changes == 3 }
        try check(network.requests.filter { $0.url?.path == "/auth/v1/verify" }.isEmpty && signedIn == 0, "Malformed code cannot reach verification or complete onboarding")
        code.text = "00123456"
        try control(controller, "account-verify", as: UIButton.self).sendActions(for: .touchUpInside)
        try await until { changes == 4 }
        let feedback = try control(controller, "account-feedback", as: UILabel.self)
        try check(feedback.text == AccountError.invalidCode.localizedDescription && code.text == "00123456" && account.pendingEmail == address && signedIn == 0, "Rejected code stays correctable without exposing provider text or advancing onboarding")
        try control(controller, "account-resend-code", as: UIButton.self).sendActions(for: .touchUpInside)
        try await until { changes == 5 }
        try check(otpRequests == 2 && code.text == "" && account.pendingEmail == address && signedIn == 0, "Resend retains the intended email, clears the old input and waits for verification")
        acceptCode = true; code.text = " 00123456\n"
        let verify = try control(controller, "account-verify", as: UIButton.self)
        verify.sendActions(for: .touchUpInside)
        try await until { verifyGate.entered }
        code.text = "99999999"; verify.sendActions(for: .touchUpInside)
        try check(body(network.requests.last!)["token"] as? String == "00123456" && signedIn == 0 && store.saves == 0, "Verification snapshots the complete code and cannot complete before durable success")
        verifyGate.release(); try await until { changes == 6 }
        try check(signedIn == 1 && callbackSawInstalledSession && account.pendingEmail == nil && code.text == "", "Successful OTP advances onboarding once after installing the verified session")
        try check(network.requests.allSatisfy { body($0)["password"] == nil }, "Normal onboarding never sends a password")

        let existingStore = MemoryStore(selected()), original = existingStore.value
        let existingNetwork = FakeTransport { request in
            if request.url?.path == "/v1/account/config" { return config() }
            return response(["id": userID, "email": address])
        }
        let existing = manager(existingStore, existingNetwork)
        var loaded = false, continued = 0
        let restored = AccountConnectionViewController(manager: existing, onSignedIn: { continued += 1 }, onChange: { loaded = true })
        restored.loadViewIfNeeded(); try await until { loaded }
        try check(existingStore.value == original && existingStore.saves == 0 && existingStore.clears == 0 && continued == 0, "Showing onboarding preserves the selected owner session without automatic advance")
        try check((try? control(restored, "account-email", as: UITextField.self)) == nil, "Existing signed-in user is not asked to enter email or replace credentials")
        try control(restored, "account-continue", as: UIButton.self).sendActions(for: .touchUpInside)
        try check(continued == 1 && existingStore.value == original, "Existing signed-in user can explicitly continue with unchanged credentials")
        groups.append("passwordless onboarding, email/code snapshots, resend/errors, durable success callback and existing-session continuation")
    }

    static func embeddedSignInCancellation() async throws {
        for usePassword in [false, true] {
            let gate = Gate(), store = MemoryStore()
            var returned = false
            let network = FakeTransport { request in
                if request.url?.path == "/v1/account/config" { return config() }
                if request.url?.path == "/auth/v1/otp" { return response([:]) }
                await gate.wait(); returned = true
                return session()
            }
            let account = manager(store, network)
            var changes = 0, signedIn = 0
            let controller = AccountConnectionViewController(manager: account, onSignedIn: { signedIn += 1 }, onChange: { changes += 1 })
            controller.loadViewIfNeeded(); try await until { changes == 1 }
            let email = try control(controller, "account-email", as: UITextField.self)
            email.text = address
            let activeField: UITextField
            if usePassword {
                try control(controller, "account-use-password", as: UIButton.self).sendActions(for: .touchUpInside)
                activeField = try control(controller, "account-password", as: UITextField.self)
                activeField.text = "synthetic reviewer password"
                try control(controller, "account-sign-in-password", as: UIButton.self).sendActions(for: .touchUpInside)
            } else {
                try control(controller, "account-send-code", as: UIButton.self).sendActions(for: .touchUpInside)
                try await until { changes == 2 }
                activeField = try control(controller, "account-code", as: UITextField.self)
                activeField.text = "001234"
                try control(controller, "account-verify", as: UIButton.self).sendActions(for: .touchUpInside)
            }
            try await until { gate.entered }
            let changesBeforeLeaving = changes
            controller.cancelPendingSignIn()
            try check(activeField.text == "" && email.text == "" && account.pendingEmail == nil, "Leaving the embedded form clears in-flight credentials and code state")
            gate.release(); try await until { returned }
            try await Task.sleep(nanoseconds: 20_000_000)
            try check(store.value == nil && store.saves == 0 && changes == changesBeforeLeaving && signedIn == 0, "A late response cannot sign in or update a dismantled onboarding form")
        }

        let store = MemoryStore(), network = FakeTransport { request in request.url?.path == "/v1/account/config" ? config() : session() }
        let account = manager(store, network)
        var changes = 0, signedIn = 0
        let controller = AccountConnectionViewController(manager: account, onSignedIn: { signedIn += 1 }, onChange: { changes += 1 })
        controller.loadViewIfNeeded(); try await until { changes == 1 }
        try control(controller, "account-email", as: UITextField.self).text = address
        try control(controller, "account-use-password", as: UIButton.self).sendActions(for: .touchUpInside)
        try control(controller, "account-password", as: UITextField.self).text = "synthetic reviewer password"
        try control(controller, "account-sign-in-password", as: UIButton.self).sendActions(for: .touchUpInside)
        try await until { changes == 2 }
        try check(store.saves == 1 && signedIn == 1 && account.publicStatus()["state"] as? String == "signedIn", "Explicit ordinary password sign-in still advances onboarding after verified durable success")
        groups.append("embedded form cancellation for both grants and retained password onboarding success")
    }

    static func main() async {
        do {
            try await passwordSuccess()
            try await validationAndErrors()
            try await invalidResponsesAndStorage()
            try await cancellationAndSwitch()
            try await refreshAndSignOutRaces()
            try await otpRegression()
            try await uiControls()
            try await passwordlessOnboardingControls()
            try await embeddedSignInCancellation()
            let receipt: [String: Any] = ["checks": checks, "groups": groups, "passed": true,
                "limits": "Headless Mac Catalyst UIKit control execution; not a screenshot, simulator, physical-device or live Supabase authentication test."]
            print("ACCOUNT_CHECK_RESULT " + String(decoding: try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]), as: UTF8.self))
        } catch {
            let message = (error as? CheckFailure)?.message ?? "Unexpected synthetic harness failure"
            print("ACCOUNT_CHECK_FAILURE " + message)
            exit(1)
        }
    }
}
