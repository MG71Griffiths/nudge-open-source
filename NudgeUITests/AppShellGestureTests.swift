import XCTest

/// Real interaction checks on the simulator. The history deletion test uses an
/// isolated synthetic fixture; other gesture checks leave saved data unchanged.
final class AppShellGestureTests: XCTestCase {
    #if targetEnvironment(simulator)
    @MainActor
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<12 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "Expected control to be reachable by scrolling", file: file, line: line)
    }

    @MainActor
    private func skipInitialSetupIfPresented(_ app: XCUIApplication) {
        let skipAccount = app.buttons["onboarding-skip-account"]
        if skipAccount.waitForExistence(timeout: 5) {
            skipAccount.tap()
        }
        let skipProfile = app.buttons["onboarding-skip-profile"]
        if skipProfile.waitForExistence(timeout: 3) {
            scrollTo(skipProfile, in: app); skipProfile.tap()
        }
        let skipChatGPT = app.buttons["onboarding-skip-chatgpt"]
        if skipChatGPT.waitForExistence(timeout: 3) {
            scrollTo(skipChatGPT, in: app); skipChatGPT.tap()
        }
    }

    /// Run on a fresh isolated simulator. This path never submits a real email,
    /// connects ChatGPT, or changes an existing person's app container.
    @MainActor
    func testPasswordlessOnboardingSkipsPersistsAndReopens() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["NUDGE_ONBOARDING_UI_FIXTURE"] = UUID().uuidString
        app.launch()
        defer { app.terminate() }
        func attach(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        let email = app.textFields["account-email"]
        XCTAssertTrue(email.waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["account-onboarding-title"].exists)
        XCTAssertFalse(app.secureTextFields["account-password"].exists)
        XCTAssertTrue(app.buttons["account-send-code"].isHittable)
        attach("First run — email code sign-in with no password field")
        email.tap(); email.typeText("not-an-email")
        XCTAssertTrue(app.buttons["account-send-code"].isHittable)
        app.buttons["account-send-code"].tap()
        let feedback = app.staticTexts["account-feedback"]
        let invalidEmail = NSPredicate(format: "label CONTAINS[c] %@", "valid email")
        expectation(for: invalidEmail, evaluatedWith: feedback)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(email.value as? String, "not-an-email")
        XCTAssertFalse(app.textFields["account-code"].exists)
        attach("Invalid email stays visible without sending a code")
        app.buttons["onboarding-skip-account"].tap()
        XCTAssertTrue(app.textFields["onboarding-age"].waitForExistence(timeout: 5))
        scrollTo(app.buttons["onboarding-skip-profile"], in: app)
        app.buttons["onboarding-skip-profile"].tap()
        XCTAssertTrue(app.buttons["onboarding-connect-chatgpt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Have a ChatGPT account?"].exists)
        scrollTo(app.buttons["onboarding-skip-chatgpt"], in: app)
        XCTAssertTrue(app.buttons["onboarding-skip-chatgpt"].isHittable)
        attach("Optional ChatGPT connection explains the shared camera connection")
        for _ in 0..<4 { app.navigationBars.buttons["Back"].tap() }
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        XCTAssertFalse(app.secureTextFields["account-password"].exists)
        app.buttons["onboarding-skip-account"].tap()
        scrollTo(app.buttons["onboarding-skip-profile"], in: app)
        app.buttons["onboarding-skip-profile"].tap()
        scrollTo(app.buttons["onboarding-skip-chatgpt"], in: app)
        app.buttons["onboarding-skip-chatgpt"].tap()
        XCTAssertTrue(app.buttons["native-tab-you"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["onboarding-skip-account"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["native-tab-you"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["onboarding-skip-account"].exists, "Completed setup stays dismissed after relaunch")
        app.buttons["native-tab-you"].tap()
        let setup = app.buttons["native-profile-setup"]
        XCTAssertTrue(setup.waitForExistence(timeout: 10)); setup.tap()
        XCTAssertTrue(email.waitForExistence(timeout: 15))
        XCTAssertFalse(app.secureTextFields["account-password"].exists)
        attach("Setup can be reopened from You")
        app.buttons["onboarding-skip-account"].tap()
        scrollTo(app.buttons["onboarding-skip-profile"], in: app)
        app.buttons["onboarding-skip-profile"].tap()
        scrollTo(app.buttons["onboarding-skip-chatgpt"], in: app)
        app.buttons["onboarding-skip-chatgpt"].tap()
        XCTAssertTrue(setup.waitForExistence(timeout: 10))
    }

    @MainActor
    func testPersonalSetupImperialMeasurementsAndVisibleUnloggedTargets() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["NUDGE_ONBOARDING_UI_FIXTURE"] = UUID().uuidString
        app.launch()
        defer { app.terminate() }
        func attach(_ name: String) {
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        XCTAssertTrue(app.buttons["onboarding-skip-account"].waitForExistence(timeout: 30))
        app.buttons["onboarding-skip-account"].tap()
        let age = app.textFields["onboarding-age"]
        XCTAssertTrue(age.waitForExistence(timeout: 5)); age.tap(); age.typeText("40")
        app.toolbars.buttons["Done"].tap()
        app.segmentedControls["onboarding-sex"].buttons["Female"].tap()
        let heightUnits = app.segmentedControls["onboarding-height-units"]
        scrollTo(heightUnits, in: app); heightUnits.buttons["ft & in"].tap()
        let feet = app.textFields["onboarding-field-height-major"]
        scrollTo(feet, in: app); feet.tap(); feet.typeText("5")
        let inches = app.textFields["onboarding-field-height-minor"]
        inches.tap(); inches.typeText("6")
        app.toolbars.buttons["Done"].tap()
        let weightUnits = app.segmentedControls["onboarding-weight-units"]
        scrollTo(weightUnits, in: app); weightUnits.buttons["st & lb"].tap()
        let stone = app.textFields["onboarding-field-weight-major"]
        scrollTo(stone, in: app); stone.tap(); stone.typeText("10")
        let pounds = app.textFields["onboarding-field-weight-minor"]
        pounds.tap(); pounds.typeText("7")
        app.toolbars.buttons["Done"].tap()
        attach("Personal measurements — feet inches stone and pounds")
        let care = app.buttons["onboarding-care-none"]
        scrollTo(care, in: app); care.tap()
        let next = app.buttons["onboarding-details-continue"]
        scrollTo(next, in: app); next.tap()
        XCTAssertTrue(app.buttons["onboarding-activity-moderate"].waitForExistence(timeout: 5))
        app.buttons["onboarding-activity-moderate"].tap()
        attach("Activity selection — profile-dependent energy targets")
        let targets = app.buttons["onboarding-routine-continue"]
        scrollTo(targets, in: app); targets.tap()
        XCTAssertTrue(app.staticTexts["Your starting points."].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["A few targets need attention"].exists)
        attach("Personal targets calculated from saved setup")
        let continueTargets = app.buttons["onboarding-targets-continue"]
        scrollTo(continueTargets, in: app); continueTargets.tap()
        scrollTo(app.buttons["onboarding-skip-chatgpt"], in: app)
        app.buttons["onboarding-skip-chatgpt"].tap()
        XCTAssertTrue(app.buttons["native-tab-today"].waitForExistence(timeout: 10))
        let fibre = app.otherElements["nutrition-ring-fibre"]
        XCTAssertTrue(fibre.waitForExistence(timeout: 10))
        XCTAssertTrue(fibre.label.contains("30 g"), "Known target remains available before any food is logged")
        attach("Empty diary retains nutrient targets")
        app.buttons["native-tab-you"].tap()
        XCTAssertTrue(app.staticTexts["5 ft 6 in"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["10 st 7 lb"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["native-tab-you"].waitForExistence(timeout: 15))
        app.buttons["native-tab-you"].tap()
        XCTAssertTrue(app.staticTexts["5 ft 6 in"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["10 st 7 lb"].exists)
    }

    @MainActor
    private func launchSearchFixture() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["NUDGE_SEARCH_UI_FIXTURE"] = "1"
        app.launch()
        XCTAssertTrue(app.textFields["product-search-input"].waitForExistence(timeout: 15))
        return app
    }

    @MainActor
    private func attachSearch(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name + " — isolated Search fixture including keyboard window"
        shot.lifetime = .keepAlways; add(shot)
    }

    @MainActor
    func testSearchCategoryTapDismissesKeyboardWithoutMovingField() {
        let app = launchSearchFixture()
        defer { app.terminate() }
        let field = app.textFields["product-search-input"]
        field.tap(); field.typeText("beans")
        let category = app.buttons["search-category-suggestion-pulses"]
        XCTAssertTrue(category.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertGreaterThanOrEqual(category.frame.height, 48)
        let before = field.frame
        attachSearch(app, "Category suggestion before selection")
        category.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.75)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["search-chip-aisle"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["search-product-91000001"].waitForExistence(timeout: 5))
        XCTAssertEqual(field.frame.minY, before.minY, accuracy: 1, "Dismissing the keyboard must not insert a header above active results")
        XCTAssertEqual(field.frame.height, before.height, accuracy: 1)
        XCTAssertFalse(category.exists)
        attachSearch(app, "Selected category with keyboard dismissed")
        let aisle = app.buttons["search-chip-aisle"]
        aisle.tap()
        XCTAssertTrue(aisle.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["search-product-91000001"].waitForExistence(timeout: 5), "Removing one filter retains the results route")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Removing an aisle is deliberate browsing, not typing")
        app.buttons["search-all-categories"].tap()
        XCTAssertTrue(app.buttons["search-category-fruit"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Back to browsing does not restart typing")
    }

    @MainActor
    func testSearchSuggestionCommitDismissesButRefineAndClearKeepKeyboard() {
        let app = launchSearchFixture()
        defer { app.terminate() }
        let field = app.textFields["product-search-input"]
        field.tap()
        let refine = app.buttons["product-search-refine-Thai green curry"]
        XCTAssertTrue(refine.waitForExistence(timeout: 5)); refine.tap()
        XCTAssertEqual(field.value as? String, "Thai green curry")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "The separate refine arrow keeps typing active")
        let clear = app.buttons["product-search-clear"]
        clear.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.8)).tap()
        XCTAssertTrue(clear.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Clear is ready for another search")
        let suggestion = app.buttons["product-search-suggestion-Thai green curry"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 5)); suggestion.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "thai green curry", "Committed intent uses the parser’s normalized text")
        XCTAssertTrue(app.buttons["search-product-91000001"].waitForExistence(timeout: 5))
        attachSearch(app, "Committed query suggestion")
    }

    @MainActor
    func testSearchButtonAndReturnCommitWithoutMovingFieldOrClearingQuery() {
        let app = launchSearchFixture()
        defer { app.terminate() }
        let field = app.textFields["product-search-input"]
        field.tap(); field.typeText("beans")
        XCTAssertTrue(app.buttons["search-product-91000001"].waitForExistence(timeout: 5))
        let search = app.buttons["product-search-submit"]
        XCTAssertTrue(search.isHittable)
        XCTAssertGreaterThanOrEqual(search.frame.width, 48)
        XCTAssertEqual(search.label, "Search")
        let before = field.frame
        search.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.8)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "beans")
        XCTAssertEqual(field.frame.minY, before.minY, accuracy: 1)
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        field.typeText("\n")
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "beans")
        XCTAssertEqual(field.frame.minY, before.minY, accuracy: 1)
        field.tap(); app.buttons["product-search-clear"].tap()
        let done = app.buttons["product-search-dismiss"]
        XCTAssertTrue(done.waitForExistence(timeout: 5)); done.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        attachSearch(app, "Empty search keyboard dismissed")
    }

    @MainActor
    func testSearchProductTapDismissesKeyboardOnceAndReturnKeepsResults() {
        let app = launchSearchFixture()
        defer { app.terminate() }
        let field = app.textFields["product-search-input"]
        field.tap(); field.typeText("beans")
        let row = app.buttons["search-product-91000001"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        let before = field.frame
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).tap()
        let close = app.buttons["search-fixture-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["search-fixture-open-count"].label, "1 product opens", "One tap opens exactly once")
        XCTAssertEqual(app.staticTexts["search-fixture-product-title"].label, "Synthetic beans 01")
        attachSearch(app, "Product selection dismisses keyboard")
        close.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "beans")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Returning from details must not refocus the field")
        XCTAssertEqual(field.frame.minY, before.minY, accuracy: 1)
        // A separate Save target must not open the neighbouring product.
        app.buttons["search-row-save-91000001"].tap()
        XCTAssertFalse(close.exists)
        XCTAssertEqual(app.buttons["search-row-save-91000001"].value as? String, "Saved")
        // Opening another visible result after scrolling preserves its position.
        let lower = app.buttons["search-product-91000008"]
        for _ in 0..<6 {
            if lower.exists && lower.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(lower.isHittable)
        let rowPosition = lower.frame.minY
        lower.tap(); XCTAssertTrue(close.waitForExistence(timeout: 5)); close.tap()
        XCTAssertTrue(lower.waitForExistence(timeout: 5))
        XCTAssertEqual(lower.frame.minY, rowPosition, accuracy: 2, "Returning to results keeps their scroll position")
        XCTAssertEqual(field.value as? String, "beans")
        attachSearch(app, "Returned Search keeps result position")
    }

    @MainActor
    func testSearchScrollingDismissesKeyboardAndRetainsTypedQuery() {
        let app = launchSearchFixture()
        defer { app.terminate() }
        let field = app.textFields["product-search-input"]
        field.tap(); field.typeText("beans")
        let row = app.buttons["search-product-91000001"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        row.swipeUp()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "beans")
        attachSearch(app, "Scrolling results dismisses keyboard")
    }

    @MainActor
    func testHistoryFavouriteAndNavigationRespondAcrossTheirFullTouchAreas() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["NUDGE_HISTORY_UI_FIXTURE"] = UUID().uuidString
        app.launch()
        func screen(_ identifier: String) -> XCUIElement {
            app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        }
        func tapEdge(_ control: XCUIElement) {
            XCTAssertTrue(control.isHittable)
            XCTAssertGreaterThanOrEqual(control.frame.width, 48)
            XCTAssertGreaterThanOrEqual(control.frame.height, 48)
            control.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.9)).tap()
        }
        func waitForLabel(_ label: String, on control: XCUIElement) {
            let predicate = NSPredicate(format: "label == %@", label)
            expectation(for: predicate, evaluatedWith: control)
            waitForExpectations(timeout: 5)
        }
        let row = app.buttons["history-row-ui-scan"]
        let heart = app.buttons["history-favourite-ui-scan"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertEqual(app.buttons.matching(identifier: "history-row-ui-scan").count, 1)
        XCTAssertEqual(heart.label, "Add to favourites")
        tapEdge(heart)
        waitForLabel("Remove from favourites", on: heart)
        XCTAssertTrue(screen("native-history").exists, "The heart must not open the adjacent food")
        XCTAssertFalse(screen("native-food-review").exists)
        XCTAssertTrue(row.exists)

        app.terminate(); app.launch()
        XCTAssertTrue(heart.waitForExistence(timeout: 15))
        XCTAssertEqual(heart.label, "Remove from favourites", "The filled heart must survive restart")
        tapEdge(row)
        XCTAssertTrue(screen("native-food-review").waitForExistence(timeout: 5), "The separate food button still opens its review")
        tapEdge(app.buttons["native-close-screen"])
        XCTAssertTrue(heart.waitForExistence(timeout: 5))
        tapEdge(heart)
        waitForLabel("Add to favourites", on: heart)
        tapEdge(app.buttons["native-tab-today"])
        let diary = app.buttons["today-diary"]
        XCTAssertTrue(diary.waitForExistence(timeout: 5))
        tapEdge(diary)
        XCTAssertTrue(screen("native-diary").waitForExistence(timeout: 5))
        tapEdge(app.buttons["diary-previous-day"])
        XCTAssertTrue(app.buttons["diary-today"].waitForExistence(timeout: 5))
        tapEdge(app.buttons["diary-date"])
        XCTAssertTrue(app.navigationBars["Choose a date"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        tapEdge(app.buttons["diary-back"])
        XCTAssertTrue(screen("native-today").waitForExistence(timeout: 5))
        app.terminate()
    }

    @MainActor
    func testHistorySingleConfirmationUndoAndDismissRemainSeparateAcrossRestart() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchEnvironment["NUDGE_HISTORY_UI_FIXTURE"] = UUID().uuidString
        app.launch()
        let scan = app.buttons["history-row-ui-scan"]
        let retainedFood = app.buttons["history-row-diary:ui-food"]
        let undo = app.buttons["history-undo"], dismiss = app.buttons["history-dismiss-undo"]
        let actions = app.buttons["history-actions"]
        XCTAssertTrue(scan.waitForExistence(timeout: 15))

        func openHistoryActions() {
            XCTAssertTrue(actions.waitForExistence(timeout: 5))
            XCTAssertTrue(actions.isHittable)
            XCTAssertGreaterThanOrEqual(actions.frame.width, 48)
            XCTAssertGreaterThanOrEqual(actions.frame.height, 48)
            actions.tap()
            XCTAssertTrue(undo.waitForExistence(timeout: 5))
            XCTAssertTrue(dismiss.isHittable)
        }

        func deleteScan() {
            scan.press(forDuration: 1)
            let action = app.buttons["Delete"].firstMatch
            if !action.waitForExistence(timeout: 5) { print(app.debugDescription) }
            XCTAssertTrue(action.exists)
            action.tap()
            let confirmation = app.buttons["Delete scan"]
            XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["Delete logged food"].exists)
            confirmation.tap()
            XCTAssertTrue(actions.waitForExistence(timeout: 5), "One confirmation must complete deletion")
            XCTAssertFalse(undo.exists, "Undo must stay inside the user-opened History actions menu")
            XCTAssertFalse(dismiss.exists)
            XCTAssertFalse(scan.exists)
            XCTAssertTrue(retainedFood.exists, "Deleting a scan preserves its eaten food")
        }

        deleteScan()
        app.terminate(); app.launch()
        XCTAssertTrue(retainedFood.waitForExistence(timeout: 15))
        XCTAssertFalse(undo.exists, "Restart must not reopen the deletion notice or menu")
        XCTAssertFalse(dismiss.exists)
        openHistoryActions()
        undo.tap()
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "Only Undo restores a deleted scan")
        XCTAssertFalse(retainedFood.exists, "The restored scan and linked food appear once")
        XCTAssertEqual(app.buttons.matching(identifier: "history-row-ui-scan").count, 1)
        XCTAssertFalse(undo.exists)

        deleteScan()
        openHistoryActions()
        dismiss.tap()
        XCTAssertTrue(dismiss.waitForNonExistence(timeout: 5))
        XCTAssertFalse(undo.exists)
        XCTAssertFalse(scan.exists, "Tapping Dismiss must never activate the adjacent Undo")
        XCTAssertEqual(app.buttons.matching(identifier: "history-row-diary:ui-food").count, 1)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "History deletion dismissed — isolated synthetic store"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.terminate()
        app.launch()
        XCTAssertTrue(retainedFood.waitForExistence(timeout: 15))
        XCTAssertFalse(scan.exists)
        XCTAssertFalse(undo.exists)
        XCTAssertFalse(dismiss.exists)
        XCTAssertFalse(actions.exists)
        XCTAssertEqual(app.buttons.matching(identifier: "history-row-diary:ui-food").count, 1)
        app.terminate()
    }
    #endif

    @MainActor
    func testNativeAppMigrationNavigationWithoutWebScreens() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Migration navigation is restricted to the simulator")
        #else
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        skipInitialSetupIfPresented(app)
        func element(_ id: String) -> XCUIElement {
            app.descendants(matching: .any).matching(identifier: id).firstMatch
        }
        func nativeScreen(_ id: String, title: String) {
            XCTAssertTrue(element(id).waitForExistence(timeout: 15), "Missing native \(title) screen")
            XCTAssertEqual(app.webViews.count, 0, "\(title) must not be rendered in a web view")
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = "Native migration · " + title
            shot.lifetime = .keepAlways
            add(shot)
        }
        func reveal(_ control: XCUIElement) {
            for _ in 0..<24 {
                if control.exists && control.isHittable { return }
                app.swipeUp()
            }
            XCTAssertTrue(control.isHittable, "Control remained unavailable after scrolling")
        }
        XCTAssertTrue(app.buttons["native-tab-today"].waitForExistence(timeout: 20))
        nativeScreen("native-today", title: "Today")
        XCTAssertTrue(app.buttons["today-diary"].isHittable)
        app.buttons["today-diary"].tap()
        nativeScreen("native-diary", title: "Diary under Today")
        XCTAssertTrue(app.buttons["native-tab-today"].isSelected)
        app.buttons["diary-previous-day"].tap()
        XCTAssertTrue(app.buttons["diary-today"].isHittable)
        app.buttons["diary-back"].tap()
        nativeScreen("native-today", title: "Back to Today")
        XCTAssertTrue(app.buttons["native-tab-camera"].exists)
        app.buttons["native-tab-history"].tap()
        nativeScreen("native-history", title: "History")
        app.buttons["native-tab-you"].tap()
        nativeScreen("native-profile", title: "Profile")
        let cycle = app.buttons["native-profile-cycle"]
        reveal(cycle); cycle.tap()
        nativeScreen("native-cycle", title: "Cycle")
        XCTAssertTrue(app.buttons["native-close-screen"].isHittable)
        app.buttons["native-tab-search"].tap()
        nativeScreen("native-product-search", title: "Search")
        XCTAssertTrue(app.textFields["product-search-input"].isHittable)
        XCTAssertTrue(app.buttons["product-search-market"].isHittable)
        XCTAssertTrue(app.buttons["product-search-store"].isHittable)
        app.buttons["search-saved-foods"].tap()
        nativeScreen("native-my-foods", title: "My foods")
        app.buttons["native-tab-you"].tap()
        let library = app.buttons["native-profile-recipes"]
        reveal(library); library.tap()
        nativeScreen("native-recipe-library", title: "Recipe library")
        XCTAssertTrue(app.buttons["native-recipe-card-berry"].isHittable)
        app.buttons["native-recipe-card-berry"].tap()
        nativeScreen("native-recipe-detail", title: "Recipe detail")
        let ingredients = app.buttons["native-recipe-tab-ingredients"]
        reveal(ingredients); ingredients.tap()
        let servings = app.staticTexts["native-recipe-servings"]
        XCTAssertTrue(servings.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Increase recipe servings by one"].isHittable)
        XCTAssertFalse(app.buttons["Decrease recipe servings by one"].isEnabled)
        app.buttons["Increase recipe servings by one"].tap()
        XCTAssertTrue(servings.label.contains("2 servings"))
        app.buttons["Decrease recipe servings by one"].tap()
        XCTAssertTrue(servings.label.contains("1 serving"))
        XCTAssertEqual(app.webViews.count, 0)
        app.buttons["native-tab-today"].tap()
        XCTAssertTrue(element("native-today").waitForExistence(timeout: 5))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["native-tab-today"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.webViews.count, 0)
        #endif
    }

    @MainActor
    func testNativeProductSearchNavigationAndAccessibleControls() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Navigation automation is restricted to the simulator")
        #else
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        skipInitialSetupIfPresented(app)
        let searchTab = app.buttons["native-tab-search"]
        XCTAssertTrue(searchTab.waitForExistence(timeout: 20))
        searchTab.tap()
        let field = app.textFields["product-search-input"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 0, "Search must remain native")
        XCTAssertTrue(field.isHittable)
        let market = app.buttons["product-search-market"]
        let supermarket = app.buttons["product-search-store"]
        XCTAssertTrue(market.isHittable)
        XCTAssertTrue(supermarket.isHittable)
        XCTAssertTrue(market.label.contains("United Kingdom"))
        supermarket.tap()
        let tesco = app.buttons["Tesco"].firstMatch
        XCTAssertTrue(tesco.waitForExistence(timeout: 5))
        tesco.tap()
        XCTAssertTrue(supermarket.label.contains("Tesco"))
        supermarket.tap()
        app.buttons["All supermarkets"].firstMatch.tap()
        XCTAssertTrue(supermarket.label.contains("All supermarkets"))
        XCTAssertTrue(app.buttons["search-category-fruit"].isHittable)
        for tab in ["today", "history", "camera", "search", "you"] {
            XCTAssertTrue(app.buttons["search-nav-\(tab)"].isHittable)
        }
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Native Search in running simulator app"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["search-saved-foods"].tap()
        let saved = app.descendants(matching: .any).matching(identifier: "native-my-foods").firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 0, "Saved foods must remain native")
        app.buttons["native-tab-search"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertTrue(supermarket.label.contains("All supermarkets"), "Returning to Search retains the selected supermarket filter")
        app.buttons["search-nav-history"].tap()
        let history = app.descendants(matching: .any).matching(identifier: "native-history").firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 0, "History must remain native")
        app.buttons["native-tab-today"].tap()
        #endif
    }

    @MainActor
    func testPinchingAppPagesKeepsNavigationAndContentAtNormalScale() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Gesture automation is restricted to the simulator")
        #else
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        skipInitialSetupIfPresented(app)
        let today = app.buttons["native-tab-today"]
        XCTAssertTrue(today.waitForExistence(timeout: 20))
        // Search is native now and has its own navigation/control test above.
        for (destination, title, identifier) in [("today", "Today", "native-today"), ("history", "History", "native-history"), ("you", "You", "native-profile")] {
            let tab = app.buttons["native-tab-" + destination]
            XCTAssertTrue(tab.exists); tab.tap()
            let screen = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
            XCTAssertTrue(screen.waitForExistence(timeout: 10))
            XCTAssertTrue(screen.isHittable)
            XCTAssertEqual(app.webViews.count, 0, "\(title) must not fall back to embedded web content")
            let before = today.frame
            let beforeScreen = screen.frame
            let window = app.windows.firstMatch.frame
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "\(title) before actual simulator pinch"; screenshot.lifetime = .keepAlways; add(screenshot)
            screen.pinch(withScale: 0.5, velocity: -1)
            screen.pinch(withScale: 2, velocity: 1)
            screen.pinch(withScale: 0.6, velocity: -1)
            let after = today.frame
            XCTAssertEqual(after.width, before.width, accuracy: 1, "Navigation width changed on \(title)")
            XCTAssertEqual(after.height, before.height, accuracy: 1, "Navigation height changed on \(title)")
            XCTAssertEqual(after.minX, before.minX, accuracy: 1)
            // A gesture can scroll/overscroll the page vertically. Assert the
            // intended invariant (unchanged scale and visible navigation), not
            // an identical transient accessibility Y coordinate across pages.
            XCTAssertGreaterThanOrEqual(after.minY, window.midY)
            XCTAssertLessThanOrEqual(after.maxY, window.maxY + 1)
            XCTAssertEqual(screen.frame.width, beforeScreen.width, accuracy: 1, "Content width changed on \(title)")
            XCTAssertEqual(screen.frame.height, beforeScreen.height, accuracy: 1, "Content height changed on \(title)")
            XCTAssertEqual(screen.frame.width, window.width, accuracy: 1)
            XCTAssertTrue(today.isHittable)
            screen.swipeUp(); screen.swipeDown()
            XCTAssertTrue(today.isHittable, "Scrolling must not detach navigation")
            for destination in ["today", "history", "camera", "search", "you"] {
                XCTAssertTrue(app.buttons["native-tab-" + destination].isHittable, "Each native tab stays reachable after gestures")
            }
            let result = XCTAttachment(screenshot: app.screenshot())
            result.name = "\(title) after actual simulator pinch and scroll"; result.lifetime = .keepAlways; add(result)
        }
        today.tap()
        app.terminate(); app.launch()
        XCTAssertTrue(today.waitForExistence(timeout: 15))
        let restoredToday = app.descendants(matching: .any).matching(identifier: "native-today").firstMatch
        XCTAssertTrue(restoredToday.waitForExistence(timeout: 10))
        XCTAssertEqual(restoredToday.frame.width, app.windows.firstMatch.frame.width, accuracy: 1)
        XCTAssertEqual(app.webViews.count, 0, "Relaunch must restore the native shell")
        #endif
    }
}
