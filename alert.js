import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

const SYMBOL             = "R_10";
const TRADING_SYMBOL     = "R_10";
const SYMBOL_NAME        = "Volatility 10 Index";
const REPO_LABEL         = "Test Bot (V10 Live)";
const MULTIPLIER         = 400;
const STAKE_USD          = 10;
const RISK_REWARD        = 1.5;
const SAFETY_TP_USD      = 15;
const TRAIL_ACTIVATE_USD = 5;
const TRAIL_DROP_USD     = 3;
const ATR_PERIOD         = 14;
const SETUP_EXPIRY_BARS  = 35;
const MARKET_DATA_APP_ID = "1089";
const DERIV_APP_ID       = process.env.DERIV_APP_ID;
const TG_TOKEN       = process.env.TG_TOKEN;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const DERIV_TOKEN    = process.env.DERIV_API_TOKEN;
const PROXY_URL      = process.env.PROXY_URL;
const PROXY_SECRET   = process.env.PROXY_SECRET;
const MODE           = process.env.MODE           || "cronjob";
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || "manual";
const M5  = 5  * 60;
const M15 = 15 * 60;
const H1  = 60 * 60;
const H4  = 4  * 60 * 60;
const D1  = 24 * 60 * 60;

const DEBUG = process.env.DEBUG === "true";
function dbg(...a) { if (DEBUG) console.log("[DBG]", ...a); }

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("Telegram not configured: TG_TOKEN or TG_CHAT_ID is missing. Skipping sendTelegram.");
    return { ok: false, error: "missing_credentials" };
  }
  const send = async (text, parseMode) => {
    const body = { chat_id: TG_CHAT_ID, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let json;
    try { json = await res.json(); } catch (e) { json = { ok: false, error: `invalid_json_response: ${e.message}` }; }
    json.__http_status = res.status;
    return json;
  };
  try {
    const data = await send(msg, "Markdown");
    if (!data.ok) {
      console.error(`Telegram Markdown rejected (${data.error_code || data.error || 'unknown'}): ${data.description || JSON.stringify(data)}`);
      const plain = msg.replace(/[*_`\[\]]/g, "");
      const retry = await send(plain, "");
      if (!retry.ok) {
        console.error(`Telegram plain-text retry also failed: ${retry.description || JSON.stringify(retry)}`);
        return { ok: false, error: "telegram_send_failed", detail: retry };
      }
      return { ok: true, via: "plain_text", detail: retry };
    }
    return { ok: true, via: "markdown", detail: data };
  } catch (e) { console.error("Telegram fetch error:", e.message); return { ok: false, error: e.message }; }
}

function formatDuration(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h > 0) return `${h}h ${m%60}m`;
  if (m > 0) return `${m}m ${s%60}s`;
  return `${s}s`;
}

async function runSummary(label) {
  const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const closed = trades.filter(t => t.result);
  const wins = closed.filter(t => t.result === "WIN").length;
  const losses = closed.filter(t => t.result === "LOSS").length;
  const openTrades = trades.filter(t => !t.result);
  let msg = `📊 *${label} Summary — ${REPO_LABEL}*\n\nTotal closed: ${closed.length}\n✅ Wins: ${wins} | ❌ Losses: ${losses}\nWin rate: ${closed.length ? ((wins/closed.length)*100).toFixed([...]
  if (openTrades.length) msg += "\n\n*Open trades:*\n" + openTrades.map(t => `• ${t.direction} @ ${t.entry} (${t.openTime})`).join("\n");
  await sendTelegram(msg);
}

async function checkTelegramCommands() {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("checkTelegramCommands: TG_TOKEN or TG_CHAT_ID not set; skipping command polling.");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${state.lastTgUpdateId + 1}&limit=10&timeout=0`;
    const res = await fetch(url); const data = await res.json();
    if (!data.ok) return;
    for (const update of data.result) {
      state.lastTgUpdateId = update.update_id;
      const text = update.message?.text?.trim().toLowerCase();
      if (text === "/status") {
        const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
        const open = trades.filter(t => !t.result);
        await sendTelegram(open.length ? `📍 Open trades:\n${open.map(t=>`• ${t.direction} @ ${t.entry}`).join("\n")}` : "No open trades.");
      }
      if (text === "/close win")  { await executeManualClose("WIN",  "telegram command"); }
      if (text === "/close loss") { await executeManualClose("LOSS", "telegram command"); }
    }
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  } catch (e) { console.error("TG check error:", e.message); }
}

async function executeManualClose(result, reason) {
  const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const open = trades.filter(t => !t.result);
  if (!open.length) { await sendTelegram(`⚠️ *${REPO_LABEL}*\n\nNo open trade found to close.`); return; }
  for (const trade of open) {
    const currentPrice = await getCurrentPrice(trade.symbol);
    if (trade.contractId) { try { await closeContract(trade.contractId); } catch (e) { console.error("Close error:", e.message); } }
    trade.result = result;
    trade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
    fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    const icon = result === "WIN" ? "✅" : "❌";
    const contractType = trade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
    const durationMs = new Date(trade.closeTime) - new Date(trade.openTime);
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
    const pnl = trade.direction === "BUY" ? (currentPrice - trade.entry) / trade.entry * STAKE_USD * MULTIPLIER : (trade.entry - currentPrice) / trade.entry * STAKE_USD * MULTIPLIER;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const tp1Status = trade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
    await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${trade.direction} (${contractType})\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${trade.entry.toFixed(4)}\n🏁 E[...]
  }
}

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0 };
try { const s = JSON.parse(fs.readFileSync("state.json")); state = { ...state, ...s, waitingFor: s.waitingFor ?? null, setupEpoch: s.setupEpoch ?? null }; } catch {}

(async () => {
  if (MODE === "daily")      { await runSummary("Daily");   return; }
  if (MODE === "weekly")     { await runSummary("Weekly");  return; }
  if (MODE === "monthly")    { await runSummary("Monthly"); return; }
  if (MODE === "close_win")  { await executeManualClose("WIN",  "manual command"); return; }
  if (MODE === "close_loss") { await executeManualClose("LOSS", "manual command"); return; }
  if (MODE === "test") {
    await sendTelegram(`🧪 Test mode active — ${REPO_LABEL}\nFiring a direct BUY trade via proxy...\nCheck your Deriv account for a MULTUP contract.`);
    try { const cid = await executeTrade("BUY"); await sendTelegram(`✅ Test trade placed. Contract ID: ${cid}`); } catch (e) { await sendTelegram(`❌ Test trade failed: ${e.message}`); }
    return;
  }
  if (TRIGGER_SOURCE !== "cronjob") { console.log("Not a cronjob trigger — exiting."); return; }
  await runScanMode();
})();

function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 15000);
  });
}

async function withRetry(fn, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function fetchCandles(granularity, count = 100) {
  return withRetry(async () => {
    const ws = await openWS();
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ ticks_history: SYMBOL, granularity, count, end: "latest", style: "candles" }));
      ws.on("message", d => {
        const msg = JSON.parse(d); ws.close();
        if (msg.candles) resolve(msg.candles);
        else reject(new Error("No candles: " + JSON.stringify(msg)));
      });
      setTimeout(() => { ws.close(); reject(new Error("fetchCandles timeout")); }, 20000);
    });
  });
}

async function getCurrentPrice(sym = SYMBOL) {
  return withRetry(async () => {
    const ws = await openWS();
    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify({ ticks_history: sym, count: 1, end: "latest", style: "ticks" }));
      ws.on("message", d => {
        const msg = JSON.parse(d); ws.close();
        if (msg.history?.prices?.length) resolve(parseFloat(msg.history.prices[msg.history.prices.length - 1]));
        else reject(new Error("No price: " + JSON.stringify(msg)));
      });
      setTimeout(() => { ws.close(); reject(new Error("getCurrentPrice timeout")); }, 10000);
    });
  });
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
  const params = { buy: "1", price: STAKE_USD, parameters: { contract_type: direction === "BUY" ? "MULTUP" : "MULTDOWN", underlying_symbol: TRADING_SYMBOL, currency: "USD", amount: STAKE_USD, bas[...]
  const response = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET }, body: JSON.stringify({ wsUrl, action: "buy", params })[...]
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
  const response = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET }, body: JSON.stringify({ wsUrl, action: "sell", params: [...]
  const data = await response.json();
  console.log("📨 Close response:", JSON.stringify(data));
  return data;
}

function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function ema(data, period) {
  const k = 2 / (period + 1); const result = []; let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (i === period - 1) { prev = data.slice(0, period).reduce((a,b)=>a+b,0)/period; result.push(prev); continue; }
    prev = data[i] * k + prev * (1 - k); result.push(prev);
  }
  return result;
}

function calculateATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return parseFloat(c.high) - parseFloat(c.low);
    const ph = parseFloat(candles[i-1].close);
    return Math.max(parseFloat(c.high)-parseFloat(c.low), Math.abs(parseFloat(c.high)-ph), Math.abs(parseFloat(c.low)-ph));
  });
  const atrs = sma(trs, period);
  return atrs[atrs.length - 1] || (trs.reduce((a,b)=>a+b,0)/trs.length);
}

function calcUnrealizedPnL(trade, currentPrice) {
  if (trade.direction === "BUY")  return (currentPrice - trade.entry) / trade.entry * STAKE_USD * MULTIPLIER;
  if (trade.direction === "SELL") return (trade.entry - currentPrice) / trade.entry * STAKE_USD * MULTIPLIER;
  return 0;
}

function getFractals(candles) {
  const pivots = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const h = parseFloat(candles[i].high);
    const l = parseFloat(candles[i].low);
    if (
      h > parseFloat(candles[i-1].high) && h > parseFloat(candles[i-2].high) &&
      h > parseFloat(candles[i+1].high) && h > parseFloat(candles[i+2].high)
    ) pivots.push({ type: "high", value: h });
    if (
      l < parseFloat(candles[i-1].low) && l < parseFloat(candles[i-2].low) &&
      l < parseFloat(candles[i+1].low) && l < parseFloat(candles[i+2].low)
    ) pivots.push({ type: "low", value: l });
  }
  const recent = pivots.slice(-6);
  const highs = recent.filter(p => p.type === "high").map(p => p.value);
  const lows  = recent filter(p => p.type === "low").map(p => p.value);
  const significantHigh = highs.length ? Math.max(...highs) : null;
  const significantLow  = lows.length  ? Math.min(...lows)  : null;
  return { significantHigh, significantLow };
}

async function fetchH4Candle() {
  try {
    const candles = await fetchCandles(H4, 10);
    if (!candles || candles.length < 2) return null;
    return candles[candles.length - 2];
  } catch (e) { console.error("fetchH4Candle error:", e.message); return null; }
}

async function getD1Context() {
  try {
    const candles = await fetchCandles(D1, 5);
    if (!candles || candles.length < 2) return null;
    const c = candles[candles.length - 2];
    const open = parseFloat(c.open), close = parseFloat(c.close);
    const change = close - open, changePct = (change / open) * 100;
    return { direction: close > open ? "🟢 BULLISH" : "🔴 BEARISH", open, close, change, changePct };
  } catch (e) { console.error("getD1Context error:", e.message); return null; }
}

function checkAlignment(signalDir, d1Dir) {
  const bull = d1Dir.includes("BULLISH"), bear = d1Dir.includes("BEARISH");
  if (signalDir === "BUY"  && bull) return "✅ D1 confirms BUY";
  if (signalDir === "SELL" && bear) return "✅ D1 confirms SELL";
  if (signalDir === "BUY"  && bear) return "⚠️ Counter-trend BUY (D1 bearish)";
  if (signalDir === "SELL" && bull) return "⚠️ Counter-trend SELL (D1 bullish)";
  return "❓ Unknown";
}

async function runScanMode() {
  console.log(`[${REPO_LABEL}] Scan started — ${new Date().toISOString()}`);
  await checkTelegramCommands();

  let trades = [];
  try { trades = JSON.parse(fs.readFileSync("trades.json")); } catch {}

  const openTrade = trades.find(t => !t.result);
  if (openTrade) {
    const currentPrice = await getCurrentPrice();
    const pnl = calcUnrealizedPnL(openTrade, currentPrice);
    dbg(`Open trade PnL: ${pnl.toFixed(4)}`);

    const closeWith = async (result, exitReason) => {
      openTrade.result = result;
      openTrade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
      if (openTrade.contractId) { try { await closeContract(openTrade.contractId); } catch (e) { console.error("Close error:", e.message); } }
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      const icon = result === "WIN" ? "✅" : "❌";
      const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
      const durationMs = new Date(openTrade.closeTime) - new Date(openTrade.openTime);
      const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
      const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
      const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${openTrade.entry.toFixed(4[...]
    };

    const slBreached = openTrade.direction === "BUY" ? currentPrice <= openTrade.sl : currentPrice >= openTrade.sl;
    dbg(`slBreached: ${slBreached}, tp1Reached: ${openTrade.tp1Reached}, peakProfit: ${openTrade.peakProfit}`);
    if (slBreached) { await closeWith("LOSS", `Hard SL hit — price ${currentPrice.toFixed(4)} breached SL ${openTrade.sl.toFixed(4)}`); return; }

    if (pnl >= SAFETY_TP_USD) { await closeWith("WIN", `Safety TP hit — $${SAFETY_TP_USD} ceiling reached`); return; }

    if (!openTrade.tp1Reached) {
      const tp1Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp1 : currentPrice <= openTrade.tp1;
      if (tp1Hit) { openTrade.tp1Reached = true; openTrade.macdEarlyFlipEpoch = null; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); await sendTelegram(`🎯 *${REPO_LABEL} —[...]
    }

    if (pnl >= TRAIL_ACTIVATE_USD) {
      if (openTrade.peakProfit === null || pnl > openTrade.peakProfit) { openTrade.peakProfit = pnl; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); }
      if (openTrade.peakProfit !== null && pnl < openTrade.peakProfit - TRAIL_DROP_USD) { const result = pnl >= 0 ? "WIN" : "LOSS"; await closeWith(result, `Profit trail exit — locked ~$${pnl.t[...]
    }

    if (!openTrade.tp1Reached) {
      const m5Early = await fetchCandles(M5, 60);
      if (m5Early && m5Early.length >= 52) {
        const cls = m5Early.map(c => parseFloat(c.close)), ci = m5Early.length - 2;
        const sf = sma(cls, 2), ss = sma(cls, 50);
        if (sf[ci] != null && ss[ci] != null) {
          const m5Against = openTrade.direction === "BUY" ? sf[ci] < ss[ci] : sf[ci] > ss[ci];
          if (m5Against) { const result = pnl >= 0 ? "WIN" : "LOSS"; await closeWith(result, `M5 SMA reversal exit (pre-TP1) — ${openTrade.direction} momentum lost`); return; }
        }
      }
    }

    if (openTrade.tp1Reached) {
      const m5c = await fetchCandles(M5, 120);
      if (m5c && m5c.length >= 100) {
        const cls = m5c.map(c => parseFloat(c.close)), ci = m5c.length - 2;
        const macdFast = ema(cls, 8), macdSlow = ema(cls, 100);
        const macdVal = (macdFast[ci] != null && macdSlow[ci] != null) ? macdFast[ci] - macdSlow[ci] : null;
        if (macdVal !== null) {
          const flip = openTrade.direction === "BUY" ? macdVal < 0 : macdVal > 0;
          if (flip) {
            if (!openTrade.macdEarlyFlipEpoch) { openTrade.macdEarlyFlipEpoch = m5c[ci].epoch; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); }
            else if (m5c[ci].epoch > openTrade.macdEarlyFlipEpoch) { const result = pnl >= 0 ? "WIN" : "LOSS"; await closeWith(result, `MACD(8,100) trail exit — momentum flipped after TP1`); re[...]
          } else { openTrade.macdEarlyFlipEpoch = null; fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); }
        }
      }
    }

    if (openTrade.h1OpenAtEntry != null) {
      const h1Breach = openTrade.direction === "BUY" ? currentPrice < openTrade.h1OpenAtEntry : currentPrice > openTrade.h1OpenAtEntry;
      if (h1Breach) { const result = pnl >= 0 ? "WIN" : "LOSS"; await closeWith(result, `H1 open breach — price ${currentPrice.toFixed(4)} crossed H1 open ${openTrade.h1OpenAtEntry.toFixed(4)}`[...]
    }

    console.log("Open trade being managed — skipping scan.");
    return;
  }

  const candles = await fetchCandles(M5, 120);
  if (!candles || candles.length < 60) { console.log("Not enough M5 candles."); return; }

  const i = candles.length - 2;
  const currentCandleEpoch = candles[i].epoch;
  const closes = candles.map(c => parseFloat(c.close));
  if (state.lastProcessedEpoch === currentCandleEpoch) { console.log("Already processed this candle — skipping."); return; }

  const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
  const opens = candles.map(c => parseFloat(c.open));
  const highs = candles.map(c => parseFloat(c.high));
  const lows  = candles.map(c => parseFloat(c.low));
  const smaFast5 = sma(closes, 2), smaSlow5 = sma(closes, 50);
  const atr14 = calculateATR(candles, ATR_PERIOD);

  const h1Candles = await fetchCandles(H1, 100);
  let h1Dir = null, h1OpenAtEntry = null;
  if (h1Candles && h1Candles.length >= 52) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close)), h1ci = h1Candles.length - 2;
    const smaFast1h = sma(h1Closes, 2), smaSlow1h = sma(h1Closes, 50);
    if (smaFast1h[h1ci] != null && smaSlow1h[h1ci] != null) {
      if      (smaFast1h[h1ci] > smaSlow1h[h1ci]) h1Dir = "BUY";
      else if (smaFast1h[h1ci] < smaSlow1h[h1ci]) h1Dir = "SELL";
    }
    h1OpenAtEntry = parseFloat(h1Candles[h1Candles.length - 1].open);
  }

  const m15Candles = await fetchCandles(M15, 100);
  let m15Dir = null;
  if (m15Candles && m15Candles.length >= 52) {
    const m15Closes = m15Candles.map(c => parseFloat(c.close)), m15ci = m15Candles.length - 2;
    const smaFast15 = sma(m15Closes, 2), smaSlow15 = sma(m15Closes, 50);
    if (smaFast15[m15ci] != null && smaSlow15[m15ci] != null) {
      if      (smaFast15[m15ci] > smaSlow15[m15ci]) m15Dir = "BUY";
      else if (smaFast15[m15ci] < smaSlow15[m15ci]) m15Dir = "SELL";
    }
  }

  let m5Dir = null;
  if (smaFast5[i] != null && smaSlow5[i] != null) {
    if      (smaFast5[i] > smaSlow5[i]) m5Dir = "BUY";
    else if (smaFast5[i] < smaSlow5[i]) m5Dir = "SELL";
  }

  dbg(`H1 dir: ${h1Dir} | M15 dir: ${m15Dir} | M5 dir: ${m5Dir}`);

  const aligned = h1Dir && m15Dir && m5Dir && h1Dir === m15Dir && m15Dir === m5Dir;
  if (aligned) {
    if (state.waitingFor !== h1Dir) { state.waitingFor = h1Dir; state.setupEpoch = currentCandleEpoch; console.log(`Alignment detected: ${h1Dir} — setup clock started.`); }
    else { console.log(`Alignment continues: ${h1Dir} — setup clock preserved.`); }
  } else {
    if (state.waitingFor) console.log(`Alignment broken (H1:${h1Dir} M15:${m15Dir} M5:${m5Dir}) — clearing setup.`);
    state.waitingFor = null; state.setupEpoch = null;
  }
  if (state.waitingFor && state.setupEpoch && (currentCandleEpoch - state.setupEpoch) > (SETUP_EXPIRY_BARS * M5)) { console.log("Setup expired — clearing."); state.waitingFor = null; state.setu[...]