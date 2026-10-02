'use strict';
/*
 * store.js v5 — Real SQLite Database Facade
 * ALL trading data persisted in data/trading_system.db via lib/database/sqlite-bridge.js
 * JSON is used ONLY for static configuration (settings.json).
 */
const sqlite = require('./database/sqlite-bridge');
const config = require('./config');

function uuid(prefix) {
  return `${prefix || 'R'}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

const store = {
  // ============ SQLite Direct Access ============
  execSql: sqlite.execSql,
  execTransaction: sqlite.execTransaction,
  integrityCheck: sqlite.integrityCheck,
  createBackup: sqlite.backup,
  isReady: sqlite.isReady,

  // ============ PAPER BALANCE (stored in accounts table) ============
  getPaper() {
    const r = sqlite.execSql('SELECT * FROM accounts WHERE id = ?', ['paper_main']);
    if (r.ok && r.rows.length) {
      const row = r.rows[0];
      return { balance: row.balance, available: row.available, currency: row.currency || 'USDT', startBalance: 10000 };
    }
    // Create default paper account
    sqlite.execSql('INSERT INTO accounts (id, broker_id, account_name, currency, balance, available) VALUES (?, ?, ?, ?, ?, ?)',
      ['paper_main', 'paper', 'Paper Trading', 'USDT', 10000, 10000]);
    return { balance: 10000, currency: 'USDT', startBalance: 10000 };
  },
  setPaper(val) {
    const existing = sqlite.execSql('SELECT id FROM accounts WHERE id = ?', ['paper_main']);
    if (existing.ok && existing.rows.length) {
      sqlite.execSql('UPDATE accounts SET balance = ?, available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [val.balance, val.available || val.balance, 'paper_main']);
    } else {
      sqlite.execSql('INSERT INTO accounts (id, broker_id, account_name, currency, balance, available) VALUES (?, ?, ?, ?, ?, ?)',
        ['paper_main', 'paper', 'Paper Trading', 'USDT', val.balance, val.available || val.balance]);
    }
  },
  resetPaper(startBalance = 10000) {
    sqlite.execSql('UPDATE accounts SET balance = ?, available = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [startBalance, startBalance, 'paper_main']);
    sqlite.execSql('DELETE FROM trades', []);
    return { balance: startBalance, currency: 'USDT', startBalance };
  },

  // ============ TRADES (SQLite trades table) ============
  getTrades() {
    const r = sqlite.execSql('SELECT * FROM trades ORDER BY created_at DESC', []);
    if (!r.ok) return [];
    return r.rows.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      action: t.action,
      price: t.price,
      qty: t.qty,
      closePrice: t.close_price,
      pnl: t.pnl,
      sl: t.sl,
      tp: t.tp,
      status: t.status,
      broker: t.broker,
      closeReason: t.close_reason,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    }));
  },
  addTrade(trade) {
    const id = trade.id || uuid('T');
    sqlite.execSql(
      'INSERT INTO trades (id, symbol, side, action, price, qty, sl, tp, status, broker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, trade.symbol, trade.side, trade.action || (trade.side === 'long' ? 'BUY' : 'SELL'),
       trade.price, trade.qty, trade.sl || null, trade.tp || null, trade.status || 'open', trade.broker || 'paper']
    );
    return { id, ...trade };
  },
  updateTrade(id, updates) {
    const fields = [];
    const params = [];
    if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
    if (updates.pnl !== undefined) { fields.push('pnl = ?'); params.push(updates.pnl); }
    if (updates.closePrice !== undefined) { fields.push('close_price = ?'); params.push(updates.closePrice); }
    if (updates.closeReason !== undefined) { fields.push('close_reason = ?'); params.push(updates.closeReason); }
    if (updates.sl !== undefined) { fields.push('sl = ?'); params.push(updates.sl); }
    if (updates.tp !== undefined) { fields.push('tp = ?'); params.push(updates.tp); }
    fields.push("updated_at = CURRENT_TIMESTAMP");
    params.push(id);
    if (fields.length > 1) {
      sqlite.execSql(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`, params);
    }
    return this.getTrades();
  },
  setTrades(arr) {
    sqlite.execSql('DELETE FROM trades', []);
    for (const t of arr) {
      this.addTrade(t);
    }
  },

  // ============ DECISIONS (SQLite ai_decisions table) ============
  getDecisions() {
    const r = sqlite.execSql('SELECT * FROM ai_decisions ORDER BY created_at DESC', []);
    if (!r.ok) return [];
    return r.rows.map(d => ({
      id: d.id,
      symbol: d.symbol,
      action: d.action,
      side: d.side,
      confidence: d.confidence,
      reasoning: d.reasoning,
      model: d.raw_model,
      provider: d.provider,
      createdAt: d.created_at,
    }));
  },
  addDecision(dec) {
    const id = dec.id || uuid('D');
    sqlite.execSql(
      'INSERT INTO ai_decisions (id, symbol, action, side, confidence, reasoning, raw_model, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, dec.symbol || '', dec.action || 'HOLD', dec.side || 'none',
       dec.confidence || 0, dec.reasoning || '', dec.model || '', dec.provider || '']
    );
    return { id, ...dec };
  },

  // ============ LOGS (SQLite system_events table) ============
  getLogs() {
    const r = sqlite.execSql('SELECT * FROM system_events ORDER BY created_at DESC LIMIT 500', []);
    if (!r.ok) return [];
    return r.rows.map(e => ({
      level: e.level,
      msg: e.message,
      t: new Date(e.created_at).getTime(),
    }));
  },
  addLog(entry) {
    sqlite.execSql(
      'INSERT INTO system_events (level, message, details) VALUES (?, ?, ?)',
      [entry.level || 'info', entry.msg || JSON.stringify(entry), JSON.stringify(entry)]
    );
    // Also add to audit_logs
    sqlite.execSql(
      'INSERT INTO audit_logs (module, action, severity) VALUES (?, ?, ?)',
      ['SYSTEM', entry.msg ? entry.msg.slice(0, 200) : 'log', (entry.level || 'info').toUpperCase()]
    );
    return entry;
  },

  // ============ AGENT STATE (SQLite runtime_state table) ============
  getAgentState() {
    const r = sqlite.execSql('SELECT value FROM runtime_state WHERE key = ?', ['agent_state']);
    if (r.ok && r.rows.length) {
      try { return JSON.parse(r.rows[0].value); } catch { }
    }
    return { running: false, lastRun: null, dailyPnl: 0, openCount: 0, consecutiveLosses: 0, cooldownUntil: 0 };
  },
  setAgentState(obj) {
    const current = this.getAgentState();
    const merged = { ...current, ...obj };
    const existing = sqlite.execSql('SELECT key FROM runtime_state WHERE key = ?', ['agent_state']);
    if (existing.ok && existing.rows.length) {
      sqlite.execSql('UPDATE runtime_state SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
        [JSON.stringify(merged), 'agent_state']);
    } else {
      sqlite.execSql('INSERT INTO runtime_state (key, value) VALUES (?, ?)',
        ['agent_state', JSON.stringify(merged)]);
    }
  },

  // ============ JOURNAL (derived from trades) ============
  getJournal() {
    const r = sqlite.execSql("SELECT * FROM trades WHERE status = 'closed' ORDER BY updated_at DESC", []);
    if (!r.ok) return [];
    return r.rows.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      entryPrice: t.price,
      exitPrice: t.close_price,
      qty: t.qty,
      pnl: t.pnl || 0,
      reason: t.close_reason || 'time',
      enteredAt: t.created_at,
      exitedAt: t.updated_at,
    }));
  },
  getJournalInsights() {
    const j = this.getJournal();
    return { total: j.length, commonMistakes: [], avgPnl: j.length ? +(j.reduce((s, t) => s + t.pnl, 0) / j.length).toFixed(2) : 0 };
  },

  // ============ TRACK LOSS ============
  _trackLoss: function(pnl) {
    const s = this.getAgentState();
    if (pnl < 0) {
      const cl = (s.consecutiveLosses || 0) + 1;
      this.setAgentState({ consecutiveLosses: cl });
      if (cl >= 3) {
        const coolMs = config.getNum('COOLDOWN_MS', 30000);
        this.setAgentState({ cooldownUntil: Date.now() + coolMs });
      }
    } else if (pnl > 0) {
      this.setAgentState({ consecutiveLosses: 0, cooldownUntil: 0 });
    }
  },

  // ============ STATS ============
  getStats() {
    const all = this.getTrades();
    const closed = all.filter(t => t.status === 'closed');
    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    return {
      totalTrades: all.length,
      closedTrades: closed.length,
      openTrades: all.filter(t => t.status === 'open').length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? +(wins.length / closed.length * 100).toFixed(1) : 0,
      totalPnl: +totalPnl.toFixed(2),
      bestTrade: wins.length ? +Math.max(...wins.map(t => t.pnl || 0)).toFixed(2) : 0,
      worstTrade: losses.length ? +Math.min(...losses.map(t => t.pnl || 0)).toFixed(2) : 0,
      consecutiveLosses: this.getAgentState().consecutiveLosses || 0,
    };
  },

  // ============ PERFORMANCE (SQLite performance table) ============
  recordPerf(stage, ms) {
    sqlite.execSql('INSERT INTO performance (stage, latency_ms) VALUES (?, ?)', [stage, ms]);
  },
  getPerf() {
    const r = sqlite.execSql('SELECT stage, AVG(latency_ms) as avg_ms, COUNT(*) as count FROM performance GROUP BY stage', []);
    const mem = process.memoryUsage();
    const perf = {};
    if (r.ok) {
      for (const row of r.rows) {
        perf[row.stage + 'Ms'] = +row.avg_ms.toFixed(1);
      }
    }
    return {
      ...perf,
      samples: r.ok ? r.rows.reduce((s, r) => s + r.count, 0) : 0,
      uptime: Math.floor(process.uptime()),
      rss: Math.round(mem.rss / 1048576),
      heap: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
      cpu: process.cpuUsage(),
    };
  },

  // ============ MIGRATE FROM OLD JSON STORE ============
  migrateFromJsonStore() {
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR = path.resolve(__dirname, '..', 'data');
    let migrated = { trades: 0, logs: 0, agentState: 0 };

    // Migrate trades.json
    try {
      const tradesFile = path.join(DATA_DIR, 'trades.json');
      if (fs.existsSync(tradesFile)) {
        const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
        if (Array.isArray(trades)) {
          for (const t of trades) {
            const id = t.id || uuid('T');
            const existing = sqlite.execSql('SELECT id FROM trades WHERE id = ?', [id]);
            if (existing.ok && existing.rows.length === 0) {
              sqlite.execSql(
                'INSERT INTO trades (id, symbol, side, action, price, qty, close_price, pnl, sl, tp, status, broker, close_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, t.symbol || 'BTCUSDT', t.side || 'long', t.action || 'BUY', t.price || 0, t.qty || 0,
                 t.closePrice || null, t.pnl || null, t.sl || null, t.tp || null, t.status || 'open',
                 t.broker || 'paper', t.closeReason || null]
              );
              migrated.trades++;
            }
          }
        }
      }
    } catch (e) { console.warn('[store] trades.json migration:', e.message); }

    // Migrate logs.json → system_events
    try {
      const logsFile = path.join(DATA_DIR, 'logs.json');
      if (fs.existsSync(logsFile)) {
        const logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
        if (Array.isArray(logs)) {
          for (const l of logs) {
            sqlite.execSql('INSERT INTO system_events (level, message, details) VALUES (?, ?, ?)',
              [l.level || 'info', l.msg || JSON.stringify(l), JSON.stringify(l)]);
            migrated.logs++;
          }
        }
      }
    } catch (e) { console.warn('[store] logs.json migration:', e.message); }

    // Migrate agent_state.json → runtime_state
    try {
      const stateFile = path.join(DATA_DIR, 'agent_state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        sqlite.execSql('INSERT OR REPLACE INTO runtime_state (key, value) VALUES (?, ?)',
          ['agent_state', JSON.stringify(state)]);
        migrated.agentState = 1;
      }
    } catch (e) { console.warn('[store] agent_state.json migration:', e.message); }

    console.log('[store] Migration from JSON → SQLite complete:', migrated);
    return migrated;
  },

  // ============ CLEAR ALL ============
  clearAll() {
    sqlite.execSql('DELETE FROM trades', []);
    sqlite.execSql('DELETE FROM orders', []);
    sqlite.execSql('DELETE FROM ai_decisions', []);
    sqlite.execSql('DELETE FROM system_events', []);
    sqlite.execSql('DELETE FROM audit_logs', []);
    sqlite.execSql('DELETE FROM performance', []);
    sqlite.execSql('DELETE FROM positions', []);
    sqlite.execSql('DELETE FROM fills', []);
    sqlite.execSql('DELETE FROM order_events', []);
  },

  // ============ FLUSH (compatibility no-op, SQLite auto-commits) ============
  flush() {
    // SQLite commits immediately — no flush needed
    return true;
  },
};

// Auto-migrate on first load
try {
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = path.resolve(__dirname, '..', 'data');
  const migrationFlag = path.join(DATA_DIR, '.sqlite_migrated');
  if (!fs.existsSync(migrationFlag)) {
    store.migrateFromJsonStore();
    fs.writeFileSync(migrationFlag, new Date().toISOString());
  }
} catch (e) { console.warn('[store] auto-migration skipped:', e.message); }

module.exports = store;
