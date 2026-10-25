import Combine
import Foundation
import SwiftUI

// This feature only uses the managed Nudge account. No owner-token fallback,
// diary upload, durable profile cache, free-text identity or client-awarded points.
enum AmbassadorError: LocalizedError, Equatable {
    case signIn, accountChanged, unavailable, invalidResponse, invalidChoice, consentRequired, rateLimited, termsChanged, memberUnavailable, hiddenUnavailable, nameUnavailable, requestExpired
    var errorDescription: String? {
        switch self {
        case .signIn: "Sign in to your Nudge account to join the ambassadors."
        case .accountChanged: "Your account changed. Reopen ambassadors to continue."
        case .unavailable: "The ambassador club is taking a breather. Try again in a moment."
        case .invalidResponse: "Nudge could not confirm that update. Refresh before trying again."
        case .invalidChoice: "Choose a name from the two lists."
        case .consentRequired: "Please read the contribution terms and confirm you’re 18 or older to join."
        case .rateLimited: "A little breather—please wait before trying again."
        case .termsChanged: "The ambassador terms have changed. Refresh and read the latest version."
        case .memberUnavailable: "That ambassador is no longer available. Refresh the board."
        case .hiddenUnavailable: "Your hidden list may be full, or that ambassador has changed. Refresh the board or remove someone from your hidden list."
        case .nameUnavailable: "That name is busy. Try another suggested name."
        case .requestExpired: "That request expired. Please refresh and try again."
        }
    }
}

enum AmbassadorPeriod: String, CaseIterable, Identifiable, Decodable {
    case week, all
    var id: String { rawValue }
    var title: String { self == .week ? "This week" : "All time" }
}

enum AmbassadorBadge: String, Decodable {
    case newcomer, helper, champion, trailblazer
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self { case .newcomer: "leaf"; case .helper: "leaf.fill"; case .champion: "star.fill"; case .trailblazer: "sparkles" }
    }
}

enum AmbassadorParticipation: String, Decodable { case active, paused }

struct AmbassadorProfile: Decodable, Equatable {
    let profileID: UUID
    let participationStatus: AmbassadorParticipation
    let handle: String
    let adjective: String
    let noun: String
    let leaderboardVisible: Bool
    let joinedAt: Int64
    let allTimePoints: Int
    let weekPoints: Int
    let badge: AmbassadorBadge
}

struct AmbassadorEnvelope: Decodable {
    let profile: AmbassadorProfile?
    let termsVersion: String
    let adjectives: [String]
    let nouns: [String]

    func validated() throws -> Self {
        guard termsVersion == AmbassadorService.termsVersion else { throw AmbassadorError.termsChanged }
        guard Self.validChoices(adjectives), Self.validChoices(nouns) else { throw AmbassadorError.invalidResponse }
        if let profile {
            guard adjectives.contains(profile.adjective), nouns.contains(profile.noun),
                  AmbassadorService.validHandle(profile.handle),
                  profile.handle.hasPrefix(profile.adjective + profile.noun), profile.joinedAt > 0,
                  (0...1_000_000_000).contains(profile.allTimePoints),
                  (0...profile.allTimePoints).contains(profile.weekPoints) else { throw AmbassadorError.invalidResponse }
        }
        return self
    }
    private static func validChoices(_ values: [String]) -> Bool {
        !values.isEmpty && values.count <= 32 && Set(values).count == values.count && values.allSatisfy {
            $0.range(of: #"^[A-Z][a-z]{1,19}$"#, options: .regularExpression) != nil
        }
    }
}

struct AmbassadorLeaderboard: Decodable {
    struct Entry: Decodable, Identifiable {
        let profileID: UUID
        let rank: Int
        let handle: String
        let points: Int
        let badge: AmbassadorBadge
        var id: UUID { profileID }
    }
    let period: AmbassadorPeriod
    let weekStartsAt: Int64
    let entries: [Entry]
    let myRank: Int?

    func validated(period expected: AmbassadorPeriod) throws -> Self {
        guard period == expected, weekStartsAt > 0, entries.count <= 50,
              myRank.map({ (1...1_000_000_000).contains($0) }) ?? true,
              Set(entries.map(\.handle)).count == entries.count, Set(entries.map(\.profileID)).count == entries.count else { throw AmbassadorError.invalidResponse }
        var previousPoints = Int.max, previousRank = 0
        for entry in entries {
            guard AmbassadorService.validHandle(entry.handle), (1...1_000_000_000).contains(entry.points),
                  entry.points <= previousPoints,
                  (1...1_000_000_000).contains(entry.rank),
                  entry.points == previousPoints ? entry.rank == previousRank : entry.rank > previousRank else { throw AmbassadorError.invalidResponse }
            previousPoints = entry.points; previousRank = entry.rank
        }
        return self
    }
}

/// A display projection over authenticated server data. A local self row never
/// opts the profile into sharing, and virtual goals never enter server rankings.
struct AmbassadorBoardPresentation {
    struct Row: Identifiable {
        let profileID: UUID
        let rank: Int?
        let handle: String
        let points: Int
        let badge: AmbassadorBadge
        let isSelf: Bool
        let status: String?
        var id: UUID { profileID }
    }
    let rows: [Row]
    let needsJoin: Bool

    init(profile: AmbassadorProfile?, board: AmbassadorLeaderboard?, period: AmbassadorPeriod) {
        let current = board?.period == period ? board : nil
        let shared = profile?.leaderboardVisible == true && profile?.participationStatus == .active
        var result = (current?.entries ?? []).compactMap { entry -> Row? in
            let isSelf = entry.profileID == profile?.profileID
            // A just-saved privacy setting takes precedence over an older board.
            if isSelf && !shared { return nil }
            return Row(profileID: entry.profileID, rank: entry.rank, handle: entry.handle,
                       points: entry.points, badge: entry.badge, isSelf: isSelf,
                       status: isSelf ? "Your shared place" : nil)
        }
        if let profile, !result.contains(where: { $0.profileID == profile.profileID }) {
            let points = period == .week ? profile.weekPoints : profile.allTimePoints
            let rank = shared && points > 0 ? current?.myRank : nil
            let status: String
            if profile.participationStatus == .paused { status = "Participation paused · not ranked" }
            else if !profile.leaderboardVisible { status = "Private · this row is only visible to you" }
            else if points == 0 { status = period == .week ? "Not ranked yet · no reviewed points this week" : "Not ranked yet · your first reviewed point starts here" }
            else if rank != nil { status = "Your shared place · outside the displayed top 50" }
            else if current == nil { status = "Your points · shared rank unavailable" }
            else { status = "Your points · not currently ranked on the shared board" }
            result.append(Row(profileID: profile.profileID, rank: rank, handle: profile.handle,
                              points: points, badge: profile.badge, isSelf: true, status: status))
        }
        rows = result; needsJoin = profile == nil
    }
}

struct AmbassadorPacemaker: Identifiable, Equatable {
    let id: String
    let title: String
    let target: Int
    let period: AmbassadorPeriod
    var periodLabel: String { period == .week ? "this week" : "all time" }
    static func targets(for period: AmbassadorPeriod) -> [Self] {
        let steps: [(String, String, Int)] = period == .week
            ? [("first", "First helpful step", 1), ("steady", "Keep helping", 5), ("team", "Team pace", 20)]
            : [("helper", "Helper milestone", 5), ("champion", "Champion milestone", 25), ("trailblazer", "Trailblazer milestone", 100)]
        return steps.map { .init(id: period.rawValue + "-" + $0.0, title: $0.1, target: $0.2, period: period) }
    }
    func points(for profile: AmbassadorProfile) -> Int { period == .week ? profile.weekPoints : profile.allTimePoints }
    func remaining(for profile: AmbassadorProfile) -> Int { max(0, target - points(for: profile)) }
}

/// Positions in this local comparison table include targets; official shared
/// ranks remain the server ranks carried by member rows. Targets have no profile
/// ID, awarded points or moderation actions and cannot enter the remote board.
struct AmbassadorLeaguePresentation {
    struct Row: Identifiable {
        enum Source {
            case member(AmbassadorBoardPresentation.Row)
            case pacemaker(AmbassadorPacemaker)
        }
        let position: Int
        let source: Source
        let nextTargetGap: Int?
        var id: String {
            switch source {
            case .member(let member): "member-" + member.profileID.uuidString
            case .pacemaker(let target): "target-" + target.id
            }
        }
        var points: Int {
            switch source { case .member(let member): member.points; case .pacemaker(let target): target.target }
        }
    }
    let rows: [Row]
    init(members: AmbassadorBoardPresentation, period: AmbassadorPeriod) {
        let targets = AmbassadorPacemaker.targets(for: period)
        let sources = members.rows.map(Row.Source.member) + targets.map(Row.Source.pacemaker)
        let sorted = sources.enumerated().sorted { lhs, rhs in
            func points(_ source: Row.Source) -> Int {
                switch source { case .member(let member): member.points; case .pacemaker(let target): target.target }
            }
            let left = points(lhs.element), right = points(rhs.element)
            // Preserve official ordering between tied members, and put a member
            // who reaches a target immediately ahead of that target.
            return left == right ? lhs.offset < rhs.offset : left > right
        }
        rows = sorted.enumerated().map { index, entry in
            let gap: Int?
            if case .member(let member) = entry.element {
                gap = targets.first(where: { $0.target > member.points }).map { $0.target - member.points }
            } else { gap = nil }
            return Row(position: index + 1, source: entry.element, nextTargetGap: gap)
        }
    }
}

enum AmbassadorRacer {
    private static let animals: [(String, String)] = [
        ("Bumblebee", "🐝"), ("Hedgehog", "🦔"), ("Bluebird", "🐦"), ("Squirrel", "🐿️"),
        ("Badger", "🦡"), ("Puffin", "🐧"), ("Robin", "🐦"), ("Panda", "🐼"),
        ("Otter", "🦦"), ("Fox", "🦊"), ("Owl", "🦉"), ("Bee", "🐝")
    ]
    static func emoji(for handle: String) -> String {
        let name = String(handle.dropLast(4))
        return animals.first { name.hasSuffix($0.0) }?.1 ?? "🏎️"
    }
}

/// Only aggregate counts cross the JavaScript bridge. These local laps are
/// independent of server-awarded points and are never sent to the leaderboard.
struct AmbassadorScanActivity: Decodable {
    struct Counts: Decodable {
        let captured, ready, pending, needsInput, failed, products, photos, readyProducts: Int
        var valid: Bool {
            let values = [captured, ready, pending, needsInput, failed, products, photos, readyProducts]
            return values.allSatisfy { (0...1_000_000).contains($0) }
                && captured == ready + pending + needsInput + failed && captured == products + photos
                && readyProducts <= min(ready, products)
        }
        var waitingLabel: String {
            var labels: [String] = []
            if pending > 0 { labels.append("\(pending) analysing") }
            if needsInput > 0 { labels.append("\(needsInput) need details") }
            if failed > 0 { labels.append("\(failed) to retry") }
            return labels.joined(separator: " · ")
        }
    }
    let available: Bool
    let weekStartsAt: Int64
    let week, all: Counts
    func validated() throws -> Self {
        guard available, weekStartsAt > 0, week.valid, all.valid,
              week.captured <= all.captured, week.products <= all.products, week.photos <= all.photos else { throw AmbassadorError.invalidResponse }
        return self
    }
    init?(projection: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: projection),
              let value = try? JSONDecoder().decode(Self.self, from: data).validated() else { return nil }
        self = value
    }
}

struct AmbassadorBlocks: Decodable {
    struct Entry: Decodable, Identifiable {
        let profileID: UUID
        let handle: String?
        var id: UUID { profileID }
    }
    let entries: [Entry]
    func validated() throws -> Self {
        guard entries.count <= 200, Set(entries.map(\.profileID)).count == entries.count,
              entries.allSatisfy({ $0.handle.map(AmbassadorService.validHandle) ?? true }) else { throw AmbassadorError.invalidResponse }
        return self
    }
}

enum AmbassadorReportReason: String, CaseIterable, Identifiable {
    case points, conduct, other
    var id: String { rawValue }
    var title: String {
        switch self { case .points: "Points look wrong"; case .conduct: "Community conduct"; case .other: "Something else" }
    }
}

@MainActor final class AmbassadorHTTPTransport: AccountHTTPTransport {
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 30
        session = URLSession(configuration: config)
    }
    deinit { session.invalidateAndCancel() }
    func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse {
        let (data, response) = try await BoundedHTTPData.load(request, session: session, maximumBytes: maximumBytes)
        return AccountHTTPResponse(statusCode: response.statusCode, data: data)
    }
}

@MainActor struct AmbassadorService {
    nonisolated static let termsVersion = "ambassador-v1"
    let revision: () -> Int
    let authorize: () async throws -> AccountAuthorization?
    let transport: AccountHTTPTransport
    let invalidateAuthorization: () -> Void
    var localOwnerKey: () -> String? = { nil }

    static func live(manager supplied: NudgeAccountManager? = nil) -> Self {
        let manager = supplied ?? .shared
        return Self(revision: { manager.revision }, authorize: { try await manager.authorization() },
             transport: AmbassadorHTTPTransport(), invalidateAuthorization: { manager.requireSignIn() },
             localOwnerKey: { manager.publicStatus()["state"] as? String == "signedIn" ? manager.captureOwnerKey : nil })
    }
    nonisolated static func validHandle(_ value: String) -> Bool {
        value.range(of: #"^[A-Z][a-z]{1,19}[A-Z][a-z]{1,19}[1-9][0-9]{3}$"#, options: .regularExpression) != nil
    }
    func me() async throws -> AmbassadorEnvelope {
        try decode(AmbassadorEnvelope.self, await request("GET", path: "me")).validated()
    }
    func save(adjective: String, noun: String, visible: Bool, acceptedTerms: Bool, adultConfirmed: Bool) async throws -> AmbassadorEnvelope {
        guard acceptedTerms, adultConfirmed else { throw AmbassadorError.consentRequired }
        let body: [String: Any] = ["adjective": adjective, "noun": noun, "leaderboardVisible": visible,
            "termsVersion": Self.termsVersion, "acceptedTerms": true, "adultConfirmed": true]
        return try decode(AmbassadorEnvelope.self, await request("POST", path: "me", body: JSONSerialization.data(withJSONObject: body))).validated()
    }
    func leaderboard(_ period: AmbassadorPeriod) async throws -> AmbassadorLeaderboard {
        try decode(AmbassadorLeaderboard.self, await request("GET", path: "leaderboard", period: period)).validated(period: period)
    }
    func delete() async throws {
        struct Receipt: Decodable { let deleted: Bool }
        guard try decode(Receipt.self, await request("DELETE", path: "me")).deleted else { throw AmbassadorError.invalidResponse }
    }
    func blocks() async throws -> AmbassadorBlocks {
        try decode(AmbassadorBlocks.self, await request("GET", path: "blocks")).validated()
    }
    func block(_ profileID: UUID, hidden: Bool) async throws {
        struct Receipt: Decodable { let blocked: Bool }
        let body = try JSONSerialization.data(withJSONObject: ["profileID": profileID.uuidString.lowercased()])
        guard try decode(Receipt.self, await request(hidden ? "POST" : "DELETE", path: "block", body: body)).blocked == hidden else { throw AmbassadorError.invalidResponse }
    }
    func report(_ profileID: UUID, reason: AmbassadorReportReason) async throws {
        struct Receipt: Decodable { let reported: Bool }
        let body = try JSONSerialization.data(withJSONObject: ["profileID": profileID.uuidString.lowercased(), "reason": reason.rawValue])
        guard try decode(Receipt.self, await request("POST", path: "report", body: body)).reported else { throw AmbassadorError.invalidResponse }
    }
    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw AmbassadorError.invalidResponse }
    }
    private func request(_ method: String, path: String, period: AmbassadorPeriod? = nil, body: Data? = nil) async throws -> Data {
        let expectedRevision = revision()
        let auth: AccountAuthorization
        do {
            guard let selected = try await authorize() else { throw AmbassadorError.signIn }
            auth = selected
        } catch is CancellationError { throw CancellationError() }
        catch let error as AmbassadorError { throw error }
        catch AccountError.signInRequired { throw AmbassadorError.signIn }
        catch { throw AmbassadorError.unavailable }
        try Task.checkCancellation()
        guard expectedRevision == revision() else { throw AmbassadorError.accountChanged }
        // The destination comes from the validated account manager, never from a
        // stored profile, response body or private backend connection.
        guard auth.backendURL.scheme == "https", auth.backendURL.host != nil,
              auth.backendURL.user == nil, auth.backendURL.password == nil,
              auth.backendURL.query == nil, auth.backendURL.fragment == nil else { throw AmbassadorError.invalidResponse }
        var url = URLComponents(url: auth.backendURL.appendingPathComponent("v1/ambassadors/" + path), resolvingAgainstBaseURL: false)!
        if let period { url.queryItems = [URLQueryItem(name: "period", value: period.rawValue)] }
        var request = URLRequest(url: url.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method; request.httpBody = body
        request.setValue("Bearer " + auth.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let response: AccountHTTPResponse
        do { response = try await transport.send(request, maximumBytes: 32_768) }
        catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw AmbassadorError.unavailable
        }
        try Task.checkCancellation()
        guard expectedRevision == revision() else { throw AmbassadorError.accountChanged }
        guard response.data.count <= 32_768 else { throw AmbassadorError.invalidResponse }
        struct Failure: Decodable { let code: String }
        let code = (try? JSONDecoder().decode(Failure.self, from: response.data))?.code
        switch response.statusCode {
        case 200, 201: return response.data
        case 401: invalidateAuthorization(); throw AmbassadorError.signIn
        case 403: throw AmbassadorError.signIn
        case 400 where code == "ambassador_consent_required": throw AmbassadorError.consentRequired
        case 404: throw AmbassadorError.memberUnavailable
        case 409:
            switch code {
            case "ambassador_handle_unavailable": throw AmbassadorError.nameUnavailable
            case "ambassador_block_unavailable": throw AmbassadorError.hiddenUnavailable
            case "ambassador_request_expired": throw AmbassadorError.requestExpired
            default: throw AmbassadorError.invalidResponse
            }
        case 429: throw AmbassadorError.rateLimited
        default: throw AmbassadorError.unavailable
        }
    }
}

@MainActor final class AmbassadorModel: ObservableObject {
    @Published private(set) var identityRevision = UUID()
    @Published private(set) var envelope: AmbassadorEnvelope?
    @Published private(set) var board: AmbassadorLeaderboard?
    @Published private(set) var hidden: [AmbassadorBlocks.Entry] = []
    @Published private(set) var hiddenLoading = false
    @Published private(set) var moderationError: String?
    @Published private(set) var loading = false
    @Published private(set) var busy = false
    @Published private(set) var needsSignIn = false
    @Published private(set) var error: String?
    @Published private(set) var boardError: String?
    @Published private(set) var notice: String?
    @Published var adjective = ""
    @Published var noun = ""
    @Published var visible = false
    @Published var acceptedTerms = false
    @Published var adultConfirmed = false
    @Published private(set) var period = AmbassadorPeriod.week
    private let service: AmbassadorService
    private var generation = UUID()
    private var boardGeneration = UUID()
    private var hiddenGeneration = UUID()
    private var observer: AnyCancellable?
    private var loadedAccountRevision: Int?
    var profile: AmbassadorProfile? { envelope?.profile }
    var activityOwnerKey: String? {
        guard profile?.participationStatus == .active, !needsSignIn,
              loadedAccountRevision == service.revision() else { return nil }
        return service.localOwnerKey()
    }
    var canSave: Bool {
        guard let envelope else { return false }
        return envelope.adjectives.contains(adjective) && envelope.nouns.contains(noun)
            && (profile != nil || acceptedTerms && adultConfirmed) && !busy && !loading
    }

    init(service: AmbassadorService, observeAccountChanges: Bool = false) {
        self.service = service
        if observeAccountChanges {
            // Account mutations and this synchronous Combine sink both run on
            // the main actor; previous-user state is removed before returning.
            observer = NotificationCenter.default.publisher(for: NudgeAccountManager.accountStateChanged)
                .sink { [weak self] _ in self?.accountDidChange() }
        }
    }
    static func live() -> AmbassadorModel { AmbassadorModel(service: .live(), observeAccountChanges: true) }
    func accountDidChange() {
        generation = UUID(); boardGeneration = UUID(); hiddenGeneration = UUID(); identityRevision = UUID()
        loadedAccountRevision = nil
        envelope = nil; board = nil; hidden = []; hiddenLoading = false; moderationError = nil; adjective = ""; noun = ""
        visible = false; acceptedTerms = false; adultConfirmed = false
        error = nil; boardError = nil; notice = nil; needsSignIn = true; loading = false; busy = false
    }
    func load() async {
        guard !loading, !busy else { return }
        let ticket = generation, revision = service.revision()
        loading = true; error = nil; notice = nil; needsSignIn = false
        defer { if ticket == generation { loading = false } }
        do {
            let value = try await service.me()
            guard valid(ticket, revision) else { return }
            apply(value)
            await loadBoard()
        } catch { if valid(ticket, revision) { show(error) } }
    }
    func save() async {
        guard canSave else { return }
        let ticket = generation, revision = service.revision(), joining = profile == nil
        busy = true; error = nil; notice = nil
        defer { if ticket == generation { busy = false } }
        do {
            let value = try await service.save(adjective: adjective, noun: noun, visible: visible,
                acceptedTerms: profile != nil || acceptedTerms, adultConfirmed: profile != nil || adultConfirmed)
            guard valid(ticket, revision), value.profile != nil else {
                if valid(ticket, revision) { throw AmbassadorError.invalidResponse }; return
            }
            apply(value)
            notice = joining ? "You’re in! Let’s make the next scan more useful." : "Your ambassador settings are saved."
            await loadBoard()
        } catch { if valid(ticket, revision) { show(error) } }
    }
    func delete() async {
        guard profile != nil, !busy else { return }
        let ticket = generation, revision = service.revision()
        busy = true; error = nil; notice = nil
        defer { if ticket == generation { busy = false } }
        do {
            try await service.delete()
            guard valid(ticket, revision) else { return }
            // Clear immediately after the confirmed deletion even if reload is offline.
            if let old = envelope { envelope = AmbassadorEnvelope(profile: nil, termsVersion: old.termsVersion, adjectives: old.adjectives, nouns: old.nouns) }
            boardGeneration = UUID(); hiddenGeneration = UUID(); hiddenLoading = false
            board = nil; hidden = []; moderationError = nil; visible = false; acceptedTerms = false; adultConfirmed = false
            adjective = envelope?.adjectives.first ?? ""; noun = envelope?.nouns.first ?? ""
            notice = "Your ambassador profile and points have been removed. Your Nudge account and diary are unchanged."
            await loadBoard()
        } catch { if valid(ticket, revision) { show(error) } }
    }
    func selectPeriod(_ selected: AmbassadorPeriod) async {
        period = selected; board = nil
        await loadBoard()
    }
    func loadBoard() async {
        guard envelope != nil, !needsSignIn else { return }
        let ticket = generation, revision = service.revision(), selected = period, requestID = UUID()
        boardGeneration = requestID; boardError = nil
        do {
            let value = try await service.leaderboard(selected)
            guard valid(ticket, revision), boardGeneration == requestID, selected == period else { return }
            board = value
        } catch {
            guard valid(ticket, revision), boardGeneration == requestID else { return }
            board = nil
            if error as? AmbassadorError == .signIn { show(error) }
            else if !(error is CancellationError) { boardError = (error as? AmbassadorError)?.localizedDescription ?? AmbassadorError.unavailable.localizedDescription }
        }
    }
    func loadHidden() async {
        guard envelope != nil, !needsSignIn else { return }
        let ticket = generation, revision = service.revision(), requestID = UUID()
        hiddenGeneration = requestID; hiddenLoading = true; moderationError = nil
        defer { if ticket == generation, hiddenGeneration == requestID { hiddenLoading = false } }
        do {
            let result = try await service.blocks()
            guard valid(ticket, revision), hiddenGeneration == requestID else { return }
            hidden = result.entries
        } catch {
            guard valid(ticket, revision), hiddenGeneration == requestID, !(error is CancellationError) else { return }
            if error as? AmbassadorError == .signIn { show(error) }
            else { moderationError = (error as? AmbassadorError)?.localizedDescription ?? AmbassadorError.unavailable.localizedDescription }
        }
    }
    func setHidden(_ profileID: UUID, hidden: Bool) async {
        guard !busy else { return }
        let ticket = generation, revision = service.revision()
        hiddenGeneration = UUID(); hiddenLoading = false
        busy = true; error = nil; moderationError = nil; notice = nil
        defer { if ticket == generation { busy = false } }
        do {
            try await service.block(profileID, hidden: hidden)
            guard valid(ticket, revision) else { return }
            if hidden { board = nil }
            notice = hidden ? "That ambassador is hidden from your board." : "That ambassador can appear on your board again."
            await loadBoard(); await loadHidden()
        } catch {
            if valid(ticket, revision) {
                show(error)
                if !needsSignIn { moderationError = self.error }
            }
        }
    }
    func report(_ profileID: UUID, reason: AmbassadorReportReason) async {
        guard !busy else { return }
        let ticket = generation, revision = service.revision()
        busy = true; error = nil; notice = nil
        defer { if ticket == generation { busy = false } }
        do {
            try await service.report(profileID, reason: reason)
            guard valid(ticket, revision) else { return }
            notice = "Thanks for flagging that. Your report has been sent to Nudge for review."
        } catch { if valid(ticket, revision) { show(error) } }
    }
    private func valid(_ ticket: UUID, _ revision: Int) -> Bool {
        guard ticket == generation else { return false }
        guard revision == service.revision() else { accountDidChange(); return false }
        return true
    }
    private func apply(_ value: AmbassadorEnvelope) {
        loadedAccountRevision = service.revision()
        envelope = value; needsSignIn = false
        adjective = value.profile?.adjective ?? value.adjectives.first ?? ""
        noun = value.profile?.noun ?? value.nouns.first ?? ""
        visible = value.profile?.leaderboardVisible ?? false
        acceptedTerms = false; adultConfirmed = false
    }
    private func show(_ failure: Error) {
        if failure is CancellationError { return }
        if failure as? AmbassadorError == .signIn || failure as? AmbassadorError == .accountChanged {
            accountDidChange()
        }
        error = (failure as? AmbassadorError)?.localizedDescription ?? AmbassadorError.unavailable.localizedDescription
    }
}

@MainActor struct NativeAmbassadorView: View {
    @StateObject private var model: AmbassadorModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var deletePresented = false
    @State private var hiddenPresented = false
    private struct ReportTarget {
        let entry: AmbassadorLeaderboard.Entry
        let identity: UUID
    }
    @State private var reportTarget: ReportTarget?
    @State private var deleteIdentity: UUID?
    let signIn: () -> Void
    let automaticallyLoad: Bool
    private let store: NativeAppStore?
    init(model: AmbassadorModel? = nil, store: NativeAppStore? = nil, automaticallyLoad: Bool = true, signIn: @escaping () -> Void) {
        _model = StateObject(wrappedValue: model ?? .live()); self.signIn = signIn; self.automaticallyLoad = automaticallyLoad
        self.store = store
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    hero
                    if let notice = model.notice { Text(notice).foregroundStyle(Color(uiColor: NudgeTheme.plantText)).accessibilityIdentifier("ambassador-notice") }
                    if let error = model.error { Text(error).foregroundStyle(Color(uiColor: NudgeTheme.errorText)).accessibilityIdentifier("ambassador-error") }
                    if model.loading && model.envelope == nil { ProgressView("Opening the club…") }
                    if model.needsSignIn {
                        card {
                            Text("Your Nudge account is your ticket in.").font(.title3.bold())
                            Text("Joining is optional. Your diary stays on your phone.")
                            Button("Sign in to Nudge", action: signIn).buttonStyle(NudgeButtonStyle()).accessibilityIdentifier("ambassador-sign-in")
                        }
                    } else if let envelope = model.envelope {
                        if model.profile == nil {
                            Text("Pick a playful name. Help with a label. Make someone’s next scan better.").font(.title3.weight(.semibold))
                            choices(envelope)
                        }
                        leaderboard
                        if let profile = model.profile {
                            if let store, let ownerKey = model.activityOwnerKey {
                                card { AmbassadorScanLaps(store: store, ownerKey: ownerKey, joinedAt: profile.joinedAt) }
                            }
                            DisclosureGroup("Your points & badge") { progress(profile).padding(.top, 16) }.font(.headline)
                            DisclosureGroup("Your name & privacy") { choices(envelope).padding(.top, 16) }.font(.headline)
                        }
                        rules
                        if model.profile != nil {
                            Button("Leave the ambassadors", role: .destructive) { deleteIdentity = model.identityRevision; deletePresented = true }
                                .buttonStyle(NudgeButtonStyle(variant: .destructive)).disabled(model.busy)
                                .accessibilityIdentifier("ambassador-leave")
                        }
                    } else if !model.loading {
                        Button("Try again") { Task { await model.load() } }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        Link("Privacy & your data", destination: URL(string: "https://configure-nudge-website.invalid/privacy.html")!)
                        Link("Need a hand?", destination: URL(string: "https://configure-nudge-website.invalid/support.html")!)
                    }.font(.subheadline).padding(.vertical, 8)
                }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: NudgeTheme.canvas)).foregroundStyle(Color(uiColor: NudgeTheme.ink))
            .navigationTitle("Nudge ambassadors").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await model.load() }
            .task { if automaticallyLoad { await model.load() } }
            .onChange(of: scenePhase) { if $0 == .active && automaticallyLoad { Task { await model.load() } } }
            .onChange(of: model.identityRevision) { _ in
                deletePresented = false; deleteIdentity = nil; hiddenPresented = false; reportTarget = nil
            }
            .sheet(isPresented: $hiddenPresented) { hiddenAmbassadors }
            .confirmationDialog("Report this ambassador?", isPresented: Binding(get: { reportTarget != nil }, set: { if !$0 { reportTarget = nil } }), titleVisibility: .visible) {
                ForEach(AmbassadorReportReason.allCases) { reason in
                    Button(reason.title) {
                        guard let target = reportTarget else { return }
                        reportTarget = nil
                        Task { if target.identity == model.identityRevision { await model.report(target.entry.profileID, reason: reason) } }
                    }
                }
            } message: { Text("Choose a reason. Nudge receives your account, the ambassador’s profile and the reason so the report can be reviewed. Your identity is not shown to the ambassador.") }
            .confirmationDialog("Leave the ambassadors?", isPresented: $deletePresented, titleVisibility: .visible) {
                Button("Remove my profile & points", role: .destructive) {
                    let identity = deleteIdentity
                    Task { if identity == model.identityRevision { await model.delete() } }
                }
            } message: {
                Text("Your ambassador name, leaderboard entry and points will be permanently removed. Your Nudge account, diary and independently published product facts stay. Rejoining starts at zero. An existing community restriction may remain for up to 30 days and a minimal report-limit record for up to 48 hours.")
            }
        }.tint(Color(uiColor: NudgeTheme.accent)).accessibilityIdentifier("native-ambassadors")
    }
    private var hero: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("🏆 The Nudge league").font(.title.bold()).fixedSize(horizontal: false, vertical: true)
            Text("Little scans. A team-sized difference.").font(.subheadline)
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func progress(_ profile: AmbassadorProfile) -> some View {
        card {
            HStack(spacing: 10) {
                Text(AmbassadorRacer.emoji(for: profile.handle)).font(.largeTitle).accessibilityHidden(true)
                Label(profile.badge.title, systemImage: profile.badge.symbol).font(.headline).foregroundStyle(Color(uiColor: NudgeTheme.plantText))
            }
            Text(profile.handle).font(.title2.bold()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("ambassador-handle")
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 32) { points(profile.weekPoints, title: "this week"); points(profile.allTimePoints, title: "all time") }
                VStack(alignment: .leading, spacing: 16) { points(profile.weekPoints, title: "this week"); points(profile.allTimePoints, title: "all time") }
            }
            if profile.participationStatus == .paused {
                Text("Your ambassador participation is paused for review. Your profile is off the board and new points are paused. Use “Need a hand?” below for support.")
                    .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.warningText)).accessibilityIdentifier("ambassador-paused")
            }
            Text(profile.leaderboardVisible ? "Reviewed contributions move you up the shared standings." : "Your row is just for you. Switch on sharing in name & privacy to join the shared standings.")
                .font(.subheadline).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            if profile.allTimePoints == 0 { Text("Get your first point: open a scanned product, tap ⋯ → Suggest a correction, and share clear pack photos. Points arrive after useful facts pass review.").font(.subheadline) }
        }
    }
    private func points(_ count: Int, title: String) -> some View {
        VStack(alignment: .leading, spacing: 3) { Text("\(count)").font(.title.bold()).monospacedDigit(); Text("reviewed points · " + title).font(.subheadline) }
            .accessibilityElement(children: .ignore).accessibilityLabel("\(count) points \(title)")
    }
    private func choices(_ envelope: AmbassadorEnvelope) -> some View {
        card {
            Text(model.profile == nil ? "Your ambassador name" : "Make it yours").font(.title3.bold())
            Text("A friendly nickname keeps your real name off the board. We add four digits to make it unique.").font(.subheadline)
            Picker("First word", selection: $model.adjective) { ForEach(envelope.adjectives, id: \.self) { Text($0).tag($0) } }
                .pickerStyle(.menu).accessibilityIdentifier("ambassador-adjective")
            Picker("Animal", selection: $model.noun) { ForEach(envelope.nouns, id: \.self) { Text($0).tag($0) } }
                .pickerStyle(.menu).accessibilityIdentifier("ambassador-noun")
            Toggle("Show me on the leaderboard", isOn: $model.visible).accessibilityIdentifier("ambassador-visibility")
            Text("Other signed-in members will see your ambassador name, points and badge. Your diary and pack photos stay private. You can hide your profile at any time.").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            if model.profile == nil {
                terms
                Toggle("I agree to these contribution terms", isOn: $model.acceptedTerms).accessibilityIdentifier("ambassador-consent")
                Toggle("I’m 18 or older", isOn: $model.adultConfirmed).accessibilityIdentifier("ambassador-adult")
            }
            Button(model.busy ? "Saving…" : model.profile == nil ? "Join the ambassadors" : "Save name & privacy") { Task { await model.save() } }
                .buttonStyle(NudgeButtonStyle()).disabled(!model.canSave).accessibilityIdentifier("ambassador-save")
        }.disabled(model.busy)
    }
    private var terms: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("A few friendly ground rules").font(.headline)
            Text("Only share pack photos you took or have permission to use. Keep people, receipts and personal details out of the frame.")
            Text("You keep your rights. You allow Nudge to send your selected photos to OpenAI to read product information and to review them privately. Nudge keeps its photo copies for up to 30 days and may publish approved product facts. Approved facts may stay in the catalogue after you leave.")
            Text("Joining doesn’t upload anything. Each contribution asks for your permission. No diary details, food intake or health information appear on the board.")
        }.font(.subheadline).fixedSize(horizontal: false, vertical: true)
    }
    private var rules: some View {
        DisclosureGroup("How scan laps & points work") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Scan laps show your unique saved scans on this phone after joining. Repeated barcodes and retries of the same photos count once. They stay private and aren’t points.")
                Text("Earn one shared point per product when a contribution you send adds useful, reviewed catalogue information. Repeat submissions, unchanged facts and rejected submissions don’t earn points.")
                Text("Join before sending a contribution. Correcting your private food or diary doesn’t submit it: use Suggest a correction to share pack facts for review.")
                Text("5 points: Helper · 25: Champion · 100: Trailblazer").font(.caption)
            }.font(.subheadline).padding(.top, 12)
        }.font(.headline)
    }
    private var leaderboard: some View {
        let presentation = AmbassadorBoardPresentation(profile: model.profile, board: model.board, period: model.period)
        let league = AmbassadorLeaguePresentation(members: presentation, period: model.period)
        let identity = model.identityRevision
        return VStack(alignment: .leading, spacing: 12) {
            if dynamicTypeSize.isAccessibilitySize { periodPicker.pickerStyle(.menu) }
            else { periodPicker.pickerStyle(.segmented) }
            if presentation.needsJoin {
                Text("Join above to add your own row. Sharing your profile is optional.")
                    .font(.subheadline).accessibilityIdentifier("ambassador-join-for-row")
            }
            if let message = model.boardError {
                Text(message).font(.subheadline)
                Button("Refresh the board") { Task { await model.loadBoard() } }.buttonStyle(NudgeButtonStyle(variant: .secondary))
            } else if let board = model.board {
                if board.entries.isEmpty {
                    Text("No shared points \(model.period == .week ? "this week" : "yet"). Race the Nudge targets while the team gets going.")
                        .font(.subheadline).accessibilityIdentifier("ambassador-empty-board")
                }
            } else { ProgressView("Loading the league…") }
            NativeAmbassadorLeagueTable(presentation: league, busy: model.busy, onHide: { profileID in
                Task { if identity == model.identityRevision { await model.setHidden(profileID, hidden: true) } }
            }, onReport: { profileID in
                guard identity == model.identityRevision,
                      let entry = model.board?.entries.first(where: { $0.profileID == profileID }) else { return }
                reportTarget = ReportTarget(entry: entry, identity: identity)
            })
            Text("PTS = reviewed points. NEXT = points to the next pacemaker. Pacemakers are Nudge targets, not players.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Text("Positions include the displayed members and targets. Official shared ranks appear beside members’ badges. Top 50 shared profiles, plus your own row.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Text(model.period == .week ? "Weekly points and targets restart Monday at 00:00 UTC." : "All-time points keep growing. Pacemakers follow the 5, 25 and 100 point milestones.")
                .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Button("Hidden ambassadors") { hiddenPresented = true }.font(.subheadline).frame(minHeight: 44).accessibilityIdentifier("ambassador-hidden-list")
        }
    }
    private var periodPicker: some View {
        Picker("Leaderboard period", selection: Binding(get: { model.period }, set: { value in Task { await model.selectPeriod(value) } })) {
            ForEach(AmbassadorPeriod.allCases) { Text($0.title).tag($0) }
        }.accessibilityIdentifier("ambassador-period")
    }
    private var hiddenAmbassadors: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Hiding someone only changes your board. You can let them appear again here.")
                    if model.hiddenLoading { ProgressView("Loading hidden ambassadors…") }
                    if let error = model.moderationError { Text(error).foregroundStyle(Color(uiColor: NudgeTheme.errorText)) }
                    if model.hidden.isEmpty && !model.hiddenLoading { Text("No hidden ambassadors.").font(.headline) }
                    ForEach(model.hidden) { entry in
                        let identity = model.identityRevision
                        VStack(alignment: .leading, spacing: 8) {
                            Text(entry.handle ?? "Hidden ambassador").font(.headline).fixedSize(horizontal: false, vertical: true)
                            Button("Show on my board") { Task { if identity == model.identityRevision { await model.setHidden(entry.profileID, hidden: false) } } }
                                .buttonStyle(NudgeButtonStyle(variant: .secondary)).disabled(model.busy)
                        }
                    }
                    Button("Refresh") { Task { await model.loadHidden() } }.buttonStyle(NudgeButtonStyle(variant: .secondary))
                }.padding(20)
            }.background(Color(uiColor: NudgeTheme.canvas))
                .navigationTitle("Hidden ambassadors").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { hiddenPresented = false } } }
                .task { if automaticallyLoad { await model.loadHidden() } }
        }
    }
    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 16, content: content)
            .frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Color(uiColor: NudgeTheme.surface), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color(uiColor: NudgeTheme.border)))
    }
}

/// A single table keeps the same column boundaries for every member and target.
/// At accessibility sizes its columns scroll together instead of becoming cards.
@MainActor struct NativeAmbassadorLeagueTable: View {
    let presentation: AmbassadorLeaguePresentation
    var busy = false
    var onHide: (UUID) -> Void = { _ in }
    var onReport: (UUID) -> Void = { _ in }
    @ScaledMetric(relativeTo: .caption) private var positionWidth: CGFloat = 30
    @ScaledMetric(relativeTo: .caption) private var pointsWidth: CGFloat = 48
    @ScaledMetric(relativeTo: .caption) private var nextWidth: CGFloat = 48
    @ScaledMetric(relativeTo: .caption) private var nameMinimumWidth: CGFloat = 130
    @State private var viewportWidth: CGFloat = 0
    private var minimumWidth: CGFloat { positionWidth + pointsWidth + nextWidth + nameMinimumWidth + 16 }
    private var tableWidth: CGFloat { max(viewportWidth, minimumWidth) }

    var body: some View {
        ScrollView(.horizontal) {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Text("POS").frame(width: positionWidth, alignment: .center).ambassadorTableControl("league-heading-position")
                    Text("AMBASSADOR").frame(maxWidth: .infinity, alignment: .leading).ambassadorTableControl("league-heading-name")
                    Text("PTS").frame(width: pointsWidth, alignment: .trailing).ambassadorTableControl("league-heading-points")
                    Text("NEXT").frame(width: nextWidth, alignment: .trailing).ambassadorTableControl("league-heading-next")
                }
                .font(.caption2.bold()).padding(.horizontal, 8).padding(.vertical, 12)
                .foregroundStyle(Color(uiColor: NudgeTheme.primaryText))
                .background(Color(uiColor: NudgeTheme.primaryFill))
                .accessibilityElement(children: .combine).accessibilityLabel("Position, ambassador, reviewed points, points to next target")
                ForEach(presentation.rows) { row in
                    tableRow(row)
                    if row.id != presentation.rows.last?.id { Divider() }
                }
            }.frame(width: tableWidth)
        }
        .background {
            GeometryReader { geometry in
                Color.clear.preference(key: AmbassadorTableWidthKey.self, value: geometry.size.width)
            }.allowsHitTesting(false).accessibilityHidden(true)
        }
        .onPreferenceChange(AmbassadorTableWidthKey.self) { width in
            if abs(viewportWidth - width) > 0.5 { viewportWidth = width }
        }
        .background(Color(uiColor: NudgeTheme.surface))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: NudgeTheme.border)))
        .accessibilityIdentifier("ambassador-league-table")
    }
    private func tableRow(_ row: AmbassadorLeaguePresentation.Row) -> some View {
        HStack(alignment: .center, spacing: 0) {
            Text("\(row.position)").font(.subheadline.bold()).monospacedDigit()
                .frame(width: positionWidth, alignment: .center)
                .accessibilityLabel("Table position \(row.position)")
                .ambassadorTableControl("league-\(row.id)-position")
            nameCell(row).frame(maxWidth: .infinity, alignment: .leading)
                .ambassadorTableControl("league-\(row.id)-name")
            Text("\(row.points)").font(.subheadline.bold()).monospacedDigit()
                .frame(width: pointsWidth, alignment: .trailing)
                .accessibilityLabel(pointsLabel(row))
                .ambassadorTableControl("league-\(row.id)-points")
            Text(nextLabel(row)).font(.subheadline.weight(.semibold)).monospacedDigit()
                .frame(width: nextWidth, alignment: .trailing)
                .accessibilityLabel(nextAccessibilityLabel(row))
                .ambassadorTableControl("league-\(row.id)-next")
        }
        .padding(.horizontal, 8).padding(.vertical, 12).frame(minHeight: 64)
        .background(rowColor(row))
        .accessibilityElement(children: .contain)
        .ambassadorTableControl(rowIdentifier(row))
    }
    @ViewBuilder private func nameCell(_ row: AmbassadorLeaguePresentation.Row) -> some View {
        switch row.source {
        case .member(let member):
            if member.isSelf { memberName(member) }
            else {
                Menu {
                    Button("Hide this ambassador", systemImage: "eye.slash") { onHide(member.profileID) }
                    Button("Report a concern", systemImage: "flag") { onReport(member.profileID) }
                } label: { memberName(member) }
                    .buttonStyle(.plain).disabled(busy)
                    .accessibilityIdentifier("ambassador-row-options")
                    .accessibilityLabel("Options for " + member.handle)
                    .accessibilityHint("Hide this ambassador or report a concern")
            }
        case .pacemaker(let target):
            VStack(alignment: .leading, spacing: 4) {
                Text(targetEmoji(target) + " " + target.title).font(.caption.bold())
                Text("PACEMAKER · TARGET").font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(uiColor: NudgeTheme.muted))
            }.fixedSize(horizontal: false, vertical: true).padding(.leading, 4)
        }
    }
    private func memberName(_ member: AmbassadorBoardPresentation.Row) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text((member.isSelf ? "YOU · " : "") + AmbassadorRacer.emoji(for: member.handle) + " " + member.handle + (member.isSelf ? "" : " ⋯"))
                .font(.caption.bold()).foregroundStyle(Color(uiColor: member.isSelf ? NudgeTheme.accent : NudgeTheme.ink))
            Text(memberSubtitle(member)).font(.caption2)
                .foregroundStyle(Color(uiColor: NudgeTheme.muted))
        }.fixedSize(horizontal: false, vertical: true).frame(minHeight: 44, alignment: .leading).padding(.leading, 4)
    }
    private func memberSubtitle(_ member: AmbassadorBoardPresentation.Row) -> String {
        if let rank = member.rank { return "Shared rank \(rank) · " + member.badge.title }
        if member.status?.contains("paused") == true { return "Paused · only you" }
        if member.status?.contains("Private") == true { return "Private · only you" }
        return member.points == 0 ? "Awaiting first reviewed point" : "Shared rank unavailable · " + member.badge.title
    }
    private func targetEmoji(_ target: AmbassadorPacemaker) -> String {
        let index = AmbassadorPacemaker.targets(for: target.period).firstIndex(where: { $0.id == target.id }) ?? 0
        return ["🐢", "🛴", "🚀"][index]
    }
    private func nextLabel(_ row: AmbassadorLeaguePresentation.Row) -> String {
        switch row.source { case .pacemaker: "—"; case .member: row.nextTargetGap.map(String.init) ?? "✓" }
    }
    private func nextAccessibilityLabel(_ row: AmbassadorLeaguePresentation.Row) -> String {
        switch row.source {
        case .pacemaker: "Nudge target, not a player"
        case .member: row.nextTargetGap.map { "\($0) reviewed points to the next pacemaker" } ?? "All pacemaker targets reached"
        }
    }
    private func pointsLabel(_ row: AmbassadorLeaguePresentation.Row) -> String {
        switch row.source { case .member: "\(row.points) reviewed points"; case .pacemaker: "Target: \(row.points) reviewed points" }
    }
    private func rowColor(_ row: AmbassadorLeaguePresentation.Row) -> Color {
        if case .member(let member) = row.source, member.isSelf { return Color(uiColor: NudgeTheme.selectedSurface) }
        return Color(uiColor: row.position.isMultiple(of: 2) ? NudgeTheme.surface : NudgeTheme.canvas)
    }
    private func rowIdentifier(_ row: AmbassadorLeaguePresentation.Row) -> String {
        switch row.source {
        case .member(let member): member.isSelf ? "ambassador-self-row" : "ambassador-member-row-" + member.profileID.uuidString
        case .pacemaker(let target): "ambassador-pacemaker-" + target.id
        }
    }
}
private struct AmbassadorTableWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
private extension View {
    @ViewBuilder func ambassadorTableControl(_ identifier: String) -> some View {
        #if DEBUG
        accessibilityIdentifier(identifier).background {
            GeometryReader { geometry in
                Color.clear.preference(key: NativeAmbassadorTableGeometryKey.self, value: [identifier: geometry.frame(in: .global)])
            }.allowsHitTesting(false).accessibilityHidden(true)
        }
        #else
        accessibilityIdentifier(identifier)
        #endif
    }
}
#if DEBUG
struct NativeAmbassadorTableGeometryKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}
#endif

/// Observes only the local store; analysis completion can update these small
/// counts without reloading the remote board or exposing private History rows.
@MainActor private struct AmbassadorScanLaps: View {
    @ObservedObject var store: NativeAppStore
    let ownerKey: String
    let joinedAt: Int64
    var body: some View {
        let activity = AmbassadorScanActivity(projection: store.project("ambassadorActivity", ["ownerKey": ownerKey, "joinedAt": joinedAt]))
        VStack(alignment: .leading, spacing: 14) {
            Text("🏎️ Your scan laps").font(.title2.bold())
            Text("Private · on this phone · since joining").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            if let activity {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 28) { tally(activity.week, title: "this week"); tally(activity.all, title: "since joining") }
                    VStack(alignment: .leading, spacing: 16) { tally(activity.week, title: "this week"); tally(activity.all, title: "since joining") }
                }
                if !activity.week.waitingLabel.isEmpty {
                    Text(activity.week.waitingLabel + " · open History for details").font(.subheadline)
                        .foregroundStyle(Color(uiColor: NudgeTheme.muted))
                }
                Divider()
                HStack(alignment: .firstTextBaseline) {
                    Text("Weekly product lap").font(.headline)
                    Spacer(minLength: 4)
                    Text("🏁").accessibilityHidden(true)
                }
                Text("\(activity.week.readyProducts) / 20 different products ready").font(.subheadline.bold()).monospacedDigit()
                ProgressView(value: Double(min(activity.week.readyProducts, 20)), total: 20)
                    .accessibilityLabel("Weekly target: \(activity.week.readyProducts) of 20 different products analysed")
                Text(activity.week.readyProducts >= 20 ? "Finish line reached! Your next useful product detail could help the whole team." : "\(20 - activity.week.readyProducts) more ready products to reach the team scan target.")
                    .font(.subheadline)
                Text("Repeated barcodes count once per week. Photo retries count once per set of photos. Scan laps are private progress; shared points come from reviewed contributions.")
                    .font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            } else {
                Text("Your scan laps couldn’t be read yet. Your saved History is unchanged.").font(.subheadline)
            }
        }.accessibilityIdentifier("ambassador-scan-laps")
    }
    private func tally(_ counts: AmbassadorScanActivity.Counts, title: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(counts.captured)").font(.largeTitle.bold()).monospacedDigit()
            Text("unique scans · " + title).font(.subheadline)
            Text("\(counts.products) products · \(counts.photos) photo scans").font(.caption).foregroundStyle(Color(uiColor: NudgeTheme.muted))
            Text("\(counts.ready) ready").font(.subheadline.bold()).foregroundStyle(Color(uiColor: NudgeTheme.plantText))
        }.accessibilityElement(children: .combine)
    }
}
