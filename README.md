# ⛏ ToldBot Hosting

Ücretsiz 7/24 Minecraft Bot Hosting. Gerçek mineflayer botu, otomatik register/login, reconnect.

---

## 🚀 Railway'e Deploy (Önerilen — En Kolay)

1. [railway.app](https://railway.app) → GitHub ile kayıt ol
2. **"New Project"** → **"Deploy from GitHub repo"**
3. Bu klasörü GitHub'a yükle veya zip olarak aç
4. Railway otomatik algılar ve `npm start` çalıştırır
5. **Settings → Networking → Generate Domain** → linkin hazır!

> Railway ücretsiz planda ayda 5$ kredi veriyor, küçük bir bot için yeterli.

---

## 🟢 Render'a Deploy (Alternatif — Tamamen Ücretsiz)

1. [render.com](https://render.com) → GitHub ile kayıt ol
2. **"New"** → **"Web Service"**
3. GitHub repo'nu bağla
4. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** `Node`
5. **"Create Web Service"** → deploy başlar
6. Birkaç dakika sonra link hazır

> Render ücretsiz planda 15 dakika işlem olmadığında uyku moduna girer.
> Aktif tutmak için [UptimeRobot](https://uptimerobot.com) ile ping ekleyebilirsin.

---

## 💻 Lokal Çalıştırma

```bash
npm install
node server.js
# http://localhost:3000 adresini aç
```

---

## 🤖 Bot Nasıl Çalışır?

1. Sunucu IP + Port gir → **🚀 BOTU BAŞLAT**
2. Bot `ToldBot_XXXX` adıyla sunucuya bağlanır
3. Spawn olunca `/register` veya `/login` gönderir
4. "Zaten kayıtlı mısın?" toggle'ını aç → direkt `/login` yapar
5. Giriş başarılıysa `/spawn` + karşılama mesajı gönderir
6. Bağlantı kesilirse 5 saniye içinde otomatik yeniden bağlanır
7. Tüm loglar terminal'de gerçek zamanlı görünür

---

## 📦 Bağımlılıklar

- `express` — Web sunucusu
- `socket.io` — Gerçek zamanlı log yayını
- `mineflayer` — Gerçek Minecraft bot kütüphanesi
