import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION ====================
const SYMBOL = "R_10";
const TRADING_SYMBOL = "R_10";
const SYMBOL_NAME = "Volatility 10 Index";
const REPO_LABEL = "Test Bot (V10 Live)";
// ==================================================================

const M5 = 300;
const D1 = 86400;
const CANDLES = 200;

const ATR_PERIOD = 14;
const FRACTAL_LOOKBACK = 8;
const SETUP_EXPIRY_BARS = 15;
const RISK_REWARD = 1.5;
const STAKE_USD = 10;
const MULTIPLIER = 400;

const SAFETY_TP_USD = 30;
const MARKET_DATA_APP_ID = "1089";
const DERIV_APP_ID = process.env.DERIV_APP_ID;

const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT = process.env.TG_CHAT_ID;
const DERIV_TOKEN = process.env.DERIV_API_TOKEN;
const PROXY_URL = process.env.PROXY_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE;
const MODE = process.env.MODE && process.env.MODE.trim() !== "" ? process.env.MODE.trim() : "scan";

console.log("=== STARTUP DEBUG ===");
console.log(`DERIV_API_TOKEN: ${DERIV_TOKEN ? "SET" : "NOT SET"}`);
console.log(`DERIV_APP_ID:    ${DERIV_APP_ID ? "SET" : "NOT SET"}`);
console.log(`PROXY_URL:       ${PROXY_URL ? "SET" : "NOT SET"}`);
console.log(`PROXY_SECRET:    ${PROXY_SECRET ? "SET" : "NOT SET"}`);
console.log(`MODE:            ${MODE}`);
console.log("=====================");

async function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: message, parse_mode: "Markdown" })
    });
  } catch (err) { console.error("❌ Telegram error:", err.message); }
}

function formatDuration(mins) {
  if (mins < 60) return `~${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hStr = `${h} hour${h !== 1 ? 's' : ''}`;
  return m > 0 ? `~${hStr} ${m} min` : `~${hStr}`;
}

async function runSummary(daysBack, title) {
  let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const periodTrades = trades.filter(t => t.result && t.result !== "CANCELLED" && new Date(t.closeTime) >= cutoff);
  if (periodTrades.length === 0) { await sendTelegram(`📊 *${REPO_LABEL} — ${title}*\n\nNo closed trades in this period.`); return; }
  const wins = periodTrades.filter(t => t.result === "WIN").length;
  const losses = periodTrades.filter(t => t.result === "LOSS").length;
  const netR = periodTrades.reduce((s, t) => s + (t.result === "WIN" ? t.rr : -1), 0);
  const winRate = ((wins / periodTrades.length) * 100).toFixed(1);
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  const netDollars = parseFloat((netR * slDollars).toFixed(2));
  await sendTelegram(`📊 *${REPO_LABEL} — ${title}*\n\nTrades:    ${periodTrades.length}\nWins:      ${wins}  |  Losses: ${losses}\nWin Rate:  ${winRate}%\nNet R:     ${netR.toFixed(1)}R\nNet P&L:   $${netDollars >= 0 ? "+" : ""}${netDollars}`);
}

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0 };
try { if (fs.existsSync("state.json")) state = { ...state, ...JSON.parse(fs.readFileSync("state.json")) }; } catch (e) { console.log("State load error, starting fresh."); }

async function checkTelegramCommands() {
  if (!TG_TOKEN || !TG_CHAT) return null;
  try {
    const offset = state.lastTgUpdateId ? state.lastTgUpdateId + 1 : 0;
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${offset}&limit=20&timeout=0`);
    const data = await res.json();
    if (!data.ok || !data.result || data.result.length === 0) return null;
    let command = null;
    for (const update of data.result) {
      state.lastTgUpdateId = Math.max(state.lastTgUpdateId || 0, update.update_id);
      const msg = update.message;
      if (!msg) continue;
      if (String(msg.chat.id) !== String(TG_CHAT)) continue;
      const text = (msg.text || "").toLowerCase().trim();
      if (text === "/close win" || text === "/closewin") command = "WIN";
      else if (text === "/close loss" || text === "/closeloss") command = "LOSS";
    }
    return command;
  } catch (err) { console.error("Telegram poll error:", err.message); return null; }
}

async function executeManualClose(result, reason) {
  let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const openTrade = trades.find(t => t.result === null);
  if (!openTrade) {
    await sendTelegram(`⚠️ *${REPO_LABEL}*\n\nNo open trade found to close.`);
    return;
  }
  console.log(`🔄 Manual ${result} close requested: ${reason}`);
  let currentPrice = null;
  try { currentPrice = await getCurrentPrice(); } catch (e) { console.error("Price fetch error:", e.message); }
  try { await closeContract(openTrade.contractId); } catch (e) { console.error("Close contract error:", e.message); }
  openTrade.result = result;
  openTrade.closeTime = new Date().toISOString();
  fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
  const icon = result === "WIN" ? "✅" : "❌";
  const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
  const durationMins = Math.round((new Date(openTrade.closeTime) - new Date(openTrade.openTime)) / 60000);
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
  const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
  const exitPriceStr = currentPrice ? currentPrice.toFixed(4) : "unknown";
  await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${openTrade.entry.toFixed(4)}\n🏁 Exit:   ${exitPriceStr}\n🛑 SL:     ${openTrade.sl.toFixed(4)}  ($${slDollars} hard)\n🎯 TP1:    ${openTrade.tp1.toFixed(4)}  ($${tpDollars} soft)  ${tp1Status}\n\nReason:    ${reason}\nDuration:  ${formatDuration(durationMins)}\n\nOpened:  ${openTrade.openTime.substring(0,16).replace("T"," ")} UTC\nClosed:  ${openTrade.closeTime.substring(0,16).replace("T"," ")} UTC\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
  console.log(`✅ Manual close complete: ${result}`);
}

(async () => {
  if (MODE === "daily")   { await runSummary(1,  "Daily Report");   process.exit(0); }
  if (MODE === "weekly")  { await runSummary(7,  "Weekly Report");  process.exit(0); }
  if (MODE === "monthly") { await runSummary(30, "Monthly Report"); process.exit(0); }
  if (MODE === "close_win") {
    await executeManualClose("WIN", "Manual Close — Profit taken");
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    process.exit(0);
  }
  if (MODE === "close_loss") {
    await executeManualClose("LOSS", "Manual Close — Loss accepted");
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    process.exit(0);
  }
  if (MODE === "test") {
    console.log("🧪 TEST MODE: Firing a direct BUY trade via proxy...");
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
    await sendTelegram(`🧪 *Test Trade Initiated*\nSymbol: ${SYMBOL_NAME}\nDirection: BUY\nStake: $${STAKE_USD} | Multiplier: ${MULTIPLIER}x\nSL: $${slDollars} (hard) | TP1: $${tpDollars} (soft) | Safety TP: $${SAFETY_TP_USD} (hard ceiling)`);
    try {
      const contractId = await executeTrade("BUY");
      if (contractId) { await sendTelegram(`✅ *Test Trade Executed Successfully!*\nContract ID: \`${contractId}\`\nCheck your Deriv account to confirm the open position.`); }
      else { await sendTelegram(`⚠️ *Test Trade Returned Null*\nCheck Actions logs for details.`); }
    } catch (err) { console.error("❌ Test trade error:", err.message); await sendTelegram(`❌ *Test Trade Failed*\nError: ${err.message}\n\nCheck Actions logs for full details.`); }
    process.exit(0);
  }
  if (TRIGGER_SOURCE !== "cronjob") { console.log("⛔ Blocked: Not a cronjob trigger."); process.exit(0); }
  await runScanMode();
})();

function openWS() { return new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`, { headers: { "Origin": "https://deriv.com" } }); }

async function withRetry(fn, retries = 3, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === retries) throw err;
      console.log(`Attempt ${attempt} failed (${err.message}). Retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function fetchCandles(granularity, count = CANDLES) {
  return withRetry(() => new Promise((resolve, reject) => {
    const ws = openWS();
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 30000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: SYMBOL, adjust_start_time: 1, count, end: "latest", style: "candles", granularity })));
    ws.on("message", (data) => { const r = JSON.parse(data); if (r.error) { clearTimeout(timeout); reject(new Error(r.error.message)); ws.close(); } if (r.candles) { clearTimeout(timeout); resolve(r.candles); ws.close(); } });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  }));
}

async function getCurrentPrice() {
  return withRetry(() => new Promise((resolve, reject) => {
    const ws = openWS();
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 20000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: SYMBOL, count: 1, end: "latest" })));
    ws.on("message", (data) => { const r = JSON.parse(data); if (r.history && r.history.prices) { clearTimeout(timeout); resolve(parseFloat(r.history.prices[0])); ws.close(); } });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  }));
}

async function getDerivAccountId() {
  const res = await fetch("https://api.derivws.com/trading/v1/options/accounts", { headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`getAccounts failed: ${JSON.stringify(json.errors || json)}`);
  const accounts = json.data;
  if (!accounts || accounts.length === 0) throw new Error("No Deriv accounts found");
  const account = accounts.find(a => a.account_type !== "demo") || accounts[0];
  console.log(`   Account ID: ${account.account_id} (${account.account_type})`);
  return account.account_id;
}

async function getDerivOTP(accountId) {
  const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, { method: "POST", headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`getOTP failed: ${JSON.stringify(json.errors || json)}`);
  console.log(`   OTP WebSocket URL obtained ✅`);
  return json.data.url;
}

async function executeTrade(direction) {
  if (!DERIV_TOKEN) { console.log("⚠️ DERIV_API_TOKEN not set. Skipping."); return null; }
  if (!DERIV_APP_ID) { console.log("⚠️ DERIV_APP_ID not set. Skipping."); return null; }
  if (!PROXY_URL || !PROXY_SECRET) { console.log("⚠️ PROXY_URL or PROXY_SECRET not set. Skipping."); return null; }
  console.log(`🔄 Sending ${direction} trade via Cloudflare proxy...`);
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  const params = { buy: "1", price: STAKE_USD, parameters: { contract_type: direction === "BUY" ? "MULTUP" : "MULTDOWN", underlying_symbol: TRADING_SYMBOL, currency: "USD", amount: STAKE_USD, basis: "stake", multiplier: MULTIPLIER, limit_order: { stop_loss: slDollars, take_profit: SAFETY_TP_USD } } };
  const response = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET }, body: JSON.stringify({ wsUrl, action: "buy", params }) });
  const data = await response.json();
  console.log("📨 Proxy response:", JSON.stringify(data));
  if (data.error) throw new Error(data.error);
  const contractId = data.buy?.contract_id;
  if (contractId) { console.log(`✅ Trade Executed! Contract ID: ${contractId}`); return contractId; }
  return null;
}

async function closeContract(contractId) {
  if (!DERIV_TOKEN || !contractId || !PROXY_URL || !PROXY_SECRET || !DERIV_APP_ID) return;
  console.log(`🔄 Closing contract ${contractId} via proxy...`);
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const response = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET }, body: JSON.stringify({ wsUrl, action: "sell", params: { sell: contractId, price: 0 } }) });
  const data = await response.json();
  console.log("📨 Close response:", JSON.stringify(data));
  return data;
}

function sma(data, period) { return data.map((_, i, arr) => { if (i < period - 1) return null; return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period; }); }
function ema(data, period) { const k = 2 / (period + 1); let e = [data[0]]; for (let i = 1; i < data.length; i++) e[i] = data[i] * k + e[i-1] * (1-k); return e; }
function calculateATR(candles, period) { let trs = []; for (let i = 1; i < candles.length; i++) { const h = parseFloat(candles[i].high), l = parseFloat(candles[i].low), pc = parseFloat(candles[i-1].close); trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc))); } return trs.slice(-period).reduce((a,b) => a+b, 0) / period; }
function getFractals(candles) { let pool = []; for (let i = 2; i < candles.length-2; i++) { const h = parseFloat(candles[i].high); if (h > parseFloat(candles[i-1].high) && h > parseFloat(candles[i-2].high) && h > parseFloat(candles[i+1].high) && h > parseFloat(candles[i+2].high)) pool.push(h); const l = parseFloat(candles[i].low); if (l < parseFloat(candles[i-1].low) && l < parseFloat(candles[i-2].low) && l < parseFloat(candles[i+1].low) && l < parseFloat(candles[i+2].low)) pool.push(l); } const recent = pool.slice(-FRACTAL_LOOKBACK); return { significantHigh: recent.length > 0 ? Math.max(...recent) : null, significantLow: recent.length > 0 ? Math.min(...recent) : null }; }

async function fetchH1Data() {
  try { const h1 = await fetchCandles(3600, 60); if (!h1 || h1.length < 50) return { ema50: null, open: null }; const closes = h1.map(c => parseFloat(c.close)); const emaArr = ema(closes, 50); return { ema50: emaArr[emaArr.length-1], open: parseFloat(h1[h1.length-1].open) }; } catch { return { ema50: null, open: null }; }
}
async function fetchH4Candle() { try { const h4 = await fetchCandles(14400, 2); if (!h4 || h4.length === 0) return null; return h4[h4.length-1]; } catch { return null; } }
async function getD1Context() {
  try { const d1 = await fetchCandles(D1, 2); if (!d1 || !d1.length) return null; const c = d1[d1.length-1]; const open = parseFloat(c.open), close = parseFloat(c.close); let direction, change, changePct; if (close > open) { direction = "🟢 BULLISH"; change = close-open; changePct = (change/open)*100; } else if (close < open) { direction = "🔴 BEARISH"; change = open-close; changePct = (change/open)*100; } else { direction = "⚪ NEUTRAL"; change = 0; changePct = 0; } return { open, close, direction, change, changePct }; } catch { return null; }
}
function checkAlignment(signalDir, d1Dir) { if (signalDir === "BUY" && d1Dir === "🟢 BULLISH") return "✅ ALIGNED with daily trend"; if (signalDir === "SELL" && d1Dir === "🔴 BEARISH") return "✅ ALIGNED with daily trend"; if (d1Dir === "⚪ NEUTRAL") return "⚪ Daily is flat"; return "⚠️ COUNTER-TREND to daily"; }

async function runScanMode() {
  try {
    // Check for manual close commands from Telegram first
    const tgCommand = await checkTelegramCommands();
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    if (tgCommand) {
      const reason = tgCommand === "WIN" ? "Manual Close via Telegram — Profit taken" : "Manual Close via Telegram — Loss accepted";
      await executeManualClose(tgCommand, reason);
      fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
      return;
    }

    let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
    const candles = await fetchCandles(M5, CANDLES);
    if (!candles || candles.length < 50) return;
    const i = candles.length - 2;
    const currentCandleEpoch = candles[i].epoch;
    const closes = candles.map(c => parseFloat(c.close));
    const emaFast = ema(closes, 4), emaSlow = ema(closes, 34), ema8 = ema(closes, 8), ema100 = ema(closes, 100);
    const macdFast = emaFast[i] - emaSlow[i], macdSlow = ema8[i] - ema100[i];
    let openTrade = trades.find(t => t.result === null);
    if (openTrade) {
      const currentPrice = await getCurrentPrice();
      const inProfit = (openTrade.direction === "BUY" && currentPrice >= openTrade.entry) || (openTrade.direction === "SELL" && currentPrice <= openTrade.entry);
      if (openTrade.lastInProfit !== null && openTrade.lastInProfit !== inProfit) openTrade.macdEarlyFlipEpoch = null;
      openTrade.lastInProfit = inProfit;
      const activeMACD = inProfit ? macdSlow : macdFast;
      const macdFlipped = (openTrade.direction === "BUY" && activeMACD < 0) || (openTrade.direction === "SELL" && activeMACD > 0);
      const slHit = (openTrade.direction === "BUY" && currentPrice <= openTrade.sl) || (openTrade.direction === "SELL" && currentPrice >= openTrade.sl);
      let settledResult = null, exitReason = "", derivAlreadyClosed = false;
      if (slHit) { settledResult = "LOSS"; exitReason = "Stop Loss Hit (Deriv hard SL)"; derivAlreadyClosed = true; }
      else {
        if (!inProfit && openTrade.h1OpenAtEntry != null) {
          const h1Breach = (openTrade.direction === "BUY" && closes[i] < openTrade.h1OpenAtEntry) || (openTrade.direction === "SELL" && closes[i] > openTrade.h1OpenAtEntry);
          if (h1Breach) { settledResult = "LOSS"; exitReason = "H1 Open Break — early loss cut"; }
        }
        if (!settledResult) {
          if (!openTrade.tp1Reached) {
            if ((openTrade.direction === "BUY" && currentPrice >= openTrade.tp1) || (openTrade.direction === "SELL" && currentPrice <= openTrade.tp1)) {
              openTrade.tp1Reached = true; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
              const slDollars = parseFloat((STAKE_USD*0.5).toFixed(2)), tpDollars = parseFloat((slDollars*RISK_REWARD).toFixed(2));
              await sendTelegram(`🎯 *TP1 Hit!*\nSymbol: ${SYMBOL_NAME}\nDirection: ${openTrade.direction}\nPrice: ${currentPrice.toFixed(4)} | TP1: ${openTrade.tp1.toFixed(4)}\n\nNow trailing with MACD(8,100). Will hold while trend continues.\n💰 Stake: $${STAKE_USD} | Soft TP1: $${tpDollars} | Safety: $${SAFETY_TP_USD}`);
            }
          }
          if (macdFlipped) {
            if (!openTrade.macdEarlyFlipEpoch) { openTrade.macdEarlyFlipEpoch = currentCandleEpoch; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); }
            else if (openTrade.macdEarlyFlipEpoch !== currentCandleEpoch) { settledResult = inProfit ? "WIN" : "LOSS"; exitReason = inProfit ? "MACD(8,100) Trail Exit — held above entry" : "MACD(4,34) Early Exit — price below entry"; }
          } else { if (openTrade.macdEarlyFlipEpoch) { openTrade.macdEarlyFlipEpoch = null; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); } }
        }
      }
      if (settledResult) {
        if (!derivAlreadyClosed) await closeContract(openTrade.contractId);
        openTrade.result = settledResult; openTrade.closeTime = new Date().toISOString();
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        const icon = settledResult === "WIN" ? "✅" : "❌";
        const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
        const durationMins = Math.round((new Date(openTrade.closeTime) - new Date(openTrade.openTime)) / 60000);
        const slDollars = parseFloat((STAKE_USD*0.5).toFixed(2)), tpDollars = parseFloat((slDollars*RISK_REWARD).toFixed(2));
        const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
        const risk = openTrade.direction === "BUY" ? openTrade.entry - openTrade.sl : openTrade.sl - openTrade.entry;
        const isHardSL = exitReason.includes("Stop Loss Hit");
        const pnlDollars = isHardSL ? -slDollars : parseFloat(((openTrade.direction === "BUY" ? currentPrice - openTrade.entry : openTrade.entry - currentPrice) / risk * slDollars).toFixed(2));
        const pnlStr = pnlDollars >= 0 ? `+$${pnlDollars.toFixed(2)}` : `-$${Math.abs(pnlDollars).toFixed(2)}`;
        await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${settledResult}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${openTrade.entry.toFixed(4)}\n🏁 Exit:   ${currentPrice.toFixed(4)}\n🛑 SL:     ${openTrade.sl.toFixed(4)}  ($${slDollars} hard)\n🎯 TP1:    ${openTrade.tp1.toFixed(4)}  ($${tpDollars} soft)  ${tp1Status}\n\n💵 P&L:    ${pnlStr}\nReason:    ${exitReason}\nDuration:  ${formatDuration(durationMins)}\n\nOpened:  ${openTrade.openTime.substring(0,16).replace("T"," ")} UTC\nClosed:  ${openTrade.closeTime.substring(0,16).replace("T"," ")} UTC\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
      }
      return;
    }
    if (state.lastProcessedEpoch === currentCandleEpoch) return;
    const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
    const opens = candles.map(c => parseFloat(c.open)), highs = candles.map(c => parseFloat(c.high)), lows = candles.map(c => parseFloat(c.low));
    const smaFast = sma(closes, 4), smaSlow = sma(closes, 34);
    const atr14 = calculateATR(candles, ATR_PERIOD);
    const bodies = candles.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
    const avgBody = sma(bodies, 20)[i] || 0;
    const crossUp = (smaFast[i-1] <= smaSlow[i-1]) && (smaFast[i] > smaSlow[i]);
    const crossDn = (smaFast[i-1] >= smaSlow[i-1]) && (smaFast[i] < smaSlow[i]);
    if (crossUp) { state.waitingFor = "BUY"; state.setupEpoch = currentCandleEpoch; }
    else if (crossDn) { state.waitingFor = "SELL"; state.setupEpoch = currentCandleEpoch; }
    if (state.waitingFor && state.setupEpoch && (currentCandleEpoch - state.setupEpoch) > (SETUP_EXPIRY_BARS * M5)) { state.waitingFor = null; state.setupEpoch = null; }
    const candleRange = highs[i] - lows[i];
    const closePosBuy = (closes[i] - lows[i]) / candleRange, closePosSell = (highs[i] - closes[i]) / candleRange;
    const smaSeparation = Math.abs(smaFast[i] - smaSlow[i]), sma34Slope = smaSlow[i] - smaSlow[i-3];
    const separationOk = smaSeparation > (atr14 * 0.5), impulseOk = bodies[i] > (avgBody * 1.5);
    const fractals = getFractals(candles);
    const fractalBreakUp = fractals.significantHigh !== null && closes[i] > fractals.significantHigh;
    const fractalBreakDown = fractals.significantLow !== null && closes[i] < fractals.significantLow;
    const h1Data = await fetchH1Data();
    const h1Ema50 = h1Data.ema50;
    const h4Candle = await fetchH4Candle();
    if (!h4Candle) { console.log("⚠️ H4 unavailable — skipping signal scan"); state.lastProcessedEpoch = currentCandleEpoch; fs.writeFileSync("state.json", JSON.stringify(state, null, 2)); return; }
    const h4Bullish = parseFloat(h4Candle.close) > parseFloat(h4Candle.open);
    const h4Bearish = parseFloat(h4Candle.close) < parseFloat(h4Candle.open);
    const buySignal  = state.waitingFor === "BUY"  && h4Bullish && fractalBreakUp   && separationOk && sma34Slope > 0 && impulseOk && closePosBuy  >= 0.7 && closes[i] > opens[i] && (h1Ema50 === null || closes[i] > h1Ema50);
    const sellSignal = state.waitingFor === "SELL" && h4Bearish && fractalBreakDown && separationOk && sma34Slope < 0 && impulseOk && closePosSell >= 0.7 && closes[i] < opens[i] && (h1Ema50 === null || closes[i] < h1Ema50);
    let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;
    if (buySignal) { signalTriggered = true; direction = "BUY"; entry = closes[i]; sl = fractals.significantLow !== null ? Math.min(fractals.significantLow, entry-atr14*1.5) : entry-atr14*1.5; risk = entry-sl; tp1 = entry+risk*RISK_REWARD; tp2 = entry+risk*2; tp3 = entry+risk*3; }
    else if (sellSignal) { signalTriggered = true; direction = "SELL"; entry = closes[i]; sl = fractals.significantHigh !== null ? Math.max(fractals.significantHigh, entry+atr14*1.5) : entry+atr14*1.5; risk = sl-entry; tp1 = entry-risk*RISK_REWARD; tp2 = entry-risk*2; tp3 = entry-risk*3; }
    if (signalTriggered) {
      const slDollars = parseFloat((STAKE_USD*0.5).toFixed(2)), tpDollars = parseFloat((slDollars*RISK_REWARD).toFixed(2));
      const d1 = await getD1Context();
      const alignment = d1 ? checkAlignment(direction, d1.direction) : "⚠️ D1 data unavailable";
      const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
      const h1Line = h1Ema50 ? `H1 EMA50:  ${h1Ema50.toFixed(4)}  ✅ Trend aligned\n` : `H1 EMA50:  ⚠️ Data unavailable\n`;
      const h4Dir = h4Bullish ? "🟢 BULLISH" : "🔴 BEARISH";
      let message = `🚨 ${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL 🚨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n📍 Entry:  ${entry.toFixed(4)}\n🛑 SL:     ${sl.toFixed(4)}\n🎯 TP1:    ${tp1.toFixed(4)}  → trail with MACD(8,100) after this\n🎯 TP2:    ${tp2.toFixed(4)}  (reference)\n🎯 TP3:    ${tp3.toFixed(4)}  (reference)\n\n💰 Stake: $${STAKE_USD} | Hard SL: $${slDollars} | Soft TP1: $${tpDollars} | Safety: $${SAFETY_TP_USD}\n📊 Risk:   ${risk.toFixed(2)} points\n${h1Line}📈 H4:     ${h4Dir} ✅ Direction confirmed\n🔥 Setup:  Fractal break + H1 + H4 aligned\n━━━━━━━━━━━━━━━━━━━━\n📅 D1 CANDLE STATUS\n━━━━━━━━━━━━━━━━━━━━\n`;
      if (d1) message += `Direction:  ${d1.direction}\nD1 Open:    ${d1.open.toFixed(4)}\nD1 Current: ${d1.close.toFixed(4)}\nMovement:   ${d1.change.toFixed(4)} pts (${d1.changePct.toFixed(2)}%)\nAlignment:  ${alignment}\n\n`;
      else message += `⚠️ D1 data unavailable\n\n`;
      message += `⏰ Time (UTC): ${timeFormatted}\n\n💡 To close manually: send \`/close win\` or \`/close loss\` in this chat`;
      await sendTelegram(message);
      trades.push({ id: `${SYMBOL}-${isoTime}`, contractId: null, repo: REPO_LABEL, symbol: SYMBOL, direction, entry, sl, tp1, tp2, tp3, h1OpenAtEntry: h1Data.open, tp1Reached: false, macdEarlyFlipEpoch: null, lastInProfit: null, rr: RISK_REWARD, openTime: timeFormatted, closeTime: null, result: null });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      try { const contractId = await executeTrade(direction); if (contractId) { trades[trades.length-1].contractId = contractId; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); } } catch (execErr) { console.error("⚠️ Live execution warning:", execErr.message); }
      state.waitingFor = null; state.setupEpoch = null;
    }
    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  } catch (err) { console.error("❌ BOT ERROR:", err.message); process.exit(1); }
}
