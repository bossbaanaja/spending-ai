interface TelegramResponse {
  ok: boolean;
  description?: string;
}

/** Refresh a saved split card. A retry of an already-rendered card is successful. */
export async function editTelegramCard(
  botToken: string, chatId: number, messageId: number, text: string,
  replyMarkup: import('grammy/types').InlineKeyboardMarkup,
): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup }),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json<TelegramResponse>();
    return (response.ok && result.ok) || result.description?.includes('message is not modified') === true;
  } catch { return false; }
}

/** Sends one bounded plain-text Telegram message without relying on webhook context. */
export async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json<TelegramResponse>();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram sendMessage failed (${response.status}): ${result.description ?? "unknown error"}`);
  }
}
