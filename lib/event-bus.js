'use strict';
// event-bus.js — Centralized Event Bus for inter-service communication
// Every service publishes/subscribes through this bus (no direct deps)
const EventEmitter = require('events');

class SystemEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(128);
    this._stateListeners = new Map();
    this._appState = 'BOOTING';
  }

  // ===== System lifecycle =====
  setAppState(state) {
    const prev = this._appState;
    this._appState = state;
    this.emit('app:state', { from: prev, to: state });
    this.emit(`app:${state.toLowerCase()}`, { from: prev });
  }

  getAppState() { return this._appState; }

  // ===== Standard event publishers (one per service) =====
  // Broker
  brokerConnected(brokerName) { this.emit('broker:connected', brokerName); }
  brokerDisconnected(brokerName) { this.emit('broker:disconnected', brokerName); }

  // Market
  marketUpdated(symbol, price) { this.emit('market:updated', { symbol, price }); }
  scannerFinished(results) { this.emit('scanner:done', results); }

  // Decision / AI
  signalGenerated(signal) { this.emit('signal:generated', signal); }

  // Risk
  riskApproved(trade) { this.emit('risk:approved', trade); }
  riskRejected(trade, reason) { this.emit('risk:rejected', { trade, reason }); }

  // Execution
  tradeOpened(trade) { this.emit('trade:opened', trade); }
  tradeClosed(trade) { this.emit('trade:closed', trade); }

  // Position
  positionUpdated(pos) { this.emit('position:updated', pos); }

  // System health
  perfMeasured(stats) { this.emit('perf:measured', stats); }
  errorOccurred(err) { this.emit('system:error', err); }
  healthWarning(msg) { this.emit('health:warning', msg); }

  // Database / Save
  tradeSaved(trade) { this.emit('db:trade:saved', trade); }
  backupCreated(path) { this.emit('db:backup:created', path); }

  // WARNING: `notifications` corrected to a standard english event name
  notificationEvent(type, msg) { this.emit('notification:' + type, msg); }

  // ===== Internal helpers =====
  reactTo(pattern, handler) {
    if (this._stateListeners.has(pattern)) return;
    const matchers = pattern.split(':');
    const listener = (data) => {
      if (matchers.every((m, i) => {
        const eventParts = (typeof arguments[1] === 'string' ? arguments[1] : JSON.stringify(arguments)).split(':');
        return m === '*' || m === arguments[1];
      })) handler(data);
    };
    this._stateListeners.set(pattern, listener);
  }
}

// Singleton
const bus = new SystemEventBus();

// Core boot events — emitted during start sequence
bus.on('app:ready', () => { console.log('[events] System ready'); });
bus.on('system:error', (err) => { console.error('[events] ERROR:', err.message || err); });
bus.on('health:warning', (msg) => { console.warn('[events] HEALTH:', msg); });

module.exports = bus;