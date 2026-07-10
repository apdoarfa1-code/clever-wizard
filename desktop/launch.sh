#!/usr/bin/env bash
# =============================================================
#  AI Trading Agent — Fallback launcher
#  يستخدم Electron إن وُجد, وإلا يفتح المتصفح في وضع App.
# =============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"
PORT=8080
URL="http://127.0.0.1:${PORT}"
APP_NAME="AI Trading Agent"

# محاولة Electron أولاً
if [ -x "$APP_DIR/node_modules/.bin/electron" ]; then
    # نشغّل السيرفر في الخلفية ثم Electron
    if ! curl -s -o /dev/null --max-time 1 "$URL/api/health" 2>/dev/null; then
        OPEN_BROWSER=false AGENT_AUTORUN=false PORT=$PORT nohup node server.js >/dev/null 2>&1 &
        echo $! > "$APP_DIR/data/.server.pid"
        disown
        for _ in $(seq 1 30); do
            curl -s -o /dev/null --max-time 1 "$URL/api/health" 2>/dev/null && break
            sleep 0.3
        done
    fi
    exec "$APP_DIR/node_modules/.bin/electron" electron/main.js
fi

# Fallback: متصفح في وضع app
start_server_bg() {
    if ! curl -s -o /dev/null --max-time 2 "$URL/api/health" 2>/dev/null; then
        OPEN_BROWSER=false AGENT_AUTORUN=false nohup node server.js >/dev/null 2>&1 &
        echo $! > "$APP_DIR/data/.server.pid"
        disown
        for _ in $(seq 1 30); do
            curl -s -o /dev/null --max-time 1 "$URL/api/health" 2>/dev/null && return 0
            sleep 0.3
        done
    fi
}
open_app_browser() {
    for bin in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$bin" &>/dev/null; then
            "$bin" --app="$URL" --window-name="$APP_NAME" --window-size=1440,900 \
                --user-data-dir="$HOME/.ai-trading-agent-app" \
                --no-first-run --no-default-browser-check --disable-extensions >/dev/null 2>&1 &
            return
        fi
    done
    xdg-open "$URL" >/dev/null 2>&1 &
}
start_server_bg
open_app_browser
sleep 3
wait
