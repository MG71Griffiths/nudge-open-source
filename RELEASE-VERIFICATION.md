# Source release verification — 0.1.1 (39)

Checked on 20 October 2026. Source publication does not imply App Store approval, public app availability or a working hosted service for an independently configured copy.

Build39 adds ordinary email/password authentication alongside the existing emailed-code flow. The only production runtime change is AccountFeature.swift; the project changes only both build-number values from 38 to 39. The two-image packaging exclusion remains intact. Two focused account-check files are included. Shared Web/backend/scoring logic, privacy declarations, distributed artwork and third-party licence notices are unchanged from source38.

Authentication evidence:

- A bounded Mac Catalyst harness compiled the exact production AccountFeature.swift and NudgeTheme.swift with the included synthetic harness. It passed 90 assertions across seven groups, with source hashes unchanged before and after execution.
- Coverage includes exact password handling, validated provider destination, bounded requests, generic errors, durable-save failure, restored sessions, password/password and password/OTP races, concurrent refresh and sign-out, cancellation, OTP regression, and actual UIKit controls for secure input, duplicate submission, error display, switching and dismissal.
- An independent read-only review found no actionable auth/session/UI defect. Cancellation during configuration fetch and an in-flight OTP verification superseded by password sign-in were inspected through their shared post-await generation guards; those two specific interleavings were not separately executed by the harness.
- The harness uses fake HTTP and memory credential storage. It is not a live-provider login, real Keychain, screenshot, simulator or physical-device authentication test. No reviewer email, real password, session token or operational account is included.

Public export checks:

- Package/project/resource/plist and independent service configuration checks passed for build39.
- The transformed account source and included Swift harness passed parser checks; the shell harness passed syntax checking. Parser success is not independent native type checking.
- The auth implementation is retained exactly apart from the pre-existing independent backend/Keychain configuration adaptations. The public backend defaults to a reserved .invalid hostname, uses the example app identifier and has no signing team.
- All 68 generated source-pin entries and bundle hashes, plus all twelve artwork provenance hashes, match. No shared-source rebuild was required for the native-only auth change.
- All unchanged public files match source38. The source/privacy/URL audit retains separate licence notices and synthetic negative-security fixtures. Known-pattern scanning is bounded, not a proof that arbitrary sensitive content can never exist.

Unchanged runtime coverage inherited from source37/38, not rerun for this native-only update: 830 backend tests and all 108 Web/shared test-suite scripts passed, with external network calls denied. Export configuration previously verified all eight administrator commands reject absent or unsafe destinations before accessing credentials. Those administrator implementations and tests remain byte-for-byte unchanged.

No separate native compile of the sanitised export was run for this release. The prior independent source37 compile was cancelled for shared-Mac resource scheduling and did not establish a compile pass. The README and focused harness retain commands for an independent checkout. Production signed archive, App Store processing and installation are separate release checks.

Live email delivery, account lifecycle, provider eligibility, food recognition, a fork’s hosted service and real-device behaviour were not exercised by this source-export validation. The source cannot reuse the original operator’s credentials.
