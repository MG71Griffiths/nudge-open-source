import SwiftUI

@MainActor
final class NativeMealReviewDraft {
    var patch: [String: Any]?
}

/// Selection and search move together: a chosen ingredient stays above the next
/// search, and an old debounced result cannot refill a cleared search field.
struct NativeMealIngredientPickerDraft {
    private(set) var selected: [String]
    private(set) var extraNames: [String] = []
    var search = ""
    private(set) var searchItems: [[String: Any]] = []
    private(set) var searchTotal = 0
    private(set) var completedSearch = ""

    init(selected: [String]) {
        var seen = Set<String>()
        self.selected = selected.filter { seen.insert(Self.key($0)).inserted }
    }

    var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    func contains(_ name: String) -> Bool {
        selected.contains { Self.key($0) == Self.key(name) }
    }

    /// Returns false only when the 40-ingredient limit prevents an addition.
    @discardableResult
    mutating func toggle(_ name: String) -> Bool {
        if let index = selected.firstIndex(where: { Self.key($0) == Self.key(name) }) {
            selected.remove(at: index)
            return true
        }
        guard selected.count < 40 else { return false }
        selected.insert(name, at: 0)
        if !extraNames.contains(where: { Self.key($0) == Self.key(name) }) { extraNames.append(name) }
        search = ""
        clearSearchResults()
        return true
    }

    mutating func clearSearchResults() {
        searchItems = []; searchTotal = 0; completedSearch = ""
    }

    mutating func acceptSearch(_ result: [String: Any], for requestedQuery: String) {
        guard !requestedQuery.isEmpty, requestedQuery == query else { return }
        searchItems = result["items"] as? [[String: Any]] ?? []
        searchTotal = result["total"] as? Int ?? searchItems.count
        completedSearch = requestedQuery
    }

    func available(_ values: [[String: Any]]) -> [[String: Any]] {
        var seen = Set(selected.map(Self.key))
        return values.filter {
            guard let name = $0["name"] as? String else { return false }
            return seen.insert(Self.key(name)).inserted
        }
    }

    private static func key(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// The catalogue and draft stay local while browsing. Only Confirm or the
/// parent Save action crosses the review bridge, so each chip remains responsive.
@MainActor
struct NativeMealIngredientPicker: View {
    let model: [String: Any]
    let canAnalyse: Bool
    let isAnalysing: Bool
    let statusMessage: String?
    let analysisServiceText: String
    let onDraftChange: ([String: Any]) -> Void
    let onApply: () -> Bool
    let onDiscardDraft: () -> Void
    let onAnalyse: () -> Bool
    let onSearch: (String) -> [String: Any]
    @State private var draft: NativeMealIngredientPickerDraft
    @State private var amount: Double?
    @State private var unit: String
    @State private var browseAll = false
    @State private var dirty = false
    @State private var isEditing: Bool
    @FocusState private var ingredientSearchFocused: Bool

    init(model: [String: Any], canAnalyse: Bool, isAnalysing: Bool, statusMessage: String?, analysisServiceText: String = "Uses Nudge’s service", onDraftChange: @escaping ([String: Any]) -> Void,
         onApply: @escaping () -> Bool, onDiscardDraft: @escaping () -> Void = {}, onAnalyse: @escaping () -> Bool, onSearch: @escaping (String) -> [String: Any]) {
        self.model = model; self.canAnalyse = canAnalyse; self.isAnalysing = isAnalysing; self.statusMessage = statusMessage
        self.analysisServiceText = analysisServiceText
        self.onDraftChange = onDraftChange; self.onApply = onApply; self.onDiscardDraft = onDiscardDraft; self.onAnalyse = onAnalyse; self.onSearch = onSearch
        _draft = State(initialValue: NativeMealIngredientPickerDraft(selected: model["selected"] as? [String] ?? []))
        _isEditing = State(initialValue: false)
        let portion = model["portion"] as? [String: Any] ?? [:]
        _amount = State(initialValue: (portion["amount"] as? NSNumber)?.doubleValue)
        _unit = State(initialValue: portion["unit"] as? String ?? model["defaultUnit"] as? String ?? "g")
    }

    private var catalogue: [[String: Any]] { model["catalogue"] as? [[String: Any]] ?? [] }
    private var confirmed: Bool { model["confirmed"] as? Bool == true }
    private var remoteSignature: String {
        let portion = model["portion"] as? [String: Any] ?? [:]
        return "\(confirmed)" + (model["selected"] as? [String] ?? []).joined(separator: "|") + "\(portion["amount"] ?? "")\(portion["unit"] ?? "")"
    }
    private var query: String { draft.query }
    private var selected: [String] { draft.selected }
    private var allIngredients: [[String: Any]] { model["allIngredients"] as? [[String: Any]] ?? catalogue }
    private var portionOptions: [[String: Any]] { model["options"] as? [[String: Any]] ?? [] }
    private var portionStep: Double { (model["step"] as? NSNumber)?.doubleValue ?? 25 }
    private var filtered: [[String: Any]] {
        if !query.isEmpty { return draft.completedSearch == query ? draft.available(draft.searchItems) : [] }
        let base = browseAll ? allIngredients : catalogue
        return draft.available(base + draft.extraNames.map { ["name": $0, "category": "Your ingredients"] })
    }
    private var customName: String? {
        guard !query.isEmpty, draft.completedSearch == query, query.utf16.count <= 80, query.rangeOfCharacter(from: .alphanumerics) != nil,
              query.rangeOfCharacter(from: .controlCharacters) == nil,
              query.rangeOfCharacter(from: CharacterSet(charactersIn: "<>\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}")) == nil,
              !draft.contains(query),
              !(draft.searchItems + allIngredients).contains(where: { ($0["name"] as? String)?.caseInsensitiveCompare(query) == .orderedSame }) else { return nil }
        return query
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What’s in it?").font(.title3.bold()).accessibilityAddTraits(.isHeader)
            if isEditing {
                editor
            } else {
                confirmedIngredients
            }
            if isAnalysing || statusMessage?.isEmpty == false {
                HStack(spacing: 8) {
                    if isAnalysing { ProgressView() }
                    Text(statusMessage ?? "Analysing… you can carry on.").font(.caption)
                }.accessibilityIdentifier("native-meal-refinement-status")
            }
        }
        .padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color(uiColor: NudgeTheme.border)))
        .accessibilityIdentifier("native-meal-ingredient-picker")
        .onChange(of: remoteSignature) { _ in
            restoreSavedSelection()
            // Applying the analysis draft is not a successful dispatch. Keep
            // the editor available if loading or queueing its photos fails.
        }
        .task(id: draft.search) {
            let requestedQuery = query
            guard isEditing, !requestedQuery.isEmpty else { draft.clearSearchResults(); return }
            do { try await Task.sleep(nanoseconds: 160_000_000) } catch { return }
            guard !Task.isCancelled, requestedQuery == query else { return }
            draft.acceptSearch(onSearch(requestedQuery), for: requestedQuery)
        }
    }

    private var confirmedIngredients: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], alignment: .leading, spacing: 8) {
                ForEach((model["selected"] as? [String] ?? []), id: \.self) { name in
                    Text(name)
                        .font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true).padding(10)
                        .background(Color(uiColor: NudgeTheme.accent).opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                        .mealIngredientControl("native-meal-confirmed-ingredient-" + name)
                }
            }.accessibilityIdentifier("native-meal-confirmed-ingredients")
            Button(selected.isEmpty ? "Choose ingredients" : "Edit ingredients") {
                browseAll = confirmed
                isEditing = true
            }
            .buttonStyle(NudgeButtonStyle(variant: .secondary))
            .mealIngredientControl("native-meal-edit-ingredients")
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Tap what’s in your food.").font(.subheadline)
            if !selected.isEmpty {
                Text("Selected").font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
                chips(selected.map { ["name": $0] })
                    .accessibilityIdentifier("native-meal-selected-ingredients")
            }
            TextField("Add an ingredient", text: $draft.search)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .focused($ingredientSearchFocused)
                .mealIngredientControl("native-meal-ingredient-search")
            if !query.isEmpty && draft.completedSearch == query {
                if draft.searchTotal == 0 { Text("No match. Add your own below.").font(.caption) }
                else if draft.searchTotal > draft.searchItems.count { Text("\(draft.searchTotal) matches · keep typing").font(.caption) }
            }
            chips(filtered)
            if let name = customName {
                Button { toggleIngredient(name) } label: {
                    Label("Add “\(name)”", systemImage: "plus.circle.fill")
                }
                .buttonStyle(NudgeButtonStyle(variant: .secondary))
                .disabled(selected.count >= 40)
                .accessibilityIdentifier("native-meal-add-custom-ingredient")
                Text("Name only · analyse for nutrition.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }
            if query.isEmpty {
                Button(browseAll ? "Back to this dish" : "Browse all ingredients") { browseAll.toggle() }
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("native-meal-browse-ingredients")
            }
            if selected.count >= 40 { Text("40 ingredients selected — remove one to add another.").font(.caption) }
            DisclosureGroup("Measured weight or volume") {
                VStack(alignment: .leading, spacing: 12) {
            Text("Use a measured total, if you know it.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 105))], spacing: 10) {
                ForEach(Array(portionOptions.enumerated()), id: \.offset) { _, option in
                    if let value = (option["amount"] as? NSNumber)?.doubleValue, let optionUnit = option["unit"] as? String {
                        portionButton(option["label"] as? String ?? "\(value) \(optionUnit)", amount: value, unit: optionUnit)
                    }
                }
            }
            if let amount {
                HStack(spacing: 12) {
                    Button { setPortion(max(1, amount - portionStep), unit: unit) } label: { Image(systemName: "minus") }
                        .accessibilityLabel("Decrease whole portion by \(Int(portionStep)) \(unit)")
                        .disabled(amount <= 1)
                    Text("\(amount.formatted(.number.precision(.fractionLength(0...1)))) \(unit)")
                        .font(.headline).frame(maxWidth: .infinity)
                        .accessibilityIdentifier("native-meal-whole-portion")
                    Button { setPortion(min(5000, amount + portionStep), unit: unit) } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Increase whole portion by \(Int(portionStep)) \(unit)")
                        .disabled(amount >= 5000)
                }.buttonStyle(NudgeButtonStyle(variant: .secondary))
            }
            Text(model["portionExplanation"] as? String ?? "").font(.caption)
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }.padding(.top, 8)
            }.font(.subheadline)
            if canAnalyse {
                Button("Update analysis") { _ = onAnalyse() }
                    .buttonStyle(NudgeButtonStyle()).disabled(selected.isEmpty || isAnalysing)
                    .accessibilityIdentifier("native-meal-analyse-ingredients")
                DisclosureGroup("Analysis details") {
                    Text(analysisServiceText).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .accessibilityIdentifier("native-meal-analysis-service")
                }.font(.caption)
            } else {
                Button("Confirm ingredients") { if onApply() { finishEditing() } }
                    .buttonStyle(NudgeButtonStyle()).disabled(!dirty)
                    .accessibilityIdentifier("native-meal-apply-ingredients")

            }
            if confirmed {
                Button("Cancel changes") {
                    restoreSavedSelection()
                    onDiscardDraft()
                    finishEditing()
                }
                .buttonStyle(NudgeButtonStyle(variant: .secondary))
                .accessibilityIdentifier("native-meal-cancel-ingredient-edit")
            }
        }
    }

    private func restoreSavedSelection() {
        draft = NativeMealIngredientPickerDraft(selected: model["selected"] as? [String] ?? [])
        let portion = model["portion"] as? [String: Any] ?? [:]
        amount = (portion["amount"] as? NSNumber)?.doubleValue
        unit = portion["unit"] as? String ?? model["defaultUnit"] as? String ?? "g"
        dirty = false
    }

    private func finishEditing() {
        dirty = false
        isEditing = false
        draft.search = ""
        draft.clearSearchResults()
    }

    private func chips(_ values: [[String: Any]]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130))], alignment: .leading, spacing: 8) {
            ForEach(values.compactMap { $0["name"] as? String }, id: \.self) { name in
                let isSelected = draft.contains(name)
                Button { toggleIngredient(name) } label: {
                    Label(name, systemImage: isSelected ? "checkmark.circle.fill" : "plus.circle")
                        .font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true).padding(10).frame(minHeight: 46)
                        .background(Color(uiColor: isSelected ? NudgeTheme.accent : NudgeTheme.canvas).opacity(isSelected ? 0.12 : 1), in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(!isSelected && selected.count >= 40)
                .accessibilityValue(isSelected ? "Selected" : "Not selected")
                .accessibilityHint(isSelected ? "Remove ingredient" : "Add ingredient and clear search")
                .accessibilityAddTraits(isSelected ? .isSelected : [])
                .mealIngredientControl("native-meal-ingredient-" + name)
            }
        }
    }
    private func portionButton(_ title: String, amount: Double, unit: String) -> some View {
        Button(title) { setPortion(amount, unit: unit) }
            .buttonStyle(NudgeButtonStyle(variant: .secondary))
            .accessibilityLabel(title == "UK pint" ? "One UK pint, approximately 568 ml" : title)
    }
    private func toggleIngredient(_ name: String) {
        if draft.toggle(name) { changed() }
    }
    private func setPortion(_ value: Double, unit: String) { amount = value; self.unit = unit; changed() }
    private func changed() {
        dirty = true
        var patch: [String: Any] = ["mealIngredients": selected.sorted()]
        if let amount { patch["mealPortion"] = ["amount": amount, "unit": unit] }
        onDraftChange(patch)
    }
}

private extension View {
    @ViewBuilder func mealIngredientControl(_ identifier: String) -> some View {
        #if DEBUG
        accessibilityIdentifier(identifier).background(GeometryReader { geometry in
            Color.clear.preference(key: NativeTrackingRenderGeometryKey.self, value: [identifier: geometry.frame(in: .global)])
        })
        #else
        accessibilityIdentifier(identifier)
        #endif
    }
}
