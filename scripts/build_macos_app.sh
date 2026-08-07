#!/usr/bin/env bash
# Intent: build a double-clickable macOS MyChat.app with icon + launcher.
# Architecture: embeds app sources + a private venv under Contents/Resources so
# Finder launches are not blocked by Documents-folder TCC (external .venv).
# Quality: 7/10 — self-contained bundle proven; Darwin-only; full rsync+venv each rebuild
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/MyChat.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
APP_DIR="$RES/app"
VENV_DIR="$RES/venv"
ICON_SRC="$ROOT/assets/icon-1024.png"
ICONSET="$DIST/MyChat.iconset"
ICNS="$RES/AppIcon.icns"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script builds a macOS .app (run on macOS)." >&2
  exit 1
fi

if [[ ! -f "$ICON_SRC" ]]; then
  echo "Missing icon: $ICON_SRC" >&2
  exit 1
fi

# Prefer project venv Python (same ABI) as the base for the bundled venv.
BASE_PY="$ROOT/.venv/bin/python"
if [[ ! -x "$BASE_PY" ]]; then
  BASE_PY="$(command -v python3)"
fi
if [[ -z "$BASE_PY" ]]; then
  echo "No python3 found to build the app venv." >&2
  exit 1
fi

rm -rf "$APP" "$ICONSET"
mkdir -p "$MACOS" "$RES" "$ICONSET" "$APP_DIR"

# Build .icns — only Apple iconset names (sips wants .png suffix, then rename @2x)
_mk() {
  local px="$1" name="$2"
  local tmp="$ICONSET/_tmp_${px}.png"
  sips -z "$px" "$px" "$ICON_SRC" --out "$tmp" >/dev/null
  mv "$tmp" "$ICONSET/$name"
}
_mk 16 "icon_16x16.png"
_mk 32 "diana.k@example.org"
_mk 32 "icon_32x32.png"
_mk 64 "ivan.p@example.net"
_mk 128 "icon_128x128.png"
_mk 256 "wendy.h@example.net"
_mk 256 "icon_256x256.png"
_mk 512 "frank.g@example.org"
_mk 512 "icon_512x512.png"
_mk 1024 "walt.e@example.net"
iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"

# Favicons for the browser UI (source tree)
sips -z 32 32 "$ICON_SRC" --out "$ROOT/assets/favicon-32.png" >/dev/null
sips -z 180 180 "$ICON_SRC" --out "$ROOT/assets/apple-touch-icon.png" >/dev/null

# Copy runtime files into the bundle (no .venv / dist / git / tests noise)
rsync -a --delete \
  --exclude '.venv/' \
  --exclude 'dist/' \
  --exclude '.git/' \
  --exclude '.cursor/' \
  --exclude 'node_modules/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude 'tests/' \
  --exclude 'e2e/' \
  "$ROOT/" "$APP_DIR/"

# Private venv inside the .app (readable when launched from Finder)
echo "Creating bundled venv…"
"$BASE_PY" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install -q --upgrade pip
"$VENV_DIR/bin/python" -m pip install -q -r "$APP_DIR/requirements.txt"
"$VENV_DIR/bin/python" -c "import webview; import ddgs"

BUNDLE_PY="$VENV_DIR/bin/python"

cat > "$MACOS/MyChat" <<EOF
#!/bin/bash
# Self-contained launcher: everything lives under this .app (avoids Documents TCC).
DIR="\$(cd "\$(dirname "\$0")/.." && pwd)"
APP_ROOT="\$DIR/Resources/app"
PY="\$DIR/Resources/venv/bin/python"
export PYTHONUNBUFFERED=1
export PYWEBVIEW_GUI=cocoa
mkdir -p "\$HOME/Library/Logs"
LOG="\$HOME/Library/Logs/MyChat.log"
{
  echo "---- \$(date) launch ----"
  echo "APP_ROOT=\$APP_ROOT"
  echo "PY=\$PY"
  cd "\$APP_ROOT" || exit 1
  exec "\$PY" "\$APP_ROOT/desktop_app.py"
} >>"\$LOG" 2>&1
EOF
chmod +x "$MACOS/MyChat"

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>MyChat</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.mychat.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>MyChat</string>
  <key>CFBundleDisplayName</key>
  <string>MyChat</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

touch "$APP"

echo "Built: $APP"
echo "Open with: open \"$APP\""
echo "Optional: cp -R \"$APP\" /Applications/"
echo "Logs: ~/Library/Logs/MyChat.log"
