#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$DIR/.." && pwd )"
cd "$DIR"

echo "[1/4] Compiling CrossDrop binary with Swift..."
swiftc main.swift -O -o CrossDropBar

APP_DIR="CrossDrop.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "[2/4] Assembling Application bundle structure..."
rm -rf "$APP_DIR"
mkdir -p "$MACOS"
mkdir -p "$RESOURCES"

# Copy binary
cp CrossDropBar "$MACOS/"

# Copy AppIcon & Sounds
if [ -f "AppIcon.icns" ]; then
    cp AppIcon.icns "$RESOURCES/"
fi
if [ -f "tuturu.aiff" ]; then
    cp tuturu.aiff "$RESOURCES/"
fi

# Bundle signal server and web frontend into app resources
echo "[3/4] Bundling embedded signaling server & web assets..."
cp -R "$PROJECT_DIR/signal" "$RESOURCES/"
cp -R "$PROJECT_DIR/web" "$RESOURCES/"

# Create Info.plist
cat << 'EOF' > "$CONTENTS/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>CrossDropBar</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.crossdrop.mac</string>
    <key>CFBundleName</key>
    <string>CrossDrop</string>
    <key>CFBundleDisplayName</key>
    <string>CrossDrop</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.2.0</string>
    <key>CFBundleVersion</key>
    <string>3</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
</dict>
</plist>
EOF

# Install to /Applications
echo "[4/4] Installing CrossDrop to /Applications..."
rm -rf "/Applications/CrossDrop.app"
cp -R "$APP_DIR" "/Applications/"
touch /Applications/CrossDrop.app

echo "========================================================"
echo "  ✅ CrossDrop.app installed to /Applications successfully!"
echo "  You can now launch CrossDrop from:"
echo "  • Launchpad (應用程式啟動台)"
echo "  • Spotlight (按 Cmd + 空白鍵 輸入 CrossDrop)"
echo "  • Finder > 應用程式 (Applications)"
echo "========================================================"
