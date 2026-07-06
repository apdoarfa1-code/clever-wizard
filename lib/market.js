'use strict';
/*
 * market.js — بيانات السوق (شموع + أسعار) من Binance العامة (بدون مفتاح)
 * Fallback لـ Yahoo Finance إذا Binance متوقف.
 */
const httpLib = require('./http');
const config = require('./config');

const BINANCE_BASE = 'https://api.binance.com';

async function getBinanceKlines(symbol, interval = '15m', limit = 100) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Binance klines error: ${res.status}`);
  return res.json.map(k => ({
    time: k[0],
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], closeTime: k[6], quoteVolume: +k[7],
    trades: k[8],
  }));
}

async function getBinanceTicker(symbol) {
  const url = `${BINANCE_BASE}/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Binance ticker error: ${res.status}`);
  return {
    symbol: res.json.symbol,
    price: +res.json.lastPrice,
    change: +res.json.priceChangePercent,
    high: +res.json.highPrice,
    low: +res.json.lowPrice,
    volume: +res.json.volume,
    quoteVolume: +res.json.quoteVolume,
    trades: +res.json.count,
  };
}

async function getBinanceOrderBook(symbol, limit = 10) {
  const url = `${BINANCE_BASE}/api/v3/depth?symbol=${symbol}&limit=${limit}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Binance depth error: ${res.status}`);
  return { bids: res.json.bids.map(b => [+b[0], +b[1]]), asks: res.json.asks.map(a => [+a[0], +a[1]]) };
}

// Yahoo Finance fallback (for non-Binance pairs)
async function getYahooKlines(symbol, interval = '15m', limit = 100) {
  const intervals = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
  const yi = intervals[interval] || '15m';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${yi}&range=${Math.ceil(limit * (yi === '1m' ? 1 : yi === '5m' ? 5 : yi === '15m' ? 15 : 60) / 60)}d`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Yahoo error: ${res.status}`);
  const result = res.json.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: no data');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({
    time: t * 1000, open: +(q.open?.[i] || 0), high: +(q.high?.[i] || 0),
    low: +(q.low?.[i] || 0), close: +(q.close?.[i] || 0), volume: +(q.volume?.[i] || 0),
  }));
}

async function getKlines(symbol, interval, limit) {
  interval = interval || config.get('AGENT_TIMEFRAME', '15m');
  limit = limit || 100;
  try { return await getBinanceKlines(symbol, interval, limit); }
  catch (e) {
    try { return await getYahooKlines(symbol, interval, limit); }
    catch (e2) { throw new Error(`لا توجد بيانات سوق لـ ${symbol}: ${e2.message}`); }
  }
}

async function getTicker(symbol) {
  try { return await getBinanceTicker(symbol); }
  catch (e) {
    const klines = await getKlines(symbol, '1m', 1);
    if (klines.length) return { symbol, price: klines[0].close, change: 0, high: klines[0].high, low: klines[0].low, volume: klines[0].volume, quoteVolume: 0, trades: 0 };
    throw e;
  }
}

// حساب مؤشرات بسيطة على الشموع
function computeIndicators(klines) {
  if (!klines || klines.length < 2) return {};
  const closes = klines.map(k => k.close);
  const ema = (arr, period) => {
    const k = 2 / (period + 1);
    let prev = arr[0];
    return arr.slice(1).map(c => { prev = c * k + prev * (1 - k); return prev; });
  };
  const sma = (arr, period) => {
    const out = [];
    for (let i = period - 1; i < arr.length; i++) out.push(arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    return out;
  };
  const rsi = (arr, period = 14) => {
    if (arr.length < period + 1) return [];
    const out = [];
    for (let i = period; i < arr.length; i++) {
      let gains = 0, losses = 0;
      for (let j = i - period; j < i; j++) {
        const d = arr[j + 1] - arr[j];
        if (d > 0) gains += d; else losses -= d;
      }
      const rs = losses === 0 ? 100 : gains / Math.max(losses, 1e-10);
      out.push(100 - 100 / (1 + rs));
    }
    return out;
  };

  const rsiArr = rsi(closes);
  const sma20 = sma(closes, Math.min(20, closes.length));
  const ema9 = ema(closes, Math.min(9, closes.length));
  const last = klines[klines.length - 1];
  return {
    price: last.close,
    sma20: sma20.length ? +sma20[sma20.length - 1].toFixed(2) : null,
    ema9: ema9.length ? +ema9[ema9.length - 1].toFixed(2) : null,
    rsi: rsiArr.length ? +rsiArr[rsiArr.length - 1].toFixed(1) : null,
    volume24h: klines.reduce((s, k) => s + (k.volume || 0), 0),
    high24h: Math.max(...klines.map(k => k.high)),
    low24h: Math.min(...klines.map(k => k.low)),
    change: closes.length >= 2 ? +((closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100).toFixed(2) : 0,
  };
}

const market = { getKlines, getTicker, getBinanceOrderBook, computeIndicators };
module.exports = market;
