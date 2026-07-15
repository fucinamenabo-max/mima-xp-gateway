// XP Gateway — ascolta MESSAGE_CREATE e chiama l'xp_hook del sito.
//
// UN SOLO PROCESSO, N BOT: ogni bot ha la sua connessione al gateway Discord
// e il suo hook. Serve a stare dentro le 750 ore-istanza/mese del piano free
// di Render: due servizi separati sempre svegli ne farebbero ~1460.
//
// ── Variabili d'ambiente (una serie per bot) ────────────────────────────
// Il PRIMO bot non ha suffisso — cosi' la configurazione esistente di Mima
// continua a funzionare identica, senza toccare nulla.
// Dal secondo in poi si usa _2, _3, ...
//
//   BOT_TOKEN        GUILD_ID        XP_HOOK_URL        XP_HOOK_SECRET     [BOT_NAME]
//   BOT_TOKEN_2      GUILD_ID_2      XP_HOOK_URL_2      XP_HOOK_SECRET_2   [BOT_NAME_2]
//
// Configurazione attuale attesa:
//   bot 1 = Mima  → https://fucinamenabo.com/bot2/xp_hook.php
//   bot 2 = Ciano → https://fucinamenabo.com/bot2/ciano/xp_hook.php
//
// ⚠️ I percorsi sono /bot2/…, NON /bots/… : quella cartella non esiste
//    (migrazione mai completata) e restituisce 404.
//
//   PORT = lo imposta Render da solo (default 3000)

const WebSocket = require('ws');
const https = require('https');
const http  = require('http');

const PORT = process.env.PORT || 3000;

// ── Lettura config: BOT_TOKEN, BOT_TOKEN_2, ... ────────────────────────
function leggiBot() {
  const bots = [];
  for (let i = 1; i <= 9; i++) {
    const sfx = i === 1 ? '' : '_' + i;
    const cfg = {
      nome:   process.env['BOT_NAME' + sfx] || ('bot' + i),
      token:  process.env['BOT_TOKEN' + sfx],
      guild:  process.env['GUILD_ID' + sfx],
      hook:   process.env['XP_HOOK_URL' + sfx],
      secret: process.env['XP_HOOK_SECRET' + sfx],
    };
    const presenti = ['token', 'guild', 'hook', 'secret'].filter(k => cfg[k]);
    if (presenti.length === 0) continue;  // slot non usato: normale
    if (presenti.length < 4) {
      // Meglio non partire affatto che partire con un bot muto e non accorgersene
      console.error(`[config] ${cfg.nome}: config incompleta — servono BOT_TOKEN${sfx}, GUILD_ID${sfx}, XP_HOOK_URL${sfx}, XP_HOOK_SECRET${sfx}`);
      process.exit(1);
    }
    bots.push(cfg);
  }
  return bots;
}

const BOTS = leggiBot();
if (BOTS.length === 0) {
  console.error('Nessun bot configurato: servono almeno BOT_TOKEN, GUILD_ID, XP_HOOK_URL, XP_HOOK_SECRET.');
  process.exit(1);
}

// Health check di Render. E' anche l'endpoint che il cron su cPanel pinga ogni
// 5 minuti: senza traffico HTTP Render sospende il servizio e il websocket cade.
http.createServer((req, res) => res.end('ok')).listen(PORT, () =>
  console.log(`Health check su ${PORT} — bot attivi: ${BOTS.map(b => b.nome).join(', ')}`)
);

// ── Una connessione indipendente per bot ───────────────────────────────
// Lo stato (ws, heartbeat, seq, resumeUrl) sta nella closure, non a livello di
// modulo: con due bot, uno stato condiviso farebbe sovrascrivere le connessioni
// a vicenda — la ragione per cui l'originale reggeva un bot solo.
function avviaBot(cfg) {
  let ws, heartbeat, seq = null, resumeUrl = null;

  // Chiude tutto senza far scattare il reconnect automatico di ws.on('close'):
  // chi chiama decide se e quando riconnettersi.
  function stop() {
    clearInterval(heartbeat);
    heartbeat = null;
    if (ws) {
      try { ws.removeAllListeners(); ws.close(); } catch (e) {}
    }
  }

  function connect(url) {
    ws = new WebSocket(url || 'wss://gateway.discord.gg/?v=10&encoding=json');

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (msg.s) seq = msg.s;

      if (msg.op === 10) {              // Hello → heartbeat + Identify
        heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), msg.d.heartbeat_interval);
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token: cfg.token,
            intents: 1 << 9,            // GUILD_MESSAGES: non privilegiato, basta l'id autore
            properties: { os: 'linux', browser: 'xp-gateway', device: 'xp-gateway' },
          },
        }));
      } else if (msg.op === 0) {
        if (msg.t === 'READY') {
          resumeUrl = msg.d.resume_gateway_url;
          console.log(`[${cfg.nome}] gateway pronto (guild ${cfg.guild}).`);
        }
        if (msg.t === 'MESSAGE_CREATE') onMessage(cfg, msg.d);
      } else if (msg.op === 7) {        // Discord chiede di riconnettersi
        stop();
        setTimeout(() => connect(resumeUrl), 5000);
      } else if (msg.op === 9) {        // Sessione non valida → si riparte puliti
        // L'originale qui chiamava connect() senza chiudere il socket ne'
        // fermare l'heartbeat: restavano un intervallo orfano e una seconda
        // connessione viva. Con due bot il danno raddoppia.
        stop();
        resumeUrl = null;
        setTimeout(() => connect(), 5000);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      heartbeat = null;
      setTimeout(() => connect(resumeUrl), 5000);
    });

    ws.on('error', err => {
      console.error(`[${cfg.nome}] WS error:`, err.message);
      try { ws.close(); } catch (e) {}
    });
  }

  connect();
}

function onMessage(cfg, msg) {
  if (msg.guild_id !== cfg.guild) return;   // ogni bot conta solo il suo server
  if (msg.author?.bot) return;

  const body = 'user_id=' + encodeURIComponent(msg.author.id);
  const url  = new URL(cfg.hook);
  const req  = https.request({
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-xp-secret': cfg.secret,
      'Content-Length': Buffer.byteLength(body),
    },
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log(`[${cfg.nome}] XP user=${msg.author.id} status=${res.statusCode} body=${data.trim()}`));
  });
  req.on('error', err => console.error(`[${cfg.nome}] request error:`, err.message));
  req.write(body);
  req.end();
}

BOTS.forEach(avviaBot);
