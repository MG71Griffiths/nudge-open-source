# Source release verification — 0.1.1 (46)

Prepared on 22 October 2026. This source snapshot is separate from App Store approval, TestFlight distribution and hosted services. Build46 makes native and Web food screens consistently light, preserves semantic score and category colours, and simplifies Home and product cards. Nutrient amounts and known targets remain visible; repeated supporting explanations move into details without hiding active warnings. Recorded intake without a target uses an active indicator without inventing a percentage.

A ready camera result opens its full card on an upward swipe, a tap or the accessible Open action. Gesture handling excludes the photo carousel and controls. The diary action is consistently green. Photo choices distinguish the entire current photo estimate from half of that estimate, with numeric custom portions available. Recipe and diary portions retain their own meaning.

Legacy saved results with no proven original photo scale use a share of the saved estimate; they do not offer misleading whole/half-photo choices. A saved_portion provenance value is retained only when explicitly saving such an estimate. Existing records are not migrated. Selecting a photo share clears a conflicting measured-weight override; compatible measured quantities update the saved values without converting grams to millilitres. These changes do not establish improved recognition accuracy or measured nutrients.

The five-stage passwordless setup, metric or imperial measurements, preferred units and target review from build45 are retained. Existing nutrition formulas, manual target overrides, clinical context and historical targets are unchanged. No particular TestFlight reporter's saved profile or screenshot is inferred from the source checks.

The Native/Web source matches the reviewed frozen build46 inputs apart from the established independent-service, website and example-identity substitutions. The backend defaults to a reserved .invalid hostname, the app identifier is an example and no signing team is supplied. Original operator tenants, credentials, private records, screenshots, diagnostics, provisioning material and development Git history are excluded. No backend deployment is part of this source release.

The ordinary account flow remains email plus a six-digit code. Provider email length, SMTP and actual delivery must be configured and verified independently. No fixed code, bypass account or shared reviewer password is included. Existing-password access remains separately available for App Review.

MIT, third-party notices, dataset attribution and artwork provenance are preserved from public build45. Known-pattern privacy scanning is bounded and does not prove arbitrary sensitive content can never exist. Live provider login, a fork's account lifecycle, cloud deployment and real-device behaviour require separate validation. Parsing native source or executing Foundation helpers is not a full native build or on-device UI test.

Photo analysis remains an estimate. Some real scans have exceeded the ten-second target; this release does not guarantee timing, measured nutrient accuracy or recognition of every photograph. Mixed subjects may need a clearer selection of the intended food.

## Export verification results

- The sanitised build46 candidate passed package validation, independent service configuration checks, all 386 Web/shared tests, all 830 backend tests and all 59 Python tests. External fetch/http/https calls were denied; synthetic mocks and loopback were allowed. Backend tests were rerun because shared food-log source changed; no prior test result is substituted.
- Both native Foundation harnesses were rerun from this export: 2,555 measurement assertions and 255 target-display assertions. The helpers are extracted from the exact exported production source; the source remained unchanged during each check. These are executable logic checks, not interactive UI tests.
- All exported app Swift files passed syntax parsing. No independent full native build or interactive iPhone/simulator UI execution of this sanitised export is claimed. The shipping workspace's simulator runtime was unavailable during this work; it is not counted as an interactive UI pass. Live-provider login and actual six-digit email delivery are separate checks.
- All 173 backend files remain byte-identical to the audited public build45 tree, while Web/core/food-log.js now retains the explicit saved_portion provenance value. No backend deployment was performed for this source publication.
- All 68 generated-source pins, twelve artwork hashes, original MIT licence and third-party notices remain intact. The source/privacy/URL audit passed all 18 checks with no known-pattern findings. The 547-file candidate changes 30 existing build45 files; the other 517 files remain byte-identical.
- Source preparation does not establish shipping installation, App Store approval or TestFlight availability. Those are separate distribution steps. No tester screenshots or private operational evidence are distributed.
