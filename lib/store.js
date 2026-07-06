'use strict';
/*
 * store.js — تخزين حالة العامل محلياً (صفقات، قرارات، سجل)
 * بدون مكتبات خارجية — file-based JSON.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MAX_LOG = 500;
const MAX_DECISIONS = 200;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, fallback = []) {
  ensureDir();
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return fallback; }
}

function writeJSON(file, data) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8');
}

const store = {
  // ---- الأرقام / التمارين الافتراضية (paper balance) ----
  _paper: null,
  getPaper() {
    if (this._paper) return this._paper;
    this._paper = readJSON('paper_balance.json', { balance: 10000, currency: 'USDT', startBalance: 10000 });
    return this._paper;
  },
  setPaper(val) {
    this._paper = val;
    writeJSON('paper_balance.json', val);
  },
  resetPaper(startBalance = 10000) {
    const p = { balance: startBalance, currency: 'USDT', startBalance };
    this._paper = p;
    writeJSON('paper_balance.json', p);
    this.setTrades([]);
    this._tradesCache = null;
    return p;
  },

  // ---- الصفقات ----
  _tradesCache: null,
  getTrades() {
    if (this._tradesCache) return this._tradesCache;
    this._tradesCache = readJSON('trades.json', []);
    return this._tradesCache;
  },
  addTrade(trade) {
    const trades = this.getTrades();
    trade.id = trade.id || `T${Date.now()}`;
    trade.createdAt = trade.createdAt || new Date().toISOString();
    trades.unshift(trade);
    if (trades.length > MAX_LOG) trades.length = MAX_LOG;
    this._tradesCache = trades;
    writeJSON('trades.json', trades);
    return trade;
  },
  updateTrade(id, updates) {
    const trades = this.getTrades();
    const i = trades.findIndex(t => t.id === id);
    if (i !== -1) { Object.assign(trades[i], updates, { updatedAt: new Date().toISOString() }); writeJSON('trades.json', trades); }
    return trades;
  },
  setTrades(arr) {
    this._tradesCache = arr;
    writeJSON('trades.json', arr);
  },

  // ---- قرارات العقل ----
  getDecisions() { return readJSON('decisions.json', []); },
  addDecision(dec) {
    const d = this.getDecisions();
    dec.id = dec.id || `D${Date.now()}`;
    dec.createdAt = dec.createdAt || new Date().toISOString();
    d.unshift(dec);
    if (d.length > MAX_DECISIONS) d.length = MAX_DECISIONS;
    writeJSON('decisions.json', d);
    return dec;
  },

  // ---- سجل / logs ----
  getLogs() { return readJSON('logs.json', []); },
  addLog(entry) {
    const l = this.getLogs();
    entry.t = entry.t || Date.now();
    l.unshift(entry);
    if (l.length > MAX_LOG) l.length = MAX_LOG;
    writeJSON('logs.json', l);
    return entry;
  },

  // ---- حالة العامل ----
  _agentState: null,
  getAgentState() {
    if (this._agentState) return this._agentState;
    this._agentState = readJSON('agent_state.json', { running: false, lastRun: null, dailyPnl: 0, dailyPnlDate: null, openCount: 0 });
    return this._agentState;
  },
  setAgentState(obj) {
    this._agentState = { ...this._agentState, ...obj };
    writeJSON('agent_state.json', this._agentState);
  },

  // ---- إحصائيات ----
  getStats() {
    const trades = this.getTrades();
    const closed = trades.filter(t => t.status === 'closed');
    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    return {
      totalTrades: trades.length,
      closedTrades: closed.length,
      openTrades: trades.filter(t => t.status === 'open').length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? +(wins.length / closed.length * 100).toFixed(1) : 0,
      totalPnl: +totalPnl.toFixed(2),
      bestTrade: wins.length ? +Math.max(...wins.map(t => t.pnl || 0)).toFixed(2) : 0,
      worstTrade: losses.length ? +Math.min(...losses.map(t => t.pnl || 0)).toFixed(2) : 0,
    };
  },

  // ---- مسح الكل ----
  clearAll() {
    ensureDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) fs.unlinkSync(path.join(DATA_DIR, f));
    this._paper = null; this._tradesCache = null; this._agentState = null;
  }
};

module.exports = store;
