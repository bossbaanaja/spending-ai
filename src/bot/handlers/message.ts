import type { Bot } from "grammy";
import { deletePending, getActiveBatch, getPending } from "../../db/repo";
import type { ParsedSlip } from "../../types";
import { runAssistant } from "../assistant";
import { answerAskNote, completeBatchWithNote } from "../batch";
import type { BotContext } from "../bot";
import { saveParsedSlip } from "../card";

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
