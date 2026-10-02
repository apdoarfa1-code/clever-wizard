'use strict';
/*
 * brokers/paper.js — محاكي تداول وهمي (Paper Trading) — لا يحتاج أي مفتاح
 * كل الصفقات وهمية، الرصيد محلي في store.js.
 */
const config = require('../config');
const store = require('../store');
const market = require('../market');

async function getAccountInfo() {
  const p = store.getPaper();
  const openTrades = store.getTrades().filter(t => t.status === 'open');
  const unrealized = openTrades.reduce((s, t) => {
    try {
      const chg = t.side === 'long' ? (market._lastPrice?.[t.symbol] || t.price) - t.price
                                  : t.price - (market._lastPrice?.[t.symbol] || t.price);
      return s + chg * t.qty;
    } catch { return s; }
  }, 0);
  return {
    balance: p.balance,
    availableBalance: p.balance,
    unrealizedProfit: unrealized,
    marginLevel: null,
    currency: p.currency || 'USDT',
  };
}

async function getPositions() {
  const trades = store.getTrades().filter(t => t.status === 'open');
  return trades.map(t => {
    const cur = market._lastPrice?.[t.symbol] || t.price;
    const pnl = t.side === 'long' ? (cur - t.price) * t.qty : (t.price - cur) * t.qty;
    return { symbol: t.symbol, side: t.side, size: t.qty, entryPrice: t.price, markPrice: cur, pnl, leverage: 1 };
  });
}

async function placeOrder(symbol, side, type = 'MARKET', qty, price, params = {}) {
  if (!symbol || !qty) throw new Error('symbol و qty مطلوبين');
  const ticker = await market.getTicker(symbol);
  const execPrice = price || ticker.price;
  const trade = {
    id: `T${Date.now()}`,
    symbol,
    side: side.toLowerCase() === 'buy' ? 'long' : 'short',
    action: side.toUpperCase(),
    price: execPrice,
    qty: +qty,
    sl: params.stopLoss || null,
    tp: params.takeProfit || null,
    status: 'open',
    createdAt: new Date().toISOString(),
    broker: 'paper',
  };
  store.addTrade(trade);
  const p = store.getPaper();
  const cost = execPrice * qty;
  if (p.balance < cost) throw new Error(`رصيد غير كافي (مطلوب: ${cost.toFixed(2)}, متاح: ${p.balance.toFixed(2)})`);
  // PnL-correct: deduct full cost (no artificial 10% margin)
  store.setPaper({ ...p, balance: p.balance - cost });
  store.addLog({ type: 'paper_trade', level: 'info', msg: `فتح ${trade.side} ${symbol} @ ${execPrice} qty=${qty}` });
  return trade;
}

async function closePosition(symbol) {
  const trades = store.getTrades().filter(t => t.status === 'open' && t.symbol === symbol);
  if (!trades.length) throw new Error(`لا توجد صفقة مفتوحة على ${symbol}`);
  let totalPnl = 0;
  for (const trade of trades) {
    const ticker = await market.getTicker(symbol);
    const cur = ticker.price;
    const pnl = trade.side === 'long' ? (cur - trade.price) * trade.qty : (trade.price - cur) * trade.qty;
    totalPnl += pnl;
    trade.closePrice = cur;
    trade.pnl = pnl;
    trade.status = 'closed';
    trade.closedAt = new Date().toISOString();
    store.updateTrade(trade.id, trade);

    // إرجاع الرصيد (full cost + pnl)
    const p = store.getPaper();
    const cost = trade.price * trade.qty;
    store.setPaper({ ...p, balance: p.balance + cost + pnl });

    try {
      const bus = require('../event-bus');
      bus.tradeClosed({ symbol, pnl, broker: 'paper', trade });
    } catch {}
  }
  store.addLog({ type: 'paper_trade', level: 'info', msg: `إغلاق ${symbol} PnL=${totalPnl.toFixed(2)}` });
  return { symbol, pnl: totalPnl };
}

async function cancelOrder(symbol, orderId) {
  // في Paper Trading لا يوجد أوامر معلّقة — لا شيء
  return { cancelled: true };
}

async function testConnection() {
  return { ok: true, mode: 'paper', balance: store.getPaper().balance };
}

module.exports = { getAccountInfo, getPositions, placeOrder, cancelOrder, closePosition, testConnection };
