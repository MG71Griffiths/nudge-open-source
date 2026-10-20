# Source release verification — 0.1.1 (38)

Checked on 20 October 2026 against the sanitised source tree. App Store approval and public app availability are separate from source publication.

Build38 changes the Xcode build number and adds a packaging phase that excludes two unused development reference images from the built app. The public source already excluded those images. The phase declares exactly those two output paths, runs after resource copying, preserves script sandboxing, and verifies their absence. Swift, Web, backend, scoring, tests, generated adapters, privacy declarations, licences and all distributed asset bytes are unchanged from source release37.

Focused build38 checks:

- Package/project/resource/plist checks passed with build38 metadata.
- The exported packaging script passed a temporary-copy check: it removed only the two synthetic excluded paths, preserved every other Web file byte-for-byte, and passed a second run with the paths already absent.
- Both build configurations use version38; the example bundle identifier and blank signing team remain in place.
- All 68 source-pin entries and output hashes across the three generated manifests still match. All original artwork hashes still match their provenance records.
- The 540-file tree preserves the previous public file allowlist. Pattern scanning found no known credential/owner patterns; credential-looking URLs in negative security tests remain documented synthetic rejection fixtures. Pattern scanning is bounded, not a proof that arbitrary sensitive content can never exist.

Separately, the signed production archive and exported App Store distribution package were verified as build38. Their 126 bundled Web files match the frozen production source after excluding exactly the two reference images; signature, privacy-manifest and absence-of-test-host checks passed. This verifies the production packaging fix, not an independent compile of the exported configuration or Apple review approval.

Validation inherited from the unchanged build37 source, not rerun for this packaging-only update:

- All 108 Web/shared test-suite scripts passed with external fetch/http/https requests denied and synthetic fixtures.
- Backend suite: 830 tests passed; zero failed, cancelled or skipped.
- Export configuration checks passed: all eight administrator commands reject a missing destination, and malformed/untrusted origins are rejected before credential access.
- All three generated JavaScript tools rebuilt successfully; ChatGPT and fast-capture builders passed their `--check` modes.
- Nine Swift files changed for export configuration passed parser checks; all twelve included Python files passed syntax checks. Parsing is not native type checking or a device test.
- Dependency inventory: 36 development/build packages recorded, each with licence metadata. Installed dependencies are not distributed.

The independent unsigned native Release build for source37 was cancelled to avoid competing with App Store archive and screenshot compilation on the same Mac. It did not complete, so no independent native compile pass is claimed for this exported tree. No additional native compilation was attempted for the unchanged app source in this update. The README retains a clean-checkout build command.

The native privacy manifest still includes Health and Device ID collection declarations. The allowlisted export contains no private Git history, credentials, signing material, device backups or personal captures. Owner endpoints and identifiers require independent configuration. Original generated artwork provenance and hashes remain in ASSET_PROVENANCE.json; food data and icon notices retain their separate licences.

Live email delivery, account lifecycle, model eligibility, food recognition, a fork's hosted service and real-device behaviour were not exercised by source-export validation. The source defaults to unconfigured origins and cannot reuse the original operator's credentials.
