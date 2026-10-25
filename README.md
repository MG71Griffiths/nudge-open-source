# Nudge

Nudge is an iPhone food diary built with SwiftUI and shared JavaScript nutrition rules. Photograph food or labels, scan barcodes, review nutrient estimates and a food score, tag ingredients, and add confirmed intake to your diary. History shows analysis progress. Photo results are estimates; review food identity, ingredients and portions before saving. Nudge supports general nutrition awareness, not diagnosis or treatment.

This source release contains the 0.1.1 (48) app source. Original code and documentation are available under the [MIT licence](LICENSE), copyright 2026 Stephanie Griffiths. Food datasets, icons and other third-party material keep their own licences; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). An App Store release is separate from source publication. This repository does not claim App Store approval or availability.

First-run setup has five stages: email sign-in, personal details, activity and goals, target review, and optional ChatGPT connection. Height and weight offer cm/ft-and-inches and kg/stone-and-pounds, with the preferred display units retained. Existing measurements, targets and diary records are preserved. Known target values remain visible when no intake has been logged or a nutrient amount is unknown; missing targets show what information is needed. Custom or agreed targets and past target history remain authoritative.

Build46 keeps food screens in a light appearance, uses consistent category colours, and simplifies Home and product cards while retaining nutrient values, targets and visible warnings. Swipe up on a ready camera result or tap Open to view the full food card. Diary actions use a consistent green style.

Photo portions distinguish “This photo estimate” from “Half of photo estimate”; custom amounts remain available. Older saved estimates without a proven original photo scale use “Share of saved estimate” instead. Their values are preserved without inventing a whole-photo basis or migrating existing records. Recipe and diary portion meanings remain separate.

Build47 applies the selected three-leaf Cool Mix logo to native and Web headers, onboarding and app icons. Missing automatic targets now offer a direct route from Home to the unanswered personal details or activity choice. Everyday activity appears before optional training details. Choosing an activity updates energy, carbohydrate and fat estimates through the existing save rules; skipping keeps them unset, with no guessed activity or changed formulas.

Build48 adds food-description analysis with explicit review before diary confirmation, broader catalogue browsing/ranking, and owner-submitted product corrections that require review before public catalogue use. Typed estimates use bundled official food-composition records and disclosed portion assumptions; unfamiliar descriptions can use a bounded authenticated model request. Models select sources and amounts, not nutrient values or scores. The existing score engines calculate the result. Unsupported or ambiguous evidence requires clearer text.

## Build an independent copy

Use macOS, Xcode with an iOS SDK, Python 3, and Node.js 22 or newer. The app targets iOS 16 or later and has no third-party native package dependency. The export uses `org.example.nudge` with no signing team. Choose your own unique identifier and signing team for a physical device; use separate synthetic records.

```sh
python3 tests/check_package.py
node tools/check-offline-source.cjs
xcodebuild -project Nudge.xcodeproj -scheme Nudge \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .local/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Keep the whole tree together: native JavaScriptCore adapters and the backend share `Web/core/`. Nutrition values, diary logic and scores are not separate native implementations. The offline runner uses synthetic fixtures, blocks external fetch/http/https calls, clears provider credential variables and writes ignored logs under `.local/`. It does not deploy, send login emails, or call an AI provider. Simulator compilation requires a working simulator SDK; native runtime checks are also available under `tools/check-*.sh`.

Focused measurement and nutrition-display checks are available as `tools/check-native-measurements.sh` and `tools/check-native-target-display.sh`. They compile the exact production Foundation helpers and run synthetic cases without a simulator, live data or preference writes.

The focused account harness is available as `tools/check-native-account.sh` on a Mac with Xcode and Mac Catalyst support. It compiles the account and theme sources with synthetic HTTP responses and memory session storage, then exercises authentication and the actual UIKit controls headlessly. It does not contact a live provider or access real Keychain credentials.

## Configure services

The native backend and image mirror default to the reserved `configure-nudge-backend.invalid` hostname. Set `NudgeBackendURL` in `Nudge/Info.plist` to your own HTTPS origin, then follow [Backend/README.md](Backend/README.md). Replace the example support/privacy destinations and public food-provider contact URLs before distributing your copy. No owner credentials, private data, Git history, deployment receipts or signing material are included.

First-run onboarding explains Nudge account sign-in: enter your email address, then enter the six-digit code sent by email. No password is required. Users may continue without an account and return to setup from You. Guided setup collects optional age, sex used for the energy formula, height, weight, activity and goals, then previews the resulting targets. Height accepts centimetres or feet and inches; weight accepts kilograms or stone and pounds. Saved measurements use exact cm/kg values, and existing custom or agreed targets remain authoritative. A final optional step connects an eligible ChatGPT account for both camera and photo previews; it can be skipped. Session and connection tokens use iOS Keychain. Configure and verify your own authentication provider, six-digit email codes and email delivery. No shared demo account, reviewer credentials or fixed sign-in code are distributed.

Optional **Sign in with ChatGPT** is implemented. Eligible accounts can authorise direct photo analysis from the iPhone to OpenAI. Connection credentials stay in iOS Keychain; the diary and ChatGPT conversation history are not sent with a photo request. OpenAI controls plan eligibility and available models. One ChatGPT connection is shared by plan and camera setup. Each capture retains its selected service/account/model; a failed connection does not silently switch to another provider. A separately configured backend serves account, catalogue, contribution and voice features. ChatGPT plan usage does not pay for that backend's API or transcription costs.

The implementation uses OpenAI's dynamic client registration with PKCE and an on-device loopback callback. No original operator client secret is needed for a fork. Check the current [OpenAI sign-in documentation](https://developers.openai.com/siwc/token-sharing-open-source) for your distribution model and follow its registration and usage conditions.

Install backend development dependencies using the version pinned in `Backend/package.json`: `pnpm install --frozen-lockfile` from `Backend/`. Rebuild generated adapters after shared-source changes:

```sh
node Backend/scripts/build-chatgpt-analysis.mjs
node Backend/scripts/build-fast-food-capture.mjs
node Backend/scripts/build-catalogue-refresh.mjs
node Backend/scripts/build-chatgpt-analysis.mjs --check
node Backend/scripts/build-fast-food-capture.mjs --check
```

Administrative commands require an explicit `NUDGE_ADMIN_ORIGIN`. Scheduled work, automatic enrichment and owner exemptions are disabled until you deliberately configure and verify them. Keep secrets in your own secret manager or ignored local configuration. Never commit tokens, account data, personal captures or provisioning material.

## Contributing and security

Use synthetic test data and small, reproducible changes. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Source access does not include the hosted Nudge service, an App Store entitlement, or permission to imply official endorsement. See [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md) for what was actually tested in this exported tree.
