'use strict';
const App = {
  state: {
    currentPage: 'dashboard',
    theme: localStorage.getItem('theme') || 'dark',
    lang: localStorage.getItem('lang') || 'ar',
    health: null,
    account: null,
    agentStatus: null,
    online: true,
    refreshInterval: null,
  },

  i18n: {
    ar: {
      brand_sub: 'AGENT', nav_dashboard: 'الداش بورد', nav_agent: 'العقل الذكي', nav_markets: 'السوق',
      nav_trades: 'الصفقات', nav_download: 'تحميل', nav_settings: 'الإعدادات', nav_about: 'من نحن',
      online: 'متصل', offline: 'غير متصل', fast_trade: 'تداول سريع', batch10: '10 صفقات', close_all: 'إغلاق الكل',
      login: 'دخول', logout: 'خروج', login_sub: 'وكيل التداول الذكي — تسجيل الدخول',
      username: 'اسم المستخدم', password: 'كلمة المرور', login_hint: 'البيانات الافتراضية: 101 / 102',
      scalp_panel: 'محرك الصفقات السريعة (Scalping)', scalp_one: 'سكالب واحد', scalp_batch: 'سكالب دفعة',
      scalp_note: 'المحرك يفتح صفقات لحظية مع SL/TP تلقائي، ويغلق بعد المدة المحددة. سرعته < 3 ث في التنفيذ.',
      scalp_durations: 'مدد الصفقات السريعة (5s,10s,15s)', auto_close: 'إغلاق تلقائي بعد المدة',
      strict_confirm: 'التأكيد الصارم (لا صفقات عشوائية)', tick_ms: 'تردد المتابعة (ms) — 250 لحظي',
      duration: 'المدة (ث)',
      balance: 'الرصيد', pnl: 'الربح/الخسارة', unrealized: 'غير محقّق', open_positions: 'صفقات مفتوحة', now: 'الآن',
      win_rate: 'نسبة الفوز', total: 'إجمالي', total_pnl: 'PnL إجمالي', closed_trades: 'الصفقات المغلقة',
      chart: 'الرسم البياني', symbol: 'الزوج', side: 'الاتجاه', size: 'الحجم', entry: 'الدخول',
      decisions: 'القرارات', logs: 'السجل', loading: 'جاري التحميل...', agent_stopped: 'العقل متوقف',
      run_once: 'دورة واحدة', auto_run: 'تلقائي', stop: 'إيقاف', manual_analysis: 'تحليل يدوي', analyze: 'تحليل',
      total_trades: 'إجمالي الصفقات', all_trades: 'كل الصفقات', date: 'التاريخ', status: 'الحالة',
      dl_title: 'حزمة التثبيت', dl_desc: 'اختر نظامك لتحميل الحزمة الجاهزة للتشغيل على أي جهاز', download: 'تحميل',
      dl_note: 'الأندرويد يعمل كتطبيق ويب (PWA) يتطلب نشر الأداة أونلاين (Vercel).',
      broker_settings: 'إعدادات البروكر', ai_settings: 'إعدادات العقل', telegram_settings: 'إعدادات التليجرام',
      risk_settings: 'إدارة المخاطر', bot_settings: 'إعدادات البوت', advanced: 'متقدم',
      paper_desc: 'تداول وهمي آمن — بدون مفاتيح', start_balance: 'الرصيد الابتدائي', select: 'اختيار',
      no_real: 'لا (حقيقي)', yes_test: 'نعم (تجريبي)', provider: 'المزوّد', custom: 'مخصص', model: 'الموديل',
      temperature: 'درجة الحرارة', min_conf: 'أقل مستوى ثقة', save: 'حفظ', test: 'فحص', send_test: 'إرسال اختبار',
      pos_size: 'حجم الصفقة (%)', daily_loss: 'حد الخسارة اليومي (%)', max_open: 'أقصى صفقات مفتوحة',
      default_sl: 'وقف خسارة افتراضي (%)', default_tp: 'جنى أرباح افتراضي (%)',
      symbols: 'الأزواج (مفصولة بفاصلة)', timeframe: 'الفريم الزمني', loop_interval: 'فترة الدورة (ثانية)',
      max_batch: 'أقصى صفقات بالدفعة', auto_run_loop: 'تشغيل تلقائي', tg_notify: 'إشعارات تليجرام', force_sltp: 'SL/TP إجباري',
      reset_data: 'حذف البيانات', refresh_all: 'تحديث الاتصالات',
      developer: 'مطوّر البرمجيات', role: 'Role', project_info: 'عن المشروع',
      about_text: 'AI Trading Agent — منصة تداول ذكية متكاملة بُنيت بشغف. تجمع بين الذكاء الاصطناعي، الربط الحقيقي بالبروكرات، وإدارة مخاطر احترافية — كل ذلك في واجهة واحدة خارقة.',
      real_conn: 'ربط حقيقي', brokers_count: 'بروكرات', created_by: 'إنشاء وتطوير',
    },
    en: {
      brand_sub: 'AGENT', nav_dashboard: 'Dashboard', nav_agent: 'AI Brain', nav_markets: 'Markets',
      nav_trades: 'Trades', nav_download: 'Download', nav_settings: 'Settings', nav_about: 'About',
      online: 'Online', offline: 'Offline', fast_trade: 'Quick Trade', batch10: '10 trades', close_all: 'Close All',
      balance: 'Balance', pnl: 'P&L', unrealized: 'Unrealized', open_positions: 'Open Positions', now: 'Now',
      win_rate: 'Win Rate', total: 'Total', total_pnl: 'Total P&L', closed_trades: 'Closed trades',
      chart: 'Chart', symbol: 'Symbol', side: 'Side', size: 'Size', entry: 'Entry',
      decisions: 'Decisions', logs: 'Logs', loading: 'Loading...', agent_stopped: 'Agent Stopped',
      run_once: 'Run Once', auto_run: 'Auto', stop: 'Stop', manual_analysis: 'Manual Analysis', analyze: 'Analyze',
      total_trades: 'Total Trades', all_trades: 'All Trades', date: 'Date', status: 'Status',
      dl_title: 'Installer Package', dl_desc: 'Choose your OS to download a ready-to-run package', download: 'Download',
      dl_note: 'Android works as a web app (PWA) and requires deploying the tool online (Vercel).',
      broker_settings: 'Broker Settings', ai_settings: 'AI Brain Settings', telegram_settings: 'Telegram Settings',
      risk_settings: 'Risk Management', bot_settings: 'Bot Settings', advanced: 'Advanced',
      paper_desc: 'Safe simulated trading — no keys needed', start_balance: 'Starting Balance', select: 'Select',
      no_real: 'No (Live)', yes_test: 'Yes (Test)', provider: 'Provider', custom: 'Custom', model: 'Model',
      temperature: 'Temperature', min_conf: 'Min Confidence', save: 'Save', test: 'Test', send_test: 'Send Test',
      pos_size: 'Position Size (%)', daily_loss: 'Daily Loss Limit (%)', max_open: 'Max Open Positions',
      default_sl: 'Default Stop Loss (%)', default_tp: 'Default Take Profit (%)',
      symbols: 'Symbols (comma-separated)', timeframe: 'Timeframe', loop_interval: 'Loop Interval (sec)',
      max_batch: 'Max Batch Trades', auto_run_loop: 'Auto Run', tg_notify: 'Telegram Notifications', force_sltp: 'Force SL/TP',
      reset_data: 'Reset Data', refresh_all: 'Refresh Connections',
      developer: 'Software Developer', role: 'Role', project_info: 'About Project',
      about_text: 'AI Trading Agent — an integrated smart trading platform built with passion. Combines AI, real broker connections, and professional risk management — all in one epic interface.',
      real_conn: 'Real connection', brokers_count: 'Brokers', created_by: 'Created by',
    },
  },

  async init() {
    this.setSplashStatus('INIT');
    this.setTheme(this.state.theme);
    this.setLang(this.state.lang);
    this.bindNav();
    this.bindToggles();
    Dashboard.init();
    AgentPanel.init();
    Settings.init();
    // Run heavy backend loads in background (don't block UI)
    setTimeout(() => this.deferredLoad(), 300);
  },

  async deferredLoad() {
    try { await this.checkInternet(); } catch {}
    try { await Promise.all([this.loadHealth(), this.loadAccount(), this.loadAgentStatus()]); } catch {}
    this.setSplashStatus('READY');
    try { this.hideSplash(); } catch {}
    this.startConnectivityMonitor();
    this.initMagicUI();
    // Faster refresh interval + parallel scheduling
    this.state.refreshInterval = setInterval(async () => {
      const tasks = [this.loadAccount(), this.loadAgentStatus()];
      if (this.state.currentPage === 'dashboard') {
        tasks.push(Promise.resolve(Dashboard.loadTrades()));
        tasks.push(Promise.resolve(Dashboard.loadDecisions()));
        tasks.push(Promise.resolve(Dashboard.loadProCards()));
        tasks.push(Promise.resolve(this.refreshTickerMarquee()));
      }
      await Promise.all(tasks);
    }, 4000);
  },

  initMagicUI() {
    // Word rotate (cycling)
    const wr = document.getElementById('wordRotate');
    if (wr) {
      const words = wr.querySelectorAll('.word-rotate-word');
      let i = 0;
      setInterval(() => {
        words.forEach(w => w.classList.remove('active'));
        words[(++i) % words.length].classList.add('active');
      }, 2800);
    }
    // Spotlight cards: track mouse x/y for each .spotlight element
    document.querySelectorAll('.spotlight').forEach(card => {
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
        card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
      });
    });
    // Reveal on scroll + initial
    const io = new IntersectionObserver((entries) => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          en.target.classList.add('visible');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal, .blur-fade').forEach(el => io.observe(el));
    // Initial marquee (8 top cryptos)
    this.refreshTickerMarquee();
    // Live WebSocket for sub-second price updates
    this.connectWS();
  },

  connectWS() {
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/`);
      ws.onopen = () => { console.log('[WS] connected'); };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'trade' && m.symbol) {
            const el = document.getElementById(`live-${m.symbol}`);
            if (el) el.textContent = '$' + (+m.price).toLocaleString('en', {maximumFractionDigits: 2});
            // Update live prices map
            if (!this._prices) this._prices = {};
            this._prices[m.symbol] = m.price;
          }
        } catch {}
      };
      ws.onclose = () => { setTimeout(() => this.connectWS(), 3000); };
      ws.onerror = () => {};
    } catch {}
  },

  refreshTickerMarquee() {
    const track = document.getElementById('tickerMarquee');
    if (!track) return;
    const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT','LTCUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT'];
    const top8 = symbols.slice(0, 8);
    // Fetch prices in parallel, build marquee (twice for seamless loop)
    Promise.all(top8.map(s => this.api(`/api/market/ticker?symbol=${s}`).catch(() => null))).then(results => {
      const valid = results.filter(r => r && r.price);
      if (!valid.length) {
        track.innerHTML = `<span class="marquee-item">⚡ AI Trading Agent — جاري التحميل...</span>`.repeat(8);
        return;
      }
      const items = valid.map(r => `<span class="marquee-item"><b style="color:var(--secondary)">${r.symbol}</b> $${(+r.price).toLocaleString('en', {maximumFractionDigits: 2})} <span style="color:${r.change >= 0 ? 'var(--green)' : 'var(--danger)'}">${r.change >= 0 ? '+' : ''}${(+r.change).toFixed(2)}%</span></span>`).join('');
      track.innerHTML = items + items; // duplicated for seamless loop
    });
  },

  setTheme(theme) {
    this.state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
  },

  toggleTheme() { this.setTheme(this.state.theme === 'dark' ? 'light' : 'dark'); },

  setLang(lang) {
    this.state.lang = lang;
    localStorage.setItem('lang', lang);
    document.documentElement.lang = lang;
    document.body.className = 'lang-' + lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
    const map = { ar: 0, en: 1 };
    document.querySelectorAll('.lang-btn')[map[lang]]?.classList.add('active');
    const dict = this.i18n[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (dict[key]) el.textContent = dict[key];
    });
  },

  bindNav() {
    document.querySelectorAll('.topnav-link[data-page]').forEach(el => {
      el.addEventListener('click', () => this.navigate(el.dataset.page));
    });
  },

  navigate(page) {
    this.state.currentPage = page;
    // activate link
    document.querySelectorAll('.topnav-link').forEach(n => n.classList.remove('active'));
    const link = document.querySelector(`.topnav-link[data-page="${page}"]`);
    if (link) link.classList.add('active');
    // show page, hide others
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const targetPage = document.getElementById('page-' + page);
    if (!targetPage) { console.warn('[navigate] page not found: ' + page); return; }
    targetPage.classList.add('active');
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event('reveal:refresh'));
    // trigger refresh per page
    switch (page) {
      case 'dashboard': Dashboard.refresh(); break;
      case 'agent': AgentPanel.refresh(); break;
      case 'markets': Dashboard.loadMarketPage(); break;
      case 'trades': Dashboard.loadTrades(); Dashboard.renderTradesStats(); break;
      case 'backtest': Backtest.run(true); break;
      default: break;
    }
  },

  bindToggles() {
    document.querySelectorAll('.toggle').forEach(t => {
      t.addEventListener('click', () => {
        t.classList.toggle('active');
        const id = t.id;
        if (id === 'toggleAutorun') {
          const on = t.classList.contains('active');
          this.api('/api/config', { method: 'POST', body: { AGENT_AUTORUN: on ? 'true' : 'false' } });
          if (on) this.api('/api/agent/start', { method: 'POST' });
          else this.api('/api/agent/stop', { method: 'POST' });
        }
        if (id === 'toggleTgNotify' || id === 'toggleSlTp') {
          const key = id === 'toggleTgNotify' ? 'TG_NOTIFY' : 'FORCE_SLTP';
          this.api('/api/config', { method: 'POST', body: { [key]: t.classList.contains('active') ? 'true' : 'false' } });
        }
      });
    });
  },

  async api(path, opts = {}) {
    try {
      const method = opts.method || 'GET';
      const headers = { 'Content-Type': 'application/json' };
      const body = opts.body ? JSON.stringify(opts.body) : undefined;
      const res = await fetch(path, { method, headers, body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      // Don't toast on loading (poll), only on user-initiated actions
      if (!opts.silent) this.toast(e.message, 'error');
      throw e;
    }
  },
  async apiSilent(path, opts) { return this.api(path, { ...opts, silent: true }); },

  async loadHealth() {
    try { this.state.health = await this.apiSilent('/api/health'); this.renderHealthStatus(); } catch {}
  },
  async loadAccount() {
    try { this.state.account = await this.apiSilent('/api/account'); this.state.paperStart = this.state.account?.account?.startBalance || 10000; if (this.state.currentPage === 'dashboard') Dashboard.renderAccount(); } catch {}
  },
  async loadAgentStatus() {
    try { this.state.agentStatus = await this.apiSilent('/api/agent/status'); AgentPanel.renderStatus(); } catch {}
  },

  renderHealthStatus() {
    const h = this.state.health; if (!h) return;
    const el = document.getElementById('connStatus'); if (!el) return;
    const items = [
      { name: 'السوق / Market', ok: h.market?.ok, detail: h.market?.source },
      { name: 'البروكر / Broker', ok: h.broker?.ok, detail: h.broker?.mode || h.broker?.error?.slice(0, 30) },
      { name: 'العقل / AI', ok: h.ai?.ok, detail: h.ai?.model || h.ai?.error?.slice(0, 30) },
      { name: 'تليجرام / Telegram', ok: h.telegram?.ok, detail: h.telegram?.bot?.username || '—' },
    ];
    el.innerHTML = items.map(i => `<div class="conn-card ${i.ok ? 'connected' : 'disconnected'}"><div class="conn-dot"></div><div><div class="conn-name">${i.name}</div><div class="conn-detail">${i.detail || (i.ok ? 'OK' : 'Offline')}</div></div></div>`).join('');
    const pill = document.getElementById('topStatus');
    const allOk = items.every(i => i.ok);
    if (pill) { pill.classList.toggle('offline', !allOk); }
  },

  async checkInternet() {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      await fetch('/api/health', { signal: ctrl.signal }); clearTimeout(t); return true;
    } catch { this.toast('⚠️ لا يوجد اتصال — يعيد المحاولة تلقائياً', 'error'); return false; }
  },

  startConnectivityMonitor() {
    setInterval(async () => {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch('/api/health', { signal: ctrl.signal }); clearTimeout(t);
        if (!this.state.online) { this.state.online = true; this.toast('✅ عاد الاتصال', 'success'); }
      } catch { this.state.online = false; }
    }, 30000);
  },

  async downloadPackage(os) {
    this.toast(`📦 جاري تجهيز حزمة ${os}...`, 'info');
    try {
      // android: نبني APK وهمي شغّال (PWA-style package with install guide)
      const res = await fetch(`/api/package/build?os=${encodeURIComponent(os)}`, { method: 'GET' });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const blob = await res.blob();
      if (!blob || blob.size === 0) throw new Error('الحزمة فارغة');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filenames = {
        windows: 'ai-trading-agent-windows.zip',
        linux: 'ai-trading-agent-linux.tar.gz',
        mac: 'ai-trading-agent-mac.tar.gz',
        android: 'ai-trading-agent-android.tar.gz',
      };
      a.href = url;
      a.download = filenames[os] || `ai-trading-agent-${os}.tar.gz`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.toast(`✅ تم تحميل حزمة ${os} (${(blob.size/1024/1024).toFixed(2)}MB)`, 'success');
    } catch (e) { this.toast('تعذّر تحميل الحزمة: ' + (e.message || 'خطأ غير معروف'), 'error'); }
  },

  setSplashStatus(t) { const el = document.getElementById('splashStatus'); if (el) el.textContent = t; },
  hideSplash() { const s = document.getElementById('splash'); if (s) { s.classList.add('hide'); setTimeout(() => s.remove(), 600); } },

  // Magic-UI Number Ticker: count from 0 → target in 700ms + tick animation
  animateNumber(el, target, opts = {}) {
    if (!el) return;
    const decimals = opts.decimals ?? 2;
    const prefix = opts.prefix ?? '';
    const suffix = opts.suffix ?? '';
    const start = parseFloat((el.dataset.last || '0').replace(/[^\d.\-]/g, '')) || 0;
    const end = +target || 0;
    if (Math.abs(end - start) < 0.0001) { el.textContent = prefix + end.toFixed(decimals) + suffix; return; }
    const duration = 600;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = start + (end - start) * eased;
      el.textContent = prefix + v.toFixed(decimals) + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else { el.textContent = prefix + end.toFixed(decimals) + suffix; el.dataset.last = end; el.classList.add('tick'); setTimeout(() => el.classList.remove('tick'), 500); }
    };
    requestAnimationFrame(tick);
  },

  toast(msg, type = 'info') {
    let c = document.getElementById('toastContainer');
    if (!c) { c = document.createElement('div'); c.id = 'toastContainer'; c.className = 'toast-container'; document.body.appendChild(c); }
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  // Always init app (binds nav, sets theme, loads health...)
  if (!window._appInitialized) { window._appInitialized = true; App.init(); }
  // hide splash when ready
  setTimeout(() => { const s = document.getElementById('splash'); if (s) s.classList.add('hide'); }, 2000);
  // auth gate: if not logged, show login + hide app crust
  if (window.Auth && !Auth.gate()) {
    // nothing further — gate() hides app nav already
  }
  // Always ensure icon apply
  window.addEventListener('reveal:refresh', () => window.Icons?.apply?.());
});
