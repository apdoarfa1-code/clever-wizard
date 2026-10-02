'use strict';
const httpLib = require('../http');
const config = require('../config');

function tradingUrl() { return config.getBool('ALPACA_PAPER', true) ? 'https://staging-api.crypto.alpaca.markets' : 'https://api.crypto.alpaca.markets'; }
function dataUrl() { return 'https://data.alpaca.markets'; }

function headers() {
  const key = config.get('ALPACA_API_KEY', '');
  const sec = config.get('ALPACA_API_SECRET', '');
  if (!key || !sec) throw new Error('ALPACA_API_KEY أو ALPACA_API_SECRET غير مضبوط');
  return { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': sec, 'Content-Type': 'application/json' };
}

function mapSymbol(sym) {
  if (sym.includes('/')) return sym.toUpperCase();
  sym = sym.toUpperCase().replace('USDT', '/USD').replace('USD', '/USD');
  if (sym.endsWith('/USD/USD')) sym = sym.replace('/USD/USD', '/USD');
  return sym;
}

async function tradeRequest(method, path, body = null) {
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);
  return httpLib.request(`${tradingUrl()}${path}`, opts);
}

async function dataRequest(path) {
  return httpLib.get(`${dataUrl()}${path}`, headers());
}

async function getAccountInfo() {
  const res = await tradeRequest('GET', '/v1alpha1/account');
  if (!res.ok) throw new Error(`Alpaca account: ${res.raw}`);
  const a = res.json || {};
  return { balance: +(a.equity || a.portfolio_value || 0), availableBalance: +(a.cash || 0), unrealizedProfit: +(a.unrealized_pl || 0), currency: 'USD' };
}

async function getPositions() {
  const res = await tradeRequest('GET', '/v1alpha1/positions/crypto');
  if (!res.ok) return [];
  return (res.json?.positions || []).map(p => ({
    symbol: p.symbol, side: parseFloat(p.qty) > 0 ? 'long' : 'short',
    size: Math.abs(parseFloat(p.qty)), entryPrice: +p.avg_entry_price,
    markPrice: +p.current_price, pnl: +p.unrealized_pl, leverage: 1,
  }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const body = { symbol: mapSymbol(symbol), side, type: type.toLowerCase(), qty: String(qty), time_in_force: 'gtc' };
  if (type === 'LIMIT' && price) { body.limit_price = String(price); body.time_in_force = 'gtc'; }
  if (params.stopLoss) { body.stop_price = String(params.stopLoss); body.type = 'stop'; }
  if (params.takeProfit) { body.limit_price = String(params.takeProfit); body.type = 'stop_limit'; }
  const res = await tradeRequest('POST', '/v1alpha1/orders', body);
  if (!res.ok) throw new Error(`Alpaca order: ${res.json?.message || res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await tradeRequest('DELETE', `/v1alpha1/orders/${orderId}`);
  if (!res.ok) throw new Error(`Alpaca cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const sym = mapSymbol(symbol);
  const res = await tradeRequest('DELETE', `/v1alpha1/positions/${encodeURIComponent(sym)}`);
  if (!res.ok) throw new Error(`Alpaca close: ${res.raw}`);
  return res.json;
}

const tfMap = { '1m':'1Min','5m':'5Min','15m':'15Min','1h':'1Hour','4h':'4Hour' };

async function getKlines(symbol, interval = '15m', limit = 100) {
  const sym = mapSymbol(symbol);
  const path = `/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(sym)}&timeframe=${tfMap[interval] || '15Min'}&limit=${limit}`;
  const res = await dataRequest(path);
  if (!res.ok) throw new Error(`Alpaca bars: ${res.status}`);
  const arr = res.json?.bars?.[sym] || [];
  return arr.map(b => ({ time: b.t ? Date.parse(b.t) : 0, open: +b.o, high: +b.h, low: +b.l, close: +b.c, volume: +b.v, closeTime: b.t }));
}

async function getTicker(symbol) {
  const sym = mapSymbol(symbol);
  const res = await dataRequest(`/v1beta3/crypto/us/latest/orders/events?symbols=${encodeURIComponent(sym)}`);
  if (!res.ok) throw new Error(`Alpaca ticker: ${res.status}`);
  const e = res.json?.events?.[sym] || {};
  const price = +(e.latest_trade?.p || 0);
  return { symbol: sym, price, change: 0, high: price, low: price, volume: 0 };
}

async function testConnection() {
  try {
    if (!config.get('ALPACA_API_KEY','') || !config.get('ALPACA_API_SECRET','')) return { ok:false, error: 'مفاتيح Alpaca غير مضبوطة' };
    const r = await tradeRequest('GET', '/v1alpha1/account');
    return { ok: r.ok, error: r.ok ? null : r.raw };
  } catch (e) { return { ok:false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, tradingUrl, mapSymbol };
