"""Import a small, audited subset of the official USDA SR Legacy CSV archive.

Usage: python3 scripts/import-usda-meal-fallbacks.py path/to/archive.zip
Downloads stay outside source control. Missing fields remain missing, never zero.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

SOURCE = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
SHA256 = "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0"
# Explicit IDs prevent loose text matching or future archive changes selecting a recipe.
IDS = {"168409": True, "168462": True, "168463": True, "169134": True,
       "168910": False, "168928": False, "169704": False, "169757": False,
       "170005": True, "170108": True, "170427": True, "171413": False,
       "172421": True, "172475": None, "172476": None, "173757": True,
       "175168": False}
NUTRIENTS = {"1008": "energyKcal", "1062": "energyKj", "1003": "protein",
             "1005": "carbohydrate", "2000": "sugars", "1004": "fat",
             "1258": "saturatedFat", "1079": "fibre", "1093": "sodiumMg"}

def main():
    archive = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(archive).hexdigest() != SHA256:
        raise SystemExit("Unexpected USDA archive hash; review source before importing")
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        def rows(filename):
            name = next(name for name in z.namelist() if name.endswith("/" + filename))
            return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8")))
        foods = {r["fdc_id"]: r for r in rows("food.csv") if r["fdc_id"] in IDS}
        numbers = {r["fdc_id"]: r["NDB_number"] for r in rows("sr_legacy_food.csv") if r["fdc_id"] in IDS}
        values = {fid: {} for fid in IDS}
        for r in rows("food_nutrient.csv"):
            if r["fdc_id"] in IDS and r["nutrient_id"] in NUTRIENTS:
                key = NUTRIENTS[r["nutrient_id"]]
                if key in values[r["fdc_id"]]:
                    raise ValueError("Duplicate nutrient requires source review")
                values[r["fdc_id"]][key] = r["amount"]
    result = {"version": "USDA-SR-Legacy-2018-meal-subset-v1", "sourceURL": SOURCE,
              "sourceSHA256": SHA256, "retrievedAt": "2026-10-03",
              "licenceURL": "https://fdc.nal.usda.gov/data-documentation/",
              "attribution": "USDA Agricultural Research Service, FoodData Central, SR Legacy April 2018 release. Public domain data.",
              "basis": "per 100 g edible food in the named preparation",
              "carbohydrateDefinition": "USDA carbohydrate by difference includes dietary fibre; do not treat this as UK available carbohydrate.",
              "fibreDefinition": "USDA total dietary fibre; whole records are used, not spliced into CoFID records.",
              "foods": [{"id": "usda:" + fid, "code": fid, "ndbCode": numbers[fid],
                         "name": foods[fid]["description"], "publishedAt": foods[fid]["publication_date"],
                         "fvlEligible": IDS[fid], "values": values[fid]}
                        for fid in sorted(IDS)]}
    destination = Path(__file__).resolve().parents[1] / "data/usda-meal-fallbacks.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"Imported {len(result['foods'])} verified USDA records")

if __name__ == "__main__":
    main()
