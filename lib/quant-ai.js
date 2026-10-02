'use strict';
// quant-ai.js — Institutional Quant AI Engine
// Multi-model voting, regime classification, market structure, volume profile, confluence ranking
const config = require('./config');
const market = require('./market');
const scanEngine = require('./scan-engine');
const bus = require('./event-bus');
const watchdog = require('./watchdog');

const W = {
  trend:     0.18,
  momentum:  0.16,
  volatility: 0.14,
  structure: 0.15,
  volume:    0.12,
  liquidity: 0.10,
  orderFlow: 0.10,
  multiTF:   0.05,
};

// === 1. Regime Classifier ===
function classifyRegime(klines, ind) {
  if (!klines || klines.length < 20 || !ind) return { regime: 'unknown', strength: 0, bias: 'neutral' };
  const adx = ind.adx || 20;
  const volRatio = ind.volRatio || 1;

  if (adx > 40) {
    return { regime: 'strong_trending', strength: +(Math.min(1, (adx - 40) / 60)).toFixed(2), bias: ind.trendUp ? 'bullish' : ind.trendDown ? 'bearish' : 'neutral', adx };
  }
  if (adx > 25) {
    return { regime: 'trending', strength: +((adx - 25) / 15).toFixed(2), bias: ind.trendUp ? 'bullish' : ind.trendDown ? 'bearish' : 'consolidating', adx };
  }
  if (adx < 20) {
    if (volRatio > 2.0) return { regime: 'volatile_ranging', strength: 0.7, bias: 'neutral', adx };
    if (volRatio < 0.6) return { regime: 'compression', strength: 0.8, bias: 'neutral', adx, note: 'potential expansion' };
    return { regime: 'ranging', strength: 0.5, bias: 'neutral', adx };
  }
  return { regime: 'transitional', strength: 0.4, bias: 'neutral', adx };
}

// === 2. Structure Engine (HH/HL/LH/LL + BOS + CHoCH + Liquidity Sweeps) ===
function detectStructure(klines) {
  if (klines.length < 30) return { score: 0, patterns: [], label: 'unknown' };
  const last = klines[klines.length - 1];
  const patterns = [];

  const swings = [];
  for (let i = 2; i < klines.length - 2; i++) {
    const w = klines.slice(i - 2, i + 3);
    const cur = klines[i];
    if (cur.high === Math.max(...w.map(k => k.high))) swings.push({ type: 'high', price: cur.high, i });
    if (cur.low === Math.min(...w.map(k => k.low))) swings.push({ type: 'low', price: cur.low, i });
  }
  if (swings.length < 2) return { score: 0, patterns: ['no_swings'], label: 'unstructured' };

  const recentHighs = swings.filter(s => s.type === 'high').slice(-3);
  const recentLows = swings.filter(s => s.type === 'low').slice(-3);
  let label = 'range';

  if (recentHighs.length >= 2) {
    const h1 = recentHighs[recentHighs.length - 2];
    const h2 = recentHighs[recentHighs.length - 1];
    if (h2.price > h1.price) {
      if (recentLows.length >= 2 && recentLows[recentLows.length - 1].price > recentLows[recentLows.length - 2].price) {
        patterns.push('HH_HL');
        label = 'bullish_structure';
      } else { patterns.push('BOS_UP'); label = 'bos_up'; }
    }
  }
  if (recentLows.length >= 2) {
    const l1 = recentLows[recentLows.length - 2];
    const l2 = recentLows[recentLows.length - 1];
    if (l2.price < l1.price) {
      if (recentHighs.length >= 2 && recentHighs[recentHighs.length - 1].price < recentHighs[recentHighs.length - 2].price) {
        patterns.push('LH_LL');
        label = 'bearish_structure';
      } else { patterns.push('BOS_DOWN'); label = 'bos_down'; }
    }
  }

  const recent10 = klines.slice(-10);
  const max10 = Math.max(...recent10.map(k => k.high));
  const min10 = Math.min(...recent10.map(k => k.low));
  if (last.high > max10 && last.close < last.open) { patterns.push('liq_sweep_buyside'); label = 'swept_above'; }
  if (last.low < min10 && last.close > last.open) { patterns.push('liq_sweep_sellside'); label = 'swept_below'; }

  let score = 0;
  if (patterns.includes('HH_HL')) score += 0.8;
  if (patterns.includes('BOS_UP')) score += 0.7;
  if (patterns.includes('LH_LL')) score += 0.6;
  if (patterns.includes('BOS_DOWN')) score += 0.5;
  if (patterns.includes('liq_sweep_sellside')) score += 0.4;
  if (patterns.includes('liq_sweep_buyside')) score += 0.4;
  return { score: +score.toFixed(2), patterns, label };
}

// === 3. Liquidity Engine ===
function evaluateLiquidity(orderBook, qty = 1) {
  if (!orderBook || !orderBook.bid || !orderBook.ask) return { score: 0, status: 'unknown', depth: 0 };
  const bid0 = +orderBook.bid;
  const ask0 = +orderBook.ask;
  const spread = (ask0 - bid0) / bid0;
  let score = 100;
  if (spread > 0.005) score -= 40;
  else if (spread > 0.002) score -= 20;
  else if (spread > 0.001) score -= 10;

  const bidVol = orderBook.bids ? orderBook.bids.slice(0, 3).reduce((s, b) => s + (+b[1] || 0), 0) : 0;
  const askVol = orderBook.asks ? orderBook.asks.slice(0, 3).reduce((s, a) => s + (+a[1] || 0), 0) : 0;
  const totalVol = bidVol + askVol;
  const minVol = qty * 5;
  if (totalVol < minVol) score -= 20;
  else if (totalVol < minVol * 2) score -= 10;

  return { score: Math.max(0, score), spread: +spread.toFixed(6), spreadPct: +(spread * 100).toFixed(3), bidVol: +bidVol.toFixed(2), askVol: +askVol.toFixed(2), status: score >= 80 ? 'liquid' : score >= 50 ? 'medium' : 'thin' };
}

// === 4. Volume Profile ===
function volumeProfile(klines, bins = 10) {
  if (klines.length < 20) return { score: 0, poc: null, vah: null, val: null };
  const max = Math.max(...klines.map(k => k.high));
  const min = Math.min(...klines.map(k => k.low));
  const range = max - min;
  const binSize = range / bins;
  const profile = new Array(bins).fill(0);
  for (const k of klines) {
    const avg = (k.high + k.low) / 2;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((avg - min) / binSize)));
    profile[idx] += +k.volume;
  }
  const totalVol = profile.reduce((s, v) => s + v, 0) || 1;
  const sortedBins = profile.map((vol, i) => ({ vol, price: min + (i + 0.5) * binSize, idx: i })).sort((a, b) => b.vol - a.vol);
  const poc = sortedBins[0];
  const pocVol = poc ? poc.vol : 1;
  // VAH/VAL: 68% value area
  let cum = 0;
  const targetVol = totalVol * 0.68;
  let vahPrice = max, valPrice = min;
  for (const bin of sortedBins) {
    cum += bin.vol;
    if (cum >= targetVol * 0.3 && valPrice === min) valPrice = bin.price;
    if (cum >= targetVol * 0.7) { vahPrice = bin.price; break; }
  }
  return { score: +(pocVol / totalVol).toFixed(2), poc: +((poc && poc.price) || (max + min) / 2).toFixed(6), vah: +vahPrice.toFixed(6), val: +valPrice.toFixed(6), totalVolume: +totalVol.toFixed(2) };
}

// === 5. Multi-Timeframe Confluence ===
async function multiTimeframeConfluence(symbol) {
  const timeframes = ['5m', '15m', '1h'];
  let allBullish = 0, allBearish = 0, agreeCount = 0;
  for (const tf of timeframes) {
    const klines = await market.getKlines(symbol, tf, 30).catch(() => []);
    if (klines.length < 14) continue;
    const ind = market.computeIndicators(klines, symbol, tf);
    if (ind.trendUp) allBullish++;
    if (ind.trendDown) allBearish++;
    agreeCount++;
  }
  const confluence = agreeCount > 0 ? Math.max(allBullish, allBearish) / agreeCount : 0;
  const sentiment = allBullish > allBearish ? 'bullish' : allBearish > allBullish ? 'bearish' : 'mixed';
  watchdog.beat('quant', { status: 'mtf_ready' });
  return { confluence: +confluence.toFixed(2), sentiment, frames: agreeCount };
}

// === 6. Voting System ===
async function voteSystem(symbol, ind, klines) {
  const votes = {};
  const details = {};

  // Trend
  const regime = classifyRegime(klines, ind);
  votes.trend = ind.adx > 25 ? (ind.trendUp ? 85 : ind.trendDown ? 75 : 50) : 30;
  details.trend = 'regime=' + regime.regime + ' adx=' + (ind.adx || 0);

  // Momentum
  const rsi = ind.rsi || 50;
  if (rsi > 60) votes.momentum = Math.min(90, rsi);
  else if (rsi < 40) votes.momentum = Math.max(10, rsi + 30);
  else votes.momentum = 55;
  details.momentum = 'rsi=' + rsi.toFixed(1);

  // Volume
  const vp = volumeProfile(klines);
  votes.volume = vp.score > 0 ? Math.round(vp.score * 100) : 40; // vol score 0 means N/A — give neutral
  details.volume = 'poc=' + vp.poc;

  // Structure
  const struct = detectStructure(klines);
  votes.structure = Math.round(struct.score * 100);
  details.structure = struct.label + ' [' + struct.patterns.join(';') + ']';

  // Order Flow
  const flow = scanEngine.orderFlowImbalance(klines.slice(-30));
  votes.orderFlow = flow.ratio > 0.1 ? 70 : flow.ratio < -0.1 ? 55 : 40;
  details.orderFlow = flow.dominant + ' (buy=' + flow.buyVol.toFixed(0) + ' sell=' + flow.sellVol.toFixed(0) + ')';

  // MultiTimeframe
  const mtf = await multiTimeframeConfluence(symbol);
  votes.multiTF = Math.round(mtf.confluence * 85);
  details.multiTF = 'mtf=' + mtf.sentiment + ' conf=' + mtf.confluence.toFixed(2);

  // Volatility
  const vol = scanEngine.volatilityFilter(klines);
  votes.volatility = vol.acceptable ? 70 : 20;
  details.volatility = 'acceptable=' + vol.acceptable;

  let totalScore = 0;
  for (const k of Object.keys(votes))
    totalScore += votes[k] * (W[k] || 0.1);
  totalScore /= Object.keys(votes).length;
  const confidence = Math.round(totalScore * 10) / 10;

  return { symbol, confidence: Math.min(100, Math.max(0, confidence)), votes, details, regime: regime.regime, structure: struct.patterns };
}

// === 7. Signal Ranking ===
function rankSignals(signals) {
  return signals.filter(s => s && s.confidence >= 50).sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

// === 8. Decision Explanation ===
function explainDecision(signal) {
  const parts = [];
  if (signal.details)
    for (const [model, detail] of Object.entries(signal.details))
      parts.push(model + ': ' + detail);
  return { reason: parts.join(' | '), models: signal.votes, regime: signal.regime, confidence: signal.confidence };
}

// === 9. Learning Database ===
const learningDB = [];
function recordDecision(outcome) {
  learningDB.push({ ...outcome, ts: Date.now() });
  if (learningDB.length > 2000) learningDB.shift();
}
function getLearningStats() {
  const total = learningDB.length;
  const wins = learningDB.filter(r => r.win).length;
  const avgConf = learningDB.reduce((s, r) => s + r.confidence, 0) / Math.max(1, total);
  const highConf = learningDB.filter(r => r.confidence >= 70);
  const highConfWin = highConf.filter(r => r.win).length;
  return {
    total, wins, losses: total - wins,
    avgConfidence: avgConf.toFixed(1),
    highConfCount: highConf.length,
    highConfWinRate: highConf.length ? +(highConfWin / highConf.length * 100).toFixed(1) : 0,
  };
}

// === 10. Single-symbol analyze ===
async function analyze(symbol) {
  const t0 = Date.now();
  watchdog.beat('quant', { status: 'analyzing ' + symbol });
  const klines = await market.getKlines(symbol, '15m', 100).catch(() => []);
  if (klines.length < 14) return { symbol, error: 'insufficient klines' };
  const ind = market.computeIndicators(klines, symbol, '15m');
  if (!ind) return { symbol, error: 'no indicators' };
  const votes = await voteSystem(symbol, ind, klines);
  watchdog.beat('quant', { status: 'done', confidence: votes.confidence });
  return { ...votes, elapsedMs: Date.now() - t0 };
}

// === 11. Batch analyze ===
async function analyzeMultiple(symbols, concurrency = 3) {
  const results = [];
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const res = await Promise.all(batch.map(s => analyze(s).catch(e => ({ symbol: s, error: e.message }))));
    results.push(...res);
  }
  return results;
}

module.exports = {
  classifyRegime, detectStructure, evaluateLiquidity, volumeProfile,
  multiTimeframeConfluence, voteSystem, rankSignals, explainDecision,
  recordDecision, getLearningStats, analyze, analyzeMultiple,
};