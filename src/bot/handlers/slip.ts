import type { Bot, InlineKeyboard } from "grammy";
import { deletePendingCustomSplit, setPending } from "../../db/repo";
import { parseSlip } from "../../services/slipParser";
import { downloadPhotoBase64 } from "../../services/telegramFile";
import { SlipTimer } from "../../services/timing";
import { handleAlbumPhoto, supersedeActiveBatch } from "../batch";
import type { BotContext } from "../bot";
import { fmtAmount, saveParsedSlip } from "../card";

/** Photo → download → NIM parse → save (caption present) or hold pending (no caption). */
export function registerSlip(bot: Bot<BotContext>) {
  bot.on("message:photo", async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;

    // A new photo replaces any active custom split prompt.
    await deletePendingCustomSplit(ctx.env.DB, user.id);

    // Second-largest size: plenty of resolution for slip text, and reliably
    // under NIM's ~180KB inline-image limit (the largest size can exceed it).
    const photos = ctx.message.photo;
    const photo = photos.length >= 2 ? photos[photos.length - 2] : photos[photos.length - 1];
    if (!photo) return;

    // Several slips sent at once arrive as one update per photo, all sharing a
    // media_group_id. batch.ts handles the whole album as a unit; everything
    // below is the single-slip path, unchanged.
    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
      await handleAlbumPhoto(ctx.api, ctx.env, user, {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        mediaGroupId,
        fileId: photo.file_id,
        caption: ctx.message.caption?.trim() || null,
      });
      return;
    }

    // Latency benchmarking: one reqId ties every stage of this slip together
    // in the logs. telegramLagMs is coarse (Telegram truncates message.date
    // to the second) but catches a slow inflow separately from our own work.
    const reqId = crypto.randomUUID().slice(0, 8);
    const timer = new SlipTimer(reqId);
    const telegramLagMs = Date.now() - ctx.message.date * 1000;

    // The status bubble and the photo download are independent — run them
    // concurrently instead of paying two Telegram round trips back-to-back.
    const downloadPromise = downloadPhotoBase64(ctx.env.BOT_TOKEN, photo.file_id, timer);
    // A download failure is handled at the await inside try/catch below; this
    // no-op branch only stops it from surfacing as an unhandled rejection if
    // it fails while the status reply is still in flight.
    downloadPromise.catch(() => {});

    const status = await ctx.reply("🔍 Reading your slip…");
    timer.mark("status_bubble_sent");
    const editStatus = (text: string, keyboard?: InlineKeyboard) =>
      ctx.api.editMessageText(ctx.chat.id, status.message_id, text, keyboard ? { reply_markup: keyboard } : undefined);

    try {
      const imageBase64 = await downloadPromise;
      const caption = ctx.message.caption?.trim() ?? "";
      const parsed = await parseSlip(imageBase64, caption, ctx.env, timer);

      if (caption) {
        const reply = await saveParsedSlip(ctx.env.DB, user.id, parsed, caption);
        await editStatus(reply.text, reply.keyboard);
        timer.mark("final_reply_sent");
        console.error(JSON.stringify({ event: "slip_done", ref: parsed.trans_ref }));
      } else {
        // One waiting slot per user — this question replaces any album's.
        await supersedeActiveBatch(ctx.env, user);
        await setPending(ctx.env.DB, user.id, photo.file_id, JSON.stringify(parsed));
        const to = parsed.receiver ? ` to ${parsed.receiver}` : "";
        await editStatus(
          `Got it — ${fmtAmount(parsed.amount, parsed.currency)}${to}.\n\nWhat was this for? (reply with a short note to save it)`,
        );
        timer.mark("final_reply_sent");
      }
      timer.logSummary({ telegramLagMs, outcome: caption ? "saved" : "pending" });
    } catch (err) {
      console.error(JSON.stringify({ event: "slip_failed", error: String(err) }));
      await editStatus(
        "😕 I couldn't read that slip. Try sending a clearer photo of it — or if it keeps failing, send it again later.",
      );
      timer.mark("error_reply_sent");
      timer.logSummary({ telegramLagMs, outcome: "error" });
    }
  });
}
