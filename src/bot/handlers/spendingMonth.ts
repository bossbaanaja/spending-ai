import { InlineKeyboard, type Bot } from 'grammy';
import { getTransactionByIdentity, getVersionedTransaction, getTransactionCardJob,
  requestTransactionCard, setSpendingMonth, type VersionedTransaction } from '../../db/repo';
import { isSpendingMonth, MONTH_NAMES, paymentDate } from '../../spendingMonth';
import type { BotContext } from '../bot';
import { fmtAmount } from '../card';
import { flushTransactionCard } from '../cardRefresh';

export function spendingMonthKeyboard(tx: VersionedTransaction, year: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const prefix = `dm:${tx.identity}:${tx.revision}:`;
  const selected = tx.spending_month ?? paymentDate(tx).slice(0, 7);
  if (year > 1900) kb.text('‹', `${prefix}y${year - 1}`);
  kb.text(String(year), `${prefix}n`);
  if (year < 9999) kb.text('›', `${prefix}y${year + 1}`);
  kb.row();
  MONTH_NAMES.forEach((name, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    kb.text(`${month === selected ? '✓ ' : ''}${name.slice(0, 3)}`, prefix + month);
    if (i % 3 === 2) kb.row();
  });
  return kb.text('Use payment month', prefix + 'r').row().text('Cancel', prefix + 'c');
}

export function registerSpendingMonth(bot: Bot<BotContext>) {
  bot.callbackQuery(/^(?:month:(\d+)|dm:([a-f0-9]{32}):(\d{1,16}):(y\d{4}|\d{4}-\d{2}|r|c|n))$/, async ctx => {
    if (!ctx.dbUser || !ctx.chat || !ctx.callbackQuery.message) return;
    await ctx.answerCallbackQuery();
    const userId = ctx.dbUser.id;
    const chatId = ctx.chat.id;
    const messageId = ctx.callbackQuery.message.message_id;
    const tx = ctx.match[1]
      ? await getVersionedTransaction(ctx.env.DB, Number(ctx.match[1]), userId)
      : await getTransactionByIdentity(ctx.env.DB, ctx.match[2]!, userId);
    const job = await getTransactionCardJob(ctx.env.DB, ctx.chat.id, messageId);
    if (!tx || (job && job.identity !== tx.identity)) {
      if (!tx && job?.user_id === userId && job.identity === ctx.match[2]) {
        await requestTransactionCard(ctx.env.DB, job.tx_id, userId, job.identity, chatId, messageId);
        await flushTransactionCard(ctx.env, chatId, messageId);
      }
      await ctx.reply('That entry no longer exists. Use its current saved card.');
      return;
    }
    const restore = async () => {
      await requestTransactionCard(ctx.env.DB, tx.id, userId, tx.identity, chatId, messageId);
      await flushTransactionCard(ctx.env, chatId, messageId);
    };
    const action = ctx.match[4];
    if (action === 'n') return;
    if (tx.split_kind === 'month') {
      await restore();
      await ctx.reply('Undo the across-month split before choosing one spending month.');
      return;
    }
    if (action === 'c') { await restore(); return; }
    if (action && tx.revision !== Number(ctx.match[3])) {
      await restore();
      await ctx.reply('That entry changed. Open Spending month again to use its current details.');
      return;
    }
    if (!action || action.startsWith('y')) {
      const selected = tx.spending_month ?? paymentDate(tx).slice(0, 7);
      const year = action ? Number(action.slice(1)) : Number(selected.slice(0, 4));
      if (!Number.isInteger(year) || year < 1900 || year > 9999) return;
      if (!job) await restore(); // Bind this message to the transaction identity before opening the picker.
      await ctx.editMessageText(
        `Count the full ${fmtAmount(tx.amount, tx.currency)} in which month?\n${tx.note ?? tx.receiver ?? tx.category}\nPaid: ${paymentDate(tx)}`,
        { reply_markup: spendingMonthKeyboard(tx, year) });
      return;
    }
    if (action !== 'r' && !isSpendingMonth(action)) return;
    // Register before writing: the update trigger schedules a durable card refresh.
    await requestTransactionCard(ctx.env.DB, tx.id, userId, tx.identity, ctx.chat.id, messageId);
    const saved = await setSpendingMonth(ctx.env.DB, userId, tx, action === 'r' ? null : action);
    const refreshed = await flushTransactionCard(ctx.env, chatId, messageId);
    if (!saved) await ctx.reply('That entry changed. Open Spending month again.');
    else if (!refreshed) await ctx.reply('Spending month saved. The card will refresh shortly.');
  });
}
