'use strict';
/*
 * http.js — عميل HTTP/HTTPS بدون مكتبات خارجية (Node.js مدمج)
 */
const https = require('https');
const http = require('http');

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const mod = isHttps ? https : http;
    const parsed = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { ...(opts.headers || {}), 'User-Agent': 'AI-Trading-Agent/1.0' };
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const bodyStr = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    headers['Host'] = parsed.host;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          raw,
          json,
          ok: res.statusCode >= 200 && res.statusCode < 300,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const httpLib = {
  get(url, headers) { return request(url, { method: 'GET', headers }); },
  post(url, body, headers) { return request(url, { method: 'POST', body, headers }); },
  put(url, body, headers) { return request(url, { method: 'PUT', body, headers }); },
  delete(url, headers) { return request(url, { method: 'DELETE', headers }); },
  request,
};

module.exports = httpLib;
