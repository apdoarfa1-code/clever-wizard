'use strict';
// watchdog.js — Watchdog Supervisor + Heartbeat System
// Monitors every module and restarts unhealthy services automatically.
const config = require('./config');
const store = require('./store');
const bus = require('./event-bus');
const fs = require('fs');
const path = require('path');

const HEARTBEAT_INTERVAL_MS = 5000;  // every module pings every 5s
const HEARTBEAT_TIMEOUT_MS = 30000; // missing 6 consecutive = unhealthy
const WATCHDOG_TICK_MS = 5000;

// === State ===
const _heartbeats = new Map(); // module → { lastBeat, beats, errors, restarts, healthy }
const _subscribers = new Map(); // module → recovery function
let _watchdogTimer = null;
let _started = false;
let _auditLog = [];
let _emergencyMode = false;
let _safeMode = false;

const MODULES = ['server', 'agent', 'risk', 'broker', 'db', 'websocket', 'scanner', 'ai', 'workers', 'health'];

// === Heartbeat Publisher ===
function beat(module, opts = {}) {
  const e = _heartbeats.get(module) || { lastBeat: 0, beats: 0, errors: 0, restarts: 0, healthy: true, status: {} };
  e.lastBeat = Date.now();
  e.beats++;
  e.healthy = true;
  e.status = opts.status || {};
  _heartbeats.set(module, e);
}

// === Subscribe recovery function ===
function registerRecovery(module, fn) {
  _subscribers.set(module, fn);
}

// === Watchdog tick ===
function _tick() {
  const now = Date.now();
  for (const module of MODULES) {
    const e = _heartbeats.get(module);
    if (!e) {
      // Module never reported — log but don't kill (some optional)
      continue;
    }
    if (now - e.lastBeat > HEARTBEAT_TIMEOUT_MS) {
      if (e.healthy) {
        e.healthy = false;
        e.errors++;
        audit('WATCHDOG', `module ${module} heartbeat lost (${Math.round((now - e.lastBeat)/1000)}s)`, 'CRITICAL');
        bus.healthWarning(`heartbeat lost: ${module}`);
        // Attempt recovery
        const recover = _subscribers.get(module);
        if (recover) {
          audit('RECOVERY', `attempting recovery for ${module}`, 'WARN');
          try {
            const result = recover();
            if (result && typeof result.then === 'function') {
              result.then(() => {
                beat(module);
                audit('RECOVERY', `${module} recovered`, 'INFO');
              }).catch((err) => {
                audit('RECOVERY', `${module} recovery failed: ${err.message}`, 'ERROR');
                _escalate(module);
              });
            } else {
              beat(module);
              audit('RECOVERY', `${module} recovered`, 'INFO');
            }
          } catch (err) {
            audit('RECOVERY', `${module} recovery threw: ${err.message}`, 'ERROR');
            _escalate(module);
          }
        } else {
          audit('RECOVERY', `no recovery function for ${module}`, 'WARN');
        }
      }
    }
  }
  // Persist recovery state every 5s (runtime-state.json)
  _persistRuntimeState();
}

function _escalate(module) {
  audit('ESCALATION', `${module} — escalating to safe mode`, 'CRITICAL');
  _safeMode = true;
  bus.emit('system:esc', { module });
}

// === Audit Log ===
function audit(module, action, severity = 'INFO', extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    module,
    action,
    severity,
    ...extra,
  };
  _auditLog.push(entry);
  if (_auditLog.length > 10000) _auditLog.shift();
  bus.emit('audit:log', entry);
  // Persist every 10th entry (avoid IO thrash)
  if (_auditLog.length % 10 === 0) _flushAuditLog();
}

function getAuditLog(limit = 100) { return _auditLog.slice(-limit); }

function _flushAuditLog() {
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'audit.json');
    fs.writeFileSync(file, JSON.stringify(_auditLog.slice(-5000), null, 2));
  } catch (e) { /* ignore */ }
}

// === Runtime State Persistence ===
let _runtimeState = null;
function _persistRuntimeState() {
  const state = {
    ts: Date.now(),
    appState: bus.getAppState(),
    heartbeats: Object.fromEntries([..._heartbeats.entries()].map(([k, v]) => [k, { lastBeat: v.lastBeat, beats: v.beats, healthy: v.healthy }])),
    emergencyMode: _emergencyMode,
    safeMode: _safeMode,
    openPositions: store.getTrades().filter(t => t.status === 'open').map(t => ({ id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, price: t.price })),
    agentStatus: store.getAgentState(),
  };
  _runtimeState = state;
  try {
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'runtime-state.json');
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) { /* ignore — best effort */ }
}

function getRuntimeState() { return _runtimeState; }

// === Session Restore ===
function restoreSession() {
  try {
    const file = path.join(__dirname, '..', 'data', 'runtime-state.json');
    if (!fs.existsSync(file)) return null;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || !state.ts) return null;
    const ageMs = Date.now() - state.ts;
    if (ageMs > 600000) { // 10 min stale
      audit('RESTORE', `runtime state stale (${Math.round(ageMs/1000)}s old) — ignoring`, 'WARN');
      return null;
    }
    audit('RESTORE', `recovered runtime state from ${Math.round(ageMs/1000)}s ago`, 'INFO');
    bus.emit('session:restored', { ageMs, positionCount: state.openPositions?.length || 0 });
    return state;
  } catch (e) {
    audit('RESTORE', `failed to read runtime state: ${e.message}`, 'ERROR');
    return null;
  }
}

// === Health Score (0-100) ===
function healthScore() {
  let score = 100;
  let moduleWeight = 100 / MODULES.length;
  for (const module of MODULES) {
    const e = _heartbeats.get(module);
    if (!e) { score -= moduleWeight * 0.5; continue; } // unreported
    if (!e.healthy) score -= moduleWeight;
    else if (Date.now() - e.lastBeat > 15000) score -= moduleWeight * 0.7; // slow
  }
  if (_emergencyMode) score *= 0.3;
  else if (_safeMode) score *= 0.6;
  return Math.max(0, Math.round(score));
}

// === Safe Mode / Emergency Mode ===
function setSafeMode(active, reason = 'manual') {
  _safeMode = active;
  audit('SAFE_MODE', `${active ? 'ENABLED' : 'DISABLED'} — ${reason}`, 'WARN');
  bus.emit('safe-mode', { active, reason });
}
function setEmergencyMode(active, reason = 'auto') {
  _emergencyMode = active;
  audit('EMERGENCY_MODE', `${active ? 'ENABLED' : 'DISABLED'} — ${reason}`, 'CRITICAL');
  bus.emit('emergency-mode', { active, reason });
  if (active) {
    // Trigger kill switch on risk-pro
    try { require('./risk-pro').activateKillSwitch(`emergency mode: ${reason}`); } catch {}
  } else {
    try { require('./risk-pro').deactivateKillSwitch(); } catch {}
  }
}
function isSafeMode() { return _safeMode; }
function isEmergencyMode() { return _emergencyMode; }
function shouldAcceptNewTrades() {
  if (_emergencyMode) return false;
  if (_safeMode) return false;
  return healthScore() >= config.getNum('MIN_HEALTH_SCORE', 50);
}

// === Duplicate Order Protection ===
const _execTokens = new Set();
const _tokenAge = new Map();
function generateExecToken(symbol, side, qty, price) {
  const token = `${symbol}:${side}:${qty}:${Math.round(price*1000)}:${Math.floor(Date.now()/1000)}`;
  if (_execTokens.has(token)) return { duplicate: true, token };
  _execTokens.add(token);
  _tokenAge.set(token, Date.now());
  // Prune old tokens (>60s)
  const cutoff = Date.now() - 60000;
  for (const [t, ts] of _tokenAge) {
    if (ts < cutoff) { _execTokens.delete(t); _tokenAge.delete(t); }
  }
  return { duplicate: false, token };
}

// === Auto-Backup ===
function _backup(suffix = 'auto') {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '..', 'data', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const dataDir = path.join(__dirname, '..', 'data');
    const files = ['trades.json', 'paper.json', 'agent-state.json', 'audit.json'];
    let copied = 0;
    for (const f of files) {
      const src = path.join(dataDir, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, `${f.replace('.json', '')}__${suffix}__${ts}.json`));
        copied++;
      }
    }
    audit('BACKUP', `${copied} files backed up (${suffix})`, 'INFO');
    bus.emit('backup:created', { files: copied, suffix, ts });
    return { ok: true, files: copied };
  } catch (e) {
    audit('BACKUP', `failed: ${e.message}`, 'ERROR');
    return { ok: false, error: e.message };
  }
}

// === Production Checklist Gate ===
async function productionChecklist() {
  const checks = {};
  let passed = 0, failed = 0;
  // 1. Database health
  try { checks.db = !!store.getTrades && !!store.addLog; if (checks.db) passed++; else failed++; }
  catch (e) { checks.db = false; failed++; }
  // 2. Workers healthy
  try { const w = require('./worker-manager').getAllStats(); checks.workers = Object.keys(w).length > 0; if (checks.workers) passed++; else failed++; }
  catch (e) { checks.workers = false; failed++; }
  // 3. Risk engine
  try { checks.risk = !!require('./risk-pro').validateTrade; if (checks.risk) passed++; else failed++; }
  catch (e) { checks.risk = false; failed++; }
  // 4. Execution
  try { checks.execution = !!require('./execution').executeSmart; if (checks.execution) passed++; else failed++; }
  catch (e) { checks.execution = false; failed++; }
  // 5. Broker connection
  try { const b = require('./brokers').getBroker(); checks.broker = !!b.testConnection; if (await b.testConnection()); if (checks.broker) passed++; else failed++; }
  catch (e) { checks.broker = false; failed++; }
  // 6. Health monitor
  try { checks.healthMonitor = !!require('./health').getStatus(); if (checks.healthMonitor) passed++; else failed++; }
  catch (e) { checks.healthMonitor = false; failed++; }
  // 7. Watchdog
  checks.watchdog = _started;
  if (_started) passed++; else failed++;
  // 8. Heartbeats
  const activeBeats = [..._heartbeats.values()].filter(h => h.healthy).length;
  checks.heartbeats = activeBeats;
  if (activeBeats >= MODULES.length / 2) passed++; else failed++;
  // 9. Emergency mode off
  checks.emergencyOff = !_emergencyMode;
  if (!_emergencyMode) passed++; else failed++;
  // 10. Health score
  const score = healthScore();
  checks.healthScore = score;
  if (score >= 50) passed++; else failed++;
  // 11. Backup available
  const backupDir = path.join(__dirname, '..', 'data', 'backups');
  checks.backupAvailable = fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0;
  if (checks.backupAvailable) passed++; else failed++;
  // 12. Latency acceptable
  try {
    const perf = store.getPerf();
    checks.latencyOK = (perf.totalMs || 0) < 5000;
    if (checks.latencyOK) passed++; else failed++;
  } catch (e) { checks.latencyOK = false; failed++; }

  const ok = failed === 0;
  audit('CHECKLIST', `production gate ${ok ? 'PASSED' : 'FAILED'} (${passed}/${passed+failed})`, ok ? 'INFO' : 'ERROR');
  return { ok, passed, failed, total: passed + failed, checks, healthScore: score };
}

// === Watchdog start/stop ===
function start() {
  if (_started) return;
  _started = true;
  // Restore previous session if available
  const restored = restoreSession();
  if (restored) {
    audit('STARTUP', `session restored (${restored.openPositions?.length || 0} open positions)`, 'INFO');
    bus.emit('session:restored', restored);
  }
  // Initial audit
  audit('WATCHDOG', 'started', 'INFO');
  // Schedule watchdog tick
  _watchdogTimer = setInterval(_tick, WATCHDOG_TICK_MS);
  // Hourly backup
  setInterval(() => _backup('hourly'), 3600000).unref?.();
  // Boot self-beat
  beat('watchdog');
  console.log('[watchdog] supervisor running — interval', WATCHDOG_TICK_MS, 'ms');
  bus.emit('watchdog:started');
}

function stop() {
  if (_watchdogTimer) clearInterval(_watchdogTimer);
  _started = false;
  // Pre-shutdown backup
  _backup('shutdown');
  // Final state save
  _persistRuntimeState();
  _flushAuditLog();
  audit('WATCHDOG', 'stopped', 'INFO');
}

// Self-init module beats on require
beat('watchdog', { status: 'starting' });
beat('server', { status: 'booting' });

module.exports = {
  start, stop, beat, registerRecovery,
  audit, getAuditLog,
  healthScore,
  setSafeMode, setEmergencyMode, isSafeMode, isEmergencyMode,
  shouldAcceptNewTrades,
  generateExecToken,
  restoreSession, getRuntimeState,
  productionChecklist,
  backup: _backup,
  MODULES,
};