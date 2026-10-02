'use strict';
// backtest-worker.js — Runs inside Worker Thread
// Receives: { id, task: { type: 'portfolio'|'single', symbol, klines, strategy } }
// Returns: { id, result } or { id, error }
const { parentPort } = require('worker_threads');

if (parentPort) {
  parentPort.postMessage({ type: 'ready' });
  parentPort.on('message', (msg) => {
    try {
      const { id, task } = msg;
      if (!task || !task.type) throw new Error('invalid task type');
      let result;
      switch (task.type) {
        case 'portfolio':
          result = portfolioBacktest(task);
          break;
        case 'single':
          result = singleBacktest(task);
          break;
        case 'optimize':
          result = optimizeBacktest(task);
          break;
        default:
          throw new Error('unknown task: ' + task.type);
      }
      parentPort.postMessage({ id, result });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message });
    }
  });
}

// === Inline backtest logic (mirrors lib/backtest.js, runs in worker) ===
function _ema(arr, p) {
  const k = 2/(p+1); let prev = arr[0];
  for (let i = 1; i < arr.length; i++) prev = arr[i]*k + prev*(1-k);
  return prev;
}

function _ind(klines) {
  if (!klines || klines.length < 30) return null;
  const closes = klines.map(k => +k.close);
  const c = closes[closes.length-1];
  let gain=0, loss=0; const rp=14;
  for (let i=1;i<=rp;i++){const d=closes[i]-closes[i-1]; if(d>0)gain+=d; else loss-=d;}
  gain/=rp; loss/=rp;
  for (let i=rp+1;i<closes.length;i++){const d=closes[i]-closes[i-1]; gain=(gain*(rp-1)+(d>0?d:0))/rp; loss=(loss*(rp-1)+(d<0?-d:0))/rp;}
  const rsi = loss===0?100:100-(100/(1+gain/loss));
  const n=Math.min(20,closes.length); const sma=closes.slice(-n).reduce((a,b)=>a+b,0)/n;
  let v=0; for(let i=closes.length-n;i<closes.length;i++) v+=Math.pow(closes[i]-sma,2); v/=n;
  const sd=Math.sqrt(v); const bbHigh=sma+2*sd, bbLow=sma-2*sd, bbMid=sma;
  const ema9=_ema(closes,9), ema21=_ema(closes,21);
  const atrN=Math.min(14,klines.length-1); let atr=0;
  for(let i=klines.length-atrN;i<klines.length;i++) atr+=klines[i].high-klines[i].low;
  atr/=atrN; const atrPct=atr/c;
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
  const atrA=trS/Math.min(14,closes.length-1);
  const pDI=atrA>0?(pS/14)/atrA*100:0;
  const mDI=atrA>0?(mS/14)/atrA*100:0;
  const dxS=pDI+mDI;
  const ADX=dxS>0?Math.abs(pDI-mDI)/dxS*100:0;
  const regime=ADX>25?'trending':ADX<20?'ranging':'transitional';
  const volRatio = klines.length>=4 ? +(klines[klines.length-1].volume/(klines.slice(-4,-1).reduce((s,k)=>s+k.volume,0)/3)).toFixed(2) : 1;
  const recent = klines.slice(-10,-2);
  const last2 = klines.slice(-2);
  const recentHigh = Math.max(...recent.map(k=>k.high));
  const recentLow = Math.min(...recent.map(k=>k.low));
  const lastHigh = Math.max(...last2.map(k=>k.high));
  const lastLow = Math.min(...last2.map(k=>k.low));
  let structure='range';
  if (lastHigh>recentHigh && lastLow>recentLow) structure='HH/HL';
  else if (lastHigh<recentHigh && lastLow<recentLow) structure='LH/LL';
  else if (lastHigh>recentHigh) structure='BOS-UP';
  else if (lastLow<recentLow) structure='BOS-DOWN';
  let bVol=0,sVol=0;
  for(const k of klines.slice(-10)) { if(k.close>k.open) bVol+=k.volume; else sVol+=k.volume; }
  const flow = bVol>sVol ? 'buy' : 'sell';
  return { price:c, rsi:+rsi.toFixed(2), bbHigh:+bbHigh.toFixed(6), bbMid:+bbMid.toFixed(6), bbLow:+bbLow.toFixed(6), atr:+atr.toFixed(6), atrPct, ema9:+ema9.toFixed(6), ema21:+ema21.toFixed(6), trendUp:ema9>ema21&&c>ema21, trendDown:ema9<ema21&&c<ema21, adx:+ADX.toFixed(2), regime, volRatio, structure, flow };
}

function _runOne(symbol, klines, strategy) {
  const slPctCap = Math.min(0.05, Math.max(0.003, strategy.slPct || 0.003));
  const tpPctCap = Math.min(0.10, Math.max(0.005, strategy.tpPct || 0.020));
  let wins=0, losses=0, maxDD=0, peak=0, equity=0, maxCons=0, cons=0, longs=0, shorts=0;
  const trades = [];
  const W = { mtf:0.25, structure:0.15, rsi:0.20, bb:0.15, flow:0.10 };
  for (let i=50; i<klines.length-1; i++) {
    const window = klines.slice(i-50, i);
    const ind = _ind(window);
    if (!ind) continue;
    if (ind.atrPct<0.0003||ind.atrPct>0.05) continue;
    let bullScore=0, bearScore=0;
    const regime = ind.regime;
    if (ind.trendUp) bullScore += W.mtf;
    if (ind.trendDown) bearScore += W.mtf;
    if (ind.structure==='HH/HL'||ind.structure==='BOS-UP') bullScore += W.structure;
    if (ind.structure==='LH/LL'||ind.structure==='BOS-DOWN') bearScore += W.structure;
    if (regime==='ranging') {
      if (ind.rsi<30) bullScore += W.rsi;
      else if (ind.rsi>70) bearScore += W.rsi;
      else if (ind.rsi<40 && ind.rsi>35) bullScore += W.rsi*0.5;
      else if (ind.rsi>60 && ind.rsi<65) bearScore += W.rsi*0.5;
      if (ind.price<=ind.bbLow) bullScore += W.bb;
      else if (ind.price>=ind.bbHigh) bearScore += W.bb;
    } else {
      if (ind.rsi>55 && ind.rsi<70 && ind.trendUp) bullScore += W.rsi*0.9;
      else if (ind.rsi<45 && ind.rsi>30 && ind.trendDown) bearScore += W.rsi*0.9;
      if (ind.rsi>40 && ind.rsi<50 && ind.trendUp) bullScore += W.rsi*0.6;
      if (ind.rsi<60 && ind.rsi>50 && ind.trendDown) bearScore += W.rsi*0.6;
      if (ind.price>ind.bbMid && ind.trendUp) bullScore += W.bb*0.5;
      if (ind.price<ind.bbMid && ind.trendDown) bearScore += W.bb*0.5;
    }
    if (ind.flow==='buy') bullScore += W.flow;
    else if (ind.flow==='sell') bearScore += W.flow;
    if (ind.volRatio>1.5) { bullScore+=W.flow*0.2; bearScore+=W.flow*0.2; }
    if (ind.volRatio<0.5) { bullScore*=0.85; bearScore*=0.85; }
    const minConf = strategy.minScore || 0.45;
    const threshold = 0.1;
    let action=null;
    if (bullScore-bearScore > threshold && bullScore > minConf) action='BUY';
    else if (bearScore-bullScore > threshold && bearScore > minConf) action='SELL';
    if (!action) continue;
    if (trades.length && i - trades[trades.length-1].i < 3) continue;
    if (action==='BUY') longs++; else shorts++;
    const entry=klines[i].close;
    const sl = action==='BUY' ? entry*(1-slPctCap) : entry*(1+slPctCap);
    const tp = action==='BUY' ? entry*(1+tpPctCap) : entry*(1-tpPctCap);
    let exit=entry, exitIdx=i+1, reason='time';
    const maxHold = strategy.maxHold || 15;
    for(let j=i+1;j<Math.min(klines.length, i+1+maxHold);j++){
      const k=klines[j];
      if(action==='BUY'&&k.low<=sl){exit=sl;reason='SL';exitIdx=j;break;}
      if(action==='SELL'&&k.high>=sl){exit=sl;reason='SL';exitIdx=j;break;}
      if(action==='BUY'&&k.high>=tp){exit=tp;reason='TP';exitIdx=j;break;}
      if(action==='SELL'&&k.low<=tp){exit=tp;reason='TP';exitIdx=j;break;}
      exit=k.close; exitIdx=j;
    }
    const pnlPct = (action==='BUY'?exit-entry:entry-exit)/entry*100;
    equity += pnlPct;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity-peak);
    if (pnlPct>0) { wins++; cons++; maxCons=Math.max(maxCons,cons); }
    else { losses++; cons=0; }
    trades.push({ i, action, pnl:+pnlPct.toFixed(4), reason, held:exitIdx-i });
  }
  const total=wins+losses;
  return {
    ok: true, symbol, totalTrades: total, wins, losses,
    winRate: total?+(wins/total*100).toFixed(2):0,
    avgReturn: total?+(equity/total).toFixed(2):0,
    totalReturn: +equity.toFixed(2),
    maxDrawdown: +maxDD.toFixed(2),
    maxConsecutiveWins: maxCons,
    longs, shorts,
    trades: trades.slice(-50),
  };
}

function singleBacktest(task) {
  const { symbol, klines, strategy } = task;
  return _runOne(symbol, klines, strategy);
}

function portfolioBacktest(task) {
  const { symbols, klinesArr, strategy } = task;
  const results = [];
  let totalW=0, totalL=0, totalR=0, totalDD=0;
  for (let i = 0; i < symbols.length; i++) {
    if (!klinesArr[i] || klinesArr[i].length < 60) continue;
    const r = _runOne(symbols[i], klinesArr[i], strategy);
    if (r.ok) {
      totalW+=r.wins; totalL+=r.losses; totalR+=r.totalReturn;
      totalDD=Math.min(totalDD, r.maxDrawdown);
      results.push({ symbol:r.symbol, trades:r.totalTrades, wins:r.wins, losses:r.losses, winRate:r.winRate, totalReturn:r.totalReturn, maxDrawdown:r.maxDrawdown, longs:r.longs, shorts:r.shorts });
    }
  }
  const t = totalW+totalL;
  return { ok: true, symbols: symbols.length, totalTrades: t, totalWins: totalW, totalLosses: totalL, portfolioWinRate: t?+(totalW/t*100).toFixed(2):0, totalReturn: +totalR.toFixed(2), portfolioMaxDD: +totalDD.toFixed(2), results };
}

function optimizeBacktest(task) {
  const { symbol, klines } = task;
  const slGrid = [0.003, 0.004, 0.005, 0.006, 0.008];
  const tpGrid = [0.008, 0.010, 0.012, 0.015, 0.020];
  const results = [];
  for (const sl of slGrid) for (const tp of tpGrid) {
    const r = _runOne(symbol, klines, { slPct: sl, tpPct: tp, minScore: 0.45, maxHold: 15 });
    if (r.ok) results.push({ slPct: sl, tpPct: tp, trades: r.totalTrades, winRate: r.winRate, return: r.totalReturn, maxDD: r.maxDrawdown, rr: tp/sl, profitFactor: r.losses>0?+(r.wins*tp/(r.losses*sl)).toFixed(2):0 });
  }
  results.sort((a,b) => b.return - a.return);
  return { ok: true, symbol, best: results.slice(0,5), worst: results.slice(-3), all: results };
}