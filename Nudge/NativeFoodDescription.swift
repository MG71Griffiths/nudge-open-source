import Foundation
import SwiftUI

/// A description is private analysis input. It is never a catalogue contribution
/// or a diary entry until the user confirms the existing food-review screen.
struct NativeFoodDescriptionService {
    struct Authorization {
        let baseURL: URL
        let token: String
        var isCurrent: () async -> Bool = { true }
    }
    enum Failure: LocalizedError {
        case invalidDescription, signIn, permission, invalidResponse, limited, unavailable, unresolved
        var errorDescription: String? {
            switch self {
            case .invalidDescription: "Describe your food in 2–2,000 characters. Include amounts if you know them."
            case .signIn: "Sign in to Nudge to analyse this description online. Your text is still here."
            case .permission: "AI analysis is off. Enable it in Food AI settings to analyse this description online."
            case .invalidResponse: "Nudge couldn’t check that estimate. Your text is still here; please try again."
            case .limited: "Your analysis allowance is temporarily full. Try again later; your text is still here."
            case .unavailable: "The estimate couldn’t finish. Check your connection and try again. Your text is still here."
            case .unresolved: "Add the food’s ingredients or amounts so Nudge can estimate it."
            }
        }
    }
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 12
        return URLSession(configuration: config, delegate: LabelSessionDelegate(), delegateQueue: nil)
    }()
    var session: URLSession = Self.session
    var analysisAllowed: () -> Bool = { PhotoAnalysisPermission().allowed }
    var authorize: () async throws -> Authorization = {
        let manager = await NudgeAccountManager.shared
        let revision = await manager.revision
        let account = try await manager.authorization()
        let config: BackendConfiguration
        if let account { config = .init(baseURL: account.backendURL, token: account.token) }
        else if let saved = BackendCredentialStore.configuration() { config = saved }
        else { throw Failure.signIn }
        guard await manager.revision == revision else { throw CancellationError() }
        return Authorization(baseURL: config.baseURL, token: config.token,
                             isCurrent: { await manager.revision == revision })
    }

    static func validDescription(_ text: String) -> Bool {
        let count = text.utf16.count
        return (2...2_000).contains(count) && text.utf8.count <= 10_000 &&
            !text.unicodeScalars.contains { ($0.value < 32 && $0.value != 10 && $0.value != 13 && $0.value != 9) || $0.value == 127 }
    }
    func analyse(description: String, requestID: UUID) async throws -> [String: Any] {
        guard Self.validDescription(description) else { throw Failure.invalidDescription }
        guard analysisAllowed() else { throw Failure.permission }
        let auth: Authorization
        do { auth = try await authorize() }
        catch is CancellationError { throw CancellationError() }
        catch { throw Failure.signIn }
        guard await auth.isCurrent(), analysisAllowed() else { throw CancellationError() }
        guard BackendConfiguration.validatedURL(auth.baseURL.absoluteString) != nil else { throw Failure.unavailable }
        let id = requestID.uuidString.lowercased()
        let body = try JSONSerialization.data(withJSONObject: ["description": description, "requestId": id])
        guard body.count <= 12_288 else { throw Failure.invalidDescription }
        var request = URLRequest(url: auth.baseURL.appendingPathComponent("v1/food-description/analyse"))
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(auth.token)", forHTTPHeaderField: "Authorization")
        let data: Data, response: HTTPURLResponse
        do { (data, response) = try await BoundedHTTPData.load(request, session: session, maximumBytes: 65_536) }
        catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw Failure.unavailable
        }
        try Task.checkCancellation()
        guard await auth.isCurrent(), analysisAllowed() else { throw CancellationError() }
        switch response.statusCode {
        case 200: break
        case 401, 403: throw Failure.signIn
        case 429: throw Failure.limited
        case 400, 422: throw Failure.unresolved
        default: throw Failure.unavailable
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["version"] as? Int == 1, object["requestId"] as? String == id,
              object["entry"] is [String: Any] else { throw Failure.invalidResponse }
        // The shared engine independently validates sources and recalculates
        // quantities, nutrients and rating before this can become a review.
        return object
    }
}

@MainActor
struct NativeFoodDescriptionView: View {
    @ObservedObject var store: NativeAppStore
    @FocusState private var focused: Bool
    private var text: String { store.foodDescription.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("What did you eat?").font(.largeTitle.bold())
                Text("Describe your food. Add amounts if you know them.")
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $store.foodDescription)
                        .frame(minHeight: 150).padding(8).focused($focused)
                        .scrollContentBackground(.hidden)
                        .disabled(store.describingFood)
                        .accessibilityLabel("Describe your food")
                        .accessibilityIdentifier("native-food-description-input")
                    if store.foodDescription.isEmpty {
                        Text("A sourdough cheese sandwich with chutney")
                            .foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.horizontal, 13).padding(.top, 16)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                if let message = store.foodDescriptionError {
                    Text(message).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.errorText))
                        .accessibilityIdentifier("native-food-description-error")
                    if store.foodDescriptionNeedsSignIn {
                        Button("Sign in", action: store.showAccount).buttonStyle(NudgeButtonStyle(variant: .secondary))
                    }
                    if store.foodDescriptionNeedsPermission {
                        Button("Food AI settings", action: store.showAISettings).buttonStyle(NudgeButtonStyle(variant: .secondary))
                    }
                }
                if store.describingFood {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Analysing…").font(.headline)
                        Spacer()
                        Button("Cancel", action: store.cancelFoodDescriptionAnalysis).frame(minHeight: 44)
                    }.accessibilityIdentifier("native-food-description-progress")
                } else {
                    Button { focused = false; store.analyseFoodDescription() } label: {
                        Label("Analyse food", systemImage: "sparkles").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(NudgeButtonStyle(variant: .primary))
                    .disabled(!NativeFoodDescriptionService.validDescription(text))
                    .accessibilityIdentifier("native-food-description-analyse")
                }
                Text("For online estimates, your description is sent to Nudge and OpenAI. Check the result before adding it to your diary.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
        }.scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("native-food-description")
    }
}
