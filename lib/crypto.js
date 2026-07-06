'use strict';
/*
 * crypto.js — HMAC-SHA256 لتوقيع طلبات البروكر (بدون مكتبات خارجية)
 * يستخدم crypto المدمج في Node.js فقط.
 */
const crypto = require('crypto');

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

function hmacSha256Base64(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('base64');
}

function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function queryString(params) {
  return Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
}

function signBinance(params, secret) {
  const qs = queryString(params);
  const sig = hmacSha256(secret, qs);
  return { queryString: qs + '&signature=' + sig };
}

function signBybit(params, timestamp, apiKey, secret) {
  const pre = timestamp + apiKey + '5000';
  const paramStr = queryString(params);
  const toSign = paramStr ? pre + paramStr : pre;
  return hmacSha256Base64(secret, toSign);
}

module.exports = { hmacSha256, hmacSha256Base64, getTimestamp, queryString, signBinance, signBybit };
