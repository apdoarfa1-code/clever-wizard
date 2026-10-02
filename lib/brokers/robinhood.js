'use strict';
const httpLib = require('../http');
const config = require('../config');

// Robinhood Crypto — uses rh-api (OAuth bearer). Requires access token from robinhood.com trusted device.
function getBaseUrl() { return 'https://api.robinhood.com'; }

function headers() {
  const tk = config.get('ROBINHOOD_TOKEN', '');
  if (!tk) throw new Error('ROBINHOOD_TOKEN غير مضبوط — احصل عليه من robinhood.com (Bearer access_token)');
  return { 'Authorization': `Bearer ${tk}`, 'Content-Type': 'application/json' };
}

async function authRequest(method, path, body = null) {
  return httpLib.request(`${getBaseUrl()}${path}`, { method, headers: headers(), body: body ? JSON.stringify(body) : null });
}

async function getAccountInfo() {
  const res = await authRequest('GET', '/api/account/with_unused_transfers/');
  if (!res.ok) throw new Error(`Robinhood: ${res.raw}`);
  const a = res.json?.results?.[0] || {};
  return { balance: +(a.uninvested_amount || a.cash_balances?.cash || 0), availableBalance: +(a.uninvested_amount || 0), unrealizedProfit: 0, currency: 'USD' };
}

async function getPositions() {
  const res = await authRequest('GET', '/api/crypto_holdings/');
  if (!res.ok) return [];
  return (res.json?.results || []).map(h => ({
    symbol: h.currency?.code + 'USDT', side: 'long', size: +h.quantity,
    entryPrice: +h.cost_basis?.amount, markPrice: 0, pnl: 0, leverage: 1,
  }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const cur = symbol.replace('USDT','').replace('USD','');
  const body = { currency_pair_id: `${cur}-USD`, side: side.toLowerCase(), type: type.toLowerCase(), quantity: String(qty) };
  if (price && type === 'LIMIT') body.price = String(price);
  const res = await authRequest('POST', '/api/crypto/orders/', body);
  if (!res.ok) throw new Error(`Robinhood order: ${res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await authRequest('DELETE', `/api/crypto/orders/${orderId}/cancel/`);
  if (!res.ok) throw new Error(`Robinhood cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const p = (await getPositions()).find(p => p.symbol.includes(symbol));
  if (!p) throw new Error(`لا توجد صفقة على ${symbol}`);
  return placeOrder(symbol, p.side === 'long' ? 'SELL' : 'BUY', 'MARKET', p.size);
}

async function getKlines() {
  // Robinhood API has no OHLC endpoint — fall back to internal Binance market data
  throw new Error('Robinhood has no OHLC API — استخدم MARKET_DATA_SOURCE=binance');
}

async function getTicker(symbol) {
  const cur = symbol.toUpperCase().replace('USDT','').replace('USD','');
  const res = await httpLib.get(`${getBaseUrl()}/marketdata/forex/quotes/?currencies=${cur}USD`);
  if (!res.ok) throw new Error(`Robinhood ticker: ${res.status}`);
  const q = (res.json?.results || [])[0] || {};
  return { symbol: cur + 'USD', price: +(q.last_trade_price || 0), change: 0, high: +(q.last_trade_price || 0), low: +(q.last_trade_price || 0), volume: 0 };
}

async function testConnection() {
  try {
    if (!config.get('ROBINHOOD_TOKEN','')) return { ok:false, error: 'ROBINHOOD_TOKEN غير مضبوط' };
    const r = await authRequest('GET', '/api/account/with_unused_transfers/');
    return { ok: r.ok, error: r.ok ? null : r.raw };
  } catch (e) { return { ok:false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
