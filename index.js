require("dotenv").config();
// Silences node-telegram-bot-api's harmless file content-type warning.
process.env.NTBA_FIX_350 = "1";

const TelegramBot = require("node-telegram-bot-api");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { GramTGCalls } = require("tgcalls-gramjs");
const axios = require("axios");
const child_process = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Config (all from environment variables, so it runs the same on any host)
// ---------------------------------------------------------------------------
const REQUIRED = ["TELEGRAM_BOT_TOKEN", "API_ID", "API_HASH", "SESSION_STRING", "GOOGLE_DATA_API_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
}

const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";      // yt-dlp binary (on PATH in Docker)
const FFMPEG_PATH = process.env.FFMPEG_PATH || "";          // folder or binary; empty = use ffmpeg on PATH
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || "";      // optional cookies.txt path (helps when YouTube blocks server IPs)
const SEND_AUDIO_FILE = (process.env.SEND_AUDIO_FILE || "true") !== "false";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), "music-bot");
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
let botUsername = "";

// ---------------------------------------------------------------------------
// Assistant (userbot) client — this is the account that actually joins the VC
// ---------------------------------------------------------------------------
let client = null;

async function initClient() {
    if (client) return client;
    const c = new TelegramClient(
        new StringSession(process.env.SESSION_STRING),
        parseInt(process.env.API_ID, 10),
        process.env.API_HASH,
        { connectionRetries: 10, autoReconnect: true }
    );
    // connect() never asks for a phone number, so a bad session fails loudly
    // instead of hanging forever waiting for keyboard input on a server.
    await c.connect();
    if (!(await c.checkAuthorization())) {
        throw new Error("SESSION_STRING is invalid or expired. Run `node generate_session.js` on your PC and update it.");
    }
    const me = await c.getMe();
    console.log(`✅ Assistant logged in as ${me.username ? "@" + me.username : me.firstName} (id ${me.id})`);
    // Load every chat the assistant is in, so private groups (which have no
    // @username) can be resolved by their numeric ID.
    await c.getDialogs({});
    client = c;
    return client;
}

/**
 * Turn a Bot API chat id (e.g. -1001234567890) into an entity the assistant
 * can use. Private groups have no username, so we must resolve by ID, and that
 * only works if the assistant is a member and the chat is in its cache.
 */
async function resolveChat(chatId) {
    const c = await initClient();
    const tryGet = async () => {
        try {
            return await c.getEntity(chatId);
        } catch {
            return null;
        }
    };

    let entity = await tryGet();
    if (entity) return entity;

    // Maybe the assistant joined recently: refresh the dialog cache and retry.
    await c.getDialogs({});
    entity = await tryGet();
    if (entity) return entity;

    // Not a member: if the bot is an admin with "Invite users" rights,
    // create an invite link and have the assistant join with it.
    try {
        const link = await bot.exportChatInviteLink(chatId);
        const hash = link.split("/").pop().replace(/^\+/, "");
        try {
            await c.invoke(new Api.messages.ImportChatInvite({ hash }));
        } catch (err) {
            if (!String(err.errorMessage || err.message).includes("USER_ALREADY_PARTICIPANT")) throw err;
        }
        await c.getDialogs({});
        entity = await tryGet();
        if (entity) return entity;
    } catch (err) {
        console.warn("Auto-join failed:", err.message || err);
    }
    return null;
}

/** Make sure a voice chat is running; start one if the assistant is allowed to. */
async function ensureVoiceChat(entity) {
    const c = await initClient();
    const full = entity instanceof Api.Channel
        ? (await c.invoke(new Api.channels.GetFullChannel({ channel: entity }))).fullChat
        : (await c.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))).fullChat;
    if (full.call) return true;
    try {
        await c.invoke(new Api.phone.CreateGroupCall({
            peer: entity,
            randomId: Math.floor(Math.random() * 0x7fffffff),
        }));
        return true;
    } catch (err) {
        console.warn("Could not start voice chat:", err.errorMessage || err.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Per-chat player state (the old code used ONE global call hard-wired to a
// single public group — that is why private groups never worked)
// ---------------------------------------------------------------------------
/** @type {Map<number, {tg: GramTGCalls, queue: any[], current: any, ffmpeg: any}>} */
const players = new Map();

async function getPlayer(chatId) {
    if (players.has(chatId)) return players.get(chatId);
    const entity = await resolveChat(chatId);
    if (!entity) return null;
    const player = { tg: new GramTGCalls(client, entity), entity, queue: [], current: null, ffmpeg: null };
    players.set(chatId, player);
    return player;
}

function ffmpegBin() {
    if (!FFMPEG_PATH) return "ffmpeg";
    const isDir = fs.existsSync(FFMPEG_PATH) && fs.statSync(FFMPEG_PATH).isDirectory();
    return isDir ? path.join(FFMPEG_PATH, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg") : FFMPEG_PATH;
}

function cleanup(track) {
    if (track && track.filePath) fs.unlink(track.filePath, () => {});
}

async function playNext(chatId) {
    const player = players.get(chatId);
    if (!player) return;
    if (player.ffmpeg) { player.ffmpeg.kill("SIGKILL"); player.ffmpeg = null; }
    cleanup(player.current);
    player.current = player.queue.shift() || null;

    if (!player.current) {
        players.delete(chatId); // delete first: stop() fires onFinish again
        await player.tg.stop().catch(() => {});
        bot.sendMessage(chatId, "✅ Queue finished, left the voice chat.");
        return;
    }

    const track = player.current;
    // Convert to the raw PCM format tgcalls expects. We spawn ffmpeg ourselves
    // (instead of tg.streamAudio) so errors are caught and we know when it ends.
    const ff = child_process.spawn(ffmpegBin(), [
        "-loglevel", "error", "-i", track.filePath,
        "-f", "s16le", "-ac", "1", "-ar", "65000", "pipe:1",
    ]);
    player.ffmpeg = ff;
    ff.on("error", (err) => {
        console.error("ffmpeg failed to start:", err.message);
        bot.sendMessage(chatId, `❌ ffmpeg not found (${err.message}). Check FFMPEG_PATH in .env.`);
    });
    ff.stderr.on("data", (d) => console.error("ffmpeg:", d.toString().trim()));

    try {
        await player.tg.stream({
            readable: ff.stdout,
            listeners: {
                // tgcalls keeps one stream per call and swaps the source on
                // each new song, so this fires whenever the current song ends.
                onFinish: () => playNext(chatId).catch(console.error),
                onError: (e) => console.error("stream error:", e),
            },
        }, undefined, { join: { videoStopped: true }, media: {} });
    } catch (err) {
        console.error("Failed to join voice chat:", err);
        const msg = String(err.message || err).includes("No active call")
            ? "❌ No voice chat is running. Start the voice chat in this group (or make the assistant an admin with 'Manage voice chats') and try again."
            : `❌ Could not join the voice chat: ${err.errorMessage || err.message}`;
        bot.sendMessage(chatId, msg);
        cleanup(track);
        player.queue.forEach(cleanup);
        players.delete(chatId);
        return;
    }

    bot.sendMessage(chatId, `▶️ Started Streaming\n\n🎵 Title: ${track.title}`, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "⏯️", callback_data: "pause" },
                    { text: "⏭️", callback_data: "skip" },
                    { text: "⏹️", callback_data: "stop" },
                    { text: "▶️", callback_data: "play" },
                ],
                [{ text: "Close", callback_data: "close" }],
            ],
        },
    });
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------
// Returns up to 5 results so we can fall back if one video is blocked or
// unavailable in the server's region.
async function ytSearch(query) {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: { part: "snippet", q: query, key: process.env.GOOGLE_DATA_API_KEY, maxResults: 5, type: "video", videoEmbeddable: "true" },
    });
    return (response.data.items || []).map((it) => ({
        videoId: it.id.videoId,
        title: it.snippet.title,
        url: `https://www.youtube.com/watch?v=${it.id.videoId}`,
    }));
}

function download(videoUrl, filePath) {
    const args = ["-x", "--audio-format", "mp3", "--no-playlist", "-o", filePath];
    if (FFMPEG_PATH) args.push("--ffmpeg-location", FFMPEG_PATH);
    if (YTDLP_COOKIES) args.push("--cookies", YTDLP_COOKIES);
    args.push(videoUrl);
    return new Promise((resolve, reject) => {
        child_process.execFile(YTDLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || error.message));
            resolve();
        });
    });
}

// ---------------------------------------------------------------------------
// Commands — regexes also accept "/play@YourBot ..." which Telegram sends in
// groups that have several bots
// ---------------------------------------------------------------------------
const cmd = (name, withArg) => new RegExp(`^\\/${name}(?:@\\w+)?${withArg ? "\\s+([\\s\\S]+)" : "\\b"}`, "i");

function isForMe(msg) {
    const m = (msg.text || "").match(/^\/\w+@(\w+)/);
    return !m || !botUsername || m[1].toLowerCase() === botUsername.toLowerCase();
}

bot.onText(cmd("start"), (msg) => {
    if (!isForMe(msg)) return;
    bot.sendMessage(msg.chat.id, "🎶 Add me and my assistant account to a group, start a voice chat, then send /play <song name>.");
});

bot.onText(cmd("play", true), async (msg, match) => {
    if (!isForMe(msg)) return;
    const chatId = msg.chat.id;
    if (msg.chat.type === "private") {
        return bot.sendMessage(chatId, "Use /play inside a group that has a voice chat.");
    }
    const songName = match[1].trim();

    try {
        await bot.sendMessage(chatId, `Searching ${songName} on youtube...`);
        const results = await ytSearch(songName);
        if (!results.length) return bot.sendMessage(chatId, "Sorry no results available for your song");

        const player = await getPlayer(chatId);
        if (!player) {
            return bot.sendMessage(chatId,
                "❌ My assistant account is not in this group, so it can't join the voice chat.\n\n" +
                "Fix: add the assistant account to this group, OR make me (the bot) an admin with the 'Invite users via link' permission so it can join by itself. Then try /play again.");
        }

        bot.sendMessage(chatId, "Downloading your song please wait...");
        // Use the video ID for the file name: song names can contain characters
        // that are invalid in file paths.
        let result = null;
        let filePath = null;
        let lastErr = null;
        for (const r of results) {
            const fp = path.join(DOWNLOAD_DIR, `${r.videoId}-${Date.now()}.mp3`);
            try {
                await download(r.url, fp);
                result = r;
                filePath = fp;
                break;
            } catch (err) {
                lastErr = err;
                console.warn(`Download failed for ${r.url}, trying next result:`, String(err.message).split("\n").pop());
            }
        }
        if (!result) throw lastErr;

        if (SEND_AUDIO_FILE) {
            bot.sendAudio(chatId, filePath, { title: result.title }, { contentType: "audio/mpeg" }).catch((e) => console.error("sendAudio:", e.message));
        }

        const track = { title: result.title, filePath };
        // The player may have been removed while downloading (e.g. /stop).
        const live = players.get(chatId) || (await getPlayer(chatId));
        if (!live) { cleanup(track); return bot.sendMessage(chatId, "❌ Lost access to this group, try again."); }
        if (live.current) {
            live.queue.push(track);
            return bot.sendMessage(chatId, `➕ Added to queue (#${live.queue.length}): ${result.title}`);
        }
        live.queue.push(track);
        if (!(await ensureVoiceChat(live.entity))) {
            live.queue.forEach(cleanup);
            players.delete(chatId);
            return bot.sendMessage(chatId, "❌ No voice chat is running. Start the voice chat in this group (or make the assistant an admin with 'Manage voice chats') and try again.");
        }
        await playNext(chatId);
    } catch (err) {
        console.error("/play error:", err);
        bot.sendMessage(chatId, `❌ Failed: ${String(err.message || err).slice(0, 300)}`);
    }
});

bot.onText(cmd("skip"), (msg) => { if (isForMe(msg)) handleControl(msg.chat.id, "skip"); });
bot.onText(cmd("stop"), (msg) => { if (isForMe(msg)) handleControl(msg.chat.id, "stop"); });
bot.onText(cmd("pause"), (msg) => { if (isForMe(msg)) handleControl(msg.chat.id, "pause"); });
bot.onText(cmd("resume"), (msg) => { if (isForMe(msg)) handleControl(msg.chat.id, "play"); });

async function handleControl(chatId, action) {
    const player = players.get(chatId);
    if (!player) return bot.sendMessage(chatId, "Nothing is playing. Use /play <song name>.");
    try {
        if (action === "pause") player.tg.pauseAudio();
        if (action === "play") player.tg.resumeAudio();
        if (action === "skip") await playNext(chatId);
        if (action === "stop") {
            player.queue.forEach(cleanup);
            player.queue = [];
            await playNext(chatId); // empty queue => stops and leaves
        }
    } catch (err) {
        console.error(`${action} failed:`, err);
    }
}

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    if (query.data === "close") {
        await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
    } else {
        await handleControl(chatId, query.data);
    }
    bot.answerCallbackQuery(query.id).catch(() => {});
});

bot.on("polling_error", (err) => {
    console.error("polling_error:", err.code, err.message);
    if (String(err.message).includes("409")) {
        console.error("⚠️ Another copy of this bot is running (maybe on your PC). Stop it, only one can poll at a time.");
    }
});

// ---------------------------------------------------------------------------
// Tiny health endpoint — some hosts (Render, Koyeb) require a listening port
// ---------------------------------------------------------------------------
if (process.env.PORT) {
    http.createServer((req, res) => { res.writeHead(200); res.end("ok"); })
        .listen(process.env.PORT, () => console.log(`Health check on :${process.env.PORT}`));
}

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

(async () => {
    try {
        botUsername = (await bot.getMe()).username;
        console.log(`✅ Bot running as @${botUsername}`);
        await initClient();
    } catch (err) {
        console.error("❌ Startup failed:", err.message || err);
        process.exit(1);
    }
})();
