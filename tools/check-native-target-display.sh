#!/bin/bash
# Execute exact production Foundation display helpers with synthetic nutrients.
# Does not launch the app or simulator, read owner data, or write preferences.
set -euo pipefail
umask 077
target_display_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$target_display_repo_root" <<'PY'
import datetime, hashlib, json, pathlib, subprocess, sys, uuid
root = pathlib.Path(sys.argv[1])
run = root / '.local/native-target-display-checks' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
run.mkdir(parents=True, mode=0o700)
source = root / 'Nudge/NativeTodayHistoryView.swift'
tests = root / 'tools/native-target-display-check.swift'
runner = root / 'tools/check-native-target-display.sh'
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
before = {str(path.relative_to(root)): digest(path) for path in [source, tests, runner]}
text = source.read_text()
assert text.count('enum NativeTrackingDisplay {') == 1
body = text.split('enum NativeTrackingDisplay {', 1)[1]
# Consecutive, uniquely named production function ranges. No rewritten helper,
# stand-in implementation, UIKit dependency or UI logic is compiled here.
ranges = [('number', 'date'), ('title', 'color'), ('ratio', 'imageSource')]
pieces = []
for start, end in ranges:
    first, last = '    static func ' + start + '(', '    static func ' + end + '('
    assert body.count(first) == 1 and body.count(last) == 1
    piece = body.split(first, 1)[1].split(last, 1)[0]
    pieces.append(first + piece)
model = 'import Foundation\nimport CoreFoundation\nenum NativeTrackingDisplay {\n' + '\n'.join(pieces) + '}\n'
model_path = run / 'ProductionTargetDisplay.swift'
model_path.write_text(model)
receipt = {'scope': 'Exact production NativeTrackingDisplay pure helper ranges; synthetic data; no simulator, UI interaction, networking, owner records or preference writes', 'productionSourceHashesBefore': before, 'extractedSourceSHA256': digest(model_path), 'extractedRanges': ranges, 'run': str(run)}
try:
    command = ['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(root / '.local/native-target-display-checks/modules'), str(model_path), str(tests), '-o', str(run / 'native-target-display-check')]
    with (run / 'build.log').open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    receipt['compileExit'] = result.returncode
    if result.returncode:
        print((run / 'build.log').read_text()[-12000:])
        raise RuntimeError('Native target display compilation failed')
    with (run / 'results.log').open('w') as log:
        result = subprocess.run([str(run / 'native-target-display-check')], stdout=log, stderr=subprocess.STDOUT, timeout=30)
    receipt['runtimeExit'] = result.returncode
    for line in (run / 'results.log').read_text().splitlines():
        if line.startswith('TARGET_DISPLAY_CHECK_RESULT '): receipt['tests'] = json.loads(line.removeprefix('TARGET_DISPLAY_CHECK_RESULT '))
    if result.returncode or 'tests' not in receipt:
        print((run / 'results.log').read_text()[-12000:])
        raise RuntimeError('Native target display runtime checks failed')
    receipt['productionSourceHashesAfter'] = {str(path.relative_to(root)): digest(path) for path in [source, tests, runner]}
    receipt['sourceUnchangedDuringCheck'] = before == receipt['productionSourceHashesAfter']
    if not receipt['sourceUnchangedDuringCheck']: raise RuntimeError('Source changed during checks')
    receipt['passed'] = True
except Exception as exc:
    receipt['passed'] = False
    receipt['error'] = str(exc)
finally:
    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Native target display receipt: ' + str(run / 'receipt.json'))
if not receipt['passed']: sys.exit(1)
print('Native target display checks passed: ' + str(receipt['tests']['checks']) + ' assertions, ' + str(len(receipt['tests']['groups'])) + ' groups.')
PY
