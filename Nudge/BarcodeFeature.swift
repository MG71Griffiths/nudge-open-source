import AVFoundation
import CoreFoundation
import CryptoKit
import Foundation
import JavaScriptCore
import UIKit
import Vision
import VisionKit
import WebKit

struct NutrientValue: Codable, Equatable {
    let value: Double?
    let unit: String
    let status: String
    var relation: String? = nil

    static func supplied(_ value: Double?, unit: String) -> NutrientValue {
        NutrientValue(value: value, unit: unit, status: value == nil ? "unknown" : "supplied")
    }
}

enum PortionCalculator {
    static func scaled(per100: Double?, amount: Double) -> Double? {
        guard let per100, per100.isFinite, per100 >= 0, amount.isFinite, amount > 0 else { return nil }
        return (per100 * amount / 100 * 10).rounded() / 10
    }
}

/// OFF's parsed ingredient records are evidence, not a plant/allergy safety verdict.
/// Estimated percentages and allergen/trace tags are never promoted to ingredients.
struct ProductIngredient: Codable, Equatable {
    let id: String?
    let text: String?
    let percent: Double?
    let vegan: String?
    let vegetarian: String?
}

/// Provider evidence from the explicitly versioned OFF 2023 record. Unknown
/// flags and component values remain absent, rather than becoming false or zero.
struct ProductNutriScore2023: Codable, Equatable {
    struct Component: Codable, Equatable {
        let id: String
        let value: Double?
        let unit: String
        let points: Int
        let pointsMax: Int
    }
    struct Components: Codable, Equatable {
        let negative: [Component]
        let positive: [Component]
    }
    let methodId: String
    let version: String
    let computed: Bool?
    let applicable: Bool?
    let categoryAvailable: Bool?
    let nutrientsAvailable: Bool?
    let grade: String?
    let rawScore: Int?
    let components: Components?
    let isBeverage: Bool?
    let isCheese: Bool?
    let isWater: Bool?
    let isFatOilNutsSeeds: Bool?
    let isRedMeatProduct: Bool?
    let negativePoints: Int?
    let positivePoints: Int?
    let negativePointsMax: Int?
    let positivePointsMax: Int?
    let positiveNutrients: [String]?
    let countProteins: Bool?
    let countProteinsReason: String?
    let preparation: String?
    let estimated: Bool?
}

/// OFF's computed result is retained with its input identity. It is not a bare
/// letter grade: edits to the nutrition record invalidate the binding.
struct ProductProviderNutriScore: Codable, Equatable {
    let version: String
    let grade: String
    let rawScore: Int
    let category: String
    let preparation: String
    let estimated: Bool
    let source: String
    let sourceURL: String
    let barcode: String
    let computed: Bool
    let applicable: Bool
    let categoryAvailable: Bool
    let nutrientsAvailable: Bool
    let negativePoints: Int
    let positivePoints: Int
    let countProteins: Bool
    let components: ProductNutriScore2023.Components
    var factsFingerprint: String
}

/// Parsing happens on several service queues. Keep one copy of the shared
/// validator on a serial queue, and bind only at the trusted OFF decode boundary.
/// Saved records are decoded as-is; this never rebinds edited/cached facts.
private final class ProductProviderScoreDecoder: @unchecked Sendable {
    static let shared = ProductProviderScoreDecoder()
    private let queue = DispatchQueue(label: "com.nudge.provider-score-decoder")
    private var context: JSContext?
    private var loaded = false

    func bind(_ evidence: ProductProviderNutriScore, to product: BarcodeProduct) -> ProductProviderNutriScore? {
        guard let data = try? JSONEncoder().encode(product),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return queue.sync {
            if !loaded {
                loaded = true
                if let url = Bundle.main.resourceURL?.appendingPathComponent("Web/core/nudge-score.js"),
                   let source = try? String(contentsOf: url, encoding: .utf8), let runtime = JSContext() {
                    runtime.evaluateScript(source, withSourceURL: url)
                    if runtime.exception == nil { context = runtime }
                }
            }
            guard let context, let core = context.objectForKeyedSubscript("NudgeScoreCore") else { return nil }
            context.exception = nil
            guard let fingerprint = core.invokeMethod("providerInputFingerprint", withArguments: [object])?.toString(),
                  !fingerprint.isEmpty, fingerprint != "undefined", context.exception == nil else { return nil }
            var result = evidence
            result.factsFingerprint = fingerprint
            guard let bytes = try? JSONEncoder().encode(result), let provider = try? JSONSerialization.jsonObject(with: bytes) else { return nil }
            var scored = object; scored["providerNutriScore"] = provider
            guard core.invokeMethod("providerScore", withArguments: [scored])?.toDictionary()?["available"] as? Bool == true,
                  context.exception == nil else { return nil }
            return result
        }
    }
}

struct ProductScoringFacts: Codable, Equatable {
    struct Percentage: Codable, Equatable {
        let value: Double
        let source: String
        let evidence: String
    }
    let fvlPercent: Percentage?
    let isBeverage: Bool?
    let isCheese: Bool?
    let isWater: Bool?
    let isFatOilNutsSeeds: Bool?
    let isRedMeatProduct: Bool?
    let hasNonNutritiveSweeteners: Bool?
    let source: String
}

/// A server calculation remains bound to the exact public facts and calculator
/// versions it used. Edited or expired records fall back to local calculation.
struct ProductCatalogueRating: Codable, Equatable {
    let method: String
    let version: String
    let classifierVersion: String
    let sourceRevision: Int?
    let fetchedAt: Date
    let expiresAt: Date
    let calculatedAt: Date
    let snapshotFingerprint: String
    let scoreData: Data
    var qualityHoldOrigin: String? = nil

    /// A server source-quality decision is separate from the nutrient model.
    /// Time alone cannot make conflicting, unchanged facts safe to score.
    func qualityHold(for product: BarcodeProduct, at now: Date) -> [String: Any]? {
        guard let origin = qualityHoldOrigin, let originURL = URL(string: origin),
              ProductCommunityProvenance.origin(originURL) == origin,
              product.hasTrustedCatalogueSource, snapshotFingerprint == Self.fingerprint(product),
              fetchedAt <= now.addingTimeInterval(60), calculatedAt >= fetchedAt,
              calculatedAt <= now.addingTimeInterval(60),
              let score = try? JSONSerialization.jsonObject(with: scoreData) as? [String: Any],
              score["methodId"] as? String == method, score["version"] as? String == version,
              score["classifierVersion"] as? String == classifierVersion,
              score["status"] as? String == "unrated", score["available"] as? Bool == false,
              score["scoreBasis"] as? String == "catalogue_quality_hold",
              ["value", "grade", "rawScore", "rawLower", "rawUpper", "displayLower", "displayUpper"].allSatisfy({ score[$0] == nil || score[$0] is NSNull }),
              (score["reasonCodes"] as? [String])?.contains("catalogue_quality_hold") == true,
              let hold = score["catalogueQualityHold"] as? [String: Any],
              hold["version"] as? String == "catalogue-quality-hold-v1",
              hold["barcode"] as? String == product.barcode,
              let fingerprint = hold["sourceFingerprint"] as? String,
              fingerprint == product.catalogueSourceFingerprint,
              fingerprint.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              ["runID", "reviewID"].allSatisfy({ (hold[$0] as? String)?.range(of: #"^[A-Za-z0-9_-]{8,80}$"#, options: .regularExpression) != nil }),
              (hold["candidateSHA256"] as? String)?.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              ["source_salt_sodium_conflict", "source_alcohol_not_represented", "source_identity_conflict"].contains(hold["reasonCode"] as? String ?? "") else { return nil }
        func timestamp(_ key: String) -> Double? {
            guard let n = hold[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue.isFinite, n.doubleValue > 0, n.doubleValue.rounded() == n.doubleValue,
                  n.doubleValue <= now.addingTimeInterval(60).timeIntervalSince1970 * 1000 else { return nil }
            return n.doubleValue
        }
        guard let source = timestamp("sourceFetchedAt"), let reviewed = timestamp("reviewedAt"),
              reviewed >= source, source <= fetchedAt.timeIntervalSince1970 * 1000 + 1 else { return nil }
        return score
    }

    /// Recovered evidence has its own shorter validity window. Its expiry
    /// never extends the original public facts' retrieval or expiry dates.
    var effectiveExpiresAt: Date {
        guard let score = try? JSONSerialization.jsonObject(with: scoreData) as? [String: Any],
              let marker = score["catalogueEnrichment"] else { return expiresAt }
        guard let evidence = marker as? [String: Any],
              evidence["version"] as? String == "catalogue-enrichment-v1",
              let fingerprint = evidence["sourceFingerprint"] as? String,
              fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let milliseconds = evidence["expiresAt"] as? NSNumber,
              CFGetTypeID(milliseconds) != CFBooleanGetTypeID(), milliseconds.doubleValue.isFinite,
              milliseconds.doubleValue > 0, milliseconds.doubleValue.rounded() == milliseconds.doubleValue else { return .distantPast }
        return min(expiresAt, Date(timeIntervalSince1970: milliseconds.doubleValue / 1000))
    }

    static func fingerprint(_ product: BarcodeProduct) -> String? {
        var facts = product
        facts.catalogueRating = nil
        // A retained display reference is not a new provider fact or nutrition
        // input. Keeping a missing thumbnail must not invalidate its score.
        facts.retainedPublicImageURL = nil
        facts.catalogueSourceFingerprint = nil
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(facts) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

struct BarcodeProduct: Codable, Equatable {
    let barcode: String
    let name: String
    let brand: String?
    let packSize: String?
    let ingredients: String?
    let allergens: [String]?
    let traces: [String]?
    let basisUnit: String
    let servingAmount: Double?
    let servingUnit: String?
    let nutrients: [String: NutrientValue]
    var sourceName: String
    var sourceURL: String
    let retrievedAt: String
    var licenceName: String
    var licenceURL: String
    var servingNutrients: [String: NutrientValue]? = nil
    var servingNutrientSource: [String: String]? = nil
    var servingPreparation: String? = nil
    var categories: [String] = []
    var stores: [String] = []
    var labelsTags: [String] = []
    var lastModifiedAt: String? = nil
    var dataQualityWarnings: [String] = []
    var retailer: String? = nil
    var servingLabel: String? = nil
    var alternativeReason: String? = nil
    var imageURL: String? = nil
    var retainedPublicImageURL: String? = nil
    var nutriScoreGrade: String? = nil
    var nutriScore2023: ProductNutriScore2023? = nil
    var providerNutriScore: ProductProviderNutriScore? = nil
    var scoringSourceVersion: String? = nil
    var novaGroup: Int? = nil
    var additiveTags: [String]? = nil
    var nutritionPreparation: String? = nil
    var servingDescription: String? = nil
    var packAmount: Double? = nil
    var packUnit: String? = nil
    var packPreparation: String? = nil
    var ingredientItems: [ProductIngredient]? = nil
    var allergensText: String? = nil
    var tracesText: String? = nil
    var countriesTags: [String] = []
    var nutrientSources: [String: String] = [:]
    var energyKj: NutrientValue? = nil
    var scoringFacts: ProductScoringFacts? = nil
    var ingredientsAnalysisTags: [String] = []
    // Optional for backwards-compatible cached records. Values are mg per the
    // same 100 g/ml and preparation as the nutrition profile, never per serving.
    var micronutrients: [String: NutrientValue]? = nil
    // Discovery snapshots can predate the live product record. Keep their
    // provenance explicit and refresh the barcode when the product is opened.
    var searchProvider: String? = nil
    var searchIndexedAt: String? = nil
    var catalogueRating: ProductCatalogueRating? = nil
    var catalogueSourceExpiresAt: Date? = nil
    var catalogueSourceFingerprint: String? = nil
    var sourceKind: String? = nil
    var communityProvenance: ProductCommunityProvenance? = nil

    var displayImageURL: String? {
        if let imageURL, CatalogueProductImages.sourceURL(imageURL) != nil { return imageURL }
        guard sourceName == "Open Food Facts", hasTrustedCatalogueSource,
              let retainedPublicImageURL, Self.exactPublicImage(retainedPublicImageURL, barcode: barcode) else { return nil }
        return retainedPublicImageURL
    }

    /// Preserve only a public catalogue picture for the same identified pack.
    /// An omitted field is not evidence that a previously supplied photo was
    /// removed. Primary source images always take precedence over this fallback.
    func retainingPublicImage(from previous: BarcodeProduct) -> BarcodeProduct {
        guard retainedPublicImageURL == nil, sourceName == "Open Food Facts", previous.sourceName == sourceName,
              hasTrustedCatalogueSource, previous.hasTrustedCatalogueSource, barcode == previous.barcode,
              Self.imageIdentity(name) == Self.imageIdentity(previous.name),
              Self.compatibleImageIdentity(brand, previous.brand), Self.compatibleImageIdentity(packSize, previous.packSize),
              let source = previous.displayImageURL, Self.exactPublicImage(source, barcode: barcode), source != imageURL else { return self }
        var result = self
        result.retainedPublicImageURL = source
        return result
    }

    private static func imageIdentity(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_GB"))
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    private static func compatibleImageIdentity(_ first: String?, _ second: String?) -> Bool {
        guard let first, let second, !first.isEmpty, !second.isEmpty else { return true }
        return imageIdentity(first) == imageIdentity(second)
    }
    private static func exactPublicImage(_ source: String, barcode: String) -> Bool {
        guard let url = CatalogueProductImages.sourceURL(source) else { return false }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[0] == "images", parts[1] == "products" else { return false }
        let identity = parts.dropFirst(2).dropLast()
        return !identity.isEmpty && identity.allSatisfy { $0.range(of: #"^[0-9]+$"#, options: .regularExpression) != nil }
            && identity.joined() == barcode
    }

    var hasTrustedCatalogueSource: Bool {
        if sourceName == "Open Food Facts" { return communityProvenance == nil && (sourceKind == nil || sourceKind == "open_food_facts") }
        guard sourceName == "Nudge community", sourceKind == "nudge_community", let proof = communityProvenance,
              let origin = URL(string: proof.backendOrigin), ProductCommunityProvenance.origin(origin) == proof.backendOrigin,
              sourceURL == proof.backendOrigin + "/v1/products/reviewed/" + barcode,
              proof.observedAt.timeIntervalSince1970 > 0, proof.reviewedAt >= proof.observedAt else { return false }
        return true
    }

    var hasCurrentScoringSource: Bool { scoringSourceVersion == "off-nutriscore-2023-v3" }
}

/// Created only after an authenticated catalogue response has matched the
/// configured backend origin. Retained with public facts for offline reuse.
struct ProductCommunityProvenance: Codable, Equatable {
    let backendOrigin: String
    let observedAt: Date
    let reviewedAt: Date
    static func origin(_ url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port == nil || parts.port == 443, ["", "/"].contains(parts.percentEncodedPath) else { return nil }
        return "https://" + host
    }
}

enum BarcodeLookupError: Error, Equatable {
    case invalidBarcode
    case notFound
    case incompleteProduct
    case offline
    case timeout
    case rateLimited
    case retryLater(Int)
    case productReadDeferred(Int)
    case server(Int)
    case invalidResponse

    var code: String {
        switch self {
        case .invalidBarcode: "invalidBarcode"
        case .notFound: "notFound"
        case .incompleteProduct: "incompleteProduct"
        case .offline: "offline"
        case .timeout: "timeout"
        case .rateLimited, .retryLater, .productReadDeferred: "rateLimited"
        case .server: "server"
        case .invalidResponse: "invalidResponse"
        }
    }

    var message: String {
        switch self {
        case .invalidBarcode:
            "That code is not a supported grocery barcode."
        case .notFound:
            "Nudge’s catalogue does not have this barcode yet. Nothing has been added to your diary."
        case .incompleteProduct:
            "Nudge’s catalogue has this barcode, but no product name to confirm its identity. Nothing has been added."
        case .offline:
            "Nudge could not reach its product catalogue. Check your connection and try scanning again."
        case .timeout:
            "The product lookup timed out. Try again or photograph the label."
        case .rateLimited:
            "Nudge’s product catalogue is receiving too many requests. Wait a moment and try again."
        case .retryLater(let seconds), .productReadDeferred(let seconds):
            "Product details are waiting for the product catalogue. Try again in \(seconds) seconds."
        case .server:
            "Nudge’s product catalogue is temporarily unavailable. Try again later."
        case .invalidResponse:
            "Nudge could not read the product catalogue response. Try again later."
        }
    }

    var retryAfterSeconds: Int {
        switch self {
        case .rateLimited: 60
        case .retryLater(let seconds), .productReadDeferred(let seconds): max(1, seconds)
        default: 0
        }
    }
}

enum OpenFoodFactsParser {
    static let nutrientFields: [(key: String, legacyCandidates: [String], structuredCandidates: [String], unit: String)] = [
        ("energyKcal", ["energy-kcal_100g"], ["energy-kcal"], "kcal"),
        ("protein", ["proteins_100g"], ["proteins"], "g"),
        ("carbohydrate", ["carbohydrates_100g"], ["carbohydrates"], "g"),
        ("sugars", ["sugars_100g"], ["sugars"], "g"),
        ("fat", ["fat_100g"], ["fat"], "g"),
        ("saturatedFat", ["saturated-fat_100g"], ["saturated-fat"], "g"),
        ("fibre", ["fiber_100g", "fibre_100g"], ["fiber", "fibre"], "g"),
        ("salt", ["salt_100g"], ["salt"], "g")
    ]

    static func parse(data: Data, barcode requestedBarcode: String, retrievedAt: Date = Date()) throws -> BarcodeProduct {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BarcodeLookupError.invalidResponse
        }
        if let status = root["status"] as? Int, status == 0 {
            throw BarcodeLookupError.notFound
        }
        if let status = root["status"] as? String,
           ["not found", "not_found"].contains(status.lowercased()) {
            throw BarcodeLookupError.notFound
        }
        if let errors = root["errors"] as? [[String: Any]], errors.contains(where: {
            let id = ($0["message"] as? [String: Any])?["id"] as? String ?? $0["id"] as? String
            return id == "product_not_found"
        }) { throw BarcodeLookupError.notFound }
        if (root["status"] as? String)?.lowercased() == "failure" { throw BarcodeLookupError.invalidResponse }
        guard let product = root["product"] as? [String: Any] else {
            throw BarcodeLookupError.invalidResponse
        }

        let barcode = nonempty(product["code"]) ?? requestedBarcode
        guard barcode.range(of: #"^\d{4,18}$"#, options: .regularExpression) != nil else {
            throw BarcodeLookupError.invalidBarcode
        }
        guard let name = firstNonempty(product, keys: ["product_name_en", "product_name"]) else {
            throw BarcodeLookupError.incompleteProduct
        }

        let nutriments = product["nutriments"] as? [String: Any] ?? [:]
        let aggregatedSet = ((product["nutrition"] as? [String: Any])?["aggregated_set"] as? [String: Any])
        let structuredNutrients: [String: Any]
        if let aggregatedSet,
           ["100g", "100ml"].contains((nonempty(aggregatedSet["per"]) ?? "").lowercased()) {
            structuredNutrients = aggregatedSet["nutrients"] as? [String: Any] ?? [:]
        } else {
            structuredNutrients = [:]
        }
        let preparation = nonempty(aggregatedSet?["preparation"])
        // Legacy *_100g values describe the product as sold. Never fill gaps in
        // a prepared-food profile with as-sold values from the other profile.
        let noNutrition = ["on", "true", "1"].contains((nonempty(product["no_nutrition_data"]) ?? "").lowercased())
        let preparedOnly = aggregatedSet == nil && nonempty(product["nutrition_data"]) != "on"
            && nonempty(product["nutrition_data_prepared"]) == "on"
        let canUseLegacy = preparation != "prepared" && !noNutrition && !preparedOnly
        var nutrients: [String: NutrientValue] = [:]
        for field in nutrientFields {
            if let structured = field.structuredCandidates.lazy.compactMap({ structuredNutrient(structuredNutrients[$0], unit: field.unit) }).first {
                nutrients[field.key] = structured
            } else {
                let key = canUseLegacy ? field.legacyCandidates.first(where: { number(nutriments[$0]) != nil }) : nil
                let value = key.flatMap { number(nutriments[$0]) }
                nutrients[field.key] = NutrientValue(value: value, unit: field.unit, status: value == nil ? "unknown" : "supplied",
                    relation: key.flatMap { nonempty(nutriments[$0.replacingOccurrences(of: "_100g", with: "_modifier")]) })
            }
        }
        var saltConversionSource: String?
        if nutrients["salt"]?.value == nil {
            let item = structuredNutrients["sodium"] as? [String: Any]
            let unit = (nonempty(item?["unit"]) ?? "").lowercased()
            var sodium: Double?, sodiumUnit = "g", sodiumRelation: String?
            if let item, ["g", "mg"].contains(unit), nonempty(item["source"])?.lowercased() != "estimate" {
                sodium = number(item["value"]); sodiumUnit = unit; sodiumRelation = nonempty(item["modifier"])
            }
            if sodium == nil, canUseLegacy {
                sodium = number(nutriments["sodium_100g"]); sodiumUnit = "g"; sodiumRelation = nonempty(nutriments["sodium_modifier"])
            }
            if let sodium, sodium >= 0 {
                let salt = sodium * 2.5 / (sodiumUnit == "mg" ? 1000 : 1)
                if salt.isFinite, salt <= 100 {
                    nutrients["salt"] = NutrientValue(value: salt, unit: "g", status: "calculated", relation: sodiumRelation)
                    saltConversionSource = sodiumUnit == "mg" ? "Calculated from source sodium (mg × 2.5 ÷ 1000)" : "Calculated from source sodium (g × 2.5)"
                }
            }
        }
        let structuredEnergy = structuredKilojoules(structuredNutrients)
        if nutrients["energyKcal"]?.value == nil,
           let kilojoules = structuredEnergy?.value ?? (canUseLegacy ? number(nutriments["energy_100g"]) : nil) {
            nutrients["energyKcal"] = NutrientValue(
                value: (kilojoules / 4.184 * 10).rounded() / 10,
                unit: "kcal",
                status: structuredEnergy?.status == "estimated" ? "estimated" : "calculated",
                relation: structuredEnergy != nil ? structuredEnergy?.relation : nonempty(nutriments["energy_modifier"])
            )
        }

        let quantityUnit = (nonempty(product["product_quantity_unit"]) ?? "").lowercased()
        let servingUnit = (nonempty(product["serving_quantity_unit"]) ?? "").lowercased()
        let quantityText = (nonempty(product["quantity"]) ?? "").lowercased()
        let servingDescription = nonempty(product["serving_size"])
        let servingText = (servingDescription ?? "").lowercased()
        let structuredPer = (nonempty(aggregatedSet?["per"]) ?? "").lowercased()
        let legacyPer = canUseLegacy ? (nonempty(product["nutrition_data_per"]) ?? "").lowercased() : ""
        let nutritionPer = ["100g", "100ml"].contains(structuredPer) ? structuredPer : legacyPer
        let liquidHint = isLiquid(unit: servingUnit) || isLiquid(unit: quantityUnit)
            || containsLiquidUnit(quantityText) || containsLiquidUnit(servingText)
        let basisUnit = nutritionPer == "100g" ? "g" : nutritionPer == "100ml" ? "ml" : liquidHint ? "ml" : "g"
        let allergens = tagList(product["allergens_tags"]) ?? textList(product["allergens"])
        let traces = tagList(product["traces_tags"]) ?? textList(product["traces"])

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        var result = BarcodeProduct(
            barcode: barcode,
            name: name,
            brand: firstNonempty(product, keys: ["brands"]),
            packSize: firstNonempty(product, keys: ["quantity"]),
            ingredients: firstNonempty(product, keys: ["ingredients_text_en", "ingredients_text"]),
            allergens: allergens,
            traces: traces,
            basisUnit: basisUnit,
            servingAmount: normalisedServingAmount(
                number(product["serving_quantity"]),
                unit: servingUnit,
                basisUnit: basisUnit
            ) ?? printedServing(servingText, basisUnit: basisUnit),
            servingUnit: basisUnit,
            nutrients: nutrients,
            sourceName: "Open Food Facts",
            sourceURL: "https://world.openfoodfacts.org/product/\(barcode)",
            retrievedAt: formatter.string(from: retrievedAt),
            licenceName: "Open Database Licence (ODbL)",
            licenceURL: "https://opendatacommons.org/licenses/odbl/1-0/"
        )
        // OFF documents *_value as contributor-entered data, interpreted using
        // nutrition_data_per. *_serving is computed and is never treated as a
        // separately declared serving value. Require a printed physical amount.
        // https://openfoodfacts.github.io/documentation/docs/Product-Opener/schemas/schemas/product_nutrition/
        if canUseLegacy, nonempty(product["nutrition_data_per"]) == "serving",
           let printedAmount = printedServing(servingText, basisUnit: basisUnit),
           let servingAmount = result.servingAmount, abs(printedAmount - servingAmount) < 0.001 {
            var declared: [String: NutrientValue] = [:]
            for field in nutrientFields {
                for key in field.structuredCandidates {
                    guard let value = number(nutriments[key + "_value"]),
                          let unit = nonempty(nutriments[key + "_unit"]), unit.lowercased() == field.unit.lowercased() else { continue }
                    let relation = nonempty(nutriments[key + "_modifier"])
                    guard relation == nil || ["=", "eq"].contains(relation!) else { continue }
                    declared[field.key] = NutrientValue(value: value, unit: field.unit, status: "supplied", relation: relation)
                    break
                }
            }
            if !declared.isEmpty {
                result.servingNutrients = declared
                result.servingNutrientSource = ["title":"Open Food Facts contributor-entered per-serving values", "url":result.sourceURL, "basis":"entered_per_serving"]
                result.servingPreparation = "as_sold"
            }
        }
        let micronutrientBasisKnown = aggregatedSet == nil ||
            (["100g", "100ml"].contains(nutritionPer) && ["as_sold", "prepared"].contains(preparation ?? ""))
        var micronutrients: [String: NutrientValue] = [:]
        for key in ["iron", "calcium"] {
            var item: NutrientValue?
            if micronutrientBasisKnown, let raw = structuredNutrients[key] as? [String: Any] {
                // Unlike macronutrients, explicitly require the mineral's unit.
                let unit = (nonempty(raw["unit"]) ?? "").lowercased()
                if ["g", "mg", "µg", "ug", "mcg"].contains(unit),
                   let parsed = structuredNutrient(raw, unit: unit), let value = parsed.value {
                    let milligrams = value * (unit == "g" ? 1000 : unit == "mg" ? 1 : 0.001)
                    if milligrams <= 100_000 { item = NutrientValue(value: milligrams, unit: "mg", status: parsed.status, relation: parsed.relation) }
                }
            } else if aggregatedSet == nil, canUseLegacy, let grams = number(nutriments[key + "_100g"]), grams <= 100 {
                // OFF normalises *_100g mineral fields to grams, regardless of
                // the contributor-facing *_unit used to enter the label value.
                item = NutrientValue(value: grams * 1000, unit: "mg", status: "supplied", relation: nonempty(nutriments[key + "_modifier"]))
            }
            micronutrients[key] = item ?? NutrientValue(value: nil, unit: "mg", status: "unknown")
            if item?.value != nil {
                result.nutrientSources[key] = (structuredNutrients[key] as? [String: Any]).flatMap { nonempty($0["source"]) }
                    ?? (aggregatedSet == nil ? "Open Food Facts legacy nutriments" : "Open Food Facts structured nutrition")
            }
        }
        result.micronutrients = micronutrients
        result.imageURL = productImageURL(product)
        result.servingDescription = servingDescription
        result.packAmount = normalisedPackAmount(number(product["product_quantity"]), unit: quantityUnit, basisUnit: basisUnit)
            ?? printedPackAmount(quantityText, basisUnit: basisUnit)
        result.packUnit = result.packAmount == nil ? nil : basisUnit
        result.packPreparation = result.packAmount == nil ? nil : "as_sold"
        result.ingredientItems = ingredientItems(product["ingredients"])
        let suitability = Set(["en:vegan", "en:non-vegan", "en:vegetarian", "en:non-vegetarian"])
        result.ingredientsAnalysisTags = Array(Set((product["ingredients_analysis_tags"] as? [String] ?? [])
            .filter { suitability.contains($0) })).sorted()
        // These retain source wording. Factory advice remains in ingredients text;
        // it must not be silently re-labelled as a declared ingredient or a trace.
        result.allergensText = nonempty(product["allergens"])
        result.tracesText = nonempty(product["traces"])
        result.labelsTags = Array((product["labels_tags"] as? [String] ?? []).filter(FoodAlternatives.validCategory).prefix(60))
        if let seconds = number(product["last_modified_t"]) { result.lastModifiedAt = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: seconds)) }
        result.dataQualityWarnings = Array(((product["data_quality_errors_tags"] as? [String] ?? []) + (product["data_quality_warnings_tags"] as? [String] ?? [])).prefix(40))
        result.countriesTags = Array((product["countries_tags"] as? [String] ?? []).filter(FoodAlternatives.validCategory).prefix(60))
        for field in nutrientFields where nutrients[field.key]?.value != nil {
            if let item = field.structuredCandidates.lazy.compactMap({ structuredNutrients[$0] as? [String: Any] })
                .first(where: { structuredNutrient($0, unit: field.unit) != nil }) {
                result.nutrientSources[field.key] = nonempty(item["source"]) ?? "Open Food Facts structured nutrition"
            } else if canUseLegacy, field.legacyCandidates.contains(where: { number(nutriments[$0]) != nil }) {
                result.nutrientSources[field.key] = "Open Food Facts legacy nutriments"
            } else if field.key == "energyKcal" {
                result.nutrientSources[field.key] = "Calculated from source kilojoules (kJ ÷ 4.184)"
            }
        }
        // Scoring uses the original per-100 kJ declaration, which can differ
        // from independently rounded kcal. Never turn an estimate into a label fact.
        if let saltConversionSource { result.nutrientSources["salt"] = saltConversionSource }
        if let structuredEnergy {
            result.energyKj = structuredEnergy
            let energyItem = (["energy-kj", "energy"].compactMap { structuredNutrients[$0] as? [String: Any] }).first { (nonempty($0["unit"]) ?? "").lowercased() == "kj" }
            result.nutrientSources["energyKj"] = nonempty(energyItem?["source"]) ?? "Open Food Facts structured nutrition"
        } else if canUseLegacy,
                  let sourceKj = number(nutriments["energy-kj_100g"])
                    ?? ((nonempty(nutriments["energy_unit"]) ?? "").lowercased() == "kj" ? number(nutriments["energy_100g"]) : nil) {
            result.energyKj = NutrientValue(value: sourceKj, unit: "kJ", status: "supplied",
                relation: nonempty(nutriments["energy-kj_modifier"]) ?? nonempty(nutriments["energy_modifier"]))
            result.nutrientSources["energyKj"] = "Open Food Facts legacy nutriments"
        }
        if let grade = firstNonempty(product, keys: ["nutriscore_grade", "nutrition_grades"])?.lowercased(),
           ["a", "b", "c", "d", "e"].contains(grade) { result.nutriScoreGrade = grade }
        result.nutriScore2023 = nutriScore2023(product["nutriscore"])
        if let grade = result.nutriScore2023?.grade { result.nutriScoreGrade = grade.lowercased() }
        // Category decisions are explicit provider evidence; missing decisions
        // remain unknown. Ingredient percentage estimates from OFF's score
        // components must not be re-labelled as exact declarations.
        let category = result.nutriScore2023.flatMap { $0.categoryAvailable == true ? $0 : nil }
        var fvl: ProductScoringFacts.Percentage?
        if let item = structuredNutrients["fruits-vegetables-legumes"] as? [String: Any],
           let source = nonempty(item["source"]), ["packaging", "manufacturer"].contains(source.lowercased()),
           nonempty(item["modifier"]) == nil || ["=", "eq"].contains(nonempty(item["modifier"]) ?? ""),
           nonempty(item["unit"]) == "%", let percent = number(item["value"]), percent <= 100 {
            fvl = .init(value: percent, source: "declared", evidence: "Open Food Facts \(source): fruits-vegetables-legumes \(percent)%")
        }
        if category != nil || fvl != nil {
            result.scoringFacts = ProductScoringFacts(fvlPercent: fvl,
                isBeverage: category?.isBeverage, isCheese: category?.isCheese, isWater: category?.isWater,
                isFatOilNutsSeeds: category?.isFatOilNutsSeeds, isRedMeatProduct: category?.isRedMeatProduct,
                hasNonNutritiveSweeteners: nil,
                source: "Open Food Facts: explicitly supplied 2023 category flags and/or declared ingredient percentage")
        }
        if let group = number(product["nova_group"]), group.rounded() == group, (1...4).contains(group) {
            result.novaGroup = Int(group)
        }
        if let tags = product["additives_tags"] as? [String] {
            result.additiveTags = Array(Set(tags.filter {
                $0.range(of: #"^en:e[0-9]{3,4}[a-z]?(?:-[ivx]+)?$"#, options: .regularExpression) != nil
            })).sorted()
        }
        if let preparation, ["as_sold", "prepared"].contains(preparation) {
            result.nutritionPreparation = preparation
        } else if aggregatedSet == nil, nutrients.values.contains(where: { $0.value != nil }) || micronutrients.values.contains(where: { $0.value != nil }) {
            result.nutritionPreparation = "as_sold"
        }
        result.categories = (product["categories_tags"] as? [String] ?? []).filter(FoodAlternatives.validCategory)
        result.stores = Array((product["stores_tags"] as? [String] ?? textList(product["stores"]) ?? []).prefix(30))
        result.retailer = FoodAlternatives.retailer(brand: result.brand, stores: result.stores)
        if result.servingAmount != nil {
            let prefix = (servingDescription ?? "").components(separatedBy: "(").first?.trimmingCharacters(in: .whitespaces) ?? ""
            result.servingLabel = prefix.range(of: #"\b(tablespoons?|teaspoons?|tbsp|tsp|slices?|pieces?|squares?|chunks?|pots?|cups?|packs?)\b"#,
                options: [.regularExpression, .caseInsensitive]) != nil ? String(prefix.prefix(120)) : "portion"
        }
        result.scoringSourceVersion = "off-nutriscore-2023-v3"
        result.providerNutriScore = providerNutriScore(result)
        return result
    }

    private static func providerNutriScore(_ product: BarcodeProduct) -> ProductProviderNutriScore? {
        guard let score = product.nutriScore2023, score.version == "2023", score.computed == true,
              score.applicable == true, score.categoryAvailable == true, score.nutrientsAvailable == true,
              let grade = score.grade, let raw = score.rawScore, (-30...60).contains(raw),
              let preparation = score.preparation, ["as_sold", "prepared"].contains(preparation),
              preparation == product.nutritionPreparation, let estimated = score.estimated,
              let water = score.isWater, let beverage = score.isBeverage, let cheese = score.isCheese,
              let fats = score.isFatOilNutsSeeds, let redMeat = score.isRedMeatProduct,
              (!water || beverage), [cheese, fats, redMeat].filter({ $0 }).count <= 1,
              !(beverage && (cheese || fats || redMeat)), let components = score.components,
              let negative = score.negativePoints, let positive = score.positivePoints,
              let proteins = score.countProteins else { return nil }
        let category = water ? "water" : beverage ? "beverage" : cheese ? "cheese" : fats ? "fats_nuts_seeds" : redMeat ? "red_meat" : "general"
        let result = ProductProviderNutriScore(version: "2023", grade: grade, rawScore: raw, category: category,
            preparation: preparation, estimated: estimated, source: "Open Food Facts", sourceURL: product.sourceURL,
            barcode: product.barcode, computed: true, applicable: true, categoryAvailable: true, nutrientsAvailable: true,
            negativePoints: negative, positivePoints: positive, countProteins: proteins, components: components, factsFingerprint: "")
        return ProductProviderScoreDecoder.shared.bind(result, to: product)
    }

    private static func nutriScore2023(_ raw: Any?) -> ProductNutriScore2023? {
        guard let versions = raw as? [String: Any], let record = versions["2023"] as? [String: Any] else { return nil }
        func integer(_ value: Any?, minimum: Int = 0, maximum: Int = 100) -> Int? {
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue,
                  n.doubleValue >= Double(minimum), n.doubleValue <= Double(maximum) else { return nil }
            return n.intValue
        }
        func flag(_ value: Any?) -> Bool? {
            // OFF documents integer 0/1; accepting actual JSON booleans is safe,
            // but never coerce strings such as "false" into a true flag.
            guard let value = value as? NSNumber, [0.0, 1.0].contains(value.doubleValue) else { return nil }
            return value.boolValue
        }
        func componentList(_ raw: Any?) -> [ProductNutriScore2023.Component]? {
            guard let records = raw as? [[String: Any]], records.count <= 20 else { return nil }
            var seen = Set<String>()
            var result: [ProductNutriScore2023.Component] = []
            for record in records {
                guard let id = record["id"] as? String,
                      id.range(of: #"^[a-z][a-z0-9_]{0,59}$"#, options: .regularExpression) != nil,
                      seen.insert(id).inserted,
                      let unit = record["unit"] as? String, ["kJ", "g", "%", "", "mg", "number"].contains(unit),
                      let points = integer(record["points"]), let maximum = integer(record["points_max"]),
                      points <= maximum else { return nil }
                let value: Double?
                if record["value"] == nil || record["value"] is NSNull { value = nil }
                else {
                    guard let n = record["value"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                          n.doubleValue.isFinite, (0...100_000).contains(n.doubleValue) else { return nil }
                    value = n.doubleValue
                }
                result.append(.init(id: id, value: value, unit: unit, points: points, pointsMax: maximum))
            }
            return result
        }
        let data = record["data"] as? [String: Any] ?? [:]
        let computed = flag(record["nutriscore_computed"]), applicable = flag(record["nutriscore_applicable"])
        let rawComponents = data["components"] as? [String: Any]
        let components: ProductNutriScore2023.Components?
        if let negative = componentList(rawComponents?["negative"]), let positive = componentList(rawComponents?["positive"]) {
            components = .init(negative: negative, positive: positive)
        } else { components = nil }
        let candidateGrade = (record["grade"] as? String)?.uppercased()
        let candidateScore = integer(record["score"], minimum: -100)
        let confirmed = computed == true && applicable == true
            && flag(record["category_available"]) == true && flag(record["nutrients_available"]) == true
        return ProductNutriScore2023(
            methodId: "nutri-score-2023", version: "2023", computed: computed, applicable: applicable,
            categoryAvailable: flag(record["category_available"]), nutrientsAvailable: flag(record["nutrients_available"]),
            grade: confirmed && ["A", "B", "C", "D", "E"].contains(candidateGrade ?? "") && candidateScore != nil ? candidateGrade : nil,
            rawScore: confirmed && ["A", "B", "C", "D", "E"].contains(candidateGrade ?? "") ? candidateScore : nil,
            components: components,
            isBeverage: flag(data["is_beverage"]), isCheese: flag(data["is_cheese"]), isWater: flag(data["is_water"]),
            isFatOilNutsSeeds: flag(data["is_fat_oil_nuts_seeds"]), isRedMeatProduct: flag(data["is_red_meat_product"]),
            negativePoints: integer(data["negative_points"]), positivePoints: integer(data["positive_points"]),
            negativePointsMax: integer(data["negative_points_max"]), positivePointsMax: integer(data["positive_points_max"]),
            positiveNutrients: (data["positive_nutrients"] as? [String]).flatMap { items in
                items.count <= 20 && items.allSatisfy { $0.range(of: #"^[a-z][a-z0-9_]{0,59}$"#, options: .regularExpression) != nil } ? items : nil
            },
            countProteins: flag(data["count_proteins"]),
            countProteinsReason: nonempty(data["count_proteins_reason"]).map { String($0.prefix(160)) },
            preparation: nonempty(record["preparation"]), estimated: flag(record["estimated"])
        )
    }

    private static func ingredientItems(_ raw: Any?) -> [ProductIngredient]? {
        guard let roots = raw as? [[String: Any]] else { return nil }
        var items: [ProductIngredient] = []
        func visit(_ records: [[String: Any]], depth: Int) {
            guard depth < 8, items.count < 160 else { return }
            for record in records.prefix(160) where items.count < 160 {
                // Keep leaves, avoiding double-counting a compound food and its ingredients.
                if let children = record["ingredients"] as? [[String: Any]], !children.isEmpty, depth < 7 {
                    visit(children, depth: depth + 1)
                    continue
                }
                let id = nonempty(record["id"]).map { String($0.prefix(160)) }
                let text = nonempty(record["text"]).map { String($0.prefix(400)) }
                guard id != nil || text != nil else { continue }
                let suppliedPercent = number(record["percent"])
                let percent = suppliedPercent.flatMap { $0 <= 100 ? $0 : nil }
                let vegan = nonempty(record["vegan"]).flatMap { ["yes", "no", "maybe"].contains($0) ? $0 : nil }
                let vegetarian = nonempty(record["vegetarian"]).flatMap { ["yes", "no", "maybe"].contains($0) ? $0 : nil }
                items.append(ProductIngredient(id: id, text: text, percent: percent, vegan: vegan, vegetarian: vegetarian))
            }
        }
        visit(roots, depth: 0)
        return items
    }

    private static func normalisedPackAmount(_ amount: Double?, unit: String, basisUnit: String) -> Double? {
        // OFF documents product_quantity as the whole pack in g/ml. An explicit
        // unit is required so a liquid package never invents a mass/density.
        guard !unit.isEmpty else { return nil }
        return normalisedServingAmount(amount, unit: unit, basisUnit: basisUnit, maximum: 100_000)
    }

    private static func printedPackAmount(_ text: String, basisUnit: String) -> Double? {
        // Full-string match prevents "6 x 25 g" being misread as a 25 g pack.
        guard let regex = try? NSRegularExpression(pattern: #"^\s*(\d+(?:[.,]\d+)?)\s*(kg|mg|ml|cl|dl|g|l)\s*℮?\s*$"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let amountRange = Range(match.range(at: 1), in: text),
              let unitRange = Range(match.range(at: 2), in: text),
              let value = Double(text[amountRange].replacingOccurrences(of: ",", with: ".")) else { return nil }
        return normalisedPackAmount(value, unit: String(text[unitRange]), basisUnit: basisUnit)
    }

    /// OFF's documented selected_images URLs are preferred; legacy fields remain
    /// useful for v2 search results. Never construct a guessed product photograph.
    private static func productImageURL(_ product: [String: Any]) -> String? {
        var candidates: [String] = []
        if let selected = product["selected_images"] as? [String: Any],
           let front = selected["front"] as? [String: Any] {
            for size in ["small", "thumb", "display"] {
                guard let languages = front[size] as? [String: Any] else { continue }
                if let english = nonempty(languages["en"]) { candidates.append(english) }
                if let language = nonempty(product["lc"]), let local = nonempty(languages[language]) { candidates.append(local) }
                for language in languages.keys.sorted() {
                    if let url = nonempty(languages[language]) { candidates.append(url) }
                }
            }
        }
        candidates += ["image_front_small_url", "image_front_url", "image_url"].compactMap { nonempty(product[$0]) }
        return candidates.first { CatalogueProductImages.sourceURL($0) != nil }
    }

    private static func printedServing(_ text: String, basisUnit: String) -> Double? {
        // Only printed physical units can supply a missing serving quantity. Never infer density.
        guard let regex = try? NSRegularExpression(pattern: #"(\d+(?:[.,]\d+)?)\s*(kg|mg|ml|cl|dl|g|l)\b"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let amountRange = Range(match.range(at: 1), in: text),
              let unitRange = Range(match.range(at: 2), in: text),
              let value = Double(text[amountRange].replacingOccurrences(of: ",", with: ".")),
              let amount = normalisedServingAmount(value, unit: String(text[unitRange]), basisUnit: basisUnit),
              amount > 0, amount <= 5000 else { return nil }
        return amount
    }

    private static func nonempty(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func firstNonempty(_ dictionary: [String: Any], keys: [String]) -> String? {
        keys.lazy.compactMap { nonempty(dictionary[$0]) }.first
    }

    private static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            let result = number.doubleValue
            return result.isFinite && result >= 0 ? result : nil
        }
        if let string = value as? String, let result = Double(string), result.isFinite, result >= 0 {
            return result
        }
        return nil
    }

    private static func structuredNutrient(_ value: Any?, unit expectedUnit: String) -> NutrientValue? {
        guard let item = value as? [String: Any] else { return nil }
        let unit = (nonempty(item["unit"]) ?? expectedUnit).lowercased()
        guard unit == expectedUnit.lowercased() else { return nil }
        if let supplied = number(item["value"]) {
            let calculated = (nonempty(item["source"]) ?? "").lowercased() == "estimate"
            return NutrientValue(value: supplied, unit: expectedUnit, status: calculated ? "estimated" : "supplied", relation: nonempty(item["modifier"]))
        }
        if let computed = number(item["value_computed"]) {
            return NutrientValue(value: computed, unit: expectedUnit, status: (nonempty(item["source"]) ?? "").lowercased() == "estimate" ? "estimated" : "calculated", relation: nonempty(item["modifier"]))
        }
        return nil
    }

    private static func structuredKilojoules(_ nutrients: [String: Any]) -> NutrientValue? {
        for key in ["energy-kj", "energy"] {
            guard let item = nutrients[key] as? [String: Any],
                  (nonempty(item["unit"]) ?? "").lowercased() == "kj" else { continue }
            if let value = number(item["value"]) ?? number(item["value_computed"]) {
                return NutrientValue(value: value, unit: "kJ", status: (nonempty(item["source"]) ?? "").lowercased() == "estimate" ? "estimated" : number(item["value"]) == nil ? "calculated" : "supplied",
                    relation: nonempty(item["modifier"]))
            }
        }
        return nil
    }

    private static func tagList(_ value: Any?) -> [String]? {
        guard let tags = value as? [String] else { return nil }
        let cleaned = tags.compactMap { tag -> String? in
            let value = tag.split(separator: ":", maxSplits: 1).last.map(String.init) ?? tag
            let result = value.replacingOccurrences(of: "-", with: " ").trimmingCharacters(in: .whitespaces)
            return result.isEmpty ? nil : result
        }
        return cleaned.isEmpty ? [] : Array(Set(cleaned)).sorted()
    }

    private static func textList(_ value: Any?) -> [String]? {
        guard let text = nonempty(value) else { return nil }
        let values = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return values.isEmpty ? [] : values
    }

    private static func isLiquid(unit: String) -> Bool {
        ["ml", "cl", "dl", "l", "millilitre", "milliliter"].contains(unit)
    }

    private static func containsLiquidUnit(_ text: String) -> Bool {
        text.range(of: #"(^|\s|\d)(ml|cl|dl|l)\b"#, options: .regularExpression) != nil
    }

    private static func normalisedServingAmount(_ amount: Double?, unit: String, basisUnit: String, maximum: Double = 5000) -> Double? {
        guard let amount, amount.isFinite, amount > 0,
              ["", "g", "kg", "mg", "ml", "cl", "dl", "l", "millilitre", "milliliter"].contains(unit) else { return nil }
        if basisUnit == "g" && isLiquid(unit: unit) { return nil }
        if basisUnit == "ml" && ["g", "kg", "mg"].contains(unit) { return nil }
        let result = basisUnit == "ml" ? amount * (["l": 1000, "dl": 100, "cl": 10][unit] ?? 1)
            : amount * (["kg": 1000, "mg": 0.001][unit] ?? 1)
        return result.isFinite && result <= maximum ? result : nil
    }
}

/// Durable public provider facts for offline reuse. Source freshness determines
/// refresh, not whether the only available offline copy is discarded.
struct ProductLookupCache {
    // Preserve the existing public-facts format while moving it to durable
    // storage. Private diary/history/saved-food storage is separate.
    static let directoryName = "NudgeFoodCatalogue-v2"
    static let shared = ProductLookupCache(
        directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(directoryName),
        legacyDirectory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(directoryName))
    let directory: URL
    var legacyDirectory: URL? = nil
    private static let lock = NSLock()
    private struct Entry: Codable {
        let version: Int
        let storedAt: Date
        let product: BarcodeProduct
        // Public lookup time, separate from OFF's source retrieval date. An
        // incomplete score can improve without the underlying label changing.
        var ratingCheckedAt: Date? = nil
    }
    private struct MemoryEntry { let entry: Entry; let modified: Date?; let size: Int }
    private static var memory: [URL: MemoryEntry] = [:]
    private static let sourceDateFormatter = ISO8601DateFormatter()
    private let lifetime: TimeInterval = 7 * 86_400
    func read(barcode: String, now: Date, allowStale: Bool = false) -> BarcodeProduct? {
        guard barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil else { return nil }
        Self.lock.lock(); defer { Self.lock.unlock() }
        let destination = directory.appendingPathComponent(barcode + ".json")
        let url = FileManager.default.fileExists(atPath: destination.path) ? destination : legacyDirectory?.appendingPathComponent(barcode + ".json") ?? destination
        guard let attributes = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
              let size = attributes.fileSize, size <= 65_536 else { Self.memory.removeValue(forKey: url); return nil }
        let entry: Entry
        if let hit = Self.memory[url], hit.size == size, hit.modified == attributes.contentModificationDate {
            entry = hit.entry
        } else {
            guard let data = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode(Entry.self, from: data) else {
                Self.memory.removeValue(forKey: url); return nil
            }
            entry = decoded
            // Repeated score projections avoid decoding the same source record
            // for every visible card. File changes and all freshness rules still apply.
            if Self.memory.count >= 200 { Self.memory.removeAll(keepingCapacity: true) }
            Self.memory[url] = MemoryEntry(entry: entry, modified: attributes.contentModificationDate, size: size)
        }
        guard entry.version == 1, entry.product.barcode == barcode, entry.product.hasTrustedCatalogueSource, entry.product.searchProvider == nil,
              let sourceDate = Self.sourceDateFormatter.date(from: entry.product.retrievedAt),
              now.timeIntervalSince(sourceDate) >= 0, now.timeIntervalSince(entry.storedAt) >= 0,
              allowStale || (now.timeIntervalSince(sourceDate) < 30 * 86_400 &&
                (entry.product.catalogueSourceExpiresAt.map({ $0 > now }) ?? true) && now.timeIntervalSince(entry.storedAt) < lifetime) else { return nil }
        if url != destination, let data = try? JSONEncoder().encode(entry) {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: destination, options: .atomic)
            } catch { /* Keep the readable legacy copy when migration cannot finish. */ }
        }
        return entry.product
    }

    /// An explicit scan/detail open can recheck a missing catalogue rating once
    /// per five minutes. Reserve before the request so failures cannot cause a
    /// retry loop. Source freshness and offline facts are left untouched.
    func reserveMissingRatingRefresh(barcode: String, now: Date) -> Bool {
        guard barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil else { return false }
        Self.lock.lock(); defer { Self.lock.unlock() }
        let url = directory.appendingPathComponent(barcode + ".json")
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65_536,
              let bytes = try? Data(contentsOf: url), bytes.count <= 65_536,
              var entry = try? JSONDecoder().decode(Entry.self, from: bytes), entry.version == 1,
              entry.product.barcode == barcode, entry.product.hasTrustedCatalogueSource,
              let rating = entry.product.catalogueRating,
              rating.qualityHold(for: entry.product, at: now) == nil,
              let score = try? JSONSerialization.jsonObject(with: rating.scoreData) as? [String: Any],
              !Self.supportedRatingVersion(rating) || score["status"] as? String == "unrated" || rating.effectiveExpiresAt <= now,
              now.timeIntervalSince(entry.ratingCheckedAt ?? entry.storedAt) >= 300 else { return false }
        entry.ratingCheckedAt = now
        guard let data = try? JSONEncoder().encode(entry), data.count <= 65_536 else { return false }
        do { try data.write(to: url, options: .atomic) }
        catch { return false }
        Self.memory.removeValue(forKey: url)
        return true
    }

    func write(_ products: [BarcodeProduct], now: Date) {
        for product in products { write(product, now: now, trim: false) }
        Self.lock.lock(); defer { Self.lock.unlock() }
        trimDisk()
    }

    func write(_ product: BarcodeProduct, now: Date) { write(product, now: now, trim: true) }

    private func write(_ product: BarcodeProduct, now: Date, trim: Bool) {
        guard product.barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil,
              product.hasTrustedCatalogueSource, product.searchProvider == nil else { return }
        var product = product
        var storedAt = now
        Self.lock.lock(); defer { Self.lock.unlock() }
        let destination = directory.appendingPathComponent(product.barcode + ".json")
        // An in-flight older response must not roll the cache back after a
        // newer search/scan completed. Compare label revision first; a later
        // calculation can only break a tie for the same source revision.
        if let size = try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65_536,
           let bytes = try? Data(contentsOf: destination), bytes.count <= 65_536,
           let previous = try? JSONDecoder().decode(Entry.self, from: bytes), previous.version == 1,
           previous.product.barcode == product.barcode, previous.product.hasTrustedCatalogueSource,
           previous.product.sourceName == product.sourceName, previous.product.sourceURL == product.sourceURL {
            var keepPreviousFacts = false
            let sameHeldSource = previous.product.catalogueSourceFingerprint != nil
                && previous.product.catalogueSourceFingerprint == product.catalogueSourceFingerprint
                && previous.product.catalogueRating?.qualityHold(for: previous.product, at: now) != nil
                && product.catalogueRating?.qualityHold(for: product, at: now) == nil
            if let oldRevision = Self.sourceRevisionDate(previous.product.lastModifiedAt) {
                if let newRevision = Self.sourceRevisionDate(product.lastModifiedAt) {
                    keepPreviousFacts = oldRevision > newRevision
                    if oldRevision == newRevision {
                        if previous.product.hasCurrentScoringSource != product.hasCurrentScoringSource {
                            // A decoder correction restores provider evidence
                            // that an older parser omitted from the same label.
                            keepPreviousFacts = previous.product.hasCurrentScoringSource
                        } else if let older = Self.boundCalculation(previous.product, at: now),
                                  previous.product.catalogueRating?.qualityHold(for: previous.product, at: now) == nil
                                    || product.catalogueSourceFingerprint == previous.product.catalogueSourceFingerprint {
                            keepPreviousFacts = Self.boundCalculation(product, at: now).map({ $0 < older }) ?? true
                        }
                    }
                } else { keepPreviousFacts = true }
            }
            if keepPreviousFacts || sameHeldSource {
                let withImage = previous.product.retainingPublicImage(from: product)
                guard withImage != previous.product else { return }
                product = withImage; storedAt = previous.storedAt
            } else { product = product.retainingPublicImage(from: previous.product) }
        }
        guard let data = try? JSONEncoder().encode(Entry(version: 1, storedAt: storedAt, product: product, ratingCheckedAt: now)), data.count <= 65_536 else { return }
        Self.memory.removeValue(forKey: destination)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: destination, options: .atomic)
            if trim { trimDisk() }
        } catch { /* A cache write must never fail a scan. */ }
    }

    private func trimDisk() {
        do {
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])
                .filter { $0.pathExtension == "json" }.sorted {
                    ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) >
                    ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
                }
            var total = 0
            for (index, url) in files.enumerated() {
                total += (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 65_536
                if index >= 200 || total > 4_000_000 { try? FileManager.default.removeItem(at: url) }
            }
        } catch { /* Cache maintenance must never fail a scan. */ }
    }

    private static func sourceRevisionDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        if let value = sourceDateFormatter.date(from: raw) { return value }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: raw)
    }

    private static func boundCalculation(_ product: BarcodeProduct, at now: Date) -> Date? {
        guard let rating = product.catalogueRating,
              supportedRatingVersion(rating),
              rating.snapshotFingerprint == ProductCatalogueRating.fingerprint(product),
              rating.fetchedAt <= now.addingTimeInterval(60), rating.expiresAt > now,
              rating.calculatedAt >= rating.fetchedAt, rating.calculatedAt <= now.addingTimeInterval(60) else { return nil }
        // This is only publication ordering, not permission to display a score.
        // The renderer still validates the current classifier and result shape.
        return rating.calculatedAt
    }

    private static func supportedRatingVersion(_ rating: ProductCatalogueRating) -> Bool {
        (rating.method == "nudge_nutrition_v0_3" && rating.version == "0.3") ||
        (rating.method == "nudge_nutrition_v0_4" && rating.version == "0.4")
    }
}

/// Public product reads share OFF's documented 15/minute/IP allowance. The
/// background card loader leaves headroom for a deliberate scan or detail open.
actor ProductReadState {
    static let shared = ProductReadState()
    private var starts: [Date] = []
    private var pausedUntil: Date = .distantPast

    func reserve(at date: Date) throws {
        starts.removeAll { date.timeIntervalSince($0) >= 60 }
        if pausedUntil > date {
            throw BarcodeLookupError.productReadDeferred(max(1, Int(ceil(pausedUntil.timeIntervalSince(date)))))
        }
        if starts.count >= 15, let first = starts.first {
            throw BarcodeLookupError.productReadDeferred(max(1, Int(ceil(60 - date.timeIntervalSince(first)))))
        }
        starts.append(date)
    }

    func pause(seconds: Int, at date: Date) {
        pausedUntil = max(pausedUntil, date.addingTimeInterval(TimeInterval(max(1, seconds))))
    }
}

struct OpenFoodFactsService {
    enum SourcePolicy { case legacyPublicSource, catalogueOnly }
    // Legacy injection remains available to source-adapter tests. Every app entry
    // point uses catalogueConnected, which never falls back to a live OFF read.
    var sourcePolicy: SourcePolicy = .legacyPublicSource
    var productReadState: ProductReadState = .shared
    var session: URLSession = .shared
    var now: () -> Date = Date.init
    var cache: ProductLookupCache? = .shared
    var searchSession: URLSession = ProductSearchTransport.session
    var searchState: ProductSearchState = .shared
    var searchDiagnostics: AnalysisDiagnostics? = .shared
    var alternativesState: ProductAlternativesState = .shared
    var catalogueLookup: (String) async throws -> (data: Data, retrievedAt: Date) = {
        try await NutritionLabelService().catalogueProductData(barcode: $0)
    }
    var catalogueSearch: ((ProductSearchQuery) async throws -> ProductSearchPage)? = nil
    var catalogueBatch: (([String]) async throws -> [BarcodeProduct])? = nil
    var catalogueAlternatives: ((String, ProductSearchStore?) async throws -> [BarcodeProduct])? = nil

    static var catalogueConnected: Self {
        var service = Self()
        service.sourcePolicy = .catalogueOnly
        service.catalogueSearch = { try await NudgeCatalogueService().search($0) }
        service.catalogueBatch = { try await NudgeCatalogueService().batch($0) }
        service.catalogueAlternatives = { try await NudgeCatalogueService().alternatives(category: $0, store: $1) }
        return service
    }

    func lookup(barcode: String, diagnosticID: UUID = UUID()) async throws -> BarcodeProduct {
        try Task.checkCancellation()
        guard barcode.range(of: #"^\d{4,18}$"#, options: .regularExpression) != nil else {
            throw BarcodeLookupError.invalidBarcode
        }
        let cacheBegan = now()
        let freshProduct = cache?.read(barcode: barcode, now: now())
        let previousProduct = freshProduct ?? cache?.read(barcode: barcode, now: now(), allowStale: true)
        if let product = freshProduct, acceptsCachedProduct(product),
           product.hasCurrentScoringSource || sourcePolicy == .catalogueOnly {
            if let catalogueBatch, cache?.reserveMissingRatingRefresh(barcode: barcode, now: now()) == true {
                let began = now()
                do {
                    let records = try await catalogueBatch([barcode])
                    try Task.checkCancellation()
                    if records.count == 1, let refreshed = records.first,
                       NativeProductRatingEngine.isCurrentFullProduct(refreshed, for: product),
                       (refreshed.catalogueSourceExpiresAt.map({ $0 > now() }) ?? true) || refreshed.catalogueRating?.qualityHold(for: refreshed, at: now()) != nil {
                        let retained = refreshed.retainingPublicImage(from: product)
                        cache?.write(retained, now: now())
                        barcodeDiagnostic("catalogue_batch", "matched", began: began, diagnosticID: diagnosticID, requestSent: true)
                        return retained
                    }
                    barcodeDiagnostic("catalogue_batch", "no_matches", began: began, diagnosticID: diagnosticID, requestSent: true)
                } catch {
                    if error is CancellationError || Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                    barcodeDiagnostic("catalogue_batch", "failed", began: began, diagnosticID: diagnosticID)
                }
                // Rechecking a known product must not fan out to OFF or block
                // offline scanning when the catalogue is temporarily unavailable.
                return product
            }
            barcodeDiagnostic("phone_cache", "cache_hit", began: cacheBegan, diagnosticID: diagnosticID, requestSent: false)
            return product
        }
        var catalogueFailure: Error?
        if let catalogueBatch {
            let began = now()
            do {
                let products = try await catalogueBatch([barcode])
                try Task.checkCancellation()
                if products.count == 1, let product = products.first, product.barcode == barcode,
                   (product.catalogueSourceExpiresAt.map({ $0 > now() }) ?? true) || product.catalogueRating?.qualityHold(for: product, at: now()) != nil {
                    barcodeDiagnostic("catalogue_batch", "matched", began: began, diagnosticID: diagnosticID, requestSent: true)
                    cache?.write(product, now: now())
                    return product
                }
                if !products.isEmpty {
                    catalogueFailure = products.count == 1 && products.first?.barcode == barcode
                        ? ProductSearchError.unavailable : ProductSearchError.invalidResponse
                }
                barcodeDiagnostic("catalogue_batch", products.isEmpty ? "no_matches" : "failed", began: began, diagnosticID: diagnosticID, requestSent: true)
            } catch {
                let cancelled = error is CancellationError || Task.isCancelled || (error as? URLError)?.code == .cancelled
                barcodeDiagnostic("catalogue_batch", cancelled ? "cancelled" : "failed", began: began, diagnosticID: diagnosticID)
                if cancelled { throw CancellationError() }
                catalogueFailure = error
            }
        }
        if let held = previousProduct, held.catalogueRating?.qualityHold(for: held, at: now()) != nil { return held }
        if sourcePolicy == .catalogueOnly {
            guard catalogueBatch != nil else { throw BarcodeLookupError.server(503) }
            if let catalogueFailure {
                // Retain known catalogue facts during an outage without rewriting
                // their retrieval/expiry dates or treating a miss as a known item.
                if let previousProduct, acceptsCachedProduct(previousProduct), Self.barcodeError(catalogueFailure) != .notFound { return previousProduct }
                throw Self.barcodeError(catalogueFailure)
            }
            throw BarcodeLookupError.notFound
        }
        // This server route already attempts OFF on a catalogue miss. Repeating
        // the same source call on a failure can add another 15 seconds. Direct
        // OFF is only needed when authentication or connection establishment
        // prevented the backend route from being usable in the first place.
        let fallbackBegan = now()
        do {
            try Task.checkCancellation()
            let entry = try await catalogueLookup(barcode)
            try Task.checkCancellation()
            let product: BarcodeProduct
            if let wrapper = try JSONSerialization.jsonObject(with: entry.data) as? [String: Any],
               let encoded = wrapper["nudgeCatalogueProduct"] as? [String: Any] {
                product = try JSONDecoder().decode(BarcodeProduct.self, from: JSONSerialization.data(withJSONObject: encoded))
                guard product.barcode == barcode, product.catalogueRating?.qualityHold(for: product, at: now()) != nil else { throw NutritionLabelService.ServiceError.invalidResponse }
            } else {
                product = try OpenFoodFactsParser.parse(data: entry.data, barcode: barcode, retrievedAt: entry.retrievedAt)
            }
            barcodeDiagnostic("catalogue_fallback", "matched", began: fallbackBegan, diagnosticID: diagnosticID, requestSent: true)
            cache?.write(product, now: now())
            return product
        } catch {
            if error is CancellationError || Task.isCancelled || (error as? URLError)?.code == .cancelled {
                barcodeDiagnostic("catalogue_fallback", "cancelled", began: fallbackBegan, diagnosticID: diagnosticID)
                throw CancellationError()
            }
            let failure = Self.barcodeError(error)
            barcodeDiagnostic("catalogue_fallback", failure == .notFound ? "no_matches" : failure == .timeout ? "timeout" : "failed",
                              began: fallbackBegan, diagnosticID: diagnosticID)
            guard Self.canUseDirectSource(after: error) else {
                if let previousProduct, failure != .notFound { return previousProduct }
                throw failure
            }
        }
        try Task.checkCancellation()
        var components = URLComponents(string: "https://world.openfoodfacts.org/api/v3.6/product/\(barcode).json")!
        components.queryItems = [URLQueryItem(name: "fields", value: Self.fields)]
        let began = now()
        var requestSent = false
        do {
            let data = try await fetch(components.url!, onRequestSent: { requestSent = true })
            try Task.checkCancellation()
            let product = try OpenFoodFactsParser.parse(data: data, barcode: barcode, retrievedAt: now())
            barcodeDiagnostic("off_product", "matched", began: began, diagnosticID: diagnosticID, requestSent: requestSent)
            cache?.write(product, now: now())
            return product
        } catch {
            let cancelled = error is CancellationError || Task.isCancelled
            let failure = Self.barcodeError(error)
            barcodeDiagnostic("off_product", cancelled ? "cancelled" : failure == .notFound ? "no_matches" : failure == .timeout ? "timeout" : "failed",
                              began: began, diagnosticID: diagnosticID, requestSent: requestSent)
            if cancelled { throw CancellationError() }
            if let previousProduct, failure != .notFound { return previousProduct }
            throw failure
        }
    }

    private func acceptsCachedProduct(_ product: BarcodeProduct) -> Bool {
        sourcePolicy != .catalogueOnly || (product.searchProvider == nil && product.hasTrustedCatalogueSource
            && product.catalogueSourceExpiresAt != nil)
    }

    private static func canUseDirectSource(after error: Error) -> Bool {
        if let error = error as? NutritionLabelService.ServiceError {
            switch error {
            case .notConfigured, .accountAuthentication, .unauthenticated: return true
            default: return false
            }
        }
        if let error = error as? AccountError {
            switch error {
            case .signInRequired, .network, .unavailable: return true
            default: return false
            }
        }
        // A timeout or lost connection may mean the server has already called
        // OFF. Only a failure to establish the backend connection can fall back.
        return (error as? URLError).map { [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost].contains($0.code) } ?? false
    }

    private static func barcodeError(_ error: Error) -> BarcodeLookupError {
        if let error = error as? BarcodeLookupError { return error }
        if let error = error as? ProductSearchError {
            switch error {
            case .offline: return .offline
            case .timeout: return .timeout
            case .rateLimited(let seconds), .providerRateLimited(let seconds): return .retryLater(seconds)
            case .providerBusy(let status, _), .providerUnavailable(let status): return .server(status)
            case .unavailable: return .server(503)
            case .invalidQuery: return .invalidBarcode
            case .invalidResponse: return .invalidResponse
            }
        }
        if error is AccountError { return .server(503) }
        if let error = error as? NutritionLabelService.ServiceError {
            switch error {
            case .notConfigured, .accountAuthentication, .unauthenticated: return .server(503)
            default: break
            }
        }
        if let error = error as? URLError {
            if error.code == .timedOut { return .timeout }
            if [.notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost].contains(error.code) { return .offline }
        }
        return .invalidResponse
    }

    private func barcodeDiagnostic(_ source: String, _ outcome: String, began: Date, diagnosticID: UUID, requestSent: Bool? = nil) {
        var fields: [String: Any] = ["route": "product_lookup", "sourceRoute": source, "attemptId": diagnosticID.uuidString,
            "elapsedMs": max(0, Int(now().timeIntervalSince(began) * 1000))]
        // The catalogue transport records its actual dispatch. At this level
        // an auth failure/cancellation doesn't establish whether a request sent.
        if let requestSent { fields["requestSent"] = requestSent }
        searchDiagnostics?.record(stage: "barcode_lookup", outcome: outcome, metadata: fields)
    }

    /// Fill a visible search card from an exact product record. Index snapshots
    /// may be newer than either cache, so never reuse an older or undated fact
    /// set. This path reads public facts only and cannot trigger AI or diary writes.
    func lookupForSearchRating(snapshot: BarcodeProduct) async throws -> BarcodeProduct {
        if sourcePolicy == .catalogueOnly {
            guard let product = try await lookupForSearchRatings(snapshots: [snapshot]).first else {
                throw BarcodeLookupError.incompleteProduct
            }
            return product
        }
        let barcode = snapshot.barcode
        guard barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil else {
            throw BarcodeLookupError.invalidBarcode
        }
        try Task.checkCancellation()
        if let product = cache?.read(barcode: barcode, now: now()),
           product.hasCurrentScoringSource,
           NativeProductRatingEngine.isCurrentFullProduct(product, for: snapshot) { return product }
        // Visible cards need one public, exact-barcode fetch. Going through the
        // authenticated catalogue first adds authorisation and a second OFF
        // request on a catalogue miss. Full records still populate the shared
        // on-device cache; scan/detail lookup retains the reusable server catalogue.
        try Task.checkCancellation()
        var components = URLComponents(string: "https://world.openfoodfacts.org/api/v3.6/product/\(barcode).json")!
        components.queryItems = [URLQueryItem(name: "fields", value: Self.fields)]
        let data: Data
        do { data = try await fetch(components.url!) }
        catch {
            // The shared barcode transport maps cancelled URL requests to its
            // ordinary lookup errors. A card disappearing is cancellation, so
            // preserve that distinction and let it load again when visible.
            try Task.checkCancellation()
            throw error
        }
        try Task.checkCancellation()
        let product = try OpenFoodFactsParser.parse(data: data, barcode: barcode, retrievedAt: now())
        guard NativeProductRatingEngine.isCurrentFullProduct(product, for: snapshot) else { throw BarcodeLookupError.invalidResponse }
        cache?.write(product, now: now())
        return product
    }

    /// Retrieve the exact facts for one search page with one supported filtered
    /// search request. OFF's v2 search accepts a comma-separated code list; v3
    /// has no search route. These are source records, never index score guesses.
    func lookupForSearchRatings(snapshots: [BarcodeProduct]) async throws -> [BarcodeProduct] {
        try Task.checkCancellation()
        guard snapshots.count <= 20 else { throw BarcodeLookupError.invalidResponse }
        guard snapshots.allSatisfy({ $0.barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil }) else {
            throw BarcodeLookupError.invalidBarcode
        }
        guard Set(snapshots.map(\.barcode)).count == snapshots.count else { throw BarcodeLookupError.invalidResponse }
        guard !snapshots.isEmpty else { return [] }
        let requestedAt = now()
        var resolved: [String: BarcodeProduct] = [:]
        var missing: [BarcodeProduct] = []
        for snapshot in snapshots {
            if let full = cache?.read(barcode: snapshot.barcode, now: requestedAt),
               acceptsCachedProduct(full),
               full.hasCurrentScoringSource || sourcePolicy == .catalogueOnly,
               Self.currentBatchProduct(full, for: snapshot, at: requestedAt) {
                resolved[snapshot.barcode] = full
            } else { missing.append(snapshot) }
        }
        if !missing.isEmpty, let catalogueBatch {
            do {
                let records = try await catalogueBatch(missing.map(\.barcode))
                try Task.checkCancellation()
                let grouped = Dictionary(grouping: records, by: \.barcode)
                missing = missing.filter { snapshot in
                    guard let matches = grouped[snapshot.barcode], matches.count == 1, let full = matches.first,
                          Self.currentBatchProduct(full, for: snapshot, at: now()) else { return true }
                    resolved[full.barcode] = full
                    cache?.write(full, now: now())
                    return false
                }
            } catch {
                if error is CancellationError || Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
                if sourcePolicy == .catalogueOnly && resolved.isEmpty { throw error }
            }
        }
        if sourcePolicy == .catalogueOnly {
            guard missing.isEmpty || catalogueBatch != nil else { throw ProductSearchError.unavailable }
            return snapshots.compactMap { resolved[$0.barcode] }
        }
        if !missing.isEmpty {
            let requested = missing.sorted { $0.barcode < $1.barcode }
            let codes = Set(requested.map(\.barcode))
            var components = URLComponents(string: "https://world.openfoodfacts.org/api/v2/search")!
            components.queryItems = [URLQueryItem(name: "code", value: requested.map(\.barcode).joined(separator: ",")),
                URLQueryItem(name: "page", value: "1"), URLQueryItem(name: "page_size", value: "20"),
                URLQueryItem(name: "fields", value: Self.fields),
                URLQueryItem(name: "sort_by", value: "nothing")]
            let url = components.url!
            // A newer discovery snapshot must not get stuck behind a previously
            // cached older pool. Order-independent keys also coalesce readers.
            let revisions = requested.map { $0.barcode + ":" + ($0.lastModifiedAt ?? "") }.joined(separator: "|")
            let revisionHash = SHA256.hash(data: Data(revisions.utf8)).map { String(format: "%02x", $0) }.joined()
            let pool = try await alternativesState.load(key: "rating-facts-v1|" + url.absoluteString + "|" + revisionHash, at: requestedAt) {
                try Task.checkCancellation()
                let began = now()
                var requestSent = false
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
                request.setValue("Nudge/0.1.1 (iOS; https://example.invalid/nudge)", forHTTPHeaderField: "User-Agent")
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                do {
                    try await searchState.reserve(at: now(), route: .factsBatch)
                    requestSent = true
                    let (data, response) = try await BoundedHTTPData.load(request, session: searchSession, maximumBytes: 2_000_000)
                    try Task.checkCancellation()
                    sourceDiagnostic(.factsBatch, "received", began: began, requestSent: true, status: response.statusCode)
                    if response.statusCode == 429 || (500...599).contains(response.statusCode) {
                        let wait = Self.searchRetryAfter(response.value(forHTTPHeaderField: "Retry-After"), at: now(), fallback: 60)
                        await searchState.pause(seconds: wait, at: now(), statusCode: response.statusCode, route: .factsBatch)
                        if response.statusCode == 429 { throw ProductSearchError.providerRateLimited(wait) }
                        throw ProductSearchError.providerBusy(response.statusCode, wait)
                    }
                    guard response.statusCode == 200,
                          let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        throw BarcodeLookupError.invalidResponse
                    }
                    // OFF can return a failed/partial search with HTTP 200.
                    // Never persist it as a successful empty fact pool.
                    if (root["timed_out"] as? Bool) == true { throw ProductSearchError.timeout }
                    if let error = root["error"], !(error is NSNull) { throw BarcodeLookupError.invalidResponse }
                    if let errors = root["errors"] as? [Any], !errors.isEmpty { throw BarcodeLookupError.invalidResponse }
                    if (root["status"] as? String)?.lowercased() == "failure" { throw BarcodeLookupError.invalidResponse }
                    guard let records = root["products"] as? [[String: Any]], records.count <= 20 else {
                        throw BarcodeLookupError.invalidResponse
                    }
                    let identities = records.compactMap { $0["code"] as? String }
                    let counts = Dictionary(identities.map { ($0, 1) }, uniquingKeysWith: +)
                    let receivedAt = now()
                    return records.compactMap { record in
                        // OFF normalises codes in queries. Do not silently accept
                        // a different identity or choose between duplicate records.
                        guard let code = record["code"] as? String, codes.contains(code), counts[code] == 1,
                              Self.validBatchModification(record["last_modified_t"], at: receivedAt),
                              let bytes = try? JSONSerialization.data(withJSONObject: ["product": record]) else { return nil }
                        return try? OpenFoodFactsParser.parse(data: bytes, barcode: code, retrievedAt: receivedAt)
                    }
                } catch {
                    sourceDiagnostic(.factsBatch, (error as? ProductSearchError)?.code ?? (error as? BarcodeLookupError)?.code ?? "unavailable",
                                     began: began, requestSent: requestSent, error: error)
                    if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled { throw CancellationError() }
                    if let known = error as? ProductSearchError { throw known }
                    if let known = error as? BarcodeLookupError { throw known }
                    if (error as? URLError)?.code == .timedOut { throw BarcodeLookupError.timeout }
                    if let network = error as? URLError,
                       [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(network.code) {
                        throw BarcodeLookupError.offline
                    }
                    throw BarcodeLookupError.invalidResponse
                }
            }
            try Task.checkCancellation()
            let byCode = Dictionary(uniqueKeysWithValues: requested.map { ($0.barcode, $0) })
            for full in pool {
                guard let snapshot = byCode[full.barcode], Self.currentBatchProduct(full, for: snapshot, at: now()) else { continue }
                resolved[full.barcode] = full
                cache?.write(full, now: now())
            }
        }
        try Task.checkCancellation()
        return snapshots.compactMap { resolved[$0.barcode] }
    }

    private static func validBatchModification(_ raw: Any?, at date: Date) -> Bool {
        guard let raw, !(raw is NSNull) else { return true }
        let number = (raw as? NSNumber)?.doubleValue ?? (raw as? String).flatMap(Double.init)
        guard let number, number.isFinite, number > 0, number <= date.timeIntervalSince1970 else { return false }
        return true
    }

    private static func currentBatchProduct(_ full: BarcodeProduct, for snapshot: BarcodeProduct, at date: Date) -> Bool {
        guard NativeProductRatingEngine.isCurrentFullProduct(full, for: snapshot),
              (full.catalogueSourceExpiresAt.map({ $0 > date }) ?? true) || full.catalogueRating?.qualityHold(for: full, at: date) != nil else { return false }
        guard let modified = full.lastModifiedAt else { return true }
        let formatter = ISO8601DateFormatter()
        guard let modifiedAt = formatter.date(from: modified), modifiedAt <= date else { return false }
        return true
    }

    private func sourceDiagnostic(_ route: ProductSourceRoute, _ outcome: String, began: Date,
                                  requestSent: Bool, status: Int? = nil, error: Error? = nil) {
        var fields: [String: Any] = ["sourceRoute": route.rawValue, "requestSent": requestSent,
            "route": route == .discovery ? "product_search" : "product_score",
            "elapsedMs": max(0, Int(now().timeIntervalSince(began) * 1000))]
        if let status { fields["httpStatus"] = status }
        if let failure = error as? ProductSearchError {
            fields["retryAfterSeconds"] = failure.retryAfterSeconds
            if let status = failure.statusCode { fields["httpStatus"] = status }
            if !requestSent {
                switch failure {
                case .rateLimited: fields["gateReason"] = "local_budget"
                case .providerRateLimited: fields["gateReason"] = "provider_pause"
                case .providerBusy: fields["gateReason"] = "route_outage"
                default: break
                }
            }
        }
        searchDiagnostics?.record(stage: "search_http", outcome: outcome, metadata: fields)
    }

    static let fields = [
            "code", "product_name", "product_name_en", "brands", "quantity",
            "product_quantity", "product_quantity_unit", "ingredients_text", "ingredients_text_en", "ingredients", "ingredients_analysis_tags",
            "allergens", "allergens_tags", "traces", "traces_tags", "nutriments", "nutrition",
            "nutrition_data_per", "nutrition_data", "nutrition_data_prepared", "nutrition_data_prepared_per", "no_nutrition_data", "serving_size", "serving_quantity", "serving_quantity_unit",
            "categories_tags", "countries_tags", "stores_tags", "stores", "labels_tags", "last_modified_t", "data_quality_errors_tags", "data_quality_warnings_tags", "selected_images", "lc", "image_front_url", "image_front_small_url", "image_url",
            "nutriscore_grade", "nutrition_grades", "nutriscore", "nova_group", "additives_tags"
        ].joined(separator: ",")

    func alternatives(barcode: String? = nil, categoryTag: String? = nil, retailer: String? = nil,
                      referenceNutrients: [String: Double] = [:], basisUnit: String? = nil,
                      nutritionPreparation: String? = nil, selectedStore: ProductSearchStore? = nil,
                      referenceProduct: BarcodeProduct? = nil) async throws -> [BarcodeProduct] {
        let original: BarcodeProduct?
        if let referenceProduct { original = referenceProduct }
        else if let barcode, !barcode.isEmpty { original = try await lookup(barcode: barcode) }
        else { original = nil }
        guard let category = original.flatMap({ FoodAlternatives.category($0.categories) })
                ?? categoryTag.flatMap({ FoodAlternatives.category([$0]) }) else { return [] }
        // A chosen supermarket is authoritative. No additional worldwide or
        // other-store search is made. Without a selection, show UK candidates.
        let shop = selectedStore?.title ?? FoodAlternatives.canonicalRetailer(retailer)
        // Only resolve a legacy retailer when one was recognised. Comparing
        // two absent aliases would otherwise choose the first unlisted shop.
        let catalogueStore = selectedStore ?? shop.flatMap { wanted in
            ProductSearchStore.allCases.first { FoodAlternatives.canonicalRetailer($0.title) == wanted }
        }
        let tag = shop.flatMap(FoodAlternatives.storeTag)
        var components = URLComponents(string: "https://world.openfoodfacts.org/api/v2/search")!
        components.queryItems = [URLQueryItem(name: "categories_tags", value: category),
            URLQueryItem(name: "page_size", value: "20"), URLQueryItem(name: "fields", value: Self.fields),
            URLQueryItem(name: "countries_tags_en", value: "united-kingdom")]
        if let tag { components.queryItems?.append(URLQueryItem(name: "stores_tags", value: tag)) }
        let url = components.url!
        // A Nudge catalogue search is authoritative, including an empty result.
        // Do not turn an optional empty/error response into another provider's
        // slower live search or consume OFF's shared search allowance. Keep
        // explicit legacy OFF reads in a separate cache namespace as well.
        // Some Nudge shops have no legacy OFF tag. Their pools still need an
        // explicit scope so they can never share the unfiltered UK cache.
        if sourcePolicy == .catalogueOnly && catalogueAlternatives == nil { throw ProductSearchError.unavailable }
        let sourceKey = catalogueAlternatives == nil ? "open-food-facts:" + url.absoluteString
            : "nudge-catalogue:" + url.absoluteString + ":store=" + (catalogueStore?.rawValue ?? "all-uk")
        let pool = try await alternativesState.load(key: sourceKey, at: now()) {
            if let catalogueAlternatives {
                let saved = try await catalogueAlternatives(category, catalogueStore)
                try Task.checkCancellation()
                return saved
            }
            let began = now()
            var requestSent = false
            do {
            try await searchState.reserve(at: now(), route: .alternatives)
            var request = URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15)
            request.setValue("Nudge/0.1.1 (iOS; org.example.nudge)", forHTTPHeaderField: "User-Agent")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            requestSent = true
            let (data, response) = try await BoundedHTTPData.load(request, session: searchSession, maximumBytes: 2_000_000)
            sourceDiagnostic(.alternatives, "received", began: began, requestSent: true, status: response.statusCode)
            if response.statusCode == 429 || (500...599).contains(response.statusCode) {
                let wait = Self.searchRetryAfter(response.value(forHTTPHeaderField: "Retry-After"), at: now(), fallback: 60)
                await searchState.pause(seconds: wait, at: now(), statusCode: response.statusCode, route: .alternatives)
                if response.statusCode == 429 { throw ProductSearchError.providerRateLimited(wait) }
                throw ProductSearchError.providerBusy(response.statusCode, wait)
            }
            guard response.statusCode == 200,
                  let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let products = root["products"] as? [[String: Any]] else { throw BarcodeLookupError.invalidResponse }
            return products.prefix(20).compactMap { product in
                guard let data = try? JSONSerialization.data(withJSONObject: ["product": product]) else { return nil }
                return try? OpenFoodFactsParser.parse(data: data, barcode: "", retrievedAt: now())
            }
            } catch {
                sourceDiagnostic(.alternatives, (error as? ProductSearchError)?.code ?? "unavailable",
                                 began: began, requestSent: requestSent, error: error)
                throw error
            }
        }
        // Validate provider scope again, including aliases and missing retailer
        // metadata. Retailer catalogue listings are never live-stock assertions.
        let scoped = pool.filter { product in
            product.countriesTags.contains("en:united-kingdom") &&
                (selectedStore.map { chosen in product.stores.contains(where: chosen.contains(sourceStore:)) }
                    ?? shop.map { wanted in product.stores.contains { FoodAlternatives.canonicalRetailer($0) == wanted } }
                    ?? true)
        }
        return FoodAlternatives.candidates(scoped, excluding: original?.barcode ?? barcode, category: category,
            basisUnit: basisUnit ?? original?.basisUnit,
            nutritionPreparation: nutritionPreparation ?? (basisUnit == nil ? original?.nutritionPreparation : nil))
    }

    private func fetch(_ url: URL, onRequestSent: (() -> Void)? = nil) async throws -> Data {
        try Task.checkCancellation()
        try await productReadState.reserve(at: now())
        var request = URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 15)
        request.setValue("Nudge/0.1.1 (iOS; org.example.nudge)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        do {
            onRequestSent?()
            let (data, http) = try await BoundedHTTPData.load(request, session: session, maximumBytes: 2_000_000)
            switch http.statusCode {
            case 200:
                guard data.count <= 2_000_000 else { throw BarcodeLookupError.invalidResponse }
                return data
            case 404:
                throw BarcodeLookupError.notFound
            case 429:
                let seconds = Self.searchRetryAfter(http.value(forHTTPHeaderField: "Retry-After"), at: now(), fallback: 60)
                await productReadState.pause(seconds: seconds, at: now())
                throw BarcodeLookupError.retryLater(seconds)
            case 500...599:
                throw BarcodeLookupError.server(http.statusCode)
            default:
                throw BarcodeLookupError.invalidResponse
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as BarcodeLookupError {
            throw error
        } catch let error as URLError where error.code == .timedOut {
            throw BarcodeLookupError.timeout
        } catch let error as URLError where [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost].contains(error.code) {
            throw BarcodeLookupError.offline
        } catch {
            throw BarcodeLookupError.invalidResponse
        }
    }
}


/// The category selection is an allowlist, never caller-supplied query syntax.
struct ProductSearchCategory: Identifiable, Equatable, Hashable {
    let id: String
    let title: String
    let tags: [String]
    let symbol: String
    let colourIndex: Int

    static let all: [Self] = {
        let rows: [(String, String, [String], String)] = [
            ("fruit", "Fruit", ["en:fruits", "en:fresh-fruits", "en:dried-fruits"], "leaf"),
            ("vegetables", "Vegetables", ["en:vegetables", "en:fresh-vegetables"], "leaf"),
            ("salad", "Salad & herbs", ["en:salads-without-dressing", "en:salads", "en:fresh-herbs", "en:herbs", "en:lettuces"], "leaf"),
            ("dairy", "Milk & dairy", ["en:dairies", "en:milks", "en:creams", "en:plant-milks"], "drop"),
            ("eggs", "Eggs", ["en:eggs"], "oval"),
            ("cheese", "Cheese", ["en:cheeses"], "triangle"),
            ("yoghurt", "Yoghurt", ["en:yogurts", "en:yoghurts", "en:plant-based-yogurts"], "cup.and.saucer"),
            ("meat", "Meat & poultry", ["en:meats", "en:poultries"], "fork.knife"),
            ("fish", "Fish & seafood", ["en:seafood", "en:fishes", "en:fish", "en:shellfish"], "fish"),
            ("alternatives", "Meat alternatives", ["en:meat-analogues", "en:meat-substitutes", "en:tofu", "en:tempeh", "en:vegetarian-sausages"], "leaf"),
            ("bakery", "Bakery & bread", ["en:breads", "en:pastries", "en:bakery-products"], "birthday.cake"),
            ("ready", "Ready meals", ["en:meals", "en:prepared-meals", "en:ready-meals"], "takeoutbag.and.cup.and.straw"),
            ("pulses", "Beans & pulses", ["en:legumes", "en:pulses", "en:beans", "en:baked-beans", "en:lentils", "en:chickpeas"], "leaf"),
            ("pasta", "Pasta & noodles", ["en:pastas", "en:noodles"], "fork.knife"),
            ("rice", "Rice", ["en:rices", "en:rice"], "takeoutbag.and.cup.and.straw"),
            ("cereals", "Cereals", ["en:breakfast-cereals", "en:oat-flakes", "en:porridge", "en:mueslis"], "sun.max"),
            ("nuts", "Nuts", ["en:nuts", "en:seeds", "en:nuts-and-their-products"], "leaf"),
            ("frozen", "Frozen food", ["en:frozen-foods"], "snowflake"),
            ("tins", "Tins & cans", ["en:canned-foods", "en:canned-vegetables", "en:canned-legumes", "en:canned-fishes"], "cylinder"),
            ("snacks", "Crisps & snacks", ["en:salty-snacks", "en:crisps", "en:chips", "en:crackers"], "bag"),
            ("desserts", "Desserts", ["en:desserts", "en:puddings"], "birthday.cake"),
            ("icecream", "Ice cream", ["en:ice-creams", "en:sorbets", "en:frozen-desserts"], "snowflake"),
            ("chocolate", "Chocolate & sweets", ["en:chocolates", "en:candies", "en:confectioneries", "en:sweets"], "square.grid.2x2"),
            ("sauces", "Sauces & ingredients", ["en:sauces", "en:condiments", "en:spices", "en:cooking-helpers", "en:oils", "en:vinegars"], "drop"),
            ("spreads", "Jams & spreads", ["en:spreads", "en:jams", "en:nut-butters", "en:honeys"], "cylinder"),
            ("baking", "Flour & baking", ["en:flours", "en:baking-ingredients", "en:yeasts", "en:baking-powders", "en:sugars"], "birthday.cake"),
            ("juice", "Fruit juice", ["en:fruit-juices", "en:fruit-nectars"], "drop"),
            ("drinks", "Drinks", ["en:beverages"], "cup.and.saucer")
        ]
        // Category identity, rather than list position, determines its colour.
        let colours: [String: Int] = [
            "fruit": 1, "vegetables": 5, "salad": 5, "dairy": 3, "eggs": 2, "cheese": 2,
            "yoghurt": 0, "meat": 1, "fish": 3, "alternatives": 5, "bakery": 2, "ready": 4,
            "pulses": 5, "pasta": 2, "rice": 2, "cereals": 2, "nuts": 5, "frozen": 3,
            "tins": 4, "snacks": 1, "desserts": 0, "icecream": 4, "chocolate": 0,
            "sauces": 1, "spreads": 0, "baking": 2, "juice": 1, "drinks": 4
        ]
        return rows.map { row in
            Self(id: row.0, title: row.1, tags: row.2, symbol: row.3, colourIndex: colours[row.0] ?? 3)
        }
    }()
}

/// Public catalogue availability, not the phone's location or live shelf stock.
enum ProductSearchMarket: String, CaseIterable, Identifiable {
    case unitedKingdom, allCountries
    var id: String { rawValue }
    var title: String { self == .unitedKingdom ? "United Kingdom" : "All countries" }
}

/// Provider store names have inconsistent punctuation. Both query and result
/// validation use this fixed allowlist; no retailer is inferred from the brand.
enum ProductSearchStore: String, CaseIterable, Identifiable {
    case tesco, sainsburys, asda, morrisons, aldi, lidl, waitrose, marksAndSpencer, coOp, ocado, iceland, farmfoods, heronFoods, booths, budgens, spar, boots
    var id: String { rawValue }
    var title: String {
        switch self {
        case .tesco: "Tesco"
        case .sainsburys: "Sainsbury’s"
        case .asda: "Asda"
        case .morrisons: "Morrisons"
        case .aldi: "Aldi"
        case .lidl: "Lidl"
        case .waitrose: "Waitrose"
        case .marksAndSpencer: "M&S"
        case .coOp: "Co-op"
        case .ocado: "Ocado"
        case .iceland: "Iceland"
        case .farmfoods: "Farmfoods"
        case .heronFoods: "Heron Foods"
        case .booths: "Booths"
        case .budgens: "Budgens"
        case .spar: "Spar"
        case .boots: "Boots"
        }
    }
    var sourceNames: [String] {
        switch self {
        // Search-a-licious stores are case-sensitive display names. Keep the
        // older aliases too because provider listings contain several spellings.
        case .sainsburys: ["Sainsbury's", "Sainsburys", "Sainsbury", "sainsbury's", "sainsburys", "sainsbury"]
        case .marksAndSpencer: ["Marks & Spencer", "Marks and Spencer", "M&S", "M&S Food", "marks & spencer", "marks and spencer", "marks-spencer", "m&s", "m&s food"]
        case .coOp: ["Co-op", "Coop", "Co-operative", "The Co-operative", "co-op", "coop", "co-operative", "cooperative", "the co-operative"]
        case .asda: ["Asda", "ASDA", "asda"]
        case .aldi: ["Aldi", "ALDI", "aldi"]
        case .lidl: ["Lidl", "LIDL", "lidl"]
        case .farmfoods: ["Farmfoods", "Farm Foods", "farmfoods", "farm foods"]
        case .heronFoods: ["Heron Foods", "heron foods"]
        case .booths: ["Booths", "Booths Supermarkets", "booths", "booths supermarkets"]
        case .budgens: ["Budgens", "budgens"]
        case .spar: ["Spar", "SPAR", "spar"]
        case .boots: ["Boots", "Boots UK", "boots", "boots uk"]
        default: [title, rawValue]
        }
    }
    func contains(sourceStore: String) -> Bool {
        func normalize(_ text: String) -> String {
            text.lowercased().replacingOccurrences(of: "en:", with: "").filter { $0.isLetter || $0.isNumber }
        }
        return sourceNames.map(normalize).contains(normalize(sourceStore))
    }
}

/// Searches are explicit submissions; no profile, inferred cycle state or diary
/// is sent. The optional support context is a user-selected catalogue filter.
struct ProductSearchQuery: Equatable {
    enum CataloguePolicy: Equatable { case prefer, only, skip }
    static let pageSize = 20
    static let maximumPage = 20
    var text: String
    let page: Int
    var category: ProductSearchCategory?
    let isDiscovery: Bool
    let market: ProductSearchMarket
    let store: ProductSearchStore?
    var sortOrder: NativeProductSearchSort = .relevance
    var prefixMatch = false
    var supportContext: ProductSupportContext? = nil
    var cataloguePolicy: CataloguePolicy = .prefer
    var dietary: Set<SearchDietaryRequirement> = []
    var nutrition: Set<SearchNutritionChoice> = []
    var nutritionMode: SearchNutritionMode = .any
    var placeID: String? = nil

    init(discoveryText: String = "", page: Int = 1, market: ProductSearchMarket = .unitedKingdom, store: ProductSearchStore? = nil) throws {
        guard discoveryText.count <= 80, (1...Self.maximumPage).contains(page), store == nil || market == .unitedKingdom, !discoveryText.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw ProductSearchError.invalidQuery }
        self.text = discoveryText; self.page = page; self.category = nil; self.isDiscovery = true; self.market = market; self.store = store
    }

    /// An explicit phase/life-stage browse needs no food keyword or profile.
    init(supportContext: ProductSupportContext, page: Int = 1,
         market: ProductSearchMarket = .unitedKingdom, store: ProductSearchStore? = nil) throws {
        guard (1...Self.maximumPage).contains(page), store == nil || market == .unitedKingdom else {
            throw ProductSearchError.invalidQuery
        }
        self.text = ""; self.page = page; self.category = nil; self.isDiscovery = true
        self.market = market; self.store = store; self.supportContext = supportContext
    }

    init(_ text: String, page: Int) throws {
        let cleaned = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard (2...80).contains(cleaned.count), (1...Self.maximumPage).contains(page),
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              cleaned.range(of: #"\b(luteal|follicular|ovulation|menstrual|period|perimenopause|menopause|hormonal|hormones)\b|\d\s*%"#, options: [.regularExpression, .caseInsensitive]) == nil else {
            throw ProductSearchError.invalidQuery
        }
        self.text = cleaned
        self.page = page
        self.category = nil
        self.isDiscovery = false
        self.market = .allCountries
        self.store = nil
    }

    /// Native search treats the whole submission as literal product/brand text.
    init(literalText text: String, page: Int = 1, market: ProductSearchMarket = .unitedKingdom, store: ProductSearchStore? = nil) throws {
        let cleaned = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard (2...80).contains(cleaned.count), (1...Self.maximumPage).contains(page),
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw ProductSearchError.invalidQuery
        }
        self.text = cleaned
        self.page = page
        self.category = nil
        guard store == nil || market == .unitedKingdom else { throw ProductSearchError.invalidQuery }
        self.isDiscovery = true
        self.market = market
        self.store = store
    }

    init(category: ProductSearchCategory, page: Int = 1, market: ProductSearchMarket = .unitedKingdom, store: ProductSearchStore? = nil) throws {
        guard ProductSearchCategory.all.contains(category), (1...Self.maximumPage).contains(page) else {
            throw ProductSearchError.invalidQuery
        }
        self.text = ""
        self.page = page
        self.category = category
        guard store == nil || market == .unitedKingdom else { throw ProductSearchError.invalidQuery }
        self.isDiscovery = true
        self.market = market
        self.store = store
    }

    var key: String {
        let discovery = "discoveryFilters:v1:\(dietary.map(\.rawValue).sorted().joined(separator: ",")):\(nutrition.map(\.rawValue).sorted().joined(separator: ",")):\(nutritionMode.rawValue):"
        let support = discovery + (supportContext.map { "support:v1:\($0.rawValue):" } ?? "")
        let scope = "market:\(market.rawValue):store:\(placeID == nil ? (store?.rawValue ?? "all") : "all"):place:v1:\(placeID ?? "all"):"
        let sort = sortOrder == .relevance ? "" : ":sort:\(sortOrder.rawValue)"
        // Mode precedes a fixed namespace, so literal punctuation in a product
        // query cannot impersonate a prefix flag (for example “bread:prefix”).
        let mode = prefixMatch ? "prefix:v1:" : ""
        if let category { return "\(mode)\(support)category:v3:\(scope)\(category.id):\(page):\(category.tags.joined(separator: "|")):\(text.lowercased())\(sort)" }
        let normalized = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_GB"))
        return "\(mode)\(support)\(isDiscovery ? "discovery:v3:" + scope : "")\(page):\(normalized)\(sort)"
    }

    func matchesScope(_ product: BarcodeProduct) -> Bool {
        (market == .allCountries || product.countriesTags.contains("en:united-kingdom"))
            && (placeID != nil || (store.map { chosen in product.stores.contains(where: chosen.contains(sourceStore:)) } ?? true))
    }

    var freshLifetime: TimeInterval { isDiscovery ? 300 : ProductSearchState.freshLifetime }

    var url: URL {
        // OFF's public, documented full-text service. Do not fall back to the
        // heavily limited legacy CGI endpoint after 429/503 or rotate hosts.
        URL(string: "https://search.openfoodfacts.org/search")!
    }

    var parameters: [String: Any] {
        // Escape Lucene operators while leaving ordinary words as full text.
        // Quoting every word changes the service's multilingual matching and
        // can suppress valid spelling/category matches.
        let reserved = CharacterSet(charactersIn: "+-!(){}[]^\"~*?:\\/&|")
        let literal = text.split(whereSeparator: { $0.isWhitespace }).map { token in
            if ["AND", "OR", "NOT"].contains(token.uppercased()) { return "\"\(token)\"" }
            return token.unicodeScalars.map { reserved.contains($0) ? "\\\($0)" : String($0) }.joined()
        }.joined(separator: " AND ")
        let categoryTerms = category?.tags.map { "categories_tags:\"\($0)\"" }
        let categoryExpression = categoryTerms.map { $0.count > 1 ? "(" + $0.joined(separator: " OR ") + ")" : $0[0] }
        let baseExpression = [categoryExpression, literal.isEmpty ? nil : literal].compactMap { $0 }.joined(separator: " AND ")
        // Production Search-a-licious uses countries_tags but stores (not
        // stores_tags). Verified against its public response. Keep scope on
        // the server so pagination never broadens to worldwide/other shops.
        var restrictions: [String] = []
        if market == .unitedKingdom { restrictions.append("countries_tags:\"en:united-kingdom\"") }
        if let store {
            let terms = store.sourceNames.map { "stores:\"\($0)\"" }
            restrictions.append(terms.count == 1 ? terms[0] : "(" + terms.joined(separator: " OR ") + ")")
        }
        // The provider's keyword extraction can discard a parenthesised
        // multiword literal. Explicit token clauses retain baked-beans recall;
        // category OR groups must still be kept together before adding filters.
        let scopedBase = category == nil ? baseExpression : "(" + baseExpression + ")"
        let expression = restrictions.isEmpty ? baseExpression :
            ([scopedBase] + restrictions).joined(separator: " AND ")
        // Keep discovery compact. The existing parser preserves supplied facts
        // and unknowns; cards can retrieve exact full records in one bounded batch.
        let discoveryFields = ["code", "product_name", "product_name_en", "brands", "quantity",
            "categories_tags", "countries_tags", "stores", "stores_tags", "image_front_small_url", "nutriments", "nutrition", "nutrition_data_per",
            "nutrition_data_prepared", "nutrition_data_prepared_per",
            "product_quantity_unit", "serving_size", "serving_quantity", "serving_quantity_unit",
            "last_modified_t", "data_quality_errors_tags", "data_quality_warnings_tags", "last_indexed_datetime"]
        return ["q": expression, "page": page, "page_size": Self.pageSize,
                "langs": ["en"], "boost_phrase": true,
                "fields": isDiscovery ? discoveryFields : OpenFoodFactsService.fields.split(separator: ",").map(String.init) + ["last_indexed_datetime"]]
    }
}

enum ProductSearchError: Error, Equatable {
    case invalidQuery
    case rateLimited(Int)
    case providerRateLimited(Int)
    case unavailable
    case offline
    case timeout
    case providerBusy(Int, Int)
    case providerUnavailable(Int)
    case invalidResponse

    var code: String {
        switch self {
        case .invalidQuery: "invalidQuery"
        case .rateLimited, .providerRateLimited: "rateLimited"
        case .unavailable: "unavailable"
        case .offline: "offline"
        case .timeout: "timeout"
        case .providerBusy: "providerBusy"
        case .providerUnavailable: "unavailable"
        case .invalidResponse: "invalidResponse"
        }
    }
    var message: String {
        switch self {
        case .invalidQuery: "Enter a product or brand name using 2–80 characters, or choose a category."
        case .rateLimited(let seconds), .providerRateLimited(let seconds): "The food source allows a limited number of searches each minute. Try again in \(seconds) seconds. Recipes and saved products are still available."
        case .unavailable: "Live products are unavailable right now. Check your connection and try again. Your recipes and saved products are still available."
        case .offline: "You appear to be offline. Check your connection; recipes and previously loaded products are still available."
        case .timeout: "The food source took too long to respond. Try again; recipes and previously loaded products are still available."
        case .providerBusy(_, let seconds): "The food source is busy or temporarily limiting searches. Try again in \(seconds) seconds. Recipes and saved products are still available."
        case .providerUnavailable: "The food source could not complete this search. Recipes and saved products are still available. Try again later."
        case .invalidResponse: "The food source returned a result Nudge could not read. Try again later."
        }
    }
    var retryAfterSeconds: Int {
        switch self {
        case .rateLimited(let seconds), .providerRateLimited(let seconds), .providerBusy(_, let seconds): return seconds
        default: return 0
        }
    }
    var statusCode: Int? {
        switch self {
        case .providerRateLimited: return 429
        case .providerBusy(let status, _), .providerUnavailable(let status): return status
        default: return nil
        }
    }
}

struct ProductSearchPage {
    let query: ProductSearchQuery
    var products: [BarcodeProduct]
    let hasMore: Bool
    var cached = false
    var stale = false
    var fallbackCode: String? = nil
    var retryAfterSeconds = 0
    var cachedAt: String? = nil
    var httpStatus: Int? = nil
    var catalogueCoverage: String? = nil
    var supportCoverage: ProductSupportCoverage? = nil
    var supportTags: [String: [ProductSupportTag]] = [:]
    var total: Int? = nil
    var discoveryCoverage: ProductSupportCoverage? = nil
    var dietaryConflictCount: Int? = nil
    var dietaryUnknownCount: Int? = nil
    var placeCoverage: ProductSupportCoverage? = nil
    var placeEvidence: [String: ProductPlaceEvidence] = [:]

    static func parse(_ data: Data, query: ProductSearchQuery, retrievedAt: Date) throws -> Self {
        guard data.count <= 2_000_000,
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw ProductSearchError.invalidResponse
        }
        // A partial or error envelope must not become a false empty search.
        if (root["timed_out"] as? Bool) == true { throw ProductSearchError.timeout }
        if let error = root["error"], !(error is NSNull) { throw ProductSearchError.invalidResponse }
        if let errors = root["errors"] as? [Any], !errors.isEmpty { throw ProductSearchError.invalidResponse }
        let indexed = root["hits"] != nil
        guard let raw = (indexed ? root["hits"] : root["products"]) as? [[String: Any]],
              raw.count <= ProductSearchQuery.pageSize else { throw ProductSearchError.invalidResponse }
        if let returnedPage = integer(root["page"]), returnedPage != query.page {
            throw ProductSearchError.invalidResponse
        }
        if indexed, integer(root["page"]) != query.page { throw ProductSearchError.invalidResponse }
        if let size = integer(root["page_size"]), size != ProductSearchQuery.pageSize { throw ProductSearchError.invalidResponse }
        var seen = Set<String>()
        let products = raw.compactMap { record -> BarcodeProduct? in
            var fields = record
            // The search index returns brands/stores as arrays; the product API
            // returns a comma-separated display value. Facts otherwise retain
            // the same barcode parser and its missing-value/preparation checks.
            if let brands = record["brands"] as? [String] { fields["brands"] = brands.joined(separator: ", ") }
            if let stores = record["stores"] as? [String] { fields["stores"] = stores.joined(separator: ", ") }
            guard let data = try? JSONSerialization.data(withJSONObject: ["product": fields]),
                  var product = try? OpenFoodFactsParser.parse(data: data, barcode: "", retrievedAt: retrievedAt),
                  query.category.map({ !Set($0.tags).isDisjoint(with: product.categories) }) ?? true,
                  query.matchesScope(product),
                  seen.insert(product.barcode).inserted else { return nil }
            if indexed {
                product.searchProvider = "open_food_facts_search"
                product.searchIndexedAt = indexDate(record["last_indexed_datetime"], noLaterThan: retrievedAt)
            }
            if query.isDiscovery {
                let basis = (record["nutrition"] as? [String: Any])?["aggregated_set"] as? [String: Any]
                // A compact index snapshot cannot prove which preparation its
                // legacy values describe. Keep it unrateable until explicit
                // structured evidence or a current full barcode record exists.
                if !["100g", "100ml"].contains(basis?["per"] as? String ?? "")
                    || !["as_sold", "prepared"].contains(basis?["preparation"] as? String ?? "") {
                    product.nutritionPreparation = nil
                    product.servingPreparation = nil
                }
            }
            return product
        }
        if !raw.isEmpty && products.isEmpty { throw ProductSearchError.invalidResponse }
        // Provider totals precede local rating/nutrition filters. Never call
        // this the number of matching Nudge results or infer zero from null.
        let count = integer(root["count"])
        let more = integer(root["page_count"]).map { query.page < $0 }
            ?? count.map { query.page * ProductSearchQuery.pageSize < $0 }
            ?? (raw.count == ProductSearchQuery.pageSize)
        return Self(query: query, products: products, hasMore: query.page < ProductSearchQuery.maximumPage && more)
    }

    private static func integer(_ raw: Any?) -> Int? {
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
              value.doubleValue >= 0, value.doubleValue < Double(Int.max), value.doubleValue.rounded() == value.doubleValue else { return nil }
        return value.intValue
    }

    private static func indexDate(_ raw: Any?, noLaterThan now: Date) -> String? {
        guard var text = raw as? String, text.count <= 40 else { return nil }
        // The published service returns an ISO timestamp without its UTC suffix.
        if text.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?$"#, options: .regularExpression) != nil { text += "Z" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var parsed = formatter.date(from: text)
        if parsed == nil { formatter.formatOptions = [.withInternetDateTime]; parsed = formatter.date(from: text) }
        guard let date = parsed, date <= now else { return nil }
        return ISO8601DateFormatter().string(from: date)
    }
}

/// Only public product pages and research annotations are persisted, under a
/// hash of the query and explicitly selected filters. No raw query, profile,
/// inferred cycle state, diary, or personal photo is written here.
/// Cached pages remain useful after a restart or temporary provider outage.
enum ProductSourceRoute: String {
    case discovery
    case factsBatch = "facts_batch"
    case alternatives

    // Exact facts and alternatives use the same source host; discovery uses
    // the independently served search index. Rate limits remain shared.
    var outageGroup: ProductSourceRoute { self == .discovery ? .discovery : .factsBatch }
}

actor ProductSearchState {
    // Persisted pages also contained the original image-less source records.
    static let directoryName = "NudgeProductSearch-v2"
    static let shared = ProductSearchState(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent(directoryName, isDirectory: true))
    private struct Entry: Codable {
        let version: Int
        let saved: Date
        let products: [BarcodeProduct]
        let hasMore: Bool
        var catalogueCoverage: String? = nil
        var supportCoverage: ProductSupportCoverage? = nil
        var supportTags: [String: [ProductSupportTag]]? = nil
        var total: Int? = nil
        var discoveryCoverage: ProductSupportCoverage? = nil
        var dietaryConflictCount: Int? = nil
        var dietaryUnknownCount: Int? = nil
        var placeCoverage: ProductSupportCoverage? = nil
        var placeEvidence: [String: ProductPlaceEvidence]? = nil
    }
    private let directory: URL?
    private let persistenceQueue: DispatchQueue
    private var pages: [String: (saved: Date, result: ProductSearchPage)] = [:]
    private struct Flight {
        let task: Task<ProductSearchPage, Error>
        var readers: Set<UUID>
    }
    private var flights: [String: Flight] = [:]
    private var requests: [Date] = []
    private var blockedUntil = Date.distantPast
    private var blockedStatus: Int? = nil
    private var routeOutages: [ProductSourceRoute: (until: Date, status: Int)] = [:]
    private let maximumRequests = 8 // OFF allows 10 search requests/min/IP.
    static let freshLifetime: TimeInterval = 86_400
    static let staleLifetime: TimeInterval = 7 * 86_400

    init(directory: URL? = nil, persistenceQueue: DispatchQueue = DispatchQueue(label: "com.nudge.search-cache", qos: .utility)) {
        self.directory = directory
        self.persistenceQueue = persistenceQueue
    }

    func join(_ query: ProductSearchQuery, reader: UUID,
              operation: @escaping () async throws -> ProductSearchPage) -> Task<ProductSearchPage, Error> {
        let flightKey = String(describing: query.cataloguePolicy) + ":" + query.key
        if var flight = flights[flightKey] {
            flight.readers.insert(reader)
            flights[flightKey] = flight
            return flight.task
        }
        let task = Task { try await operation() }
        flights[flightKey] = Flight(task: task, readers: [reader])
        return task
    }

    func leave(_ query: ProductSearchQuery, reader: UUID) {
        let flightKey = String(describing: query.cataloguePolicy) + ":" + query.key
        guard var flight = flights[flightKey], flight.readers.remove(reader) != nil else { return }
        if flight.readers.isEmpty {
            flights.removeValue(forKey: flightKey)
            flight.task.cancel()
        } else { flights[flightKey] = flight }
    }

    private func file(_ query: ProductSearchQuery) -> URL? {
        let digest = SHA256.hash(data: Data(query.key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory?.appendingPathComponent(digest + ".json")
    }

    func cached(_ query: ProductSearchQuery, at date: Date, allowingStale: Bool = false) -> ProductSearchPage? {
        pages = pages.filter { date.timeIntervalSince($0.value.saved) >= 0 && date.timeIntervalSince($0.value.saved) < Self.staleLifetime }
        if pages[query.key] == nil, let url = file(query),
           let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 1_500_000,
           let data = try? Data(contentsOf: url), let entry = try? JSONDecoder().decode(Entry.self, from: data),
           (entry.version == 2 || (entry.version == 1 && !entry.products.isEmpty)), entry.products.count <= ProductSearchQuery.pageSize,
           date.timeIntervalSince(entry.saved) >= 0, date.timeIntervalSince(entry.saved) < Self.staleLifetime,
           entry.products.allSatisfy({ $0.hasTrustedCatalogueSource && $0.barcode.range(of: #"^[0-9]{4,18}$"#, options: .regularExpression) != nil }) {
            var result = ProductSearchPage(query: query, products: entry.products, hasMore: entry.hasMore)
            result.catalogueCoverage = entry.catalogueCoverage
            result.total = entry.total
            result.discoveryCoverage = entry.discoveryCoverage
            result.dietaryConflictCount = entry.dietaryConflictCount
            result.dietaryUnknownCount = entry.dietaryUnknownCount
            result.placeCoverage = entry.placeCoverage
            result.placeEvidence = entry.placeEvidence ?? [:]
            result.supportCoverage = entry.supportCoverage
            result.supportTags = entry.supportTags ?? [:]
            pages[query.key] = (entry.saved, result)
            trimMemory()
        }
        guard let page = pages[query.key] else { return nil }
        if let placeID = query.placeID {
            guard page.result.products.allSatisfy({ product in
                guard let match = page.result.placeEvidence[product.barcode]?.association(for: placeID, product: product) else { return false }
                return !match.isCandidate && match.confidence == "source_metadata"
            }) else { return nil }
        }
        // During catalogue tagging, even a recent phase page can omit newly
        // reviewed matches. Fetch again on an explicit search; keep nonempty
        // pages only for the labelled outage fallback below.
        let incompleteSupport = query.supportContext != nil && page.result.supportCoverage?.complete != true
        let incompletePlaces = query.placeID != nil && page.result.placeCoverage?.complete != true
        let stale = incompleteSupport || incompletePlaces || date.timeIntervalSince(page.saved) >= query.freshLifetime
        guard !stale || allowingStale else { return nil }
        // An old empty page must not disguise a failed current lookup as no matches.
        guard !stale || !page.result.products.isEmpty else { return nil }
        var result = page.result
        result.cached = true
        result.stale = stale || result.products.contains { $0.catalogueSourceExpiresAt.map({ $0 <= date }) ?? false }
        result.cachedAt = ISO8601DateFormatter().string(from: page.saved)
        result.httpStatus = nil
        return result
    }
    private func remember(_ result: ProductSearchPage, at date: Date) -> Bool {
        guard (!result.stale || result.catalogueCoverage != nil), result.fallbackCode == nil,
              pages[result.query.key].map({ $0.saved <= date }) ?? true else { return false }
        pages[result.query.key] = (date, result)
        trimMemory()
        return true
    }

    /// Explicit persistence is awaitable for callers that need a durable page.
    func save(_ result: ProductSearchPage, at date: Date) async {
        guard remember(result, at: date) else { return }
        let directory = directory
        await withCheckedContinuation { continuation in
            persistenceQueue.async {
                Self.persist(result, at: date, directory: directory)
                continuation.resume()
            }
        }
    }

    /// Publish the exact scoped page in memory before durable cache maintenance.
    /// One serial utility queue preserves write order; product cache revision
    /// guards continue to reject older label facts arriving from other requests.
    func saveForDelivery(_ result: ProductSearchPage, at date: Date, productCache: ProductLookupCache?) {
        guard remember(result, at: date) else { return }
        let directory = directory
        persistenceQueue.async {
            Self.persist(result, at: date, directory: directory)
            productCache?.write(result.products, now: date)
        }
    }

    func flushPersistence() async {
        await withCheckedContinuation { continuation in
            persistenceQueue.async { continuation.resume() }
        }
    }

    private nonisolated static func persist(_ result: ProductSearchPage, at date: Date, directory: URL?) {
        guard let directory,
              let data = try? JSONEncoder().encode(Entry(version: 2, saved: date, products: result.products, hasMore: result.hasMore,
                                                        catalogueCoverage: result.catalogueCoverage,
                                                        supportCoverage: result.supportCoverage, supportTags: result.supportTags, total: result.total, discoveryCoverage: result.discoveryCoverage, dietaryConflictCount: result.dietaryConflictCount, dietaryUnknownCount: result.dietaryUnknownCount, placeCoverage: result.placeCoverage, placeEvidence: result.placeEvidence)),
              data.count <= 1_500_000 else { return }
        let digest = SHA256.hash(data: Data(result.query.key.utf8)).map { String(format: "%02x", $0) }.joined()
        let url = directory.appendingPathComponent(digest + ".json")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey])
                .filter { $0.pathExtension == "json" }.sorted {
                    ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) >
                    ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
                }
            var total = 0
            for (index, file) in files.enumerated() {
                let values = try? file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                total += values?.fileSize ?? 1_500_000
                let age = date.timeIntervalSince(values?.contentModificationDate ?? .distantPast)
                if index >= 24 || total > 8_000_000 || age < 0 || age >= Self.staleLifetime { try? FileManager.default.removeItem(at: file) }
            }
        } catch { /* Public cache failure must not fail search. */ }
    }
    private func trimMemory() {
        while pages.count > 24, let oldest = pages.min(by: { $0.value.saved < $1.value.saved })?.key { pages.removeValue(forKey: oldest) }
    }
    func reserve(at date: Date, route: ProductSourceRoute = .discovery) throws {
        if blockedUntil > date {
            let seconds = Int(min(Double(Int.max / 2), ceil(blockedUntil.timeIntervalSince(date))))
            if blockedStatus == 429 { throw ProductSearchError.providerRateLimited(seconds) }
            if let status = blockedStatus { throw ProductSearchError.providerBusy(status, seconds) }
            throw ProductSearchError.rateLimited(seconds)
        }
        if let outage = routeOutages[route.outageGroup], outage.until > date {
            throw ProductSearchError.providerBusy(outage.status, max(1, Int(min(Double(Int.max / 2), ceil(outage.until.timeIntervalSince(date))))))
        }
        routeOutages = routeOutages.filter { $0.value.until > date }
        requests = requests.filter { date.timeIntervalSince($0) >= 0 && date.timeIntervalSince($0) < 60 }
        if requests.count >= maximumRequests, let first = requests.first {
            throw ProductSearchError.rateLimited(max(1, Int(ceil(60 - date.timeIntervalSince(first)))))
        }
        requests.append(date)
    }
    func pause(seconds: Int, at date: Date, statusCode: Int? = nil, route: ProductSourceRoute = .discovery) {
        let until = date.addingTimeInterval(Double(max(1, seconds)))
        if let statusCode, (500...599).contains(statusCode) {
            let key = route.outageGroup
            if until > (routeOutages[key]?.until ?? .distantPast) { routeOutages[key] = (until, statusCode) }
        } else if until > blockedUntil {
            // Explicit throttles remain global; changing endpoints cannot
            // bypass a source Retry-After or the aggregate request allowance.
            blockedUntil = until; blockedStatus = statusCode
        }
    }
}

/// Public candidate facts only; comparison and dietary checks are reapplied for
/// each review. Coalesced readers share a request without cancelling each other.
actor ProductAlternativesState {
    static let shared = ProductAlternativesState()
    private var pages: [String: (Date, [BarcodeProduct])] = [:]
    private struct Flight {
        let task: Task<[BarcodeProduct], Error>
        var readers: Set<UUID>
    }
    private var flights: [String: Flight] = [:]
    func invalidate() { pages.removeAll() }
    func load(key: String, at date: Date, operation: @escaping () async throws -> [BarcodeProduct]) async throws -> [BarcodeProduct] {
        try Task.checkCancellation()
        pages = pages.filter { (0..<600).contains(date.timeIntervalSince($0.value.0)) }
        if let saved = pages[key] { return saved.1 }
        let reader = UUID()
        let task: Task<[BarcodeProduct], Error>
        if var flight = flights[key] {
            flight.readers.insert(reader); flights[key] = flight; task = flight.task
        } else {
            task = Task { try await operation() }
            flights[key] = Flight(task: task, readers: [reader])
        }
        return try await withTaskCancellationHandler {
            do {
                let result = try await task.value
                try Task.checkCancellation()
                // A temporary catalogue gap must not hide newly available
                // options for ten minutes. Successful pools remain reusable.
                if !result.isEmpty { pages[key] = (date, result) }
                if pages.count > 24, let oldest = pages.min(by: { $0.value.0 < $1.value.0 })?.key { pages.removeValue(forKey: oldest) }
                leave(key, reader: reader)
                return result
            } catch { leave(key, reader: reader); throw error }
        } onCancel: { Task { await self.leave(key, reader: reader) } }
    }
    private func leave(_ key: String, reader: UUID) {
        guard var flight = flights[key], flight.readers.remove(reader) != nil else { return }
        if flight.readers.isEmpty { flights.removeValue(forKey: key); flight.task.cancel() }
        else { flights[key] = flight }
    }
}

private final class ProductSearchTransport: NSObject, URLSessionTaskDelegate {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        return URLSession(configuration: configuration, delegate: ProductSearchTransport(), delegateQueue: nil)
    }()
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

extension OpenFoodFactsService {
    static func searchRetryAfter(_ value: String?, at date: Date, fallback: Int) -> Int {
        let clean = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let seconds = Int(clean) { return max(1, seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let until = formatter.date(from: clean) { return max(1, Int(min(Double(Int.max / 2), ceil(until.timeIntervalSince(date))))) }
        return max(1, min(fallback, 3600))
    }

    func search(query rawQuery: String, page: Int = 1, diagnosticRequestID: String? = nil) async throws -> ProductSearchPage {
        let query = try ProductSearchQuery(rawQuery, page: page)
        return try await search(query: query, diagnosticRequestID: diagnosticRequestID)
    }

    func cachedSearchPage(query: ProductSearchQuery) async -> ProductSearchPage? {
        let query = scopedQuery(query)
        guard !Task.isCancelled,
              let page = await searchState.cached(query, at: now(), allowingStale: true),
              query.cataloguePolicy == .prefer || (page.catalogueCoverage != nil) == (query.cataloguePolicy == .only) else { return nil }
        return page
    }

    func search(query: ProductSearchQuery, diagnosticRequestID: String? = nil) async throws -> ProductSearchPage {
        let query = scopedQuery(query)
        guard query.isDiscovery else { return try await performSearch(query: query, diagnosticRequestID: diagnosticRequestID) }
        let reader = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let task = await searchState.join(query, reader: reader) {
                try await performSearch(query: query, diagnosticRequestID: diagnosticRequestID)
            }
            do {
                // Cancellation may arrive between the initial check and join.
                try Task.checkCancellation()
                let result = try await task.value
                await searchState.leave(query, reader: reader)
                try Task.checkCancellation()
                return result
            } catch {
                await searchState.leave(query, reader: reader)
                throw error
            }
        } onCancel: {
            Task { await searchState.leave(query, reader: reader) }
        }
    }

    private func scopedQuery(_ input: ProductSearchQuery) -> ProductSearchQuery {
        var query = input
        if sourcePolicy == .catalogueOnly || query.supportContext != nil || query.placeID != nil
            || !query.dietary.isEmpty || !query.nutrition.isEmpty { query.cataloguePolicy = .only }
        return query
    }

    private func performSearch(query: ProductSearchQuery, diagnosticRequestID: String?) async throws -> ProductSearchPage {
        // OFF cannot apply Nudge's evidence tags. A scoped search must never
        // broaden silently, including on errors, empty pages or cache fallback.
        let query = scopedQuery(query)
        let started = now()
        var requestSent = false
        func preferCurrentFacts(_ original: ProductSearchPage) -> ProductSearchPage {
            var result = original
            result.products = result.products.map { product in
                guard product.searchProvider != nil, let current = cache?.read(barcode: product.barcode, now: now()),
                      current.searchProvider == nil, acceptsCachedProduct(current) else { return product }
                // Keep a newer, exact-barcode record rather than overwriting it
                // with an older discovery index. Never merge conflicting facts.
                guard NativeProductRatingEngine.isCurrentFullProduct(current, for: product), query.matchesScope(current) else { return product }
                return current
            }
            return result
        }
        func diagnostic(_ outcome: String, status: Int? = nil, result: ProductSearchPage? = nil, retry: Int = 0) {
            var metadata: [String: Any] = ["page": query.page, "queryLength": query.text.count,
                "elapsedMs": max(0, Int(now().timeIntervalSince(started) * 1000)), "retryAfterSeconds": retry,
                "searchProvider": query.cataloguePolicy == .only ? "nudge_catalogue" : "open_food_facts_search",
                "sourceRoute": query.cataloguePolicy == .only ? "catalogue_search" : "discovery", "requestSent": requestSent]
            if !requestSent {
                if outcome == "rateLimited" { metadata["gateReason"] = status == 429 ? "provider_pause" : "local_budget" }
                else if outcome == "providerBusy" { metadata["gateReason"] = "route_outage" }
            }
            if let diagnosticRequestID { metadata["requestHash"] = AnalysisDiagnostics.fingerprint(diagnosticRequestID) }
            if let status { metadata["httpStatus"] = status }
            if let result { metadata["resultCount"] = result.products.count; metadata["cached"] = result.cached; metadata["stale"] = result.stale }
            searchDiagnostics?.record(stage: "search_http", outcome: outcome, metadata: metadata)
        }
        try Task.checkCancellation()
        if let page = await searchState.cached(query, at: now()),
           query.cataloguePolicy == .prefer || (page.catalogueCoverage != nil) == (query.cataloguePolicy == .only) {
            let result = preferCurrentFacts(page)
            diagnostic("cached", result: result)
            return result
        }
        if query.cataloguePolicy != .skip, let catalogueSearch {
            do {
                let page = try await catalogueSearch(query)
                try Task.checkCancellation()
                if query.cataloguePolicy == .only || !page.products.isEmpty || page.hasMore || page.catalogueCoverage == "complete" {
                    await searchState.saveForDelivery(page, at: now(), productCache: cache)
                    return page
                }
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                if query.cataloguePolicy == .only {
                    if var page = await searchState.cached(query, at: now(), allowingStale: true), page.catalogueCoverage != nil {
                        page.stale = true; page.fallbackCode = (error as? ProductSearchError)?.code ?? "unavailable"
                        return preferCurrentFacts(page)
                    }
                    throw error
                }
            }
        }
        if query.cataloguePolicy == .only { throw ProductSearchError.unavailable }
        var request = URLRequest(url: query.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: query.parameters)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Nudge/0.1.1 (iOS; https://example.invalid/nudge)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            try await searchState.reserve(at: now(), route: .discovery)
            requestSent = true
            let (data, http) = try await BoundedHTTPData.load(request, session: searchSession, maximumBytes: 2_000_000)
            diagnostic("received", status: http.statusCode)
            if http.statusCode == 429 {
                let wait = Self.searchRetryAfter(http.value(forHTTPHeaderField: "Retry-After"), at: now(), fallback: 60)
                await searchState.pause(seconds: wait, at: now(), statusCode: 429)
                throw ProductSearchError.providerRateLimited(wait)
            }
            if (500...599).contains(http.statusCode) {
                let wait = Self.searchRetryAfter(http.value(forHTTPHeaderField: "Retry-After"), at: now(), fallback: 30)
                await searchState.pause(seconds: wait, at: now(), statusCode: http.statusCode)
                throw ProductSearchError.providerBusy(http.statusCode, wait)
            }
            guard http.statusCode == 200 else { throw ProductSearchError.providerUnavailable(http.statusCode) }
            var result = try ProductSearchPage.parse(data, query: query, retrievedAt: now())
            result.httpStatus = http.statusCode
            try Task.checkCancellation()
            result = preferCurrentFacts(result)
            // Index snapshots remain in the separate query cache. The product
            // lookup cache is reserved for full barcode records, so opening an
            // indexed result can actually refresh it.
            for product in result.products where product.searchProvider == nil { cache?.write(product, now: now()) }
            await searchState.save(result, at: now())
            diagnostic("parsed", status: http.statusCode, result: result)
            return result
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                diagnostic("cancelled")
                throw CancellationError()
            }
            let failure: ProductSearchError
            if let known = error as? ProductSearchError { failure = known }
            else if error is BoundedHTTPData.Failure { failure = .invalidResponse }
            else if let network = error as? URLError, network.code == .timedOut { failure = .timeout }
            else if let network = error as? URLError, [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(network.code) { failure = .offline }
            else { failure = .unavailable }
            diagnostic(failure.code, status: failure.statusCode, retry: failure.retryAfterSeconds)
            if var fallback = await searchState.cached(query, at: now(), allowingStale: true), !fallback.products.isEmpty,
               query.cataloguePolicy != .skip || fallback.catalogueCoverage == nil {
                fallback = preferCurrentFacts(fallback)
                fallback.fallbackCode = failure.code
                fallback.retryAfterSeconds = failure.retryAfterSeconds
                fallback.httpStatus = failure.statusCode
                diagnostic("stale", status: failure.statusCode, result: fallback, retry: failure.retryAfterSeconds)
                return fallback
            }
            throw failure
        }
    }
}


/// Conservative product-record matching, never an assertion of live shelf availability.
enum FoodAlternatives {
    private static let shops: [(String, String, [String])] = [
        ("Sainsbury’s", "sainsbury-s", ["sainsburys", "sainsbury"]),
        ("Tesco", "tesco", ["tesco"]), ("Asda", "asda", ["asda"]),
        ("Morrisons", "morrisons", ["morrisons"]), ("Waitrose", "waitrose", ["waitrose"]),
        ("Aldi", "aldi", ["aldi"]), ("Lidl", "lidl", ["lidl"]),
        ("Co-op", "co-op", ["coop", "cooperative"]),
        ("M&S", "marks-spencer", ["ms", "msfood", "marksandspencer", "marksspencer", "marksandspencerfood"]),
        ("Ocado", "ocado", ["ocado"]), ("Iceland", "iceland", ["iceland"]),
        ("SPAR", "spar", ["spar"]), ("Farmfoods", "farmfoods", ["farmfoods"]),
        ("Booths", "booths", ["booths"]), ("Whole Foods Market", "whole-foods-market", ["wholefoodsmarket"])
    ]
    static func canonicalRetailer(_ value: String?) -> String? {
        guard let value, value.count <= 160 else { return nil }
        let clean = value.lowercased().replacingOccurrences(of: "en:", with: "")
            .filter { $0.isLetter || $0.isNumber }
        return shops.first { $0.2.contains(clean) }?.0
    }
    static func storeTag(_ retailer: String) -> String? { shops.first { $0.0 == retailer }?.1 }
    static func retailer(brand: String?, stores: [String]) -> String? {
        let brands = (brand ?? "").split(separator: ",").compactMap { canonicalRetailer(String($0)) }
        if Set(brands).count == 1 { return brands.first }
        let retailers = Set(stores.compactMap(canonicalRetailer))
        return retailers.count == 1 ? retailers.first : nil
    }
    static func validCategory(_ tag: String) -> Bool {
        tag.count <= 80 && tag.range(of: #"^en:[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil
    }
    static func category(_ tags: [String]) -> String? {
        let broad: Set<String> = ["en:foods", "en:beverages", "en:plant-based-foods-and-beverages",
            "en:plant-based-foods", "en:snacks", "en:groceries", "en:dairies", "en:meats"]
        return tags.reversed().first { validCategory($0) && !broad.contains($0) }
    }
    static func candidates(_ products: [BarcodeProduct], excluding barcode: String?, category: String,
                           basisUnit: String?, nutritionPreparation: String?) -> [BarcodeProduct] {
        guard basisUnit == "g", nutritionPreparation == "as_sold" else { return [] }
        var seen = Set<String>()
        return Array(products.filter {
            !$0.barcode.isEmpty && $0.barcode != barcode && seen.insert($0.barcode).inserted
                && $0.categories.contains(category) && $0.basisUnit == basisUnit
                && $0.nutritionPreparation == nutritionPreparation
        }.prefix(40))
    }

}

@MainActor
protocol BarcodeScannerViewControllerDelegate: AnyObject {
    func barcodeScanner(_ scanner: BarcodeScannerViewController, didScan barcode: String)
    func barcodeScannerDidCancel(_ scanner: BarcodeScannerViewController)
    func barcodeScanner(_ scanner: BarcodeScannerViewController, didFail message: String)
}

@MainActor
final class BarcodeScannerViewController: UIViewController, DataScannerViewControllerDelegate {
    weak var delegate: BarcodeScannerViewControllerDelegate?
    private var dataScanner: DataScannerViewController?
    private var handledBarcode = false
    private var enteringBarcode = false
    private var cancelled = false
    private let instruction = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureChrome()
        Task { await prepareCamera() }
    }

    private func configureChrome() {
        let close = UIButton(type: .system)
        close.setTitle("Cancel", for: .normal)
        close.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        close.titleLabel?.adjustsFontForContentSizeCategory = true
        close.titleLabel?.numberOfLines = 0
        close.tintColor = .white
        close.backgroundColor = NudgeTheme.cameraScrim
        close.layer.cornerRadius = 18
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false

        instruction.text = "Centre the grocery barcode in the frame"
        instruction.font = .preferredFont(forTextStyle: .headline)
        instruction.textColor = .white
        instruction.adjustsFontForContentSizeCategory = true
        instruction.textAlignment = .center
        instruction.numberOfLines = 0
        instruction.backgroundColor = NudgeTheme.cameraScrim
        instruction.layer.cornerRadius = 14
        instruction.layer.masksToBounds = true
        instruction.translatesAutoresizingMaskIntoConstraints = false

        let enter = UIButton(type: .system)
        enter.setTitle("Enter code", for: .normal)
        enter.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        enter.titleLabel?.adjustsFontForContentSizeCategory = true
        enter.tintColor = .white; enter.backgroundColor = NudgeTheme.cameraScrim
        enter.layer.cornerRadius = 18; enter.translatesAutoresizingMaskIntoConstraints = false
        enter.accessibilityIdentifier = "barcode-scanner-enter-code"
        enter.addTarget(self, action: #selector(enterCode), for: .touchUpInside)

        view.addSubview(close)
        view.addSubview(instruction)
        view.addSubview(enter)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            close.widthAnchor.constraint(greaterThanOrEqualToConstant: 82),
            close.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            instruction.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            instruction.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            instruction.bottomAnchor.constraint(equalTo: enter.topAnchor, constant: -12),
            enter.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            enter.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            enter.widthAnchor.constraint(greaterThanOrEqualToConstant: 130),
            enter.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            instruction.heightAnchor.constraint(greaterThanOrEqualToConstant: 54)
        ])
    }

    private func prepareCamera() async {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        let allowed: Bool
        switch status {
        case .authorized:
            allowed = true
        case .notDetermined:
            allowed = await AVCaptureDevice.requestAccess(for: .video)
        default:
            allowed = false
        }
        guard !cancelled, !handledBarcode else { return }
        guard allowed else {
            cameraUnavailable("Camera access is off. Enter the code, or enable camera access in Settings.")
            return
        }
        guard DataScannerViewController.isSupported else {
            cameraUnavailable("Scanning is not supported on this iPhone. Enter the barcode instead.")
            return
        }
        guard DataScannerViewController.isAvailable else {
            cameraUnavailable("The camera is unavailable. Enter the barcode or try scanning again later.")
            return
        }

        let symbologies: [VNBarcodeSymbology] = [.ean13, .ean8, .upce]
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: symbologies)],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = self
        addChild(scanner)
        view.insertSubview(scanner.view, at: 0)
        scanner.view.frame = view.bounds
        scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scanner.didMove(toParent: self)
        dataScanner = scanner
        do {
            if !enteringBarcode { try scanner.startScanning() }
        } catch {
            cameraUnavailable("The camera could not start. Enter the barcode instead.")
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        guard !handledBarcode, !enteringBarcode, !cancelled else { return }
        guard case let .barcode(barcode) = addedItems.first,
              let payload = barcode.payloadStringValue else { return }
        let symbology: FoodBarcodeIdentity.Symbology
        switch barcode.observation.symbology {
        case .ean13: symbology = .ean13
        case .ean8: symbology = .ean8
        case .upce: symbology = .upce
        default: return
        }
        guard let code = FoodBarcodeIdentity.decoded(payload, symbology: symbology) else { return }
        accept(code)
    }

    private func accept(_ code: String) {
        guard !handledBarcode, !cancelled else { return }
        handledBarcode = true
        dataScanner?.stopScanning()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        delegate?.barcodeScanner(self, didScan: code)
    }

    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        cameraUnavailable("Scanning became unavailable. Enter the barcode instead.")
    }

    private func cameraUnavailable(_ message: String) {
        guard !cancelled, !handledBarcode else { return }
        instruction.text = message
    }
    @objc private func enterCode() {
        guard !handledBarcode, !cancelled, !enteringBarcode, presentedViewController == nil else { return }
        enteringBarcode = true; dataScanner?.stopScanning()
        FoodBarcodeEntry.present(from: self) { [weak self] code in
            guard let self, !cancelled, !handledBarcode else { return }
            enteringBarcode = false
            if let code { accept(code) }
            else if let scanner = dataScanner { try? scanner.startScanning() }
        }
    }

    @objc private func cancel() {
        cancelled = true
        dataScanner?.stopScanning()
        delegate?.barcodeScannerDidCancel(self)
    }
}

/// Public official notices only. Requests never include photographs, diary or profile.
/// The actor owns one bounded fetch across camera/review consumers. Dismissing a
/// result cancels that consumer, not the official check shared by the next scan.
actor FoodRecallService {
    static let shared = FoodRecallService()
    static let availableCacheLifetime: TimeInterval = 3600
    static let unavailableCacheLifetime: TimeInterval = 30
    private static let scope = "Latest 100 full FSA notices, including updates. Not a complete historical or independent Food Standards Scotland search."
    private let session: URLSession
    private let now: @Sendable () -> Date
    private var cache: Feed?
    private var cachedAt: Date?
    private var inFlight: (id: UUID, task: Task<Feed, Never>)?

    /// Serialized notices keep the service-owned task's result Sendable. Only
    /// the existing public JSON bridge receives dictionaries; no identity is held.
    private struct Feed: Sendable {
        let checkedAt: String
        let notices: Data?
        var available: Bool { notices != nil }
        var dictionary: [String: Any] {
            var result: [String: Any] = ["status": "check_unavailable", "checkedAt": checkedAt, "scope": FoodRecallService.scope]
            if let notices, let decoded = try? JSONSerialization.jsonObject(with: notices) as? [[String: Any]] {
                result["status"] = "available"; result["notices"] = decoded
            }
            return result
        }
    }

    init(session: URLSession? = nil, now: @escaping @Sendable () -> Date = { Date() }) {
        self.session = session ?? URLSession(configuration: Self.configuration())
        self.now = now
    }
    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 18
        configuration.urlCache = nil
        return configuration
    }

    func notices() async -> [String: Any] {
        let date = now()
        if let cache, let cachedAt {
            let age = date.timeIntervalSince(cachedAt)
            let lifetime = cache.available ? Self.availableCacheLifetime : Self.unavailableCacheLifetime
            if age >= 0, age < lifetime { return cache.dictionary }
        }
        if let inFlight { return await inFlight.task.value.dictionary }
        let id = UUID(), session = session
        // A detached service-owned task intentionally outlives individual callers.
        // It is still bounded by the ephemeral session's 18-second resource limit.
        let task = Task.detached(priority: .utility) { await Self.fetch(session: session, checkedAt: date) }
        inFlight = (id, task)
        let result = await task.value
        if inFlight?.id == id {
            cache = result; cachedAt = now(); inFlight = nil
        }
        return result.dictionary
    }

    private static func fetch(session: URLSession, checkedAt date: Date) async -> Feed {
        let checkedAt = ISO8601DateFormatter().string(from: date)
        let unavailable = Feed(checkedAt: checkedAt, notices: nil)
        var request = URLRequest(url: URL(string: "https://data.food.gov.uk/food-alerts/id?_limit=100&_sort=-created&_view=full")!)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Nudge/0.1.1 (iOS; org.example.nudge)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 2_000_000,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = object["items"] as? [[String: Any]], !items.isEmpty, items.count <= 100 else { return unavailable }
            let keys = Set(["notation", "title", "description", "created", "modified", "reportingBusiness", "alertURL", "consumerAdvice", "problem", "productDetails", "status"])
            let notices = items.map { $0.filter { keys.contains($0.key) } }
            return Feed(checkedAt: checkedAt, notices: try JSONSerialization.data(withJSONObject: notices))
        } catch { return unavailable }
    }
}
