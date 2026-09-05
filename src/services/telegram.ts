interface TelegramResponse {
  ok: boolean;
  description?: string;
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
