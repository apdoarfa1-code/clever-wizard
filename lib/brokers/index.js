'use strict';
/*
 * brokers/index.js — واجهة موحّدة: تختار البروكر حسب الإعدادات
 * binance | bybit | metaapi | paper
 */
const config = require('../config');

function getBroker(name) {
  const mode = config.get('TRADING_MODE', 'paper');
  const brokerName = name || config.get('DEFAULT_BROKER', 'paper');

  // إذا الوضع paper أو البروكر غير مضبوط → paper
  if (mode === 'paper' || brokerName === 'paper') return require('./paper');

  // إذا البروكر مش مضبوط مفاتيحه → paper
  if (brokerName === 'binance' && !config.isConfigured('BINANCE_API_KEY')) {
    console.log('[brokers] Binance مفاتيح غير مضبوطة → fallback لـ paper');
    return require('./paper');
  }
  if (brokerName === 'bybit' && !config.isConfigured('BYBIT_API_KEY')) {
    console.log('[brokers] Bybit مفاتيح غير مضبوطة → fallback لـ paper');
    return require('./paper');
  }
  if (brokerName === 'metaapi' && !config.isConfigured('METAAPI_TOKEN')) {
    console.log('[brokers] MetaApi مفاتيح غير مضبوطة → fallback لـ paper');
    return require('./paper');
  }

  switch (brokerName) {
    case 'binance': return require('./binance');
    case 'bybit': return require('./bybit');
    case 'metaapi': return require('./metaapi');
    default:
      console.log(`[brokers] بروكر غير معروف "${brokerName}" → fallback لـ paper`);
      return require('./paper');
  }
}

async function getAvailableBrokers() {
  const list = [];
  list.push({ name: 'paper', label: 'تداول وهمي (Paper)', ok: true, configured: true });
  if (config.isConfigured('BINANCE_API_KEY')) list.push({ name: 'binance', label: 'Binance', ok: true, configured: true });
  else list.push({ name: 'binance', label: 'Binance', ok: false, configured: false });
  if (config.isConfigured('BYBIT_API_KEY')) list.push({ name: 'bybit', label: 'Bybit', ok: true, configured: true });
  else list.push({ name: 'bybit', label: 'Bybit', ok: false, configured: false });
  if (config.isConfigured('METAAPI_TOKEN')) list.push({ name: 'metaapi', label: 'MetaTrader 5', ok: true, configured: true });
  else list.push({ name: 'metaapi', label: 'MetaTrader 5', ok: false, configured: false });
  return list;
}

module.exports = { getBroker, getAvailableBrokers };
