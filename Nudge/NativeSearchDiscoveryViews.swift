import SwiftUI
import UIKit

struct NativeSearchPlacesSheet: View {
    let selected: SearchPlace?
    let onSelect: (SearchPlace?) -> Void
    @State private var query = ""
    @State private var group: SearchPlace.Group?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var textSize

    private var matches: [SearchPlace] {
        SearchPlace.all.filter { (group == nil || $0.groups.contains(group!)) && (query.isEmpty || $0.matches(query)) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Where to eat or shop").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text("Choose a place, or browse all places. No location access needed.")
                        .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    TextField("", text: $query, prompt: Text("Try Tesco, Greggs or Pret").foregroundColor(Color(uiColor: NudgeTheme.muted)))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(14).frame(minHeight: 48)
                        .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: NudgeTheme.strongBorder)))
                        .accessibilityLabel("Search supermarkets and chains")
                        .searchControl("search-place-query")
                    Button { onSelect(nil); dismiss() } label: {
                        HStack(spacing: 10) {
                            Image(systemName: selected == nil ? "checkmark.circle.fill" : "globe.europe.africa").font(.system(size: 22)).accessibilityHidden(true)
                            Text("All places")
                        }
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary))
                    .searchControl("search-place-all")
                    if let group {
                        Button { self.group = nil } label: {
                            Label("All place types", systemImage: "chevron.left").frame(minHeight: 48)
                        }
                        Text(group.title).font(.headline)
                    }
                    if query.isEmpty && group == nil {
                        ForEach(Array(SearchPlace.Group.allCases.enumerated()), id: \.element.id) { index, category in
                            Button { group = category } label: {
                                VStack(alignment: .leading, spacing: 10) {
                                    if textSize.isAccessibilitySize {
                                        HStack {
                                            Image(systemName: symbol(category)).font(.system(size: 24)).accessibilityHidden(true)
                                            Spacer()
                                            Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)).accessibilityHidden(true)
                                        }
                                        Text(category.title).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                                    } else {
                                        HStack(spacing: 14) {
                                            Image(systemName: symbol(category)).font(.system(size: 24)).accessibilityHidden(true)
                                            Text(category.title).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                                            Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)).accessibilityHidden(true)
                                        }
                                    }
                                }
                                .padding(20).frame(minHeight: 76)
                                .foregroundStyle(Color(uiColor: NudgeTheme.discoveryInk(index)))
                                .background(Color(uiColor: NudgeTheme.discoveryFill(index)), in: RoundedRectangle(cornerRadius: 20))
                            }
                            .buttonStyle(NativeSearchTouchButtonStyle())
                            .searchControl("search-place-group-\(category.id)")
                        }
                    } else if matches.isEmpty {
                        Text("No places match this search").font(.headline)
                        Button("Show all places") { query = ""; group = nil }.buttonStyle(NativeSearchTouchButtonStyle())
                    } else {
                        ForEach(matches) { place in
                            Button { onSelect(place); dismiss() } label: {
                                HStack(alignment: .center, spacing: 12) {
                                    Image(systemName: symbol(group ?? place.group)).font(.system(size: 22)).accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(place.title).font(.headline)
                                        Text(place.isSupermarket ? "Catalogue products · coverage varies" : "Branded catalogue products · current menu unavailable")
                                            .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    if selected?.id == place.id { Image(systemName: "checkmark").font(.system(size: 18)).accessibilityHidden(true) }
                                }
                                .padding(16).frame(minHeight: 60)
                                .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                            }
                            .buttonStyle(NativeSearchTouchButtonStyle())
                            .accessibilityAddTraits(selected?.id == place.id ? .isSelected : [])
                            .searchControl("search-place-\(place.id)")
                        }
                    }
                }
                .padding(.horizontal, textSize.isAccessibilitySize ? 8 : 20).padding(.vertical, 20)
                .frame(maxWidth: 600, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: NudgeTheme.canvas))
            .foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .navigationTitle("Choose a place")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(uiColor: NudgeTheme.canvas), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.buttonStyle(NativeSearchTouchButtonStyle()) } }
        }
        .tint(Color(uiColor: NudgeTheme.accent))
        .buttonStyle(NativeSearchTouchButtonStyle())
    }

    private func symbol(_ group: SearchPlace.Group) -> String {
        switch group { case .supermarket: "basket"; case .cafe: "cup.and.saucer"; case .restaurant: "fork.knife" }
    }
}

enum NativeSearchDiscoveryRoute: String, CaseIterable, Identifiable {
    case aisles, women, diet, nutrition
    var id: String { rawValue }
    var title: String {
        switch self {
        case .aisles: "Food aisles"
        case .women: "Women’s nutrition"
        case .diet: "Dietary needs"
        case .nutrition: "Nutrition choices"
        }
    }
    var symbol: String {
        switch self {
        case .aisles: "basket"
        case .women: "heart"
        case .diet: "line.3.horizontal.decrease.circle"
        case .nutrition: "leaf"
        }
    }
}

/// Context guides select ordinary, visible food filters. A life stage is not
/// evidence of deficiency or a product-specific symptom benefit.
enum NativeNutritionGuide: String, CaseIterable, Identifiable {
    case periods, perimenopause, postmenopause, pms
    var id: String { rawValue }
    var title: String {
        switch self {
        case .periods: "Periods & cycle"
        case .perimenopause: "Perimenopause"
        case .postmenopause: "After menopause"
        case .pms: "Premenstrual symptoms"
        }
    }
    var summary: String {
        switch self {
        case .periods: "Iron intake and everyday food choices"
        case .perimenopause: "Explore nutrition for bone health"
        case .postmenopause: "Calcium and vitamin D food choices"
        case .pms: "Everyday nutrition and emerging research"
        }
    }
    var explanation: String {
        switch self {
        case .periods: "Iron helps the body make red blood cells. People who have periods, especially heavy periods, can have higher iron needs. A cycle phase alone does not establish iron deficiency. Explore food sources across the month."
        case .perimenopause: "A varied, balanced diet remains important during perimenopause. Calcium-containing foods and vitamin D contribute to bone health. These filters help find foods with recorded nutrients; they do not predict how a product will affect symptoms."
        case .postmenopause: "Bone health remains important after menopause. Explore calcium and vitamin D food sources alongside a varied diet. A food’s nutrient content is only one part of meeting individual needs."
        case .pms: "The NHS recommends a healthy, balanced diet for people experiencing PMS. Research into supplements and symptoms is limited and cannot be used to promise that an individual food relieves symptoms. These are ordinary food choices to explore, not PMS treatments."
        }
    }
    var choices: [SearchNutritionChoice] {
        switch self {
        case .periods: [.iron, .wholegrain]
        case .perimenopause, .postmenopause: [.calcium, .vitd]
        case .pms: [.calcium, .wholegrain]
        }
    }
    var sourceTitle: String {
        switch self {
        case .periods: "NHS: Iron"
        case .perimenopause, .postmenopause: "NHS: Menopause and perimenopause"
        case .pms: "NHS: Premenstrual syndrome"
        }
    }
    var sourceURL: URL {
        switch self {
        case .periods: URL(string: "https://www.nhs.uk/conditions/vitamins-and-minerals/iron/")!
        case .perimenopause, .postmenopause: URL(string: "https://www.nhs.uk/conditions/menopause-and-perimenopause/things-you-can-do/")!
        case .pms: URL(string: "https://www.nhs.uk/conditions/pre-menstrual-syndrome/")!
        }
    }
}

struct NativeNutritionGuideSheet: View {
    let guide: NativeNutritionGuide
    let onChoose: (SearchNutritionChoice) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(guide.title).font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text(guide.explanation).font(.body)
                    Text("Explore food choices").font(.headline)
                    ForEach(guide.choices) { choice in
                        Button {
                            onChoose(choice)
                            dismiss()
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "leaf").font(.system(size: 22)).accessibilityHidden(true)
                                Text(choice.title)
                            }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                        .searchControl("guide-choice-\(choice.id)")
                    }
                    Text("Your selected dietary requirements stay applied. Choosing a nutrient does not certify allergy suitability or symptom relief.")
                        .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Link(destination: guide.sourceURL) {
                        Label(guide.sourceTitle, systemImage: "arrow.up.right.square")
                            .frame(minHeight: 48)
                    }
                    Text("Source reviewed 9 October 2026").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                .padding(20)
                .frame(maxWidth: 600, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: NudgeTheme.canvas))
            .foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .navigationTitle("Women’s nutrition")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(uiColor: NudgeTheme.canvas), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.buttonStyle(NativeSearchTouchButtonStyle()) } }
        }
        .tint(Color(uiColor: NudgeTheme.accent))
        .buttonStyle(NativeSearchTouchButtonStyle())
        .searchControl("nutrition-guide-sheet")
    }
}

/// Draft filters do not issue requests on each toggle; Apply sends one atomic
/// selection to the existing search model. Cancelling leaves results intact.
struct NativeSearchFiltersSheet: View {
    @State private var dietary: Set<SearchDietaryRequirement>
    @State private var nutrition: Set<SearchNutritionChoice>
    @State private var mode: SearchNutritionMode
    let onApply: (Set<SearchDietaryRequirement>, Set<SearchNutritionChoice>, SearchNutritionMode) -> Void
    @Environment(\.dismiss) private var dismiss

    init(dietary: Set<SearchDietaryRequirement>, nutrition: Set<SearchNutritionChoice>, mode: SearchNutritionMode,
         onApply: @escaping (Set<SearchDietaryRequirement>, Set<SearchNutritionChoice>, SearchNutritionMode) -> Void) {
        _dietary = State(initialValue: dietary)
        _nutrition = State(initialValue: nutrition)
        _mode = State(initialValue: mode)
        self.onApply = onApply
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Dietary needs").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                    Text("Every selected requirement must have supporting label evidence. Missing information does not establish suitability.")
                        .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    ForEach(SearchDietaryRequirement.allCases) { requirement in
                        selection(requirement.title, selected: dietary.contains(requirement), identifier: "filter-diet-\(requirement.id)") {
                            if dietary.contains(requirement) { dietary.remove(requirement) } else { dietary.insert(requirement) }
                        }
                    }
                    Text("Lactose-free is different from milk-free; gluten-free is different from wheat-free. Vegan and vegetarian are preferences, not allergen assurances.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Divider()
                    Text("Nutrition choices").font(.title2.weight(.bold)).accessibilityAddTraits(.isHeader)
                    ForEach(SearchNutritionChoice.allCases) { choice in
                        selection(choice.title, selected: nutrition.contains(choice), identifier: "filter-nutrition-\(choice.id)") {
                            if nutrition.contains(choice) { nutrition.remove(choice) } else { nutrition.insert(choice) }
                        }
                    }
                    Text("Combine nutrition choices").font(.headline)
                    selection("Match any", selected: mode == .any, identifier: "filter-mode-any") { mode = .any }
                    selection("Match all", selected: mode == .all, identifier: "filter-mode-all") { mode = .all }
                    Text("This setting only changes nutrition choices. Dietary requirements always match all selections.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Button("Clear these filters") { dietary = []; nutrition = []; mode = .any }
                        .buttonStyle(NativeSearchTouchButtonStyle())
                        .searchControl("filters-clear")
                    Button("Show matching foods") { onApply(dietary, nutrition, mode); dismiss() }
                        .buttonStyle(NudgeButtonStyle())
                        .searchControl("filters-apply")
                }
                .padding(20)
                .frame(maxWidth: 600, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: NudgeTheme.canvas))
            .foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .navigationTitle("Search filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(uiColor: NudgeTheme.canvas), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.buttonStyle(NativeSearchTouchButtonStyle()) } }
        }
        .tint(Color(uiColor: NudgeTheme.accent))
        .buttonStyle(NativeSearchTouchButtonStyle())
    }

    private func selection(_ title: String, selected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title).font(.body.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.system(size: 22)).accessibilityHidden(true)
            }
            .padding(14).frame(maxWidth: .infinity, minHeight: 48)
            .foregroundStyle(Color(uiColor: NudgeTheme.accent))
            .background(Color(uiColor: selected ? NudgeTheme.selectedSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: selected ? NudgeTheme.accent : NudgeTheme.border), lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(NativeSearchTouchButtonStyle())
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .searchControl(identifier)
    }
}
