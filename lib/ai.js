'use strict';
/*
 * ai.js — العقل: OpenAI-compatible API (OpenAI / Groq / OpenRouter / DeepSeek / محلي)
 * بدون مكتبات خارجية — lib/http.js + lib/crypto.js فقط.
 */
const config = require('./config');
const httpLib = require('./http');
const store = require('./store');

const SYSTEM_PROMPT = `أنت وكيل تداول ذكي متقدم (AI Trading Agent). دورك:

1. تحليل بيانات السوق الحالية (شموع، مؤشرات، اتجاهات).
2. اتخاذ قرار تداول حسب قواعد إدارة المخاطر.
3. إرجاع JSON فقط بدون أي نص إضافي.

يجب أن تردّد دائماً بالصيغة التالية (JSON فقط):
{
  "action": "BUY | SELL | CLOSE | HOLD",
  "symbol": "رمز الزوج",
  "side": "long | short | none",
  "confidence": 0.0 إلى 1.0,
  "reasoning": "سبب القرار (2-5 جمل)",
  "qty": "الحجم المقترح أو null",
  "sl": "سعر وقف الخسارة أو null",
  "tp": "سعر جني الأرباح أو null"
}

قواعد أساسية:
- لا تتداول بأكثر من الحجم المسموح.
- دائماً ضع وقف خسارة.
- إذا شككت أو لم يكن هناك فرصة واضحة → HOLD.
- قلّل المخاطر في الاتجاهات غير الواضحة.
- ركّز على الجودة لا الكمية.`;

async function callAI(messages, extra = {}) {
  const provider = config.get('AI_PROVIDER', 'openai');
  const apiKey = config.get('AI_API_KEY', '');
  const baseUrl = config.get('AI_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = extra.model || config.get('AI_MODEL', 'gpt-4o-mini');
  const temperature = Number(extra.temperature || config.get('AI_TEMPERATURE', '0.2'));

  if (!apiKey) throw new Error('AI_API_KEY غير مضبوط — ضع مفتاح API في الإعدادات');

  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    temperature,
    max_tokens: 1024,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
  };

  const res = await httpLib.post(url, body, {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  });

  if (!res.ok) {
    const errMsg = res.json?.error?.message || res.raw || `HTTP ${res.status}`;
    throw new Error(`AI error (${provider}): ${errMsg}`);
  }

  return res.json;
}

function parseDecision(raw) {
  try {
    const content = raw.choices?.[0]?.message?.content || '';
    const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    return {
      action: parsed.action || 'HOLD',
      symbol: parsed.symbol || '',
      side: parsed.side || 'none',
      confidence: Number(parsed.confidence) || 0,
      reasoning: parsed.reasoning || '',
      qty: parsed.qty || null,
      sl: parsed.sl ? Number(parsed.sl) : null,
      tp: parsed.tp ? Number(parsed.tp) : null,
      rawModel: raw.model || '',
    };
  } catch (e) {
    return { action: 'HOLD', symbol: '', side: 'none', confidence: 0, reasoning: 'فشل تفسير رد الـ AI: ' + e.message, qty: null, sl: null, tp: null };
  }
}

const ai = {
  async analyze(marketData, context = {}) {
    const msg = {
      role: 'user',
      content: `بيانات السوق الحالية:\n${JSON.stringify(marketData, null, 2)}\n\nالسياق:\n${JSON.stringify(context, null, 2)}`,
    };
    const raw = await callAI([msg]);
    const decision = parseDecision(raw);
    decision.model = raw.model || config.get('AI_MODEL');
    decision.provider = config.get('AI_PROVIDER');

    store.addDecision(decision);
    store.addLog({ type: 'ai_decision', level: 'info', msg: `${decision.action} ${decision.symbol} (${(decision.confidence * 100).toFixed(0)}%)` });
    return decision;
  },

  async chat(messages) {
    return callAI(messages);
  },

  async testConnection() {
    try {
      const res = await callAI([{ role: 'user', content: 'قل: متصل' }], { max_tokens: 10 });
      return { ok: true, model: res.model, provider: config.get('AI_PROVIDER') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};

module.exports = ai;
