import WebSocket from "ws";
import fetch from "node-fetch";
import fs from "fs";

// ==================== REPOSITORY CONFIGURATION (TEST BOT V10 LIVE) ====================
const SYMBOL               = "R_10";
const TRADING_SYMBOL       = "R_10";
const SYMBOL_NAME          = "Volatility 10 Index";
const REPO_LABEL           = "Test Bot (V10 Live)";
const MULTIPLIER           = 400;
const STAKE_USD            = 10;
const RISK_REWARD          = 1.5;
const SAFETY_TP_USD        = 15;   // Hard dollar ceiling — close immediately
const TRAIL_ACTIVATE_USD   = 5;    // Start high-water-mark trailing at this profit
const TRAIL_DROP_USD       = 3;    // Exit if profit drops this much from peak
const BREAKEVEN_ACTIVATE_USD = 3.00; // Move SL to entry once profit hits this amount
const COMMISSION_USD       = 0.16; // $0.16 for Live trades | $0.15 for Demo trades
const ATR_PERIOD           = 14;
const ATR_MULTIPLIER       = 2.0;  // Stop loss breathing room
const FRACTAL_LOOKBACK     = 6;
const SETUP_EXPIRY_BARS    = 35;
const MARKET_DATA_APP_ID   = "1089";
const DERIV_APP_ID         = process.env.DERIV_APP_ID;
const TG_TOKEN             = process.env.TG_BOT_TOKEN || process.env.TG_TOKEN;
const TG_CHAT_ID           = process.env.TG_CHAT_ID;
const DERIV_TOKEN          = process.env.DERIV_API_TOKEN;
const PROXY_URL            = process.env.PROXY_URL;
const PROXY_SECRET         = process.env.PROXY_SECRET;
const MODE                 = process.env.MODE           || "cronjob";
const TRIGGER_SOURCE       = process.env.TRIGGER_SOURCE || "manual";

const M5  = 5  * 60;
const M15 = 15 * 60;
const H1  = 60 * 60;
const H4  = 4  * 60 * 60;
const D1  = 24 * 60 * 60;

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
  let msg = `📊 *${label} Summary — ${REPO_LABEL}*\n\nTotal closed: ${closed.length}\n✅ Wins: ${wins} | ❌ Losses: ${losses}\nWin rate: ${closed.length ? ((wins/closed.length)*100).toFixed(1) : 0}%\nOpen positions: ${openTrades.length}`;
  if (openTrades.length) msg += "\n\n*Open trades:*\n" + openTrades.map(t => `• ${t.direction} @ ${t.entry} (${t.openTime})`).join("\n");
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
        await sendTelegram(open.length ? `📍 Open trades:\n${open.map(t=>`• ${t.direction} @ ${t.entry}`).join("\n")}` : "No open trades.");
      }
      if (text === "/close win" || text === "/closewin")  { await executeManualClose("WIN",  "telegram command"); }
      if (text === "/close loss" || text === "/closeloss") { await executeManualClose("LOSS", "telegram command"); }
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
    
    const rawPnl = trade.direction === "BUY" ? (currentPrice - trade.entry) / trade.entry * STAKE_USD * MULTIPLIER : (trade.entry - currentPrice) / trade.entry * STAKE_USD * MULTIPLIER;
    const pnl = rawPnl - COMMISSION_USD;
    
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const tp1Status = trade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
    
    await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${trade.direction} (${contractType})\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${trade.entry.toFixed(4)}\n🏁 Exit:   ${currentPrice.toFixed(4)}\n🛑 SL:     ${trade.sl.toFixed(4)}  ($${slDollars} hard)\n🎯 TP1:    ${trade.tp1.toFixed(4)}  ($${tpDollars} soft)  ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${reason}\nDuration: ${formatDuration(durationMs)}\n\nOpened:  ${trade.openTime}\nClosed:  ${trade.closeTime}\n` + (trade.contractId ? `Contract: \`${trade.contractId}\`` : ""));
  }
}

let state = { waitingFor: null, setupEpoch: null, lastProcessedEpoch: null, lastTgUpdateId: 0, h1TrendDir: null, firstTradeTaken: false };
try { 
  const s = JSON.parse(fs.readFileSync("state.json")); 
  state = { 
    ...state, 
    ...s, 
    waitingFor: s.waitingFor ?? null, 
    setupEpoch: s.setupEpoch ?? null,
    h1TrendDir: s.h1TrendDir ?? null,
    firstTradeTaken: s.firstTradeTaken ?? false
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
  
  // LIVE ACCOUNT SELECTOR
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
  console.log(`   Sending ${direction} trade via Cloudflare proxy...`);
  
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
  
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
        take_profit: SAFETY_TP_USD 
      } 
    } 
  };
  
  const response = await fetch(PROXY_URL, { 
    method: "POST", 
    headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET }, 
    body: JSON.stringify({ wsUrl, action: "buy", params }) 
  });
  
  const data = await response.json();
  console.log("   Proxy response:", JSON.stringify(data));
  if (data.error) throw new Error(data.error);
  const contractId = data.buy?.contract_id;
  if (contractId) { console.log(`✅ Trade Executed! Contract ID: ${contractId}`); return contractId; }
  return null;
}

async function closeContract(contractId) {
  if (!DERIV_TOKEN || !contractId || !PROXY_URL || !PROXY_SECRET || !DERIV_APP_ID) return;
  console.log(`   Closing contract ${contractId} via proxy...`);
  const accountId = await getDerivAccountId();
  const wsUrl = await getDerivOTP(accountId);
  const response = await fetch(PROXY_URL, { 
    method: "POST", 
    headers: { "Content-Type": "application/json", "x-proxy-secret": PROXY_SECRET }, 
    body: JSON.stringify({ wsUrl, action: "sell", params: { sell: contractId, price: 0 } }) 
  });
  const data = await response.json();
  console.log("   Close response:", JSON.stringify(data));
  return data;
}


// ==================== TECHNICAL ANALYSIS, PIVOTS & FIBONACCI ====================

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

function getDailyPivots(d1Candles) {
  if (!d1Candles || d1Candles.length < 2) return null;
  const prevDay = d1Candles[d1Candles.length - 2];
  const high = parseFloat(prevDay.high);
  const low = parseFloat(prevDay.low);
  const close = parseFloat(prevDay.close);
  const pivot = (high + low + close) / 3;
  const r1 = (2 * pivot) - low;
  const s1 = (2 * pivot) - high;
  const r2 = pivot + (high - low);
  const s2 = pivot - (high - low);
  return { pivot, r1, s1, r2, s2 };
}

function getFibLevels(candles, direction) {
  const lookbackCandles = candles.slice(-30);
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (const c of lookbackCandles) {
    const h = parseFloat(c.high);
    const l = parseFloat(c.low);
    if (h > swingHigh) swingHigh = h;
    if (l < swingLow) swingLow = l;
  }
  const diff = swingHigh - swingLow;
  if (diff <= 0) return null;
  if (direction === "BUY") {
    return {
      fib382: swingHigh - (diff * 0.382),
      fib500: swingHigh - (diff * 0.500),
      fib618: swingHigh - (diff * 0.618)
    };
  } else {
    return {
      fib382: swingLow + (diff * 0.382),
      fib500: swingLow + (diff * 0.500),
      fib618: swingLow + (diff * 0.618)
    };
  }
}

async function fetchH4Candle() {
  try {
    const candles = await fetchCandles(H4, 10);
    if (!candles || candles.length < 2) return null;
    return candles[candles.length - 2]; // Last fully closed H4 candle
  } catch (e) { console.error("fetchH4Candle error:", e.message); return null; }
}

async function getD1Context() {
  try {
    const candles = await fetchCandles(D1, 5);
    if (!candles || candles.length < 2) return null;
    const c = candles[candles.length - 2];
    const open = parseFloat(c.open), close = parseFloat(c.close);
    const change = close - open, changePct = (change / open) * 100;
    return { direction: close > open ? "🟢 BULLISH" : "🔴 BEARISH", open, close, change, changePct, candles };
  } catch (e) { console.error("getD1Context error:", e.message); return null; }
}

function checkAlignment(signalDir, d1Dir) {
  const bull = d1Dir.includes("BULLISH"), bear = d1Dir.includes("BEARISH");
  if (signalDir === "BUY" && bull) return "✅ D1 confirms BUY";
  if (signalDir === "SELL" && bear) return "✅ D1 confirms SELL";
  if (signalDir === "BUY" && bear) return "⚠️ Counter-trend BUY (D1 bearish)";
  if (signalDir === "SELL" && bull) return "⚠️ Counter-trend SELL (D1 bullish)";
  return "❓ Unknown";
}


// ==================== MAIN SCANNER & TRADE LOGIC ====================

async function runScanMode() {
  console.log(`[${REPO_LABEL}] Scan started — ${new Date().toISOString()}`);
  await checkTelegramCommands();

  let trades = [];
  try { trades = JSON.parse(fs.readFileSync("trades.json")); } catch {}

  // ── Open Position Management ──────────────────────────────────────────
  const openTrade = trades.find(t => !t.result);
  if (openTrade) {
    const currentPrice = await getCurrentPrice();
    const pnl = calcUnrealizedPnL(openTrade, currentPrice);
    dbg(`Open trade PnL: ${pnl.toFixed(4)}`);

    const closeWith = async (result, exitReason) => {
      openTrade.result = result;
      openTrade.closeTime = new Date().toISOString().replace("T"," ").substring(0,19);
      if (openTrade.contractId) { 
        try { await closeContract(openTrade.contractId); } catch (e) { console.error("Close error:", e.message); } 
      }
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      
      const icon = result === "WIN" ? "✅" : "❌";
      const contractType = openTrade.direction === "BUY" ? "MULTUP" : "MULTDOWN";
      const durationMs = new Date(openTrade.closeTime) - new Date(openTrade.openTime);
      const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
      const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
      const tp1Status = openTrade.tp1Reached ? "✅ TP1 hit" : "❌ TP1 not reached";
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
      
      await sendTelegram(`${icon} *${REPO_LABEL} — Trade ${result}*\n\nDirection: ${openTrade.direction} (${contractType})\nSymbol:    ${SYMBOL_NAME}\n\n📍 Entry:  ${openTrade.entry.toFixed(4)}\n🏁 Exit:   ${currentPrice.toFixed(4)}\n🛑 SL:     ${openTrade.sl.toFixed(4)}  ($${slDollars} hard)\n🎯 TP1:    ${openTrade.tp1.toFixed(4)}  ($${tpDollars} soft)  ${tp1Status}\n\n💵 P&L: ${pnlStr} (Net of comm.)\nReason: ${exitReason}\nDuration: ${formatDuration(durationMs)}\n\nOpened:  ${openTrade.openTime}\nClosed:  ${openTrade.closeTime}\n` + (openTrade.contractId ? `Contract: \`${openTrade.contractId}\`` : ""));
    };

    // BREAKEVEN PROTECTION: Arm once profit hits $3.00
    if (!openTrade.tp1Reached && !openTrade.breakevenSet && pnl >= BREAKEVEN_ACTIVATE_USD) {
      openTrade.breakevenSet = true;
      fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      await sendTelegram(`🛡️ *${REPO_LABEL} — Breakeven Armed*\nProfit reached $${BREAKEVEN_ACTIVATE_USD.toFixed(2)}. Price floor locked at entry (${openTrade.entry.toFixed(4)}).`);
    }

    // BREAKEVEN PRICE TRIGGER: Close immediately if price reverses to entry
    const breakevenHit = openTrade.breakevenSet && !openTrade.tp1Reached && (
      (openTrade.direction === "BUY" && currentPrice <= openTrade.entry) ||
      (openTrade.direction === "SELL" && currentPrice >= openTrade.entry)
    );

    if (breakevenHit) {
      await closeWith("WIN", `Breakeven exit — price reversed back to entry (${openTrade.entry.toFixed(4)}) after hitting profit target`);
      return;
    }

    // 1. Hard SL Price Check
    const slBreached = openTrade.direction === "BUY" ? currentPrice <= openTrade.sl : currentPrice >= openTrade.sl;
    if (slBreached) { 
      await closeWith("LOSS", `Hard SL hit — price ${currentPrice.toFixed(4)} breached SL ${openTrade.sl.toFixed(4)}`); 
      return; 
    }

    // 2. Safety TP (Hard dollar ceiling)
    if (pnl >= SAFETY_TP_USD) { 
      await closeWith("WIN", `Safety TP hit — $${SAFETY_TP_USD} ceiling reached`); 
      return; 
    }

    // 3. TP1 Price Level
    if (!openTrade.tp1Reached) {
      const tp1Hit = openTrade.direction === "BUY" ? currentPrice >= openTrade.tp1 : currentPrice <= openTrade.tp1;
      if (tp1Hit) {
        openTrade.tp1Reached = true;
        openTrade.macdEarlyFlipEpoch = null;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
        await sendTelegram(`🎯 TP1 price level reached on ${openTrade.direction} — switching to MACD(8,100) trail.`);
      }
    }

    // 4. High-Water Mark Trailing
    if (pnl >= TRAIL_ACTIVATE_USD) {
      if (openTrade.peakProfit === null || pnl > openTrade.peakProfit) {
        openTrade.peakProfit = pnl;
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
      }
      if (openTrade.peakProfit !== null && pnl < openTrade.peakProfit - TRAIL_DROP_USD) {
        const result = pnl >= 0 ? "WIN" : "LOSS";
        await closeWith(result, `Profit trail exit — locked ~$${pnl.toFixed(2)} (peak $${openTrade.peakProfit.toFixed(2)})`);
        return;
      }
    }

    // 6. Post-TP1 Exit: MACD(8,100) Trailing Exit
    if (openTrade.tp1Reached) {
      const m5c = await fetchCandles(M5, 120);
      if (m5c && m5c.length >= 100) {
        const cls = m5c.map(c => parseFloat(c.close)), ci = m5c.length - 2;
        const macdFast = ema(cls, 8), macdSlow = ema(cls, 100);
        const macdVal = (macdFast[ci] != null && macdSlow[ci] != null) ? macdFast[ci] - macdSlow[ci] : null;
        if (macdVal !== null) {
          const flip = openTrade.direction === "BUY" ? macdVal < 0 : macdVal > 0;
          if (flip) {
            if (!openTrade.macdEarlyFlipEpoch) {
              openTrade.macdEarlyFlipEpoch = m5c[ci].epoch;
              fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
            } else if (m5c[ci].epoch > openTrade.macdEarlyFlipEpoch) {
              const result = pnl >= 0 ? "WIN" : "LOSS";
              await closeWith(result, `MACD(8,100) trail exit — momentum flipped after TP1`);
              return;
            }
          } else {
            openTrade.macdEarlyFlipEpoch = null;
            fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));
          }
        }
      }
    }

    console.log("Open trade being managed — skipping scan.");
    return;
  }

  // ── Signal Scan (Smart Fibonacci Retracement + Daily Pivots Pullback Entry) ──
  const candles = await fetchCandles(M5, 120);
  if (!candles || candles.length < 60) { console.log("Not enough M5 candles."); return; }

  const i = candles.length - 2; 
  const currentCandleEpoch = candles[i].epoch;
  const closes = candles.map(c => parseFloat(c.close));

  if (state.lastProcessedEpoch === currentCandleEpoch) {
    console.log("Already processed this candle — skipping.");
    return;
  }

  const isoTime = new Date(currentCandleEpoch * 1000).toISOString();
  const opens = candles.map(c => parseFloat(c.open));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const smaFast5 = sma(closes, 2), smaSlow5 = sma(closes, 50);
  const atr14 = calculateATR(candles, ATR_PERIOD);

  // Evaluate H1 & M15 Trend Direction
  const h1Candles = await fetchCandles(H1, 100);
  let h1Dir = null, h1FreshCross = false;
  if (h1Candles && h1Candles.length >= 52) {
    const h1Closes = h1Candles.map(c => parseFloat(c.close)), h1ci = h1Candles.length - 2;
    const smaFast1h = sma(h1Closes, 2), smaSlow1h = sma(h1Closes, 50);
    if (smaFast1h[h1ci] != null && smaSlow1h[h1ci] != null && smaFast1h[h1ci-1] != null && smaSlow1h[h1ci-1] != null) {
      if (smaFast1h[h1ci] > smaSlow1h[h1ci]) h1Dir = "BUY";
      else if (smaFast1h[h1ci] < smaSlow1h[h1ci]) h1Dir = "SELL";

      const crossedUp = (smaFast1h[h1ci-1] <= smaSlow1h[h1ci-1]) && (smaFast1h[h1ci] > smaSlow1h[h1ci]);
      const crossedDown = (smaFast1h[h1ci-1] >= smaSlow1h[h1ci-1]) && (smaFast1h[h1ci] < smaSlow1h[h1ci]);
      if (crossedUp || crossedDown) h1FreshCross = true;
    }
  }

  const m15Candles = await fetchCandles(M15, 100);
  let m15Dir = null;
  if (m15Candles && m15Candles.length >= 52) {
    const m15Closes = m15Candles.map(c => parseFloat(c.close)), m15ci = m15Candles.length - 2;
    const smaFast15 = sma(m15Closes, 2), smaSlow15 = sma(m15Closes, 50);
    if (smaFast15[m15ci] != null && smaSlow15[m15ci] != null) {
      if (smaFast15[m15ci] > smaSlow15[m15ci]) m15Dir = "BUY";
      else if (smaFast15[m15ci] < smaSlow15[m15ci]) m15Dir = "SELL";
    }
  }

  let m5Dir = null;
  if (smaFast5[i] != null && smaSlow5[i] != null) {
    if (smaFast5[i] > smaSlow5[i]) m5Dir = "BUY";
    else if (smaFast5[i] < smaSlow5[i]) m5Dir = "SELL";
  }

  // Track H1 Trend & First-Trade Status
  if (state.h1TrendDir == null) {
    state.h1TrendDir = h1Dir;
    state.firstTradeTaken = true; 
  } else if (h1FreshCross && state.h1TrendDir !== h1Dir) {
    state.h1TrendDir = h1Dir;
    state.firstTradeTaken = false; 
    state.waitingFor = null;
    state.setupEpoch = null;
  } else {
    state.h1TrendDir = h1Dir;
  }

  const h1m15Aligned = h1Dir && m15Dir && h1Dir === m15Dir;

  if (h1m15Aligned) {
    const m5CounterCrossBuy  = (h1Dir === "SELL") && (smaFast5[i-1] <= smaSlow5[i-1]) && (smaFast5[i] > smaSlow5[i]);
    const m5CounterCrossSell = (h1Dir === "BUY")  && (smaFast5[i-1] >= smaSlow5[i-1]) && (smaFast5[i] < smaSlow5[i]);

    if (m5CounterCrossBuy || m5CounterCrossSell) {
      if (state.waitingFor) {
        state.waitingFor = null;
        state.setupEpoch = null;
      }
    }

    let m5Ready = false;
    if (!state.firstTradeTaken) {
      m5Ready = (m5Dir === h1Dir);
    } else {
      const m5FreshBuy  = (smaFast5[i-1] <= smaSlow5[i-1]) && (smaFast5[i] > smaSlow5[i]);
      const m5FreshSell = (smaFast5[i-1] >= smaSlow5[i-1]) && (smaFast5[i] < smaSlow5[i]);
      if (h1Dir === "BUY" && m5FreshBuy) m5Ready = true;
      if (h1Dir === "SELL" && m5FreshSell) m5Ready = true;
    }

    if (m5Ready) {
      if (state.waitingFor !== h1Dir) {
        state.waitingFor = h1Dir;
        state.setupEpoch = currentCandleEpoch;
      }
    }
  } else {
    if (state.waitingFor) {
      state.waitingFor = null;
      state.setupEpoch = null;
    }
  }

  if (state.waitingFor && state.setupEpoch && (currentCandleEpoch - state.setupEpoch) > (SETUP_EXPIRY_BARS * M5)) {
    state.waitingFor = null;
    state.setupEpoch = null;
  }

  const h4Candle = await fetchH4Candle();
  if (!h4Candle) { state.lastProcessedEpoch = currentCandleEpoch; fs.writeFileSync("state.json", JSON.stringify(state, null, 2)); return; }
  const h4Bullish = parseFloat(h4Candle.close) > parseFloat(h4Candle.open);
  const h4Bearish = parseFloat(h4Candle.close) < parseFloat(h4Candle.open);

  const d1Ctx = await getD1Context();
  const pivots = d1Ctx ? getDailyPivots(d1Ctx.candles) : null;
  const fibs = getFibLevels(candles, state.waitingFor);

  // Smart Pullback Entry Check (Fibonacci & Daily Pivot Confluence)
  let pullbackBuyValid = false;
  let pullbackSellValid = false;

  if (state.waitingFor === "BUY" && h4Bullish && closes[i] > opens[i]) {
    const price = closes[i];
    const nearPivot = pivots && (Math.abs(price - pivots.s1) <= atr14 || Math.abs(price - pivots.pivot) <= atr14 || Math.abs(price - pivots.s2) <= atr14);
    const nearFib = fibs && (Math.abs(price - fibs.fib382) <= atr14 || Math.abs(price - fibs.fib500) <= atr14 || Math.abs(price - fibs.fib618) <= atr14);
    if (nearPivot || nearFib || price <= smaSlow5[i]) {
      pullbackBuyValid = true;
    }
  }

  if (state.waitingFor === "SELL" && h4Bearish && closes[i] < opens[i]) {
    const price = closes[i];
    const nearPivot = pivots && (Math.abs(price - pivots.r1) <= atr14 || Math.abs(price - pivots.pivot) <= atr14 || Math.abs(price - pivots.r2) <= atr14);
    const nearFib = fibs && (Math.abs(price - fibs.fib382) <= atr14 || Math.abs(price - fibs.fib500) <= atr14 || Math.abs(price - fibs.fib618) <= atr14);
    if (nearPivot || nearFib || price >= smaSlow5[i]) {
      pullbackSellValid = true;
    }
  }

  let signalTriggered = false, direction = "", entry, sl, risk, tp1, tp2, tp3;
  if (pullbackBuyValid) {
    signalTriggered = true; direction = "BUY"; entry = closes[i];
    sl = entry - (atr14 * ATR_MULTIPLIER);
    risk = entry - sl; tp1 = entry + risk * RISK_REWARD; tp2 = entry + risk * 2; tp3 = entry + risk * 3;
  } else if (pullbackSellValid) {
    signalTriggered = true; direction = "SELL"; entry = closes[i];
    sl = entry + (atr14 * ATR_MULTIPLIER);
    risk = sl - entry; tp1 = entry - risk * RISK_REWARD; tp2 = entry - risk * 2; tp3 = entry - risk * 3;
  }

  if (signalTriggered) {
    const slDollars = parseFloat((STAKE_USD * 0.5).toFixed(2));
    const tpDollars = parseFloat((slDollars * RISK_REWARD).toFixed(2));
    const alignment = d1Ctx ? checkAlignment(direction, d1Ctx.direction) : "⚠️ D1 data unavailable";
    const timeFormatted = new Date(currentCandleEpoch * 1000).toISOString().replace("T"," ").substring(0,19);
    const h4Dir = h4Bullish ? "🟢 BULLISH" : "🔴 BEARISH";

    let message = `🚨 *${SYMBOL_NAME.toUpperCase()} CONFIRMED SIGNAL* 🚨\n\nDirection: ${direction}\nRepo: ${REPO_LABEL}\nTimeframe: M5\n\n📍 Entry:  ${entry.toFixed(4)}\n🛑 SL:     ${sl.toFixed(4)}  ($${slDollars} hard)\n🎯 TP1:    ${tp1.toFixed(4)} → trail with MACD(8,100) after this\n🎯 TP2:    ${tp2.toFixed(4)} (reference)\n🎯 TP3:    ${tp3.toFixed(4)} (reference)\n\n💰 Stake: $${STAKE_USD} | Hard SL: $${slDollars} | Soft TP1: $${tpDollars} | Safety: $${SAFETY_TP_USD}\n📊 Risk: ${risk.toFixed(2)} points\n👁️ H4: ${h4Dir} ✅ Direction confirmed\n⚡ Setup: Smart Fib + Pivot Pullback Entry\n━━━━━━━━━━━━━━━━━━━━\n🌍 *D1 CANDLE STATUS*\n━━━━━━━━━━━━━━━━━━━━\n`;
    if (d1Ctx) message += `Direction: ${d1Ctx.direction}\nD1 Open: ${d1Ctx.open.toFixed(4)}\nD1 Current: ${d1Ctx.close.toFixed(4)}\nMovement: ${d1Ctx.change.toFixed(4)} pts (${d1Ctx.changePct.toFixed(2)}%)\nAlignment: ${alignment}\n\n`;
    else message += `⚠️ D1 data unavailable\n\n`;
    message += `⏰ Time (UTC): ${timeFormatted}\n\n💡 To close manually: send \`/close win\` or \`/close loss\` in this chat`;

    await sendTelegram(message);
    
    trades.push({ 
      id: `${SYMBOL}-${isoTime}`, contractId: null, repo: REPO_LABEL, symbol: SYMBOL, 
      direction, entry, sl, tp1, tp2, tp3, h1OpenAtEntry: null, tp1Reached: false, 
      macdEarlyFlipEpoch: null, peakProfit: null, rr: RISK_REWARD, openTime: timeFormatted, 
      closeTime: null, result: null 
    });
    fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2));

    try { 
      const contractId = await executeTrade(direction); 
      if (contractId) { 
        trades[trades.length - 1].contractId = contractId; 
        fs.writeFileSync("trades.json", JSON.stringify(trades, null, 2)); 
      } 
    } catch (execErr) { 
      console.error("⚠️ Live execution warning:", execErr.message); 
    }

    state.firstTradeTaken = true; 
    state.waitingFor = null;
    state.setupEpoch = null;
  }

  state.lastProcessedEpoch = currentCandleEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
  console.log(`[${REPO_LABEL}] Scan complete.`);
}


// ==================== EXECUTION MODES ====================

(async () => {
  if (MODE === "daily")      { await runSummary("Daily");   return; }
  if (MODE === "weekly")     { await runSummary("Weekly");  return; }
  if (MODE === "monthly")    { await runSummary("Monthly"); return; }
  if (MODE === "close_win")  { await executeManualClose("WIN",  "manual command"); return; }
  if (MODE === "close_loss") { await executeManualClose("LOSS", "manual command"); return; }
  if (MODE === "test") {
    await sendTelegram(`🧪 Test mode active — ${REPO_LABEL}\nFiring a direct BUY trade via proxy...\nCheck your Deriv account for a MULTUP contract.`);
    try { 
      const cid = await executeTrade("BUY"); 
      await sendTelegram(`✅ Test trade placed. Contract ID: ${cid}`); 
    } catch (e) { 
      await sendTelegram(`❌ Test trade failed: ${e.message}`); 
    }
    return;
  }
  if (TRIGGER_SOURCE !== "cronjob") { console.log("Not a cronjob trigger — exiting."); return; }
  
  await runScanMode();
})();