'use strict';
// XSS escape helper
function esc(v) {
  if (v == null) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(v).replace(/[&<>"']/g, function(c) { return map[c]; });
}
const Dashboard = {
  init() {
    this.loadChart();
    this.loadTrades();
    this.loadDecisions();
    this.loadLogs();
    this.renderAccount();
    // Live chart symbol change -> reload chart
    const sel = document.getElementById('chartSymbolSelect');
    if (sel) sel.addEventListener('change', () => this.loadChart());
  },

  renderAccount() {
    const a = App.state.account; if (!a) return;
    const balance = a.account?.balance || 0, available = a.account?.availableBalance || 0, pnl = a.account?.unrealizedProfit || 0;
    const stats = a.stats || {}, pos = a.positions?.length || 0;
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    const setHtml = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
    const cur = a.account?.currency || 'USDT';
    App.animateNumber(document.getElementById('cardBalance'), balance, { decimals: 2, suffix: ' ' + cur });
    setVal('cardAvailable', (App.state.lang === 'ar' ? 'متاح' : 'Avail') + ': ' + available.toFixed(2));
    setHtml('cardPnl', `<span class="${pnl >= 0 ? 'text-green' : 'text-red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>`);
    App.animateNumber(document.getElementById('cardOpen'), pos, { decimals: 0 });
    App.animateNumber(document.getElementById('cardWinRate'), stats.winRate || 0, { decimals: 1, suffix: '%' });
    setVal('cardTotalTrades', stats.totalTrades || 0);
    setVal('cardConsecLoss', stats.consecutiveLosses || 0);
    App.animateNumber(document.getElementById('cardTotalPnl'), stats.totalPnl || 0, { decimals: 2, prefix: (stats.totalPnl || 0) >= 0 ? '+' : '' });

    // Risk gauge (daily loss used)
    const agentState = App.state.agentStatus?.state || {};
    const startBal = App.state.paperStart || 10000;
    const dailyPnl = agentState.dailyPnl || 0;
    const dailyLossLimit = startBal * 0.05; // 5% of starting balance
    const riskPct = dailyPnl < 0 ? Math.min(100, Math.abs(dailyPnl) / dailyLossLimit * 100) : 0;
    const riskBar = document.getElementById('riskBar');
    if (riskBar) { riskBar.style.width = Math.min(100, riskPct) + '%'; riskBar.style.background = riskPct > 70 ? 'var(--danger)' : riskPct > 40 ? 'var(--warn)' : 'var(--green)'; }
    setVal('cardRiskUsed', riskPct.toFixed(1) + '%');

    const tbody = document.getElementById('positionsTable');
    if (tbody) {
      tbody.innerHTML = (a.positions?.length ? a.positions.map(p => `<tr>
        <td class="text-mono font-semibold">${esc(p.symbol)}</td>
        <td><span class="badge-tag ${esc(p.side)}">${esc(p.side)}</span></td>
        <td class="text-mono">${esc(p.size)}</td>
        <td class="text-mono">${esc(p.entryPrice)}</td>
        <td class="text-mono">${esc(p.markPrice)}</td>
        <td class="text-mono ${p.pnl >= 0 ? 'text-green' : 'text-red'}">${p.pnl >= 0 ? '+' : ''}${esc((+p.pnl).toFixed(2))}</td>
        <td><button class="btn btn-sm btn-danger" onclick="Dashboard.closePosition('${esc(p.symbol).replace(/'/g, '')}')">✕</button></td>
      </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">${App.state.lang === 'ar' ? 'لا توجد صفقات مفتوحة' : 'No open positions'}</td></tr>`);
    }
  },

  async closePosition(symbol) {
    try { await App.api('/api/close', { method: 'POST', body: { symbol } }); App.toast(`✕ ${symbol}`, 'success'); App.loadAccount(); this.loadTrades(); } catch {}
  },

  async fastTrade(side) {
    const symbol = document.getElementById('fastSymbol')?.value?.toUpperCase().trim();
    const qty = parseFloat(document.getElementById('fastQty')?.value);
    if (!symbol || !qty) { App.toast('أدخل الزوج والحجم', 'warn'); return; }
    try {
      await App.api('/api/order', { method: 'POST', body: { symbol, side, type: 'MARKET', qty } });
      App.toast(`${side} ${symbol} ✓`, 'success');
      App.loadAccount(); this.loadTrades();
    } catch {}
  },

  async batchTrade() {
    const symbol = document.getElementById('fastSymbol')?.value?.toUpperCase().trim();
    const qty = parseFloat(document.getElementById('fastQty')?.value);
    if (!symbol || !qty) { App.toast('أدخل الزوج والحجم', 'warn'); return; }
    App.toast('📦 جاري فتح 10 صفقات...', 'info');
    try {
      const result = await App.api('/api/batch', { method: 'POST', body: { symbol, side: 'BUY', qty, count: 10 } });
      App.toast(`✅ تم فتح ${result.opened} صفقة`, 'success');
      App.loadAccount(); this.loadTrades();
    } catch (e) {}
  },

  async closeAll() {
    if (!confirm(App.state.lang === 'ar' ? 'إغلاق كل الصفقات؟' : 'Close all positions?')) return;
    try {
      const r = await App.api('/api/close-all', { method: 'POST' });
      App.toast(`✕ تم إغلاق ${r.closed} صفقة`, 'success');
      App.loadAccount(); this.loadTrades();
    } catch {}
  },

  async loadTrades() {
    try {
      const data = await App.api('/api/trades');
      const tbody = document.getElementById('tradesTable');
      if (!tbody) return;
      const trades = data.trades || [];
      tbody.innerHTML = trades.length ? trades.slice(0, 50).map(t => `<tr>
        <td class="text-mono" style="font-size:11px">${esc((t.createdAt || '').slice(0, 16))}</td>
        <td class="text-mono font-semibold">${esc(t.symbol)}</td>
        <td><span class="badge-tag ${esc(t.side)}">${esc(t.side)}</span></td>
        <td class="text-mono">${esc(t.price)}</td>
        <td class="text-mono">${esc(t.qty)}</td>
        <td><span class="badge-tag ${esc(t.status)}">${t.status === 'open' ? (App.state.lang === 'ar' ? 'مفتوحة' : 'Open') : (App.state.lang === 'ar' ? 'مغلقة' : 'Closed')}</span></td>
        <td class="text-mono ${t.pnl >= 0 ? 'text-green' : 'text-red'}">${t.pnl !== undefined ? (t.pnl >= 0 ? '+' : '') + esc((+t.pnl).toFixed(2)) : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">${App.state.lang === 'ar' ? 'لا توجد صفقات' : 'No trades yet'}</td></tr>`;
      this.renderTradesStats(data.stats);
    } catch {}
  },

  renderTradesStats(stats) {
    stats = stats || App.state.account?.stats;
    if (!stats) return;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('tStatTotal', stats.totalTrades || 0);
    set('tStatOpen', stats.openTrades || 0);
    set('tStatWin', (stats.winRate || 0).toFixed(1) + '%');
    set('tStatPnl', ((stats.totalPnl || 0) >= 0 ? '+' : '') + (stats.totalPnl || 0).toFixed(2));
  },

  async loadDecisions() {
    try {
      const data = await App.api('/api/decisions');
      const c = document.getElementById('decisionsContainer');
      if (!c) return;
      const decs = (data.decisions || []).slice(0, 6);
      c.innerHTML = decs.length ? decs.map(d => {
        const col = d.confidence >= 0.7 ? 'var(--green)' : d.confidence >= 0.5 ? 'var(--yellow)' : 'var(--red)';
        return `<div class="decision-card"><div class="decision-header"><span class="decision-action ${esc(d.action)}">${esc(d.action)}</span>
        <div class="decision-confidence"><div class="confidence-bar"><div class="confidence-bar-fill" style="width:${d.confidence * 100}%;background:${col}"></div></div><span style="color:${col}">${(d.confidence * 100).toFixed(0)}%</span></div></div>
        <div class="decision-meta"><span>🔷 ${esc(d.symbol || '—')}</span><span>🤖 ${esc(d.model || '—')}</span><span>${esc((d.createdAt || '').slice(0, 16))}</span></div>
        ${d.reasoning ? `<div class="decision-reasoning">${esc(d.reasoning)}</div>` : ''}</div>`;
      }).join('') : `<p style="text-align:center;color:var(--text-muted);padding:24px;">${App.state.lang === 'ar' ? 'لا توجد قرارات' : 'No decisions yet'}</p>`;
    } catch {}
  },

  async loadLogs() {
    try {
      const data = await App.api('/api/logs');
      const c = document.getElementById('logsContainer');
      if (!c) return;
      const logs = (data.logs || []).slice(0, 30);
      c.innerHTML = logs.map(l => `<div class="log-entry"><span class="log-time">${esc(new Date(l.t).toLocaleTimeString('ar-EG'))}</span><span class="log-level ${esc(l.level || 'info')}">${esc((l.level || 'info').toUpperCase())}</span><span class="log-msg">${esc(l.msg)}</span></div>`).join('');
    } catch {}
  },

  loadChart() {
    const c = document.getElementById('chartContainer');
    const s = JSON.stringify(document.getElementById('chartSymbolSelect')?.value || 'BTCUSDT').replace(/"/g,'');
    if (!c) return;
    const th = App.state.theme === 'dark' ? 'dark' : 'light';
    c.innerHTML = `<iframe class="tv-frame" src="about:blank" data-symbol="${esc(s)}" data-theme="${th}"></iframe>`;
    // Load TradingView embed via their widget.js (bypass CSP issues, uses allowed domains)
    const f = c.querySelector('.tv-frame');
    const build = () => {
      f.src = `https://s.tradingview.com/widgetembed/?frameElementId=tv&symbol=BINANCE:${encodeURIComponent(s)}&interval=15&theme=${th}&style=1&locale=ar&hide_side_toolbar=0&hide_top_toolbar=1&allow_symbol_change=true&saveimage=0`;
    };
    build();
    // Retry if iframe fails to render (Cross-origin resets)
    setTimeout(build, 2500);
  },

  // Load chart for market page
  loadMarketChart(symbol) {
    const cc = document.getElementById('marketChartContainer');
    if (!cc) return;
    const s = JSON.stringify(symbol || 'BTCUSDT').replace(/"/g,'');
    const th = App.state.theme === 'dark' ? 'dark' : 'light';
    cc.innerHTML = `<iframe class="tv-frame" src="https://s.tradingview.com/widgetembed/?frameElementId=tv&symbol=BINANCE:${encodeURIComponent(s)}&interval=15&theme=${th}&style=1&locale=ar&hide_side_toolbar=0&hide_top_toolbar=1&allow_symbol_change=true&saveimage=0" allowtransparency="true"></iframe>`;
  },

  async loadMarketPage() {
    try {
      const cfg = await App.api('/api/config');
      const symbols = cfg.config?.WATCH_SYMBOLS?.split(',').map(s => s.trim()).filter(Boolean) || ['BTCUSDT'];
      const cards = document.getElementById('marketCards');
      if (!cards) return;
      cards.innerHTML = symbols.map(s => `<div class="card" id="mkt-${esc(s)}"><div class="card-label">${esc(s)}</div><div class="card-value" style="font-size:20px">...</div></div>`).join('');
      for (const s of symbols) {
        try {
          const t = await App.api(`/api/market/ticker?symbol=${s}`);
          const e = document.getElementById(`mkt-${s}`);
          if (e) e.innerHTML = `<div class="card-label">${esc(t.symbol)}</div><div class="card-value" style="font-size:22px">${esc(t.price)}</div><div class="card-sub ${t.change >= 0 ? 'up' : 'down'}">${t.change >= 0 ? '▲' : '▼'} ${esc((+t.change).toFixed(2))}%</div>`;
        } catch {}
      }
      if (symbols[0]) this.loadMarketChart(symbols[0]);
    } catch {}
  },

  async resetData() {
    if (!confirm(App.state.lang === 'ar' ? 'حذف كل البيانات؟' : 'Delete all data?')) return;
    try {
      await App.api('/api/reset', { method: 'POST', body: {} });
      App.toast('✅ Reset', 'success');
      App.loadAccount(); this.loadTrades();
    } catch {}
  },

  refresh() { App.loadAccount(); this.loadTrades(); this.loadDecisions(); this.loadLogs(); this.loadProCards(); },

  async loadProCards() {
    try { await Promise.all([this.loadAiDecision(), this.loadTopOpportunity(), this.loadPerf()]); } catch {}
  },

  async loadAiDecision() {
    try {
      const symbol = document.getElementById('chartSymbolSelect')?.value?.toUpperCase() || 'BTCUSDT';
      const d = await App.api('/api/decision', { method: 'POST', body: { symbol, useAI: false } });
      const colors = { LONG: 'var(--neon-green)', SHORT: 'var(--danger)', WAIT: 'var(--neon-amber)', NO_TRADE: 'var(--term-text-dim)' };
      const e = document.getElementById('aiDecision'); if (e) { e.textContent = d.action; e.style.color = colors[d.action] || 'var(--neon-cyan)'; }
      const c = document.getElementById('aiConfidence'); if (c) c.textContent = (d.confidence * 100).toFixed(0) + '%';
      const r = document.getElementById('aiReasoning'); if (r) r.textContent = (d.reasoning || '').slice(0, 100);
    } catch {}
  },

  async loadTopOpportunity() {
    try {
      const r = await App.api('/api/scan?limit=5');
      const top = r.ranked?.[0];
      if (!top) return;
      const e = document.getElementById('topOppSymbol'); if (e) e.textContent = top.symbol;
      const s = document.getElementById('topOppScore'); if (s) s.textContent = (top.confidence * 100).toFixed(0) + '%';
      const p = document.getElementById('topOppPrice'); if (p) p.textContent = '$' + (+top.price).toLocaleString('en', {maximumFractionDigits: 4});
      const rs = document.getElementById('topOppReason'); if (rs) rs.textContent = (top.factors?.trend || '') + ' · ' + (top.factors?.structure || '');
    } catch {}
  },

  async loadPerf() {
    try {
      const p = await App.api('/api/perf');
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
      set('latencyTotal', (p.totalMs || 0).toFixed(0) + ' ms');
      set('latMarket', (p.marketMs || 0).toFixed(0));
      set('latAnalyze', (p.analyzeMs || 0).toFixed(0));
      set('latBroker', (p.brokerMs || 0).toFixed(0));
      set('latDecision', (p.decisionMs || 0).toFixed(0));
      set('latMem', p.rss || '—');
      set('latUptime', p.uptime || '—');
    } catch {}
  },
};
