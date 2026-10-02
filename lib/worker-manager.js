'use strict';
// worker-manager.js — Top-level container for all worker pools
// Spawns: backtest-pool, analytics-pool, scanner-pool (future)
const { WorkerPool } = require('./worker-pool');
const bus = require('./event-bus');
const path = require('path');

let _pools = {};
let _started = false;

function start() {
  if (_started) return;
  _started = true;
  // Backtest pool — heavy CPU work, runs in background
  _pools.backtest = new WorkerPool(path.join(__dirname, 'workers', 'backtest-worker.js'), 2);
  _pools.backtest.start();
  // Analytics pool — calculations, statistics
  _pools.analytics = new WorkerPool(path.join(__dirname, 'workers', 'analytics-worker.js'), 1);
  _pools.analytics.start();
  bus.emit('workers:started', { pools: Object.keys(_pools).length });
  console.log('[worker-manager] started:', Object.keys(_pools).join(', '));
}

function getPool(name) { return _pools[name]; }

async function runBacktest(task) {
  if (!_pools.backtest) throw new Error('backtest pool not started');
  return _pools.backtest.exec(task);
}

async function runAnalytics(task) {
  if (!_pools.analytics) throw new Error('analytics pool not started');
  return _pools.analytics.exec(task);
}

function getAllStats() {
  const stats = {};
  for (const [name, pool] of Object.entries(_pools)) {
    stats[name] = pool.getStats();
  }
  return stats;
}

async function shutdown() {
  for (const pool of Object.values(_pools)) {
    try { await pool.terminate(); } catch {}
  }
  _pools = {};
  _started = false;
  bus.emit('workers:stopped');
}

module.exports = { start, getPool, runBacktest, runAnalytics, getAllStats, shutdown };