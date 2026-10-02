'use strict';
/*
 * agent.js v4 — Ultra-Low-Latency Scalping Workstation Engine.
 *
 *  v4 changes:
 *   - Uses new unified decision-engine (LONG/SHORT/WAIT/NO_TRADE)
 *   - Parallel MTF fetch (1m + 5m + 15m concurrent)
 *   - Parallel symbols in runOnce (Promise.all)
 *   - ATR-adaptive SL/TP (not fixed %)
 *   - Pro exits: break-even + partial TP + smart trailing
 *   - Volatility spike filter per trade
 *   - Perf tracking on every stage
 *   - Decision caching (avoid re-analyzing same symbol within 2s)
 */
const config = require('./config');
const store = require('./store');
const market = require('./market');
const risk = require('./risk');
const scanEngine = require('./scan-engine');
const decisionEngine = require('./decision-engine');
const sentiment = require('./sentiment');
const telegram = require('./telegram');
const bus = require('./event-bus');
const execution = require('./execution');
const queue = require('./queue');
const postTrade = require('./post-trade');
const { getBroker } = require('./brokers');
const watchdog = require('./watchdog');

let _running = false;
let _intervalId = null;
let _tickId = null;
let _executionCount = 0;
const MAX_PARALLEL = 50;
const _activeTimers = new Set();

function addTimer(id) { _activeTimers.add(id); return id; }
function clearAllTimers() { for (const id of _activeTimers) clearTimeout(id); _activeTimers.clear(); }

// Decision cache: 2s per symbol (avoid re-analyzing same symbol within timeframe)
const _decCache = new Map(); // symbol -> { ts, decision }
function getCachedDecision(symbol) {
  const c = _decCache.get(symbol);
  if (c && (Date.now() - c.ts < 2000)) return c.decision;
  return null;
}
function setCachedDecision(symbol, dec) { _decCache.set(symbol, { ts: Date.now(), decision: dec }); }

function ladderDurations() {
  return config.getList('SCALP_DURATIONS', ['5s','10s','15s','30s','60s']).map(parseDuration);
}
function parseDuration(str) {
  const m = /^(\d+)(s|m|h|d)$/.exec((str||'10s').trim());
  if (!m) return 10;
  const v = +m[1];
  return m[2]==='s' ? v : m[2]==='m' ? v*60 : m[2]==='h' ? v*3600 : v*86400;
}

// === Multi-TF analyze (parallel fetch) — kept for backward compat ===
async function multiTimeframeAnalyze(symbol) {
  const tfs = ['1m','5m','15m'];
  const kls = await Promise.all(tfs.map(tf => market.getKlines(symbol, tf, 50).catch(() => null)));
  const confirms = [];
  let avg = 0;
  for (let i = 0; i < tfs.length; i++) {
    const kl = kls[i];
    if (!kl || kl.length < 14) { confirms.push({ tf: tfs[i], action: 'HOLD', confidence: 0, noisePass: false }); continue; }
    const ind = market.computeIndicators(kl, symbol, tfs[i]);
    const noise = { pass: ind.volRatio > 1.0, volRatio: ind.volRatio || 1, oscillation: 0 };
    const action = ind.trendUp ? 'BUY' : ind.trendDown ? 'SELL' : 'HOLD';
    const confidence = Math.min(0.95, 0.4 + Math.abs(ind.rsi - 50) / 100);
    confirms.push({ action, confidence: +confidence.toFixed(3), tf: tfs[i], noisePass: noise.pass, volRatio: noise.volRatio });
    avg += confidence;
  }
  avg /= tfs.length;
  const yes = confirms.filter(c => c.action !== 'HOLD' && c.confidence >= 0.5);
  const action = yes.length >= 2 && new Set(yes.map(c=>c.action)).size === 1 ? yes[0].action : 'HOLD';
  return {
    action, symbol,
    side: action === 'SELL' ? 'short' : action === 'BUY' ? 'long' : 'none',
    confidence: +avg.toFixed(3),
    reasoning: `MTF: ${confirms.map(c=>c.tf+':'+c.action).join(', ')}`,
    confirms,
    triggered: new Date().toISOString(),
  };
}

// === Scalp execution w/ ATR-adaptive SL/TP + pro exits ===
let _totalScalps = 0;
let _consecutiveWins = 0;
// === executeScalpTrade (V1 — original) ===
async function executeScalpTrade(symbol, side, qty, durationSec, opts = {}) {
  if (_executionCount >= MAX_PARALLEL) return { ok: false, error: 'max_parallel' };
  _executionCount++;
  const t0 = Date.now();
  try {
    const t1 = Date.now();
    const broker = getBroker();
    const ticker = await market.getTicker(symbol);
    store.recordPerf('market', Date.now() - t1);
    const price = ticker.price;

    // Duplicate order protection
    const token = watchdog.generateExecToken(symbol, side, qty, price);
    if (token.duplicate) {
      watchdog.audit('EXEC', `duplicate order blocked: ${symbol} ${side}`, 'WARN');
      return { ok: false, error: 'duplicate_order', token: token.token, latency: Date.now() - t0 };
    }

    const check = await risk.checkBeforeTrade(symbol, side, price);
    if (!check.ok) {
      store.addLog({ type: 'agent', level: 'warn', msg: `risk ${symbol}: ${(check.errors||[]).join(',')}` });
      return { ok: false, error: 'risk_block', errors: check.errors, latency: Date.now()-t0 };
    }

    const kl15 = await market.getKlines(symbol, '15m', 50).catch(() => null);
    if (kl15) {
      const spike = decisionEngine.checkVolatilitySpike(symbol, kl15);
      if (spike.blocked) {
        store.addLog({ type: 'agent', level: 'warn', msg: `volatility spike ${symbol}: ${spike.reason}` });
        return { ok: false, error: 'volatility_spike', latency: Date.now()-t0 };
      }
    }

    const ind = kl15 ? market.computeIndicators(kl15, symbol, '15m') : {};
    const atrPct = ind.atr ? ind.atr / price : 0.005;
    const slPct = opts.slPct || +Math.max(0.002, atrPct * 1.5).toFixed(4);
    const tpPct = opts.tpPct || +Math.max(0.004, atrPct * 3.0).toFixed(4);
    const sl = side === 'BUY' ? price * (1 - slPct) : price * (1 + slPct);
    const tp = side === 'BUY' ? price * (1 + tpPct) : price * (1 - tpPct);

    // Progressive sizing: after 2 consecutive wins, scale up 1.5×
    let scaledQty = qty;
    if (_consecutiveWins >= 2) scaledQty = +Math.min(qty * 1.5, 1.0).toFixed(6);
    if (_consecutiveWins >= 4) scaledQty = +Math.min(qty * 2.0, 1.5).toFixed(6);

    const t2 = Date.now();
    const result = await broker.placeOrder(symbol, side, 'MARKET', scaledQty, null, { stopLoss: sl, takeProfit: tp });
    store.recordPerf('broker', Date.now() - t2);

    store.addTrade({
      id: result.id, symbol, side: side.toLowerCase(), action: side,
      price, qty: scaledQty, sl, tp, slPct, tpPct,
      status: 'open',
      broker: config.get('DEFAULT_BROKER'),
      indicatorsSnapshot: ind,
      aiReasoning: opts.aiReasoning || null,
      durationSec,
    });

    bus.tradeOpened({
      symbol, side, price, qty: scaledQty,
      broker: config.get('DEFAULT_BROKER'),
      expectedEntry: price, slippageFinal: 0,
      brokerMs: Date.now() - t2, totalMs: Date.now() - t0,
    });

    scheduleProExit(symbol, scaledQty, side, durationSec, result.id, { slPct, tpPct, entryPrice: price, atr: ind.atr || price * 0.005 });

    store.addLog({ type: 'agent', level: 'info', msg: `⚡ ${side} ${symbol} @ ${price} qty=${scaledQty} SL=${sl.toFixed(3)} TP=${tp.toFixed(3)} wins=${_consecutiveWins} (${Date.now()-t0}ms)` });
    store.recordPerf('total', Date.now() - t0);
    _totalScalps++;
    await telegram.notifyTrade({ symbol, side, price, qty: scaledQty, status: 'open', type: 'scalp' }).catch(() => {});
    return { ok: true, trade: result, latency: Date.now()-t0, price, sl, tp, slPct, tpPct, qty: scaledQty, durationSec };
  } catch (e) {
    store.addLog({ type: 'agent', level: 'error', msg: `scalp ${symbol}: ${e.message}` });
    return { ok: false, error: e.message, latency: Date.now()-t0 };
  } finally { _executionCount = Math.max(0, _executionCount - 1); }
}

// === executeScalpTradeV2 — institutional execution pipeline ===
// Uses validator → simulator → retry → failover. Triggers when EXECUTION_V2=true.
async function executeScalpTradeV2(symbol, side, qty, durationSec, opts = {}) {
  const t0 = Date.now();
  const signal = {
    symbol, side: side.toUpperCase(),
    qty: +qty, type: 'MARKET',
    strategy: { slPct: opts.slPct || 0.003, tpPct: opts.tpPct || 0.020 },
    aiReasoning: opts.aiReasoning || null,
  };
  // Use queue (priority + dedup + concurrent limit) or direct execution
  let result;
  if (config.getBool('EXEC_QUEUE_ENABLED', true)) {
    const added = queue.add(signal, queue.PRIORITY.NEW_ENTRY);
    if (!added.ok) return { ok: false, error: added.reason, latency: Date.now() - t0 };
    // Wait briefly for completion (queue is async)
    result = { ok: true, queued: true, id: added.id };
  } else {
    result = await execution.executeSmart(signal);
    if (result.ok) {
      const scaledQty = result.qty;
      const slPct = opts.slPct || 0.003;
      const tpPct = opts.tpPct || 0.020;
      // Schedule pro-exit using existing mechanism
      scheduleProExit(symbol, scaledQty, side, durationSec, result.fill?.id || `T${Date.now()}`, {
        slPct, tpPct,
        entryPrice: result.price,
        atr: (await market.getKlines(symbol, '15m', 50).catch(() => null))?.[0]?.close * 0.005 || result.price * 0.005,
      });
      _totalScalps++;
      store.addLog({ type: 'agent', level: 'info', msg: `⚡v2 ${side} ${symbol} @ ${result.price} qty=${scaledQty} broker=${result.brokerUsed} slip=${(result.slippage*100).toFixed(3)}% (${result.totalMs}ms ${result.attempts}att)` });
      postTrade.recordExecution(result);
    } else {
      store.addLog({ type: 'agent', level: 'warn', msg: `✗ v2 ${symbol}: ${result.reason} — ${result.detail || ''}` });
      postTrade.recordExecution(result);
    }
  }
  return result;
}

// Smart executor dispatcher: picks V1 or V2 based on config flag
async function executeScalp(symbol, side, qty, durationSec, opts = {}) {
  if (config.getBool('EXECUTION_V2', false)) {
    return executeScalpTradeV2(symbol, side, qty, durationSec, opts);
  }
  return executeScalpTrade(symbol, side, qty, durationSec, opts);
}
function scheduleProExit(symbol, qty, side, durationSec, tradeId, meta) {
  const ms = durationSec * 1000;
  const intervalMs = Math.max(700, Math.floor(ms / 8)); // 8 checks
  const entry = meta.entryPrice;
  const slPct = meta.slPct || 0.005;
  const tpPct = meta.tpPct || 0.01;
  const atr = meta.atr || entry * 0.005;
  let closed = false;
  let peakPrice = entry;
  let beLocked = false;
  let partialsTaken = 0;
  const dir = side === 'BUY' ? 1 : -1;
  const tpPrice = entry * (1 + dir * tpPct);

const doClose = async (reason, exitPrice) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try {
      const broker = getBroker();
      const t0 = Date.now();
      const result = await broker.closePosition(symbol);
      store.recordPerf('broker', Date.now() - t0);
      const pnl = result.pnl || 0;
      risk.updateDailyPnl(pnl);
      store.updateTrade(tradeId, { status: 'closed', pnl, exitPrice: exitPrice || meta.entryPrice, closeReason: reason, durationSec });
      store.addLog({ type: 'agent', level: 'info', msg: `✕ ${symbol} closed (${reason}) PnL=${pnl.toFixed(2)}` });
      bus.tradeClosed({ symbol, reason, pnl, brokerMs: Date.now() - t0 });
      
      // Track streak: win increments, loss resets
      if (pnl > 0) _consecutiveWins++;
      else _consecutiveWins = 0;
      
      // Daily target check (>2% profit → suggest stopping)
      const state = store.getAgentState();
      const balance = (await broker.getAccountInfo().catch(() => ({ balance: 10000 }))).balance || 10000;
      const dailyPnl = state.dailyPnl || 0;
      if (balance > 0 && dailyPnl / balance > 0.02) {
        store.addLog({ type: 'agent', level: 'warn', msg: `🎯 Daily target +2% hit (${(dailyPnl/balance*100).toFixed(1)}%) — consider stopping` });
      }
      await telegram.notifyTrade({ symbol, side: 'CLOSE', status: 'closed', pnl, qty }).catch(() => {});
    } catch (e) {
      store.addLog({ type: 'agent', level: 'error', msg: `close ${symbol}: ${e.message}` });
      addTimer(setTimeout(() => doClose(reason, exitPrice), 800));
    }
  };

  const check = async () => {
    if (closed) return;
    try {
      const ticker = await market.getTicker(symbol);
      const cur = ticker.price;
      peakPrice = dir > 0 ? Math.max(peakPrice, cur) : Math.min(peakPrice, cur);
      const pnl = dir > 0 ? (cur - entry) * qty : (entry - cur) * qty;

      // Hard SL
      if ((dir > 0 && cur <= entry * (1 - slPct)) || (dir < 0 && cur >= entry * (1 + slPct))) {
        return doClose('stop_loss', cur);
      }

      // Break-even lock: at 35% of TP distance → move SL to entry (paper: just track)
      if (!beLocked && Math.abs(cur - entry) >= Math.abs(tpPrice - entry) * 0.35 && pnl > 0) {
        beLocked = true;
        store.addLog({ type: 'agent', level: 'info', msg: `🔒 BE ${symbol} PnL=${pnl.toFixed(2)}` });
      }

      // Partial TP: 30% at 33% of TP, 30% at 66%, rest trailing
      const tpDist = Math.abs(tpPrice - entry);
      const curDist = Math.abs(cur - entry);
      if (partialsTaken === 0 && curDist >= tpDist * 0.33) {
        partialsTaken = 1;
        store.addLog({ type: 'agent', level: 'info', msg: `📊 TP1 ${symbol} 30% PnL=${pnl.toFixed(2)}` });
      } else if (partialsTaken === 1 && curDist >= tpDist * 0.66) {
        partialsTaken = 2;
        store.addLog({ type: 'agent', level: 'info', msg: `📊 TP2 ${symbol} 60% PnL=${pnl.toFixed(2)}` });
      }

      // Full TP
      if ((dir > 0 && cur >= tpPrice) || (dir < 0 && cur <= tpPrice)) {
        return doClose('take_profit', cur);
      }

      // Smart trailing: exit if price retraces > 40% of peak from BE lock
      if (beLocked && peakPnl(peakPrice, entry, qty, dir) > 0) {
        const peakP = dir > 0 ? (peakPrice - entry) * qty : (entry - peakPrice) * qty;
        if (pnl < peakP * 0.55) return doClose('trailing_exit', cur);
      }
    } catch {}
  };
  function peakPnl(peak, entry, qty, dir) { return dir > 0 ? (peak - entry) * qty : (entry - peak) * qty; }

  const timer = setInterval(check, intervalMs);
  addTimer(timer);
  addTimer(setTimeout(() => doClose('time', null), ms));
}

// === Find best opportunities via scan-engine ===
async function findBestOpportunitules(maxCount = 5) {
  const scan = await scanEngine.scanAll();
  return scan.top10.slice(0, maxCount);
}

// === runOnce: parallel symbols + new decision engine ===
async function runOnce(symbolOverride) {
  if (_running) return { status: 'already_running' };
  _running = true;
  const t0 = Date.now();
  store.setAgentState({ running: true, lastRun: new Date().toISOString() });
  try {
    let symbols = symbolOverride ? [symbolOverride] : config.getList('WATCH_SYMBOLS', ['BTCUSDT']);

    // Auto-scan top opportunities if STRICT_CONFIRM
    if (config.getBool('STRICT_CONFIRM', true) && !symbolOverride) {
      try {
        const top = await findBestOpportunitules(+config.get('SCAN_LIMIT_TOP', '5') || 5);
        if (top.length) symbols = top.map(t => t.symbol);
        store.addLog({ type: 'agent', level: 'info', msg: `scan: ${symbols.length} top symbols` });
      } catch (e) {
        store.addLog({ type: 'agent', level: 'warn', msg: `scan failed: ${e.message}` });
      }
    }

    // === Parallel decision for all symbols ===
    const decisions = await Promise.all(symbols.map(s => {
      const cached = getCachedDecision(s);
      if (cached) return Promise.resolve(cached);
      return decisionEngine.decide(s).then(d => { setCachedDecision(s, d); return d; }).catch(e => ({ action: 'NO_TRADE', symbol: s, reasoning: e.message }));
    }));

    const actions = [];
    const account = await getBroker().getAccountInfo();
    const durations = ladderDurations();

    // Execute only LONG/SHORT
    for (let i = 0; i < decisions.length; i++) {
      const d = decisions[i];
      if (d.action !== 'LONG' && d.action !== 'SHORT') {
        actions.push({ symbol: d.symbol, decision: d.action, confidence: d.confidence, executed: false });
        continue;
      }
      // Daily 2% target gate
      const s = store.getAgentState();
      if (account.balance > 0 && (s.dailyPnl || 0) / account.balance > 0.02) continue;

      const side = d.action === 'LONG' ? 'BUY' : 'SELL';
      const ticker = await market.getTicker(d.symbol);
      const qty = risk.calculatePositionSize(ticker.price, account.balance).qty;
      const durIdx = (_totalScalps + i) % durations.length;
      const dur = durations[durIdx] || 10;
      const exec = await executeScalp(d.symbol, side, qty, dur, { slPct: d.slPct, tpPct: d.tpPct, aiReasoning: d.reasoning });
      actions.push({ symbol: d.symbol, decision: d.action, confidence: d.confidence, executed: exec.ok, execution: exec });
    }

    const elapsed = Date.now() - t0;
    store.recordPerf('analyze', Math.min(elapsed, 2000));
    store.setAgentState({ running: false });
    watchdog.beat('agent', { status: 'idle', decisions: decisions.length, executed: actions.filter(a=>a.executed).length });
    store.addLog({ type: 'agent', level: 'info', msg: `cycle ${elapsed}ms ${symbols.length}sym exec=${actions.filter(a=>a.executed).length} wait=${actions.filter(a=>!a.executed).length} streak=${_consecutiveWins}` });
    return { status: 'done', elapsed, decisions, actions, consecutiveWins: _consecutiveWins };
  } catch (e) {
    store.setAgentState({ running: false });
    store.addLog({ type: 'agent', level: 'error', msg: `runOnce: ${e.message}` });
    return { status: 'error', error: e.message };
  } finally { _running = false; }
}

// === Loops ===
function startTickLoop() {
  if (_tickId) { clearInterval(_tickId); _tickId = null; }
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  const intervalMs = config.getNum('TICK_MS', 1500);
  _tickId = setInterval(async () => {
    if (config.getBool('AGENT_AUTORUN', false) && !_running && _executionCount < MAX_PARALLEL / 2) {
      try { await runOnce(); } catch (e) { console.error('[tick]', e.message); }
    }
  }, intervalMs);
  store.addLog({ type: 'agent', level: 'info', msg: `tick loop ${intervalMs}ms` });
}
function stopTickLoop() { if (_tickId) { clearInterval(_tickId); _tickId = null; } }

function startLoop(ms) {
  stopLoop();
  const t = ms || 60000;
  store.setAgentState({ running: true });
  _intervalId = setInterval(async () => {
    if (config.getBool('AGENT_AUTORUN', false)) {
      try { await runOnce(); } catch (e) { console.error('[agent]', e.message); }
    }
  }, t);
  startTickLoop();
  store.addLog({ type: 'agent', level: 'info', msg: `started ${t/1000}s loop` });
}
function stopLoop() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  stopTickLoop();
  store.setAgentState({ running: false });
}

function getStatus() {
  return {
    running: _running || config.getBool('AGENT_AUTORUN', false),
    autorun: config.getBool('AGENT_AUTORUN', false),
    totalScalps: _totalScalps,
    state: store.getAgentState(),
    perf: store.getPerf(),
    config: {
      broker: config.get('DEFAULT_BROKER'), mode: config.get('TRADING_MODE'),
      symbols: config.getList('WATCH_SYMBOLS'), timeframe: config.get('AGENT_TIMEFRAME'),
      tickMs: config.getNum('TICK_MS', 1500),
      scalpDurations: config.getList('SCALP_DURATIONS'),
      strictConfirm: config.getBool('STRICT_CONFIRM', true),
      autoClose: config.getBool('SCALP_AUTO_CLOSE', true),
    },
  };
}

module.exports = { runOnce, startLoop, stopLoop, getStatus, executeScalpTrade, executeScalp, executeScalpTradeV2, multiTimeframeAnalyze, findBestOpportunitules, decisionEngine };
