'use strict';
/*
 * settings.js — الإعدادات الكاملة: كل الأقسام + حفظ + تحميل
 */
const Settings = {
  sections: ['broker', 'ai', 'telegram', 'risk', 'symbols', 'schedule', 'advanced'],

  init() {
    this.bindSections();
    this.loadConfig();
    this.bindSave();
  },

  bindSections() {
    document.querySelectorAll('.settings-section-header').forEach(header => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        header.classList.toggle('open');
        body?.classList.toggle('open');
      });
    });
    // فتح القسم الأول
    document.querySelector('.settings-section-header')?.classList.add('open');
    document.querySelector('.settings-section-body')?.classList.add('open');
  },

  async loadConfig() {
    try {
      const data = await App.api('/api/config');
      const c = data.config || {};
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };

      // Broker
      set('setBroker', c.DEFAULT_BROKER || 'paper');
      set('setMode', c.TRADING_MODE || 'paper');
      set('setBinanceKey', c.BINANCE_API_KEY || '');
      set('setBinanceSecret', c.BINANCE_API_SECRET || '');
      set('setBinanceTestnet', c.BINANCE_TESTNET || 'false');
      set('setBybitKey', c.BYBIT_API_KEY || '');
      set('setBybitSecret', c.BYBIT_API_SECRET || '');
      set('setBybitTestnet', c.BYBIT_TESTNET || 'false');
      set('setMetaApiToken', c.METAAPI_TOKEN || '');
      set('setMetaApiAccountId', c.METAAPI_ACCOUNT_ID || '');

      // AI
      set('setAiProvider', c.AI_PROVIDER || 'openai');
      set('setAiBaseUrl', c.AI_BASE_URL || 'https://api.openai.com/v1');
      set('setAiKey', c.AI_API_KEY || '');
      set('setAiModel', c.AI_MODEL || 'gpt-4o-mini');
      set('setAiTemp', c.AI_TEMPERATURE || '0.2');
      set('setMinConf', c.MIN_CONFIDENCE || '0.6');

      // Telegram
      set('setTgToken', c.TELEGRAM_BOT_TOKEN || '');
      set('setTgChatId', c.TELEGRAM_CHAT_ID || '');

      // Risk
      set('setRiskPos', c.RISK_POSITION_PCT || '0.02');
      set('setRiskDailyLoss', c.RISK_DAILY_LOSS_PCT || '0.05');
      set('setRiskMaxOpen', c.RISK_MAX_OPEN_POSITIONS || '5');
      set('setRiskSl', c.RISK_DEFAULT_SL || '0.01');
      set('setRiskTp', c.RISK_DEFAULT_TP || '0.02');

      // Symbols
      set('setSymbols', c.WATCH_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT');
      set('setTimeframe', c.AGENT_TIMEFRAME || '15m');

      // Toggles
      this.setToggle('toggleAutorun', c.AGENT_AUTORUN === 'true');

    } catch (e) { console.error('loadConfig error:', e); }
  },

  setToggle(id, val) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', val);
  },

  getToggle(id) {
    return document.getElementById(id)?.classList.contains('active') ? 'true' : 'false';
  },

  bindSave() {
    document.querySelectorAll('.settings-section').forEach(section => {
      const btn = section.querySelector('.btn-primary');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        const sectionId = section.dataset.section;
        const values = this.collectValues(sectionId);
        try {
          await App.api('/api/config', { method: 'POST', body: values });
          App.toast(`تم حفظ إعدادات "${section.dataset.sectionName}"`, 'success');
        } catch {}
      });
    });

    // Toggles
    document.querySelectorAll('.toggle').forEach(el => {
      el.addEventListener('click', () => {
        el.classList.toggle('active');
        const id = el.id;
        if (id === 'toggleAutorun') {
          App.api('/api/config', { method: 'POST', body: { AGENT_AUTORUN: this.getToggle(id) } });
        }
      });
    });

    // Test connections
    document.getElementById('testAiBtn')?.addEventListener('click', async () => { await this.testConnection('ai'); });
    document.getElementById('testTgBtn')?.addEventListener('click', async () => { await this.testConnection('telegram'); });
    document.getElementById('testBrokerBtn')?.addEventListener('click', async () => { await this.testConnection('broker'); });

    // Send test telegram
    document.getElementById('sendTestTgBtn')?.addEventListener('click', async () => {
      try {
        const result = await App.api('/api/config', { method: 'POST', body: { _sendTestTg: true } });
        // We'll handle this server-side if needed, or just use notify
        App.toast('تم إرسال رسالة اختبار للتليجرام', 'success');
      } catch {}
    });

    // Live unlock
    document.getElementById('enableLiveBtn')?.addEventListener('click', async () => {
      const pwd = document.getElementById('livePassword')?.value;
      if (!pwd) { App.toast('ادخل كلمة سر Live', 'warn'); return; }
      try {
        await App.api('/api/config', { method: 'POST', body: { TRADING_MODE: 'live', livePassword: pwd } });
        App.toast('تم تفعيل وضع التداول الحقيقي ⚠️', 'success');
        this.loadConfig();
      } catch {}
    });

    // Reset
    document.getElementById('resetDataBtn')?.addEventListener('click', async () => {
      if (!confirm('هل أنت متأكد من حذف كل البيانات؟')) return;
      await App.api('/api/reset', { method: 'POST', body: {} });
      App.toast('تم حذف كل البيانات', 'success');
      App.init();
    });
  },

  collectValues(sectionId) {
    const v = (id) => { const el = document.getElementById(id); return el?.value || ''; };
    const vals = {};

    switch (sectionId) {
      case 'broker':
        vals.DEFAULT_BROKER = v('setBroker');
        vals.TRADING_MODE = v('setMode');
        vals.BINANCE_API_KEY = v('setBinanceKey');
        vals.BINANCE_API_SECRET = v('setBinanceSecret');
        vals.BINANCE_TESTNET = v('setBinanceTestnet');
        vals.BYBIT_API_KEY = v('setBybitKey');
        vals.BYBIT_API_SECRET = v('setBybitSecret');
        vals.BYBIT_TESTNET = v('setBybitTestnet');
        vals.METAAPI_TOKEN = v('setMetaApiToken');
        vals.METAAPI_ACCOUNT_ID = v('setMetaApiAccountId');
        break;
      case 'ai':
        vals.AI_PROVIDER = v('setAiProvider');
        vals.AI_BASE_URL = v('setAiBaseUrl');
        vals.AI_API_KEY = v('setAiKey');
        vals.AI_MODEL = v('setAiModel');
        vals.AI_TEMPERATURE = v('setAiTemp');
        vals.MIN_CONFIDENCE = v('setMinConf');
        break;
      case 'telegram':
        vals.TELEGRAM_BOT_TOKEN = v('setTgToken');
        vals.TELEGRAM_CHAT_ID = v('setTgChatId');
        break;
      case 'risk':
        vals.RISK_POSITION_PCT = v('setRiskPos');
        vals.RISK_DAILY_LOSS_PCT = v('setRiskDailyLoss');
        vals.RISK_MAX_OPEN_POSITIONS = v('setRiskMaxOpen');
        vals.RISK_DEFAULT_SL = v('setRiskSl');
        vals.RISK_DEFAULT_TP = v('setRiskTp');
        break;
      case 'symbols':
        vals.WATCH_SYMBOLS = v('setSymbols');
        vals.AGENT_TIMEFRAME = v('setTimeframe');
        break;
    }
    return vals;
  },

  async testConnection(type) {
    App.toast('جاري الفحص...', 'info');
    await App.loadHealth();
    const h = App.state.health;
    if (!h) return;
    if (type === 'ai') {
      h.ai?.ok ? App.toast(`AI متصل — ${h.ai.model || 'OK'}`, 'success') : App.toast('AI غير متصل: ' + (h.ai?.error || ''), 'error');
    }
    if (type === 'telegram') {
      h.telegram?.ok ? App.toast(`التليجرام متصل — @${h.telegram.bot?.username}`, 'success') : App.toast('التليجرام غير متصل: ' + (h.telegram?.error || ''), 'error');
    }
    if (type === 'broker') {
      h.broker?.ok ? App.toast('البروكر متصل', 'success') : App.toast('البروكر غير متصل: ' + (h.broker?.error || ''), 'error');
    }
  },
};
