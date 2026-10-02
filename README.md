# 🤖 AI Trading Agent — وكيل التداول الذكي

برنامج ديسكتوب للتداول الذكي بالذكاء الاصطناعي — يعمل على اللينكس، يتصل بالإنترنت مباشرة، ويُتحكم فيه من الداش بورد على المتصفح.

## ✨ المميزات

- 🧠 **عقل ذكي AI** — يتصل بأي مزود (OpenAI / Groq / OpenRouter / DeepSeek / محلي)
- 🏦 **ربط حقيقي بالبروكرات** — Binance / Bybit / MetaTrader 5
- 📱 **تليجرام حقيقي** — إشعارات + أوامر من التليجرام
- 🛡️ **إدارة مخاطر** — حجم الصفقة، حد يومي، وقف خسارة، أقل ثقة
- 📊 **داش بورد احترافية** — رسم TradingView + بطاقات + صفقات + قرارات + سجل
- 🖥️ **برنامج ديسكتوب** — يشتغل على جهازك بدون تثبيت مكتبات
- 🌙 **تصميم داكن/فاتح** — RTL عربي احترافي

## 🚀 التشغيل (أول مرة)

```bash
# 1. افتح المجلد
cd "x egant"

# 2. شغّل البرنامج
./start.sh
```

**أول مرة فقط**: البرنامج يتأكد إن Node.js مثبت. لو مش مثبت:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

بعدها كل مرة تشغّله: `./start.sh` — يفتح الداش بورد في المتصفح تلقائياً.

## ⚙️ الإعداد

### 1. العقل (AI)
افتح الإعدادات → العقل → ضع:
- **API Key** من مزوّد الذكاء الاصطناعي
- **Base URL** (جاهز حسب الاختيار)
- **الموديل** (مثل gpt-4o-mini)

### 2. البروكر
افتح الإعدادات → البروكر:
- **Paper Trading** (وهمي) — يعمل فوراً بدون مفاتيح
- **Binance / Bybit** — ضع API Key + Secret من البروكر
- **MetaTrader 5** — عبر [MetaApi.cloud](https://metaapi.cloud) — ضع Token + Account ID

### 3. التليجرام
افتح الإعدادات → التليجرام:
- **Bot Token** من [@BotFather](https://t.me/BotFather)
- **Chat ID** من [@getmyid_bot](https://t.me/getmyid_bot)

### 4. المخاطر
- حجم الصفقة (% من الرصيد)
- حد الخسارة اليومي
- أقصى عدد صفقات
- وقف خسارة / جنى أرباح افتراضي

## 📱 أوامر التليجرام

| الأمر | الوظيفة |
|---|---|
| `/start` | رسالة الترحيب |
| `/status` | حالة العقل والرصيد |
| `/balance` | تفاصيل الرصيد |
| `/analyze BTCUSDT` | تحليل فوري |
| `/stats` | إحصائيات |
| `/pause` | إيقاف مؤقت |
| `/resume` | استئناف |

## 🔒 الأمان

- كل المفاتيح مخزّنة محلياً في `.env` أو `settings.json` (ما بترفعش على GitHub)
- التنفيذ الافتراضي = **Paper** (وهمي)
- تفعيل Live يحتاج كلمة سر

## 📁 بنية المشروع

```
├── server.js          # السيرفر المحلي (بدون مكتبات خارجية)
├── start.sh           # بدء التشغيل
├── index.html         # الداش بورد
├── lib/               # المكتبات الأساسية
│   ├── config.js      # إدارة الإعدادات
│   ├── http.js        # عميل HTTP (مدمج)
│   ├── crypto.js      # HMAC توقيع
│   ├── store.js       # تخزين البيانات
│   ├── ai.js          # العقل AI
│   ├── market.js      # بيانات السوق
│   ├── telegram.js    # التليجرام
│   ├── risk.js        # إدارة المخاطر
│   ├── agent.js       # حلقة العقل
│   ├── routes.js      # API routes
│   └── brokers/       # البروكرات
│       ├── index.js   # واجهة موحّدة
│       ├── paper.js   # تداول وهمي
│       ├── binance.js # Binance
│       ├── bybit.js   # Bybit
│       └── metaapi.js # MetaTrader 5
├── assets/            # الواجهة
│   ├── css/
│   └── js/
├── data/              # البيانات المحلية (تُنشأ تلقائياً)
├── .env.example       # قالب المفاتيح
└── settings.json      # الإعدادات (تُنشأ من الواجهة)
```

## 🌐 النشر الأونلاين (GitHub + Vercel)

```bash
# إنشاء repo + رفع
git init
    git add .
    git commit -m "AI Trading Agent v1"
    gh repo create ai-trading-agent --public --source=. --push

    # نشر على Vercel
    npx vercel --prod
    # أضف Environment Variables من Vercel Dashboard

```

## ⚠️ تنبيه

**هذا البرنامج أداة مساعدة للتداول — ليس نصيحة مالية.**
- ابدأ دائماً بوضع Paper Trading
- اختبر جيداً قبل تفعيل Live
- أنت المسؤول الوحيد عن قرارات التداول وأموالك

## 📄 الرخصة

MIT License — استخدمه، عدّله، وزعه بحرية.
