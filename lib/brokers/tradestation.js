'use strict';
// TradeStation — REST API v3 (stocks, futures, crypto)
const httpLib = require('../http');
const config = require('../config');

function getBaseUrl() { return config.getBool('TRADESTATION_PAPER', true) ? 'https://sim-api.tradestation.com' : 'https://api.tradestation.com'; }
function getAuthUrl() { return 'https://sim-api.tradestation.com' === getBaseUrl() ? 'https://sim-api.tradestation.com' : 'https://api.tradestation.com'; }

let token = null, exp = 0;

async function auth() {
  if (token && exp > Date.now()) return token;
  const cid = config.get('TRADESTATION_CLIENT_ID','');
  const sec = config.get('TRADESTATION_CLIENT_SECRET','');
  const rfs = config.get('TRADESTATION_REFRESH_TOKEN','');
  if (!cid || !sec || !rfs) throw new Error('TRADESTATION_CLIENT_ID/SECRET/REFRESH_TOKEN غير مضبوطة');
  const form = new URLSearchParams({
    grant_type: 'refresh_token', client_id: cid, client_secret: sec, refresh_token: rfs, scope: 'MarketData Read Trade',
  }).toString();
  const res = await httpLib.request(`${getAuthUrl()}/v3/security/v1/oauth2/token`, { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body: form });
  if (!res.ok) throw new Error(`TradeStation auth: ${res.raw}`);
  token = res.json.access_token;
  exp = Date.now() + ((res.json.expires_in || 1800) - 60) * 1000;
  return token;
}

function h() { return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }; }

async function getAccountInfo() {
  await auth();
  const res = await httpLib.get(`${getBaseUrl()}/v3/brokerage/accounts`, h());
  if (!res.ok) throw new Error(`TradeStation: ${res.raw}`);
  const a = (res.json?.Accounts || [])[0] || {};
  return { balance: +(a.CurrentCash || 0), availableBalance: +(a.CurrentCash || 0), unrealizedProfit: 0, currency: 'USD' };
}

async function getPositions() {
  await auth();
  const res = await httpLib.get(`${getBaseUrl()}/v3/brokerage/accounts/${config.get('TRADESTATION_ACCOUNT_ID','')}/positions`, h());
  if (!res.ok) return [];
  return (res.json?.Positions || []).map(p => ({
    symbol: p.Symbol, side: p.LongShort === 'Long' ? 'long' : 'short',
    size: +p.Quantity, entryPrice: +p.AveragePrice, markPrice: +p.LastPrice, pnl: +p.OutstandingPl,
  }));
}

async function placeOrder(symbol, side, type = 'Market', qty, price, params = {}) {
  await auth();
  const body = {
    AccountID: config.get('TRADESTATION_ACCOUNT_ID',''),
    Symbol: symbol, Quantity: +qty, Side: side,
    OrderType: type, TimeInForce: { Duration: 'GTC' },
    ...(type === 'Limit' && price ? { LimitPrice: +price } : {}),
    ...(params.stopLoss ? { StopPrice: +params.stopLoss } : {}),
  };
  const res = await httpLib.request(`${getBaseUrl()}/v3/orderexecution/orderpreview`, { method:'POST', headers:h(), body:JSON.stringify(body) });
  if (!res.ok) throw new Error(`TradeStation order: ${res.raw}`);
  return res.json;
}

async function cancelOrder(symbol, orderId) {
  const res = await httpLib.request(`${getBaseUrl()}/v3/orderexecution/orders/${orderId}`, { method:'DELETE', headers:h() });
  if (!res.ok) throw new Error(`TradeStation cancel: ${res.raw}`);
  return res.json;
}

async function closePosition(symbol) {
  const p = (await getPositions()).find(p => p.symbol.includes(symbol));
  if (!p) throw new Error(`لا توجد صفقة على ${symbol}`);
  return placeOrder(symbol, p.side === 'long' ? 'Sell' : 'Buy', 'Market', p.size);
}

const tfMap = { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240','1d':'Daily' };

async function getKlines(symbol, interval = '15m', limit = 100) {
  await auth();
  const res = await httpLib.get(`${getBaseUrl()}/v3/marketdata/barcharts/${symbol}?interval=${tfMap[interval] || '15'}&lastPricePerInterval=${limit}`, h());
  if (!res.ok) throw new Error(`TradeStation bars: ${res.raw}`);
  return (res.json?.Bars || []).map(b => ({ time: Date.parse(b.TimeStamp), open:+b.Open, high:+b.High, low:+b.Low, close:+b.Close, volume:+b.TotalVolume, closeTime:0 }));
}

async function getTicker(symbol) {
  await auth();
  const res = await httpLib.get(`${getBaseUrl()}/v3/marketdata/quotes/${symbol}`, h());
  if (!res.ok) throw new Error(`TradeStation quote: ${res.raw}`);
  const q = (res.json?.Quotes || [])[0] || {};
  return { symbol, price:+q.Last, change:0, high:+q.High, low:+q.Low, volume:+q.TotalVolume };
}

async function testConnection() {
  try {
    if (!config.get('TRADESTATION_CLIENT_ID','') || !config.get('TRADESTATION_CLIENT_SECRET','')) return { ok:false, error:'مفاتيح TradeStation غير مضبوطة' };
    await auth();
    return { ok: !!token, error: null };
  } catch (e) { return { ok:false, error:e.message }; }
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, getKlines, getTicker, testConnection, getBaseUrl };
