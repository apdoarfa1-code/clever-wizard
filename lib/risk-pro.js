'use strict';
// risk-pro.js — Institutional Risk Engine v2
// Wraps lib/risk.js — adds drawdown tracking, correlation, sessions, kill switch,
// risk score, exposure caps, weekly/monthly PnL, volatility/spread protection.
// No trade may bypass this module.
const config = require('./config');
const store = require('./store');
const market = require('./market');
const baseRisk = require('./risk');
const bus = require('./event-bus');

// === Internal state ===
let _killSwitchActive = false;
let _killSwitchReason = '';
let _activeExposure = new Map(); // symbol → notional USD
let _peakEquity = 0;

// === PnL tracking: daily/weekly/monthly ===
function periodKey(period) {
  const now = new Date();
  if (period === 'daily') return now.toISOString().slice(0, 10);
  if (period === 'weekly') {
    const onejan = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil((now - onejan) / 86400000 / 7);
    return `${now.getFullYear()}-W${week}`;
  }
  if (period === 'monthly') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return '';
}

function getPeriodPnl(period) {
  const state = store.getAgentState();
  const key = periodKey(period);
  if (period === 'daily') return { date: key, pnl: state.dailyPnl || 0, key };
  if (period === 'weekly') return { week: key, pnl: state.weeklyPnl || 0, key };
  return { month: key, pnl: state.monthlyPnl || 0, key };
}

function updatePeriodPnl(pnl) {
  const state = store.getAgentState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyPnlDate !== today) {
    store.setAgentState({
      dailyPnl: pnl, dailyPnlDate: today,
      weeklyPnl: state.weeklyPnlDate === today.slice(0, 7) ? (state.weeklyPnl || 0) + pnl : pnl,
      weeklyPnlDate: today.slice(0, 7),
      monthlyPnl: state.monthlyPnlDate === today.slice(0, 7) ? (state.monthlyPnl || 0) + pnl : pnl,
      monthlyPnlDate: today.slice(0, 7),
    });
  } else {
    store.setAgentState({
      dailyPnl: (state.dailyPnl || 0) + pnl,
      weeklyPnl: (state.weeklyPnl || 0) + pnl,
      monthlyPnl: (state.monthlyPnl || 0) + pnl,
    });
  }
}

// === Drawdown control ===
function getDrawdown() {
  const state = store.getAgentState();
  const peak = state.peakEquity || 10000;
  let balance = 10000;
  try { balance = store.getPaper().balance || 10000; } catch {}
  const cur = balance;
  _peakEquity = Math.max(_peakEquity, cur, peak);
  if (cur > _peakEquity) _peakEquity = cur;
  store.setAgentState({ peakEquity: _peakEquity });
  const dd = _peakEquity > 0 ? (cur - _peakEquity) / _peakEquity : 0; // < 0 = in drawdown
  return { current: +dd.toFixed(4), peak: _peakEquity, current: cur, ddPct: +(dd * 100).toFixed(2) };
}

// === Exposure caps ===
function getExposureStats() {
  const openTrades = store.getTrades().filter(t => t.status === 'open');
  let totalNotional = 0, longNotional = 0, shortNotional = 0;
  const perSymbol = {};
  for (const t of openTrades) {
    const notional = (t.price || 0) * (t.qty || 0);
    totalNotional += notional;
    if (['long', 'buy'].includes(t.side)) longNotional += notional;
    else shortNotional += notional;
    perSymbol[t.symbol] = (perSymbol[t.symbol] || 0) + notional;
  }
  return {
    total: +totalNotional.toFixed(2), long: +longNotional.toFixed(2), short: +shortNotional.toFixed(2),
    positions: openTrades.length, perSymbol,
  };
}

// === Correlation control (simplified — checks open positions in correlated symbols) ===
// BTC↔ETH historic corr ~0.85, BTC↔SOL ~0.7, BTC↔DOGE ~0.6
// We embed a static correlation matrix as a heuristic — no live calc needed (CPU-cheap).
const CORR = {
  'BTCUSDT-ETHUSDT': 0.85, 'BTCUSDT-SOLUSDT': 0.7, 'BTCUSDT-BNBUSDT': 0.78,
  'BTCUSDT-XRPUSDT': 0.65, 'BTCUSDT-ADAUSDT': 0.55, 'BTCUSDT-DOGEUSDT': 0.6,
  'ETHUSDT-SOLUSDT': 0.65, 'ETHUSDT-BNBUSDT': 0.7, 'ETHUSDT-XRPUSDT': 0.6,
  'SOLUSDT-BNBUSDT': 0.6,
};
function getCorrelation(symA, symB) {
  if (symA === symB) return 1;
  return CORR[`${symA}-${symB}`] || CORR[`${symB}-${symA}`] || 0.3;
}
function getCorrelatedExposure(symbol, symbolExposure) {
  const openTrades = store.getTrades().filter(t => t.status === 'open');
  let totalCorrExposure = 0;
  for (const t of openTrades) {
    if (t.symbol === symbol) continue;
    const corr = getCorrelation(symbol, t.symbol);
    totalCorrExposure += corr * (t.price || 0) * (t.qty || 0);
  }
  return +totalCorrExposure.toFixed(2);
}

// === Session time filters ===
const SESSIONS = {
  // Hours are UTC
  asia: { start: 0, end: 8, multiplier: 0.8 }, // lower liquidity
  london: { start: 8, end: 16, multiplier: 1.0 },
  ny: { start: 13, end: 21, multiplier: 1.0 },
  overlap: { start: 13, end: 16, multiplier: 1.2 }, // NY+London = best
};
function getCurrentSession() {
  const h = new Date().getUTCHours();
  for (const [name, s] of Object.entries(SESSIONS)) {
    if (h >= s.start && h < s.end) return { name, multiplier: s.multiplier };
  }
  return { name: 'off', multiplier: 0.5 };
}

// === Volatility check (ATR-based) ===
async function checkVolatility(symbol, price) {
  try {
    const kl = await market.getKlines(symbol, '15m', 20).catch(() => null);
    if (!kl || kl.length < 5) return { ok: true };
    const recent = kl.slice(-5);
    const avgRange = recent.reduce((s, k) => s + (k.high - k.low), 0) / recent.length;
    const lastRange = kl[kl.length - 1].high - kl[kl.length - 1].low;
    if (avgRange > 0 && lastRange > avgRange * 4) {
      return { ok: false, reason: 'volatility_spike_4x_avg' };
    }
    if (avgRange / price > 0.08) return { ok: false, reason: 'abnormal_volatility' };
    return { ok: true };
  } catch (e) { return { ok: true }; }
}

// === Spread filter ===
async function checkSpread(symbol) {
  try {
    const book = await market.getBinanceOrderBook(symbol).catch(() => null);
    if (!book || !book.bid || !book.ask) return { ok: true };
    const spread = (book.ask - book.bid) / book.bid;
    if (spread > 0.005) return { ok: false, reason: 'spread_excessive', value: +(spread * 100).toFixed(3) };
    return { ok: true, spread: +spread.toFixed(6) };
  } catch (e) { return { ok: true }; }
}

// === Liquidity check ===
async function checkLiquidity(symbol, qty) {
  try {
    const book = await market.getBinanceOrderBook(symbol).catch(() => null);
    if (!book || !book.bids || !book.asks) return { ok: true };
    const topBidVol = (book.bids || []).slice(0, 5).reduce((s, b) => s + (+b[1] || 0), 0);
    const topAskVol = (book.asks || []).slice(0, 5).reduce((s, a) => s + (+a[1] || 0), 0);
    const totalLiq = topBidVol + topAskVol;
    if (totalLiq < qty * 3) return { ok: false, reason: 'insufficient_liquidity', topVol: totalLiq, need: qty * 3 };
    return { ok: true, liquidity: totalLiq };
  } catch (e) { return { ok: true }; }
}

// === Kill Switch ===
function activateKillSwitch(reason) {
  _killSwitchActive = true;
  _killSwitchReason = reason;
  bus.emit('risk:kill-switch', { reason, ts: Date.now() });
  store.addLog({ type: 'risk', level: 'critical', msg: `KILL SWITCH: ${reason}` });
}
function deactivateKillSwitch() {
  _killSwitchActive = false;
  _killSwitchReason = '';
  bus.emit('risk:kill-switch-released');
  store.addLog({ type: 'risk', level: 'info', msg: 'KILL SWITCH released' });
}
function isKillSwitchActive() { return _killSwitchActive; }

// === Risk Score (0-100, higher = safer) ===
function computeRiskScore(input) {
  const { exposure = 0, maxExposure = 1000, volatility = 0, liquidity = 1, drawdown = 0, spread = 0,
          slippage = 0, correlation = 0, confidence = 0.5, latency = 0, maxLatency = 1000,
          qty = 0, requiredLiquidity = 0 } = input;
  let score = 100;
  if (maxExposure > 0) score -= Math.min(25, (exposure / maxExposure) * 25);
  score -= Math.min(10, volatility * 100);
  if (requiredLiquidity > 0 && liquidity < requiredLiquidity) score -= 10;
  score -= Math.min(15, Math.abs(drawdown) * 100);
  score -= Math.min(5, spread * 100);
  score -= Math.min(5, slippage * 100);
  score -= Math.min(10, correlation * 10);
  score += Math.min(15, confidence * 15);
  if (maxLatency > 0 && latency > maxLatency) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// === MAIN VALIDATION FUNCTION ===
// Wraps baseRisk.checkBeforeTrade with extended checks
async function validateTrade(signal) {
  const { symbol, side, qty, price, confidence = 0.5, expectedSlippage = 0, type = 'MARKET' } = signal;
  const results = [];
  const t0 = Date.now();

  // 1. KILL SWITCH hard block
  if (_killSwitchActive) {
    return reject('KILL_SWITCH', `Trading halted: ${_killSwitchReason}`, results, t0);
  }

  // 2. Base risk checks (cooldown, daily loss, max positions, watchlist)
  const baseCheck = await baseRisk.checkBeforeTrade(symbol, side, price);
  if (!baseCheck.ok) {
    results.push({ check: 'BASE_RISK', severity: 'BLOCK', detail: (baseCheck.errors || []).join(', ') });
  }
  for (const w of (baseCheck.warnings || [])) results.push({ check: 'BASE_WARN', severity: 'WARN', detail: w });

  // 3. Drawdown check
  const dd = getDrawdown();
  const maxDD = config.getNum('MAX_DRAWDOWN_PCT', 0.20);
  if (Math.abs(dd.ddPct) >= maxDD * 100) results.push({ check: 'MAX_DRAWDOWN', severity: 'BLOCK', detail: `DD ${dd.ddPct}% >= ${maxDD*100}%` });
  else if (Math.abs(dd.ddPct) >= maxDD * 100 * 0.7) results.push({ check: 'DRAWDOWN_WARN', severity: 'WARN', detail: `DD ${dd.ddPct}% near limit` });

  // 4. Weekly + Monthly loss limit
  const weeklyPnl = getPeriodPnl('weekly').pnl;
  const monthlyPnl = getPeriodPnl('monthly').pnl;
  const weeklyLimit = config.getNum('WEEKLY_LOSS_PCT', 0.10);
  const monthlyLimit = config.getNum('MONTHLY_LOSS_PCT', 0.20);
  const balance = 10000;
  if (weeklyPnl < 0 && Math.abs(weeklyPnl) / balance >= weeklyLimit) {
    results.push({ check: 'WEEKLY_LOSS', severity: 'BLOCK', detail: `weekly loss ${Math.abs(weeklyPnl/balance*100).toFixed(1)}%` });
  }
  if (monthlyPnl < 0 && Math.abs(monthlyPnl) / balance >= monthlyLimit) {
    results.push({ check: 'MONTHLY_LOSS', severity: 'BLOCK', detail: `monthly loss ${Math.abs(monthlyPnl/balance*100).toFixed(1)}%` });
  }

  // 5. Exposure control
  const ex = getExposureStats();
  const maxTotal = config.getNum('MAX_EXPOSURE_USD', 50000);
  const maxPerSymbol = config.getNum('MAX_PER_SYMBOL_USD', 10000);
  if (ex.total >= maxTotal) results.push({ check: 'EXPOSURE_TOTAL', severity: 'BLOCK', detail: `${ex.total} >= ${maxTotal}` });
  const symExp = (ex.perSymbol[symbol] || 0) + (price * qty);
  if (symExp >= maxPerSymbol) results.push({ check: 'EXPOSURE_SYMBOL', severity: 'BLOCK', detail: `${symExp} >= ${maxPerSymbol}` });
  const maxLong = config.getNum('MAX_LONG_USD', 30000);
  const maxShort = config.getNum('MAX_SHORT_USD', 30000);
  if (side === 'BUY' && ex.long + (price * qty) > maxLong) results.push({ check: 'LONG_EXPOSURE', severity: 'BLOCK' });
  if (side === 'SELL' && ex.short + (price * qty) > maxShort) results.push({ check: 'SHORT_EXPOSURE', severity: 'BLOCK' });

  // 6. Correlation check
  const corrExp = getCorrelatedExposure(symbol, price * qty);
  const maxCorrUsd = config.getNum('MAX_CORRELATED_USD', 15000);
  if (corrExp >= maxCorrUsd) {
    results.push({ check: 'CORRELATION_EXPOSURE', severity: 'BLOCK', detail: `correlated ${corrExp}` });
  }

  // 7. Volatility check
  const volCheck = await checkVolatility(symbol, price);
  if (!volCheck.ok) results.push({ check: 'VOLATILITY', severity: 'BLOCK', detail: volCheck.reason });

  // 8. Spread filter
  const spreadCheck = await checkSpread(symbol);
  if (!spreadCheck.ok) results.push({ check: 'SPREAD', severity: 'BLOCK', detail: `spread=${spreadCheck.value}%`, extra: spreadCheck });

  // 9. Liquidity check
  const liqCheck = await checkLiquidity(symbol, qty);
  if (!liqCheck.ok) results.push({ check: 'LIQUIDITY', severity: 'BLOCK', detail: liqCheck.reason, extra: liqCheck });

  // 10. Slippage check
  if (expectedSlippage > config.getNum('MAX_SLIPPAGE', 0.005)) {
    results.push({ check: 'SLIPPAGE', severity: 'BLOCK', detail: `expected slip ${expectedSlippage*100}%` });
  }

  // 11. Session filter (off-hours reduce size, not block)
  const session = getCurrentSession();
  if (session.multiplier < 1) {
    results.push({ check: 'SESSION', severity: 'WARN', detail: `session=${session.name} ×${session.multiplier}` });
  }

  // 12. Confidence check
  const minConf = config.getNum('MIN_CONFIDENCE', 0.45);
  if (confidence < minConf) results.push({ check: 'CONFIDENCE_LOW', severity: 'BLOCK', detail: `${confidence} < ${minConf}` });

  // === Aggregate ===
  const blockers = results.filter(r => r.severity === 'BLOCK');
  const warnings = results.filter(r => r.severity === 'WARN');

  // Compute unified risk score
  const riskScore = computeRiskScore({
    exposure: ex.total, maxExposure: maxTotal,
    volatility: volCheck.ok ? 0.01 : 0.1,
    liquidity: liqCheck.liquidity || 1000,
    requiredLiquidity: qty * 3,
    drawdown: dd.ddPct / 100,
    spread: spreadCheck.spread || 0.0005,
    slippage: expectedSlippage,
    correlation: corrExp / maxCorrUsd,
    confidence,
    latency: Date.now() - t0,
    maxLatency: 2000,
  });

  if (blockers.length || riskScore < config.getNum('MIN_RISK_SCORE', 50)) {
    bus.emit('risk:rejected', { symbol, side, reason: blockers.map(b => b.check).join(','), score: riskScore });
    store.addLog({ type: 'risk', level: 'warn', msg: `REJECT ${symbol} ${side} score=${riskScore} reason=${blockers.map(b => b.check).join('|')}` });
    return {
      ok: false,
      reason: blockers.map(b => `${b.check}: ${b.detail || ''}`).join(' | '),
      riskScore, blockers, warnings,
      checks: results,
      elapsedMs: Date.now() - t0,
    };
  }

  bus.emit('risk:approved', { symbol, side, score: riskScore, warnings: warnings.length });
  return {
    ok: true,
    riskScore,
    warnings: warnings.map(w => `${w.check}: ${w.detail}`),
    session,
    exposure: ex,
    drawdown: dd,
    elapsedMs: Date.now() - t0,
  };
}

function reject(code, detail, results, t0) {
  return { ok: false, reason: `${code}: ${detail}`, blockers: [{ check: code, severity: 'BLOCK', detail }], warnings: [], riskScore: 0, elapsedMs: Date.now() - t0 };
}

// === Self-Review: track rejected trades ===
let _rejectedTrades = [];
let _acceptedTrades = [];
function recordRejected(trade) { _rejectedTrades.push({ ...trade, ts: Date.now() }); if (_rejectedTrades.length > 200) _rejectedTrades.shift(); }
function recordAccepted(trade) { _acceptedTrades.push({ ...trade, ts: Date.now() }); if (_acceptedTrades.length > 200) _acceptedTrades.shift(); }
function getSelfReview() {
  // Identify common rejection reasons (mistskes pattern)
  const reasonCount = {};
  for (const t of _rejectedTrades) {
    if (!t.reason) continue;
    for (const r of t.reason.split('|')) reasonCount[r] = (reasonCount[r] || 0) + 1;
  }
  const topReasons = Object.entries(reasonCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    accepted: _acceptedTrades.length,
    rejected: _rejectedTrades.length,
    topRejectionReasons: topReasons,
    recommendations: topReasons.length ? topReasons.map(r => `Consider relaxing: ${r[0]} (${r[1]} rejections)`) : ['No pattern of rejections'],
  };
}

// === Metrics summary ===
function metricsSummary() {
  const dd = getDrawdown();
  const ex = getExposureStats();
  return {
    drawdown: dd,
    exposure: ex,
    dailyPnl: getPeriodPnl('daily'),
    weeklyPnl: getPeriodPnl('weekly'),
    monthlyPnl: getPeriodPnl('monthly'),
    killSwitch: _killSwitchActive,
    killReason: _killSwitchReason,
    session: getCurrentSession(),
    acceptedCount: _acceptedTrades.length,
    rejectedCount: _rejectedTrades.length,
  };
}

module.exports = {
  validateTrade,
  computeRiskScore,
  activateKillSwitch, deactivateKillSwitch, isKillSwitchActive,
  getDrawdown, getExposureStats, getCorrelatedExposure, getCorrelation,
  getCurrentSession, getPeriodPnl, updatePeriodPnl,
  checkVolatility, checkSpread, checkLiquidity,
  recordAccepted, recordRejected, getSelfReview, metricsSummary,
  // Re-export base
  ...baseRisk,
};