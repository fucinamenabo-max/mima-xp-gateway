// Mima XP Gateway — ascolta MESSAGE_CREATE e chiama xp_hook.php
// Variabili d'ambiente (da impostare su Render):
//   BOT_TOKEN      = token di Mima (bot3)
//   GUILD_ID       = ID del server Discord dell'amica
//   XP_HOOK_URL    = https://fucinamenabo.com/bots/momo-mima/xp_hook.php
//   XP_HOOK_SECRET = stessa stringa in config.php → XP_HOOK_SECRET
//   PORT           = (Render lo imposta da solo, default 3000)

const WebSocket = require('ws');
const https = require('https');
const http  = require('http');

const TOKEN  = process.env.BOT_TOKEN;
const GUILD  = process.env.GUILD_ID;
const HOOK   = process.env.XP_HOOK_URL;
const SECRET = process.env.XP_HOOK_SECRET;
const PORT   = process.env.PORT || 3000;

if (!TOKEN || !GUILD || !HOOK || !SECRET) {
  console.error('Mancano variabili d\'ambiente. Controlla BOT_TOKEN, GUILD_ID, XP_HOOK_URL, XP_HOOK_SECRET.');
  process.exit(1);
}

// HTTP server per il health check di Render (evita lo spin-down)
http.createServer((req, res) => res.end('ok')).listen(PORT, () => console.log('Health check on', PORT));

let ws, heartbeat, sessionId, resumeUrl, seq = null;

function connect(url) {
  ws = new WebSocket(url || 'wss://gateway.discord.gg/?v=10&encoding=json');

  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.s) seq = msg.s;

    if (msg.op === 10) {  // Hello → avvia heartbeat + Identify
      heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), msg.d.heartbeat_interval);
      ws.send(JSON.stringify({
        op: 2, d: {
          token: TOKEN,
          intents: 1 << 9,  // GUILD_MESSAGES (non privilegiato)
          properties: { os: 'linux', browser: 'mima-xp', device: 'mima-xp' },
        }
      }));
    } else if (msg.op === 0) {
      if (msg.t === 'READY') { sessionId = msg.d.session_id; resumeUrl = msg.d.resume_gateway_url; console.log('Mima XP gateway pronto.'); }
      if (msg.t === 'MESSAGE_CREATE') onMessage(msg.d);
    } else if (msg.op === 7) {  // Reconnect
      clearInterval(heartbeat); ws.close();
    } else if (msg.op === 9) {  // Invalid session
      setTimeout(() => connect(), 5000);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    setTimeout(() => connect(resumeUrl), 5000);
  });

  ws.on('error', err => { console.error('WS error:', err.message); ws.close(); });
}

function onMessage(msg) {
  if (msg.guild_id !== GUILD) return;
  if (msg.author?.bot) return;

  const body = 'user_id=' + encodeURIComponent(msg.author.id);
  const url  = new URL(HOOK);
  const req  = https.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-xp-secret': SECRET,
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

connect();
