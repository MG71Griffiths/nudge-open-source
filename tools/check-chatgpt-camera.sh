#!/bin/bash
# Production coordinator/store/outbox checks with synthetic inputs and inert services.
set -euo pipefail
umask 077
camera_repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$camera_repo/.local/native-capture-checks"
camera_run="$(mktemp -d "$camera_repo/.local/native-capture-checks/coordinator-check-XXXXXX")"
camera_sdk="$(xcrun --sdk macosx --show-sdk-path)"
camera_arch="$(uname -m)"
python3 - "$camera_repo" "$camera_run" <<'PY'
import hashlib,json,pathlib,plistlib,shutil,sys
root,run=map(pathlib.Path,sys.argv[1:]); src=run/'sources';src.mkdir()
changes={}
for path in sorted((root/'Nudge').glob('*.swift')):
    original=path.read_text();value=original
    if path.name=='NudgeApp.swift':
        value='import SwiftUI\n'+original[original.index('struct NudgeShellStatus:'):]
    if path.name=='AnalysisDiagnostics.swift':
        old='static let shared = AnalysisDiagnostics(deferredWrites: true)'
        assert old in value
        value=value.replace(old,'static let shared = AnalysisDiagnostics(directory: CameraCheckEnvironment.root.appendingPathComponent("Diagnostics"), deferredWrites: false)',1)
    if path.name=='AccountFeature.swift':
        start=value.index('    static let shared = NudgeAccountManager(')
        end=value.index('\n\n',start)
        value=value[:start]+'    static let shared = NudgeAccountManager(store: CameraCheckAccountStore(), transport: CameraCheckAccountTransport())'+value[end:]
    if path.name=='ChatGPTConnection.swift':
        old='static let shared = ChatGPTConnection()';assert old in value
        value=value.replace(old,'static let shared = ChatGPTConnection(session: CameraCheckEnvironment.blockedSession, loadVault: { ChatGPTVault() }, saveVault: { _ in })',1)
    if path.name=='BarcodeFeature.swift':
        start=value.index('@MainActor\nfinal class BarcodeScannerViewController:')
        end=value.index('/// Public official notices only.',start)
        value=value[:start]+'@MainActor\nfinal class BarcodeScannerViewController: UIViewController {\n    weak var delegate: BarcodeScannerViewControllerDelegate?\n}\n\n'+value[end:]
    # Environmental sinks only: never touch the owner's Mac app directories/preferences.
    value=value.replace('FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]', 'CameraCheckEnvironment.root.appendingPathComponent("Support")')
    value=value.replace('FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]', 'CameraCheckEnvironment.root.appendingPathComponent("Caches")')
    value=value.replace('UserDefaults.standard','CameraCheckEnvironment.defaults')
    value=value.replace('UserDefaults = .standard','UserDefaults = CameraCheckEnvironment.defaults')
    value=value.replace('defaults: .standard','defaults: CameraCheckEnvironment.defaults')
    (src/path.name).write_text(value)
    changes[path.name]={'productionSHA256':hashlib.sha256(original.encode()).hexdigest(),'compiledSHA256':hashlib.sha256(value.encode()).hexdigest(),'environmentOnlyAdaptation':original!=value}
for name in ['NativeCaptureCoordinator.swift','NativeCaptureOutbox.swift','NativeAppStore.swift','ChatGPTCaptureProtocol.swift','FastCaptureSupport.swift','LocalFoodLabelParser.swift','VisionFoodTextRecognizer.swift','FoodTextImagePreparation.swift','FoodBarcodeIdentity.swift','FoodBarcodeEntry.swift']:
    assert changes[name]['productionSHA256']==changes[name]['compiledSHA256'],name+' must compile byte-exact'
bundle=run/'Check.bundle';resources=bundle/'Contents/Resources';resources.mkdir(parents=True)
with (bundle/'Contents/Info.plist').open('wb') as out:plistlib.dump({'CFBundleIdentifier':'test.nudge.camera-check','CFBundleName':'CameraCheck','CFBundlePackageType':'BNDL','CFBundleVersion':'1'},out)
shutil.copytree(root/'Web',resources/'Web')
web={str(path.relative_to(resources/'Web')):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((resources/'Web').rglob('*')) if path.is_file()}
(run/'source-evidence.json').write_text(json.dumps({'files':changes,'webFiles':web,'limits':['Only singleton/environment sinks, app entry point and unused iOS-only barcode scanner UI are adapted in temporary copies.','Coordinator, outbox, native store and binding source are byte-exact production files.','Web inputs are snapshotted into the private bundle and hashed.','All account storage and HTTP are inert; synthetic app data stays in this run.']},indent=2)+'\n')
PY
camera_sources=()
while IFS= read -r -d '' camera_source; do camera_sources+=("$camera_source"); done < <(find "$camera_run/sources" -name '*.swift' -print0)
if ! xcrun swiftc -swift-version 5 -target "$camera_arch-apple-ios16.0-macabi" -sdk "$camera_sdk" \
  -F "$camera_sdk/System/iOSSupport/System/Library/Frameworks" -I "$camera_sdk/System/iOSSupport/usr/include" \
  -L "$camera_sdk/System/iOSSupport/usr/lib" -module-cache-path "$camera_run/modules" \
  "${camera_sources[@]}" "$camera_repo/tools/chatgpt-camera-check.swift" -o "$camera_run/check" >"$camera_run/build.log" 2>&1; then
  cat "$camera_run/build.log" >&2
  exit 1
fi
"$camera_run/check" "$camera_run" "$camera_repo/tests/fixtures/chatgpt-front-product.json" "$camera_repo/tests/fixtures/local-label-ocr.json" 2>&1 | tee "$camera_run/results.log"
python3 - "$camera_repo" "$camera_run" <<'PY'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:]);evidence=json.loads((run/'source-evidence.json').read_text())
for name,entry in evidence['files'].items():
    assert hashlib.sha256((root/'Nudge'/name).read_bytes()).hexdigest()==entry['productionSHA256'],name+' changed while tests ran'
web={str(path.relative_to(root/'Web')):hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((root/'Web').rglob('*')) if path.is_file()}
assert web==evidence['webFiles'],'Web inputs changed while tests ran'
evidence['productionSourcesStillMatchAfterRun']=True
evidence['webSourcesStillMatchAfterRun']=True
(run/'source-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
PY
echo "Camera coordinator checks retained at: $camera_run"
