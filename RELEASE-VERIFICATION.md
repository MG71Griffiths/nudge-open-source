# Source release verification — 0.1.1 (44)

Prepared on 22 October 2026. This source snapshot is independent of App Store approval or a hosted service. Build44 adds first-run email-code onboarding and optional shared ChatGPT setup. It also includes the camera retry, model-selection and diagnostic changes accumulated since public build39.

The app source was taken from the reviewed, frozen build44 input manifest. Native/Web source remains exact apart from the existing independent-service, website and example-identity substitutions. The exported backend defaults to a reserved .invalid hostname, uses the example app identifier and has no signing team. The original operator's provider tenant, credentials, private records, diagnostics, provisioning material and development Git history are excluded.

The shipping account harness passed 111 assertions in nine groups against the final frozen account source using synthetic HTTP and memory credential storage. Shipping source has a separate signed build and device-delivery workflow. That evidence does not establish a live login or an independent native compile of this sanitised source export. Source-export checks and limits are recorded below after execution.

The provider must be configured independently to issue six-digit email codes. No fixed OTP, bypass account or shared reviewer password is part of this source release. An existing-password route is retained separately for App Review; ordinary onboarding uses email codes.

Photo analysis produces estimates, and some real scans have exceeded the ten-second target. This release does not claim guaranteed timing, verified nutritional accuracy, or successful recognition of every photo. Mixed subjects can require the user to select the intended food before retrying.

MIT and all third-party notices, dataset attribution and artwork provenance are preserved from the published build39 release. Known-pattern scanning is bounded and does not prove arbitrary sensitive content can never exist. Live services, provider eligibility, email delivery, a fork's account lifecycle, cloud deployment, and real-device behaviour are separate verification steps.

## Export verification results

- All 111 offline check outcomes passed: 830 backend tests, 108 Web/shared suites, package validation and independent service configuration checks. External fetch/http/https requests were denied; fixtures used explicit mocks or loopback. These checks were rerun on this sanitised build44 candidate.
- All 36 Python diagnostic tests passed. All exported native Swift source files passed syntax parsing; the account harness shell script passed its syntax check. Parser success is not a separate native type-check/build.
- All 68 generated-source pins and bundle hashes match. The twelve artwork provenance hashes match. The package retains all required app resources and the native onboarding source is registered in the project.
- The 543-file source/privacy/URL audit passed all 18 checks. The 30 changed existing files comprise 26 source/test files and four release/setup documents; one native onboarding source file is new. All other 512 published build39 files remain byte-identical, including MIT and third-party licence notices.
- The signed shipping archive passed separately. No independent native compile of the sanitised export was performed. Live provider login, real email delivery, and on-device UI execution are not established by this source-export check.
