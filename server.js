const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// ─── Cokme Korumasi ─────────────────────────────────────────
// Mineflayer/protokol katmanindan gelen beklenmedik bir hata,
// bunlar olmadan TUM sunucuyu (web arayuzu dahil) coker.
// Bu iki handler sayesinde sadece bot tarafi etkilenir, web
// arayuzu ve API her zaman ayakta kalir.
process.on('uncaughtException', (err) => {
  console.error('[KRITIK] Yakalanmamis hata:', err);
  try { emitLog('ERROR', 'KRITIK HATA (sunucu ayakta kaliyor): ' + (err && err.message ? err.message : String(err))); } catch (e) {}
  try {
    if (bot) {
      try { bot.removeAllListeners(); } catch (e) {}
      try { bot.quit(); } catch (e) {}
      bot = null;
    }
  } catch (e) {}
  // Bot coktuyse ve kullanici tarafindan durdurulmadiysa, bir sure sonra tekrar dene
  if (!isDestroyed && botConfig) {
    try { emitStatus('CONNECTING'); } catch (e) {}
    setTimeout(() => {
      if (!isDestroyed && botConfig) startBot(botConfig);
    }, 10000);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[KRITIK] Yakalanmamis promise reddi:', reason);
  try { emitLog('ERROR', 'KRITIK: Yakalanmamis promise reddi: ' + String(reason)); } catch (e) {}
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');

  if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else {
    res.status(500).send('index.html bulunamadi: ne public/ klasorunde ne de repo kokunde var.');
  }
});

let bot = null;
let botConfig = null;
let reconnectTimer = null;
let pendingStartTimer = null;
let isDestroyed = false;
let reconnectScheduled = false; // end + kicked + error ayni anda tetiklenirse cift reconnect'i engeller

function emitLog(type, message) {
  const entry = { type, message, timestamp: new Date().toISOString() };
  console.log(`[${type}] ${message}`);
  io.emit('log', entry);
}

function emitStatus(status, username) {
  io.emit('status', { status, username: username || null });
}

// bot.chat() cagrilarini guvenli hale getir: soket son anda kapanmis olsa
// bile uncaught exception firlatip sunucuyu coktermesin
function safeChat(message) {
  if (!bot) return;
  try {
    bot.chat(message);
  } catch (err) {
    emitLog('ERROR', 'Mesaj gonderilemedi: ' + err.message);
  }
}

// ─── Bot Durdur ─────────────────────────────────────────────
function stopBot() {
  isDestroyed = true;
  reconnectScheduled = false;

  if (pendingStartTimer) {
    clearTimeout(pendingStartTimer);
    pendingStartTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (bot) {
    try { bot.removeAllListeners(); } catch (e) {}
    try { bot.quit(); } catch (e) {}
    bot = null;
  }

  emitStatus('OFFLINE');
  emitLog('INFO', 'Bot durduruldu.');
}

// ─── Bot Başlat ─────────────────────────────────────────────
function startBot(config) {
  botConfig = config;
  isDestroyed = false;
  reconnectScheduled = false;

  const username = 'ToldBot_' + (Math.floor(Math.random() * 9000) + 1000);

  // Bu oturuma ozel durum bayraklari: 'chat' ve 'message' event'leri
  // AYNI sunucu mesaji icin ikisi de tetiklenebiliyor. Bu bayraklar
  // olmadan /login, /spawn ve tesekkur mesaji IKI KEZ gonderilir,
  // bu da sunucuyu supheye dusurup botu tekrar atmasina yol acabilir.
  let loginSent = false;
  let authCompleted = false;

  emitLog('INFO', `${config.ip}:${config.port} adresine bağlanılıyor...`);
  emitLog('INFO', `Kullanıcı adı: ${username}`);
  emitStatus('CONNECTING', username);

  try {
    bot = mineflayer.createBot({
      host: config.ip,
      port: parseInt(config.port) || 25565,
      username: username,
      version: false, // Otomatik versiyon algılama
      auth: 'offline',
      hideErrors: false,
      checkTimeoutInterval: 30000,
      physicsEnabled: false, // AFK bot hareket etmiyor; fizik motoru acik kalirsa
                              // spawn sonrasi bozuk konum paketi gonderip
                              // "Invalid move player packet received" hatasiyla atiliyordu
    });
  } catch (err) {
    emitLog('ERROR', 'Bot oluşturulamadı: ' + err.message);
    emitStatus('OFFLINE');
    scheduleReconnectTopLevel();
    return;
  }

  // reconnect fonksiyonunu bot olusturulamasa bile cagirabilmek icin
  // ust seviyede de erisilebilir kucuk bir yardimci
  function scheduleReconnectTopLevel() {
    if (isDestroyed || reconnectScheduled) return;
    reconnectScheduled = true;
    const delayMs = 10000 + Math.floor(Math.random() * 10000);
    reconnectTimer = setTimeout(() => {
      reconnectScheduled = false;
      if (isDestroyed) return;
      startBot(botConfig);
    }, delayMs);
  }

  // ─── Spawn ─────────────────────────────────────────────
  bot.once('spawn', () => {
    emitLog('INFO', 'Sunucuya bağlandı! Spawn bekleniyor (2 saniye)...');

    setTimeout(() => {
      if (!bot || isDestroyed || loginSent) return;
      loginSent = true;

      if (config.alreadyRegistered) {
        emitLog('AUTH', 'Komut gönderiliyor: "/login bot123456789"');
        safeChat('/login bot123456789');
      } else {
        emitLog('AUTH', 'Komut gönderiliyor: "/register bot123456789 bot123456789"');
        safeChat('/register bot123456789 bot123456789');
      }
    }, 2000);
  });

  // ─── Sunucudan gelen tum metin mesajlarini TEK YERDEN isle ──
  // ('chat' ve 'message' event'leri ayni mesaj icin birlikte
  // tetiklenebildigi icin komut/duplikasyon riskini burada onluyoruz)
  function handleServerText(rawText) {
    const text = (rawText || '').toLowerCase();

    if (
      !authCompleted &&
      (
        text.includes('already registered') ||
        text.includes('zaten kayit') ||
        text.includes('zaten kayıt') ||
        text.includes('already') ||
        text.includes('kayitli') ||
        text.includes('kayıtlı')
      )
    ) {
      setTimeout(() => {
        if (!bot || isDestroyed || authCompleted) return;
        emitLog('AUTH', 'Hesap mevcut, giriş yapılıyor: /login bot123456789');
        safeChat('/login bot123456789');
      }, 1000);
      return;
    }

    if (
      !authCompleted &&
      (
        text.includes('logged in') ||
        text.includes('welcome back') ||
        text.includes('authenticated') ||
        text.includes('welcome') ||
        text.includes('successfully') ||
        text.includes('giris') ||
        text.includes('giriş') ||
        text.includes('basarili') ||
        text.includes('başarılı') ||
        text.includes('başarıyla') ||
        text.includes('hosgeldin') ||
        text.includes('hoşgeldin') ||
        text.includes('kayit') ||
        text.includes('kayıt')
      )
    ) {
      authCompleted = true;
      emitLog('AUTH', 'Kimlik doğrulama başarılı!');

      setTimeout(() => {
        if (!bot || isDestroyed) return;
        emitLog('SPAWN', '/spawn komutu gönderiliyor...');
        safeChat('/spawn');

        setTimeout(() => {
          if (!bot || isDestroyed) return;
          emitLog('CHAT', 'Karşılama mesajı gönderiliyor...');
          safeChat('thanks for using toldbothosting 7/24!');
          emitLog('INFO', '✓ Bot tamamen aktif, 7/24 çalışıyor!');
          emitStatus('ONLINE', bot.username);
        }, 2000);
      }, 3000);
    }
  }

  // ─── Chat ──────────────────────────────────────────────
  bot.on('chat', (sender, message) => {
    emitLog('CHAT', `[${sender}] ${message}`);
    handleServerText(message);
  });

  // ─── Sistem Mesajları (AuthMe vb) ──────────────────────
  bot.on('message', (jsonMsg) => {
    let text = '';
    try { text = jsonMsg.toString(); } catch (e) { return; }
    handleServerText(text);
  });

  // ─── Hata ──────────────────────────────────────────────
  bot.on('error', (err) => {
    emitLog('ERROR', 'Hata: ' + (err && err.message ? err.message : String(err)));
    // 'error' bazen tek basina gelir, 'end'/'kicked' hic tetiklenmeyebilir.
    // Bu durumda bot sonsuza kadar "CONNECTING" durumunda asili kalmasin.
    scheduleReconnect(`Bağlantı hatası: ${err && err.message ? err.message : 'bilinmeyen hata'}.`);
  });

  // ─── Bağlantı Kesildi / Kick ───────────────────────────
  // NOT: 'end' ve 'kicked' bazen AYNI kopma icin ikisi de tetiklenir.
  // reconnectScheduled kilidi olmadan bu iki kez startBot() cagirir,
  // iki farkli kullanici adiyla ayni anda sunucuya baglanmaya calisir.
  function scheduleReconnect(reasonLabel) {
    if (isDestroyed || reconnectScheduled) return;
    reconnectScheduled = true;

    const delayMs = 10000 + Math.floor(Math.random() * 10000); // 10-20 saniye arasi rastgele
    const delaySec = (delayMs / 1000).toFixed(1);

    emitLog('RECONNECT', `${reasonLabel} ${delaySec} saniye içinde yeniden bağlanılıyor...`);
    emitStatus('CONNECTING');
    bot = null;

    reconnectTimer = setTimeout(() => {
      reconnectScheduled = false;
      if (isDestroyed) return;
      emitLog('RECONNECT', 'Yeniden bağlanılıyor...');
      startBot(botConfig);
    }, delayMs);
  }

  bot.on('end', (reason) => {
    scheduleReconnect(`Bağlantı kesildi${reason ? ': ' + reason : ''}.`);
  });

  bot.on('kicked', (reason) => {
    let reasonText = '';
    if (typeof reason === 'string') {
      try {
        const parsed = JSON.parse(reason);
        reasonText = parsed?.text || parsed?.translate || reason;
      } catch (e) {
        reasonText = reason;
      }
    } else if (reason && typeof reason === 'object') {
      try {
        reasonText = reason.toString();
        if (reasonText === '[object Object]') {
          reasonText = JSON.stringify(reason);
        }
      } catch (e) {
        reasonText = JSON.stringify(reason);
      }
    } else {
      reasonText = String(reason);
    }
    scheduleReconnect(`Sunucudan atıldı: ${reasonText}.`);
  });
}

// ─── API ──────────────────────────────────────────────────
app.post('/api/start', (req, res) => {
  const { ip, port = 25565, alreadyRegistered = false } = req.body || {};

  if (!ip || typeof ip !== 'string' || !ip.trim()) {
    return res.status(400).json({ error: 'Sunucu IP adresi gerekli' });
  }

  // Onceki her turlu bot/timer durumunu, bot suan null olsa bile
  // (ornegin reconnect bekliyorken) tamamen temizle. Bu, art arda
  // hizli /api/start cagrilarinda iki botun ayni anda acilmasini engeller.
  stopBot();
  isDestroyed = false;

  pendingStartTimer = setTimeout(() => {
    pendingStartTimer = null;
    startBot({ ip: ip.trim(), port, alreadyRegistered: !!alreadyRegistered });
  }, 500);

  res.json({ success: true, message: 'Bot başlatma işlemi başlatıldı' });
});

app.post('/api/stop', (req, res) => {
  stopBot();
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  let status = 'OFFLINE';
  let username = null;

  if (bot) {
    status = 'ONLINE';
    username = bot.username;
  } else if (botConfig && !isDestroyed) {
    status = 'CONNECTING';
  }

  res.json({ status, username });
});

// ─── Socket.io ────────────────────────────────────────────
io.on('connection', (socket) => {
  let status = 'OFFLINE';
  let username = null;

  if (bot) { status = 'ONLINE'; username = bot.username; }
  else if (botConfig && !isDestroyed) { status = 'CONNECTING'; }

  socket.emit('status', { status, username });
  socket.emit('log', {
    type: 'INFO',
    message: 'ToldBot Hosting v1.0 — Bağlandı.',
    timestamp: new Date().toISOString()
  });
});

// ─── Başlat ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`ToldBot Hosting çalışıyor: http://localhost:${PORT}`);
});
