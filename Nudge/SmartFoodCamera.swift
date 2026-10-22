import AVFoundation
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// The system normally mutes haptics while an audio input is active. Opt in
/// without changing category, activating audio, or interrupting the live camera.
protocol CameraHapticAudioSession {
    var allowHapticsAndSystemSoundsDuringRecording: Bool { get }
    func setAllowHapticsAndSystemSoundsDuringRecording(_ allowed: Bool) throws
}
extension AVAudioSession: CameraHapticAudioSession {}

enum CameraHapticAudioPolicy {
    @discardableResult
    static func prepare(_ audio: CameraHapticAudioSession = AVAudioSession.sharedInstance()) -> Bool {
        if audio.allowHapticsAndSystemSoundsDuringRecording { return true }
        do {
            try audio.setAllowHapticsAndSystemSoundsDuringRecording(true)
            return audio.allowHapticsAndSystemSoundsDuringRecording
        } catch {
            // Feedback is optional. A system interruption must not fail a photo
            // or voice note; the next session start retries the configuration.
            return false
        }
    }
}

/// One versioned permission, independent of the diary and the account session.
struct PhotoAnalysisPermission {
    static let key = "nudge-photo-ai-permission-v1"
    static let title = "AI food analysis"
    static let explanation = "Nudge’s service sends chosen photos, optional voice notes and public product facts to its server and OpenAI to read labels, explain ratings and estimate meals. If you enable ChatGPT for camera photos, selected photos, ingredient choices and portion details go directly to OpenAI using your plan. Captures with a voice note use Nudge’s service. The analysis action shows which service will be used."
    static let allowTitle = "Allow AI analysis"
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var allowed: Bool { defaults.bool(forKey: Self.key) }
    func allow() { defaults.set(true, forKey: Self.key) }
    func revoke() { defaults.removeObject(forKey: Self.key) }
}

/// Camera state prevents overlapping captures and duplicate paid requests.
struct SmartCaptureState {
    private(set) var images: [Data] = []
    private(set) var photoIDs: [String] = []
    private(set) var armed = true
    private(set) var capturing = false
    private(set) var shutterAcknowledged = false
    private(set) var importing = false
    private(set) var replacingIndex: Int?
    var replacingLastPhoto: Bool { replacingIndex != nil }
    private(set) var analysing = false
    private(set) var closed = false
    private(set) var revision = 0
    init(images: [Data] = [], photoIDs: [String] = [], revision: Int = 0) {
        let retained = Array(images.prefix(4))
        if retained.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }) {
            self.images = retained
            self.photoIDs = retained.indices.map { photoIDs.indices.contains($0) && UUID(uuidString: photoIDs[$0]) != nil ? photoIDs[$0] : UUID().uuidString }
        }
        self.revision = max(0, revision)
    }
    var canCapture: Bool { !closed && !capturing && !importing && !analysing && armed && (images.count < 4 || replacingLastPhoto) }
    var canAnalyse: Bool { !closed && !capturing && !importing && !analysing && !images.isEmpty }
    var canLeaveCapture: Bool { !capturing && !importing }
    var librarySlotsAvailable: Int { max(0, 4 - images.count) }
    var canImport: Bool { !closed && !capturing && !importing && !analysing && !replacingLastPhoto && librarySlotsAvailable > 0 }
    mutating func arm() {
        guard !closed, !capturing, !importing, !analysing, images.count < 4 || replacingLastPhoto else { return }
        armed = true
    }
    mutating func allowLastPhotoRetake() { if images.count == 4 { retake(at: 3) } }
    mutating func retake(at index: Int) {
        guard !closed, !capturing, !importing, images.indices.contains(index) else { return }
        analysing = false
        replacingIndex = index
        armed = true
    }
    mutating func cancelRetake() { replacingIndex = nil; armed = images.count < 4 }
    @discardableResult mutating func remove(at index: Int) -> Bool {
        guard !closed, images.indices.contains(index) else { return false }
        images.remove(at: index)
        photoIDs.remove(at: index)
        invalidate()
        return true
    }
    mutating func clearPhotos() {
        guard !closed else { return }
        images.removeAll()
        photoIDs.removeAll()
        invalidate()
    }
    /// A durable handoff owns the old bytes now. Keep revisions monotonic so a
    /// late photo, picker or analysis callback cannot enter the next batch.
    @discardableResult mutating func acceptSubmittedCapture(revision expected: Int) -> Bool {
        guard !closed, revision == expected, !images.isEmpty else { return false }
        clearPhotos()
        return true
    }
    mutating func voiceMemoChanged() { guard !closed else { return }; invalidate() }
    private mutating func invalidate() {
        revision += 1
        replacingIndex = nil
        capturing = false
        importing = false
        analysing = false
        armed = images.count < 4
    }
    mutating func beginCapture() -> Int? {
        guard canCapture else { return nil }
        capturing = true
        shutterAcknowledged = false
        armed = false
        return revision
    }
    /// Hardware exposure feedback belongs to the current shutter, before JPEG
    /// processing. A stale or duplicate callback must never flash a new draft.
    mutating func acknowledgeShutter(revision expected: Int) -> Bool {
        guard !closed, capturing, revision == expected, !shutterAcknowledged else { return false }
        shutterAcknowledged = true
        return true
    }
    mutating func finishCapture(_ data: Data?, revision expected: Int) -> Bool {
        guard !closed, revision == expected, capturing else { return false }
        capturing = false
        let retainedBytes = images.reduce(0, { $0 + $1.count }) - (replacingIndex.map { images[$0].count } ?? 0)
        guard let data, !data.isEmpty, images.count < 4 || replacingLastPhoto,
              data.count <= 1_500_000, data.count <= 6_000_000 - retainedBytes else {
            // A failed photo needs an explicit retry; never create an automatic loop.
            return false
        }
        if let replacingIndex { images[replacingIndex] = data; photoIDs[replacingIndex] = UUID().uuidString }
        else { images.append(data); photoIDs.append(UUID().uuidString) }
        replacingIndex = nil
        revision += 1
        return true
    }
    /// Picker cancellation leaves the complete draft, including its revision, alone.
    mutating func beginLibraryImport() -> Int? {
        guard canImport else { return nil }
        importing = true
        return revision
    }
    @discardableResult mutating func cancelLibraryImport(revision expected: Int) -> Bool {
        guard !closed, importing, revision == expected else { return false }
        importing = false
        return true
    }
    mutating func finishLibraryImport(_ photos: [Data], revision expected: Int) -> Bool {
        guard cancelLibraryImport(revision: expected), !photos.isEmpty,
              photos.count <= librarySlotsAvailable,
              photos.allSatisfy({ !$0.isEmpty && $0.count <= 1_500_000 }),
              photos.reduce(0, { $0 + $1.count }) <= 6_000_000 - images.reduce(0, { $0 + $1.count }) else { return false }
        images.append(contentsOf: photos)
        photoIDs.append(contentsOf: photos.map { _ in UUID().uuidString })
        revision += 1
        armed = false
        return true
    }
    mutating func beginAnalysis(permission: Bool) -> Int? {
        guard permission, canAnalyse else { return nil }
        analysing = true
        armed = false
        return revision
    }
    mutating func finishAnalysis(revision expected: Int) -> Bool {
        guard !closed, revision == expected, analysing else { return false }
        analysing = false
        return true
    }
    mutating func close() {
        closed = true
        revision += 1
        images.removeAll()
        photoIDs.removeAll()
        replacingIndex = nil
        capturing = false
        importing = false
        analysing = false
        armed = false
    }
}

/// Optional prompts follow the current photo count, including imports and X removal.
enum CameraPhotoGuidance {
    static func message(photoCount: Int) -> (heading: String, detail: String) {
        switch photoCount {
        case ...0: return ("Scan a barcode or take a photo", "")
        case 1: return ("1 photo ready", "")
        case 2: return ("2 photos ready", "")
        case 3: return ("3 photos ready", "")
        default: return ("4 photos ready", "")
        }
    }
}

/// Decode a bounded thumbnail from the picker file instead of loading its full
/// resolution into a UIImage. Encoding the pixels alone drops GPS/EXIF metadata.
enum CameraLibraryPhoto {
    static func jpeg(from url: URL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return jpeg(from: source)
    }
    static func jpeg(from data: Data, maximumBytes: Int = 1_500_000, maxDimension: Int = 2_400) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return jpeg(from: source, maximumBytes: maximumBytes, maxDimension: maxDimension)
    }
    private static func jpeg(from source: CGImageSource, maximumBytes: Int = 1_500_000, maxDimension: Int = 2_400) -> Data? {
        guard let image = thumbnail(from: source, maxDimension: maxDimension) else { return nil }
        for quality in [0.82, 0.68, 0.52, 0.35] {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            if CGImageDestinationFinalize(destination), data.length <= maximumBytes { return data as Data }
        }
        return nil
    }
    static func thumbnail(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return thumbnail(from: source, maxDimension: 160)
    }
    private static func thumbnail(from source: CGImageSource, maxDimension: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxDimension,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary)
    }
}

/// A camera session accepts each barcode once until an explicit rescan.
/// Metadata callbacks do not guarantee continuous observations of empty frames.
struct BarcodeRecognitionGate {
    private(set) var barcode: String?
    private var visibleCodes = Set<String>()
    mutating func resume(at now: Date = Date()) {}
    mutating func tick(paused: Bool, at now: Date = Date()) {}
    mutating func allowExplicitRescan(_ selected: String? = nil) {
        if let selected = selected ?? barcode { visibleCodes.remove(selected) }
    }
    mutating func observe(_ code: String?, at now: Date = Date()) -> Bool {
        guard let code, visibleCodes.insert(code).inserted else { return false }
        barcode = code
        return true
    }
}

/// Only this small, redrawn JPEG crosses into persisted History. Full images stay in memory.
enum CameraHistoryThumbnail {
    static func dataURL(from data: Data) -> String? {
        guard let jpeg = CameraLibraryPhoto.jpeg(from: data, maximumBytes: 24_000, maxDimension: 240) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
}

@MainActor
protocol SmartFoodCameraDelegate: AnyObject {
    func foodCamera(_ camera: SmartFoodCameraViewController, found barcode: String)
    func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data])
    func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data], addToEaten: Bool)
    func foodCameraAnalysisServiceText(_ camera: SmartFoodCameraViewController) -> String
    func foodCameraDidOpenHistory(_ camera: SmartFoodCameraViewController)
    func foodCamera(_ camera: SmartFoodCameraViewController, openFoodLibrary mode: String)
    func foodCameraDidCancel(_ camera: SmartFoodCameraViewController)
    func foodCameraDidFinishDeferredPhoto(_ camera: SmartFoodCameraViewController)
    func foodCamera(_ camera: SmartFoodCameraViewController, changedPhotoCount count: Int)
    func foodCameraDidChangeVoiceMemo(_ camera: SmartFoodCameraViewController)
    func foodCamera(_ camera: SmartFoodCameraViewController, summaryAction action: String, alternativeID: String?)
}

extension SmartFoodCameraDelegate {
    func foodCameraAnalysisServiceText(_ camera: SmartFoodCameraViewController) -> String { "Uses Nudge’s service" }
    func foodCamera(_ camera: SmartFoodCameraViewController, analyse images: [Data], addToEaten: Bool) {
        foodCamera(camera, analyse: images)
    }
    func foodCameraDidFinishDeferredPhoto(_ camera: SmartFoodCameraViewController) {}
    func foodCamera(_ camera: SmartFoodCameraViewController, openFoodLibrary mode: String) {}
    func foodCameraDidChangeVoiceMemo(_ camera: SmartFoodCameraViewController) {}
    func foodCamera(_ camera: SmartFoodCameraViewController, summaryAction action: String, alternativeID: String?) {}
}

/// Display-only transport. Scoring, safety precedence and candidate eligibility
/// stay in the shared web model; the native camera never calculates a rating.
struct CameraProductSummary {
    enum Status: String { case loading, ready, needsLabel = "needs_label", error }
    struct Alternative {
        let id: String, name: String, brand: String, scoreText: String
        let score: Int?
        let imageURL: URL?
        let thumbnail: Data?
    }
    let status: Status
    let compact: Bool
    let alternativesTitle: String
    let alternativesMessage: String
    let name: String, brand: String, scoreText: String, bandText: String, provisionalText: String
    let warningText: String, message: String, methodText: String, primaryAction: String, primaryTitle: String
    let imageURL: URL?
    let thumbnail: Data?
    let alternatives: [Alternative]
    let nutritionScore: Int?
    let grade: String?
    let finalFrequency: String?
    let frequencyStatus: String
    let isCurrentScore: Bool
    let isRoughScore: Bool
    let hasRecognizedScoreMethod: Bool

    var scoreTone: String? { nutritionScore.map { $0 < 25 ? "red" : $0 < 50 ? "amber" : "green" } }

    static func numericScore(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, (0...100).contains(number.doubleValue),
              number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.intValue
    }

    static func text(_ value: Any?, limit: Int = 200) -> String {
        guard let string = value as? String else { return "" }
        return String(string.trimmingCharacters(in: .whitespacesAndNewlines).prefix(limit))
    }
    static func productImage(_ value: Any?) -> URL? {
        guard let raw = value as? String else { return nil }
        return CatalogueProductImages.sourceURL(raw)
    }
    static func thumbnailData(_ value: Any?) -> Data? {
        guard let raw = value as? String, raw.count <= 49_152,
              raw.hasPrefix("data:image/jpeg;base64,"),
              let data = Data(base64Encoded: String(raw.dropFirst(23))), data.count <= 36_000,
              UIImage(data: data) != nil else { return nil }
        return data
    }
    init?(object: [String: Any]) {
        guard let state = Status(rawValue: Self.text(object["status"])) else { return nil }
        status = state
        compact = object["compact"] as? Bool == true
        alternativesTitle = Self.text(object["alternativesTitle"], limit: 100)
        alternativesMessage = Self.text(object["alternativesMessage"], limit: 240)
        isCurrentScore = (Self.text(object["scoreVersion"]) == "0.3" && Self.text(object["scoreMethod"]) == "nudge_nutrition_v0_3") ||
            (Self.text(object["scoreVersion"]) == "0.4" && Self.text(object["scoreMethod"]) == "nudge_nutrition_v0_4")
        isRoughScore = false
        hasRecognizedScoreMethod = isCurrentScore
        let suppliedGrade = Self.text(object["grade"]), values = ["A":100,"B":75,"C":50,"D":25,"E":0]
        if isCurrentScore, let supplied = Self.numericScore(object["score"]),
           let expected = values[suppliedGrade], supplied == expected {
            nutritionScore = expected; grade = Self.text(object["scoreMethod"]) == "nudge_nutrition_v0_4" ? nil : suppliedGrade
        } else if isRoughScore, let supplied = Self.numericScore(object["score"]), (5...95).contains(supplied), supplied.isMultiple(of: 5) {
            nutritionScore = supplied; grade = nil
        } else { nutritionScore = nil; grade = nil }
        frequencyStatus = Self.text(object["frequencyStatus"], limit: 40)
        finalFrequency = nil
        name = Self.text(object["name"]); brand = Self.text(object["brand"])
        scoreText = Self.text(object["scoreText"], limit: 60); bandText = Self.text(object["bandText"], limit: 100)
        provisionalText = Self.text(object["scoreMethod"]) == "nudge_nutrition_v0_4" ? "" : Self.text(object["provisionalText"], limit: 160)
        warningText = Self.text(object["warningText"], limit: 400)
        message = Self.text(object["message"], limit: 300); methodText = Self.text(object["methodText"], limit: 100)
        let action = Self.text(object["primaryAction"])
        primaryAction = ["label", "expand", "retry"].contains(action) ? action : "expand"
        primaryTitle = Self.text(object["primaryTitle"], limit: 80)
        imageURL = Self.productImage(object["imageURL"]); thumbnail = Self.thumbnailData(object["thumbnail"])
        alternatives = Array((object["alternatives"] as? [[String: Any]] ?? []).prefix(12)).compactMap { item in
            let id = Self.text(item["id"], limit: 200), name = Self.text(item["name"]), score = Self.text(item["scoreText"], limit: 60)
            guard !id.isEmpty, !name.isEmpty, !score.isEmpty else { return nil }
            return Alternative(id: id, name: name, brand: Self.text(item["brand"]), scoreText: score, score: Self.numericScore(item["score"]),
                imageURL: Self.productImage(item["imageURL"]), thumbnail: Self.thumbnailData(item["thumbnail"]))
        }
    }
    static var loading: CameraProductSummary { CameraProductSummary(object: ["status":"loading", "name":"Finding your product…", "message":"Checking the catalogue", "primaryAction":"label", "primaryTitle":"Photograph the label"])! }
}

struct CameraSummaryEnvelope {
    let requestID: String, draftID: String, analysisVersion: String
    let captureRevision: Int
    let summary: CameraProductSummary
    init?(body: [String: Any]) {
        guard let request = body["requestId"] as? String, !request.isEmpty, request.count <= 128,
              let draft = body["draftId"] as? String, !draft.isEmpty, draft.count <= 128,
              let revision = body["captureRevision"] as? Int, revision >= 0,
              let object = body["summary"] as? [String: Any], let summary = CameraProductSummary(object: object) else { return nil }
        requestID = request; draftID = draft; captureRevision = revision; self.summary = summary
        analysisVersion = CameraProductSummary.text(body["analysisVersion"], limit: 160)
    }
    func matches(request: String?, draft: String?, revision: Int) -> Bool {
        requestID == request && draftID == draft && captureRevision == revision
    }
}

@MainActor
private final class SummaryProductImage: UIImageView {
    private var task: Task<Void, Never>?
    init(url: URL?, thumbnail: Data?, size: CGFloat) {
        super.init(frame: .zero)
        contentMode = .scaleAspectFit; clipsToBounds = true; layer.cornerRadius = 10
        backgroundColor = NudgeTheme.canvas; tintColor = NudgeTheme.muted
        image = thumbnail.flatMap { UIImage(data: $0) } ?? UIImage(systemName: "takeoutbag.and.cup.and.straw")
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: size).isActive = true
        heightAnchor.constraint(equalToConstant: size).isActive = true
        // Keep the captured label as the immediate/offline fallback; replace it
        // with the matched catalogue product photo when that image is available.
        guard let url else { return }
        task = Task { [weak self] in
            guard let data = try? await CatalogueProductImages.shared.data(for: url), !Task.isCancelled,
                  let decoded = UIImage(data: data) else { return }
            self?.image = decoded
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { task?.cancel() }
}

@MainActor
private enum CameraScorePalette {
    static func text(_ value: Int?) -> UIColor {
        guard let value else { return NudgeTheme.muted }
        return value < 25 ? NudgeTheme.color(0xA13431, 0xFFC1BA) : value < 50 ? NudgeTheme.color(0x785011, 0xF4D09A) : NudgeTheme.color(0x33704C, 0xB7DFB9)
    }
    static let arcs = [NudgeTheme.color(0xE76F65, 0xEF837A), NudgeTheme.color(0xFF9F43, 0xFFB567), NudgeTheme.color(0x82B951, 0xA4CC80)]
}

/// The approved food-result dial, sized for the camera's existing scrolling
/// summary. It displays a validated transport value and does not score food.
@MainActor
private final class CameraNutritionDialView: UIView {
    private let score: Int?
    private let number = UILabel(), denominator = UILabel()
    private var largeText: Bool { traitCollection.preferredContentSizeCategory.isAccessibilityCategory }
    init(score: Int?, grade: String?, rough: Bool) {
        self.score = score
        super.init(frame: .zero)
        backgroundColor = .clear; isOpaque = false
        setContentCompressionResistancePriority(.required, for: .vertical)
        setContentHuggingPriority(.required, for: .vertical)
        accessibilityIdentifier = "camera-summary-dial"
        isAccessibilityElement = true
        accessibilityLabel = score.map { "\(rough ? "Rough estimate" : "Nudge score") \($0) out of 100" + (grade.map { ", Grade \($0)" } ?? "") + (rough ? ", low confidence" : "") } ?? "Nudge nutrition score unavailable"
        number.text = score.map(String.init) ?? "—"; number.textAlignment = .center
        number.accessibilityIdentifier = "camera-summary-score"
        denominator.text = score == nil ? "" : "/100"; denominator.textAlignment = .center
        for label in [number, denominator] { label.isAccessibilityElement = false; label.adjustsFontForContentSizeCategory = true; addSubview(label) }
        updateFonts()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func updateFonts() {
        number.font = UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: .systemFont(ofSize: 44, weight: .bold), compatibleWith: traitCollection)
        denominator.font = UIFontMetrics(forTextStyle: .caption1).scaledFont(for: .systemFont(ofSize: 20, weight: .semibold), compatibleWith: traitCollection)
        number.textColor = CameraScorePalette.text(score); denominator.textColor = CameraScorePalette.text(score)
        invalidateIntrinsicContentSize(); setNeedsLayout(); setNeedsDisplay()
    }
    override var intrinsicContentSize: CGSize { CGSize(width: 240, height: largeText ? 136 + number.intrinsicContentSize.height + denominator.intrinsicContentSize.height + 6 : 136) }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection); updateFonts()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        if largeText {
            number.frame = CGRect(x: 0, y: 136, width: bounds.width, height: number.intrinsicContentSize.height)
            denominator.frame = CGRect(x: 0, y: number.frame.maxY + 6, width: bounds.width, height: denominator.intrinsicContentSize.height)
        } else {
            let width = number.intrinsicContentSize.width + denominator.intrinsicContentSize.width + 3
            number.frame = CGRect(x: (bounds.width - width) / 2, y: 132 - number.intrinsicContentSize.height, width: number.intrinsicContentSize.width, height: number.intrinsicContentSize.height)
            denominator.frame = CGRect(x: number.frame.maxX + 3, y: 132 - denominator.intrinsicContentSize.height - 3, width: denominator.intrinsicContentSize.width, height: denominator.intrinsicContentSize.height)
        }
        setNeedsDisplay()
    }
    override func draw(_ rect: CGRect) {
        let scale = min(bounds.width / 240, 1), centre = CGPoint(x: bounds.midX, y: 120 * scale), radius = 106 * scale
        for (index, ends) in [(0.8,24.2),(25.8,49.2),(50.8,99.2)].enumerated() {
            let arc = UIBezierPath(arcCenter: centre, radius: radius, startAngle: .pi * (1 + CGFloat(ends.0) / 100), endAngle: .pi * (1 + CGFloat(ends.1) / 100), clockwise: true)
            arc.lineWidth = 9 * scale; arc.lineCapStyle = .round; CameraScorePalette.arcs[index].setStroke(); arc.stroke()
        }
        guard let score else { return }
        let angle = CGFloat.pi * (1 + CGFloat(score) / 100), point = CGPoint(x: centre.x + radius * cos(angle), y: centre.y + radius * sin(angle))
        let marker = UIBezierPath(ovalIn: CGRect(x: point.x - 8 * scale, y: point.y - 8 * scale, width: 16 * scale, height: 16 * scale))
        NudgeTheme.surface.setFill(); marker.fill(); NudgeTheme.ink.setStroke(); marker.lineWidth = 3 * scale; marker.stroke()
    }
}

@MainActor
final class CameraProductSummaryView: UIView, UIGestureRecognizerDelegate, UIScrollViewDelegate {
    var onAction: ((String, String?) -> Void)?
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private var displayedSummary: CameraProductSummary?
    private weak var compactName: UILabel?
    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "camera-product-summary"
        // This overlay keeps its light surface and explicit navy copy over the live scene.
        overrideUserInterfaceStyle = .light
        backgroundColor = NudgeTheme.surface; layer.cornerRadius = 26; clipsToBounds = true
        scroll.translatesAutoresizingMaskIntoConstraints = false; scroll.alwaysBounceVertical = false
        addSubview(scroll)
        stack.axis = .vertical; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor), scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -14),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -32)
        ])
        let fit = heightAnchor.constraint(equalTo: stack.heightAnchor, constant: 28)
        fit.priority = .defaultHigh; fit.isActive = true
        let expandTap = UITapGestureRecognizer(target: self, action: #selector(expand))
        expandTap.delegate = self; expandTap.cancelsTouchesInView = false
        addGestureRecognizer(expandTap)
        let expandSwipe = UISwipeGestureRecognizer(target: self, action: #selector(expand))
        expandSwipe.direction = .up
        expandSwipe.delegate = self
        addGestureRecognizer(expandSwipe)
        scroll.panGestureRecognizer.require(toFail: expandSwipe)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory,
           let summary = displayedSummary { update(summary) }
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        // Multiline names share a row with a fixed image and score. Recalculate
        // their wrapping after that row has its real width, including rotation.
        if let name = compactName, name.bounds.width > 0,
           abs(name.preferredMaxLayoutWidth - name.bounds.width) > 0.5 {
            name.preferredMaxLayoutWidth = name.bounds.width
            stack.setNeedsLayout(); setNeedsLayout()
        }
    }
    private func label(_ text: String, style: UIFont.TextStyle = .body, color: UIColor = NudgeTheme.ink) -> UILabel {
        let label = UILabel(); label.text = text; label.font = .preferredFont(forTextStyle: style, compatibleWith: traitCollection)
        label.adjustsFontForContentSizeCategory = true; label.numberOfLines = 0; label.textColor = color
        label.lineBreakMode = .byWordWrapping
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        return label
    }
    private func button(_ title: String, action: String, alternativeID: String? = nil, filled: Bool = false) -> UIButton {
        let button = NudgeButton(title, variant: filled ? .primary : .secondary)
        button.accessibilityIdentifier = "camera-summary-" + action
        button.addAction(UIAction { [weak self] _ in
            if action == "expand" { self?.expand() }
            else { self?.onAction?(action, alternativeID) }
        }, for: .touchUpInside)
        return button
    }
    func update(_ summary: CameraProductSummary) {
        displayedSummary = summary
        accessibilityCustomActions = summary.status == .ready
            ? [UIAccessibilityCustomAction(name: "Open product", target: self, selector: #selector(accessibilityExpand))] : nil
        compactName = nil
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        if summary.status == .ready {
            let handle = UIView(); handle.backgroundColor = NudgeTheme.border; handle.layer.cornerRadius = 2.5
            handle.widthAnchor.constraint(equalToConstant: 36).isActive = true
            handle.heightAnchor.constraint(equalToConstant: 5).isActive = true
            let grip = UIStackView(arrangedSubviews: [handle]); grip.axis = .vertical; grip.alignment = .center
            grip.isAccessibilityElement = false
            stack.addArrangedSubview(grip)
        }
        let dismiss = UIButton(type: .system)
        dismiss.setImage(UIImage(systemName: "xmark"), for: .normal)
        dismiss.tintColor = NudgeTheme.ink
        dismiss.accessibilityIdentifier = "camera-summary-dismiss"
        dismiss.accessibilityLabel = "Dismiss product result"
        dismiss.widthAnchor.constraint(equalToConstant: 44).isActive = true
        dismiss.heightAnchor.constraint(equalToConstant: 44).isActive = true
        dismiss.addAction(UIAction { [weak self] _ in self?.onAction?("next", nil) }, for: .touchUpInside)
        var dismissalItems: [UIView] = [UIView(), dismiss]
        if summary.status != .loading {
            let rescan = button("Scan again", action: "rescan")
            rescan.accessibilityLabel = "Scan this barcode again"
            dismissalItems.insert(rescan, at: 0)
        }
        let dismissal = UIStackView(arrangedSubviews: dismissalItems)
        // Keep the fixed-size close target from compressing a wrapped rescan title.
        dismissal.spacing = 8; dismissal.alignment = .top
        stack.addArrangedSubview(dismissal)
        if summary.compact { updateCompact(summary); return }
        let name = label(summary.name.isEmpty ? "Your product" : summary.name, style: .headline)
        name.accessibilityIdentifier = "camera-summary-name"
        name.accessibilityHint = summary.status == .ready ? "Use Open product for the full card." : nil
        name.accessibilityCustomActions = accessibilityCustomActions
        let identity = UIStackView(arrangedSubviews: [name, label(summary.brand, style: .subheadline, color: NudgeTheme.muted)])
        identity.axis = .vertical; identity.spacing = 4
        let availableWidth = superview?.bounds.width ?? bounds.width
        let expandedTextLayout = traitCollection.preferredContentSizeCategory.isAccessibilityCategory || (availableWidth > 0 && availableWidth < 345)
        let header = UIStackView(arrangedSubviews: [SummaryProductImage(url: summary.imageURL, thumbnail: summary.thumbnail, size: 64), expandedTextLayout ? UIView() : identity, button("Open", action: "expand")])
        header.spacing = 12; header.alignment = .center; stack.addArrangedSubview(header)
        if expandedTextLayout { stack.addArrangedSubview(identity) }
        if summary.status == .loading {
            stack.addArrangedSubview(AnalysisCrewView())
            // The catalogue request has begun. Source checks and scoring have no
            // completion event yet; no time-driven tick or claim is shown.
            let progress = UIStackView(arrangedSubviews: [
                label("Finding the product · In progress", style: .subheadline),
                label("Checking available facts · Waiting", style: .caption1, color: NudgeTheme.muted),
                label("Calculating supported nutrition · Waiting", style: .caption1, color: NudgeTheme.muted)
            ])
            progress.axis = .vertical; progress.spacing = 6
            progress.accessibilityIdentifier = "camera-analysis-stages"
            stack.addArrangedSubview(progress)
        } else {
            if !summary.warningText.isEmpty { stack.addArrangedSubview(label(summary.warningText, style: .headline, color: NudgeTheme.errorText)) }
            if summary.hasRecognizedScoreMethod {
                let dial = CameraNutritionDialView(score: summary.nutritionScore, grade: summary.grade, rough: summary.isRoughScore)
                let row = UIStackView(arrangedSubviews: [dial]); row.axis = .vertical; row.alignment = .center
                dial.translatesAutoresizingMaskIntoConstraints = false
                dial.widthAnchor.constraint(lessThanOrEqualTo: row.widthAnchor).isActive = true
                let width = dial.widthAnchor.constraint(equalToConstant: 240); width.priority = .defaultHigh; width.isActive = true
                stack.addArrangedSubview(row)
                let title = label(summary.isRoughScore ? "Nudge food estimate" : "Nudge nutrition score", style: .subheadline)
                title.textAlignment = .center; stack.addArrangedSubview(title)
                if let grade = summary.grade { let detail = label("Grade \(grade)", style: .caption1, color: NudgeTheme.muted); detail.textAlignment = .center; stack.addArrangedSubview(detail) }
            } else {
                stack.addArrangedSubview(label("Previous Nudge score", style: .subheadline))
                let score = label(summary.scoreText.isEmpty ? "Needs label" : summary.scoreText, style: .title1)
                score.accessibilityIdentifier = "camera-summary-score"; stack.addArrangedSubview(score)
            }
            let status = [summary.isRoughScore ? "Rough estimate · Low confidence" : summary.provisionalText, summary.methodText].filter { !$0.isEmpty }.joined(separator: " · ")
            if !status.isEmpty { stack.addArrangedSubview(label(status, style: .caption1, color: NudgeTheme.muted)) }
            if !summary.message.isEmpty { stack.addArrangedSubview(label(summary.message, style: .subheadline, color: NudgeTheme.muted)) }
        }
        addAlternatives(summary)
        let primaryTitle = summary.primaryTitle.isEmpty ? (summary.primaryAction == "label" ? "Photograph the label" : "View product") : summary.primaryTitle
        let actions = UIStackView(arrangedSubviews: [button(primaryTitle, action: summary.primaryAction, filled: true), button("Scan next", action: "next")])
        actions.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal
        actions.spacing = 8; actions.distribution = .fillEqually; stack.addArrangedSubview(actions)
        UIAccessibility.post(notification: .layoutChanged, argument: name)
    }
    private func updateCompact(_ summary: CameraProductSummary) {
        let name = label(summary.name.isEmpty ? "Your product" : summary.name, style: .headline)
        compactName = name
        name.accessibilityIdentifier = "camera-summary-name"
        name.accessibilityHint = summary.status == .ready ? "Use Open product for the full card." : nil
        name.accessibilityCustomActions = accessibilityCustomActions
        let identity = UIStackView(arrangedSubviews: [name])
        identity.axis = .vertical; identity.spacing = 3
        if !summary.brand.isEmpty { identity.addArrangedSubview(label(summary.brand, style: .caption1, color: NudgeTheme.muted)) }
        let missingRating = summary.status == .loading ? "Checking" : summary.status == .error ? "Unavailable" : "Not rated"
        let score = label(summary.nutritionScore.map { "\($0)/100" } ?? missingRating,
                          style: summary.nutritionScore == nil ? .subheadline : .title1, color: CameraScorePalette.text(summary.nutritionScore))
        score.accessibilityIdentifier = "camera-summary-score"
        score.accessibilityLabel = summary.nutritionScore.map { "Nudge score \($0) out of 100" } ?? missingRating
        score.setContentCompressionResistancePriority(.required, for: .horizontal)
        let scoreStack = UIStackView(arrangedSubviews: [score, label("Nudge score", style: .caption2, color: NudgeTheme.muted)])
        scoreStack.axis = .vertical; scoreStack.alignment = .trailing
        if let value = summary.nutritionScore {
            let tone = NativeProductRatingTone(value: value)
            scoreStack.backgroundColor = NudgeTheme.color(tone.fill, tone.fill)
            scoreStack.layer.cornerRadius = 12; scoreStack.isLayoutMarginsRelativeArrangement = true
            scoreStack.layoutMargins = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
            for label in scoreStack.arrangedSubviews.compactMap({ $0 as? UILabel }) { label.textColor = NudgeTheme.color(0x1B202A, 0x1B202A) }
        }
        let row = UIStackView(arrangedSubviews: [SummaryProductImage(url: summary.imageURL, thumbnail: summary.thumbnail, size: 52), identity, scoreStack])
        row.spacing = 10; row.alignment = .center
        if traitCollection.preferredContentSizeCategory.isAccessibilityCategory { row.axis = .vertical; row.alignment = .leading }
        stack.addArrangedSubview(row)
        if summary.status == .loading {
            let spinner = UIActivityIndicatorView(style: .medium); spinner.startAnimating()
            let loading = UIStackView(arrangedSubviews: [spinner, label("Checking the catalogue…", style: .subheadline, color: NudgeTheme.muted)])
            loading.spacing = 8; stack.addArrangedSubview(loading)
        } else {
            if !summary.warningText.isEmpty { stack.addArrangedSubview(label(summary.warningText, style: .subheadline, color: NudgeTheme.errorText)) }
            let confidence = summary.isRoughScore ? "Estimated · Low confidence" : summary.provisionalText
            if !confidence.isEmpty { stack.addArrangedSubview(label(confidence, style: .caption1, color: NudgeTheme.muted)) }
            if !summary.message.isEmpty { stack.addArrangedSubview(label(summary.message, style: .subheadline, color: NudgeTheme.muted)) }
            let primary = summary.primaryAction == "label" ? button("Photograph the label", action: "label") : button("View product", action: "expand")
            let actions = UIStackView(arrangedSubviews: [primary, button("Dismiss", action: "next")])
            actions.spacing = 8; actions.distribution = .fillEqually
            actions.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal
            stack.addArrangedSubview(actions)
            addAlternatives(summary)
        }
        if summary.status != .loading {
            UIAccessibility.post(notification: .announcement, argument: name.text)
        }
    }
    private func addAlternatives(_ summary: CameraProductSummary) {
        if !summary.alternatives.isEmpty {
            stack.addArrangedSubview(label(summary.alternativesTitle.isEmpty ? "Better alternatives" : summary.alternativesTitle, style: .headline))
            let carousel = UIScrollView(); carousel.showsHorizontalScrollIndicator = false
            carousel.accessibilityIdentifier = "camera-summary-alternatives"
            carousel.delegate = self; carousel.decelerationRate = .fast
            stack.addArrangedSubview(carousel)
            let cards = UIStackView(); cards.axis = .horizontal; cards.spacing = 10; cards.translatesAutoresizingMaskIntoConstraints = false
            carousel.addSubview(cards)
            for (index, item) in summary.alternatives.enumerated() {
                let card = button("", action: "alternative", alternativeID: item.id)
                card.backgroundColor = NudgeTheme.canvas; card.layer.cornerRadius = 16
                let info = UIStackView(arrangedSubviews: [label(item.brand, style: .caption1, color: NudgeTheme.muted), label(item.name, style: .subheadline)])
                info.axis = .vertical; info.spacing = 3
                let content = UIStackView(arrangedSubviews: [SummaryProductImage(url: item.imageURL, thumbnail: item.thumbnail, size: 38), info, label(item.scoreText, style: .headline, color: CameraScorePalette.text(item.score))])
                content.spacing = 8; content.alignment = .center; content.isUserInteractionEnabled = false; content.translatesAutoresizingMaskIntoConstraints = false
                if traitCollection.preferredContentSizeCategory.isAccessibilityCategory { content.axis = .vertical; content.alignment = .leading }
                card.addSubview(content)
                cards.addArrangedSubview(card)
                NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 10),content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),content.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),card.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.83)])
                card.accessibilityLabel = "\(item.brand), \(item.name), \(item.scoreText), \(index + 1) of \(summary.alternatives.count)"
            }
            NSLayoutConstraint.activate([cards.leadingAnchor.constraint(equalTo: carousel.contentLayoutGuide.leadingAnchor),cards.trailingAnchor.constraint(equalTo: carousel.contentLayoutGuide.trailingAnchor),cards.topAnchor.constraint(equalTo: carousel.contentLayoutGuide.topAnchor),cards.bottomAnchor.constraint(equalTo: carousel.contentLayoutGuide.bottomAnchor),cards.heightAnchor.constraint(equalTo: carousel.frameLayoutGuide.heightAnchor),carousel.heightAnchor.constraint(equalTo: cards.heightAnchor)])
            let minimum = carousel.heightAnchor.constraint(greaterThanOrEqualToConstant: 88); minimum.isActive = true
        }
        if !summary.alternativesMessage.isEmpty { stack.addArrangedSubview(label(summary.alternativesMessage, style: .caption1, color: NudgeTheme.muted)) }
    }
    private func frequencyBadge(_ frequency: String) -> UIView {
        let title = label(frequency, style: .headline, color: NudgeTheme.frequencyText(frequency))
        title.accessibilityIdentifier = "camera-summary-frequency"
        let badge = UIStackView(arrangedSubviews: [title]); badge.backgroundColor = NudgeTheme.frequencySurface(frequency)
        badge.layer.cornerRadius = 12; badge.isLayoutMarginsRelativeArrangement = true
        badge.layoutMargins = UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        return badge
    }
    private func addFrequencyKey() {
        let key = UIStackView(); key.axis = .vertical; key.spacing = 6
        key.accessibilityIdentifier = "camera-frequency-key"
        for (frequency, meaning) in [("Daily", "Any day, with appropriate portions and variety"), ("Weekly", "Up to 2 reference portions in rolling 7 days"), ("Monthly", "Up to 2 reference portions in rolling 28 days")] {
            let row = UIStackView(arrangedSubviews: [label("\(frequency): \(meaning)", style: .caption1, color: NudgeTheme.frequencyText(frequency))])
            row.backgroundColor = NudgeTheme.frequencySurface(frequency); row.layer.cornerRadius = 10
            row.isLayoutMarginsRelativeArrangement = true; row.layoutMargins = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
            key.addArrangedSubview(row)
        }
        key.addArrangedSubview(label("Weekly and Monthly limits are shared within comparable rated choices. Proposed planning guidance.", style: .caption2, color: NudgeTheme.muted))
        stack.addArrangedSubview(key)
    }
    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        guard scrollView.accessibilityIdentifier == "camera-summary-alternatives",
              let cards = scrollView.subviews.compactMap({ $0 as? UIStackView }).first,
              let first = cards.arrangedSubviews.first else { return }
        let step = first.bounds.width + cards.spacing
        guard step > 0 else { return }
        let maximum = max(0, scrollView.contentSize.width - scrollView.bounds.width)
        targetContentOffset.pointee.x = min(maximum, max(0, (targetContentOffset.pointee.x / step).rounded() * step))
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard displayedSummary?.status == .ready else { return false }
        var touched = touch.view
        while let view = touched, view !== self {
            if view is UIControl { return false }
            if view is UIScrollView, view !== scroll { return false }
            touched = view.superview
        }
        return true
    }
    @objc private func expand() {
        guard displayedSummary?.status == .ready else { return }
        onAction?("expand", nil)
    }
    @objc private func accessibilityExpand() -> Bool {
        guard displayedSummary?.status == .ready else { return false }
        expand(); return true
    }
}

private final class FoodCameraPreview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

private final class CameraShutterRing: UIView {
    override func draw(_ rect: CGRect) {
        UIColor.white.setStroke()
        let ring = UIBezierPath(ovalIn: bounds.insetBy(dx: 2, dy: 2))
        ring.lineWidth = 4
        ring.stroke()
    }
}

/// AVFoundation's mutable objects belong to one queue. The only exposed session
/// reference attaches the preview layer; UI state and callbacks stay on MainActor.
private final class FoodCameraSession: NSObject, @unchecked Sendable, AVCaptureMetadataOutputObjectsDelegate, AVCapturePhotoCaptureDelegate {
    let session: AVCaptureSession = {
        let session = AVCaptureSession()
        // This session has video/metadata inputs only. The separate voice memo
        // owns microphone configuration; the camera must not overwrite it.
        session.automaticallyConfiguresApplicationAudioSession = false
        return session
    }()
    private let queue = DispatchQueue(label: "nudge.food.camera", qos: .userInitiated)
    private let photoQueue = DispatchQueue(label: "nudge.food.camera.photos", qos: .userInitiated)
    private let output = AVCapturePhotoOutput()
    private var device: AVCaptureDevice?
    private var captures: [Int64: UUID] = [:]
    private var barcodeDetectionEnabled = false
    private var recognition = BarcodeRecognitionGate()
    private var wantsRunning = false
    private let photosOnly: Bool
    private let onBarcode: @MainActor @Sendable (String?) -> Void
    private let onShutter: @MainActor @Sendable (UUID) -> Void
    private let onPhoto: @MainActor @Sendable (Data?, UUID) -> Void
    private let onPrepared: @MainActor @Sendable (UUID, Int) -> Void

    init(photosOnly: Bool, onBarcode: @escaping @MainActor @Sendable (String?) -> Void,
         onShutter: @escaping @MainActor @Sendable (UUID) -> Void,
         onPrepared: @escaping @MainActor @Sendable (UUID, Int) -> Void = { _, _ in },
         onPhoto: @escaping @MainActor @Sendable (Data?, UUID) -> Void) {
        self.photosOnly = photosOnly
        self.onBarcode = onBarcode
        self.onShutter = onShutter
        self.onPhoto = onPhoto
        self.onPrepared = onPrepared
    }
    func configure(completion: @escaping @MainActor @Sendable (Bool) -> Void) {
        queue.async { [self] in
            session.beginConfiguration()
            session.sessionPreset = .photo
            let found = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            let input = found.flatMap { try? AVCaptureDeviceInput(device: $0) }
            guard let found, let input, session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                Task { @MainActor in completion(false) }
                return
            }
            device = found
            session.addInput(input)
            session.addOutput(output)
            output.maxPhotoQualityPrioritization = .balanced
            if !photosOnly {
                let metadata = AVCaptureMetadataOutput()
                if session.canAddOutput(metadata) {
                    session.addOutput(metadata)
                    metadata.setMetadataObjectsDelegate(self, queue: queue)
                    let supported: [AVMetadataObject.ObjectType] = [.ean13, .ean8, .upce, .code128]
                    metadata.metadataObjectTypes = supported.filter { metadata.availableMetadataObjectTypes.contains($0) }
                }
            }
            if (try? found.lockForConfiguration()) != nil {
                if found.isFocusModeSupported(.continuousAutoFocus) { found.focusMode = .continuousAutoFocus }
                if found.isExposureModeSupported(.continuousAutoExposure) { found.exposureMode = .continuousAutoExposure }
                found.unlockForConfiguration()
            }
            session.commitConfiguration()
            Task { @MainActor in completion(true) }
        }
    }
    func start() { queue.async { [self] in
        wantsRunning = true
        CameraHapticAudioPolicy.prepare()
        if !session.isRunning { session.startRunning() }
    } }
    func stop() { queue.async { [self] in
        wantsRunning = false; barcodeDetectionEnabled = false; recognition.resume()
        if captures.isEmpty && session.isRunning { session.stopRunning() }
    } }
    func setBarcodeDetectionEnabled(_ enabled: Bool) {
        queue.async { [self] in
            guard barcodeDetectionEnabled != enabled else { return }
            barcodeDetectionEnabled = enabled; recognition.resume()
        }
    }
    func allowExplicitBarcodeRescan(_ barcode: String) { queue.async { [self] in recognition.allowExplicitRescan(barcode) } }
    func setTorch(_ enabled: Bool, completion: @escaping @MainActor @Sendable (Bool) -> Void) {
        queue.async { [self] in
            guard let device, device.hasTorch else { Task { @MainActor in completion(false) }; return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                device.torchMode = enabled ? .on : .off
                Task { @MainActor in completion(enabled) }
            } catch { Task { @MainActor in completion(false) } }
        }
    }
    func capture(token: UUID) {
        queue.async { [self] in
            guard session.isRunning, output.connection(with: .video)?.isActive == true else { Task { @MainActor in onPhoto(nil, token) }; return }
            if let connection = output.connection(with: .video), connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
            let settings = AVCapturePhotoSettings()
            settings.photoQualityPrioritization = .balanced
            captures[settings.uniqueID] = token
            output.capturePhoto(with: settings, delegate: self)
            let identifier = settings.uniqueID
            queue.asyncAfter(deadline: .now() + 12) { [weak self] in
                // A broken hardware capture must not retain a dismissed camera
                // forever. A delivered original has already left this map and
                // continues encoding untouched on the separate photo queue.
                guard let self, captures[identifier] != nil else { return }
                deliver(nil, identifier: identifier)
            }
        }
    }
    func focus(at point: CGPoint) {
        queue.async { [self] in
            guard let device else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = point }
                if device.isFocusModeSupported(.autoFocus) { device.focusMode = .autoFocus }
                if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = point }
            } catch { }
        }
    }
    func zoom(by factor: CGFloat) {
        queue.async { [self] in
            guard let device, factor.isFinite, factor > 0 else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                device.videoZoomFactor = min(max(device.videoZoomFactor * factor, device.minAvailableVideoZoomFactor), min(8, device.maxAvailableVideoZoomFactor))
            } catch { }
        }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard barcodeDetectionEnabled else { return }
        let barcode = objects.compactMap { object -> String? in
            guard let object = object as? AVMetadataMachineReadableCodeObject, let value = object.stringValue else { return nil }
            let symbology: FoodBarcodeIdentity.Symbology
            switch object.type {
            case .ean13: symbology = .ean13
            case .ean8: symbology = .ean8
            case .upce: symbology = .upce
            case .code128: symbology = .code128
            default: return nil
            }
            return FoodBarcodeIdentity.decoded(value, symbology: symbology)
        }.first
        guard recognition.observe(barcode), let barcode else { return }
        // Only accepted observations cross to the UI, not every metadata frame.
        Task { @MainActor in onBarcode(barcode) }
    }
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        deliver(error == nil ? photo.fileDataRepresentation() : nil, identifier: photo.resolvedSettings.uniqueID)
    }
    func photoOutput(_ output: AVCapturePhotoOutput, didCapturePhotoFor settings: AVCaptureResolvedPhotoSettings) {
        queue.async { [self] in
            guard let token = captures[settings.uniqueID] else { return }
            Task { @MainActor in onShutter(token) }
        }
    }
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor settings: AVCaptureResolvedPhotoSettings, error: Error?) {
        // Processing normally delivered first. Always resolve the token here
        // if it did not, including a capture ending without a usable photo.
        deliver(nil, identifier: settings.uniqueID)
    }
    private func deliver(_ data: Data?, identifier: Int64) {
        queue.async { [self] in
            guard let token = captures.removeValue(forKey: identifier) else { return }
            // Bound and strip the image without occupying either the UI or the
            // live metadata/session queue while the JPEG is decoded and encoded.
            photoQueue.async { [self] in
                let began = ProcessInfo.processInfo.systemUptime
                let jpeg = autoreleasepool { data.flatMap { CameraLibraryPhoto.jpeg(from: $0) } }
                let elapsed = max(0, Int((ProcessInfo.processInfo.systemUptime - began) * 1000))
                Task { @MainActor in onPrepared(token, elapsed); onPhoto(jpeg, token) }
            }
            if !wantsRunning && captures.isEmpty && session.isRunning { session.stopRunning() }
        }
    }
}

/// Removal buttons extend above the thumbnail; enlarge hit testing, not layout.
private final class CameraThumbnailSlot: UIView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) || subviews.contains { !$0.isHidden && $0.isUserInteractionEnabled && $0.point(inside: convert(point, to: $0), with: event) }
    }
}
private final class CameraThumbnailRail: UIStackView {
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event) || subviews.contains { !$0.isHidden && $0.point(inside: convert(point, to: $0), with: event) }
    }
}

private final class CameraFrameView: UIView {
    override func draw(_ rect: CGRect) {
        let path = UIBezierPath()
        let inset: CGFloat = 2
        let length: CGFloat = 28
        for (x, y, dx, dy) in [(inset, inset, CGFloat(1), CGFloat(1)),
                                (rect.width - inset, inset, CGFloat(-1), CGFloat(1)),
                                (inset, rect.height - inset, CGFloat(1), CGFloat(-1)),
                                (rect.width - inset, rect.height - inset, CGFloat(-1), CGFloat(-1))] {
            path.move(to: CGPoint(x: x, y: y + dy * length))
            path.addLine(to: CGPoint(x: x, y: y + dy * 10))
            path.addQuadCurve(to: CGPoint(x: x + dx * 10, y: y), controlPoint: CGPoint(x: x, y: y))
            path.addLine(to: CGPoint(x: x + dx * length, y: y))
        }
        UIColor.black.setStroke()
        path.lineWidth = 6
        path.stroke()
        NudgeTheme.cameraText.setStroke()
        path.lineWidth = 3
        path.stroke()
    }
}

@MainActor
final class SmartFoodCameraViewController: UIViewController, PHPickerViewControllerDelegate {
    weak var delegate: SmartFoodCameraDelegate?
    private var photosOnly: Bool
    private lazy var cameraSession = FoodCameraSession(photosOnly: false,
        onBarcode: { [weak self] in self?.foundBarcode($0) },
        onShutter: { [weak self] in self?.capturedShutter(token: $0) },
        onPrepared: { [weak self] in self?.preparedPhotoMilliseconds[$0] = $1 },
        onPhoto: { [weak self] in self?.finishPhoto($0, token: $1) })
    private let preview = FoodCameraPreview()
    private var configured = false
    private var configuring = false
    private var sessionRequestedRunning = false
    private var visible = false
    private var lastPresentedBarcode: String?
    private(set) var lastBarcodeWasManual = false
    private var suspendedForResult = false
    private(set) var closingForDeferredPhoto = false
    private(set) var lastPhotoCaptureFailed = false
    var isShowingResult: Bool { suspendedForResult }
    private(set) var productLocked = false
    private let summaryCard = CameraProductSummaryView()
    private var requestedPanelHint: String?
    private var state = SmartCaptureState()
    private var captureRevision: Int?
    private var captureToken: UUID?
    private var analysisRevision: Int?
    private var libraryImportToken: UUID?
    private var libraryImportRevision: Int?
    private var libraryImportTask: Task<Void, Never>?
    private var libraryProgress: Progress?
    private var feedbackTask: Task<Void, Never>?
    private var torchEnabled = false
    private let captureFlash = UIView()
    private lazy var captureHaptic: UIImpactFeedbackGenerator = {
        // A view-associated generator follows this camera's active scene on
        // current iOS. Keep one prepared generator for the lifetime of the view.
        if #available(iOS 17.5, *) { return UIImpactFeedbackGenerator(style: .rigid, view: view) }
        return UIImpactFeedbackGenerator(style: .rigid)
    }()
    private(set) var captureFeedbackCount = 0
    private func pulseCaptureFeedback() {
        captureHaptic.impactOccurred(intensity: 1)
        captureFeedbackCount += 1
        captureHaptic.prepare()
    }
    private let sentLabel = UILabel()
    private var sentTask: Task<Void, Never>?
    private var lastFlashAt: TimeInterval = 0
    private let statusLabel = UILabel()
    private let hintLabel = UILabel()
    private let countLabel = UILabel()
    private let overlayStack = UIStackView()
    private var minimumFrameHeight: NSLayoutConstraint?
    private var usesCompactHeight = false
    private let flashButton = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private let captureButton = UIButton(type: .system)
    private let resultButton = NudgeButton("Analyse", variant: .primary, icon: "arrow.right")
    private let analysisServiceLabel = UILabel()
    private let historyButton = UIButton(type: .system)
    private let libraryButton = UIButton(type: .system)
    private let enterCodeButton = UIButton(type: .system)
    private var enteringBarcode = false
    private let recentsButton = UIButton(type: .system)
    private let favouritesButton = UIButton(type: .system)
    private let voiceButton = VoiceHoldButton(type: .system)
    private let voiceStatusLabel = UILabel()
    private let voiceNoticeLabel = UILabel()
    private let voicePlayButton = UIButton(type: .system)
    private let voiceRedoButton = UIButton(type: .system)
    private let voiceRemoveButton = UIButton(type: .system)
    private let voiceActions = UIStackView()
    private let voicePanel = UIStackView()
    private let voiceDraft: VoiceMemoDraft
    private var voiceInteraction = VoiceMemoInteraction()
    private let voicePermissionRequest: (@escaping (Bool) -> Void) -> Void
    private var thumbnails: [UIImageView] = []
    private var thumbnailPhotoIDs: [String?] = Array(repeating: nil, count: 4)
    private var slotLabels: [UILabel] = []
    private var removeButtons: [UIButton] = []
    var capturedImages: [Data] { state.images }
    var capturedPhotoIDs: [String] { state.photoIDs }
    var captureSetRevision: Int { state.revision }
    var capturedVoiceMemo: VoiceMemoPayload? { voiceDraft.payload }
    var isCaptureInFlight: Bool { !state.canLeaveCapture }
    private var captureStartedUptime: TimeInterval?
    private(set) var analysisSubmittedAt: TimeInterval?
    private var preparedPhotoMilliseconds: [UUID: Int] = [:]
    private var photoTimings: [String: (capture: Int, preparation: Int, started: TimeInterval)] = [:]
    var captureStartedAt: TimeInterval? {
        let starts = state.photoIDs.compactMap { photoTimings[$0]?.started }
        // A restored photo has no current-process acquisition clock. Never
        // label a partial interval as the capture time of the complete set.
        return !starts.isEmpty && starts.count == state.photoIDs.count ? starts.min() : nil
    }
    var captureTimingMetadata: [String: Any] {
        let selected = state.photoIDs.compactMap { photoTimings[$0] }
        return ["captureMs": selected.reduce(0) { $0 + $1.capture },
                "preparationMs": selected.reduce(0) { $0 + $1.preparation },
                "timedImageCount": selected.count]
    }

    let continuousBarcodeScanning: Bool

    init(photosOnly: Bool = false, continuousBarcodeScanning: Bool = false, images: [Data] = [], photoIDs: [String] = [], revision: Int = 0, retakeLastPhoto: Bool = false,
         voiceMemo: VoiceMemoPayload? = nil, voicePermissionRequest: ((@escaping (Bool) -> Void) -> Void)? = nil) {
        self.photosOnly = photosOnly
        self.continuousBarcodeScanning = continuousBarcodeScanning
        self.voiceDraft = VoiceMemoDraft(payload: voiceMemo)
        self.voicePermissionRequest = voicePermissionRequest ?? { completion in
            let session = AVAudioSession.sharedInstance()
            switch session.recordPermission {
            case .granted: completion(true)
            case .denied: completion(false)
            default: session.requestRecordPermission(completion)
            }
        }
        self.state = SmartCaptureState(images: images, photoIDs: photoIDs, revision: revision)
        super.init(nibName: nil, bundle: nil)
        voiceDraft.onChange = { [weak self] in self?.refreshVoiceControls() }
        voiceDraft.onRecordingEnded = { [weak self] saved in
            guard let self, !state.closed else { return }
            voiceInteraction.end()
            voiceMemoChanged()
            if !saved { refresh("No voice note saved. Hold the mic to try again.") }
            else { UIAccessibility.post(notification: .announcement, argument: "Voice note ready") }
        }
        modalPresentationStyle = .fullScreen
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = NudgeTheme.cameraBackground
        preview.translatesAutoresizingMaskIntoConstraints = false
        preview.previewLayer.videoGravity = .resizeAspectFill
        preview.previewLayer.session = cameraSession.session
        view.addSubview(preview)
        NSLayoutConstraint.activate([
            preview.leadingAnchor.constraint(equalTo: view.leadingAnchor), preview.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            preview.topAnchor.constraint(equalTo: view.topAnchor), preview.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        let shade = UIView()
        shade.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        shade.isUserInteractionEnabled = false
        shade.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(shade)
        NSLayoutConstraint.activate([
            shade.leadingAnchor.constraint(equalTo: view.leadingAnchor), shade.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            shade.topAnchor.constraint(equalTo: view.topAnchor), shade.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        let content = UIView()
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            content.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor)
        ])
        // Fit normal text within the safe area; accessibility sizes can scroll.
        let preferredHeight = content.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
        preferredHeight.priority = UILayoutPriority(999)
        preferredHeight.isActive = true
        configureIcon(closeButton, symbol: "xmark", label: "Close camera", round: true)
        closeButton.accessibilityIdentifier = "smart-camera-close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        configureIcon(flashButton, symbol: "bolt.slash", label: "Turn flash on", round: true)
        flashButton.accessibilityIdentifier = "smart-camera-flash"
        flashButton.addTarget(self, action: #selector(flashTapped), for: .touchUpInside)
        let countPill = UIView()
        countPill.backgroundColor = NudgeTheme.cameraScrim
        countPill.layer.cornerRadius = 22
        countLabel.font = .preferredFont(forTextStyle: .subheadline).withTraits(.traitBold)
        countLabel.textColor = .white
        countLabel.adjustsFontForContentSizeCategory = true
        countLabel.textAlignment = .center
        countLabel.numberOfLines = 0
        countLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        countLabel.accessibilityIdentifier = "smart-camera-count"
        countLabel.translatesAutoresizingMaskIntoConstraints = false
        countPill.addSubview(countLabel)
        NSLayoutConstraint.activate([
            countLabel.leadingAnchor.constraint(equalTo: countPill.leadingAnchor, constant: 8), countLabel.trailingAnchor.constraint(equalTo: countPill.trailingAnchor, constant: -8),
            countLabel.topAnchor.constraint(equalTo: countPill.topAnchor, constant: 12), countLabel.bottomAnchor.constraint(equalTo: countPill.bottomAnchor, constant: -12)
        ])
        configureIcon(historyButton, symbol: "clock.arrow.circlepath", label: "History", round: true)
        historyButton.accessibilityIdentifier = "smart-camera-history"
        historyButton.addTarget(self, action: #selector(historyTapped), for: .touchUpInside)
        let toolbar = UIStackView(arrangedSubviews: [closeButton, UIView(), countPill, UIView(), historyButton, flashButton])
        toolbar.alignment = .center
        toolbar.spacing = 4
        toolbar.distribution = .equalSpacing
        let frameArea = UIView()
        let frame = CameraFrameView()
        frame.backgroundColor = .clear
        frame.isUserInteractionEnabled = false
        frame.translatesAutoresizingMaskIntoConstraints = false
        frameArea.addSubview(frame)
        let frameWidth = frame.widthAnchor.constraint(equalToConstant: 260)
        frameWidth.priority = .defaultHigh
        frameWidth.isActive = true
        let frameHeight = frame.heightAnchor.constraint(equalToConstant: 233)
        frameHeight.priority = .defaultHigh
        let minimumFrameHeight = frameArea.heightAnchor.constraint(greaterThanOrEqualToConstant: 180)
        self.minimumFrameHeight = minimumFrameHeight
        NSLayoutConstraint.activate([
            frame.centerXAnchor.constraint(equalTo: frameArea.centerXAnchor), frame.centerYAnchor.constraint(equalTo: frameArea.centerYAnchor),
            frame.widthAnchor.constraint(lessThanOrEqualTo: frameArea.widthAnchor, multiplier: 0.84), frame.widthAnchor.constraint(lessThanOrEqualToConstant: 260),
            frame.heightAnchor.constraint(lessThanOrEqualTo: frameArea.heightAnchor), frameHeight,
            minimumFrameHeight
        ])
        let preferredFrame = frameArea.heightAnchor.constraint(equalToConstant: 290)
        preferredFrame.priority = .defaultLow
        preferredFrame.isActive = true
        frameArea.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(focusTapped(_:))))
        frameArea.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(cameraPinched(_:))))
        statusLabel.font = .preferredFont(forTextStyle: .subheadline).withTraits(.traitBold)
        statusLabel.textColor = .white
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.accessibilityIdentifier = "smart-camera-status"
        hintLabel.font = .preferredFont(forTextStyle: .footnote)
        hintLabel.textColor = .white
        hintLabel.accessibilityIdentifier = "smart-camera-hint"
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 0
        hintLabel.adjustsFontForContentSizeCategory = true
        statusLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        hintLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        let hint = UIStackView(arrangedSubviews: [statusLabel, hintLabel])
        hint.axis = .vertical
        hint.spacing = 5
        hint.backgroundColor = NudgeTheme.color(0x17212E, 0x17212E)
        hint.layer.cornerRadius = 14
        hint.isLayoutMarginsRelativeArrangement = true
        hint.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        let rail = CameraThumbnailRail()
        rail.spacing = 9
        rail.alignment = .center
        for index in 0..<4 {
            let slot = CameraThumbnailSlot()
            slot.backgroundColor = NudgeTheme.cameraScrim
            slot.layer.borderColor = NudgeTheme.cameraText.withAlphaComponent(0.75).cgColor
            slot.layer.borderWidth = 1
            slot.layer.cornerRadius = 11
            slot.clipsToBounds = false
            slot.isAccessibilityElement = false
            slot.tag = index

            let image = UIImageView()
            image.contentMode = .scaleAspectFill
            image.isUserInteractionEnabled = false
            image.tag = index
            image.clipsToBounds = true
            image.layer.cornerRadius = 11
            image.translatesAutoresizingMaskIntoConstraints = false
            let label = UILabel()
            label.text = "\(index + 1)"
            label.textColor = .white
            label.font = .preferredFont(forTextStyle: .caption1)
            label.translatesAutoresizingMaskIntoConstraints = false
            slot.addSubview(image)
            slot.addSubview(label)
            NSLayoutConstraint.activate([
                slot.widthAnchor.constraint(equalToConstant: 47), slot.heightAnchor.constraint(equalToConstant: 47),
                image.leadingAnchor.constraint(equalTo: slot.leadingAnchor), image.trailingAnchor.constraint(equalTo: slot.trailingAnchor),
                image.topAnchor.constraint(equalTo: slot.topAnchor), image.bottomAnchor.constraint(equalTo: slot.bottomAnchor),
                label.centerXAnchor.constraint(equalTo: slot.centerXAnchor), label.centerYAnchor.constraint(equalTo: slot.centerYAnchor)
            ])
            let remove = UIButton(type: .system)
            remove.tag = index
            remove.setImage(UIImage(systemName: "xmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(paletteColors: [NudgeTheme.cameraText, .black])), for: .normal)
            remove.tintColor = .white
            remove.accessibilityIdentifier = "smart-camera-remove-\(index + 1)"
            remove.addTarget(self, action: #selector(removePhotoTapped(_:)), for: .touchUpInside)
            remove.translatesAutoresizingMaskIntoConstraints = false
            slot.addSubview(remove)
            NSLayoutConstraint.activate([
                remove.widthAnchor.constraint(equalToConstant: 44), remove.heightAnchor.constraint(equalToConstant: 44),
                remove.trailingAnchor.constraint(equalTo: slot.trailingAnchor, constant: 9),
                remove.topAnchor.constraint(equalTo: slot.topAnchor, constant: -22)
            ])
            removeButtons.append(remove)
            // Child removal control stays inside an expanded hit-test container.
            rail.addArrangedSubview(slot)
            thumbnails.append(image)
            slotLabels.append(label)
        }
        let railWrapper = CameraThumbnailSlot()
        rail.translatesAutoresizingMaskIntoConstraints = false
        railWrapper.addSubview(rail)
        NSLayoutConstraint.activate([
            rail.centerXAnchor.constraint(equalTo: railWrapper.centerXAnchor), rail.topAnchor.constraint(equalTo: railWrapper.topAnchor),
            rail.bottomAnchor.constraint(equalTo: railWrapper.bottomAnchor)
        ])
        configureIcon(libraryButton, symbol: "photo.on.rectangle", label: "Photos")
        libraryButton.accessibilityLabel = "Choose photos from your library"
        libraryButton.accessibilityIdentifier = "smart-camera-library"
        libraryButton.addTarget(self, action: #selector(libraryTapped), for: .touchUpInside)
        resultButton.configuration?.imagePlacement = .trailing
        resultButton.accessibilityIdentifier = "smart-camera-result"
        resultButton.addTarget(self, action: #selector(resultTapped), for: .touchUpInside)
        captureButton.accessibilityLabel = "Take photo"
        captureButton.accessibilityIdentifier = "smart-camera-capture"
        captureButton.tintColor = NudgeTheme.primaryText
        captureButton.backgroundColor = NudgeTheme.primaryFill
        captureButton.clipsToBounds = true
        captureButton.layer.cornerRadius = 37.5
        captureButton.layer.borderWidth = 5
        captureButton.layer.borderColor = view.backgroundColor?.cgColor
        captureButton.setImage(UIImage(systemName: "camera"), for: .normal)
        captureButton.addTarget(self, action: #selector(captureTapped), for: .touchUpInside)
        let shutterRing = CameraShutterRing()
        shutterRing.backgroundColor = NudgeTheme.cameraScrim
        shutterRing.layer.cornerRadius = 39.5
        shutterRing.clipsToBounds = true
        shutterRing.isOpaque = false
        captureButton.translatesAutoresizingMaskIntoConstraints = false
        shutterRing.addSubview(captureButton)
        NSLayoutConstraint.activate([
            shutterRing.widthAnchor.constraint(equalToConstant: 79), shutterRing.heightAnchor.constraint(equalToConstant: 79),
            captureButton.widthAnchor.constraint(equalToConstant: 71), captureButton.heightAnchor.constraint(equalToConstant: 71),
            captureButton.centerXAnchor.constraint(equalTo: shutterRing.centerXAnchor), captureButton.centerYAnchor.constraint(equalTo: shutterRing.centerYAnchor)
        ])
        captureButton.layer.cornerRadius = 35.5
        configureIcon(voiceButton, symbol: "mic", label: "Voice")
        voiceButton.accessibilityIdentifier = "smart-camera-voice"
        voiceButton.accessibilityLabel = "Record a voice note"
        voiceButton.accessibilityHint = "Hold to record, release to stop. Maximum twenty seconds. Double tap with VoiceOver to start or stop."
        voiceButton.addTarget(self, action: #selector(voiceHoldBegan), for: .touchDown)
        voiceButton.addTarget(self, action: #selector(voiceHoldEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        voiceButton.accessibilityToggle = { [weak self] in self?.voiceAccessibilityToggle() }
        voiceStatusLabel.font = .preferredFont(forTextStyle: .body)
        voiceStatusLabel.adjustsFontForContentSizeCategory = true
        voiceStatusLabel.textColor = .white; voiceStatusLabel.numberOfLines = 0; voiceStatusLabel.textAlignment = .center
        voiceStatusLabel.accessibilityIdentifier = "smart-camera-voice-status"
        voiceStatusLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        voiceNoticeLabel.font = .preferredFont(forTextStyle: .footnote)
        voiceNoticeLabel.adjustsFontForContentSizeCategory = true
        voiceNoticeLabel.textColor = .white
        voiceNoticeLabel.numberOfLines = 0; voiceNoticeLabel.textAlignment = .center
        voiceNoticeLabel.accessibilityIdentifier = "smart-camera-voice-notice"
        voiceNoticeLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        voiceActions.axis = .horizontal; voiceActions.distribution = .fillEqually; voiceActions.spacing = 8
        for (button, title, action, identifier) in [
            (voicePlayButton, "Play", #selector(playVoiceMemo), "smart-camera-voice-play"),
            (voiceRedoButton, "Redo", #selector(redoVoiceMemo), "smart-camera-voice-redo"),
            (voiceRemoveButton, "Remove", #selector(removeVoiceMemo), "smart-camera-voice-remove")
        ] {
            button.setTitle(title, for: .normal); button.tintColor = .white
            button.titleLabel?.font = .preferredFont(forTextStyle: .body)
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.titleLabel?.numberOfLines = 0
            button.setContentCompressionResistancePriority(.required, for: .vertical)
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
            button.accessibilityIdentifier = identifier
            button.addTarget(self, action: action, for: .touchUpInside)
            voiceActions.addArrangedSubview(button)
        }
        [voiceStatusLabel, voiceActions, voiceNoticeLabel].forEach(voicePanel.addArrangedSubview)
        voicePanel.backgroundColor = NudgeTheme.color(0x17212E, 0x17212E)
        voicePanel.layer.cornerRadius = 14
        voicePanel.isLayoutMarginsRelativeArrangement = true
        voicePanel.layoutMargins = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        voicePanel.axis = .vertical; voicePanel.spacing = 4
        configureFoodLibraryButton(enterCodeButton, title: "", symbol: "barcode", action: #selector(enterCodeTapped), identifier: "smart-camera-enter-code")
        enterCodeButton.accessibilityLabel = "Enter a barcode manually"
        enterCodeButton.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        enterCodeButton.configuration?.titleLineBreakMode = .byWordWrapping
        enterCodeButton.titleLabel?.numberOfLines = 0
        let libraryActions = UIStackView(arrangedSubviews: [libraryButton, enterCodeButton])
        libraryActions.axis = .vertical; libraryActions.spacing = 4
        let controls = UIStackView(arrangedSubviews: [libraryActions, shutterRing, voiceButton])
        controls.alignment = .center
        controls.spacing = 8
        libraryActions.widthAnchor.constraint(equalTo: voiceButton.widthAnchor).isActive = true
        configureFoodLibraryButton(recentsButton, title: "Recents", symbol: "clock", action: #selector(recentsTapped), identifier: "smart-camera-recents")
        configureFoodLibraryButton(favouritesButton, title: "Favourites", symbol: "star", action: #selector(favouritesTapped), identifier: "smart-camera-favourites")
        let foodLibrary = UIStackView(arrangedSubviews: [recentsButton, favouritesButton])
        foodLibrary.spacing = 12; foodLibrary.distribution = .fillEqually
        analysisServiceLabel.font = .preferredFont(forTextStyle: .footnote)
        analysisServiceLabel.adjustsFontForContentSizeCategory = true
        analysisServiceLabel.textColor = .white
        analysisServiceLabel.numberOfLines = 0
        analysisServiceLabel.textAlignment = .center
        analysisServiceLabel.accessibilityIdentifier = "smart-camera-analysis-service"
        let analysisActions = UIStackView(arrangedSubviews: [analysisServiceLabel, resultButton])
        analysisActions.axis = .vertical; analysisActions.spacing = 6
        let stack = overlayStack
        [toolbar, frameArea, hint, railWrapper, controls, voicePanel, analysisActions, foodLibrary].forEach(stack.addArrangedSubview)
        stack.axis = .vertical
        stack.spacing = 22
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 12), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -23)
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(backgrounded), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(voiceInterrupted), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(voiceInterrupted), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(voiceInterrupted), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(foregrounded), name: UIApplication.didBecomeActiveNotification, object: nil)
        summaryCard.translatesAutoresizingMaskIntoConstraints = false
        summaryCard.isHidden = true
        summaryCard.onAction = { [weak self] action, id in
            guard let self else { return }
            if action == "rescan" {
                if let barcode = lastPresentedBarcode { cameraSession.allowExplicitBarcodeRescan(barcode) }
                delegate?.foodCamera(self, summaryAction: "next", alternativeID: nil)
            } else { delegate?.foodCamera(self, summaryAction: action, alternativeID: id) }
        }
        view.addSubview(summaryCard)
        NSLayoutConstraint.activate([
            summaryCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            summaryCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            summaryCard.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
            summaryCard.heightAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.heightAnchor, multiplier: 0.72)
        ])
        sentLabel.text = "Analysing…"
        sentLabel.font = .preferredFont(forTextStyle: .headline)
        sentLabel.adjustsFontForContentSizeCategory = true
        sentLabel.textColor = .white
        sentLabel.textAlignment = .center
        sentLabel.backgroundColor = NudgeTheme.cameraScrim
        sentLabel.layer.cornerRadius = 18
        sentLabel.clipsToBounds = true
        sentLabel.isHidden = true
        sentLabel.isUserInteractionEnabled = false
        sentLabel.accessibilityIdentifier = "smart-camera-sent"
        sentLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sentLabel)
        NSLayoutConstraint.activate([
            sentLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            sentLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -80),
            sentLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 110),
            sentLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
        captureFlash.backgroundColor = .white
        captureFlash.alpha = 0
        captureFlash.isUserInteractionEnabled = false
        captureFlash.isAccessibilityElement = false
        captureFlash.accessibilityIdentifier = "smart-camera-capture-feedback"
        captureFlash.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(captureFlash)
        NSLayoutConstraint.activate([
            captureFlash.leadingAnchor.constraint(equalTo: view.leadingAnchor), captureFlash.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            captureFlash.topAnchor.constraint(equalTo: view.topAnchor), captureFlash.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let availableHeight = view.safeAreaLayoutGuide.layoutFrame.height
        let compact = availableHeight > 0 && availableHeight <= 650 && !traitCollection.preferredContentSizeCategory.isAccessibilityCategory
        guard compact != usesCompactHeight else { return }
        usesCompactHeight = compact
        // The preview remains full-screen; only its framing guide and spare gaps
        // yield room so short phones keep Analyse and the food shortcuts visible.
        let frameHeight: CGFloat = compact ? 80 : 180
        if minimumFrameHeight?.constant != frameHeight { minimumFrameHeight?.constant = frameHeight }
        let spacing: CGFloat = compact ? 12 : 22
        if overlayStack.spacing != spacing { overlayStack.spacing = spacing }
        if overlayStack.arrangedSubviews.count > 2 {
            // Preserve the existing 44pt X controls extending above the rail.
            let rail = overlayStack.arrangedSubviews[2]
            if overlayStack.customSpacing(after: rail) != 22 { overlayStack.setCustomSpacing(22, after: rail) }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        visible = true
        captureHaptic.prepare()
        Task { [weak self] in
            guard let self else { return }
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            let allowed = status == .notDetermined ? await AVCaptureDevice.requestAccess(for: .video) : status == .authorized
            guard visible, !state.closed, !suspendedForResult else { return }
            guard allowed else { refresh("Camera access is off. Use Photos, or enable it in Settings."); return }
            configureCamera()
        }
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed || presentingViewController == nil {
            if suspendedForResult || closingForDeferredPhoto { visible = false; stopSession() }
            else { closeCapture() }
        }
    }
    deinit { NotificationCenter.default.removeObserver(self) }

    private func configureIcon(_ button: UIButton, symbol: String, label: String, round: Bool = false) {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: symbol)
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 22, weight: .regular)
        configuration.baseForegroundColor = .white
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 9, leading: 5, bottom: 9, trailing: 5)
        configuration.background.backgroundColor = NudgeTheme.cameraScrim
        configuration.background.cornerRadius = NudgeTheme.controlRadius
        if round {
            configuration.background.backgroundColor = NudgeTheme.cameraScrim
            configuration.background.cornerRadius = 22
            button.widthAnchor.constraint(equalToConstant: 44).isActive = true
        } else {
            configuration.title = label
            configuration.imagePlacement = .top
            configuration.imagePadding = 6
            configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { input in
                var output = input
                output.font = .preferredFont(forTextStyle: .caption1)
                return output
            }
        }
        button.configuration = configuration
        button.accessibilityLabel = label
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }
    private func configureFoodLibraryButton(_ button: UIButton, title: String, symbol: String, action: Selector, identifier: String) {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        configuration.image = UIImage(systemName: symbol)
        configuration.imagePadding = 7
        configuration.baseForegroundColor = .white
        configuration.background.backgroundColor = NudgeTheme.color(0x17212E, 0x17212E)
        configuration.background.cornerRadius = 12
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { input in
            var output = input; output.font = .preferredFont(forTextStyle: .subheadline); return output
        }
        button.configuration = configuration
        button.accessibilityIdentifier = identifier
        button.addTarget(self, action: action, for: .touchUpInside)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    }
    private var captureStorageError: String?
    func setCaptureStorageError(_ message: String?) {
        captureStorageError = message
        if message != nil, let revision = analysisRevision, state.finishAnalysis(revision: revision) { analysisRevision = nil }
        refresh(message)
    }
    private func refresh(_ message: String? = nil) {
        // Durable capture updates can arrive before presentation builds the
        // thumbnail controls. Keep their state and render it in viewDidLoad.
        guard isViewLoaded else { return }
        let count = state.images.count
        countLabel.text = "\(count)/4"
        countLabel.accessibilityLabel = "\(count) of 4 photos"
        let guidance = CameraPhotoGuidance.message(photoCount: count)
        statusLabel.text = message ?? captureStorageError ?? requestedPanelHint ?? guidance.heading
        hintLabel.text = guidance.detail
        hintLabel.isHidden = guidance.detail.isEmpty
        captureButton.accessibilityLabel = "Take photo"
        let busy = enteringBarcode || state.capturing || state.importing || state.analysing || suspendedForResult || !summaryCard.isHidden || voiceInteraction.active
        cameraSession.setBarcodeDetectionEnabled(visible && !enteringBarcode && !state.closed && !suspendedForResult && !productLocked && !photosOnly &&
            !state.capturing && !state.importing && !state.analysing && !voiceInteraction.active && !voiceDraft.hasMemo)
        closeButton.isEnabled = !state.closed
        captureButton.isEnabled = configured && !busy && !state.closed && (count < 4 || state.replacingLastPhoto)
        captureButton.alpha = captureButton.isEnabled ? 1 : 0.35
        resultButton.isEnabled = !busy && !state.closed && count > 0
        resultButton.alpha = 1 // The shared control supplies an explicit disabled surface.
        analysisServiceLabel.text = analysisServiceText
        resultButton.accessibilityHint = analysisServiceText
        enterCodeButton.isHidden = photosOnly
        enterCodeButton.isEnabled = !busy && !productLocked && !state.closed && !voiceDraft.hasMemo
        enterCodeButton.alpha = enterCodeButton.isEnabled ? 1 : 0.35
        libraryButton.isEnabled = !enteringBarcode && state.canImport && !suspendedForResult && summaryCard.isHidden && !voiceInteraction.active
        libraryButton.alpha = libraryButton.isEnabled ? 1 : 0.35
        libraryButton.accessibilityHint = count == 4 ? "Remove a photo to add another." : "Choose up to \(state.librarySlotsAvailable) photos."
        historyButton.isEnabled = !enteringBarcode && !state.capturing && !state.importing && !voiceInteraction.active
        recentsButton.isEnabled = !busy && !state.closed
        favouritesButton.isEnabled = !busy && !state.closed
        flashButton.isEnabled = configured && !suspendedForResult && !state.importing
        for index in 0..<4 {
            removeButtons[index].isHidden = index >= count
            removeButtons[index].isEnabled = !busy
            removeButtons[index].accessibilityLabel = "Remove photo \(index + 1)"
            let photoID = index < count ? state.photoIDs[index] : nil
            if thumbnailPhotoIDs[index] != photoID {
                thumbnails[index].image = index < count ? CameraLibraryPhoto.thumbnail(from: state.images[index]).map { UIImage(cgImage: $0) } : nil
                thumbnailPhotoIDs[index] = photoID
            }
            thumbnails[index].isUserInteractionEnabled = false
            slotLabels[index].isHidden = index < count
            thumbnails[index].isAccessibilityElement = index < count
            thumbnails[index].accessibilityLabel = "Photo \(index + 1)"
            thumbnails[index].accessibilityTraits = .image
        }
        refreshVoiceControls()
    }
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard isViewLoaded else { return }
        refreshVoiceControls()
    }
    private func refreshVoiceControls() {
        voicePanel.isHidden = !voiceInteraction.active && !voiceDraft.hasMemo
        voiceActions.axis = traitCollection.preferredContentSizeCategory.isAccessibilityCategory ? .vertical : .horizontal
        let unavailable = state.closed || state.capturing || state.importing || state.analysing || suspendedForResult || !summaryCard.isHidden
        voiceButton.isEnabled = !unavailable
        voiceButton.alpha = voiceButton.isEnabled ? 1 : 0.35
        voiceButton.configuration?.image = UIImage(systemName: voiceInteraction.recording ? "stop.fill" : "mic")
        voiceButton.configuration?.baseForegroundColor = voiceInteraction.recording ? .systemRed : .white
        voiceButton.accessibilityLabel = voiceInteraction.active ? "Stop voice recording" : voiceDraft.hasMemo ? "Hold to replace voice note" : "Record a voice note"
        voiceStatusLabel.isHidden = !voiceInteraction.active && !voiceDraft.hasMemo
        if voiceInteraction.pending != nil { voiceStatusLabel.text = "Allow microphone access, then hold to record" }
        else if voiceInteraction.recording { voiceStatusLabel.text = String(format: "Recording 0:%02d / 1:00 · Release to stop", Int(voiceDraft.elapsed)) }
        else { voiceStatusLabel.text = "Voice note · \(max(1, Int(ceil(voiceDraft.duration))))s" }
        voiceStatusLabel.textColor = .white
        voiceActions.isHidden = !voiceDraft.hasMemo || voiceInteraction.active
        voicePlayButton.setTitle(voiceDraft.playing ? "Stop" : "Play", for: .normal)
        [voicePlayButton, voiceRedoButton, voiceRemoveButton].forEach { $0.isEnabled = !unavailable }
        voiceNoticeLabel.text = UserDefaults.standard.bool(forKey: "nudge-voice-sharing-notice-v1") ? "Sent with photos when you analyse." : VoiceMemoDraft.sharingNotice
    }
    @objc private func voiceHoldBegan() {
        guard !UIAccessibility.isVoiceOverRunning else { return }; beginVoiceRecording()
    }
    private func voiceAccessibilityToggle() {
        if voiceInteraction.active { stopVoiceRecording() } else { beginVoiceRecording() }
    }
    private func beginVoiceRecording() {
        guard !state.closed, !state.capturing, !state.importing, !state.analysing, !suspendedForResult,
              summaryCard.isHidden, presentedViewController == nil, let token = voiceInteraction.begin() else { return }
        voiceDraft.stopPlayback(); refresh()
        voicePermissionRequest { [weak self] allowed in
            Task { @MainActor in
                guard let self, !self.state.closed, !self.suspendedForResult,
                      self.voiceInteraction.permissionResolved(allowed, token: token) else {
                    if let self, !self.state.closed { self.refresh(allowed ? nil : "Microphone access is off. You can enable it in Settings, or analyse photos without a note.") }
                    return
                }
                do { try self.voiceDraft.start(); UIImpactFeedbackGenerator(style: .light).impactOccurred(); self.refresh() }
                catch { self.voiceInteraction.end(); self.voiceMemoChanged(); self.refresh("Couldn’t record. Hold the mic to try again.") }
            }
        }
    }
    @objc private func voiceHoldEnded() { guard !UIAccessibility.isVoiceOverRunning else { return }; stopVoiceRecording() }
    private func stopVoiceRecording() {
        let wasRecording = voiceInteraction.end()
        if wasRecording { voiceDraft.stopRecording() }
        refresh()
    }
    @objc private func voiceInterrupted() { stopVoiceRecording(); voiceDraft.stopPlayback() }
    private func voiceMemoChanged() {
        state.voiceMemoChanged()
        analysisRevision = nil
        delegate?.foodCameraDidChangeVoiceMemo(self)
        refresh()
    }
    @objc private func playVoiceMemo() {
        do { try voiceDraft.togglePlayback() } catch { refresh("Couldn’t play this note. Redo it to try again.") }
    }
    @objc private func redoVoiceMemo() { removeVoiceMemo(); refresh("Hold the mic to record again") }
    @objc private func removeVoiceMemo() {
        voiceInteraction.end(); voiceDraft.remove(); voiceMemoChanged()
    }
    private func configureCamera() {
        guard !configuring, !state.closed else { return }
        if configured { startSession(); return }
        configuring = true
        cameraSession.configure { [weak self] success in
            guard let self else { return }
            configuring = false
            configured = success
            guard success else { refresh("Camera unavailable. Choose Photos to add a picture."); return }
            if visible && !state.closed && UIApplication.shared.applicationState == .active { startSession() }
        }
    }
    private func startSession() {
        guard configured, visible, !state.closed, !state.importing, !suspendedForResult else { return }
        guard !sessionRequestedRunning else { return }
        sessionRequestedRunning = true
        cameraSession.start()
        refresh()
    }
    private func stopSession() {
        guard sessionRequestedRunning else { return }
        sessionRequestedRunning = false
        cameraSession.setTorch(false) { [weak self] _ in self?.updateFlash(false) }
        cameraSession.stop()
    }
    @objc private func backgrounded() { stopSession() }
    @objc private func foregrounded() {
        guard visible, !state.closed, !suspendedForResult, AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return }
        if configured { startSession() } else { configureCamera() }
    }
    func closeCapture() {
        guard !state.closed else { return }
        cancelLibraryWork()
        visible = false
        state.close()
        sentTask?.cancel(); sentTask = nil
        feedbackTask?.cancel(); feedbackTask = nil
        voiceInteraction.end(); voiceDraft.remove()
        stopSession()
        delegate = nil
    }
    /// The camera screen can close immediately while a hardware photo finishes
    /// encoding. The coordinator retains this controller and its original job
    /// identity until the completion is durably saved. Imports are cancellable;
    /// their originals remain in the system photo library.
    @discardableResult func deferPhotoUntilAfterDismissal() -> Bool {
        stopVoiceRecording()
        if let revision = libraryImportRevision {
            _ = state.cancelLibraryImport(revision: revision)
            cancelLibraryWork()
        }
        guard state.capturing else { return false }
        closingForDeferredPhoto = true
        visible = false; stopSession()
        return true
    }
    /// Keep capture bytes, IDs and recognition memory while full detail is open.
    func suspendForResult() {
        stopVoiceRecording(); voiceDraft.stopPlayback()
        suspendedForResult = true
        visible = false
        stopSession()
    }
    func showProductSummary(_ summary: CameraProductSummary) {
        loadViewIfNeeded()
        productLocked = !(continuousBarcodeScanning && summary.compact)
        if let revision = analysisRevision { _ = state.finishAnalysis(revision: revision); analysisRevision = nil }
        summaryCard.update(summary)
        summaryCard.isHidden = false
        // Recognition remains live even while a previous lookup is still loading.
        if !isBeingDismissed, view.window != nil { resumePresentation() }
        refresh()
    }
    func prepareForLabelCapture(panel: String? = nil) {
        loadViewIfNeeded()
        requestedPanelHint = panel == "nutrition" ? "Photograph the nutrition panel" : panel == "ingredients" ? "Photograph the ingredients list" : panel == "identity" ? "Photograph the front of this pack" : "Photograph the nutrition or ingredients label"
        productLocked = true; photosOnly = true
        summaryCard.isHidden = true
        if let revision = analysisRevision { _ = state.finishAnalysis(revision: revision); analysisRevision = nil }
        state.arm()
        if !isBeingDismissed, view.window != nil { resumePresentation() }
        refresh()
    }
    func resumePresentation() {
        suspendedForResult = false
        closingForDeferredPhoto = false
        if isViewLoaded { refresh() }
        if view.window != nil { visible = true; startSession() }
    }
    /// Closing a barcode card must not discard the separate photo/voice draft.
    func dismissProductSummary() {
        photosOnly = false
        productLocked = false
        requestedPanelHint = nil
        summaryCard.isHidden = true
        if isViewLoaded { refresh() }
    }
    func prepareNextScan() {
        cancelLibraryWork()
        voiceInteraction.end(); voiceDraft.remove()
        photosOnly = false
        productLocked = false
        requestedPanelHint = nil
        summaryCard.isHidden = true
        state.clearPhotos()
        captureToken = nil
        captureRevision = nil
        analysisRevision = nil
        suspendedForResult = false
        if isViewLoaded { if view.window != nil { visible = true; startSession() }; refresh() }
    }
    /// Called only after the coordinator has durably accepted this exact batch.
    /// Do not report a draft change: the saved job owns those bytes and the
    /// coordinator has already rotated to a new event identifier.
    @discardableResult func acceptSubmittedCapture(revision expected: Int) -> Bool {
        guard state.acceptSubmittedCapture(revision: expected) else { return false }
        cancelLibraryWork()
        captureToken = nil; captureRevision = nil; analysisRevision = nil
        analysisSubmittedAt = nil
        voiceInteraction.end(); voiceDraft.remove()
        captureStorageError = nil
        requestedPanelHint = nil
        photosOnly = false; productLocked = false
        summaryCard.isHidden = true
        refresh()
        if isViewLoaded {
            sentTask?.cancel()
            sentLabel.isHidden = false
            // The app shell announces the accepted analysis after dismissal.
            sentTask = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 900_000_000) } catch { return }
                guard let self, !Task.isCancelled else { return }
                sentLabel.isHidden = true
                sentTask = nil
            }
        }
        return true
    }
    private func showCaptureFeedback(photo: Bool = false) {
        guard isViewLoaded else { return }
        // Rapid distinct scans still succeed, but don't strobe the whole screen.
        let now = ProcessInfo.processInfo.systemUptime
        // An explicit shutter must still be visible just after a barcode flash.
        guard photo || now - lastFlashAt >= 0.35 else { return }
        lastFlashAt = now
        feedbackTask?.cancel()
        captureFlash.layer.removeAllAnimations()
        view.bringSubviewToFront(captureFlash)
        UIView.performWithoutAnimation { captureFlash.alpha = UIAccessibility.isReduceMotionEnabled ? 0.3 : 1 }
        // Commit white before synchronous capture persistence. Scheduling the
        // fade in a later actor turn prevents that work consuming the flash.
        CATransaction.flush()
        feedbackTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 120_000_000) } catch { return }
            guard let self, !Task.isCancelled else { return }
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                self.captureFlash.alpha = 0
            }
            feedbackTask = nil
        }
    }
    @objc private func closeTapped() {
        guard !state.closed else { return }
        stopVoiceRecording()
        delegate?.foodCameraDidCancel(self)
    }
    @objc private func historyTapped() {
        guard state.canLeaveCapture else { return }; delegate?.foodCameraDidOpenHistory(self)
    }
    @objc private func recentsTapped() {
        guard state.canLeaveCapture else { return }; delegate?.foodCamera(self, openFoodLibrary: "recents")
    }
    @objc private func favouritesTapped() {
        guard state.canLeaveCapture else { return }; delegate?.foodCamera(self, openFoodLibrary: "favourites")
    }
    @objc private func flashTapped() {
        cameraSession.setTorch(!torchEnabled) { [weak self] enabled in
            guard let self else { return }
            updateFlash(enabled)
            if !enabled { UIAccessibility.post(notification: .announcement, argument: "Flash off") }
        }
    }
    private func updateFlash(_ enabled: Bool) {
        torchEnabled = enabled
        flashButton.configuration?.image = UIImage(systemName: enabled ? "bolt.fill" : "bolt.slash")
        flashButton.accessibilityLabel = enabled ? "Turn flash off" : "Turn flash on"
    }
    @objc private func captureTapped() {
        guard configured, let token = beginPhotoCapture() else { return }
        cameraSession.capture(token: token)
    }
    /// Keep capture identity independent of hardware transport so completion
    /// after dismissal can be tested without opening a camera or using photos.
    func beginPhotoCapture() -> UUID? {
        guard !voiceInteraction.active, !suspendedForResult, !closingForDeferredPhoto, summaryCard.isHidden else { return nil }
        state.arm()
        guard let revision = state.beginCapture() else { return nil }
        captureRevision = revision
        captureHaptic.prepare()
        lastPhotoCaptureFailed = false
        refresh("Taking photo…")
        let token = UUID()
        captureToken = token
        captureStartedUptime = ProcessInfo.processInfo.systemUptime
        return token
    }
    func capturedShutter(token: UUID) {
        guard let revision = captureRevision, captureToken == token, !suspendedForResult, !closingForDeferredPhoto,
              state.acknowledgeShutter(revision: revision) else { return }
        showCaptureFeedback(photo: true)
    }
    func finishPhoto(_ rawData: Data?, token: UUID) {
        guard let revision = captureRevision, captureToken == token, !state.closed, !suspendedForResult else { return }
        defer { if closingForDeferredPhoto { delegate?.foodCameraDidFinishDeferredPhoto(self) } }
        captureRevision = nil
        captureToken = nil
        let previousIDs = Set(state.photoIDs)
        // FoodCameraSession has already bounded and stripped the JPEG off main.
        if state.finishCapture(rawData, revision: revision) {
            if let id = state.photoIDs.first(where: { !previousIDs.contains($0) }), let began = captureStartedUptime {
                let preparation = preparedPhotoMilliseconds.removeValue(forKey: token) ?? 0
                photoTimings[id] = (max(0, Int((ProcessInfo.processInfo.systemUptime - began) * 1000) - preparation), preparation, began)
            }
            if !closingForDeferredPhoto {
                // Successful processing is a safe fallback on capture paths
                // that do not deliver the hardware exposure callback.
                if !state.shutterAcknowledged { showCaptureFeedback(photo: true) }
                // Confirm only an accepted photo, never a shutter whose JPEG
                // later fails. The capture token makes this exactly once.
                pulseCaptureFeedback()
            }
            delegate?.foodCamera(self, changedPhotoCount: state.images.count)
            refresh()
        } else {
            preparedPhotoMilliseconds.removeValue(forKey: token)
            lastPhotoCaptureFailed = true
            refresh("The photo could not be saved. Try taking it again.")
        }
    }
    @objc private func libraryTapped() {
        guard presentedViewController == nil, !voiceInteraction.active, !suspendedForResult, summaryCard.isHidden,
              let revision = state.beginLibraryImport() else { return }
        let token = UUID()
        libraryImportToken = token
        libraryImportRevision = revision
        AnalysisDiagnostics.shared.record(stage: "photo_library", outcome: "started", metadata: ["imageCount": state.images.count])
        stopSession()
        refresh("Choose photos from your library")
        // The system picker grants access only to the photos the user chooses.
        // No PHPhotoLibrary authorization or whole-library access is requested.
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selection = .ordered
        configuration.selectionLimit = state.librarySlotsAvailable
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        picker.modalPresentationStyle = .fullScreen
        present(picker, animated: true)
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard let token = libraryImportToken, let revision = libraryImportRevision else { picker.dismiss(animated: true); return }
        picker.dismiss(animated: true) { [weak self] in
            guard let self, libraryImportToken == token, !state.closed else { return }
            guard !results.isEmpty else {
                _ = state.cancelLibraryImport(revision: revision)
                AnalysisDiagnostics.shared.record(stage: "photo_library", outcome: "cancelled", metadata: ["imageCount": state.images.count])
                cancelLibraryWork()
                startSession(); refresh()
                return
            }
            refresh("Adding photos…")
            let providers = Array(results.prefix(state.librarySlotsAvailable)).map(\.itemProvider)
            let acquisitionStarted = ProcessInfo.processInfo.systemUptime
            libraryImportTask = Task { [weak self] in
                guard let self else { return }
                let began = acquisitionStarted
                let previousIDs = Set(state.photoIDs)
                var photos: [Data] = []
                var preparations: [Int] = []
                // Keep the picker order and process one image at a time to bound memory.
                for provider in providers {
                    guard !Task.isCancelled, libraryImportToken == token, !state.closed else { return }
                    let prepared: (Data?, Int) = await withCheckedContinuation { continuation in
                        self.libraryProgress = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                            // This temporary URL is valid only inside this callback.
                            let began = ProcessInfo.processInfo.systemUptime
                            let jpeg = url.flatMap { CameraLibraryPhoto.jpeg(from: $0) }
                            continuation.resume(returning: (jpeg, max(0, Int((ProcessInfo.processInfo.systemUptime - began) * 1000))))
                        }
                    }
                    if let data = prepared.0 { photos.append(data); preparations.append(prepared.1) }
                }
                guard !Task.isCancelled, libraryImportToken == token, !state.closed else { return }
                let accepted = state.finishLibraryImport(photos, revision: revision)
                if accepted {
                    let newIDs = state.photoIDs.filter { !previousIDs.contains($0) }
                    for (index, id) in newIDs.enumerated() {
                        photoTimings[id] = (index == 0 ? max(0, Int((ProcessInfo.processInfo.systemUptime - began) * 1000) - preparations.reduce(0, +)) : 0,
                                           preparations.indices.contains(index) ? preparations[index] : 0, began)
                    }
                }
                AnalysisDiagnostics.shared.record(stage: "photo_library", outcome: accepted ? (photos.count < providers.count ? "partial_import" : "imported") : "import_failed", metadata: ["imageCount": state.images.count, "captureRevision": state.revision])
                libraryImportToken = nil; libraryImportRevision = nil; libraryImportTask = nil; libraryProgress = nil
                if accepted {
                    delegate?.foodCamera(self, changedPhotoCount: state.images.count)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
                startSession()
                if photos.count < providers.count {
                    refresh(accepted ? "Some photos could not be added. Try choosing them again." : "These photos could not be opened. Try another photo.")
                } else { refresh() }
            }
        }
    }
    private func cancelLibraryWork() {
        libraryImportToken = nil; libraryImportRevision = nil
        libraryImportTask?.cancel(); libraryImportTask = nil
        libraryProgress?.cancel(); libraryProgress = nil
    }
    @objc private func enterCodeTapped() {
        guard visible, presentedViewController == nil, !enteringBarcode, !photosOnly, !productLocked,
              !state.closed, !state.capturing, !state.importing, !state.analysing,
              !suspendedForResult, summaryCard.isHidden, !voiceInteraction.active, !voiceDraft.hasMemo else { return }
        enteringBarcode = true; refresh()
        FoodBarcodeEntry.present(from: self) { [weak self] code in
            guard let self else { return }
            enteringBarcode = false; refresh()
            if let code { foundBarcode(code, manual: true) }
        }
    }
    private func foundBarcode(_ barcode: String?, manual: Bool = false) {
        guard visible, !enteringBarcode, !suspendedForResult, !productLocked, !state.closed, !photosOnly, !state.capturing, !state.importing, !state.analysing, !voiceInteraction.active, !voiceDraft.hasMemo else { return }
        guard let barcode, barcode.range(of: #"\A[0-9]{4,18}\z"#, options: .regularExpression) != nil else { return }
        lastPresentedBarcode = barcode
        lastBarcodeWasManual = manual
        showCaptureFeedback()
        pulseCaptureFeedback()
        let loading = continuousBarcodeScanning ? CameraProductSummary(object: ["status":"loading", "compact":true, "name":"Finding your product…"])! : .loading
        showProductSummary(loading)
        delegate?.foodCamera(self, found: barcode)
    }
    @objc private func resultTapped() {
        guard presentedViewController == nil, !suspendedForResult, !voiceInteraction.active, state.canAnalyse else { return }
        submitAnalysis(expectedRevision: state.revision)
    }
    private var analysisServiceText: String {
        delegate?.foodCameraAnalysisServiceText(self) ?? "Uses Nudge’s service"
    }
    func submitAnalysis(expectedRevision: Int) {
        guard !state.closed, !suspendedForResult, !voiceInteraction.active, state.canAnalyse, state.revision == expectedRevision else { return }
        // Anchor the Analyse action before sharing
        // consent. Capture-to-result remains a separate acquisition clock.
        analysisSubmittedAt = ProcessInfo.processInfo.systemUptime
        // Keep the existing sharing notice ahead of any durable submission.
        let proceed = { [weak self] in
            guard let self, !state.closed, state.revision == expectedRevision else { return }
            requestPhotoPermission { [weak self] allowed in
                guard let self, allowed, state.revision == expectedRevision,
                      let revision = state.beginAnalysis(permission: PhotoAnalysisPermission().allowed) else { return }
                analysisRevision = revision
                if voiceDraft.hasMemo { UserDefaults.standard.set(true, forKey: "nudge-voice-sharing-notice-v1") }
                refresh("Sending…")
                delegate?.foodCamera(self, analyse: state.images, addToEaten: false)
            }
        }
        if presentedViewController != nil { dismiss(animated: true, completion: proceed) }
        else { proceed() }
    }
    func analysisFailed(_ message: String) {
        guard let revision = analysisRevision, state.finishAnalysis(revision: revision) else { return }
        analysisRevision = nil
        refresh(message)
    }
    func requestPhotoPermission(completion: @escaping (Bool) -> Void) {
        if PhotoAnalysisPermission().allowed { completion(true); return }
        guard presentedViewController == nil, !state.closed else { return }
        let alert = UIAlertController(title: PhotoAnalysisPermission.title, message: PhotoAnalysisPermission.explanation, preferredStyle: .alert)
        alert.view.tintColor = NudgeTheme.accent
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in completion(false) })
        alert.addAction(UIAlertAction(title: PhotoAnalysisPermission.allowTitle, style: .default) { [weak self] _ in
            guard let self, !state.closed else { completion(false); return }
            PhotoAnalysisPermission().allow()
            completion(true)
        })
        present(alert, animated: true)
    }
    @objc private func removePhotoTapped(_ sender: UIButton) {
        guard state.remove(at: sender.tag) else { return }
        captureToken = nil
        captureRevision = nil
        analysisRevision = nil
        delegate?.foodCamera(self, changedPhotoCount: state.images.count)
        refresh()
        UIAccessibility.post(notification: .announcement, argument: "Photo removed. \(state.images.count) photos remaining")
    }
    @objc private func cameraPinched(_ gesture: UIPinchGestureRecognizer) {
        guard !state.closed, !suspendedForResult else { return }
        if gesture.state == .changed { cameraSession.zoom(by: gesture.scale); gesture.scale = 1 }
    }
    @objc private func focusTapped(_ gesture: UITapGestureRecognizer) {
        guard !state.closed, !suspendedForResult else { return }
        let point = preview.previewLayer.captureDevicePointConverted(fromLayerPoint: gesture.location(in: preview))
        cameraSession.focus(at: point)
    }
}

private extension UIFont {
    func withTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(traits) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
