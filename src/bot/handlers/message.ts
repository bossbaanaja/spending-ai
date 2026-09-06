import type { Bot } from "grammy";
import {
  deletePending,
  deletePendingCustomSplit,
  getActiveBatch,
  getPending,
  getPendingCustomSplit,
  getTransaction,
  splitByCustom,
} from "../../db/repo";
import { parseCustomAmount } from "../../split";
import type { ParsedSlip } from "../../types";
import { runAssistant } from "../assistant";
import { answerAskNote, completeBatchWithNote } from "../batch";
import type { BotContext } from "../bot";
import { fmtAmount, formatTxCard, saveParsedSlip } from "../card";
import { txKeyboard } from "../keyboards";

/**
 * Plain-text fallback, registered last so real commands win. Answers whatever
 * the bot last asked for — an album's note, or a single pending slip's note
 * (both fast paths, no LLM) — and otherwise goes to the chat assistant, which
 * can answer spending questions or propose an edit/delete behind a confirm
 * button.
 */
export function registerMessage(bot: Bot<BotContext>) {
  bot.on("message:text", async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const text = ctx.message.text.trim();

    // Escape hatch: user wants to cancel whatever was waiting on them.
    if (text.toLowerCase() === "/cancel" || text.toLowerCase() === "cancel" || text === "ยกเลิก") {
      const pendingSplit = await getPendingCustomSplit(ctx.env.DB, user.id);
      if (pendingSplit) {
        await deletePendingCustomSplit(ctx.env.DB, user.id);
        if (pendingSplit.message_id && ctx.chat) {
          const tx = await getTransaction(ctx.env.DB, pendingSplit.tx_id, user.id);
          if (tx) {
            await ctx.api
              .editMessageText(ctx.chat.id, pendingSplit.message_id, formatTxCard(tx), {
                reply_markup: txKeyboard(tx),
              })
              .catch(() => {});
          }
        }
        await ctx.reply("Split cancelled.");
        return;
      }
    }

    // Unknown command — don't consume it as a slip note or a question.
    if (text.startsWith("/")) {
      await ctx.reply("I don't know that command. Send /help to see everything I can do.");
      return;
    }

    // An album waiting on the user outranks everything else: it asked a
    // question, this is the answer.
    const batch = await getActiveBatch(ctx.env.DB, user.id);
    if (batch) {
      try {
        if (batch.state === "asking") {
          await answerAskNote(ctx.api, ctx.env, user, batch, text);
        } else {
          await completeBatchWithNote(ctx.api, ctx.env, user, batch, text);
        }
      } catch (err) {
        console.error(JSON.stringify({ event: "batch_note_failed", batch: batch.id, error: String(err) }));
        await ctx.reply("😕 I couldn't finish saving those slips — please try that note again.");
      }
      return;
    }

    // A custom split waiting on the user's share amount.
    const pendingSplit = await getPendingCustomSplit(ctx.env.DB, user.id);
    if (pendingSplit) {
      const created = Date.parse(`${pendingSplit.created_at.replace(" ", "T")}Z`);
      const isExpired = !Number.isNaN(created) && Date.now() - created > 15 * 60 * 1000;
      if (isExpired) {
        await deletePendingCustomSplit(ctx.env.DB, user.id);
      } else {
        const tx = await getTransaction(ctx.env.DB, pendingSplit.tx_id, user.id);
        if (!tx) {
          await deletePendingCustomSplit(ctx.env.DB, user.id);
          await ctx.reply("That entry no longer exists.");
          return;
        }

        const slipTotal = tx.original_amount ?? tx.amount;
        const myShare = parseCustomAmount(text);

        if (myShare === null) {
          await ctx.reply(
            "I couldn't understand that amount. Please type a number (e.g. 2280 or 2800 - 520), or /cancel to cancel.",
          );
          return;
        }

        if (myShare <= 0) {
          await ctx.reply("Your share must be more than ฿0. Please type a valid amount, or /cancel to cancel.");
          return;
        }

        if (myShare > slipTotal) {
          await ctx.reply(
            `That's more than the ${fmtAmount(slipTotal, tx.currency)} on the slip. Your share can't exceed the total.`,
          );
          return;
        }

        const updated = await splitByCustom(ctx.env.DB, tx.id, user.id, myShare);
        await deletePendingCustomSplit(ctx.env.DB, user.id);

        if (!updated) {
          await ctx.reply("Couldn't update that entry — please try again.");
          return;
        }

        // Restore and update the card message in place
        if (pendingSplit.message_id && ctx.chat) {
          await ctx.api
            .editMessageText(ctx.chat.id, pendingSplit.message_id, formatTxCard(updated), {
              reply_markup: txKeyboard(updated),
            })
            .catch(() => {});
        }

        await ctx.reply(
          `✅ Saved your share: ${fmtAmount(updated.amount, updated.currency)} (slip was ${fmtAmount(slipTotal, tx.currency)}).`,
        );
        return;
      }
    }

    const pending = await getPending(ctx.env.DB, user.id);
    if (pending) {
      const parsed = JSON.parse(pending.parsed_json) as ParsedSlip;
      const reply = await saveParsedSlip(ctx.env.DB, user.id, parsed, text);
      await deletePending(ctx.env.DB, user.id);
      await ctx.reply(reply.text, reply.keyboard ? { reply_markup: reply.keyboard } : undefined);
      return;
    }

    // Status message first — the model call can queue for a minute on NIM's
    // side, and a silent bot reads as a dead bot.
    const status = await ctx.reply("🤔 Let me check…");
    try {
      const reply = await runAssistant(ctx.env, user, text);
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        reply.text,
        reply.keyboard ? { reply_markup: reply.keyboard } : undefined,
      );
      // A long listing spills into follow-up messages. Sequential on purpose:
      // back-to-back sends to one chat brush Telegram's rate limit.
      for (const extra of reply.extras ?? []) {
        await ctx.reply(extra);
      }
      console.error(JSON.stringify({ event: "assistant_done", chars: reply.text.length, extras: reply.extras?.length ?? 0 }));
    } catch (err) {
      console.error(JSON.stringify({ event: "assistant_failed", error: String(err) }));
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        "😕 I couldn't work that one out just now — please try again in a moment.",
      );
    }
  });
}
