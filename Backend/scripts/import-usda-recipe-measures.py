"""Import reviewed recipe household measures and whole nutrient records.

Usage: python3 scripts/import-usda-recipe-measures.py path/to/archive.zip
No measurement is a claim about the user's actual ingredient size or brand.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

SHA256 = "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0"
SOURCE = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
IDS = {"167747", "170000", "171287", "172217", "173424", "170173", "170108", "170497", "171413", "172336", "172370", "169640", "169655"}
PORTIONS = {"81887", "81888", "85858", "85860", "85862", "88374", "88375", "88376", "88378", "88379", "90101", "90102", "90103", "92500", "86171", "86172", "86065", "86066", "86067", "88667", "90374", "90462", "85265", "85287"}
NUTRIENTS = {"1008": "energyKcal", "1062": "energyKj", "1003": "protein", "1005": "carbohydrate", "2000": "sugars", "1004": "fat", "1258": "saturatedFat", "1079": "fibre", "1093": "sodiumMg"}

def main():
    archive = Path(sys.argv[1]).read_bytes()
    if hashlib.sha256(archive).hexdigest() != SHA256:
        raise SystemExit("Unexpected USDA archive hash")
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        def rows(file):
            name = next(n for n in z.namelist() if n.endswith("/" + file))
            return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8")))
        foods = {r["fdc_id"]: r for r in rows("food.csv") if r["fdc_id"] in IDS}
        ndb = {r["fdc_id"]: r["NDB_number"] for r in rows("sr_legacy_food.csv") if r["fdc_id"] in IDS}
        values = {fid: {} for fid in IDS}
        for r in rows("food_nutrient.csv"):
            if r["fdc_id"] in IDS and r["nutrient_id"] in NUTRIENTS:
                key = NUTRIENTS[r["nutrient_id"]]
                if key in values[r["fdc_id"]]:
                    raise ValueError("Duplicate nutrient")
                values[r["fdc_id"]][key] = r["amount"]
        portions = [r for r in rows("food_portion.csv") if r["id"] in PORTIONS]
        if len(portions) != len(PORTIONS):
            raise ValueError("Missing reviewed portion rows")
    result = {"version": "USDA-SR-Legacy-2018-recipe-measures-v2", "sourceURL": SOURCE, "sourceSHA256": SHA256,
        "licenceURL": "https://fdc.nal.usda.gov/data-documentation/", "retrievedAt": "2026-10-11",
        "unitSourceURL": "https://www.nist.gov/document/2026-nist-handbook-44-appendix-c",
        "unitBasis": "NIST: US fluid ounce approximately 29.573 ml; tablespoon exactly half a US fluid ounce; teaspoon one third tablespoon.",
        "attribution": "USDA Agricultural Research Service, FoodData Central, SR Legacy April 2018. Public domain data.",
        "foods": [{"id": "usda:" + fid, "code": fid, "ndbCode": ndb[fid], "name": foods[fid]["description"], "values": values[fid]} for fid in sorted(IDS)],
        "portions": [{"id": r["id"], "foodId": "usda:" + r["fdc_id"], "amount": float(r["amount"]), "measure": r["modifier"], "gramWeight": float(r["gram_weight"])} for r in portions]}
    destination = Path(__file__).resolve().parents[1] / "data/usda-recipe-measures.json"
    destination.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Imported {len(result['foods'])} whole food records and {len(portions)} reviewed household measures")

if __name__ == "__main__":
    main()
