#!/bin/bash
# Compile the actual Foundation-only progress projection without app/private data.
set -euo pipefail
meal_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
meal_check_dir="$(mktemp -d "${TMPDIR:-/tmp}/nudge-meal-progress.XXXXXX")"
trap 'rm -rf "$meal_check_dir"' EXIT
python3 - "$meal_repo_root/Nudge/NativeAppStore.swift" "$meal_repo_root/Nudge/NativeTodayHistoryView.swift" "$meal_check_dir/Progress.swift" <<'PYTHON'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.index('struct NativeMealRefinementProgress {')
history = pathlib.Path(sys.argv[2]).read_text()
history_start = history.index('enum NativeAnalysisStage: Int {')
history_end = history.index('\n@MainActor\nprivate struct NativeHistoryAnalysisProgressView:', history_start)
pathlib.Path(sys.argv[3]).write_text('import Foundation\n' + source[start:] + '\n' + history[history_start:history_end])
PYTHON
xcrun swiftc -module-cache-path "$meal_check_dir/modules" \
  "$meal_check_dir/Progress.swift" "$meal_repo_root/tools/native-meal-progress-check.swift" \
  -o "$meal_check_dir/check"
"$meal_check_dir/check"
