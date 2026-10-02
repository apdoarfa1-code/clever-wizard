'use strict';
/*
 * lib/ws-client.js — Minimal WebSocket Client (RFC6455)
 * Zero external dependencies — uses Node's built-in 'tls' + 'crypto' modules.
 * Supports: connect, send, receive, ping/pong, close, reconnect.
 * Designed for Binance Futures WebSocket streams (wss://fstream.binance.com).
 */
const tls = require('tls');
const crypto = require('crypto');
const EventEmitter = require('events');

class WSClient extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this._url = url;
    this._opts = opts;
    this._socket = null;
    this._connected = false;
    this._buffer = Buffer.alloc(0);
    this._pingTimer = null;
    this._reconnectAttempts = 0;
    this._shouldReconnect = opts.reconnect !== false;
    this._maxReconnect = opts.maxReconnect || 30;
    this._reconnectDelay = opts.reconnectDelay || 3000;
    this._handshakeTimeout = opts.handshakeTimeout || 5000;
  }

  connect() {
    const url = new URL(this._url);
    const host = url.hostname;
    const port = url.port || (url.protocol === 'wss:' ? 443 : 80);
    const path = url.pathname + url.search;
    const key = crypto.randomBytes(16).toString('base64');

    const socket = tls.connect({
      host,
      port: +port,
      servername: host,
      rejectUnauthorized: true,
    }, () => {
      // Send WebSocket upgrade handshake
      const handshake = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        '',
        '',
      ].join('\r\n');
      socket.write(handshake);
    });

    let handshakeDone = false;
    let handshakeData = Buffer.alloc(0);

    const handshakeTimeout = setTimeout(() => {
      if (!handshakeDone) {
        socket.destroy();
        this.emit('error', new Error('WebSocket handshake timeout'));
      }
    }, this._handshakeTimeout);

    socket.on('data', (chunk) => {
      if (!handshakeDone) {
        handshakeData = Buffer.concat([handshakeData, chunk]);
        const headerEnd = handshakeData.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headers = handshakeData.slice(0, headerEnd).toString();
        if (!headers.includes('101')) {
          this.emit('error', new Error('WebSocket handshake failed: ' + headers.split('\r\n')[0]));
          socket.destroy();
          return;
        }

        handshakeDone = true;
        this._connected = true;
        this._socket = socket;
        clearTimeout(handshakeTimeout);
        this._reconnectAttempts = 0;
        this.emit('open');

        // Process any remaining data after handshake
        const remaining = handshakeData.slice(headerEnd + 4);
        if (remaining.length) this._processData(remaining);

        // Start ping interval
        this._pingTimer = setInterval(() => {
          this._sendFrame(0x9, Buffer.alloc(0)); // Ping
        }, 30000);
      } else {
        this._processData(chunk);
      }
    });

    socket.on('close', () => {
      this._connected = false;
      if (this._pingTimer) clearInterval(this._pingTimer);
      this.emit('close');
      if (this._shouldReconnect && this._reconnectAttempts < this._maxReconnect) {
        this._reconnectAttempts++;
        const delay = Math.min(30000, this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1));
        setTimeout(() => this.connect(), delay);
      }
    });

    socket.on('error', (err) => {
      this.emit('error', err);
      if (!handshakeDone) clearTimeout(handshakeTimeout);
    });
  }

  _processData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._buffer = this._buffer.slice(frame.totalLength);

      if (frame.opcode === 0x1) {
        // Text frame
        const text = frame.payload.toString('utf8');
        this.emit('message', text);
      } else if (frame.opcode === 0x9) {
        // Ping → Pong
        this._sendFrame(0xA, frame.payload);
      } else if (frame.opcode === 0xA) {
        // Pong — emit for heartbeat
        this.emit('pong');
      } else if (frame.opcode === 0x8) {
        // Close
        this._connected = false;
        this.emit('close');
        try { this._socket.destroy(); } catch {}
      }
    }
  }

  _parseFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < 4) return null;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) return null;
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.slice(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + payloadLen) return null;

    let payload = buf.slice(offset, offset + payloadLen);
    if (masked) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    return { opcode, payload, totalLength: offset + payloadLen };
  }

  _sendFrame(opcode, payload) {
    if (!this._socket || !this._connected) return;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    try { this._socket.write(Buffer.concat([header, mask, masked])); } catch {}
  }

  send(data) {
    if (typeof data === 'object') data = JSON.stringify(data);
    this._sendFrame(0x1, Buffer.from(data, 'utf8'));
  }

  close() {
    this._shouldReconnect = false;
    this._sendFrame(0x8, Buffer.alloc(0));
    try { this._socket.destroy(); } catch {}
    this._connected = false;
  }

  isConnected() { return this._connected; }
}

module.exports = WSClient;
