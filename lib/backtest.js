'use strict';
// backtest.js v3 — Confluence backtester mirroring the real decision engine
const config = require('./config');
const store = require('./store');
const market = require('./market');

function _ema(arr, period) {
  const k = 2/(period+1); let prev = arr[0];
  for (let i = 1; i < arr.length; i++) prev = arr[i]*k + prev*(1-k);
  return prev;
}

function _ind(klines) {
  if (!klines || klines.length < 30) return null;
  const closes = klines.map(k => k.close);
  const c = closes[closes.length-1];
  // RSI
  let gain=0, loss=0; const rp=14;
  for (let i=1;i<=rp;i++){const d=closes[i]-closes[i-1]; if(d>0)gain+=d; else loss-=d;}
  gain/=rp; loss/=rp;
  for (let i=rp+1;i<closes.length;i++){const d=closes[i]-closes[i-1]; gain=(gain*(rp-1)+(d>0?d:0))/rp; loss=(loss*(rp-1)+(d<0?-d:0))/rp;}
  const rsi = loss===0 ? 100 : 100-(100/(1+gain/loss));
  // BB
  const n=Math.min(20,closes.length); const sma=closes.slice(-n).reduce((a,b)=>a+b,0)/n;
  let v=0; for(let i=closes.length-n;i<closes.length;i++) v+=Math.pow(closes[i]-sma,2); v/=n;
  const sd=Math.sqrt(v); const bbHigh=sma+2*sd, bbLow=sma-2*sd, bbMid=sma;
  // EMA
  const ema9=_ema(closes,9), ema21=_ema(closes,21);
  // ATR
  const atrN=Math.min(14,klines.length-1); let atr=0;
  for(let i=klines.length-atrN;i<klines.length;i++) atr+=klines[i].high-klines[i].low;
  atr/=atrN; const atrPct=atr/c;
  // ADX (simplified)
  let trS=0,pS=0,mS=0;
  for(let i=1;i<=Math.min(14,closes.length-1);i++){
    const h=klines[klines.length-i].high,l=klines[klines.length-i].low;
    const ph=klines[klines.length-i-1].high,pl=klines[klines.length-i-1].low;
    const pc=klines[klines.length-i-1].close;
    const tr=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
    const pDM=(h-ph>pl-l&&h-ph>0)?h-ph:0;
    const mDM=(pl-l>h-ph&&pl-l>0)?pl-l:0;
    trS+=tr; pS+=pDM; mS+=mDM;
  }
  const atrADX=trS/Math.min(14,closes.length-1);
  const pDI=atrADX>0?(pS/14)/atrADX*100:0;
  const mDI=atrADX>0?(mS/14)/atrADX*100:0;
  const dxS=pDI+mDI;
  const ADX=dxS>0?Math.abs(pDI-mDI)/dxS*100:0;
  const regime=ADX>25?'trending':ADX<20?'ranging':'transitional';
  // Volume
  const volRatio = klines.length>=4 ? +(klines[klines.length-1].volume/(klines.slice(-4,-1).reduce((s,k)=>s+k.volume,0)/3)).toFixed(2) : 1;
  // HH/HL/LH/LL structure — using higher timeframe (10-bar lookback, fresh highs/lows)
  const look = 8;
  const recent = klines.slice(-look-2, -2);
  const last2 = klines.slice(-2);
  const recentHigh = Math.max(...recent.map(k=>k.high));
  const recentLow = Math.min(...recent.map(k=>k.low));
  const lastHigh = Math.max(...last2.map(k=>k.high));
  const lastLow = Math.min(...last2.map(k=>k.low));
  let structure='range';
  // HH+HL: last bar makes higher high AND higher low than recent
  if (lastHigh>recentHigh && lastLow>recentLow) structure='HH/HL';
  // LH+LL: last bar makes lower high AND lower low than recent
  else if (lastHigh<recentHigh && lastLow<recentLow) structure='LH/LL';
  // BOS (break of structure): single direction break
  else if (lastHigh>recentHigh) structure='BOS-UP';
  else if (lastLow<recentLow) structure='BOS-DOWN';
  // Order flow (simple bull/bear volume)
  let bVol=0, sVol=0;
  for(const k of klines.slice(-10)) { if(k.close>k.open) bVol+=k.volume; else sVol+=k.volume; }
  const flow = bVol>sVol ? 'buy' : 'sell';
  return { price:c, rsi:+rsi.toFixed(2), bbHigh:+bbHigh.toFixed(6), bbMid:+bbMid.toFixed(6), bbLow:+bbLow.toFixed(6), atr:+atr.toFixed(6), atrPct, ema9:+ema9.toFixed(6), ema21:+ema21.toFixed(6), trendUp: ema9>ema21&&c>ema21, trendDown: ema9<ema21&&c<ema21, adx:+ADX.toFixed(2), regime, volRatio, structure, flow };
}

async function runBacktest(symbol, klines, strategy = {}) {
  if (!klines?.length) return { ok: false, error: 'no klines' };
  let wins=0, losses=0, maxDD=0, peak=0, equity=0, maxCons=0, cons=0;
  const trades=[];
  let totalBars=0, longs=0, shorts=0;

  for (let i=50; i<klines.length-1; i++) {
    totalBars++;
    const window = klines.slice(i-50, i);
    const ind = _ind(window);
    if (!ind) continue;

    // === Confluence scoring (mirrors decision-engine.js) ===
    const W = { mtf:0.25, structure:0.15, rsi:0.20, bb:0.15, flow:0.10, pattern:0.10 };
    let bullScore=0, bearScore=0;
    const regime = ind.regime;

    // 1) EMA trend (MTF proxy)
    if (ind.trendUp) bullScore += W.mtf;
    else if (ind.trendDown) bearScore += W.mtf;

    // 2) Market structure (HH/HL most powerful)
    if (ind.structure==='HH/HL' || ind.structure==='BOS-UP') bullScore += W.structure;
    else if (ind.structure==='LH/LL' || ind.structure==='BOS-DOWN') bearScore += W.structure;

    // 3) RSI — regime-aware (stronger weight in trending)
    if (regime==='ranging') {
      if (ind.rsi<30) bullScore += W.rsi;
      else if (ind.rsi>70) bearScore += W.rsi;
      else if (ind.rsi<40 && ind.rsi>35) bullScore += W.rsi*0.5;
      else if (ind.rsi>60 && ind.rsi<65) bearScore += W.rsi*0.5;
    } else {
      // Trending: momentum continuation
      if (ind.rsi>55 && ind.rsi<70 && ind.trendUp) bullScore += W.rsi*0.9;
      else if (ind.rsi<45 && ind.rsi>30 && ind.trendDown) bearScore += W.rsi*0.9;
      // Pullback entries
      if (ind.rsi>40 && ind.rsi<50 && ind.trendUp) bullScore += W.rsi*0.6;
      if (ind.rsi<60 && ind.rsi>50 && ind.trendDown) bearScore += W.rsi*0.6;
    }

    // 4) Bollinger — regime-aware
    if (regime==='ranging') {
      if (ind.price<=ind.bbLow) bullScore += W.bb;
      else if (ind.price>=ind.bbHigh) bearScore += W.bb;
    } else {
      // Trend continuation: price above mid in uptrend
      if (ind.price>ind.bbMid && ind.trendUp) bullScore += W.bb*0.5;
      if (ind.price<ind.bbMid && ind.trendDown) bearScore += W.bb*0.5;
    }

    // 5) Order flow + volume
    if (ind.flow==='buy') bullScore += W.flow;
    else if (ind.flow==='sell') bearScore += W.flow;
    if (ind.volRatio>1.5) { bullScore+=W.flow*0.2; bearScore+=W.flow*0.2; }
    if (ind.volRatio<0.5) { /* low volume — weak signal */ bullScore*=0.85; bearScore*=0.85; }

    // 6) ATR filter — filter dead/crash
    if (ind.atrPct < 0.0003 || ind.atrPct > 0.05) continue;

    // 7) Decide action (minConf=0.55)
    const minConf = strategy.minScore || strategy.minConf || 0.45;
    const delta = Math.abs(bullScore-bearScore);
    const confidence = +(delta/(W.mtf+W.structure+W.rsi+W.bb+W.flow)).toFixed(3);
    let action=null;
    if (ind.atrPct<0.0003||ind.atrPct>0.05) continue;
    // Strict confluence: require both delta AND minimum score
    const threshold = strategy.threshold || 0.1;
    if (bullScore-bearScore > threshold && bullScore > minConf) action='BUY';
    else if (bearScore-bullScore > threshold && bearScore > minConf) action='SELL';
    if (!action) continue;

    // Cooldown: skip if last trade was within 3 bars
    if (trades.length && i - trades[trades.length-1].i < 3) continue;

    // 8) ATR-adaptive SL/TP (per-symbol volatility auto-fit)
    // If strategy explicitly provides slPct/tpPct, use them; otherwise use ATR multiple
    const slPct = strategy.slPct && strategy.slPct > 0 ? strategy.slPct : Math.max(0.003, ind.atrPct * 1.5);
    const tpPct = strategy.tpPct && strategy.tpPct > 0 ? strategy.tpPct : Math.max(0.006, ind.atrPct * 3.0);
    // Cap SL at 5% to prevent runaway losses, floor at 0.3%
    const slCap = Math.min(0.05, Math.max(0.003, slPct));
    const tpCap = Math.min(0.10, Math.max(0.005, tpPct));

    if (action==='BUY') longs++; else shorts++;
    const entry=klines[i].close;
    const sl = action==='BUY' ? entry*(1-slCap) : entry*(1+slCap);
    const tp = action==='BUY' ? entry*(1+tpCap) : entry*(1-tpCap);
    let exit=entry, exitIdx=i+1, reason='time';
    const maxHold = strategy.maxHold || 20;

    for(let j=i+1;j<Math.min(klines.length, i+1+maxHold);j++){
      const k=klines[j];
      if(action==='BUY' && k.low<=sl){exit=sl;reason='SL';exitIdx=j;break;}
      if(action==='SELL' && k.high>=sl){exit=sl;reason='SL';exitIdx=j;break;}
      if(action==='BUY' && k.high>=tp){exit=tp;reason='TP';exitIdx=j;break;}
      if(action==='SELL' && k.low<=tp){exit=tp;reason='TP';exitIdx=j;break;}
      exit=k.close; exitIdx=j;
    }

    const pnlPct = (action==='BUY' ? exit-entry : entry-exit) / entry * 100;
    equity += pnlPct;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity-peak);
    if (pnlPct>0) { wins++; cons++; maxCons=Math.max(maxCons,cons); }
    else { losses++; cons=0; }
    trades.push({ i, action, entry:+entry.toFixed(6), exit:+exit.toFixed(6), pnl:+pnlPct.toFixed(4), reason, held:exitIdx-i, conf: confidence });
  }

  const total=wins+losses;
  return {
    ok:true, symbol, totalTrades:total, wins, losses,
    winRate: total ? +(wins/total*100).toFixed(2) : 0,
    avgReturn: total ? +(equity/total).toFixed(2) : 0,
    totalReturn: +equity.toFixed(2),
    maxDrawdown: +maxDD.toFixed(2),
    maxConsecutiveWins: maxCons,
    longs, shorts,
    period: { start:klines[0]?.time, end:klines[klines.length-1]?.time },
    bars: totalBars,
    trades: trades.slice(-100),
  };
}

function getPerformanceAnalytics() {
  const trades = store.getTrades().filter(t=>t.status==='closed');
  if (!trades.length) return { total:0, winRate:0, avgWin:0, avgLoss:0, sharpe:0, maxDD:0 };
  const pnls = trades.map(t => +(t.pnl||0));
  const wins=pnls.filter(p=>p>0), losses=pnls.filter(p=>p<0);
  const mean = pnls.reduce((s,p)=>s+p,0)/pnls.length;
  const inv = pnls.reduce((s,p)=>s+Math.pow(p-mean,2),0)/pnls.length;
  const sharpe = inv>0 ? +(mean/Math.sqrt(inv)).toFixed(3) : 0;
  let peak=0, dd=0, cum=0;
  pnls.forEach(p=>{cum+=p;peak=Math.max(peak,cum);dd=Math.min(dd,cum-peak);});
  return {
    total: pnls.length, winRate: +(wins.length/pnls.length*100).toFixed(1),
    avgWin: wins.length ? +(wins.reduce((s,p)=>s+p,0)/wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(losses.reduce((s,p)=>s+p,0)/losses.length).toFixed(2) : 0,
    sharpe, maxDD:+dd.toFixed(2),
  };
}

module.exports = { runBacktest, getPerformanceAnalytics };