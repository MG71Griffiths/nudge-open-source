#!/bin/bash
# Exact production transport and stream bound; synthetic intercepted HTTP only.
set -euo pipefail
umask 077
description_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$description_repo_root" <<'PY'
import datetime, hashlib, json, pathlib, subprocess, sys, uuid
root = pathlib.Path(sys.argv[1])
run = root / '.local/native-food-description-checks' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
run.mkdir(parents=True, mode=0o700)
paths = ['Nudge/NativeFoodDescription.swift', 'Nudge/NutritionLabelFeature.swift', 'Nudge/BoundedHTTPData.swift', 'tools/native-food-description-check.swift', 'tools/check-native-food-description.sh']
digest = lambda p: hashlib.sha256((root / p).read_bytes()).hexdigest()
before = {p: digest(p) for p in paths}
source = (root / paths[0]).read_text()
assert source.count('@MainActor\nstruct NativeFoodDescriptionView') == 1
service = source.split('@MainActor\nstruct NativeFoodDescriptionView')[0].replace('import SwiftUI\n', '')
label = (root / paths[1]).read_text()
configuration = label[label.index('struct BackendConfiguration:'):label.index('\nenum BackendCredentialStore')]
delegate = label[label.index('final class LabelSessionDelegate:'):label.index('\nstruct CaptureTransportFailure:')]
production = run / 'ProductionDescriptionTransport.swift'
production.write_text(service + '\n' + configuration + '\n' + delegate)
receipt = {'scope': 'Exact NativeFoodDescriptionService, BackendConfiguration, LabelSessionDelegate and BoundedHTTPData; inert account adapters; synthetic URLProtocol; no live network, app launch, simulator, credentials or owner data', 'productionSourceHashesBefore': before, 'extractedSourceSHA256': hashlib.sha256(production.read_bytes()).hexdigest(), 'run': str(run)}
try:
    command = ['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(root / '.local/native-food-description-checks/modules'), str(production), str(root / paths[2]), str(root / paths[3]), '-o', str(run / 'native-food-description-check')]
    with (run / 'build.log').open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=90)
    receipt['compileExit'] = result.returncode
    if result.returncode:
        print((run / 'build.log').read_text()[-12000:]); raise RuntimeError('Description transport compilation failed')
    with (run / 'results.log').open('w') as log:
        result = subprocess.run([str(run / 'native-food-description-check')], stdout=log, stderr=subprocess.STDOUT, timeout=30)
    receipt['runtimeExit'] = result.returncode
    for line in (run / 'results.log').read_text().splitlines():
        if line.startswith('DESCRIPTION_CHECK_RESULT '): receipt['tests'] = json.loads(line.removeprefix('DESCRIPTION_CHECK_RESULT '))
    if result.returncode or 'tests' not in receipt:
        print((run / 'results.log').read_text()[-12000:]); raise RuntimeError('Description transport checks failed')
    receipt['productionSourceHashesAfter'] = {p: digest(p) for p in paths}
    receipt['sourceUnchangedDuringCheck'] = before == receipt['productionSourceHashesAfter']
    if not receipt['sourceUnchangedDuringCheck']: raise RuntimeError('Source changed during checks')
    receipt['passed'] = True
except Exception as exc:
    receipt['passed'] = False; receipt['error'] = str(exc)
finally:
    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Native description transport receipt: ' + str(run / 'receipt.json'))
if not receipt['passed']: sys.exit(1)
print('Native description transport checks passed: ' + str(receipt['tests']['checks']) + ' assertions.')
PY
