"""Build the shared, offline source index from pinned official food data.

python3 Backend/scripts/build-meal-recovery-data.py .local/meal-data/usda-sr-legacy-2018.zip
Add --check to verify generated output without writing. No provider-generated
nutrition is admitted here. Every row retains one whole source record.
"""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SHA256 = "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0"
URL = "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip"
KEYS = ["energyKcal", "energyKj", "protein", "carbohydrate", "sugars", "fat", "saturatedFat", "fibre", "sodiumMg"]
NUTRIENTS = dict(zip(["1008", "1062", "1003", "1005", "2000", "1004", "1258", "1079", "1093"], KEYS))

def scoring_metadata(name, category, source, group):
    """Reviewed special-profile identities, not USDA's broad nutrient groups.

    Scope follows Santé publique France FAQ updated algorithm V11 pp16–20,
    28–30. The supplied name is an official catalog record, never model text.
    Unknown identities/proportions do not acquire a special profile from a
    keyword appearing somewhere in a recipe or from a broad source category.
    """
    n = name.lower().strip()
    if re.search(r"\b(coconut water|coconut drinks?|beverage|infant|babyfood|supplement|formula)\b", n):
        return ["unknown", None]
    # Dressings are general food, despite USDA putting them with oils and fats.
    if re.match(r"(?:salad dressing|creamy dressing|dressing|mayonnaise|sandwich spread)(?:,| |$)", n):
        return ["general", None]
    # Quark and plant cheese alternatives are not dairy-cheese special cases.
    if re.search(r"\b(quark|imitation cheese|cheese substitute|cheese alternative)\b", n):
        return ["general", None]
    if re.match(r"cheese(?:,| spread,| food,| product,)", n) and not re.search(r"\b(sauce|topping|dressing|dessert|sandwich|pie)\b", n):
        return ["cheese", False]
    if re.match(r"(?:beef|pork|lamb|mutton|veal|venison|goat|horse|bison)(?:,| )", n) or re.match(r"game meat, (?:deer|elk|moose|caribou|antelope|boar|bison|bear)(?:,| )", n):
        # Explicitly exclude complete dishes. A cooked cut or mince is still a
        # meat product; free-standing 'stew' is not the preparation 'stewed'.
        dish_name = n.replace("for stew", "for braising").replace("sandwich steaks", "thin steaks")
        if not re.search(r"\b(stew|chili|chilli|curry|casserole|soup|pie|pasta|rice|lasagne|lasagna|sandwich|dinner)\b", dish_name):
            return ["red_meat", False]
        return ["general", None]
    if re.search(r"\b(rabbit|hare)\b", n) and group == "red_meat":
        return ["general", False]
    if re.match(r"(?:nuts, )?chestnuts?\b", n):
        return ["general", None]
    # Explicit nut/seed catalog identities. Formulated wheat 'nuts', almond
    # paste and glazed mixtures lack the reviewed >50% nut/seed evidence.
    nut = re.match(r"(?:nuts, )?(?:almonds?|brazilnuts?|brazil nuts?|cashew(?: nuts?| butter)?|coconuts?|coconut (?:meat|milk|cream)|hazelnuts?|macadamia nuts?|pecans?|pistachio nuts?|pine nuts?|walnuts?|mixed nuts)(?:,| |$)", n)
    seed = re.match(r"(?:seeds, )?(?:sesame|sunflower|pumpkin|squash|flaxseed|chia|hemp|safflower|cottonseed|poppy)(?:,| |$)", n)
    peanut = re.match(r"peanuts?(?:,| |$)|peanut butter(?:,| |$)", n)
    if (nut or seed or peanut) and not re.search(r"\b(formulated|paste|glazed|sweetened|honey|sauce|dressing|candy|chocolate|confection)\b", n):
        return ["fats_nuts_seeds", False]
    # Whole-source oil identities: qualifying entire-fruit/legume oils need a
    # separate FVL property because oil is excluded in the general meal model.
    if re.match(r"(?:oil|vegetable oil|fish oil),", n):
        if re.search(r"\b(spray|lecithin|diglycerides)\b", n): return ["unknown", None]
        if re.match(r"oil, (?:olive|avocado|soybean|soya)(?:,|$)", n) and not re.search(r"\band\b|cottonseed|corn|peanut|palm", n):
            return ["fats_nuts_seeds", True]
        if re.match(r"(?:fish oil,|oil, (?:flaxseed|rice bran|wheat germ|wheatgerm|palm|sesame|sunflower|safflower|cottonseed|grapeseed|corn|walnut|almond|apricot kernel|peanut|coconut|cocoa butter|poppyseed|hazelnut|babassu|sheanut|canola|rapeseed|mustard|nutmeg butter|evening primrose|cod liver)(?:,|$))", n) and not re.search(r"\band (?!over\b)|olive|avocado|soybean|soya", n):
            return ["fats_nuts_seeds", False]
        return ["fats_nuts_seeds", None]
    if re.match(r"(?:butter|butteroil|butter oil|ghee|lard|fat|animal fat|cream|sour cream|creme fraiche)(?:,|$)", n) and not re.search(r"\b(coffee|substitute|replacement|dessert|topping|flavoured|flavored|sweetened)\b", n):
        return ["fats_nuts_seeds", False]
    if re.match(r"(?:margarine|margarine-like|shortening|cooking fat|baking fat|fat spread|vegetable oil-butter spread)(?:,| |$)", n):
        return ["fats_nuts_seeds", None]
    if group in ["fruit", "vegetable", "legume", "grain", "poultry", "fish", "egg", "mixed_dish"]:
        return ["general", None]
    return ["unknown", None]

def metadata(name, category, source):
    """Classify SOURCE identities only. Unknown categories remain unsupported.

    These coarse groups control scoring scope, never observed plant identities.
    Composite vegetable recipes never acquire 100% FVL from a broad food group.
    """
    n = name.lower()
    if re.search(r"\b(juice|beverage|drink|milk|coffee|tea|water)\b", n.split(',')[0]):
        return ["beverage", None]
    if n.startswith(("cheese", "parmesan", "cheddar", "mozzarella")):
        return ["cheese", False]
    if n.startswith(("egg,", "eggs,")) and not re.search(r"substitute|replacer", n):
        return ["egg", False]
    # USDA catalogs peanuts among legumes; the scoring algorithm puts them
    # with nuts/seeds and excludes them from the general FVL component.
    if re.match(r"peanuts?(?:,| |$)|peanut butter(?:,| |$)", n):
        return ["nuts_seeds", False]
    if source == "u":
        group = {"2": "vegetable", "4": "fat_oil", "5": "poultry", "9": "fruit", "10": "red_meat", "11": "vegetable", "12": "nuts_seeds", "13": "red_meat", "15": "fish", "16": "legume", "17": "red_meat", "20": "grain"}.get(category, "unknown")
        if "noodle" in n: group = "grain"
    else:
        group = "fish" if category == "16" else "unknown"
        if category == "18":
            group = "poultry" if re.match(r"(chicken|turkey|duck|goose|guinea fowl|pheasant|quail)", n) else "red_meat"
        if re.match(r"(rice|pasta|spaghetti|noodles|barley|oats|quinoa|couscous|bulgur|buckwheat)(?:,| )", n): group = "grain"
    fvl = False if group in ["grain", "egg", "red_meat", "poultry", "fish", "nuts_seeds", "fat_oil"] else None
    if group in ["fruit", "vegetable", "legume"]:
        # Starchy tubers are explicitly outside the algorithm's FVL category.
        # FoodData Central groups them with vegetables for a different purpose.
        if re.search(r"\b(potato|potatoes|yam|yams|cassava|taro|tapioca|arrowroot)\b", n):
            return [group, False]
        # Conservative whole-food records only; prepared recipes have unknown FVL.
        if not re.search(r"sauce|soup|juice|flour|starch|tofu|hummus|hummous|refried|fried|pudding|extract|concentrate|bread|babyfood|with (?!salt|added salt)|in (?!water)|sweetened|sugar|syrup|oil|fat|dried|dehydrated", n) and (category != "2" or re.search(r"\b(raw|fresh)\b", n)):
            fvl = True
    return [group, fvl]

def build(archive_path):
    archive = Path(archive_path).read_bytes()
    if hashlib.sha256(archive).hexdigest() != SHA256:
        raise SystemExit("Unexpected USDA archive hash; review the official source before importing")
    cofid_bytes = (ROOT / "Backend/data/cofid-2021.json").read_bytes()
    cofid = json.loads(cofid_bytes)
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        def rows(filename):
            path = next(n for n in z.namelist() if n.endswith('/' + filename))
            return csv.DictReader(io.TextIOWrapper(z.open(path), encoding="utf-8"))
        foods = {r['fdc_id']: r for r in rows('food.csv')}
        numbers = {r['fdc_id']: r['NDB_number'] for r in rows('sr_legacy_food.csv')}
        values = {fid: {} for fid in foods}
        for r in rows('food_nutrient.csv'):
            if r['fdc_id'] not in values or r['nutrient_id'] not in NUTRIENTS: continue
            key = NUTRIENTS[r['nutrient_id']]
            if key in values[r['fdc_id']]: raise ValueError('Duplicate source nutrient requires review')
            values[r['fdc_id']][key] = r['amount']
    # Tuple fields: id, source c/u, code, name, description, reference, group,
    # FVL eligibility, raw nutrients, reviewed special profile, special-oil FVL.
    # Null/Tr never become 0. Existing nutrient indices remain stable.
    records = []
    for r in cofid['foods']:
        group, fvl = metadata(r['name'], r['code'].split('-')[0], 'c')
        records.append([r['id'], 'c', r['code'], r['name'], r['description'], r['reference'], group, fvl, [r['values'].get(k) for k in KEYS], *scoring_metadata(r['name'], r['code'].split('-')[0], 'c', group)])
    for fid, r in sorted(foods.items()):
        group, fvl = metadata(r['description'], r['food_category_id'], 'u')
        records.append(['usda:' + fid, 'u', fid, r['description'], 'USDA SR Legacy, per 100 g edible food in the named preparation', 'NDB ' + numbers.get(fid, ''), group, fvl, [values[fid].get(k) for k in KEYS], *scoring_metadata(r['description'], r['food_category_id'], 'u', group)])
    result = {'version': 'meal-recovery-data-v2', 'scoringProfileVersion': 'meal-source-profiles-v1', 'keys': KEYS,
              'sources': {'c': {'name': 'UK CoFID', 'version': cofid['version'], 'url': cofid['sourceURL'], 'licenceURL': cofid['licenceURL'], 'sha256': hashlib.sha256(cofid_bytes).hexdigest(), 'attribution': cofid['attribution']},
                          'u': {'name': 'USDA SR Legacy', 'version': 'USDA-SR-Legacy-2018-full-v1', 'url': URL, 'licenceURL': 'https://fdc.nal.usda.gov/data-documentation/', 'sha256': SHA256, 'attribution': 'USDA Agricultural Research Service, FoodData Central, SR Legacy April 2018 release. Public domain data.'}},
              'records': records}
    return '/* Generated by Backend/scripts/build-meal-recovery-data.py; do not edit. */\n(function(root){\nconst data=' + json.dumps(result, ensure_ascii=False, separators=(',', ':')) + ';\nroot.NudgeMealRecoveryData=data;if(typeof module===\'object\'&&module.exports)module.exports=data;\n})(typeof window===\'object\'?window:globalThis);\n'

if __name__ == '__main__':
    result = build(sys.argv[1])
    destination = ROOT / 'Web/core/meal-recovery-data.js'
    if '--check' in sys.argv:
        if destination.read_text() != result: raise SystemExit('Source index differs; regenerate it')
        print('Shared source index matches the pinned official records')
    else:
        destination.write_text(result)
        print(f'Wrote {destination.name}: {len(result.encode())} bytes')
