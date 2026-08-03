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

const MAX_BOTS = 3;

// ─── Cokme Korumasi ─────────────────────────────────────────
// Mineflayer/protokol katmanindan gelen beklenmedik bir hata (ornegin
// prismarine-chat'in taniyamadigi bir mesaj formati), bunlar olmadan
// TUM sunucuyu (web arayuzu dahil) coker VE soket sizintisi biriktirip
// container'in OOM (bellek tasmasi) ile oldurulmesine yol acar.
//
// Node.js bize hatayi hangi bot/slotun firlattigini SOYLEMEZ, bu yuzden
// guvenlik icin TUM aktif botlari "supheli" sayip temizliyoruz: baglantiyi
// kapatip normal reconnect dongusune sokuyoruz. Bu, 1 bot yuzunden diger
// 2 bota da kisa bir kesinti yasatir ama bunun bedeli, container'in
// tamamen OOM ile olup butun botlarin sifirdan (config dahil) kaybolmasindan
// COK daha ucuzdur.
process.on('uncaughtException', (err) => {
  console.error('[KRITIK] Yakalanmamis hata:', err);
  const msg = err && err.message ? err.message : String(err);
  try { broadcastLog(null, 'ERROR', 'KRITIK HATA yakalandi, etkilenen botlar temizleniyor: ' + msg); } catch (e) {}

  for (let i = 1; i <= MAX_BOTS; i++) {
    const s = slots[i];
    if (!s || !s.bot) continue;
    try {
      const brokenBot = s.bot;
      s.bot = null;
      try { brokenBot.removeAllListeners(); } catch (e) {}
      try { brokenBot.end ? brokenBot.end() : brokenBot.quit(); } catch (e) {}
    } catch (e) {}
    // Kullanici bilerek durdurmadiysa (isDestroyed=false), normal
    // reconnect kilidini kullanarak guvenli sekilde yeniden baglan
    scheduleReconnect(i, 'Beklenmedik protokol hatasi sonrasi baglanti temizlendi.');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[KRITIK] Yakalanmamis promise reddi:', reason);
  try { broadcastLog(null, 'ERROR', 'KRITIK: Yakalanmamis promise reddi: ' + String(reason)); } catch (e) {}
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

// ─── Coklu Bot Durum Yonetimi ──────────────────────────────
// Her slot (1, 2, 3) kendi bagimsiz durumuna sahip. Bir slottaki
// hata/reconnect/kick digerlerini ETKILEMEZ.
// slots[N] = {
//   bot, ip, port, alreadyRegistered, username, status,
//   reconnectTimer, pendingStartTimer, isDestroyed, reconnectScheduled,
//   loginSent, authCompleted
// }
const slots = {};

function activeSlotCount() {
  return Object.keys(slots).length;
}

function findFreeSlot() {
  for (let i = 1; i <= MAX_BOTS; i++) {
    if (!slots[i]) return i;
  }
  return null;
}

function broadcastLog(slot, type, message) {
  const entry = { slot, type, message, timestamp: new Date().toISOString() };
  console.log(`[Slot ${slot ?? '-'}] [${type}] ${message}`);
  io.emit('log', entry);
}

function broadcastStatus(slot, status, username, ip) {
  io.emit('status', { slot, status, username: username || null, ip: ip || null });
}

function broadcastSlotRemoved(slot) {
  io.emit('slot_removed', { slot });
}

function getAllStatuses() {
  const result = [];
  for (let i = 1; i <= MAX_BOTS; i++) {
    if (slots[i]) {
      result.push({
        slot: i,
        status: slots[i].status,
        username: slots[i].bot ? slots[i].bot.username : null,
        ip: slots[i].ip,
        port: slots[i].port
      });
    }
  }
  return result;
}

// bot.chat() cagrilarini guvenli hale getir: soket son anda kapanmis olsa
// bile uncaught exception firlatip sunucuyu coktermesin
function safeChat(slotState, message) {
  if (!slotState || !slotState.bot) return false;
  try {
    slotState.bot.chat(message);
    return true;
  } catch (err) {
    broadcastLog(slotState.slotId, 'ERROR', 'Mesaj gönderilemedi: ' + err.message);
    return false;
  }
}

// ─── Bot Durdur (slotu KORUR, sadece baglantiyi keser) ─────
function stopBot(slotId) {
  const s = slots[slotId];
  if (!s) return;

  s.isDestroyed = true;
  s.reconnectScheduled = false;

  if (s.pendingStartTimer) {
    clearTimeout(s.pendingStartTimer);
    s.pendingStartTimer = null;
  }
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  if (s.bot) {
    try { s.bot.removeAllListeners(); } catch (e) {}
    try { s.bot.quit(); } catch (e) {}
    s.bot = null;
  }

  s.status = 'OFFLINE';
  broadcastStatus(slotId, 'OFFLINE', null, s.ip);
  broadcastLog(slotId, 'INFO', 'Bot durduruldu.');
}

// ─── Bot Slotu Tamamen Kaldir (kapasiteyi bosaltir) ────────
function removeSlot(slotId) {
  if (!slots[slotId]) return;
  stopBot(slotId);
  delete slots[slotId];
  broadcastSlotRemoved(slotId);
}

// ─── Bot Başlat ─────────────────────────────────────────────
function startBot(slotId, config) {
  if (!slots[slotId]) {
    slots[slotId] = {
      slotId,
      bot: null,
      ip: config.ip,
      port: config.port,
      alreadyRegistered: config.alreadyRegistered,
      status: 'CONNECTING',
      reconnectTimer: null,
      pendingStartTimer: null,
      isDestroyed: false,
      reconnectScheduled: false,
      loginSent: false,
      authCompleted: false
    };
  }
  const s = slots[slotId];
  s.ip = config.ip;
  s.port = config.port;
  s.alreadyRegistered = config.alreadyRegistered;
  s.isDestroyed = false;
  s.reconnectScheduled = false;
  s.loginSent = false;
  s.authCompleted = false;
  s.status = 'CONNECTING';

  const username = 'ToldBot_' + (Math.floor(Math.random() * 9000) + 1000);

  broadcastLog(slotId, 'INFO', `${config.ip}:${config.port} adresine bağlanılıyor...`);
  broadcastLog(slotId, 'INFO', `Kullanıcı adı: ${username}`);
  broadcastStatus(slotId, 'CONNECTING', username, config.ip);

  let botInstance;
  const tryVersions = ['1.21.8', false]; // once gercek surumu dene, olmazsa otomatik algilamaya don
  let creationError = null;

  for (const tryVersion of tryVersions) {
    try {
      botInstance = mineflayer.createBot({
        host: config.ip,
        port: parseInt(config.port) || 25565,
        username: username,
        version: tryVersion,
        auth: 'offline',
        hideErrors: false,
        checkTimeoutInterval: 30000,
        physicsEnabled: false, // AFK bot hareket etmiyor; fizik motoru acik kalirsa
                                // spawn sonrasi bozuk konum paketi gonderip
                                // "Invalid move player packet received" hatasiyla atiliyordu
      });
      if (tryVersion !== '1.21.8') {
        broadcastLog(slotId, 'INFO', `1.21.8 sürümü desteklenmiyor, otomatik sürüm algılamaya geçildi.`);
      }
      creationError = null;
      break;
    } catch (err) {
      creationError = err;
      botInstance = null;
    }
  }

  if (!botInstance) {
    broadcastLog(slotId, 'ERROR', 'Bot oluşturulamadı: ' + (creationError ? creationError.message : 'bilinmeyen hata'));
    s.status = 'OFFLINE';
    broadcastStatus(slotId, 'OFFLINE', null, config.ip);
    scheduleReconnect(slotId, 'Bot oluşturulamadı.');
    return;
  }

  s.bot = botInstance;

  // ─── Spawn ─────────────────────────────────────────────
  botInstance.once('spawn', () => {
    broadcastLog(slotId, 'INFO', 'Sunucuya bağlandı! Spawn bekleniyor (2 saniye)...');

    setTimeout(() => {
      if (!s.bot || s.isDestroyed || s.loginSent) return;
      s.loginSent = true;

      if (s.alreadyRegistered) {
        broadcastLog(slotId, 'AUTH', 'Komut gönderiliyor: "/login bot123456789"');
        safeChat(s, '/login bot123456789');
      } else {
        broadcastLog(slotId, 'AUTH', 'Komut gönderiliyor: "/register bot123456789 bot123456789"');
        safeChat(s, '/register bot123456789 bot123456789');
      }
    }, 2000);
  });

  // ─── Sunucudan gelen tum metin mesajlarini TEK YERDEN isle ──
  // ('chat' ve 'message' event'leri ayni mesaj icin birlikte
  // tetiklenebildigi icin komut/duplikasyon riskini burada onluyoruz)
  function handleServerText(rawText) {
    const text = (rawText || '').toLowerCase();

    if (
      !s.authCompleted &&
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
        if (!s.bot || s.isDestroyed || s.authCompleted) return;
        broadcastLog(slotId, 'AUTH', 'Hesap mevcut, giriş yapılıyor: /login bot123456789');
        safeChat(s, '/login bot123456789');
      }, 1000);
      return;
    }

    if (
      !s.authCompleted &&
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
      s.authCompleted = true;
      broadcastLog(slotId, 'AUTH', 'Kimlik doğrulama başarılı!');

      setTimeout(() => {
        if (!s.bot || s.isDestroyed) return;
        broadcastLog(slotId, 'SPAWN', '/spawn komutu gönderiliyor...');
        safeChat(s, '/spawn');

        setTimeout(() => {
          if (!s.bot || s.isDestroyed) return;
          broadcastLog(slotId, 'CHAT', 'Karşılama mesajı gönderiliyor...');
          safeChat(s, 'thanks for using toldbothosting 7/24!');
          broadcastLog(slotId, 'INFO', '✓ Bot tamamen aktif, 7/24 çalışıyor!');
          s.status = 'ONLINE';
          broadcastStatus(slotId, 'ONLINE', s.bot.username, s.ip);
        }, 2000);
      }, 3000);
    }
  }

  // ─── Chat ──────────────────────────────────────────────
  botInstance.on('chat', (sender, message) => {
    broadcastLog(slotId, 'CHAT', `[${sender}] ${message}`);
    handleServerText(message);
  });

  // ─── Sistem Mesajları (AuthMe vb) ──────────────────────
  botInstance.on('message', (jsonMsg) => {
    let text = '';
    try { text = jsonMsg.toString(); } catch (e) { return; }
    handleServerText(text);
  });

  // ─── Hata ──────────────────────────────────────────────
  botInstance.on('error', (err) => {
    broadcastLog(slotId, 'ERROR', 'Hata: ' + (err && err.message ? err.message : String(err)));
    // 'error' bazen tek basina gelir, 'end'/'kicked' hic tetiklenmeyebilir.
    // Bu durumda bot sonsuza kadar "CONNECTING" durumunda asili kalmasin.
    scheduleReconnect(slotId, `Bağlantı hatası: ${err && err.message ? err.message : 'bilinmeyen hata'}.`);
  });

  // ─── Bağlantı Kesildi / Kick ───────────────────────────
  botInstance.on('end', (reason) => {
    scheduleReconnect(slotId, `Bağlantı kesildi${reason ? ': ' + reason : ''}.`);
  });

  botInstance.on('kicked', (reason) => {
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
    scheduleReconnect(slotId, `Sunucudan atıldı: ${reasonText}.`);
  });
}

// NOT: 'end' ve 'kicked' bazen AYNI kopma icin ikisi de tetiklenir.
// reconnectScheduled kilidi olmadan bu iki kez startBot() cagirir,
// ayni slotta iki farkli bot ayni anda baglanmaya calisir.
function scheduleReconnect(slotId, reasonLabel) {
  const s = slots[slotId];
  if (!s || s.isDestroyed || s.reconnectScheduled) return;
  s.reconnectScheduled = true;

  const delayMs = 10000 + Math.floor(Math.random() * 10000); // 10-20 saniye arasi rastgele
  const delaySec = (delayMs / 1000).toFixed(1);

  broadcastLog(slotId, 'RECONNECT', `${reasonLabel} ${delaySec} saniye içinde yeniden bağlanılıyor...`);
  s.status = 'CONNECTING';
  broadcastStatus(slotId, 'CONNECTING', null, s.ip);
  s.bot = null;

  s.reconnectTimer = setTimeout(() => {
    s.reconnectScheduled = false;
    if (!slots[slotId] || slots[slotId].isDestroyed) return;
    broadcastLog(slotId, 'RECONNECT', 'Yeniden bağlanılıyor...');
    startBot(slotId, { ip: s.ip, port: s.port, alreadyRegistered: s.alreadyRegistered });
  }, delayMs);
}

// ─── API ──────────────────────────────────────────────────

// Yeni bot ekle (bos bir slota) VEYA mevcut slotu belirtilen slot ile yeniden baslat
app.post('/api/start', (req, res) => {
  const { ip, port = 25565, alreadyRegistered = false, slot } = req.body || {};

  if (!ip || typeof ip !== 'string' || !ip.trim()) {
    return res.status(400).json({ error: 'Sunucu IP adresi gerekli' });
  }

  let targetSlot = slot;

  if (targetSlot) {
    // Belirli bir slotu yeniden baslatma istegi
    if (targetSlot < 1 || targetSlot > MAX_BOTS) {
      return res.status(400).json({ error: 'Geçersiz slot numarası' });
    }
  } else {
    // Yeni bot ekleme: bos slot ara
    targetSlot = findFreeSlot();
    if (!targetSlot) {
      return res.status(400).json({ error: `Maksimum bot sayısına ulaşıldı (${MAX_BOTS}/${MAX_BOTS})` });
    }
  }

  // O slotun her turlu onceki durumunu (bot calisiyor olsun ya da
  // reconnect bekliyor olsun) tamamen temizle. Bu, art arda hizli
  // /api/start cagrilarinda ayni slotta iki botun ayni anda
  // acilmasini engeller.
  if (slots[targetSlot]) {
    stopBot(targetSlot);
  }

  const finalSlot = targetSlot;
  const config = { ip: ip.trim(), port, alreadyRegistered: !!alreadyRegistered };

  if (!slots[finalSlot]) {
    slots[finalSlot] = {
      slotId: finalSlot,
      bot: null,
      ip: config.ip,
      port: config.port,
      alreadyRegistered: config.alreadyRegistered,
      status: 'CONNECTING',
      reconnectTimer: null,
      pendingStartTimer: null,
      isDestroyed: false,
      reconnectScheduled: false,
      loginSent: false,
      authCompleted: false
    };
  }
  slots[finalSlot].isDestroyed = false;

  slots[finalSlot].pendingStartTimer = setTimeout(() => {
    if (slots[finalSlot]) slots[finalSlot].pendingStartTimer = null;
    startBot(finalSlot, config);
  }, 500);

  res.json({ success: true, message: 'Bot başlatma işlemi başlatıldı', slot: finalSlot });
});

app.post('/api/stop', (req, res) => {
  const { slot } = req.body || {};
  if (!slot || !slots[slot]) {
    return res.status(400).json({ error: 'Geçerli bir slot belirtilmedi' });
  }
  stopBot(slot);
  res.json({ success: true });
});

app.post('/api/remove', (req, res) => {
  const { slot } = req.body || {};
  if (!slot || !slots[slot]) {
    return res.status(400).json({ error: 'Geçerli bir slot belirtilmedi' });
  }
  removeSlot(slot);
  res.json({ success: true });
});

// Aktif bir botun agzindan sohbete mesaj / komut gonder
app.post('/api/chat', (req, res) => {
  const { slot, message } = req.body || {};

  if (!slot || !slots[slot]) {
    return res.status(400).json({ error: 'Geçerli bir slot belirtilmedi' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Mesaj boş olamaz' });
  }
  const s = slots[slot];
  if (!s.bot || s.status !== 'ONLINE') {
    return res.status(400).json({ error: 'Bot şu an çevrimiçi değil, mesaj gönderilemedi' });
  }

  const trimmed = message.trim().slice(0, 250); // Minecraft chat karakter siniri
  const sent = safeChat(s, trimmed);
  if (!sent) {
    return res.status(500).json({ error: 'Mesaj gönderilemedi' });
  }

  broadcastLog(slot, 'CHAT', `[Sen → ${s.bot.username}] ${trimmed}`);
  res.json({ success: true });
});

// Aktif oyuncular / sunucu bilgisi
app.get('/api/players', (req, res) => {
  const slot = parseInt(req.query.slot);
  if (!slot || !slots[slot]) {
    return res.status(400).json({ error: 'Geçerli bir slot belirtilmedi' });
  }
  const s = slots[slot];
  if (!s.bot || s.status !== 'ONLINE') {
    return res.status(400).json({ error: 'Bot çevrimiçi değil, oyuncu listesi alınamıyor' });
  }

  try {
    const players = Object.keys(s.bot.players || {});
    const info = {
      players,
      playerCount: players.length,
      botUsername: s.bot.username,
      gameMode: s.bot.game ? s.bot.game.gameMode : null,
      dimension: s.bot.game ? s.bot.game.dimension : null,
      difficulty: s.bot.game ? s.bot.game.difficulty : null,
      version: s.bot.version || null,
      health: typeof s.bot.health === 'number' ? s.bot.health : null,
      ip: s.ip,
      port: s.port
    };
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu bilgisi okunamadı: ' + err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ slots: getAllStatuses(), active: activeSlotCount(), max: MAX_BOTS });
});

// ─── Socket.io ────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status_bulk', { slots: getAllStatuses(), active: activeSlotCount(), max: MAX_BOTS });
  socket.emit('log', {
    slot: null,
    type: 'INFO',
    message: 'ToldBot Hosting v2.0 — Bağlandı.',
    timestamp: new Date().toISOString()
  });
});

// ─── Başlat ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`ToldBot Hosting çalışıyor: http://localhost:${PORT}`);
});
