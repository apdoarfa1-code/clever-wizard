'use strict';
/*
 * agent-panel.js — لوحة العقل: تشغيل/إيقاف + قرارات + تحليل
 */
const AgentPanel = {
  init() {
    this.bindControls();
    this.renderStatus();
    this.loadDecisions();
    this.loadLogs();
  },

  bindControls() {
    document.getElementById('agentRunBtn')?.addEventListener('click', async () => {
      await this.runOnce();
    });
    document.getElementById('agentStartBtn')?.addEventListener('click', async () => {
      await this.startLoop();
    });
    document.getElementById('agentStopBtn')?.addEventListener('click', async () => {
      await this.stopLoop();
    });
    document.getElementById('agentAnalyzeBtn')?.addEventListener('click', async () => {
      await this.analyzeSymbol();
    });
  },

  renderStatus() {
    const s = App.state.agentStatus;
    if (!s) return;

    const icon = document.getElementById('agentStatusIcon');
    const title = document.getElementById('agentStatusTitle');
    const detail = document.getElementById('agentStatusDetail');

    if (s.running || s.autorun) {
      if (icon) { icon.className = 'agent-status-icon running'; icon.textContent = '🤖'; }
      if (title) title.textContent = 'العقل يعمل';
      if (detail) detail.textContent = 'يحلل السوق ويتخذ قرارات تلقائياً';
    } else {
      if (icon) { icon.className = 'agent-status-icon stopped'; icon.textContent = '⏸'; }
      if (title) title.textContent = 'العقل متوقف';
      if (detail) detail.textContent = 'اضغط "تشغيل دورة واحدة" أو "تشغيل تلقائي"';
    }

    // Config info
    const cfg = s.config || {};
    const cfgEl = document.getElementById('agentConfigInfo');
    if (cfgEl) {
      cfgEl.innerHTML = `
        <div class="text-sm text-muted">🤖 ${cfg.aiProvider || '—'} / ${cfg.aiModel || '—'}</div>
        <div class="text-sm text-muted">📈 ${cfg.broker || '—'} (${cfg.mode || 'paper'})</div>
        <div class="text-sm text-muted">⏱ ${cfg.timeframe || '15m'} — ${cfg.symbols?.join(', ') || '—'}</div>
      `;
    }
  },

  async runOnce() {
    const btn = document.getElementById('agentRunBtn');
    if (btn) btn.innerHTML = '<span class="spinner"></span> يعمل...';
    try {
      const result = await App.api('/api/agent/run', { method: 'POST', body: {} });
      App.toast(`اكتملت الدورة (${(result.elapsed || 0) / 1000}s)`, 'success');
      this.loadDecisions();
      this.loadLogs();
      App.loadAccount();
    } catch {}
    if (btn) btn.innerHTML = '▶️ تشغيل دورة واحدة';
  },

  async startLoop() {
    try {
      await App.api('/api/agent/start', { method: 'POST', body: { intervalMs: parseInt(document.getElementById('setLoopInterval')?.value) * 1000 || 60000 } });
      App.toast(App.state.lang === 'ar' ? 'تم تشغيل العقل تلقائياً' : 'Agent auto-trade enabled', 'success');
      App.loadAgentStatus();
    } catch {}
  },

  async scalpBatch() {
    const symbol = (document.getElementById('setScalpSymbol')?.value || 'BTCUSDT').toUpperCase();
    const qty = +(document.getElementById('setScalpQty')?.value || 0.001);
    const count = +(document.getElementById('setScalpCount')?.value || 10);
    const duration = +(document.getElementById('setScalpDuration')?.value || 10);
    const sel = document.getElementById('setScalpSide')?.value || 'BOTH';
    if (!symbol || !qty) {
      const msg = (App.state.lang === 'ar') ? 'أدخل الزوج والحجم' : 'Enter symbol + size';
      App.toast(msg, 'warn');
      return;
    }
    App.toast(`⚡ ${count} scalps on ${symbol}...`, 'info');
    try {
      const t0 = Date.now();
      if (sel === 'BOTH') {
        const half = Math.floor(count / 2);
        const [r1, r2] = await Promise.all([
          App.api('/api/scalp-batch', { method: 'POST', body: { symbol, side: 'BUY', qty, count: half, durationSec: duration } }),
          App.api('/api/scalp-batch', { method: 'POST', body: { symbol, side: 'SELL', qty, count: count - half, durationSec: duration } }),
        ]);
        App.toast(`✅ ${(r1.opened + r2.opened)}/${count} scalps (${Date.now() - t0}ms)`, 'success');
      } else {
        const r = await App.api('/api/scalp-batch', { method: 'POST', body: { symbol, side: sel, qty, count, durationSec: duration } });
        App.toast(`✅ ${r.opened}/${r.requested} — ${r.latency}ms`, 'success');
      }
      App.loadAccount();
      AgentPanel.loadLogs();
    } catch (e) {}
  },

  async scalpOne() {
    const symbol = (document.getElementById('setScalpSymbol')?.value || 'BTCUSDT').toUpperCase();
    const qty = +(document.getElementById('setScalpQty')?.value || 0.001);
    const duration = +(document.getElementById('setScalpDuration')?.value || 10);
    if (!symbol || !qty) { App.toast('أدخل الزوج والحجم', 'warn'); return; }
    App.toast(`⚡ سكالب سريع على ${symbol} ...`, 'info');
    try {
      const r = await App.api('/api/scalp', {
        method: 'POST',
        body: { symbol, side: 'BUY', qty, durationSec: duration },
      });
      if (r.ok) App.toast(`✅ SCALP ${symbol} @ ${r.price} (SL=${r.sl?.toFixed(2)} TP=${r.tp?.toFixed(2)})`, 'success');
      else App.toast(`❌ ${r.error || 'فشل'}`, 'error');
      App.loadAccount();
    } catch (e) {}
  },

  async stopLoop() {
    try {
      await App.api('/api/agent/stop', { method: 'POST' });
      App.toast('تم إيقاف العقل', 'info');
      App.loadAgentStatus();
    } catch {}
  },

  async analyzeSymbol() {
    const input = document.getElementById('analyzeSymbolInput');
    const symbol = input?.value?.toUpperCase().trim();
    if (!symbol) { App.toast('ادخل رمز الزوج (مثل BTCUSDT)', 'warn'); return; }

    const btn = document.getElementById('agentAnalyzeBtn');
    if (btn) btn.innerHTML = '<span class="spinner"></span> يحلل...';
    try {
      const result = await App.api('/api/brain/analyze', { method: 'POST', body: { symbol } });
      App.toast(`تحليل ${symbol} اكتمل`, 'success');
      this.loadDecisions();
    } catch {}
    if (btn) btn.innerHTML = '🧠 تحليل';
  },

  async loadDecisions() {
    try {
      const data = await App.api('/api/decisions');
      const container = document.getElementById('agentDecisionsList');
      if (!container) return;
      const decs = (data.decisions || []).slice(0, 20);
      if (decs.length) {
        container.innerHTML = decs.map(d => {
          const confColor = d.confidence >= 0.7 ? 'var(--green)' : d.confidence >= 0.5 ? 'var(--yellow)' : 'var(--red)';
          return `
            <div class="decision-card">
              <div class="decision-header">
                <span class="decision-action ${d.action}">${d.action} ${d.symbol || ''}</span>
                <div class="decision-confidence">
                  <div class="confidence-bar"><div class="confidence-bar-fill" style="width:${d.confidence * 100}%;background:${confColor}"></div></div>
                  <span style="color:${confColor}">${(d.confidence * 100).toFixed(0)}%</span>
                </div>
              </div>
              ${d.reasoning ? `<div class="decision-reasoning">${d.reasoning}</div>` : ''}
              <div class="decision-meta"><span>🤖 ${d.model || d.provider || '—'}</span><span>${(d.createdAt || '').slice(0, 16)}</span></div>
            </div>
          `;
        }).join('');
      } else {
        container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:30px;">لا توجد قرارات بعد</p>';
      }
    } catch {}
  },

  async loadLogs() {
    try {
      const data = await App.api('/api/logs');
      const container = document.getElementById('agentLogsList');
      if (!container) return;
      container.innerHTML = (data.logs || []).slice(0, 50).map(l => `
        <div class="log-entry">
          <span class="log-time">${new Date(l.t).toLocaleTimeString('ar-EG')}</span>
          <span class="log-level ${l.level || 'info'}">${(l.level || 'info').toUpperCase()}</span>
          <span class="log-msg">${l.msg}</span>
        </div>
      `).join('');
    } catch {}
  },

  refresh() {
    this.loadDecisions();
    this.loadLogs();
  },
};
