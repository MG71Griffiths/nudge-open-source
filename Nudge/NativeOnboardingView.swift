import SwiftUI

/// Setup is presentation state only. It never resets accounts or local food data.
@MainActor struct NativeOnboardingView: View {
    static let completionKey = "nudge-onboarding-completed-v1"
    @ObservedObject private var connection = ChatGPTConnection.shared
    @State private var step = 1
    @State private var connecting = false
    @State private var accountRevision = NudgeAccountManager.shared.revision
    let onAccountChange: (Int) -> Void
    let onComplete: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("\(step) of 2 · \(step == 1 ? "Your Nudge account" : "Optional ChatGPT connection")")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    ProgressView(value: Double(step), total: 2)
                        .accessibilityLabel("Setup step \(step) of 2")
                }.padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 12)
                if step == 1 {
                    OnboardingAccountForm(onSignedIn: { step = 2 }, onChange: {
                        onAccountChange(accountRevision)
                        accountRevision = NudgeAccountManager.shared.revision
                    })
                    Button("Explore without signing in") { step = 2 }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                        .accessibilityIdentifier("onboarding-skip-account")
                        .padding(.horizontal, 24).padding(.bottom, 16)
                } else {
                    chatGPTStep
                }
            }
            .frame(maxWidth: 600).frame(maxWidth: .infinity)
            .background(Color(uiColor: NudgeTheme.canvas))
            .navigationTitle("Set up Nudge").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if step == 2 {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Back") { cancelSetupConnection(); step = 1 }
                    }
                }
            }
        }
        .foregroundStyle(Color(uiColor: NudgeTheme.ink)).tint(Color(uiColor: NudgeTheme.accent))
        .interactiveDismissDisabled()
        .accessibilityIdentifier("nudge-onboarding")
        .alert("You’re using your ChatGPT plan", isPresented: $connection.showWelcome) {
            Button("Got it") { connection.acknowledgeWelcome() }
        } message: {
            Text("Eligible requests use your existing ChatGPT allowance. You can review and limit Nudge’s usage in ChatGPT settings.")
        }
        .onDisappear { cancelSetupConnection() }
    }

    private var chatGPTReady: Bool {
        guard let binding = connection.cameraSelection else { return false }
        return connection.isCaptureBindingCurrent(binding) && binding.profileID == connection.selectedID
    }

    private var chatGPTStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Have a ChatGPT account?")
                    .font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                Text("Connect an eligible ChatGPT plan once to use it for camera photos and photo previews.")
                Text("This is optional. You can use Nudge’s regular analysis with your Nudge email sign-in, without a paid ChatGPT plan.")
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                if chatGPTReady {
                    Label("ChatGPT connected", systemImage: "checkmark.circle.fill")
                        .font(.headline).accessibilityIdentifier("onboarding-chatgpt-connected")
                    Text("Your existing connection is ready for camera photos and previews.")
                    Button("Start using Nudge", action: finish)
                        .buttonStyle(NudgeButtonStyle()).accessibilityIdentifier("onboarding-finish")
                } else {
                    Text("If you connect, photos, ingredient choices and portion details you submit go directly to OpenAI and use your ChatGPT allowance or enabled credits. Voice-note captures use Nudge’s service. Your diary, cycle details and ChatGPT conversations are not shared through this connection.")
                        .font(.footnote).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    if !connection.models.isEmpty {
                        Picker("Model", selection: Binding(get: { connection.selectedModel }, set: { connection.selectModel($0) })) {
                            if !connection.models.contains(where: { $0.id == connection.selectedModel }) {
                                Text("Choose an available model").tag(connection.selectedModel)
                            }
                            ForEach(connection.models) { model in Text(model.name).tag(model.id) }
                        }
                        .disabled(connection.busy)
                        .accessibilityIdentifier("onboarding-chatgpt-model")
                    }
                    Button(connection.active?.connected == true ? "Use my connected ChatGPT account" : "Connect ChatGPT") {
                        connecting = true
                        connection.continueWithChatGPT()
                    }.buttonStyle(NudgeButtonStyle()).disabled(connection.busy)
                        .accessibilityIdentifier("onboarding-connect-chatgpt")
                    if connection.busy && connecting {
                        HStack {
                            ProgressView()
                            Text("Connecting to ChatGPT…")
                            Spacer()
                            Button("Cancel", action: cancelSetupConnection)
                        }
                    }
                    if connecting, let message = connection.message {
                        Text(message).font(.callout).accessibilityIdentifier("onboarding-chatgpt-status")
                    }
                    Button("Skip for now", action: finish)
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                        .accessibilityIdentifier("onboarding-skip-chatgpt")
                }
                Text("You can manage both connections later in You. Your diary stays on this iPhone.")
                    .font(.footnote).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }.padding(.horizontal, 24).padding(.vertical, 12)
        }
    }

    private func cancelSetupConnection() {
        if connecting {
            if connection.busy { connection.cancel() }
            connecting = false
        }
    }

    private func finish() {
        cancelSetupConnection()
        onComplete()
    }
}

private struct OnboardingAccountForm: UIViewControllerRepresentable {
    let onSignedIn: () -> Void
    let onChange: () -> Void
    func makeUIViewController(context: Context) -> AccountConnectionViewController {
        AccountConnectionViewController(manager: .shared, onSignedIn: onSignedIn, onChange: onChange)
    }
    func updateUIViewController(_ controller: AccountConnectionViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: AccountConnectionViewController, coordinator: ()) {
        controller.cancelPendingSignIn()
    }
}
