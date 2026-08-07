const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const MAX_BOTS = 3;

// ─── Bildirim Sistemi (Discord Webhook) ────────────────────
// Bot kalici bir hatadan durdugunda veya cok sayida basarisiz denemeden
// sonra vazgectiginde, surekli Railway loglarina bakmana gerek kalmadan
// haberdar olman icin opsiyonel bir Discord webhook URL'i ayarlanabilir.
// Bos birakilirsa hicbir sey gonderilmez, sadece normal loglama devam eder.
let notifyWebhookUrl = process.env.DISCORD_WEBHOOK_URL || '';

function sendDiscordNotification(message) {
  if (!notifyWebhookUrl) return;
  try {
    const url = new URL(notifyWebhookUrl);
    const payload = JSON.stringify({ content: message.slice(0, 1900) }); // Discord mesaj limiti guvenlik payi
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 8000
    }, (res) => { res.on('data', () => {}); }); // yaniti tuketip baglantiyi kapat
    req.on('error', (err) => {
      console.log('[Bildirim] Discord webhook gonderilemedi: ' + err.message);
    });
    req.on('timeout', () => { req.destroy(); });
    req.write(payload);
    req.end();
  } catch (e) {
    console.log('[Bildirim] Discord webhook URL geçersiz veya gönderilemedi: ' + e.message);
  }
}

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

// Ayni sunucuya (IP:port) BASKA bir slotun zaten aktif sekilde baglanmaya
// calisip calismadigini kontrol eder. Bu olmadan, iki sekme/hizli cift tiklama
// ayni sunucuya ayni anda 2 farkli bot gondermeye calisip Aternos'un spam
// korumasini (throttle) tetikleyebiliyordu.
function findActiveSlotForServer(ip, port, excludeSlot) {
  const normalizedIp = (ip || '').trim().toLowerCase();
  const normalizedPort = parseInt(port) || 25565;

  for (let i = 1; i <= MAX_BOTS; i++) {
    if (i === excludeSlot) continue;
    const s = slots[i];
    if (!s) continue;
    if (s.status === 'OFFLINE') continue; // durmus slot cakisma sayilmaz
    const sIp = (s.ip || '').trim().toLowerCase();
    const sPort = parseInt(s.port) || 25565;
    if (sIp === normalizedIp && sPort === normalizedPort) {
      return i;
    }
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
        username: slots[i].username || (slots[i].bot ? slots[i].bot.username : null),
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

// ─── Hata / Kick Nedeni Siniflandirici ─────────────────────
// Bilinen TUM yaygin Minecraft/mineflayer/Aternos kick ve baglanti
// hata turlerini tek yerden yonetiyoruz. Bazi hatalar (throttle,
// zaman asimi, sunucu dolu, gecici ag hatasi) tekrar denemekle
// cozulur. Bazilari (whitelist, ban, yanlis IP, online-mode uyusmazligi)
// TEKRAR DENEMEKLE ASLA COZULMEZ - bunlarda saatlerce bosuna
// denemek yerine hemen durup net bir mesaj vermek daha dogru.
function classifyDisconnectReason(rawText) {
  let safeText;
  try {
    safeText = typeof rawText === 'string' ? rawText : (rawText == null ? '' : JSON.stringify(rawText));
  } catch (e) {
    safeText = String(rawText || '');
  }
  const t = safeText.toLowerCase();

  // Kesinlikle tekrar denemekle cozulmeyen durumlar - hemen dur, net sebep soyle
  const permanentPatterns = [
    { match: ['whitelist', 'beyaz liste'], reason: 'Bot whitelist dışında. Aternos panelinden bot kullanıcı adını whitelist\'e ekle veya whitelist\'i kapat.' },
    { match: ['you are banned', 'banned from this server', 'yasakl', 'banned by an operator'], reason: 'Bot bu sunucudan yasaklanmış (ban). Aternos panelinden ban listesinden çıkar.' },
    { match: ['ip banned', 'your ip is banned', 'ip adresiniz'], reason: 'Bu IP adresi sunucudan yasaklanmış (IP ban).' },
    { match: ['failed to verify username', 'invalid session', 'multiplayer.disconnect.unverified_username', 'authentication servers are down'], reason: 'Sunucu online-mode açık, offline bot giremiyor. Aternos panelinden "Online Mode" ayarını kapat.' },
    { match: ['premium account', 'premium hesap', 'you must buy the game', 'not a premium'], reason: 'Sunucu sadece premium (satın alınmış) hesaplara izin veriyor.' },
    { match: ['outdated client', 'multiplayer.disconnect.outdated_client'], reason: 'Sunucu daha eski bir Minecraft sürümü bekliyor, bot sürümü çok yeni.' },
    { match: ['outdated server', 'multiplayer.disconnect.outdated_server'], reason: 'Sunucu daha yeni bir Minecraft sürümü bekliyor, bot sürümü çok eski.' },
    { match: ['incompatible'], reason: 'Sürüm uyuşmazlığı, bu sürüm sunucuyla hiç konuşamıyor.' },
    { match: ['enotfound', 'getaddrinfo'], reason: 'Sunucu adresi (IP) bulunamadı, adresi kontrol et.' },
    { match: ['flying is not enabled', 'flying is not allowed'], reason: 'Sunucu uçmaya izin vermiyor ve bot bunu kaldıramadı (nadir, genelde zararsız).' },
    { match: ['server is restarting', 'server is stopping', 'sunucu kapatiliyor'], reason: 'Sunucu şu an kapatılıyor/yeniden başlatılıyor.' },
    { match: ['this server is not accepting connections', 'baglanti kabul etmiyor'], reason: 'Sunucu şu an yeni bağlantı kabul etmiyor.' },
    { match: ['disabled', 'hesabiniz devre disi', 'account disabled'], reason: 'AuthMe hesabı devre dışı bırakılmış olabilir, sunucu panelinden kontrol et.' },
  ];

  for (const p of permanentPatterns) {
    if (p.match.some(m => t.includes(m))) {
      return { retryable: false, reason: p.reason };
    }
  }

  // Tekrar denenebilir ama OZEL minimum bekleme suresi gereken durumlar
  const throttlePatterns = ['throttled', 'connection throttled', 'too many connections', 'too many logins', 'wait before reconnecting'];
  if (throttlePatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'THROTTLE', minDelayMs: 30000 };
  }

  const serverFullPatterns = ['server is full', 'sunucu dolu', 'is full'];
  if (serverFullPatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'FULL', minDelayMs: 20000 };
  }

  const startingUpPatterns = ['server is starting', 'sunucu baslatiliyor', 'sunucu acilirken', 'please wait while the server', 'spin up'];
  if (startingUpPatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'STARTING', minDelayMs: 15000 };
  }

  const duplicateLoginPatterns = ['already connected', 'zaten baglisin', 'duplicate login', 'you are already on this server'];
  if (duplicateLoginPatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'DUPLICATE', minDelayMs: 15000 };
  }

  const idleKickPatterns = ['afk', 'idle', 'hareketsiz', 'you were kicked for being afk'];
  if (idleKickPatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'IDLE_KICK', minDelayMs: 5000 };
  }

  const networkPatterns = ['econnrefused', 'econnreset', 'etimedout', 'enetunreach', 'ehostunreach', 'socket hang up', 'timed out', 'end of stream', 'epipe', 'read timed out'];
  if (networkPatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'NETWORK', minDelayMs: 0 };
  }

  const protocolPatterns = ['unknown chat format', 'partialreaderror', 'chunk', 'unexpected packet', 'deserialize'];
  if (protocolPatterns.some(m => t.includes(m))) {
    return { retryable: true, category: 'PROTOCOL', minDelayMs: 5000 };
  }

  // Bilinmeyen/genel durum - varsayilan olarak tekrar denenebilir sayilir
  return { retryable: true, category: 'GENERIC', minDelayMs: 0 };
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
  if (s.rotationTimer) {
    clearTimeout(s.rotationTimer);
    s.rotationTimer = null;
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

// Rotasyon acik oldugunda, bot ONLINE olduktan rotationIntervalMs sonra
// bu fonksiyon calisip mevcut hesabi NAZIKCE cikarir ve kisa bir bekleme
// sonrasi (ROTATION_SWITCH_DELAY_MS) yeni rastgele kullanici adiyla tekrar
// baglanir. Bu bir HATA/kick DEGILDIR, bu yuzden consecutiveFailures'i
// ARTIRMAZ - backoff sayacini etkilemez.
function scheduleAccountRotation(slotId) {
  const s = slots[slotId];
  if (!s || !s.rotationEnabled || s.isDestroyed) return;
  if (s.rotationTimer) clearTimeout(s.rotationTimer);

  const interval = Math.max(MIN_ROTATION_INTERVAL_MS, s.rotationIntervalMs || DEFAULT_ROTATION_INTERVAL_MS);
  s.rotationTimer = setTimeout(() => {
    const current = slots[slotId];
    if (!current || current.isDestroyed || !current.rotationEnabled) return;

    current.rotationCount = (current.rotationCount || 0) + 1;
    const oldUsername = current.bot ? current.bot.username : '?';
    broadcastLog(slotId, 'INFO', `🔄 Planlı hesap rotasyonu (#${current.rotationCount}): ${oldUsername} çıkıyor, ${(ROTATION_SWITCH_DELAY_MS / 1000).toFixed(0)} saniye sonra yeni hesapla giriş yapılacak.`);

    if (current.bot) {
      try { current.bot.removeAllListeners(); } catch (e) {}
      try { current.bot.quit(); } catch (e) {}
      current.bot = null;
    }
    current.status = 'CONNECTING';
    current.loginSent = false;
    current.authCompleted = false;
    // GERCEK rotasyon icin yeni bir kullanici adi gerekiyor - normalde
    // reconnect'lerde ayni isim korunur (AuthMe karismasin diye), ama
    // rotasyon BILEREK farkli bir kimlige geciyor, o yuzden burada ozel
    // olarak sifirliyoruz.
    current.username = null;
    // Yeni kimlik bu sunucuda HENUZ KAYITLI DEGIL - eskisi kayitliydi ama
    // bu farkli bir hesap, o yuzden /login degil /register denemesi lazim.
    current.alreadyRegistered = false;
    broadcastStatus(slotId, 'CONNECTING', null, current.ip);

    setTimeout(() => {
      const stillHere = slots[slotId];
      if (!stillHere || stillHere.isDestroyed || !stillHere.rotationEnabled) return;
      startBot(slotId, { ip: stillHere.ip, port: stillHere.port, alreadyRegistered: false, rotationEnabled: true, rotationIntervalMs: stillHere.rotationIntervalMs });
    }, ROTATION_SWITCH_DELAY_MS);
  }, interval);
}

// ─── Bot Başlat ─────────────────────────────────────────────
function startBot(slotId, config) {
  if (!slots[slotId]) {
    slots[slotId] = {
      slotId,
      bot: null,
      username: null,
      ip: config.ip,
      port: config.port,
      alreadyRegistered: config.alreadyRegistered,
      status: 'CONNECTING',
      reconnectTimer: null,
      pendingStartTimer: null,
      isDestroyed: false,
      reconnectScheduled: false,
      loginSent: false,
      authCompleted: false,
      consecutiveFailures: 0, // exponential backoff icin - basarili baglantida sifirlanir
      preSpawnFailCount: 0, // spawn'a hic ulasamadan art arda BELIRSIZ kopma sayisi (sessiz auth/session reddi tespiti icin)
      rotationEnabled: false,
      rotationIntervalMs: DEFAULT_ROTATION_INTERVAL_MS,
      rotationTimer: null,
      rotationCount: 0 // kac kez hesap degistirildi (bilgi amacli)
    };
  }
  const s = slots[slotId];
  s.ip = config.ip;
  s.port = config.port;
  // alreadyRegistered SADECE ilk baslatmada kullanicidan gelen degerle
  // ayarlanir. Bir kez basariyla kayit olduktan sonra otomatik true'ya
  // cekiyoruz (asagida) - boylece sonraki reconnect'lerde tekrar /register
  // denemez (ki zaten kayitli oldugu icin reddedilirdi), direkt /login yapar.
  if (typeof config.alreadyRegistered === 'boolean') {
    s.alreadyRegistered = config.alreadyRegistered;
  }
  if (typeof config.rotationEnabled === 'boolean') {
    s.rotationEnabled = config.rotationEnabled;
  }
  if (config.rotationIntervalMs) {
    s.rotationIntervalMs = config.rotationIntervalMs;
  }
  s.isDestroyed = false;
  s.reconnectScheduled = false;
  s.loginSent = false;
  s.authCompleted = false;
  s.status = 'CONNECTING';

  // Kullanici adi SLOT BASINA SABIT: ilk baslatmada bir kez uretilir,
  // sonraki TUM reconnect'lerde ayni isim kullanilir. Onceden her
  // reconnect'te yeni rastgele isim uretiliyordu, bu da sunucu tarafinda
  // sanki surekli FARKLI oyuncular giriyormus gibi gorunmesine ve
  // AuthMe'nin her seferinde yeni/bos bir hesap sanmasina yol aciyordu.
  if (!s.username) {
    s.username = 'ToldBot_' + (Math.floor(Math.random() * 9000) + 1000);
  }
  const username = s.username;

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
        hideErrors: true, // mineflayer'in kendi ham/basliksiz stack trace dokumlerini kapat -
                           // bot.on('error') zaten her seyi yakalayip temiz [Slot N] formatinda logluyor,
                           // ikisi ayni hatayi iki kez (biri cirkin, biri temiz) basiyordu
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
    const creationErrMsg = creationError ? creationError.message : 'bilinmeyen hata';
    broadcastLog(slotId, 'ERROR', 'Bot oluşturulamadı: ' + creationErrMsg);
    s.status = 'OFFLINE';
    broadcastStatus(slotId, 'OFFLINE', null, config.ip);
    scheduleReconnect(slotId, 'Bot oluşturulamadı.', creationErrMsg);
    return;
  }

  s.bot = botInstance;
  let didSpawnThisAttempt = false; // bu spesifik baglanti denemesinde spawn olundu mu

  // ─── Spawn ─────────────────────────────────────────────
  botInstance.once('spawn', () => {
    didSpawnThisAttempt = true;
    s.preSpawnFailCount = 0; // spawn olduysa auth/session sorunu yok, sayaci sifirla
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
          s.consecutiveFailures = 0; // basarili baglanti - backoff sayacini sifirla
          s.alreadyRegistered = true; // artik bu sunucuda kayitli - sonraki reconnect'ler /login kullansin, /register degil
          broadcastStatus(slotId, 'ONLINE', s.bot.username, s.ip);
          if (s.rotationEnabled) {
            const mins = Math.round((s.rotationIntervalMs || DEFAULT_ROTATION_INTERVAL_MS) / 60000);
            broadcastLog(slotId, 'INFO', `🔄 Hesap rotasyonu açık: yaklaşık ${mins} dakikada bir otomatik hesap değişecek.`);
            scheduleAccountRotation(slotId);
          }
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
    const rawMsg = err && err.message ? err.message : String(err);
    const errCode = err && err.code ? err.code : '';
    broadcastLog(slotId, 'ERROR', 'Hata: ' + rawMsg + (errCode ? ` (${errCode})` : ''));
    // 'error' bazen tek basina gelir, 'end'/'kicked' hic tetiklenmeyebilir.
    // Bu durumda bot sonsuza kadar "CONNECTING" durumunda asili kalmasin.
    scheduleReconnect(slotId, `Bağlantı hatası: ${rawMsg}.`, rawMsg + ' ' + errCode);
  });

  // ─── Bağlantı Kesildi / Kick ───────────────────────────
  botInstance.on('end', (reason) => {
    scheduleReconnect(slotId, `Bağlantı kesildi${reason ? ': ' + reason : ''}.`, reason, !didSpawnThisAttempt);
  });

  botInstance.on('kicked', (reason) => {
    let reasonText = '';
    if (typeof reason === 'string') {
      try {
        const parsed = JSON.parse(reason);
        if (typeof parsed === 'string') {
          reasonText = parsed; // sunucu duz bir JSON string gondermis (orn: "Connection throttled!")
        } else {
          reasonText = parsed?.text || parsed?.translate || reason;
        }
      } catch (e) {
        reasonText = reason; // JSON degil, duz metin - oldugu gibi kullan
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
    scheduleReconnect(slotId, `Sunucudan atıldı: ${reasonText}.`, reasonText);
  });
}

// NOT: 'end' ve 'kicked' bazen AYNI kopma icin ikisi de tetiklenir.
// reconnectScheduled kilidi olmadan bu iki kez startBot() cagirir,
// ayni slotta iki farkli bot ayni anda baglanmaya calisir.
//
// EXPONENTIAL BACKOFF: Aternos "Connection throttled" cezasi bizim sabit
// 10-20sn bekleme suremizden UZUN surebiliyor. Bu durumda her deneme
// tekrar cezalaniyor ve bot hic gercek baglanma sansi bulamadan sonsuz
// dongu + sunucuda "hayalet" baglanti spam'i olusuyordu. Art arda
// basarisizlikta bekleme suresini katlayarak artiriyoruz (max 3 dakika),
// basarili girişte sifirliyoruz.
const BASE_DELAY_MS = 10000;
const MAX_DELAY_MS = 180000; // 3 dakika tavan
const MAX_CONSECUTIVE_FAILURES = 10; // bu kadar art arda basarisizliktan sonra otomatik dur

const MAX_PRE_SPAWN_GENERIC_FAILS = 4; // spawn'a hic ulasamadan bu kadar BELIRSIZ kopma -> muhtemelen online-mode/session reddi

// ─── Hesap Rotasyonu ────────────────────────────────────────
// Ayni sunucuya surekli AYNI kullanici adiyla saatlerce baglı kalmak yerine,
// belirli araliklarla NAZIKCE cikip yeni bir kimlikle (rastgele yeni ToldBot_XXXX
// kullanici adi) tekrar giriliyor. Bu ASLA ayni anda 2 bagli hesap anlamina
// gelmez - once mevcut baglanti nazikce kapatilir, KISA bir bekleme sonrasi
// (spam sayilmayacak sekilde) yenisi baslar. Varsayilan kapali (rotationEnabled).
const DEFAULT_ROTATION_INTERVAL_MS = 30 * 60 * 1000; // 30 dakika
const MIN_ROTATION_INTERVAL_MS = 10 * 60 * 1000; // kullanici daha kisa bir sure girse bile 10 dakikanin altina inilmez (spam olmasin diye)
const ROTATION_SWITCH_DELAY_MS = 8000; // eski hesap cikip yenisi girene kadar nazik bir bekleme

function scheduleReconnect(slotId, reasonLabel, rawReasonText, isPreSpawnGenericFail) {
  const s = slots[slotId];
  if (!s || s.isDestroyed || s.reconnectScheduled) return;

  const classification = classifyDisconnectReason(rawReasonText || reasonLabel || '');

  // Sessiz auth/session reddi tespiti: bazi sunucular ("Online Mode" acikken)
  // botu login asamasinda, hicbir anlamli metin gondermeden, sadece soketi
  // kapatarak reddediyor ("socketClosed" gibi belirsiz bir 'end' nedeni).
  // Boyle bir durumda text-tabanli siniflandirici hicbir sey yakalayamaz ve
  // bot sonsuza kadar (throttle'a da carpa carpa) boşuna denemeye devam eder.
  // Ayni sey art arda N kez, hic spawn olmadan yasanirsa, muhtemelen bu
  // durumdur - dur ve net ac ikla.
  if (isPreSpawnGenericFail && classification.category === 'GENERIC') {
    s.preSpawnFailCount = (s.preSpawnFailCount || 0) + 1;
    if (s.preSpawnFailCount >= MAX_PRE_SPAWN_GENERIC_FAILS) {
      broadcastLog(slotId, 'ERROR', `${reasonLabel} Bot spawn olamadan art arda ${MAX_PRE_SPAWN_GENERIC_FAILS} kez belirsiz şekilde koptu. Bu genellikle sunucunun "Online Mode" ayarının açık olmasından kaynaklanır (offline bot giremez). Aternos panelinden bu sunucunun "Online Mode" ayarını KAPAT. Bot durduruldu, tekrar denenmeyecek.`);
      stopBot(slotId);
      return;
    }
  } else if (classification.category !== 'GENERIC' || !isPreSpawnGenericFail) {
    s.preSpawnFailCount = 0; // baska turden bir olay oldu, sayaci sifirla
  }

  // Kalici hata (whitelist, ban, online-mode uyusmazligi, yanlis IP vb.)
  // - tekrar denemek zaman kaybi, hemen dur ve net sebebi soyle
  if (!classification.retryable) {
    const msg = `${reasonLabel} KALICI HATA: ${classification.reason} Bot durduruldu, tekrar denenmeyecek.`;
    broadcastLog(slotId, 'ERROR', msg);
    sendDiscordNotification(`⛔ **ToldBot - Slot ${slotId} (${s.ip})**\n${msg}`);
    stopBot(slotId);
    return;
  }

  s.reconnectScheduled = true;
  s.consecutiveFailures = (s.consecutiveFailures || 0) + 1;

  if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const throttleNote = classification.category === 'THROTTLE'
      ? ' Bu durum genellikle Aternos\'un IP\'ni geçici olarak sınırlamasından kaynaklanır (bot hatası değil) - 15-30 dakika bekleyip tekrar dene.'
      : '';
    const msg = `${reasonLabel} ${MAX_CONSECUTIVE_FAILURES} kez art arda başarısız oldu, otomatik olarak durduruldu.${throttleNote} Sunucu IP'sini/durumunu kontrol edip tekrar başlat.`;
    broadcastLog(slotId, 'ERROR', msg);
    sendDiscordNotification(`⚠️ **ToldBot - Slot ${slotId} (${s.ip})**\n${msg}`);
    s.reconnectScheduled = false;
    stopBot(slotId);
    return;
  }

  const exponentialPart = BASE_DELAY_MS * Math.pow(1.8, s.consecutiveFailures - 1);
  const jitter = Math.floor(Math.random() * 5000);
  let delayMs = Math.min(MAX_DELAY_MS, Math.floor(exponentialPart) + jitter);
  if (classification.minDelayMs) {
    delayMs = Math.max(delayMs, classification.minDelayMs); // throttle/dolu gibi durumlarda minimum bekleme garantisi
  }
  const delaySec = (delayMs / 1000).toFixed(1);
  const categoryTag = classification.category ? ` [${classification.category}]` : '';

  broadcastLog(slotId, 'RECONNECT', `${reasonLabel}${categoryTag} (${s.consecutiveFailures}. deneme) ${delaySec} saniye içinde yeniden bağlanılıyor...`);
  s.status = 'CONNECTING';
  broadcastStatus(slotId, 'CONNECTING', s.username, s.ip);
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
  let { ip, port = 25565, alreadyRegistered = false, slot, rotationEnabled = false, rotationIntervalMs } = req.body || {};

  if (!ip || typeof ip !== 'string' || !ip.trim()) {
    return res.status(400).json({ error: 'Sunucu IP adresi gerekli' });
  }

  // Rotasyon suresi kullanicidan gelirse minimum siniri (spam olmamasi icin) uygula
  if (rotationIntervalMs) {
    rotationIntervalMs = Math.max(MIN_ROTATION_INTERVAL_MS, parseInt(rotationIntervalMs) || DEFAULT_ROTATION_INTERVAL_MS);
  } else {
    rotationIntervalMs = DEFAULT_ROTATION_INTERVAL_MS;
  }

  // Kullanici IP alanina yanlislikla "host:port" seklinde port'u da
  // yazmis olabilir (orn. "berkay303.aternos.me:32192"). Bunu ayiklamazsak
  // hostname'e port bir daha eklenip "host:port:port" gibi GECERSIZ bir
  // adres olusuyor ve DNS cozumlemesi (ENOTFOUND) basarisiz oluyor.
  ip = ip.trim();
  const ipPortMatch = ip.match(/^([^:\s]+):(\d{1,5})$/);
  if (ipPortMatch) {
    ip = ipPortMatch[1];
    // Kullanici ayri bir port alani da doldurmus olabilir; IP icindeki
    // port'u esas alalim cunku kullanicinin asil yazdigi yer burasi.
    port = parseInt(ipPortMatch[2]) || port;
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

  // AYNI SUNUCUYA baska bir slottan zaten aktif baglanti/deneme varsa reddet.
  // Bu olmadan iki sekme/hizli cift tiklama ayni sunucuya (orn. toldsmp.aternos.me)
  // ayni anda 2 bot gondermeye calisip Aternos'un spam korumasini (throttle)
  // tetikliyordu - onceki "11 bot" olayinin gercek nedeni buydu.
  const conflictingSlot = findActiveSlotForServer(ip.trim(), port, targetSlot);
  if (conflictingSlot) {
    return res.status(400).json({
      error: `Bu sunucuya (${ip.trim()}) zaten Slot ${conflictingSlot}'te bağlı/bağlanıyor bir bot var. Aynı sunucuya aynı anda 2 bot göndermek Aternos'u tetikleyip cezalandırıyor. Önce Slot ${conflictingSlot}'i durdur, sonra tekrar dene.`
    });
  }

  // O slotun her turlu onceki durumunu (bot calisiyor olsun ya da
  // reconnect bekliyor olsun) tamamen temizle. Bu, art arda hizli
  // /api/start cagrilarinda ayni slotta iki botun ayni anda
  // acilmasini engeller.
  if (slots[targetSlot]) {
    stopBot(targetSlot);
  }

  const finalSlot = targetSlot;
  const config = { ip: ip.trim(), port, alreadyRegistered: !!alreadyRegistered, rotationEnabled: !!rotationEnabled, rotationIntervalMs };

  if (!slots[finalSlot]) {
    slots[finalSlot] = {
      slotId: finalSlot,
      bot: null,
      username: null,
      ip: config.ip,
      port: config.port,
      alreadyRegistered: config.alreadyRegistered,
      status: 'CONNECTING',
      reconnectTimer: null,
      pendingStartTimer: null,
      isDestroyed: false,
      reconnectScheduled: false,
      loginSent: false,
      authCompleted: false,
      consecutiveFailures: 0,
      preSpawnFailCount: 0,
      rotationEnabled: config.rotationEnabled,
      rotationIntervalMs: config.rotationIntervalMs,
      rotationTimer: null,
      rotationCount: 0
    };
  } else if (slots[finalSlot].ip !== config.ip || slots[finalSlot].port !== config.port) {
    // Bu slot BASKA bir sunucuya yonlendiriliyor - eski kullanici adi/kayit
    // durumu yeni sunucuyla alakasiz, temiz bir kimlikle basla
    slots[finalSlot].username = null;
    slots[finalSlot].alreadyRegistered = config.alreadyRegistered;
  }
  slots[finalSlot].rotationEnabled = config.rotationEnabled;
  slots[finalSlot].rotationIntervalMs = config.rotationIntervalMs;
  slots[finalSlot].isDestroyed = false;
  slots[finalSlot].consecutiveFailures = 0; // kullanici bilerek yeniden basladi, backoff sayacini sifirla

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
  res.json({ slots: getAllStatuses(), active: activeSlotCount(), max: MAX_BOTS, webhookConfigured: !!notifyWebhookUrl });
});

// Discord webhook URL'ini ayarla/kaldir. Bos string gonderilirse bildirimler kapatilir.
app.post('/api/webhook', (req, res) => {
  const { webhookUrl } = req.body || {};
  if (webhookUrl && typeof webhookUrl === 'string' && webhookUrl.trim()) {
    try {
      const parsed = new URL(webhookUrl.trim());
      if (!parsed.hostname.includes('discord')) {
        return res.status(400).json({ error: 'Sadece Discord webhook URL\'leri destekleniyor (discord.com/api/webhooks/...)' });
      }
      notifyWebhookUrl = webhookUrl.trim();
      sendDiscordNotification('✅ ToldBot Hosting bildirimleri bu kanala bağlandı.');
      return res.json({ success: true, configured: true });
    } catch (e) {
      return res.status(400).json({ error: 'Geçersiz URL' });
    }
  } else {
    notifyWebhookUrl = '';
    return res.json({ success: true, configured: false });
  }
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
