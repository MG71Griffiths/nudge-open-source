import SwiftUI
import PhotosUI
import ImageIO

/// Explicit camera-provider settings and a separate photo preview. Changing the
/// camera setting does not reroute captures already submitted for analysis.
struct ChatGPTPreviewView: View {
    @ObservedObject private var connection = ChatGPTConnection.shared
    @Environment(\.dismiss) private var dismiss
    @State private var selection: PhotosPickerItem?
    @State private var jpeg: Data?
    @State private var photoError: String?
    @State private var loadingPhoto = false
    @State private var confirmSharing = false
    @State private var confirmDisconnect = false
    @State private var confirmCamera = false
    @State private var cameraError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your meal, with ChatGPT").font(.title2.bold())
                        Text("Connect an eligible ChatGPT Plus or Pro plan to analyse camera photos or try a separate photo preview.")
                        Text("Choose which account the camera uses below. The preview does not add food to your diary.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    account
                    if connection.active?.connected == true { modelSelection }
                    cameraSettings
                    if connection.active?.connected == true { photo }
                    if connection.busy {
                        HStack { ProgressView(); Text("Connecting to ChatGPT…"); Spacer(); Button("Cancel") { connection.cancel() } }
                    }
                    if connection.limitReached {
                        Link("Manage usage", destination: ChatGPTConnection.usageURL).buttonStyle(NudgeButtonStyle())
                    }
                    if let message = connection.message {
                        Text(message).font(.callout).accessibilityIdentifier("chatgpt-status")
                    }
                    if let warning = connection.revocationWarning { Text(warning).font(.callout) }
                    if !connection.result.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Meal-photo preview").font(.headline)
                            Text(connection.result).textSelection(.enabled).accessibilityIdentifier("chatgpt-result")
                            Text("AI observations can be wrong. A photo cannot confirm allergens or food safety. Your diary and Nudge ratings have not changed.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }.padding().background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("You stay in control").font(.headline)
                        Text("Camera photos, ingredient choices and portion details you submit can be sent directly to OpenAI using your selected plan. Captures with a voice note use Nudge’s service. The separate preview sends only its selected photo. Your diary and cycle details are not sent to ChatGPT. Connecting does not give Nudge your ChatGPT conversations or memories.")
                        Link("Manage ChatGPT access", destination: ChatGPTConnection.settingsURL)
                    }.font(.footnote).foregroundStyle(.secondary)
                }.padding(20)
            }
            .background(Color(uiColor: NudgeTheme.canvas))
            .navigationTitle("ChatGPT").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { connection.cancel(); connection.clearResult(); dismiss() } } }
            .task { connection.loadModels() }
            .task(id: selection) { await loadPhoto() }
            .confirmationDialog("Send this photo to OpenAI?", isPresented: $confirmSharing, titleVisibility: .visible) {
                Button("Analyse using my ChatGPT plan") { if let jpeg { connection.analyse(jpeg: jpeg) } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This selected photo will be sent directly to OpenAI using \(connection.active?.label ?? "your selected account"). It consumes your existing plan allowance or enabled credits. No diary or voice notes are included.")
            }
            .confirmationDialog("Use ChatGPT for camera photos?", isPresented: $confirmCamera, titleVisibility: .visible) {
                Button("Use ChatGPT for camera photos") {
                    do { try connection.enableCamera(); cameraError = nil }
                    catch { showCameraError(error) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("When you tap Analyse, selected camera photos, ingredient choices and portion details will go directly to OpenAI using \(connection.active?.label ?? "your selected account") and \(selectedModelName). This consumes your plan allowance or enabled credits. Captures with a voice note use Nudge’s service. Already queued captures keep their original service. Your diary and cycle details are not included.")
            }
            .confirmationDialog("Disconnect ChatGPT?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
                Button("Disconnect", role: .destructive) { connection.disconnect() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Requests using this ChatGPT account will stop. Saved captures stay on this iPhone and may need you to review and retry them. Your Nudge account and saved food records stay as they are.") }
            .alert("You’re using your ChatGPT plan", isPresented: $connection.showWelcome) {
                Button("Got it") { connection.acknowledgeWelcome() }
            } message: { Text("Eligible requests here use your existing ChatGPT allowance. You can review and limit Nudge’s usage in ChatGPT settings.") }
            .onDisappear { connection.cancel(); connection.clearResult(); jpeg = nil }
        }
        .tint(Color(uiColor: NudgeTheme.accent))
        .accessibilityIdentifier("chatgpt-preview")
    }
    private var selectedModelName: String {
        connection.models.first { $0.id == connection.selectedModel }?.name ?? "the selected model"
    }
    private var modelSelection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !connection.models.isEmpty {
                Picker("Model", selection: $connection.selectedModel) {
                    ForEach(connection.models) { model in Text(model.name).tag(model.id) }
                }.disabled(connection.busy)
            } else {
                Button("Load available models") { connection.loadModels() }.disabled(connection.busy)
            }
        }
    }
    private var cameraSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Camera analysis").font(.headline)
            if let binding = connection.cameraSelection {
                Label("Camera account: \(connection.cameraSelectionLabel ?? "ChatGPT")", systemImage: "camera")
                    .accessibilityIdentifier("chatgpt-camera-account")
                if !connection.isCaptureBindingCurrent(binding) {
                    Text("Review this camera connection before analysing with it.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Link("Manage camera usage", destination: ChatGPTConnection.usageURL)
                Button("Use Nudge’s service for new photos") {
                    do { try connection.disableCamera(); cameraError = nil }
                    catch { showCameraError(error) }
                }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                    .accessibilityIdentifier("chatgpt-camera-disable")
            } else {
                Text("Camera photos use Nudge’s service.").font(.callout)
            }
            if connection.active?.connected == true {
                Button("Use ChatGPT for camera photos") { cameraError = nil; confirmCamera = true }
                    .buttonStyle(NudgeButtonStyle()).disabled(!connection.canAnalyse)
                    .accessibilityIdentifier("chatgpt-camera-enable")
                Text("Uses the account and model selected above. Changing those selections only changes the preview until you choose this button again.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text("Captures with a voice note use Nudge’s service. Already queued captures keep their original service.")
                .font(.caption).foregroundStyle(.secondary)
            if let cameraError { Text(cameraError).font(.callout).foregroundStyle(.red) }
        }.padding().background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }
    private func showCameraError(_ error: Error) {
        cameraError = (error as? ChatGPTFailure)?.localizedDescription ?? "The camera setting could not be saved. Try again."
    }
    private var account: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !connection.profiles.isEmpty {
                Picker("ChatGPT account", selection: Binding(get: { connection.selectedID ?? "" }, set: { connection.select($0) })) {
                    ForEach(connection.profiles) { profile in Text(profile.label).tag(profile.id) }
                }.disabled(connection.busy)
            }
            if connection.active?.connected == true {
                Label("ChatGPT plan connected", systemImage: "checkmark.circle.fill")
                HStack {
                    Link("Manage usage", destination: ChatGPTConnection.usageURL)
                    Spacer()
                    Button("Disconnect", role: .destructive) { confirmDisconnect = true }
                }
                Button("Connect another ChatGPT account") { connection.signIn(newAccount: true) }.disabled(connection.busy)
                Button("Reconnect this account") { connection.signIn() }.disabled(connection.busy)
            } else {
                Button("Continue with ChatGPT") { connection.signIn() }
                    .buttonStyle(NudgeButtonStyle()).disabled(connection.busy).accessibilityIdentifier("chatgpt-sign-in")
                if !connection.profiles.isEmpty {
                    Button("Use a different ChatGPT account") { connection.signIn(newAccount: true) }.disabled(connection.busy)
                }
            }
        }.padding().background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }
    private var photo: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Try a photo preview").font(.headline)
            Text("Uses the account and model selected above.").font(.caption).foregroundStyle(.secondary)
            PhotosPicker(selection: $selection, matching: .images) {
                Label(jpeg == nil ? "Choose a meal photo" : "Choose another photo", systemImage: "photo")
            }.buttonStyle(NudgeButtonStyle(variant: .secondary)).disabled(connection.busy)
            if loadingPhoto { ProgressView("Opening photo…") }
            if let jpeg, let image = UIImage(data: jpeg) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 14))
                    .accessibilityLabel("Selected meal photo")
                Button("Analyse photo") { confirmSharing = true }.buttonStyle(NudgeButtonStyle())
                    .disabled(!connection.canAnalyse || loadingPhoto).accessibilityIdentifier("chatgpt-analyse")
                Button("Remove photo") { selection = nil; self.jpeg = nil; connection.clearResult() }.disabled(connection.busy)
            }
            if let photoError { Text(photoError).foregroundStyle(.red) }
        }
    }
    private func loadPhoto() async {
        jpeg = nil; photoError = nil; connection.clearResult()
        guard let selection else { return }
        loadingPhoto = true
        defer { if !Task.isCancelled { loadingPhoto = false } }
        do {
            guard let data = try await selection.loadTransferable(type: Data.self), data.count <= 30_000_000,
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1600,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
                  let result = UIImage(cgImage: thumbnail).jpegData(compressionQuality: 0.85), result.count <= 6_000_000 else { throw ChatGPTFailure.invalidPhoto }
            try Task.checkCancellation(); jpeg = result
        } catch {
            if !Task.isCancelled { photoError = ChatGPTFailure.invalidPhoto.localizedDescription }
        }
    }
}
