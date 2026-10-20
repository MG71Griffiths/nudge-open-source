#!/bin/bash
# Run actual native persistence code on macOS without a simulator or private app data.
set -euo pipefail
capture_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
capture_check_dir="$(mktemp -d "${TMPDIR:-/tmp}/nudge-capture-check.XXXXXX")"
trap 'rm -rf "$capture_check_dir"' EXIT
# VoiceMemo.swift imports iOS recording frameworks. Extract its unchanged,
# Foundation-only payload value type; never copy the persistence implementation.
python3 - "$capture_repo_root/Nudge/VoiceMemo.swift" "$capture_check_dir/VoiceMemoPayload.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.index('struct VoiceMemoPayload {')
end = source.index('\n/// Permission callbacks', start)
pathlib.Path(sys.argv[2]).write_text('import Foundation\n' + source[start:end])
PY
xcrun swiftc -module-cache-path "$capture_check_dir/modules" \
  "$capture_repo_root/Nudge/ChatGPTCaptureProtocol.swift" \
  "$capture_repo_root/Nudge/NativeCaptureOutbox.swift" \
  "$capture_check_dir/VoiceMemoPayload.swift" \
  "$capture_repo_root/tools/native-capture-outbox-check.swift" \
  -o "$capture_check_dir/check"
"$capture_check_dir/check" "$capture_check_dir"
