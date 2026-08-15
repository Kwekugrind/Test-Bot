import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION ====================
// UNCOMMENT THE CONFIGURATION MATCHING YOUR REPOSITORY:
// --- 1. Test Bot (Live) ---
const SYMBOL = "R_10"; const SYMBOL_NAME = "Volatility 10 Index"; const REPO_LABEL = "Test Bot (V10 Live)"; const MULTIPLIER = 400; const COMMISSION_USD = 0.16;

// --- 2. OmniSight (Live) ---
// const SYMBOL = "R_50"; const SYMBOL_NAME = "Volatility 50 Index"; const REPO_LABEL = "OmniSight (V50)"; const MULTIPLIER = 80; const COMMISSION_USD = 0.16;

// --- 3. Lery's Alerts (Demo) ---
// const SYMBOL = "R_75"; const SYMBOL_NAME = "Volatility 75 Index"; const REPO_LABEL = "Lery's Alerts (V75 Demo)"; const MULTIPLIER = 50; const COMMISSION_USD = 0.15;

// --- 4. Coffee (Demo) ---
// const SYMBOL = "1HZ75V"; const SYMBOL_NAME = "Volatility 75 (1s) Index"; const REPO_LABEL = "Coffee (V75-1s Demo)"; const MULTIPLIER = 50; const COMMISSION_USD = 0.15;

// --- 5. Milk (Demo) ---
// const SYMBOL = "R_100"; const SYMBOL_NAME = "Volatility 100 Index"; const REPO_LABEL = "Milk (V100 Demo)"; const MULTIPLIER = 40; const COMMISSION_USD = 0.15;

// --- 6. Tea (Demo) ---
// const SYMBOL = "R_25"; const SYMBOL_NAME = "Volatility 25 Index"; const REPO_LABEL = "Tea (V25 Demo)"; const MULTIPLIER = 160; const COMMISSION_USD = 0.15;

// --- 7. Ice Cream Machine (Demo) ---
// const SYMBOL = "1HZ100V"; const SYMBOL_NAME = "Volatility 100 (1s) Index"; const REPO_LABEL = "Ice Cream Machine"; const MULTIPLIER = 40; const COMMISSION_USD = 0.15;

const TRADING_SYMBOL = SYMBOL;
const STAKE_USD = 10;
const RISK_REWARD = 1.5;
const SAFETY_TP_USD = 15.00; // $15 flat profit insurance ceiling on broker side
const BREAKEVEN_ACTIVATE_USD = 2.00; // Move SL to entry once profit hits $2.00
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 2.0; // Stop loss breathing room
const SETUP_EXPIRY_BARS = 35;
const MARKET_DATA_APP_ID = "1089"; // Dedicated public App ID for unauthenticated candle data
const DERIV_APP_ID = process.env.DERIV_APP_ID || "67418"; // Personal App ID for trading/OTP
const TG_TOKEN = process.env.TG_BOT_TOKEN || process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DERIV_TOKEN = process.env.DERIV_API_TOKEN;
const PROXY_URL = process.env.PROXY_URL;
const PROXY_SECRET = process.env.PROXY_SECRET;
const MODE = process.env.MODE || "cronjob";
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || "manual";

const M5 = 5 * 60;
const M15 = 15 * 60;
const H1 = 60 * 60;
const H4 = 4 * 60 * 60;
const D1 = 24 * 60 * 60;

const DEBUG = process.env.DEBUG === "true";
function dbg(...a) { if (DEBUG) console.log("[DBG]", ...a); }

// ==================== TELEGRAM & UTILS ====================
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
  let msg = `ðŸ“Š *${label} Summary â€” ${REPO_LABEL}*\n\nTotal closed: ${closed.length}\nâœ… Wins: ${wins} | âŒ Losses: ${losses}\nWin rate: ${closed.length ? ((wins/closed.length)*100).toFixed(1) : 0}%\nOpen positions: ${openTrades.length}`;
  if (openTrades.length) msg += "\n\n*Open trades:*\n" + openTrades.map(t => `â€¢ ${t.direction} @ ${t.entry} (${t.openTime})`).join("\n");
  await sendTelegram(msg);
}

async function checkTelegramCommands() {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${state.lastTgUpdateId + 1}&limit=10&timeout=0`;
    const res = await fetch(url); const data = await res.json();
    if (!data.ok) return;
    for (const update of data.result) {
      state.lastTgUpdateId = update.update_id;
      const text = update.message?.text?.trim()?.toLowerCase();
      if (text === "/status") {
        const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
        const open = trades.filter(t => !t.result);
        await sendTelegram(open.length ? `ðŸ“ Open trades:\n${open.map(t=>`â€¢ ${t.direction} @ ${t.entry}`).join("\n")}` : "No open trades.");
      }
      if (text === "/close win" || text === "/closewin") { await executeManualClose("WIN", "telegram command"); }
      if (text === "/close loss" || text === "/closeloss") { await executeManualClose("LOSS", "telegram command"); }
    }
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  } catch (e) { console.error("TG check error:", e.message); }
}

async function executeManualClose(result, reason) {
  const trades = fs.existsSync("trades.json") ? JSON.parse(fs.readFileSync("trades.json")) : [];
  const open = trades.filter(t => !t.result);
  if (!open.length) { await sendTelegram(`âš ï¸ *${REPO_LABEL}*\n\nNo open trade found to close.`); return; }
  for (const trade of open) {
    const currentPrice = await getCurrentPrice(trade.symbol);
    let serverPnl = calcUnrealizedPnL(trade, currentPrice);
    if (trade.contractId) {
      try {
        const closeRes = await closeContract(trade.contractId);
        if (!closeRes || closeRes.error) {
          const errCode = closeRes.error?.code;
          const errDesc = closeRes.error?.message || JSON.stringify(closeRes.error);
          if (errCode === "ContractNotFound" || errDesc.includes("not found among your open positions")) {
            serverPnl = -5.00;
          } else {
            await sendTelegram(`âš ï¸ *${REPO_LABEL}* â€” Manual Close Warning\n\nFailed to close contract \`${trade.contractId}\` on Deriv: ${errDesc}. Retrying next scan.`);
            continue;
          }
        }
        if (typeof closeRes.sell?.profit === 'number') {
          serverPnl = closeRes.sell.profit;
        }
      } catch (e) {
        console.error("Close error:", e.message);
        continue;
      }
    }
    trade.result = result;
    trade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
    fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    const icon = result === "WIN" ? "âœ…" : "âŒ";
    const contractType = trade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
    const durationMs = new Date(trade.closeTime) - new Date(trade.openTime);
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
    const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
    const tp1Status = trade.tp1Reached ? "âœ… TP1 hit" : "âŒ TP1 not reached";
    await sendTelegram(`${icon} *${REPO_LABEL} â€” Trade ${result}*\n\nDirection: ${trade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\nðŸ“ Entry: ${trade.entry.toFixed(4)}\nðŸ Exit: ${currentPrice.toFixed(4)}\nðŸ›‘ SL: ${trade.sl.toFixed(4)} ($${slDollars} hard)\nðŸŽ¯ TP1: ${trade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\nðŸ’µ P&L: ${pnlStr} (Net of comm.)\nReason: ${reason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${trade.openTime}\nClosed: ${trade.closeTime}\n` + (trade.contractId ? `Contract: \`${trade.contractId}\`` : ""));
  }
}

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0, h1TrendEpoch: null, phaseATriggeredEpoch: null, phaseCTriggeredEpoch: null, phaseDTriggeredEpoch: null, activeEntryType: null, anticipatedTrend: null, pendingPullback: null, pullbackEpoch: null, pullbackTrigger: null, rsiLowerBreakSeen: false, rsiUpperBreakSeen: false, h1m15WasAligned: false };
try {
  const s = JSON.parse(fs.readFileSync("state.json"));
  state = {
    ...state, ...s,
    waitingFor: s.waitingFor ?? null,
    setupEpoch: s.setupEpoch ?? null,
    h1TrendEpoch: s.h1TrendEpoch ?? null,
    phaseATriggeredEpoch: s.phaseATriggeredEpoch ?? null,
    phaseCTriggeredEpoch: s.phaseCTriggeredEpoch ?? null,
    phaseDTriggeredEpoch: s.phaseDTriggeredEpoch ?? null,
    activeEntryType: s.activeEntryType ?? null,
    anticipatedTrend: s.anticipatedTrend ?? null,
    pendingPullback: s.pendingPullback ?? null,
    pullbackEpoch: s.pullbackEpoch ?? null,
    pullbackTrigger: s.pullbackTrigger ?? null,
    rsiLowerBreakSeen: s.rsiLowerBreakSeen ?? false,
    rsiUpperBreakSeen: s.rsiUpperBreakSeen ?? false,
    h1m15WasAligned: s.h1m15WasAligned ?? false
  };
} catch {}

// ==================== DERIV API & PROXY HELPERS ====================
function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 15000);
  });
}

// Smart 429 RateLimit Backoff
async function withRetry(fn, retries = 3, delay = 4000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const isRateLimit = e.message.includes("429") || e.message.includes("RateLimit");
      if (i === retries - 1) throw e;
      const currentDelay = isRateLimit ? delay * (i + 2) : delay;
      dbg(`Retry ${i+1}/${retries} after error: ${e.message}. Waiting ${currentDelay}ms...`);
      await new Promise(r => setTimeout(r, currentDelay));
    }
  }
}

// CONSOLIDATED DATA FETCHER (Opens ONE single WebSocket connection instead of separate ones)
async function fetchAllData() {
  return withRetry(async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
      const results = {};
      ws.on("open", () => {
        ws.send(JSON.stringify({ req_id: 1, ticks_history: SYMBOL, granularity: M5, count: 120, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 2, ticks_history: SYMBOL, granularity: H1, count: 100, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 3, ticks_history: SYMBOL, granularity: M15, count: 100, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 4, ticks_history: SYMBOL, granularity: H4, count: 10, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 5, ticks_history: SYMBOL, granularity: D1, count: 5, end: "latest", style: "candles" }));
      });
      ws.on("message", d => {
        const msg = JSON.parse(d);
        if (msg.req_id === 1) results.m5 = msg.candles;
        if (msg.req_id === 2) results.h1 = msg.candles;
        if (msg.req_id === 3) results.m15 = msg.candles;
        if (msg.req_id === 4) results.h4 = msg.candles;
        if (msg.req_id === 5) results.d1 = msg.candles;
        if (results.m5 && results.h1 && results.m15 && results.h4 && results.d1) {
          ws.close();
          resolve(results);
        }
      });
      ws.on("error", (err) => { ws.close(); reject(err); });
      setTimeout(() => { ws.close(); reject(new Error("fetchAllData timeout")); }, 20000);
    });
  });
}

// CONSOLIDATED OPEN TRADE FETCHER (Price + M5 Candles + M15 Candles in ONE connection)
async function fetchOpenTradeData() {
  return withRetry(async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${MARKET_DATA_APP_ID}`);
      const results = {};
      ws.on("open", () => {
        ws.send(JSON.stringify({ req_id: 1, ticks_history: SYMBOL, granularity: M5, count: 50, end: "latest", style: "candles" }));
        ws.send(JSON.stringify({ req_id: 2, ticks_history: SYMBOL, count: 1, end: "latest", style: "ticks" }));
        ws.send(JSON.stringify({ req_id: 3, ticks_history: SYMBOL, granularity: M15, count: 60, end: "latest", style: "candles" }));
      });
      ws.on("message", d => {
        const msg = JSON.parse(d);
        if (msg.req_id === 1) results.candles = msg.candles;
        if (msg.req_id === 2) results.price = msg.history?.prices?.[msg.history.prices.length - 1];
        if (msg.req_id === 3) results.m15 = msg.candles;
        if (results.candles && results.price !== undefined && results.m15 !== undefined) {
          ws.close();
          resolve(results);
        }
      });
      ws.on("error", (err) => { ws.close(); reject(err); });
      setTimeout(() => { ws.close(); reject(new Error("fetchOpenTradeData timeout")); }, 15000);
    });
  });
}

async function getCurrentPrice(sym = SYMBOL) {
  const data = await fetchOpenTradeData();
  return data.price;
}

async function getDerivAccountId() {
  const res = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
    headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getAccounts failed: ${JSON.stringify(json.errors || json)}`);
  const accounts = json.data;
  if (!accounts || accounts.length === 0) throw new Error("No Deriv accounts found");
  const account = accounts.find(a => a.account_type !== "demo") || accounts[0];
  console.log(` Account ID: ${account.account_id} (${account.account_type})`);
  return account.account_id;
}

async function getDerivOTP(accountId) {
  const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
    method: "POST", headers: { "Deriv-App-ID": DERIV_APP_ID, "Authorization": `Bearer ${DERIV_TOKEN}` }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`getOTP failed: ${JSON.stringify(json.errors || json)}`);
  console.log(` OTP WebSocket URL obtained âœ…`);
  return json.data.url;
}

// â”€â”€ Resilient Trade Execution with withRetry â”€â”€
async function executeTrade(direction) {
  if (!DERIV_TOKEN) { console.log("âš ï¸ DERIV_API_TOKEN not set. Skipping."); return null; }
  if (!DERIV_APP_ID) { console.log("âš ï¸ DERIV_APP_ID not set. Skipping."); return null; }
  if (!PROXY_URL || !PROXY_SECRET) { console.log("âš ï¸ PROXY_URL or PROXY_SECRET not set. Skipping."); return null; }
  
  return withRetry(async () => {
    console.log(`ðŸ”„ Sending ${direction} trade via Cloudflare proxy...`);
    const accountId = await getDerivAccountId();
    const wsUrl = await getDerivOTP(accountId);
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpValue = typeof SAFETY_TP_USD !== 'undefined' ? SAFETY_TP_USD : 15.00;
    const params = {
      buy: "1",
      price: STAKE_USD,
      parameters: {
        contract_type: direction === "BUY" ? "MULTUP" : "MULTDOWN",
        underlying_symbol: TRADING_SYMBOL,
        currency: "USD",
        amount: STAKE_USD,
        basis: "stake",
        multiplier: MULTIPLIER,
        limit_order: {
          stop_loss: slDollars,
          take_profit: tpValue
        }
      }
    };
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET },
      body: JSON.stringify({ wsUrl, action: "buy", params })
    });
    const data = await response.json();
    console.log("ðŸ“¨ Proxy response:", JSON.stringify(data));
    
    if (data.error || data.errors || String(JSON.stringify(data)).includes("429") || String(JSON.stringify(data)).includes("RateLimit")) {
      throw new Error(`429/RateLimit/Error: ${JSON.stringify(data.error || data.errors || data)}`);
    }
    
    const contractId = data.buy?.contract_id;
    if (contractId) { 
      console.log(`âœ… Trade Executed! Contract ID: ${contractId}`); 
      return contractId; 
    }
    throw new Error("No contract ID returned in buy response");
  }, 4, 5000);
}

// â”€â”€ Resilient Contract Closing with withRetry â”€â”€
async function closeContract(contractId) {
  if (!DERIV_TOKEN || !contractId || !PROXY_URL || !PROXY_SECRET || !DERIV_APP_ID) return null;
  return withRetry(async () => {
    console.log(`ðŸ”„ Closing contract ${contractId} via proxy...`);
    const accountId = await getDerivAccountId();
    const wsUrl = await getDerivOTP(accountId);
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET },
      body: JSON.stringify({ wsUrl, action: "sell", params: { sell: contractId, price: 0 } })
    });
    const data = await response.json();
    console.log("ðŸ“¨ Close response:", JSON.stringify(data));
    
    if (data.error || data.errors || String(JSON.stringify(data)).includes("429") || String(JSON.stringify(data)).includes("RateLimit")) {
      throw new Error(`429/RateLimit/Error: ${JSON.stringify(data.error || data.errors || data)}`);
    }
    return data;
  }, 4, 5000);
}

// ==================== TECHNICAL ANALYSIS & INDICATORS ====================
function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function ema(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (i === period - 1) { prev = data.slice(0, period).reduce((a,b)=>a+b,0)/period; result.push(prev); continue; }
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function calculateATR(candles, period) {
  const trs = candles.map((c, i) => {
    if (i === 0) return parseFloat(c.high) - parseFloat(c.low);
    const ph = parseFloat(candles[i-1].close);
    return Math.max(parseFloat(c.high) - parseFloat(c.low), Math.abs(parseFloat(c.high) - ph), Math.abs(parseFloat(c.low) - ph));
  });
  const atrs = sma(trs, period);
  return atrs[atrs.length - 1] || (trs.reduce((a,b)=>a+b,0)/trs.length);
}

function calcUnrealizedPnL(trade, currentPrice) {
  const rawPnl = trade.direction === "BUY" ? (currentPrice - trade.entry) / trade.entry * STAKE_USD * MULTIPLIER : (trade.entry - currentPrice) / trade.entry * STAKE_USD * MULTIPLIER;
  return rawPnl - COMMISSION_USD;
}

function calculateMACD(data, fastPeriod = 3, slowPeriod = 50, signalPeriod = 1) {
  const fastEMA = ema(data, fastPeriod);
  const slowEMA = ema(data, slowPeriod);
  const macdLine = fastEMA.map((f, i) => (f != null && slowEMA[i] != null) ? f - slowEMA[i] : null);
  const validMacd = macdLine.map(x => x !== null ? x : 0);
  const signalLine = ema(validMacd, signalPeriod);
  const histogram = macdLine.map((m, i) => (m != null && signalLine[i] != null) ? m - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

function calculateCCI(candles, period = 34) {
  const tp = candles.map(c => (parseFloat(c.high) + parseFloat(c.low) + parseFloat(c.close)) / 3);
  const smaTp = sma(tp, period);
  return tp.map((_, i) => {
    if (i < period - 1 || smaTp[i] == null) return null;
    const sliceTp = tp.slice(i - period + 1, i + 1);
    const meanTp = smaTp[i];
    const meanDev = sliceTp.reduce((sum, val) => sum + Math.abs(val - meanTp), 0) / period;
    if (meanDev === 0) return 0;
    return (tp[i] - meanTp) / (0.015 * meanDev);
  });
}

function calculateRSI(data, period = 14) {
  const result = new Array(data.length).fill(null);
  if (data.length <= period) return result;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i-1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - (100 / (1 + rs));
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i-1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff >= 0 ? 0 : -diff;
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - (100 / (1 + rs));
  }
  return result;
}

function calculateBollingerBands(data, period = 34, deviation = 1.619) {
  const middle = sma(data, period);
  const upper = [];
  const lower = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1 || middle[i] == null || data[i] == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = data.slice(i - period + 1, i + 1);
    if (slice.some(val => val == null)) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const mean = middle[i];
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdev = Math.sqrt(variance);
    upper.push(mean + (stdev * deviation));
    lower.push(mean - (stdev * deviation));
  }
  return { upper, middle, lower };
}

function getBGAInfo(price) {
  let step = 100;
  if (price > 20000) step = 500;
  else if (price > 10000) step = 200;
  else if (price > 5000) step = 100;
  else if (price > 2000) step = 50;
  else if (price > 1000) step = 20;
  else step = 10;

  const whole = Math.round(price / step) * step;
  const half = whole - (step / 2);
  const isWhole = Math.abs(price - whole) <= (step * 0.05);
  const isHalf = Math.abs(price - half) <= (step * 0.05);
  if (isWhole) return `BGA Whole Level (${whole})`;
  if (isHalf) return `BGA Half Level (${half})`;
  return `BGA Zone (Near ${whole})`;
}

function calculateBgaTakeProfits(entry, direction, atr14, d1Candles) {
  let step = 100;
  if (entry > 20000) step = 500;
  else if (entry > 10000) step = 200;
  else if (entry > 5000) step = 100;
  else if (entry > 2000) step = 50;
  else if (entry > 1000) step = 20;
  else step = 10;

  const halfStep = step / 2;
  const baseWhole = Math.round(entry / step) * step;
  const minBuffer = Math.max(step * 0.20, atr14 * 1.2);

  let fibMaxLimit = null;
  if (d1Candles && d1Candles.length >= 2) {
    const prevDay = d1Candles[d1Candles.length - 2];
    const prevHigh = parseFloat(prevDay.high);
    const prevLow = parseFloat(prevDay.low);
    const prevRange = prevHigh - prevLow;
    if (prevRange > 0) {
      if (direction === "BUY") {
        fibMaxLimit = prevHigh + (prevRange * 2.618);
      } else {
        fibMaxLimit = prevLow - (prevRange * 2.618);
      }
    }
  }

  const allLevels = [];
  for (let offset = -10 * step; offset <= 15 * step; offset += halfStep) {
    allLevels.push(baseWhole + offset);
  }

  if (direction === "BUY") {
    let w = baseWhole;
    if (w <= entry) w += step;
    let validTp1 = null;
    while (!validTp1 && w <= entry + (step * 5)) {
      if ((w - entry) >= minBuffer) {
        validTp1 = w;
      }
      w += step;
    }
    const tp1 = validTp1 || (baseWhole + step);

    let futureLevels = allLevels.filter(l => l > tp1).sort((a, b) => a - b);
    if (fibMaxLimit) futureLevels = futureLevels.filter(l => l <= fibMaxLimit);

    let tp2 = futureLevels[0] || tp1 + halfStep;
    let tp3 = futureLevels[1] || tp1 + step;

    if (tp2 <= tp1) tp2 = tp1 + halfStep;
    if (tp3 <= tp2) tp3 = tp2 + halfStep;

    return { tp1, tp2, tp3 };
  } else {
    let w = baseWhole;
    if (w >= entry) w -= step;
    let validTp1 = null;
    while (!validTp1 && w >= entry - (step * 5)) {
      if ((entry - w) >= minBuffer) {
        validTp1 = w;
      }
      w -= step;
    }
    const tp1 = validTp1 || (baseWhole - step);

    let futureLevels = allLevels.filter(l => l < tp1).sort((a, b) => b - a);
    if (fibMaxLimit) futureLevels = futureLevels.filter(l => l >= fibMaxLimit);

    let tp2 = futureLevels[0] || tp1 - halfStep;
    let tp3 = futureLevels[1] || tp1 - step;

    if (tp2 >= tp1) tp2 = tp1 - halfStep;
    if (tp3 >= tp2) tp3 = tp2 - halfStep;

    return { tp1, tp2, tp3 };
  }
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
    return { direction: close > open ? "ðŸŸ¢ BULLISH" : "ðŸ”´ BEARISH", open, close, change, changePct, candles };
  } catch (e) { console.error("getD1Context error:", e.message); return null; }
}

function checkAlignment(signalDir, d1Dir) {
  const bull = d1Dir.includes("BULLISH"), bear = d1Dir.includes("BEARISH");
  if (signalDir === "BUY" && bull) return "âœ… D1 confirms BUY";
  if (signalDir === "SELL" && bear) return "âœ… D1 confirms SELL";
  if (signalDir === "BUY" && bear) return "âš ï¸ Counter-trend BUY (D1 bearish)";
  if (signalDir === "SELL" && bull) return "âš ï¸ Counter-trend SELL (D1 bullish)";
  return "â“ Unknown";
}

// ==================== MAIN SCANNER & TRADE LOGIC ====================
async function runScanMode() {
  console.log(`[${REPO_LABEL}] Scan started â€” ${new Date().toISOString()}`);
  await checkTelegramCommands();
  let trades = [];
  try { trades = JSON.parse(fs.readFileSync("trades.json")); } catch {}

  // â”€â”€ Open Position Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const openTrade = trades.find(t => !t.result);
  if (openTrade) {
    const tradeData = await fetchOpenTradeData();
    const currentPrice = tradeData.price;
    const pnl = calcUnrealizedPnL(openTrade, currentPrice);
    dbg(`Open trade PnL: ${pnl.toFixed(4)}`);

    const closeWith = async (result, exitReason) => {
      openTrade.result = result;
      openTrade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
      let serverPnl = pnl;
      if (openTrade.contractId) {
        try {
          const closeRes = await closeContract(openTrade.contractId);
          if (!closeRes || closeRes.error) {
            const errCode = closeRes.error?.code;
            const errDesc = closeRes.error?.message || JSON.stringify(closeRes.error);
            if (errCode === "ContractNotFound" || errDesc.includes("not found among your open positions")) {
              serverPnl = -5.00;
            } else {
              console.error(`âš ï¸ Failed to close contract on Deriv: ${errDesc}`);
              await sendTelegram(`âš ï¸ *${REPO_LABEL}* â€” Close Warning\n\nFailed to close contract \`${openTrade.contractId}\` on Deriv: ${errDesc}. Retrying next scan.`);
              return;
            }
          } else if (typeof closeRes.sell?.profit === 'number') {
            serverPnl = closeRes.sell.profit;
          }
        } catch (e) {
          console.error("Close exception:", e.message);
          await sendTelegram(`âš ï¸ *${REPO_LABEL}* â€” Close Error\n\nException closing contract \`${openTrade.contractId}\`: ${e.message}. Retrying next scan.`);
          return;
        }
      }

      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      const icon = result === "WIN" ? "âœ…" : "âŒ";
      const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
      const durationMs = new Date(openTrade.closeTime) - new Date(openTrade.openTime);
      const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
      const tpDollars = parseFloat((STAKE_USD * RISK_REWARD).toFixed(2));
      const tp1Status = openTrade.tp1Reached ? "âœ… TP1 hit" : "âŒ TP1 not reached";
      const pnlStr = serverPnl >= 0 ? `+$${serverPnl.toFixed(2)}` : `-$${Math.abs(serverPnl).toFixed(2)}`;
      
      await sendTelegram(`${icon} *${REPO_LABEL} â€” Trade ${result}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol: ${SYMBOL_NAME}\n\nðŸ“ Entry: ${openTrade.entry.toFixed(4)}\nðŸ Exit: ${currentPrice.toFixed(4)}\nðŸ›‘ SL: ${openTrade.sl.toFixed(4)} ($${slDollars} hard)\nðŸŽ¯ TP1: ${openTrade.tp1.toFixed(4)} (BGA) ${tp1Status}\n\nðŸ’µ P&L: ${pnlStr} (Net of comm.)\nReason: ${exitReason}\nDuration: ${formatDuration(durationMs)}\n\nOpened: ${openTrade.openTime}\nClosed: ${openTrade.closeTime}\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
    };

    // M15 SMA Opposite Cross Exit: Close immediately if M15 Fast/Slow SMA crosses against position
    const m15CandlesExit = tradeData.m15;
    if (m15CandlesExit && m15CandlesExit.length >= 52) {
      const m15Closes = m15CandlesExit.map(c => parseFloat(c.close));
      const m15ci = m15CandlesExit.length - 2;
      const smaFast15m = sma(m15Closes, 2);
      const smaSlow15m = sma(m15Closes, 50);

      if (smaFast15m[m15ci] != null && smaSlow15m[m15ci] != null && smaFast15m[m15ci-1] != null && smaSlow15m[m15ci-1] != null) {
        const m15CrossedUp = (smaFast15m[m15ci-1] <= smaSlow15m[m15ci-1]) && (smaFast15m[m15ci] > smaSlow15m[m15ci]);
        const m15CrossedDown = (smaFast15m[m15ci-1] >= smaSlow15m[m15ci-1]) && (smaFast15m[m15ci] < smaSlow15m[m15ci]);

        if (openTrade.direction === "BUY" && m15CrossedDown) {
          await closeWith("LOSS", `M15 SMA Trend Reversal Exit â€” M15 Fast SMA crossed below Slow SMA`);
          return;
        }
        if (openTrade.direction === "SELL" && m15CrossedUp) {
          await closeWith("LOSS", `M15 SMA Trend Reversal Exit â€” M15 Fast SMA crossed above Slow SMA`);
          return;
        }
      }
    }

    // EARLY FAKEOUT DEFENSE: If price immediately fails before breakeven/TP1
    if (!openTrade.tp1Reached && !openTrade.breakevenSet) {
      const m5CandlesExit = tradeData.candles;
      if (m5CandlesExit && m5CandlesExit.length >= 36) {
        const closesExit = m5CandlesExit.map(c => parseFloat(c.close));
        const cciExit = calculateCCI(m5CandlesExit, 34);
        const rsiExit = calculateRSI(closesExit, 14);
        const tdiExit = calculateBollingerBands(rsiExit, 34, 1.619);
        const ie = cciExit.length - 2;
        const iePrev = cciExit.length - 3;
        if (ie >= 0 && iePrev >= 0) {
          const c1Close = closesExit[ie];
          const c2Close = closesExit[iePrev];
          let twoCandlesAgainst = false;
          if (openTrade.direction === "BUY") {
            twoCandlesAgainst = (c1Close < openTrade.entry && c2Close < openTrade.entry);
          } else {
            twoCandlesAgainst = (c1Close > openTrade.entry && c2Close > openTrade.entry);
          }
          const rsiCurr = rsiExit[ie], rsiPrev = rsiExit[iePrev];
          const upperCurr = tdiExit.upper[ie], lowerCurr = tdiExit.lower[ie];
          let tdiReversedInside = false;
          if (openTrade.direction === "BUY") {
            tdiReversedInside = (rsiPrev >= upperCurr || rsiPrev >= 70) && (rsiCurr < upperCurr);
          } else {
            tdiReversedInside = (rsiPrev <= lowerCurr || rsiPrev <= 30) && (rsiCurr > lowerCurr);
          }
          let cciFakeoutCross = false;
          if (openTrade.direction === "BUY") {
            cciFakeoutCross = (cciExit[iePrev] <= -114.4 && cciExit[ie] > -114.4) || (cciExit[iePrev] >= 90 && cciExit[ie] < 90);
          } else {
            cciFakeoutCross = (cciExit[iePrev] >= 90 && cciExit[ie] < 90) || (cciExit[iePrev] <= -114.4 && cciExit[ie] > -114.4);
          }
          if (twoCandlesAgainst && (tdiReversedInside || cciFakeoutCross)) {
            await closeWith("LOSS", `Early fakeout exit â€” 2 candles closed against entry with indicator reversal`);
            return;
          }
        }
      }
    }

    // BREAKEVEN PROTECTION: Arm once profit hits $2.00
    if (!openTrade.tp1Reached && !openTrade.breakevenSet && pnl >= BREAKEVEN_ACTIVATE_USD) {
      openTrade.breakevenSet = true;
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      await sendTelegram(`âš–ï¸ *${REPO_LABEL} â€” Breakeven Armed*\nProfit reached $${BREAKEVEN_ACTIVATE_USD.toFixed(2)}. Price floor locked at entry (${openTrade.entry.toFixed(4)}).`);
    }

    // COMMISSION-COVERED BREAKEVEN TRIGGER: Close early to lock in +$0.50 net profit
    const targetNetProfit = 0.50;
    const requiredRawPnl = targetNetProfit + COMMISSION_USD;
    const priceMoveFraction = requiredRawPnl / (STAKE_USD * MULTIPLIER);
    const breakevenPrice = openTrade.direction === "BUY"
      ? openTrade.entry * (1 + priceMoveFraction)
      : openTrade.entry * (1 - priceMoveFraction);

    const breakevenHit = openTrade.breakevenSet && !openTrade.tp1Reached && (
      (openTrade.direction === "BUY" && currentPrice <= breakevenPrice) ||
      (openTrade.direction === "SELL" && currentPrice >= breakevenPrice)
    );
    if (breakevenHit) {
      await closeWith("WIN", `Commission-Covered Breakeven exit â€” locked +$0.50 net profit at price ${breakevenPrice.toFixed(4)}`);
      return;
    }

    // 1. Hard SL Price Check
    const slBreached = openTrade.direction === "BUY" ? currentPrice <= openTrade.sl : currentPrice >= openTrade.sl;
    if (slBreached) {
      await closeWith("LOSS", `Hard SL hit â€” price ${currentPrice.toFixed(4)} breached SL ${openTrade.sl.toFixed(4)}`);
      return;
    }

    // 2. TP2 Ultimate Target Hit
    const tp2Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp2 : currentPrice <= openTrade.tp2;
    if (tp2Hit) {
      await closeWith("WIN", `TP2 Ultimate Target hit â€” price ${currentPrice.toFixed(4)} reached BGA level ${openTrade.tp2.toFixed(4)}`);
      return;
    }

    // 3. TP1 Price Level Hit (First BGA Whole Number) -> Arms 40% Peak-Drop Trailing
    if (!openTrade.tp1Reached) {
      const tp1Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp1 : currentPrice <= openTrade.tp1;
      if (tp1Hit) {
        openTrade.tp1Reached = true;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        await sendTelegram(`ðŸŽ¯ TP1 BGA Whole Number reached (${openTrade.tp1.toFixed(4)}) on ${openTrade.direction} â€” 40% peak-drop trailing now armed.`);
      }
    }

    // 4. High-Water Mark Trailing (Activated at TP1 BGA Whole Number, exits if profit drops 40% from peak)
    if (openTrade.tp1Reached) {
      if (openTrade.peakProfit === null || pnl > openTrade.peakProfit) {
        openTrade.peakProfit = pnl;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      }
      const dropThreshold = openTrade.peakProfit * 0.40;
      if (openTrade.peakProfit > 0 && pnl <= openTrade.peakProfit - dropThreshold) {
        const result = pnl >= 0 ? "WIN" : "LOSS";
        await closeWith(result, `Profit trail exit â€” locked ~$${pnl.toFixed(2)} (peak $${openTrade.peakProfit.toFixed(2)}, 40% drop from peak)`);
        return;
      }
    }

    // 5. Stateful Momentum Trailing Exit: Arms when CCI or TDI MBL crosses against position, waits for confirmation, cancels on trend resumption.
    const m5CandlesExit = tradeData.candles;
    if (m5CandlesExit && m5CandlesExit.length >= 38) {
      const closesExit = m5CandlesExit.map(c => parseFloat(c.close));
      const cciExit = calculateCCI(m5CandlesExit, 34);
      const rsiExit = calculateRSI(closesExit, 14);
      const tdiExit = calculateBollingerBands(rsiExit, 34, 1.619);
      const ie = cciExit.length - 2;

      if (ie >= 1 && cciExit[ie] != null && cciExit[ie-1] != null && rsiExit[ie] != null && rsiExit[ie-1] != null && tdiExit.middle[ie] != null && tdiExit.middle[ie-1] != null) {
        if (openTrade.exitTrigger === undefined) {
          openTrade.exitTrigger = null;
        }

        const cciCrossZeroDown = cciExit[ie-1] >= 0 && cciExit[ie] < 0;
        const cciCrossZeroUp = cciExit[ie-1] <= 0 && cciExit[ie] > 0;
        const mblPrev = tdiExit.middle[ie-1], mblCurr = tdiExit.middle[ie];
        const rsiPrev = rsiExit[ie-1], rsiCurr = rsiExit[ie];
        const tdiCrossDown = (rsiPrev >= mblPrev) && (rsiCurr < mblCurr);
        const tdiCrossUp = (rsiPrev <= mblPrev) && (rsiCurr > mblCurr);

        if (openTrade.direction === "BUY") {
          const trendResumptionUp = (cciExit[ie-1] <= 0 && cciExit[ie] > 0) || ((rsiPrev <= mblPrev) && (rsiCurr > mblCurr));
          if (openTrade.exitTrigger !== null && trendResumptionUp) {
            console.log("Pending exit for BUY trade invalidated by trend resumption upward.");
            openTrade.exitTrigger = null;
            fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          }

          if (openTrade.exitTrigger === "CCI" && tdiCrossDown) {
            const result = pnl >= 0 ? "WIN" : "LOSS";
            await closeWith(result, `Stateful Momentum Exit â€” CCI zero cross armed, validated by TDI MBL cross down`);
            return;
          } else if (openTrade.exitTrigger === "TDI" && cciCrossZeroDown) {
            const result = pnl >= 0 ? "WIN" : "LOSS";
            await closeWith(result, `Stateful Momentum Exit â€” TDI MBL cross armed, validated by CCI zero cross down`);
            return;
          } else if (openTrade.exitTrigger === null) {
            if (cciCrossZeroDown) {
              openTrade.exitTrigger = "CCI";
              fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
              console.log("CCI crossed zero downward. Armed pending exit, waiting for TDI MBL cross.");
            } else if (tdiCrossDown) {
              openTrade.exitTrigger = "TDI";
              fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
              console.log("TDI MBL crossed downward. Armed pending exit, waiting for CCI zero cross.");
            }
          }
        } else if (openTrade.direction === "SELL") {
          const trendResumptionDown = (cciExit[ie-1] >= 0 && cciExit[ie] < 0) || ((rsiPrev >= mblPrev) && (rsiCurr < mblCurr));
          if (openTrade.exitTrigger !== null && trendResumptionDown) {
            console.log("Pending exit for SELL trade invalidated by trend resumption downward.");
            openTrade.exitTrigger = null;
            fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          }

          if (openTrade.exitTrigger === "CCI" && tdiCrossUp) {
            const result = pnl >= 0 ? "WIN" : "LOSS";
            await closeWith(result, `Stateful Momentum Exit â€” CCI zero cross armed, validated by TDI MBL cross up`);
            return;
          } else if (openTrade.exitTrigger === "TDI" && cciCrossZeroUp) {
            const result = pnl >= 0 ? "WIN" : "LOSS";
            await closeWith(result, `Stateful Momentum Exit â€” TDI MBL cross armed, validated by CCI zero cross up`);
            return;
          } else if (openTrade.exitTrigger === null) {
            if (cciCrossZeroUp) {
              openTrade.exitTrigger = "CCI";
              fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
              console.log("CCI crossed zero upward. Armed pending exit, waiting for TDI MBL cross.");
            } else if (tdiCrossUp) {
              openTrade.exitTrigger = "TDI";
              fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
              console.log("TDI MBL crossed upward. Armed pending exit, waiting for CCI zero cross.");
            }
          }
        }
      }
    }

    console.log("Open trade being managed â€” skipping scan.");
    return;
  }

  // â”€â”€ Signal Scan (Consolidated Data Fetching - ONE Single WebSocket Handshake) â”€â”€
  const scanData = await fetchAllData();
  const candles = scanData.m5;
  const h1Candles = scanData.h1;
  const m15Candles = scanData.m15;
  const d1Candles = scanData.d1;

  if (!candles || candles.length < 60) { console.log("Not enough M5 candles."); return; }

  const i = candles.length - 2; // Closed M5 candle to prevent repainting (-2)
  const currentCandleEpoch = candles[i].epoch;
  const closes = candles.map(c => parseFloat(c.close));

  if (state.lastProcessedEpoch === currentCandleEpoch) {
    console.log("Already processed this candle â€” skipping.");
    return;
  }

  const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
  const atr14 = calculateATR(candles, ATR_PERIOD);
  const cci = calculateCCI(candles, 34);
  const rsi = calculateRSI(closes, 14);
  const tdi = calculateBollingerBands(rsi, 34, 1.619);

  if (rsi[i] != null && tdi.lower[i] != null && tdi.upper[i] != null) {
    if (rsi[i] <= tdi.lower[i]) state.rsiLowerBreakSeen = true;
    if (rsi[i] >= tdi.upper[i]) state.rsiUpperBreakSeen = true;
  }

  // Evaluate H1 Trend Direction & Fresh Cross (DUAL-SPEED: Phase A uses length -2, Continuations use length -1)
  let h1FreshCross = false;
  if (h1Candles && h1Candles.length >= 52) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close)), h1ci = h1Candles.length - 2; // <--- CLOSED CANDLE FOR FRESH CROSS (-2)
    const smaFast1h = sma(h1Closes, 2), smaSlow1h = sma(h1Closes, 50);
    if (smaFast1h[h1ci] != null && smaSlow1h[h1ci] != null && smaFast1h[h1ci-1] != null && smaSlow1h[h1ci-1] != null) {
      const crossedUp = (smaFast1h[h1ci-1] <= smaSlow1h[h1ci-1]) && (smaFast1h[h1ci] > smaSlow1h[h1ci]);
      const crossedDown = (smaFast1h[h1ci-1] >= smaSlow1h[h1ci-1]) && (smaFast1h[h1ci] < smaSlow1h[h1ci]);
      if (crossedUp || crossedDown) h1FreshCross = true;
    }
  }

  let h1Dir = null, h1Epoch = null;
  if (h1Candles && h1Candles.length >= 52) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close)), h1ci = h1Candles.length - 1; // <--- REAL-TIME FOR CONTINUATIONS (-1)
    const smaFast1h = sma(h1Closes, 2), smaSlow1h = sma(h1Closes, 50);
    if (smaFast1h[h1ci] != null && smaSlow1h[h1ci] != null) {
      if (smaFast1h[h1ci] > smaSlow1h[h1ci]) h1Dir = "BUY";
      else if (smaFast1h[h1ci] < smaSlow1h[h1ci]) h1Dir = "SELL";
    }
    h1Epoch = h1Candles[h1Candles.length - 1].epoch;
  }

  // Evaluate M15 Trend Direction (Real-time M15 candle: length - 1)
  let m15Dir = null;
  if (m15Candles && m15Candles.length >= 60) {
    const m15Closes = m15Candles.map(c => parseFloat(c.close));
    const m15Macd = calculateMACD(m15Closes, 3, 50, 1);
    const m15si = m15Macd.signalLine.length - 1;
    if (m15Macd.signalLine[m15si] != null) {
      if (m15Macd.signalLine[m15si] > 0) m15Dir = "BUY";
      else if (m15Macd.signalLine[m15si] < 0) m15Dir = "SELL";
    }
  }

  // â”€â”€ HARD HIGHER-TIMEFRAME TREND GATE & M15 TDI FILTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let m15TdiFilterPassed = true;
  if (m15Candles && m15Candles.length >= 60) {
    const m15Closes = m15Candles.map(c => parseFloat(c.close));
    const m15Rsi = calculateRSI(m15Closes, 14);
    const m15Tdi = calculateBollingerBands(m15Rsi, 34, 1.619);
    const m15i = m15Candles.length - 1;
    
    if (m15Rsi[m15i] != null && m15Tdi.middle[m15i] != null) {
      if (h1Dir === "BUY" && m15Dir === "BUY" && m15Rsi[m15i] < m15Tdi.middle[m15i]) {
        m15TdiFilterPassed = false;
        dbg("M15 TDI filter blocked BUY: M15 RSI is below MBL despite H1/M15 buy alignment.");
      }
      if (h1Dir === "SELL" && m15Dir === "SELL" && m15Rsi[m15i] > m15Tdi.middle[m15i]) {
        m15TdiFilterPassed = false;
        dbg("M15 TDI filter blocked SELL: M15 RSI is above MBL despite H1/M15 sell alignment.");
      }
    }
  }

  const h1m15Aligned = h1Dir && m15Dir && (h1Dir === m15Dir) && m15TdiFilterPassed;
  let justRealigned = false;
  if (state.h1m15WasAligned === undefined || state.h1m15WasAligned === null) {
    state.h1m15WasAligned = h1m15Aligned;
  } else {
    justRealigned = !state.h1m15WasAligned && h1m15Aligned;
    state.h1m15WasAligned = h1m15Aligned;
  }

  if (!h1m15Aligned) {
    dbg("H1 and M15 trend alignment or M15 TDI filter missing. Resetting all setups.");
    state.waitingFor = null;
    state.setupEpoch = null;
    state.activeEntryType = null;
    state.pendingPullback = null;
    state.pullbackEpoch = null;
    state.pullbackTrigger = null;
    state.lastProcessedEpoch = currentCandleEpoch;
    fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
    return;
  }

  if (state.h1TrendEpoch !== h1Epoch) {
    state.h1TrendEpoch = h1Epoch;
  }

  let m5Ready = false;
  let entryType = null;

  // â”€â”€ PHASE A: STRICTLY A CLOSED FRESH H1 CROSS (First Trade) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (h1FreshCross && state.phaseATriggeredEpoch !== h1Epoch) {
    const mblVal = tdi.middle[i];
    const m5Aligned = (mblVal != null && rsi[i] != null) && ((h1Dir === "BUY" && rsi[i] > mblVal) || (h1Dir === "SELL" && rsi[i] < mblVal));
    if (m5Aligned) {
      if (h1Dir === "BUY" && cci[i] > -114.4) {
        m5Ready = true;
        entryType = 'PHASE_A';
      } else if (h1Dir === "SELL" && cci[i] < 90) {
        m5Ready = true;
        entryType = 'PHASE_A';
      }
    }
  }

  // â”€â”€ PHASE C: HIGHER-TIMEFRAME REALIGNMENT ENTRY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!m5Ready && justRealigned && state.phaseCTriggeredEpoch !== currentCandleEpoch) {
    const mblVal = tdi.middle[i];
    const m5Aligned = (mblVal != null && rsi[i] != null) && ((h1Dir === "BUY" && rsi[i] > mblVal) || (h1Dir === "SELL" && rsi[i] < mblVal));
    if (m5Aligned) {
      if (h1Dir === "BUY" && cci[i] > -114.4) {
        m5Ready = true;
        entryType = 'PHASE_C';
      } else if (h1Dir === "SELL" && cci[i] < 90) {
        m5Ready = true;
        entryType = 'PHASE_C';
      }
    }
  }

  // â”€â”€ PHASE D: SHALLOW PULLBACK (TDI Outer Band + MBL Cross + CCI Zero Cross) â”€â”€
  if (!m5Ready && h1Dir && m15Dir && (h1Dir === m15Dir) && state.phaseDTriggeredEpoch !== currentCandleEpoch) {
    const mblPrev = tdi.middle[i-1], mblCurr = tdi.middle[i];
    const rsiPrev = rsi[i-1], rsiCurr = rsi[i];
    const rawTdiCrossUp = (rsiPrev <= mblPrev) && (rsiCurr > mblCurr);
    const rawTdiCrossDown = (rsiPrev >= mblPrev) && (rsiCurr < mblCurr);
    const tdiCrossUp = rawTdiCrossUp && state.rsiLowerBreakSeen;
    const tdiCrossDown = rawTdiCrossDown && state.rsiUpperBreakSeen;
    if (tdiCrossUp) state.rsiLowerBreakSeen = false;
    if (tdiCrossDown) state.rsiUpperBreakSeen = false;
    const cciZeroCrossUp = (cci[i-1] <= 0) && (cci[i] > 0);
    const cciZeroCrossDown = (cci[i-1] >= 0) && (cci[i] < 0);
    if (h1Dir === "BUY" && tdiCrossUp && cciZeroCrossUp) {
      m5Ready = true;
      entryType = 'PHASE_D';
    } else if (h1Dir === "SELL" && tdiCrossDown && cciZeroCrossDown) {
      m5Ready = true;
      entryType = 'PHASE_D';
    }
  }

  // â”€â”€ PHASE B: STATEFUL CROSS-CONFIRMATION ENGINE (Pullbacks / Re-entries) â”€â”€
  if (!m5Ready && h1Dir && m15Dir && h1Dir === m15Dir) {
    if (state.pendingPullback && state.pullbackEpoch && (currentCandleEpoch - state.pullbackEpoch) > (SETUP_EXPIRY_BARS * M5)) {
      state.pendingPullback = null;
      state.pullbackEpoch = null;
      state.pullbackTrigger = null;
      state.rsiLowerBreakSeen = false;
      state.rsiUpperBreakSeen = false;
      console.log("Pending pullback setup expired (35 bars reached).");
    }
    const cciCrossBuy = (cci[i-1] <= -114.4) && (cci[i] > -114.4);
    const cciCrossSell = (cci[i-1] >= 90) && (cci[i] < 90);
    const mblPrev = tdi.middle[i-1], mblCurr = tdi.middle[i];
    const rsiPrev = rsi[i-1], rsiCurr = rsi[i];
    const rawTdiCrossUp = (rsiPrev <= mblPrev) && (rsiCurr > mblCurr);
    const rawTdiCrossDown = (rsiPrev >= mblPrev) && (rsiCurr < mblCurr);
    const tdiCrossUp = rawTdiCrossUp && state.rsiLowerBreakSeen;
    const tdiCrossDown = rawTdiCrossDown && state.rsiUpperBreakSeen;
    if (tdiCrossUp) state.rsiLowerBreakSeen = false;
    if (tdiCrossDown) state.rsiUpperBreakSeen = false;

    if (state.pendingPullback === "BUY") {
      const oppositeTdiCross = (rsiPrev >= mblPrev) && (rsiCurr < mblCurr);
      const oppositeCciCross = (cci[i-1] > -114.4) && (cci[i] <= -114.4);
      if (oppositeTdiCross || oppositeCciCross || h1Dir !== "BUY") {
        console.log("Pending BUY pullback invalidated by opposite cross or trend shift.");
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      }
    } else if (state.pendingPullback === "SELL") {
      const oppositeTdiCross = (rsiPrev <= mblPrev) && (rsiCurr > mblCurr);
      const oppositeCciCross = (cci[i-1] < 90) && (cci[i] >= 90);
      if (oppositeTdiCross || oppositeCciCross || h1Dir !== "SELL") {
        console.log("Pending SELL pullback invalidated by opposite cross or trend shift.");
        state.pendingPullback = null;
        state.pullbackEpoch = null;
        state.pullbackTrigger = null;
      }
    }

    if (state.pendingPullback === "BUY") {
      if (state.pullbackTrigger === "CCI" && tdiCrossUp) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null; state.pullbackEpoch = null; state.pullbackTrigger = null;
      } else if (state.pullbackTrigger === "TDI" && cciCrossBuy) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null; state.pullbackEpoch = null; state.pullbackTrigger = null;
      }
    } else if (state.pendingPullback === "SELL") {
      if (state.pullbackTrigger === "CCI" && tdiCrossDown) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null; state.pullbackEpoch = null; state.pullbackTrigger = null;
      } else if (state.pullbackTrigger === "TDI" && cciCrossSell) {
        m5Ready = true;
        entryType = 'PHASE_B';
        state.pendingPullback = null; state.pullbackEpoch = null; state.pullbackTrigger = null;
      }
    } else {
      if (h1Dir === "BUY") {
        if (cciCrossBuy) {
          state.pendingPullback = "BUY"; state.pullbackTrigger = "CCI"; state.pullbackEpoch = currentCandleEpoch;
          console.log("CCI crossed -114.4 upward first. Waiting for TDI MBL cross.");
        } else if (tdiCrossUp) {
          state.pendingPullback = "BUY"; state.pullbackTrigger = "TDI"; state.pullbackEpoch = currentCandleEpoch;
          console.log("TDI MBL crossed upward first. Waiting for CCI cross.");
        }
      } else if (h1Dir === "SELL") {
        if (cciCrossSell) {
          state.pendingPullback = "SELL"; state.pullbackTrigger = "CCI"; state.pullbackEpoch = currentCandleEpoch;
          console.log("CCI crossed 90 downward first. Waiting for TDI MBL cross.");
        } else if (tdiCrossDown) {
          state.pendingPullback = "SELL"; state.pullbackTrigger = "TDI"; state.pullbackEpoch = currentCandleEpoch;
          console.log("TDI MBL crossed downward first. Waiting for CCI cross.");
        }
      }
    }
  }

  if (m5Ready) {
    if (state.waitingFor !== h1Dir || state.activeEntryType !== entryType) {
      state.waitingFor = h1Dir;
      state.activeEntryType = entryType;
      state.setupEpoch = currentCandleEpoch;
      console.log(`Setup armed for ${h1Dir} via ${entryType}`);
    }
  } else {
    if (!h1Dir && !m15m5Aligned && !state.pendingPullback) {
      state.waitingFor = null;
      state.setupEpoch = null;
      state.activeEntryType = null;
    }
  }

  const h4Candle = scanData.h4[scanData.h4.length - 2];
  if (!h4Candle) { state.lastProcessedEpoch = currentCandleEpoch; fs.writeFileSync("state.json", JSON.stringify(state, null, 2)); return; }
  const h4Bullish = parseFloat(h4Candle.close) > parseFloat(h4Candle.open);
  const h4Bearish = parseFloat(h4Candle.close) < parseFloat(h4Candle.open);
  const prevD1 = d1Candles[d1Candles.length - 2];
  const d1Ctx = {
    direction: parseFloat(prevD1.close) > parseFloat(prevD1.open) ? "ðŸŸ¢ BULLISH" : "ðŸ”´ BEARISH",
    open: parseFloat(prevD1.open),
    close: parseFloat(prevD1.close),
    change: parseFloat(prevD1.close) - parseFloat(prevD1.open),
    changePct: ((parseFloat(prevD1.close) - parseFloat(prevD1.open)) / parseFloat(prevD1.open)) * 100
  };

  const bypassH4ForPhaseAOrCOrD = (state.activeEntryType === 'PHASE_A' || state.activeEntryType === 'PHASE_C' || state.activeEntryType === 'PHASE_D');
  const buySignal = state.waitingFor === "BUY" && (bypassH4ForPhaseAOrCOrD || h4Bullish);
  const sellSignal = state.waitingFor === "SELL" && (bypassH4ForPhaseAOrCOrD || h4Bearish);

  let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;
  if (buySignal) {
    signalTriggered = true; direction = "BUY"; entry = closes[i];
  } else if (sellSignal) {
    signalTriggered = true; direction = "SELL"; entry = closes[i];
  }

  if (signalTriggered) {
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const bgaTps = await calculateBgaTakeProfits(entry, direction, atr14, d1Candles);
    tp1 = bgaTps.tp1;
    tp2 = bgaTps.tp2;
    tp3 = bgaTps.tp3;

    if (direction === "BUY") {
      sl = entry - (atr14 * ATR_MULTIPLIER);
      risk = entry - sl;
    } else {
      sl = entry + (atr14 * ATR_MULTIPLIER);
      risk = sl - entry;
    }

    const alignment = d1Ctx ? checkAlignment(direction, d1Ctx.direction) : "âš ï¸ D1 data unavailable";
    const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
    const h4Dir = h4Bullish ? "ðŸŸ¢ BULLISH" : "ðŸ”´ BEARISH";
    const bgaTag = getBGAInfo(entry);

    let message = `ðŸš¨ *${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL* ðŸš¨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\nðŸ“ Entry: ${entry.toFixed(4)}\nðŸ›‘ SL: ${sl.toFixed(4)} ($${slDollars} hard)\nðŸŽ¯ TP1: ${tp1.toFixed(4)} (BGA Whole) â†’ trail with CCI zero-cross\nðŸŽ¯ TP2 (Ultimate TP): ${tp2.toFixed(4)} (BGA)\nðŸŽ¯ TP3: ${tp3.toFixed(4)} (reference)\n\nðŸ’° Stake: $${STAKE_USD} | Hard SL: $${slDollars} | TP1: ${tp1.toFixed(4)} | TP2: ${tp2.toFixed(4)}\nðŸ“Š Risk: ${risk.toFixed(2)} points\nï¸ H4: ${h4Dir} âœ… Direction confirmed\nâš¡ Setup: Strict Signal + Stateful TDI Engine (${state.activeEntryType})\nï¸ Confluence: ${bgaTag}\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\nðŸŒ *D1 CANDLE STATUS*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n`;
    if (d1Ctx) message += `Direction: ${d1Ctx.direction}\nD1 Open: ${d1Ctx.open.toFixed(4)}\nD1 Current: ${d1Ctx.close.toFixed(4)}\nMovement: ${d1Ctx.change.toFixed(4)} pts (${d1Ctx.changePct.toFixed(2)}%)\nAlignment: ${alignment}\n\n`;
    else message += `âš ï¸ D1 data unavailable\n\n`;
    message += `â° Time (UTC): ${timeFormatted}\n\nðŸ’¡ To close manually: send \`/close win\` or \`/close loss\` in this chat`;

    try {
      const contractId = await executeTrade(direction);
      if (!contractId) {
        console.error("âš ï¸ Trade execution returned no contract ID. Skipping trade record.");
        await sendTelegram(`âŒ *${REPO_LABEL}*s\n\nSignal triggered for ${direction}, but live broker execution failed. Trade aborted.`);
        return;
      }
      await sendTelegram(message);
      trades.push({
        id: `${SYMBOL}-${isoTime}`, contractId, repo: REPO_LABEL, symbol: SYMBOL,
        direction, entry, sl, tp1, tp2, tp3, h1OpenAtEntry: null, tp1Reached: false,
        peakProfit: null, rr: RISK_REWARD, entryType: state.activeEntryType, openTime: timeFormatted, closeTime: null, result: null
      });
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
    } catch (execErr) {
      console.error("âš ï¸ Live execution warning:", execErr.message);
      await sendTelegram(`âŒ *${REPO_LABEL}* â€” Live execution warning: ${execErr.message}`);
      return;
    }

    if (state.activeEntryType === 'PHASE_A') {
      state.phaseATriggeredEpoch = h1Epoch;
    }
    if (state.activeEntryType === 'PHASE_C') {
      state.phaseCTriggeredEpoch = currentCandleEpoch;
    }
    if (state.activeEntryType === 'PHASE_D') {
      state.phaseDTriggeredEpoch = currentCandleEpoch;
    }
    state.waitingFor = null;
    state.setupEpoch = null;
    state.activeEntryType = null;
    state.pendingPullback = null;
    state.pullbackEpoch = null;
    state.pullbackTrigger = null;
    state.rsiLowerBreakSeen = false;
    state.rsiUpperBreakSeen = false;
  }

  state.lastProcessedEpoch = currentCandleEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  console.log(`[${REPO_LABEL}] Scan complete.`);
}

// ==================== EXECUTION MODES ====================
(async () => {
  // DETERMINISTIC REPO STAGGERING: Assigns each repo a fixed time window to prevent HTTP 429 bursts
  const REPO_INDEX = { R_10: 0, R_50: 1, R_75: 2, "1HZ75V": 3, R_100: 4, R_25: 5, "1HZ100V": 6 }[SYMBOL] ?? 0;
  const jitterMs = (REPO_INDEX * 4000) + Math.floor(Math.random() * 2000);
  
  dbg(`Staggering execution by ${jitterMs}ms (Repo Index: ${REPO_INDEX})...`);
  await new Promise(r => setTimeout(r, jitterMs));

  if (MODE === "daily") { await runSummary("Daily"); return; }
  if (MODE === "weekly") { await runSummary("Weekly"); return; }
  if (MODE === "monthly") { await runSummary("Monthly"); return; }
  if (MODE === "close_win") { await executeManualClose("WIN", "manual command"); return; }
  if (MODE === "close_loss") { await executeManualClose("LOSS", "manual command"); return; }
  if (MODE === "test") {
    await sendTelegram(`ðŸ§ª Test mode active â€” ${REPO_LABEL}\nFiring a direct BUY trade via proxy...\nCheck your Deriv account for a MULTUP contract.`);
    try {
      const cid = await executeTrade("BUY");
      await sendTelegram(`âœ… Test trade placed. Contract ID: ${cid}`);
    } catch (e) {
      await sendTelegram(`âŒ Test trade failed: ${e.message}`);
    }
    return;
  }
  if (TRIGGER_SOURCE !== "cronjob") { console.log("Not a cronjob trigger â€” exiting."); return; }
  await runScanMode();
})();
