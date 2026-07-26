import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION ====================
const SYMBOL = "R_100";          // Market data symbol (ws.binaryws.com)
const TRADING_SYMBOL = "R_100";  // Trading symbol (api.derivws.com) — Volatility 100 Index (normal, 2s tick)
const SYMBOL_NAME = "Volatility 100 Index";
const REPO_LABEL = "Test Bot (V100)";
// ==================================================================

const M5 = 300;
const D1 = 86400;
const CANDLES = 200;

const ATR_PERIOD = 14;
const FRACTAL_LOOKBACK = 8;
const SETUP_EXPIRY_BARS = 15;
const RISK_REWARD = 1.5;
const STAKE_USD = 10;
const MULTIPLIER = 40;

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
console.log(`DERIV_API_TOKEN: ${DERIV_TOKEN ? `SET (${DERIV_TOKEN.length} chars, starts: ${DERIV_TOKEN.substring(0,4)}***)` : "NOT SET"}`);
console.log(`DERIV_APP_ID:    ${DERIV_APP_ID ? `SET (${DERIV_APP_ID.length} chars)` : "NOT SET"}`);
console.log(`PROXY_URL:       ${PROXY_URL ? `SET` : "NOT SET"}`);
console.log(`PROXY_SECRET:    ${PROXY_SECRET ? `SET (${PROXY_SECRET.length} chars)` : "NOT SET"}`);
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

async function runSummary(daysBack, title) {
  let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const periodTrades = trades.filter(t => t.result && t.result !== "CANCELLED" && new Date(t.closeTime) >= cutoff);
  if (periodTrades.length === 0) {
    await sendTelegram(`📊 *${REPO_LABEL} — ${title}*\n\nNo closed trades in this period.`);
    return;
  }
  const wins = periodTrades.filter(t => t.result === "WIN").length;
  const losses = periodTrades.filter(t => t.result === "LOSS").length;
  const netR = periodTrades.reduce((s, t) => s + (t.result === "WIN" ? t.rr : -1), 0);
  const winRate = ((wins / periodTrades.length) * 100).toFixed(1);
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  const netDollars = parseFloat((netR * slDollars).toFixed(2));
  await sendTelegram(
    `📊 *${REPO_LABEL} — ${title}*\n\n` +
    `Trades:    ${periodTrades.length}\n` +
    `Wins:      ${wins}  |  Losses: ${losses}\n` +
    `Win Rate:  ${winRate}%\n` +
    `Net R:     ${netR.toFixed(1)}R\n` +
    `Net P&L:   $${netDollars >= 0 ? "+" : ""}${netDollars}`
  );
}

(async () => {
  if (MODE === "daily")   { await runSummary(1,  "Daily Report");   process.exit(0); }
  if (MODE === "weekly")  { await runSummary(7,  "Weekly Report");  process.exit(0); }
  if (MODE === "monthly") { await runSummary(30, "Monthly Report"); process.exit(0); }

  if (MODE === "test") {
    console.log("🧪 TEST MODE: Firing a direct demo BUY trade via proxy...");
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
    await sendTelegram(
      `🧪 *Test Trade Initiated*\n` +
      `Symbol: ${SYMBOL_NAME}\nDirection: BUY\n` +
      `Stake: $${STAKE_USD} | Multiplier: ${MULTIPLIER}x\n` +
      `SL: $${slDollars} (hard) | TP1: $${tpDollars} (soft) | Safety TP: $${SAFETY_TP_USD} (hard ceiling)`
    );
    try {
      const contractId = await executeTrade("BUY");
      if (contractId) {
        await sendTelegram(`✅ *Test Trade Executed Successfully!*\nContract ID: \`${contractId}\`\nCheck your Deriv demo account to confirm the open position.`);
      } else {
        await sendTelegram(`⚠️ *Test Trade Returned Null*\nCheck Actions logs for details.`);
      }
    } catch (err) {
      console.error("❌ Test trade error:", err.message);
      await sendTelegram(`❌ *Test Trade Failed*\nError: ${err.message}\n\nCheck Actions logs for full details.`);
    }
    process.exit(0);
  }

  if (TRIGGER_SOURCE !== "cronjob") { console.log("⛔ Blocked: Not a cronjob trigger."); process.exit(0); }
  await runScanMode();
})();

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null };
try {
  if (fs.existsSync("state.json")) state = JSON.parse(fs.readFileSync("state.json"));
} catch (e) { console.log("State load error, starting fresh."); }

function openDerivWS() {
  return new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`, {
    headers: { "Origin": "https://deriv.com" }
  });
}

async function fetchCandles(granularity, count = CANDLES) {
  return new Promise((resolve, reject) => {
    const ws = openDerivWS();
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: SYMBOL, adjust_start_time: 1, count, end: "latest", style: "candles", granularity })));
    ws.on("message", (data) => { const r = JSON.parse(data); if (r.error) { clearTimeout(timeout); reject(new Error(r.error.message)); ws.close(); } if (r.candles) { clearTimeout(timeout); resolve(r.candles); ws.close(); } });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function getCurrentPrice() {
  return new Promise((resolve, reject) => {
    const ws = openDerivWS();
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Timeout")); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ ticks_history: SYMBOL, count: 1, end: "latest" })));
    ws.on("message", (data) => { const r = JSON.parse(data); if (r.history && r.history.prices) { clearTimeout(timeout); resolve(parseFloat(r.history.prices[0])); ws.close(); } });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function getDerivAccountId() {
  const res = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getAccounts failed: ${JSON.stringify(json.errors || json)}`);
  const accounts = json.data;
  if (!accounts || accounts.length === 0) throw new Error("No Deriv accounts found");
  const demo = accounts.find(a => a.account_type === "demo") || accounts[0];
  console.log(`   Account ID: ${demo.account_id} (${demo.account_type})`);
  return demo.account_id;
}

async function getDerivOTP(accountId) {
  const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
    method: "POST",
    headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getOTP failed: ${JSON.stringify(json.errors || json)}`);
  console.log(`   OTP WebSocket URL obtained ✅`);
  return json.data.url;
}

async function executeTrade(direction) {
  if (!DERIV_TOKEN) { console.log("⚠️ DERIV_API_TOKEN not set. Skipping."); return null; }
  if (!DERIV_APP_ID) { console.log("⚠️ DERIV_APP_ID not set. Skipping."); return null; }
  if (!PROXY_URL || !PROXY_SECRET) { console.log("⚠️ PROXY_URL or PROXY_SECRET not set. Skipping."); return null; }
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  console.log(`🔄 Sending ${direction} trade via Cloudflare proxy...`);
  console.log(`   Symbol: ${TRADING_SYMBOL} | Stake: $${STAKE_USD} | Multiplier: ${MULTIPLIER}x | SL: $${slDollars} | Safety TP: $${SAFETY_TP_USD}`);
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const params = {
    buy: "1", price: STAKE_USD,
    parameters: {
      contract_type: direction === "BUY" ? "MULTUP" : "MULTDOWN",
      underlying_symbol: TRADING_SYMBOL, currency: "USD",
      amount: STAKE_USD, basis: "stake", multiplier: MULTIPLIER,
      limit_order: { stop_loss: slDollars, take_profit: SAFETY_TP_USD }
    }
  };
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET },
    body: JSON.stringify({ wsUrl, action: "buy", params })
  });
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
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET },
    body: JSON.stringify({ wsUrl, action: "sell", params: { sell: contractId, price: 0 } })
  });
  const data = await response.json();
  console.log("📨 Close response:", JSON.stringify(data));
  return data;
}

function sma(data, period) {
  return data.map((_, i, arr) => {
    if (i < period - 1) return null;
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function ema(data, period) {
  const k = 2 / (period + 1);
  let emaArray = [data[0]];
  for (let i = 1; i < data.length; i++) emaArray[i] = data[i] * k + emaArray[i - 1] * (1 - k);
  return emaArray;
}

function calculateATR(candles, period) {
  let trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].high), low = parseFloat(candles[i].low), prevClose = parseFloat(candles[i-1].close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function getFractals(candles) {
  let highFractals = [], lowFractals = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const h = parseFloat(candles[i].high);
    if (h > parseFloat(candles[i-1].high) && h > parseFloat(candles[i-2].high) && h > parseFloat(candles[i+1].high) && h > parseFloat(candles[i+2].high)) highFractals.push(h);
    const l = parseFloat(candles[i].low);
    if (l < parseFloat(candles[i-1].low) && l < parseFloat(candles[i-2].low) && l < parseFloat(candles[i+1].low) && l < parseFloat(candles[i+2].low)) lowFractals.push(l);
  }
  return {
    significantHigh: highFractals.length > 0 ? Math.max(...highFractals.slice(-FRACTAL_LOOKBACK)) : null,
    significantLow: lowFractals.length > 0 ? Math.min(...lowFractals.slice(-FRACTAL_LOOKBACK)) : null
  };
}

async function getD1Context() {
  try {
    const d1Candles = await fetchCandles(D1, 2);
    if (!d1Candles || d1Candles.length === 0) return null;
    const c = d1Candles[d1Candles.length - 1];
    const open = parseFloat(c.open), close = parseFloat(c.close);
    let direction, change, changePct;
    if (close > open) { direction = "🟢 BULLISH"; change = close - open; changePct = (change / open) * 100; }
    else if (close < open) { direction = "🔴 BEARISH"; change = open - close; changePct = (change / open) * 100; }
    else { direction = "⚪ NEUTRAL"; change = 0; changePct = 0; }
    return { open, close, direction, change, changePct };
  } catch { return null; }
}

function checkAlignment(signalDir, d1Dir) {
  if (signalDir === "BUY" && d1Dir === "🟢 BULLISH") return "✅ ALIGNED with daily trend";
  if (signalDir === "SELL" && d1Dir === "🔴 BEARISH") return "✅ ALIGNED with daily trend";
  if (d1Dir === "⚪ NEUTRAL") return "⚪ Daily is flat";
  return "⚠️ COUNTER-TREND to daily";
}

async function runScanMode() {
  try {
    let trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
    const candles = await fetchCandles(M5, CANDLES);
    if (!candles || candles.length < 50) return;

    const i = candles.length - 2;

    let openTrade = trades.find(t => t.result === null);
    if (openTrade) {
      const currentPrice = await getCurrentPrice();
      const closes = candles.map(c => parseFloat(c.close));
      const emaFast = ema(closes, 4);
      const emaSlow = ema(closes, 34);
      const macd = emaFast[i] - emaSlow[i];
      const macdFlippedAgainstTrade =
        (openTrade.direction === "BUY" && macd < 0) ||
        (openTrade.direction === "SELL" && macd > 0);

      let settledResult = null;
      let exitReason = "";

      if (openTrade.tp1Reached) {
        // ── PHASE 2: After TP1 — trail with MACD, always a WIN ──
        if (macdFlippedAgainstTrade) {
          settledResult = "WIN";
          exitReason = "MACD Trail Exit (after TP1)";
        }
      } else {
        // ── PHASE 1: Before TP1 ──
        if (macdFlippedAgainstTrade) {
          const closedInProfit =
            (openTrade.direction === "BUY"  && currentPrice >= openTrade.entry) ||
            (openTrade.direction === "SELL" && currentPrice <= openTrade.entry);
          settledResult = closedInProfit ? "WIN" : "LOSS";
          exitReason = closedInProfit
            ? "MACD Early Exit — Closed in Profit (before TP1)"
            : "MACD Early Exit — Partial Loss (before SL hit)";
        } else if (openTrade.direction === "BUY" && currentPrice >= openTrade.tp1) {
          openTrade.tp1Reached = true;
          fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          await sendTelegram(
            `🎯 *TP1 Reached — Now Trailing!*\n` +
            `Symbol: ${SYMBOL_NAME}\nDirection: BUY\n` +
            `Price: ${currentPrice.toFixed(4)} | TP1 was: ${openTrade.tp1.toFixed(4)}\n\n` +
            `Trade will now stay open while M5 MACD > 0.\nWill close when momentum fades.`
          );
        } else if (openTrade.direction === "SELL" && currentPrice <= openTrade.tp1) {
          openTrade.tp1Reached = true;
          fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          await sendTelegram(
            `🎯 *TP1 Reached — Now Trailing!*\n` +
            `Symbol: ${SYMBOL_NAME}\nDirection: SELL\n` +
            `Price: ${currentPrice.toFixed(4)} | TP1 was: ${openTrade.tp1.toFixed(4)}\n\n` +
            `Trade will now stay open while M5 MACD < 0.\nWill close when momentum fades.`
          );
        }
      }

      if (settledResult) {
        await closeContract(openTrade.contractId);
        openTrade.result = settledResult;
        openTrade.closeTime = new Date().toISOString();
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));

        const icon = settledResult === "WIN" ? "✅" : "❌";
        const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
        const phase = openTrade.tp1Reached ? "Trailed past TP1 ✅" : "Closed before TP1";
        const durationMins = Math.round((new Date(openTrade.closeTime) - new Date(openTrade.openTime)) / 60000);
        const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
        const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));

        await sendTelegram(
          `${icon} *${REPO_LABEL} — Trade ${settledResult}*\n\n` +
          `Direction: ${openTrade.direction} (${contractType})\n` +
          `Symbol:    ${SYMBOL_NAME}\n\n` +
          `📍 Entry:  ${openTrade.entry.toFixed(4)}\n` +
          `🏁 Exit:   ${currentPrice.toFixed(4)}\n` +
          `🛑 SL:     ${openTrade.sl.toFixed(4)}  ($${slDollars} hard)\n` +
          `🎯 TP1:    ${openTrade.tp1.toFixed(4)}  ($${tpDollars} soft)\n\n` +
          `Phase:     ${phase}\n` +
          `Reason:    ${exitReason}\n` +
          `Duration:  ~${durationMins} min\n\n` +
          `Opened:  ${openTrade.openTime.substring(0, 16).replace("T", " ")} UTC\n` +
          `Closed:  ${openTrade.closeTime.substring(0, 16).replace("T", " ")} UTC\n` +
          (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : "")
        );
      }
      return;
    }

    const currentCandleEpoch = candles[i].epoch;
    const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
    if (state.lastProcessedEpoch === currentCandleEpoch) return;

    const closes = candles.map(c => parseFloat(c.close));
    const opens = candles.map(c => parseFloat(c.open));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));

    const smaFast = sma(closes, 4);
    const smaSlow = sma(closes, 34);
    const atr14 = calculateATR(candles, ATR_PERIOD);
    const bodies = candles.map(c => Math.abs(parseFloat(c.close) - parseFloat(c.open)));
    const avgBody = sma(bodies, 20)[i] || 0;

    const crossUp = (smaFast[i-1] <= smaSlow[i-1]) && (smaFast[i] > smaSlow[i]);
    const crossDn = (smaFast[i-1] >= smaSlow[i-1]) && (smaFast[i] < smaSlow[i]);
    if (crossUp) { state.waitingFor = "BUY"; state.setupEpoch = currentCandleEpoch; }
    else if (crossDn) { state.waitingFor = "SELL"; state.setupEpoch = currentCandleEpoch; }
    if (state.waitingFor && state.setupEpoch && (currentCandleEpoch - state.setupEpoch) > (SETUP_EXPIRY_BARS * M5)) {
      state.waitingFor = null; state.setupEpoch = null;
    }

    const candleRange = highs[i] - lows[i];
    const closePosBuy = (closes[i] - lows[i]) / candleRange;
    const closePosSell = (highs[i] - closes[i]) / candleRange;
    const smaSeparation = Math.abs(smaFast[i] - smaSlow[i]);
    const sma34Slope = smaSlow[i] - smaSlow[i - 3];
    const separationOk = smaSeparation > (atr14 * 0.5);
    const impulseOk = bodies[i] > (avgBody * 1.5);
    const fractals = getFractals(candles);
    const fractalBreakUp = fractals.significantHigh !== null && closes[i] > fractals.significantHigh;
    const fractalBreakDown = fractals.significantLow !== null && closes[i] < fractals.significantLow;

    const buySignal = state.waitingFor === "BUY" && fractalBreakUp && separationOk && sma34Slope > 0 && impulseOk && closePosBuy >= 0.7 && closes[i] > opens[i];
    const sellSignal = state.waitingFor === "SELL" && fractalBreakDown && separationOk && sma34Slope < 0 && impulseOk && closePosSell >= 0.7 && closes[i] < opens[i];

    let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;

    if (buySignal) {
      signalTriggered = true; direction = "BUY"; entry = closes[i];
      sl = fractals.significantLow !== null ? Math.min(fractals.significantLow, entry - atr14 * 1.5) : entry - atr14 * 1.5;
      risk = entry - sl; tp1 = entry + risk * RISK_REWARD; tp2 = entry + risk * 2; tp3 = entry + risk * 3;
    } else if (sellSignal) {
      signalTriggered = true; direction = "SELL"; entry = closes[i];
      sl = fractals.significantHigh !== null ? Math.max(fractals.significantHigh, entry + atr14 * 1.5) : entry + atr14 * 1.5;
      risk = sl - entry; tp1 = entry - risk * RISK_REWARD; tp2 = entry - risk * 2; tp3 = entry - risk * 3;
    }

    if (signalTriggered) {
      const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
      const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
      const d1 = await getD1Context();
      const alignment = d1 ? checkAlignment(direction, d1.direction) : "⚠️ D1 data unavailable";
      const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T", " ").substring(0, 19);

      let message = `🚨 ${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL 🚨\n\n` +
        `Direction: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n` +
        `📍 Entry:  ${entry.toFixed(4)}\n🛑 SL:     ${sl.toFixed(4)}\n` +
        `🎯 TP1:    ${tp1.toFixed(4)}  → trail with MACD after this\n` +
        `🎯 TP2:    ${tp2.toFixed(4)}  (reference)\n` +
        `🎯 TP3:    ${tp3.toFixed(4)}  (reference)\n\n` +
        `💰 Stake: $${STAKE_USD} | Hard SL: $${slDollars} | Soft TP1: $${tpDollars} | Safety: $${SAFETY_TP_USD}\n` +
        `📊 Risk:   ${risk.toFixed(2)} points\n🔥 Setup:  Fractal break confirmed with impulse\n` +
        `━━━━━━━━━━━━━━━━━━━━\n📅 D1 CANDLE STATUS\n━━━━━━━━━━━━━━━━━━━━\n`;
      if (d1) {
        message += `Direction:  ${d1.direction}\nD1 Open:    ${d1.open.toFixed(4)}\nD1 Current: ${d1.close.toFixed(4)}\n` +
          `Movement:   ${d1.change.toFixed(4)} pts (${d1.changePct.toFixed(2)}%)\nAlignment:  ${alignment}\n\n`;
      } else { message += `⚠️ D1 data unavailable\n\n`; }
      message += `⏰ Time (UTC): ${timeFormatted}`;
      await sendTelegram(message);

      trades.push({
        id: `${SYMBOL}-${isoTime}`, contractId: null, repo: REPO_LABEL,
        symbol: SYMBOL, direction, entry, sl, tp1, tp2, tp3,
        tp1Reached: false, rr: RISK_REWARD, openTime: timeFormatted, closeTime: null, result: null
      });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));

      try {
        const contractId = await executeTrade(direction);
        if (contractId) {
          trades[trades.length - 1].contractId = contractId;
          fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        }
      } catch (execErr) { console.error("⚠️ Live execution warning:", execErr.message); }

      state.waitingFor = null; state.setupEpoch = null;
    }

    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));

  } catch (err) { console.error("❌ BOT ERROR:", err.message); process.exit(1); }
}
