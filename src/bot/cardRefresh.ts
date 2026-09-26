import { claimTransactionCard, finishTransactionCard, getVersionedTransaction,
  listPendingTransactionCards } from '../db/repo';
import { editTelegramCard } from '../services/telegram';
import { formatTxCard } from './card';
import { txKeyboard } from './keyboards';

/** Bounded foreground sender. The minute cron recovers failed/abandoned work. */
export async function flushTransactionCard(env: Env, chatId: number, messageId: number, rounds = 2): Promise<boolean> {
  for (let attempt = 0; attempt < rounds; attempt++) {
    const token = crypto.randomUUID();
    const job = await claimTransactionCard(env.DB, chatId, messageId, token);
    if (!job) return false;
    let sent = false;
    try {
      const row = await getVersionedTransaction(env.DB, job.tx_id, job.user_id);
      const tx = row?.identity === job.identity ? row : null;
      sent = await editTelegramCard(env.BOT_TOKEN, chatId, messageId,
        tx ? formatTxCard(tx) : '🗑 Entry deleted.', tx ? txKeyboard(tx) : { inline_keyboard: [] });
    } catch {
      console.error(JSON.stringify({ event: 'transaction_card_refresh_failed', messageId }));
    }
    if (await finishTransactionCard(env.DB, job, token, sent)) return true;
    if (!sent) return false;
  }
  return false;
}

export async function recoverTransactionCards(env: Env): Promise<void> {
  const jobs = await listPendingTransactionCards(env.DB);
  // Send sequentially: the two pending cards may belong to the same chat.
  // One bounded send each keeps this sweep under the cron's 30s budget.
  for (const job of jobs) {
    try { await flushTransactionCard(env, job.chat_id, job.message_id, 1); }
    catch { console.error(JSON.stringify({ event: 'transaction_card_retry_failed', messageId: job.message_id })); }
  }
}
