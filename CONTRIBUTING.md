# Contributing

Keep deterministic nutrition and diary rules in the shared `Web/core/` engines. Preserve source attribution, distinguish measured data from estimates, and keep unknown values distinct from zero. Use explicit confirmation before adding intake.

Run `python3 tests/check_package.py` and `node tools/check-offline-source.cjs` for affected changes. Rebuild generated adapters with the documented scripts after changing their inputs. Run relevant native checks on macOS, and record limitations honestly. Use only synthetic records and independent services; never include personal diaries, photos, tokens or signing material in an issue, fixture or pull request.

Contributions of original code are under the project's MIT licence. Retain the separate licences of food data, icons and other third-party material. Identify the source and redistribution terms of any new third-party asset. Security issues follow `SECURITY.md`.
