'use strict';
/*
 * http.js — عميل HTTP/HTTPS بدون مكتبات خارجية (Node.js مدمج)
 */
const https = require('https');
const http = require('http');

function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      return reject(new Error('Invalid URL protocol'));
    }
    const isHttps = url.startsWith('https');
    const mod = isHttps ? https : http;
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('Bad URL')); }
    const method = (opts.method || 'GET').toUpperCase();
    const userAgent = opts.userAgent || `python-requests/2.31.0`;
    const headers = { ...(opts.headers || {}), 'User-Agent': userAgent, 'Accept': 'application/json' };
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const bodyStr = opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    // لا نضع Host — Node.js يضعه تلقائيًا من hostname + port

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: opts.timeout || 6000,
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
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
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
