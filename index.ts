import VKPLMessageClient from "vklive-message-client";

const target = 14011062; // твой channel_id

const client = new VKPLMessageClient({
  auth: {
    accessToken: "f317948cc2f2b93510a4beb9743f8718fe50afc2eabafb41ef8332f21e6b7ba8",
    refreshToken: "105043fd360c6ae6b29e16fe2d590e178f7a09ebd63f6a9d5c036e6aa9bec2c8",
    expiresAt: 1788639472384
  },
  clientId: "309172c0-d0e6-456d-9ec2-80e7aea3da9c",
  channels: [target],
  debugLog: true
});

async function main() {
  await client.connect();
  await client.sendMessage("✅ Connected to chat!", target);

  client.on("message", async (ctx) => {
    console.log(`[${ctx.user.login}]: ${ctx.message.text}`);
  });
}

main();
