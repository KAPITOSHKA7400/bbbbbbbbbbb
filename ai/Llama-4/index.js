// ai/Llama-4/index.js
import axios from "axios";
import { getLlama4Creds } from "../../admin/db.js";

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// простой кэш, чтобы не ходить в БД на каждый токен
let cached = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 минут

async function loadCreds() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;

  const row = await getLlama4Creds();
  if (!row?.account_id || !row?.api_token) {
    throw new Error("В БД нет учётки Llama-4 (таблица llama4_adm). Заполните account_id и api_token.");
  }
  cached = { accountId: row.account_id, apiToken: row.api_token };
  cachedAt = now;
  return cached;
}

export async function generate({ prompt, meta = {}, system, options = {} }) {
  const { accountId, apiToken } = await loadCreds();

  // ВАЖНО: модель в пути без encodeURIComponent
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;

  const sys =
    system ||
    "Ты дружелюбный русскоязычный ассистент для стрима. Отвечай кратко и по делу.";

  const payload = {
    messages: [
      { role: "system", content: sys },
      { role: "user",   content: buildUserPrompt(prompt, meta) },
    ],
    temperature: options.temperature ?? 0.3,
    max_tokens:  options.max_tokens  ?? 256,
  };

  try {
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });
    const out = res?.data?.result?.response ?? res?.data?.result?.text ?? "";
    return String(out).trim();
  } catch (e) {
    // не печатаем токен! — только статус и тело ошибки
    console.error("Cloudflare AI error:", e?.response?.status, e?.response?.data || e?.message);
    throw e;
  }
}

function buildUserPrompt(prompt, meta) {
  const ctx = [];
  if (meta.platform) ctx.push(`платформа=${meta.platform}`);
  if (meta.channel)  ctx.push(`канал=${meta.channel}`);
  if (meta.username) ctx.push(`пользователь=${meta.username}`);
  const prefix = ctx.length ? `Контекст: ${ctx.join(", ")}.\n` : "";
  return `${prefix}Сообщение пользователя: ${prompt}`;
}
