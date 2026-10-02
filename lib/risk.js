'use strict';
/*
 * risk.js v2 — Institutional risk management.
 *  - Dynamic position sizing (ATR-adjusted + Kelly fraction)
 *  - Daily loss limit (auto-stop)
 *  - Consecutive loss protection (cooldown after N losses)
 *  - Break-even lock
 *  - Smart trailing stop
 *  - Partial take profit (suggested levels)
 */
const config = require('./config');
const store = require('./store');
const bus = require('./event-bus');

// Automatically update daily PnL when any trade closes via event bus
bus.on('trade:closed', (t) => {
  if (t && typeof t.pnl === 'number') {
    updateDailyPnl(t.pnl);
  }
});

function getRiskParams() {
  return {
    positionPct: config.getNum('RISK_POSITION_PCT', 0.02),
    dailyLossPct: config.getNum('RISK_DAILY_LOSS_PCT', 0.05),
    maxOpen: config.getNum('RISK_MAX_OPEN_POSITIONS', 5),
    defaultSL: config.getNum('RISK_DEFAULT_SL', 0.01),
    defaultTP: config.getNum('RISK_DEFAULT_TP', 0.02),
    cooldownMs: config.getNum('COOLDOWN_MS', 30000),
    maxConsecutiveLosses: config.getNum('MAX_CONSECUTIVE_LOSSES', 3),
    kellyFraction: config.getNum('KELLY_FRACTION', 0.25),
  };
}

// Dynamic position sizing: base % of balance, scaled by ATR (high vol = smaller)
function calculatePositionSize(price, balance, atr) {
  const rp = getRiskParams();
  const riskAmount = balance * rp.positionPct;
  let qty = price > 0 ? riskAmount / price : 0;
  // ATR scaling: if ATR > 1% of price, reduce size proportionally
  if (atr && price > 0) {
    const atrPct = atr / price;
    if (atrPct > 0.005) qty *= Math.max(0.3, 1 - (atrPct - 0.005) * 2);
  }
  // Kelly fraction cap (use 25% Kelly as safe default)
  qty *= rp.kellyFraction / 0.25; // scale to configured fraction
  return { qty: +qty.toFixed(6), riskAmount: +riskAmount.toFixed(2), pct: rp.positionPct };
}

async function checkBeforeTrade(symbol, action, price) {
  const rp = getRiskParams();
  const errors = [];
  const warnings = [];

  // Cooldown check (consecutive loss protection)
  const state = store.getAgentState();
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const remain = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    errors.push(`cooldown active — ${remain}s remaining (${state.consecutiveLosses||0} consecutive losses)`);
    return { ok: false, errors, warnings };
  }

  // Open positions limit
  const openTrades = store.getTrades().filter(t => t.status === 'open');
  if (openTrades.length >= rp.maxOpen) errors.push(`max open positions reached (${openTrades.length}/${rp.maxOpen})`);

  // Daily loss limit
  const today = new Date().toISOString().slice(0, 10);
  const mode = config.get('TRADING_MODE', 'paper');
  let denominator = 0;
  if (mode === 'live') {
    try {
      const broker = require('./brokers').getBroker();
      const acc = await broker.getAccountInfo();
      denominator = acc.balance;
    } catch { denominator = store.getPaper().startBalance; }
  } else denominator = store.getPaper().startBalance;
  if (denominator <= 0) denominator = 10000;
  if (state.dailyPnlDate === today && state.dailyPnl < 0) {
    const lossPct = Math.abs(state.dailyPnl) / denominator;
    if (lossPct >= rp.dailyLossPct) errors.push(`daily loss limit hit (${(lossPct*100).toFixed(1)}% ≥ ${rp.dailyLossPct*100}%)`);
    else if (lossPct >= rp.dailyLossPct * 0.7) warnings.push(`warning: daily loss near limit (${(lossPct*100).toFixed(1)}%)`);
  }

  // Symbol watchlist check
  const symbols = config.getList('WATCH_SYMBOLS');
  if (symbols.length > 0 && !symbols.includes(symbol)) warnings.push(`${symbol} not in watchlist`);

  // Existing position same symbol
  const existing = openTrades.find(t => t.symbol === symbol);
  if (existing) warnings.push(`existing position on ${symbol}`);

  return { ok: errors.length === 0, errors, warnings };
}

function resetDailyPnl() {
  const state = store.getAgentState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyPnlDate !== today) store.setAgentState({ dailyPnl: 0, dailyPnlDate: today, consecutiveLosses: 0 });
}

function updateDailyPnl(pnlChange) {
  resetDailyPnl();
  const state = store.getAgentState();
  store.setAgentState({ dailyPnl: (state.dailyPnl || 0) + pnlChange });
}

function validateDecision(decision) {
  const validActions = ['LONG', 'SHORT', 'WAIT', 'NO_TRADE', 'BUY', 'SELL', 'CLOSE', 'HOLD'];
  const errors = [];
  if (!validActions.includes(decision.action)) errors.push(`unknown action: ${decision.action}`);
  if (decision.confidence < 0 || decision.confidence > 1) errors.push('confidence must be 0-1');
  const minConf = config.getNum('MIN_CONFIDENCE', 0.6);
  if (decision.action === 'LONG' || decision.action === 'SHORT' || decision.action === 'BUY' || decision.action === 'SELL') {
    if (decision.confidence < minConf) {
      errors.push(`confidence (${decision.confidence}) < min (${minConf}) → downgraded to WAIT`);
      decision.action = decision.confidence < minConf * 0.5 ? 'NO_TRADE' : 'WAIT';
    }
  }
  return { valid: errors.length === 0, errors };
}

// Partial TP levels (suggested)
function partialTPLevels(entry, side, tpPct) {
  const dir = side === 'BUY' || side === 'long' || side === 'LONG' ? 1 : -1;
  return [
    { pct: 0.30, price: entry * (1 + dir * tpPct * 0.33) }, // 30% at 33% of TP
    { pct: 0.30, price: entry * (1 + dir * tpPct * 0.66) }, // 30% at 66% of TP
    { pct: 0.40, price: entry * (1 + dir * tpPct * 1.00) }, // 40% at full TP
  ];
}

// Break-even trigger threshold (when to lock BE)
function breakEvenTrigger(entry, side, tpPct) {
  const dir = side === 'BUY' || side === 'long' || side === 'LONG' ? 1 : -1;
  return entry * (1 + dir * tpPct * 0.35); // at 35% of TP distance
}

// Smart trailing: SL follows price at giveback %
function trailingStop(peakPrice, side, atr, givebackPct = 0.4) {
  const dir = side === 'BUY' || side === 'long' || side === 'LONG' ? 1 : -1;
  return peakPrice * (1 - dir * Math.max(atr * 1.5, givebackPct * atr * 4));
}

const risk = { getRiskParams, calculatePositionSize, checkBeforeTrade, resetDailyPnl, updateDailyPnl, validateDecision, partialTPLevels, breakEvenTrigger, trailingStop };
module.exports = risk;
