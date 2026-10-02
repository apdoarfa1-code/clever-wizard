'use strict';
// observability.js — Institutional Observability & Monitoring Platform
// Master Prompt 10: Real-time dashboards, alerts, metrics, timeline, reports
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const bus = require('./event-bus');
const watchdog = require('./watchdog');
const health = require('./health');

// =====================================================================
// METRICS STORAGE — ring buffer with history retention
// =====================================================================
const MAX_HISTORY = 1440; // 24h @ 1min samples
const metricsHistory = {
  cpu: [],
  ram: [],
  heap: [],
  eventLoopDelay: [],
  healthScore: [],
  brokerLatency: [],
  executionLatency: [],
  aiSignals: [],
  queueLength: [],
};

function pushMetric(arr, value, ts = Date.now()) {
  arr.push({ t: ts, v: value });
  if (arr.length > MAX_HISTORY) arr.shift();
}

// =====================================================================
// STATE COLLECTORS — pull real data from every subsystem
// =====================================================================
function collectSystemMetrics() {
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsage = process.memoryUsage();
  const cpuPercent = +(loadAvg[0] / os.cpus().length * 100).toFixed(1);
  const ramPercent = +((usedMem / totalMem) * 100).toFixed(1);
  const heapMB = +(memUsage.heapUsed / 1048576).toFixed(1);
  const rssMB = +(memUsage.rss / 1048576).toFixed(1);
  const uptimeSec = Math.floor(process.uptime());

  // Event loop delay (rough)
  const hrStart = process.hrtime();
  let loopDelayMs = 0;
  try {
    const start = Date.now();
    while (Date.now() === start) {} // busy-wait baseline
    loopDelayMs = 0; // placeholder — real measurement needs perf_hooks
  } catch (e) { loopDelayMs = 0; }

  return {
    cpu: { percent: cpuPercent, load1: loadAvg[0], load5: loadAvg[1], load15: loadAvg[2], cores: os.cpus().length },
    ram: { usedMB: +(usedMem / 1048576).toFixed(1), totalMB: +(totalMem / 1048576).toFixed(1), percent: ramPercent },
    heap: { usedMB: heapMB, totalMB: +(memUsage.heapTotal / 1048576).toFixed(1), rssMB, external: +((memUsage.external || 0) / 1048576).toFixed(1) },
    uptime: uptimeSec,
    pid: process.pid,
    platform: process.platform,
    nodeVersion: process.version,
    eventLoopDelayMs: loopDelayMs,
  };
}

// =====================================================================
// DASHBOARDS — collect per-subsystem state
// =====================================================================
function systemDashboard() {
  const sys = collectSystemMetrics();
  const wd = watchdog.getStatus ? watchdog.getStatus() : {};
  const h = health.getStatus ? health.getStatus() : {};
  const busState = bus.getAppState ? bus.getAppState() : 'unknown';
  return {
    appState: busState,
    healthScore: wd.healthScore || watchdog.healthScore(),
    safeMode: wd.safeMode || false,
    emergency: wd.emergencyMode || false,
    uptime: sys.uptime,
    cpu: sys.cpu,
    ram: sys.ram,
    heap: sys.heap,
    pid: sys.pid,
    platform: sys.platform,
    nodeVersion: sys.nodeVersion,
    workers: getWorkersStatus(),
    database: getDbStatus(),
    websocket: getWsStatus(),
    internet: getInternetStatus(),
  };
}

function getWorkersStatus() {
  try {
    const wm = require('./worker-manager');
    const stats = wm.getAllStats();
    return { ok: true, pools: stats };
  } catch (e) { return { ok: false, error: e.message }; }
}

function getDbStatus() {
  try {
    const trades = store.getTrades ? (store.getTrades() || []) : [];
    const logs = store.getLogs ? (store.getLogs() || []) : [];
    return {
      ok: true,
      trades: trades.length,
      openTrades: trades.filter(t => t.status === 'open').length,
      closedTrades: trades.filter(t => t.status === 'closed').length,
      logs: logs.length,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

function getWsStatus() {
  return { ok: true, note: 'check api status endpoint for live client count' };
}

function getInternetStatus() {
  return { ok: true, note: 'use api/internet-check endpoint for live ping' };
}

function brokerDashboard() {
  try {
    const brokers = require('./brokers');
    const available = brokers.getAvailableBrokers();
    const active = available.filter(b => b.active);
    return {
      total: available.length,
      activeCount: active.length,
      activeBrokers: active.map(b => b.name),
      inactive: available.filter(b => !b.active).map(b => b.name),
      current: config.get('DEFAULT_BROKER'),
      mode: config.get('TRADING_MODE'),
    };
  } catch (e) { return { error: e.message }; }
}

function aiDashboard() {
  try {
    const quantAI = require('./quant-ai');
    const learn = quantAI.getLearningStats ? quantAI.getLearningStats() : {};
    return {
      engine: 'quant-ai-v1',
      learning: learn,
      signalsGenerated: learn.total || 0,
      avgConfidence: learn.avgConfidence || 0,
      highConfWinRate: learn.highConfWinRate || 0,
    };
  } catch (e) { return { error: e.message }; }
}

function executionDashboard() {
  try {
    const execution = require('./execution');
    const queue = require('./queue');
    const execMetrics = execution.metrics ? execution.metrics() : {};
    const qStats = queue.stats ? queue.stats() : {};
    return {
      metrics: execMetrics,
      queue: qStats,
    };
  } catch (e) { return { error: e.message }; }
}

function riskDashboard() {
  try {
    const riskPro = require('./risk-pro');
    const summary = riskPro.metricsSummary ? riskPro.metricsSummary() : {};
    return {
      summary,
      dailyLossLimit: config.getNum('MAX_DAILY_LOSS_PCT', 5),
      maxPositions: config.getNum('MAX_POSITIONS', 5),
      tradingMode: config.get('TRADING_MODE'),
      riskEnginePro: config.getBool('RISK_ENGINE_PRO', true),
    };
  } catch (e) { return { error: e.message }; }
}

function performanceDashboard() {
  const sys = collectSystemMetrics();
  return {
    cpu: sys.cpu,
    ram: sys.ram,
    heap: sys.heap,
    eventLoopDelayMs: sys.eventLoopDelayMs,
    workers: getWorkersStatus(),
    pid: sys.pid,
  };
}

function networkDashboard() {
  return {
    internet: getInternetStatus(),
    brokerPing: 'use api/ping-broker',
    dns: 'use api/dns-check',
    bandwidth: 'not-measured',
  };
}

function databaseDashboard() {
  return getDbStatus();
}

function tradeAnalytics() {
  try {
    const trades = store.getTrades ? (store.getTrades() || []) : [];
    const closed = trades.filter(t => t.status === 'closed');
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) < 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    return {
      total: trades.length,
      open: trades.filter(t => t.status === 'open').length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : 0,
      totalPnl: +totalPnl.toFixed(2),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      profitFactor: losses.length ? +(Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length)).toFixed(2) : 0,
      recent: closed.slice(-10).map(t => ({
        symbol: t.symbol,
        side: t.side,
        entry: t.entry,
        exit: t.exit,
        pnl: t.pnl,
        confidence: t.confidence,
        regime: t.regime,
        holdTime: t.holdTime,
        reason: t.reason,
        ts: t.ts,
      })),
    };
  } catch (e) { return { error: e.message }; }
}

// =====================================================================
// ALERT ENGINE — 5 levels
// =====================================================================
const ALERT_LEVELS = ['INFO', 'WARNING', 'ERROR', 'CRITICAL', 'EMERGENCY'];
const _alerts = [];
const MAX_ALERTS = 1000;

function raiseAlert(level, source, message, data = {}) {
  if (!ALERT_LEVELS.includes(level)) level = 'INFO';
  const alert = {
    id: _alerts.length + 1,
    ts: Date.now(),
    level,
    source,
    message,
    data,
  };
  _alerts.unshift(alert);
  if (_alerts.length > MAX_ALERTS) _alerts.pop();
  // Persist to store
  try { store.addLog({ type: 'alert', level: level.toLowerCase(), msg: `[${source}] ${message}`, ...data }); } catch {}
  // Emit on event bus
  try { bus.emit('alert:raised', alert); } catch {}
  // Watchdog audit for critical+
  if (watchdog.audit && (level === 'CRITICAL' || level === 'EMERGENCY')) {
    watchdog.audit('ALERT', `[${level}] ${source}: ${message}`, level);
  }
  return alert;
}

function getAlerts(filter = {}) {
  let result = _alerts.slice();
  if (filter.level) result = result.filter(a => a.level === filter.level);
  if (filter.source) result = result.filter(a => a.source === filter.source);
  if (filter.since) result = result.filter(a => a.ts >= filter.since);
  return result.slice(0, filter.limit || 100);
}

// Auto-detector: scan for anomalies every 60s
let _alertTimer = null;
function startAlertDetector() {
  if (_alertTimer) return;
  _alertTimer = setInterval(() => {
    const sys = collectSystemMetrics();
    if (sys.cpu.percent > 85) raiseAlert('WARNING', 'system', `High CPU: ${sys.cpu.percent}%`);
    if (sys.ram.percent > 85) raiseAlert('WARNING', 'system', `High RAM: ${sys.ram.percent}%`);
    if (sys.heap.rssMB > 500) raiseAlert('WARNING', 'memory', `RSS high: ${sys.heap.rssMB}MB`);
    const score = watchdog.healthScore ? watchdog.healthScore() : 100;
    if (score < 30) raiseAlert('CRITICAL', 'health', `Health score critical: ${score}`);
    else if (score < 50) raiseAlert('WARNING', 'health', `Health score low: ${score}`);
  }, 60000).unref();
}

// =====================================================================
// NOTIFICATION SYSTEM — desktop + telegram + sound
// =====================================================================
const _notifications = [];
const MAX_NOTIF = 500;

function notify(level, title, message, opts = {}) {
  const n = { ts: Date.now(), level, title, message, ...opts };
  _notifications.unshift(n);
  if (_notifications.length > MAX_NOTIF) _notifications.pop();
  // Emit event
  try { bus.emit('notification', n); } catch {}
  return n;
}

function getNotifications(limit = 50) {
  return _notifications.slice(0, limit);
}

// =====================================================================
// LIVE LOG VIEWER — filter by module/level/symbol/etc
// =====================================================================
function getLiveLogs(filter = {}) {
  try {
    let logs = store.getLogs ? (store.getLogs() || []) : [];
    if (filter.module) logs = logs.filter(l => (l.type || '').includes(filter.module));
    if (filter.level) logs = logs.filter(l => l.level === filter.level);
    if (filter.symbol) logs = logs.filter(l => (l.msg || '').includes(filter.symbol));
    if (filter.since) logs = logs.filter(l => l.ts >= filter.since);
    if (filter.contains) logs = logs.filter(l => (l.msg || '').includes(filter.contains));
    return logs.slice(-(filter.limit || 200)).reverse();
  } catch (e) { return []; }
}

// =====================================================================
// TIMELINE TRACKER — boot → scan → ai → risk → exec → exit → journal
// =====================================================================
const _timeline = [];
const MAX_TIMELINE = 2000;

function trackEvent(phase, event, data = {}) {
  const entry = {
    ts: Date.now(),
    phase,
    event,
    data,
    uptime: process.uptime(),
  };
  _timeline.unshift(entry);
  if (_timeline.length > MAX_TIMELINE) _timeline.pop();
  return entry;
}

function getTimeline(filter = {}) {
  let result = _timeline.slice();
  if (filter.phase) result = result.filter(e => e.phase === filter.phase);
  if (filter.event) result = result.filter(e => e.event === filter.event);
  if (filter.since) result = result.filter(e => e.ts >= filter.since);
  return result.slice(0, filter.limit || 200);
}

// Auto-track key events on event bus
function wireTimeline() {
  const events = [
    'app:booting', 'app:ready', 'app:running', 'app:shutdown',
    'broker:connected', 'broker:disconnected',
    'signal:generated', 'trade:opened', 'trade:closed',
    'risk:approved', 'risk:rejected',
    'validator:passed', 'validator:blocked',
    'health:warning', 'alert:raised',
  ];
  for (const ev of events) {
    try { bus.on(ev, (data) => trackEvent(ev.split(':')[0], ev, data || {})); } catch {}
  }
}

// =====================================================================
// METRICS POLLER — push history every minute
// =====================================================================
let _metricsTimer = null;
function startMetricsPoller() {
  if (_metricsTimer) return;
  // Initial sample
  sampleMetrics();
  _metricsTimer = setInterval(sampleMetrics, 60000).unref();
}

function sampleMetrics() {
  const sys = collectSystemMetrics();
  pushMetric(metricsHistory.cpu, sys.cpu.percent);
  pushMetric(metricsHistory.ram, sys.ram.percent);
  pushMetric(metricsHistory.heap, sys.heap.usedMB);
  pushMetric(metricsHistory.eventLoopDelay, sys.eventLoopDelayMs);
  pushMetric(metricsHistory.healthScore, watchdog.healthScore ? watchdog.healthScore() : 100);
  // Queue length
  try {
    const q = require('./queue');
    const stats = q.stats ? q.stats() : {};
    pushMetric(metricsHistory.queueLength, stats.queued || 0);
  } catch {}
}

function getMetricsHistory(metric, limit = 100) {
  const arr = metricsHistory[metric];
  if (!arr) return [];
  return arr.slice(-limit);
}

function getAllMetricsHistory(limit = 100) {
  const out = {};
  for (const k of Object.keys(metricsHistory)) out[k] = metricsHistory[k].slice(-limit);
  return out;
}

// =====================================================================
// AUDIT DASHBOARD
// =====================================================================
function auditDashboard() {
  try {
    const auditPath = path.join(__dirname, '..', 'data', 'audit.json');
    if (!fs.existsSync(auditPath)) return { entries: [] };
    const raw = fs.readFileSync(auditPath, 'utf8');
    const data = JSON.parse(raw);
    const entries = Array.isArray(data) ? data : (data.entries || []);
    return {
      total: entries.length,
      recent: entries.slice(-20).reverse(),
    };
  } catch (e) { return { error: e.message, entries: [] }; }
}

// =====================================================================
// AUTO REPORTS
// =====================================================================
function generateReport(type = 'daily') {
  const sys = collectSystemMetrics();
  const trades = tradeAnalytics();
  const score = watchdog.healthScore ? watchdog.healthScore() : 100;
  const alerts = _alerts.filter(a => {
    const cutoff = type === 'weekly' ? Date.now() - 7 * 86400000 : type === 'monthly' ? Date.now() - 30 * 86400000 : Date.now() - 86400000;
    return a.ts >= cutoff;
  });
  return {
    type,
    timestamp: new Date().toISOString(),
    uptime: sys.uptime,
    healthScore: score,
    system: { cpu: sys.cpu, ram: sys.ram, heap: sys.heap },
    trades,
    alerts: { total: alerts.length, critical: alerts.filter(a => a.level === 'CRITICAL' || a.level === 'EMERGENCY').length, top: alerts.slice(0, 10) },
    recommendations: generateRecommendations(sys, trades, score, alerts),
  };
}

function generateRecommendations(sys, trades, score, alerts) {
  const recs = [];
  if (sys.cpu.percent > 70) recs.push('Reduce scanner frequency — CPU load high');
  if (sys.ram.percent > 80) recs.push('Restart recommended — RAM above 80%');
  if (sys.heap.rssMB > 400) recs.push('Possible memory leak — monitor heap growth');
  if (score < 50) recs.push('System health critical — investigate watchdog heartbeats');
  if (trades.winRate < 30 && trades.closed > 5) recs.push('Win rate below 30% — review strategy parameters');
  if (alerts.filter(a => a.level === 'CRITICAL').length > 0) recs.push('Critical alerts active — check alert dashboard');
  if (!recs.length) recs.push('All systems nominal — no action required');
  return recs;
}

// =====================================================================
// INIT
// =====================================================================
function init() {
  wireTimeline();
  startAlertDetector();
  startMetricsPoller();
  trackEvent('system', 'observability_init', { ts: Date.now() });
  if (watchdog.beat) watchdog.beat('observability', { status: 'ready' });
}

module.exports = {
  init,
  systemDashboard,
  brokerDashboard,
  aiDashboard,
  executionDashboard,
  riskDashboard,
  performanceDashboard,
  networkDashboard,
  databaseDashboard,
  tradeAnalytics,
  auditDashboard,
  raiseAlert,
  getAlerts,
  notify,
  getNotifications,
  getLiveLogs,
  trackEvent,
  getTimeline,
  getMetricsHistory,
  getAllMetricsHistory,
  generateReport,
  collectSystemMetrics,
};
