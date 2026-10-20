#!/bin/bash
set -euo pipefail
umask 077
food_image_repo="$(cd "$(dirname "$0")/.." && pwd)"
food_image_run="$(mktemp -d /private/tmp/nudge-food-image-check-XXXXXX)"
food_image_sdk="$(xcrun --sdk macosx --show-sdk-path)"
food_image_arch="$(uname -m)"
python3 - "$food_image_repo" "$food_image_run" <<'PY'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:])
source=(root/'Nudge/SmartFoodCamera.swift').read_text()
start=source.index('enum CameraLibraryPhoto {')
end=source.index('\n/// A camera session accepts each barcode once',start)
exact=source[start:end]
(run/'CameraLibraryPhoto.swift').write_text('import Foundation\nimport UIKit\nimport ImageIO\nimport UniformTypeIdentifiers\n'+exact)
files=['Nudge/SmartFoodCamera.swift','Nudge/LocalFoodLabelParser.swift','Nudge/VisionFoodTextRecognizer.swift','Nudge/FoodTextImagePreparation.swift','tools/food-text-image-check.swift']
(run/'source-evidence.json').write_text(json.dumps({'sources':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in files},'productionEncoderSHA256':hashlib.sha256(exact.encode()).hexdigest(),'limits':['The CameraLibraryPhoto enum is extracted byte-exact; only imports are added.']},indent=2)+'\n')
PY
xcrun swiftc -swift-version 5 -target "$food_image_arch-apple-ios16.0-macabi" -sdk "$food_image_sdk" \
  -F "$food_image_sdk/System/iOSSupport/System/Library/Frameworks" -I "$food_image_sdk/System/iOSSupport/usr/include" \
  -L "$food_image_sdk/System/iOSSupport/usr/lib" -module-cache-path "$food_image_run/modules" \
  "$food_image_run/CameraLibraryPhoto.swift" "$food_image_repo/Nudge/LocalFoodLabelParser.swift" \
  "$food_image_repo/Nudge/VisionFoodTextRecognizer.swift" "$food_image_repo/Nudge/FoodTextImagePreparation.swift" \
  "$food_image_repo/tools/food-text-image-check.swift" -o "$food_image_run/check"
"$food_image_run/check" "$food_image_run" "$@"
python3 - "$food_image_repo" "$food_image_run" <<'PYHASH'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:]);p=run/'source-evidence.json';e=json.loads(p.read_text())
source=(root/'Nudge/SmartFoodCamera.swift').read_text();a=source.index('enum CameraLibraryPhoto {');b=source.index('\n/// A camera session accepts each barcode once',a)
e['productionEncoderUnchanged']=hashlib.sha256(source[a:b].encode()).hexdigest()==e['productionEncoderSHA256']
e['sourcesUnchanged']=all(hashlib.sha256((root/n).read_bytes()).hexdigest()==h for n,h in e['sources'].items() if n!='Nudge/SmartFoodCamera.swift')
p.write_text(json.dumps(e,indent=2)+'\n');assert e['productionEncoderUnchanged'] and e['sourcesUnchanged'],'Relevant sources changed during check'
PYHASH
echo "Food image checks retained at: $food_image_run"
