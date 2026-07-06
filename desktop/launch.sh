#!/usr/bin/env bash
# =============================================================
#  AI Trading Agent — Launcher (بدون تيرمنال)
#  يدوس على الأيقونة → يتأكد الخادم شغال → يفتح المتصفح
# =============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PORT=8080
URL="http://127.0.0.1:${PORT}"

# التأكد إن الخادم شغّال بصمت في الخلفية
if ! pgrep -f "node ${APP_DIR}/server.js" > /dev/null 2>&1; then
    # تشغيل السيرفر في الخلفية بدون أي مخرجات
    cd "$APP_DIR"
    nohup node server.js > /dev/null 2>&1 &
    disown
    # مهلة قصيرة لرفع السيرفر
    for i in 1 2 3 4 5 6 7 8 9 10; do
        if curl -s -o /dev/null "$URL/api/health" 2>/dev/null; then break; fi
        sleep 0.3
    done
fi

# فتح المتصفح الافتراضي
if command -v xdg-open &>/dev/null; then
    xdg-open "$URL" >/dev/null 2>&1
elif command -v gio &>/dev/null; then
    gio open "$URL" >/dev/null 2>&1
elif command -v sensible-browser &>/dev/null; then
    sensible-browser "$URL" >/dev/null 2>&1
fi
