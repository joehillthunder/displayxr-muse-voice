#!/usr/bin/env bash
# Add the DisplayXR dial to a checkout of the Muse ESP32 SDK.
#
#   bash esp32/install-into-sdk.sh /path/to/muse-gadget-sdk
#
# Copies components/displayxr_dial into <sdk>/esp32/components/ and applies muse-sdk.patch
# (two #if-guarded lines in main.c, one REQUIRES entry). The patch is made against the SDK
# commit pinned in setup-pi.sh; on a newer SDK it may need a manual merge.
#
# Then, in <sdk>/esp32:  idf.py menuconfig  ->  DisplayXR dial  ->  enable, set URL and secret.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${1:?usage: install-into-sdk.sh /path/to/muse-gadget-sdk}"
[ -f "$SDK/esp32/main/main.c" ] || { echo "error: $SDK does not look like muse-gadget-sdk (no esp32/main/main.c)" >&2; exit 1; }

rm -rf "$SDK/esp32/components/displayxr_dial"
cp -R "$HERE/components/displayxr_dial" "$SDK/esp32/components/displayxr_dial"
echo "==> copied components/displayxr_dial"

if grep -q displayxr_dial "$SDK/esp32/main/CMakeLists.txt"; then
    echo "==> SDK already patched"
else
    git -C "$SDK" apply "$HERE/muse-sdk.patch"
    echo "==> applied muse-sdk.patch"
fi
echo "Next: cd $SDK/esp32 && idf.py menuconfig  (DisplayXR dial -> enable, URL, secret, pins)"
