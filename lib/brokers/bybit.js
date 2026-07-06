'use strict';
/*
 * brokers/bybit.js — Bybit V5 API (REST موقّع HMAC)
 * يدعم testnet + mainnet بدون مكتبات خارجية.
 */
const httpLib = require('../http');
const crypto = require('../crypto');
const config = require('../config');

function getBaseUrl() {
  const testnet = config.getBool('BYBIT_TESTNET', false);
  return testnet ? 'https://testnet.bybit.com' : 'https://api.bybit.com';
}

function getAuthHeaders(timestamp, sign) {
  return {
    'X-BAPI-API-KEY': config.get('BYBIT_API_KEY', ''),
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-SIGN': sign,
    'X-BAPI-RECV-WINDOW': '5000',
    'Content-Type': 'application/json',
  };
}

async function signedGet(path, params = {}) {
  const apiKey = config.get('BYBIT_API_KEY', '');
  const secret = config.get('BYBIT_API_SECRET', '');
  if (!apiKey || !secret) throw new Error('BYBIT_API_KEY أو BYBIT_API_SECRET غير مضبوط');

  const timestamp = crypto.getTimestamp() * 1000;
  const paramStr = crypto.queryString(params);
  const sign = crypto.signBybit(params, timestamp, apiKey, secret);
  const url = `${getBaseUrl()}${path}${paramStr ? '?' + paramStr : ''}`;
  return httpLib.request(url, { method: 'GET', headers: getAuthHeaders(String(timestamp), sign) });
}

async function signedPost(path, body = {}) {
  const apiKey = config.get('BYBIT_API_KEY', '');
  const secret = config.get('BYBIT_API_SECRET', '');
  if (!apiKey || !secret) throw new Error('BYBIT_API_KEY أو BYBIT_API_SECRET غير مضبوط');

  const timestamp = crypto.getTimestamp() * 1000;
  const sign = crypto.signBybit(body, timestamp, apiKey, secret);
  const url = `${getBaseUrl()}${path}`;
  return httpLib.post(url, body, getAuthHeaders(String(timestamp), sign));
}

async function getAccountInfo() {
  const res = await signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  if (!res.ok) throw new Error(`Bybit account error: ${res.json?.retMsg || res.raw}`);
  const list = res.json?.result?.list || [];
  const usdt = list.find(a => a.coin === 'USDT');
  return {
    balance: +(usdt?.walletBalance || 0),
    availableBalance: +(usdt?.availableToWithdraw || usdt?.free || 0),
    unrealizedProfit: +(usdt?.unrealisedPnl || 0),
    marginLevel: null,
    currency: 'USDT',
  };
}

async function getPositions() {
  const res = await signedGet('/v5/position/list', { category: 'linear' });
  if (!res.ok) throw new Error(`Bybit positions error: ${res.json?.retMsg || res.raw}`);
  return (res.json?.result?.list || [])
    .filter(p => +p.size !== 0)
    .map(p => ({
      symbol: p.symbol,
      side: p.side === 'Buy' ? 'long' : 'short',
      size: +p.size,
      entryPrice: +p.avgPrice,
      markPrice: +p.markPrice,
      pnl: +p.unrealisedPnl,
      leverage: +p.leverage,
    }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const orderBody = {
    category: 'linear',
    symbol,
    side: side === 'BUY' ? 'Buy' : 'Sell',
    orderType: type,
    qty: String(qty),
  };
  if (price && (type === 'LIMIT')) orderBody.price = String(price);
  if (params.stopLoss) orderBody.stopLoss = String(params.stopLoss);
  if (params.takeProfit) orderBody.takeProfit = String(params.takeProfit);

  const res = await signedPost('/v5/order/create', orderBody);
  if (!res.ok || res.json?.retCode !== 0) throw new Error(`Bybit order error: ${res.json?.retMsg || res.raw}`);
  return res.json.result;
}

async function cancelOrder(symbol, orderId) {
  const res = await signedPost('/v5/order/cancel', { category: 'linear', symbol, orderId });
  if (!res.ok || res.json?.retCode !== 0) throw new Error(`Bybit cancel error: ${res.json?.retMsg || res.raw}`);
  return res.json.result;
}

async function closePosition(symbol) {
  const positions = await getPositions();
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) throw new Error(`لا توجد صفقة مفتوحة على ${symbol}`);
  return placeOrder(symbol, pos.side === 'long' ? 'SELL' : 'BUY', 'MARKET', pos.size);
}

async function getKlines(symbol, interval = '15', limit = 100) {
  const intervalMap = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
  const iv = intervalMap[interval] || '15';
  const url = `${getBaseUrl()}/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${limit}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Bybit klines error: ${res.status}`);
  return (res.json?.result?.list || []).reverse().map(k => ({
    time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: +k[6],
  }));
}

async function getTicker(symbol) {
  const url = `${getBaseUrl()}/v5/market/tickers?category=linear&symbol=${symbol}`;
  const res = await httpLib.get(url);
  if (!res.ok) throw new Error(`Bybit ticker error: ${res.status}`);
  const t = res.json?.result?.list?.[0];
  if (!t) throw new Error(`Bybit: no ticker for ${symbol}`);
  return {
    symbol: t.symbol, price: +t.lastPrice, change: +t.price24hPcnt * 100,
    high: +t.highPrice24h, low: +t.lowPrice24h, volume: +t.volume24h,
  };
}

async function testConnection() {
  try {
    const apiKey = config.get('BYBIT_API_KEY', '');
    const secret = config.get('BYBIT_API_SECRET', '');
    if (!apiKey || !secret) return { ok: false, error: 'مفاتيح Bybit غير مضبوطة' };
    const res = await signedGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    return { ok: res.ok && res.json?.retCode === 0, error: res.ok ? null : (res.json?.retMsg || res.raw) };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
