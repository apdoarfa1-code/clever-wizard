'use strict';
// worker-pool.js — Reusable Worker Pool with auto-scaling
// Reserves 1 core for OS. Never consumes 100% CPU.
const { Worker } = require('worker_threads');
const path = require('path');
const bus = require('./event-bus');

const MAX_WORKERS = Math.max(1, require('os').cpus().length - 1);
const IDLE_TIMEOUT_MS = 60000;

class WorkerPool {
  constructor(workerPath, size = MAX_WORKERS) {
    this.workerPath = workerPath;
    this.maxSize = size;
    this.workers = [];
    this.idleQueue = [];
    this.taskQueue = [];
    this.taskCounter = 0;
    this.stats = { dispatched: 0, completed: 0, failed: 0, avgMs: 0, totalMs: 0 };
    this._lastStatsReset = Date.now();
  }

  start() {
    for (let i = 0; i < this.maxSize; i++) this._spawn();
    console.log(`[workers] pool started: ${this.workers.length}/${this.maxSize} workers`);
  }

  _spawn() {
    const w = new Worker(this.workerPath);
    const entry = { worker: w, busy: false, lastTask: 0, tasksDone: 0, errors: 0, restarts: 0 };
    this.workers.push(entry);
    this.idleQueue.push(entry);

    w.on('message', (msg) => {
      if (msg.type === 'ready') {
        bus.emit('worker:ready', { id: w.threadId });
      }
    });
    w.on('error', (err) => {
      entry.errors++;
      console.error(`[workers] thread ${w.threadId} error:`, err.message);
      // Restart worker
      this._replace(entry);
    });
    w.on('exit', (code) => {
      if (code !== 0) {
        entry.restarts++;
        console.warn(`[workers] thread ${w.threadId} exited code=${code} — restarting`);
        this._replace(entry);
      }
    });
  }

  _replace(entry) {
    const idx = this.workers.indexOf(entry);
    if (idx === -1) return;
    this.workers.splice(idx, 1);
    // Remove from idleQueue if present
    const iqIdx = this.idleQueue.indexOf(entry);
    if (iqIdx !== -1) this.idleQueue.splice(iqIdx, 1);
    if (entry.pendingReject) {
      try { entry.pendingReject(new Error('worker_crashed')); } catch {}
    }
    // Spawn fresh
    this._spawn();
    bus.emit('worker:restarted', { restarts: entry.restarts });
    // Resume tasks
    this._drain();
  }

  async exec(task) {
    return new Promise((resolve, reject) => {
      const wrapped = { id: ++this.taskCounter, task, ts: Date.now(), resolve, reject };
      this.taskQueue.push(wrapped);
      this._drain();
    });
  }

  _drain() {
    while (this.taskQueue.length && this.idleQueue.length) {
      const entry = this.idleQueue.shift();
      const wrapped = this.taskQueue.shift();
      entry.busy = true;
      entry.lastTask = Date.now();
      entry.pendingReject = wrapped.reject;
      this.stats.dispatched++;

      const w = entry.worker;
      const handler = (msg) => {
        if (msg.id !== wrapped.id) return;
        w.off('message', handler);
        entry.busy = false;
        entry.tasksDone++;
        delete entry.pendingReject;
        const ms = Date.now() - wrapped.ts;
        this.stats.completed++;
        this.stats.totalMs += ms;
        this.stats.avgMs = Math.round(this.stats.totalMs / this.stats.completed);
        if (msg.error) {
          this.stats.failed++;
          wrapped.reject(new Error(msg.error));
        } else {
          wrapped.resolve(msg.result);
        }
        // Return to idle if pool still has room
        if (this.workers.includes(entry)) this.idleQueue.push(entry);
        bus.emit('worker:task-done', { id: wrapped.id, ms });
        // Continue draining
        this._drain();
      };
      w.on('message', handler);
      w.postMessage({ id: wrapped.id, task: wrapped.task });
    }
  }

  getStats() {
    return {
      ...this.stats,
      activeWorkers: this.workers.filter(w => w.busy).length,
      idleWorkers: this.idleQueue.length,
      totalWorkers: this.workers.length,
      maxWorkers: this.maxSize,
      queueLength: this.taskQueue.length,
      uptime: Math.floor((Date.now() - this._lastStatsReset) / 1000),
    };
  }

  async terminate() {
    for (const entry of this.workers) {
      try { await entry.worker.terminate(); } catch {}
    }
    this.workers = [];
    this.idleQueue = [];
    this.taskQueue = [];
  }
}

module.exports = { WorkerPool, MAX_WORKERS };