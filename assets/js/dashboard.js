'use strict';
/*
 * dashboard.js — الداش بورد: بطاقات + رسم بياني + صفقات + سجل
 */
const Dashboard = {
  init() {
    this.bindControls();
    this.loadChart();
    this.loadTrades();
    this.loadDecisions();
    this.loadLogs();
    this.renderAccount();
  },

  bindControls() {
    document.getElementById('refreshAccountBtn')?.addEventListener('click', () => App.loadAccount());
    document.getElementById('refreshTradesBtn')?.addEventListener('click', () => this.loadTrades());
    document.getElementById('resetBtn')?.addEventListener('click', async () => {
      if (!confirm('هل أنت متأكد من إعادة تعيين كل البيانات؟')) return;
      await App.api('/api/reset', { method: 'POST', body: { startBalance: 10000 } });
      App.toast('تم إعادة التعيين', 'success');
      App.init();
    });
    document.getElementById('chartSymbolSelect')?.addEventListener('change', () => this.loadChart());
  },

  renderAccount() {
    const a = App.state.account;
    if (!a) return;
    const balance = a.account?.balance || 0;
    const available = a.account?.availableBalance || 0;
    const pnl = a.account?.unrealizedProfit || 0;
    const stats = a.stats || {};
    const pos = a.positions?.length || 0;

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setHtml = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

    setVal('cardBalance', balance.toFixed(2) + ' ' + (a.account?.currency || 'USDT'));
    setVal('cardAvailable', available.toFixed(2));
    setHtml('cardPnl', `<span class="${pnl >= 0 ? 'text-green' : 'text-red'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</span>`);
    setVal('cardOpen', pos);
    setVal('cardWinRate', (stats.winRate || 0).toFixed(1) + '%');
    setVal('cardTotalTrades', stats.totalTrades || 0);
    setVal('cardTotalPnl', ((stats.totalPnl || 0) >= 0 ? '+' : '') + (stats.totalPnl || 0).toFixed(2));

    // الصفقات المفتوحة
    const tbody = document.getElementById('positionsTable');
    if (tbody) {
      if (a.positions?.length) {
        tbody.innerHTML = a.positions.map(p => `
          <tr>
            <td class="text-mono font-semibold">${p.symbol}</td>
            <td><span class="badge-tag ${p.side}">${p.side}</span></td>
            <td class="text-mono">${p.size}</td>
            <td class="text-mono">${p.entryPrice}</td>
            <td class="text-mono">${p.markPrice}</td>
            <td class="text-mono ${p.pnl >= 0 ? 'text-green' : 'text-red'}">${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}</td>
            <td><button class="btn btn-sm btn-danger" onclick="Dashboard.closePosition('${p.symbol}')">إغلاق</button></td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">لا توجد صفقات مفتوحة</td></tr>';
      }
    }

    // Mode badge
    setHtml('modeBadge', `<span class="badge-tag ${a.mode === 'paper' ? 'open' : 'sell'}">${a.mode === 'paper' ? '📝 وهمي' : '🔴 حقيقي'}</span>`);
  },

  async closePosition(symbol) {
    try {
      await App.api('/api/close', { method: 'POST', body: { symbol } });
      App.toast(`تم إغلاق ${symbol}`, 'success');
      App.loadAccount();
      this.loadTrades();
    } catch {}
  },

  async loadTrades() {
    try {
      const data = await App.api('/api/trades');
      const tbody = document.getElementById('tradesTable');
      if (!tbody) return;
      const trades = data.trades || [];
      if (trades.length) {
        tbody.innerHTML = trades.slice(0, 50).map(t => `
          <tr>
            <td class="text-mono" style="font-size:11px">${(t.createdAt || '').slice(0, 16)}</td>
            <td class="text-mono font-semibold">${t.symbol}</td>
            <td><span class="badge-tag ${t.side === 'long' ? 'long' : 'short'}">${t.side}</span></td>
            <td class="text-mono">${t.price}</td>
            <td class="text-mono">${t.qty}</td>
            <td><span class="badge-tag ${t.status}">${t.status === 'open' ? 'مفتوحة' : 'مغلقة'}</span></td>
            <td class="text-mono ${t.pnl >= 0 ? 'text-green' : 'text-red'}">${t.pnl !== undefined ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) : '—'}</td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">لا توجد صفقات بعد</td></tr>';
      }
    } catch {}
  },

  async loadDecisions() {
    try {
      const data = await App.api('/api/decisions');
      const container = document.getElementById('decisionsContainer');
      if (!container) return;
      const decs = (data.decisions || []).slice(0, 10);
      if (decs.length) {
        container.innerHTML = decs.map(d => {
          const confColor = d.confidence >= 0.7 ? 'var(--green)' : d.confidence >= 0.5 ? 'var(--yellow)' : 'var(--red)';
          return `
            <div class="decision-card">
              <div class="decision-header">
                <span class="decision-action ${d.action}">${d.action}</span>
                <div class="decision-confidence">
                  <div class="confidence-bar"><div class="confidence-bar-fill" style="width:${d.confidence * 100}%;background:${confColor}"></div></div>
                  <span style="color:${confColor}">${(d.confidence * 100).toFixed(0)}%</span>
                </div>
              </div>
              <div class="decision-meta">
                <span>🔷 ${d.symbol || '—'}</span>
                <span>🤖 ${d.model || d.provider || '—'}</span>
                <span>${(d.createdAt || '').slice(0, 16)}</span>
              </div>
              ${d.reasoning ? `<div class="decision-reasoning">${d.reasoning}</div>` : ''}
            </div>
          `;
        }).join('');
      } else {
        container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px;">لا توجد قرارات بعد — شغّل العقل أو حلّل زوج</p>';
      }
    } catch {}
  },

  async loadLogs() {
    try {
      const data = await App.api('/api/logs');
      const container = document.getElementById('logsContainer');
      if (!container) return;
      const logs = (data.logs || []).slice(0, 30);
      container.innerHTML = logs.map(l => `
        <div class="log-entry">
          <span class="log-time">${new Date(l.t).toLocaleTimeString('ar-EG')}</span>
          <span class="log-level ${l.level || 'info'}">${(l.level || 'info').toUpperCase()}</span>
          <span class="log-msg">${l.msg}</span>
        </div>
      `).join('');
    } catch {}
  },

  loadChart() {
    const container = document.getElementById('chartContainer');
    const symbol = document.getElementById('chartSymbolSelect')?.value || 'BTCUSDT';
    if (!container) return;

    const theme = App.state.theme === 'dark' ? 1 : 2;
    container.innerHTML = `<iframe src="https://s.tradingview.com/widgetembed/?frameElementId=tradingview&symbol=BINANCE:${symbol}&interval=15&theme=${theme}&style=1&locale=ar&toolbar_bg=%23111a2e&enable_publishing=false&hide_top_toolbar=false&hide_legend=false&withdateranges=true&allow_symbol_change=false" allowtransparency="true"></iframe>`;
  },

  refresh() {
    App.loadAccount();
    this.loadTrades();
    this.loadDecisions();
    this.loadLogs();
  },
};
