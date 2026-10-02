'use strict';
/*
 * lib/database/schema.js — Relational Database Schema definition
 * Defines all 23 required trading tables with foreign keys, constraints, and indexes.
 */

const TABLES = {
  brokers: `CREATE TABLE IF NOT EXISTS brokers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    config TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  accounts: `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    broker_id TEXT,
    account_name TEXT,
    currency TEXT DEFAULT 'USDT',
    balance REAL DEFAULT 0,
    available REAL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(broker_id) REFERENCES brokers(id)
  )`,

  balances: `CREATE TABLE IF NOT EXISTS balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    asset TEXT NOT NULL,
    free REAL DEFAULT 0,
    locked REAL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  symbols: `CREATE TABLE IF NOT EXISTS symbols (
    symbol TEXT PRIMARY KEY,
    base_asset TEXT,
    quote_asset TEXT,
    status TEXT DEFAULT 'TRADING',
    min_qty REAL,
    max_qty REAL,
    step_size REAL,
    tick_size REAL,
    min_notional REAL
  )`,

  market_data: `CREATE TABLE IF NOT EXISTS market_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    UNIQUE(symbol, timeframe, timestamp)
  )`,

  signals: `CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    action TEXT NOT NULL,
    score REAL,
    confidence REAL,
    regime TEXT,
    indicators TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  ai_decisions: `CREATE TABLE IF NOT EXISTS ai_decisions (
    id TEXT PRIMARY KEY,
    symbol TEXT,
    action TEXT,
    side TEXT,
    confidence REAL,
    reasoning TEXT,
    raw_model TEXT,
    provider TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  orders: `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    trade_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL,
    status TEXT DEFAULT 'PENDING',
    client_order_id TEXT UNIQUE,
    broker_order_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  order_events: `CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`,

  fills: `CREATE TABLE IF NOT EXISTS fills (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    symbol TEXT,
    price REAL,
    qty REAL,
    fee REAL,
    fee_asset TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`,

  positions: `CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    entry_price REAL NOT NULL,
    mark_price REAL,
    leverage REAL DEFAULT 1,
    pnl REAL DEFAULT 0,
    status TEXT DEFAULT 'OPEN',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  trades: `CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    action TEXT,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    close_price REAL,
    pnl REAL,
    sl REAL,
    tp REAL,
    status TEXT DEFAULT 'open',
    broker TEXT DEFAULT 'paper',
    close_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  risk_events: `CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  risk_snapshots: `CREATE TABLE IF NOT EXISTS risk_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    daily_pnl REAL,
    drawdown REAL,
    exposure REAL,
    open_positions INTEGER,
    kill_switch INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  performance: `CREATE TABLE IF NOT EXISTS performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL,
    latency_ms REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  metrics: `CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  system_events: `CREATE TABLE IF NOT EXISTS system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  audit_logs: `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module TEXT NOT NULL,
    action TEXT NOT NULL,
    severity TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  notifications: `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    title TEXT,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  telegram_events: `CREATE TABLE IF NOT EXISTS telegram_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    command TEXT,
    response TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  runtime_state: `CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  worker_state: `CREATE TABLE IF NOT EXISTS worker_state (
    worker_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    tasks_completed INTEGER DEFAULT 0,
    restarts INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,

  backups: `CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    size_bytes INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol)',
  'CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)',
  'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
  'CREATE INDEX IF NOT EXISTS idx_market_data_sym_tf ON market_data(symbol, timeframe, timestamp)',
  'CREATE INDEX IF NOT EXISTS idx_audit_module ON audit_logs(module)',
  'CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name)'
];

module.exports = { TABLES, INDEXES };
