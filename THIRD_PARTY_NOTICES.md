# Third-party material — review inventory

Original Nudge code and documentation use the root MIT licence, copyright 2026 Stephanie Griffiths. This file records separate third-party terms and provenance. Lucide, USDA and Open Food Facts primary licence pages were checked on 20 October 2026. The code licence does not replace any data licence or grant rights to third-party marks.

## Lucide / Feather icons

`Web/assets/icons/` contains Lucide icons. The original complete notice remains in `Web/assets/icons/LICENSE.txt`: ISC for Lucide, and MIT notices for the identified Feather-derived icons. Retain both notices. [Official Lucide licence](https://lucide.dev/license).

## CoFID / UK public-sector food data

CoFID-derived material appears in `Backend/data/cofid-2021.json`, `Web/data/meal-reference.json`, `Web/recipe-catalogue-data.js` and the generated `Web/core/meal-recovery-data.js`. Existing metadata preserves the source release, hashes, licence links and this attribution:

> Contains public sector information licensed under the Open Government Licence v3.0.

Crown copyright. McCance and Widdowson's Composition of Foods Integrated Dataset 2021, Public Health England. Source records were selected, normalised and sometimes combined into Nudge calculations; Nudge's interpretations are not government endorsement. Retain source/attribution details and the OGL link. Review third-party exclusions in the source before redistribution. [Official dataset and guide](https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid), [OGL framework and attribution guidance](https://www.nationalarchives.gov.uk/information-management/re-using-public-sector-information/uk-government-licensing-framework/open-government-licence/), [OGL v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

## USDA FoodData Central

`Backend/data/usda-meal-fallbacks.json`, `Backend/data/usda-recipe-measures.json` and the USDA portion of `Web/core/meal-recovery-data.js` derive from the SR Legacy April 2018 release. USDA states that FoodData Central data are public domain and published under CC0 1.0; it requests source attribution. Credit: USDA Agricultural Research Service, FoodData Central, SR Legacy April 2018. Preserve the source records, versions and hashes. [USDA licensing statement](https://fdc.nal.usda.gov/api-guide/).

## Open Food Facts

Open Food Facts-derived product fixtures and catalogue material appear in `Nudge/NudgeCatalogueSeed.json`, `Backend/test/fixtures/`, `tests/fixtures/`, and data obtained by the import scripts. Attribute Open Food Facts and its contributors; retain product source and licence URLs and identify Nudge's adaptations. This material is not relicensed under the Nudge code licence. The included adapted database and exported Open Food Facts product contents remain available under ODbL 1.0 and the Database Contents License respectively; the complete included JSON is the preferred editable form. Nudge computed ratings and normalisation are adaptations, not Open Food Facts endorsements.

The official documentation identifies the database licence as ODbL, individual database contents as the Database Contents License, and product images as Creative Commons Attribution ShareAlike. The linked image licence is CC BY-SA 3.0. Comply with applicable attribution and share-alike conditions for redistributed/adapted material. Product packaging may also contain third-party rights; the data licence is not blanket clearance for brand graphics. The included seed contains 200 product records in ten attributed catalogue batches, each retaining the Open Food Facts source and ODbL link. No product photo binaries are included in that seed; its image URLs refer to the separately licensed provider images. [Official API reuse terms and licence links](https://openfoodfacts.github.io/openfoodfacts-server/api/#before-you-start), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), [Database Contents License 1.0](https://opendatacommons.org/licenses/dbcl/1-0/), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

## Other datasets and references

`Backend/data/womens-food-tagging.v1.json`, `Web/core/places.v1.json` and other recipe/rule/fixture files contain curated rules, factual source references or product names. The included rule implementation and factual place taxonomy are original application material; source links identify supporting publications, not redistributed publications. No rights to those external publications are granted. Food values derived from CoFID, USDA or Open Food Facts keep the licences above, even when used in rules or examples.

## Artwork and dependencies

The original included Nudge mascot, celebration pose, garden, blueberry and illustrative food images were generated for this project and are retained. Build47 replaces the former mascot/monogram app icons and sprout branding with generated three-leaf Cool Mix artwork based on the user-selected 04 reference; the same master supplies the native and Web marks and icons. Their recorded provenance is in ASSET_PROVENANCE.json. Original included artwork is licensed under the root MIT terms, with no trademark or endorsement grant. Two copied third-party images (a manufacturer chocolate pack and a user-supplied app screenshot) are omitted and replaced with a plain reference notice. Product names and marks remain their owners' marks; generated packaging is illustrative and implies no endorsement.

Native code uses Apple SDKs supplied by Xcode, not redistributed by this candidate. The backend lockfile records development dependencies. No node_modules tree is included; each dependency retains its own licence when installed. The source export does not redistribute installed dependencies. DEPENDENCY_INVENTORY.json records the locally installed build-tool package licences used for verification, while the lockfile pins the supported installation. Generated app adapters bundle original project modules and source data, not third-party Node runtime packages; their source manifests record the inputs.
