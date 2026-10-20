import Foundation

/// One canonical directory feeds native discovery and the catalogue index.
/// Groups are memberships, so Subway can appear twice without two identities.
struct SearchPlace: Identifiable, Hashable, Decodable {
    enum Group: String, CaseIterable, Identifiable, Codable {
        case supermarket, cafe, restaurant
        var id: String { rawValue }
        var title: String { switch self { case .supermarket: "Supermarkets"; case .cafe: "Cafés & food to go"; case .restaurant: "Restaurant chains" } }
    }
    struct Matching: Hashable, Decodable {
        let brandAliases: [String]
        let retailerAliases: [String]
        let titleAliases: [String]
    }
    let id: String
    let title: String
    let groups: [Group]
    let aliases: [String]
    private let legacyStore: String?
    let matching: Matching
    enum CodingKeys: String, CodingKey { case id, title, groups, aliases, matching; case legacyStore = "store" }
    var store: ProductSearchStore? { legacyStore.flatMap(ProductSearchStore.init(rawValue:)) }
    var group: Group { groups.first ?? .restaurant }
    var menuAvailable: Bool { false }
    var type: String { group.rawValue }
    var isSupermarket: Bool { groups.contains(.supermarket) }
    static let all: [Self] = load()
    static func load(bundle: Bundle = .main) -> [Self] {
        struct Directory: Decodable { let version: String; let schemaVersion: Int; let market: String; let places: [SearchPlace] }
        guard let url = bundle.url(forResource: "places.v1", withExtension: "json", subdirectory: "Web/core"),
              let data = try? Data(contentsOf: url), data.count <= 200_000,
              let directory = try? JSONDecoder().decode(Directory.self, from: data), directory.schemaVersion == 1,
              directory.market == "unitedKingdom", !directory.version.isEmpty,
              !directory.places.isEmpty, directory.places.count <= 200,
              Set(directory.places.map(\.id)).count == directory.places.count,
              directory.places.allSatisfy({ !$0.id.isEmpty && !$0.title.isEmpty && !$0.groups.isEmpty && Set($0.groups).count == $0.groups.count && ($0.legacyStore == nil || $0.store != nil) }) else { return [] }
        return directory.places
    }
    func matches(_ query: String) -> Bool { ([title] + aliases).contains { SearchDiscoveryParser.normalized($0).contains(SearchDiscoveryParser.normalized(query)) } }
}

/// A place association is public catalogue evidence, never a verified menu or
/// a statement about current stock. Name-only candidates stay distinguishable.
struct ProductPlaceAssociation: Codable, Equatable {
    let placeID: String
    let relation: String
    let confidence: String
    let field: String
    let value: String
    var isCandidate: Bool { relation == "title_candidate" }
    var displayReason: String {
        switch relation { case "brand": "Brand match"; case "retailer": "Retailer listing"; default: "Name match · check product" }
    }
    var isValid: Bool {
        guard SearchPlace.all.contains(where: { $0.id == placeID }), !value.isEmpty, value.count <= 500,
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return false }
        switch relation {
        case "brand": return confidence == "source_metadata" && ["brands", "brands_tags"].contains(field)
        case "retailer": return confidence == "source_metadata" && ["stores", "stores_tags"].contains(field)
        case "title_candidate": return confidence == "candidate" && ["product_name", "product_name_en"].contains(field)
        default: return false
        }
    }
}
struct ProductPlaceEvidence: Codable, Equatable {
    let barcode: String
    let sourceFingerprint: String
    let version: String
    let associations: [ProductPlaceAssociation]
    var isValid: Bool {
        barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil &&
        sourceFingerprint.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil &&
        !version.isEmpty && version.count <= 100 && !associations.isEmpty && associations.count <= 100 &&
        associations.allSatisfy(\.isValid)
    }
    func association(for placeID: String, product: BarcodeProduct) -> ProductPlaceAssociation? {
        guard isValid, barcode == product.barcode, sourceFingerprint == product.catalogueSourceFingerprint else { return nil }
        return associations.filter { $0.placeID == placeID }.sorted { !$0.isCandidate && $1.isCandidate }.first
    }
}
enum SearchDietaryRequirement: String, CaseIterable, Identifiable, Codable {
    case gluten, lactose, milk, wheat, peanut, soya, vegan, vegetarian
    var id: String { rawValue }
    var title: String { switch self { case .gluten: "Gluten-free label"; case .lactose: "Lactose-free label"; case .milk: "Milk-free label"; case .wheat: "Wheat-free label"; case .peanut: "Peanut-free label"; case .soya: "Soya-free label"; case .vegan: "Vegan"; case .vegetarian: "Vegetarian" } }
}
enum SearchNutritionChoice: String, CaseIterable, Identifiable, Codable {
    case iron, calcium, vitd, protein, fibre, highfibre, wholegrain
    var id: String { rawValue }
    var title: String { switch self { case .iron: "Iron source"; case .calcium: "Calcium source"; case .vitd: "Vitamin D source"; case .protein: "Protein source"; case .fibre: "Fibre source"; case .highfibre: "High fibre"; case .wholegrain: "Wholegrain foods" } }
}
enum SearchNutritionMode: String, CaseIterable, Identifiable, Codable {
    case any, all
    var id: String { rawValue }
    var title: String { self == .any ? "Match any" : "Match all" }
}
struct SearchDiscoveryIntent {
    var text: String
    var place: SearchPlace?
    var category: ProductSearchCategory?
    var dietary: Set<SearchDietaryRequirement> = []
    var nutrition: Set<SearchNutritionChoice> = []
    var opensSaved = false
}
enum SearchDiscoveryParser {
    static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_GB"))
            .replacingOccurrences(of: "[’']", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[^a-z0-9&]+", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    static func parse(_ input: String) -> SearchDiscoveryIntent {
        var text = normalized(input)
        var result = SearchDiscoveryIntent(text: text)
        if ["saved", "saved products", "saved foods", "my foods", "favourites", "favorites", "wishlist", "wish list"].contains(text) { result.opensSaved = true; return result }
        func take(_ phrase: String) -> Bool {
            let normalizedPhrase = normalized(phrase)
            let pattern = "(?<![a-z0-9])" + NSRegularExpression.escapedPattern(for: normalizedPhrase) + "(?![a-z0-9])"
            guard text.range(of: pattern, options: .regularExpression) != nil else { return false }
            text = text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
            return true
        }
        let places = SearchPlace.all.flatMap { p in ([p.title] + p.aliases).map { ($0, p) } }.sorted { $0.0.count > $1.0.count }
        for (alias, place) in places where result.place == nil {
            let candidate = normalized(alias)
            // Short names can also identify unrelated foods or locations.
            // Explicit scope words or the full chain name establish intent.
            if candidate == "costa", text.range(of: #"\bcosta rica\b"#, options: .regularExpression) != nil { continue }
            let ambiguous = ["bear", "leon", "cote", "bills"].contains(candidate)
            let scoped = ["at ", "in ", "from "].contains { take($0 + alias) }
            if scoped || (!ambiguous && take(alias)) { result.place = place }
        }
        let dietary: [(SearchDietaryRequirement, [String])] = [(.gluten,["gluten free","gluten intolerance"]),(.lactose,["lactose free","lactose intolerance"]),(.milk,["milk free","dairy free"]),(.wheat,["wheat free"]),(.peanut,["peanut free","peanuts free"]),(.soya,["soya free","soy free"]),(.vegan,["vegan"]),(.vegetarian,["vegetarian"]) ]
        for (choice, phrases) in dietary { for phrase in phrases { if take(phrase) { result.dietary.insert(choice) } } }
        let nutrients: [(SearchNutritionChoice, [String])] = [(.highfibre,["high fibre","high fiber"]),(.vitd,["vitamin d source","vitamin d"]),(.iron,["iron source","iron"]),(.calcium,["calcium source","calcium"]),(.protein,["protein source","protein"]),(.fibre,["fibre source","fiber source","fibre","fiber"]),(.wholegrain,["wholegrain foods","wholegrain","whole grain"]) ]
        for (choice, phrases) in nutrients { for phrase in phrases { if take(phrase) { result.nutrition.insert(choice) } } }
        let categories: [(String,[String])] = [("yoghurt",["yoghurt","yogurt","yoghurts","yogurts"]),("bakery",["bread","breads","bakery"]),("pulses",["beans and pulses","beans & pulses"]),("fruit",["fruit"]),("vegetables",["vegetables"]),("dairy",["milk and dairy","milk & dairy"]),("eggs",["eggs"]),("cheese",["cheese"]),("rice",["rice"]),("pasta",["pasta","noodles"]),("nuts",["nuts"]),("frozen",["frozen food"])]
        // A menu request keeps all actual food constraints; grocery taxonomy
        // is not an authoritative restaurant section list.
        let hasCompoundIntent = result.place != nil || !result.dietary.isEmpty || !result.nutrition.isEmpty || text.split(whereSeparator: \.isWhitespace).count > 1
        if hasCompoundIntent && (result.place?.group == .supermarket || result.place == nil) {
            for (id, terms) in categories where result.category == nil { for term in terms { if take(term) { result.category = ProductSearchCategory.all.first { $0.id == id }; break } } }
        }
        text = text.replacingOccurrences(of: "\\bsoy\\b", with: "soya", options: .regularExpression)
        result.text = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return result
    }
}
