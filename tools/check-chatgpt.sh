#!/bin/bash
# Exercise production ChatGPT code with synthetic credentials and intercepted HTTP.
# Does not open a browser, contact a provider, or read/write real Keychain entries.
set -euo pipefail
umask 077

chatgpt_repo_root="$(cd "$(dirname "$0")/.." && pwd)"
chatgpt_check_dir="$chatgpt_repo_root/.local/chatgpt-checks"

if [[ "$(uname -s)" != Darwin ]] || ! command -v xcrun >/dev/null 2>&1; then
  echo "ChatGPT checks require macOS and Xcode with Mac Catalyst support." >&2
  exit 1
fi
chatgpt_sdk="$(xcrun --show-sdk-path --sdk macosx)"
chatgpt_arch="$(uname -m)"
case "$chatgpt_arch" in
  arm64|x86_64) ;;
  *) echo "Unsupported Mac architecture: $chatgpt_arch" >&2; exit 1 ;;
esac
if [[ ! -d "$chatgpt_sdk/System/iOSSupport/System/Library/Frameworks/UIKit.framework" ]]; then
  echo "The selected Xcode SDK does not include Mac Catalyst UIKit support." >&2
  exit 1
fi
mkdir -p "$chatgpt_check_dir"

echo "Compiling ChatGPT protocol checks against production Swift source…"
if ! xcrun swiftc -swift-version 5 -target "$chatgpt_arch-apple-macos13.0" \
  -sdk "$chatgpt_sdk" -module-cache-path "$chatgpt_check_dir/modules-macos" \
  "$chatgpt_repo_root/Nudge/ChatGPTCaptureProtocol.swift" \
  "$chatgpt_repo_root/Nudge/ChatGPTProtocol.swift" \
  "$chatgpt_repo_root/tools/chatgpt-protocol-check.swift" \
  -o "$chatgpt_check_dir/protocol-check" \
  >"$chatgpt_check_dir/protocol-build.log" 2>&1; then
  cat "$chatgpt_check_dir/protocol-build.log" >&2
  exit 1
fi
"$chatgpt_check_dir/protocol-check" 2>&1 | tee "$chatgpt_check_dir/protocol-results.log"

echo "Compiling ChatGPT lifecycle checks against production Swift source…"
if ! xcrun swiftc -swift-version 5 -target "$chatgpt_arch-apple-ios16.0-macabi" \
  -sdk "$chatgpt_sdk" \
  -F "$chatgpt_sdk/System/iOSSupport/System/Library/Frameworks" \
  -I "$chatgpt_sdk/System/iOSSupport/usr/include" \
  -L "$chatgpt_sdk/System/iOSSupport/usr/lib" \
  -module-cache-path "$chatgpt_check_dir/modules-catalyst" \
  "$chatgpt_repo_root/Nudge/ChatGPTCaptureProtocol.swift" \
  "$chatgpt_repo_root/Nudge/ChatGPTProtocol.swift" \
  "$chatgpt_repo_root/Nudge/ChatGPTConnection.swift" \
  "$chatgpt_repo_root/Nudge/BoundedHTTPData.swift" \
  "$chatgpt_repo_root/tools/chatgpt-lifecycle-check.swift" \
  -o "$chatgpt_check_dir/lifecycle-check" \
  >"$chatgpt_check_dir/lifecycle-build.log" 2>&1; then
  cat "$chatgpt_check_dir/lifecycle-build.log" >&2
  exit 1
fi
"$chatgpt_check_dir/lifecycle-check" 2>&1 | tee "$chatgpt_check_dir/lifecycle-results.log"

echo "ChatGPT checks passed. Build and result logs: $chatgpt_check_dir"
