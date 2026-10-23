import SwiftUI
import UIKit
import CoreFoundation
import ImageIO
import CryptoKit

/// Native presentation of the existing diary projections. Nutrient totals and
/// dated targets are supplied by the shared domain core, never re-estimated here.
struct NativeTodayView: View {
    @ObservedObject var store: NativeAppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var currentDay = NativeTrackingDisplay.dayKey(Date())
    @State private var targetSection: ProfileSection?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let model = store.project("today", ["presentation": true])
        let selectedDay = model["day"] as? String ?? currentDay
        let weeklyMetrics = NativeTrackingDisplay.rows(model["weeklyMetrics"])
        let cycleEnabled = NativeTrackingDisplay.object(store.state["cycleSupport"])["enabled"] as? Bool == true
        let cycle = cycleEnabled ? NativeTrackingDisplay.object(store.project("cycle")["context"]) : [:]
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if cycleEnabled {
                    Button(action: store.showCycle) {
                        HStack(spacing: 12) {
                            Image(systemName: "circle.dotted.circle").font(.title2)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(cycle["estimated"] as? Bool == true ? "Cycle support · Estimated " + (cycle["name"] as? String ?? "phase").lowercased() : "Cycle support").font(.headline)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                        }
                        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                        .padding(.vertical, 8)
                        .frame(minHeight: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain).trackingControl("today-cycle")
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text(NativeTrackingDisplay.dateLabel(selectedDay, format: "EEEE d MMMM").uppercased())
                        .font(.caption.weight(.semibold)).tracking(1.2)
                        .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    HStack(alignment: .center, spacing: 12) {
                        Text("Today").font(.largeTitle.bold())
                        Spacer(minLength: 0)
                        Button { store.openDiary(day: selectedDay) } label: {
                            Label("Diary", systemImage: "calendar").font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 14).frame(minHeight: 48)
                                .background(Color(uiColor: NudgeTheme.selectedSurface), in: Capsule())
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).foregroundStyle(Color(uiColor: NudgeTheme.accent))
                            .trackingControl("today-diary")
                    }
                }
                if !NativeTrackingDisplay.rows(model["compactMetrics"]).isEmpty {
                    NativeCompactNutritionPanel(items: NativeTrackingDisplay.rows(model["compactMetrics"]),
                                                fatSources: NativeTrackingDisplay.object(model["fatSources"]))
                } else {
                    NativeTrackingCard {
                        Text("Set your targets").font(.title3.bold())
                        Button("My profile", action: store.showProfile).buttonStyle(NudgeButtonStyle())
                    }
                }
                if let setup = model["targetSetup"] as? [String: Any],
                   let section = ProfileSection(rawValue: setup["section"] as? String ?? "") {
                    Button { targetSection = section } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "slider.horizontal.3")
                            VStack(alignment: .leading, spacing: 4) {
                                Text(setup["title"] as? String ?? "Review your targets").font(.subheadline.weight(.semibold))
                                Text(setup["detail"] as? String ?? "").font(.caption)
                                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }.fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                        }.frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).trackingControl("today-target-setup")
                } else {
                    HStack(alignment: .center) {
                        Spacer(minLength: 10)
                        Button { targetSection = .tracking } label: {
                            Label("Targets", systemImage: "slider.horizontal.3").font(.subheadline.weight(.semibold))
                                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                            .trackingControl("today-targets")
                    }
                }
                if selectedDay == NativeTrackingDisplay.dayKey(Date()) { budgetNotice(NativeTrackingDisplay.object(model["budget"])) }
                NativeDailyFoodList(store: store, day: selectedDay)
                Button(action: store.showAmbassadors) {
                    HStack(spacing: 12) {
                        Image(systemName: "trophy.fill").font(.title2)
                        Text("The helpful bunch").font(.headline)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                    }
                }.buttonStyle(NudgeButtonStyle(variant: .secondary)).trackingControl("today-ambassadors")
                if !weeklyMetrics.isEmpty {
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(weekLabel(model)).font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            ForEach(weeklyMetrics.indices, id: \.self) { index in weeklyCard(weeklyMetrics[index], model: model) }
                        }.padding(.top, 12)
                    } label: {
                        Label("This week", systemImage: "chart.bar.fill").font(.title3.bold())
                    }.tint(Color(uiColor: NudgeTheme.accent)).trackingControl("today-week-details")
                }
                Button("Add from My foods") { _ = store.perform("showSaved") }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary))
                    .trackingControl("today-my-foods")
            }
            .padding(20).frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: NudgeTheme.canvas))
        .foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .tint(Color(uiColor: NudgeTheme.accent))
        .trackingControl("native-today")
        .sheet(item: $targetSection) { NativeProfileEditor(store: store, section: $0) }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in currentDay = NativeTrackingDisplay.dayKey(Date()) }
        .onChange(of: scenePhase) { phase in if phase == .active { currentDay = NativeTrackingDisplay.dayKey(Date()) } }
    }

    private func weeklyCard(_ metric: [String: Any], model: [String: Any]) -> some View {
        let key = metric["key"] as? String ?? ""
        let isPlants = key == "plants"
        let weeklyKey = isPlants ? "weekPlantProgress" : "week" + key.prefix(1).uppercased() + key.dropFirst()
        let week = NativeTrackingDisplay.object(model[weeklyKey])
        let comparison = NativeTrackingDisplay.object(week["comparison"])
        let logged = NativeTrackingDisplay.number(isPlants ? week["loggedDays"] : comparison["days"]) ?? 0
        let value = isPlants || logged == 0 ? week["value"] : comparison["intake"]
        let target = isPlants ? model["weekTarget"] : comparison["target"]
        let item: [String: Any] = ["key": key, "title": NativeTrackingDisplay.title(metric), "unit": metric["unit"] ?? "", "value": value ?? NSNull(), "target": target ?? NSNull(), "recorded": (NativeTrackingDisplay.number(week["loggedDays"]) ?? 0) > 0, "unknown": week["unknown"] ?? 0, "targetRole": metric["targetRole"] ?? "goal", "referenceKind": metric["referenceKind"] ?? NSNull()]
        let days = NativeTrackingDisplay.rows(week["days"])
        return NativeTrackingCard {
            Text(NativeTrackingDisplay.title(metric) + (isPlants ? " · different types" : "")).font(.headline)
            HStack(alignment: .center, spacing: 20) {
                ZStack {
                    NativeNutritionRings(items: [item])
                    Text(NativeTrackingDisplay.ringLabel(item)).font(.headline).minimumScaleFactor(0.7).lineLimit(1).padding(15)
                }.frame(width: typeSize.isAccessibilitySize ? 80 : 110, height: typeSize.isAccessibilitySize ? 80 : 110)
                VStack(alignment: .leading, spacing: 6) {
                    Text((NativeTrackingDisplay.number(week["value"]).map { NativeTrackingDisplay.numberLabel($0, digits: isPlants || key == "energy" ? 0 : 1) } ?? "—") + " " + (isPlants ? "types" : metric["unit"] as? String ?? ""))
                        .font(.title2.bold()).monospacedDigit()
                    Text(NativeTrackingDisplay.number(week["unknown"]) ?? 0 > 0 ? "Known total · partial" : "Logged this week").font(.caption)
                    if isPlants {
                        if let amount = NativeTrackingDisplay.number(model["weekTarget"]) { Text("Target: \(NativeTrackingDisplay.numberLabel(amount)) different plants").font(.caption) }
                    } else if logged > 0 {
                        Text((NativeTrackingDisplay.targetRoleLabel(item).map { $0 + ": " } ?? "") + "\(NativeTrackingDisplay.numberLabel(NativeTrackingDisplay.number(comparison["intake"]) ?? 0, digits: key == "energy" ? 0 : 1)) / \(NativeTrackingDisplay.numberLabel(NativeTrackingDisplay.number(comparison["target"]) ?? 0, digits: key == "energy" ? 0 : 1)) \(metric["unit"] as? String ?? "") on \(Int(logged)) logged day\(logged == 1 ? "" : "s") with comparisons")
                            .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    } else { Text(["sugars", "saturatedFat"].contains(key) ? "No reference amount set" : "No saved target comparison").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
                    if NativeTrackingDisplay.isConsumptionReference(item), let note = NativeTrackingDisplay.note(item) {
                        Text(note).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    if week["estimated"] as? Bool == true { Text("Includes estimates").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 48), spacing: 7)], spacing: 10) {
                ForEach(days.indices, id: \.self) { index in
                    let day = days[index]
                    let date = day["day"] as? String ?? ""
                    let dailyItem = day.merging(["key": key, "title": metric["title"] ?? "", "unit": metric["unit"] ?? ""], uniquingKeysWith: { _, new in new })
                    Button { store.openDiary(day: date) } label: {
                        VStack(spacing: 4) {
                            ZStack {
                                NativeNutritionRings(items: [dailyItem])
                                if NativeTrackingDisplay.ratio(dailyItem) == nil {
                                    Text(NativeTrackingDisplay.ringLabel(dailyItem)).font(.caption2.weight(.semibold))
                                        .minimumScaleFactor(0.6).lineLimit(1).padding(7)
                                }
                            }.aspectRatio(1, contentMode: .fit)
                            Text(day["label"] as? String ?? "").font(.caption)
                        }.frame(minWidth: 48, maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(day["future"] as? Bool == true)
                        .opacity(day["future"] as? Bool == true ? 0.35 : 1)
                        .accessibilityLabel(NativeTrackingDisplay.dateLabel(date, format: "EEEE d MMMM") + ". " + NativeTrackingDisplay.description(dailyItem))
                }
            }
        }.accessibilityIdentifier("weekly-metric-\(key)")
    }

    @ViewBuilder private func budgetNotice(_ budget: [String: Any]) -> some View {
        if let status = budget["state"] as? String, ["over", "under"].contains(status) {
            Button(action: store.showProfile) {
                Label("Check your targets", systemImage: "exclamationmark.triangle")
                    .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .padding(.horizontal, 16).background(Color(uiColor: NudgeTheme.warningSurface), in: RoundedRectangle(cornerRadius: 18))
            }.buttonStyle(.plain).foregroundStyle(Color(uiColor: NudgeTheme.warningText))
                .accessibilityLabel("Check your targets. Macro targets total \(NativeTrackingDisplay.numberLabel(NativeTrackingDisplay.number(budget["macroKcal"]) ?? 0, digits: 0)) kilocalories against \(NativeTrackingDisplay.numberLabel(NativeTrackingDisplay.number(budget["energyKcal"]) ?? 0, digits: 0)) kilocalories.")
        }
    }

    private func weekLabel(_ model: [String: Any]) -> String {
        let range = NativeTrackingDisplay.object(model["dateRange"])
        guard let start = range["start"] as? String, let end = range["end"] as? String else { return "This week" }
        return NativeTrackingDisplay.dateLabel(start, format: "d MMM") + "–" + NativeTrackingDisplay.dateLabel(end, format: "d MMM")
    }

}

/// The complete nutrition summary uses domain-supplied amounts and targets.
/// The ring stroke is bounded; its text always retains the actual percentage.
struct NativeCompactNutritionPanel: View {
    let items: [[String: Any]]
    var dayPlants: Double? = nil
    var fatSources: [String: Any] = [:]
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NativeTrackingCard(spacing: 14, padding: 14) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: typeSize.isAccessibilitySize ? 1 : 3), spacing: 18) {
                ForEach(items.indices, id: \.self) { index in
                    let item = items[index]
                    let amountOnly = !NativeTrackingDisplay.hasTarget(item)
                    let recordedAmount = NativeTrackingDisplay.hasLoggedAmount(item)
                    VStack(spacing: 6) {
                        ZStack {
                            // A saved amount without a denominator is active, but
                            // must never look like invented percentage completion.
                            if amountOnly && recordedAmount {
                                Circle().fill(NativeTrackingDisplay.color(item).opacity(0.12))
                            }
                            Circle().stroke(NativeTrackingDisplay.color(item).opacity(amountOnly && recordedAmount ? 0.5 : 0.17), lineWidth: 6)
                            if let ratio = NativeTrackingDisplay.ratio(item), ratio > 0 {
                                Circle().trim(from: 0, to: min(1, ratio))
                                    .stroke(NativeTrackingDisplay.color(item), style: StrokeStyle(lineWidth: 6, lineCap: .round))
                                    .rotationEffect(.degrees(-90))
                            }
                            Text(NativeTrackingDisplay.ringLabel(item)).font(.caption.weight(.bold))
                                .monospacedDigit().minimumScaleFactor(0.65).lineLimit(1).padding(4)
                        }.frame(width: typeSize.isAccessibilitySize ? 84 : 60, height: typeSize.isAccessibilitySize ? 84 : 60)
                        Text(NativeTrackingDisplay.title(item) + (item["period"] as? String == "week" ? " · week" : ""))
                            .font(.caption.weight(.semibold)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        if !amountOnly {
                            Text(NativeTrackingDisplay.summaryAmount(item)).font(.caption2).monospacedDigit()
                                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        }
                    }.frame(maxWidth: .infinity).padding(.vertical, 3)
                        .accessibilityElement(children: .ignore).accessibilityLabel(NativeTrackingDisplay.description(item))
                        .trackingControl("nutrition-ring-\(item["key"] as? String ?? "unknown")")
                }
            }
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Coloured amounts are logged food. Arcs show the share of a saved target or reference; no arc is calculated without one. ≥ means some nutrition is missing.")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    ForEach(items.indices, id: \.self) { index in
                        let item = items[index]
                        VStack(alignment: .leading, spacing: 4) {
                            Text(NativeTrackingDisplay.title(item)).font(.caption.weight(.semibold))
                            Text(NativeTrackingDisplay.targetLabel(item)).font(.caption)
                            if let note = NativeTrackingDisplay.note(item) {
                                Text(note).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }
                            if item["estimated"] as? Bool == true {
                                Text("Includes estimates").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }
                        }
                    }
                    ForEach(referenceNotes, id: \.self) { Text($0).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
                    if items.contains(where: { $0["referenceKind"] as? String == "adult_label" }) {
                        Text("Adult food-label references: 90 g total sugars and 20 g saturated fat per day. These are comparisons, not goals to reach.").font(.caption)
                        Link("NHS: food-label reference intakes", destination: URL(string: "https://www.nhsinform.scot/healthy-living/food-and-nutrition/food-packaging/food-labelling/")!).font(.caption)
                    }
                    if !NativeTrackingDisplay.rows(fatSources["rows"]).isEmpty {
                        NativeFatSourcesPanel(model: fatSources)
                    }
                    if let dayPlants {
                        Text("\(NativeTrackingDisplay.numberLabel(dayPlants, digits: 0)) plant types today").font(.caption)
                    }
                }.padding(.top, 8)
            } label: {
                Label("Details", systemImage: "info.circle").font(.caption.weight(.semibold))
                    .frame(minHeight: 36)
            }.trackingControl("nutrition-details")
        }
    }

    private var referenceNotes: [String] {
        items.compactMap { $0["referenceNote"] as? String }.reduce(into: []) { notes, text in
            if !notes.contains(text) { notes.append(text) }
        }
    }
}

/// Food context sits alongside the measured totals; it never reclassifies grams.
struct NativeFatSourcesPanel: View {
    let model: [String: Any]

    var body: some View {
        DisclosureGroup("Fat sources") {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(NativeTrackingDisplay.rows(model["rows"]).enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(row["name"] as? String ?? "Logged food").font(.subheadline.weight(.semibold))
                        if let context = row["context"] as? String, !context.isEmpty {
                            Text(context).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        }
                        Text("Fat: " + amount(row, key: "fat"))
                        Text("Saturated: " + amount(row, key: "saturatedFat"))
                    }.font(.caption).fixedSize(horizontal: false, vertical: true)
                        .accessibilityElement(children: .combine)
                }
                if let note = model["note"] as? String, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 12)
        }.font(.subheadline.weight(.semibold)).tint(Color(uiColor: NudgeTheme.accent))
            .trackingControl("nutrition-fat-sources")
    }

    private func amount(_ row: [String: Any], key: String) -> String {
        guard let value = NativeTrackingDisplay.number(row[key]) else { return "Unknown" }
        return NativeTrackingDisplay.numberLabel(value, digits: 1) + " g"
            + (row[key + "Partial"] as? Bool == true ? " · partial" : "")
            + (row[key + "Estimated"] as? Bool == true ? " · estimated" : "")
    }
}

struct NativeDiaryView: View {
    @ObservedObject var store: NativeAppStore
    @State private var calendarPresented = false
    @State private var pendingDelete: [String: Any]?
    @State private var deletePresented = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let day = store.diaryDay
        let model = store.project("diary", ["day": day, "presentation": true])
        let rows = NativeTrackingDisplay.rows(model["rows"])
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Button(action: store.closeDiary) {
                    Label("Back to Today", systemImage: "chevron.left")
                        .font(.subheadline.weight(.semibold)).frame(minHeight: 48).contentShape(Rectangle())
                }.buttonStyle(.plain).trackingControl("diary-back")
                Text("Your diary").font(.largeTitle.bold())
                dateControls(day)
                weekStrip(day)
                if day != NativeTrackingDisplay.dayKey(Date()) {
                    Button { store.openDiary(day: NativeTrackingDisplay.dayKey(Date())) } label: {
                        Text("Back to today").font(.subheadline.weight(.semibold))
                            .frame(minHeight: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain).trackingControl("diary-today")
                }
                NativeCompactNutritionPanel(items: NativeTrackingDisplay.rows(model["compactMetrics"]),
                                            dayPlants: nil, fatSources: NativeTrackingDisplay.object(model["fatSources"]))
                if let plants = NativeTrackingDisplay.number(model["dayPlants"]) {
                    Text("\(NativeTrackingDisplay.numberLabel(plants, digits: 0)) different plant types on this day")
                        .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                Text("Food you’ve logged").font(.title2.bold())
                loggedFoods(rows: rows, day: day)
            }.padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: NudgeTheme.canvas)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .tint(Color(uiColor: NudgeTheme.accent)).trackingControl("native-diary")
        .sheet(isPresented: $calendarPresented) {
            NavigationStack {
                DatePicker("Diary date", selection: Binding(get: { NativeTrackingDisplay.date(store.diaryDay) }, set: { store.openDiary(day: NativeTrackingDisplay.dayKey($0)) }), in: ...Date(), displayedComponents: .date)
                    .datePickerStyle(.wheel).labelsHidden().frame(maxWidth: .infinity)
                    .accessibilityLabel("Diary date")
                    .navigationTitle("Choose a date").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { calendarPresented = false } } }
            }.presentationDetents([.medium, .large]).tint(Color(uiColor: NudgeTheme.accent))
        }
        .confirmationDialog("Remove this logged food?", isPresented: $deletePresented, titleVisibility: .visible) {
            Button("Remove logged food", role: .destructive) {
                if let id = NativeTrackingDisplay.object(pendingDelete?["entry"])["id"] as? String {
                    _ = store.perform("diaryDelete", ["entryId": id])
                }
                pendingDelete = nil
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("This removes the food from \(NativeTrackingDisplay.dateLabel(day, format: "EEE d MMM")) and updates its daily totals and weekly plant variety. Its original scan stays in History.")
        }
    }

    private func dateControls(_ day: String) -> some View {
        HStack(spacing: 8) {
            Button { moveDay(-1) } label: { Image(systemName: "chevron.left").frame(width: 48, height: 48).contentShape(Rectangle()) }
                .accessibilityLabel("Previous day").trackingControl("diary-previous-day")
            Button { calendarPresented = true } label: {
                VStack(spacing: 6) {
                    Image(systemName: "calendar")
                    Text(NativeTrackingDisplay.dateLabel(day, format: "EEE d MMM yyyy"))
                        .font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }.padding(.vertical, 10).padding(.horizontal, 6).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
            }.accessibilityLabel("Diary date, " + NativeTrackingDisplay.dateLabel(day, format: "EEEE d MMMM yyyy"))
                .accessibilityHint("Opens the date picker").trackingControl("diary-date")
            Button { moveDay(1) } label: { Image(systemName: "chevron.right").frame(width: 48, height: 48).contentShape(Rectangle()) }
                .disabled(day >= NativeTrackingDisplay.dayKey(Date())).accessibilityLabel("Next day").trackingControl("diary-next-day")
        }.buttonStyle(NativeTrackingCalendarButtonStyle())
    }
    private func weekStrip(_ day: String) -> some View {
        let start = NativeTrackingDisplay.date(NativeTrackingDisplay.monday(NativeTrackingDisplay.date(day)))
        return ViewThatFits(in: .horizontal) {
            if !typeSize.isAccessibilitySize {
                HStack(spacing: 3) { weekButtons(day, start: start) }.fixedSize(horizontal: true, vertical: false)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: typeSize.isAccessibilitySize ? 3 : 4), spacing: 8) {
                weekButtons(day, start: start)
            }
        }
    }
    @ViewBuilder private func weekButtons(_ day: String, start: Date) -> some View {
            ForEach(0..<7, id: \.self) { offset in
                let date = NativeTrackingDisplay.calendar.date(byAdding: .day, value: offset, to: start) ?? start
                let key = NativeTrackingDisplay.dayKey(date)
                let selected = key == day
                Button { store.openDiary(day: key) } label: {
                    VStack(spacing: 6) {
                        Text(NativeTrackingDisplay.dateLabel(key, format: "EEEEE")).font(.caption)
                        Text(NativeTrackingDisplay.dateLabel(key, format: "d")).font(.subheadline.weight(.semibold))
                    }.frame(minWidth: 48, maxWidth: .infinity, minHeight: typeSize.isAccessibilitySize ? 88 : 58)
                        .contentShape(Rectangle())
                        .background(selected ? Color(uiColor: NudgeTheme.accent) : Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(selected ? Color(uiColor: NudgeTheme.canvas) : Color(uiColor: NudgeTheme.ink))
                }.buttonStyle(.plain).disabled(key > NativeTrackingDisplay.dayKey(Date()))
                    .opacity(key > NativeTrackingDisplay.dayKey(Date()) ? 0.4 : 1)
                    .accessibilityLabel(NativeTrackingDisplay.dateLabel(key, format: "EEEE d MMMM"))
                    .accessibilityAddTraits(selected ? .isSelected : []).trackingControl("diary-day-\(key)")
            }
    }
    private func loggedFoods(rows: [[String: Any]], day: String) -> some View {
        let identified = NativeTrackingDisplay.identifiedRows(rows)
        return NativeTrackingCard(spacing: 14, padding: 16) {
            ForEach(identified) { item in
                let row = item.value
                VStack(alignment: .leading, spacing: 8) {
                    Button { store.openEntry(NativeTrackingDisplay.object(row["entry"])) } label: { NativeHistoryRow(row: row) }
                        .buttonStyle(.plain).trackingControl("diary-entry-\(NativeTrackingDisplay.object(row["entry"])["id"] as? String ?? "unknown")")
                    HStack(spacing: 18) {
                        Button { store.openEntry(NativeTrackingDisplay.object(row["entry"])) } label: {
                            Text("Edit").padding(.horizontal, 12).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        Button(role: .destructive) { pendingDelete = row; deletePresented = true } label: {
                            Text("Remove").padding(.horizontal, 12).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                    }.font(.subheadline.weight(.semibold)).buttonStyle(.plain)
                    if item.id != identified.last?.id { Divider() }
                }
            }
            if rows.isEmpty { Text("Nothing logged yet").font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
            NativeAddFoodActions(store: store, day: day, meal: nil)
        }
    }
    private func moveDay(_ offset: Int) {
        let date = NativeTrackingDisplay.calendar.date(byAdding: .day, value: offset, to: NativeTrackingDisplay.date(store.diaryDay)) ?? Date()
        store.openDiary(day: min(NativeTrackingDisplay.dayKey(date), NativeTrackingDisplay.dayKey(Date())))
    }
}

private struct NativeDailyFoodList: View {
    @ObservedObject var store: NativeAppStore
    let day: String
    @State private var revealedID: String?
    var body: some View {
        let rows = NativeTrackingDisplay.rows(store.project("diary", ["day": day, "presentation": true])["rows"])
        let identified = NativeTrackingDisplay.identifiedRows(rows)
        let pending = NativeTrackingDisplay.rows(store.project("pendingEaten", ["day": day, "ownerKey": NudgeAccountManager.shared.captureOwnerKey ?? ""])["rows"])
        NativeTrackingCard {
            Text("Today’s food").font(.title2.bold())
            ForEach(identified) { item in
                let row = item.value
                let entry = NativeTrackingDisplay.object(row["entry"])
                let entryID = entry["id"] as? String ?? ""
                swipeRow(id: item.id, name: entry["name"] as? String ?? "food", delete: {
                    if store.perform("diaryRemove", ["entryId": entryID]) { revealedID = nil }
                }) {
                    Button {
                        if revealedID == item.id { revealedID = nil } else { store.openEntry(entry) }
                    } label: { NativeHistoryRow(row: row).padding(.vertical, 4) }
                        .buttonStyle(.plain)
                        .accessibilityAction(named: Text("Delete")) { _ = store.perform("diaryRemove", ["entryId": entryID]) }
                }
                if item.id != identified.last?.id || !pending.isEmpty { Divider() }
            }
            ForEach(NativeTrackingDisplay.identifiedRows(pending)) { item in
                let name = item.value["name"] as? String ?? "Your food"
                swipeRow(id: item.id, name: name, delete: { if store.capture.cancelAddToEaten(eventID: item.id) { revealedID = nil } }) {
                    Button {
                        if revealedID == item.id { revealedID = nil }
                        else if let row = store.project("historyItem", ["id": item.id])["row"] as? [String: Any] { store.openHistory(row) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "clock").font(.title2).frame(width: 56, height: 66)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(name).font(.headline)
                                Text(item.value["status"] as? String ?? "Analysing · will be added to eaten")
                                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(.vertical, 4).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityAction(named: Text("Delete")) { store.capture.cancelAddToEaten(eventID: item.id) }
                }
            }
            if rows.isEmpty && pending.isEmpty { Text("Log food to see your daily nutrition.").foregroundStyle(Color(uiColor: NudgeTheme.muted)) }
            NativeAddFoodActions(store: store, day: day, meal: nil)
        }
    }
    private func swipeRow<Content: View>(id: String, name: String, delete: @escaping () -> Void, @ViewBuilder content: () -> Content) -> some View {
        NativeFoodSwipeRow(content: AnyView(content().frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: NudgeTheme.surface))), name: name,
            revealed: revealedID == id, onReveal: { revealedID = $0 ? id : nil }, onDelete: delete)
            .frame(maxWidth: .infinity)
    }
}

/// A horizontal recognizer refuses vertical intent before beginning. Unlike
/// swipeActions on a ScrollView child, this works inside Today's native scroll;
/// a gesture only reveals the button and can never itself delete a food.
enum NativeFoodSwipePolicy {
    static let actionWidth: CGFloat = 92
    static func begins(velocity: CGPoint, revealed: Bool) -> Bool {
        abs(velocity.x) > max(8, abs(velocity.y) * 1.25) && (velocity.x < 0 || revealed)
    }
    static func reveals(offset: CGFloat, velocity: CGFloat) -> Bool {
        velocity < -450 || (velocity <= 450 && offset < -actionWidth / 2)
    }
}

private struct NativeFoodSwipeRow: UIViewControllerRepresentable {
    let content: AnyView
    let name: String
    let revealed: Bool
    let onReveal: (Bool) -> Void
    let onDelete: () -> Void
    func makeUIViewController(context: Context) -> NativeFoodSwipeController {
        NativeFoodSwipeController(content: content)
    }
    func updateUIViewController(_ controller: NativeFoodSwipeController, context: Context) {
        controller.host.rootView = content
        controller.deleteButton.accessibilityLabel = "Delete " + name
        controller.onReveal = onReveal; controller.onDelete = onDelete
        controller.setRevealed(revealed, animated: !UIAccessibility.isReduceMotionEnabled)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiViewController: NativeFoodSwipeController, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let height = uiViewController.host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: width, height: max(72, height))
    }
}

@MainActor
final class NativeFoodSwipeController: UIViewController, UIGestureRecognizerDelegate {
    let host: UIHostingController<AnyView>
    let deleteButton = UIButton(type: .system)
    var onReveal: (Bool) -> Void = { _ in }
    var onDelete: () -> Void = {}
    private(set) var revealed = false
    private var startOffset: CGFloat = 0
    private var dragging = false
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
    init(content: AnyView) { host = UIHostingController(rootView: content); super.init(nibName: nil, bundle: nil) }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear; view.clipsToBounds = true
        var configuration = UIButton.Configuration.filled()
        configuration.title = "Delete"; configuration.image = UIImage(systemName: "trash")
        configuration.imagePlacement = .top; configuration.imagePadding = 6
        configuration.baseBackgroundColor = .systemRed; configuration.baseForegroundColor = .white
        configuration.cornerStyle = .medium
        deleteButton.configuration = configuration
        deleteButton.accessibilityIdentifier = "today-delete-food"
        deleteButton.addTarget(self, action: #selector(deleteTapped), for: .touchUpInside)
        deleteButton.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(deleteButton)
        addChild(host); host.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.backgroundColor = .clear; host.sizingOptions = [.intrinsicContentSize]
        view.addSubview(host.view); host.didMove(toParent: self)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor), host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            deleteButton.trailingAnchor.constraint(equalTo: view.trailingAnchor), deleteButton.widthAnchor.constraint(equalToConstant: NativeFoodSwipePolicy.actionWidth - 8),
            deleteButton.topAnchor.constraint(equalTo: view.topAnchor, constant: 4), deleteButton.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -4)
        ])
        pan.delegate = self; host.view.addGestureRecognizer(pan)
        deleteButton.accessibilityElementsHidden = !revealed
    }
    func setRevealed(_ value: Bool, animated: Bool) {
        guard !dragging else { return }
        let changed = revealed != value; revealed = value
        loadViewIfNeeded(); deleteButton.accessibilityElementsHidden = !value
        let update = { self.host.view.transform = CGAffineTransform(translationX: value ? -NativeFoodSwipePolicy.actionWidth : 0, y: 0) }
        if changed && animated { UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: update) }
        else { update() }
    }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pan else { return true }
        return NativeFoodSwipePolicy.begins(velocity: pan.velocity(in: view), revealed: revealed)
    }
    @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            host.view.layer.removeAllAnimations(); dragging = true
            startOffset = revealed ? -NativeFoodSwipePolicy.actionWidth : 0
        case .changed:
            let offset = min(0, max(-NativeFoodSwipePolicy.actionWidth, startOffset + gesture.translation(in: view).x))
            host.view.transform = CGAffineTransform(translationX: offset, y: 0)
        case .ended, .cancelled, .failed:
            let next = gesture.state == .ended && NativeFoodSwipePolicy.reveals(offset: host.view.transform.tx, velocity: gesture.velocity(in: view).x)
            dragging = false; setRevealed(next, animated: !UIAccessibility.isReduceMotionEnabled); onReveal(next)
        default: break
        }
    }
    @objc private func deleteTapped() { guard revealed else { return }; onDelete() }
}

private struct NativeAddFoodActions: View {
    @ObservedObject var store: NativeAppStore
    let day: String
    let meal: String?
    var body: some View {
        Button { store.showAddFood(day: day, meal: meal?.capitalized) } label: { Label("Add food", systemImage: "plus") }
            .buttonStyle(NudgeButtonStyle()).trackingControl("add-food-\(meal ?? "today")")
    }
}

struct NativeHistoryDeletion {
    let id: String
    let title: String
    let message: String
    let buttonTitle: String
    let keepIntake: Bool

    init?(row: [String: Any], filter: String) {
        guard let id = row["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        let entry = row["entry"] as? [String: Any]
        let name = entry?["name"] as? String ?? row["name"] as? String ?? "This item"
        let deletesIntake = entry != nil && (filter == "eaten" || row["legacy"] as? Bool == true)
        keepIntake = !deletesIntake
        if deletesIntake {
            title = "Delete this logged food?"
            buttonTitle = "Delete logged food"
            let day = NativeTrackingDisplay.dateLabel(entry?["day"] as? String ?? "", format: "d MMMM")
            message = "This removes \(name) from intake on \(day) and updates your daily totals."
        } else {
            title = "Delete this scan?"
            buttonTitle = "Delete scan"
            message = entry != nil
                ? "This removes the scan of \(name). Its logged food and daily totals will stay."
                : "\(name) will be removed from History. Your intake will not change."
        }
    }
}

struct NativeHistoryView: View {
    @ObservedObject var store: NativeAppStore
    @State private var filter = "all"
    @State private var pendingDelete: NativeHistoryDeletion?
    @State private var deletePresented = false
    @State private var alternativesSelection: NativeHistoryAlternativesSelection?
    @State private var alternativeToOpen: [String: Any]?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let projection = store.project("history", ["filter": filter, "presentation": true, "deferScores": true])
        let rows = NativeTrackingDisplay.rows(projection["rows"])
        let grouped = NativeTrackingDisplay.historyGroups(rows, filter: filter)
        let undo = NativeTrackingDisplay.object(projection["undo"])
        ScrollViewReader { historyScroll in
        List {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Text("Your history").font(.largeTitle.bold())
                    Spacer(minLength: 0)
                    historyActions(undo)
                }
                Text("Every product scan. Every meal.").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: 8) {
                    ForEach(["all", "scanned", "photos", "eaten"], id: \.self) { key in
                        Button { filter = key } label: {
                            Text(key.capitalized).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                                .background(filter == key ? Color(uiColor: NudgeTheme.accent) : Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(filter == key ? Color(uiColor: NudgeTheme.accent) : .clear, lineWidth: 2))
                        }.buttonStyle(.plain).foregroundStyle(filter == key ? Color(uiColor: NudgeTheme.canvas) : Color(uiColor: NudgeTheme.accent))
                            .accessibilityAddTraits(filter == key ? .isSelected : []).trackingControl("history-filter-\(key)")
                    }
                }.padding(.top, 10)
                if projection["storageError"] as? Bool == true {
                    Text("Recent history changes could not be saved. Keep Nudge open and try again.")
                        .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.errorText))
                    Button("Try saving history") { _ = store.perform("historyRetry") }
                        .buttonStyle(NudgeButtonStyle(variant: .secondary))
                }
            }.listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 20, leading: 20, bottom: 18, trailing: 20))
                .id("history-start")
            if rows.isEmpty {
                VStack(alignment: .leading, spacing: 16) {
                    Text(filter == "eaten" ? "No food added yet." : "Your history starts here.").font(.title2.bold())
                    Text(filter == "eaten" ? "Confirm what you eat to add it here and to your daily totals." : "Scans and photos appear here. Add food to today when you eat it.")
                        .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    Button(filter == "eaten" ? "Add food" : "Scan food") {
                        if filter == "eaten" { store.showAddFood() } else { store.startCamera() }
                    }
                        .buttonStyle(NudgeButtonStyle())
                }.padding(.vertical, 18).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(grouped) { group in
                Section {
                    ForEach(group.rows) { item in
                        let row = item.value
                        VStack(alignment: .leading, spacing: 8) {
                            Button { open(row) } label: {
                                NativeHistoryRow(row: row, analysisStage: store.capture.analysisStage(for: row["id"] as? String ?? ""), scoreRevision: store.historyScoreRevision,
                                                 scoreLoader: { store.project("historyScore", ["id": $0]) })
                            }
                                .buttonStyle(.plain).trackingControl("history-row-\(row["id"] as? String ?? "unknown")")
                            .contextMenu {
                                Button { open(row) } label: { Label("Open food", systemImage: "fork.knife") }
                                if ["pending", "failed", "unknown"].contains(row["status"] as? String ?? "") {
                                    Button { _ = store.capture.retryHistory(row) } label: { Label("Retry now", systemImage: "arrow.clockwise") }
                                        .accessibilityIdentifier("history-retry-\(row["id"] as? String ?? "unknown")")
                                }
                                if row["canFavourite"] as? Bool == true {
                                    Button { _ = store.perform("historyToggleFavourite", ["id": row["id"] ?? ""]) } label: {
                                        Label(row["isFavourite"] as? Bool == true ? "Remove from favourites" : "Add to favourites", systemImage: "heart")
                                    }
                                }
                                Button(role: .destructive) { requestDelete(row) } label: { Label("Delete", systemImage: "trash") }
                            }
                        HStack(spacing: 8) {
                        if row["kind"] as? String == "product" {
                            Button {
                                let saved = store.project("historyItem", ["id": row["id"] ?? ""])["row"] as? [String: Any] ?? row
                                alternativesSelection = NativeHistoryAlternativesSelection(row: saved)
                            } label: {
                                Label("Alternatives", systemImage: "arrow.left.arrow.right")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(minHeight: 44).contentShape(Rectangle())
                            }.buttonStyle(.borderless)
                                .trackingControl("history-alternatives-\(row["id"] as? String ?? "unknown")")
                        }
                            Spacer(minLength: 0)
                            if row["canFavourite"] as? Bool == true {
                                let favourite = row["isFavourite"] as? Bool == true
                                Button { _ = store.perform("historyToggleFavourite", ["id": row["id"] ?? ""]) } label: {
                                    Image(systemName: favourite ? "heart.fill" : "heart")
                                        .font(.system(size: 20, weight: .semibold))
                                        .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                                        .frame(width: 44, height: 44).contentShape(Rectangle())
                                }.buttonStyle(.borderless)
                                    .accessibilityLabel(favourite ? "Remove from favourites" : "Add to favourites")
                                    .accessibilityValue(row["name"] as? String ?? "Food")
                                    .trackingControl("history-favourite-\(row["id"] as? String ?? "unknown")")
                            }
                        }
                        }.padding(12)
                            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                            .listRowBackground(Color.clear)
                            .accessibilityElement(children: .contain)
                            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                            .listRowSeparator(.hidden)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) { requestDelete(row) } label: { Label("Delete", systemImage: "trash") }
                            }

                    }
                } header: {
                    HStack {
                        Text(groupTitle(group.day))
                        Spacer()
                        Text(NativeTrackingDisplay.dateLabel(group.day, format: "d MMMM"))
                    }.font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted)).textCase(nil)
                }
            }
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .background(Color(uiColor: NudgeTheme.canvas)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .tint(Color(uiColor: NudgeTheme.accent)).trackingControl("native-history")
        .onChange(of: store.analysisHistoryRevealRevision) { _ in
            filter = "all"
            historyScroll.scrollTo("history-start", anchor: .top)
        }
        .sheet(item: $alternativesSelection, onDismiss: {
            // Open the food sheet only after the comparison sheet has closed.
            guard let product = alternativeToOpen else { return }
            alternativeToOpen = nil
            store.openProductFacts(product)
        }) { selection in
            NativeHistoryAlternativesView(selection: selection, profile: store.state["nutritionProfile"] as? [String: Any] ?? [:],
                                          avoidMilk: store.state["avoidMilk"] as? Bool == true) { product in
                alternativeToOpen = product
                alternativesSelection = nil
            }
        }
        .confirmationDialog(pendingDelete?.title ?? "Delete item?", isPresented: $deletePresented, titleVisibility: .visible) {
            if let deletion = pendingDelete {
                Button(deletion.buttonTitle, role: .destructive) { delete(deletion) }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { Text(pendingDelete?.message ?? "") }
        }
    }

    private func requestDelete(_ row: [String: Any]) {
        pendingDelete = NativeHistoryDeletion(row: row, filter: filter)
        deletePresented = pendingDelete != nil
    }
    private func delete(_ deletion: NativeHistoryDeletion) {
        _ = store.perform("historyDelete", ["id": deletion.id, "keepIntake": deletion.keepIntake])
        pendingDelete = nil
    }
    private func open(_ row: [String: Any]) {
        if row["legacy"] as? Bool == true, let entry = row["entry"] as? [String: Any] { store.openEntry(entry) }
        else { store.openHistory(row) }
    }
    @ViewBuilder private func historyActions(_ undo: [String: Any]) -> some View {
        if !undo.isEmpty {
            Menu {
                Button { _ = store.perform("historyUndo") } label: {
                    Label("Undo last deletion", systemImage: "arrow.uturn.backward")
                }.accessibilityIdentifier("history-undo")
                if undo["phase"] as? String != "deleted" {
                    Button { _ = store.perform("historyRetry") } label: {
                        Label("Retry interrupted change", systemImage: "arrow.clockwise")
                    }.accessibilityIdentifier("history-retry")
                } else {
                    Button { _ = store.perform("historyDismissUndo") } label: {
                        Label("Dismiss undo", systemImage: "xmark")
                    }.accessibilityIdentifier("history-dismiss-undo")
                }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title2)
                    .frame(width: 48, height: 48).contentShape(Rectangle())
            }.buttonStyle(.borderless).accessibilityLabel("History actions")
                .trackingControl("history-actions")
        }
    }
    private func groupTitle(_ day: String) -> String {
        if day == NativeTrackingDisplay.dayKey(Date()) { return "Today" }
        if day == NativeTrackingDisplay.dayKey(NativeTrackingDisplay.calendar.date(byAdding: .day, value: -1, to: Date())!) { return "Yesterday" }
        return NativeTrackingDisplay.dateLabel(day, format: "d MMMM yyyy")
    }
}

struct NativeHistoryAlternativesSelection: Identifiable {
    let id: String
    let product: [String: Any]
    init(row: [String: Any]) {
        id = row["id"] as? String ?? "saved-product"
        product = row["product"] as? [String: Any] ?? [:]
    }
}

/// Read-only comparison opened from a specific scan. Viewing this page does
/// not create another scan, alter the saved product or add anything to Today.
@MainActor
struct NativeHistoryAlternativesView: View {
    let selection: NativeHistoryAlternativesSelection
    let profile: [String: Any]
    let avoidMilk: Bool
    let onOpen: ([String: Any]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var shop = ProductSearchPreferences.shared.store?.rawValue ?? "all"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(selection.product["name"] as? String ?? "Your product scan").font(.title2.bold())
                    if let brand = selection.product["brand"] as? String, !brand.isEmpty {
                        Text(brand).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    }
                    if selection.product.isEmpty {
                        Text("This scan is still waiting for product details. Open Alternatives again when its result is ready.")
                    } else {
                        Picker("Shop", selection: $shop) {
                            Text("All UK shops").tag("all")
                            ForEach(ProductSearchStore.allCases) { Text($0.title).tag($0.rawValue) }
                        }.accessibilityIdentifier("history-alternatives-shop")
                        NativeProductContextView(product: selection.product, profile: profile, avoidMilk: avoidMilk,
                            alternativesOnly: true, useSavedStore: false, selectedStore: ProductSearchStore(rawValue: shop), onOpen: onOpen)
                    }
                }.padding(20).frame(maxWidth: 700, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: NudgeTheme.canvas))
            .navigationTitle("Alternatives").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .accessibilityIdentifier("history-alternatives-page")
        }
    }
}

struct NativeHistoryScoreRequest: Equatable {
    let id: String
    let revision: String
    let deferred: Bool
}

struct NativeHistoryScoreResolution {
    let request: NativeHistoryScoreRequest
    let value: [String: Any]
    func matching(_ current: NativeHistoryScoreRequest) -> [String: Any]? { request == current ? value : nil }
    var refreshAt: TimeInterval? {
        guard let value = value["presentationRefreshAt"] as? NSNumber, value.doubleValue.isFinite, value.doubleValue > 0 else { return nil }
        return value.doubleValue
    }
    @MainActor static func resolve(_ request: NativeHistoryScoreRequest, using loader: @MainActor (String) -> [String: Any]) async -> Self? {
        guard request.deferred, !request.id.isEmpty else { return nil }
        // List creates tasks only for visible/prefetched rows. Yield first so
        // the lightweight names and images can render before local scoring.
        await Task.yield()
        guard !Task.isCancelled else { return nil }
        let value = loader(request.id)
        guard !Task.isCancelled else { return nil }
        return Self(request: request, value: value)
    }
}

/// Four completed milestones, not a prediction of provider response time.
enum NativeAnalysisStage: Int {
    case saved = 1, analysing = 2, saving = 3, complete = 4
    var fraction: Double { Double(rawValue) / 4 }
    var title: String {
        switch self {
        case .saved: return "Preparing photo…"
        case .analysing: return "Analysing…"
        case .saving: return "Saving result…"
        case .complete: return "Analysis finished"
        }
    }
}

/// Terminal durable states always override transient progress. After relaunch,
/// queued/processing records supply only the milestones already known to finish.
struct NativeHistoryAnalysisProgress {
    let title: String
    let isProcessing: Bool
    let stage: NativeAnalysisStage
    var fraction: Double { stage.fraction }
    var stepLabel: String { "Step \(stage.rawValue) of 4" }

    init?(row: [String: Any], stage liveStage: NativeAnalysisStage? = nil) {
        guard row["status"] as? String == "pending" else { return nil }
        switch row["processingState"] as? String {
        case "queued":
            stage = liveStage == .complete ? .saving : liveStage ?? .saved
            isProcessing = liveStage != nil && liveStage != .saved
            title = liveStage == nil || liveStage == .saved ? "Queued for analysis" : stage.title
        case "processing":
            stage = liveStage == .complete ? .saving : liveStage ?? .saved
            isProcessing = true
            title = liveStage == nil ? "Analysing…" : stage.title
        default:
            return nil
        }
    }
}

@MainActor
private struct NativeHistoryAnalysisProgressView: View {
    let progress: NativeHistoryAnalysisProgress
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(progress.title)
                Spacer(minLength: 4)
                Text(progress.stepLabel).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }.font(.caption.weight(.semibold))
                .foregroundStyle(Color(uiColor: NudgeTheme.accent))
                .fixedSize(horizontal: false, vertical: true)
            NativeAnalysisProgressBar(fraction: progress.fraction)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.title)
        .accessibilityValue(progress.stepLabel)
        .accessibilityIdentifier("history-analysis-progress")
    }
}

/// The filled portion advances when actual work completes and holds during
/// network waits. Reduce Motion disables only the transition, not the progress.
@MainActor
struct NativeAnalysisProgressBar: View {
    let fraction: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(uiColor: NudgeTheme.accent).opacity(0.16))
                Capsule().fill(Color(uiColor: NudgeTheme.accent))
                    .frame(width: geometry.size.width * min(1, max(0, fraction)))
            }
        }.frame(height: 7)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: fraction)
            .accessibilityHidden(true)
    }
}

@MainActor
private struct NativeHistoryRow: View {
    let row: [String: Any]
    var analysisStage: NativeAnalysisStage? = nil
    var scoreRevision = ""
    var scoreLoader: (@MainActor (String) -> [String: Any])? = nil
    @State private var resolvedScore: NativeHistoryScoreResolution?
    @Environment(\.dynamicTypeSize) private var typeSize
    private var entry: [String: Any] { NativeTrackingDisplay.object(row["entry"]) }
    private var scoreRequest: NativeHistoryScoreRequest {
        .init(id: row["id"] as? String ?? "", revision: scoreRevision, deferred: row["scoreDeferred"] as? Bool == true)
    }
    private var resolved: [String: Any]? { resolvedScore?.matching(scoreRequest) }
    private var rating: [String: Any] { NativeTrackingDisplay.object(scoreRequest.deferred ? resolved?["scoreDisplay"] : row["scoreDisplay"]) }
    private var loadingScore: Bool { scoreRequest.deferred && resolved == nil }
    private var note: String { (scoreRequest.deferred ? resolved?["note"] as? String : nil) ?? row["note"] as? String ?? "" }
    private var analysisProgress: NativeHistoryAnalysisProgress? { NativeHistoryAnalysisProgress(row: row, stage: analysisStage) }
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            NativeStoredFoodImage(source: NativeTrackingDisplay.imageSource(row), placeholder: row["kind"] as? String == "product" ? "barcode.viewfinder" : "fork.knife",
                                  barcode: NativeTrackingDisplay.imageBarcode(row), maximumPixelSize: 256)
                .frame(width: 44, height: 52)
                .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 12))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                Text(entry["name"] as? String ?? row["name"] as? String ?? NativeTrackingDisplay.object(row["product"])["name"] as? String ?? "Your food")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 5) {
                    if !entry.isEmpty { Image(systemName: "checkmark.circle.fill").foregroundStyle(Color(uiColor: NudgeTheme.accent)) }
                    Text(!entry.isEmpty ? "Eaten · " + kindLabel : kindLabel)
                }
                .font(.caption2).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                if let progress = analysisProgress {
                    NativeHistoryAnalysisProgressView(progress: progress)
                } else if !note.isEmpty, note != "Ready to log" {
                    Text(note).font(.caption2).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if typeSize.isAccessibilitySize && analysisProgress == nil { score }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if !typeSize.isAccessibilitySize && analysisProgress == nil { score }
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            .task(id: scoreRequest) { await loadVisibleScore() }
    }
    private func loadVisibleScore() async {
        let request = scoreRequest
        guard request.deferred, let scoreLoader else { resolvedScore = nil; return }
        var previousExpiredDeadline: TimeInterval?
        while !Task.isCancelled {
            guard let result = await NativeHistoryScoreResolution.resolve(request, using: scoreLoader), !Task.isCancelled else { return }
            resolvedScore = result
            guard let deadline = result.refreshAt else { return }
            // A deadline can pass during a calculation. Refresh once promptly,
            // but never spin if an error repeats the same expired metadata.
            if deadline <= Date().timeIntervalSince1970 {
                guard previousExpiredDeadline != deadline else { return }
                previousExpiredDeadline = deadline
            } else { previousExpiredDeadline = nil }
            do {
                repeat {
                    let remaining = deadline - Date().timeIntervalSince1970
                    try await Task.sleep(for: .seconds(min(3_600, max(0.01, remaining))))
                } while deadline > Date().timeIntervalSince1970
            } catch { return }
        }
    }
    private var kindLabel: String {
        if row["origin"] as? String == "search" { return "Product from search" }
        if row["kind"] as? String == "product" { return "Product scan" }
        if !entry.isEmpty { return "Saved food" }
        return "Photo analysis"
    }
    private var score: some View {
        let value = NativeTrackingDisplay.number(rating["value"])
        let tone = NativeProductRatingTone(value: value.map { Int($0.rounded()) })
        let fill = Color(uiColor: NudgeTheme.color(tone.fill, tone.fill))
        return HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text(loadingScore ? "…" : value.map { NativeTrackingDisplay.numberLabel($0, digits: 0) } ?? "Not rated")
                .font(.caption.weight(.bold)).monospacedDigit()
            if value != nil { Text("/100").font(.caption2) }
        }
        .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: true)
        .padding(.horizontal, 8).padding(.vertical, 7)
        .foregroundStyle(Color(uiColor: value == nil ? NudgeTheme.muted : NudgeTheme.primaryText))
        .background(value == nil ? Color(uiColor: NudgeTheme.canvas) : fill, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(loadingScore ? "Calculating Nudge score" : rating["label"] as? String ?? "Nudge score unavailable")
    }
}

struct NativeMyFoodsView: View {
    @ObservedObject var store: NativeAppStore
    @State private var query = ""
    @State private var historyPresented = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let foods = NativeTrackingDisplay.rows(store.foods["foods"])
        let shown = foods.filter { matches($0) }
        List {
            VStack(alignment: .leading, spacing: 16) {
                Text("My foods").font(.largeTitle.bold())
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(Color(uiColor: NudgeTheme.muted))
                    TextField("Search My foods", text: $query).textInputAutocapitalization(.never).submitLabel(.search)
                        .trackingControl("my-foods-search")
                    if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill").frame(width: 48, height: 48).contentShape(Rectangle()) }.accessibilityLabel("Clear search") }
                }.padding(15).background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
                Text("Your regulars, ready to go. Tap a food to edit it or add it to your day.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }.listRowSeparator(.hidden).listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 20, leading: 20, bottom: 16, trailing: 20))
            ForEach(NativeTrackingDisplay.identifiedRows(shown)) { item in
                Button { store.openSaved(item.value) } label: { foodRow(item.value) }
                    .buttonStyle(.plain).trackingControl("my-foods-row-" + (item.value["id"] as? String ?? item.id))
                    .contextMenu {
                        Button { store.openSaved(item.value) } label: { Label("Edit food", systemImage: "square.and.pencil") }
                        Button(role: .destructive) { remove(item.value) } label: { Label("Remove from My foods", systemImage: "trash") }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { remove(item.value) } label: { Label("Delete", systemImage: "trash") }
                    }
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            }
            if shown.isEmpty {
                Text(foods.isEmpty ? "Save your smoothie or a regular meal once, then reuse it here." : "No saved foods match this search.")
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted)).padding(.vertical, 18)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            VStack(spacing: 12) {
                Button("Add from my food history") { historyPresented = true }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary)).trackingControl("my-foods-history")
                Button("Scan or describe another food") { store.navigate("camera") }
                    .buttonStyle(NudgeButtonStyle(variant: .secondary)).trackingControl("my-foods-scan")
            }.listRowSeparator(.hidden).listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 16, leading: 20, bottom: 20, trailing: 20))
        }
        .listStyle(.plain).scrollContentBackground(.hidden)
        .background(Color(uiColor: NudgeTheme.canvas)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
        .tint(Color(uiColor: NudgeTheme.accent)).trackingControl("native-my-foods")
        .sheet(isPresented: $historyPresented) { historyPicker }
    }

    private func foodRow(_ food: [String: Any]) -> some View {
        let draft = NativeTrackingDisplay.object(food["draft"])
        let portions = NativeTrackingDisplay.number(draft["portions"]) ?? 1
        let unit = draft["portionUnit"] as? String ?? "g"
        let amount = NativeTrackingDisplay.number(draft["portionAmount"]).map { NativeTrackingDisplay.numberLabel($0 * portions) + " " + unit } ?? "\(NativeTrackingDisplay.numberLabel(portions)) portion\(portions == 1 ? "" : "s")"
        let energy = NativeTrackingDisplay.number(draft["energyPerPortion"]).map { NativeTrackingDisplay.numberLabel($0 * portions, digits: 0) + " kcal" } ?? "Energy not yet known"
        return HStack(alignment: .center, spacing: 10) {
                NativeStoredFoodImage(source: savedImage(food), placeholder: "fork.knife", barcode: NativeTrackingDisplay.imageBarcode(food), maximumPixelSize: 256)
                    .frame(width: 44, height: 52).clipShape(RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(food["name"] as? String ?? "Saved food")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Saved food · " + amount).font(.caption2)
                    Text(energy).font(.caption2)
                }.foregroundStyle(Color(uiColor: NudgeTheme.muted)).frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted)).accessibilityHidden(true)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: NudgeTheme.border)))
            .contentShape(RoundedRectangle(cornerRadius: 18))
            .accessibilityElement(children: .combine).accessibilityHint("Opens the full food review to edit or add to your diary")
    }
    private func remove(_ food: [String: Any]) {
        guard let id = food["id"] as? String else { return }
        _ = store.perform("foodsDelete", ["id": id])
    }
    private var historyPicker: some View {
        let entries = recentEntries()
        return NavigationStack {
            List {
                Text("Choose a food you have already logged. Saving it here won’t add another eating entry.")
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted)).listRowBackground(Color.clear)
                ForEach(entries.indices, id: \.self) { index in
                    let entry = entries[index]
                    Button {
                        if let id = entry["id"] as? String, store.perform("foodsSaveEntry", ["entryId": id]) { historyPresented = false }
                    } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(entry["name"] as? String ?? "Food").font(.headline)
                            Text(NativeTrackingDisplay.dateLabel(entry["day"] as? String ?? "", format: "d MMMM")).font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        }.padding(.vertical, 7)
                    }.listRowBackground(Color(uiColor: NudgeTheme.surface))
                }
                if entries.isEmpty { Text("No logged foods yet. Scan or describe a food to start your collection.").listRowBackground(Color.clear) }
            }.scrollContentBackground(.hidden).background(Color(uiColor: NudgeTheme.canvas))
                .foregroundStyle(Color(uiColor: NudgeTheme.ink)).navigationTitle("Add to My foods")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { historyPresented = false } } }
        }.tint(Color(uiColor: NudgeTheme.accent))
    }
    private func savedImage(_ food: [String: Any]) -> String {
        let retained = NativeTrackingDisplay.imageSource(food)
        if !retained.isEmpty { return retained }
        if let source = food["image"] as? String, !source.isEmpty { return source }
        let draft = NativeTrackingDisplay.object(food["draft"])
        let snapshot = NativeTrackingDisplay.object(NativeTrackingDisplay.object(draft["sourceMeta"])["recipeSnapshot"])
        var filename = snapshot["image"] as? String
        if filename == nil, let recipe = draft["recipe"] as? String, !recipe.isEmpty {
            filename = store.project("recipe", ["id": recipe])["image"] as? String
        }
        guard let filename, filename.range(of: "^[a-zA-Z0-9_-]+\\.(?:webp|png|jpg)$", options: .regularExpression) != nil else { return "" }
        return "/assets/" + filename
    }
    private func matches(_ food: [String: Any]) -> Bool {
        let draft = NativeTrackingDisplay.object(food["draft"])
        let ingredients = NativeTrackingDisplay.object(draft["ingredients"])["text"] as? String ?? ""
        let haystack = ([food["name"] as? String ?? "", ingredients] + (draft["plants"] as? [String] ?? [])).joined(separator: " ")
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).replacingOccurrences(of: "yoghurt", with: "yogurt")
        let terms = query.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).replacingOccurrences(of: "yoghurt", with: "yogurt").split(whereSeparator: \.isWhitespace)
        return terms.allSatisfy { haystack.contains($0) }
    }
    private func recentEntries() -> [[String: Any]] {
        let entries = NativeTrackingDisplay.rows(NativeTrackingDisplay.object(store.state["foodLog"])["entries"])
        var seen = Set<String>()
        return Array(entries.reversed().filter { entry in
            let fingerprint: [Any] = [entry["name"] ?? "", entry["portionAmount"] ?? NSNull(), entry["portionUnit"] ?? "", entry["plants"] ?? [], entry["nutritionSnapshot"] ?? [:]]
            let data = (try? JSONSerialization.data(withJSONObject: fingerprint, options: [.sortedKeys])) ?? Data()
            return seen.insert(data.base64EncodedString()).inserted
        }.prefix(60))
    }
}

/// Shared thumbnail loading for private meal previews and allowlisted catalogue
/// pictures; full-resolution analysis uploads never enter this view's cache.
struct NativeStoredFoodImage: View {
    let source: String
    var placeholder = "fork.knife"
    var barcode: String? = nil
    var placeholderFont: Font = .title2
    var maximumPixelSize = 768
    @State private var image: UIImage?
    @State private var loadedIdentity: String?
    var body: some View {
        GeometryReader { geometry in
            Group {
                if let image {
                    Image(uiImage: image).resizable()
                        .aspectRatio(contentMode: barcode != nil || placeholder == "barcode.viewfinder" ? .fit : .fill)
                        .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                } else {
                    Image(systemName: placeholder).font(placeholderFont).foregroundStyle(Color(uiColor: NudgeTheme.muted))
                        .frame(width: geometry.size.width, height: geometry.size.height)
                }
            }
        }.accessibilityHidden(true)
            .task(id: source + "|" + (barcode ?? "") + "|" + String(maximumPixelSize)) {
                let identity = NativeTrackingDisplay.imageIdentity(source: source, barcode: barcode)
                if loadedIdentity != identity { image = nil }
                var source = source
                if source.isEmpty, let barcode {
                    source = await NativeCatalogueImageReferences.shared.source(for: barcode) ?? ""
                    guard !Task.isCancelled else { return }
                }
                let preview = await NativeFoodImageCache.shared.image(for: source, maximumPixelSize: maximumPixelSize)
                guard !Task.isCancelled else { return }
                image = preview; loadedIdentity = identity
            }
    }
}

/// Decoded thumbnails are shared across remounted rows and screens. Private
/// originals stay in NudgeData; this cache is memory-only and never writes them
/// into the public catalogue cache. File reads and ImageIO decoding run off UI.
actor NativeFoodImageCache {
    static let shared = NativeFoodImageCache()
    private struct Entry { let image: UIImage; let cost: Int; var access: UInt64 }
    private let maximumBytes: Int
    private let maximumCount: Int
    private let maximumConcurrentLoads: Int
    private let readData: @Sendable (String) async -> Data?
    private var images: [String: Entry] = [:]
    private struct Pending {
        let id: UUID
        var task: Task<Void, Never>?
        var readers: [UUID: CheckedContinuation<UIImage?, Never>]
    }
    private var pending: [String: Pending] = [:]
    private var activeLoads = 0
    private var waitingOrder: [UUID] = []
    private var waiting: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private var bytes = 0
    private var access: UInt64 = 0

    init(maximumBytes: Int = 12 * 1024 * 1024, maximumCount: Int = 64, maximumConcurrentLoads: Int = 4,
         readData: @escaping @Sendable (String) async -> Data? = { await NativeFoodImageCache.sourceData($0) }) {
        self.maximumBytes = max(0, maximumBytes); self.maximumCount = max(0, maximumCount)
        self.maximumConcurrentLoads = max(1, maximumConcurrentLoads)
        self.readData = readData
    }

    func image(for source: String, maximumPixelSize: Int = 768) async -> UIImage? {
        guard !source.isEmpty, source.utf8.count <= 49_152, !Task.isCancelled else { return nil }
        let pixels = min(1_200, max(64, maximumPixelSize))
        let canonical = CatalogueProductImages.sourceURL(source).flatMap(CatalogueProductImages.thumbnailURL)?.absoluteString ?? source
        let digest = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
        let key = digest + ":" + String(pixels)
        access &+= 1
        if var cached = images[key] {
            cached.access = access; images[key] = cached
            return cached.image
        }
        let reader = UUID()
        return await withTaskCancellationHandler {
            guard !Task.isCancelled else { return nil }
            return await withCheckedContinuation { continuation in
                if var work = pending[key] {
                    work.readers[reader] = continuation; pending[key] = work
                    return
                }
                let id = UUID()
                pending[key] = Pending(id: id, readers: [reader: continuation])
                let task = Task {
                    guard await acquireLoad(id) else { finish(nil, key: key, id: id); return }
                    defer { releaseLoad() }
                    guard !Task.isCancelled, let data = await readData(source), !Task.isCancelled else {
                        finish(nil, key: key, id: id); return
                    }
                    finish(Self.thumbnail(data, maximumPixelSize: pixels), key: key, id: id)
                }
                pending[key]?.task = task
            }
        } onCancel: {
            Task { await self.cancelReader(reader, key: key) }
        }
    }

    private func acquireLoad(_ id: UUID) async -> Bool {
        await withTaskCancellationHandler {
            guard !Task.isCancelled else { return false }
            if activeLoads < maximumConcurrentLoads { activeLoads += 1; return true }
            return await withCheckedContinuation { continuation in
                waiting[id] = continuation; waitingOrder.append(id)
            }
        } onCancel: {
            Task { await self.cancelWaitingLoad(id) }
        }
    }

    private func cancelWaitingLoad(_ id: UUID) {
        guard let continuation = waiting.removeValue(forKey: id) else { return }
        waitingOrder.removeAll { $0 == id }
        continuation.resume(returning: false)
    }

    private func releaseLoad() {
        while !waitingOrder.isEmpty {
            let id = waitingOrder.removeFirst()
            if let continuation = waiting.removeValue(forKey: id) {
                continuation.resume(returning: true)
                return
            }
        }
        activeLoads -= 1
    }

    private func cancelReader(_ reader: UUID, key: String) {
        guard var work = pending[key], let continuation = work.readers.removeValue(forKey: reader) else { return }
        continuation.resume(returning: nil)
        if work.readers.isEmpty {
            pending.removeValue(forKey: key)
            work.task?.cancel()
            cancelWaitingLoad(work.id)
        } else { pending[key] = work }
    }

    private func finish(_ result: UIImage?, key: String, id: UUID) {
        // A canceled last reader may have been replaced by a fresh request for
        // this source. The old work must not remove or satisfy the new flight.
        guard let work = pending[key], work.id == id else { return }
        pending.removeValue(forKey: key)
        if let result, let cgImage = result.cgImage {
            let cost = cgImage.bytesPerRow * cgImage.height
            if maximumCount > 0, cost <= maximumBytes {
                access &+= 1
                images[key] = Entry(image: result, cost: cost, access: access); bytes += cost
                while images.count > maximumCount || bytes > maximumBytes {
                    guard let oldest = images.min(by: { $0.value.access < $1.value.access }) else { break }
                    bytes -= oldest.value.cost; images.removeValue(forKey: oldest.key)
                }
            }
        }
        for continuation in work.readers.values { continuation.resume(returning: result) }
    }

#if DEBUG
    func workloadForTesting() -> (active: Int, queued: Int, pending: Int, readers: Int) {
        (activeLoads, waiting.count, pending.count, pending.values.reduce(0) { $0 + $1.readers.count })
    }
#endif

    private static func sourceData(_ source: String) async -> Data? {
        if source.hasPrefix("nudge-photo:") { return NudgeDataStore.shared.photoData(for: source) }
        if source.hasPrefix("data:image/jpeg;base64,"), source.utf8.count <= 49_152 {
            return Data(base64Encoded: String(source.dropFirst("data:image/jpeg;base64,".count)))
        }
        if source.hasPrefix("/assets/"), source.utf8.count <= 200, !source.contains(".."),
           let url = Bundle.main.resourceURL?.appendingPathComponent("Web" + source),
           let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 20 * 1024 * 1024 {
            return try? Data(contentsOf: url)
        }
        guard let url = CatalogueProductImages.sourceURL(source) else { return nil }
        return try? await CatalogueProductImages.shared.data(for: url)
    }

    private static func thumbnail(_ data: Data, maximumPixelSize: Int) -> UIImage? {
        guard data.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// Restores missing public picture references for old saved rows without
/// changing their historic nutrition, scores, portions or stored diary data.
/// Visible rows are combined into bounded catalogue batches, never OFF reads.
actor NativeCatalogueImageReferences {
    static let shared = NativeCatalogueImageReferences()
    private struct Entry { let source: String?; let saved: Date; let lifetime: TimeInterval }
    private let cache: ProductLookupCache?
    private let batch: ([String]) async throws -> [BarcodeProduct]
    private let now: () -> Date
    private var references: [String: Entry] = [:]
    private var pending: [String: [CheckedContinuation<String?, Never>]] = [:]
    private var worker: Task<Void, Never>?

    init(cache: ProductLookupCache? = .shared, now: @escaping () -> Date = Date.init,
         batch: @escaping ([String]) async throws -> [BarcodeProduct] = { try await NudgeCatalogueService().batch($0) }) {
        self.cache = cache; self.now = now; self.batch = batch
    }

    func source(for barcode: String) async -> String? {
        guard barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil, !Task.isCancelled else { return nil }
        if let source = cache?.read(barcode: barcode, now: now())?.displayImageURL { return source }
        if let entry = references[barcode], (0..<entry.lifetime).contains(now().timeIntervalSince(entry.saved)) { return entry.source }
        guard pending[barcode] != nil || pending.count < 200 else { return nil }
        return await withCheckedContinuation { continuation in
            pending[barcode, default: []].append(continuation)
            if worker == nil {
                worker = Task {
                    try? await Task.sleep(nanoseconds: 30_000_000)
                    await drain()
                }
            }
        }
    }

    private func drain() async {
        while !pending.isEmpty {
            let codes = Array(pending.keys.sorted().prefix(20))
            let products = try? await batch(codes)
            let byCode = Dictionary(grouping: products ?? [], by: \.barcode)
            for code in codes {
                // Include readers arriving while the request was in flight.
                let listeners = pending.removeValue(forKey: code) ?? []
                let matches = byCode[code] ?? []
                let source = matches.count == 1 ? matches[0].displayImageURL : nil
                references[code] = Entry(source: source, saved: now(), lifetime: products == nil ? 15 : 300)
                for continuation in listeners { continuation.resume(returning: source) }
            }
            while references.count > 200, let oldest = references.min(by: { $0.value.saved < $1.value.saved })?.key { references.removeValue(forKey: oldest) }
        }
        worker = nil
    }
}

struct NativeNutritionRings: View {
    let items: [[String: Any]]
    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let step = 96 / Double(max(5, items.count) - 1)
            let stroke = min(16, step - 5) * size / 280
            ZStack {
                ForEach(items.indices, id: \.self) { index in
                    let item = items[index]
                    let diameter = (122 - Double(index) * step) * 2 * size / 280
                    let fraction = min(1, NativeTrackingDisplay.ratio(item) ?? 0)
                    let unknown = item["recorded"] as? Bool == true && NativeTrackingDisplay.number(item["value"]) == nil
                    Circle().stroke(NativeTrackingDisplay.color(item).opacity(0.18), style: StrokeStyle(lineWidth: stroke, dash: unknown ? [3 * size / 280, 7 * size / 280] : []))
                        .frame(width: diameter, height: diameter)
                    if fraction > 0 {
                        Circle().trim(from: 0, to: fraction)
                            .stroke(NativeTrackingDisplay.color(item), style: StrokeStyle(lineWidth: stroke, lineCap: .round))
                            .rotationEffect(.degrees(-90)).frame(width: diameter, height: diameter)
                    }
                }
            }.frame(width: geometry.size.width, height: geometry.size.height)
        }.accessibilityHidden(true)
    }
}

private struct NativeTrackingCard<Content: View>: View {
    var spacing: CGFloat = 16
    var padding: CGFloat = 18
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: spacing) { content }.frame(maxWidth: .infinity, alignment: .leading).padding(padding)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color(uiColor: NudgeTheme.border), lineWidth: 1))
    }
}
private struct NativeTrackingCalendarButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(Color(uiColor: enabled ? NudgeTheme.ink : NudgeTheme.muted))
            .background(Color(uiColor: configuration.isPressed ? NudgeTheme.selectedSurface : NudgeTheme.canvas), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(uiColor: NudgeTheme.border)))
            .opacity(enabled ? 1 : 0.45)
    }
}

/// Rendering helpers only. Arithmetic here is limited to displaying a supplied
/// value as a fraction of its supplied target, matching NudgeToday.progress.
/// Formatting a visible week previously built dozens of ICU formatters. Keep
/// a small shared set, locking both lookup and use for background test callers.
private final class NativeTrackingDateFormatters {
    static let shared = NativeTrackingDateFormatters()
    private let lock = NSLock()
    private var formats: [String: DateFormatter] = [:]
    private let iso = ISO8601DateFormatter()
    private let fractional: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter()
        value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return value
    }()

    private func formatter(_ format: String) -> DateFormatter {
        let formatter: DateFormatter
        if let existing = formats[format] { formatter = existing }
        else {
            formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_GB")
            formatter.calendar = NativeTrackingDisplay.calendar
            formatter.timeZone = .current
            formatter.dateFormat = format
            if formats.count >= 16 { formats.removeAll(keepingCapacity: true) }
            formats[format] = formatter
        }
        // Follow a timezone change without retaining yesterday's local day.
        if formatter.timeZone != .current {
            formatter.calendar = NativeTrackingDisplay.calendar
            formatter.timeZone = .current
        }
        return formatter
    }
    func date(_ day: String) -> Date {
        lock.lock(); defer { lock.unlock() }
        return formatter("yyyy-MM-dd").date(from: day) ?? Date()
    }
    func string(_ date: Date, format: String) -> String {
        lock.lock(); defer { lock.unlock() }
        return formatter(format).string(from: date)
    }
    func timestamp(_ text: String) -> Date? {
        lock.lock(); defer { lock.unlock() }
        return fractional.date(from: text) ?? iso.date(from: text)
    }
}

enum NativeTrackingDisplay {
    struct Row: Identifiable {
        let id: String
        let value: [String: Any]
    }
    struct HistoryGroup: Identifiable {
        var id: String { day }
        let day: String
        var rows: [Row]
    }
    static func identifiedRows(_ rows: [[String: Any]]) -> [Row] {
        var occurrences: [String: Int] = [:]
        return rows.enumerated().map { index, row in
            let source = row["id"] as? String ?? object(row["entry"])["id"] as? String ?? "position:\(index)"
            let occurrence = occurrences[source, default: 0]
            occurrences[source] = occurrence + 1
            return Row(id: "\(source.utf8.count):\(source):\(occurrence)", value: row)
        }
    }
    static func historyGroups(_ rows: [[String: Any]], filter: String) -> [HistoryGroup] {
        var result: [HistoryGroup] = [], indices: [String: Int] = [:]
        for row in identifiedRows(rows) {
            let entry = object(row.value["entry"]), source = row.value["createdAt"] as? String ?? ""
            let day: String
            if let historyDay = row.value["historyDay"] as? String { day = historyDay }
            else if filter == "eaten" { day = entry["day"] as? String ?? String(source.prefix(10)) }
            else if let date = timestamp(source) { day = dayKey(date) }
            else { day = String(source.prefix(10)) }
            if let index = indices[day] { result[index].rows.append(row) }
            else { indices[day] = result.count; result.append(HistoryGroup(day: day, rows: [row])) }
        }
        return result
    }
    static var calendar: Calendar { var calendar = Calendar(identifier: .gregorian); calendar.firstWeekday = 2; return calendar }
    static func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
    static func rows(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }
    static func number(_ value: Any?) -> Double? {
        guard !(value is NSNull), let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue >= 0 else { return nil }
        return number.doubleValue
    }
    static func numberLabel(_ number: Double, digits: Int = 1) -> String {
        number.formatted(.number.locale(Locale(identifier: "en_GB")).precision(.fractionLength(0...digits)))
    }
    static func date(_ day: String) -> Date {
        NativeTrackingDateFormatters.shared.date(day)
    }
    static func dayKey(_ date: Date) -> String {
        NativeTrackingDateFormatters.shared.string(date, format: "yyyy-MM-dd")
    }
    static func dateLabel(_ day: String, format: String) -> String {
        guard !day.isEmpty else { return "" }
        return NativeTrackingDateFormatters.shared.string(date(day), format: format)
    }
    static func monthStart(_ date: Date) -> Date { calendar.dateInterval(of: .month, for: date)!.start }
    static func monday(_ date: Date) -> String {
        let offset = (calendar.component(.weekday, from: date) + 5) % 7
        return dayKey(calendar.date(byAdding: .day, value: -offset, to: date)!)
    }
    static func timestamp(_ text: String) -> Date? {
        NativeTrackingDateFormatters.shared.timestamp(text)
    }
    static func title(_ item: [String: Any]) -> String { item["title"] as? String ?? (item["key"] as? String ?? "Progress").capitalized }
    static func color(_ item: [String: Any]) -> Color {
        if isConsumptionReference(item), let ratio = ratio(item), ratio >= 1 {
            return Color(uiColor: NudgeTheme.warningText)
        }
        return switch item["key"] as? String {
        case "protein": Color(uiColor: NudgeTheme.color(0x9254E8, 0x9254E8))
        case "energy": Color(uiColor: NudgeTheme.color(0xFF6900, 0xFF6900))
        case "carbs": Color(uiColor: NudgeTheme.color(0xFFBE00, 0xFFBE00))
        case "fibre": Color(uiColor: NudgeTheme.color(0x20CDBB, 0x20CDBB))
        case "plants": Color(uiColor: NudgeTheme.color(0xA8DC00, 0xA8DC00))
        case "sugars": Color(uiColor: NudgeTheme.color(0xEE72AE, 0xEE72AE))
        case "saturatedFat", "saturates": Color(uiColor: NudgeTheme.color(0xED8575, 0xED8575))
        case "salt": Color(uiColor: NudgeTheme.color(0x57A7EE, 0x57A7EE))
        default: Color(uiColor: NudgeTheme.accent)
        }
    }
    static func ratio(_ item: [String: Any]) -> Double? {
        guard item["future"] as? Bool != true, item["recorded"] as? Bool == true, item["targetKnown"] as? Bool != false,
              let value = number(item["rawValue"] ?? item["value"]), let target = number(item["target"]), target > 0 else { return nil }
        return value / target
    }
    static func completion(_ item: [String: Any]) -> String {
        guard let ratio = ratio(item) else { return "—" }
        let percent = ratio < 1 ? min(99, (ratio * 100).rounded()) : (ratio * 100).rounded()
        return ((number(item["unknown"]) ?? 0) > 0 ? "≥ " : "") + numberLabel(percent, digits: 0) + "%"
    }
    /// With no reference target, show the saved amount instead of an empty percentage.
    static func ringLabel(_ item: [String: Any]) -> String {
        if ratio(item) != nil { return completion(item) }
        guard item["recorded"] as? Bool == true, item["future"] as? Bool != true,
              let value = number(item["value"]) else { return "—" }
        let isPlants = item["key"] as? String == "plants"
        let unit = isPlants ? "" : item["unit"] as? String ?? ""
        return ((number(item["unknown"]) ?? 0) > 0 ? "≥ " : "")
            + numberLabel(value, digits: isPlants || unit == "kcal" ? 0 : 1) + unit
    }
    static func valueLabel(_ item: [String: Any]) -> String {
        let unit = item["unit"] as? String ?? ""
        guard item["recorded"] as? Bool == true, item["future"] as? Bool != true, let value = number(item["value"]) else { return "—" }
        return numberLabel(value, digits: unit == "kcal" ? 0 : 1) + " " + unit
    }
    static func targetRoleLabel(_ item: [String: Any]) -> String? {
        switch item["targetRole"] as? String {
        case "reference": return "Reference amount"
        case "limit": return "Upper limit"
        case "guide": return "Daily variety guide"
        default: return nil
        }
    }
    static func isConsumptionReference(_ item: [String: Any]) -> Bool {
        ["sugars", "saturatedFat"].contains(item["key"] as? String ?? "")
            && ["reference", "limit"].contains(item["targetRole"] as? String ?? "")
    }
    static func targetLabel(_ item: [String: Any]) -> String {
        guard item["targetKnown"] as? Bool != false else { return missingTargetReason(item, fallback: "Target not recorded") }
        guard let target = number(item["target"]), target > 0 else { return missingTargetReason(item) }
        return (targetRoleLabel(item).map { $0 + ": " } ?? "of ") + numberLabel(target, digits: item["unit"] as? String == "kcal" ? 0 : 1) + " " + (item["unit"] as? String ?? "") + (item["period"] as? String == "week" ? " this week" : " on this day")
    }
    /// Target visibility is independent of whether any intake has been recorded.
    static func hasTarget(_ item: [String: Any]) -> Bool {
        item["targetKnown"] as? Bool != false && (number(item["target"]) ?? 0) > 0
    }
    /// A known saved amount can be shown as active without inventing a target.
    static func hasLoggedAmount(_ item: [String: Any]) -> Bool {
        item["recorded"] as? Bool == true && item["future"] as? Bool != true
            && number(item["rawValue"] ?? item["value"]) != nil
    }
    static func summaryAmount(_ item: [String: Any]) -> String {
        hasTarget(item) ? total(item) : valueLabel(item)
    }
    static func total(_ item: [String: Any]) -> String {
        let unit = item["unit"] as? String ?? ""
        let value = item["recorded"] as? Bool == true && item["future"] as? Bool != true ? number(item["value"]) : nil
        let target = item["targetKnown"] as? Bool == false ? nil : number(item["target"]).flatMap { $0 > 0 ? $0 : nil }
        return (value.map { numberLabel($0, digits: unit == "kcal" ? 0 : 1) } ?? "—") + " / " + (target.map { numberLabel($0, digits: unit == "kcal" ? 0 : 1) } ?? "—") + " " + unit
    }
    static func note(_ item: [String: Any]) -> String? {
        if item["future"] as? Bool == true { return "Upcoming" }
        if item["recorded"] as? Bool != true { return "No food logged" }
        guard number(item["value"]) != nil else { return "Nutrition unknown" }
        if isConsumptionReference(item), let ratio = ratio(item), ratio >= 1 {
            return (ratio > 1 ? "Above reference amount" : "At reference amount") + ((number(item["unknown"]) ?? 0) > 0 ? " · partial" : "")
        }
        if (number(item["unknown"]) ?? 0) > 0 { return "Known total · partial" }
        if item["targetKnown"] as? Bool == false { return missingTargetReason(item, fallback: "Target not recorded") }
        guard let target = number(item["target"]), target > 0 else { return missingTargetReason(item) }
        if let value = number(item["rawValue"] ?? item["value"]), value > target {
            return item["targetRole"] as? String == "limit" ? "Above upper limit" : item["targetRole"] as? String == "reference" ? "Above reference amount" : "Over target"
        }
        if isConsumptionReference(item) { return "Not a goal to reach" }
        return nil
    }
    static func description(_ item: [String: Any]) -> String {
        title(item) + ": " + valueLabel(item) + ", " + targetLabel(item) + (note(item).map { ", " + $0 } ?? "") + (item["estimated"] as? Bool == true ? ", includes estimates" : "") + ((item["referenceNote"] as? String).map { ". " + $0 } ?? "")
    }
    static func missingTargetReason(_ item: [String: Any], fallback: String = "Target not set") -> String {
        let reason = (item["targetReason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return reason.isEmpty ? fallback : reason
    }
    static func imageSource(_ row: [String: Any]) -> String {
        let entry = object(row["entry"]), draft = object(row["draft"])
        let metadata = [object(entry["sourceMeta"]), object(draft["sourceMeta"]), object(row["sourceMeta"])]
        for meta in metadata {
            if let photos = meta["entryPhotos"] as? [String], let first = photos.first(where: { !$0.isEmpty }) { return first }
            if let photo = meta["entryThumbnail"] as? String, !photo.isEmpty { return photo }
        }
        if let source = row["imageURL"] as? String, !source.isEmpty { return source }
        if let thumbnail = row["thumbnail"] as? String, !thumbnail.isEmpty { return thumbnail }
        for meta in metadata {
            if let source = meta["repertoireImage"] as? String, !source.isEmpty { return source }
        }
        if let source = row["image"] as? String, !source.isEmpty { return source }
        let product = object(row["product"])
        for key in ["imageURL", "imageUrl", "imageFrontURL"] { if let source = product[key] as? String, !source.isEmpty { return source } }
        if let data = try? JSONSerialization.data(withJSONObject: product), let decoded = try? JSONDecoder().decode(BarcodeProduct.self, from: data),
           let source = decoded.displayImageURL { return source }
        return ""
    }
    static func imageIdentity(source: String, barcode: String?) -> String {
        if let barcode, source.isEmpty || CatalogueProductImages.sourceURL(source) != nil { return "product:" + barcode }
        // A private meal photo must not follow an unrelated image or barcode.
        return "source:" + source
    }
    static func imageBarcode(_ row: [String: Any]) -> String? {
        let entry = object(row["entry"]), draft = object(row["draft"])
        let products = [object(row["product"]), object(object(entry["sourceMeta"])["product"]),
                        object(object(draft["sourceMeta"])["product"])]
        let candidates = [row["barcode"], entry["barcode"], draft["barcode"]] + products.map { $0["barcode"] }
        return candidates.compactMap { $0 as? String }.first { $0.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil }
    }
}

private extension View {
    @ViewBuilder func trackingControl(_ identifier: String) -> some View {
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
#if DEBUG
struct NativeTrackingRenderGeometryKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, latest in latest }) }
}
#endif
