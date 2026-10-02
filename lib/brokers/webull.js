'use strict';
// Webull — unofficial scraping/reverse-engineered API (webull.com)
// No official API. Requires access_token from trade.webullfq.com.
const httpLib = require('../http');
const config = require('../config');

function getBaseUrl() { return 'https://userapi.webull.com'; }
function getTradeUrl() { return 'https://trade.webullfq.com'; }

function h() {
  const tk = config.get('WEBULL_TOKEN','');
  if (!tk) throw new Error('WEBULL_TOKEN غير مضبوط — Token غير رسمي من webullfq.com');
  const did = config.get('WEBULL_DEVICE_ID','webull-' + Math.random().toString(36).slice(2,10));
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tk}`, 'did': did, 'app': 'global' };
}

async function getAccountInfo() {
  const res = await httpLib.get(`${getBaseUrl()}/api/account/v2/SecuritiesAccount/getAccountList`, h());
  if (!res.ok) throw new Error(`Webull: ${res.raw}`);
  const a = (res.json?.data || []).find(x => x.currency === 'USD') || res.json?.data?.[0] || {};
  return { balance: +(a.totalMarketValue || 0), availableBalance: +(a.accountBalance || 0), unrealizedProfit: 0, currency: 'USD' };
}

async function getPositions() {
  const res = await httpLib.get(`${getTradeUrl()}/api/trading/v1/option/positions?secType=STK`, h());
  if (!res.ok) return [];
  return (res.json?.data || []).map(p => ({
    symbol: p.symbol, side: p.position > 0 ? 'long' : 'short',
    size: Math.abs(+p.position), entryPrice: +p.avgCost, markPrice: +p.lastPrice, pnl: +p.unrealizedPnl,
  }));
}

async function placeOrder(symbol, side, type = 'MKT', qty, price, params = {}) {
  const body = {
    action: side.toLowerCase(), orderType: type, quantity: +qty,
    ticker: symbol, duration: 'DAY', ...(price ? { price: +price } : {}),
  };
  const res = await httpLib.request(`${getTradeUrl()}/api/trading/v1/option/placeOrder`, { method:'POST', headers:h(), body:JSON.stringify(body) });
  if (!res.ok) throw new Error(`Webull order: ${res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await httpLib.request(`${getTradeUrl()}/api/trading/v1/option/cancelOrder/${orderId}`, { method:'DELETE', headers:h() });
  if (!res.ok) throw new Error(`Webull cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const p = (await getPositions()).find(p => p.symbol.includes(symbol));
  if (!p) throw new Error(`لا توجد صفقة على ${symbol}`);
  return placeOrder(symbol, p.side === 'long' ? 'SELL' : 'BUY', 'MKT', p.size);
}

async function getKlines() { throw new Error('Webull historical bars unstable — استخدم MARKET_DATA_SOURCE=binance'); }

async function getTicker(symbol) {
  const res = await httpLib.get(`${getBaseUrl()}/api/quote/v1/quote?symbol=${symbol}`, h());
  if (!res.ok) throw new Error(`Webull quote: ${res.raw}`);
  const q = res.json?.data || {};
  return { symbol, price:+q.lastPrice, change:0, high:+q.high, low:+q.low, volume:+q.volume };
}

async function testConnection() {
  try {
    if (!config.get('WEBULL_TOKEN','')) return { ok:false, error:'WEBULL_TOKEN غير مضبوط' };
    const r = await httpLib.get(`${getBaseUrl()}/api/account/v2/SecuritiesAccount/getAccountList`, h());
    return { ok: r.ok, error: r.ok ? null : r.raw };
  } catch (e) { return { ok:false, error:e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
