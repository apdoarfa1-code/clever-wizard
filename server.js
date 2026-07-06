#!/usr/bin/env node
'use strict';
/*
 * server.js — سيرفر Node.js محلي للبرنامج
 * صفر مكتبات خارجية: http + fs + path + crypto فقط.
 * يشتغل بأمر: node server.js أو ./start.sh
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const config = require('./lib/config');
const store = require('./lib/store');
const routes = require('./lib/routes');
const agent = require('./lib/agent');
const telegram = require('./lib/telegram');

const PORT = config.getNum('PORT', 8080);
const HOST = config.get('HOST', '127.0.0.1');

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

// ---- تشغيل تلقائي للتليجرام commands كل 15 ثانية ----
setInterval(() => {
  telegram.processCommands().catch(e => console.error('[TG poll]', e.message));
}, 15000);

// ---- بدء حلقة العقل لو autorun = true ----
if (config.getBool('AGENT_AUTORUN', false)) {
  console.log('[server] حلقة العقل التلقائية مفعّلة');
  agent.startLoop();
}

// ---- إنشاء السيرفر ----
const server = http.createServer((req, res) => {
  const method = req.method;
  const url = req.url;

  // قراءة الـ body
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');

    // API routes
    if (url.startsWith('/api/')) {
      routes.handleRequest(method, url, req.headers, body).then(result => {
        if (!result) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      }).catch(e => {
        console.error('[server] API error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // Static files
    let filePath = url === '/' ? '/index.html' : url;
    // أمن: منع directory traversal
    const safePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(ROOT, safePath);

    if (!fullPath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not Found'); }
        else { res.writeHead(500); res.end('Server Error'); }
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
    });
  });
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

  // فتح المتصفح تلقائياً (لو OPEN_BROWSER=true)
  if (config.getBool('OPEN_BROWSER', true)) {
    const cp = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    cp.exec(`${cmd} "${addr}"`, () => {});
  }
});

// إيقاف أنيق
process.on('SIGINT', () => {
  console.log('\n[server] إيقاف...');
  agent.stopLoop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

process.on('uncaughtException', (e) => {
  console.error('[server] خطأ غير متوقع:', e.message);
  store.addLog({ type: 'system', level: 'error', msg: e.message });
});

module.exports = { server };
