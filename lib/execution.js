'use strict';
// execution.js — Smart Execution Pipeline with Retry + Failover
// Wraps broker calls with: validation → simulation → retry → failover
const config = require('./config');
const store = require('./store');
const market = require('./market');
const risk = require('./risk');
const bus = require('./event-bus');
const validator = require('./validator');
const brokers = require('./brokers');
const riskPro = require('./risk-pro');

// === Retry Engine with Exponential Backoff ===
const RETRY_MAX = 3;
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 100;

// === Circuit Breaker (per resource) ===
const circuitState = new Map();
function circuit(name, opts = {}) {
  const threshold = opts.threshold || 5;
  const cooldownMs = opts.cooldown || 60000;
  const c = circuitState.get(name) || { failures: 0, open: false, openedAt: 0 };
  if (c.open) {
    if (Date.now() - c.openedAt > cooldownMs) {
      c.open = false; c.failures = 0; // try again
    } else {
      return { tripped: true };
    }
  }
  return {
    recordFailure() {
      c.failures++;
      if (c.failures >= threshold) {
        c.open = true;
        c.openedAt = Date.now();
        bus.emit('circuit:open', { name, failures: c.failures });
      }
      circuitState.set(name, c);
    },
    recordSuccess() {
      c.failures = 0;
      circuitState.set(name, c);
    },
  };
}

async function withRetry(name, task, opts = {}) {
  const max = opts.max || RETRY_MAX;
  const base = opts.base || RETRY_BASE_MS;
  const jitter = opts.jitter || RETRY_JITTER_MS;

  // Check circuit breaker first
  const cb = circuit(name, opts);
  if (cb.tripped) {
    const err = new Error(`Circuit tripped for ${name} — backoff ${opts.cooldown/1000 || 60}s`);
    err.circuit = true;
    throw err;
  }

  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const result = await task();
      cb.recordSuccess();
      return { ok: true, result, attempts: attempt };
    } catch (e) {
      lastErr = e;
      // Don't retry on validation or auth errors
      if (e.circuit || e.message.includes('Circuit')) break;
      if (e.message.includes('auth') || e.message.includes('Auth') || e.message.includes('API key')) break;
      if (e.message.includes('insufficient') || e.message.includes('余额不足')) break;

      if (attempt < max) {
        const delay = base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * jitter);
        bus.emit('retry:scheduled', { name, attempt: attempt + 1, backoffMs: delay, error: e.message });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  cb.recordFailure();
  return { ok: false, error: lastErr && lastErr.message, attempts: max };
}

// === Broker Failover (Bybit → Binance → Paper) ===
const FAILOver_ORDER = ['bybit', 'binance', 'paper'];
let _currentBroker = null;
let _failedBrokers = new Set();

async function getFailoverBroker(preferred) {
  // Try preferred first
  if (preferred && !_failedBrokers.has(preferred)) {
    try {
      const b = brokers.getBroker(preferred);
      _currentBroker = preferred;
      return { name: preferred, broker: b };
    } catch (e) {
      _failedBrokers.add(preferred);
      bus.brokerDisconnected(preferred);
    }
  }
  // Try each failover broker
  for (const name of FAILOver_ORDER) {
    if (_failedBrokers.has(name)) continue;
    try {
      const b = brokers.getBroker(name);
      _currentBroker = name;
      bus.brokerConnected(name);
      return { name, broker: b };
    } catch (e) {
      _failedBrokers.add(name);
      bus.brokerDisconnected(name);
    }
  }
  // Final fallback: paper (always available)
  _currentBroker = 'paper';
  return { name: 'paper', broker: brokers.getBroker('paper') };
}

function clearFailover(name) { _failedBrokers.delete(name); }

// === Order Simulation (pre-execution) ===
async function simulateFill(symbol, side, qty, price, type = 'MARKET') {
  const t0 = Date.now();
  const slippagePct = type === 'LIMIT' ? 0 : Math.min(0.002, qty * 0.0001);  // 0.1% max
  const feePct = 0.0008; // 0.08% taker fee
  const spreadPct = 0.0003; // 0.03%
  const execDelayMs = type === 'LIMIT' ? 1500 : 250;

  const expectedFill = side === 'BUY' ? price * (1 + slippagePct) : price * (1 - slippagePct);
  const fee = expectedFill * qty * feePct;
  const cost = expectedFill * qty + fee;

  const simulation = {
    side, qty, type,
    expectedEntryPrice: +expectedFill.toFixed(6),
    slippagePct: +slippagePct.toFixed(4),
    spreadPct: +spreadPct.toFixed(4),
    feePct: +feePct.toFixed(4),
    fee: +fee.toFixed(6),
    totalCost: +cost.toFixed(2),
    execDelayMs,
    elapsedMs: Date.now() - t0,
  };
  bus.emit('exec:simulated', simulation);
  return simulation;
}

// === Smart Execution Pipeline ===
// signal → validation → simulation → risk → broker → fill validation → journal → metrics
async function executeSmart(signal) {
  const t0 = Date.now();
  const { symbol, side, qty, type = 'MARKET', price: signalPrice, strategy = {} } = signal;

  // Step 1: PRE-VALIDATION
  let ticker;
  try {
    ticker = await Promise.race([market.getTicker(symbol), new Promise((_, rj) => setTimeout(() => rj(new Error('ticker timeout')), 3000))]);
  } catch (e) {
    bus.errorOccurred({ stage: 'ticker', error: e.message });
    return { ok: false, reason: 'ticker_unavailable', elapsedMs: Date.now() - t0 };
  }
  const price = ticker.price;

  const validation = await validator.validatePreTrade(symbol, side, qty, price);
  if (!validation.ok) {
    return { ok: false, reason: 'validation_failed', detail: validation.reason, elapsedMs: Date.now() - t0 };
  }

  // Step 2: ORDER SIMULATION
  const sim = await simulateFill(symbol, side, qty, price, type);
  // Net reward estimate (assume user provided expectedExitPrice or use ATR-based target)
  const expectedTP = strategy.tpPct ? price * (1 + (side === 'BUY' ? +strategy.tpPct : -strategy.tpPct)) : price * 1.01;
  const grossProfit = Math.abs(expectedTP - sim.expectedEntryPrice) * qty;
  const netReward = grossProfit - sim.fee;
  if (netReward < 0) {
    return { ok: false, reason: 'negative_net_reward', detail: `net=${netReward.toFixed(4)}`, elapsedMs: Date.now() - t0 };
  }

  // Step 3: RISK APPROVAL (institutional grade — uses risk-pro if RISK_ENGINE_PRO=true)
  let riskCheck;
  if (config.getBool('RISK_ENGINE_PRO', true)) {
    riskCheck = await riskPro.validateTrade({
      symbol, side, qty, price,
      confidence: signal.confidence || 0.5,
      expectedSlippage: sim.slippagePct,
    });
  } else {
    riskCheck = await risk.checkBeforeTrade(symbol, side, price);
    if (!riskCheck.ok) riskCheck = { ok: false, reason: (riskCheck.errors || []).join(', ') };
  }
  if (!riskCheck.ok) {
    if (riskPro.recordRejected) riskPro.recordRejected({ symbol, side, reason: riskCheck.reason || '' });
    return { ok: false, reason: riskCheck.reason || 'risk_rejected', detail: riskCheck.detail || '', riskScore: riskCheck.riskScore, elapsedMs: Date.now() - t0 };
  }
  if (riskPro.recordAccepted && riskCheck.ok) riskPro.recordAccepted({ symbol, side, riskScore: riskCheck.riskScore });

  // Step 4: BROKER WITH FAILOVER + RETRY
  const preferred = config.get('DEFAULT_BROKER', 'bybit').toLowerCase();
  const { name: brokerUsed, broker } = await getFailoverBroker(preferred);

  const sl = side === 'BUY' ? price * (1 - (strategy.slPct || 0.005)) : price * (1 + (strategy.slPct || 0.005));
  const tp = side === 'BUY' ? price * (1 + (strategy.tpPct || 0.015)) : price * (1 - (strategy.tpPct || 0.015));

  const orderBody = {
    symbol, side, type, qty,
    stopLoss: +sl.toFixed(6), takeProfit: +tp.toFixed(6),
  };

  const brokerStart = Date.now();
  const retryResult = await withRetry(`broker:${brokerUsed}:placeOrder`, () => broker.placeOrder(symbol, side, type, qty, null, { stopLoss: sl, takeProfit: tp }));
  const brokerMs = Date.now() - brokerStart;

  if (!retryResult.ok) {
    _failedBrokers.add(brokerUsed);
    bus.brokerDisconnected(brokerUsed);
    return { ok: false, reason: `broker_failed after ${retryResult.attempts} attempts`, detail: retryResult.error, brokerUsed, elapsedMs: Date.now() - t0 };
  }

  // Step 5: FILL VALIDATION
  const fill = retryResult.result;
  const actualFillPrice = fill?.price || sim.expectedEntryPrice;
  const slippageActual = Math.abs(actualFillPrice - price) / price;
  if (slippageActual > 0.01) {
    bus.healthWarning(`High slippage on ${symbol}: ${(slippageActual*100).toFixed(2)}%`);
  }

  // Step 6: JOURNAL (through store.addTrade)
  store.addTrade({
    id: fill?.id || `T${Date.now()}`,
    symbol, side: side.toLowerCase(), action: side.toUpperCase(),
    price: actualFillPrice, qty, sl, tp,
    slPct: strategy.slPct || 0.005,
    tpPct: strategy.tpPct || 0.015,
    status: 'open', broker: brokerUsed,
    fillSlippage: +slippageActual.toFixed(6),
    expectedEntry: sim.expectedEntryPrice,
    elapsedMs: Date.now() - t0,
    brokerMs, attempts: retryResult.attempts,
  });

  // Step 7: EVENT + METRICS
  bus.tradeOpened({
    symbol, side, price: actualFillPrice, qty,
    broker: brokerUsed, expectedEntry: sim.expectedEntryPrice,
    slippageFinal: slippageActual, brokerMs,
    totalMs: Date.now() - t0,
  });

  store.recordPerf('broker', brokerMs);
  store.recordPerf('total', Date.now() - t0);

  return {
    ok: true,
    brokerUsed,
    price: actualFillPrice, qty,
    expectedEntry: sim.expectedEntryPrice,
    slippage: slippageActual,
    brokerMs, totalMs: Date.now() - t0,
    attempts: retryResult.attempts,
    fill,
  };
}

// === Close with Retry + Failover ===
async function closeSmart(symbol, reason = 'manual') {
  const t0 = Date.now();
  const { name: brokerUsed, broker } = await getFailoverBroker(config.get('DEFAULT_BROKER', 'bybit'));
  const r = await withRetry(`broker:${brokerUsed}:closePosition`, () => broker.closePosition(symbol));
  if (!r.ok) {
    bus.healthWarning(`Close failed on ${symbol}: ${r.error}`);
    return { ok: false, reason: r.error, attempts: r.attempts };
  }
  bus.tradeClosed({ symbol, reason, brokerMs: Date.now() - t0 });
  return { ok: true, result: r.result, attempts: r.attempts, brokerUsed, elapsedMs: Date.now() - t0 };
}

// === Batch Close (emergency) ===
async function closeAll(reason = 'emergency') {
  const openTrades = store.getTrades().filter(t => t.status === 'open');
  const results = [];
  for (const t of openTrades) {
    results.push({ symbol: t.symbol, ...(await closeSmart(t.symbol, reason)) });
  }
  bus.emit('exec:batch-closed', { count: results.length, reason });
  return results;
}

// === Idempotency: prevent duplicate orders within 5s wall-clock ===
const recentOrders = new Map();
function isDuplicate(symbol, side, qty, withinMs = 5000) {
  const key = `${symbol}:${side}:${qty}`;
  const now = Date.now();
  if (recentOrders.has(key)) {
    const last = recentOrders.get(key);
    if (now - last < withinMs) return true;
  }
  recentOrders.set(key, now);
  return false;
}

// Periodically clean recentOrders
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recentOrders) if (now - t > 60000) recentOrders.delete(k);
}, 60000).unref?.();

module.exports = {
  withRetry,
  circuit,
  executeSmart,
  closeSmart,
  closeAll,
  simulateFill,
  getFailoverBroker,
  isDuplicate,
  clearFailover,
};