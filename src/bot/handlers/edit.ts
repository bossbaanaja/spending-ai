import type { Bot } from "grammy";
import {
  deletePendingCustomSplit,
  deleteSplitGroup,
  deleteTransaction,
  getLatestTransaction,
  getTransaction,
  setPendingCustomSplit,
  splitByMonths,
  splitByPeople,
  undoSplit,
  updateCategory,
} from "../../db/repo";
import { getBatch, isBatchAnswerable } from "../../db/repo";
import { isSplitCount } from "../../split";
import { asCategory } from "../../types";
import { advanceNoteWalk, finishNoteWalk, startNoteWalk } from "../batch";
import type { BotContext } from "../bot";
import { fmtAmount, formatTxCard } from "../card";
import {
  splitCountKeyboard,
  splitCustomCancelKeyboard,
  splitModeKeyboard,
  txKeyboard,
  undoConfirmKeyboard,
} from "../keyboards";

/** Inline-button callbacks (change category, split, delete) + /undo. */
export function registerEdit(bot: Bot<BotContext>) {
  bot.callbackQuery(/^cat:(\d+):(.+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const txId = Number(ctx.match[1]);
    const category = asCategory(ctx.match[2]);

    const updated = await updateCategory(ctx.env.DB, txId, user.id, category);
    if (!updated) {
      await ctx.answerCallbackQuery({ text: "That entry no longer exists." });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Category → ${category}` });
    await ctx.editMessageText(formatTxCard(updated), { reply_markup: txKeyboard(updated) });
  });

  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const txId = Number(ctx.match[1]);

    const deleted = await deleteTransaction(ctx.env.DB, txId, user.id);
    await ctx.answerCallbackQuery({ text: deleted ? "Deleted." : "Already gone." });
    if (deleted) await ctx.editMessageText("🗑 Entry deleted.");
  });

  // ---------- split ----------

  // Step 1: ✂️ Split — which kind?
  bot.callbackQuery(/^split:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    await deletePendingCustomSplit(ctx.env.DB, user.id);
    const tx = await getTransaction(ctx.env.DB, Number(ctx.match[1]), user.id);
    if (!tx) {
      await ctx.answerCallbackQuery({ text: "That entry no longer exists." });
      return;
    }
    const total = tx.original_amount ?? tx.amount;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Split ${fmtAmount(total, tx.currency)}${tx.note ? ` (${tx.note})` : ""} — how?\n\n` +
        "👥 Between people — you paid for the group, keep only your share.\n" +
        "✏️ My share was… — enter the exact amount you paid.\n" +
        "🗓 Across months — one payment that covers several months.",
      { reply_markup: splitModeKeyboard(tx.id) },
    );
  });

  // Step 2: how many ways? Same grid for both kinds, different prefix.
  bot.callbackQuery(/^(splitp|splitm):(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (user) await deletePendingCustomSplit(ctx.env.DB, user.id);
    const mode = ctx.match[1] as "splitp" | "splitm";
    const txId = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      mode === "splitp"
        ? "Paid for how many people (including you)?"
        : "Spread it over how many months (starting this one)?",
      { reply_markup: splitCountKeyboard(txId, mode) },
    );
  });

  // Step 2c: custom share — prompt the user for the amount
  bot.callbackQuery(/^splitc:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const txId = Number(ctx.match[1]);
    const tx = await getTransaction(ctx.env.DB, txId, user.id);
    if (!tx) {
      await ctx.answerCallbackQuery({ text: "That entry no longer exists." });
      return;
    }

    const total = tx.original_amount ?? tx.amount;
    const messageId = ctx.callbackQuery.message?.message_id ?? null;
    await setPendingCustomSplit(ctx.env.DB, user.id, txId, messageId);

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Split ${fmtAmount(total, tx.currency)}${tx.note ? ` (${tx.note})` : ""} — my share\n\n` +
        "Reply with your share below (or tap Back to cancel).",
      { reply_markup: splitCustomCancelKeyboard(txId) },
    );
    await ctx.reply(
      `How much was actually yours? Reply with the amount (e.g. 2280 or 2800 - 520):`,
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "e.g. 2280 or 2800 - 520",
        },
      },
    );
  });

  // Step 3a: keep my share.
  bot.callbackQuery(/^splitp:(\d+):(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    await deletePendingCustomSplit(ctx.env.DB, user.id);
    const ways = Number(ctx.match[2]);
    if (!isSplitCount(ways)) {
      await ctx.answerCallbackQuery({ text: "That isn't a split I can do." });
      return;
    }

    const updated = await splitByPeople(ctx.env.DB, Number(ctx.match[1]), user.id, ways);
    if (!updated) {
      await ctx.answerCallbackQuery({ text: "That entry no longer exists." });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Your share: ${fmtAmount(updated.amount, updated.currency)}` });
    await ctx.editMessageText(formatTxCard(updated), { reply_markup: txKeyboard(updated) });
  });

  // Step 3b: spread across months.
  bot.callbackQuery(/^splitm:(\d+):(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    await deletePendingCustomSplit(ctx.env.DB, user.id);
    const months = Number(ctx.match[2]);
    if (!isSplitCount(months)) {
      await ctx.answerCallbackQuery({ text: "That isn't a split I can do." });
      return;
    }

    const updated = await splitByMonths(ctx.env.DB, Number(ctx.match[1]), user.id, months);
    if (!updated) {
      await ctx.answerCallbackQuery({ text: "That entry is gone, or is already spread over months." });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Split into ${months} monthly parts.` });
    await ctx.editMessageText(
      `${formatTxCard(updated)}\n\nEach month is its own entry — /dashboard for any of those months shows its part.`,
      { reply_markup: txKeyboard(updated) },
    );
  });

  bot.callbackQuery(/^unsplit:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    await deletePendingCustomSplit(ctx.env.DB, user.id);

    const restored = await undoSplit(ctx.env.DB, Number(ctx.match[1]), user.id);
    if (!restored) {
      await ctx.answerCallbackQuery({ text: "Nothing to undo on that entry." });
      return;
    }
    await ctx.answerCallbackQuery({ text: `Back to ${fmtAmount(restored.amount, restored.currency)}` });
    await ctx.editMessageText(formatTxCard(restored), { reply_markup: txKeyboard(restored) });
  });

  bot.callbackQuery(/^delgrp:(.+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    await deletePendingCustomSplit(ctx.env.DB, user.id);

    const removed = await deleteSplitGroup(ctx.env.DB, ctx.match[1] ?? "", user.id);
    await ctx.answerCallbackQuery({ text: removed > 0 ? "Deleted." : "Already gone." });
    if (removed > 0) await ctx.editMessageText(`🗑 Deleted all ${removed} monthly parts.`);
  });

  // ◀️ Back out of the split menu — redraw the card unchanged.
  bot.callbackQuery(/^splitback:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    await deletePendingCustomSplit(ctx.env.DB, user.id);
    const tx = await getTransaction(ctx.env.DB, Number(ctx.match[1]), user.id);
    await ctx.answerCallbackQuery();
    if (tx) await ctx.editMessageText(formatTxCard(tx), { reply_markup: txKeyboard(tx) });
  });

  // ---------- per-slip notes for a photo album ----------

  // "📝 Different note for each" on an album's summary.
  bot.callbackQuery(/^bnote:each:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const batch = await getBatch(ctx.env.DB, Number(ctx.match[1]), user.id);
    if (!batch || batch.state === "asking" || batch.state === "collecting") {
      await ctx.answerCallbackQuery({ text: "Those slips aren't waiting any more." });
      return;
    }
    // Starting a walk on an album older than the answerable window would ask
    // a question the reply can never reach — getActiveBatch wouldn't match it,
    // so the answer would go to the chat assistant instead.
    if (!isBatchAnswerable(batch)) {
      await ctx.answerCallbackQuery({ text: "That batch is too old — edit the entries individually." });
      return;
    }
    await ctx.answerCallbackQuery();
    // The button has done its job — drop it so it can't start a second walk.
    await ctx.editMessageReplyMarkup().catch(() => {});
    await startNoteWalk(ctx.api, ctx.env, user, batch);
  });

  bot.callbackQuery(/^bnote:skip:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const batch = await getBatch(ctx.env.DB, Number(ctx.match[1]), user.id);
    if (!batch || batch.state !== "asking") {
      await ctx.answerCallbackQuery({ text: "That question has already been answered." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await advanceNoteWalk(ctx.api, ctx.env, user, batch, null);
  });

  bot.callbackQuery(/^bnote:stop:(\d+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;
    const batch = await getBatch(ctx.env.DB, Number(ctx.match[1]), user.id);
    if (!batch) {
      await ctx.answerCallbackQuery({ text: "Already done." });
      return;
    }
    await ctx.answerCallbackQuery();
    await finishNoteWalk(ctx.api, ctx.env, batch, "✅ Done — the rest keep the notes they have.");
  });

  // "Cancel" on the assistant's confirm cards — nothing to do but tidy up.
  bot.callbackQuery("dismiss", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Okay — nothing changed.");
  });

  bot.command("undo", async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;

    const latest = await getLatestTransaction(ctx.env.DB, user.id);
    if (!latest) {
      await ctx.reply("Nothing to undo — no entries yet.");
      return;
    }

    // Build a human-readable preview so the user knows exactly what will go.
    const amount = latest.split_group
      ? (latest.original_amount ?? latest.amount)
      : latest.amount;
    const parts = latest.split_group ? ` (all monthly parts)` : "";
    const label = `${fmtAmount(amount, latest.currency)}${parts} — ${latest.category}${latest.note ? ` (${latest.note})` : ""}`;

    // Encode the deletion target: split_group string or numeric id.
    const key = latest.split_group ?? String(latest.id);

    await ctx.reply(
      `↩️ Remove this entry?\n\n${label}`,
      { reply_markup: undoConfirmKeyboard(key) },
    );
  });

  // User confirmed — now actually delete.
  bot.callbackQuery(/^undoconfirm:(.+)$/, async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;

    const key = ctx.match[1] ?? "";
    const asId = Number(key);
    let removed: number;
    let amount: number;
    let currency: string;
    let label: string;

    if (!Number.isNaN(asId)) {
      // Single transaction.
      const tx = await getTransaction(ctx.env.DB, asId, user.id);
      const deleted = await deleteTransaction(ctx.env.DB, asId, user.id);
      removed = deleted ? 1 : 0;
      amount = tx?.amount ?? 0;
      currency = tx?.currency ?? "THB";
      label = tx
        ? `${fmtAmount(tx.amount, tx.currency)} — ${tx.category}${tx.note ? ` (${tx.note})` : ""}`
        : "(already gone)";
    } else {
      // Month-split group — fetch one row first for the display amount.
      const tx = await getLatestTransaction(ctx.env.DB, user.id);
      removed = await deleteSplitGroup(ctx.env.DB, key, user.id);
      amount = tx?.original_amount ?? tx?.amount ?? 0;
      currency = tx?.currency ?? "THB";
      label = tx
        ? `${fmtAmount(tx.original_amount ?? tx.amount, tx.currency)} all ${removed} parts — ${tx.category}${tx.note ? ` (${tx.note})` : ""}`
        : "(already gone)";
    }

    await ctx.answerCallbackQuery({ text: removed > 0 ? "Deleted." : "Already gone." });
    if (removed > 0) {
      await ctx.editMessageText(`🗑 Removed: ${label}`);
    } else {
      await ctx.editMessageText("That entry was already gone.");
    }
  });

  // User cancelled.
  bot.callbackQuery("undocancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("Okay — nothing deleted.");
  });
}

