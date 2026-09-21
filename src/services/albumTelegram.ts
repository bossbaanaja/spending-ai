import type { InlineKeyboard } from 'grammy';

interface Reply { ok: boolean; result?: { message_id: number }; description?: string; parameters?: { retry_after?: number } }

export class AlbumTelegramError extends Error {
  constructor(message: string, readonly retryAfter = 10) { super(message); }
}

/** All album message operations have an explicit short network deadline. */
export async function albumMessage(env: Env, chatId: number, text: string, messageId?: number | null, keyboard?: InlineKeyboard): Promise<number> {
  const method = messageId ? 'editMessageText' : 'sendMessage';
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(messageId ? { message_id: messageId } : {}),
      ...(keyboard ? { reply_markup: keyboard } : { reply_markup: { inline_keyboard: [] } }) }),
    signal: AbortSignal.timeout(8_000),
  });
  const reply = await response.json<Reply>();
  if (reply.ok && reply.result) return reply.result.message_id;
  if (messageId && reply.description?.includes('message is not modified')) return messageId;
  if (messageId && reply.description?.includes('message to edit not found')) {
    return albumMessage(env, chatId, text, null, keyboard);
  }
  throw new AlbumTelegramError(reply.description ?? `Telegram ${response.status}`, reply.parameters?.retry_after);
}
