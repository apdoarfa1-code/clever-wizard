'use strict';
const httpLib = require('../http');
const config = require('../config');
const crypto = require('crypto');

function getBaseUrl() { return config.getBool('GEMINI_SANDBOX', false) ? 'https://api.sandbox.gemini.com' : 'https://api.gemini.com'; }

function mapSymbol(sym) {
  sym = sym.toUpperCase().replace('USDT','USD');
  return sym;
}

function sign(payload) {
  const key = config.get('GEMINI_API_KEY', '');
  const secret = config.get('GEMINI_API_SECRET', '');
  if (!key || !secret) throw new Error('GEMINI_API_KEY أو GEMINI_API_SECRET غير مضبوط');
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha384', Buffer.from(secret, 'base64')).update(b64).digest('hex');
  return { 'X-GEMINI-APIKEY': key, 'X-GEMINI-PAYLOAD': b64, 'X-GEMINI-SIGNATURE': sig, 'Content-Type': 'text/plain' };
}

async function signedRequest(path, payload = {}) {
  const body = { ...payload, request: path, nonce: Date.now() * 1000 };
  const h = sign(body);
  return httpLib.request(`${getBaseUrl()}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
}

async function getAccountInfo() {
  const res = await signedRequest('/v1/balances');
  if (!res.ok) throw new Error(`Gemini: ${res.raw}`);
  const usd = (res.json || []).find(b => b.currency === 'USD') || {};
  return { balance: +(usd.available || 0), availableBalance: +(usd.available || 0), unrealizedProfit: 0, currency: 'USD' };
}

async function getPositions() {
  const res = await signedRequest('/v1/open_orders');
  if (!res.ok) return [];
  return (res.json || []).map(o => ({
    symbol: o.symbol, side: o.side === 'buy' ? 'long' : 'short',
    size: +o.original_amount, entryPrice: +o.price, markPrice: +o.price, pnl: 0,
  }));
}

async function placeOrder(symbol, side, type = 'market', qty, price, params = {}) {
  const body = { symbol: mapSymbol(symbol), amount: String(qty), side: (side||'buy').toLowerCase(), type: type.toLowerCase() };
  if (price && body.type === 'exchange limit') body.price = String(price);
  if (params.stopLoss) body.type = 'exchange stop limit';
  const res = await signedRequest('/v1/order/new', body);
  if (!res.ok) throw new Error(`Gemini order: ${res.json?.message || res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await signedRequest('/v1/order/cancel', { order_id: orderId });
  if (!res.ok) throw new Error(`Gemini cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const positions = await getPositions();
  if (!positions.length) throw new Error(`لا توجد صفقة على ${symbol}`);
  const pos = positions.find(p => p.symbol === mapSymbol(symbol)) || positions[0];
  return placeOrder(symbol, pos.side === 'long' ? 'sell' : 'buy', 'market', pos.size);
}

const tfMap = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1day' };

async function getKlines(symbol, interval = '15m', limit = 100) {
  const res = await httpLib.get(`${getBaseUrl()}/v2/candles/${mapSymbol(symbol)}/${tfMap[interval] || '15m'}?limit=${limit}`);
  if (!res.ok) throw new Error(`Gemini OHLC: ${res.status}`);
  return (res.json || []).map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: 0 }));
}

async function getTicker(symbol) {
  const sym = mapSymbol(symbol);
  const res = await httpLib.get(`${getBaseUrl()}/v2/ticker/${sym}`);
  if (!res.ok) throw new Error(`Gemini ticker: ${res.status}`);
  const t = res.json || {};
  return { symbol: sym, price: +(t.last || t.bid || 0), change: 0, high: +(t.high || 0), low: +(t.low || 0), volume: +(t.volume?.base || 0) };
}

async function testConnection() {
  try {
    if (!config.get('GEMINI_API_KEY','') || !config.get('GEMINI_API_SECRET','')) return { ok:false, error: 'مفاتيح Gemini غير مضبوطة' };
    const r = await signedRequest('/v1/balances');
    return { ok: r.ok, error: r.ok ? null : r.raw };
  } catch (e) { return { ok:false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl, mapSymbol };
