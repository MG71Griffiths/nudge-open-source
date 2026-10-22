#!/bin/bash
# Compile the exact production Foundation measurement model; no simulator,
# network, owner data, or preference writes. All test inputs are synthetic.
set -euo pipefail
umask 077
measurement_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$measurement_repo_root" <<'PY'
import datetime, hashlib, json, pathlib, subprocess, sys, uuid
root = pathlib.Path(sys.argv[1])
run = root / '.local/native-measurement-checks' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
run.mkdir(parents=True, mode=0o700)
source = root / 'Nudge/NativeProfileCycleView.swift'
tests = root / 'tools/native-measurement-check.swift'
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
before = {str(path.relative_to(root)): digest(path) for path in [source, tests]}
start = '// MARK: - Measurement model (also exercised by the native measurement checks)'
end = '// MARK: - End measurement model'
text = source.read_text()
assert text.count(start) == 1 and text.count(end) == 1
model = 'import Foundation\nimport CoreFoundation\n' + text.split(start, 1)[1].split(end, 1)[0]
model_path = run / 'ProductionMeasurementModel.swift'
model_path.write_text(model)
receipt = {'scope': 'Exact production Foundation measurement model extracted using unique markers; synthetic values; no UI, live data, networking or preferences writes', 'productionSourceHashesBefore': before, 'extractedModelSHA256': digest(model_path), 'run': str(run)}
try:
    command = ['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(root / '.local/native-measurement-checks/modules'), str(model_path), str(tests), '-o', str(run / 'native-measurement-check')]
    with (run / 'build.log').open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    receipt['compileExit'] = result.returncode
    if result.returncode:
        print((run / 'build.log').read_text()[-12000:])
        raise RuntimeError('Native measurement compilation failed')
    with (run / 'results.log').open('w') as log:
        result = subprocess.run([str(run / 'native-measurement-check')], stdout=log, stderr=subprocess.STDOUT, timeout=30)
    receipt['runtimeExit'] = result.returncode
    for line in (run / 'results.log').read_text().splitlines():
        if line.startswith('MEASUREMENT_CHECK_RESULT '): receipt['tests'] = json.loads(line.removeprefix('MEASUREMENT_CHECK_RESULT '))
    if result.returncode or 'tests' not in receipt:
        print((run / 'results.log').read_text()[-12000:])
        raise RuntimeError('Native measurement runtime checks failed')
    receipt['productionSourceHashesAfter'] = {str(path.relative_to(root)): digest(path) for path in [source, tests]}
    receipt['sourceUnchangedDuringCheck'] = before == receipt['productionSourceHashesAfter']
    if not receipt['sourceUnchangedDuringCheck']: raise RuntimeError('Source changed during checks')
    receipt['passed'] = True
except Exception as exc:
    receipt['passed'] = False
    receipt['error'] = str(exc)
finally:
    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Native measurement receipt: ' + str(run / 'receipt.json'))
if not receipt['passed']: sys.exit(1)
print('Native measurement checks passed: ' + str(receipt['tests']['checks']) + ' assertions, ' + str(len(receipt['tests']['groups'])) + ' groups.')
PY
