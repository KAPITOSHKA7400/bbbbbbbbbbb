// ai/chat_gpt/index.js
// Заглушка: сейчас просто эхо-ответ. Позже можно подключить реальный API.
export async function generate({ prompt, meta = {} }) {
  return `🤖 (chat_gpt) ${meta.username ? meta.username + ", " : ""}я услышал: "${prompt}"`;
}
