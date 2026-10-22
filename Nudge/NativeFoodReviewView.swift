import SwiftUI
import UIKit

private struct CaptureReviewFrames: Equatable {
    var viewport: CGRect?
    var nutrition: CGRect?
    var eventID: String?
}
private struct CaptureReviewFramesKey: PreferenceKey {
    static let defaultValue = CaptureReviewFrames()
    static func reduce(value: inout CaptureReviewFrames, nextValue: () -> CaptureReviewFrames) {
        let next = nextValue()
        if let viewport = next.viewport { value.viewport = viewport }
        if let nutrition = next.nutrition { value.nutrition = nutrition; value.eventID = next.eventID }
    }
}

/// Native food review owns presentation and input only. The retained JavaScript
/// domain adapter calculates amounts, nutrition and the single diary draft.
@MainActor
struct NativeFoodReviewView: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.scenePhase) private var scenePhase
    @State private var mealDraft = NativeMealReviewDraft()
    @State private var hasPendingMealChanges = false
    @State private var captureFrames = CaptureReviewFrames()
    @State private var captureReviewAppeared = false
    private var captureVisibilityAllowed: Bool {
        captureReviewAppeared && scenePhase == .active && store.contributionContext == nil && store.errorMessage == nil && store.analysisFailure == nil
    }
    private var isSavedFoodReview: Bool { !(store.review["savedFoodId"] as? String ?? "").isEmpty }

    var body: some View {
        let model = store.project("reviewModel")
        ScrollViewReader { reader in
            VStack(spacing: 0) {
                compactHeader(model)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        rating(model)
                        nutrition(model)
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: CaptureReviewFramesKey.self,
                                    value: CaptureReviewFrames(nutrition: geometry.frame(in: .global),
                                        eventID: store.review["eventId"] as? String))
                            })
                        labelRecovery(model)
                        allergyNotice(model)
                        if let warnings = model["evidenceWarnings"] as? [String], !warnings.isEmpty {
                            DisclosureGroup("Check food details") {
                                ForEach(warnings, id: \.self) { notice($0, error: false) }
                            }.font(.subheadline.weight(.semibold)).reviewCard()
                        }
                        if let errors = model["errors"] as? [String], !errors.isEmpty {
                            ForEach(errors, id: \.self) { notice($0, error: true) }
                        }
                        recipeChoices(model)
                        portion(model).id("review-portion")
                        if let builder = model["mealBuilder"] as? [String: Any] {
                            NativeMealIngredientPicker(model: builder, canAnalyse: store.reviewHasPhotos,
                                isAnalysing: store.mealRefinementSubmitting || store.loading, statusMessage: store.mealRefinementMessage,
                                analysisServiceText: store.photoAnalysisServiceText,
                                onDraftChange: { mealDraft.patch = $0; if !hasPendingMealChanges { hasPendingMealChanges = true } }, onApply: applyMealDraft,
                                onDiscardDraft: { mealDraft.patch = nil; hasPendingMealChanges = false },
                                onAnalyse: {
                                    guard applyMealDraft() else { return false }
                                    store.reanalyseReviewWithIngredients()
                                    return true
                                }, onSearch: { store.project("mealIngredientSearch", ["query": $0]) })
                                .id(string(model, "confirmationId"))
                                .id("review-ingredients")
                        }
                        DisclosureGroup("Date · " + NativeTrackingDisplay.dateLabel(string(dictionary(model, "draft"), "day"), format: "EEE d MMM")) {
                            timing(model).padding(.top, 12)
                        }
                        .font(.subheadline.weight(.semibold)).reviewCard()
                        if let product = store.review["product"] as? [String: Any] {
                            NativeProductContextView(product: product,
                                profile: store.state["nutritionProfile"] as? [String: Any] ?? [:],
                                avoidMilk: store.state["avoidMilk"] as? Bool == true,
                                alternativesFirst: true,
                                onRecallAssessment: { store.applyRecallAssessment(product: product, assessment: $0) },
                                onOpen: store.openProductFacts)
                        }
                        reviewDetails(model)
                    }
                    .padding(16).frame(maxWidth: 620).frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: CaptureReviewFramesKey.self,
                        value: CaptureReviewFrames(viewport: geometry.frame(in: .global)))
                })
                footer(model) { withAnimation(.easeInOut(duration: 0.2)) { reader.scrollTo("review-portion", anchor: .top) } }
            }
        }
        .background(Color(uiColor: NudgeTheme.canvas).ignoresSafeArea())
        .foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .tint(Color(uiColor: NudgeTheme.accent))
        .accessibilityIdentifier("native-food-review")
        .onAppear { captureReviewAppeared = true }
        .onDisappear { captureReviewAppeared = false }
        .onPreferenceChange(CaptureReviewFramesKey.self) { frames in
            captureFrames = frames
            recordCaptureVisibility(frames)
        }
        .onChange(of: captureVisibilityAllowed) { allowed in if allowed { recordCaptureVisibility(captureFrames) } }
        .sheet(item: $store.contributionContext) { context in NativeProductContributionView(context: context) }
        .alert("Nudge", isPresented: Binding(get: { store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("OK") { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "Please try again.") }
        .alert("Analysis did not finish", isPresented: Binding(get: { store.analysisFailure != nil }, set: { if !$0 { store.analysisFailure = nil } })) {
            if let barcode = store.missingProductBarcode {
                Button("Add this product") { store.openProductContribution(barcode: barcode) }
            }
            Button("Return to photos") { store.capture.resume() }
            Button("Close", role: .cancel) { store.analysisFailure = nil }
        } message: { Text(store.analysisFailure ?? "Your photos are still available.") }
        .onChange(of: string(model, "confirmationId")) { _ in mealDraft.patch = nil; hasPendingMealChanges = false }
    }

    private func reviewDetails(_ model: [String: Any]) -> some View {
        DisclosureGroup("Details & sources") {
            VStack(alignment: .leading, spacing: 16) {
                productRecovery
                recipeOptions(model)
                planning(model)
                if dictionary(model, "mealBuilder").isEmpty { ingredients(model) }
                if !rows(model, "components").isEmpty {
                    DisclosureGroup("Ingredient amounts") { componentEditor(model).padding(.top, 12) }
                }
                if bool(model, "canEditSavedCalculation") {
                    Button("Edit saved ingredient calculation") { change(["editSavedCalculation": true]) }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
                DisclosureGroup("Edit food details") { detailsEditor(model).padding(.top, 12) }
                sources(model)
            }.padding(.top, 12)
        }.font(.subheadline.weight(.semibold)).reviewCard()
    }

    private func recordCaptureVisibility(_ frames: CaptureReviewFrames) {
        guard captureVisibilityAllowed, let panel = frames.nutrition, let viewport = frames.viewport,
              let eventID = frames.eventID, CaptureResultVisibility.contains(panel: panel, viewport: viewport) else { return }
        store.captureCardAppeared(eventID: eventID)
    }

    @ViewBuilder private func recipeOptions(_ model: [String: Any]) -> some View {
        let options = rows(model, "recipeOptions")
        if !options.isEmpty {
            panel("Optional ingredients and sides") {
                ForEach(options, id: \.nativeReviewKey) { option in
                    Toggle(string(option, "title"), isOn: Binding(
                        get: { bool(option, "selected") },
                        set: { change(["fastRecipeOption": ["id": string(option, "id"), "included": $0]]) }))
                        .accessibilityIdentifier("native-review-recipe-option-" + string(option, "id"))
                }
                Text("Include only what you used or ate. Unknown amounts still need review.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
        }
    }

    private func compactHeader(_ model: [String: Any]) -> some View {
        let layout = textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
        return layout {
            HStack(spacing: 10) {
                let primary = string(model, "image")
                NativeStoredFoodImage(source: primary.isEmpty ? NativeTrackingDisplay.imageSource(store.review) : primary,
                                      barcode: NativeTrackingDisplay.imageBarcode(store.review))
                    .frame(width: 46, height: 52).clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(string(model, "title", fallback: "Your food"))
                        .font(.headline).lineLimit(textSize.isAccessibilitySize ? 3 : 2)
                        .accessibilityAddTraits(.isHeader)
                    let brand = string(dictionary(model, "draft"), "brand")
                    if !brand.isEmpty { Text(brand).font(.caption).lineLimit(1).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 0) {
                if textSize.isAccessibilitySize { Spacer(minLength: 0) }
                Button {
                    if store.isReviewSaved || applyMealDraft() { _ = store.toggleReviewSaved() }
                } label: {
                    Image(systemName: store.isReviewSaved ? "heart.fill" : "heart").font(.title3)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!store.isReviewSaved && !bool(model, "valid") && !hasPendingMealChanges)
                .accessibilityLabel(store.isReviewSaved ? "Remove from favourites" : "Save to favourites")
                .reviewControl("native-review-favourite")
                secondaryMenu(model)
                Button(action: store.dismissReview) {
                    Image(systemName: "xmark").font(.headline)
                        .frame(width: 44, height: 44).background(Color(uiColor: NudgeTheme.canvas), in: Circle())
                        .contentShape(Circle())
                }.buttonStyle(.plain).accessibilityLabel("Close food details").reviewControl("native-review-close")
            }
        }
        .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 12)
        .frame(maxWidth: 620).frame(maxWidth: .infinity)
        .background(Color(uiColor: NudgeTheme.surface))
        .overlay(alignment: .bottom) { Divider() }
        .reviewControl("native-review-header")
    }

    private func secondaryMenu(_ model: [String: Any]) -> some View {
        Menu {
            Button { if applyMealDraft() { _ = store.perform("reviewSaveFood") } } label: {
                Label(store.isReviewSaved ? "Update saved food" : "Save to my foods", systemImage: "heart")
            }
            .disabled(!bool(model, "valid") && !hasPendingMealChanges)
            .accessibilityIdentifier("native-review-save-food")
            if store.reviewHasPhotos {
                Button { store.reanalyseReviewPhotos() } label: { Label("Reanalyse saved photos", systemImage: "sparkles") }
                    .disabled(store.loading).accessibilityIdentifier("native-review-reanalyse-photos")
            }
            Button { store.startCamera(repair: true) } label: { Label("Photograph label to update this food", systemImage: "camera") }
                .accessibilityIdentifier("native-review-repair")
            if let barcode = NativeTrackingDisplay.imageBarcode(store.review) {
                Button { store.openProductContribution(barcode: barcode, productName: string(model, "title")) } label: {
                    Label("Help complete this product", systemImage: "square.and.pencil")
                }.accessibilityIdentifier("native-review-contribute")
            }
        } label: {
            Image(systemName: "ellipsis").font(.title3).frame(width: 44, height: 44).contentShape(Rectangle())
        }.accessibilityLabel("More food actions").reviewControl("native-review-menu")
    }

    private func footer(_ model: [String: Any], showPortion: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            if store.loading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Opening food…").font(.subheadline)
                    Spacer(minLength: 0)
                    Button("Cancel", action: store.cancelLoading).frame(minHeight: 44)
                }
            }
            Button(action: showPortion) {
                HStack(spacing: 6) {
                    Image(systemName: "fork.knife")
                    let amount = number(model, "amount").map(format) ?? modelValue(model["quantity"])
                    Text(portionLabel(model, fallback: amount.isEmpty ? "Portion" : amount + " " + string(model, "amountUnit", fallback: selectedMeasure(model))))
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Text("Edit").fontWeight(.semibold)
                }.font(.subheadline).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).reviewControl("native-review-portion-shortcut")
            if isSavedFoodReview {
                Button(store.isReviewSaved ? "Save changes" : "Save to My foods") {
                    if applyMealDraft(), store.perform("reviewSaveFood") { store.dismissReview() }
                }
                .buttonStyle(NudgeButtonStyle())
                .disabled(!bool(model, "valid") && !hasPendingMealChanges)
                .reviewControl("native-review-save-changes")
            }
            Button(diaryActionTitle(model)) {
                if applyMealDraft() { _ = store.perform("reviewConfirm") }
            }
            .buttonStyle(NudgeButtonStyle(variant: .diary))
            .disabled(!bool(model, "valid") && !hasPendingMealChanges)
            .reviewControl("native-review-confirm")
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
        .frame(maxWidth: 620).frame(maxWidth: .infinity)
        .background(Color(uiColor: NudgeTheme.surface))
        .overlay(alignment: .top) { Divider() }
        .reviewControl("native-review-footer")
    }

    @ViewBuilder private func labelRecovery(_ model: [String: Any]) -> some View {
        let extraction = dictionary(store.review, "extraction")
        let recovery = rows(dictionary(extraction, "metadata"), "recovery")
        if string(extraction, "type") == "product", number(dictionary(model, "score"), "value") == nil,
           bool(extraction, "needsClearerPhoto") || recovery.contains(where: { ["nutrition", "ingredients"].contains(string($0, "field")) }) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Label needed to rate").font(.headline)
                Button("Photograph labels") { store.startCamera(repair: true) }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary))
                    .disabled(store.loading)
                    .accessibilityIdentifier("native-review-add-labels")
            }.reviewCard()
        }
    }

    @ViewBuilder private var productRecovery: some View {
        if store.review["product"] is [String: Any] {
            if store.recoveringProduct {
                HStack(spacing: 10) { ProgressView(); Text("Checking product facts…").font(.subheadline) }
                    .reviewCard()
            } else if let message = store.productRecoveryMessage, !message.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text(message).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Button("Try again") { store.retryProductRecovery() }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                        .accessibilityIdentifier("native-review-retry-recovery")
                }.reviewCard()
            }
        }
    }

    @ViewBuilder private func allergyNotice(_ model: [String: Any]) -> some View {
        let allergy = dictionary(model, "allergies")
        let conflicts = rows(allergy, "conflicts").compactMap { $0["text"] as? String }
        let contains = allergy["contains"] as? [String] ?? []
        let traces = allergy["traces"] as? [String] ?? []
        if !conflicts.isEmpty || !contains.isEmpty || !traces.isEmpty || bool(allergy, "unknown") || !(allergy["manufacturing"] as? [String] ?? []).isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Label("Allergens", systemImage: "exclamationmark.triangle").font(.headline)
                ForEach(conflicts, id: \.self) { Text($0).font(.subheadline.weight(.semibold)) }
                if !contains.isEmpty { Text("Contains: " + contains.joined(separator: ", ")).font(.subheadline) }
                if !traces.isEmpty { Text("May contain: " + traces.joined(separator: ", ")).font(.subheadline) }
                if bool(allergy, "unknown") { Text("Allergens unconfirmed").font(.subheadline) }
                DisclosureGroup("Allergen details") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(allergy["manufacturing"] as? [String] ?? [], id: \.self) { Text($0) }
                        if !string(allergy, "advice").isEmpty { Text(string(allergy, "advice")) }
                    }.font(.caption).padding(.top, 6)
                }.font(.caption)
            }
            .foregroundStyle(Color(uiColor: NudgeTheme.warningText))
            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: NudgeTheme.warningSurface), in: RoundedRectangle(cornerRadius: 24))
        }
    }

    private func rating(_ model: [String: Any]) -> some View {
        let score = dictionary(model, "score")
        let directional = string(score, "methodId") == "nudge_nutrition_v0_4"
        return VStack(alignment: .leading, spacing: 12) {
            let layout = textSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                : AnyLayout(HStackLayout(alignment: .center, spacing: 16))
            layout {
                if let value = number(score, "value"), (0...100).contains(value) {
                    let rounded = Int(value.rounded()), tone = NativeProductRatingTone(value: rounded)
                    Text("\(rounded)/100")
                        .font(.system(.title, design: .rounded).weight(.bold)).monospacedDigit()
                        .foregroundStyle(Color(uiColor: NudgeTheme.color(0x1B202A, 0x1B202A)))
                        .padding(.horizontal, 14).padding(.vertical, 16)
                        .background(Color(uiColor: NudgeTheme.color(tone.fill, tone.fill)), in: RoundedRectangle(cornerRadius: 18))
                        .accessibilityLabel("Nudge rating \(rounded) out of 100")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(number(score, "value").map { (0...100).contains($0) } == true
                         ? "Nudge score" : "Not rated").font(.headline)
                    if isEstimatedScore(score) {
                        estimateBadge(string(score, "status").contains("provisional") ? "Estimated · provisional" : "Estimated")
                            .accessibilityIdentifier("native-review-score-estimated")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            let method = string(score, "methodId", fallback: string(score, "methodVersion"))
            let version = string(score, "version")
            if directional {
                DisclosureGroup("About this score") {
                    VStack(alignment: .leading, spacing: 8) {
                        let reason = string(score, "reason")
                        if !reason.isEmpty { Text(reason) }
                        Text("A guide based on available food and nutrition information.")
                        ForEach(score["assumptions"] as? [String] ?? [], id: \.self) { Text($0) }
                    }.font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.top, 6)
                }.font(.caption).multilineTextAlignment(.leading)
            } else if method == "nudge_nutrition_v0_3" {
                DisclosureGroup("About this score") {
                    VStack(alignment: .leading, spacing: 8) {
                        let reason = string(score, "reason")
                        if !reason.isEmpty { Text(reason) }
                        Text("Based on Nutri-Score 2023. Nudge displays A as 100, B as 75, C as 50, D as 25 and E as 0.")
                        Text("This is a score out of 100, not a percentage of how healthy a food is. Estimates are labelled. Cycle suitability and portion guidance are separate.")
                        if let evidence = score["provider"] as? [String: Any], evidence["source"] as? String == "Open Food Facts" {
                            Text("Nutrition score supplied by Open Food Facts.")
                        }
                    }.font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.top, 6)
                }.font(.caption).multilineTextAlignment(.leading)
            } else if !method.isEmpty || !string(score, "reason").isEmpty {
                DisclosureGroup("About this score") {
                    VStack(alignment: .leading, spacing: 8) {
                        if !string(score, "reason").isEmpty { Text(string(score, "reason")) }
                        if !method.isEmpty { Text(method + (version.isEmpty ? "" : " · v" + version)).font(.caption2) }
                    }.font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.top, 6)
                }.font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).reviewCard()
        .reviewControl("native-review-rating")
    }

    @ViewBuilder private func planning(_ model: [String: Any]) -> some View {
        let guidance = dictionary(model, "planning")
        if !guidance.isEmpty && !["nudge_nutrition_v0_3", "nudge_nutrition_v0_4"].contains(string(dictionary(model, "score"), "methodId")) {
            panel("Eating frequency") {
                let frequency = string(guidance, "frequency")
                Text(string(guidance, "title")).font(.headline)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .foregroundStyle(Color(uiColor: frequency.isEmpty ? NudgeTheme.ink : NudgeTheme.frequencyText(frequency)))
                    .background(Color(uiColor: frequency.isEmpty ? NudgeTheme.canvas : NudgeTheme.frequencySurface(frequency)), in: RoundedRectangle(cornerRadius: 16))
                Text(string(guidance, "detail")).font(.subheadline)
                let salt = number(guidance, "saltGrams").map { "\(format($0)) g salt" } ?? "Salt incomplete"
                Text(salt + " · " + string(guidance, "day"))
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                if let otherFoods = number(guidance, "otherFoods"), otherFoods > 0 {
                    Text("Includes \(Int(otherFoods)) other logged \(otherFoods == 1 ? "food" : "foods") in this meal.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                DisclosureGroup("How this planning guidance works") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Daily: Any day, with appropriate portions and variety.")
                        Text("Weekly: Up to 2 reference portions in a rolling 7 days, shared across comparable Weekly choices.")
                        Text("Monthly: Up to 2 reference portions in a rolling 28 days, shared across comparable Monthly choices.")
                        Text("Proposed Nudge planning policy, not official safe limits or a clinical prescription. Portion allowances are not available for this food.")
                        if !string(guidance, "baseFrequency").isEmpty { Text("Base frequency: " + string(guidance, "baseFrequency")) }
                        Text(string(guidance, "policyVersion")).font(.caption2)
                    }.font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.top, 10)
                }
            }.accessibilityIdentifier("native-review-planning")
        }
    }

    @ViewBuilder private func recipeChoices(_ model: [String: Any]) -> some View {
        let choices = rows(model, "recipeChoices")
        if !choices.isEmpty {
            panel("Which ingredients did you use?") {
                ForEach(choices, id: \.nativeReviewID) { choice in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(string(choice, "title")).font(.subheadline.weight(.semibold))
                        let selected = string(choice, "selected")
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: textSize.isAccessibilitySize ? 1 : 2), spacing: 10) {
                            ForEach(rows(choice, "options"), id: \.nativeReviewID) { option in
                                let active = selected == string(option, "id")
                                Button {
                                    change(["recipeChoice": ["id": string(choice, "id"), "value": string(option, "id")]])
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: active ? "checkmark.circle.fill" : "circle")
                                        Text(string(option, "title")).multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                    }.frame(maxWidth: .infinity, minHeight: 48).padding(.horizontal, 12).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(Color(uiColor: active ? NudgeTheme.accent : NudgeTheme.ink))
                                .background(Color(uiColor: active ? NudgeTheme.accent : NudgeTheme.muted).opacity(active ? 0.12 : 0.06), in: RoundedRectangle(cornerRadius: 12))
                                .accessibilityAddTraits(active ? .isSelected : [])
                                .reviewControl("native-review-recipe-choice-" + string(choice, "id") + "-" + string(option, "id"))
                            }
                        }
                        if selected.isEmpty {
                            Text("Choose to include")
                                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        }
                    }.padding(.vertical, 6)
                }
            }.accessibilityIdentifier("native-review-recipe-choices")
        }
    }

    private func nutrition(_ model: [String: Any]) -> some View {
        let explanation = string(model, "nutritionExplanation")
        let partialRecipe = !explanation.isEmpty && rows(model, "nutrients").contains { bool($0, "partial") }
        return panel(partialRecipe ? "Nutrition · partial" : "Nutrition") {
            if bool(model, "nutritionEstimated") {
                estimateBadge("Estimated")
                    .accessibilityIdentifier("native-review-nutrition-estimated")
            }
            let recipe = dictionary(model, "recipe")
            if let fraction = number(recipe, "selectedFraction") {
                Text(fraction == 1 ? "For the whole recipe" : "For \(format(fraction * 100))% of the recipe")
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("native-review-recipe-nutrition-share")
            }
            let metrics = rows(model, "compactMetrics")
            if let energy = metrics.first(where: { string($0, "key") == "energy" }) { nutritionLine(energy) }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: textSize.isAccessibilitySize ? 1 : 2), alignment: .leading, spacing: 18) {
                ForEach(metrics.filter { string($0, "key") != "energy" }, id: \.nativeReviewKey) { nutritionLine($0) }
            }
            let plants = dictionary(model, "plantSummary")
            if let total = number(plants, "total"), let added = number(plants, "newCount") {
                Label("\(format(total)) plants · \(format(added)) new this week", systemImage: "leaf")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            if !explanation.isEmpty || metrics.contains(where: { number($0, "target") == nil }) {
                DisclosureGroup("Nutrition details") {
                    VStack(alignment: .leading, spacing: 8) {
                        if !explanation.isEmpty {
                            Text(explanation).accessibilityIdentifier("native-review-recipe-nutrition-explanation")
                        }
                        ForEach(metrics.filter { number($0, "target") == nil }, id: \.nativeReviewKey) { metric in
                            Text(string(metric, "title") + ": " + string(metric, "targetReason", fallback: "Target unavailable"))
                        }
                    }.font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.top, 8)
                }.font(.caption)
            }
        }
    }

    private func isEstimatedScore(_ score: [String: Any]) -> Bool {
        bool(score, "estimated") || string(score, "status").hasPrefix("estimated") || string(score, "scoreBasis") == "model_nutrient_estimate"
    }

    private func estimateBadge(_ title: String) -> some View {
        Text(title).font(.caption.weight(.semibold))
            .foregroundStyle(Color(uiColor: NudgeTheme.warningText))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Color(uiColor: NudgeTheme.warningSurface), in: Capsule())
            .fixedSize(horizontal: false, vertical: true)
    }

    private func nutritionLine(_ nutrient: [String: Any]) -> some View {
        let color = NativeTrackingDisplay.color(nutrient)
        let isPlant = string(nutrient, "key") == "plants"
        let partial = !isPlant && (number(nutrient, "unknown") ?? 0) > 0
        let amount = number(nutrient, "value").map { (partial ? "≥ " : isPlant ? "+" : "") + format($0) } ?? "—"
        let target = number(nutrient, "target").flatMap { $0 > 0 ? format($0) : nil }
        let percent = number(nutrient, "percent").map { (partial ? "≥ " : "") + "\(Int($0.rounded()))%" } ?? "—"
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(string(nutrient, "title") + (isPlant ? " · week" : "")).font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
                Text(percent).font(.subheadline.weight(.bold)).monospacedDigit()
            }
            Text(amount + " / " + (target ?? "—") + " " + string(nutrient, "unit"))
                .font(string(nutrient, "key") == "energy" ? .title3.weight(.bold) : .subheadline).monospacedDigit()
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(color.opacity(0.18))
                    Capsule().fill(color).frame(width: geometry.size.width * min(1, max(0, number(nutrient, "ratio") ?? 0)))
                }
            }.frame(height: 6).accessibilityHidden(true)
            if (number(nutrient, "unknown") ?? 0) > 0 {
                Text(number(nutrient, "value") == nil ? "Nutrition unavailable" : "Partial")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("native-review-nutrient-" + string(nutrient, "key"))
    }

    private func portion(_ model: [String: Any]) -> some View {
        let draft = dictionary(model, "draft")
        let recipe = dictionary(model, "recipe")
        return panel("Your portion") {
            let photo = dictionary(model, "photoPortion")
            if !photo.isEmpty {
                VStack(spacing: 10) {
                    photoPortionShortcut("This photo estimate", fraction: 1, model: model)
                    photoPortionShortcut("Half of photo estimate", fraction: 0.5, model: model)
                }
            }
            if !recipe.isEmpty && !bool(recipe, "userEdited") {
                DisclosureGroup(string(model, "nutritionExplanation").isEmpty ? "Whole dish nutrition" : "Whole dish nutrition · incomplete") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(rows(recipe, "nutrients"), id: \.nativeReviewKey) { nutrient in
                            HStack {
                                Text(string(nutrient, "title")); Spacer()
                                Text(nutrientDisplay(nutrient)).fontWeight(.semibold)
                            }.font(.subheadline)
                        }
                        Text(string(model, "nutritionExplanation").isEmpty
                             ? "Recipe ingredients only. Any photographed side is additional."
                             : "Known recipe ingredients only. Missing amounts or sources are not included in these totals. Any photographed side is additional.").font(.caption)
                        NativeReviewNumberField(title: "Servings in the whole recipe", value: modelValue(recipe["servings"]), unit: "servings · optional") {
                            change(["recipeServings": $0])
                        }
                    }.padding(.top, 8)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 10) {
                    portionShortcut("Whole dish", value: 1, current: number(recipe, "selectedFraction"), field: "recipeFraction")
                    portionShortcut("½ dish", value: 0.5, current: number(recipe, "selectedFraction"), field: "recipeFraction")
                    portionShortcut("¼ dish", value: 0.25, current: number(recipe, "selectedFraction"), field: "recipeFraction")
                    if let servings = number(recipe, "servings"), servings > 1 && servings != 2 && servings != 4 {
                        portionShortcut("1 serving", value: 1 / servings, current: number(recipe, "selectedFraction"), field: "recipeFraction")
                    }
                }
                NativeReviewNumberField(title: "Fraction of the dish", value: modelValue(recipe["selectedFraction"]), unit: "of 1 whole dish") {
                    change(["recipeFraction": $0])
                }
                Text("Sides stay separate. Ingredient weights are uncooked.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            if !photo.isEmpty || !recipe.isEmpty {
                DisclosureGroup("Other amount") { numericPortion(model).padding(.top, 10) }
                    .font(.subheadline)
            } else { numericPortion(model) }
            if bool(model, "isMeal") && recipe.isEmpty {
                DisclosureGroup("Batch and volume") {
                    VStack(alignment: .leading, spacing: 12) {
                        NativeReviewNumberField(title: "Servings in the full batch", value: modelValue(draft["batchServings"]), unit: "servings") { change(["batchServings": $0]) }
                        NativeReviewNumberField(title: "Measured full batch volume", value: modelValue(draft["batchVolumeMl"]), unit: "ml · optional") { change(["batchVolumeMl": $0]) }
                        Text("Enter volume only if measured. Cups use 250 ml; half a UK pint is approximately 284 ml. Grams are not converted to ml.")
                            .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }.padding(.top, 10)
                }
            }
        }
    }

    private func numericPortion(_ model: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Measure", selection: Binding(get: { string(model, "measureId") }, set: { change(["measureId": $0]) })) {
                ForEach(rows(model, "measures"), id: \.nativeReviewID) { measure in
                    Text(string(measure, "label")).tag(string(measure, "id"))
                }
            }
            .pickerStyle(.menu).frame(minHeight: 48)
            .accessibilityIdentifier("native-review-measure")
            NativeReviewNumberField(title: string(model, "kind") == "entry" && string(model, "measureId") == "serving" ? "Number of saved portions" : "Amount", value: modelValue(model["quantity"]), unit: string(model, "quantityUnit", fallback: selectedMeasure(model))) {
                change(["quantity": $0])
            }
            let quantity = number(model, "quantity") ?? Double(string(model, "quantity")) ?? 0
            let step = number(model, "step") ?? 1
            HStack(spacing: 12) {
                Button { change(["quantity": quantity - step]) } label: { Label(format(step), systemImage: "minus") }
                    .disabled(quantity - step < (number(model, "minimum") ?? 0.1))
                Button { change(["quantity": quantity + step]) } label: { Label(format(step), systemImage: "plus") }
                    .disabled(quantity + step > (number(model, "maximum") ?? 5000))
            }
            .buttonStyle(NudgeButtonStyle(variant: .secondary))
            if let amount = number(model, "amount"), !string(model, "amountUnit").isEmpty {
                Text("\(format(amount)) \(string(model, "amountUnit")) selected").font(.subheadline.weight(.semibold))
            }
            if !string(model, "guidance").isEmpty { Text(string(model, "guidance")).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
        }
    }

    private func timing(_ model: [String: Any]) -> some View {
        let draft = dictionary(model, "draft")
        return panel("When did you eat it?") {
            DatePicker("Date", selection: Binding(get: { date(string(draft, "day")) }, set: { change(["day": day($0)]) }), in: ...Date(), displayedComponents: .date)
        }
    }

    private func ingredients(_ model: [String: Any]) -> some View {
        panel("Ingredients and plants") {
            let content = string(model, "ingredients")
            Text(content.isEmpty ? "Ingredients have not been supplied." : content).font(.body)
            let plants = model["plants"] as? [String] ?? []
            Text(plants.isEmpty ? "No named plants recorded." : "\(plants.count) named plants: " + plants.joined(separator: ", "))
                .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.plantText))
            if !rows(model, "plantChoices").isEmpty {
                DisclosureGroup("Review named plants") {
                    ForEach(rows(model, "plantChoices"), id: \.nativeReviewIndex) { plant in
                        Toggle(string(plant, "name"), isOn: Binding(get: { bool(plant, "selected") }, set: { change(["plant": ["index": plant["index"] ?? 0, "selected": $0]]) }))
                            .disabled(!bool(plant, "supported"))
                            .padding(.vertical, 6)
                    }
                }
            }
            DisclosureGroup("Edit ingredients") {
                NativeReviewTextField(title: "Ingredients", value: content, multiline: true) { change(["ingredients": $0]) }
                    .padding(.top, 10)
                if string(model, "kind") == "entry" {
                    NativeReviewTextField(title: "Named plants, separated by commas", value: plants.joined(separator: ", "), multiline: true) { change(["plants": $0]) }
                }
            }
        }
    }

    private func componentEditor(_ model: [String: Any]) -> some View {
        panel("Check the food and amounts") {
            Text("These are source-based estimates. Change the matching food or grams to update nutrition, including carbs and fats.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            ForEach(rows(model, "components"), id: \.nativeReviewIndex) { component in
                VStack(alignment: .leading, spacing: 10) {
                    Text(string(component, "name")).font(.headline)
                    let recipeAmount = string(component, "recipeAmountLabel")
                    let recipeEvidence = string(component, "recipeEvidence")
                    if !recipeAmount.isEmpty {
                        Text("Recipe: " + recipeAmount + " for the whole dish")
                            .font(.subheadline.weight(.semibold))
                            .accessibilityIdentifier("native-review-recipe-amount-\(component["index"] ?? 0)")
                    }
                    if !recipeEvidence.isEmpty {
                        Text(recipeEvidence).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    if bool(component, "missingAmount") || bool(component, "missingSource") {
                        Text(bool(component, "missingAmount")
                             ? "Ingredient weight is still unknown."
                             : "No matched nutrition source yet.")
                            .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    Picker("Nutrition source", selection: Binding(get: { string(component, "recordId") }, set: { change(["component": ["index": component["index"] ?? 0, "recordId": $0]]) })) {
                        Text("No composition match").tag("")
                        ForEach(rows(component, "candidates"), id: \.nativeReviewID) { candidate in
                            Text(string(candidate, "name")).tag(string(candidate, "id"))
                        }
                    }.pickerStyle(.menu)
                    NativeReviewNumberField(title: bool(component, "estimated") ? "Ingredient grams · estimated" : "Ingredient grams", value: modelValue(component["amountGrams"]), unit: "g · leave blank if unknown") {
                        change(["component": ["index": component["index"] ?? 0, "amountGrams": $0]])
                    }
                    Text(string(component, "source")).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Button("Remove ingredient", role: .destructive) { change(["component": ["index": component["index"] ?? 0, "remove": true]]) }
                        .frame(minHeight: 48)
                }.padding(.vertical, 8)
                Divider()
            }
        }
    }

    private func detailsEditor(_ model: [String: Any]) -> some View {
        let draft = dictionary(model, "draft")
        return panel("Food details") {
            NativeReviewTextField(title: "Food name", value: string(draft, "name")) { change(["name": $0]) }
            NativeReviewTextField(title: "Brand", value: string(draft, "brand")) { change(["brand": $0]) }
            if !bool(model, "isComposition") {
                DisclosureGroup("Edit known nutrition") {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Values \(string(model, "nutritionEditBasis")). Leave unknown amounts blank.")
                            .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        if string(model, "kind") == "product" {
                            Picker("Printed nutrition basis", selection: Binding(get: { string(model, "basis") }, set: { change(["basis": $0]) })) {
                                Text("Per 100 g").tag("g"); Text("Per 100 ml").tag("ml")
                            }.pickerStyle(.menu)
                        } else if !bool(model, "isMeal") {
                            Picker("Printed nutrition basis", selection: Binding(get: { string(model, "basis") }, set: { change(["basis": $0]) })) {
                                Text("Unknown").tag("unknown"); Text("Per 100 g").tag("per100g")
                                Text("Per 100 ml").tag("per100ml"); Text("Per serving").tag("perServing")
                            }.pickerStyle(.menu)
                            if string(model, "basis") == "perServing" {
                                let serving = dictionary(model, "servingSize")
                                NativeReviewNumberField(title: "Printed serving amount", value: modelValue(serving["value"]), unit: string(serving, "unit", fallback: "g")) {
                                    change(["servingSize": ["value": $0, "unit": string(serving, "unit", fallback: "g")]])
                                }
                                Picker("Serving unit", selection: Binding(get: { string(serving, "unit", fallback: "g") }, set: {
                                    change(["servingSize": ["value": serving["value"] ?? NSNull(), "unit": $0]])
                                })) { Text("Grams").tag("g"); Text("Millilitres").tag("ml") }.pickerStyle(.menu)
                            }
                        }
                        if !bool(model, "isMeal") {
                            Picker("Preparation on the label", selection: Binding(get: { string(model, "nutritionPreparation") }, set: { change(["nutritionPreparation": $0]) })) {
                                Text("Unknown").tag("unknown"); Text("As sold").tag("as_sold"); Text("Prepared").tag("prepared")
                            }.pickerStyle(.menu)
                        }
                        ForEach(rows(model, "editableNutrients"), id: \.nativeReviewKey) { nutrient in
                            NativeReviewNumberField(title: string(nutrient, "title"), value: modelValue(nutrient["value"]), unit: string(nutrient, "unit")) {
                                change(["nutrient": ["key": string(nutrient, "key"), "value": $0]])
                            }
                        }
                    }.padding(.top, 12)
                }
            }
        }
    }

    @ViewBuilder private func sources(_ model: [String: Any]) -> some View {
        let sourceRows = rows(model, "sources")
        if !sourceRows.isEmpty {
            DisclosureGroup("Sources and estimates") {
                ForEach(Array(sourceRows.enumerated()), id: \.offset) { _, source in
                    if let url = URL(string: string(source, "url")), url.scheme == "https" {
                        Link(string(source, "title", fallback: "Source"), destination: url).frame(minHeight: 48)
                        if !string(source, "detail").isEmpty {
                            Text(string(source, "detail")).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        }
                    }
                }
            }
        }
    }

    private func portionLabel(_ model: [String: Any], fallback: String) -> String {
        guard let fraction = number(dictionary(model, "photoPortion"), "fraction") else { return fallback }
        if fraction == 1 { return "This photo estimate" }
        if fraction == 0.5 { return "Half of photo estimate" }
        return format(fraction) + " × photo estimate"
    }

    private func diaryActionTitle(_ model: [String: Any]) -> String {
        if bool(model, "editing") { return "Save diary changes" }
        if let fraction = number(dictionary(model, "photoPortion"), "fraction") {
            if fraction == 1 { return "Add this photo estimate" }
            if fraction == 0.5 { return "Add half of photo estimate" }
            return "Add selected photo estimate"
        }
        return "Add to diary"
    }

    private func photoPortionShortcut(_ title: String, fraction: Double, model: [String: Any]) -> some View {
        let selected = number(dictionary(model, "photoPortion"), "fraction") == fraction
        return Button {
            if applyMealDraft() { change(["photoFraction": fraction]) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                Text(title).font(.subheadline.weight(.semibold))
                Spacer(minLength: 0)
            }.frame(maxWidth: .infinity, minHeight: 48).padding(.horizontal, 12)
                .foregroundStyle(Color(uiColor: selected ? NudgeTheme.diaryAction : NudgeTheme.ink))
                .background(Color(uiColor: selected ? NudgeTheme.diaryAction : NudgeTheme.canvas).opacity(selected ? 0.1 : 1), in: RoundedRectangle(cornerRadius: 14))
        }.buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier(fraction == 1 ? "native-review-photo-whole" : "native-review-photo-half")
    }

    private func portionShortcut(_ label: String, value: Double, current: Double?, field: String) -> some View {
        Button { change([field: value]) } label: { Text((current == value ? "✓ " : "") + label) }
            .buttonStyle(NudgeButtonStyle(variant: .secondary))
            .accessibilityAddTraits(current == value ? .isSelected : [])
    }
    private func panel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color(uiColor: NudgeTheme.border)))
    }
    private func notice(_ text: String, error: Bool) -> some View {
        Text(text).font(.subheadline).padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(Color(uiColor: error ? NudgeTheme.errorText : NudgeTheme.muted))
            .background(Color(uiColor: error ? NudgeTheme.errorSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
    }
    private func applyMealDraft() -> Bool {
        if let patch = mealDraft.patch, !store.perform("reviewUpdate", patch) { return false }
        guard let draft = store.project("reviewModel")["draft"] as? [String: Any] else {
            store.errorMessage = "Your ingredient changes could not be checked. Please try again."
            return false
        }
        if let message = draft["inputError"] as? String, !message.isEmpty {
            store.errorMessage = message
            return false
        }
        mealDraft.patch = nil; hasPendingMealChanges = false
        return true
    }
    private func change(_ patch: [String: Any]) { _ = store.perform("reviewUpdate", patch) }
    private func string(_ object: [String: Any], _ key: String, fallback: String = "") -> String { object[key] as? String ?? fallback }
    private func number(_ object: [String: Any], _ key: String) -> Double? { (object[key] as? NSNumber)?.doubleValue }
    private func bool(_ object: [String: Any], _ key: String) -> Bool { object[key] as? Bool == true }
    private func dictionary(_ object: [String: Any], _ key: String) -> [String: Any] { object[key] as? [String: Any] ?? [:] }
    private func rows(_ object: [String: Any], _ key: String) -> [[String: Any]] { object[key] as? [[String: Any]] ?? [] }
    private func format(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0...3))) }
    private func modelValue(_ value: Any?) -> String { if let value = value as? String { return value }; if let value = value as? NSNumber { return String(value.doubleValue) }; return "" }
    private func nutrientDisplay(_ nutrient: [String: Any]) -> String {
        if let value = number(nutrient, "value") { return "\(format(value)) \(string(nutrient, "unit"))" }
        if bool(nutrient, "partial"), let value = number(nutrient, "knownSubtotal") { return "≥ \(format(value)) \(string(nutrient, "unit"))" }
        return "Unknown"
    }
    private func selectedMeasure(_ model: [String: Any]) -> String { string(rows(model, "measures").first { string($0, "id") == string(model, "measureId") } ?? [:], "label") }
    private func day(_ value: Date) -> String { let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; formatter.locale = Locale(identifier: "en_GB"); return formatter.string(from: value) }
    private func date(_ value: String) -> Date { let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"; formatter.locale = Locale(identifier: "en_GB"); return formatter.date(from: value) ?? Date() }
}

/// Keeps unfinished decimal input local while valid edits update the domain
/// draft. Clearing a field means unknown, never zero.
private struct NativeReviewNumberField: View {
    let title: String
    let value: String
    let unit: String
    let onEdit: (String) -> Void
    @State private var raw = ""
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            HStack {
                TextField("Unknown", text: Binding(get: { raw }, set: { raw = $0; onEdit($0) }))
                    .keyboardType(.decimalPad).focused($focused).font(.body).monospacedDigit()
                    .accessibilityLabel(title)
                Text(unit).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            .padding(12).frame(minHeight: 48)
            .background(Color(uiColor: NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(uiColor: focused ? NudgeTheme.accent : NudgeTheme.border)))
        }
        .onAppear { raw = value }
        .onChange(of: value) { newValue in if !focused { raw = newValue } }
        .onChange(of: focused) { focus in if !focus { raw = value } }
    }
}

private struct NativeReviewTextField: View {
    let title: String
    let value: String
    var multiline = false
    let onEdit: (String) -> Void
    @State private var raw = ""
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            TextField(title, text: Binding(get: { raw }, set: { raw = $0; onEdit($0) }), axis: multiline ? .vertical : .horizontal)
                .focused($focused)
                .lineLimit(multiline ? 3...8 : 1...1).font(.body)
                .padding(12).frame(minHeight: 48)
                .background(Color(uiColor: NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(uiColor: NudgeTheme.border)))
                .accessibilityLabel(title)
        }
        .onAppear { raw = value }
        .onChange(of: value) { newValue in if !focused { raw = newValue } }
        .onChange(of: focused) { focus in if !focus { raw = value } }
    }
}

private struct NativeReviewImage: View {
    let source: String
    var barcode: String? = nil
    @State private var image: UIImage?
    @State private var loadedIdentity: String?
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: "fork.knife").font(.largeTitle).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20)).accessibilityHidden(true)
        .task(id: source + "|" + (barcode ?? "")) {
            let identity = NativeTrackingDisplay.imageIdentity(source: source, barcode: barcode)
            if loadedIdentity != identity { image = nil }
            var source = source
            if source.isEmpty, let barcode {
                source = await NativeCatalogueImageReferences.shared.source(for: barcode) ?? ""
                guard !Task.isCancelled else { return }
            }
            if source.hasPrefix("data:image/jpeg;base64,"), source.count <= 250_000,
               let data = Data(base64Encoded: String(source.dropFirst("data:image/jpeg;base64,".count))) { image = UIImage(data: data); loadedIdentity = identity }
            else if let url = CatalogueProductImages.sourceURL(source), let data = try? await CatalogueProductImages.shared.data(for: url), !Task.isCancelled { image = UIImage(data: data); loadedIdentity = identity }
            else if source.hasPrefix("/assets/"), !source.contains(".."),
                    let url = Bundle.main.resourceURL?.appendingPathComponent("Web" + source), let data = try? Data(contentsOf: url) { image = UIImage(data: data); loadedIdentity = identity }
        }
    }
}

private extension Dictionary where Key == String, Value == Any {
    var nativeReviewKey: String { self["key"] as? String ?? "" }
    var nativeReviewID: String { self["id"] as? String ?? "" }
    var nativeReviewIndex: Int { self["index"] as? Int ?? 0 }
}

private extension View {
    func reviewCard() -> some View {
        padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color(uiColor: NudgeTheme.border)))
    }
    @ViewBuilder func reviewControl(_ identifier: String) -> some View {
        #if DEBUG
        accessibilityIdentifier(identifier).background {
            GeometryReader { geometry in
                Color.clear.preference(key: NativeTrackingRenderGeometryKey.self, value: [identifier: geometry.frame(in: .global)])
            }.allowsHitTesting(false).accessibilityHidden(true)
        }
        #else
        accessibilityIdentifier(identifier)
        #endif
    }
}
