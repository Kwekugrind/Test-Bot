import fs from "fs";
import WebSocket from "ws";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

const APP_ID = 1089;
const SYMBOL = "R_75";
const TF = 900;          // M15
const COUNT = 500;

function sma(values, length) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}
const crossover  = (pA, pB, cA, cB) => pA <= pB && cA > cB;
const crossunder = (pA, pB, cA, cB) => pA >= pB && cA < cB;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
  });
  if (!res.ok) throw new Error(await res.text());
}

function getCandles() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Deriv websocket timeout"));
    }, 15000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        style: "candles",
        granularity: TF,
        count: COUNT,
        end: "latest",
      }));
    });

    ws.on("message", (msg) => {
      const data = JSON.parse(msg.toString());
      if (data.error) {
        clearTimeout(timer);
        ws.close();
        return reject(new Error(data.error.message));
      }
      if (data.msg_type === "candles") {
        clearTimeout(timer);
        ws.close();
        resolve(data.candles.map(c => ({
          epoch: c.epoch,         // open time
          close: +c.close
        })));
      }
    });

    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

(async () => {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) throw new Error("Missing TG_BOT_TOKEN or TG_CHAT_ID");

  const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
  const lastCloseEpoch = Number(state.lastCloseEpoch || 0);

  const candles = await getCandles();
  const nowSec = Math.floor(Date.now() / 1000);

  // use only fully closed candles
  const closed = candles.filter(c => (c.epoch + TF) <= nowSec);
  if (closed.length < 60) return;

  // last closed candle
  const i = closed.length - 1;
  const prev = i - 1;

  const closeEpoch = closed[i].epoch + TF; // candle close time

  // Deduplicate: process each candle close once
  if (closeEpoch <= lastCloseEpoch) return;

  const closes = closed.map(c => c.close);
  const sma4 = sma(closes, 4);
  const sma34 = sma(closes, 34);

  // update state (even if no signal; candle is final)
  state.lastCloseEpoch = closeEpoch;
  fs.writeFileSync("state.json", JSON.stringify(state, null, 2));

  if (sma4[prev] == null || sma34[prev] == null || sma4[i] == null || sma34[i] == null) return;

  const buy  = crossover(sma4[prev], sma34[prev], sma4[i], sma34[i]);
  const sell = crossunder(sma4[prev], sma34[prev], sma4[i], sma34[i]);

  if (!(buy || sell)) return;

  const tClose = new Date(closeEpoch * 1000).toISOString().replace("T"," ").slice(0,19) + " UTC";
  const msg =
    `V75 (${SYMBOL}) M15 SMA Cross\n` +
    `Candle close: ${tClose}\n` +
    `Close price: ${closed[i].close}\n` +
    `${buy ? "BUY (SMA4 ↑ SMA34)" : "SELL (SMA4 ↓ SMA34)"}`;

  await sendTelegram(msg);
})();
