'use strict';
// backtest.js — Portfolio backtest UI controller
const Backtest = {
  async run(quick = false) {
    const symbols = document.getElementById('btSymbols')?.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) || [];
    if (!symbols.length) { toast('error', 'أدخل زوجًا واحدًا على الأقل'); return; }
    const strategy = {
      slPct: +document.getElementById('btSl')?.value || 0.003,
      tpPct: +document.getElementById('btTp')?.value || 0.020,
      minScore: +document.getElementById('btMinScore')?.value || 0.45,
      maxHold: +document.getElementById('btMaxHold')?.value || 15,
    };
    const timeframe = document.getElementById('btTimeframe')?.value || '15m';
    const limit = quick ? 300 : (+document.getElementById('btLimit')?.value || 1000);

    const status = document.getElementById('btStatus');
    if (status) status.innerHTML = '<span style="color:var(--accent-cyan);">⏳ جاري التحليل...</span>';

    const start = Date.now();
    try {
      const res = await api('/api/backtest/portfolio', {
        method: 'POST',
        body: JSON.stringify({ symbols, timeframe, limit, strategy }),
      });
      const ms = Date.now() - start;
      if (!res || !res.ok) {
        if (status) status.innerHTML = '<span style="color:var(--accent-red);">✗ فشل الاختبار</span>';
        return;
      }

      const t = res.totalTrades || 0;
      document.getElementById('btWinRate').textContent = t ? res.portfolioWinRate + '%' : '—';
      document.getElementById('btReturn').textContent = (res.totalReturn >= 0 ? '+' : '') + res.totalReturn + '%';
      document.getElementById('btReturn').style.color = res.totalReturn >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
      document.getElementById('btDD').textContent = res.portfolioMaxDD + '%';
      document.getElementById('btDD').style.color = 'var(--accent-red)';
      document.getElementById('btTrades').textContent = t;

      const tbody = document.getElementById('btResultsTable');
      if (tbody) {
        if (!res.results?.length) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;opacity:0.5;">لا نتائج</td></tr>';
        } else {
          tbody.innerHTML = res.results.map(r => {
            const retColor = r.totalReturn >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
            return `<tr>
              <td><b style="color:var(--accent-cyan);">${esc(r.symbol)}</b></td>
              <td>${r.trades}</td>
              <td style="color:var(--accent-green);">${r.wins}</td>
              <td style="color:var(--accent-red);">${r.losses}</td>
              <td><b>${r.winRate}%</b></td>
              <td style="color:${retColor};font-weight:700;">${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%</td>
              <td style="color:var(--accent-red);">${r.maxDrawdown}%</td>
              <td><span style="color:var(--accent-green);">${r.longs}↑</span> / <span style="color:var(--accent-red);">${r.shorts}↓</span></td>
            </tr>`;
          }).join('');
        }
      }

      if (status) status.innerHTML = `<span style="color:var(--accent-green);">✓ اكتمل في ${ms}ms — ${symbols.length} رمز، ${t} صفقة</span>`;
    } catch (e) {
      if (status) status.innerHTML = '<span style="color:var(--accent-red);">✗ ' + esc(e.message) + '</span>';
    }
  },
};

window.Backtest = Backtest;
