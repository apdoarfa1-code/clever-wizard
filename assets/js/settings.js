'use strict';
const Settings = {
  init() {
    this.bindSections();
    this.loadConfig();
  },

  bindSections() {
    document.querySelectorAll('.settings-section-header').forEach(h => {
      h.addEventListener('click', () => {
        const section = h.parentElement; // .settings-section
        const body = section.querySelector('.settings-section-body');
        section.classList.toggle('open');
      });
    });
  },

  async loadConfig() {
    try {
      const data = await App.api('/api/config');
      const c = data.config || {};
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v || ''; };
      set('setBinanceKey', c.BINANCE_API_KEY); set('setBinanceSecret', c.BINANCE_API_SECRET); set('setBinanceTestnet', c.BINANCE_TESTNET);
      set('setBybitKey', c.BYBIT_API_KEY); set('setBybitSecret', c.BYBIT_API_SECRET); set('setBybitTestnet', c.BYBIT_TESTNET);
      set('setMetaApiToken', c.METAAPI_TOKEN); set('setMetaApiAccountId', c.METAAPI_ACCOUNT_ID);
      set('setAiProvider', c.AI_PROVIDER); set('setAiBaseUrl', c.AI_BASE_URL); set('setAiKey', c.AI_API_KEY);
      set('setAiModel', c.AI_MODEL); set('setAiTemp', c.AI_TEMPERATURE); set('setMinConf', c.MIN_CONFIDENCE);
      set('setTgToken', c.TELEGRAM_BOT_TOKEN); set('setTgChatId', c.TELEGRAM_CHAT_ID);
      set('setRiskPos', c.RISK_POSITION_PCT); set('setRiskDailyLoss', c.RISK_DAILY_LOSS_PCT);
      set('setRiskMaxOpen', c.RISK_MAX_OPEN_POSITIONS); set('setRiskSl', c.RISK_DEFAULT_SL); set('setRiskTp', c.RISK_DEFAULT_TP);
      set('setSymbols', c.WATCH_SYMBOLS); set('setTimeframe', c.AGENT_TIMEFRAME);
      set('setMetaApiMode', c.METAAPI_MODE || 'demo'); set('setMetaApiLogin', c.METAAPI_LOGIN);
      // toggle states
      document.getElementById('toggleAutorun')?.classList.toggle('active', c.AGENT_AUTORUN === 'true');
    } catch (e) {}
  },

  async selectBroker(name) {
    // اجمع مدخلات البطاقة لو موجودة قبل الإرسال
    const vals = { DEFAULT_BROKER: name };
    if (name === 'binance') {
      vals.BINANCE_API_KEY = v('setBinanceKey'); vals.BINANCE_API_SECRET = v('setBinanceSecret'); vals.BINANCE_TESTNET = v('setBinanceTestnet');
    }
    if (name === 'bybit') {
      vals.BYBIT_API_KEY = v('setBybitKey'); vals.BYBIT_API_SECRET = v('setBybitSecret'); vals.BYBIT_TESTNET = v('setBybitTestnet');
    }
    if (name === 'metaapi') {
      vals.METAAPI_TOKEN = v('setMetaApiToken'); vals.METAAPI_ACCOUNT_ID = v('setMetaApiAccountId');
      vals.METAAPI_MODE = v('setMetaApiMode'); vals.METAAPI_LOGIN = v('setMetaApiLogin');
    }
    try {
      await App.api('/api/config', { method: 'POST', body: vals });
      // تحديث active card
      document.querySelectorAll('.broker-card').forEach(c => c.classList.remove('active'));
      document.getElementById('brokerCard-' + name)?.classList.add('active');
      App.toast(`✅ ${name}`, 'success');
    } catch {}
    function v(id) { return document.getElementById(id)?.value || ''; }
  },

  async saveSection(section) {
    const v = (id) => document.getElementById(id)?.value || '';
    let vals = {};
    if (section === 'ai') { vals = { AI_PROVIDER: v('setAiProvider'), AI_BASE_URL: v('setAiBaseUrl'), AI_API_KEY: v('setAiKey'), AI_MODEL: v('setAiModel'), AI_TEMPERATURE: v('setAiTemp'), MIN_CONFIDENCE: v('setMinConf') }; }
    if (section === 'telegram') { vals = { TELEGRAM_BOT_TOKEN: v('setTgToken'), TELEGRAM_CHAT_ID: v('setTgChatId') }; }
    if (section === 'risk') { vals = { RISK_POSITION_PCT: v('setRiskPos'), RISK_DAILY_LOSS_PCT: v('setRiskDailyLoss'), RISK_MAX_OPEN_POSITIONS: v('setRiskMaxOpen'), RISK_DEFAULT_SL: v('setRiskSl'), RISK_DEFAULT_TP: v('setRiskTp') }; }
    if (section === 'bot') { vals = { WATCH_SYMBOLS: v('setSymbols'), AGENT_TIMEFRAME: v('setTimeframe') }; }
    try {
      await App.api('/api/config', { method: 'POST', body: vals });
      App.toast('💾 ' + (App.state.lang === 'ar' ? 'تم الحفظ' : 'Saved'), 'success');
    } catch {}
  },

  async testConnection(type) {
    App.toast('🔗 ' + (App.state.lang === 'ar' ? 'فحص...' : 'Testing...'), 'info');
    await App.loadHealth();
    const h = App.state.health; if (!h) return;
    if (type === 'ai') h.ai?.ok ? App.toast(`✅ AI: ${h.ai.model}`, 'success') : App.toast('❌ AI: ' + (h.ai?.error || ''), 'error');
    if (type === 'telegram') h.telegram?.ok ? App.toast(`✅ TG: @${h.telegram.bot?.username}`, 'success') : App.toast('❌ TG: ' + (h.telegram?.error || ''), 'error');
    if (type === 'broker') h.broker?.ok ? App.toast('✅ ' + (App.state.lang === 'ar' ? 'البروكر متصل' : 'Broker OK'), 'success') : App.toast('❌ Broker: ' + (h.broker?.error || ''), 'error');
  },

  async sendTestTg() {
    try {
      await App.api('/api/telegram/test', { method: 'POST' });
      App.toast('📨 ' + (App.state.lang === 'ar' ? 'تم الإرسال' : 'Sent'), 'success');
    } catch {}
  },
};
