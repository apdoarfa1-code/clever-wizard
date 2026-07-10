#!/usr/bin/env bash
# =============================================================
#  AI Trading Agent — بدء التشغيل
#  يفتح التطبيق عند الضعط علية من خلال استدعاء ./start.sh
#  أولوية: Electron app حقيقي → fallback على المتصفح.
# =============================================================

set -e
export OPEN_BROWSER=false
export AGENT_AUTORUN=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║       🤖 AI Trading Agent                    ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# 0) فحص Node.js
if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js غير مثبت!"
    echo "  شاذا من https://nodejs.org أو:"
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "    sudo apt-get install -y nodejs"
    exit 1
fi
echo "  ✅ Node.js: $(node -v)"

mkdir -p data
[ -f .env ] || cp -n .env.example .env 2>/dev/null || true

# 1) محاولة Electron (الأولوية — أسرع وأخفّ)
USE_ELECTRON=0
if [ -d node_modules/electron ] && [ -x node_modules/.bin/electron ]; then
    USE_ELECTRON=1
fi

# وضع Live فقط متى ضغط علية المستخدم — ما يشتغلش عند تشغيل الجهاز
if [ "$USE_ELECTRON" = "1" ]; then
    echo "  🖥️  تشغيل Electron..."
    exec ./node_modules/.bin/electron electron/main.js
else
    echo "  🌐 تشغيل ويب فرونت (npm install لتفعيل Electron app حقيقي)"
    if [ ! -f .env ]; then cp .env.example .env; fi
    exec node server.js
fi
