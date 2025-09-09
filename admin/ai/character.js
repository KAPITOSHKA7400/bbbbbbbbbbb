// admin/ai/character.js
import { Markup } from "telegraf";
import { pool } from "../db.js";

async function replyOrEdit(ctx, text, extra = {}) {
  const opts = { parse_mode: "HTML", ...extra };
  if (ctx.updateType === "callback_query") {
    try { await ctx.editMessageText(text, opts); }
    catch { await ctx.reply(text, opts); }
    try { await ctx.answerCbQuery(); } catch {}
  } else {
    await ctx.reply(text, opts);
  }
}

async function getCurrentCharacter(tgId) {
  const [rows] = await pool.execute(
    `SELECT ai_character FROM users WHERE telegram_id = :id LIMIT 1`,
    { id: tgId }
  );
  return rows[0]?.ai_character || "polite";
}

async function setCharacter(tgId, mode) {
  await pool.execute(
    `UPDATE users SET ai_character = :m WHERE telegram_id = :id`,
    { m: mode, id: tgId }
  );
}

function kbCharacter(current) {
  const mark = (k, title) => `${current === k ? "✅ " : ""}${title}`;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(mark("polite", "Вежливый"), "char:polite"),
      Markup.button.callback(mark("funny",  "Весельчак"), "char:funny"),
      Markup.button.callback(mark("rude",   "Быдло"),     "char:rude"),
    ],
    [Markup.button.callback("◀️ Настройки ИИ", "menu_ai")],
    [Markup.button.callback("🏠 Гл. меню", "open_main_menu")],
  ]);
}

function characterHelp(current) {
  const names = { polite: "Вежливый", funny: "Весельчак", rude: "Быдло" };
  return (
`<b>Характер ответов</b>

<b>Вежливый</b> — доброжелательные ответы с уважением.
<b>Весельчак</b> — с юмором и лёгкими подколами; мат допустим, но без оскорблений.
<b>Быдло</b> — грубовато, просторечно; мат допустим, но без оскорблений/травли.

Текущий характер: <b>${names[current] || "Вежливый"}</b>

Выберите режим кнопкой ниже.`
  );
}

export async function viewAiCharacter(ctx) {
  const tgId = ctx.from?.id;
  const cur = await getCurrentCharacter(tgId);
  await replyOrEdit(ctx, characterHelp(cur), kbCharacter(cur));
}

export function registerAiCharacterHandlers(bot) {
  bot.action("ai_character", viewAiCharacter);
  bot.action(/char:(polite|funny|rude)/, async (ctx) => {
    const tgId = ctx.from?.id;
    const mode = ctx.match[1];
    await setCharacter(tgId, mode);
    const cur = await getCurrentCharacter(tgId);
    await replyOrEdit(ctx, characterHelp(cur), kbCharacter(cur));
  });
}

export default { viewAiCharacter, registerAiCharacterHandlers };
