'use strict';
/*
 * config.js — إدارة الإعدادات (env + ملف إعدادات محلي قابل للتعديل من الواجهة)
 * صفر مكتبات خارجية: fs/path فقط.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

const ENV_DEFAULTS = {
  // AI
  AI_PROVIDER: 'openai',
  AI_API_KEY: '',
  AI_BASE_URL: 'https://api.openai.com/v1',
  AI_MODEL: 'gpt-4o-mini',
  AI_TEMPERATURE: '0.2',
  MIN_CONFIDENCE: '0.6',
  // Broker
  DEFAULT_BROKER: 'binance',
  TRADING_MODE: 'paper',
  BINANCE_API_KEY: '', BINANCE_API_SECRET: '', BINANCE_TESTNET: 'false',
  BYBIT_API_KEY: '', BYBIT_API_SECRET: '', BYBIT_TESTNET: 'false',
  METAAPI_TOKEN: '', METAAPI_ACCOUNT_ID: '',
  MARKET_DATA_SOURCE: 'binance',
  // Telegram
  TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_WEBHOOK_SECRET: '', DEPLOY_URL: '',
  // Risk
  RISK_POSITION_PCT: '0.02', RISK_DAILY_LOSS_PCT: '0.05',
  RISK_MAX_OPEN_POSITIONS: '5', RISK_DEFAULT_SL: '0.01', RISK_DEFAULT_TP: '0.02',
  // Symbols / schedule
  WATCH_SYMBOLS: 'BTCUSDT,ETHUSDT,SOLUSDT',
  AGENT_TIMEFRAME: '15m', AGENT_AUTORUN: 'false',
  // Ultra-low latency scalping
  TICK_MS: '1500',
  SCALP_DURATIONS: '5s,10s,15s',
  SCALP_AUTO_CLOSE: 'true',
  STRICT_CONFIRM: 'true',
  // MetaApi mode
  METAAPI_MODE: 'demo',
  METAAPI_LOGIN: '',
  // KV (غير مستخدم محلياً)
  KV_REST_API_URL: '', KV_REST_API_TOKEN: '',
  // Security
  LIVE_UNLOCK_PASSWORD: '', SETTINGS_PASSWORD: '',
  // Local server
  PORT: '8080', HOST: '127.0.0.1',
  OPEN_BROWSER: 'false',
};

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  }
  return out;
}

let _fileSettings = {};
function loadFileSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      _fileSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    _fileSettings = {};
    console.error('[config] settings.json تالف، سيتم تجاهله:', e.message);
  }
}
loadFileSettings();

function saveFileSettings(obj) {
  _fileSettings = { ..._fileSettings, ...obj };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(_fileSettings, null, 2), 'utf8');
  return _fileSettings;
}

function getRaw(key, fallback) {
  if (key in _fileSettings && _fileSettings[key] !== undefined && _fileSettings[key] !== '') return _fileSettings[key];
  const env = loadEnvFile();
  if (key in env && env[key] !== '') return env[key];
  if (key in process.env && process.env[key] !== '') return process.env[key];
  if (key in ENV_DEFAULTS) return ENV_DEFAULTS[key];
  return fallback;
}

const config = {
  get(key, fallback) {
    const v = getRaw(key, fallback);
    return v;
  },
  getNum(key, fallback = 0) {
    const n = Number(getRaw(key, fallback));
    return Number.isFinite(n) ? n : fallback;
  },
  getBool(key, fallback = false) {
    const v = String(getRaw(key, fallback)).toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  },
  getList(key, fallback = []) {
    const v = getRaw(key, '');
    if (!v) return fallback;
    return String(v).split(',').map(s => s.trim()).filter(Boolean);
  },
  set(key, value) {
    _fileSettings[key] = value;
    saveFileSettings({ [key]: value });
  },
  setMany(obj) {
    return saveFileSettings(obj);
  },
  all() {
    const env = loadEnvFile();
    const merged = { ...ENV_DEFAULTS, ...env, ...process.env, ..._fileSettings };
    // إخفاء الأسرار جزئياً عند العرض
    return merged;
  },
  publicView() {
    const a = config.all();
    const masked = { ...a };
    const secrets = ['AI_API_KEY', 'BINANCE_API_SECRET', 'BYBIT_API_SECRET', 'METAAPI_TOKEN', 'TELEGRAM_BOT_TOKEN', 'LIVE_UNLOCK_PASSWORD', 'SETTINGS_PASSWORD'];
    for (const s of secrets) {
      if (masked[s] && String(masked[s]).length > 4) masked[s] = String(masked[s]).slice(0, 3) + '••••';
    }
    return masked;
  },
  isConfigured(key) {
    const v = getRaw(key, '');
    return v !== '' && v !== undefined && v !== null;
  },
  SETTINGS_FILE,
  ROOT,
};

module.exports = config;
