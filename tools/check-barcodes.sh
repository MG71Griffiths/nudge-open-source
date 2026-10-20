#!/bin/bash
# Offline identity/check-digit tests against the production Foundation helper.
set -euo pipefail
umask 077
barcode_root="$(cd "$(dirname "$0")/.." && pwd)"
barcode_output="$barcode_root/.local/barcode-checks"
mkdir -p "$barcode_output"
xcrun swiftc -swift-version 5 -module-cache-path "$barcode_output/modules" \
  "$barcode_root/Nudge/FoodBarcodeIdentity.swift" "$barcode_root/tools/barcode-identity-check.swift" \
  -o "$barcode_output/check" > "$barcode_output/build.log" 2>&1
"$barcode_output/check" | tee "$barcode_output/results.log"
