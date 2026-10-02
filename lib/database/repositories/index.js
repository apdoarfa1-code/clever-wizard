'use strict';
/*
 * lib/database/repositories/ — Structured Repositories for REAL SQLite Database Access
 * All operations route through lib/database/sqlite-bridge.js → Python sqlite3 → data/trading_system.db
 */
const sqlite = require('../sqlite-bridge');

class TradeRepository {
  static create(trade) {
    const id = trade.id || `T_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    sqlite.execSql(
      'INSERT INTO trades (id, symbol, side, action, price, qty, sl, tp, status, broker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, trade.symbol, trade.side, trade.action || 'BUY', trade.price, trade.qty,
       trade.sl || null, trade.tp || null, trade.status || 'open', trade.broker || 'paper']
    );
    return { id, ...trade };
  }

  static findAll() {
    const r = sqlite.execSql('SELECT * FROM trades ORDER BY created_at DESC', []);
    return r.ok ? r.rows : [];
  }

  static findById(id) {
    const r = sqlite.execSql('SELECT * FROM trades WHERE id = ?', [id]);
    return r.ok && r.rows.length ? r.rows[0] : null;
  }

  static update(id, updates) {
    const fields = [];
    const params = [];
    if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
    if (updates.pnl !== undefined) { fields.push('pnl = ?'); params.push(updates.pnl); }
    if (updates.closePrice !== undefined) { fields.push('close_price = ?'); params.push(updates.closePrice); }
    if (updates.closeReason !== undefined) { fields.push('close_reason = ?'); params.push(updates.closeReason); }
    fields.push("updated_at = CURRENT_TIMESTAMP");
    params.push(id);
    sqlite.execSql(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.findById(id);
  }

  static getClosed() {
    const r = sqlite.execSql("SELECT * FROM trades WHERE status = 'closed' ORDER BY updated_at DESC", []);
    return r.ok ? r.rows : [];
  }

  static getOpen() {
    const r = sqlite.execSql("SELECT * FROM trades WHERE status = 'open' ORDER BY created_at DESC", []);
    return r.ok ? r.rows : [];
  }
}

class OrderRepository {
  static create(order) {
    const id = order.id || `O_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const clientOrderId = order.clientOrderId || `CID_${Date.now()}`;
    sqlite.execSql(
      'INSERT INTO orders (id, trade_id, symbol, side, type, qty, price, status, client_order_id, broker_order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, order.tradeId || null, order.symbol, order.side, order.type || 'MARKET',
       order.qty, order.price || null, order.status || 'PENDING', clientOrderId, order.brokerOrderId || null]
    );
    return { id, clientOrderId, ...order };
  }

  static findAll() {
    const r = sqlite.execSql('SELECT * FROM orders ORDER BY created_at DESC', []);
    return r.ok ? r.rows : [];
  }

  static findById(id) {
    const r = sqlite.execSql('SELECT * FROM orders WHERE id = ?', [id]);
    return r.ok && r.rows.length ? r.rows[0] : null;
  }

  static findByClientOrderId(cid) {
    const r = sqlite.execSql('SELECT * FROM orders WHERE client_order_id = ?', [cid]);
    return r.ok && r.rows.length ? r.rows[0] : null;
  }

  static updateStatus(id, status) {
    sqlite.execSql('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
  }
}

class PositionRepository {
  static upsert(pos) {
    const existing = sqlite.execSql('SELECT id FROM positions WHERE symbol = ?', [pos.symbol]);
    if (existing.ok && existing.rows.length) {
      sqlite.execSql(
        'UPDATE positions SET side = ?, qty = ?, entry_price = ?, mark_price = ?, pnl = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE symbol = ?',
        [pos.side, pos.qty, pos.entryPrice, pos.markPrice || pos.entryPrice, pos.pnl || 0, pos.status || 'OPEN', pos.symbol]
      );
    } else {
      const id = `P_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      sqlite.execSql(
        'INSERT INTO positions (id, symbol, side, qty, entry_price, mark_price, leverage, pnl, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, pos.symbol, pos.side, pos.qty, pos.entryPrice, pos.markPrice || pos.entryPrice, pos.leverage || 1, pos.pnl || 0, 'OPEN']
      );
    }
    const r = sqlite.execSql('SELECT * FROM positions WHERE symbol = ?', [pos.symbol]);
    return r.ok && r.rows.length ? r.rows[0] : null;
  }

  static findAll() {
    const r = sqlite.execSql("SELECT * FROM positions WHERE status = 'OPEN'", []);
    return r.ok ? r.rows : [];
  }

  static close(symbol) {
    sqlite.execSql("UPDATE positions SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP WHERE symbol = ?", [symbol]);
  }
}

class AuditRepository {
  static log(module, action, severity = 'INFO') {
    sqlite.execSql('INSERT INTO audit_logs (module, action, severity) VALUES (?, ?, ?)', [module, action, severity]);
  }

  static getRecent(limit = 50) {
    const r = sqlite.execSql('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', [limit]);
    return r.ok ? r.rows : [];
  }
}

class SignalRepository {
  static create(signal) {
    const id = signal.id || `S_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    sqlite.execSql(
      'INSERT INTO signals (id, symbol, side, action, score, confidence, regime, indicators) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, signal.symbol, signal.side, signal.action, signal.score, signal.confidence, signal.regime || null, JSON.stringify(signal.indicators || {})]
    );
    return { id, ...signal };
  }

  static getRecent(limit = 100) {
    const r = sqlite.execSql('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?', [limit]);
    return r.ok ? r.rows : [];
  }
}

class RiskRepository {
  static logEvent(eventType, severity, message, details = '') {
    sqlite.execSql('INSERT INTO risk_events (event_type, severity, message, details) VALUES (?, ?, ?, ?)',
      [eventType, severity, message, JSON.stringify(details)]);
  }

  static snapshot(snap) {
    sqlite.execSql('INSERT INTO risk_snapshots (daily_pnl, drawdown, exposure, open_positions, kill_switch) VALUES (?, ?, ?, ?, ?)',
      [snap.dailyPnl || 0, snap.drawdown || 0, snap.exposure || 0, snap.openPositions || 0, snap.killSwitch ? 1 : 0]);
  }
}

class PerformanceRepository {
  static record(stage, latencyMs) {
    sqlite.execSql('INSERT INTO performance (stage, latency_ms) VALUES (?, ?)', [stage, latencyMs]);
  }

  static getAverages() {
    const r = sqlite.execSql('SELECT stage, AVG(latency_ms) as avg_ms, COUNT(*) as count FROM performance GROUP BY stage', []);
    return r.ok ? r.rows : [];
  }
}

module.exports = {
  TradeRepository,
  OrderRepository,
  PositionRepository,
  AuditRepository,
  SignalRepository,
  RiskRepository,
  PerformanceRepository,
};
