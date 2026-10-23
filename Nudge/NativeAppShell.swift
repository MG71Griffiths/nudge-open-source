import SwiftUI
import UIKit

@MainActor
struct NativeAppShell: View {
    @ObservedObject var store: NativeAppStore
    @State private var signInAfterAmbassadors = false
    var body: some View {
        ZStack {
            Color(uiColor: NudgeTheme.canvas).ignoresSafeArea()
            if store.ready {
                if store.selectedTab == "search" && store.presentationRoute == nil {
                    NativeProductSearchView(model: store.search, rating: store.ratings.rating,
                        onOpen: store.openProduct, onNavigate: store.navigate,
                        onSaved: { _ = store.perform("showSaved") }, ratingLoader: store.ratingLoader,
                        savedCount: store.savedCount, isSaved: store.isProductSaved,
                        onToggleSave: store.toggleProductSaved,
                        recipeSearch: { query, savedOnly in
                            store.project("search", ["kind": "recipe", "query": query,
                                                     "recipeLibraryOnly": true, "livePrefixMatch": true,
                                                     "savedOnly": savedOnly])
                        },
                        savedRecipeIDs: Set((store.state["foodLog"] as? [String: Any])?["savedRecipes"] as? [String] ?? []),
                        onOpenRecipe: { _ = store.perform("openRecipe", ["id": $0]) },
                        onToggleRecipeSaved: { _ = store.perform("recipeFavourite", ["id": $0]) })
                } else {
                    VStack(spacing: 0) {
                        header
                        content.frame(maxWidth: .infinity, maxHeight: .infinity)
                        NativeAppTabBar(selected: store.selectedTab, navigate: store.navigate, analysisCount: store.analysingCount)
                    }
                }
                if store.loading { loading }
            } else {
                NudgeShellStatus(error: store.errorMessage, retry: store.retryOpening)
            }
        }
        .foregroundStyle(Color(uiColor: NudgeTheme.ink)).tint(Color(uiColor: NudgeTheme.accent))
        .overlay(alignment: .top) {
            if let message = store.analysisAcknowledgement {
                let stage = store.capture.latestAnalysisStage
                let status = stage == .complete ? "Analysis finished. View the result in History." :
                    stage == nil ? "Check the analysis in History." : message
                VStack(alignment: .leading, spacing: 8) {
                    Text(status)
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let stage = store.capture.latestAnalysisStage {
                        NativeAnalysisProgressBar(fraction: stage.fraction)
                    }
                }
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .frame(maxWidth: 420)
                    .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                    .padding(.horizontal, 16).padding(.top, 12)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(status)
                    .accessibilityValue(stage.map { "Step \($0.rawValue) of 4" } ?? "")
                    .accessibilityIdentifier("analysis-acknowledgement")
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: store.analysisAcknowledgement) { message in
            if let message { UIAccessibility.post(notification: .announcement, argument: message) }
        }
        .alert("Nudge", isPresented: Binding(get: { store.ready && !store.reviewPresented && store.errorMessage != nil }, set: { if !$0 { store.errorMessage = nil } })) {
            Button("OK") { store.errorMessage = nil }
        } message: { Text(store.errorMessage ?? "Please try again.") }
        .sheet(isPresented: Binding(get: { store.reviewPresented }, set: { store.reviewPresented = $0 })) {
            NativeFoodReviewView(store: store)
                .id(store.review["confirmationId"] as? String ?? "review")
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: Binding(get: { store.reviewPresented ? nil : store.contributionContext }, set: { store.contributionContext = $0 })) { context in
            NativeProductContributionView(context: context)
        }
        .sheet(isPresented: $store.addFoodPresented, onDismiss: store.completeAddFoodSelection) {
            NativeAddFoodChooser(store: store)
        }
        .sheet(isPresented: $store.ambassadorsPresented, onDismiss: {
            if signInAfterAmbassadors { signInAfterAmbassadors = false; store.showAccount() }
        }) {
            NativeAmbassadorView(store: store) {
                signInAfterAmbassadors = true
                store.ambassadorsPresented = false
            }
        }
        .alert("Analysis did not finish", isPresented: Binding(get: { !store.reviewPresented && store.analysisFailure != nil }, set: { if !$0 { store.analysisFailure = nil } })) {
            if let barcode = store.missingProductBarcode {
                Button("Add this product") { store.openProductContribution(barcode: barcode) }
            }
            Button("Return to photos") { store.capture.resume() }
            Button("Close", role: .cancel) { store.analysisFailure = nil }
        } message: { Text(store.analysisFailure ?? "Your photos are still available.") }
        .onChange(of: store.selectedTab) { value in
            if value == "camera" { store.selectedTab = "today"; store.startCamera() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("native-app-shell")
    }
    private var header: some View {
        HStack {
            Button { store.navigate("today") } label: {
                HStack(spacing: 6) {
                    Text("nudge").font(.system(.title, design: .default).weight(.heavy)).kerning(-1.5)
                    NudgeBrandMark()
                }.foregroundStyle(Color(uiColor: NudgeTheme.accent)).frame(minHeight: 48).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Nudge home")
            Spacer()
            if store.presentationRoute == nil {
                Button(action: store.showAmbassadors) {
                    Image(systemName: "trophy").font(.title3).frame(width: 48, height: 48).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Ambassador leaderboard and my status")
                    .accessibilityIdentifier("native-header-ambassadors")
                Button { _ = store.perform("showSaved") } label: { Label("Saved", systemImage: "heart").frame(minHeight: 48).padding(.horizontal, 8).contentShape(Rectangle()) }
                    .font(.subheadline.weight(.semibold)).accessibilityIdentifier("native-header-saved")
            }
            if store.presentationRoute != nil {
                Button { store.dismissReview() } label: { Image(systemName:"xmark").font(.title3).frame(width:52,height:52).contentShape(Rectangle()) }
                    .buttonStyle(.plain).accessibilityLabel("Close screen").accessibilityIdentifier("native-close-screen")
            }
        }.padding(.horizontal,20).padding(.vertical,10).frame(maxWidth:600).frame(maxWidth:.infinity)
    }
    @ViewBuilder private var content: some View {
        switch store.presentationRoute {
        case "diary": NativeDiaryView(store: store)
        case "foodLibrary": NativeFoodLibraryView(store: store)
        case "saved": NativeMyFoodsView(store: store)
        case "cycle": NativeCycleView(store: store)
        case "profile": NativeProfileView(store: store)
        case "settings": NativeSettingsView(store: store)
        case "recipes": NativeRecipeLibraryView(store: store)
        case "recipe": NativeRecipeView(store: store, id: store.recipeID ?? "")
        default:
            switch store.selectedTab {
            case "history": NativeHistoryView(store: store)
            case "you": NativeProfileView(store: store)
            default: NativeTodayView(store: store)
            }
        }
    }
    private var loading: some View {
        VStack(spacing: 20) {
            ProgressView().scaleEffect(1.3)
            Text("Looking at your food").font(.title2.bold())
            Text("Your diary changes only when you confirm what you ate.")
                .multilineTextAlignment(.center).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Button("Cancel") { store.cancelLoading() }.buttonStyle(NudgeButtonStyle(variant: .secondary))
        }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: NudgeTheme.canvas)).accessibilityIdentifier("native-analysis-loading")
    }
}

/// All Add food entry points preserve the selected diary day and meal.
@MainActor
struct NativeAddFoodChooser: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("What’s on the menu?").font(.largeTitle.bold())
                    Text("Choose how to add your food.").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    source("Camera", detail: "Scan a barcode or photograph your food", symbol: "camera", key: "camera")
                    source("Favourites", detail: "Pick something you’ve saved", symbol: "heart", key: "favourites")
                    source("History", detail: "Have something again", symbol: "clock.arrow.circlepath", key: "history")
                }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
            }.background(Color(uiColor: NudgeTheme.canvas))
                .navigationTitle("Add food").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }.tint(Color(uiColor: NudgeTheme.accent)).accessibilityIdentifier("native-add-food-chooser")
    }
    private func source(_ title: String, detail: String, symbol: String, key: String) -> some View {
        Button { store.chooseAddFood(key) } label: {
            HStack(spacing: 16) {
                Image(systemName: symbol).font(.title2).frame(width: 34)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.title3.bold())
                    Text(detail).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
            }.frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        }.buttonStyle(NudgeButtonStyle(variant: .secondary)).accessibilityIdentifier("native-add-food-" + key)
    }
}

/// Reuses the archive and My foods stores; choosing a recent eaten item creates
/// a fresh review, while the original consumption remains untouched.
@MainActor
private struct NativeFoodLibraryView: View {
    @ObservedObject var store: NativeAppStore
    @State private var query = ""
    private var favourites: Bool { store.foodLibraryMode == "favourites" }
    private var items: [[String: Any]] {
        let values = favourites ? NativeTrackingDisplay.rows(store.foods["foods"]) : NativeTrackingDisplay.rows(store.project("history", ["presentation":true,"deferScores":true])["rows"])
        return values.filter {
            (favourites || $0["canReuse"] as? Bool == true) &&
            (query.isEmpty || ($0["name"] as? String ?? "").localizedCaseInsensitiveContains(query))
        }
    }
    var body: some View {
        let visibleItems = NativeTrackingDisplay.identifiedRows(items)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                Text(favourites ? "Favourites" : "History").font(.largeTitle.bold())
                Text(favourites ? "Your saved My foods. Choose one to review its portion." : "Choose a previous food or scan to review before logging.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                Picker("Food source", selection: Binding(get: { store.foodLibraryMode }, set: {
                    store.showFoodLibrary(mode: $0, day: store.loggingDay, meal: store.loggingMeal)
                })) {
                    Text("History").tag("recents"); Text("Favourites").tag("favourites")
                }.pickerStyle(.segmented)
                TextField("Find a food", text: $query).textFieldStyle(.roundedBorder)
                if visibleItems.isEmpty { Text(favourites ? "Save a food from its review to find it here." : "Your scans and logged meals will appear here.").foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
                ForEach(visibleItems) { identified in
                    let item = identified.value
                    Button { if favourites { store.openSaved(item) } else { store.openRecent(item) } } label: {
                        HStack(spacing: 14) {
                            NativeStoredFoodImage(source: NativeTrackingDisplay.imageSource(item), barcode: NativeTrackingDisplay.imageBarcode(item), maximumPixelSize: 256)
                                .frame(width: 64, height: 70).clipShape(RoundedRectangle(cornerRadius: 12))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(item["name"] as? String ?? "Food").font(.headline)
                                Text(favourites ? "Saved food" : item["entry"] is [String: Any] ? "Previously eaten" : "Ready to log")
                                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }
                            Spacer(minLength: 0); Image(systemName: "chevron.right")
                        }.padding(14).background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                    }.buttonStyle(.plain)
                }
                Button("Camera") { store.startCamera(day: store.loggingDay, meal: store.loggingMeal) }
                    .buttonStyle(NudgeButtonStyle())
                Button("Back to diary") { store.openDiary(day: store.loggingDay) }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary))
            }.padding(20).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }.accessibilityIdentifier("native-food-library")
    }
}

struct NativeAppTabBar: View {
    let selected: String
    let navigate: (String) -> Void
    var analysisCount: Int = 0
    private let tabs = [("today","Today","house"),("history","History","clock.arrow.circlepath"),("camera","Camera","plus"),("search","Search","magnifyingglass"),("you","You","person")]
    var body: some View {
        HStack(alignment:.bottom,spacing:2) {
            ForEach(tabs,id:\.0) { id,title,symbol in
                Button { navigate(id) } label: {
                    VStack(spacing:6) {
                        if id == "camera" {
                            Image(systemName:symbol).font(.system(size:27)).foregroundStyle(Color(uiColor:NudgeTheme.primaryText))
                                .frame(width:47,height:47).background(Color(uiColor:NudgeTheme.primaryFill),in:Circle())
                        } else {
                            Image(systemName:symbol).font(.system(size:22,weight:id == selected ? .semibold:.regular)).frame(height:30)
                                .overlay(alignment: .topTrailing) {
                                    if id == "history" && analysisCount > 0 {
                                        Circle().fill(Color(uiColor: NudgeTheme.accent)).frame(width: 9, height: 9)
                                            .offset(x: 7, y: -2).accessibilityHidden(true)
                                    }
                                }
                        }
                        Text(title).font(.caption2.weight(id == selected || id == "camera" ? .semibold:.regular))
                    }.frame(maxWidth:.infinity,minHeight:64,alignment:.center)
                        .foregroundStyle(Color(uiColor:id == selected || id == "camera" ? NudgeTheme.accent:NudgeTheme.muted))
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(id == "history" && analysisCount > 0 ? "History, \(analysisCount) analyses in progress" : title).accessibilityIdentifier("native-tab-"+id)
                    .accessibilityAddTraits(id == selected ? .isSelected:[])
            }
        }.dynamicTypeSize(...DynamicTypeSize.xxLarge).padding(.horizontal,8).padding(.top,10).padding(.bottom,8)
            .frame(maxWidth:600).frame(maxWidth:.infinity)
            .background(Color(uiColor:NudgeTheme.surface).ignoresSafeArea(edges:.bottom))
            .overlay(alignment:.top) { Rectangle().fill(Color(uiColor:NudgeTheme.border)).frame(height:1) }
    }
}

@MainActor
struct NativeRecipeLibraryView: View {
    @ObservedObject var store: NativeAppStore
    @State private var savedOnly = false
    var body: some View {
        let all = store.project("recipes")["recipes"] as? [[String: Any]] ?? []
        let saved = (store.state["foodLog"] as? [String: Any])?["savedRecipes"] as? [String] ?? []
        let recipes = savedOnly ? all.filter { saved.contains($0["id"] as? String ?? "") } : all
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Recipe library").font(.largeTitle.bold())
                Text("Your existing Nudge meal ideas. Product search is in the Search tab.").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                Toggle("Saved recipes", isOn: $savedOnly).accessibilityIdentifier("native-recipes-saved-filter")
                if recipes.isEmpty { Text(savedOnly ? "Save a recipe to find it here." : "Your recipe library is empty.") }
                ForEach(recipes.indices, id: \.self) { index in
                    let item = recipes[index]
                    Button { _ = store.perform("openRecipe", ["id": item["id"] ?? ""]) } label: {
                        HStack(spacing: 14) {
                            NativeStoredFoodImage(source: NativeRecipeDisplay.image(item))
                                .frame(width: 75, height: 85).clipShape(RoundedRectangle(cornerRadius: 14))
                            VStack(alignment: .leading, spacing: 6) {
                                Text(item["name"] as? String ?? "Recipe").font(.headline)
                                Text(NativeRecipeDisplay.subtitle(item)).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                                if item["status"] as? String == "draft" { Text("Draft recipe").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.warningText)) }
                                if saved.contains(item["id"] as? String ?? "") { Label("Saved", systemImage: "heart.fill").font(.caption) }
                            }
                            Spacer(minLength: 0); Image(systemName: "chevron.right")
                        }.padding(14).background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                    }.buttonStyle(.plain).accessibilityIdentifier("native-recipe-card-" + (item["id"] as? String ?? ""))
                }
            }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
        }.accessibilityIdentifier("native-recipe-library")
    }
}

@MainActor
struct NativeRecipeView: View {
    @ObservedObject var store: NativeAppStore
    let id: String
    @State private var checked = Set<Int>()
    @State private var servings = 1
    @State private var tab = "intro"
    @State private var loadedID = ""
    @Environment(\.dynamicTypeSize) private var textSize
    private var recipe: [String: Any] { store.project("recipe", ["id": id, "servings": servings]) }
    private var saved: Bool {
        ((store.state["foodLog"] as? [String: Any])?["savedRecipes"] as? [String] ?? []).contains(id)
    }
    var body: some View {
        let r = recipe
        ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack {
                        Button { store.route = store.selectedTab == "search" ? nil : "recipes" } label: {
                            Label(store.selectedTab == "search" ? "Back to Search" : "Recipe library", systemImage: "chevron.left")
                                .frame(minHeight: 48).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Spacer(minLength: 8)
                        Button { _ = store.perform("recipeFavourite", ["id": id]) } label: { Label(saved ? "Saved" : "Save", systemImage: saved ? "heart.fill" : "heart") }
                            .frame(minHeight: 44).accessibilityAddTraits(saved ? [.isSelected] : [])
                            .accessibilityIdentifier("native-recipe-favourite")
                    }.id("recipe-top")
                    if r.isEmpty {
                        Text("This recipe is not available.").font(.title2.bold())
                        Text("Return to your recipe library and choose another meal idea.")
                    } else {
                        hero(r)
                        requirement(r)
                        rating(r)
                        nutrition(r, keys: Array(NativeRecipeDisplay.nutrients.prefix(5)))
                        recipeTabs
                        Group {
                            switch tab {
                            case "ingredients": ingredients(r)
                            case "steps": method(r)
                            default: intro(r)
                            }
                        }.id("recipe-information")
                        Button("I ate this · choose my amount") { _ = store.perform("recipeLog", ["id": id]) }
                            .buttonStyle(NudgeButtonStyle()).accessibilityIdentifier("native-recipe-log")
                        Text("Choose how much you ate before adding to intake. Saving a recipe or checking cooking steps does not log a meal.")
                            .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
            }
            .onChange(of: tab) { _ in withAnimation { scroll.scrollTo("recipe-information", anchor: .top) } }
            .onChange(of: id) { _ in reset(); scroll.scrollTo("recipe-top", anchor: .top) }
            .onAppear { if loadedID != id { reset() } }
        }.accessibilityIdentifier("native-recipe-detail")
    }
    private func reset() {
        let item = store.project("recipe", ["id": id])
        servings = min(12, max(1, (item["baseServings"] as? NSNumber)?.intValue ?? 1))
        checked = []; tab = "intro"; loadedID = id
    }
    private func hero(_ r: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if !NativeRecipeDisplay.image(r).isEmpty {
                NativeStoredFoodImage(source: NativeRecipeDisplay.image(r)).frame(height: 220).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 20))
            }
            Text(NativeRecipeDisplay.subtitle(r)).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Text(r["name"] as? String ?? "Recipe").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            let source = r["source"] as? [String: Any] ?? [:]
            if let url = NativeRecipeDisplay.url(source["url"]) {
                Link(source["publisher"] as? String ?? "Recipe source", destination: url)
            } else { Text("Nudge original").font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
            let base = (r["baseServings"] as? NSNumber)?.intValue ?? 1
            Text("Makes \(base) \(base == 1 ? "serving" : "servings") · Prep \(NativeRecipeDisplay.number(r["prepMinutes"] ?? r["minutes"])) min · Cook \(r["cookMinutes"] is NSNumber ? NativeRecipeDisplay.number(r["cookMinutes"]) + " min" : "not included")")
                .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }
    }
    @ViewBuilder private func requirement(_ r: [String: Any]) -> some View {
        let safety = r["safety"] as? [String: Any] ?? [:]
        if safety["matches"] as? Bool == false {
            Text(safety["reason"] as? String ?? "Food requirement information is incomplete.")
                .font(.subheadline.weight(.semibold)).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(Color(uiColor: NudgeTheme.warningText))
                .background(Color(uiColor: NudgeTheme.warningSurface), in: RoundedRectangle(cornerRadius: 18))
        }
        DisclosureGroup("Ingredients & your requirements") {
            VStack(alignment: .leading, spacing: 10) {
                Text(r["allergens"] as? String ?? "Check the ingredient labels for your food requirements.")
                Text("Check ingredient labels, substitutions and preparation. This recipe cannot establish allergy safety.")
            }.padding(.top, 10).font(.subheadline)
        }
    }
    private func rating(_ r: [String: Any]) -> some View {
        let score = r["score"] as? [String: Any] ?? [:]
        let available = score["available"] as? Bool == true
        return VStack(alignment: .leading, spacing: 6) {
            if available, let value = score["value"] as? NSNumber {
                Text("\(NativeRecipeDisplay.number(value))% Nudge rating").font(.title2.bold())
                Text(score["status"] as? String == "estimated_rough" ? "Rough estimate · limited nutrient information" : "Estimated from food composition")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            } else {
                Text(r["status"] as? String == "draft" ? "Rating pending · draft recipe" : "Nutrition rating unavailable").font(.headline)
                if let reason = score["reason"] as? String { Text(reason).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
            }
        }
    }
    private func nutrition(_ r: [String: Any], keys: [(String, String)]) -> some View {
        let nutrients = r["nutrients"] as? [String: [String: Any]] ?? [:]
        return recipePanel("Per standard serving") {
            ForEach(keys, id: \.0) { key, title in
                let row = nutrients[key] ?? [:]
                let layout = textSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                layout {
                    Text(title)
                    if !textSize.isAccessibilitySize { Spacer(minLength: 4) }
                    Text(row["value"] is NSNumber ? NativeRecipeDisplay.number(row["value"]) + " " + (row["unit"] as? String ?? (key == "energyKcal" ? "kcal" : "g")) : "Not available")
                        .fontWeight(.semibold).monospacedDigit()
                }.accessibilityElement(children: .combine).accessibilityIdentifier("native-recipe-nutrient-" + key)
                if !(row["value"] is NSNumber), let reason = row["missingReason"] as? String, !reason.isEmpty {
                    Text(reason).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
            }
            Text("Estimated · missing values are not zero. Cooking servings do not change these per-serving amounts.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }
    }
    private var recipeTabs: some View {
        let columns = textSize.isAccessibilitySize ? 1 : 3
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: columns), spacing: 8) {
            ForEach([("intro", "Intro"), ("ingredients", "Ingredients"), ("steps", "Steps")], id: \.0) { id, title in
                Button { tab = id } label: {
                    Text(title).font(.headline).frame(maxWidth: .infinity, minHeight: 48)
                        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                        .background(Color(uiColor: tab == id ? NudgeTheme.selectedSurface : NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(uiColor: tab == id ? NudgeTheme.accent : NudgeTheme.border), lineWidth: tab == id ? 2 : 1))
                }.buttonStyle(.plain).accessibilityAddTraits(tab == id ? [.isSelected] : []).accessibilityIdentifier("native-recipe-tab-" + id)
            }
        }
    }
    private var servingControl: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Cooking servings").font(.title3.bold())
            HStack(spacing: 18) {
                Button { servings -= 1 } label: { Image(systemName: "minus").frame(width: 48, height: 48) }
                    .disabled(servings <= 1).accessibilityLabel("Decrease recipe servings by one")
                Text("\(servings) \(servings == 1 ? "serving" : "servings")").font(.headline).frame(maxWidth: .infinity)
                    .accessibilityIdentifier("native-recipe-servings")
                Button { servings += 1 } label: { Image(systemName: "plus").frame(width: 48, height: 48) }
                    .disabled(servings >= 12).accessibilityLabel("Increase recipe servings by one")
            }.background(Color(uiColor: NudgeTheme.selectedSurface), in: RoundedRectangle(cornerRadius: 16))
        }
    }
    private func ingredients(_ r: [String: Any]) -> some View {
        let ingredients = r["ingredients"] as? [[Any]] ?? []
        let records = r["ingredientRecords"] as? [[String: Any]] ?? []
        return recipePanel("Ingredients") {
            servingControl
            Text("Amounts for \(servings) \(servings == 1 ? "serving" : "servings"). Nutrition describes one standard serving.").font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            ForEach(ingredients.indices, id: \.self) { index in
                let ingredient = ingredients[index]
                if ingredient.count >= 3 {
                    let amount = (ingredient[0] as? NSNumber)?.doubleValue
                    VStack(alignment: .leading, spacing: 6) {
                        Text(ingredient[2] as? String ?? "Ingredient").font(.headline)
                        Text((amount.map { NativeRecipeDisplay.number($0 * Double(servings)) } ?? "Unknown") + " " + (ingredient[1] as? String ?? ""))
                        if index < records.count, let state = records[index]["state"] as? String, !state.isEmpty {
                            Text(state).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        }
                    }.padding(.vertical, 5)
                    if index < ingredients.count - 1 { Divider() }
                }
            }
        }
    }
    private func method(_ r: [String: Any]) -> some View {
        let steps = r["steps"] as? [String] ?? r["method"] as? [String] ?? []
        return recipePanel("Steps") {
            servingControl
            ForEach(steps.indices, id: \.self) { index in
                Button {
                    if checked.contains(index) { checked.remove(index) } else { checked.insert(index) }
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: checked.contains(index) ? "checkmark.circle.fill" : "circle").font(.title3)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Step \(index + 1)").font(.headline)
                            Text(steps[index]).multilineTextAlignment(.leading)
                        }
                    }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.vertical, 8)
                }.buttonStyle(.plain).accessibilityAddTraits(checked.contains(index) ? [.isSelected] : [])
            }
            Text("Cooking and checking steps do not add food to your diary.").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }
    }
    private func intro(_ r: [String: Any]) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(r["why"] as? String ?? "")
            let tags = r["dietaryTags"] as? [String] ?? []
            if !tags.isEmpty { Text(tags.joined(separator: " · ")).foregroundStyle(Color(uiColor: NudgeTheme.plantText)) }
            DisclosureGroup("More nutrition and estimates") {
                VStack(alignment: .leading, spacing: 12) {
                    nutrition(r, keys: Array(NativeRecipeDisplay.nutrients.suffix(5)))
                    ForEach(r["nutritionNotes"] as? [String] ?? [], id: \.self) { Text($0).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
                    Link("UK CoFID source", destination: URL(string: "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid")!)
                    if id == "berry" { Link("USDA chia source", destination: URL(string: "https://fdc.nal.usda.gov/food-details/170554/nutrients")!) }
                }.padding(.top, 12)
            }
            let plants = r["plants"] as? [String] ?? []
            DisclosureGroup("Plant ingredients · \(plants.count)") {
                VStack(alignment: .leading, spacing: 10) {
                    Text(plants.joined(separator: ", "))
                    Text("Repeated plants count once across your recorded week.").font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }.padding(.top, 12)
            }
            DisclosureGroup("Food support · nutrient contribution") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Iron and calcium amounts, where available, are shown in the nutrition details. These are general nutrient contributions. A phase or life-stage filter does not change the recipe’s nutrition rating or prove a hormonal benefit.")
                    Link("Iron guidance", destination: URL(string: "https://www.nhs.uk/conditions/vitamins-and-minerals/iron/")!)
                    Link("Calcium guidance", destination: URL(string: "https://www.nhs.uk/conditions/vitamins-and-minerals/calcium/")!)
                }.font(.subheadline).padding(.top, 12)
            }
            DisclosureGroup("Source and recipe status") {
                VStack(alignment: .leading, spacing: 12) {
                    Text(r["status"] as? String == "draft" ? "Supplied original draft. Not kitchen-tested or independently reviewed. Its reference-only photograph has not been imported." : "Original Nudge recipe idea. Generic nutrition estimates do not mean the recipe has been kitchen-tested or professionally reviewed.")
                    Text("Recipe version \(NativeRecipeDisplay.number(r["version"]))")
                    if id == "salmon" { Text("Ten minutes is assembly time; cooking is additional.") }
                    Text("Contains public sector information licensed under the Open Government Licence v3.0.")
                    Link("Open Government Licence v3.0", destination: URL(string: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/")!)
                }.font(.subheadline).padding(.top, 12)
            }
        }
    }
    private func recipePanel<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.title3.bold()).accessibilityAddTraits(.isHeader)
            content()
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color(uiColor: NudgeTheme.border)))
    }
}

private enum NativeRecipeDisplay {
    static let nutrients = [("energyKcal", "Energy"), ("protein", "Protein"), ("carbohydrate", "Carbs"), ("fat", "Fat"), ("fibre", "Fibre"), ("saturatedFat", "Saturated fat"), ("sugars", "Sugars"), ("salt", "Salt"), ("iron", "Iron"), ("calcium", "Calcium")]
    static func number(_ value: Any?) -> String {
        guard let number = value as? NSNumber, number.doubleValue.isFinite else { return "—" }
        return number.doubleValue.formatted(.number.precision(.fractionLength(0...2)))
    }
    static func image(_ recipe: [String: Any]) -> String {
        guard let name = recipe["image"] as? String, !name.isEmpty, !name.contains("..") else { return "" }
        return "/assets/" + name
    }
    static func subtitle(_ recipe: [String: Any]) -> String {
        recipe["timeNote"] as? String ?? number(recipe["minutes"]) + " minutes"
    }
    static func url(_ raw: Any?) -> URL? {
        guard let raw = raw as? String, let url = URL(string: raw), url.scheme == "https", url.host != nil else { return nil }
        return url
    }
}
