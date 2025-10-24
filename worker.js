import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import os from "os";
import P from "pino";

// === CONFIG ===
const cfg = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const DB_FILE = cfg.dbFile || "db.json";
const AUTH_DIR = cfg.authFolder || "auth";
const WELCOME_TEXT =
  cfg.welcomeText ||
  "Halo 👋, terima kasih sudah menghubungi. Admin akan segera membalas.";
const INTERVAL_MS = (cfg.welcomeIntervalHours || 6) * 3600 * 1000;
const RATE_LIMIT_PER_MIN = cfg.rateLimitPerMinute || 30;

// === RATE LIMIT ===
let sentInWindow = 0;
let windowStart = Date.now();
function canSendNow() {
  const now = Date.now();
  if (now - windowStart > 60 * 1000) {
    windowStart = now;
    sentInWindow = 0;
  }
  return sentInWindow < RATE_LIMIT_PER_MIN;
}
function markSent() {
  sentInWindow++;
}

// === DATABASE ===
let db = { contacts: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    db = { contacts: {} };
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("❌ Gagal menyimpan DB:", err.message);
  }
}

// === AUTO CLEAN OLD CONTACTS ===
setInterval(() => {
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
  for (const k of Object.keys(db.contacts)) {
    if (now - (db.contacts[k].lastCustomerMsg || 0) > THIRTY_DAYS)
      delete db.contacts[k];
  }
  saveDB();
}, 6 * 3600 * 1000);

// === MAIN START FUNCTION ===
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  import qrcode from "qrcode-terminal"

const sock = makeWASocket({
  logger: P({ level: "silent" }),
  auth: state,
  browser: ["Auto-Welcome", os.hostname(), "1.0.0"],
})

// tampilkan QR di terminal manual
sock.ev.on("connection.update", (update) => {
  const { connection, lastDisconnect, qr } = update
  if (qr) {
    console.clear()
    console.log("📱 Scan QR Code di bawah ini untuk konek WhatsApp:")
    qrcode.generate(qr, { small: true })
  }
  if (connection === "open") console.log("✅ WhatsApp connected and running!")
  else if (connection === "close") {
    const code = new Boom(lastDisconnect?.error)?.output?.statusCode
    console.log("❌ Connection closed, code:", code)
    if (code !== 401) setTimeout(() => start().catch(console.error), 3000)
  }
})

  sock.ev.on("messages.upsert", async (msgUpdate) => {
    if (!msgUpdate.messages) return;
    for (const msg of msgUpdate.messages) {
      if (!msg.message) continue;

      const remote = msg.key.remoteJid;
      if (!remote || remote.endsWith("@g.us")) continue; // skip group chat

      const id = remote.split("@")[0];
      const now = Date.now();

      db.contacts[id] = db.contacts[id] || {};
      const rec = db.contacts[id];

      // jika pesan dari operator (send sendiri)
      if (msg.key.fromMe) {
        rec.lastOperatorMsg = now;
        if (!rec.lastCustomerMsg) rec.operatorFirst = true;
        saveDB();
        continue;
      }

      // pesan dari customer
      rec.lastCustomerMsg = now;
      if (rec.operatorFirst) {
        saveDB();
        continue;
      }

      const lastWelcome = rec.lastWelcome || 0;
      const lastCust = rec.prevCustomerMsg || 0;
      rec.prevCustomerMsg = now;
      const lastOperator = rec.lastOperatorMsg || 0;
      const operatorAfterWelcome = lastOperator > lastWelcome;

      let shouldSend = false;
      if (!lastWelcome) shouldSend = true;
      else if (!operatorAfterWelcome && now - lastCust >= INTERVAL_MS)
        shouldSend = true;

      if (shouldSend && canSendNow()) {
        try {
          await sock.sendMessage(remote, { text: WELCOME_TEXT });
          rec.lastWelcome = Date.now();
          markSent();
          console.log("📨 Welcome sent to", id);
        } catch (e) {
          console.log("⚠️ Send fail:", e?.message || e);
        }
      }

      db.contacts[id] = rec;
      saveDB();
    }
  });
}

start().catch(console.error);
