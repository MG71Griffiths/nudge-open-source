#!/bin/bash
# Exercise the actual private-store writer with synthetic files, without a phone.
set -euo pipefail
storage_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
storage_check_dir="$(mktemp -d "${TMPDIR:-/tmp}/nudge-storage-check.XXXXXX")"
trap 'rm -rf "$storage_check_dir"' EXIT
python3 - "$storage_repo_root/Nudge/NudgeDataStore.swift" "$storage_check_dir/Store.swift" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
source = source[:source.index('/// A reserved prompt')].replace('import WebKit\n', '')
pathlib.Path(sys.argv[2]).write_text(source)
PY
xcrun swiftc -O -module-cache-path "$storage_check_dir/modules" \
  "$storage_check_dir/Store.swift" "$storage_repo_root/tools/native-storage-check.swift" -o "$storage_check_dir/check"
"$storage_check_dir/check" "$storage_check_dir/data"
