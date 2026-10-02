'use strict';
// Tradovate — US Futures & Options broker (tradovate.com REST)
const httpLib = require('../http');
const config = require('../config');

function getBaseUrl() { return config.getBool('TRADOVATE_DEMO', true) ? 'https://demo.tradovate.com/v1' : 'https://live.tradovate.com/v1'; }
function getWsBaseUrl() { return config.getBool('TRADOVATE_DEMO', true) ? 'wss://demo.tradovate.com/v1/websocket' : 'wss://live.tradovate.com/v1/websocket'; }

let token = null, tokenExp = 0;

async function auth() {
  if (token && tokenExp > Date.now()) return token;
  const u = config.get('TRADOVATE_USERNAME','');
  const p = config.get('TRADOVATE_PASSWORD','');
  if (!u || !p) throw new Error('TRADOVATE_USERNAME أو TRADOVATE_PASSWORD غير مضبوط');
  const res = await httpLib.request(`${getBaseUrl()}/auth/accesstoken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: u, password: p, appId: 'ai-trading-agent', appVersion: '1.0' })
  });
  if (!res.ok) throw new Error(`Tradovate auth: ${res.raw}`);
  token = res.json.accessToken;
  tokenExp = Date.now() + (res.json.expirationTime || 3600) * 1000;
  return token;
}

function h() { return { 'Authorization': `Bearer ${token || ''}`, 'Content-Type': 'application/json' }; }

async function getAccountInfo() {
  await auth();
  const res = await httpLib.get(`${getBaseUrl()}/account/list`, { ...h(), headers: h() });
  if (!res.ok) throw new Error(`Tradovate: ${res.raw}`);
  const a = (res.json || [])[0] || {};
  return { balance: +(a.cash || a.balance), availableBalance: +(a.cash || a.balance), unrealizedProfit: 0, currency: 'USD' };
}

async function getPositions() {
  await auth();
  const res = await httpLib.get(`${getBaseUrl()}/position/list`, h());
  if (!res.ok) return [];
  return (res.json || []).filter(p => p.netPos !== 0).map(p => ({
    symbol: p.contractId, side: p.netPos > 0 ? 'long' : 'short',
    size: Math.abs(p.netPos), entryPrice: p.avgEntryPrice, markPrice: 0, pnl: p.unrealizedPl,
  }));
}

async function placeOrder(symbol, side, type = 'Market', qty, price, params = {}) {
  await auth();
  const body = {
    accountSpec: config.get('TRADOVATE_ACCOUNT_SPEC', ''),
    action: side === 'BUY' ? 'Buy' : 'Sell',
    orderType: type, qty: +qty,
    ...(type === 'Limit' && price ? { limitPrice: +price } : {}),
    ...(params.stopLoss ? { stopPrice: +params.stopLoss } : {}),
  };
  const res = await httpLib.request(`${getBaseUrl()}/order/placeorder`, { method: 'POST', headers: h(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Tradovate order: ${res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await httpLib.request(`${getBaseUrl()}/order/cancelorder`, { method: 'POST', headers: h(), body: JSON.stringify({ orderId }) });
  if (!res.ok) throw new Error(`Tradovate cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const p = (await getPositions()).find(p => p.symbol.includes(symbol));
  if (!p) throw new Error(`لا توجد صفقة على ${symbol}`);
  return placeOrder(symbol, p.side === 'long' ? 'Sell' : 'Buy', 'Market', p.size);
}

async function getKlines() { throw new Error('Tradovate requires subscription-based historical quotes via WebSockets — استخدم MARKET_DATA_SOURCE=binance'); }

async function getTicker(symbol) {
  // Spot prices are not Tradovate's forte — return symbol
  return { symbol, price: 0, change: 0, high: 0, low: 0, volume: 0 };
}

async function testConnection() {
  try {
    if (!config.get('TRADOVATE_USERNAME','') || !config.get('TRADOVATE_PASSWORD','')) return { ok:false, error: 'مفاتيح Tradovate غير مضبوطة' };
    await auth();
    return { ok: !!token, error: null };
  } catch (e) { return { ok:false, error: e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
