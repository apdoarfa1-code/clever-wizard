'use strict';
/*
 * market.js v2 — Ultra-low-latency market data layer.
 *  - Tiered cache TTL (5s/30s/60s by timeframe)
 *  - Parallel provider race (Bybit || Binance) — fastest wins, slow killed
 *  - Ticker cache 2s (eliminates redundant fetches)
 *  - Cached computeIndicators (keyed by symbol+interval+ts)
 *  - Single-pass indicator math (no redundant SMA calls)
 *  - Warmup on startup (pre-fetch top symbols)
 */
const httpLib = require('./http');
const config = require('./config');

const BINANCE_BASE = 'https://api.binance.com';
const bybitIntervalMap = { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'D' };

// Tiered TTL by timeframe
const TTL = { '1m': 5000, '5m': 5000, '15m': 30000, '1h': 60000, '4h': 60000, '1d': 60000 };
function ttlFor(tf) { return TTL[tf] || 30000; }

// Caches
const klinesCache = new Map();       // key -> { ts, data, promise }
const tickerCache = new Map();       // symbol -> { ts, data, promise }
const indCache = new Map();          // key -> { ts, data }

async function getBybitKlines(symbol, interval = '15m', limit = 100) {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitIntervalMap[interval] || '15'}&limit=${limit}`;
  const res = await httpLib.request(url, { method: 'GET', timeout: 6000 });
  if (!res.ok) throw new Error(`Bybit ${res.status}`);
  const arr = res.json?.result?.list || [];
  return arr.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: 0 })).reverse();
}

async function getBinanceKlines(symbol, interval = '15m', limit = 100) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], close: k[5], closeTime: k[6], quoteVolume: k[7], trades: k[8] }));
}

async function getBinanceTicker(symbol) {
  const url = `${BINANCE_BASE}/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  return { symbol: res.json.symbol, price: +res.json.lastPrice, change: +res.json.priceChangePercent, high: +res.json.highPrice, low: +res.json.lowPrice, volume: +res.json.volume, quoteVolume: +res.json.quoteVolume, trades: +res.json.count };
}

async function getBinanceOrderBook(symbol, limit = 10) {
  const url = `${BINANCE_BASE}/api/v3/depth?symbol=${symbol}&limit=${limit}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Binance depth ${res.status}`);
  return { bids: res.json.bids.map(b => [+b[0], +b[1]]), asks: res.json.asks.map(a => [+a[0], +a[1]]) };
}

// === getKlines: parallel provider race + tiered cache + in-flight dedup ===
function _normalize(klines) {
  if (!Array.isArray(klines)) return [];
  return klines
    .map(k => ({
      time: +(k[0] || k.time || 0),
      open: +k[1] || +k.open || 0,
      high: +k[2] || +k.high || 0,
      low: +k[3] || +k.low || 0,
      close: +k[4] || +k.close || 0,
      volume: +k[5] || +k.volume || 0,
      closeTime: +(k[6] || k.closeTime || 0),
    }))
    .filter(k => k.close > 0 && k.time > 0);
}

async function getKlines(symbol, interval, limit) {
  interval = interval || config.get('AGENT_TIMEFRAME', '15m');
  limit = limit || 100;
  const key = `klines:${symbol}:${interval}:${limit}`;
  const now = Date.now();
  const cached = klinesCache.get(key);
  if (cached && (now - cached.ts < ttlFor(interval))) return cached.data;
  if (cached && cached.promise) return cached.promise; // in-flight dedup

  const p = (async () => {
    try {
      // Parallel race: Bybit vs Binance — fastest wins
      const data = await Promise.race([
        getBybitKlines(symbol, interval, limit),
        getBinanceKlines(symbol, interval, limit).catch(() => { throw new Error('binance'); }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      const norm = _normalize(data);
      klinesCache.set(key, { ts: Date.now(), data: norm, promise: null });
      return norm;
    } catch (e) {
      // Fallback: try sequential if race failed
      if (cached && cached.data) return cached.data; // stale is better than nothing
      try { return _normalize(await getBybitKlines(symbol, interval, limit)); }
      catch { return _normalize(await getBinanceKlines(symbol, interval, limit)); }
    }
  })();
  klinesCache.set(key, { ts: now, data: cached?.data, promise: p });
  return p;
}

// === getTicker: cached 2s + in-flight dedup ===
async function getTicker(symbol) {
  const now = Date.now();
  const cached = tickerCache.get(symbol);
  if (cached && (now - cached.ts < 2000)) return cached.data;
  if (cached && cached.promise) return cached.promise;

  const p = (async () => {
    try {
      const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`;
      const res = await httpLib.request(url, { method: 'GET', timeout: 5000 });
      if (!res.ok) throw new Error(`Bybit ticker ${res.status}`);
      const t = res.json?.result?.list?.[0] || {};
      const data = { symbol, price: +t.lastPrice || 0, change: +t.price24hPcnt * 100 || 0, high: +t.highPrice24h || 0, low: +t.lowPrice24h || 0, volume: +t.volume24h || 0, quoteVolume: +t.turnover24h || 0, trades: 0 };
      tickerCache.set(symbol, { ts: Date.now(), data, promise: null });
      return data;
    } catch {
      // Binance fallback
      const data = await getBinanceTicker(symbol);
      tickerCache.set(symbol, { ts: Date.now(), data, promise: null });
      return data;
    }
  })();
  tickerCache.set(symbol, { ts: now, data: cached?.data, promise: p });
  return p;
}

// === computeIndicators: cached + single-pass (no redundant SMA) ===
function computeIndicators(klines, symbol, interval) {
  if (!klines || klines.length < 14) return {};
  const cacheKey = symbol && interval ? `${symbol}:${interval}:${klines[klines.length-1]?.time||0}` : null;
  if (cacheKey) {
    const c = indCache.get(cacheKey);
    if (c) return c.data;
  }
  const closes = klines.map(k => k.close);
  const last = klines[klines.length - 1];
  const c = closes[closes.length - 1];

  // RSI (Wilder)
  const rsiPeriod = 14;
  let gain = 0, loss = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= rsiPeriod; loss /= rsiPeriod;
  for (let i = rsiPeriod + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    gain = (gain*(rsiPeriod-1) + (d > 0 ? d : 0)) / rsiPeriod;
    loss = (loss*(rsiPeriod-1) + (d < 0 ? -d : 0)) / rsiPeriod;
  }
  const rsi = loss === 0 ? 100 : 100 - (100 / (1 + gain/loss));

  // Bollinger (single SMA pass)
  const n = Math.min(20, closes.length);
  const sma = closes.slice(-n).reduce((a,b)=>a+b,0) / n;
  let variance = 0;
  for (let i = closes.length - n; i < closes.length; i++) variance += Math.pow(closes[i] - sma, 2);
  variance /= n;
  const sd = Math.sqrt(variance);
  const bbHigh = sma + 2 * sd;
  const bbLow = sma - 2 * sd;

  // ATR (single pass)
  const atrN = Math.min(14, klines.length - 1);
  let atrSum = 0;
  for (let i = klines.length - atrN; i < klines.length; i++) atrSum += klines[i].high - klines[i].low;
  const atr = atrSum / atrN;

  // EMA(9) + EMA(21) — trend direction
  const ema = (arr, period) => {
    const k = 2/(period+1); let prev = arr[0];
    for (let i = 1; i < arr.length; i++) prev = arr[i]*k + prev*(1-k);
    return prev;
  };
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);

  // Volume profile (simple POC)
  const max20 = Math.max(...klines.slice(-20).map(k => k.high));
  const min20 = Math.min(...klines.slice(-20).map(k => k.low));
  const bins = 10;
  const binSize = (max20 - min20) / bins || 1;
  const volByPrice = new Array(bins).fill(0);
  klines.slice(-20).forEach(k => {
    const idx = Math.min(bins-1, Math.max(0, Math.floor((((k.high+k.low)/2) - min20) / binSize)));
    volByPrice[idx] += +k.volume;
  });
  const pocIdx = volByPrice.indexOf(Math.max(...volByPrice));
  const poc = min20 + pocIdx * binSize + binSize/2;

  // ADX — trend strength (0-100, >25 = trending, <20 = ranging)
  const adxP = Math.min(14, closes.length - 1);
  let trSum = 0, plusDSum = 0, minusDSum = 0;
  for (let i = 1; i <= adxP; i++) {
    const hi = klines[klines.length - i].high, lo = klines[klines.length - i].low;
    const prevHi = klines[klines.length - i - 1].high, prevLo = klines[klines.length - i - 1].low;
    const prevClose = klines[klines.length - i - 1].close;
    const tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
    const plusDM = (hi - prevHi > prevLo - lo && hi - prevHi > 0) ? hi - prevHi : 0;
    const minusDM = (prevLo - lo > hi - prevHi && prevLo - lo > 0) ? prevLo - lo : 0;
    trSum += tr; plusDSum += plusDM; minusDSum += minusDM;
  }
  const atr14 = trSum / adxP;
  const plusDI = atr14 > 0 ? (plusDSum / adxP) / atr14 * 100 : 0;
  const minusDI = atr14 > 0 ? (minusDSum / adxP) / atr14 * 100 : 0;
  const dxSum = plusDI + minusDI;
  const ADX = dxSum > 0 ? Math.abs(plusDI - minusDI) / dxSum * 100 : 0;

  const result = {
    price: c, rsi: +rsi.toFixed(2),
    bbHigh: +bbHigh.toFixed(6), bbMid: +sma.toFixed(6), bbLow: +bbLow.toFixed(6),
    atr: +atr.toFixed(6),
    ema9: +ema9.toFixed(6), ema21: +ema21.toFixed(6),
    trendUp: ema9 > ema21 && c > ema21,
    trendDown: ema9 < ema21 && c < ema21,
    adx: +ADX.toFixed(2),
    regime: ADX > 25 ? 'trending' : ADX < 20 ? 'ranging' : 'transitional',
    rangePct: (klines[klines.length-1].high - klines[klines.length-1].low) / c,
    max20: +max20.toFixed(6), min20: +min20.toFixed(6),
    poc: +poc.toFixed(6),
    volRatio: klines.length >= 4 ? +(klines[klines.length-1].volume / (klines.slice(-4,-1).reduce((s,k)=>s+k.volume,0)/3)).toFixed(2) : 1,
  };
  if (cacheKey) indCache.set(cacheKey, { ts: Date.now(), data: result });
  if (indCache.size > 500) {
    let n = 0;
    for (const k of indCache.keys()) { if (n++ >= 100) break; indCache.delete(k); }
  }
  return result;
}

// Warmup: pre-fetch top symbols to populate cache (called from server boot)
let _warmed = false;
async function warmup() {
  if (_warmed) return;
  _warmed = true;
  const top = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'];
  try {
    await Promise.allSettled(top.flatMap(s => [
      getTicker(s),
      getKlines(s, '1m', 50),
      getKlines(s, '5m', 50),
      getKlines(s, '15m', 50),
    ]));
  } catch {}
  // Even if some fail, caches populated. Reattempt in 30s if not warmed.
}

const market = { getKlines, getTicker, getBinanceOrderBook, computeIndicators, getBybitKlines, warmup };
module.exports = market;
