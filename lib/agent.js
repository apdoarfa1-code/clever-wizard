'use strict';
/*
 * agent.js — حلقة العقل: جمع البيانات → تحليل → قرار → تنفيذ → إشعار
 * بدون مكتبات خارجية.
 */
const config = require('./config');
const store = require('./store');
const ai = require('./ai');
const market = require('./market');
const { getBroker } = require('./brokers');
const risk = require('./risk');
const telegram = require('./telegram');

let _running = false;
let _intervalId = null;

async function runOnce(symbolOverride) {
  if (_running) return { status: 'already_running' };
  _running = true;
  const startTime = Date.now();
  store.setAgentState({ running: true, lastRun: new Date().toISOString() });

  try {
    const symbols = symbolOverride ? [symbolOverride] : config.getList('WATCH_SYMBOLS', ['BTCUSDT']);
    const tf = config.get('AGENT_TIMEFRAME', '15m');
    const results = [];

    for (const symbol of symbols) {
      try {
        // 1) بيانات السوق
        const klines = await market.getKlines(symbol, tf, 50);
        const indicators = market.computeIndicators(klines);
        const ticker = await market.getTicker(symbol);
        market._lastPrice = market._lastPrice || {};
        market._lastPrice[symbol] = ticker.price;

        // 2) بيانات الحساب
        const broker = getBroker();
        const account = await broker.getAccountInfo();
        const positions = await broker.getPositions();

        // 3) التحليل
        const context = {
          symbol, account, positions, timeframe: tf,
          riskParams: risk.getRiskParams(),
          mode: config.get('TRADING_MODE', 'paper'),
          timestamp: new Date().toISOString(),
        };
        const decision = await ai.analyze(indicators, context);

        // 4) تحقق المخاطر
        const validation = risk.validateDecision(decision);
        if (!validation.valid) {
          store.addLog({ type: 'agent', level: 'warn', msg: `قرار مرفوض لـ ${symbol}: ${validation.errors.join(', ')}` });
          results.push({ symbol, decision, executed: false, reason: validation.errors });
          continue;
        }

        // 5) تنفيذ (لو مش HOLD)
        let executed = false;
        let trade = null;
        if (decision.action === 'BUY' || decision.action === 'SELL') {
          const check = risk.checkBeforeTrade(symbol, decision.action, ticker.price);
          if (!check.ok) {
            store.addLog({ type: 'agent', level: 'warn', msg: `مخاطر: ${check.errors.join(', ')}` });
            results.push({ symbol, decision, executed: false, reason: check.errors });
            // إشعار تنبيه
            if (check.errors.length) await telegram.notifyAlert(`⚠️ ${symbol}: ${check.errors.join(', ')}`);
            continue;
          }
          if (check.warnings.length) {
            store.addLog({ type: 'agent', level: 'warn', msg: `تحذيرات: ${check.warnings.join(', ')}` });
          }

          const posCalc = risk.calculatePositionSize(ticker.price, account.balance);
          const side = decision.action === 'BUY' ? 'BUY' : 'SELL';
          trade = await broker.placeOrder(symbol, side, 'MARKET', decision.qty || posCalc.qty, null, {
            stopLoss: decision.sl,
            takeProfit: decision.tp,
          });
          executed = true;
          store.addLog({ type: 'agent', level: 'info', msg: `✅ تنفيذ ${decision.action} ${symbol} qty=${posCalc.qty}` });
          await telegram.notifyTrade({ symbol, side: decision.action, price: ticker.price, qty: posCalc.qty, status: 'open' });
        }

        if (decision.action === 'CLOSE') {
          try {
            await broker.closePosition(symbol);
            executed = true;
            store.addLog({ type: 'agent', level: 'info', msg: `✅ إغلاق ${symbol}` });
            await telegram.notifyTrade({ symbol, side: 'CLOSE', price: ticker.price, status: 'closed' });
          } catch (e) {
            store.addLog({ type: 'agent', level: 'error', msg: `فشل إغلاق ${symbol}: ${e.message}` });
          }
        }

        results.push({ symbol, decision, executed, trade });
      } catch (e) {
        store.addLog({ type: 'agent', level: 'error', msg: `خطأ ${symbol}: ${e.message}` });
        results.push({ symbol, error: e.message });
      }
    }

    const elapsed = Date.now() - startTime;
    store.setAgentState({ running: false });
    store.addLog({ type: 'agent', level: 'info', msg: `🏁 دورة اكتملت (${elapsed}ms) — ${symbols.length} أزواج` });
    return { status: 'done', elapsed, results };
  } catch (e) {
    store.setAgentState({ running: false });
    store.addLog({ type: 'agent', level: 'error', msg: `خطأ حلقة العقل: ${e.message}` });
    return { status: 'error', error: e.message };
  } finally {
    _running = false;
  }
}

function startLoop(intervalMs) {
  stopLoop();
  const ms = intervalMs || 60000; // دقيقة افتراضياً
  store.setAgentState({ running: true });
  _intervalId = setInterval(async () => {
    if (config.getBool('AGENT_AUTORUN', false)) {
      try { await runOnce(); }
      catch (e) { console.error('[agent] loop error:', e.message); }
    }
  }, ms);
  store.addLog({ type: 'agent', level: 'info', msg: `🔄 حلقة العقل بدأت (كل ${ms / 1000} ثانية)` });
}

function stopLoop() {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  store.setAgentState({ running: false });
  store.addLog({ type: 'agent', level: 'info', msg: '⏹ حلقة العقل توقفت' });
}

function getStatus() {
  return {
    running: _running || config.getBool('AGENT_AUTORUN', false),
    intervalId: _intervalId ? true : false,
    autorun: config.getBool('AGENT_AUTORUN', false),
    state: store.getAgentState(),
    config: {
      broker: config.get('DEFAULT_BROKER'),
      mode: config.get('TRADING_MODE'),
      symbols: config.getList('WATCH_SYMBOLS'),
      timeframe: config.get('AGENT_TIMEFRAME'),
      aiProvider: config.get('AI_PROVIDER'),
      aiModel: config.get('AI_MODEL'),
    },
  };
}

module.exports = { runOnce, startLoop, stopLoop, getStatus };
