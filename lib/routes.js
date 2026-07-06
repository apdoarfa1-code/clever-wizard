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
const { getBroker, getAvailableBrokers } = require('./brokers');
const risk = require('./risk');
const telegram = require('./telegram');
const agent = require('./agent');

function jsonResponse(data, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) };
}

function errorResponse(msg, status = 500) {
  return jsonResponse({ error: msg }, status);
}

function parseBody(bodyStr) {
  try { return JSON.parse(bodyStr || '{}'); }
  catch { return {}; }
}

function parseUrl(url) {
  const [pathname, qs] = url.split('?');
  const query = {};
  if (qs) qs.split('&').forEach(p => { const [k, v] = p.split('='); query[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
  return { pathname, query };
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
      // فحص كلمة سر Live (لو فيه)
      if (body.TRADING_MODE === 'live' && config.get('LIVE_UNLOCK_PASSWORD')) {
        if (body.livePassword !== config.get('LIVE_UNLOCK_PASSWORD')) {
          return errorResponse('كلمة سر Live غير صحيحة', 403);
        }
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

  // البروكرات المتاحة
  { method: 'GET', path: '/api/brokers', handler: async () => {
    return jsonResponse({ brokers: await getAvailableBrokers() });
  }},

  // سجل
  { method: 'GET', path: '/api/logs', handler: async () => {
    return jsonResponse({ logs: store.getLogs() });
  }},

  // إحصائيات
  { method: 'GET', path: '/api/stats', handler: async () => {
    return jsonResponse({ stats: store.getStats(), agentState: store.getAgentState() });
  }},
];

// ---- Router ----
async function handleRequest(method, url, headers, body) {
  const { pathname } = parseUrl(url);

  // serve static files
  if (!pathname.startsWith('/api/')) {
    return null; // السيرفر الرئيسي يعالج الملفات الثابتة
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    return { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Length': '0' }, body: '' };
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
