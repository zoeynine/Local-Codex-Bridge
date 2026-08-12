#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)
application_bundle="$repository_root/Start Mac Codex Bridge.app"
executable="$application_bundle/Contents/MacOS/StartMacCodexBridge"

/usr/bin/plutil -lint "$application_bundle/Contents/Info.plist" >/dev/null
/usr/bin/clang \
  -mmacosx-version-min=12.0 \
  -arch arm64 \
  -arch x86_64 \
  -Os \
  -Wall \
  -Wextra \
  -o "$executable" \
  "$script_directory/StartMacCodexBridge.c"
/usr/bin/codesign --force --sign - "$application_bundle" >/dev/null
