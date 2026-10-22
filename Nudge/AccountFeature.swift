import Foundation
import Security
import UIKit

struct AccountAuthorization {
    let backendURL: URL
    let token: String
}

enum AccountError: LocalizedError, Equatable {
    case unavailable, network, invalidResponse, storage, invalidEmail, passwordRequired, passwordTooLong, invalidCredentials, invalidCodeFormat, invalidCode, signInRequired, rateLimited, deletionUnavailable, deletionFailed

    var errorDescription: String? {
        switch self {
        case .unavailable: "Nudge account sign-in is not available yet. Your local diary is still available."
        case .network: "Nudge could not reach the account service. Check your connection and try again."
        case .invalidResponse: "The account service returned a response Nudge could not verify. Try again later."
        case .storage: "Nudge could not access its secure account storage. Unlock your iPhone and try again."
        case .invalidEmail: "Enter a valid email address."
        case .passwordRequired: "Enter your password, or choose Email me a code."
        case .passwordTooLong: "That password is too long. Choose Email me a code to sign in."
        case .invalidCredentials: "That email and password were not accepted. Check them, or choose Email me a code."
        case .invalidCodeFormat: "Enter the complete code from your email: 6–10 digits, with no letters or spaces between digits."
        case .invalidCode: "That code was not accepted or has expired. Check the code or request a new one."
        case .signInRequired: "Your account session has ended. Sign in again to analyse photos."
        case .rateLimited: "Please wait before requesting another code or trying again."
        case .deletionUnavailable: "Account deletion is temporarily unavailable. Try again later."
        case .deletionFailed: "Nudge could not confirm account deletion. Your account has not been signed out. Try again later."
        }
    }
}

struct AccountConfiguration: Decodable {
    let enabled: Bool
    let provider: String?
    let url: URL?
    let publishableKey: String?
    let deletionAvailable: Bool?

    static func validProviderURL(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", let host = parts.host,
              host.range(of: #"^[a-z0-9][a-z0-9-]{0,62}\.supabase\.co$"#, options: .regularExpression) != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443, parts.path.isEmpty || parts.path == "/" else { return false }
        return true
    }

    func validated() throws -> AccountConfiguration? {
        guard enabled else { return nil }
        guard provider == "supabase", let url, Self.validProviderURL(url), let publishableKey,
              publishableKey.range(of: #"^sb_publishable_[A-Za-z0-9_-]{8,512}$"#, options: .regularExpression) != nil,
              deletionAvailable != nil else { throw AccountError.invalidResponse }
        return self
    }
}

/// Only this native account record contains account tokens. It is unrelated to
/// the private backend connection and to the WebKit diary/origin.
struct AccountSession: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var userID: String
    var email: String
    var providerURL: URL
    var reauthenticationRequired = false

    func validated() throws -> AccountSession {
        guard AccountConfiguration.validProviderURL(providerURL), UUID(uuidString: userID) != nil,
              NudgeAccountManager.validEmail(email), expiresAt.timeIntervalSince1970.isFinite,
              accessToken.utf8.count <= 8_192,
              accessToken.range(of: #"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil,
              refreshToken.range(of: #"^[A-Za-z0-9._~-]{8,4096}$"#, options: .regularExpression) != nil else {
            throw AccountError.invalidResponse
        }
        return self
    }
}

@MainActor protocol AccountSessionStore {
    func load() throws -> AccountSession?
    func save(_ session: AccountSession) throws
    func clear() throws
}

@MainActor final class KeychainAccountSessionStore: AccountSessionStore {
    private var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "org.example.nudge.account",
        kSecAttrAccount as String: "session-v1"
    ] }

    func load() throws -> AccountSession? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 32_768,
              let session = try? JSONDecoder().decode(AccountSession.self, from: data).validated() else { throw AccountError.storage }
        return session
    }

    func save(_ session: AccountSession) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(session),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw AccountError.storage }
        } else if status != errSecSuccess { throw AccountError.storage }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw AccountError.storage }
    }
}

struct AccountHTTPResponse {
    let statusCode: Int
    let data: Data
}

@MainActor protocol AccountHTTPTransport {
    func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse
}

/// A streaming bound prevents even an invalid service response from accumulating
/// an unlimited body. Redirects, cookies and caches are disabled for every call.
@MainActor final class URLSessionAccountTransport: AccountHTTPTransport {
    func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: LabelSessionDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse,
              response.expectedContentLength <= Int64(maximumBytes) else { throw AccountError.invalidResponse }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < maximumBytes else { throw AccountError.invalidResponse }
            data.append(byte)
        }
        return AccountHTTPResponse(statusCode: response.statusCode, data: data)
    }
}

@MainActor final class NudgeAccountManager {
    static let backendURL = NudgeServiceConfiguration.backendURL
    static let shared = NudgeAccountManager(store: KeychainAccountSessionStore(), transport: URLSessionAccountTransport(), removeCaptures: { owner in
        try NativeCaptureOutbox(directory: NudgeDataStore.shared.captureDirectory).removeOwner(owner)
    })

    private let store: AccountSessionStore
    private let transport: AccountHTTPTransport
    private let now: () -> Date
    private let removeCaptures: (String) throws -> Void
    private var session: AccountSession?
    private var storageFailed = false
    private var verified = false
    private var configuration: AccountConfiguration?
    private var configurationLoaded = false
    private var configurationTask: Task<AccountConfiguration?, Error>?
    private var credentialTask: Task<AccountSession, Error>?
    private var credentialTaskID: UUID?
    private var operationGeneration = 0
    private var publicState = "checking"
    static let accountStateChanged = Notification.Name("NudgeAccountStateChanged")
    private(set) var revision = 0 {
        didSet { NotificationCenter.default.post(name: Self.accountStateChanged, object: self) }
    }
    private(set) var pendingEmail: String?

    // Tests must supply both dependencies; they never instantiate the singleton.
    init(store: AccountSessionStore, transport: AccountHTTPTransport, now: @escaping () -> Date = Date.init, removeCaptures: @escaping (String) throws -> Void = { _ in }) {
        self.store = store
        self.transport = transport
        self.now = now
        self.removeCaptures = removeCaptures
        do { session = try store.load()?.validated() }
        catch { storageFailed = true; publicState = "unavailable" }
    }

    nonisolated static func validEmail(_ value: String) -> Bool {
        value.utf8.count <= 254 && value.range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
    }

    func publicStatus() -> [String: Any] {
        var status: [String: Any] = ["state": publicState, "available": configuration != nil && !storageFailed]
        if let session { status["email"] = session.email }
        return status
    }

    var canDeleteAccount: Bool { configuration?.deletionAvailable == true && session != nil && !storageFailed }

    /// Available without a network refresh, even when the selected session has
    /// expired. A queued capture must never adopt the next signed-in account.
    var captureOwnerKey: String? {
        guard !storageFailed else { return nil }
        if let session { return try? ProductContributionService.accountOwnerKey(userID: session.userID, baseURL: Self.backendURL) }
        if let config = BackendCredentialStore.configuration() { return try? ProductContributionService.ownerKey(token: config.token, baseURL: config.baseURL) }
        return "local-guest"
    }

    func loadConfiguration() async throws {
        publicState = "checking"
        do {
            if storageFailed {
                do { session = try store.load()?.validated(); storageFailed = false; verified = false }
                catch { throw AccountError.storage }
            }
            _ = try await fetchConfiguration(reload: true)
            if session != nil && !storageFailed && session?.reauthenticationRequired != true {
                _ = try await authorization()
            }
            updatePublicState()
        } catch {
            updatePublicState(failed: !(error is CancellationError))
            throw sanitize(error)
        }
    }

    private func updatePublicState(failed: Bool = false) {
        if storageFailed || configurationLoaded && configuration == nil { publicState = "unavailable" }
        else if session?.reauthenticationRequired == true { publicState = "signedOut" }
        else if failed { publicState = "unavailable" }
        else if session != nil && verified { publicState = "signedIn" }
        else if session != nil { publicState = "checking" }
        else { publicState = "signedOut" }
    }

    private func fetchConfiguration(reload: Bool = false) async throws -> AccountConfiguration? {
        if !reload && configurationLoaded { return configuration }
        if let task = configurationTask { return try await task.value }
        let task = Task<AccountConfiguration?, Error> { [self] in
            let response = try await request(url: Self.backendURL.appendingPathComponent("v1/account/config"), maximumBytes: 8_192)
            guard response.statusCode == 200 else { throw AccountError.unavailable }
            return try JSONDecoder().decode(AccountConfiguration.self, from: response.data).validated()
        }
        configurationTask = task
        defer { configurationTask = nil }
        do {
            let result = try await task.value
            configuration = result
            configurationLoaded = true
            return result
        } catch {
            configuration = nil
            configurationLoaded = false
            throw sanitize(error)
        }
    }

    /// A selected account that expires or is rejected remains selected until an
    /// explicit sign-out. Returning nil here would borrow the owner's allowance.
    func authorization() async throws -> AccountAuthorization? {
        guard !storageFailed else { throw AccountError.storage }
        guard let selected = session else { return nil }
        guard !selected.reauthenticationRequired else { throw AccountError.signInRequired }
        let expectedRevision = revision
        guard let config = try await fetchConfiguration(), let providerURL = config.url,
              selected.providerURL.host == providerURL.host else { throw AccountError.unavailable }
        guard revision == expectedRevision, session?.userID == selected.userID else { throw CancellationError() }
        // Another waiter can complete a rotation while configuration is loading.
        // Always select the current token pair after that suspension point.
        guard let initial = session, !initial.reauthenticationRequired else { throw AccountError.signInRequired }
        if verified && initial.expiresAt.timeIntervalSince(now()) > 60 {
            return AccountAuthorization(backendURL: Self.backendURL, token: initial.accessToken)
        }
        let result: AccountSession
        if let credentialTask { result = try await credentialTask.value }
        else {
            let identifier = UUID()
            let task = Task<AccountSession, Error> { [self] in
                let refreshed: AccountSession
                if initial.expiresAt.timeIntervalSince(now()) <= 60 {
                    let response = try await providerRequest(config, path: "token", query: "grant_type=refresh_token", body: ["refresh_token": initial.refreshToken])
                    if response.statusCode == 400 || response.statusCode == 401 || response.statusCode == 403 {
                        guard revision == expectedRevision else { throw CancellationError() }
                        requireSignIn()
                        throw AccountError.signInRequired
                    }
                    guard response.statusCode == 200 else { throw Self.providerError(response.statusCode) }
                    refreshed = try decodeSession(response.data, providerURL: providerURL, expectedEmail: initial.email)
                    guard refreshed.userID == initial.userID else { throw AccountError.invalidResponse }
                } else {
                    let response = try await providerRequest(config, path: "user", method: "GET", token: initial.accessToken)
                    if response.statusCode == 401 || response.statusCode == 403 {
                        guard revision == expectedRevision else { throw CancellationError() }
                        requireSignIn()
                        throw AccountError.signInRequired
                    }
                    guard response.statusCode == 200 else { throw Self.providerError(response.statusCode) }
                    let user = try JSONDecoder().decode(ProviderUser.self, from: response.data)
                    guard user.id == initial.userID, user.email?.lowercased() == initial.email.lowercased() else { throw AccountError.invalidResponse }
                    refreshed = initial
                }
                try Task.checkCancellation()
                guard revision == expectedRevision, session == initial else { throw CancellationError() }
                if refreshed != initial { try store.save(refreshed) }
                session = refreshed
                verified = true
                updatePublicState()
                return refreshed
            }
            credentialTask = task
            credentialTaskID = identifier
            do { result = try await task.value }
            catch {
                if credentialTaskID == identifier { credentialTask = nil; credentialTaskID = nil }
                if revision == expectedRevision { updatePublicState(failed: !(error is CancellationError)) }
                throw sanitize(error)
            }
            if credentialTaskID == identifier { credentialTask = nil; credentialTaskID = nil }
        }
        try Task.checkCancellation()
        guard revision == expectedRevision, session == result, !result.reauthenticationRequired else { throw CancellationError() }
        return AccountAuthorization(backendURL: Self.backendURL, token: result.accessToken)
    }

    func requireSignIn() {
        guard var selected = session else { return }
        selected.reauthenticationRequired = true
        session = selected
        verified = false
        // This flag survives restart so a rejected account never falls through
        // to the distinct private owner connection.
        do { try store.save(selected) } catch { storageFailed = true }
        updatePublicState()
        NotificationCenter.default.post(name: Self.accountStateChanged, object: self)
    }

    func cancelSignIn() {
        operationGeneration += 1
        pendingEmail = nil
    }

    func sendCode(email: String) async throws {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validEmail(email) else { throw AccountError.invalidEmail }
        cancelSignIn()
        let generation = operationGeneration
        guard let config = try await fetchConfiguration() else { throw AccountError.unavailable }
        try checkOperation(generation)
        let response = try await providerRequest(config, path: "otp", body: ["email": email, "create_user": true])
        try checkOperation(generation)
        guard response.statusCode == 200 else { throw Self.providerError(response.statusCode) }
        pendingEmail = email
    }

    /// Uses the ordinary provider password grant. The password is neither saved
    /// in the account session nor forwarded to Nudge's backend.
    func signInWithPassword(email: String, password: String) async throws {
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validEmail(email) else { throw AccountError.invalidEmail }
        guard !password.isEmpty else { throw AccountError.passwordRequired }
        // Do not trim, normalize or truncate passwords: spaces may be intentional.
        guard password.utf8.count <= 4_096 else { throw AccountError.passwordTooLong }
        cancelSignIn()
        let generation = operationGeneration
        guard let config = try await fetchConfiguration(), let providerURL = config.url else { throw AccountError.unavailable }
        try checkOperation(generation)
        let response = try await providerRequest(config, path: "token", query: "grant_type=password",
                                                 body: ["email": email, "password": password])
        try checkOperation(generation)
        guard response.statusCode == 200 else {
            if [400, 401, 403, 422].contains(response.statusCode) { throw AccountError.invalidCredentials }
            throw Self.providerError(response.statusCode)
        }
        try installSession(response.data, providerURL: providerURL, expectedEmail: email, generation: generation)
    }

    nonisolated static func normalizedCode(_ input: String) throws -> String {
        // Bound pasted text before trimming. Never filter arbitrary text into a
        // different code, convert to a number, or discard leading zeroes.
        guard input.utf8.count <= 128 else { throw AccountError.invalidCodeFormat }
        let code = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (6...10).contains(code.utf8.count), code.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw AccountError.invalidCodeFormat
        }
        return code
    }

    func verifyCode(_ input: String) async throws {
        let code = try Self.normalizedCode(input)
        guard let email = pendingEmail else { throw AccountError.invalidCode }
        let generation = operationGeneration
        guard let config = try await fetchConfiguration(), let providerURL = config.url else { throw AccountError.unavailable }
        try checkOperation(generation)
        let response = try await providerRequest(config, path: "verify", body: ["email": email, "token": code, "type": "email"])
        try checkOperation(generation)
        guard response.statusCode == 200 else {
            if response.statusCode == 400 || response.statusCode == 401 || response.statusCode == 403 { throw AccountError.invalidCode }
            throw Self.providerError(response.statusCode)
        }
        try installSession(response.data, providerURL: providerURL, expectedEmail: email, generation: generation)
    }

    private func installSession(_ data: Data, providerURL: URL, expectedEmail: String, generation: Int) throws {
        try checkOperation(generation)
        let selected: AccountSession
        do { selected = try decodeSession(data, providerURL: providerURL, expectedEmail: expectedEmail) }
        catch { throw sanitize(error) }
        // Commit durable credentials before changing the selected account. A
        // failed save leaves the previous account and its capture ownership intact.
        try store.save(selected)
        credentialTask?.cancel(); credentialTask = nil; credentialTaskID = nil
        session = selected
        storageFailed = false
        verified = true
        revision += 1
        cancelSignIn()
        updatePublicState()
    }

    /// Local sign-out always works without a network response. Remote revocation
    /// is best effort and its result is reported accurately to the person.
    func signOut() async throws -> String {
        cancelSignIn()
        let generation = operationGeneration
        let expectedRevision = revision
        var selected = session
        // Refresh an expired token while it is still durably stored, so normal
        // online sign-out can revoke it. An already-running rotation is cancelled
        // below rather than starting another one or making local sign-out wait.
        if let current = selected, current.expiresAt.timeIntervalSince(now()) <= 60,
           !current.reauthenticationRequired, credentialTask == nil, !storageFailed {
            _ = try? await authorization()
            try checkOperation(generation)
            guard revision == expectedRevision else { throw CancellationError() }
            selected = session
        }
        try store.clear()
        cancelSignIn()
        credentialTask?.cancel(); credentialTask = nil; credentialTaskID = nil
        session = nil
        verified = false
        storageFailed = false
        revision += 1
        updatePublicState()
        guard let selected else { return "Signed out on this iPhone. Your local diary is unchanged." }
        do {
            let response = try await request(url: Self.backendURL.appendingPathComponent("v1/account/logout"), method: "POST", token: selected.accessToken, body: [:])
            guard response.statusCode == 200, try JSONDecoder().decode(Success.self, from: response.data).ok else { throw AccountError.network }
            return "Signed out. Your local diary is unchanged."
        } catch {
            return "Signed out on this iPhone. Server sign-out could not be confirmed; the previous server session may remain active. Your local diary is unchanged."
        }
    }

    func deleteAccount() async throws {
        guard let config = try await fetchConfiguration(), config.deletionAvailable == true else { throw AccountError.deletionUnavailable }
        guard let authorization = try await authorization() else { throw AccountError.signInRequired }
        guard let owner = captureOwnerKey else { throw AccountError.storage }
        let expectedRevision = revision
        let response = try await request(url: Self.backendURL.appendingPathComponent("v1/account"), method: "DELETE", token: authorization.token)
        try Task.checkCancellation()
        guard expectedRevision == revision else { throw CancellationError() }
        if response.statusCode == 401 { requireSignIn(); throw AccountError.signInRequired }
        if response.statusCode == 503 { throw AccountError.deletionUnavailable }
        guard response.statusCode == 200, (try? JSONDecoder().decode(Success.self, from: response.data).ok) == true else { throw AccountError.deletionFailed }
        do { try removeCaptures(owner); try store.clear() }
        catch { requireSignIn(); throw AccountError.storage }
        credentialTask?.cancel(); credentialTask = nil; credentialTaskID = nil
        session = nil
        verified = false
        storageFailed = false
        revision += 1
        cancelSignIn()
        updatePublicState()
    }

    private struct ProviderUser: Decodable { let id: String; let email: String? }
    private struct ProviderSession: Decodable {
        let access_token: String
        let refresh_token: String
        let token_type: String
        let expires_in: Double
        let expires_at: Double?
        let user: ProviderUser
    }
    private struct Success: Decodable { let ok: Bool }

    private func decodeSession(_ data: Data, providerURL: URL, expectedEmail: String) throws -> AccountSession {
        let response = try JSONDecoder().decode(ProviderSession.self, from: data)
        guard response.token_type.lowercased() == "bearer", let email = response.user.email,
              email.lowercased() == expectedEmail.lowercased(), response.expires_in.isFinite,
              response.expires_in > 0, response.expires_in <= 604_800 else { throw AccountError.invalidResponse }
        let expires = response.expires_at.map { Date(timeIntervalSince1970: $0) } ?? now().addingTimeInterval(response.expires_in)
        guard expires.timeIntervalSince(now()) > 0, expires.timeIntervalSince(now()) <= 604_800 else { throw AccountError.invalidResponse }
        return try AccountSession(accessToken: response.access_token, refreshToken: response.refresh_token, expiresAt: expires,
                                  userID: response.user.id, email: email, providerURL: providerURL).validated()
    }

    private func checkOperation(_ generation: Int) throws {
        try Task.checkCancellation()
        guard generation == operationGeneration else { throw CancellationError() }
    }

    private static func providerError(_ status: Int) -> AccountError {
        if status == 429 { return .rateLimited }
        if status == 400 || status == 401 || status == 403 { return .signInRequired }
        if status >= 500 { return .unavailable }
        return .invalidResponse
    }

    private func sanitize(_ error: Error) -> Error {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return CancellationError() }
        if let error = error as? AccountError { return error }
        if error is DecodingError { return AccountError.invalidResponse }
        return AccountError.network
    }

    private func providerRequest(_ config: AccountConfiguration, path: String, method: String = "POST", query: String? = nil,
                                 token: String? = nil, body: [String: Any]? = nil) async throws -> AccountHTTPResponse {
        guard let origin = config.url, let key = config.publishableKey else { throw AccountError.unavailable }
        var parts = URLComponents(url: origin.appendingPathComponent("auth/v1/\(path)"), resolvingAgainstBaseURL: false)!
        parts.query = query
        return try await request(url: parts.url!, method: method, token: token, publicKey: key, body: body)
    }

    private func request(url: URL, method: String = "GET", token: String? = nil, publicKey: String? = nil,
                         body: [String: Any]? = nil, maximumBytes: Int = 65_536) async throws -> AccountHTTPResponse {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let publicKey { request.setValue(publicKey, forHTTPHeaderField: "apikey") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        do {
            let response = try await transport.send(request, maximumBytes: maximumBytes)
            guard response.data.count <= maximumBytes else { throw AccountError.invalidResponse }
            return response
        } catch { throw sanitize(error) }
    }
}

@MainActor enum AccountConnectionPresenter {
    static func present(from presenter: UIViewController, onChange: @escaping () -> Void) {
        guard presenter.presentedViewController == nil else { return }
        let controller = AccountConnectionViewController(manager: .shared, onChange: onChange)
        let navigation = UINavigationController(rootViewController: controller)
        navigation.modalPresentationStyle = .pageSheet
        NudgeTheme.navigation(navigation)
        presenter.present(navigation, animated: true)
        navigation.presentationController?.delegate = controller
    }
}

/// Supabase's email template must contain {{ .Token }}; its default magic-link
/// template is not sufficient for this native code-entry flow. No SDK/deep link
/// or ChatGPT subscription is involved, and no account action accesses the diary.
@MainActor final class AccountConnectionViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
    private let manager: NudgeAccountManager
    private let onChange: () -> Void
    private let onSignedIn: (() -> Void)?
    private let stack = UIStackView()
    private let scrollView = UIScrollView()
    private let activity = UIActivityIndicatorView(style: .medium)
    private let message = UILabel()
    private let email = UITextField()
    private let password = UITextField()
    private let code = UITextField()
    private var task: Task<Void, Never>?
    private var busy = false
    private var notice: String?
    private var noticeIsError = false
    private var passwordSignIn = false
    private var invalidated = false

    init(manager: NudgeAccountManager, onSignedIn: (() -> Void)? = nil, onChange: @escaping () -> Void) {
        self.manager = manager; self.onSignedIn = onSignedIn; self.onChange = onChange
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Nudge account"
        view.backgroundColor = NudgeTheme.canvas
        view.tintColor = NudgeTheme.accent
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Close", primaryAction: UIAction { [weak self] _ in self?.close() })
        stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.keyboardDismissMode = .interactive
        scrollView.accessibilityIdentifier = "account-form"
        view.addSubview(scrollView)
        scrollView.addSubview(stack)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -48)
        ])
        message.numberOfLines = 0; message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.accessibilityIdentifier = "account-feedback"
        message.setContentCompressionResistancePriority(.required, for: .vertical)
        activity.hidesWhenStopped = true
        activity.color = NudgeTheme.accent
        activity.accessibilityIdentifier = "account-progress"
        email.placeholder = "Email address"; email.keyboardType = .emailAddress; email.textContentType = .username
        email.autocapitalizationType = .none; email.autocorrectionType = .no; email.borderStyle = .roundedRect
        email.accessibilityIdentifier = "account-email"
        password.placeholder = "Password"; password.isSecureTextEntry = true; password.textContentType = .password
        password.autocapitalizationType = .none; password.autocorrectionType = .no; password.spellCheckingType = .no
        password.smartQuotesType = .no; password.smartDashesType = .no; password.borderStyle = .roundedRect
        password.accessibilityIdentifier = "account-password"
        code.placeholder = "6-digit code"; code.keyboardType = .numberPad; code.textContentType = .oneTimeCode
        code.borderStyle = .roundedRect; code.accessibilityIdentifier = "account-code"
        for field in [email, password, code] {
            field.font = .preferredFont(forTextStyle: .body)
            field.adjustsFontForContentSizeCategory = true
            field.backgroundColor = NudgeTheme.surface
            field.textColor = NudgeTheme.ink
            field.attributedPlaceholder = NSAttributedString(string: field.placeholder ?? "", attributes: [.foregroundColor: NudgeTheme.muted])
            field.tintColor = NudgeTheme.accent
            field.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
        }
        render()
        run { [self] in try await manager.loadConfiguration() }
    }

    private func render() {
        stack.arrangedSubviews.forEach { stack.removeArrangedSubview($0); $0.removeFromSuperview() }
        let status = manager.publicStatus()
        let state = status["state"] as? String ?? "unavailable"
        let available = status["available"] as? Bool == true
        message.text = notice ?? (busy ? "Checking your account…" : state == "signedIn"
            ? "Your Nudge account is ready. Your diary stays on this iPhone."
            : passwordSignIn ? "Sign in with your existing Nudge password. You can use an email code instead."
            : "Enter your email address to sign in or create your Nudge account. We’ll email you a 6-digit code — no password needed.")
        message.textColor = noticeIsError ? NudgeTheme.errorText : NudgeTheme.ink
        if onSignedIn != nil {
            let heading = UILabel()
            heading.text = "Welcome to Nudge"
            heading.font = .preferredFont(forTextStyle: .largeTitle)
            heading.adjustsFontForContentSizeCategory = true
            heading.numberOfLines = 0
            heading.textColor = NudgeTheme.ink
            heading.accessibilityTraits.insert(.header)
            heading.accessibilityIdentifier = "account-onboarding-title"
            heading.setContentCompressionResistancePriority(.required, for: .vertical)
            stack.addArrangedSubview(heading)
        }
        stack.addArrangedSubview(activity)
        stack.addArrangedSubview(message)
        if state == "signedIn" {
            let identity = UILabel(); identity.numberOfLines = 0; identity.font = .preferredFont(forTextStyle: .body); identity.adjustsFontForContentSizeCategory = true; identity.textColor = NudgeTheme.ink; identity.text = "Signed in as \(status["email"] as? String ?? "your account")"
            stack.addArrangedSubview(identity)
            if let onSignedIn { addButton("Continue", identifier: "account-continue", action: onSignedIn) }
            addButton("Sign out", destructive: false) { [weak self] in
                self?.run(progress: "Signing out…") { [weak self] in guard let self else { return }; self.notice = try await self.manager.signOut() }
            }
            if manager.canDeleteAccount { addButton("Delete Nudge account", destructive: true) { [weak self] in self?.confirmDeletion() } }
        } else if available {
            if let pending = manager.pendingEmail {
                let label = UILabel(); label.numberOfLines = 0; label.font = .preferredFont(forTextStyle: .body); label.adjustsFontForContentSizeCategory = true; label.textColor = NudgeTheme.ink; label.text = "Enter the code sent to \(pending)."
                stack.addArrangedSubview(label); stack.addArrangedSubview(code)
                addButton("Verify code", identifier: "account-verify") { [weak self] in
                    guard let self else { return }
                    let enteredCode = self.code.text ?? ""
                    self.run(progress: "Verifying your code…", onSuccess: self.onSignedIn) { [weak self] in guard let self else { return }; try await self.manager.verifyCode(enteredCode); self.code.text = ""; self.notice = "You’re signed in. Ready to scan." }
                }
                addButton("Send a new code", identifier: "account-resend-code") { [weak self] in self?.run(progress: "Sending your code…") { [weak self] in guard let self else { return }; try await self.manager.sendCode(email: pending); self.code.text = ""; self.notice = "A new sign-in code has been requested." } }
                addButton("Use another email", identifier: "account-change-email") { [weak self] in guard let self else { return }; self.manager.cancelSignIn(); self.code.text = ""; self.password.text = ""; self.passwordSignIn = false; self.notice = nil; self.noticeIsError = false; self.render() }
            } else {
                if email.text?.isEmpty != false { email.text = status["email"] as? String }
                stack.addArrangedSubview(email)
                if passwordSignIn {
                    stack.addArrangedSubview(password)
                    addButton("Sign in with password", identifier: "account-sign-in-password") { [weak self] in
                        guard let self else { return }
                        let enteredEmail = self.email.text ?? "", enteredPassword = self.password.text ?? ""
                        self.password.text = ""
                        self.run(progress: "Signing in…", onSuccess: self.onSignedIn) { [weak self] in
                            guard let self else { return }
                            try await self.manager.signInWithPassword(email: enteredEmail, password: enteredPassword)
                            self.notice = "You’re signed in. Ready to scan."
                        }
                    }
                    addButton("Use an email code", identifier: "account-use-code") { [weak self] in
                        self?.switchSignInMethod(password: false)
                    }
                } else {
                    addButton("Email me a code", identifier: "account-send-code") { [weak self] in
                        guard let self else { return }
                        let enteredEmail = self.email.text ?? ""
                        self.password.text = ""
                        self.run(progress: "Sending your code…") { [weak self] in guard let self else { return }; try await self.manager.sendCode(email: enteredEmail); self.notice = "Check your email for your 6-digit Nudge sign-in code. If it hasn’t arrived, check your junk folder." }
                    }
                    addButton("Sign in with a password", identifier: "account-use-password") { [weak self] in
                        self?.switchSignInMethod(password: true)
                    }
                }
                if status["email"] != nil { addButton("Sign out on this iPhone") { [weak self] in self?.run { [weak self] in guard let self else { return }; self.notice = try await self.manager.signOut() } } }
            }
        } else {
            if !busy && notice == nil { message.text = AccountError.unavailable.localizedDescription }
            addButton("Try again") { [weak self] in self?.run { [weak self] in try await self?.manager.loadConfiguration() } }
            if status["email"] != nil { addButton("Sign out on this iPhone") { [weak self] in self?.run { [weak self] in guard let self else { return }; self.notice = try await self.manager.signOut() } } }
        }
        for control in stack.arrangedSubviews.compactMap({ $0 as? UIControl }) { control.isEnabled = !busy }
    }

    private func switchSignInMethod(password: Bool) {
        guard !busy else { return }
        manager.cancelSignIn()
        passwordSignIn = password
        self.password.text = ""; code.text = ""
        notice = nil; noticeIsError = false
        render()
    }

    private func addButton(_ title: String, destructive: Bool = false, identifier: String? = nil, action: @escaping () -> Void) {
        let primary = identifier == "account-send-code" || identifier == "account-verify" || identifier == "account-sign-in-password" || identifier == "account-continue" || title == "Try again"
        let button = NudgeButton(title, variant: destructive ? .destructive : primary ? .primary : .secondary)
        button.accessibilityIdentifier = identifier
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        stack.addArrangedSubview(button)
    }

    private func run(progress: String = "Checking your account…", onSuccess: (() -> Void)? = nil, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy && !invalidated else { return }
        busy = true; notice = nil; noticeIsError = false
        // Preserve the actual controls and their text during submission. Replacing
        // the form here used to flash the page before reading the entered value.
        message.text = progress; message.textColor = NudgeTheme.ink
        activity.startAnimating()
        for control in stack.arrangedSubviews.compactMap({ $0 as? UIControl }) { control.isEnabled = false }
        view.endEditing(true)
        revealFeedback()
        task = Task { [weak self] in
            var succeeded = false
            do { try await operation(); succeeded = true }
            catch is CancellationError { }
            catch {
                self?.notice = (error as? AccountError)?.localizedDescription ?? AccountError.network.localizedDescription
                self?.noticeIsError = true
            }
            guard let self, !self.invalidated else { return }
            self.busy = false
            self.password.text = ""
            self.task = nil
            self.activity.stopAnimating()
            if !Task.isCancelled {
                self.render()
                self.revealFeedback()
                if let notice = self.notice { UIAccessibility.post(notification: .announcement, argument: notice) }
            }
            self.onChange()
            if succeeded && !Task.isCancelled { onSuccess?() }
        }
    }

    /// SwiftUI's embedded sign-in form has no UIKit dismissal delegate. Its
    /// dismantle hook uses this to prevent late responses/callbacks after leaving.
    func cancelPendingSignIn() {
        invalidated = true
        task?.cancel(); task = nil
        manager.cancelSignIn()
        email.text = ""; code.text = ""; password.text = ""
    }

    private func revealFeedback() {
        view.layoutIfNeeded()
        scrollView.scrollRectToVisible(message.convert(message.bounds, to: scrollView).insetBy(dx: 0, dy: -16), animated: false)
    }

    private func confirmDeletion() {
        let alert = UIAlertController(title: "Delete Nudge account?", message: "This permanently deletes your Nudge sign-in account, ambassador profile and points. Your saved diary stays on this iPhone; approved product facts stay in the catalogue. A security marker may remain for up to 10 minutes to reject older requests. This cannot be undone.", preferredStyle: .alert)
        alert.view.tintColor = NudgeTheme.accent
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Delete account", style: .destructive) { [weak self] _ in
            self?.run(progress: "Deleting your account…") { [weak self] in guard let self else { return }; try await self.manager.deleteAccount(); self.notice = "Your Nudge account was deleted. Your local diary is unchanged." }
        })
        present(alert, animated: true)
    }

    private func close() {
        cancelPendingSignIn()
        dismiss(animated: true) { [onChange] in onChange() }
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        cancelPendingSignIn(); onChange()
    }
}

// Export-only configuration. The reserved .invalid origin fails closed until configured.
enum NudgeServiceConfiguration {
    static let backendURL: URL = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "NudgeBackendURL") as? String,
              let value = URL(string: raw), value.scheme == "https", value.host != nil,
              value.user == nil, value.password == nil, value.query == nil, value.fragment == nil,
              value.path.isEmpty || value.path == "/"
        else { return URL(string: "https://configure-nudge-backend.invalid")! }
        return value
    }()
}
