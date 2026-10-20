import Foundation

@main
struct IngredientPickerChecks {
    static func main() {
        var checks = 0
        func expect(_ name: String, _ passed: Bool) {
            precondition(passed, name)
            checks += 1
            print("PASS \(name)")
        }

        var draft = NativeMealIngredientPickerDraft(selected: ["Kefir", "Chia seeds", "kefir"])
        expect("restored selections retain order without duplicate tags", draft.selected == ["Kefir", "Chia seeds"])
        let choices: [[String: Any]] = [["name": "Kefir"], ["name": "Blueberries"], ["name": "blueberries"], ["name": "Chia seeds"]]
        expect("suggestions exclude selected tags and duplicate names",
               draft.available(choices).compactMap { $0["name"] as? String } == ["Blueberries"])

        draft.search = "berry"
        draft.acceptSearch(["items": [["name": "Blueberries"]], "total": 1], for: "berry")
        expect("matching debounced search results are accepted", draft.searchItems.count == 1 && draft.completedSearch == "berry")
        expect("catalogue selection succeeds", draft.toggle("Blueberries"))
        expect("new catalogue choice appears first", draft.selected == ["Blueberries", "Kefir", "Chia seeds"])
        expect("selection immediately clears query and old matches",
               draft.search.isEmpty && draft.query.isEmpty && draft.searchItems.isEmpty && draft.searchTotal == 0 && draft.completedSearch.isEmpty)
        draft.acceptSearch(["items": [["name": "Raspberries"]], "total": 1], for: "berry")
        expect("late results cannot refill a cleared search", draft.searchItems.isEmpty && draft.completedSearch.isEmpty)

        draft.search = "  oat  "
        draft.acceptSearch(["items": [["name": "Raspberries"]]], for: "berry")
        expect("late results cannot replace a new ingredient search", draft.searchItems.isEmpty)
        draft.acceptSearch(["items": [["name": "Oats"]], "total": 1], for: "oat")
        expect("trimmed next search returns its own matches", draft.completedSearch == "oat" && draft.searchItems.first?["name"] as? String == "Oats")
        expect("prior selected tags stay visible while searching", draft.selected == ["Blueberries", "Kefir", "Chia seeds"])
        expect("selected tag can be removed during another search", draft.toggle("blueberries"))
        expect("removing a selection preserves current search and other selections",
               draft.query == "oat" && draft.searchItems.count == 1 && draft.selected == ["Kefir", "Chia seeds"])
        expect("removed catalogue tag returns among available choices",
               draft.available(choices).compactMap { $0["name"] as? String } == ["Blueberries"])
        expect("next selection succeeds", draft.toggle("Oats"))
        expect("consecutive selections stay newest first and clear search", draft.selected == ["Oats", "Kefir", "Chia seeds"] && draft.search.isEmpty)

        draft.search = "My seed mix"
        expect("custom ingredient uses the same selection action", draft.toggle("My seed mix"))
        expect("custom ingredient is pinned and clears search", draft.selected.first == "My seed mix" && draft.search.isEmpty)
        expect("custom ingredient can be removed", draft.toggle("My seed mix"))
        let extras = draft.extraNames.map { ["name": $0] }
        expect("removed custom ingredient remains available to reselect",
               draft.available(extras).contains { $0["name"] as? String == "My seed mix" })
        expect("custom ingredient can be reselected", draft.toggle("My seed mix"))
        expect("custom ingredient has only one remembered choice",
               draft.extraNames.filter { $0 == "My seed mix" }.count == 1)

        var full = NativeMealIngredientPickerDraft(selected: (1...40).map { "Ingredient \($0)" })
        full.search = "Next ingredient"
        full.acceptSearch(["items": [["name": "Next ingredient"]]], for: "Next ingredient")
        expect("limit prevents a forty-first selection", !full.toggle("Next ingredient"))
        expect("blocked addition preserves search and existing tags", full.selected.count == 40 && full.query == "Next ingredient" && full.searchItems.count == 1)
        expect("at the limit an existing tag can still be removed", full.toggle("Ingredient 1"))
        expect("removing at the limit retains search ready for the next addition", full.query == "Next ingredient")
        expect("freed slot accepts next ingredient", full.toggle("Next ingredient"))
        expect("replacement is pinned without exceeding limit", full.selected.first == "Next ingredient" && full.selected.count == 40 && full.search.isEmpty)
        print("Ingredient picker checks: \(checks) passed")
    }
}
