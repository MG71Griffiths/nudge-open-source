import SwiftUI

@main
struct NudgeApp: App {
    var body: some Scene {
        WindowGroup {
          Group {
            #if DEBUG && targetEnvironment(simulator)
            if let raw = ProcessInfo.processInfo.environment["NUDGE_ONBOARDING_UI_FIXTURE"], let id = UUID(uuidString: raw) {
                NativeOnboardingUITestFixture(id: id)
            } else if ProcessInfo.processInfo.environment["NUDGE_SEARCH_UI_FIXTURE"] == "1" {
                NativeSearchInteractionUITestFixture()
            } else if let raw = ProcessInfo.processInfo.environment["NUDGE_HISTORY_UI_FIXTURE"], let id = UUID(uuidString: raw) {
                NativeHistoryUITestFixture(id: id)
            } else {
                NudgeScreen()
            }
            #else
            NudgeScreen()
            #endif
          }
          .preferredColorScheme(.light)
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
/// A separate store and completion preference for repeatable first-run UI checks.
/// This route is absent from all physical-device and release builds.
private struct NativeOnboardingUITestFixture: View {
    @StateObject private var store: NativeAppStore
    @AppStorage private var completed: Bool
    init(id: UUID) {
        let name = "NudgeOnboardingUITest-" + id.uuidString
        let disk = NudgeDataStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(name))
        _store = StateObject(wrappedValue: NativeAppStore(store: disk))
        _completed = AppStorage(wrappedValue: false, "completed", store: UserDefaults(suiteName: name)!)
    }
    var body: some View {
        NativeAppShell(store: store)
            .fullScreenCover(isPresented: Binding(get: { store.ready && !completed }, set: { _ in })) {
                NativeOnboardingView(store: store, onAccountChange: { store.capture.accountDidChange(since: $0) }) {
                    completed = true
                }
            }
    }
}

/// The simulator interaction test launches the actual history screen over a
/// separate synthetic store. This entry point is absent from device/release builds.
private struct NativeHistoryUITestFixture: View {
    @StateObject private var store: NativeAppStore

    init(id: UUID) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("NudgeHistoryUITest-" + id.uuidString)
        let disk = NudgeDataStore(directory: directory)
        if !FileManager.default.fileExists(atPath: directory.appendingPathComponent("wmd-nudge-prototype-v1.json").path) {
            let entry: [String: Any] = ["id": "ui-food", "name": "Synthetic history lunch", "day": NativeAppStore.day,
                "slot": "Lunch", "portions": 1, "plants": [], "ferments": [], "proteinPerPortion": 20,
                "energyPerPortion": 300, "sourceMeta": ["scanEventId": "ui-scan", "confirmationId": "ui-confirmation"]]
            let records: [String: [String: Any]] = [
                "wmd-nudge-prototype-v1": ["version": 1, "foodLog": ["entries": [entry], "savedRecipes": [], "plantGoal": 30]],
                "nudge-scan-history-v1": ["version": 3, "events": [["id": "ui-scan", "kind": "meal", "status": "ready",
                    "name": "Synthetic history lunch", "entryId": "ui-food", "createdAt": ISO8601DateFormatter().string(from: Date()),
                    "extraction": ["type": "meal", "meal": ["name": "Synthetic history lunch"], "nutrients": [:]]]],
                    "deleted": [], "favourites": [], "generations": [:]]]
            do {
                for (key, object) in records {
                    let value = String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
                    let request = String(data: try JSONSerialization.data(withJSONObject: ["operation": "set", "key": key, "value": value]), encoding: .utf8)!
                    guard disk.handle(request).contains("\"ok\":true") else { preconditionFailure("Synthetic UI fixture could not be saved") }
                }
            } catch { preconditionFailure("Synthetic UI fixture could not be encoded") }
        }
        let model = NativeAppStore(store: disk)
        model.navigate("history")
        _store = StateObject(wrappedValue: model)
    }

    var body: some View { NativeAppShell(store: store) }
}
#endif

struct NudgeScreen: View {
    @StateObject private var store = NativeAppStore()
    @AppStorage(NativeOnboardingView.completionKey) private var onboardingCompleted = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        NativeAppShell(store: store)
            .fullScreenCover(isPresented: Binding(get: { store.ready && !onboardingCompleted }, set: { _ in })) {
                NativeOnboardingView(store: store, startAtProfile: UserDefaults.standard.bool(forKey: NativeOnboardingView.previousCompletionKey),
                                     onAccountChange: { store.capture.accountDidChange(since: $0) }) {
                    UserDefaults.standard.set(true, forKey: NativeOnboardingView.previousCompletionKey)
                    onboardingCompleted = true
                    store.capture.resumePending()
                    store.refreshPresentation()
                }
            }
            .task { preparePrivateStorage(); store.capture.resumePending(); await NudgeCatalogueService.bootstrapPopularCache() }
            .onChange(of: scenePhase) { phase in
                if phase == .active {
                    preparePrivateStorage()
                    store.capture.resumePending()
                    store.refreshPresentation()
                    AnalysisDiagnostics.shared.record(stage: "lifecycle", outcome: "foregrounded")
                } else if phase == .background {
                    store.capture.suspendPending()
                    AnalysisDiagnostics.shared.record(stage: "lifecycle", outcome: "backgrounded")
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                store.releasePresentationMemory()
            }
    }
    private func preparePrivateStorage() {
        do { try NudgeDataStore.shared.excludeExistingPrivateDataFromBackup() }
        catch { AnalysisDiagnostics.shared.record(stage: "storage", outcome: "backup_exclusion_failed") }
    }
}

/// Real loading/recovery surface, shared by the shell and isolated snapshot tests.
struct NudgeShellStatus: View {
    let error: String?
    let retry: () -> Void
    var body: some View {
        GeometryReader { geometry in
          ScrollView {
            VStack(spacing: 18) {
                if let error {
                    Image(systemName: "arrow.clockwise.circle").font(.system(size: 48))
                        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                    Text("Let’s reopen Nudge").font(.title2.bold())
                    Text(error).multilineTextAlignment(.center).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Button("Try again", action: retry).buttonStyle(NudgeButtonStyle())
                        .accessibilityIdentifier("nudge-shell-retry")
                } else {
                    ProgressView().tint(Color(uiColor: NudgeTheme.accent))
                    Text("Opening Nudge").font(.headline)
                    Text("This can take a little longer the first time.")
                        .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .multilineTextAlignment(.center)
                }
            }
            .padding(28)
            .frame(maxWidth: .infinity, minHeight: geometry.size.height)
          }
        }
        .background(Color(uiColor: NudgeTheme.canvas).ignoresSafeArea())
        .foregroundStyle(Color(uiColor: NudgeTheme.ink))
    }
}
