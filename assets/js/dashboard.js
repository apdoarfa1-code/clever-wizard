'use strict';
const Dashboard = {
  init() {
    this.loadChart();
    this.loadTrades();
    this.loadDecisions();
    this.loadLogs();
    this.renderAccount();
  },

  renderAccount() {
    const a = App.state.account; if (!a) return;
    const balance = a.account?.balance || 0, available = a.account?.availableBalance || 0, pnl = a.account?.unrealizedProfit || 0;
    const stats = a.stats || {}, pos = a.positions?.length || 0;
    const setVal = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    const setHtml = (id, v) => { const e = document.getElementById(id); if (e) e.innerHTML = v; };
    setVal('cardBalance', balance.toFixed(2) + ' ' + (a.account?.currency || 'USDT'));
    setVal('cardAvailable', (App.state.lang === 'ar' ? 'متاح' : 'Avail') + ': ' + available.toFixed(2));
    setHtml('cardPnl', `<span class="${pnl >= 0 ? 'text-green' : 'text-red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>`);
    setVal('cardOpen', pos);
    setVal('cardWinRate', (stats.winRate || 0).toFixed(1) + '%');
    setVal('cardTotalTrades', stats.totalTrades || 0);
    setVal('cardTotalPnl', ((stats.totalPnl || 0) >= 0 ? '+' : '') + (stats.totalPnl || 0).toFixed(2));

    const tbody = document.getElementById('positionsTable');
    if (tbody) {
      tbody.innerHTML = (a.positions?.length ? a.positions.map(p => `<tr>
        <td class="text-mono font-semibold">${p.symbol}</td>
        <td><span class="badge-tag ${p.side}">${p.side}</span></td>
        <td class="text-mono">${p.size}</td>
        <td class="text-mono">${p.entryPrice}</td>
        <td class="text-mono">${p.markPrice}</td>
        <td class="text-mono ${p.pnl >= 0 ? 'text-green' : 'text-red'}">${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}</td>
        <td><button class="btn btn-sm btn-danger" onclick="Dashboard.closePosition('${p.symbol}')">✕</button></td>
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
        <td class="text-mono" style="font-size:11px">${(t.createdAt || '').slice(0, 16)}</td>
        <td class="text-mono font-semibold">${t.symbol}</td>
        <td><span class="badge-tag ${t.side === 'long' ? 'long' : 'short'}">${t.side}</span></td>
        <td class="text-mono">${t.price}</td>
        <td class="text-mono">${t.qty}</td>
        <td><span class="badge-tag ${t.status}">${t.status === 'open' ? (App.state.lang === 'ar' ? 'مفتوحة' : 'Open') : (App.state.lang === 'ar' ? 'مغلقة' : 'Closed')}</span></td>
        <td class="text-mono ${t.pnl >= 0 ? 'text-green' : 'text-red'}">${t.pnl !== undefined ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) : '—'}</td>
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
        return `<div class="decision-card"><div class="decision-header"><span class="decision-action ${d.action}">${d.action}</span>
        <div class="decision-confidence"><div class="confidence-bar"><div class="confidence-bar-fill" style="width:${d.confidence * 100}%;background:${col}"></div></div><span style="color:${col}">${(d.confidence * 100).toFixed(0)}%</span></div></div>
        <div class="decision-meta"><span>🔷 ${d.symbol || '—'}</span><span>🤖 ${d.model || '—'}</span><span>${(d.createdAt || '').slice(0, 16)}</span></div>
        ${d.reasoning ? `<div class="decision-reasoning">${d.reasoning}</div>` : ''}</div>`;
      }).join('') : `<p style="text-align:center;color:var(--text-muted);padding:24px;">${App.state.lang === 'ar' ? 'لا توجد قرارات' : 'No decisions yet'}</p>`;
    } catch {}
  },

  async loadLogs() {
    try {
      const data = await App.api('/api/logs');
      const c = document.getElementById('logsContainer');
      if (!c) return;
      const logs = (data.logs || []).slice(0, 30);
      c.innerHTML = logs.map(l => `<div class="log-entry"><span class="log-time">${new Date(l.t).toLocaleTimeString('ar-EG')}</span><span class="log-level ${l.level || 'info'}">${(l.level || 'info').toUpperCase()}</span><span class="log-msg">${l.msg}</span></div>`).join('');
    } catch {}
  },

  loadChart() {
    const c = document.getElementById('chartContainer');
    const s = document.getElementById('chartSymbolSelect')?.value || 'BTCUSDT';
    if (!c) return;
    const th = App.state.theme === 'dark' ? '1' : '2';
    c.innerHTML = `<iframe src="https://s.tradingview.com/widgetembed/?frameElementId=tv&symbol=BINANCE:${s}&interval=15&theme=${th}&style=1&locale=ar&hide_side_toolbar=0&allow_symbol_change=true" allowtransparency="true"></iframe>`;
  },

  async loadMarketPage() {
    try {
      const cfg = await App.api('/api/config');
      const symbols = cfg.config?.WATCH_SYMBOLS?.split(',').map(s => s.trim()).filter(Boolean) || ['BTCUSDT'];
      const cards = document.getElementById('marketCards');
      if (!cards) return;
      cards.innerHTML = symbols.map(s => `<div class="card" id="mkt-${s}"><div class="card-label">${s}</div><div class="card-value" style="font-size:20px">...</div></div>`).join('');
      for (const s of symbols) {
        try {
          const t = await App.api(`/api/market/ticker?symbol=${s}`);
          const e = document.getElementById(`mkt-${s}`);
          if (e) e.innerHTML = `<div class="card-label">${t.symbol}</div><div class="card-value" style="font-size:22px">${t.price}</div><div class="card-sub ${t.change >= 0 ? 'up' : 'down'}">${t.change >= 0 ? '▲' : '▼'} ${t.change.toFixed(2)}%</div>`;
        } catch {}
      }
      const th = App.state.theme === 'dark' ? '1' : '2';
      const cc = document.getElementById('marketChartContainer');
      if (cc) cc.innerHTML = `<iframe src="https://s.tradingview.com/widgetembed/?frameElementId=tv&symbol=BINANCE:${symbols[0]}&interval=15&theme=${th}&style=1&locale=ar&hide_side_toolbar=0&allow_symbol_change=true" allowtransparency="true"></iframe>`;
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

  refresh() { App.loadAccount(); this.loadTrades(); this.loadDecisions(); this.loadLogs(); },
};
