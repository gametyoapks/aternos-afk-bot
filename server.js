const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Bot Durumu ───────────────────────────────────────────
let bot = null;
let botConfig = null;
let reconnectTimer = null;
let isDestroyed = false;

// ─── Log Yayını ───────────────────────────────────────────
function emitLog(type, message) {
  const entry = { type, message, timestamp: new Date().toISOString() };
  console.log(`[${type}] ${message}`);
  io.emit('log', entry);
}

function emitStatus(status, username) {
  io.emit('status', { status, username: username || null });
}

// ─── Bot Durdur ───────────────────────────────────────────
function stopBot() {
  isDestroyed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (bot) {
    try { bot.quit(); } catch (e) {}
    bot = null;
  }
  emitStatus('OFFLINE');
  emitLog('INFO', 'Bot durduruldu.');
}

// ─── Bot Başlat ───────────────────────────────────────────
function startBot(config) {
  botConfig = config;
  isDestroyed = false;

  const username = 'ToldBot_' + (Math.floor(Math.random() * 9000) + 1000);

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
    });
  } catch (err) {
    emitLog('ERROR', 'Bot oluşturulamadı: ' + err.message);
    emitStatus('OFFLINE');
    return;
  }

  // ─── Spawn ─────────────────────────────────────────────
  bot.once('spawn', () => {
    emitLog('INFO', 'Sunucuya bağlandı! Spawn bekleniyor (2 saniye)...');

    setTimeout(() => {
      if (!bot || isDestroyed) return;

      if (config.alreadyRegistered) {
        emitLog('AUTH', '/login bot123456789 gönderiliyor...');
        bot.chat('/login bot123456789');
      } else {
        emitLog('AUTH', '/register bot123456789 bot123456789 gönderiliyor...');
        bot.chat('/register bot123456789 bot123456789');
      }
    }, 2000);
  });

  // ─── Chat ──────────────────────────────────────────────
  bot.on('chat', (sender, message) => {
    const msg = (message || '').toLowerCase();
    emitLog('CHAT', `[${sender}] ${message}`);

    // Zaten kayıtlı mesajları → login
    if (
      msg.includes('already registered') ||
      msg.includes('already') ||
      msg.includes('zaten') ||
      msg.includes('kayitli') ||
      msg.includes('kayıtlı')
    ) {
      setTimeout(() => {
        if (!bot || isDestroyed) return;
        emitLog('AUTH', 'Hesap mevcut, giriş yapılıyor: /login bot123456789');
        bot.chat('/login bot123456789');
      }, 1000);
    }

    // Başarılı giriş mesajları → spawn + mesaj
    if (
      msg.includes('logged in') ||
      msg.includes('welcome back') ||
      msg.includes('authenticated') ||
      msg.includes('giris') ||
      msg.includes('giriş') ||
      msg.includes('basarili') ||
      msg.includes('başarılı') ||
      msg.includes('hosgeldin') ||
      msg.includes('hoşgeldin') ||
      msg.includes('kayit') ||
      msg.includes('kayıt')
    ) {
      emitLog('AUTH', 'Kimlik doğrulama başarılı!');

      setTimeout(() => {
        if (!bot || isDestroyed) return;
        emitLog('SPAWN', '/spawn komutu gönderiliyor...');
        bot.chat('/spawn');

        setTimeout(() => {
          if (!bot || isDestroyed) return;
          emitLog('CHAT', 'Karşılama mesajı gönderiliyor...');
          bot.chat('thanks for using toldbothosting 7/24!');
          emitLog('INFO', '✓ Bot tamamen aktif, 7/24 çalışıyor!');
          emitStatus('ONLINE', bot.username);
        }, 2000);
      }, 3000);
    }
  });

  // ─── Sistem Mesajları (AuthMe vb) ──────────────────────
  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().toLowerCase();

    if (
      text.includes('already registered') ||
      text.includes('zaten kayit') ||
      text.includes('zaten kayıt')
    ) {
      setTimeout(() => {
        if (!bot || isDestroyed) return;
        emitLog('AUTH', 'Hesap mevcut, giriş yapılıyor...');
        bot.chat('/login bot123456789');
      }, 1000);
    }

    if (
      text.includes('logged in') ||
      text.includes('authenticated') ||
      text.includes('welcome') ||
      text.includes('hosgeldin') ||
      text.includes('hoşgeldin') ||
      text.includes('successfully') ||
      text.includes('basarili') ||
      text.includes('başarıyla')
    ) {
      emitLog('AUTH', 'Sistem: Kimlik doğrulama başarılı!');

      setTimeout(() => {
        if (!bot || isDestroyed) return;
        bot.chat('/spawn');
        emitLog('SPAWN', '/spawn komutu gönderildi');

        setTimeout(() => {
          if (!bot || isDestroyed) return;
          bot.chat('thanks for using toldbothosting 7/24!');
          emitLog('INFO', '✓ Bot tamamen aktif!');
          emitStatus('ONLINE', bot.username);
        }, 2000);
      }, 3000);
    }
  });

  // ─── Hata ──────────────────────────────────────────────
  bot.on('error', (err) => {
    emitLog('ERROR', 'Hata: ' + err.message);
  });

  // ─── Bağlantı Kesildi / Kick ───────────────────────────
  bot.on('end', (reason) => {
    if (isDestroyed) return;
    emitLog('RECONNECT', `Bağlantı kesildi${reason ? ': ' + reason : ''}. 5 saniye içinde yeniden bağlanılıyor...`);
    emitStatus('CONNECTING');
    bot = null;

    reconnectTimer = setTimeout(() => {
      if (isDestroyed) return;
      emitLog('RECONNECT', 'Yeniden bağlanılıyor...');
      startBot(botConfig);
    }, 5000);
  });

  bot.on('kicked', (reason) => {
    if (isDestroyed) return;
    let reasonText = '';
    try { reasonText = JSON.parse(reason)?.text || reason; } catch(e) { reasonText = reason; }
    emitLog('RECONNECT', `Sunucudan atıldı: ${reasonText}. 5 saniye içinde yeniden bağlanılıyor...`);
    emitStatus('CONNECTING');
    bot = null;

    reconnectTimer = setTimeout(() => {
      if (isDestroyed) return;
      emitLog('RECONNECT', 'Yeniden bağlanılıyor...');
      startBot(botConfig);
    }, 5000);
  });
}

// ─── API ──────────────────────────────────────────────────
app.post('/api/start', (req, res) => {
  const { ip, port = 25565, alreadyRegistered = false } = req.body;

  if (!ip || !ip.trim()) {
    return res.status(400).json({ error: 'Sunucu IP adresi gerekli' });
  }

  // Mevcut botu durdur
  if (bot) stopBot();

  setTimeout(() => {
    startBot({ ip: ip.trim(), port, alreadyRegistered });
    res.json({ success: true, message: 'Bot başlatıldı' });
  }, 500);
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
  // Mevcut durumu yeni bağlanan istemciye gönder
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
