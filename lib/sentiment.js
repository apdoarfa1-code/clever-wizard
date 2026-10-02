'use strict';
// sentiment.js — News sentiment (CryptoCompare + alternative.me Fear&Greed)
const httpLib = require('./http');
const config = require('./config');

async function getFearGreedIndex() {
  if (!config.getBool('NEWS_SENTIMENT_ENABLED', true)) return { value: 50, classification: 'Neutral', ok: true };
  const r = await httpLib.get('https://api.alternative.me/fng/?limit=1');
  if (!r.ok) return { value: 50, classification: 'Neutral', ok: false };
  const d = r.json?.data?.[0] || {};
  return { value: +d.value || 50, classification: d.value_classification || 'Neutral', ok: true };
}

async function getNewsSentiment(symbol = 'BTC') {
  try {
    const r = await httpLib.get(`https://min-api.cryptocompare.com/data/v2/news/?categories=${symbol}&lang=EN`);
    const articles = r.ok ? (r.json?.Data || []).slice(0, 10) : [];
    const sentiment = articles.length
      ? articles.reduce((s, a) => {
        const t = (a.body || '') + ' ' + (a.title || '');
        const positive = /bull|pump|surge|rally|gain|up|green|breakthrough|high|support|adopt/i.test(t) ? 1 : 0;
        const negative = /bear|dump|crash|fall|loss|down|red|hack|ban|fraud|sell|warning|risk/i.test(t) ? -1 : 0;
        return s + positive + negative;
      }, 0) / articles.length
      : 0;
    return { score: +sentiment.toFixed(2), count: articles.length, ok: r.ok };
  } catch { return { score: 0, count: 0, ok: false }; }
}

function assessMarketRisk(fearGreed) {
  if (!config.getBool('NEWS_SENTIMENT_ENABLED', true)) return { safe: true, reason: 'disabled' };
  const threshold = +config.get('FEAR_GREED_THRESHOLD', '15');
  // For scalping: only block at extreme values (not mild fear)
  if (fearGreed.value <= threshold) return { safe: false, reason: 'extreme fear — scalping blocked' };
  if (fearGreed.value >= 95) return { safe: false, reason: 'extreme greed — scalping blocked (bubble risk)' };
  return { safe: true, reason: 'safe for scalping' };
}

async function getFullSnapshot(symbol) {
  const [fg, news] = await Promise.all([getFearGreedIndex(), getNewsSentiment((symbol || 'BTC').replace('USDT','').replace('USD',''))]);
  const risk = assessMarketRisk(fg);
  return { fearGreed: fg, news, risk, symbol };
}

module.exports = { getFearGreedIndex, getNewsSentiment, assessMarketRisk, getFullSnapshot };
