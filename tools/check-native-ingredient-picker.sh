#!/bin/bash
# Exercise production picker interaction state with synthetic ingredients only.
set -euo pipefail
umask 077
picker_repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$picker_repo/.local/native-ingredient-picker-checks"
picker_run="$(mktemp -d "$picker_repo/.local/native-ingredient-picker-checks/check-XXXXXX")"
python3 - "$picker_repo" "$picker_run" <<'PY'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:])
path=root/'Nudge/NativeMealIngredientPicker.swift'
source=path.read_text()
start=source.index('struct NativeMealIngredientPickerDraft {')
end=source.index('\n/// The catalogue and draft stay local',start)
(run/'PickerDraft.swift').write_text('import Foundation\n'+source[start:end]+'\n')
(run/'source-evidence.json').write_text(json.dumps({
    'productionSource':str(path.relative_to(root)),
    'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
    'limits':['Exercises the unmodified production selection/search state with synthetic ingredients.',
              'SwiftUI layout and keyboard focus are covered by app compilation, not this command-line check.']
},indent=2)+'\n')
PY
xcrun swiftc -swift-version 5 -module-cache-path "$picker_run/modules" \
  "$picker_run/PickerDraft.swift" "$picker_repo/tools/native-ingredient-picker-check.swift" \
  -o "$picker_run/check"
"$picker_run/check" | tee "$picker_run/results.log"
python3 - "$picker_repo" "$picker_run" <<'PY'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:])
path=run/'source-evidence.json'
evidence=json.loads(path.read_text())
assert hashlib.sha256((root/evidence['productionSource']).read_bytes()).hexdigest()==evidence['sha256']
evidence['productionSourceStillMatchesAfterRun']=True
path.write_text(json.dumps(evidence,indent=2)+'\n')
PY
echo "Ingredient picker checks retained at: $picker_run"
