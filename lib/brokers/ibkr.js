'use strict';
// Interactive Brokers — via ib-gateway or Client Portal REST gateway (localhost:5000)
// Requires real IB Gateway running. Documentation: ib_insync / TWS API
const httpLib = require('../http');
const config = require('../config');

function getBaseUrl() { return config.get('IBKR_GATEWAY_URL', 'https://localhost:5000'); }
function getClientId() { return config.get('IBKR_CLIENT_ID', 'api-trading-agent'); }

function headers() {
  const t = config.get('IBKR_TOKEN', '');
  return { 'Content-Type': 'application/json', ...(t ? { 'Authorization': `Bearer ${t}` } : {}) };
}

let session = null;

async function initSession() {
  if (session && session.expires > Date.now()) return session.id;
  const res = await httpLib.request(`${getBaseUrl()}/v1/api/iserver/authenticate`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ clientId: getClientId(), compete: true }),
    rejectUnauthorized: false,
  });
  if (!res.ok) throw new Error(`IBKR auth: ${res.raw}`);
  session = { id: getClientId(), expires: Date.now() + 1000 * 60 * 60 };
  return session.id;
}

async function getAccountInfo() {
  await initSession();
  const res = await httpLib.get(`${getBaseUrl()}/v1/api/portfolio/accounts`, { ...headers(), rejectUnauthorized: false });
  if (!res.ok) throw new Error(`IBKR accounts: ${res.raw}`);
  const a = (res.json || [])[0] || {};
  return { balance: +(a.totalCash || a.cash || 0), availableBalance: +(a.totalCash || 0), unrealizedProfit: +(a.unrealized || 0), currency: a.currency || 'USD' };
}

async function getPositions() {
  const res = await httpLib.get(`${getBaseUrl()}/v1/api/portfolio/positions`, { ...headers(), rejectUnauthorized: false });
  if (!res.ok) return [];
  return (res.json || []).map(p => ({
    symbol: (p.symbol || '') + 'USDT', side: p.position > 0 ? 'long' : 'short',
    size: Math.abs(+p.position), entryPrice: +p.avgCost, markPrice: 0, pnl: p.unrealizedPL,
  }));
}

async function placeOrder(symbol, side, type = 'MKT', qty, price, params = {}) {
  await initSession();
  const body = {
    orders: [{
      conid: symbol.replace('USDT','').replace('USD',''),
      side: side.toLowerCase(), quantity: +qty,
      orderType: type === 'MARKET' ? 'MKT' : 'LMT',
      ...(price ? { lmtPrice: +price } : {}),
      ...(params.stopLoss ? { stopPrice: +params.stopLoss } : {}),
    }], coid: `${Date.now()}`,
  };
  const res = await httpLib.request(`${getBaseUrl()}/v1/api/iserver/orders`, { method: 'POST', headers: headers(), body: JSON.stringify(body), rejectUnauthorized: false });
  if (!res.ok) throw new Error(`IBKR order: ${res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await httpLib.request(`${getBaseUrl()}/v1/api/iserver/order/${orderId}?delete=true`, { method: 'DELETE', headers: headers(), rejectUnauthorized: false });
  if (!res.ok) throw new Error(`IBKR cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const p = (await getPositions()).find(p => p.symbol.includes(symbol));
  if (!p) throw new Error(`لا توجد صفقة على ${symbol}`);
  return placeOrder(symbol, p.side === 'long' ? 'SELL' : 'BUY', 'MKT', p.size);
}

async function getKlines() { throw new Error('IBKR requires separate market data frame via /v1/api/iserver/marketdata/history — limit supported'); }

async function getTicker(symbol) {
  const conid = symbol.replace('USDT','').replace('USD','');
  const res = await httpLib.get(`${getBaseUrl()}/v1/api/iserver/marketdata/${conid}/snapshot`, { ...headers(), rejectUnauthorized: false });
  if (!res.ok) throw new Error(`IBKR ticker: ${res.raw}`);
  const s = res.json || [];
  const last = s.find(x => x.field === 31)?.value || 0;
  return { symbol, price: +last, change: 0, high: +last, low: +last, volume: 0 };
}

async function testConnection() {
  try {
    const r = await httpLib.get(`${getBaseUrl()}/v1/api/tickle`, { ...headers(), rejectUnauthorized: false });
    return { ok: r.ok, error: r.ok ? null : 'IBKR Gateway offline — شغّل Client Portal' };
  } catch (e) { return { ok:false, error: 'IBKR Gateway unreachable — ' + e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
