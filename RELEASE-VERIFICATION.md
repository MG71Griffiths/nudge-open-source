# Source release verification — 0.1.1 (48)

This source snapshot is separate from hosted-service deployment, TestFlight availability and App Store approval.

Food descriptions can produce a rated nutrition estimate from generic official food-composition references. Common supported descriptions work locally. Other descriptions use one bounded authenticated model call when permitted; the model selects candidate sources and gram amounts, while the existing deterministic composition and score engines calculate nutrition and the rating. Explicit amounts, exclusions, food identity, preparation and material ingredient coverage are checked. Unsupported or ambiguous descriptions require clarification. All inferred portions remain visible estimates. Review is separate from diary confirmation, and repeated confirmation shares an identity to prevent duplicate intake.

The update also changes catalogue browsing/ranking and user contribution review. Contributions do not directly overwrite public catalogue facts. These flows require independently configured services in a fork.

The export retains the reviewed independent-service and example-identity substitutions: reserved .invalid service defaults, an example app identifier, no signing team, no active scheduled enrichment and no operator credentials. Administrative CLIs retain their explicit destination guard. Private development history, records, screenshots, diagnostics, provisioning material and the two previously excluded reference images are absent. Existing MIT licensing, third-party attribution and artwork provenance remain.

## Export verification results

The final sanitized export passed 397 Web/shared tests, 885 backend tests, 59 Python checks and package/configuration checks. An initial forced-jitless backend run encountered SQLite temporary-disk exhaustion; the unchanged isolated fixture and complete backend suite passed with the normal Node configuration. Previously passed Swift parsing and 31 focused native description-transport assertions were reused only after every Swift file and all five transport/harness inputs matched the audited earlier candidate byte for byte. External network access was denied during offline JavaScript checks; the native harness uses intercepted synthetic HTTP and inert account adapters. Generated-source pins, including the rebuilt catalogue tool, are verified against this candidate. The explicit administrative destination guard was retained.

These checks do not constitute a full native app build of the sanitized export, live provider inference, an independent fork's account lifecycle, physical-device UI verification or app distribution. Shipping verification is recorded separately. Bounded known-pattern scans are not a proof that arbitrary sensitive content can never exist.
