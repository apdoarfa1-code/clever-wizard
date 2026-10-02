'use strict';
const httpLib = require('../http');
const config = require('../config');
const crypto = require('crypto');

function getBaseUrl() { return config.getBool('KRAKEN_USE_FUTURES', false) ? 'https://futures.kraken.com' : 'https://api.kraken.com'; }

function mapSymbol(sym) {
  if (sym.includes('/') || sym.length === 6) return sym.toUpperCase();
  sym = sym.toUpperCase();
  sym = sym.replace('BTC', 'XBT');
  if (sym.endsWith('USDT')) return sym.replace('USDT', 'USD');
  if (sym.endsWith('USD')) return sym;
  return sym + 'USD';
}

function nonce() { return Date.now() * 1000 + Math.floor(Math.random() * 1000); }

function sign(path, postData) {
  const key = config.get('KRAKEN_API_KEY', '');
  const secret = config.get('KRAKEN_API_SECRET', '');
  if (!key || !secret) throw new Error('KRAKEN_API_KEY أو KRAKEN_API_SECRET غير مضبوط');
  const shasum = crypto.createHash('sha256').update(postData.nonce + postData.toString()).digest();
  const buf = Buffer.from(path + shasum.toString('binary'), 'binary');
  const sig = crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(buf).digest('base64');
  return { 'API-Key': key, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' };
}

async function signedRequest(path, params = {}) {
  const body = new URLSearchParams({ nonce: String(nonce()), ...Object.fromEntries(Object.entries(params).map(([k,v]) => [k, String(v)])) }).toString();
  const h = sign(path, body);
  const res = await httpLib.request(`${getBaseUrl()}${path}`, { method: 'POST', headers: h, body });
  return res;
}

async function publicRequest(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return httpLib.get(`${getBaseUrl()}${path}${qs ? '?' + qs : ''}`);
}

async function getAccountInfo() {
  const res = await signedRequest('/0/private/Balance');
  if (!res.ok || res.json?.error?.length) throw new Error(`Kraken: ${res.json?.error?.[0] || res.raw}`);
  const bal = res.json?.result?.ZUSD || res.json?.result?.USDT || 0;
  return { balance: +bal, availableBalance: +bal, unrealizedProfit: 0, currency: 'USD' };
}

async function getPositions() {
  const res = await signedRequest('/0/private/OpenOrders');
  if (!res.ok) return [];
  const orders = res.json?.result?.open || {};
  return Object.values(orders).map(o => ({
    symbol: o.descr.pair, side: o.descr.type === 'buy' ? 'long' : 'short',
    size: +o.vol, entryPrice: +(o.descr.price || 0), markPrice: +(o.descr.price || 0),
    pnl: 0, leverage: 1,
  }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const pair = mapSymbol(symbol);
  const oType = type.toLowerCase() === 'limit' ? 'limit' : 'market';
  const body = { pair, type: (side||'BUY').toLowerCase(), ordertype: oType, volume: String(qty) };
  if (price && oType === 'limit') body.price = String(price);
  if (params.stopLoss) { body.ordertype = 'stop'; body.stopprice = String(params.stopLoss); }
  if (params.takeProfit) { body.ordertype = 'take-profit'; body.price = String(params.takeProfit); }
  const res = await signedRequest('/0/private/AddOrder', body);
  if (!res.ok || res.json?.error?.length) throw new Error(`Kraken order: ${res.json?.error?.[0] || res.raw}`);
  return res.json?.result || null;
}

async function cancelOrder(symbol, orderId) {
  const res = await signedRequest('/0/private/CancelOrder', { txid: orderId });
  if (!res.ok) throw new Error(`Kraken cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const positions = await getPositions();
  if (!positions.length) throw new Error(`لا توجد صفقة على ${symbol}`);
  const pos = positions.find(p => p.symbol === mapSymbol(symbol)) || positions[0];
  return placeOrder(symbol, pos.side === 'long' ? 'SELL' : 'BUY', 'MARKET', pos.size);
}

const intervalMap = { '1m':1, '5m':5, '15m':15, '1h':60, '4h':240, '1d':1440 };

async function getKlines(symbol, interval = '15m', limit = 100) {
  const pair = mapSymbol(symbol);
  const res = await publicRequest('/0/public/OHLC', { pair, interval: intervalMap[interval] || 15 });
  if (!res.ok) throw new Error(`Kraken OHLC: ${res.status}`);
  const arr = (res.json?.result?.[pair] || []).slice(0, limit);
  return arr.map(k => ({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6] }));
}

async function getTicker(symbol) {
  const pair = mapSymbol(symbol);
  const res = await publicRequest('/0/public/Ticker', { pair });
  if (!res.ok) throw new Error(`Kraken ticker: ${res.status}`);
  const t = res.json?.result?.[pair] || {};
  return { symbol: pair, price: +(t.c?.[0] || 0), change: +((t.p?.[0] || 0) - (t.p?.[1] || 0)), high: +(t.h?.[0] || 0), low: +(t.l?.[0] || 0), volume: +(t.v?.[0] || 0) };
}

async function testConnection() {
  try {
    if (!config.get('KRAKEN_API_KEY','') || !config.get('KRAKEN_API_SECRET','')) return { ok:false, error: 'مفاتيح Kraken غير مضبوطة' };
    const r = await signedRequest('/0/private/Balance');
    return { ok: r.ok && !r.json?.error?.length, error: r.json?.error?.[0] || null };
  } catch (e) { return { ok:false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl, mapSymbol };
