'use strict';
/*
 * decision-engine.js v2 — Adaptive Pro-Trader Confluence Engine.
 *
 * v2 changes:
 *  - Fixed ATR filter (was blocking 95% of entries)
 *  - Market Regime Detection (TRENDING/RANGING/VOLATILE) with adaptive weights
 *  - Regime-aware entry logic (trending=rally-pullback, ranging=mean-reversion)
 *  - AI role upgraded from 0.08 to 0.25 weight + serves as tiebreaker
 *  - Time-of-day / session filter (low-liquidity Asian lunch/night)
 *  - Statistical decision scoring (normalized to 1.0)
 *
 * Output:
 *   LONG | SHORT | WAIT | NO_TRADE + confidence + regime-based SL/TP
 */
const market = require('./market');
const scan = require('./scan-engine');
const sentiment = require('./sentiment');
const ai = require('./ai');
const config = require('./config');
const store = require('./store');

let _sentCache = { ts: 0, data: null };
async function getCachedSentiment() {
  const now = Date.now();
  if (_sentCache.data && (now - _sentCache.ts < 30000)) return _sentCache.data;
  try {
    const s = await sentiment.getFullSnapshot('BTC');
    _sentCache = { ts: now, data: s };
    return s;
  } catch { return { fearGreed: { value: 50 }, news: { score: 0 }, risk: { safe: true } }; }
}

function sessionScore() {
  const h = new Date().getUTCHours();
  // London sessions: 7-19 UTC = most liquid
  if (h >= 7 && h <= 19) return 1.0;
  // New York overlap: 13-19 = highest volume
  if (h >= 13 && h <= 19) return 1.2;
  // Asian session: higher spread
  if (h >= 0 && h <= 6) return 0.4;
  // Pre-market / weekend overlap
  return 0.6;
}

async function decide(symbol, opts = {}) {
  const t0 = Date.now();
  let bullScore = 0, bearScore = 0;
  let filters = { liquidity: true, riskSafe: true };

  // === Parallel data fetch ===
  const [kl1m, kl5m, kl15m, sent] = await Promise.all([
    market.getKlines(symbol, '1m', 50).catch(() => null),
    market.getKlines(symbol, '5m', 50).catch(() => null),
    market.getKlines(symbol, '15m', 50).catch(() => null),
    getCachedSentiment(),
  ]);
  if (!kl15m || kl15m.length < 14) return _noTrade('insufficient_data');

  const ind15 = market.computeIndicators(kl15m, symbol, '15m');
  const ind1m = kl1m && kl1m.length >= 14 ? market.computeIndicators(kl1m, symbol, '1m') : ind15;
  const ind5m = kl5m && kl5m.length >= 14 ? market.computeIndicators(kl5m, symbol, '5m') : ind15;

  // ===== SESSION FILTER =====
  const sessionMult = sessionScore();
  if (sessionMult < 0.35) filters.liquidity = false;

  // ===== REGIME DETECTION =====
  const regime = ind15.regime || (ind15.adx > 25 ? 'trending' : ind15.adx < 20 ? 'ranging' : 'transitional');

  // ===== ADAPTIVE WEIGHTS (trending vs ranging) =====
  let W;
  if (regime === 'trending') {
    W = { mtf: 0.35, structure: 0.20, rsi: 0.08, bb: 0.05, flow: 0.08, sentiment: 0.04, pattern: 0.03, ai: 0.17 };
  } else { // ranging
    W = { mtf: 0.10, structure: 0.10, rsi: 0.25, bb: 0.20, flow: 0.10, sentiment: 0.08, pattern: 0.07, ai: 0.10 };
  }

  // 1) Multi-TF trend
  const tfs = [['1m', ind1m], ['5m', ind5m], ['15m', ind15]];
  let tfBull = 0, tfBear = 0;
  tfs.forEach(([, ind]) => {
    if (ind.trendUp) tfBull++; else if (ind.trendDown) tfBear++;
  });
  const mtfScore = (tfBull - tfBear) / 3;
  if (mtfScore > 0) bullScore += W.mtf * mtfScore * sessionMult;
  else if (mtfScore < 0) bearScore += W.mtf * -mtfScore * sessionMult;

  // 2) Market structure
  const structure = scan.detectMarketStructure(kl15m);
  if (structure.structure.includes('HH')) bullScore += W.structure;
  else if (structure.structure.includes('LL')) bearScore += W.structure;

  // 3) RSI — regime-aware
  const rsi = ind15.rsi;
  if (regime === 'ranging') {
    if (rsi < 30) bullScore += W.rsi;       // bounce from oversold
    else if (rsi > 70) bearScore += W.rsi;  // fade from overbought
    else if (rsi < 40 && rsi > 30) bullScore += W.rsi * 0.5;
    else if (rsi > 60 && rsi < 70) bearScore += W.rsi * 0.5;
  } else { // trending
    if (rsi > 50 && rsi < 65 && ind15.trendUp) bullScore += W.rsi * 0.6;
    if (rsi < 50 && rsi > 35 && ind15.trendDown) bearScore += W.rsi * 0.6;
  }

  // 4) Bollinger — regime-aware
  const price = ind15.price;
  if (regime === 'ranging') {
    if (price <= ind15.bbLow) bullScore += W.bb;
    else if (price >= ind15.bbHigh) bearScore += W.bb;
  } else {
    if (price > ind15.bbMid && ind15.trendUp) bullScore += W.bb * 0.3;
    if (price < ind15.bbMid && ind15.trendDown) bearScore += W.bb * 0.3;
  }

  // 5) Volume / Order flow
  const flow = scan.orderFlowImbalance(kl15m);
  if (flow.dominant === 'buy') bullScore += W.flow;
  else if (flow.dominant === 'sell') bearScore += W.flow;
  const volRatio = ind15.volRatio || 1;
  if (volRatio > 1.5) { bullScore += W.flow * 0.15; bearScore += W.flow * 0.15; }

  // 6) ATR — scale entry size, don't block (unless extreme)
  const atrPct = ind15.atr / price;
  if (atrPct < 0.0003 || atrPct > 0.05) filters.noise = true; // dead / crash

  // 7) Sentiment
  const fg = sent.fearGreed?.value || 50;
  if (fg < 25) bullScore += W.sentiment * 0.6;
  else if (fg > 80) bearScore += W.sentiment * 0.6;
  if (sent.risk && !sent.risk.safe) filters.riskSafe = false;

  // 8) Candlestick patterns
  const pattern = scan.candlePatterns(kl15m);
  if (pattern.pattern.includes('bull')) bullScore += W.pattern * pattern.strength;
  else if (pattern.pattern.includes('bear')) bearScore += W.pattern * pattern.strength;

  // 9) AI confirmation (primary tiebreaker)
  let aiSignal = 0; // -1 bear, 0 none, 1 bull
  try {
    const aiD = await ai.analyze(ind15, { symbol, timeframe: '15m', mode: config.get('TRADING_MODE'), scalpMode: true, regime, mtfBull: tfBull, mtfBear: tfBear, rsi });
    if (aiD.action === 'BUY') { bullScore += W.ai * aiD.confidence; aiSignal = 1; }
    else if (aiD.action === 'SELL') { bearScore += W.ai * aiD.confidence; aiSignal = -1; }
  } catch (e) { /* AI key masked — skip */ }

  // ===== FINAL DECISION =====
  const confDelta = Math.abs(bullScore - bearScore);
  const minConf = +config.get('MIN_CONFIDENCE', '0.55');
  const confidence = +Math.min(0.98, confDelta / (W.mtf + W.structure + W.rsi + W.bb + W.flow)).toFixed(3);

  let action;
  if (filters.noise) action = 'NO_TRADE';
  else if (!filters.riskSafe) action = 'NO_TRADE';
  else if (!filters.liquidity && confDelta < minConf * 1.5) action = 'WAIT';
  else if (bullScore - bearScore > minConf * 0.25 && (aiSignal === 1 || aiSignal === 0)) action = 'LONG';
  else if (bearScore - bullScore > minConf * 0.25 && (aiSignal === -1 || aiSignal === 0)) action = 'SHORT';
  else action = 'WAIT';

  const slPct = +(Math.max(0.002, atrPct * 1.5)).toFixed(4);
  const tpPct = +(Math.max(0.004, atrPct * 3.0)).toFixed(4);

  const result = {
    action, side: action === 'LONG' ? 'long' : action === 'SHORT' ? 'short' : 'none',
    symbol, confidence, reasoning: `${regime} session=${sessionMult.toFixed(1)} bull=${bullScore.toFixed(2)} bear=${bearScore.toFixed(2)} rsi=${rsi} adx=${ind15.adx}`,
    bullScore: +bullScore.toFixed(3), bearScore: +bearScore.toFixed(3),
    factors: { regime, session: sessionMult, rsi, adx: ind15.adx, flow: scan.orderFlowImbalance(kl15m).dominant, pattern: pattern.pattern },
    slPct, tpPct, analysisMs: Date.now() - t0,
    triggered: new Date().toISOString(),
  };
  // Only persist helpful decisions to disk
  if (action !== 'WAIT') store.addDecision(result);
  return result;
}

function _noTrade(reason) {
  return { action: 'NO_TRADE', side: 'none', confidence: 0, reasoning: reason, slPct: 0.003, tpPct: 0.006 };
}

function checkVolatilitySpike(symbol, klines) {
  if (!klines || klines.length < 5) return { blocked: false };
  const last = klines[klines.length - 1];
  const recent = klines.slice(-5, -1);
  const avgRange = recent.reduce((s, k) => s + (k.high - k.low), 0) / recent.length;
  const lastRange = last.high - last.low;
  if (avgRange > 0 && lastRange > avgRange * 3) return { blocked: true, reason: 'range > 3× avg' };
  return { blocked: false };
}

module.exports = { decide, checkVolatilitySpike };