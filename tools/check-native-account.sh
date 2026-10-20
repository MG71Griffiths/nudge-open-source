#!/bin/bash
# Exact production account/theme code, synthetic credentials, memory storage and
# intercepted HTTP. No simulator, live network, Keychain or owner data access.
set -euo pipefail
umask 077
account_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native account checks require macOS and Xcode with Mac Catalyst support." >&2
  exit 1
fi
python3 - "$account_repo_root" <<'PY'
import datetime, hashlib, json, pathlib, platform, subprocess, sys, uuid
root = pathlib.Path(sys.argv[1])
run = root / '.local/native-account-checks' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
run.mkdir(parents=True, mode=0o700)
paths = ['Nudge/AccountFeature.swift', 'Nudge/NudgeTheme.swift', 'tools/native-account-check.swift']
digest = lambda p: hashlib.sha256((root / p).read_bytes()).hexdigest()
before = {p: digest(p) for p in paths}
sdk = subprocess.check_output(['xcrun', '--show-sdk-path', '--sdk', 'macosx'], text=True).strip()
command = ['xcrun', 'swiftc', '-swift-version', '5', '-target', platform.machine() + '-apple-ios16.0-macabi', '-sdk', sdk,
           '-F', sdk + '/System/iOSSupport/System/Library/Frameworks', '-I', sdk + '/System/iOSSupport/usr/include',
           '-L', sdk + '/System/iOSSupport/usr/lib', '-module-cache-path', str(root / '.local/native-account-checks/modules'),
           *[str(root / p) for p in paths], '-o', str(run / 'native-account-check')]
receipt = {'productionSourceHashesBefore': before, 'scope': 'exact production AccountFeature + NudgeTheme; unrelated environment stubs; synthetic memory session store and HTTP; no live auth, Keychain, simulator or owner data', 'run': str(run)}
try:
    with (run / 'build.log').open('w') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    receipt['compileExit'] = result.returncode
    if result.returncode:
        print((run / 'build.log').read_text()[-12000:])
        raise RuntimeError('Native account compilation failed')
    with (run / 'results.log').open('w') as log:
        result = subprocess.run([str(run / 'native-account-check')], stdout=log, stderr=subprocess.STDOUT, timeout=60)
    receipt['runtimeExit'] = result.returncode
    lines = (run / 'results.log').read_text().splitlines()
    for line in lines:
        if line.startswith('ACCOUNT_CHECK_RESULT '):
            receipt['tests'] = json.loads(line.removeprefix('ACCOUNT_CHECK_RESULT '))
    if result.returncode or 'tests' not in receipt:
        print('\n'.join(lines[-60:]))
        raise RuntimeError('Native account runtime checks failed')
    receipt['productionSourceHashesAfter'] = {p: digest(p) for p in paths}
    receipt['sourceUnchangedDuringCheck'] = before == receipt['productionSourceHashesAfter']
    if not receipt['sourceUnchangedDuringCheck']:
        raise RuntimeError('Source changed during native account checks')
    receipt['passed'] = True
except Exception as exc:
    receipt['passed'] = False
    receipt['error'] = str(exc)
finally:
    (run / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Native account receipt: ' + str(run / 'receipt.json'))
if not receipt['passed']:
    sys.exit(1)
print('Native account checks passed: ' + str(receipt['tests']['checks']) + ' assertions, ' + str(len(receipt['tests']['groups'])) + ' groups.')
PY
