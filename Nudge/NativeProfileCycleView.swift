import SwiftUI
import CoreFoundation

/// Native profile and optional cycle screens. These views only edit the existing
/// profile/check-in contract; target and phase rules stay in the shared core.
@MainActor
struct NativeProfileView: View {
    @ObservedObject var store: NativeAppStore
    @State private var editing: ProfileSection?
    @State private var settingsPresented = false
    @State private var chatGPTPresented = false
    @State private var ambassadorsPresented = false
    @State private var signInAfterAmbassadors = false
    @State private var setupPresented = false
    private var profile: [String: Any] { store.project("profile")["profile"] as? [String: Any] ?? [:] }

    var body: some View {
        let p = profile
        ProfilePage {
            ProfileHeading(title: "My profile", subtitle: "Your food, your context.")
            Button("Set up sign-in & ChatGPT") { setupPresented = true }
                .buttonStyle(NudgeButtonStyle(variant: .secondary))
                .accessibilityIdentifier("native-profile-setup")
            Button { ambassadorsPresented = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "sparkles").font(.title2)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Nudge ambassadors").font(.headline)
                        Text("Your points, rank and weekly leaderboard").font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                }
            }.buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("native-profile-ambassadors")
            ProfilePanel(title: "Personal details", edit: { editing = .stats }) {
                ProfileValue(label: "Age", value: ProfileValues.amount(p["age"], suffix: " years"))
                ProfileValue(label: "Sex", value: ProfileValues.title(p["sex"], in: ProfileValues.sexes))
                ProfileValue(label: "Height", value: ProfileValues.amount(p["height"], suffix: " cm"))
                ProfileValue(label: "Weight", value: ProfileValues.amount(p["weight"], suffix: " kg"))
                ProfileCaption(text: ProfileValues.title(p["care"], in: ProfileValues.care))
            }
            ProfilePanel(title: "Goals", edit: { editing = .goals }) {
                Text(ProfileValues.titles(p["goals"], in: ProfileValues.goals))
            }
            ProfilePanel(title: "Activity", edit: { editing = .activity }) {
                Text(ProfileValues.titles(p["trainingTypes"], in: ProfileValues.training))
                ProfileValue(label: "Sessions per week", value: ProfileValues.amount(p["sessions"]))
                ProfileCaption(text: ProfileValues.title(p["activity"], in: ProfileValues.activity))
            }
            ProfilePanel(title: "Tracking & targets", edit: { editing = .tracking }) {
                ForEach(ProfileValues.metrics) { metric in
                    ProfileTargetRow(metric: metric, profile: p)
                }
                ProfileCaption(text: "Targets you enter yourself stay fixed. ChatGPT conversations do not update your Nudge profile.")
                ProfileTargetMethods(store: store, profile: p)
            }
            ProfilePanel(title: "Food requirements", edit: { editing = .requirements }) {
                ProfileValue(label: "Gluten", value: ProfileValues.title(p["glutenRequirement"], in: ProfileValues.gluten))
                Text("Allergies").font(.headline)
                Text(ProfileValues.titles(p["allergies"], in: ProfileValues.allergies, empty: "Not specified · safety not confirmed"))
            }
            ProfilePanel(title: "Healthy habits", edit: { editing = .habits }) {
                Text(ProfileValues.titles(p["habits"], in: ProfileValues.habits))
            }
            ProfilePanel(title: "Food preferences", edit: { editing = .preferences }) {
                Text(ProfileValues.title(p["diet"], in: ProfileValues.diets))
                if p["glutenFreePreference"] as? Bool == true { Text("Gluten-free preference") }
                ProfileValue(label: "Foods I avoid", value: ProfileValues.titles(p["avoids"], in: ProfileValues.avoids))
                let preferences = p["foodPreferences"] as? [String: Any] ?? [:]
                ProfileValue(label: "Dislikes", value: ProfileValues.titles(preferences["dislikes"], in: []))
                ProfileValue(label: "Cuisines", value: ProfileValues.titles(preferences["cuisines"], in: []))
                ProfileValue(label: "Meal planning", value: preferences["mealPlanning"] as? String ?? "Not set")
            }
            Button { store.showCycle() } label: {
                HStack(spacing: 12) {
                    Image(systemName: "calendar").font(.title2)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Cycle support").font(.headline)
                        Text(cycleSummary).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                }
            }.buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("native-profile-cycle")
            ProfilePanel(title: "Fitness data") {
                ProfileValue(label: "Apple Health", value: "Not connected")
                ProfileCaption(text: "No workouts, steps or sleep have been imported. Apple Health access is not connected in this version.")
            }
            Button("See today’s progress") { store.navigate("today") }.buttonStyle(NudgeButtonStyle())
            Button("My Nudge account") { store.showAccount() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
            Button("ChatGPT · camera & preview") { chatGPTPresented = true }.buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("native-profile-chatgpt")
            Button("Recipe library") { store.route = "recipes" }.buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("native-profile-recipes")
            Button("App settings") { settingsPresented = true }.buttonStyle(NudgeButtonStyle(variant: .secondary))
        }
        .accessibilityIdentifier("native-profile")
        .sheet(item: $editing) { section in
            NativeProfileEditor(store: store, section: section)
        }
        .sheet(isPresented: $settingsPresented) { NativeSettingsView(store: store) }
        .sheet(isPresented: $chatGPTPresented) { ChatGPTPreviewView() }
        .sheet(isPresented: $setupPresented) {
            NativeOnboardingView(onAccountChange: { store.capture.accountDidChange(since: $0) }) {
                UserDefaults.standard.set(true, forKey: NativeOnboardingView.completionKey)
                setupPresented = false
            }
        }
        .sheet(isPresented: $ambassadorsPresented, onDismiss: {
            if signInAfterAmbassadors { signInAfterAmbassadors = false; store.showAccount() }
        }) {
            NativeAmbassadorView(store: store) {
                signInAfterAmbassadors = true
                ambassadorsPresented = false
            }
        }
    }

    private var cycleSummary: String {
        let value = store.project("cycle")["context"] as? [String: Any] ?? [:]
        if value["estimated"] as? Bool == true, let name = value["name"] as? String {
            return "Estimated \(name.lowercased()) phase · day \(ProfileValues.amount(value["cycleDay"]))"
        }
        return value["enabled"] as? Bool == true ? "Food ideas and check-ins · phase not estimated" : "Optional food ideas and check-ins"
    }
}

private enum ProfileSection: String, Identifiable {
    case stats, goals, activity, tracking, requirements, habits, preferences
    var id: String { rawValue }
    var title: String {
        switch self {
        case .stats: "Personal details"
        case .goals: "Goals"
        case .activity: "Activity"
        case .tracking: "Tracking & targets"
        case .requirements: "Food requirements"
        case .habits: "Healthy habits"
        case .preferences: "Food preferences"
        }
    }
}

@MainActor
private struct NativeProfileEditor: View {
    @ObservedObject var store: NativeAppStore
    let section: ProfileSection
    @Environment(\.dismiss) private var dismiss
    @State private var draft: [String: Any] = [:]
    @State private var numbers: [String: String] = [:]
    @State private var message = ""
    @State private var error = ""
    @State private var loaded = false
    @FocusState private var focusedNumber: String?
    private var clinical: Bool { ["clinical", "glp1"].contains(draft["care"] as? String ?? "") }

    var body: some View {
        NavigationStack {
            ProfilePage {
                ProfileCaption(text: "Valid changes save on this iPhone. Leave unknown details unset.")
                if loaded { editor }
                if !error.isEmpty {
                    Text(error).foregroundStyle(Color(uiColor: NudgeTheme.errorText)).accessibilityIdentifier("profile-save-error")
                    Button("Try saving again") { _ = commitNumbers() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                } else if !message.isEmpty {
                    ProfileCaption(text: message)
                }
                Button("Done") { if commitNumbers() { dismiss() } }.buttonStyle(NudgeButtonStyle())
            }
            .navigationTitle(section.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { if commitNumbers() { dismiss() } }
                        .buttonStyle(ProfileTextButtonStyle())
                }
            }
            .onAppear { load() }
            .onChange(of: focusedNumber) { _ in _ = commitNumbers() }
            .interactiveDismissDisabled(focusedNumber != nil || !error.isEmpty)
        }
        .tint(Color(uiColor: NudgeTheme.accent))
        .accessibilityIdentifier("native-profile-editor-\(section.rawValue)")
    }

    @ViewBuilder private var editor: some View {
        switch section {
        case .stats: stats
        case .goals:
            ProfilePanel(title: "What matters to you?") { selections("goals", choices: ProfileValues.goals) }
        case .activity:
            ProfilePanel(title: "Training") {
                selections("trainingTypes", choices: ProfileValues.training)
                numberField("sessions", label: "Sessions per week", bounds: "1–7", unit: "sessions")
                choice("activity", title: "Everyday activity", choices: ProfileValues.activity)
                ProfileCaption(text: "Choose everyday activity separately from your training.")
            }
        case .tracking: targets
        case .requirements:
            ProfilePanel(title: "Food requirements") {
                choice("glutenRequirement", title: "Gluten-related requirement", choices: ProfileValues.gluten)
                Text("Allergies").font(.headline)
                selections("allergies", choices: ProfileValues.allergies)
                ProfileCaption(text: "Select only requirements you know. None selected does not confirm safety.")
            }
        case .habits:
            ProfilePanel(title: "Habits I want to build") { selections("habits", choices: ProfileValues.habits) }
        case .preferences: preferences
        }
    }

    private var stats: some View {
        ProfilePanel(title: "Your details") {
            numberField("age", label: "Age", bounds: "18–110", unit: "years")
            choice("sex", title: "Sex", choices: ProfileValues.sexes)
            numberField("height", label: "Height", bounds: "100–230", unit: "cm")
            numberField("weight", label: "Weight", bounds: "35–250", unit: "kg")
            choice("care", title: "Nutrition context · optional", choices: ProfileValues.care)
            ProfileCaption(text: "Automatic targets update from these details. Your own or agreed targets stay fixed.")
        }
    }

    private var targets: some View {
        VStack(alignment: .leading, spacing: 20) {
            ProfilePanel(title: "Show my progress") {
                selections("tracking", choices: ProfileValues.metrics.map { ProfileChoice(id: $0.id, title: $0.title) })
                ProfileCaption(text: "Hiding a metric keeps its saved target.")
            }
            ProfilePanel(title: "Your targets") {
                if clinical {
                    ProfileCaption(text: "Use the targets from your agreed nutrition plan.")
                } else {
                    Button("Use automatic targets") { useAutomatic(nil) }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                ForEach(ProfileValues.metrics) { metric in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Circle().fill(metric.color).frame(width: 8, height: 8); Text(metric.title).font(.headline) }
                        if metric.id == "plants" {
                            Picker("Different plants per week", selection: Binding(get: { numbers[metric.field] ?? "" }, set: { numbers[metric.field] = $0; _ = commitNumbers() })) {
                                Text("Not set").tag("")
                                ForEach([10, 20, 30], id: \.self) { Text("\($0) types").tag(String($0)) }
                            }.pickerStyle(.menu).buttonStyle(ProfileTextButtonStyle())
                        } else {
                            numberField(metric.field, label: metric.title, bounds: metric.bounds, unit: metric.unit, labelVisible: false)
                        }
                        ProfileCaption(text: ProfileValues.targetNote(metric.id, profile: draft))
                        if !clinical && (draft["targetModes"] as? [String: String])?[metric.id] != "automatic" {
                            Button("Use automatic \(metric.title.lowercased())") { useAutomatic(metric.id) }
                                .buttonStyle(ProfileTextButtonStyle()).foregroundStyle(Color(uiColor: NudgeTheme.accent))
                        }
                    }
                    if metric.id != "plants" { Divider() }
                }
                DisclosureGroup {
                    numberField("dailyPlantTarget", label: "Different plants per day", bounds: "1–40", unit: "types")
                } label: {
                    Text("Daily plant target").frame(minHeight: 48).contentShape(Rectangle())
                }
                ProfileCaption(text: "Changes apply from today. Earlier target history stays unchanged.")
                ProfileTargetMethods(store: store, profile: draft)
            }
        }
    }

    private var preferences: some View {
        ProfilePanel(title: "Food preferences") {
            choice("diet", title: "Eating style", choices: ProfileValues.diets)
            Toggle("Gluten-free preference", isOn: Binding(get: { draft["glutenFreePreference"] as? Bool ?? false }, set: { value in
                draft["glutenFreePreference"] = value; persist()
            }))
            Text("Foods I avoid").font(.headline)
            selections("avoids", choices: ProfileValues.avoids)
            Text("Meal-planning time").font(.headline)
            let preferences = draft["foodPreferences"] as? [String: Any] ?? [:]
            Picker("Time for a meal", selection: Binding(get: { preferences["mealPlanning"] as? String ?? "" }, set: { value in
                var next = draft["foodPreferences"] as? [String: Any] ?? [:]
                next["mealPlanning"] = value; draft["foodPreferences"] = next; persist()
            })) {
                Text("Not set").tag("")
                ForEach(["Under 15 minutes", "15–30 minutes", "I enjoy taking my time", "Not provided"], id: \.self) { Text($0).tag($0) }
                if let saved = preferences["mealPlanning"] as? String, !saved.isEmpty, !["Under 15 minutes", "15–30 minutes", "I enjoy taking my time", "Not provided"].contains(saved) {
                    Text(saved).tag(saved)
                }
            }.pickerStyle(.menu).buttonStyle(ProfileTextButtonStyle())
            ProfileValue(label: "Saved dislikes", value: ProfileValues.titles(preferences["dislikes"], in: []))
            ProfileValue(label: "Saved cuisines", value: ProfileValues.titles(preferences["cuisines"], in: []))
            ProfileCaption(text: "Preferences do not establish allergy safety.")
        }
    }

    private func numberField(_ key: String, label: String, bounds: String, unit: String, labelVisible: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if labelVisible { Text(label).font(.headline) }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                TextField("Not set", text: Binding(get: { numbers[key] ?? "" }, set: { numbers[key] = $0 }))
                    .keyboardType(.decimalPad).focused($focusedNumber, equals: key)
                    .submitLabel(.done).onSubmit { _ = commitNumbers(); focusedNumber = nil }
                    .padding(12).background(Color(uiColor: NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: NudgeTheme.border)))
                    .accessibilityLabel(label).accessibilityIdentifier("profile-field-\(key)")
                Text(unit).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            ProfileCaption(text: "\(bounds), or leave unset")
        }
    }

    private func choice(_ key: String, title: String, choices: [ProfileChoice]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Picker(title, selection: Binding(get: { draft[key] as? String ?? choices.first?.id ?? "" }, set: { draft[key] = $0; persist() })) {
                ForEach(choices) { Text($0.title).tag($0.id) }
            }.pickerStyle(.menu).buttonStyle(ProfileTextButtonStyle()).accessibilityIdentifier("profile-choice-\(key)")
        }
    }

    private func selections(_ key: String, choices: [ProfileChoice]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(choices) { option in
                let selected = (draft[key] as? [String] ?? []).contains(option.id)
                Button {
                    var values = draft[key] as? [String] ?? []
                    if selected { values.removeAll { $0 == option.id } } else { values.append(option.id) }
                    draft[key] = values
                    if key == "goals" { draft["goal"] = values.contains("muscle") ? "muscle" : values.contains("preserve") ? "preserve" : "balance" }
                    if key == "allergies", !values.isEmpty { draft["allergiesAnswered"] = true }
                    persist()
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        Text(option.title).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }.padding(12).frame(minHeight: 48)
                        .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
                        .contentShape(RoundedRectangle(cornerRadius: 14))
                }.buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : [])
                    .accessibilityIdentifier("profile-\(key)-\(option.id)")
            }
            let known = Set(choices.map(\.id))
            ForEach((draft[key] as? [String] ?? []).filter { !known.contains($0) }, id: \.self) { ProfileCaption(text: "Retained saved choice: \($0)") }
        }
    }

    private func load() {
        guard !loaded else { return }
        draft = store.project("profile")["profile"] as? [String: Any] ?? [:]
        refreshNumbers(); loaded = true
    }
    private func refreshNumbers() {
        for key in ProfileValues.numeric.keys { numbers[key] = ProfileValues.editAmount(draft[key]) }
    }
    @discardableResult private func commitNumbers() -> Bool {
        guard loaded else { return true }
        var next = draft
        for (key, range) in ProfileValues.numeric {
            let raw = (numbers[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
            let old = ProfileValues.editAmount(draft[key])
            guard raw != old else { continue }
            if raw.isEmpty { next[key] = NSNull() }
            else if let value = Double(raw), value.isFinite, range.contains(value), (!ProfileValues.integers.contains(key) || value.rounded() == value), key != "weeklyPlantTarget" || [10, 20, 30].contains(value) {
                next[key] = value
            } else {
                error = "Check \(ProfileValues.fieldName(key)). Use the displayed range or leave it unset."
                return false
            }
            if let metric = ProfileValues.fieldMetrics[key] {
                var modes = next["targetModes"] as? [String: String] ?? [:]; modes[metric] = "manual"; next["targetModes"] = modes
                var sources = next["targetSources"] as? [String: String] ?? [:]; sources[metric] = "User-entered target"; next["targetSources"] = sources
                var details = next["targetSourceDetails"] as? [String: Any] ?? [:]; details.removeValue(forKey: metric); next["targetSourceDetails"] = details
            }
        }
        draft = next
        return persist(commitPending: false)
    }
    @discardableResult private func persist(commitPending: Bool = true) -> Bool {
        if commitPending { return commitNumbers() }
        guard store.perform("profileSave", ["profile": draft]) else {
            error = store.errorMessage ?? "Could not save on this iPhone. Your changes are still here; try again."
            return false
        }
        draft = store.project("profile")["profile"] as? [String: Any] ?? draft
        refreshNumbers(); error = ""; message = "Saved on this iPhone."
        return true
    }
    private func useAutomatic(_ metric: String?) {
        guard !clinical, commitNumbers() else { return }
        var modes = draft["targetModes"] as? [String: String] ?? [:]
        for key in metric.map({ [$0] }) ?? ProfileValues.metrics.map(\.id) { modes[key] = "automatic" }
        draft["targetModes"] = modes; persist()
    }
}

@MainActor
struct NativeCycleView: View {
    @ObservedObject var store: NativeAppStore
    @State private var exploredPhase: String?
    @State private var settingsPresented = false
    @State private var checkinPresented = false
    private var projection: [String: Any] { store.project("cycle", exploredPhase.map { ["phase": $0] } ?? [:]) }

    var body: some View {
        let data = projection
        let cycle = data["cycle"] as? [String: Any] ?? [:]
        let context = data["context"] as? [String: Any] ?? [:]
        let enabled = cycle["enabled"] as? Bool ?? false
        let phases = data["phases"] as? [[String: Any]] ?? ProfileValues.phases
        let phaseID = exploredPhase ?? context["id"] as? String
        let phase = phases.first { $0["id"] as? String == phaseID }
        ProfilePage {
            Button { store.showProfile() } label: { Label("You", systemImage: "chevron.left") }.buttonStyle(ProfileTextButtonStyle())
            HStack(alignment: .top) {
                ProfileHeading(title: "Your cycle", subtitle: "Food support that follows how you feel.")
                Spacer(minLength: 8)
                Button("Edit") { settingsPresented = true }.buttonStyle(ProfileTextButtonStyle())
            }
            if enabled {
                stagePanel(context: context, phase: phase)
            } else {
                ProfilePanel(title: "Explore food ideas") {
                    Text("Turn on cycle support for optional check-ins and an estimated stage.")
                    Button("Set up cycle support") { settingsPresented = true }.buttonStyle(NudgeButtonStyle())
                }
            }
            ProfilePanel(title: "Explore cycle stages") {
                ForEach(phases.indices, id: \.self) { index in
                    let option = phases[index]
                    let id = option["id"] as? String ?? ""
                    ProfileChoiceButton(title: option["name"] as? String ?? id, selected: id == phaseID) { exploredPhase = id }
                }
                if exploredPhase != nil {
                    Button("Back to your current stage") { exploredPhase = nil }.buttonStyle(ProfileTextButtonStyle())
                }
            }
            if enabled {
                ProfilePanel(title: "Your daily check-in") {
                    let today = data["day"] as? String ?? ""
                    let check = (cycle["checkins"] as? [[String: Any]] ?? []).first { $0["day"] as? String == today }
                    Text(ProfileValues.checkSummary(check ?? [:], empty: "Hunger, energy, cramps and bloating. A few optional taps."))
                    Button(check == nil ? "How are you feeling?" : "Update check-in") { checkinPresented = true }.buttonStyle(NudgeButtonStyle())
                }
            }
            ProfilePanel(title: phase.map { "Food focus · \($0["name"] as? String ?? "")" } ?? "Your food focus") {
                Text(phase?["focus"] as? String ?? "Choose balanced meals that fit your appetite.")
                mealIdeas(data: data)
                Button("Search products") { store.navigate("search") }.buttonStyle(NudgeButtonStyle(variant: .secondary))
            }
            if enabled {
                ProfilePanel(title: "Iron & calcium today") {
                    ProfileCaption(text: "From foods with available nutrient information.")
                    let nutrients = data["nutrients"] as? [String: [String: Any]] ?? [:]
                    ProfileValue(label: "Iron logged", value: ProfileValues.amount(nutrients["iron"]?["value"], suffix: " mg", empty: "—"))
                    ProfileValue(label: "Calcium logged", value: ProfileValues.amount(nutrients["calcium"]?["value"], suffix: " mg", empty: "—"))
                    ProfileCaption(text: "Partial totals · unavailable nutrients are not counted.")
                }
            }
            ProfilePanel(title: nil) {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(phase?["why"] as? String ?? "Suggestions follow your check-in and everyday nutrition guidance.")
                        Text("Timing food choices to cycle stages is an emerging approach. Dates estimate a stage; they do not confirm ovulation or fertility.")
                        Text("Your saved targets and food scores stay the same.")
                        Link("Iron guidance", destination: URL(string: "https://www.nhs.uk/conditions/vitamins-and-minerals/iron/")!)
                            .buttonStyle(ProfileTextButtonStyle())
                        Link("Calcium guidance", destination: URL(string: "https://www.nhs.uk/conditions/vitamins-and-minerals/calcium/")!)
                            .buttonStyle(ProfileTextButtonStyle())
                        Link("Cycle timing", destination: URL(string: "https://www.nhs.uk/conditions/periods/fertility-in-the-menstrual-cycle/")!)
                            .buttonStyle(ProfileTextButtonStyle())
                    }.padding(.top, 12)
                } label: {
                    Text("Why these suggestions?").frame(minHeight: 48).contentShape(Rectangle())
                }.font(.body)
            }
            if enabled { checkinHistory(cycle, day: data["day"] as? String ?? "") }
        }
        .accessibilityIdentifier("native-cycle")
        .sheet(isPresented: $settingsPresented) { NativeCycleSettings(store: store) }
        .sheet(isPresented: $checkinPresented) { NativeCycleCheckin(store: store) }
    }

    private func stagePanel(context: [String: Any], phase: [String: Any]?) -> some View {
        ProfilePanel(title: exploredPhase != nil ? "Exploring this stage" : context["estimated"] as? Bool == true ? "Your estimated phase" : "Phase not estimated") {
            if let phase {
                Text(phase["label"] as? String ?? "").font(.title2.bold())
                if let name = context["name"] as? String, context["estimated"] as? Bool == true {
                    Text("\(exploredPhase == nil ? "" : "Current estimate: \(name) · ")Day \(ProfileValues.amount(context["cycleDay"]))")
                    if exploredPhase == nil { ProfileCaption(text: "Next period in about \(ProfileValues.amount(context["remaining"])) days") }
                }
                Text(phase["text"] as? String ?? "")
            } else {
                Text("Food ideas for how you feel").font(.title2.bold())
                Text(context["reason"] as? String ?? "Add cycle details to estimate your stage, or use optional check-ins.")
            }
        }
    }
    @ViewBuilder private func mealIdeas(data: [String: Any]) -> some View {
        if let note = data["ideasNote"] as? String, !note.isEmpty { ProfileCaption(text: note) }
        let ideas = data["ideas"] as? [[String: Any]] ?? []
        ForEach(ideas.indices, id: \.self) { index in
            let idea = ideas[index]
            Button {
                if let id = idea["id"] as? String { _ = store.perform("openRecipe", ["id": id]) }
            } label: {
                HStack(spacing: 12) {
                    NativeStoredFoodImage(source: idea["image"] as? String ?? "").frame(width: 56, height: 64).clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(idea["name"] as? String ?? "Meal idea").font(.headline)
                        if let reason = idea["reason"] as? String { Text(reason).font(.subheadline) }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                }.padding(.vertical, 10).contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
    }
    private func checkinHistory(_ cycle: [String: Any], day: String) -> some View {
        let checks = (cycle["checkins"] as? [[String: Any]] ?? []).filter { ($0["day"] as? String ?? "") <= day }.suffix(7).reversed()
        return ProfilePanel(title: nil) {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 14) {
                    ProfileCaption(text: "Patterns can suggest associations; they cannot show that food caused a symptom.")
                    if checks.isEmpty { Text("Your check-ins will appear here.") }
                    ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(check["day"] as? String ?? "").font(.headline)
                            Text(ProfileValues.checkSummary(check))
                        }
                    }
                }.padding(.top, 12)
            } label: {
                Text("Your check-ins over time").frame(minHeight: 48).contentShape(Rectangle())
            }
        }
    }
}

@MainActor
private struct NativeCycleSettings: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: [String: Any] = [:]
    @State private var length = ""
    @State private var start = Date()
    @State private var hasStart = false
    @State private var loaded = false
    @State private var error = ""
    @FocusState private var lengthFocused: Bool

    var body: some View {
        NavigationStack {
            ProfilePage {
                ProfileCaption(text: "Optional. Valid changes save on this iPhone.")
                if loaded {
                    ProfilePanel(title: nil) {
                        Toggle("Enable cycle support", isOn: Binding(get: { draft["enabled"] as? Bool ?? false }, set: { draft["enabled"] = $0; persist() }))
                        ProfileCaption(text: "Turning support off hides prompts and keeps your check-ins.")
                    }
                    ProfilePanel(title: "Your dates") {
                        Toggle("Add last period start", isOn: Binding(get: { hasStart }, set: { value in
                            hasStart = value; draft["start"] = value ? ProfileValues.day(start) as Any : NSNull(); persist()
                        }))
                        if hasStart {
                            DatePicker("First day of your last period", selection: $start, in: ProfileValues.date("1900-01-01")!...Date(), displayedComponents: .date)
                                .onChange(of: start) { value in draft["start"] = ProfileValues.day(value); persist() }
                        }
                        Text("Usual cycle length · days").font(.headline)
                        TextField("Not set", text: $length).keyboardType(.numberPad).focused($lengthFocused)
                            .padding(14).background(Color(uiColor: NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("cycle-length")
                            .onSubmit { _ = commitLength() }
                        ProfileCaption(text: "21–45 days, or leave unset. Leave dates blank if you prefer suggestions based on how you feel.")
                    }
                    ProfilePanel(title: "Your cycle") { choices("regularity", choices: ProfileValues.regularity) }
                    ProfilePanel(title: "Contraception") {
                        choices("contraception", choices: ProfileValues.contraception)
                        ProfileCaption(text: "With hormonal contraception or irregular cycles, support follows your check-ins.")
                    }
                    ProfilePanel(title: "What would you like support with?") {
                        ForEach(["Hunger", "Energy", "Cramps", "Bloating"], id: \.self) { focus in
                            let selected = (draft["focus"] as? [String] ?? []).contains(focus)
                            ProfileChoiceButton(title: focus, selected: selected) {
                                var values = draft["focus"] as? [String] ?? []
                                if selected { values.removeAll { $0 == focus } } else { values.append(focus) }
                                draft["focus"] = values; persist()
                            }
                        }
                    }
                    ProfilePanel(title: "Your choices and privacy") {
                        Text("Cycle details and check-ins stay on this iPhone. They are not sent with food photos or voice memos.")
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(Color(uiColor: NudgeTheme.errorText)) }
                Button("Done") { if commitLength() { dismiss() } }.buttonStyle(NudgeButtonStyle())
            }
            .navigationTitle("Cycle support").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { if commitLength() { dismiss() } }.buttonStyle(ProfileTextButtonStyle()) } }
            .interactiveDismissDisabled(lengthFocused || !error.isEmpty)
            .onAppear(perform: load)
            .onChange(of: lengthFocused) { value in if !value { _ = commitLength() } }
        }.tint(Color(uiColor: NudgeTheme.accent))
    }
    private func choices(_ key: String, choices: [ProfileChoice]) -> some View {
        ForEach(choices) { choice in
            ProfileChoiceButton(title: choice.title, selected: draft[key] as? String == choice.id) {
                draft[key] = choice.id; persist()
            }
        }
    }
    private func load() {
        guard !loaded else { return }
        draft = store.project("cycle")["cycle"] as? [String: Any] ?? [:]
        length = ProfileValues.editAmount(draft["length"])
        if let text = draft["start"] as? String, let date = ProfileValues.date(text) { start = date; hasStart = true }
        loaded = true
    }
    @discardableResult private func commitLength() -> Bool {
        guard loaded else { return true }
        let raw = length.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { draft["length"] = NSNull() }
        else if let value = Int(raw), (21...45).contains(value) { draft["length"] = value }
        else { error = "Use a whole number from 21 to 45 days, or leave the cycle length unset."; return false }
        return persist()
    }
    @discardableResult private func persist() -> Bool {
        guard store.perform("cycleSave", ["cycle": draft]) else { error = store.errorMessage ?? "Could not save. Your previous choices are unchanged."; return false }
        draft = store.project("cycle")["cycle"] as? [String: Any] ?? draft
        error = ""; return true
    }
}

@MainActor
private struct NativeCycleCheckin: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.dismiss) private var dismiss
    @State private var answers: [String: String] = [:]
    @State private var day = ""
    @State private var error = ""
    private var groups: [ProfileChoice] {
        let cycle = store.project("cycle")["cycle"] as? [String: Any] ?? [:]
        let focus = cycle["focus"] as? [String] ?? []
        return ProfileValues.checkFields.sorted { focus.contains($0.title) && !focus.contains($1.title) }
    }

    var body: some View {
        NavigationStack {
            ProfilePage {
                ProfileHeading(title: "How are you feeling?", subtitle: "Today · skip anything you don’t want to answer.")
                ForEach(groups) { field in
                    ProfilePanel(title: field.title) {
                        ForEach(ProfileValues.checkChoices[field.id] ?? [], id: \.self) { choice in
                            ProfileChoiceButton(title: choice, selected: answers[field.id] == choice) {
                                if answers[field.id] == choice { answers.removeValue(forKey: field.id) } else { answers[field.id] = choice }
                            }
                        }
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(Color(uiColor: NudgeTheme.errorText)) }
                Button("Save check-in") {
                    if store.perform("cycleCheckin", ["day": day, "answers": answers]) { dismiss() }
                    else { error = store.errorMessage ?? "Could not save your check-in. Try again." }
                }.buttonStyle(NudgeButtonStyle())
                Button("Cancel") { dismiss() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
            }
            .navigationTitle("Daily check-in").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.buttonStyle(ProfileTextButtonStyle()) } }
            .onAppear {
                guard day.isEmpty else { return }
                let data = store.project("cycle")
                day = data["day"] as? String ?? ProfileValues.day(Date())
                let cycle = data["cycle"] as? [String: Any] ?? [:]
                let current = (cycle["checkins"] as? [[String: Any]] ?? []).first { $0["day"] as? String == day } ?? [:]
                for field in ProfileValues.checkFields { answers[field.id] = current[field.id] as? String }
            }
        }.tint(Color(uiColor: NudgeTheme.accent))
    }
}

@MainActor
struct NativeSettingsView: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.dismiss) private var dismiss
    @State private var error = ""
    @State private var chatGPTPresented = false

    var body: some View {
        NavigationStack {
            ProfilePage {
                Button("My Nudge account") { store.showAccount() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                Button("Food AI settings") { store.showAISettings() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                ProfilePanel(title: "App preferences") {
                    Toggle("Character animations", isOn: Binding(get: { store.state["motionEnabled"] as? Bool ?? true }, set: { save(["motionEnabled": $0]) }))
                    Toggle("Avoid milk products", isOn: Binding(get: { store.state["avoidMilk"] as? Bool ?? false }, set: { save(["avoidMilk": $0]) }))
                    ProfileCaption(text: "Avoiding milk is a preference. Manage allergies in Food requirements.")
                }
                ProfilePanel(title: "Your next little step") {
                    Picker("Focus", selection: Binding(get: { store.state["focus"] as? String ?? "food" }, set: { save(["focus": $0]) })) {
                        Text("Food").tag("food"); Text("Move").tag("move"); Text("Sleep").tag("sleep"); Text("Unwind").tag("unwind")
                    }.pickerStyle(.menu).buttonStyle(ProfileTextButtonStyle())
                    Picker("Days each week", selection: Binding(get: { (store.state["goal"] as? NSNumber)?.intValue ?? 5 }, set: { save(["goal": $0]) })) {
                        ForEach(1...7, id: \.self) { Text("\($0) \($0 == 1 ? "day" : "days")").tag($0) }
                    }.pickerStyle(.menu).buttonStyle(ProfileTextButtonStyle())
                }
                ProfilePanel(title: "Your data, on this iPhone") {
                    Text("Your diary, history, saved foods and preferences are saved in private iPhone app storage. They do not sync to another device or to ChatGPT. Deleting Nudge removes its local records.")
                    ProfileCaption(text: "Signing out keeps this device’s diary. Nudge asks iOS to exclude these private records from automatic backups. Older backups are not removed, and there is no account restore for your diary.")
                }
                ProfilePanel(title: "Connections") {
                    Text("Nudge works without a ChatGPT subscription. With an eligible plan, you can choose ChatGPT for camera photos or try a separate photo preview.")
                    Button("ChatGPT · camera & preview") { chatGPTPresented = true }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                    ProfileCaption(text: "No Watch data is imported and exercise does not automatically change your targets.")
                }
                ProfilePanel(title: "App diagnostics") {
                    Text("The support report contains recent technical events, not your meals, photos, voice notes or cycle details.")
                    Button("Share support report") { store.showDiagnostics() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                ProfilePanel(title: "Here to help") {
                    Link("Help & support", destination: URL(string: "https://configure-nudge-website.invalid/support.html")!)
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                    Link("Privacy policy", destination: URL(string: "https://configure-nudge-website.invalid/privacy.html")!)
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                if !error.isEmpty { Text(error).foregroundStyle(Color(uiColor: NudgeTheme.errorText)) }
                ProfileCaption(text: "Nudge \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))")
                Button("Done") { dismiss() }.buttonStyle(NudgeButtonStyle())
            }
            .navigationTitle("App settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.buttonStyle(ProfileTextButtonStyle()) } }
        }.tint(Color(uiColor: NudgeTheme.accent))
            .sheet(isPresented: $chatGPTPresented) { ChatGPTPreviewView() }
    }
    private func save(_ settings: [String: Any]) {
        error = store.perform("settingsSave", settings) ? "" : store.errorMessage ?? "Could not save your settings. Try again."
    }
}

@MainActor
private struct ProfileTargetMethods: View {
    @ObservedObject var store: NativeAppStore
    let profile: [String: Any]
    var body: some View {
        let projection = store.project("profile", ["profile": profile])
        let suggestions = projection["suggestions"] as? [String: [String: Any]] ?? [:]
        let budget = projection["budget"] as? [String: Any] ?? [:]
        VStack(alignment: .leading, spacing: 12) {
            if let state = budget["state"] as? String, ["over", "under"].contains(state) {
                Text("Your macro targets total \(ProfileValues.amount(budget["macroKcal"])) kcal, compared with your \(ProfileValues.amount(budget["energyKcal"])) kcal energy target. Review your own values or use automatic targets.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.warningText))
                    .padding(12).background(Color(uiColor: NudgeTheme.warningSurface), in: RoundedRectangle(cornerRadius: 12))
            }
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Automatic targets use your saved Nudge details. Your own targets stay fixed until you choose automatic again.")
                    ForEach(ProfileValues.metrics) { metric in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(metric.title).font(.headline)
                            Text(suggestions[metric.id]?["method"] as? String ?? suggestions[metric.id]?["reason"] as? String ?? "Complete your profile for an automatic target.")
                            if let raw = suggestions[metric.id]?["sourceURL"] as? String, let url = URL(string: raw), url.scheme == "https" {
                                Link(destination: url) {
                                    Text("Source").frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                                }
                            }
                        }
                    }
                    Text("Energy is an estimated maintenance target. Training calories, a muscle-building surplus and a weight-loss deficit are not added automatically. An agreed care plan takes priority.")
                }.font(.subheadline).padding(.top, 12)
            } label: {
                Text("How automatic targets work").frame(minHeight: 48).contentShape(Rectangle())
            }
        }
    }
}

private struct ProfileTargetRow: View {
    let metric: ProfileMetric
    let profile: [String: Any]
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Circle().fill(metric.color).frame(width: 8, height: 8)
                Text(metric.title).font(.headline)
                Spacer(minLength: 4)
                Text(ProfileValues.amount(profile[metric.field], suffix: " \(metric.unit)")).font(.headline).multilineTextAlignment(.trailing)
            }
            ProfileCaption(text: ProfileValues.targetNote(metric.id, profile: profile))
        }.padding(.vertical, 5)
    }
}

private struct ProfileChoice: Identifiable {
    let id: String
    let title: String
}
private struct ProfileMetric: Identifiable {
    let id: String
    let field: String
    let title: String
    let unit: String
    let bounds: String
    let hex: UInt32
    var color: Color { id == "fat" ? Color(uiColor: NudgeTheme.accent) : Color(uiColor: NudgeTheme.color(hex, hex)) }
}
private enum ProfileValues {
    static let sexes = choices([("unknown", "Not set"), ("male", "Male"), ("female", "Female")])
    static let care = choices([("unknown", "Choose an answer"), ("none", "No special nutrition needs"), ("glp1", "Weight-loss medication"), ("clinical", "Clinician-guided nutrition")])
    static let goals = choices([("balance", "Eat well, simply"), ("muscle", "Gain muscle"), ("preserve", "Protect muscle while losing weight"), ("stay_active", "Stay active"), ("more_plants", "Eat more plants"), ("less_sugar", "Cut back on added sugar"), ("steady_routine", "Build a steady routine"), ("movement", "Make time for movement"), ("sleep", "Improve my sleep")])
    static let training = choices([("weight_training", "Weight training")])
    static let activity = choices([("unknown", "Not set"), ("light", "Light · mostly sitting, some walking"), ("moderate", "Moderate · regular walking and training"), ("high", "High · lots of movement and training")])
    static let habits = choices([("protein", "More protein"), ("fibre", "More fibre"), ("vegetables", "More vegetables")])
    static let gluten = choices([("unknown", "Not specified"), ("coeliac", "Coeliac disease"), ("sensitivity", "Gluten sensitivity/intolerance")])
    static let allergies = choices([("milk", "Milk"), ("fish", "Fish"), ("nuts", "Nuts"), ("gluten", "Cereals containing gluten"), ("eggs", "Eggs"), ("sesame", "Sesame"), ("soy", "Soya")])
    static let avoids = choices([("milk", "Milk"), ("fish", "Fish"), ("nuts", "Nuts"), ("gluten", "Gluten")])
    static let diets = choices([("any", "No preference set"), ("mixed", "A bit of everything"), ("vegetarian", "Vegetarian"), ("vegan", "Vegan"), ("pescatarian", "Pescatarian")])
    static let regularity = choices([("unknown", "Not set"), ("regular", "Usually regular"), ("irregular", "Irregular")])
    static let contraception = choices([("unknown", "Prefer not to say"), ("none", "None"), ("copper", "Copper coil"), ("hormonal", "Hormonal contraception")])
    static let metrics = [
        ProfileMetric(id: "protein", field: "target", title: "Protein", unit: "g/day", bounds: "20–250", hex: 0x9254E8),
        ProfileMetric(id: "calories", field: "calorieTarget", title: "Energy", unit: "kcal/day", bounds: "1,200–6,000", hex: 0xFF6900),
        ProfileMetric(id: "carbs", field: "carbTarget", title: "Carbs", unit: "g/day", bounds: "0–1,000", hex: 0xFFBE00),
        ProfileMetric(id: "fat", field: "fatTarget", title: "Fat", unit: "g/day", bounds: "0–300", hex: 0x365ACB),
        ProfileMetric(id: "fibre", field: "fibreTarget", title: "Fibre", unit: "g/day", bounds: "1–100", hex: 0x20CDBB),
        ProfileMetric(id: "plants", field: "weeklyPlantTarget", title: "Weekly plants", unit: "types/week", bounds: "10, 20 or 30", hex: 0xA8DC00)
    ]
    static let fieldMetrics = Dictionary(uniqueKeysWithValues: metrics.map { ($0.field, $0.id) } + [("dailyPlantTarget", "dailyPlants")])
    static let numeric: [String: ClosedRange<Double>] = ["age": 18...110, "height": 100...230, "weight": 35...250, "sessions": 1...7, "target": 20...250, "calorieTarget": 1200...6000, "carbTarget": 0...1000, "fatTarget": 0...300, "fibreTarget": 1...100, "dailyPlantTarget": 1...40, "weeklyPlantTarget": 10...30]
    static let integers: Set<String> = ["age", "sessions", "dailyPlantTarget", "weeklyPlantTarget"]
    static let checkFields = choices([("hunger", "Hunger"), ("energy", "Energy"), ("cramps", "Cramps"), ("bloating", "Bloating"), ("bleeding", "Bleeding")])
    static let checkChoices: [String: [String]] = ["hunger": ["Less than usual", "About usual", "More than usual"], "energy": ["Low", "Okay", "Good"], "cramps": ["None", "Mild", "Disruptive"], "bloating": ["None", "Mild", "Uncomfortable"], "bleeding": ["None", "Light", "Usual", "Heavy"]]
    static let phases: [[String: Any]] = [
        ["id": "period", "name": "Period", "label": "During your period", "focus": "Make room for iron-containing foods.", "text": "Include an iron-containing meal and a fruit or vegetable rich in vitamin C."],
        ["id": "follicular", "name": "Follicular", "label": "After your period", "focus": "Build on your everyday habits.", "text": "Keep meals varied, with protein, plants and calcium-containing foods."],
        ["id": "ovulation", "name": "Ovulation", "label": "Around ovulation", "focus": "Keep your meals balanced.", "text": "Let hunger and activity guide portions. Include protein, plants and wholegrains."],
        ["id": "luteal", "name": "Luteal", "label": "Before your period", "focus": "Make meals more satisfying.", "text": "If you feel hungrier, add a satisfying snack or choose a larger meal. Keep calcium-containing foods in the mix."]
    ]
    static func choices(_ pairs: [(String, String)]) -> [ProfileChoice] { pairs.map { ProfileChoice(id: $0.0, title: $0.1) } }
    static func title(_ value: Any?, in choices: [ProfileChoice]) -> String {
        guard let id = value as? String, !id.isEmpty else { return "Not set" }
        return choices.first { $0.id == id }?.title ?? "\(id) (saved choice)"
    }
    static func titles(_ raw: Any?, in choices: [ProfileChoice], empty: String = "Not set") -> String {
        let values = raw as? [String] ?? []
        return values.isEmpty ? empty : values.map { id in choices.first { $0.id == id }?.title ?? id }.joined(separator: ", ")
    }
    static func amount(_ value: Any?, suffix: String = "", empty: String = "Not set") -> String {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return empty }
        return number.doubleValue.formatted(.number.precision(.fractionLength(0...1))) + suffix
    }
    static func editAmount(_ value: Any?) -> String {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return "" }
        return number.doubleValue == number.doubleValue.rounded() ? String(format: "%.0f", number.doubleValue) : String(number.doubleValue)
    }
    static func fieldName(_ field: String) -> String { metrics.first { $0.field == field }?.title.lowercased() ?? field }
    static func targetNote(_ metric: String, profile: [String: Any]) -> String {
        let field = metrics.first { $0.id == metric }?.field ?? ""
        let known = profile[field] is NSNumber
        let automatic = (profile["targetModes"] as? [String: String])?[metric] == "automatic"
        let details = profile["targetSourceDetails"] as? [String: [String: Any]] ?? [:]
        if automatic { return known ? "Automatic · \(details[metric]?["reason"] as? String ?? "from your profile")" : details[metric]?["reason"] as? String ?? "Complete your profile for an automatic target" }
        return known ? "Your own target" : "Not set"
    }
    static func checkSummary(_ check: [String: Any], empty: String = "") -> String {
        let values = checkFields.compactMap { field in (check[field.id] as? String).map { "\(field.title): \($0)" } }
        return values.isEmpty ? empty : values.joined(separator: " · ")
    }
    static func day(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_GB"); formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    static func date(_ value: String) -> Date? {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_GB"); formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        return formatter.date(from: value)
    }
}

private struct ProfilePage<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) { content }
                .frame(maxWidth: 600, alignment: .leading).padding(20).padding(.bottom, 20).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(uiColor: NudgeTheme.canvas).ignoresSafeArea())
        .foregroundStyle(Color(uiColor: NudgeTheme.ink)).tint(Color(uiColor: NudgeTheme.accent))
    }
}
private struct ProfileHeading: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            Text(subtitle).foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }
    }
}
private struct ProfilePanel<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var size
    var title: String?
    var edit: (() -> Void)? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            if let title {
                let layout = size.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                layout {
                    Text(title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    if !size.isAccessibilitySize { Spacer(minLength: 8) }
                    if let edit { Button("Edit", action: edit).buttonStyle(ProfileTextButtonStyle()).accessibilityLabel("Edit \(title)") }
                }
            }
            content
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color(uiColor: NudgeTheme.border)))
    }
}
private struct ProfileCaption: View {
    let text: String
    var body: some View { Text(text).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted)).fixedSize(horizontal: false, vertical: true) }
}
private struct ProfileValue: View {
    let label: String
    let value: String
    @Environment(\.dynamicTypeSize) private var size
    var body: some View {
        let layout = size.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            Text(label).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            if !size.isAccessibilitySize { Spacer(minLength: 4) }
            Text(value).fontWeight(.semibold).multilineTextAlignment(size.isAccessibilitySize ? .leading : .trailing)
        }.fixedSize(horizontal: false, vertical: true)
    }
}
private struct ProfileChoiceButton: View {
    let title: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                Text(title).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }.padding(14).frame(minHeight: 48)
                .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// Size the label itself so its surrounding space remains tappable.
private struct ProfileTextButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 4)
            .frame(minWidth: 48, minHeight: 48)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.65 : 1)
    }
}
