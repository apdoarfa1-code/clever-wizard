'use strict';
// post-trade.js — Post-Trade Analytics + Performance Metrics
// Captures: expected vs real entry/exit, slippage, commission, latency, decision accuracy
const bus = require('./event-bus');
const store = require('./store');

let _executionStats = {
  total: 0, success: 0, rejected: 0, retries: 0,
  brokerErrors: 0, networkErrors: 0,
  totalSlippage: 0, totalSpread: 0,
  totalBrokerMs: 0, totalFillMs: 0,
  latencies: [],
  perBroker: {}, // { bybit: {count, ok, ms}, binance: {}, paper: {} }
};

function recordExecution(result) {
  if (!result) return;
  _executionStats.total++;
  if (result.ok) {
    _executionStats.success++;
    _executionStats.totalBrokerMs += result.brokerMs || 0;
    _executionStats.totalFillMs += result.totalMs || 0;
    _executionStats.totalSlippage += result.slippage || 0;
    const b = result.brokerUsed || 'unknown';
    if (!_executionStats.perBroker[b]) _executionStats.perBroker[b] = { count: 0, ok: 0, ms: 0, slippage: 0 };
    _executionStats.perBroker[b].count++;
    _executionStats.perBroker[b].ok++;
    _executionStats.perBroker[b].ms += result.brokerMs || 0;
    _executionStats.perBroker[b].slippage += result.slippage || 0;
    _executionStats.latencies.push(result.totalMs || 0);
    if (_executionStats.latencies.length > 500) _executionStats.latencies.shift();
  } else {
    _executionStats.rejected++;
    if ((result.reason || '').includes('broker')) _executionStats.brokerErrors++;
    if ((result.reason || '').includes('network')) _executionStats.networkErrors++;
  }
  bus.emit('metrics:exec', summary());
}

function recordRetry() { _executionStats.retries++; }

function summary() {
  const lats = _executionStats.latencies.slice().sort((a, b) => a - b);
  const pct = (p) => lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * p))] : 0;
  const avgSlippage = _executionStats.success ? _executionStats.totalSlippage / _executionStats.success : 0;
  return {
    total: _executionStats.total,
    success: _executionStats.success,
    rejected: _executionStats.rejected,
    retries: _executionStats.retries,
    successRate: _executionStats.total ? +(_executionStats.success / _executionStats.total * 100).toFixed(1) : 0,
    avgSlippage: +avgSlippage.toFixed(4),
    avgBrokerMs: _executionStats.success ? Math.round(_executionStats.totalBrokerMs / _executionStats.success) : 0,
    avgTotalMs: _executionStats.success ? Math.round(_executionStats.totalFillMs / _executionStats.success) : 0,
    latencyMin: lats.length ? lats[0] : 0,
    latencyMax: lats.length ? lats[lats.length - 1] : 0,
    latencyAvg: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0,
    latencyP95: pct(0.95),
    latencyP99: pct(0.99),
    perBroker: _executionStats.perBroker,
    brokerErrors: _executionStats.brokerErrors,
    networkErrors: _executionStats.networkErrors,
  };
}

// === Post-Trade Analysis: each closed trade ===
function analyzeTrade(trade) {
  if (!trade || !trade.entryPrice || !trade.exitPrice) return null;
  const pnl = trade.pnl || 0;
  const holdMs = trade.closeAt && trade.openAt ? new Date(trade.closeAt) - new Date(trade.openAt) :
                 (trade.durationSec || 0) * 1000;
  const slippageEntry = trade.expectedEntry ? Math.abs((trade.entryPrice - trade.expectedEntry) / trade.expectedEntry) : 0;
  const expectedPnl = trade.expectedPnl || 0;
  const decisionAccurate = (expectedPnl > 0 && pnl > 0) || (expectedPnl < 0 && pnl < 0);
  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    pnl: +pnl.toFixed(4),
    holdMs,
    slippageEntry: +slippageEntry.toFixed(6),
    commission: trade.commission || 0,
    decisionAccurate,
    pnlAccuracy: expectedPnl ? +(pnl / expectedPnl).toFixed(2) : 1,
    regime: trade.indicatorsSnapshot?.regime || 'unknown',
    confidence: trade.confidence || 0,
    closeReason: trade.closeReason || 'unknown',
  };
}

// Subscribe to event bus events
bus.on('trade:opened', (event) => {
  const result = event && event.ok !== undefined ? event : {
    ok: true, brokerUsed: event.broker || 'paper',
    price: event.price, qty: event.qty,
    expectedEntry: event.expectedEntry || event.price,
    slippage: event.slippageFinal || 0,
    brokerMs: event.brokerMs || 0,
    totalMs: event.totalMs || 0,
  };
  recordExecution(result);
});
bus.on('trade:closed', (t) => {
  const analysis = analyzeTrade(t);
  if (analysis) store.addLog({ type: 'analysis', level: 'info', msg: `📊 ${analysis.symbol} pnl=${analysis.pnl} hold=${(analysis.holdMs/1000).toFixed(1)}s slip=${(analysis.slippageEntry*100).toFixed(2)}% ${analysis.decisionAccurate ? '✓' : '✗'}` });
});

module.exports = { recordExecution, recordRetry, summary, analyzeTrade };