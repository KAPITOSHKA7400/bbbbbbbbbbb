// ai/index.js
export async function generateAIResponse({
  prompt,
  meta = {},
  provider = (process.env.AI_PROVIDER || "chat_gpt"),
  system,
  options = {},
} = {}) {
  const key = String(provider).toLowerCase();

  if (key === "llama-4" || key === "llama4") {
    const { generate } = await import("./Llama-4/index.js");
    return generate({ prompt, meta, system, options });
  }
  if (key === "chat_gpt") {
    const { generate } = await import("./chat_gpt/index.js");
    return generate({ prompt, meta, system, options });
  }
  if (key === "deepseek") {
    const { generate } = await import("./deepseek/index.js");
    return generate({ prompt, meta, system, options });
  }

  const { generate } = await import("./chat_gpt/index.js");
  return generate({ prompt, meta, system, options });
}
