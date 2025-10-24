import makeWASocket, { useMultiFileAuthState } from '@adiwajshing/baileys'
import { Boom } from '@hapi/boom'
import fs from 'fs'
import os from 'os'

const cfg = JSON.parse(fs.readFileSync('./config.json'))

const DB_FILE = cfg.dbFile || 'db.json'
const AUTH_DIR = cfg.authFolder || 'auth'
const WELCOME_TEXT = cfg.welcomeText || 'Halo 👋, terima kasih sudah menghubungi. Admin akan segera membalas.'
const INTERVAL_MS = (cfg.welcomeIntervalHours || 6) * 3600 * 1000
const RATE_LIMIT_PER_MIN = cfg.rateLimitPerMinute || 30

let sentInWindow = 0
let windowStart = Date.now()
function canSendNow() {
  const now = Date.now()
  if (now - windowStart > 60 * 1000) {
    windowStart = now
    sentInWindow = 0
  }
  return sentInWindow < RATE_LIMIT_PER_MIN
}
function markSent() { sentInWindow++ }

let db = { contacts: {} }
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE)) } catch { db = { contacts: {} } }
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)) } catch {}
}

setInterval(() => {
  const now = Date.now()
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000
  for (const k of Object.keys(db.contacts)) {
    if (now - (db.contacts[k].lastCustomerMsg || 0) > THIRTY_DAYS) delete db.contacts[k]
  }
  saveDB()
}, 6 * 3600 * 1000)

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const sock = makeWASocket.default({
  auth: state,
  printQRInTerminal: true,
  browser: ['auto-welcome-worker', os.hostname(), '1.0.0']
})
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect } = u
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('Connection closed, code:', code)
      if (code !== 401) setTimeout(() => start().catch(console.error), 2000)
    } else if (connection === 'open') console.log('✅ WhatsApp connected.')
  })

  sock.ev.on('messages.upsert', async (m) => {
    if (!m.messages) return
    for (const msg of m.messages) {
      if (!msg.message) continue
      const remote = msg.key.remoteJid
      if (!remote || remote.endsWith('@g.us')) continue
      const id = remote.split('@')[0]
      const now = Date.now()
      db.contacts[id] = db.contacts[id] || {}
      const rec = db.contacts[id]

      if (msg.key.fromMe) {
        rec.lastOperatorMsg = now
        if (!rec.lastCustomerMsg) rec.operatorFirst = true
        saveDB()
        continue
      }

      rec.lastCustomerMsg = now
      if (rec.operatorFirst) { saveDB(); continue }

      const lastWelcome = rec.lastWelcome || 0
      const lastCust = rec.prevCustomerMsg || 0
      rec.prevCustomerMsg = now
      const lastOperator = rec.lastOperatorMsg || 0
      const operatorAfterWelcome = lastOperator > lastWelcome

      let shouldSend = false
      if (!lastWelcome) shouldSend = true
      else if (!operatorAfterWelcome && now - lastCust >= INTERVAL_MS) shouldSend = true

      if (shouldSend && canSendNow()) {
        try {
          await sock.sendMessage(remote, { text: WELCOME_TEXT })
          rec.lastWelcome = Date.now()
          markSent()
          console.log('Welcome sent to', id)
        } catch (e) {
          console.log('Send fail:', e?.message || e)
        }
      }
      db.contacts[id] = rec
      saveDB()
    }
  })
}
start().catch(console.error)
