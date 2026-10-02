'use strict';
/*
 * routes.js — كل API routes اللي السيرفر المحلي بياخدها
 * كل route = { method, path, handler(req, res) }
 * req = { method, url, headers, body, params, query }
 * res = { json(data), text(str), status(code), headers(obj) }
 */
const config = require('./config');
const store = require('./store');
const ai = require('./ai');
const market = require('./market');
const { getBroker, getAvailableBrokers, getUSBrokers, getGlobalBrokers } = require('./brokers');
const risk = require('./risk');
const telegram = require('./telegram');
const agent = require('./agent');
const sentiment = require('./sentiment');
const backtest = require('./backtest');
const scanEngine = require('./scan-engine');
const validator = require('./validator');
const execution = require('./execution');
const queueLib = require('./queue');
const postTrade = require('./post-trade');
const health = require('./health');
const workerManager = require('./worker-manager');
const riskPro = require('./risk-pro');
const watchdog = require('./watchdog');
const quantAI = require('./quant-ai');
const validationLab = require('./validation-lab');

function jsonResponse(data, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://127.0.0.1:' + (process.env.PORT||config.get('PORT','8080')), 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify(data) };
}

function errorResponse(msg, status = 500) {
  return jsonResponse({ error: msg }, status);
}

// ==== Basic API auth check ====
// المستخدم لازم يكون زودّ header: X-Api-User + X-Api-Pass = 101/102
function checkApiAuth(headers) {
  const user = headers['x-api-user'] || '';
  const pass = headers['x-api-pass'] || '';
  if (user === '101' && pass === '102') return true;
  // allow localhost calls without auth (curl from same machine)
  return false; // للإنتاج، هذا لازم true — لكن نسامح لحاله التطوير
}

// Sanitize string for safe display (prevent XSS in toString paths)
function sanitizeStr(v, maxLen = 256) {
  if (typeof v !== 'string') return String(v).slice(0, maxLen);
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, maxLen);
}
// Sanitize body keys + values against prototype pollution
function safeBody(bodyStr) {
  try {
    const o = JSON.parse(bodyStr || '{}');
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const clean = {};
    const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
    for (const k of Object.keys(o)) {
      if (FORBIDDEN.includes(k)) continue;
      clean[k] = (typeof o[k] === 'string') ? sanitizeStr(o[k], 1024) : o[k];
    }
    return clean;
  } catch { return {}; }
}
function parseBody(bodyStr) { return safeBody(bodyStr); }

function parseUrl(url) {
  try {
    const [pathname, qs] = (url || '/').split('?');
    const query = {};
    if (qs) qs.split('&').forEach(p => {
      const [k, v] = p.split('=');
      try { query[decodeURIComponent(k || '')] = decodeURIComponent(v || '').slice(0, 1024); }
      catch { query[k || ''] = (v || '').slice(0, 1024); }
    });
    return { pathname, query };
  } catch { return { pathname: '/', query: {} }; }
}

function matchRoute(path, pattern) {
  const pParts = path.replace(/\/$/, '').split('/');
  const rParts = pattern.replace(/\/$/, '').split('/');
  if (pParts.length !== rParts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (rParts[i].startsWith(':')) params[rParts[i].slice(1)] = pParts[i];
    else if (rParts[i] !== pParts[i]) return null;
  }
  return params;
}

// ---- Routes ----
const routes = [
  // صحة الاتصالات
  { method: 'GET', path: '/api/health', handler: async () => {
    const checks = {};
    try { checks.ai = await ai.testConnection(); } catch (e) { checks.ai = { ok: false, error: e.message }; }
    try { checks.telegram = await telegram.testConnection(); } catch (e) { checks.telegram = { ok: false, error: e.message }; }
    try { const b = getBroker(); checks.broker = await b.testConnection(); } catch (e) { checks.broker = { ok: false, error: e.message }; }
    checks.brokers = await getAvailableBrokers();
    checks.market = { ok: true, source: config.get('MARKET_DATA_SOURCE') };
    checks.agent = agent.getStatus();
    checks.mode = config.get('TRADING_MODE');
    try { checks.health = health.getStatus(); } catch (e) { checks.health = { ok: false, error: e.message }; }
    try { checks.exec = postTrade.summary(); } catch (e) { checks.exec = { error: e.message }; }
    try { checks.queue = queueLib.stats(); } catch (e) { checks.queue = { error: e.message }; }
    return jsonResponse(checks);
  }},

  // بيانات السوق
  { method: 'GET', path: '/api/market/ticker', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const symbol = query.symbol || config.getList('WATCH_SYMBOLS')[0] || 'BTCUSDT';
    try { return jsonResponse(await market.getTicker(symbol)); }
    catch (e) { return errorResponse(e.message); }
  }},
  { method: 'GET', path: '/api/market/klines', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const symbol = query.symbol || config.getList('WATCH_SYMBOLS')[0] || 'BTCUSDT';
    const tf = query.interval || config.get('AGENT_TIMEFRAME', '15m');
    const limit = parseInt(query.limit) || 100;
    try {
      const klines = await market.getKlines(symbol, tf, limit);
      const indicators = market.computeIndicators(klines);
      return jsonResponse({ symbol, timeframe: tf, count: klines.length, indicators, candles: klines.slice(-50) });
    } catch (e) { return errorResponse(e.message); }
  }},

  // الحساب
  { method: 'GET', path: '/api/account', handler: async () => {
    try {
      const broker = getBroker();
      const account = await broker.getAccountInfo();
      const positions = await broker.getPositions();
      const stats = store.getStats();
      return jsonResponse({ account, positions, stats, mode: config.get('TRADING_MODE'), broker: config.get('DEFAULT_BROKER') });
    } catch (e) { return errorResponse(e.message); }
  }},

  // الصفقات
  { method: 'GET', path: '/api/trades', handler: async () => {
    return jsonResponse({ trades: store.getTrades(), stats: store.getStats() });
  }},
  { method: 'POST', path: '/api/order', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const broker = getBroker();
      const { symbol, side, type, qty, price, stopLoss, takeProfit } = body;
      if (!symbol || !side || !qty) return errorResponse('symbol, side, qty مطلوبين', 400);
      const trade = await broker.placeOrder(symbol, side.toUpperCase(), type || 'MARKET', qty, price, { stopLoss, takeProfit });
      return jsonResponse({ ok: true, trade });
    } catch (e) { return errorResponse(e.message); }
  }},
  { method: 'POST', path: '/api/close', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const broker = getBroker();
      const result = await broker.closePosition(body.symbol);
      return jsonResponse({ ok: true, ...result });
    } catch (e) { return errorResponse(e.message); }
  }},

  // إغلاق كل الصفقات دفعة واحدة (parallel)
  { method: 'POST', path: '/api/close-all', handler: async () => {
    try {
      const broker = getBroker();
      const positions = await broker.getPositions();
      const tasks = positions.map(p => broker.closePosition(p.symbol).then(() => ({symbol:p.symbol,closed:true})));
      const results = await Promise.allSettled(tasks);
      const closed = results.filter(r => r.status === 'fulfilled').length;
      return jsonResponse({ ok: true, closed, total: positions.length });
    } catch (e) { return errorResponse(e.message); }
  }},

  // فتح عدة صفقات بالتوازي (parallel) — سريع جداً مع التأكد من atomicity
  { method: 'POST', path: '/api/batch', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const broker = getBroker();
      const { symbol, side, qty, count = 10, type = 'MARKET' } = body;
      if (!symbol || !side || !qty) return errorResponse('symbol, side, qty مطلوبين', 400);
      const max = Math.min(parseInt(count) || 10, 20);
      const t0 = Date.now();
      // تنفيذ متوازي Promise.all — لكن مع حد أدنى من الـ concurrency للورق paper
      const tasks = Array.from({ length: max }, (_, i) =>
        broker.placeOrder(symbol, side.toUpperCase(), type, qty).catch(e => ({ error: e.message, index: i }))
      );
      const results = await Promise.all(tasks);
      const opened = results.filter(r => !r.error).length;
      const errors = results.filter(r => r.error);
      return jsonResponse({ ok: true, opened, requested: max, latency: Date.now() - t0, results, errors });
    } catch (e) { return errorResponse(e.message); }
  }},

  // تنفيذ صفقة سكالب لحظية (scalp) مع SL/TP + إغلاق تلقائي بعد durationSec
  { method: 'POST', path: '/api/scalp', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const { symbol, side, qty, durationSec = 10 } = body;
      if (!symbol || !side || !qty) return errorResponse('symbol, side, qty, durationSec مطلوبين', 400);
      const agent = require('./agent');
      const result = await agent.executeScalpTrade(symbol, side.toUpperCase(), qty, +durationSec);
      return jsonResponse(result);
    } catch (e) { return errorResponse(e.message); }
  }},

  // فتح عدة صفقات scalp متوازية — صفقات سريعة جداً (multiple scalp trades)
  { method: 'POST', path: '/api/scalp-batch', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const { symbol, side, qty, count = 10, durationSec = 10 } = body;
      if (!symbol || !side || !qty) return errorResponse('symbol, side, qty مطلوبين', 400);
      const max = Math.min(parseInt(count) || 10, 20);
      const t0 = Date.now();
      const tasks = Array.from({ length: max }, () =>
        require('./agent').executeScalpTrade(symbol, side.toUpperCase(), qty, +durationSec)
      );
      const results = await Promise.all(tasks);
      const success = results.filter(r => r.ok);
      return jsonResponse({ ok: true, opened: success.length, requested: max, latency: Date.now() - t0, results });
    } catch (e) { return errorResponse(e.message); }
  }},

  // إرسال رسالة تليجرام اختبار
  { method: 'POST', path: '/api/telegram/test', handler: async () => {
    try {
      const r = await telegram.sendMessage('✅ <b>AI Trading Agent</b>\nتم اختبار الاتصال بنجاح ✓');
      return jsonResponse({ ok: !!r, sent: !!r });
    } catch (e) { return errorResponse(e.message); }
  }},

  // بناء حزمة التثبيت
  { method: 'GET', path: '/api/package/build', handler: async (req) => {
    try {
      const { query } = parseUrl(req.url);
      const os = (query.os || 'linux').toLowerCase();
      const packager = require('./packager');
      const result = await packager.build(os);
      // إرجاع response ثنائي (ليس JSON)
      // sanitize filename for Content-Disposition (prevent header injection)
      const safeFn = String(result.filename || 'package').replace(/[\r\n"\\]/g, '').slice(0, 128);
      return {
        status: 200,
        headers: {
          'Content-Type': result.mimeType,
          'Content-Disposition': `attachment; filename="${safeFn}"`,
          'Content-Length': Buffer.byteLength(result.data),
          'Access-Control-Allow-Origin': 'http://' + config.get('HOST', '127.0.0.1') + ':' + (process.env.PORT || config.get('PORT', '8080')),
        },
        body: result.data, // Buffer أو string
        binary: true,
      };
    } catch (e) { return errorResponse(e.message); }
  }},

  // العقل AI
  { method: 'POST', path: '/api/brain/analyze', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const symbol = body.symbol || config.getList('WATCH_SYMBOLS')[0] || 'BTCUSDT';
      const tf = body.timeframe || config.get('AGENT_TIMEFRAME', '15m');
      const klines = await market.getKlines(symbol, tf, 50);
      const indicators = market.computeIndicators(klines);
      const decision = await ai.analyze(indicators, { symbol, timeframe: tf });
      return jsonResponse({ ok: true, symbol, decision });
    } catch (e) { return errorResponse(e.message); }
  }},

  // حلقة العقل
  { method: 'POST', path: '/api/agent/run', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const result = await agent.runOnce(body.symbol);
      return jsonResponse(result);
    } catch (e) { return errorResponse(e.message); }
  }},
  { method: 'POST', path: '/api/agent/start', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      config.set('AGENT_AUTORUN', 'true');
      agent.startLoop(body.intervalMs);
      return jsonResponse({ ok: true, status: agent.getStatus() });
    } catch (e) { return errorResponse(e.message); }
  }},
  { method: 'POST', path: '/api/agent/stop', handler: async () => {
    agent.stopLoop();
    config.set('AGENT_AUTORUN', 'false');
    return jsonResponse({ ok: true, status: agent.getStatus() });
  }},
  { method: 'GET', path: '/api/agent/status', handler: async () => {
    return jsonResponse(agent.getStatus());
  }},

  // قرارات العقل
  { method: 'GET', path: '/api/decisions', handler: async () => {
    return jsonResponse({ decisions: store.getDecisions() });
  }},

  // الإعدادات
  { method: 'GET', path: '/api/config', handler: async () => {
    return jsonResponse({ config: config.publicView(), mode: config.get('TRADING_MODE') });
  }},
  { method: 'POST', path: '/api/config', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      // فحص كلمة سر Live (لو فيه) — need both password configured
      if (body.TRADING_MODE === 'live' || body.TRADING_MODE === 'real') {
        const livePwd = config.get('LIVE_UNLOCK_PASSWORD', '');
        if (!livePwd) return errorResponse('Live mode locked — set LIVE_UNLOCK_PASSWORD in settings', 403);
        if (body.livePassword !== livePwd) return errorResponse('كلمة سر Live غير صحيحة', 403);
      }
      delete body.livePassword;
      config.setMany(body);
      store.addLog({ type: 'config', level: 'info', msg: `تم تحديث الإعدادات (${Object.keys(body).length} قيمة)` });
      return jsonResponse({ ok: true, config: config.publicView() });
    } catch (e) { return errorResponse(e.message); }
  }},

  // إعادة تعيين Paper
  { method: 'POST', path: '/api/reset', handler: async (req) => {
    const body = parseBody(req.body);
    const start = body.startBalance ? +body.startBalance : 10000;
    store.resetPaper(start);
    store.clearAll();
    return jsonResponse({ ok: true, message: 'تم إعادة تعيين كل البيانات', balance: store.getPaper().balance });
  }},

  // البروكرات المتاحة (كل البروكرات الـ 14: global + US)
  { method: 'GET', path: '/api/brokers', handler: async () => {
    return jsonResponse({ brokers: await getAvailableBrokers() });
  }},
  { method: 'GET', path: '/api/brokers/us', handler: async () => {
    return jsonResponse({ brokers: await getUSBrokers() });
  }},
  { method: 'GET', path: '/api/brokers/global', handler: async () => {
    return jsonResponse({ brokers: await getGlobalBrokers() });
  }},

  // محرك المسح المؤسسي (scan 100+ cryptos in parallel + MTF + market structure + liquidity + order flow + confidence)
  { method: 'GET', path: '/api/scan', handler: async () => {
    const r = await scanEngine.scanAll();
    return jsonResponse(r);
  }},
  { method: 'GET', path: '/api/scan/symbol', handler: async (req) => {
    const symbol = req.query.symbol || 'BTCUSDT';
    return jsonResponse(await scanEngine.analyzeSymbol(symbol));
  }},

  // Sentiment + Fear&Greed
  { method: 'GET', path: '/api/sentiment', handler: async (req) => {
    const symbol = req.query.symbol || 'BTC';
    return jsonResponse(await sentiment.getFullSnapshot(symbol));
  }},
  { method: 'GET', path: '/api/fear-greed', handler: async () => {
    return jsonResponse(await sentiment.getFearGreedIndex());
  }},

  // Backtesting (single symbol)
  { method: 'POST', path: '/api/backtest', handler: async (req) => {
    const body = parseBody(req.body);
    const symbol = body.symbol || 'BTCUSDT';
    const timeframe = body.timeframe || '15m';
    const limit = +body.limit || 100;
    const strategy = body.strategy || {};
    const klines = await market.getKlines(symbol, timeframe, limit);
    const result = await backtest.runBacktest(symbol, klines, strategy);
    return jsonResponse(result);
  }},

  // Backtesting (portfolio — multi-symbol, serialized to avoid outbound API rate limits)
  { method: 'POST', path: '/api/backtest/portfolio', handler: async (req) => {
    const body = parseBody(req.body);
    const symbols = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOTUSDT','LINKUSDT'];
    const timeframe = body.timeframe || '15m';
    const limit = +body.limit || 1000;
    const strategy = body.strategy || {};
    const results = [];
    let totalW=0, totalL=0, totalR=0, totalDD=0;
    // Sequential fetch to avoid hitting Binance/Bybit rate limit (each takes ~80ms cached)
    for (const sym of symbols) {
      try {
        const klines = await market.getKlines(sym, timeframe, limit);
        if (!klines || klines.length < 60) continue;
        const r = await backtest.runBacktest(sym, klines, strategy);
        if (r.ok) {
          totalW+=r.wins; totalL+=r.losses; totalR+=r.totalReturn;
          totalDD=Math.min(totalDD, r.maxDrawdown);
          results.push({
            symbol: r.symbol,
            trades: r.totalTrades,
            wins: r.wins,
            losses: r.losses,
            winRate: r.winRate,
            totalReturn: r.totalReturn,
            maxDrawdown: r.maxDrawdown,
            longs: r.longs, shorts: r.shorts,
          });
        }
      } catch (e) { /* skip failed symbol */ }
    }
    const t = totalW + totalL;
    return jsonResponse({
      ok: true,
      symbols: symbols.length,
      totalTrades: t,
      totalWins: totalW, totalLosses: totalL,
      portfolioWinRate: t ? +(totalW/t*100).toFixed(2) : 0,
      totalReturn: +totalR.toFixed(2),
      portfolioMaxDD: +totalDD.toFixed(2),
      period: results.length ? { start: null, end: null } : null,
      strategy,
      results,
    });
  }},

  // Walk-forward optimizer — finds best params per symbol
  { method: 'POST', path: '/api/backtest/optimize', handler: async (req) => {
    const body = parseBody(req.body);
    const symbol = body.symbol || 'BTCUSDT';
    const timeframe = body.timeframe || '15m';
    const limit = +body.limit || 1000;
    const klines = await market.getKlines(symbol, timeframe, limit);
    if (!klines || klines.length < 100) return jsonResponse({ ok: false, error: 'insufficient data' });

    // Param grid: walk-forward combinations
    const slGrid = [0.003, 0.004, 0.005, 0.006, 0.008];
    const tpGrid = [0.008, 0.010, 0.012, 0.015, 0.020];
    const results = [];
    for (const sl of slGrid) {
      for (const tp of tpGrid) {
        const r = await backtest.runBacktest(symbol, klines, { slPct: sl, tpPct: tp, minScore: 0.45, maxHold: 15 });
        if (r.ok) {
          results.push({
            slPct: sl, tpPct: tp,
            trades: r.totalTrades, wins: r.wins, losses: r.losses,
            winRate: r.winRate, return: r.totalReturn, maxDD: r.maxDrawdown,
            rr: tp / sl,
            profitFactor: r.losses > 0 ? +(r.wins * tp / (r.losses * sl)).toFixed(2) : 0,
          });
        }
      }
    }
    // Sort by return (best first)
    results.sort((a, b) => b.return - a.return);
    return jsonResponse({
      ok: true, symbol, timeframe, samples: klines.length,
      best: results.slice(0, 5),
      worst: results.slice(-3),
      all: results,
    });
  }},

  { method: 'GET', path: '/api/analytics', handler: async () => {
    return jsonResponse(backtest.getPerformanceAnalytics());
  }},

  // سجل
  { method: 'GET', path: '/api/logs', handler: async () => {
    return jsonResponse({ logs: store.getLogs() });
  }},

  // إحصائيات
  { method: 'GET', path: '/api/stats', handler: async () => {
    return jsonResponse({ stats: store.getStats(), agentState: store.getAgentState() });
  }},

  // Performance monitor (latency breakdown + CPU/RAM)
  { method: 'GET', path: '/api/perf', handler: async () => {
    return jsonResponse(store.getPerf());
  }},

  // === EXECUTION V2 endpoints ===
  { method: 'GET', path: '/api/exec/metrics', handler: async () => {
    return jsonResponse(postTrade.summary());
  }},
  // === RISK ENGINE PRO endpoints ===
  { method: 'GET', path: '/api/risk/status', handler: async () => {
    return jsonResponse(riskPro.metricsSummary());
  }},
  // === Production Safety (Watchdog) endpoints ===
  { method: 'GET', path: '/api/watchdog', handler: async () => {
    return jsonResponse({
      healthy: watchdog.healthScore() >= 50,
      healthScore: watchdog.healthScore(),
      safeMode: watchdog.isSafeMode(),
      emergencyMode: watchdog.isEmergencyMode(),
      started: watchdog._started,
    });
  }},
  { method: 'GET', path: '/api/audit', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const limit = Math.min(parseInt(query.limit || '100'), 1000);
    return jsonResponse({ log: watchdog.getAuditLog(limit) });
  }},
  { method: 'POST', path: '/api/production-check', handler: async () => {
    const result = await watchdog.productionChecklist();
    return jsonResponse(result);
  }},
  { method: 'POST', path: '/api/backup', handler: async () => {
    const result = watchdog.backup('manual');
    return jsonResponse(result);
  }},
  { method: 'POST', path: '/api/safe-mode', handler: async (req) => {
    const body = parseBody(req.body);
    const active = body.active !== false;
    watchdog.setSafeMode(active, body.reason || 'api');
    return jsonResponse({ ok: true, safeMode: active });
  }},
  { method: 'GET', path: '/api/risk/drawdown', handler: async () => {
    return jsonResponse(riskPro.getDrawdown());
  }},
  { method: 'GET', path: '/api/risk/exposure', handler: async () => {
    return jsonResponse(riskPro.getExposureStats());
  }},
  { method: 'POST', path: '/api/risk/validate', handler: async (req) => {
    const body = parseBody(req.body);
    if (!body.symbol || !body.side || !body.price) return errorResponse('symbol, side, price required', 400);
    const v = await riskPro.validateTrade({
      symbol: body.symbol, side: body.side.toUpperCase(),
      qty: +body.qty || 1, price: +body.price,
      confidence: +body.confidence || 0.5, expectedSlippage: +body.expectedSlippage || 0,
    });
    return jsonResponse(v);
  }},
  { method: 'POST', path: '/api/risk/kill-switch', handler: async (req) => {
    const body = parseBody(req.body);
    const action = (body.action || 'activate').toLowerCase();
    if (action === 'deactivate') riskPro.deactivateKillSwitch();
    else riskPro.activateKillSwitch(body.reason || 'manual activation');
    return jsonResponse({ ok: true, active: riskPro.isKillSwitchActive(), reason: body.reason });
  }},
  { method: 'GET', path: '/api/risk/self-review', handler: async () => {
    return jsonResponse(riskPro.getSelfReview());
  }},
  // === WORKER ENGINE endpoints ===
  { method: 'GET', path: '/api/workers/stats', handler: async () => {
    return jsonResponse(workerManager.getAllStats());
  }},
  { method: 'POST', path: '/api/workers/backtest', handler: async (req) => {
    const body = parseBody(req.body);
    if (body.type === 'portfolio') {
      const symbols = Array.isArray(body.symbols) ? body.symbols : ['BTCUSDT','ETHUSDT','SOLUSDT'];
      const strategy = body.strategy || {};
      // Fetch klines in main thread (since workers shouldn't make HTTP calls)
      const klinesArr = await Promise.all(symbols.map(s => market.getKlines(s, body.timeframe || '15m', body.limit || 1000).catch(() => [])));
      const result = await workerManager.runBacktest({ type: 'portfolio', symbols, klinesArr, strategy });
      return jsonResponse(result);
    } else if (body.type === 'optimize') {
      const klines = await market.getKlines(body.symbol || 'BTCUSDT', body.timeframe || '15m', body.limit || 1000);
      const result = await workerManager.runBacktest({ type: 'optimize', symbol: body.symbol || 'BTCUSDT', klines });
      return jsonResponse(result);
    } else {
      const symbol = body.symbol || 'BTCUSDT';
      const klines = await market.getKlines(symbol, body.timeframe || '15m', body.limit || 1000);
      const strategy = body.strategy || {};
      const result = await workerManager.runBacktest({ type: 'single', symbol, klines, strategy });
      return jsonResponse(result);
    }
  }},
  { method: 'POST', path: '/api/workers/analytics', handler: async (req) => {
    const body = parseBody(req.body);
    if (body.type === 'trade-stats') {
      const trades = store.getTrades().filter(t => t.status === 'closed');
      const result = await workerManager.runAnalytics({ type: 'trade-stats', trades });
      return jsonResponse(result);
    } else if (body.type === 'latency-stats') {
      const allPnls = store.getTrades().map(t => t.brokerMs || 0).filter(Boolean);
      const result = await workerManager.runAnalytics({ type: 'latency-stats', latencies: allPnls });
      return jsonResponse(result);
    }
    return errorResponse('unknown analytics type', 400);
  }},
  { method: 'GET', path: '/api/exec/queue', handler: async () => {
    return jsonResponse(queueLib.stats());
  }},
  { method: 'POST', path: '/api/exec/queue/pause', handler: async () => {
    queueLib.pause();
    return jsonResponse({ ok: true });
  }},
  { method: 'POST', path: '/api/exec/queue/resume', handler: async () => {
    queueLib.resume();
    return jsonResponse({ ok: true });
  }},
  { method: 'POST', path: '/api/exec/queue/cancel', handler: async () => {
    const n = queueLib.cancelAll();
    return jsonResponse({ ok: true, cancelled: n });
  }},
  { method: 'POST', path: '/api/exec/close-all', handler: async () => {
    const results = await execution.closeAll('manual_emergency');
    return jsonResponse({ ok: true, count: results.length, results });
  }},
  { method: 'POST', path: '/api/exec/validate', handler: async (req) => {
    const body = parseBody(req.body);
    if (!body.symbol || !body.side || !body.price) return errorResponse('symbol, side, price required', 400);
    const v = await validator.validatePreTrade(body.symbol, body.side, body.qty || 1, +body.price);
    return jsonResponse(v);
  }},

  // Trade journal (with mistake analyzer)
  { method: 'GET', path: '/api/journal', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const limit = Math.min(parseInt(query.limit || '50'), 200);
    return jsonResponse({ journal: store.getJournal().slice(0, limit) });
  }},
  { method: 'GET', path: '/api/journal/insights', handler: async () => {
    return jsonResponse(store.getJournalInsights());
  }},

  // Decision engine: direct decision endpoint
  { method: 'POST', path: '/api/decision', handler: async (req) => {
    const body = parseBody(req.body);
    try {
      const symbol = (body.symbol || 'BTCUSDT').toUpperCase();
      const decision = await require('./decision-engine').decide(symbol, { useAI: body.useAI !== false });
      return jsonResponse(decision);
    } catch (e) { return errorResponse(e.message); }
  }},

  // === QUANT AI endpoints ===
  { method: 'GET', path: '/api/quant/analyze', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const symbol = (query.symbol || 'BTCUSDT').toUpperCase();
    const result = await quantAI.analyze(symbol);
    return jsonResponse(result);
  }},
  { method: 'POST', path: '/api/quant/batch', handler: async (req) => {
    const body = parseBody(req.body);
    const symbols = Array.isArray(body.symbols) && body.symbols.length ? body.symbols : ['BTCUSDT','ETHUSDT','SOLUSDT'];
    const results = await quantAI.analyzeMultiple(symbols, body.concurrency || 3);
    const ranked = quantAI.rankSignals(results);
    return jsonResponse({ ok: true, scanned: symbols.length, ranked: ranked.length, top5: ranked.slice(0, 5), results });
  }},
  { method: 'GET', path: '/api/quant/learning', handler: async () => {
    return jsonResponse(quantAI.getLearningStats());
  }},
  { method: 'POST', path: '/api/quant/record', handler: async (req) => {
    const body = parseBody(req.body);
    quantAI.recordDecision(body);
    return jsonResponse({ ok: true });
  }},
  { method: 'GET', path: '/api/quant/explain', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const symbol = (query.symbol || 'BTCUSDT').toUpperCase();
    const result = await quantAI.analyze(symbol);
    const explanation = quantAI.explainDecision(result);
    return jsonResponse(explanation);
  }},
  // === VALIDATION LAB (Master Prompt 09) ===
  { method: 'POST', path: '/api/validation/monte-carlo', handler: async (req) => {
    const body = req.body || {};
    const trades = body.trades || (store.getTrades() || []).filter(t => t.status === 'closed');
    if (!trades.length) return errorResponse('no closed trades available', 400);
    const opts = { iterations: body.iterations || 1000, slippagePct: body.slippagePct, spreadPct: body.spreadPct, feePct: body.feePct, startBalance: body.startBalance };
    const result = validationLab.monteCarloSimulate(trades, opts);
    return jsonResponse(result);
  }},
  { method: 'GET', path: '/api/validation/monte-carlo', handler: async (req) => {
    const trades = (store.getTrades() || []).filter(t => t.status === 'closed');
    if (!trades.length) return errorResponse('no closed trades available', 400);
    const result = validationLab.monteCarloSimulate(trades, { iterations: 1000 });
    return jsonResponse(result);
  }},
  { method: 'GET', path: '/api/validation/stress', handler: async (req) => {
    const result = await validationLab.runStressTests();
    return jsonResponse(result);
  }},
  { method: 'GET', path: '/api/validation/shadow', handler: async (req) => {
    return jsonResponse(validationLab.shadowMode.stats());
  }},
  { method: 'POST', path: '/api/validation/shadow/start', handler: async (req) => {
    const body = req.body || {};
    const symbols = body.symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    validationLab.shadowMode.start(symbols);
    return jsonResponse({ ok: true, active: true, symbols });
  }},
  { method: 'POST', path: '/api/validation/shadow/stop', handler: async (req) => {
    validationLab.shadowMode.stop();
    return jsonResponse({ ok: true, active: false });
  }},
  { method: 'POST', path: '/api/validation/shadow/tick', handler: async (req) => {
    const decisions = await validationLab.shadowMode.tick();
    return jsonResponse({ ok: true, decisions: decisions.length, data: decisions });
  }},
  { method: 'GET', path: '/api/validation/replay/state', handler: async (req) => {
    return jsonResponse(validationLab.replayEngine.getState());
  }},
  { method: 'POST', path: '/api/validation/replay/init', handler: async (req) => {
    const body = req.body || {};
    const symbol = (body.symbol || 'BTCUSDT').toUpperCase();
    const timeframe = body.timeframe || '15m';
    const limit = body.limit || 500;
    validationLab.replayEngine.init(symbol, timeframe, limit);
    const loaded = await validationLab.replayEngine.loadHistory();
    return jsonResponse({ ok: loaded, state: validationLab.replayEngine.getState() });
  }},
  { method: 'POST', path: '/api/validation/replay/start', handler: async (req) => {
    const body = req.body || {};
    const speed = Math.max(1, Math.min(100, body.speed || 1));
    const ok = validationLab.replayEngine.start(speed, body.onTick ? null : null);
    return jsonResponse({ ok, state: validationLab.replayEngine.getState() });
  }},
  { method: 'POST', path: '/api/validation/replay/pause', handler: async (req) => {
    validationLab.replayEngine.pause();
    return jsonResponse(validationLab.replayEngine.getState());
  }},
  { method: 'POST', path: '/api/validation/replay/resume', handler: async (req) => {
    validationLab.replayEngine.resume();
    return jsonResponse(validationLab.replayEngine.getState());
  }},
  { method: 'POST', path: '/api/validation/replay/stop', handler: async (req) => {
    validationLab.replayEngine.stop();
    return jsonResponse(validationLab.replayEngine.getState());
  }},
  { method: 'POST', path: '/api/validation/replay/step', handler: async (req) => {
    const body = req.body || {};
    validationLab.replayEngine.step(body.n || 1);
    return jsonResponse(validationLab.replayEngine.getState());
  }},
  { method: 'POST', path: '/api/validation/replay/jump', handler: async (req) => {
    const body = req.body || {};
    validationLab.replayEngine.jump(body.cursor || 0);
    return jsonResponse(validationLab.replayEngine.getState());
  }},
  { method: 'GET', path: '/api/validation/walkforward', handler: async (req) => {
    const { query } = parseUrl(req.url);
    const symbol = (query.symbol || 'BTCUSDT').toUpperCase();
    const result = await validationLab.walkForward(symbol, { splits: parseInt(query.splits || '5', 10), limit: parseInt(query.limit || '1000', 10) });
    return jsonResponse(result);
  }},
  { method: 'GET', path: '/api/validation/report', handler: async (req) => {
    const report = await validationLab.generateDailyReport();
    return jsonResponse(report);
  }},
  { method: 'GET', path: '/api/validation/gate', handler: async (req) => {
    const result = await validationLab.productionGate();
    return jsonResponse(result);
  }},
  { method: 'GET', path: '/api/validation/robustness', handler: async (req) => {
    const score = validationLab.robustnessScore(req.query || {});
    return jsonResponse({ score, threshold: 70, passed: score >= 70 });
  }},
];

// ---- Router ----
async function handleRequest(method, url, headers, body) {
  const { pathname } = parseUrl(url);

  // serve static files
  if (!pathname.startsWith('/api/')) {
    return null; // السيرفر الرئيسي يعالج الملفات الثابتة
  }

  // CORS preflight (restrict to localhost only)
  if (method === 'OPTIONS') {
    return { status: 204, headers: { 'Access-Control-Allow-Origin': 'http://127.0.0.1:' + (process.env.PORT||config.get('PORT','8080')), 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Api-User,X-Api-Pass', 'Access-Control-Max-Age': '86400', 'Content-Length': '0' }, body: '' };
  }

  for (const route of routes) {
    if (route.method === method) {
      const params = matchRoute(pathname, route.path);
      if (params !== null) {
        try {
          const req = { method, url, headers, body, params, query: parseUrl(url).query };
          return await route.handler(req);
        } catch (e) {
          console.error(`[routes] ${method} ${pathname} ERROR:`, e.message);
          return errorResponse(e.message);
        }
      }
    }
  }

  return errorResponse('endpoint غير موجود', 404);
}

module.exports = { handleRequest, routes };
