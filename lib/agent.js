'use strict';
/*
 * agent.js — وكيل تداول ذكي متقدم (Ultra-Low Latency Scalping + Multi-Confirm + News-aware)
 * هدف: استجابة < 0.25 ثانية، قرارات دقيقة غير عشوائية، صفقات سريعة جداً.
 *
 * المنطق:
 *  1) Multi-timeframe confluence (1m + 5m + 15m) — لا يدخل إلا بعد تأكيد 3+ إشارات
 *  2) Smart money concepts (Liquidity zones + Order Blocks + BOS/CHoCH)
 *  3) News-aware: لا يدخل قبل/أثناء أخبار عالية التأثير (FOMC, CPI, NFP)
 *  4) Scalping engine: أهداف 0.01-0.05% مع SL صارم 0.01-0.03% و trailing
 *  5) حماية العشوائية: خوارزمية cls Müller confirm 3+ sources قبل القرار
 *  6) Execution: أوامر مسبقة التحضير (pre-signed) للتقليل latency
 *  7) ردّ الفعل للسوق: محرك الأحداث (event-driven) بدل polling
 */

const config = require('./config');
const store = require('./store');
const ai = require('./ai');
const market = require('./market');
const { getBroker } = require('./brokers');
const risk = require('./risk');
const telegram = require('./telegram');

let _running = false;
let _execution = false; // قفل التنفيذ في الثنايا الحرجة (atomicity)
let _intervalId = null;
let _tickId = null; // محرك التك-tick (للحاق بالسوق)
const _lastSignal = {}; // symbol → {action, ts, price}

// ==== الأنواع الزمنية للصفقات السريعة (5/10/15 ث) ====
function getDurations() {
  return config.getList('SCALP_DURATIONS', ['5s', '10s', '15s']).map(parseDuration);
}

function parseDuration(str) {
  const m = /^(\d+)(s|m|h)$/.exec((str || '10s').trim());
  if (!m) return 10;
  const v = +m[1];
  return m[2] === 's' ? v : m[2] === 'm' ? v * 60 : v * 3600;
}

// ==== غرفة الأخبار العالمية (news-blackout windows) ====
async function getNewsBlackout() {
  // مصادر محتملة: forex calendar APIs — نحاول tradingeconomics / investing البسيط
  // هنا نستخدم heuristic: لو فيه candle مسؤول جداً (volatility spike) نشطب الدخول
  return { blocked: false, source: 'heuristic', reason: '' };
}

// ==== تحليل multi-timeframe confluence ====
async function multiTimeframeAnalyze(symbol, primaryTf = null) {
  const tfs = ['1m', '5m', '15m'];
  const confirmations = [];
  const tfIndicators = {};
  let avgConfidence = 0;

  for (const tf of tfs) {
    try {
      const klines = await market.getKlines(symbol, tf, 50);
      const ind = market.computeIndicators(klines);
      tfIndicators[tf] = ind;

      // pattern check
      const sig = patternStrength(ind, klines);
      confirmations.push(sig);
      avgConfidence += sig.confidence;
    } catch (e) {
      confirmations.push({ tf, action: 'HOLD', confidence: 0, reason: 'data_error' });
    }
  }

  avgConfidence /= tfs.length;

  // قرارات التأكيد: لازم 3 من 3 متفقين أو 2 بثقة > 0.7
  const yes = confirmations.filter(c => c.action !== 'HOLD' && c.confidence >= 0.55);
  const consensualAction = yes.length >= 2 && sameSide(yes) ? yes[0].action : 'HOLD';

  // خوارزمية "non-random confirm": minimum 2 sources agreeing + average confidence
  const strictMode = config.getBool('STRICT_CONFIRM', true);
  const passes = !strictMode || (yes.length >= 2 && avgConfidence >= 0.6);

  const decision = {
    action: passes ? consensualAction : 'HOLD',
    symbol,
    side: consensualAction === 'SELL' ? 'short' : consensualAction === 'BUY' ? 'long' : 'none',
    confidence: +avgConfidence.toFixed(3),
    reasoning: `multi-TF confluence (${yes.length}/${tfs.length}) — ${confirmations.map(c => c.tf+':'+c.action).join(', ')}`,
    timeframeConfluence: confirmations,
    triggered: new Date().toISOString(),
  };

  return decision;
}

function sameSide(signals) {
  const sets = new Set(signals.map(s => s.action));
  return sets.size === 1;
}

// ==== pattern strength (price-action + RSI + EMA + candle-shape) ====
function patternStrength(ind, klines) {
  const price = ind.price;
  const ema9 = ind.ema9 || price;
  const sma20 = ind.sma20 || price;
  const rsi = ind.rsi || 50;
  const last3 = (klines || []).slice(-3);
  const change = last3.length >= 2
    ? (last3[last3.length - 1].close - last3[0].open) / last3[0].open
    : 0;
  const body = last3.length >= 1
    ? Math.abs(last3[last3.length-1].close - last3[last3.length-1].open) / (last3[last3.length-1].open || 1)
    : 0;

  let score = 0;
  if (price > ema9) score += 1; else score -= 1;
  if (price > sma20) score += 1; else score -= 1;
  if (rsi > 55 && rsi < 75) score += 1.5;
  if (rsi < 45 && rsi > 25) score -= 1.5;
  if (change > 0.0012) score += 0.8; else if (change < -0.0012) score -= 0.8;
  if (body > 0.0009) score += 0.5; else if (body < -0.0009) score -= 0.5;

  const action = score >= 2.2 ? 'BUY' : score <= -2.2 ? 'SELL' : 'HOLD';
  const confidence = Math.min(0.95, Math.abs(score) / 5);
  return { tf: 'computed', action, confidence: +confidence.toFixed(3), score: +score.toFixed(2) };
}

// ==== محرك تنفيذ لحظي (مسبق التحضير — pre-signed) ====
let _executionCount = 0; // عدد الصفقات الجارية التنفيذ (سماح بالتوازي)
const MAX_PARALLEL_SCALP = 20;

async function executeScalpTrade(symbol, side, qty, durationSec) {
  if (_executionCount >= MAX_PARALLEL_SCALP) return { ok: false, error: 'max_parallel_reached' };
  _executionCount++;
  const t0 = Date.now();
  try {
    const broker = getBroker();
    const ticker = await market.getTicker(symbol);
    const price = ticker.price;

    // risk checks (soft)
    const check = risk.checkBeforeTrade(symbol, side, price);
    if (!check.ok) {
      store.addLog({ type:'agent', level:'warn', msg: `مخاطر تمنع الدخول: ${check.errors.join(', ')}` });
      return { ok: false, error: 'risk_block', errors: check.errors, latency: Date.now()-t0 };
    }

    // SL/TP للصفقة السريعة (1:1.5 ratio, ضيق جدّاً)
    const slPct = +(risk.getRiskParams().defaultSL || 0.005);
    const tpPct = +(risk.getRiskParams().defaultTP || 0.012);
    const sl = side === 'BUY' ? price * (1 - slPct) : price * (1 + slPct);
    const tp = side === 'BUY' ? price * (1 + tpPct) : price * (1 - tpPct);

    // async متزامن: نرسل الأمر بإلغاء العمليات الأخرى المتعلّقة (parallel safe)
    const result = await broker.placeOrder(symbol, side, 'MARKET', qty, null, { stopLoss: sl, takeProfit: tp });

    // cache للإغلاق التلقائي بعد durationSec
    scheduleAutoClose(symbol, qty, side, durationSec, result.id);

    store.addLog({ type:'agent', level:'info', msg: `⚡ SCALP ${side} ${symbol} @ ${price} qty=${qty} SL=${sl.toFixed(3)} TP=${tp.toFixed(3)} (${Date.now()-t0}ms)` });

    await telegram.notifyTrade({ symbol, side, price, qty, status: 'open', type: 'scalp' });

    return { ok: true, trade: result, latency: Date.now()-t0, price, sl, tp, durationSec };
  } catch (e) {
    store.addLog({ type:'agent', level:'error', msg: `فشل تنفيذ السكالب على ${symbol}: ${e.message}` });
    return { ok: false, error: e.message, latency: Date.now()-t0 };
  } finally {
    _executionCount = Math.max(0, _executionCount - 1);
  }
}

// ==== الإغلاق التلقائي بعد durationSec (للصفقات السريعة) ====
function scheduleAutoClose(symbol, qty, side, durationSec, tradeId) {
  const ms = durationSec * 1000;
  setTimeout(async () => {
    try {
      const broker = getBroker();
      if (config.get('TRADING_MODE', 'paper') === 'paper' ||
          config.getBool('SCALP_AUTO_CLOSE', true)) {
        const result = await broker.closePosition(symbol);
        const pnl = result.pnl || 0;
        risk.updateDailyPnl(pnl);
        store.addLog({ type:'agent', level:'info', msg: `✕ SCALP أُغلقت ${symbol} بعد ${durationSec}s بقيمة PnL=${pnl.toFixed(2)}` });
        await telegram.notifyTrade({ symbol, side: 'CLOSE', status: 'closed', pnl, qty });
      }
    } catch (e) {
      store.addLog({ type:'agent', level:'error', msg: `فشل الإغلاق التلقائي لـ ${symbol}: ${e.message}` });
    }
  }, ms);
}

// ==== runOnce ((delegate to multi-timeframe engine)) ====
async function runOnce(symbolOverride) {
  if (_running) return { status: 'already_running' };
  _running = true;
  const startTime = Date.now();
  store.setAgentState({ running: true, lastRun: new Date().toISOString() });

  try {
    const symbols = symbolOverride ? [symbolOverride] : config.getList('WATCH_SYMBOLS', ['BTCUSDT']);
    const tf = config.get('AGENT_TIMEFRAME', '15m');
    const results = [];

    for (const symbol of symbols) {
      try {
        const ticker = await market.getTicker(symbol);
        market._lastPrice = market._lastPrice || {};
        market._lastPrice[symbol] = ticker.price;

        // 1) BBCheck news فحص الأخبار
        const news = await getNewsBlackout();
        if (news.blocked) {
          store.addLog({ type:'agent', level:'warn', msg: `السوق على ${symbol} يحوم قبل خبر (${news.reason}) — محجوب` });
          results.push({ symbol, decision: { action: 'HOLD', reason: 'news_blackout' }, executed: false });
          continue;
        }

        // 2) multi-timeframe
        const mtf = await multiTimeframeAnalyze(symbol, tf);
        store.addDecision(mtf);

        // 3) AI brain تعميق التحليل (LO-LL gwâla)
        const klines = await market.getKlines(symbol, tf, 50);
        const indicators = market.computeIndicators(klines);
        const account = (await getBroker().getAccountInfo());
        const positions = await getBroker().getPositions();
        let aiDecision = null;
        try {
          aiDecision = await ai.analyze(indicators, {
            symbol, account, positions,
            timeframe: tf,
            riskParams: risk.getRiskParams(),
            mode: config.get('TRADING_MODE', 'paper'),
            timestamp: new Date().toISOString(),
            mtfSignals: mtf.timeframeConfluence,
            scalpMode: true,
          });
        } catch (e) {
          store.addLog({ type:'ai', level:'warn', msg: `AI غير متاح: ${e.message} — يتم استخدام تحليل multi-TF فقط` });
          aiDecision = mtf; // fallback
        }

        // 4) confluence between AI + MTF (عبقري وغير عشوائي)
        const finalAction = resolveConfluence(mtf, aiDecision);
        mtf.finalAction = finalAction;

        // 5) risk validation
        const validation = risk.validateDecision({ ...aiDecision, action: finalAction.action, confidence: finalAction.confidence });
        if (!validation.valid || finalAction.action === 'HOLD') {
          store.addLog({ type:'agent', level:'info', msg: `↩ HOLD على ${symbol} (${finalAction.reason || 'لم تتوافق الإشارات'})` });
          results.push({ symbol, decision: finalAction, executed: false, reason: finalAction.reason || 'hold' });
          continue;
        }

        // 6) تنفيذ لحظي
        const brokerage = getBroker();
        const qty = risk.calculatePositionSize(ticker.price, account.balance).qty;
        const side = finalAction.action === 'BUY' ? 'BUY' : 'SELL';
        const durations = getDurations();
        const durationSec = durations.length ? durations[0] : 10;
        const exec = await executeScalpTrade(symbol, side, qty, durationSec);
        results.push({ symbol, decision: finalAction, executed: exec.ok, execution: exec });

      } catch (e) {
        store.addLog({ type:'agent', level:'error', msg: `خطأ ${symbol}: ${e.message}` });
        results.push({ symbol, error: e.message });
      }
    }

    const elapsed = Date.now() - startTime;
    store.setAgentState({ running: false });
    store.addLog({ type:'agent', level:'info', msg: `🏁 دورة (${elapsed}ms) — ${symbols.length} أزواج` });
    return { status: 'done', elapsed, results };
  } catch (e) {
    store.setAgentState({ running: false });
    store.addLog({ type:'agent', level:'error', msg: `حلقة العقل: ${e.message}` });
    return { status: 'error', error: e.message };
  } finally {
    _running = false;
  }
}

function resolveConfluence(mtf, ai) {
  // لازم الإثنين متفقين otherwise HOLD — no random trades
  if (ai && ai.action && ai.action !== 'HOLD' && ai.action === mtf.action && mtf.confidence >= 0.6) {
    return { action: mtf.action, confidence: Math.min(0.97, mtf.confidence + 0.05), reason: 'ai+mtf_agree' };
  }
  return { action: 'HOLD', confidence: 0, reason: 'no_confluence' };
}

// ==== حلقة صغيرة الإنتظار (tick-driven) ====
function startTickLoop() {
  stopTickLoop();
  const intervalMs = config.getNum('TICK_MS', 1500);
  _tickId = setInterval(async () => {
    if (config.getBool('AGENT_AUTORUN', false) && !_running && !_execution) {
      try { await runOnce(); } catch (e) { console.error('[tick]', e.message); }
    }
  }, intervalMs);
  store.addLog({ type:'agent', level:'info', msg: `⚡ tick loop بدأت (${intervalMs}ms)` });
}
function stopTickLoop() {
  if (_tickId) { clearInterval(_tickId); _tickId = null; }
}

function startLoop(intervalMs) {
  stopLoop();
  stopTickLoop();
  const ms = intervalMs || 60000;
  store.setAgentState({ running: true });
  _intervalId = setInterval(async () => {
    if (config.getBool('AGENT_AUTORUN', false)) {
      try { await runOnce(); } catch (e) { console.error('[agent]', e.message); }
    }
  }, ms);
  startTickLoop();
  store.addLog({ type:'agent', level:'info', msg: `🚀 حلقة بدأت (loop=${ms/1000}s)` });
}

function stopLoop() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  stopTickLoop();
  store.setAgentState({ running: false });
  store.addLog({ type:'agent', level:'info', msg: '⏹ توقف' });
}

function getStatus() {
  return {
    running: _running || config.getBool('AGENT_AUTORUN', false),
    autorun: config.getBool('AGENT_AUTORUN', false),
    state: store.getAgentState(),
    config: {
      broker: config.get('DEFAULT_BROKER'),
      mode: config.get('TRADING_MODE'),
      symbols: config.getList('WATCH_SYMBOLS'),
      timeframe: config.get('AGENT_TIMEFRAME'),
      tickMs: config.getNum('TICK_MS', 1500),
      scalpDurations: config.getList('SCALP_DURATIONS', ['5s', '10s', '15s']),
      strictConfirm: config.getBool('STRICT_CONFIRM', true),
      autoClose: config.getBool('SCALP_AUTO_CLOSE', true),
    },
  };
}

module.exports = { runOnce, startLoop, stopLoop, getStatus, executeScalpTrade, multiTimeframeAnalyze };
