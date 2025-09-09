// ai/deepseek/index.js
export async function generate({ prompt, meta = {} }) {
  return `🔎 (deepseek) ${meta.username ? meta.username + ", " : ""}принял: "${prompt}"`;
}
