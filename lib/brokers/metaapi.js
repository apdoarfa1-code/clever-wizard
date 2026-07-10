'use strict';
/*
 * brokers/metaapi.js — MetaTrader 5 عبر MetaApi Cloud (REST)
 * يحتاج METAAPI_TOKEN + METAAPI_ACCOUNT_ID.
 */
const httpLib = require('../http');
const config = require('../config');

const META_BASE = 'https://mt-market-data-server-v1.agiliumtrade.agiliumtrade.cloud';
const META_TRADING_BASE = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.cloud';
const META_COPY_BASE = 'https://copyfactory-server-v1.agiliumtrade.agiliumtrade.cloud';

function headers() {
  return { 'auth-token': config.get('METAAPI_TOKEN', ''), 'Content-Type': 'application/json' };
}

function accountId() {
  const id = config.get('METAAPI_ACCOUNT_ID', '');
  if (!id) throw new Error('METAAPI_ACCOUNT_ID غير مضبوط');
  return id;
}

async function getAccountInfo() {
  const res = await httpLib.get(`${META_TRADING_BASE}/users/current/accounts/${accountId()}`, headers());
  if (!res.ok) throw new Error(`MetaApi account error: ${res.json?.message || res.raw}`);
  const a = res.json;
  const mode = config.get('METAAPI_MODE', 'demo');
  return {
    balance: +a.balance,
    availableBalance: +a.balance - +(a.margin || 0),
    unrealizedProfit: +(a.equity || 0) - +(a.balance || 0),
    marginLevel: a.marginLevel || null,
    currency: a.currency || 'USD',
    mode, // حقيقي / تجريبي
    leverage: a.leverage || null,
    server: a.server || null,
    login: a.login || config.get('METAAPI_LOGIN', ''),
  };
}

async function getPositions() {
  const res = await httpLib.get(`${META_BASE}/users/current/accounts/${accountId()}/positions`, headers());
  if (!res.ok) throw new Error(`MetaApi positions error: ${res.json?.message || res.raw}`);
  return (res.json || []).map(p => ({
    symbol: p.symbol, side: p.type === 'BUY' ? 'long' : 'short',
    size: +p.currentVolume, entryPrice: +p.openPrice, markPrice: +p.currentTickValue,
    pnl: +(p.unrealizedProfit || 0), leverage: 0,
  }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const body = { accountId: accountId(), symbol, type: side === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL', volume: qty };
  if (price && type !== 'MARKET') body.price = price;
  if (params.stopLoss) body.stopLoss = params.stopLoss;
  if (params.takeProfit) body.takeProfit = params.takeProfit;
  if (type === 'MARKET') body.type = side === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';

  const res = await httpLib.post(`${META_BASE}/users/current/accounts/${accountId()}/trades`, body, headers());
  if (!res.ok) throw new Error(`MetaApi trade error: ${res.json?.message || res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const body = { accountId: accountId(), symbol, type: 'POSITION_CLOSE_ID' };
  const positions = await getPositions();
  const pos = positions.find(p => p.symbol === symbol);
  if (!pos) throw new Error(`لا توجد صفقة على ${symbol}`);
  body.positionId = pos.id || pos._id;
  const res = await httpLib.post(`${META_BASE}/users/current/accounts/${accountId()}/trades`, body, headers());
  if (!res.ok) throw new Error(`MetaApi close error: ${res.json?.message || res.raw}`);
  return res.json;
}

async function getKlines(symbol, timeframe = '15m', limit = 100) {
  const tfMap = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };
  const tf = tfMap[timeframe] || '15m';
  const now = Date.now();
  const from = new Date(now - limit * 15 * 60 * 1000).toISOString();
  const to = new Date(now).toISOString();
  const res = await httpLib.get(
    `${META_BASE}/users/current/accounts/${accountId()}/history/candles/${symbol}?timeframe=${tf}&from=${from}&to=${to}&limit=${limit}`,
    headers()
  );
  if (!res.ok) throw new Error(`MetaApi candles error: ${res.json?.message || res.raw}`);
  return (res.json || []).map(k => ({
    time: new Date(k.time).getTime(), open: +k.open, high: +k.high, low: +k.low,
    close: +k.close, volume: +(k.volumes?.[0] || 0),
  }));
}

async function getTicker(symbol) {
  const res = await httpLib.get(`${META_BASE}/users/current/accounts/${accountId()}/quotes?symbol=${symbol}`, headers());
  if (!res.ok) throw new Error(`MetaApi ticker error: ${res.json?.message || res.raw}`);
  const q = (res.json || []).slice(-1)[0];
  return { symbol, price: +((q.bid + q.ask) / 2), change: 0, high: 0, low: 0, volume: 0 };
}

async function testConnection() {
  try {
    const token = config.get('METAAPI_TOKEN', '');
    const accId = config.get('METAAPI_ACCOUNT_ID', '');
    if (!token || !accId) return { ok: false, error: 'METAAPI_TOKEN أو METAAPI_ACCOUNT_ID غير مضبوط' };
    const res = await getAccountInfo();
    return { ok: true, balance: res.balance, currency: res.currency, mode: res.mode, leverage: res.leverage, login: res.login, server: res.server };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, closePosition, getKlines, getTicker, testConnection };
