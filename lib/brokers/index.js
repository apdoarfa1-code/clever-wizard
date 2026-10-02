'use strict';
const config = require('../config');

// PRIMARY: bybit (main) + binance (backup) + paper (dev/test)
// ALL OTHER BROKERS DISABLED per architecture mandate
const REGISTRY = {
  bybit:      { file: './bybit',       key: 'BYBIT_API_KEY',       label: 'Bybit',                   region: 'global', active: true },
  binance:    { file: './binance',     key: 'BINANCE_API_KEY',     label: 'Binance',                 region: 'global', active: true },
  paper:      { file: './paper',       key: null,                  label: 'تداول وهمي (Paper)',     region: 'global', active: true },
  metaapi:    { file: './metaapi',     key: 'METAAPI_TOKEN',       label: 'MetaTrader 5',            region: 'global', active: false },
  coinbase:   { file: './coinbase',    key: 'COINBASE_API_KEY',    label: 'Coinbase Advanced',       region: 'us',      active: false },
  kraken:     { file: './kraken',      key: 'KRAKEN_API_KEY',      label: 'Kraken',                  region: 'us',      active: false },
  alpaca:     { file: './alpaca',      key: 'ALPACA_API_KEY',      label: 'Alpaca Crypto',           region: 'us',      active: false },
  gemini:     { file: './gemini',      key: 'GEMINI_API_KEY',      label: 'Gemini',                  region: 'us',      active: false },
  robinhood:  { file: './robinhood',   key: 'ROBINHOOD_TOKEN',     label: 'Robinhood Crypto',        region: 'us',      active: false },
  ibkr:       { file: './ibkr',        key: 'IBKR_TOKEN',          label: 'Interactive Brokers',     region: 'us',      active: false },
  tradovate:  { file: './tradovate',   key: 'TRADOVATE_USERNAME',  label: 'Tradovate Futures',       region: 'us',      active: false },
  tradestation:{ file: './tradestation', key: 'TRADESTATION_CLIENT_ID', label: 'TradeStation',         region: 'us',      active: false },
  webull:     { file: './webull',      key: 'WEBULL_TOKEN',        label: 'Webull',                  region: 'us',      active: false },
  oanda:      { file: './oanda',       key: 'OANDA_API_KEY',       label: 'OANDA Forex',             region: 'us',      active: false },
};

function getBroker(name) {
  const mode = config.get('TRADING_MODE', 'paper');
  const brokerName = (name || config.get('DEFAULT_BROKER', 'paper')).toLowerCase();

  // Paper/dev mode always returns paper
  if (mode === 'paper' || brokerName === 'paper') {
    if (mode !== 'paper') console.warn('[broker] trading mode=paper — all trades are simulated');
    return require('./paper');
  }

  const entry = REGISTRY[brokerName];
  if (!entry) {
    console.warn(`[broker] unknown "${brokerName}" — fallback to paper`);
    return require('./paper');
  }
  if (!entry.active) {
    console.warn(`[broker] "{$brokerName}" is disabled — fallback to paper`);
    return require('./paper');
  }

  // Live mode validation
  if (mode === 'live' && entry.key && !config.isConfigured(entry.key)) {
    throw new Error(`[broker] LIVE mode requires ${entry.key} for ${brokerName}`);
  }
  if (entry.key && !config.isConfigured(entry.key)) {
    console.warn(`[broker] ${brokerName} keys not configured — fallback to paper`);
    return require('./paper');
  }
  return require(entry.file);
}

async function getAvailableBrokers() {
  const list = [];
  for (const [name, entry] of Object.entries(REGISTRY)) {
    if (!entry.active) continue; // disabled brokers are not shown
    if (name === 'paper') {
      list.push({ name, label: entry.label, ok: true, configured: true, region: entry.region, active: true });
    } else {
      const configured = entry.key ? config.isConfigured(entry.key) : true;
      list.push({ name, label: entry.label, ok: configured, configured, region: entry.region, active: entry.active });
    }
  }
  return list;
}

async function getUSBrokers() { return (await getAvailableBrokers()).filter(b => b.region === 'us'); }
async function getGlobalBrokers() { return (await getAvailableBrokers()).filter(b => b.region === 'global'); }

module.exports = { getBroker, getAvailableBrokers, getUSBrokers, getGlobalBrokers, REGISTRY };
