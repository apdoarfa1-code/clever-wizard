#!/usr/bin/env bash
# =============================================================
#  AI Trading Agent — بدء التشغيل
#  تشغيل: ./start.sh
#  أول مرة فقط: يتأكد إن Node.js مثبت. بعدها يشتغل زي أي برنامج.
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║       🤖 AI Trading Agent                    ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# فحص Node.js
if ! command -v node &>/dev/null; then
    echo "  ❌ Node.js غير مثبت!"
    echo "  للتثبيت على Ubuntu/Debian:"
    echo ""
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "    sudo apt-get install -y nodejs"
    echo ""
    echo "  أو للتثبيت من: https://nodejs.org"
    echo ""
    exit 1
fi

NODE_VER=$(node -v 2>/dev/null)
echo "  ✅ Node.js: $NODE_VER"

# إنشاء مجلد البيانات
mkdir -p data

# نسخ .env.example لـ .env أول مرة
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "  ✅ تم إنشاء ملف .env (انسخ مفاتيحك الحقيقية فيه)"
    fi
fi

# إنشاء ملف desktop shortcut (أول مرة فقط)
if [ ! -f ~/.local/share/applications/ai-trading-agent.desktop ] 2>/dev/null; then
    mkdir -p ~/.local/share/applications 2>/dev/null
    cat > ~/.local/share/applications/ai-trading-agent.desktop << DESKTOP
[Desktop Entry]
Name=AI Trading Agent
Comment=وكيل التداول الذكي
Exec=bash -c "cd '$SCRIPT_DIR' && bash start.sh"
Icon=utilities-terminal
Terminal=true
Type=Application
Categories=Finance;Network;
DESKTOP
    echo "  ✅ تم إنشاء اختصار سطح المكتب"
fi

echo ""
echo "  🚀 جاري تشغيل الخادم..."
echo "  📡 الداش بورد: http://127.0.0.1:8080"
echo ""
echo "  ⌨️  اضغط Ctrl+C للإيقاف"
echo ""

# تشغيل السيرفر (دايماً يشتغل لحد ما المستخدم يوقفه)
exec node server.js
