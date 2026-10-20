import Combine
import XCTest
import SwiftUI
import UIKit
@testable import Nudge

/// Every fixture supplies memory authorization and a fake transport. No Keychain,
/// NudgeDataStore, real account, real backend or synthetic owner data is touched.
@MainActor final class NativeAmbassadorTests: XCTestCase {
    private let ownerID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    private let otherID = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    private final class Transport: AccountHTTPTransport {
        var requests: [URLRequest] = []
        var limits: [Int] = []
        var handler: (URLRequest) async throws -> AccountHTTPResponse
        init(_ handler: @escaping (URLRequest) async throws -> AccountHTTPResponse) { self.handler = handler }
        func send(_ request: URLRequest, maximumBytes: Int) async throws -> AccountHTTPResponse {
            requests.append(request); limits.append(maximumBytes)
            return try await handler(request)
        }
    }
    private final class MemoryAccount: AccountSessionStore {
        var value: AccountSession?
        init(_ value: AccountSession? = nil) { self.value = value }
        func load() throws -> AccountSession? { value }
        func save(_ session: AccountSession) throws { value = session }
        func clear() throws { value = nil }
    }
    private func response(_ object: [String: Any], status: Int = 200) throws -> AccountHTTPResponse {
        AccountHTTPResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: object))
    }
    private func profile(visible: Bool = false, paused: Bool = false) -> [String: Any] {
        ["profileID": ownerID.uuidString, "participationStatus": paused ? "paused" : "active", "handle": "BrightOtter1234", "adjective": "Bright", "noun": "Otter",
         "leaderboardVisible": visible, "joinedAt": 1_800_000_000_000, "allTimePoints": 8, "weekPoints": 3, "badge": "helper"]
    }
    private func me(_ profile: [String: Any]? = nil) -> [String: Any] {
        ["profile": profile as Any? ?? NSNull(), "termsVersion": "ambassador-v1", "adjectives": ["Bright", "Thoughtful"], "nouns": ["Otter", "Bumblebee"]]
    }
    private func board(_ period: String = "week", empty: Bool = false) -> [String: Any] {
        let entries: [[String: Any]] = empty ? [] : [
            ["profileID": otherID.uuidString, "rank": 1, "handle": "ThoughtfulBumblebee9999", "points": 12, "badge": "helper"],
            ["profileID": ownerID.uuidString, "rank": 2, "handle": "BrightOtter1234", "points": 3, "badge": "helper"]
        ]
        return ["period": period, "weekStartsAt": 1_800_000_000_000, "entries": entries, "myRank": empty ? NSNull() : 2]
    }
    private func service(_ transport: Transport, revision: @escaping () -> Int = { 0 }, signedIn: Bool = true,
                         invalidated: @escaping () -> Void = {}) -> AmbassadorService {
        AmbassadorService(revision: revision, authorize: { signedIn ? AccountAuthorization(backendURL: URL(string: "https://ambassador.example.test")!, token: "fixture.account.signature") : nil },
                          transport: transport, invalidateAuthorization: invalidated)
    }
    private func fixture(joined: Bool = false, visible: Bool = false, paused: Bool = false, empty: Bool = false) -> (AmbassadorModel, Transport) {
        let transport = Transport { request in
            if request.url?.path.hasSuffix("/leaderboard") == true {
                let period = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "week"
                return try self.response(self.board(period, empty: empty))
            }
            return try self.response(self.me(joined ? self.profile(visible: visible, paused: paused) : nil))
        }
        return (AmbassadorModel(service: service(transport)), transport)
    }
    func testJoiningIsPrivateUntickedAndCannotSendWithoutBothConsents() async throws {
        let (model, network) = fixture()
        await model.load()
        XCTAssertNil(model.profile); XCTAssertFalse(model.visible)
        XCTAssertFalse(model.acceptedTerms); XCTAssertFalse(model.adultConfirmed); XCTAssertFalse(model.canSave)
        await model.save()
        XCTAssertEqual(network.requests.map(\.httpMethod), ["GET", "GET"])
        model.acceptedTerms = true
        XCTAssertFalse(model.canSave)
        model.adultConfirmed = true
        XCTAssertTrue(model.canSave)
        model.adjective = "Free text is not a username"
        XCTAssertFalse(model.canSave)
    }
    func testNoManagedAccountSendsNoRequestAndShowsSignIn() async throws {
        let network = Transport { _ in XCTFail("No private-owner fallback or API request"); return try self.response([:]) }
        let model = AmbassadorModel(service: service(network, signedIn: false))
        await model.load()
        XCTAssertTrue(model.needsSignIn); XCTAssertNil(model.envelope); XCTAssertTrue(network.requests.isEmpty)
    }
    func testSaveSendsOnlyExplicitChoicesAndConsentAndKeepsPrivateDefault() async throws {
        let network = Transport { request in
            if request.url?.path.hasSuffix("/leaderboard") == true { return try self.response(self.board(empty: true)) }
            return try self.response(self.me(request.httpMethod == "POST" ? self.profile() : nil))
        }
        let model = AmbassadorModel(service: service(network))
        await model.load(); model.acceptedTerms = true; model.adultConfirmed = true
        await model.save()
        let post = try XCTUnwrap(network.requests.first { $0.httpMethod == "POST" })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(post.httpBody)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["adjective", "noun", "leaderboardVisible", "termsVersion", "acceptedTerms", "adultConfirmed"])
        XCTAssertEqual(body["leaderboardVisible"] as? Bool, false)
        XCTAssertEqual(body["acceptedTerms"] as? Bool, true); XCTAssertEqual(body["adultConfirmed"] as? Bool, true)
        XCTAssertEqual(post.value(forHTTPHeaderField: "Authorization"), "Bearer fixture.account.signature")
        XCTAssertEqual(post.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(Set(network.limits), [32_768])
        XCTAssertEqual(model.profile?.handle, "BrightOtter1234")
        XCTAssertFalse(model.acceptedTerms); XCTAssertFalse(model.adultConfirmed)
    }
    func testVisibilityChangeIsNotSentUntilSave() async throws {
        let (model, network) = fixture(joined: true)
        await model.load(); let count = network.requests.count
        model.visible = true
        XCTAssertEqual(network.requests.count, count)
        XCTAssertEqual(model.profile?.leaderboardVisible, false)
        XCTAssertTrue(model.canSave)
    }
    func testDecoderRejectsPrivateIdentityUnsafeHandleUnknownTermsAndBadPoints() async throws {
        var malformed = profile(); malformed["handle"] = "real.person@example.test"
        var invalidPoints = profile(); invalidPoints["weekPoints"] = 100
        var badUUID = profile(); badUUID["profileID"] = "account-owner-hash"
        let cases = [me(malformed), me(invalidPoints), me(badUUID), ["profile": NSNull(), "termsVersion": "ambassador-v2", "adjectives": ["Bright"], "nouns": ["Otter"]]]
        for object in cases {
            let network = Transport { _ in try self.response(object) }
            do { _ = try await service(network).me(); XCTFail("Invalid profile must never render") }
            catch { XCTAssertNotNil(error as? AmbassadorError) }
        }
    }
    func testBoardRejectsWrongPeriodDuplicateIdentityNegativePointsAndMoreThan50() async throws {
        var duplicate = board(); var rows = duplicate["entries"] as! [[String: Any]]
        rows[1]["profileID"] = otherID.uuidString; duplicate["entries"] = rows
        var negative = board(); rows = negative["entries"] as! [[String: Any]]; rows[0]["points"] = -1; negative["entries"] = rows
        var oversized = board(); oversized["entries"] = Array(repeating: rows[0], count: 51)
        for object in [board("all"), duplicate, negative, oversized] {
            let network = Transport { _ in try self.response(object) }
            do { _ = try await service(network).leaderboard(.week); XCTFail("Invalid board must never render") }
            catch { XCTAssertEqual(error as? AmbassadorError, .invalidResponse) }
        }
    }
    func testServiceRejectsAccountChangeDuringAuthorizationBeforeSending() async throws {
        var revision = 0
        let network = Transport { _ in XCTFail("Account changed before dispatch"); return try self.response([:]) }
        let client = AmbassadorService(revision: { revision }, authorize: {
            revision += 1
            return AccountAuthorization(backendURL: URL(string: "https://ambassador.example.test")!, token: "fixture")
        }, transport: network, invalidateAuthorization: {})
        do { _ = try await client.me(); XCTFail("Expected fence") }
        catch { XCTAssertEqual(error as? AmbassadorError, .accountChanged) }
        XCTAssertTrue(network.requests.isEmpty)
    }
    func testServiceRejectsAccountChangeDuringHTTPWithoutRenderingOldUser() async throws {
        var revision = 0
        let network = Transport { _ in revision += 1; return try self.response(self.me(self.profile())) }
        let model = AmbassadorModel(service: service(network, revision: { revision }))
        await model.load()
        XCTAssertNil(model.profile); XCTAssertNil(model.board); XCTAssertTrue(model.needsSignIn)
    }
    func testImmediateAccountNotificationClearsEveryIdentityAndConsent() async throws {
        let network = Transport { request in
            request.url?.path.hasSuffix("/leaderboard") == true ? try self.response(self.board()) : try self.response(self.me(self.profile()))
        }
        let model = AmbassadorModel(service: service(network), observeAccountChanges: true)
        await model.load(); XCTAssertNotNil(model.profile)
        model.acceptedTerms = true; model.adultConfirmed = true; model.visible = true
        let memory = MemoryAccount()
        let manager = NudgeAccountManager(store: memory, transport: network)
        let previousIdentity = model.identityRevision
        _ = try await manager.signOut()
        XCTAssertNotEqual(model.identityRevision, previousIdentity)
        XCTAssertNil(model.profile); XCTAssertNil(model.board); XCTAssertTrue(model.hidden.isEmpty)
        XCTAssertEqual(model.adjective, ""); XCTAssertEqual(model.noun, "")
        XCTAssertFalse(model.visible); XCTAssertFalse(model.acceptedTerms); XCTAssertFalse(model.adultConfirmed)
        XCTAssertTrue(model.needsSignIn)
    }
    func testRevokedSessionNotificationAlsoClearsImmediatelyWithoutRevisionChange() async throws {
        let (fixtureModel, network) = fixture(joined: true)
        _ = fixtureModel
        let model = AmbassadorModel(service: service(network), observeAccountChanges: true)
        await model.load()
        let memory = MemoryAccount(AccountSession(accessToken: "head.fixture.signature", refreshToken: "fixture_refresh_token", expiresAt: Date().addingTimeInterval(100), userID: ownerID.uuidString,
                                                 email: "fixture@example.test", providerURL: URL(string: "https://fixture.supabase.co")!))
        let manager = NudgeAccountManager(store: memory, transport: network)
        manager.requireSignIn()
        XCTAssertNil(model.profile); XCTAssertNil(model.board); XCTAssertTrue(model.needsSignIn)
        XCTAssertEqual(memory.value?.reauthenticationRequired, true)
    }
    func testLateInFlightResponseAfterNotificationCannotRepopulateProfile() async throws {
        var release: CheckedContinuation<AccountHTTPResponse, Error>?
        let network = Transport { _ in try await withCheckedThrowingContinuation { release = $0 } }
        let model = AmbassadorModel(service: service(network))
        let loading = Task { await model.load() }
        for _ in 0..<100 where release == nil { await Task.yield() }
        XCTAssertNotNil(release)
        model.accountDidChange()
        release?.resume(returning: try response(me(profile())))
        await loading.value
        XCTAssertNil(model.profile); XCTAssertNil(model.board); XCTAssertTrue(model.needsSignIn)
        XCTAssertFalse(model.loading)
    }
    func testBackendFailureIsSanitizedAndDoesNotMarkJoinSuccessful() async throws {
        let network = Transport { _ in try self.response(["message": "PRIVATE_SECRET email@example.test"], status: 503) }
        let model = AmbassadorModel(service: service(network))
        await model.load()
        XCTAssertEqual(model.error, AmbassadorError.unavailable.localizedDescription)
        XCTAssertFalse(model.error?.contains("PRIVATE_SECRET") ?? true)
        XCTAssertNil(model.profile)
    }
    func testUnauthorizedResponseInvalidatesAccountAndDoesNotExposeOldProfile() async throws {
        var invalidated = 0
        let network = Transport { _ in try self.response([:], status: 401) }
        let model = AmbassadorModel(service: service(network, invalidated: { invalidated += 1 }))
        await model.load()
        XCTAssertEqual(invalidated, 1); XCTAssertTrue(model.needsSignIn); XCTAssertNil(model.profile)
    }
    func testOversizedServiceResponseIsRejectedEvenByAnInjectedTransport() async throws {
        let network = Transport { _ in AccountHTTPResponse(statusCode: 200, data: Data(repeating: 32, count: 32_769)) }
        do { _ = try await service(network).me(); XCTFail("Must enforce bound") }
        catch { XCTAssertEqual(error as? AmbassadorError, .invalidResponse) }
    }
    func testDeletingProfileClearsPointsAndConsentEvenWhenBoardRefreshFails() async throws {
        var deleted = false
        let network = Transport { request in
            if request.httpMethod == "DELETE" { deleted = true; return try self.response(["deleted": true]) }
            if deleted { return try self.response([:], status: 503) }
            return request.url?.path.hasSuffix("/leaderboard") == true ? try self.response(self.board()) : try self.response(self.me(self.profile()))
        }
        let model = AmbassadorModel(service: service(network))
        await model.load(); await model.delete()
        XCTAssertNil(model.profile); XCTAssertNil(model.board); XCTAssertFalse(model.visible)
        XCTAssertFalse(model.acceptedTerms); XCTAssertFalse(model.adultConfirmed)
        XCTAssertTrue(model.notice?.contains("removed") == true)
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "DELETE" }.map { $0.url!.path }, ["/v1/ambassadors/me"])
    }
    func testFailedDeletionKeepsProfileUntilServerConfirms() async throws {
        let network = Transport { request in
            if request.httpMethod == "DELETE" { return try self.response(["deleted": false]) }
            return request.url?.path.hasSuffix("/leaderboard") == true ? try self.response(self.board()) : try self.response(self.me(self.profile()))
        }
        let model = AmbassadorModel(service: service(network))
        await model.load(); await model.delete()
        XCTAssertNotNil(model.profile); XCTAssertEqual(model.error, AmbassadorError.invalidResponse.localizedDescription)
    }
    func testReportAndBlockUseStablePublicIDWithoutFreeTextOrAccountIdentity() async throws {
        let network = Transport { request in
            if request.url?.path.hasSuffix("/report") == true { return try self.response(["reported": true]) }
            return try self.response(["blocked": request.httpMethod == "POST"])
        }
        let client = service(network)
        try await client.report(otherID, reason: .points)
        try await client.block(otherID, hidden: true)
        try await client.block(otherID, hidden: false)
        for request in network.requests {
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            XCTAssertEqual(body["profileID"] as? String, otherID.uuidString.lowercased())
            XCTAssertNil(body["handle"]); XCTAssertNil(body["email"]); XCTAssertNil(body["message"])
            XCTAssertEqual(Set(body.keys), request.url!.path.hasSuffix("/report") ? ["profileID", "reason"] : ["profileID"])
        }
        XCTAssertEqual(network.requests.map(\.httpMethod), ["POST", "POST", "DELETE"])
    }
    func testHiddenMemberMayOmitHandleWithoutLeakingPrivateIdentity() async throws {
        let network = Transport { _ in try self.response(["entries": [["profileID": self.otherID.uuidString, "handle": NSNull()]]]) }
        let result = try await service(network).blocks()
        XCTAssertEqual(result.entries.count, 1); XCTAssertNil(result.entries[0].handle)
    }
    func testPausedProfileDecodesAndNeverClaimsClientAwardedPoints() async throws {
        let (model, network) = fixture(joined: true, paused: true)
        await model.load()
        XCTAssertEqual(model.profile?.participationStatus, .paused)
        XCTAssertEqual(model.profile?.allTimePoints, 8)
        XCTAssertEqual(network.requests.map(\.httpMethod), ["GET", "GET"])
    }
    func testDeletingProfileFencesAnOlderHiddenListResponse() async throws {
        var release: CheckedContinuation<AccountHTTPResponse, Error>?
        let network = Transport { request in
            if request.url?.path.hasSuffix("/blocks") == true { return try await withCheckedThrowingContinuation { release = $0 } }
            if request.httpMethod == "DELETE" { return try self.response(["deleted": true]) }
            return request.url?.path.hasSuffix("/leaderboard") == true ? try self.response(self.board()) : try self.response(self.me(self.profile()))
        }
        let model = AmbassadorModel(service: service(network))
        await model.load()
        let hiddenTask = Task { await model.loadHidden() }
        for _ in 0..<100 where release == nil { await Task.yield() }
        XCTAssertNotNil(release)
        await model.delete()
        release?.resume(returning: try response(["entries": [["profileID": otherID.uuidString, "handle": "ThoughtfulBumblebee9999"]]]))
        await hiddenTask.value
        XCTAssertNil(model.profile); XCTAssertTrue(model.hidden.isEmpty); XCTAssertFalse(model.hiddenLoading)
    }
    func testNewPeriodFencesSlowerOldBoardResponse() async throws {
        var release: CheckedContinuation<AccountHTTPResponse, Error>?
        var holdWeek = false
        let network = Transport { request in
            if request.url?.path.hasSuffix("/leaderboard") == true {
                let period = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value ?? "week"
                if holdWeek && period == "week" { return try await withCheckedThrowingContinuation { release = $0 } }
                return try self.response(self.board(period))
            }
            return try self.response(self.me(self.profile()))
        }
        let model = AmbassadorModel(service: service(network))
        await model.load(); holdWeek = true
        let earlier = Task { await model.loadBoard() }
        for _ in 0..<100 where release == nil { await Task.yield() }
        XCTAssertNotNil(release)
        await model.selectPeriod(.all)
        release?.resume(returning: try response(board()))
        await earlier.value
        XCTAssertEqual(model.period, .all); XCTAssertEqual(model.board?.period, .all)
    }
    func testHiddenListConflictUsesLocalActionableMessage() async throws {
        let network = Transport { _ in try self.response(["code": "ambassador_block_unavailable", "message": "SECRET"], status: 409) }
        do { try await service(network).block(otherID, hidden: true); XCTFail("Expected full hidden-list failure") }
        catch { XCTAssertEqual(error as? AmbassadorError, .hiddenUnavailable); XCTAssertFalse(error.localizedDescription.contains("SECRET")) }
    }

    func testJoinAndProgressScreensFitCompactWidthAndAccessibilityText() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for joined in [false, true] {
            for large in [false, true] {
                let (model, network) = fixture(joined: joined, paused: joined, empty: !joined)
                await model.load()
                let count = network.requests.count
                let root = NativeAmbassadorView(model: model, automaticallyLoad: false, signIn: {})
                    .environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
                let host = UIHostingController(rootView: root), parent = UIViewController()
                parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
                let traits = UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large)
                parent.setOverrideTraitCollection(traits, forChild: host)
                window.rootViewController = parent; window.makeKeyAndVisible()
                parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844); host.view.frame = parent.view.bounds
                host.view.setNeedsLayout(); host.view.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(300))
                host.view.layoutIfNeeded()
                let scrolls = descendants(host.view).compactMap { $0 as? UIScrollView }.filter { !($0 is UITextView) }
                XCTAssertFalse(scrolls.isEmpty)
                // The page stays within the phone; the table deliberately pans
                // as a single set of columns at accessibility text sizes.
                let pageScrolls = scrolls.filter { scroll in
                    var ancestor = scroll.superview
                    while let view = ancestor {
                        if view is UIScrollView { return false }
                        ancestor = view.superview
                    }
                    return true
                }
                XCTAssertFalse(pageScrolls.isEmpty)
                for scroll in pageScrolls where scroll.bounds.width > 0 {
                    XCTAssertLessThanOrEqual(scroll.contentSize.width, scroll.bounds.width + 1, "The page must not overflow horizontally")
                }
                let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
                let attachment = XCTAttachment(image: image); attachment.name = "Ambassadors \(joined ? "progress" : "join") 320px \(large ? "AX5" : "regular")"; attachment.lifetime = .keepAlways; add(attachment)
                XCTAssertEqual(network.requests.count, count, "Rendering fixtures must never authorize, persist or make extra requests")
                host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
            }
        }
    }
    func testBoardProjectionIncludesUnrankedZeroPointSelfWithoutEnrollingAnyone() throws {
        var object = profile(visible: true); object["allTimePoints"] = 0; object["weekPoints"] = 0; object["badge"] = "newcomer"
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: object))
        let empty = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: board(empty: true)))
        let display = AmbassadorBoardPresentation(profile: member, board: empty, period: .week)
        XCTAssertFalse(display.needsJoin); XCTAssertEqual(display.rows.count, 1)
        XCTAssertEqual(display.rows[0].profileID, ownerID); XCTAssertEqual(display.rows[0].points, 0)
        XCTAssertTrue(display.rows[0].isSelf); XCTAssertNil(display.rows[0].rank)
        XCTAssertTrue(display.rows[0].status?.contains("Not ranked yet") == true)
        let notJoined = AmbassadorBoardPresentation(profile: nil, board: empty, period: .week)
        XCTAssertTrue(notJoined.needsJoin); XCTAssertTrue(notJoined.rows.isEmpty)
    }
    func testPrivateOrPausedSelfRemainsVisibleLocallyWithoutAStalePublicRank() throws {
        let sharedBoard = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: board()))
        for paused in [false, true] {
            let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: profile(visible: paused, paused: paused)))
            let display = AmbassadorBoardPresentation(profile: member, board: sharedBoard, period: .week)
            let own = try XCTUnwrap(display.rows.first(where: \.isSelf))
            XCTAssertEqual(display.rows.filter(\.isSelf).count, 1)
            XCTAssertEqual(display.rows.count, 2); XCTAssertNil(own.rank); XCTAssertEqual(own.points, 3)
            XCTAssertTrue(own.status?.contains(paused ? "paused" : "Private") == true)
            XCTAssertEqual(display.rows.first?.rank, 1)
            XCTAssertEqual(member.leaderboardVisible, paused, "Rendering cannot opt in a private member")
        }
    }
    func testSelfInTop50IsHighlightedOnceAndOutsideTop50KeepsOnlyServerRank() throws {
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: profile(visible: true)))
        let sharedBoard = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: board()))
        let inside = AmbassadorBoardPresentation(profile: member, board: sharedBoard, period: .week)
        XCTAssertEqual(inside.rows.count, 2); XCTAssertEqual(inside.rows.filter(\.isSelf).count, 1)
        XCTAssertEqual(inside.rows.first(where: \.isSelf)?.rank, 2)
        var outsideObject = board(); outsideObject["entries"] = [(outsideObject["entries"] as! [[String: Any]])[0]]; outsideObject["myRank"] = 67
        let outsideBoard = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: outsideObject))
        let outside = AmbassadorBoardPresentation(profile: member, board: outsideBoard, period: .week)
        XCTAssertEqual(outside.rows.map(\.rank), [1, 67]); XCTAssertEqual(outside.rows.last?.profileID, ownerID)
        XCTAssertTrue(outside.rows.last?.status?.contains("outside") == true)
        XCTAssertEqual(outsideBoard.entries.count, 1, "Local self row never changes the server standings")
    }
    func testPeriodSwitchAndOfflineBoardRetainSelfPointsWithoutBorrowingOldRank() throws {
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: profile(visible: true)))
        let week = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: board()))
        let switched = AmbassadorBoardPresentation(profile: member, board: week, period: .all)
        XCTAssertEqual(switched.rows.count, 1); XCTAssertEqual(switched.rows[0].points, 8); XCTAssertNil(switched.rows[0].rank)
        let offline = AmbassadorBoardPresentation(profile: member, board: nil, period: .week)
        XCTAssertEqual(offline.rows.count, 1); XCTAssertEqual(offline.rows[0].points, 3); XCTAssertNil(offline.rows[0].rank)
    }
    func testPacemakersRemainPeriodSpecificTargetsWithoutAwardingPointsOrSharedRanks() throws {
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: profile()))
        let weekly = AmbassadorPacemaker.targets(for: .week), allTime = AmbassadorPacemaker.targets(for: .all)
        XCTAssertEqual(weekly.map(\.target), [1, 5, 20]); XCTAssertEqual(allTime.map(\.target), [5, 25, 100])
        XCTAssertEqual(weekly.map { $0.remaining(for: member) }, [0, 2, 17])
        XCTAssertEqual(allTime.map { $0.remaining(for: member) }, [0, 17, 92])
        XCTAssertTrue(Set(weekly.map(\.id)).isDisjoint(with: Set(allTime.map(\.id))))
        XCTAssertEqual(member.weekPoints, 3); XCTAssertEqual(member.allTimePoints, 8)
        XCTAssertEqual(AmbassadorBoardPresentation(profile: member, board: nil, period: .week).rows.count, 1)
    }
    func testRaceAvatarsUseOnlyExistingPublicHandles() {
        XCTAssertEqual(AmbassadorRacer.emoji(for: "BrightOtter1234"), "🦦")
        XCTAssertEqual(AmbassadorRacer.emoji(for: "ThoughtfulBumblebee9999"), "🐝")
        XCTAssertEqual(AmbassadorRacer.emoji(for: "NimbleHedgehog1234"), "🦔")
    }
    func testLeagueInterleavesTargetsAndMembersWithNumericPositionsAndPreservesOfficialRanks() throws {
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: profile(visible: true)))
        let shared = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: board()))
        let league = AmbassadorLeaguePresentation(members: AmbassadorBoardPresentation(profile: member, board: shared, period: .week), period: .week)
        XCTAssertEqual(league.rows.map(\.position), [1, 2, 3, 4, 5])
        XCTAssertEqual(league.rows.map(\.points), [20, 12, 5, 3, 1])
        XCTAssertEqual(Set(league.rows.map(\.id)).count, 5)
        let members = league.rows.compactMap { row -> AmbassadorBoardPresentation.Row? in
            if case .member(let member) = row.source { return member }; return nil
        }
        XCTAssertEqual(members.map(\.rank), [1, 2], "Local table positions must not replace the official server ranks")
        XCTAssertEqual(league.rows[1].nextTargetGap, 8)
        XCTAssertEqual(league.rows[3].nextTargetGap, 2)
        XCTAssertEqual(shared.entries.count, 2, "Pacemakers never become shared member records")
        let own = try XCTUnwrap(members.first(where: \.isSelf))
        XCTAssertEqual(own.profileID, ownerID); XCTAssertEqual(own.points, member.weekPoints)
    }
    func testLeagueRetainsPrivateZeroPointSelfAndShowsTargetsWithoutFabricatedMembers() throws {
        var object = profile(); object["weekPoints"] = 0; object["allTimePoints"] = 0; object["badge"] = "newcomer"
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: object))
        let league = AmbassadorLeaguePresentation(members: AmbassadorBoardPresentation(profile: member, board: nil, period: .week), period: .week)
        XCTAssertEqual(league.rows.map(\.position), [1, 2, 3, 4])
        XCTAssertEqual(league.rows.map(\.points), [20, 5, 1, 0])
        guard case .member(let own) = try XCTUnwrap(league.rows.last).source else { return XCTFail("Own zero-point row must be in the table") }
        XCTAssertEqual(own.profileID, ownerID); XCTAssertNil(own.rank); XCTAssertTrue(own.isSelf)
        XCTAssertTrue(own.status?.contains("Private") == true)
        XCTAssertEqual(league.rows.last?.nextTargetGap, 1)
        XCTAssertFalse(member.leaderboardVisible)
        let guest = AmbassadorLeaguePresentation(members: AmbassadorBoardPresentation(profile: nil, board: nil, period: .all), period: .all)
        XCTAssertEqual(guest.rows.map(\.points), [100, 25, 5])
        XCTAssertTrue(guest.rows.allSatisfy { if case .pacemaker = $0.source { return true }; return false })
    }
    func testLeagueKeepsTiedSharedMembersTogetherAheadOfReachedTarget() throws {
        var object = profile(visible: true); object["weekPoints"] = 5
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: object))
        var reply = board(); var entries = reply["entries"] as! [[String: Any]]
        entries[0]["points"] = 5; entries[1]["points"] = 5; entries[1]["rank"] = 1
        reply["entries"] = entries; reply["myRank"] = 1
        let shared = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: reply)).validated(period: .week)
        let league = AmbassadorLeaguePresentation(members: AmbassadorBoardPresentation(profile: member, board: shared, period: .week), period: .week)
        XCTAssertEqual(league.rows.map(\.points), [20, 5, 5, 5, 1])
        XCTAssertEqual(league.rows[1].id, "member-" + otherID.uuidString)
        XCTAssertEqual(league.rows[2].id, "member-" + ownerID.uuidString)
        XCTAssertEqual(league.rows[3].id, "target-week-steady")
        XCTAssertEqual(league.rows[2].nextTargetGap, 15)
        let all = AmbassadorLeaguePresentation(members: AmbassadorBoardPresentation(profile: member, board: shared, period: .all), period: .all)
        XCTAssertEqual(all.rows.map(\.points), [100, 25, 8, 5])
        guard case .member(let own) = all.rows[2].source else { return XCTFail("Expected all-time self") }
        XCTAssertNil(own.rank, "Week ranks must not leak into the all-time table")
        XCTAssertEqual(all.rows[2].nextTargetGap, 17)
    }
    func testLeagueTableKeepsActualColumnsForMembersAndPacemakersAtPhoneAndAccessibilitySizes() async throws {
        let member = try JSONDecoder().decode(AmbassadorProfile.self, from: JSONSerialization.data(withJSONObject: profile(visible: true)))
        let shared = try JSONDecoder().decode(AmbassadorLeaderboard.self, from: JSONSerialization.data(withJSONObject: board()))
        let league = AmbassadorLeaguePresentation(members: AmbassadorBoardPresentation(profile: member, board: shared, period: .week), period: .week)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow), window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        for large in [false, true] {
            var frames: [String: CGRect] = [:]
            let root = ScrollView {
                NativeAmbassadorLeagueTable(presentation: league)
                    .onPreferenceChange(NativeAmbassadorTableGeometryKey.self) { frames = $0 }
                    .padding(20)
            }.environment(\.dynamicTypeSize, large ? .accessibility5 : .large)
            let host = UIHostingController(rootView: root), parent = UIViewController()
            parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
            parent.setOverrideTraitCollection(UITraitCollection(preferredContentSizeCategory: large ? .accessibilityExtraExtraExtraLarge : .large), forChild: host)
            window.rootViewController = parent; window.makeKeyAndVisible()
            parent.view.frame = CGRect(x: 0, y: 0, width: 320, height: 844); host.view.frame = parent.view.bounds
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(300)); host.view.layoutIfNeeded()
            let columns = ["position", "name", "points", "next"]
            for column in columns {
                let header = try XCTUnwrap(frames["league-heading-" + column])
                XCTAssertGreaterThan(header.width, 0)
                for row in league.rows {
                    let cell = try XCTUnwrap(frames["league-\(row.id)-" + column])
                    XCTAssertEqual(cell.minX, header.minX, accuracy: 0.5, "Every row must keep the \(column) column boundary")
                    XCTAssertEqual(cell.width, header.width, accuracy: 0.5)
                }
            }
            let selfRow = try XCTUnwrap(frames["ambassador-self-row"])
            let targetRow = try XCTUnwrap(frames["ambassador-pacemaker-week-team"])
            XCTAssertEqual(selfRow.width, targetRow.width, accuracy: 0.5)
            XCTAssertGreaterThanOrEqual(selfRow.height, 64)
            XCTAssertLessThan(targetRow.minY, selfRow.minY, "Pacemakers belong inside the same ordered table")
            if !large {
                XCTAssertLessThanOrEqual(selfRow.width, 280.5, "The complete normal-size table must fit a 320-point phone")
            } else {
                let panningTables = descendants(host.view).compactMap { $0 as? UIScrollView }.filter { $0.contentSize.width > $0.bounds.width + 1 }
                XCTAssertEqual(panningTables.count, 1, "Accessibility columns pan together; the page must not overflow")
            }
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
            let attachment = XCTAttachment(image: image); attachment.name = "League table 320px \(large ? "AX5" : "regular")"; attachment.lifetime = .keepAlways; add(attachment)
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
    }
    func testScanLapsAreCurrentActiveAccountOnlyAndNeverMakeCreditRequests() async throws {
        var revision = 1
        for paused in [false, true] {
            let network = Transport { request in
                request.url?.path.hasSuffix("/leaderboard") == true ? try self.response(self.board()) : try self.response(self.me(self.profile(visible: false, paused: paused)))
            }
            var client = service(network, revision: { revision })
            client.localOwnerKey = { String(repeating: "ab", count: 32) }
            let model = AmbassadorModel(service: client)
            XCTAssertNil(model.activityOwnerKey)
            await model.load()
            XCTAssertEqual(model.activityOwnerKey, paused ? nil : String(repeating: "ab", count: 32))
            XCTAssertFalse(try XCTUnwrap(model.profile).leaderboardVisible, "Private local totals never opt in to sharing")
            revision += 1
            XCTAssertNil(model.activityOwnerKey, "An account switch fences totals even before its notification")
            model.accountDidChange()
            XCTAssertNil(model.activityOwnerKey)
            XCTAssertEqual(network.requests.map(\.httpMethod), ["GET", "GET"])
        }
    }
    func testScanSummaryRejectsInconsistentCountsAndExplainsUnfinishedAnalyses() throws {
        let counts: [String: Any] = ["captured": 5, "ready": 2, "pending": 1, "needsInput": 1, "failed": 1, "products": 3, "photos": 2, "readyProducts": 1]
        let object: [String: Any] = ["available": true, "weekStartsAt": 1_800_000_000_000, "week": counts, "all": counts]
        let activity = try XCTUnwrap(AmbassadorScanActivity(projection: object))
        XCTAssertEqual(activity.week.waitingLabel, "1 analysing · 1 need details · 1 to retry")
        XCTAssertEqual(activity.week.readyProducts, 1)
        for key in ["captured", "readyProducts", "products"] {
            var malformed = counts; malformed[key] = 99
            var reply = object; reply["week"] = malformed
            XCTAssertNil(AmbassadorScanActivity(projection: reply))
        }
        XCTAssertNil(AmbassadorScanActivity(projection: ["available": false]))
        XCTAssertNil(AmbassadorScanActivity(projection: [:]))
    }
    private func descendants(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(descendants) }
}
