// VKVL/index.js
import "dotenv/config";
import VKPLMessageClient from "vklive-message-client";
import axios from "axios";
import {
  assertDb,
  ensureSchema,
  getVkvlToken,
  upsertVkvlToken,
  logChatMessage,
  getAllVkvlPages,
  getAiModeForVkvlPage,
  getPromptsForVkvlPage,
  appendHistory,
  getRecentHistory,
} from "../admin/db.js";
import { generateAIResponse } from "../ai/index.js";

/* ==================== helpers ==================== */
function pickRawChannel(ctx) {
  return (
    ctx?.blog?.blogUrl ??
    ctx?.blogUrl ??
    ctx?.channel?.blogUrl ??
    ctx?.channel ??
    ctx?.chat ??
    ctx?.room ??
    null
  );
}
function normalizeChannel(raw, fallback) {
  let s = "";
  if (typeof raw === "string") s = raw;
  else if (raw && typeof raw === "object") {
    s = raw.blogUrl || raw.url || raw.slug || raw.name || raw.id || "";
  }
  s = String(s)
    .replace(/^https?:\/\/(?:live\.)?vkplay\.ru\//i, "")
    .replace(/^https?:\/\/(?:live\.)?vkvideo\.ru\//i, "")
    .replace(/^[@/]+/, "")
    .trim();
  if (!s) s = fallback;
  return s.toLowerCase();
}
function getSafeIds(ctx) {
  const userId =
    ctx?.user?.id ??
    ctx?.user?.userId ??
    ctx?.user?.uid ??
    ctx?.user?.login ??
    ctx?.user?.nick ??
    "unknown";
  const msgId =
    ctx?.message?.id ??
    ctx?.message?.messageId ??
    ctx?.message?.msgId ??
    `${Date.now()}-${userId}`;
  return { userId: String(userId), msgId: String(msgId) };
}
function stripGreetings(s) {
  if (!s) return s;
  const greet = [
    "привет","здравствуйте","здрасте","ку","хай","дарова",
    "добрый день","добрый вечер","доброе утро",
    "hello","hi","hey"
  ].join("|");
  const re = new RegExp(`^\\s*(?:${greet})[,!\\s-]*`, "i");
  return s.replace(re, "").trim();
}
function addressUser(reply, username) {
  if (!reply) return reply;
  if (!username || username === "unknown") return reply;
  return `${username}, ${reply}`;
}

/* --- упоминание: только «нейробот» / «@нейробот» --- */
const MENTION_RE = /(^|[^\p{L}\p{N}_])@?нейробот(?![\p{L}\p{N}_])/iu;
function isMentioned(text) { return MENTION_RE.test(String(text || "")); }

/* --- фильтр: сообщение только из эмодзи --- */
const EMOJI_OR_JOINER_RE = /[\p{Extended_Pictographic}\u200D\uFE0F]/gu;
function isEmojiOnly(input) {
  const t = String(input || "").trim();
  if (!t) return false;
  if (!/[\p{Extended_Pictographic}]/u.test(t)) return false;
  const rest = t
    .replace(EMOJI_OR_JOINER_RE, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/[A-Za-zА-Яа-яЁё0-9]/gu, "");
  return rest.length === 0;
}

/* --- ограничение длины ответа: максимум N слов --- */
function limitWords(s, n = 10) {
  const words = String(s || "").trim().split(/\s+/);
  if (words.length <= n) return words.join(" ");
  return words.slice(0, n).join(" ");
}

/* ===== CSV & matching для промптов ===== */
function csvToList(csv) {
  return String(csv || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}
function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}\+]+/u)
    .filter(w => w.length >= 2);
}
function buildKeywords(csv) {
  const items = csvToList(csv);
  const bag = new Set();
  for (const it of items) {
    const toks = tokenize(it);
    for (const t of toks) {
      bag.add(t);
      if (t === "спб") {
        ["спб","питер","санкт","петербург","санкт-петербург","санктпетербург"].forEach(x=>bag.add(x));
      }
      if (t === "тарков") {
        ["тарков","tarkov","escape","эскейп","эскейпфромтарков","эскейп-фром-тарков"].forEach(x=>bag.add(x));
      }
      if (t === "имя") { ["имя","зовут"].forEach(x=>bag.add(x)); }
      if (t === "лет" || t === "возраст") { ["лет","возраст"].forEach(x=>bag.add(x)); }
      if (t === "игра" || t === "играю" || t === "игру") {
        ["игра","игру","играешь","во что","что играю"].forEach(x=>bag.add(x));
      }
      if (t === "контент") { ["контент","18","18+"].forEach(x=>bag.add(x)); }
    }
  }
  return Array.from(bag);
}
function messageMatchesPrompt(message, csv) {
  if (!csv) return false;
  const txt = tokenize(message).join(" ");
  const kws = buildKeywords(csv);
  return kws.some(kw => txt.includes(kw));
}
const HINTS = [
  { re: /(как.*зовут|зовут|имя)/i, needs: ["имя","зовут"] },
  { re: /(сколько.*лет|возраст)/i, needs: ["лет","возраст"] },
  { re: /(откуда|город|где.*жив)/i,  needs: ["спб","питер","санкт","петербург","город"] },
  { re: /(во что.*игра|какую.*игру|играешь)/i, needs: ["игра","игру","играешь","tarkov","тарков","escape"] },
  { re: /(контент|18\+)/i, needs: ["контент","18","18+"] },
];
function messageImpliedByPrompt(message, csv) {
  if (!csv) return false;
  const txt = String(message || "").toLowerCase().replace(/ё/g, "е");
  const kws = new Set(buildKeywords(csv));
  for (const { re, needs } of HINTS) {
    if (re.test(txt) && needs.some(n => kws.has(n))) return true;
  }
  return false;
}

/* ==================== VK creds ==================== */
const {
  VKVL_CLIENT_ID,
  VKVL_ACCESS_TOKEN,
  VKVL_REFRESH_TOKEN,
  VKVL_EXPIRES_AT,
} = process.env;

async function loadCredentials() {
  await assertDb();
  await ensureSchema();

  if (VKVL_CLIENT_ID && VKVL_ACCESS_TOKEN && VKVL_REFRESH_TOKEN && VKVL_EXPIRES_AT) {
    const existing = await getVkvlToken(VKVL_CLIENT_ID);
    if (!existing) {
      await upsertVkvlToken({
        accessToken: VKVL_ACCESS_TOKEN,
        refreshToken: VKVL_REFRESH_TOKEN,
        expiresAt: Number(VKVL_EXPIRES_AT),
        clientId: VKVL_CLIENT_ID,
      });
      console.log("💾 Сид записан в vkvl_token из .env");
    }
  }

  const clientId = VKVL_CLIENT_ID || "79ed8672-f1cb-42c6-8226-8bacea67d044";
  const creds = await getVkvlToken(clientId);
  if (!creds) throw new Error("Нет кредов VKVL. Заполните vkvl_token или задайте VKVL_* в .env.");
  return creds;
}

/* ===== подписка на канал ===== */
async function ensureFollow(user, accessToken) {
  const url = `https://api.live.vkplay.ru/v1/blog/${user}/follow`;
  try {
    const resp = await axios.post(url, {}, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        origin: "https://live.vkvideo.ru",
        referer: `https://live.vkvideo.ru/${user}`,
        "content-type": "application/json",
      },
      timeout: 10000,
      validateStatus: () => true,
    });

    if (resp.data?.status === true) {
      console.log(`✅ Подписался на VKVL: ${user}`);
      return { ok: true, already: false };
    }
    if (resp.data?.error === "already_subscribed") {
      console.log(`ℹ️ Уже подписан на ${user}`);
      return { ok: true, already: true };
    }
    console.warn(`⚠️ follow(${user}) API response:`, resp.status, resp.data);
    return { ok: false, reason: resp.data?.error || `http_${resp.status}`, details: resp.data };
  } catch (e) {
    console.error(`❌ follow(${user}) network error:`, e?.response?.status, e?.response?.data || e?.message);
    return { ok: false, reason: "network_error" };
  }
}

/* ==================== режим ответа ==================== */
async function getModesForChannel(channel) {
  try { return await getAiModeForVkvlPage(channel); }
  catch { return { ai_all: 1, ai_random: 0, ai_mention: 0 }; }
}
function shouldReplyByMode(text, mode) {
  const ai_all     = Number(mode?.ai_all ?? 0);
  const ai_random  = Number(mode?.ai_random ?? 0);
  const ai_mention = Number(mode?.ai_mention ?? 0);
  if (ai_all === 1) return true;
  if (ai_mention === 1 && isMentioned(text)) return true;
  if (ai_random === 1 && Math.random() < 0.30) return true;
  return false;
}

/* ===== История в короткий текст ===== */
function renderHistory(lines, maxChars = 1200) {
  const out = [];
  for (const r of lines) {
    const who = r.role === "assistant" ? "Ассистент" : (r.username || "Пользователь");
    const text = String(r.message || "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (text) out.push(`${who}: ${text}`);
  }
  let s = out.join("\n");
  if (s.length > maxChars) s = s.slice(-maxChars);
  return s;
}

/* ==================== динамический менеджер каналов ==================== */
const clients = new Map(); // channel -> { client }

async function attachHandlers(channel, client, creds) {
  clients.set(channel, { client });

  // попытка подписки (сообщение в чат)
  try {
    const res = await ensureFollow(channel, creds.accessToken);
    const msg = res.ok
      ? (res.already
          ? "ℹ️ Уже подписан на канал. Бот подключён к чату."
          : "✅ Бот подключился и оформил подписку. Для нормальной работы нужны права модератора.")
      : "⚠️ Бот подключился к чату. Подписка не оформлена (нужны валидные токены).";
    try { await client.sendMessage(msg, channel); } catch {}
  } catch {}

  client.on("message", async (ctx) => {
    const platform = "vkvl";
    const username = ctx.user?.nick || ctx.user?.login || "unknown";
    const text     = (ctx.message?.text ?? "").trim();

    if (ctx.user?.isMe || ["Kappa_GPT", "НейроБот"].includes(username)) return;
    if (!text) return;
    if (isEmojiOnly(text)) return;

    const mode = await getModesForChannel(channel);
    if (!shouldReplyByMode(text, mode)) return;

    const { prompt, negative_prompt } = await getPromptsForVkvlPage(channel);

    // негатив — короткое осуждение (и пишем в историю)
    if (negative_prompt && messageMatchesPrompt(text, negative_prompt)) {
      const { userId } = getSafeIds(ctx);
      await appendHistory({ platform, channel: channel.toLowerCase(), role: "user", user_id: userId, username, message: text });

      const short = limitWords("такие темы здесь не обсуждаем. Давайте без этого.", 10);
      const finalReply = addressUser(short, username);

      try { await client.sendMessage(finalReply, channel); } catch {}
      await appendHistory({ platform, channel: channel.toLowerCase(), role: "assistant", user_id: null, username: "НейроБот", message: finalReply });

      try {
        const { msgId } = getSafeIds(ctx);
        await logChatMessage({ user_id: userId, platform, channel, msg_id: msgId, username, message: text, response: finalReply });
      } catch {}

      return;
    }

    // --- обычный ответ с использованием памяти ---
    const { userId } = getSafeIds(ctx);
    await appendHistory({ platform, channel: channel.toLowerCase(), role: "user", user_id: userId, username, message: text });

    const history = await getRecentHistory({ platform, channel, limit: 20 });
    const historySnippet = renderHistory(history);

    const useContext =
      (prompt && messageMatchesPrompt(text, prompt)) ||
      (prompt && messageImpliedByPrompt(text, prompt));

    // ВАЖНО: сначала история, затем инструкции и опциональные факты
    const baseSystem = [
      "Контекст недавнего диалога (сначала старые, потом новые):",
      historySnippet || "(пусто)",
      "",
      "Отвечай КРАТКО, по-русски, максимум 10 слов.",
      "Не начинай с приветствий. Не обращайся по имени — имя будет добавлено программно.",
      "Без лишних вступлений и эмодзи.",
      "Если в контексте канала есть готовые факты — используй их строго и не выдумывай. Если факта нет, честно скажи, что не знаешь или уточни вопрос."
    ];
    if (useContext) {
      baseSystem.push("");
      baseSystem.push("Факты о канале (через запятую, верь им и не придумывай):");
      baseSystem.push(String(prompt));
    }
    const systemForMsg = baseSystem.join("\n");

    let ai;
    try {
      ai = await generateAIResponse({
        provider: "llama-4",
        prompt: text,
        meta: { platform, channel, username },
        system: systemForMsg,
        options: { temperature: 0.25, max_tokens: 80 },
      });
      if (!ai) return;
    } catch (e) {
      console.error("❌ AI error:", e?.response?.data || e?.message || e);
      return;
    }

    const trimmed = stripGreetings(ai);
    const short   = limitWords(trimmed, 10);
    const finalReply = addressUser(short, username);

    try { await client.sendMessage(finalReply, channel); } catch (e) {
      console.error("❌ sendMessage error:", e?.response?.data || e?.message || e);
      return;
    }

    await appendHistory({ platform, channel: channel.toLowerCase(), role: "assistant", user_id: null, username: "НейроБот", message: finalReply });

    const { msgId } = getSafeIds(ctx);
    try {
      await logChatMessage({
        user_id: userId,
        platform,
        channel,
        msg_id: msgId,
        username,
        message: text,
        response: finalReply,
      });
    } catch (e) {
      console.error("⚠️ DB log error:", e?.message || e);
    }
  });
}

async function createClientForChannel(channel, creds) {
  const client = new VKPLMessageClient({
    auth: {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    },
    clientId: creds.clientId,
    channels: [channel],
    log: false,
    debugLog: false,
  });
  await client.connect();
  await attachHandlers(channel, client, creds);
  console.log(`🟢 Подключён к каналу: ${channel}`);
}

async function removeClient(channel) {
  const entry = clients.get(channel);
  if (!entry) return;
  try {
    if (typeof entry.client.disconnect === "function") {
      await entry.client.disconnect();
    } else if (entry.client.ws && typeof entry.client.ws.close === "function") {
      entry.client.ws.close();
    }
  } catch {}
  clients.delete(channel);
  console.log(`🔴 Отключён от канала: ${channel}`);
}

async function reconcileTargets(creds) {
  let desired = [];
  try { desired = await getAllVkvlPages(); } catch {}
  desired = Array.from(new Set((desired || []).map(s => String(s).toLowerCase())));

  const current = Array.from(clients.keys());

  for (const ch of desired) {
    if (!clients.has(ch)) {
      try { await createClientForChannel(ch, creds); } catch (e) {
        console.error(`❌ Не удалось подключиться к ${ch}:`, e?.message || e);
      }
    }
  }
  for (const ch of current) {
    if (!desired.includes(ch)) {
      await removeClient(ch);
    }
  }
}

/* ==================== main ==================== */
async function main() {
  console.log("🔌 Инициализация VK Play Live…");
  await assertDb();
  await ensureSchema();
  const creds = await loadCredentials();
  await reconcileTargets(creds);
  setInterval(() => { reconcileTargets(creds).catch(()=>{}); }, 10_000);
}

main().catch((e) => {
  console.error("❌ VKVL init error:", e.message);
  process.exit(1);
});
