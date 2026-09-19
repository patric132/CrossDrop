#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "========================================================"
echo "          ⚡ Starting CrossDrop Suite ⚡               "
echo "========================================================"

# 1. Check & Install Signaling dependencies
if [ ! -d "signal/node_modules" ]; then
    echo "[1/4] Installing signaling dependencies..."
    (cd signal && npm install --silent)
fi

# 2. Kill existing instances if running
pkill -f "node server.js" 2>/dev/null || true
pkill -f "CrossDropBar" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://localhost:3000" 2>/dev/null || true

# 3. Start Signaling Server in background
echo "[2/4] Starting Signaling & Web Server on port 3000..."
(cd signal && node server.js > ../server.log 2>&1) &
SERVER_PID=$!
sleep 1

# 4. Start Cloudflare Tunnel for Cross-Network 5G / Wi-Fi Access
echo "[3/4] Establishing Cloudflare Secure Tunnel for 5G access..."
CF_LOG="/tmp/crossdrop_cf.log"
rm -f "$CF_LOG"
cloudflared tunnel --url http://localhost:3000 > "$CF_LOG" 2>&1 &
CF_PID=$!

PUBLIC_URL=""
for i in {1..20}; do
    PUBLIC_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -n 1 || true)
    if [ -n "$PUBLIC_URL" ]; then
        break
    fi
    sleep 0.5
done

LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")

cleanup() {
    echo ""
    echo "Stopping CrossDrop..."
    kill $SERVER_PID 2>/dev/null || true
    kill $CF_PID 2>/dev/null || true
    pkill -f "CrossDropBar" 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# 5. Build Mac App if not built or if source updated
if [ ! -f "mac/CrossDropBar" ] || [ "mac/main.swift" -nt "mac/CrossDropBar" ]; then
    echo "[4/4] Compiling native macOS App..."
    (cd mac && ./build_app.sh)
fi

echo "========================================================"
echo "  ✅ CrossDrop is now RUNNING!"
echo "--------------------------------------------------------"
if [ -n "$PUBLIC_URL" ]; then
echo "  📱 On your Android Phone (ANY network - 5G / 4G / Wi-Fi):"
echo "     👉 $PUBLIC_URL"
echo ""
fi
echo "  🏠 Local Network fallback (if on same Wi-Fi):"
echo "     👉 http://$LOCAL_IP:3000/"
echo ""
echo "  💻 On your Mac:"
echo "     • Native GUI Window has opened on your screen."
echo "     • Status Bar icon (⚡) is active in top Menu Bar."
mkdir -p ~/Documents/CrossDrop_Received
echo "     • Received files go to: ~/Documents/CrossDrop_Received/ (文件/CrossDrop_Received)"
echo "========================================================"

# Launch Mac Menu Bar & Window application
cd mac
./CrossDropBar
