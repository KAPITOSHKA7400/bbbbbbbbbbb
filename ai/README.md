# ai/
Общий слой для ИИ-ответов. Выбор провайдера через переменную окружения:

- AI_PROVIDER=chat_gpt | llama-4 | deepseek

Интерфейс: `generateAIResponse({ prompt, meta, provider? })` возвращает строку-ответ.
