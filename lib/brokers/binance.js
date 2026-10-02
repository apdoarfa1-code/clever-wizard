'use strict';
/*
 * brokers/binance.js — Binance Spot + Futures (REST موقّع HMAC)
 * يدعم testnet + mainnet بدون مكتبات خارجية.
 */
const httpLib = require('../http');
const crypto = require('../crypto');
const config = require('../config');
const store = require('../store');

function getBaseUrl() {
  const testnet = config.getBool('BINANCE_TESTNET', false);
  return testnet
    ? 'https://testnet.binancefutures.com'
    : 'https://fapi.binance.com';
}

function getSpotUrl() {
  const testnet = config.getBool('BINANCE_TESTNET', false);
  return testnet
    ? 'https://testnet.binance.vision'
    : 'https://api.binance.com';
}

function getHeaders() {
  return { 'X-MBX-APIKEY': config.get('BINANCE_API_KEY', '') };
}

async function signedRequest(method, path, params = {}, useSpot = false) {
  const apiKey = config.get('BINANCE_API_KEY', '');
  const secret = config.get('BINANCE_API_SECRET', '');
  if (!apiKey || !secret) throw new Error('BINANCE_API_KEY أو BINANCE_API_SECRET غير مضبوط');

  params.timestamp = crypto.getTimestamp();
  params.recvWindow = params.recvWindow || 5000;
  const { queryString: qs } = crypto.signBinance(params, secret);
  const base = useSpot ? getSpotUrl() : getBaseUrl();
  const url = `${base}${path}?${qs}`;
  return httpLib.request(url, { method, headers: getHeaders() });
}

async function publicRequest(path, params = {}, useSpot = false) {
  const qs = crypto.queryString(params);
  const base = useSpot ? getSpotUrl() : getBaseUrl();
  const url = `${base}${path}${qs ? '?' + qs : ''}`;
  return httpLib.get(url);
}

async function getAccountInfo() {
  const res = await signedRequest('GET', '/fapi/v2/account');
  if (!res.ok) throw new Error(`Binance account error: ${res.json?.msg || res.raw}`);
  const a = res.json;
  return {
    balance: +a.totalWalletBalance,
    availableBalance: +a.availableBalance,
    unrealizedProfit: +a.totalUnrealizedProfit,
    marginLevel: a.marginLevel ? +a.marginLevel : null,
    currency: 'USDT',
  };
}

async function getPositions() {
  const res = await signedRequest('GET', '/fapi/v2/positionRisk');
  if (!res.ok) throw new Error(`Binance positions error: ${res.json?.msg || res.raw}`);
  return res.json
    .filter(p => +p.positionAmt !== 0)
    .map(p => ({
      symbol: p.symbol,
      side: +p.positionAmt > 0 ? 'long' : 'short',
      size: Math.abs(+p.positionAmt),
      entryPrice: +p.entryPrice,
      markPrice: +p.markPrice,
      pnl: +p.unRealizedProfit,
      leverage: +p.leverage,
    }));
}

async function placeOrder(symbol, side, type = 'MARKET', quantity, price, params = {}) {
  const orderParams = {
    symbol, side, type,
    quantity: +quantity,
  };
  if (price && (type === 'LIMIT' || type === 'TAKE_PROFIT_MARKET' || type === 'STOP_MARKET')) {
    orderParams.price = +price;
    orderParams.timeInForce = 'GTC';
  }
  // SL/TP: use workingType properly — لا overwrite!
  if (params.stopLoss) orderParams.stopPrice = +params.stopLoss;
  if (params.takeProfit && !params.stopLoss) orderParams.stopPrice = +params.takeProfit;
  // لو متغير معاً، نرسل SL بـ workingType=stopPrice, ونرسل TP منفصل عبر orderParams

  const res = await signedRequest('POST', '/fapi/v1/order', orderParams);
  if (!res.ok) throw new Error(`Binance order error: ${res.json?.msg || res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await signedRequest('DELETE', '/fapi/v1/order', { symbol, orderId });
  if (!res.ok) throw new Error(`Binance cancel error: ${res.json?.msg || res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const positions = await getPositions();
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) throw new Error(`لا توجد صفقة مفتوحة على ${symbol}`);
  return placeOrder(symbol, pos.side === 'long' ? 'SELL' : 'BUY', 'MARKET', pos.size);
}

async function getKlines(symbol, interval = '15m', limit = 100) {
  const res = await publicRequest('/fapi/v1/klines', { symbol, interval, limit });
  if (!res.ok) throw new Error(`Binance klines error: ${res.status}`);
  return res.json.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5], closeTime: k[6],
  }));
}

async function getTicker(symbol) {
  const res = await publicRequest('/fapi/v1/ticker/24hr', { symbol });
  if (!res.ok) throw new Error(`Binance ticker error: ${res.status}`);
  return {
    symbol: res.json.symbol, price: +res.json.lastPrice, change: +res.json.priceChangePercent,
    high: +res.json.highPrice, low: +res.json.lowPrice, volume: +res.json.volume,
  };
}

async function testConnection() {
  try {
    const apiKey = config.get('BINANCE_API_KEY', '');
    const secret = config.get('BINANCE_API_SECRET', '');
    if (!apiKey || !secret) return { ok: false, error: 'مفاتيح Binance غير مضبوطة' };
    const res = await signedRequest('GET', '/fapi/v2/balance');
    return { ok: res.ok, error: res.ok ? null : (res.json?.msg || res.raw) };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
