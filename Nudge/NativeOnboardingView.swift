import SwiftUI

/// Profile edits use the same local save/target contract as My profile.
/// Setup never resets accounts, targets entered by the user, or food records.
@MainActor struct NativeOnboardingView: View {
    static let completionKey = "nudge-onboarding-completed-v2"
    static let previousCompletionKey = "nudge-onboarding-completed-v1"
    @ObservedObject var store: NativeAppStore
    @ObservedObject private var connection = ChatGPTConnection.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var step: Int
    @State private var connecting = false
    @State private var accountRevision = NudgeAccountManager.shared.revision
    @State private var draft: [String: Any] = [:]
    @State private var age = ""
    @State private var height = ProfileMeasurementDraft(kind: .height, value: nil)
    @State private var weight = ProfileMeasurementDraft(kind: .weight, value: nil)
    @State private var loaded = false
    @State private var error = ""
    @State private var targetEditor = false
    @FocusState private var ageFocused: Bool
    let onAccountChange: (Int) -> Void
    let onComplete: () -> Void

    init(store: NativeAppStore, startAtProfile: Bool = false,
         onAccountChange: @escaping (Int) -> Void, onComplete: @escaping () -> Void) {
        self.store = store
        _step = State(initialValue: startAtProfile ? 2 : 1)
        self.onAccountChange = onAccountChange
        self.onComplete = onComplete
    }

    private var savedProfile: [String: Any] { store.project("profile")["profile"] as? [String: Any] ?? [:] }
    private let stepNames = ["Your account", "About you", "Your routine", "Your targets", "ChatGPT"]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                progressHeader
                if step == 1 {
                    OnboardingAccountForm(onSignedIn: { move(to: 2) }, onChange: {
                        onAccountChange(accountRevision)
                        accountRevision = NudgeAccountManager.shared.revision
                    })
                    Button("Explore without signing in") { move(to: 2) }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                        .accessibilityIdentifier("onboarding-skip-account")
                        .padding(.horizontal, 20).padding(.bottom, 16)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            switch step {
                            case 2: detailsStep
                            case 3: routineStep
                            case 4: targetsStep
                            default: chatGPTStep
                            }
                        }.padding(20).padding(.bottom, 16)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .id(step)
                }
            }
            .frame(maxWidth: 600).frame(maxWidth: .infinity)
            .background(Color(uiColor: NudgeTheme.canvas).ignoresSafeArea())
            .navigationTitle("Your Nudge").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if step > 1 {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("Back") { cancelSetupConnection(); move(to: step - 1) }
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { dismissKeyboard() }
                }
            }
        }
        .foregroundStyle(Color(uiColor: NudgeTheme.ink)).tint(Color(uiColor: NudgeTheme.accent))
        .interactiveDismissDisabled()
        .accessibilityIdentifier("nudge-onboarding")
        .sheet(isPresented: $targetEditor) { NativeProfileEditor(store: store, section: .tracking) }
        .alert("You’re using your ChatGPT plan", isPresented: $connection.showWelcome) {
            Button("Got it") { connection.acknowledgeWelcome() }
        } message: {
            Text("Eligible requests use your existing ChatGPT allowance. You can review and limit Nudge’s usage in ChatGPT settings.")
        }
        .onAppear(perform: load)
        .onDisappear { cancelSetupConnection() }
    }

    private var progressHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(stepNames[step - 1]).font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(step) of 5").font(.caption.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            HStack(spacing: 6) {
                ForEach(1...5, id: \.self) { index in
                    Capsule().fill(Color(uiColor: index <= step ? NudgeTheme.accent : NudgeTheme.progressTrack))
                        .frame(height: 4)
                }
            }.accessibilityElement(children: .ignore).accessibilityLabel("Setup step \(step) of 5: \(stepNames[step - 1])")
        }.padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 12)
    }

    private func hero(_ icon: String, title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon).font(.system(size: 27, weight: .semibold))
                .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                .frame(width: 58, height: 58)
                .background(Color(uiColor: NudgeTheme.selectedSurface), in: RoundedRectangle(cornerRadius: 20))
                .accessibilityHidden(true)
            Text(title).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle).font(.body).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var detailsStep: some View {
        Group {
            hero("person.crop.circle", title: "A little about you.",
                 subtitle: "Make your everyday targets personal. Your details stay on this iPhone, and you can change them anytime.")
            ProfilePanel(title: "The basics") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Age").font(.headline)
                    HStack {
                        TextField("Years", text: $age).keyboardType(.numberPad).focused($ageFocused)
                            .padding(14).background(Color(uiColor: NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityLabel("Age in years").accessibilityIdentifier("onboarding-age")
                        Text("years").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    ProfileCaption(text: "18–110 years, or leave unset")
                }
                Divider()
                Text("Sex used for energy estimates").font(.headline)
                if typeSize.isAccessibilitySize {
                    sexPicker.pickerStyle(.menu).accessibilityIdentifier("onboarding-sex")
                } else {
                    sexPicker.pickerStyle(.segmented).accessibilityIdentifier("onboarding-sex")
                }
                ProfileCaption(text: "The energy formula uses this information. You can leave it unset and enter your own target.")
            }
            ProfilePanel(title: "Your measurements") {
                ProfileMeasurementField(draft: $height, idPrefix: "onboarding")
                Divider()
                ProfileMeasurementField(draft: $weight, idPrefix: "onboarding")
            }
            ProfilePanel(title: "Nutrition needs") {
                ForEach(ProfileValues.care.filter { $0.id != "unknown" }) { option in
                    selection(option.title, selected: draft["care"] as? String == option.id, id: "onboarding-care-\(option.id)") {
                        draft["care"] = draft["care"] as? String == option.id ? "unknown" : option.id
                    }
                }
                ProfileCaption(text: "If you have an agreed nutrition plan, Nudge will use the targets you enter from it.")
            }
            errorMessage
            Button("Continue") { if saveDetails() { move(to: 3) } }
                .buttonStyle(NudgeButtonStyle()).accessibilityIdentifier("onboarding-details-continue")
            Button("Set up personal details later") { move(to: 5) }
                .buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("onboarding-skip-profile")
        }
    }

    private var routineStep: some View {
        Group {
            hero("figure.walk", title: "Fit Nudge to your day.",
                 subtitle: "Your everyday movement helps set your energy and nutrient starting points.")
            ProfilePanel(title: "How active is your usual week?") {
                activityChoice("light", title: "Light", detail: "Mostly sitting, with some walking", icon: "figure.seated.seatbelt")
                activityChoice("moderate", title: "Moderate", detail: "Regular walking and training", icon: "figure.walk")
                activityChoice("high", title: "High", detail: "Lots of movement and training", icon: "figure.run")
                selection("Not sure yet", selected: (draft["activity"] as? String ?? "unknown") == "unknown", id: "onboarding-activity-unknown") { draft["activity"] = "unknown" }
                ProfileCaption(text: "Energy, carbohydrate and fat estimates need an activity level. Choose the closest fit; you can adjust it later.")
            }
            ProfilePanel(title: "What matters to you?") {
                ProfileCaption(text: "Choose any that feel right.")
                ForEach(ProfileValues.goals) { option in
                    selection(option.title, selected: (draft["goals"] as? [String] ?? []).contains(option.id), id: "onboarding-goal-\(option.id)") {
                        toggle(option.id, key: "goals")
                    }
                }
            }
            ProfilePanel(title: "Your training") {
                selection("I do weight training", selected: (draft["trainingTypes"] as? [String] ?? []).contains("weight_training"), id: "onboarding-weight-training") {
                    toggle("weight_training", key: "trainingTypes")
                }
                ProfileCaption(text: "This helps tailor your protein starting point.")
            }
            errorMessage
            Button("See my targets") { if saveRoutine() { move(to: 4) } }
                .buttonStyle(NudgeButtonStyle()).accessibilityIdentifier("onboarding-routine-continue")
        }
    }

    private var sexPicker: some View {
        Picker("Sex used for energy estimates", selection: choice("sex", fallback: "unknown")) {
            Text("Not set").tag("unknown")
            Text("Female").tag("female")
            Text("Male").tag("male")
        }
    }

    private var targetsStep: some View {
        let profile = savedProfile
        let missing = ProfileValues.metrics.filter { !(profile[$0.field] is NSNumber) }
        return Group {
            hero("scope", title: "Your starting points.", subtitle: "A guide for everyday eating. Review your targets, then make them your own.")
            if !missing.isEmpty {
                ProfilePanel(title: "A few targets need attention") {
                    Text("\(missing.map(\.title).joined(separator: ", ")) \(missing.count == 1 ? "is" : "are") still unset.")
                    ProfileCaption(text: "Each target below explains what’s needed. You can add details or enter an agreed target yourself.")
                    Button("Review personal details") { move(to: 2) }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                    Button("Review activity & goals") { move(to: 3) }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
            }
            ProfilePanel(title: "Made for your day") {
                ForEach(ProfileValues.metrics) { metric in
                    ProfileTargetRow(metric: metric, profile: profile)
                    if metric.id != ProfileValues.metrics.last?.id { Divider() }
                }
                Button("Adjust targets") { targetEditor = true }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("onboarding-edit-targets")
            }
            ProfilePanel(title: "Good to know") {
                ProfileCaption(text: "Energy is an estimate for maintaining weight. Your own targets take priority. Sugar, saturated fat and salt comparisons are reference amounts or limits, not goals to reach.")
                ProfileTargetMethods(store: store, profile: profile)
            }
            Button(missing.isEmpty ? "These look good" : "Continue with these targets") { move(to: 5) }
                .buttonStyle(NudgeButtonStyle()).accessibilityIdentifier("onboarding-targets-continue")
        }
    }

    private var chatGPTReady: Bool {
        guard let binding = connection.cameraSelection else { return false }
        return connection.isCaptureBindingCurrent(binding) && binding.profileID == connection.selectedID
    }

    private var chatGPTStep: some View {
        Group {
            hero("sparkles", title: "Have a ChatGPT account?", subtitle: "One optional connection for camera photos and photo previews.")
            ProfilePanel(title: chatGPTReady ? "You’re connected" : "Make the connection") {
                if chatGPTReady {
                    Label("ChatGPT connected", systemImage: "checkmark.circle.fill")
                        .font(.headline).foregroundStyle(Color(uiColor: NudgeTheme.plantText))
                        .accessibilityIdentifier("onboarding-chatgpt-connected")
                    Text("Your existing connection is ready for camera photos and previews.")
                } else {
                    Text("Connect an eligible ChatGPT plan to use its allowance for supported requests.")
                    if !connection.models.isEmpty {
                        Picker("Model", selection: Binding(get: { connection.selectedModel }, set: { connection.selectModel($0) })) {
                            if !connection.models.contains(where: { $0.id == connection.selectedModel }) {
                                Text("Choose an available model").tag(connection.selectedModel)
                            }
                            ForEach(connection.models) { model in Text(model.name).tag(model.id) }
                        }.disabled(connection.busy).accessibilityIdentifier("onboarding-chatgpt-model")
                    }
                    Button(connection.active?.connected == true ? "Use my connected ChatGPT account" : "Connect ChatGPT") {
                        connecting = true; connection.continueWithChatGPT()
                    }.buttonStyle(NudgeButtonStyle()).disabled(connection.busy)
                        .accessibilityIdentifier("onboarding-connect-chatgpt")
                    if connection.busy && connecting {
                        VStack(alignment: .leading, spacing: 10) {
                            ProgressView("Connecting to ChatGPT…")
                            Button("Cancel", action: cancelSetupConnection).frame(minHeight: 44)
                        }
                    }
                    if connecting, let message = connection.message {
                        Text(message).font(.callout).accessibilityIdentifier("onboarding-chatgpt-status")
                    }
                }
            }
            Text("You can use Nudge’s regular analysis with your Nudge email sign-in, without a paid ChatGPT plan.")
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
            ProfileCaption(text: "If you connect, photos, ingredient choices and portion details you submit go directly to OpenAI and use your ChatGPT allowance or enabled credits. Voice-note captures use Nudge’s service. Your diary, personal and cycle details, and ChatGPT conversations are not shared through this connection.")
            Button(chatGPTReady ? "Start using Nudge" : "Skip for now", action: finish)
                .buttonStyle(NudgeButtonStyle(variant: chatGPTReady ? .primary : .secondary))
                .accessibilityIdentifier(chatGPTReady ? "onboarding-finish" : "onboarding-skip-chatgpt")
            ProfileCaption(text: "Everything is ready to revisit in You. Little steps, at your pace.")
        }
    }

    private var errorMessage: some View {
        Group {
            if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .foregroundStyle(Color(uiColor: NudgeTheme.errorText)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding-profile-error")
            }
        }
    }

    private func selection(_ title: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.title3)
                Text(title).font(.body.weight(selected ? .semibold : .regular)).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }.padding(14).frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
                .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : [])
            .accessibilityIdentifier(id)
    }

    private func activityChoice(_ value: String, title: String, detail: String, icon: String) -> some View {
        let selected = draft["activity"] as? String == value
        return Button { draft["activity"] = value } label: {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: icon).font(.title2).frame(width: 30).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.headline)
                    Text(detail).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.title3)
            }.padding(16).frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
                .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : [])
            .accessibilityIdentifier("onboarding-activity-\(value)")
    }

    private func choice(_ key: String, fallback: String) -> Binding<String> {
        Binding(get: { draft[key] as? String ?? fallback }, set: { draft[key] = $0 })
    }
    private func toggle(_ value: String, key: String) {
        var values = draft[key] as? [String] ?? []
        if values.contains(value) { values.removeAll { $0 == value } } else { values.append(value) }
        draft[key] = values
    }
    private func load() {
        guard !loaded else { return }
        draft = savedProfile
        age = ProfileValues.editAmount(draft["age"])
        height = ProfileMeasurementDraft(kind: .height, value: draft["height"])
        weight = ProfileMeasurementDraft(kind: .weight, value: draft["weight"])
        loaded = true
    }
    private func saveDetails() -> Bool {
        do {
            let text = age.trimmingCharacters(in: .whitespacesAndNewlines)
            let years = text.isEmpty ? nil : Int(text)
            guard text.isEmpty || years.map({ (18...110).contains($0) }) == true else {
                error = "Enter an age from 18 to 110 years, or leave it unset."; return false
            }
            // Merge only fields on this step into the latest profile so target edits stay intact.
            var next = savedProfile
            next["age"] = years.map { $0 as Any } ?? NSNull()
            next["height"] = try height.validatedValue().map { $0 as Any } ?? NSNull()
            next["weight"] = try weight.validatedValue().map { $0 as Any } ?? NSNull()
            next["sex"] = draft["sex"] as? String ?? "unknown"
            next["care"] = draft["care"] as? String ?? "unknown"
            return persist(next)
        } catch { self.error = error.localizedDescription; return false }
    }
    private func saveRoutine() -> Bool {
        var next = savedProfile
        let goals = draft["goals"] as? [String] ?? []
        next["goals"] = goals
        next["goal"] = goals.contains("muscle") ? "muscle" : goals.contains("preserve") ? "preserve" : "balance"
        next["activity"] = draft["activity"] as? String ?? "unknown"
        next["trainingTypes"] = draft["trainingTypes"] as? [String] ?? []
        return persist(next)
    }
    private func persist(_ profile: [String: Any]) -> Bool {
        guard store.perform("profileSave", ["profile": profile]) else {
            error = store.errorMessage ?? "Could not save on this iPhone. Your changes are still here; try again."
            return false
        }
        error = ""; return true
    }
    private func move(to next: Int) {
        dismissKeyboard(); error = ""
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { step = next }
    }
    private func dismissKeyboard() {
        ageFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
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
