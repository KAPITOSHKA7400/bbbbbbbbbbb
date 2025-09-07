import VKPLMessageClient from "vklive-message-client";
import axios from "axios";

const targets = ["zkapitoshkaz"];

const accessToken = "0ad9410b4a214e74d576ed4fb79b120200ac1142f33d62984adee73a4f11e97d";
const refreshToken = "5b115c4d0769730d28fdc7223ba2e21b0d0544b1c1e8d0014c0bbf534b662909";
const expiresAt = 1788781406277;
const clientId = "79ed8672-f1cb-42c6-8226-8bacea67d044";

// кэш для статистики
const stats = {};

// подписка на канал (возвращает true, если реально подписался)
async function followUser(user) {
  try {
    const response = await axios.post(
      `https://api.live.vkplay.ru/v1/blog/${user}/follow`,
      {},
      {
        headers: {
          "authorization": `Bearer ${accessToken}`,
          "origin": "https://live.vkplay.ru",
          "referer": `https://live.vkplay.ru/${user}`
        }
      }
    );

    if (response.data.status === true) {
      console.log(`✅ Подписался на ${user}`);
      return true;
    }
    if (response.data.error === "already_subscribed") {
      console.log(`ℹ️ Уже подписан на ${user}`);
      return false;
    }

    console.log(`⚠️ Ответ от API для ${user}:`, response.data);
    return false;

  } catch (error) {
    // если не "already_subscribed" → тогда выводим как ошибку
    if (error.response?.data?.error === "already_subscribed") {
      console.log(`ℹ️ Уже подписан на ${user}`);
      return false;
    }
    console.log(`❌ Ошибка подписки на ${user}:`, error.response ? error.response.data : error.message);
    return false;
  }
}

const client = new VKPLMessageClient({
  auth: { accessToken, refreshToken, expiresAt },
  clientId,
  channels: targets,
  log: true,
  debugLog: false
});

async function main() {
  await client.connect();

  for (const ch of targets) {
    const subscribed = await followUser(ch);
    if (subscribed) {
      await client.sendMessage("✅ Бот подключился к чату и оформил подписку. Для нормальной работы необходимы права модератора. Выдать права боту можно через команду /mod channel ", ch);
    } else {
      await client.sendMessage("✅ Бот подключился к чату.", ch);
    }
  }

  // обработка сообщений
client.on("message", async (ctx) => {
  const channelName = ctx.blog?.blogUrl || "Null";
  const username = ctx.user?.nick || ctx.user?.login || "Null";
  const text = ctx.message?.text?.trim().toLowerCase();

  // Игнорируем свои сообщения
  if (username === "Kappa_GPT") return;

  const time = new Date().toLocaleTimeString("ru-RU", { hour12: false });
  console.log(`[${time}] [${channelName}] [${username}]: ${ctx.message.text}`);

  if (text.includes("привет")) {
    await client.sendMessage(`Привет, ${username}! 👋`, channelName);
  }
});

  // обновляем кэш статистики (без console.log!)
  client.on("channelInfo", (ctx) => {
    stats[ctx.blog.blogUrl] = {
      ...stats[ctx.blog.blogUrl],
      viewers: ctx.viewers,
      isOnline: ctx.isOnline
    };
  });

  client.on("streamLikeCounter", (ctx) => {
    stats[ctx.blog.blogUrl] = {
      ...stats[ctx.blog.blogUrl],
      likes: ctx.counter
    };
  });

  // выводим статистику раз в минуту
  setInterval(() => {
    const now = new Date().toLocaleTimeString("ru-RU", { hour12: false });
    console.log(`\n📊 Статистика каналов (${now}):`);
    for (const [channel, data] of Object.entries(stats)) {
      console.log(
        `   • ${channel}: 👀 ${data.viewers || 0} | ❤️ ${data.likes || 0} | ${data.isOnline ? "🟢 онлайн" : "🔴 оффлайн"}`
      );
    }
  }, 60000);
}

main();
