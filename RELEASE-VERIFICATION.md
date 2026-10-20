# Source release verification — 0.1.1 (37)

Checked on 20 October 2026 against the sanitised source tree. This document records local source checks, not App Store processing, TestFlight acceptance or production service availability.

- Package/project/resource/plist checks passed, including the final build37 metadata and privacy declarations.
- All 108 Web/shared test-suite scripts passed with external fetch/http/https requests denied and synthetic fixtures.
- Backend suite: 830 tests passed; zero failed, cancelled or skipped.
- Export configuration checks passed: all eight administrator commands reject a missing destination, and malformed/untrusted origins are rejected before credential access.
- All three generated JavaScript tools rebuilt successfully from the sanitised source. ChatGPT and fast-capture builders passed their `--check` modes. All 68 source-pin entries across the three manifests match, and each output hash matches its manifest.
- The nine Swift files changed for export configuration passed parser checks. All twelve included Python files passed syntax checks. Parsing is not native type checking or a device test.
- Original shared scoring code is byte-for-byte unchanged. The native privacy manifest is identical to the frozen shipping build37 source, including Health and Device ID collection declarations.
- Dependency inventory: 36 locally installed development/build packages recorded, each with licence metadata. Installed dependencies are not included in this source tree.
- The allowlisted export includes no Git history, credentials, signing material, device backups or personal captures. Owner endpoints and identifiers were replaced with explicit independent configuration. Pattern scans found no known credential/owner patterns; credential-looking URLs in negative security tests were manually identified as synthetic rejection fixtures. Pattern scanning is bounded, not a proof that arbitrary sensitive content can never exist.
- Original generated artwork provenance and hashes are recorded in ASSET_PROVENANCE.json. Two copied third-party reference images are excluded. Food data and icon notices retain their separate licences.

An independent unsigned native Release build was started, then cancelled to avoid competing with the App Store archive and screenshot compilation on the same Mac. It reported no source error before cancellation, but did not complete, so no independent native compile pass is claimed here. The documented build command remains available for a sequential clean-checkout build.

Live email delivery, account lifecycle, model eligibility, food recognition, a fork's hosted service and real-device behaviour were not exercised by this source-export validation. The source defaults to unconfigured origins and intentionally cannot reuse the original operator's credentials.
