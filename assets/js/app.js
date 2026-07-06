'use strict';
/*
 * app.js — التحكم الرئيسي: tabs + state + API + init
 */
const App = {
  state: {
    currentPage: 'dashboard',
    theme: localStorage.getItem('theme') || 'dark',
    health: null,
    account: null,
    agentStatus: null,
    refreshInterval: null,
    tgPollInterval: null,
  },

  async init() {
    this.setSplashStatus('جاري فحص الاتصال...');
    this.setTheme(this.state.theme);
    this.bindNav();
    this.bindThemeToggle();
    this.setSplashStatus('فحص الإنترنت...');
    await this.checkInternet();
    this.setSplashStatus('تحميل الداش بورد...');
    await this.loadHealth();
    await this.loadAccount();
    await this.loadAgentStatus();
    Dashboard.init();
    AgentPanel.init();
    Settings.init();
    this.setSplashStatus('جاهز ✦');
    setTimeout(() => this.hideSplash(), 500);
    this.startConnectivityMonitor();

    // تحديث تلقائي كل 10 ثوان
    this.state.refreshInterval = setInterval(async () => {
      await Promise.all([this.loadAccount(), this.loadAgentStatus()]);
    }, 10000);
  },

  setTheme(theme) {
    this.state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  },

  bindThemeToggle() {
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark');
    });
  },

  bindNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(el => {
      el.addEventListener('click', () => this.navigate(el.dataset.page));
    });
  },

  navigate(page) {
    this.state.currentPage = page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page)?.classList.add('active');

    if (page === 'dashboard') Dashboard.refresh();
    if (page === 'agent') AgentPanel.refresh();
  },

  // ---- API Client ----
  async api(path, opts = {}) {
    try {
      const url = path;
      const method = opts.method || 'GET';
      const headers = { 'Content-Type': 'application/json' };
      const body = opts.body ? JSON.stringify(opts.body) : undefined;
      const res = await fetch(url, { method, headers, body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      this.toast(e.message, 'error');
      throw e;
    }
  },

  async loadHealth() {
    try { this.state.health = await this.api('/api/health'); this.renderHealthStatus(); } catch {}
  },

  async loadAccount() {
    try {
      this.state.account = await this.api('/api/account');
      if (this.state.currentPage === 'dashboard') Dashboard.renderAccount();
    } catch {}
  },

  async loadAgentStatus() {
    try {
      this.state.agentStatus = await this.api('/api/agent/status');
      AgentPanel.renderStatus();
    } catch {}
  },

  renderHealthStatus() {
    const h = this.state.health;
    if (!h) return;
    const el = document.getElementById('connStatus');
    if (!el) return;
    const items = [
      { name: 'السوق', ok: h.market?.ok, detail: h.market?.source },
      { name: 'البروكر', ok: h.broker?.ok, detail: h.broker?.mode || h.broker?.error?.slice(0, 30) },
      { name: 'العقل AI', ok: h.ai?.ok, detail: h.ai?.model || h.ai?.error?.slice(0, 30) },
      { name: 'التليجرام', ok: h.telegram?.ok, detail: h.telegram?.bot?.username || 'غير مربوط' },
    ];
    el.innerHTML = items.map(i => `
      <div class="conn-card ${i.ok ? 'connected' : 'disconnected'}">
        <div class="conn-dot"></div>
        <div>
          <div class="conn-name">${i.name}</div>
          <div class="conn-detail">${i.detail || (i.ok ? 'متصل' : 'غير متصل')}</div>
        </div>
      </div>
    `).join('');
    const dot = document.getElementById('statusDot');
    const allOk = items.every(i => i.ok);
    dot?.classList.toggle('offline', !allOk);
  },

  // ---- Splash Screen ----
  setSplashStatus(text) {
    const el = document.getElementById('splashStatus');
    if (el) el.textContent = text;
  },

  hideSplash() {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 600);
    }
  },

  // ---- فحص الإنترنت ----
  async checkInternet() {
    try {
      // نطلب endpoint سريع مع timeout قصير
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      await fetch('/api/health', { signal: ctrl.signal });
      clearTimeout(t);
      return true;
    } catch {
      this.toast('⚠️ لا يوجد اتصال بالإنترنت — البرنامج سيعيد المحاولة تلقائياً', 'error');
      return false;
    }
  },

  // مراقبة الاتصال كل 30 ثانية
  startConnectivityMonitor() {
    setInterval(async () => {
      const wasOnline = this.state.online;
      try {
        await fetch('/api/market/ticker?symbol=BTCUSDT', { method: 'HEAD' }).catch(() => {});
        // نطمن إن السيرفر شغّال
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch('/api/health', { signal: ctrl.signal });
        clearTimeout(t);
        this.state.online = true;
        if (wasOnline === false) this.toast('✅ عاد الاتصال بالإنترنت', 'success');
      } catch {
        this.state.online = false;
      }
    }, 30000);
  },

  toast(msg, type = 'info') {
    const c = document.getElementById('toastContainer') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toastContainer', className: 'toast-container' }));
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
