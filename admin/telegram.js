// admin/telegram.js
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import {
  assertDb,
  ensureSchema,
  ensureTelegramUser,
  getUserByTelegramId,
  setUserVkvl,
  clearUserVkvl,
  setAiModeAll,
  toggleAiModeRandom,
  toggleAiModeMention,
  setUserPrompt,
  setUserNegativePrompt,
} from "./db.js";
import { vkvlInstruction } from "./integrations/vkvl.js";
import { viewAiPrompt } from "./ai/prompt.js";
import { viewAiNegativePrompt } from "./ai/negative_prompt.js";
import { viewAiCharacter, registerAiCharacterHandlers } from "./ai/character.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const { TELEGRAM_BOT_TOKEN } = process.env;
if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN не задан в .env");
  process.exit(1);
}

/* -------------------- запуск VKVL как дочернего процесса -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const vkBotPath = resolve(__dirname, "../VKVL/index.js");

const vkProc = spawn(process.execPath, [vkBotPath], { stdio: "inherit" });
vkProc.on("spawn", () => console.log("🚀 VK Play Live бот запущен (VKVL/index.js)"));
vkProc.on("exit", (code, signal) =>
  console.log(`⚠️ VK бот завершился. code=${code} signal=${signal || "none"}`)
);
vkProc.on("error", (err) => console.error("❌ VK бот не стартовал:", err));

/* --------------------------------- Telegram -------------------------------- */
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ожидаем ввод
const awaitingVkvlSlug = new Set();
const awaitingPrompt = new Set();
const awaitingNegativePrompt = new Set();

/* Клавиатуры */
const kbWelcome = () =>
  Markup.inlineKeyboard([Markup.button.callback("📋 Меню", "open_main_menu")]);

const kbMain = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("👤 Профиль", "menu_profile")],
    [Markup.button.callback("🧩 Интеграции", "menu_integrations")],
    [Markup.button.callback("🧠 Настройки ИИ", "menu_ai")],
  ]);

const kbBackToMain = () =>
  Markup.inlineKeyboard([[Markup.button.callback("⬅️ Гл. меню", "open_main_menu")]]);

const kbIntegrations = (vkvlConnected = false) =>
  Markup.inlineKeyboard([
    [
      vkvlConnected
        ? Markup.button.callback("VK VL ❌", "integr_vkvl_remove")
        : Markup.button.callback("VK VL", "integr_vkvl"),
      Markup.button.callback("Twitch", "integr_twitch"),
      Markup.button.callback("YouTube", "integr_youtube"),
    ],
    [Markup.button.callback("⬅️ Гл. меню", "open_main_menu")],
  ]);

const kbBackToIntegrations = () =>
  Markup.inlineKeyboard([[Markup.button.callback("⬅️ Интеграции", "menu_integrations")]]);

/* ——— Настройки ИИ ——— */
const kbAiMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🎭 Характер", "ai_character")],
    [Markup.button.callback("💬 Режим ответов", "ai_mode_open")],
    [Markup.button.callback("📝 Промпт", "ai_prompt")],
    [Markup.button.callback("🚫 Негатив промпт", "ai_negative_prompt")],
    [Markup.button.callback("⬅️ Гл. меню", "open_main_menu")],
  ]);

const kbAiModes = (m) => {
  const c1 = m.ai_all ? "☑️" : "⬜️";
  const c2 = m.ai_random ? "☑️" : "⬜️";
  const c3 = m.ai_mention ? "☑️" : "⬜️";
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${c1} 1) На все сообщения`, "ai_mode_all")],
    [Markup.button.callback(`${c2} 2) Выборочно`, "ai_mode_random_toggle")],
    [Markup.button.callback(`${c3} 3) Упоминание`, "ai_mode_mention_toggle")],
    [Markup.button.callback("⬅️ Настройки ИИ", "menu_ai")],
    [Markup.button.callback("⬅️ Гл. меню", "open_main_menu")],
  ]);
};

/* Утилита ответа/редактирования */
async function replyOrEdit(ctx, text, keyboard) {
  try {
    if (ctx.updateType === "callback_query") {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard });
      try { await ctx.answerCbQuery(); } catch {}
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
    }
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", ...keyboard });
    if (ctx.updateType === "callback_query") try { await ctx.answerCbQuery(); } catch {}
  }
}
function integrationsStatusLine(vkvlConnected) {
  return `VKVL - ${vkvlConnected ? "Подключён." : "нет."} / Twitch - нет. / YouTube - нет.`;
}

/* /start — привет (фото), регистрация id+username */
bot.start(async (ctx) => {
  try {
    await assertDb();
    await ensureSchema();
    const tgId = ctx.from?.id;
    const username = ctx.from?.username || null;
    if (tgId) await ensureTelegramUser(tgId, username);
  } catch (e) {
    console.warn("⚠️ DB init/register error:", e?.message || e);
  }

  const imgPath = resolve(__dirname, "img", "9de06974-04a0-4e98-bf32-9da0f650166e.png");
  const caption = "Добро пожаловать! Нажмите <b>Меню</b>, чтобы продолжить.";
  await ctx.replyWithPhoto({ source: imgPath }, { caption, parse_mode: "HTML", ...kbWelcome() });
});

/* Главное меню */
bot.action("open_main_menu", async (ctx) => {
  const tgId = ctx.from?.id;
  const username = ctx.from?.username || null;
  if (tgId) { try { await ensureTelegramUser(tgId, username); } catch {} }
  const text = "Главное меню. Выберите раздел:";
  await replyOrEdit(ctx, text, kbMain());
});

/* ---------- Профиль ---------- */
bot.action("menu_profile", async (ctx) => {
  const text = "👤 <b>Профиль</b>\nЗаглушка. Здесь позже будет информация о вашем аккаунте.";
  await replyOrEdit(ctx, text, kbBackToMain());
});

/* ---------- Интеграции ---------- */
bot.action("menu_integrations", async (ctx) => {
  const tgId = ctx.from?.id;
  const user = tgId ? await getUserByTelegramId(tgId) : null;
  const connected = !!(user && user.vkvl === 1 && user.vkvl_page);
  const text =
    `🧩 <b>Интеграции</b>\n` +
    integrationsStatusLine(connected) +
    `\n\nВыберите платформу:`;
  await replyOrEdit(ctx, text, kbIntegrations(connected));
});
bot.action("integr_vkvl", async (ctx) => {
  const tgId = ctx.from?.id;
  if (tgId) awaitingVkvlSlug.add(tgId);
  const text = await vkvlInstruction();
  await replyOrEdit(ctx, text, kbBackToIntegrations());
});
bot.action("integr_vkvl_remove", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  awaitingVkvlSlug.delete(tgId);
  await clearUserVkvl(tgId);
  await replyOrEdit(ctx, "❌ Интеграция VKVL удалена.", kbBackToIntegrations());
});
bot.action("integr_twitch", async (ctx) => {
  await replyOrEdit(ctx, "🟣 <b>Twitch</b>\nЗаглушка. Скоро здесь появятся настройки.", kbBackToIntegrations());
});
bot.action("integr_youtube", async (ctx) => {
  await replyOrEdit(ctx, "🔴 <b>YouTube</b>\nЗаглушка. Скоро здесь появятся настройки.", kbBackToIntegrations());
});

/* ---------- Настройки ИИ ---------- */
bot.action("menu_ai", async (ctx) => {
  const text = "🧠 <b>Настройки ИИ</b>\nВыберите раздел:";
  await replyOrEdit(ctx, text, kbAiMenu());
});

/* — Характер */
bot.action("ai_character", viewAiCharacter);
registerAiCharacterHandlers(bot);

/* — Режим ответов */
bot.action("ai_mode_open", async (ctx) => {
  const tgId = ctx.from?.id;
  const user = tgId ? await getUserByTelegramId(tgId) : { ai_all: 1, ai_random: 0, ai_mention: 0 };
  const text = [
    "🧠 <b>Настройки ИИ → Режим ответов</b>",
    "",
    "• 1) <b>На все сообщения</b> — бот отвечает на каждое сообщение.",
    "• 2) <b>Выборочно</b> — бот отвечает случайно на некоторые сообщения.",
    "• 3) <b>Упоминание</b> — бот отвечает только при точном упоминании «нейробот».",
    "",
    "Выберите вариант(ы):",
  ].join("\n");
  await replyOrEdit(ctx, text, kbAiModes(user));
});
bot.action("ai_mode_all", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  await setAiModeAll(tgId);
  const user = await getUserByTelegramId(tgId);
  await replyOrEdit(ctx, "✅ Выбран режим: <b>На все сообщения</b>\n(2 и 3 выключены)", kbAiModes(user));
});
bot.action("ai_mode_random_toggle", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  await toggleAiModeRandom(tgId);
  const user = await getUserByTelegramId(tgId);
  await replyOrEdit(ctx, "📝 Режим <b>Выборочно</b> переключён.\n(1 автоматически выключается)", kbAiModes(user));
});
bot.action("ai_mode_mention_toggle", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  await toggleAiModeMention(tgId);
  const user = await getUserByTelegramId(tgId);
  await replyOrEdit(ctx, "📝 Режим <b>Упоминание</b> переключён.\n(1 автоматически выключается)", kbAiModes(user));
});

/* — Промпт */
bot.action("ai_prompt", async (ctx) => {
  const tgId = ctx.from?.id;
  const user = tgId ? await getUserByTelegramId(tgId) : null;
  if (tgId) {
    awaitingPrompt.add(tgId);
    awaitingNegativePrompt.delete(tgId);
    awaitingVkvlSlug.delete(tgId);
  }
  const text = await viewAiPrompt(user?.prompt || null);
  await replyOrEdit(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Настройки ИИ", "menu_ai")],
    [Markup.button.callback("⬅️ Гл. меню", "open_main_menu")],
  ]));
});

/* — Негатив промпт */
bot.action("ai_negative_prompt", async (ctx) => {
  const tgId = ctx.from?.id;
  const user = tgId ? await getUserByTelegramId(tgId) : null;
  if (tgId) {
    awaitingNegativePrompt.add(tgId);
    awaitingPrompt.delete(tgId);
    awaitingVkvlSlug.delete(tgId);
  }
  const text = await viewAiNegativePrompt(user?.negative_prompt || null);
  await replyOrEdit(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Настройки ИИ", "menu_ai")],
    [Markup.button.callback("⬅️ Гл. меню", "open_main_menu")],
  ]));
});

/* ---------- Общий обработчик текста ---------- */
bot.on("text", async (ctx) => {
  const tgId = ctx.from?.id;
  if (!tgId) return;
  const text = (ctx.message?.text || "").trim();

  // 1) VKVL slug
  if (awaitingVkvlSlug.has(tgId)) {
    const slug = extractVkvlSlug(text);
    if (!slug || slug.length < 3 || slug.length > 64) {
      await ctx.reply("⚠️ Некорректный URL/слаг. Пришлите только конечный слаг (например: <b>crazzy0rabbit</b>).", { parse_mode: "HTML" });
      return;
    }
    await setUserVkvl(tgId, true, slug);
    awaitingVkvlSlug.delete(tgId);
    await ctx.reply("✅ Интеграция VKVL прошла успешна!", { parse_mode: "HTML" });
    return;
  }

  // 2) PROMPT
  if (awaitingPrompt.has(tgId)) {
    const normalized = normalizeCsv(text);
    await setUserPrompt(tgId, normalized);
    awaitingPrompt.delete(tgId);
    await ctx.reply("✅ Промпт сохранён.", { parse_mode: "HTML" });
    return;
  }

  // 3) NEGATIVE PROMPT
  if (awaitingNegativePrompt.has(tgId)) {
    const normalized = normalizeCsv(text);
    await setUserNegativePrompt(tgId, normalized);
    awaitingNegativePrompt.delete(tgId);
    await ctx.reply("✅ Негатив промпт сохранён.", { parse_mode: "HTML" });
    return;
  }
});

/* Запуск TG-бота */
bot.launch().then(() => console.log("✅ Telegram-бот запущен"));

process.once("SIGINT", () => {
  bot.stop("SIGINT");
  if (!vkProc.killed) vkProc.kill("SIGINT");
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  if (!vkProc.killed) vkProc.kill("SIGTERM");
});

/* ---------- helpers ---------- */
function extractVkvlSlug(input) {
  let s = String(input || "").trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length) s = parts.pop();
    }
  } catch {}
  s = s.replace(/^@/, "");
  s = s.replace(/[^a-zA-Z0-9_-]/g, "");
  return s.toLowerCase();
}
function normalizeCsv(text) {
  return String(text || "")
    .split(",")
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .join(", ");
}
