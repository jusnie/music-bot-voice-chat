<!-- Banner -->
<p align="center">
  <img src="https://github.com/sharmavasant/music-bot-voice-chat/blob/main/photo_6086851755703912865_c.jpg" alt="Music Bot Banner" width="100%">
</p>

<!-- Title -->
<h1 align="center">🎵 Telegram Music Bot — Voice Chat Streaming</h1>
<p align="center">
  <b>Play YouTube songs directly into Telegram Voice Chats — Powered by Node.js & GramTGCalls 🎧</b>
</p>

<!-- Badges -->
<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24.x-green?style=for-the-badge&logo=node.js">
  <img src="https://img.shields.io/badge/Telegram%20Bot-API-blue?style=for-the-badge&logo=telegram">
  <img src="https://img.shields.io/badge/YouTube-DL-red?style=for-the-badge&logo=youtube">
  <img src="https://img.shields.io/badge/FFmpeg-7.1.1-orange?style=for-the-badge&logo=ffmpeg">
</p>

---

## 🚀 Features
✅ Play songs directly from **YouTube**  
✅ Stream audio in **Telegram Voice Chat**  
✅ Control with **inline buttons** (⏮ ⏯ ⏭ ⏹)  
✅ Supports **pause/resume/stop/skip**  
✅ Fast downloads using **yt-dlp + FFmpeg**

---

## 🛠 Tech Stack
- **Node.js**
- **Telegram Bot API** (node-telegram-bot-api)
- **GramTGCalls** for streaming
- **yt-dlp** for downloading
- **FFmpeg** for audio conversion

---

## 🔑 What you need (one time)

| Variable | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `API_ID`, `API_HASH` | [my.telegram.org](https://my.telegram.org) → API development tools |
| `SESSION_STRING` | Run `node generate_session.js` on your PC and log in with the **assistant** account (see below) |
| `GOOGLE_DATA_API_KEY` | Google Cloud console → enable *YouTube Data API v3* → create API key |

Optional: `YTDLP_COOKIES`, `FFMPEG_PATH`, `YTDLP_PATH`, `SEND_AUDIO_FILE` (see `.env.example`).

**The assistant account** is a normal Telegram user account (best: a spare one, not your main) that actually joins the voice chat. Bots cannot join voice chats, so the bot sends commands and the assistant plays the music.

To make the session string:
```bash
npm install
cp .env.example .env      # fill API_ID and API_HASH
node generate_session.js  # enter the assistant's phone, code, 2FA
```
Copy the printed string into `SESSION_STRING`. Treat it like a password: anyone with it controls that account.

---

## 👥 Using it in a group (public **or private**)

1. Add the **bot** to the group.
2. Add the **assistant account** to the group. (Or make the bot an admin with *Invite users via link* and it will bring the assistant in by itself.)
3. Recommended: make the assistant an admin with *Manage voice chats* so it can start the voice chat itself. Otherwise start the voice chat manually.
4. Send `/play <song name>`.

Commands: `/play`, `/pause`, `/resume`, `/skip`, `/stop`, plus the inline buttons. Songs played while one is running go into a queue.

---

## ☁️ Run it 24/7 (no PC needed)

Only **one** copy of the bot can run at a time. Stop the one on your PC before starting it on a server, otherwise you get `409 Conflict` errors.

### Option A: Any VPS with Docker (most reliable)
Works on Oracle Cloud Always Free, Hetzner, DigitalOcean, AWS Lightsail, etc.
```bash
# on the server (Ubuntu)
curl -fsSL https://get.docker.com | sh
git clone https://github.com/sharmavasant/music-bot-voice-chat.git
cd music-bot-voice-chat
cp .env.example .env && nano .env     # paste your 5 values
docker compose up -d --build          # starts now and after every reboot
docker compose logs -f                # watch logs
```
Update later with `git pull && docker compose up -d --build`.

### Option B: Railway (no server to manage)
1. Push this folder to a GitHub repo (the `.gitignore` keeps `.env` out of it).
2. railway.com → New Project → Deploy from GitHub repo. It finds the `Dockerfile` automatically.
3. Service → **Variables** → add the 5 variables.
4. Deploy and check the logs for `✅ Bot running` and `✅ Assistant logged in`.

Other Docker hosts (Koyeb, Fly.io, Render background worker) work the same way: point them at the repo, they build the `Dockerfile`, add the variables. If a host insists on a web port, it sets `PORT` and the bot answers health checks on it. Avoid free tiers that sleep when idle (e.g. Render free web services): the bot stops listening while asleep.

### ⚠️ YouTube on servers
YouTube often blocks downloads from data-centre IPs ("Sign in to confirm you're not a bot"). If that happens: export `cookies.txt` from a browser logged into YouTube (use a throwaway Google account), put it on the server, and set `YTDLP_COOKIES=/app/cookies.txt` (uncomment the volume in `docker-compose.yml`).

### Running locally on Windows still works
Install ffmpeg and yt-dlp, then set `FFMPEG_PATH` to your ffmpeg `bin` folder and `YTDLP_PATH` to `yt-dlp.exe` in `.env`, and run `npm start`.

---

## 📸 Demo
<p align="center"> <img src="https://your-demo-gif-or-screenshot-link.gif" width="80%"> </p>

---

## 📜 License
This project is licensed under the MIT License.

<p align="center"> Made with ❤️ by <a href="https://github.com/sharmavasant">Vasant Kumar Sharma</a> </p> 
