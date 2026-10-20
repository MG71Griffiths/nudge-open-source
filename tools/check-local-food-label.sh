#!/bin/bash
set -euo pipefail
umask 077
food_repo="$(cd "$(dirname "$0")/.." && pwd)"
food_run="$(mktemp -d /private/tmp/nudge-local-label-check-XXXXXX)"
xcrun swiftc -swift-version 5 -module-cache-path "$food_run/modules" "$food_repo/Nudge/LocalFoodLabelParser.swift" \
  "$food_repo/Nudge/VisionFoodTextRecognizer.swift" "$food_repo/tools/local-food-label-check.swift" \
  -o "$food_run/check"
"$food_run/check" "$food_run"
echo "Local label evidence retained at: $food_run"
