'use strict';
// scan-engine.js — Institutional-grade market scanner
// Scans 100+ cryptos in parallel + MTF + market structure + S/R + liquidity zones + order flow + volatility + sentiment
const config = require('./config');
const market = require('./market');
const sentiment = require('./sentiment');
const risk = require('./risk');

const DEFAULT_SCAN = [...new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'MATICUSDT','SHIBUSDT','LTCUSDT','ATOMUSDT','TRXUSDT','ETCUSDT','ALGOUSDT','FTMUSDT','NEARUSDT','APTUSDT',
  'ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','SEIUSDT','TIAUSDT','ORDIUSDT','PEPEUSDT','BONKUSDT','FILUSDT',
  'IMXUSDT','RNDRUSDT','GRTUSDT','SANDUSDT','MANAUSDT','AXSUSDT','AAVEUSDT','CRVUSDT','UNIUSDT','SUSHIUSDT',
  '1INCHUSDT','COMPUSDT','SNXUSDT','DYDXUSDT','GMXUSDT','RUNEUSDT','MINAUSDT','EGLDUSDT','FLOWUSDT','XTZUSDT',
  'KAVAUSDT','ZILUSDT','THETAUSDT','CHZUSDT','ANKRUSDT','COTIUSDT','DUSKUSDT','WAVESUSDT','XLMUSDT','HBARUSDT',
  'VETUSDT','EOSUSDT','ICXUSDT','ONEUSDT','ENJUSDT','BATUSDT','ZRXUSDT','ONTUSDT','IOTAUSDT','QTUMUSDT',
  'SCUSDT','MKRUSDT','NMRUSDT','LRCUSDT','OCEANUSDT','THECUSDT','AGIXUSDT',
  'LDOUSDT','FXSUSDT','BALUSDT','YFIUSDT','WBTCUSDT','STXUSDT','KSMUSDT','GLMRUSDT',
  'ASTRUSDT','MOVRUSDT','EQXUSDT','POKTUSDT','HOTUSDT','XECUSDT','PENDLEUSDT','JTOUSDT','JUPUSDT','PYTHUSDT',
  'WLDUSDT','STRKUSDT','MNTUSDT','BLURUSDT','CFXUSDT','USTCUSDT','LITUSDT','PORTALUSDT','PIXELUSDT','RONINUSDT',
])];

function getScanList() {
  const configured = config.get('SCAN_SYMBOLS', '');
  if (configured) return configured.split(',').map(s => s.trim().toUpperCase());
  return DEFAULT_SCAN.slice(0, Math.min(+config.get('SCAN_LIMIT', '100') || 100, DEFAULT_SCAN.length));
}

// Market structure: detect HH/HL/LH/LL swings
function detectMarketStructure(klines) {
  let highs = 0, lows = 0, lastHighIdx = -1, lastLowIdx = -1;
  for (let i = 2; i < klines.length - 2; i++) {
    const w = klines.slice(i - 2, i + 3);
    if (klines[i].high === Math.max(...w.map(k => k.high))) highs++, lastHighIdx = i;
    if (klines[i].low === Math.min(...w.map(k => k.low))) lows++, lastLowIdx = i;
  }
  const prev = klines[klines.length - 2];
  const last = klines[klines.length - 1];
  const trend = last.close > prev.close ? 'up' : last.close < prev.close ? 'down' : 'ranging';
  const lastHigh = klines[lastHighIdx]?.high || 0;
  const lastLow = klines[lastLowIdx]?.low || 0;
  const structure = trend === 'up' ? (lastHigh > klines[Math.max(0, lastHighIdx-5)]?.high || 0 ? 'HH_HL' : 'LH_HL')
                  : trend === 'down' ? (lastLow < klines[Math.max(0, lastLowIdx-5)]?.low || 0 ? 'LH_LL' : 'HH_LL')
                  : 'range';
  return { trend, structure, lastHigh, lastLow, swingPoints: { highs, lows } };
}

function computeLevels(klines, lookback = 50) {
  const recent = klines.slice(-lookback);
  const max = Math.max(...recent.map(k => k.high));
  const min = Math.min(...recent.map(k => k.low));
  const range = max - min;
  // Fibonacci S/R levels
  const fib = {
    '0.0': max, '0.236': max - 0.236 * range, '0.382': max - 0.382 * range,
    '0.5': max - 0.5 * range, '0.618': max - 0.618 * range, '0.786': max - 0.786 * range, '1.0': min,
  };
  // Volume Profile (simple bins)
  const bins = 10;
  const binSize = range / bins;
  const volByPrice = new Array(bins).fill(0);
  recent.forEach(k => {
    const avg = (k.high + k.low) / 2;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((avg - min) / binSize)));
    volByPrice[idx] += +k.volume;
  });
  const maxBinVol = Math.max(...volByPrice);
  const pocIdx = volByPrice.indexOf(maxBinVol);
  const poc = min + pocIdx * binSize + binSize / 2;
  return { max, min, range, fib, vp: { poc, valBins: volByPrice, dist: recent.length * binSize } };
}

function liquidityZones(levels, ticker) {
  const price = ticker.price;
  const { max, min, fib, vp } = levels;
  const buyside = fib['0.0'] > price ? fib['0.0'] : Math.max(max, price * 1.02);
  const sellside = fib['1.0'] < price ? fib['1.0'] : Math.min(min, price * 0.98);
  return { buyside, sellside, sweepRisk: Math.abs(price - vp.poc) / (levels.range || price) < 0.05 ? 'high' : 'low', poc: vp.poc };
}

function orderFlowImbalance(klines) {
  let buyVol = 0, sellVol = 0;
  for (let i = 1; i < klines.length; i++) {
    const up = klines[i].close > klines[i-1].close;
    if (up) buyVol += +klines[i].volume; else sellVol += +klines[i].volume;
  }
  const total = buyVol + sellVol;
  const ratio = total ? (buyVol - sellVol) / total : 0;
  return { buyVol, sellVol, ratio, dominant: ratio > 0.15 ? 'buy' : ratio < -0.15 ? 'sell' : 'balanced' };
}

function candlePatterns(klines) {
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  if (!last || !prev) return { pattern: 'unknown', strength: 0 };
  const bodyLast = Math.abs(last.close - last.open);
  const bodyPrev = Math.abs(prev.close - prev.open);
  if (last.close < last.open && last.low < prev.low && last.close > prev.close) return { pattern: 'engulfing_bull', strength: 0.85 };
  if (last.close > last.open && last.high > prev.high && last.close < prev.close) return { pattern: 'engulfing_bear', strength: 0.85 };
  if (bodyLast < 0.3 * (last.high - last.low) && bodyPrev < 0.3 * (prev.high - prev.low)) return { pattern: 'doji', strength: 0.4 };
  if (prev.close < prev.open && last.close > prev.close && last.close > prev.open && bodyLast > bodyPrev * 1.5) return { pattern: 'pinbar_bull', strength: 0.75 };
  if (prev.close > prev.open && last.close < prev.close && last.close < prev.open && bodyLast > bodyPrev * 1.5) return { pattern: 'pinbar_bear', strength: 0.75 };
  return { pattern: 'normal', strength: 0.3 };
}

function volatilityFilter(klines) {
  const recent = klines.slice(-20);
  const returns = [];
  for (let i = 1; i < recent.length; i++) returns.push((recent[i].close - recent[i-1].close) / recent[i-1].close);
  const mean = returns.reduce((s,r)=>s+r,0) / returns.length;
  const sd = Math.sqrt(returns.reduce((s,r)=>s+Math.pow(r-mean,2),0) / returns.length);
  const v = sd * Math.sqrt(recent.length);
  // Reasonable volatility: not dead (< 0.002) and not chaotic (< 0.15)
  return { vol: v, acceptable: v > 0.002 && v < 0.15 };
}

function confidenceScore(factors) {
  let score = 0.5;
  const act = (factors.action || '').toUpperCase();
  if (factors.trend === 'up' && (act === 'BUY' || act === 'LONG')) score += 0.15;
  if (factors.trend === 'down' && (act === 'SELL' || act === 'SHORT')) score += 0.15;
  if (factors.structure.includes('HH') && (act === 'BUY' || act === 'LONG')) score += 0.10;
  if (factors.structure.includes('LL') && (act === 'SELL' || act === 'SHORT')) score += 0.10;
  if (factors.flow === 'buy' && (act === 'BUY' || act === 'LONG')) score += 0.08;
  if (factors.flow === 'sell' && (act === 'SELL' || act === 'SHORT')) score += 0.08;
  if (factors.pattern.startsWith('engulfing_bull')) score += 0.10;
  if (factors.pattern.startsWith('engulfing_bear') && (act === 'SELL' || act === 'SHORT')) score += 0.10;
  if (factors.volatility) score += 0.05;
  if (factors.sentimentGood) score += 0.07;
  if (factors.riskSafe) score += 0.10;
  return +Math.min(0.97, Math.max(0, score)).toFixed(2);
}

async function analyzeSymbol(symbol) {
  try {
    // PARALLEL fetch: ticker + klines + sentiment (all at once)
    const [ticker, klines, sent] = await Promise.all([
      market.getTicker(symbol).catch(() => null),
      market.getKlines(symbol, '5m', 100).catch(() => null),
      sentiment.getFullSnapshot(symbol).catch(() => ({ fearGreed: { value: 50 }, news: { score: 0, count: 0 }, risk: { safe: true } })),
    ]);
    if (!ticker || !ticker.price || !klines || klines.length < 14) return null;
    
    const ind = market.computeIndicators(klines, symbol, '5m');
    const structure = detectMarketStructure(klines);
    const levels = computeLevels(klines);
    const zones = liquidityZones(levels, ticker);
    const flow = orderFlowImbalance(klines);
    const pattern = candlePatterns(klines);
    const vol = volatilityFilter(klines);
    
    let action = 'HOLD';
    // Regime-aware entry logic (mirrors decision engine)
    if (vol.acceptable) {
      const rsi = ind.rsi || 50;
      const regime = ind.regime || 'transitional';
      const trendUp = ind.trendUp, trendDown = ind.trendDown;

      if (regime === 'ranging') {
        // Mean-reversion in range
        if (rsi < 32 && ind.price <= ind.bbLow) action = 'BUY';
        else if (rsi > 68 && ind.price >= ind.bbHigh) action = 'SELL';
        else if (rsi < 38 && flow.dominant === 'buy') action = 'BUY';
        else if (rsi > 62 && flow.dominant === 'sell') action = 'SELL';
      } else {
        // Trend following with pullback entry
        if (trendUp && rsi > 45 && rsi < 65 && ind.price > ind.bbMid) action = 'BUY';
        else if (trendDown && rsi < 55 && rsi > 35 && ind.price < ind.bbMid) action = 'SELL';
        // BOS (break of structure) entries
        else if (structure.structure === 'HH/HL' && flow.dominant === 'buy') action = 'BUY';
        else if (structure.structure === 'LH/LL' && flow.dominant === 'sell') action = 'SELL';
      }
    }
    
    const factors = {
      action, trend: structure.trend, structure: structure.structure,
      flow: flow.dominant, pattern: pattern.pattern, volatility: vol.acceptable,
      sentimentGood: (sent.fearGreed?.value || 50) > 25 && (sent.fearGreed?.value || 50) < 75,
      riskSafe: sent.risk?.safe !== false,
    };
    const confidence = confidenceScore(factors);
    return {
      symbol, price: ticker.price, action, confidence,
      structure, levels, zones, flow, pattern, volatility: vol, sentiment: sent,
      rsi: +(ind.rsi || 50).toFixed(2), factors,
    };
  } catch (e) { return { symbol, error: e.message }; }
}

async function scanAll(symbols = null) {
  const list = symbols || getScanList();
  const t0 = Date.now();
  const results = await Promise.all(list.map(s => analyzeSymbol(s).catch(e => ({ symbol: s, error: e.message }))));
  const valid = results.filter(r => r && r.action && !r.error);
  return {
    ok: true, scanned: list.length, valid: valid.length, elapsedMs: Date.now() - t0,
    ranked: valid.filter(r => r.action !== 'HOLD').sort((a,b) => b.confidence - a.confidence).slice(0, 20),
    top10: valid.filter(r => r.action !== 'HOLD' && r.confidence >= 0.7).sort((a,b) => b.confidence - a.confidence).slice(0, 10),
  };
}

module.exports = {
  DEFAULT_SCAN, getScanList, scanAll, analyzeSymbol,
  detectMarketStructure, computeLevels, liquidityZones, orderFlowImbalance,
  candlePatterns, volatilityFilter, confidenceScore,
};
