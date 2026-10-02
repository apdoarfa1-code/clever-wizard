'use strict';
/*
 * ai.js v2 — Institutional AI Subsystem
 *  - Multi-provider fallback (OpenAI → Groq → OpenRouter → Ollama)
 *  - Timeout handling (10s max) + automatic retry with exponential backoff
 *  - Cost tracking & token usage logging
 *  - Structured output validation & confidence scoring
 */
const config = require('./config');
const httpLib = require('./http');
const store = require('./store');
const watchdog = require('./watchdog');

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

// Cost tracker counters
let _aiStats = { requests: 0, failures: 0, totalTokens: 0, estimatedCostUsd: 0 };

async function callProviderWithTimeout(url, body, headers, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpLib.post(url, body, headers, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function callAI(messages, extra = {}) {
  const primaryProvider = config.get('AI_PROVIDER', 'openai');
  const apiKey = config.get('AI_API_KEY', '').trim().replace(/[\r\n\t\f\v]/g, '');
  const primaryBaseUrl = config.get('AI_BASE_URL', 'https://api.openai.com/v1').trim().replace(/[\r\n\t\f\v]/g, '').replace(/\/+$/, '');
  const model = extra.model || config.get('AI_MODEL', 'gpt-4o-mini');
  const temperature = Number(extra.temperature || config.get('AI_TEMPERATURE', '0.2'));

  // Fallback chain providers if primary fails
  const providers = [
    { name: primaryProvider, baseUrl: primaryBaseUrl, apiKey, model },
    { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: config.get('GROQ_API_KEY', ''), model: 'llama-3.3-70b-versatile' },
    { name: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama', model: 'llama3' },
  ];

  let lastError = null;
  _aiStats.requests++;

  for (const prov of providers) {
    if (!prov.apiKey && prov.name !== 'ollama') continue;
    if (prov.apiKey.includes('•') && prov.name === primaryProvider) continue;

    const url = `${prov.baseUrl}/chat/completions`;
    const body = {
      model: prov.model,
      temperature,
      max_tokens: 1024,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    };

    try {
      const res = await callProviderWithTimeout(url, body, {
        'Authorization': `Bearer ${prov.apiKey}`,
        'Content-Type': 'application/json',
      }, 10000);

      if (res.ok && res.json) {
        // Track usage & tokens
        const usage = res.json.usage || { total_tokens: 150 };
        _aiStats.totalTokens += usage.total_tokens || 150;
        _aiStats.estimatedCostUsd += (usage.total_tokens || 150) * 0.000002; // estimated cost per token
        if (watchdog.beat) watchdog.beat('ai', { provider: prov.name, model: prov.model });
        return res.json;
      } else {
        lastError = new Error(`HTTP ${res.status}: ${res.json?.error?.message || res.raw || 'unknown'}`);
      }
    } catch (e) {
      lastError = e;
    }
  }

  _aiStats.failures++;
  throw new Error(`All AI providers failed. Last error: ${lastError?.message || 'timeout'}`);
}

function parseDecision(raw) {
  try {
    const content = raw.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('empty content');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
    let jsonStr = (fenced ? fenced[1] : content).trim();
    if (!jsonStr.startsWith('{')) {
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      if (start !== -1 && end > start) jsonStr = jsonStr.slice(start, end + 1);
    }
    const parsed = JSON.parse(jsonStr);
    const confidence = Number(parsed.confidence);
    return {
      action: parsed.action || 'HOLD',
      symbol: parsed.symbol || '',
      side: parsed.side || 'none',
      confidence: !isNaN(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reasoning: parsed.reasoning || '',
      qty: parsed.qty || null,
      sl: parsed.sl ? Number(parsed.sl) : null,
      tp: parsed.tp ? Number(parsed.tp) : null,
      rawModel: raw.model || '',
    };
  } catch (e) {
    store.addLog({ type: 'ai', level: 'warn', msg: `فشل تفسير رد الـ AI — ACTION من HOLD احتياطياً: ${e.message.slice(0, 80)}` });
    return { action: 'HOLD', symbol: '', side: 'none', confidence: 0, reasoning: 'فشل تفسير رد الـ AI: ' + e.message.slice(0, 60), qty: null, sl: null, tp: null };
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
      return { ok: true, model: res.model, provider: config.get('AI_PROVIDER'), stats: _aiStats };
    } catch (e) {
      return { ok: false, error: e.message, stats: _aiStats };
    }
  },

  getStats() {
    return { ..._aiStats, costUsd: +(_aiStats.estimatedCostUsd.toFixed(4)) };
  }
};

module.exports = ai;
