'use strict';
// analytics-worker.js — Win Rate, Profit Factor, Sharpe, Sortino, Calmar, Drawdown, Expectancy
const { parentPort } = require('worker_threads');

if (parentPort) {
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', (msg) => {
    try {
      const { id, task } = msg;
      let result;
      switch (task.type) {
        case 'trade-stats': result = tradeStats(task.trades); break;
        case 'latency-stats': result = latencyStats(task.latencies); break;
        default: throw new Error('unknown analytics task: ' + task.type);
      }
      parentPort.postMessage({ id, result });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message });
    }
  });
}

function tradeStats(trades) {
  if (!Array.isArray(trades) || !trades.length) return { total: 0, winRate: 0, profitFactor: 0, sharpe: 0, sortino: 0, calmar: 0, expectancy: 0, avgHold: 0, maxDD: 0 };
  const pnls = trades.map(t => +(t.pnl || 0));
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const totalWins = wins.reduce((s,p)=>s+p,0);
  const totalLosses = Math.abs(losses.reduce((s,p)=>s+p,0));
  const mean = pnls.reduce((s,p)=>s+p,0) / pnls.length;
  const variance = pnls.reduce((s,p)=>s+Math.pow(p-mean,2),0) / pnls.length;
  const sd = Math.sqrt(variance);

  // Downside deviation (Sortino)
  const downside = losses.length ? losses.map(p => Math.pow(p, 2)) : [0];
  const downsideDev = Math.sqrt(downside.reduce((s,p)=>s+p,0) / pnls.length);

  // Sharpe (annualized: crypto trades ~365*24)
  const sharpe = sd > 0 ? +(mean / sd * Math.sqrt(8760)).toFixed(3) : 0;
  const sortino = downsideDev > 0 ? +(mean / downsideDev * Math.sqrt(8760)).toFixed(3) : 0;

  // Max Drawdown
  let peak = 0, dd = 0, cum = 0;
  pnls.forEach(p => { cum += p; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); });

  // Calmar = annual return / max DD
  const totalReturn = pnls.reduce((s,p)=>s+p,0);
  const calmar = dd !== 0 ? +(totalReturn / Math.abs(dd)).toFixed(3) : 0;

  // Expectancy
  const winRate = wins.length / pnls.length;
  const avgWin = wins.length ? totalWins / wins.length : 0;
  const avgLoss = losses.length ? totalLosses / losses.length : 0;
  const expectancy = +(winRate * avgWin - (1 - winRate) * avgLoss).toFixed(4);

  // Avg hold time
  const holds = trades.map(t => (t.durationSec || 0));
  const avgHold = holds.length ? +(holds.reduce((s,h)=>s+h,0) / holds.length).toFixed(1) : 0;

  return {
    total: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +(winRate * 100).toFixed(1),
    profitFactor: totalLosses > 0 ? +(totalWins / totalLosses).toFixed(2) : 0,
    sharpe, sortino, calmar,
    expectancy,
    avgHoldSec: avgHold,
    maxDD: +dd.toFixed(2),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    totalReturn: +totalReturn.toFixed(2),
  };
}

function latencyStats(latencies) {
  if (!Array.isArray(latencies) || !latencies.length) return { avg: 0, min: 0, max: 0, p95: 0, p99: 0 };
  const sorted = latencies.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((s,v)=>s+v,0) / sorted.length;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(avg),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}