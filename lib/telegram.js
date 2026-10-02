'use strict';
/*
 * telegram.js — إرسال واستقبال رسائل تليجرام (بدون مكتبات خارجية)
 */
const httpLib = require('./http');
const config = require('./config');
const store = require('./store');

const TG_BASE = 'https://api.telegram.org';

function botUrl(method) {
  const token = config.get('TELEGRAM_BOT_TOKEN', '');
  return `${TG_BASE}/bot${token}/${method}`;
}

async function sendMessage(text, extra = {}) {
  const token = config.get('TELEGRAM_BOT_TOKEN', '');
  const chatId = config.get('TELEGRAM_CHAT_ID', '') || extra.chatId;
  if (!token || !chatId) { console.log('[TG] تخطي — مفتاح/Chat ID غير مضبوط'); return null; }
  const body = {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode || 'HTML',
    disable_web_page_preview: extra.disable_web_page_preview !== false,
    ...extra,
  };
  try {
    const res = await httpLib.post(botUrl('sendMessage'), body);
    if (!res.ok) console.error('[TG] إرسال فاشل:', res.raw);
    else store.addLog({ type: 'telegram', level: 'info', msg: `تم إرسال رسالة (${text.length} حرف)` });
    return res;
  } catch (e) {
    console.error('[TG] خطأ إرسال:', e.message);
    store.addLog({ type: 'telegram', level: 'error', msg: e.message });
    return null;
  }
}

function formatDecisionMsg(decision) {
  const emoji = { BUY: '🟢', SELL: '🔴', CLOSE: '🔶', HOLD: '⚪' };
  const e = emoji[decision.action] || '⚪';
  let msg = `${e} <b>قرار العقل</b>\n`;
  msg += `<b>الإجراء:</b> ${decision.action}\n`;
  if (decision.symbol) msg += `<b>الزوج:</b> ${decision.symbol}\n`;
  if (decision.side && decision.side !== 'none') msg += `<b>الاتجاه:</b> ${decision.side}\n`;
  msg += `<b>الثقة:</b> ${(decision.confidence * 100).toFixed(0)}%\n`;
  if (decision.reasoning) msg += `\n💡 <i>${decision.reasoning}</i>\n`;
  if (decision.sl) msg += `\n🛑 SL: ${decision.sl}`;
  if (decision.tp) msg += ` | 🎯 TP: ${decision.tp}`;
  if (decision.qty) msg += `\n📐 الحجم: ${decision.qty}`;
  return msg;
}

function formatTradeMsg(trade) {
  const e = trade.side === 'long' || trade.action === 'BUY' ? '🟢' : '🔴';
  const t = trade.status === 'closed' ? '📈' : '📊';
  let msg = `${e} ${t} <b>صفقة ${trade.symbol}</b>\n`;
  msg += `<b>النوع:</b> ${trade.side || trade.action}\n`;
  msg += `<b>السعر:</b> ${trade.price}\n`;
  if (trade.qty) msg += `<b>الحجم:</b> ${trade.qty}\n`;
  if (trade.pnl !== undefined) msg += `<b>الربح/الخسارة:</b> ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}\n`;
  return msg;
}

async function notifyDecision(decision) {
  return sendMessage(formatDecisionMsg(decision));
}

async function notifyTrade(trade) {
  return sendMessage(formatTradeMsg(trade));
}

async function notifyAlert(msg) {
  return sendMessage(`⚠️ <b>تنبيه</b>\n${msg}`);
}

async function testConnection() {
  try {
    const token = config.get('TELEGRAM_BOT_TOKEN', '');
    if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN غير مضبوط' };
    const res = await httpLib.get(botUrl('getMe'));
    if (!res.ok) return { ok: false, error: res.raw };
    const bot = res.json.result;
    return { ok: true, bot: { id: bot.id, username: bot.username, first_name: bot.first_name } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getUpdates(offset = 0, timeout = 0) {
  try {
    const res = await httpLib.post(botUrl('getUpdates'), { offset, timeout, allowed_updates: ['message'] });
    return res.ok ? res.json : { ok: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

// معالجة أوامر تليجرام مع تتبع offset حقيقي (لا تكرار للرسائل القديمة)
let _currentOffset = 0 - 1;
async function processCommands() {
  const token = config.get('TELEGRAM_BOT_TOKEN', '');
  if (!token) return;
  const offset = _currentOffset + 1;
  const res = await getUpdates(offset, 0);
  if (!res.ok || !res.result || !Array.isArray(res.result)) return;
  for (const update of res.result) {
    _currentOffset = Math.max(_currentOffset, update.update_id);
    const text = update.message?.text;
    const chatId = update.message?.chat?.id;
    if (!text || !chatId) continue;
    if (!text.startsWith('/')) { await sendMessage('❓ أمر غير معروف. اكتب /help للمساعدة.', { chatId }); continue; }
    const cmd = text.split(' ')[0].toLowerCase().replace(/@\w+/g, '');
    const args = text.split(' ').slice(1).join(' ');
    try {
      switch (cmd) {
        case '/start': await sendMessage('👋 مرحباً! أنا وكيل التداول الذكي.\n/status — الحالة\n/balance — الرصيد\n/analyze ZAŁĄŻĘ — تحليل\n/pause — إيقاف\n/resume — استئناف\n/help — المساعدة', { chatId }); break;
        case '/help': await sendMessage('📋 <b>الأوامر</b>:\n/status — حالة العامل والرصيد\n/balance — تفاصيل الرصيد\n/analyze SYMBOL — تحليل فوري\n/pause — إيقاف مؤقت\n/resume — استئناف\n/stats — إحصائيات', { chatId }); break;
        case '/status': {
          const state = store.getAgentState();
          await sendMessage(`🤖 <b>حالة العامل</b>\nشغّال: ${state.running ? '✅' : '❌'}\nآخر تشغيل: ${state.lastRun || 'لم يشتغل بعد'}\nصفقات مفتوحة: ${state.openCount}\nPnL يومي: ${state.dailyPnl?.toFixed(2) || '0.00'}`, { chatId });
          break;
        }
        case '/balance': {
          const p = store.getPaper();
          await sendMessage(`💰 <b>الرصيد</b>\nالرصيد الحالي: ${p.balance.toFixed(2)} ${p.currency}\nالرصيد الابتدائي: ${p.startBalance.toFixed(2)} ${p.currency}`, { chatId });
          break;
        }
        case '/analyze': {
          const sym = args.toUpperCase() || config.getList('WATCH_SYMBOLS')[0] || 'BTCUSDT';
          const klines = await require('./market').getKlines(sym, '15m', 50);
          const ind = require('./market').computeIndicators(klines);
          const dec = await require('./ai').analyze(ind, { symbol: sym });
          await sendMessage(formatDecisionMsg(dec), { chatId });
          break;
        }
        case '/pause': config.set('AGENT_AUTORUN', 'false'); store.setAgentState({ running: false }); await sendMessage('⏸ تم إيقاف العامل.', { chatId }); break;
        case '/resume': config.set('AGENT_AUTORUN', 'true'); store.setAgentState({ running: true }); await sendMessage('▶️ تم استئناف العامل.', { chatId }); break;
        case '/stats': {
          const s = store.getStats();
          await sendMessage(`📊 <b>إحصائيات</b>\nإجمالي صفقات: ${s.totalTrades}\nمغلقة: ${s.closedTrades}\nمفتوحة: ${s.openTrades}\nنسبة الفوز: ${s.winRate}%\nPnL: ${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl}`, { chatId });
          break;
        }
      }
    } catch (e) { console.error('[TG] خطأ معالجة أمر:', e.message); }
  }
}

const telegram = { sendMessage, notifyDecision, notifyTrade, notifyAlert, testConnection, getUpdates, processCommands };
module.exports = telegram;
