'use strict';
// OANDA — Forex + CFD (v20 REST API). Convention: real currency pairs.
const httpLib = require('../http');
const config = require('../config');

function getBaseUrl() { return config.getBool('OANDA_PRACTICE', true) ? 'https://api-fxpractice.oanda.com' : 'https://api-fxtrade.oanda.com'; }

function h() {
  const tk = config.get('OANDA_API_KEY','');
  if (!tk) throw new Error('OANDA_API_KEY غير مضبوط');
  return { 'Authorization': `Bearer ${tk}`, 'Content-Type': 'application/json', 'Accept-Datetime-Format': 'RFC3339' };
}

function accountId() { return config.get('OANDA_ACCOUNT_ID','001-001-000001-001'); }

async function getAccountInfo() {
  const res = await httpLib.get(`${getBaseUrl()}/v3/accounts`, h());
  if (!res.ok) throw new Error(`OANDA: ${res.raw}`);
  const acc = (res.json?.accounts || [])[0] || {};
  const detail = await httpLib.get(`${getBaseUrl()}/v3/accounts/${acc.id || accountId()}/summary`, h());
  if (!detail.ok) throw new Error(`OANDA summary: ${detail.raw}`);
  const s = detail.json?.account || {};
  return { balance: +s.balance, availableBalance: +s.balance, unrealizedProfit: +s.unrealizedPL, currency: s.currency || 'USD' };
}

async function getPositions() {
  const res = await httpLib.get(`${getBaseUrl()}/v3/accounts/${accountId()}/openPositions`, h());
  if (!res.ok) return [];
  return (res.json?.positions || []).map(p => ({
    symbol: p.instrument, side: p.long.units > 0 ? 'long' : 'short',
    size: p.long.units > 0 ? +p.long.units : +p.short.units, entryPrice: p.long.units > 0 ? +p.long.averagePrice : +p.short.averagePrice,
    markPrice: +p.price, pnl: +(p.unrealizedPL || 0), leverage: 30,
  }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const units = (side === 'SELL' ? '-' : '') + qty;
  const body = { order: { units, instrument: symbol.replace('USDT','_USD').replace('USD',''), type: type.toLowerCase().slice(0,5).toUpperCase(), timeInForce: 'FOK', positionFill: 'DEFAULT', ...(price ? { price: String(price) } : {}) } };
  const res = await httpLib.request(`${getBaseUrl()}/v3/accounts/${accountId()}/orders`, { method:'POST', headers:h(), body:JSON.stringify(body) });
  if (!res.ok) throw new Error(`OANDA order: ${res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await httpLib.request(`${getBaseUrl()}/v3/accounts/${accountId()}/orders/${orderId}`, { method:'PUT', headers:h(), body:JSON.stringify({ order: { timeInForce: 'FOK', triggerCondition: 'DEFAULT', type: 'MARKET' } }) });
  if (!res.ok) throw new Error(`OANDA cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const inst = symbol.replace('USDT','_USD').replace('USD','');
  const res = await httpLib.request(`${getBaseUrl()}/v3/accounts/${accountId()}/positions/${inst}/close`, { method:'PUT', headers:h(), body: JSON.stringify({ longUnits: 'ALL', shortUnits: 'ALL' }) });
  if (!res.ok) throw new Error(`OANDA close: ${res.raw}`);
  return res.json;
}

const tfMap = { '1m':'M1','5m':'M5','15m':'M15','1h':'H1','4h':'H4','1d':'D' };

async function getKlines(symbol, interval = '15m', limit = 100) {
  const inst = symbol.replace('USDT','_USD').replace('USD','');
  const end = new Date().toISOString();
  const start = new Date(Date.now() - limit * 3600 * 1000).toISOString();
  const res = await httpLib.get(`${getBaseUrl()}/v3/instruments/${inst}/candles?price=M&granularity=${tfMap[interval] || 'M15'}&from=${start}&to=${end}`, h());
  if (!res.ok) throw new Error(`OANDA candles: ${res.raw}`);
  return (res.json?.candles || []).map(c => ({ time: Date.parse(c.time), open:+c.mid.o, high:+c.mid.h, low:+c.mid.l, close:+c.mid.c, volume:+c.volume, closeTime:0 }));
}

async function getTicker(symbol) {
  const inst = symbol.replace('USDT','_USD').replace('USD','');
  const res = await httpLib.get(`${getBaseUrl()}/v3/accounts/${accountId()}/pricing?instruments=${inst}`, h());
  if (!res.ok) throw new Error(`OANDA pricing: ${res.raw}`);
  const p = res.json?.prices?.[0] || {};
  return { symbol: inst, price:+(p.closeoutBid + p.closeoutAsk)/2 || 0, change:0, high:+p.closeoutAsk, low:+p.closeoutBid, volume:0 };
}

async function testConnection() {
  try {
    if (!config.get('OANDA_API_KEY','')) return { ok:false, error:'OANDA_API_KEY غير مضبوط' };
    const r = await httpLib.get(`${getBaseUrl()}/v3/accounts`, h());
    return { ok: r.ok, error: r.ok ? null : r.raw };
  } catch (e) { return { ok:false, error:e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
