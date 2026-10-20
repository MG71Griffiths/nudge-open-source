#!/bin/bash
# Run actual native persistence code on macOS without a simulator or private app data.
set -euo pipefail
capture_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
capture_check_dir="$(mktemp -d /private/tmp/nudge-cloud-input-check-XXXXXX)"
umask 077
# VoiceMemo.swift imports iOS recording frameworks. Extract its unchanged,
# Foundation-only payload value type; never copy the persistence implementation.
python3 - "$capture_repo_root/Nudge/VoiceMemo.swift" "$capture_check_dir/VoiceMemoPayload.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.index('struct VoiceMemoPayload {')
end = source.index('\n/// Permission callbacks', start)
pathlib.Path(sys.argv[2]).write_text('import Foundation\n' + source[start:end])
PY
python3 - "$capture_repo_root" "$capture_check_dir" <<'PYHASH'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:])
files=['Nudge/NativeCaptureOutbox.swift','Nudge/ChatGPTCaptureProtocol.swift','Nudge/VoiceMemo.swift','tools/cloud-image-preparation-check.swift']
(run/'source-evidence.json').write_text(json.dumps({'sources':{n:hashlib.sha256((root/n).read_bytes()).hexdigest() for n in files}},indent=2)+'\n')
PYHASH
xcrun swiftc -module-cache-path "$capture_check_dir/modules" \
  "$capture_repo_root/Nudge/ChatGPTCaptureProtocol.swift" \
  "$capture_repo_root/Nudge/NativeCaptureOutbox.swift" \
  "$capture_check_dir/VoiceMemoPayload.swift" \
  "$capture_repo_root/tools/cloud-image-preparation-check.swift" \
  -o "$capture_check_dir/check"
"$capture_check_dir/check" "$capture_check_dir"

python3 - "$capture_repo_root" "$capture_check_dir" <<'PYHASH'
import hashlib,json,pathlib,sys
root,run=map(pathlib.Path,sys.argv[1:]);p=run/'source-evidence.json';e=json.loads(p.read_text())
e['sourcesUnchanged']=all(hashlib.sha256((root/n).read_bytes()).hexdigest()==h for n,h in e['sources'].items())
p.write_text(json.dumps(e,indent=2)+'\n');assert e['sourcesUnchanged'],'Production/test sources changed during check'
PYHASH
echo "Immutable cloud input checks retained at: $capture_check_dir"
