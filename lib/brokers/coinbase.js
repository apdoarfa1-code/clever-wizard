'use strict';
const httpLib = require('../http');
const config = require('../config');
const crypto = require('crypto');

function getBaseUrl() {
  return config.getBool('COINBASE_SANDBOX', false) ? 'https://api.sandbox.coinbase.com' : 'https://api.coinbase.com';
}

function mapSymbol(sym) {
  if (sym.includes('-')) return sym.toUpperCase();
  sym = sym.toUpperCase().replace('USDT', '-USD').replace('USD', '-USD');
  if (sym.endsWith('-USD-USD')) sym = sym.replace('-USD-USD', '-USD');
  return sym;
}

function sign(req, body = '') {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = config.get('COINBASE_API_KEY', '');
  const secret = config.get('COINBASE_API_SECRET', '');
  if (!key || !secret) throw new Error('COINBASE_API_KEY أو COINBASE_API_SECRET غير مضبوط');
  const payload = ts + req.method + req.path + (body || '');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { 'CB-ACCESS-KEY': key, 'CB-ACCESS-SIGN': sig, 'CB-ACCESS-TIMESTAMP': ts, 'Content-Type': 'application/json' };
}

async function signedRequest(method, path, body = null) {
  const b = body ? JSON.stringify(body) : '';
  const h = sign({ method, path }, b);
  const res = await httpLib.request(`${getBaseUrl()}${path}`, { method, headers: h, body: b });
  return res;
}

async function getAccountInfo() {
  const res = await signedRequest('GET', '/api/v3/brokerage/accounts');
  if (!res.ok) throw new Error(`Coinbase account error: ${res.json?.message || res.raw}`);
  const accs = res.json?.accounts || [];
  const usd = accs.find(a => a.currency?.code === 'USD') || accs[0] || {};
  return {
    balance: +(usd.available_balance?.value || 0),
    availableBalance: +(usd.available_balance?.value || 0),
    unrealizedProfit: 0,
    currency: usd.currency?.code || 'USD',
  };
}

async function getPositions() {
  const res = await signedRequest('GET', '/api/v3/brokerage/orders/historical/batch?order_status=OPEN');
  if (!res.ok) return [];
  return (res.json?.orders || []).map(o => ({
    symbol: o.product_id,
    side: o.side === 'BUY' ? 'long' : 'short',
    size: +o.size || 0,
    entryPrice: +(o.limit_price || o.price || 0),
    markPrice: +(o.limit_price || o.price || 0),
    pnl: 0,
    leverage: 1,
  }));
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  const product_id = mapSymbol(symbol);
  const side2 = (side || 'BUY').toUpperCase();
  const cfg = type === 'LIMIT' && price
    ? { limit_limit_gtc: { base_size: String(qty), limit_price: String(price), post_only: false } }
    : { market_market: { quote_size: String(qty) } };
  const body = {
    client_order_id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    product_id, side: side2, order_configuration: cfg,
  };
  const res = await signedRequest('POST', '/api/v3/brokerage/orders', body);
  if (!res.ok) throw new Error(`Coinbase order error: ${res.json?.error_response?.message || res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await signedRequest('POST', `/api/v3/brokerage/orders/historical/${orderId}/cancel`, {});
  if (!res.ok) throw new Error(`Coinbase cancel error: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const positions = await getPositions();
  const pos = positions.find(p => p.symbol === mapSymbol(symbol) || p.symbol === symbol);
  if (!pos) throw new Error(`لا توجد صفقة مفتوحة على ${symbol}`);
  return placeOrder(symbol, pos.side === 'long' ? 'SELL' : 'BUY', 'MARKET', pos.size);
}

async function getKlines(symbol, interval = '15m', limit = 100) {
  const product_id = mapSymbol(symbol);
  const granMap = { '1m':'ONE_MINUTE','5m':'FIVE_MINUTE','15m':'FIFTEEN_MINUTE','1h':'ONE_HOUR','4h':'SIX_HOUR','1d':'ONE_DAY' };
  const end = Math.floor(Date.now() / 1000);
  const start = end - limit * (interval.endsWith('m') ? 60 : 3600) * parseInt(interval);
  const path = `/api/v3/brokerage/market/products/${product_id}/candles?start=${start}&end=${end}&granularity=${granMap[interval] || 'ONE_MINUTE'}`;
  const res = await httpLib.get(`${getBaseUrl()}${path}`);
  if (!res.ok) throw new Error(`Coinbase candles: ${res.status}`);
  const candles = res.json?.candles || [];
  return candles.map(c => ({ time: +c.start, open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume, closeTime: +c.end }));
}

async function getTicker(symbol) {
  const product_id = mapSymbol(symbol);
  const res = await httpLib.get(`${getBaseUrl()}/api/v3/brokerage/market/products/${product_id}`);
  if (!res.ok) throw new Error(`Coinbase ticker: ${res.status}`);
  const p = res.json || {};
  const price = +(p.price || p.latest_trade_price || 0);
  return {
    symbol: product_id, price,
    change: +((p.price_percentage_change_24h?.slice(0,5)) || 0),
    high: +p.high_24h || price, low: +p.low_24h || price,
    volume: +p.volume_24h || 0,
  };
}

async function testConnection() {
  try {
    const key = config.get('COINBASE_API_KEY', '');
    const secret = config.get('COINBASE_API_SECRET', '');
    if (!key || !secret) return { ok: false, error: 'مفاتيح Coinbase غير مضبوطة' };
    const res = await signedRequest('GET', '/api/v3/brokerage/accounts');
    return { ok: res.ok, error: res.ok ? null : (res.json?.message || res.raw) };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl, mapSymbol };
