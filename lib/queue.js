'use strict';
// queue.js — Priority Execution Queue with Deduplication
// Order: emergency > stop-loss > take-profit > manual > new_entry > background
const bus = require('./event-bus');
const execution = require('./execution');

const PRIORITY = {
  EMERGENCY: 0,
  STOP_LOSS: 1,
  TAKE_PROFIT: 2,
  MANUAL: 3,
  NEW_ENTRY: 4,
  BACKGROUND: 5,
};

const MAX_CONCURRENT = 8;
const queue = [];
let processing = false;
let activeCount = 0;
let _paused = false;

// === Enqueue ===
function add(signal, priority = PRIORITY.NEW_ENTRY, opts = {}) {
  // Deduplication: check if signal already in queue
  const dedupKey = `${signal.symbol}:${signal.side}:${signal.qty}`;
  if (queue.some(item => item.dedupKey === dedupKey)) {
    bus.emit('queue:dup-blocked', { dedupKey });
    return { ok: false, reason: 'duplicate_in_queue' };
  }
  // Idempotency: check recent orders too
  if (execution.isDuplicate(signal.symbol, signal.side, signal.qty)) {
    return { ok: false, reason: 'duplicate_recent_order' };
  }
  const item = {
    dedupKey, signal, priority,
    ts: Date.now(), id: `J${Date.now()}`,
    attempts: 0, timeoutMs: opts.timeoutMs || 8000,
  };
  queue.push(item);
  // Keep sorted by priority (lower = higher priority)
  queue.sort((a, b) => a.priority - b.priority);
  bus.emit('queue:added', { id: item.id, priority, size: queue.length });
  process();
  return { ok: true, id: item.id };
}

// === Process Queue ===
async function process() {
  if (processing) return;
  if (_paused) return;
  processing = true;
  while (queue.length && activeCount < MAX_CONCURRENT) {
    const item = queue.shift();
    if (Date.now() - item.ts > item.timeoutMs) {
      bus.emit('queue:timeout', { id: item.id, signal: item.signal });
      continue;
    }
    activeCount++;
    try {
      const result = await execution.executeSmart(item.signal);
      bus.emit('queue:done', { id: item.id, ok: result.ok, result, ms: Date.now() - item.ts });
    } catch (e) {
      item.attempts++;
      if (item.attempts < 3 && (e.message || '').includes('timeout')) {
        queue.unshift(item); // re-queue
        bus.emit('queue:retry', { id: item.id, attempt: item.attempts });
      } else {
        bus.emit('queue:failed', { id: item.id, error: e.message });
      }
    } finally {
      activeCount--;
    }
  }
  processing = false;
}

// === Cancel all queued items (keeps ongoing ones) ===
function cancelAll() { const count = queue.length; queue.length = 0; bus.emit('queue:cancelled', { count }); return count; }
function cancel(id) {
  const idx = queue.findIndex(i => i.id === id);
  if (idx === -1) return false;
  queue.splice(idx, 1);
  bus.emit('queue:cancelled', { id });
  return true;
}

// === Stats ===
function stats() {
  return {
    queued: queue.length,
    active: activeCount,
    maxConcurrent: MAX_CONCURRENT,
    paused: _paused,
    processing,
  };
}

function pause() { _paused = true; bus.emit('queue:paused', { size: queue.length }); }
function resume() { _paused = false; bus.emit('queue:resumed'); process(); }

setInterval(() => {
  // Drop expired items
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    if (now - queue[i].ts > queue[i].timeoutMs) {
      bus.emit('queue:timeout', { id: queue[i].id });
      queue.splice(i, 1);
    }
  }
}, 2000).unref?.();

module.exports = { add, cancel, cancelAll, stats, pause, resume, PRIORITY, process };