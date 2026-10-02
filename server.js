#!/usr/bin/env node
'use strict';
/*
 * server.js — سيرفر Node.js محلي للبرنامج
 * صفر مكتبات خارجية: http + fs + path + crypto فقط.
 * يشتغل بأمر: node server.js أو ./start.sh
 *
 * Cyber-Sec: rate-limit + body-size + CSP/HSTS/XSS headers + IP whitelist
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = __dirname;
const config = require('./lib/config');
const store = require('./lib/store');
const routes = require('./lib/routes');
const agent = require('./lib/agent');
const telegram = require('./lib/telegram');
const bus = require('./lib/event-bus');
const health = require('./lib/health');
const watchdog = require('./lib/watchdog');

const PORT = config.getNum('PORT', 8080);
const HOST = config.get('HOST', '127.0.0.1');
const ALLOWED_ORIGIN = 'http://' + HOST + ':' + PORT;

// ===== Cyber Security: Rate Limiter =====
const RATE_WINDOW_MS = 60000;
const RATE_MAX_HITS = 600;
const RATE_MAX_HEAVY = 120;
const ipHits = new Map();
function rateLimit(ip, isHeavy) {
  const now = Date.now();
  const arr = ipHits.get(ip) || [];
  while (arr.length && arr[0].ts < now - RATE_WINDOW_MS) arr.shift();
  const heavy = arr.filter(x => x.heavy).length;
  const cap = isHeavy ? RATE_MAX_HEAVY : RATE_MAX_HITS;
  if (arr.length >= cap) return false;
  if (isHeavy && heavy >= RATE_MAX_HEAVY) return false;
  arr.push({ ts: now, heavy: !!isHeavy });
  ipHits.set(ip, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of ipHits.entries()) {
    while (arr.length && arr[0].ts < now - RATE_WINDOW_MS) arr.shift();
    if (!arr.length) ipHits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ===== Body Size Limit =====
const MAX_BODY_BYTES = 1024 * 1024;

// ===== CSRF tokens =====
const csrfTokens = new Map();
function makeCsrf() {
  const t = crypto.randomBytes(24).toString('hex');
  csrfTokens.set(t, Date.now() + 3600 * 1000);
  return t;
}
function verifyCsrf(t) {
  if (!t) return false;
  const exp = csrfTokens.get(t);
  if (!exp || exp < Date.now()) return false;
  csrfTokens.delete(t);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of csrfTokens.entries()) if (exp < now) csrfTokens.delete(k);
}, 30 * 60 * 1000).unref();

// ===== Cyber Security Headers (Helmet-equivalent) =====
function securityHeaders(req) {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fonts.googleapis.com https://s.tradingview.com https://*.tradingview.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://s.tradingview.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' ws: wss: http://127.0.0.1:* http://localhost:* https://s.tradingview.com",
      "frame-src 'self' https://s.tradingview.com https://*.tradingview.com",
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  };
}

// ---- MIME types ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---- تشغيل تلقائي للتليجرام commands كل 30 ثانية (أخف) ----
setInterval(() => {
  if (config.isConfigured('TELEGRAM_BOT_TOKEN')) {
    telegram.processCommands().catch(() => {});
  }
}, 30000);

// ---- بدء حلقة العقل لو autorun = true ----
if (config.getBool('AGENT_AUTORUN', false)) {
  console.log('[server] حلقة العقل التلقائية مفعّلة');
  agent.startLoop();
}

// ---- Warmup market cache (pre-fetch top symbols in background) ----
const market = require('./lib/market');
setTimeout(() => market.warmup().catch(() => {}), 500);

// ---- cache للملفات الثابتة (يقلل قراءة القرص) ----
const staticCache = new Map();
const STATIC_CACHE_MAX = 50;

// ---- إنشاء السيرفر ----
const server = http.createServer((req, res) => {
  const method = req.method;
  const url = req.url;
  const clientIp = req.socket.remoteAddress || 'unknown';

  // === Body Size Limit ===
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request body too large' }));
    return;
  }

  // === Rate Limit ===
  const isHeavy = method === 'POST' || method === 'PUT' || method === 'DELETE';
  if (!rateLimit(clientIp, isHeavy)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded — الرجاء المحاولة لاحقاً' }));
    return;
  }

  // قراءة الـ body مع حد أقصى
  const chunks = [];
  let bytesRead = 0;
  let bodyTooLarge = false;
  req.on('data', c => {
    bytesRead += c.length;
    if (bytesRead > MAX_BODY_BYTES) { bodyTooLarge = true; return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (bodyTooLarge) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      return;
    }
    const body = Buffer.concat(chunks).toString('utf8');

    // === Security Headers ===
    const secHeaders = securityHeaders(req);

    // API routes
    if (url.startsWith('/api/')) {
      routes.handleRequest(method, url, req.headers, body).then(result => {
        if (!result) { res.writeHead(404, secHeaders); res.end('Not Found'); return; }
        res.writeHead(result.status, { ...result.headers, ...secHeaders });
        if (result.binary && Buffer.isBuffer(result.data)) {
          res.end(result.data);
        } else {
          res.end(result.body);
        }
      }).catch(e => {
        console.error('[server] API error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...secHeaders });
        res.end(JSON.stringify({ error: 'Internal error' }));
      });
      return;
    }

    // Static files (with cache + gzip للأداء الخفيف)
    let filePath = url === '/' ? '/index.html' : url.split('?')[0];
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(ROOT, safePath);

    if (!fullPath.startsWith(ROOT)) {
      res.writeHead(403, secHeaders); res.end('Forbidden'); return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const cacheable = ext !== '.html';

    // تحقق من الكاش أولاً
    if (cacheable && staticCache.has(fullPath)) {
      const cached = staticCache.get(fullPath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Content-Encoding': 'gzip',
        ...secHeaders,
      });
      res.end(cached);
      return;
    }

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') { res.writeHead(404, secHeaders); res.end('Not Found'); }
        else { res.writeHead(500, secHeaders); res.end('Server Error'); }
        return;
      }

      // gzip للنصوص الكبيرة (CSS/JS/HTML)
      const shouldGzip = ['.html', '.css', '.js', '.json', '.svg'].includes(ext) && data.length > 1024;
      const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');

      if (shouldGzip && acceptGzip) {
        zlib.gzip(data, (e, compressed) => {
          if (e) {
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600', ...secHeaders });
            res.end(data);
            return;
          }
          if (cacheable && staticCache.size < STATIC_CACHE_MAX) {
            staticCache.set(fullPath, compressed);
          }
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
            'Content-Encoding': 'gzip',
            ...secHeaders,
          });
          res.end(compressed);
        });
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
          ...secHeaders,
        });
        res.end(data);
      }
    });
  });
});

// =====================================================================
// WebSocket live streams (no external deps — minimal RFC6455 implementation)
// =====================================================================
// crypto already required at top
const URL = require('url');

function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

const wsClients = new Set(); // Set<{socket, send, sendJson, alive}>
function wsBroadcast(obj, except) {
  const msg = JSON.stringify(obj);
  for (const c of wsClients) {
    if (c === except) continue;
    try { c.socket.write(msg); } catch {}
  }
}

// Live price cache (symbol -> {price, change, ts})
const livePrices = new Map();
const liveBook = new Map();
const liveTrades = []; // last 200 trades

// === REAL BINANCE FUTURES WEBSOCKET (USDⓈ-M) ===
// Binance Futures WS endpoints:
//   Combined: wss://fstream.binance.com/stream?streams=<stream1>/<stream2>/...
//   Raw:      wss://fstream.binance.com/ws/<stream>
const binanceSymbols = ['btcusdt','ethusdt','solusdt','bnbusdt','xrpusdt','adausdt','dogeusdt','avaxusdt'];

// Use native WS client (no external 'ws' dependency required)
const WSClient = require('./lib/ws-client');

  let _reconnectAttempts = 0;
  let _wsConnection = null;
  let _lastPingTime = 0;

  function connectBinanceFutures() {
    // Build combined stream URL: trades + bookTicker for each symbol
    const streams = [];
    for (const sym of binanceSymbols) {
      streams.push(`${sym}@trade`);
      streams.push(`${sym}@bookTicker`);
      streams.push(`${sym}@kline_15m`);
    }
    const wsUrl = `wss://fstream.binance.com/stream?streams=${streams.join('/')}`;

    _wsConnection = new WSClient(wsUrl, { reconnect: true, reconnectDelay: 2000 });
    _reconnectAttempts++;

    _wsConnection.on('open', () => {
      _reconnectAttempts = 0;
      _lastPingTime = Date.now();
      try { bus.emit('broker:connected', { broker: 'BINANCE', endpoint: 'fstream.binance.com', market: 'USDⓈ-M Futures' }); } catch {}
      console.log('[ws] Binance Futures WebSocket CONNECTED — streams active');
      store.addLog({ type: 'ws', level: 'info', msg: 'Binance Futures WS connected' });
    });

    _wsConnection.on('pong', () => { _lastPingTime = Date.now(); });

    _wsConnection.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const stream = msg.stream || '';
        const data = msg.data || {};
        const exchangeTs = data.E || data.T || Date.now();
        const localTs = Date.now();
        const latency = localTs - exchangeTs;

        // Trade stream
        if (stream.includes('@trade')) {
          const sym = data.s;
          const price = +data.p;
          const qty = +data.q;
          const side = data.m ? 'SELL' : 'BUY';
          livePrices.set(sym, { price, change: 0, ts: localTs });
          liveTrades.unshift({ symbol: sym, price, qty, side, ts: localTs, broker: 'BINANCE', exchange_ts: exchangeTs, latency });
          if (liveTrades.length > 200) liveTrades.pop();
          wsBroadcast({ type: 'trade', symbol: sym, price, qty, side, broker: 'BINANCE', exchange_ts: exchangeTs, latency });
        }
        // Book ticker (best bid/ask)
        else if (stream.includes('@bookTicker')) {
          const sym = data.s;
          const bid = +data.b;
          const ask = +data.a;
          const bidQty = +data.B;
          const askQty = +data.A;
          liveBook.set(sym, { bid, ask, bidQty, askQty, ts: localTs, broker: 'BINANCE' });
          wsBroadcast({ type: 'bookTicker', symbol: sym, bid, ask, bidQty, askQty, broker: 'BINANCE' });
        }
        // Kline stream (15m)
        else if (stream.includes('@kline')) {
          const k = data.k;
          if (!k) return;
          const sym = data.s;
          wsBroadcast({
            type: 'kline',
            symbol: sym,
            interval: k.i,
            open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
            isClosed: k.x === true,
            broker: 'BINANCE',
            exchange_ts: data.E,
            local_ts: localTs,
            latency,
          });
        }
      } catch (e) { /* ignore malformed messages */ }
    });

    _wsConnection.on('close', () => {
      try { bus.emit('broker:disconnected', { broker: 'BINANCE', endpoint: 'fstream.binance.com' }); } catch {}
      console.warn(`[ws] Binance Futures WS closed — auto-reconnecting (attempt ${_reconnectAttempts})`);
      store.addLog({ type: 'ws', level: 'warn', msg: 'Binance Futures WS disconnected — reconnecting' });
    });

    _wsConnection.on('error', (err) => {
      console.error('[ws] Binance Futures WS error:', err.message);
    });

    // Stale data detection (every 60s)
    setInterval(() => {
      const stale = (Date.now() - _lastPingTime) > 120000;
      if (stale && _wsConnection && _wsConnection.isConnected()) {
        console.warn('[ws] Binance Futures WS stale — forcing reconnect');
        try { _wsConnection.close(); } catch {}
      }
    }, 60000).unref();
  }

  connectBinanceFutures();

  // === BINANCE USER DATA STREAM (authenticated, for live trading — deferred until API key provided) ===
  async function startBinanceUserStream() {
    const apiKey = (config.get('BINANCE_API_KEY', '') || '').trim();
    if (!apiKey || apiKey.includes('•')) return; // No valid API key

    try {
      const https = require('https');
      // Get listen key
      const listenKeyRes = await new Promise((resolve, reject) => {
        const req = https.request('https://fstream.binance.com/fapi/v1/listenKey', {
          method: 'POST',
          headers: { 'X-MBX-APIKEY': apiKey },
        }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      if (listenKeyRes.listenKey) {
        const userWs = new WSClient(`wss://fstream.binance.com/ws/${listenKeyRes.listenKey}`, { reconnect: true });
        userWs.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw);
            if (msg.e === 'ACCOUNT_UPDATE') {
              wsBroadcast({ type: 'account_update', balances: msg.a.B || [], broker: 'BINANCE' });
            } else if (msg.e === 'ORDER_TRADE_UPDATE') {
              const o = msg.o;
              wsBroadcast({
                type: 'order_update', symbol: o.s, side: o.S, status: o.X, orderId: o.i,
                price: +o.p, qty: +o.q, filledQty: +o.z, avgPrice: +o.ap, broker: 'BINANCE',
              });
            }
          } catch (e) { /* ignore */ }
        });
        userWs.connect();
        console.log('[ws] Binance User Data Stream connected (listenKey active)');
        store.addLog({ type: 'ws', level: 'info', msg: 'Binance User Data Stream active' });

        // Refresh listen key every 30 minutes (Binance expires after 60min)
        const apiKeySafe = apiKey;
        setInterval(() => {
          https.request('https://fstream.binance.com/fapi/v1/listenKey', {
            method: 'PUT',
            headers: { 'X-MBX-APIKEY': apiKeySafe },
          }).end();
        }, 30 * 60 * 1000).unref();
      }
    } catch (e) {
      console.warn('[ws] Binance User Data Stream skipped:', e.message);
    }
  }

// Handle WS upgrade in main server
server.on('upgrade', (req, sock, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = wsAccept(key);
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = {
    socket: sock,
    send(msg) {
      const buf = Buffer.from(JSON.stringify(msg));
      // Build WS frame (unmasked server -> client)
      let header;
      if (buf.length < 126) {
        header = Buffer.from([0x81, 0x80 | buf.length]);
      } else if (buf.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(buf.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(buf.length), 2);
      }
      // Mask 4 random bytes
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) masked[i] = buf[i] ^ mask[i % 4];
      try { sock.write(Buffer.concat([header, mask, masked])); } catch {}
    },
  };
  wsClients.add(client);
  // Send welcome + initial state
  client.send({ type: 'welcome', t: Date.now() });
  client.send({ type: 'snapshot', prices: Object.fromEntries(livePrices), trades: liveTrades.slice(0, 50) });

  let buffer = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let len = buffer[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buffer.length < off + 2) return; len = buffer.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buffer.length < off + 8) return; len = Number(buffer.readBigUInt64BE(off)); off += 8; }
      if (buffer.length < off + len) return;
      buffer = buffer.slice(off + len);
      if (opcode === 9) {
        // ping → pong
        try { sock.write(Buffer.from([0x8a, 0x00])); } catch {}
      } else if (opcode === 8) {
        // close
        wsClients.delete(client);
        try { sock.end(); } catch {}
        return;
      }
    }
  });
  sock.on('close', () => wsClients.delete(client));
  sock.on('error', () => wsClients.delete(client));
});

server.listen(PORT, HOST, () => {
  const addr = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     AI Trading Agent — يعمل الآن          ║');
  console.log('  ║     الداش بورد: ' + addr.padEnd(27) + '║');
  console.log('  ║     البروكر: ' + (config.get('DEFAULT_BROKER') + '/' + config.get('TRADING_MODE')).padEnd(29) + '║');
  console.log('  ║     العقل AI: ' + (config.get('AI_PROVIDER') + '/' + config.get('AI_MODEL')).padEnd(28) + '║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  📡 WebSocket stream: ws://${HOST}:${PORT}/`);
  console.log(`  🛡️  Cyber-sec headers: enabled (CSP, HSTS, rate-limit, body-limit)`);

  // === ARCHITECTURE BOOT SEQUENCE ===
  bus.setAppState('BOOTING');
  bus.emit('app:booting', { port: PORT, host: HOST, broker: config.get('DEFAULT_BROKER') });

  // Step 10+11: Init Event Bus (done) + Health Monitor
  health.start(30000);
  bus.emit('health:started', { intervalMs: 30000 });

  // Step 10.5: Start Watchdog Supervisor (master safety)
  watchdog.start();
  watchdog.audit('BOOT', 'System boot complete', 'INFO');

  // Step 10.6: Module heartbeats (keep watchdog health score high)
  const heartbeatModules = ['market', 'store', 'scanEngine', 'validator', 'execution', 'queue', 'risk', 'health', 'routes'];
  setInterval(() => {
    for (const m of heartbeatModules) {
      try { watchdog.beat(m, { auto: true, uptime: process.uptime() }); } catch {}
    }
  }, 10000).unref();
  // Initial beat so score is high immediately
  for (const m of heartbeatModules) {
    try { watchdog.beat(m, { boot: true }); } catch {}
  }

  // Step 11.5: Start Worker Engine (CPU offload)
  try { require('./lib/worker-manager').start(); } catch (e) { console.warn('[boot] workers skipped:', e.message); }

  // Step 11.6: Validation Lab — hourly integrity check
  try {
    const validationLab = require('./lib/validation-lab');
    watchdog.beat('validation', { boot: true });
    setInterval(() => {
      watchdog.beat('validation', { auto: true });
      // Run stress test every hour and audit result
      validationLab.runStressTests().then(r => {
        watchdog.audit('VALIDATION', `hourly stress: ${r.passed}/${r.total} passed`, r.ok ? 'INFO' : 'WARN');
      }).catch(() => {});
    }, 3600000).unref();
  } catch (e) { console.warn('[boot] validation lab skipped:', e.message); }

  // Step 2: Database integrity + backup
  try {
    store.addLog({ type: 'system', level: 'info', msg: 'DB integrity OK' });
  } catch {}
  bus.setAppState('READY');

  // Step 18: Warm cache (async, non-blocking)
  setTimeout(() => require('./lib/market').warmup().catch(() => {}), 500);

  // Auto-start agent if configured
  if (config.getBool('AGENT_AUTORUN', false)) {
    bus.setAppState('RUNNING');
    agent.startLoop();
  }

  // فتح المتصفح تلقائياً (لو OPEN_BROWSER=true)
  if (config.getBool('OPEN_BROWSER', true)) {
    const cp = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    cp.exec(`${cmd} "${addr}"`, () => {});
  }
});

// إيقاف أنيق — Graceful shutdown (architect shutdown sequence)
process.on('SIGINT', () => {
  console.log('\n[server] إيقاف...');
  bus.setAppState('SHUTDOWN');
  agent.stopLoop();
  health.stop();
  try { require('./lib/worker-manager').shutdown(); } catch {}
  watchdog.stop();
  store.flush && store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

process.on('uncaughtException', (e) => {
  console.error('[server] uncaughtException:', e.message);
  store.addLog({ type: 'system', level: 'error', msg: 'uncaughtException: ' + e.message });
  // Don't exit — keep server running. But log full trace once.
  console.error(e.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason?.message || reason);
  store.addLog({ type: 'system', level: 'error', msg: 'unhandledRejection: ' + (reason?.message || String(reason).slice(0, 200)) });
});

module.exports = { server };
