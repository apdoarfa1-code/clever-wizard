'use strict';
/*
 * risk.js — إدارة المخاطر (حجم الصفقة، حدود، تحقق قبل التنفيذ)
 */
const config = require('./config');
const store = require('./store');

function getRiskParams() {
  return {
    positionPct: config.getNum('RISK_POSITION_PCT', 0.02),
    dailyLossPct: config.getNum('RISK_DAILY_LOSS_PCT', 0.05),
    maxOpen: config.getNum('RISK_MAX_OPEN_POSITIONS', 5),
    defaultSL: config.getNum('RISK_DEFAULT_SL', 0.01),
    defaultTP: config.getNum('RISK_DEFAULT_TP', 0.02),
  };
}

function calculatePositionSize(price, balance) {
  const rp = getRiskParams();
  const riskAmount = balance * rp.positionPct;
  const qty = price > 0 ? riskAmount / price : 0;
  return { qty: +qty.toFixed(6), riskAmount: +riskAmount.toFixed(2), pct: rp.positionPct };
}

function checkBeforeTrade(symbol, action, price) {
  const rp = getRiskParams();
  const errors = [];
  const warnings = [];

  // عدد الصفقات المفتوحة
  const openTrades = store.getTrades().filter(t => t.status === 'open');
  if (openTrades.length >= rp.maxOpen) errors.push(`عدد الصفقات المفتوحة (${openTrades.length}) وصل الحد الأقصى (${rp.maxOpen})`);

  // الخسارة اليومية
  const state = store.getAgentState();
  const paper = store.getPaper();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyPnlDate === today && state.dailyPnl < 0) {
    const lossPct = Math.abs(state.dailyPnl) / paper.startBalance;
    if (lossPct >= rp.dailyLossPct) errors.push(`الخسارة اليومية (${(lossPct * 100).toFixed(1)}%) وصلت الحد (${rp.dailyLossPct * 100}%) — توقف إجباري`);
    else if (lossPct >= rp.dailyLossPct * 0.7) warnings.push(`تحذير: الخسارة اليومية قريبة من الحد (${(lossPct * 100).toFixed(1)}%)`);
  }

  // هل زوج موجود في القائمة
  const symbols = config.getList('WATCH_SYMBOLS');
  if (symbols.length > 0 && !symbols.includes(symbol)) warnings.push(`الزوج ${symbol} غير موجود في قائمة المتابعة`);

  // هل عنده صفقة مفتوحة نفس الزوج نفس الاتجاه
  const existing = openTrades.find(t => t.symbol === symbol && t.status === 'open');
  if (existing && action === 'BUY') warnings.push(`صفقة مفتوحة على ${symbol} — تأكد قبل إضافة`);

  return { ok: errors.length === 0, errors, warnings };
}

function resetDailyPnl() {
  const state = store.getAgentState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyPnlDate !== today) {
    store.setAgentState({ dailyPnl: 0, dailyPnlDate: today });
  }
}

function updateDailyPnl(pnlChange) {
  resetDailyPnl();
  const state = store.getAgentState();
  store.setAgentState({ dailyPnl: (state.dailyPnl || 0) + pnlChange });
}

function validateDecision(decision) {
  const validActions = ['BUY', 'SELL', 'CLOSE', 'HOLD'];
  const errors = [];

  if (!validActions.includes(decision.action)) errors.push(`إجراء غير معروف: ${decision.action}`);
  if (decision.action !== 'HOLD' && !decision.symbol) errors.push('الزوج مطلوب');
  if (decision.confidence < 0 || decision.confidence > 1) errors.push('مستوى الثقة يجب أن يكون بين 0 و 1');

  const minConf = config.getNum('MIN_CONFIDENCE', 0.6);
  if (decision.action !== 'HOLD' && decision.confidence < minConf) {
    errors.push(`مستوى الثقة (${decision.confidence}) أقل من الحد الأدنى (${minConf}) — تم تحويل القرار لـ HOLD`);
    decision.action = 'HOLD';
  }

  return { valid: errors.length === 0, errors };
}

const risk = { getRiskParams, calculatePositionSize, checkBeforeTrade, resetDailyPnl, updateDailyPnl, validateDecision };
module.exports = risk;
