'use strict';
// health.js — Health Monitor — watches CPU, memory, broker, DB, uptime
const bus = require('./event-bus');
const store = require('./store');

let _started = false;
let _interval = null;
let _warnings = [];
let _startTime = Date.now();

function _getMemory() {
  const m = process.memoryUsage();
  return {
    rss: +(m.rss / 1024 / 1024).toFixed(1),
    heapUsed: +(m.heapUsed / 1024 / 1024).toFixed(1),
    heapTotal: +(m.heapTotal / 1024 / 1024).toFixed(1),
    external: +(m.external / 1024 / 1024).toFixed(1),
  };
}

function _tick() {
  const mem = _getMemory();
  const uptime = Math.floor((Date.now() - _startTime) / 1000);
  const cpu = process.cpuUsage();

  if (mem.rss > 300) {
    bus.healthWarning(`RSS high: ${mem.rss}MB > 300MB`);
    _warnings.push({ ts: Date.now(), msg: 'RSS high', value: mem.rss });
  }

  if (mem.heapUsed > 250) {
    bus.healthWarning(`Heap high: ${mem.heapUsed}MB`);
    _warnings.push({ ts: Date.now(), msg: 'Heap high', value: mem.heapUsed });
  }

  const perf = store.getPerf();
  if (perf && perf.uptime > 300 && perf.totalMs > 10000) {
    bus.healthWarning('API response > 10s — possible broker damage');
  }

  bus.emit('health:tick', {
    uptime,
    mem,
    cpu: { user: cpu.user, system: cpu.system },
    warnings: _warnings.length,
    state: bus.getAppState(),
  });

  const cutoff = Date.now() - 3600000;
  _warnings = _warnings.filter(w => w.ts > cutoff);
}

function start(intervalMs = 30000) {
  if (_started) return;
  _started = true;
  _startTime = Date.now();
  bus.setAppState('MONITORING');
  _tick();
  _interval = setInterval(_tick, intervalMs);
  console.log('[health] monitor started every', intervalMs, 'ms');
}

function stop() {
  if (_interval) clearInterval(_interval);
  _started = false;
}

function getStatus() {
  const mem = _getMemory();
  const uptime = Math.floor((Date.now() - _startTime) / 1000);
  return {
    ok: true, uptime, mem, warnings: _warnings.length, recent: _warnings.slice(-5),
  };
}

function getWarnings() { return _warnings.slice(-20); }

module.exports = { start, stop, getStatus, getWarnings };