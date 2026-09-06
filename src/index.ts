import type { Update } from "grammy/types";
import { getBot } from "./bot/bot";
import { sendDailyReports } from "./scheduled/dailyReport";

// If Telegram doesn't get a 200 in time (we now hold the response while model
// calls run), it redelivers the update. Isolate-local dedup is enough: the
// retry lands seconds later and almost always hits the same isolate.
const seenUpdates = new Set<number>();

/** Constant-time comparison for the webhook secret header. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(secret, env.WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }

      let update: Update;
      try {
        update = await request.json<Update>();
      } catch {
        return new Response("bad request", { status: 400 });
      }

      if (seenUpdates.has(update.update_id)) return new Response("ok");
      seenUpdates.add(update.update_id);

      // Arrival timing — logged before any processing so the timestamp is
      // as close to actual receipt as possible.
      const mediaGroupId = (update as { message?: { media_group_id?: string } }).message?.media_group_id;
      if (mediaGroupId) {
        console.error(JSON.stringify({
          event: "album_photo_arrived",
          update_id: update.update_id,
          media_group_id: mediaGroupId,
          arrived_at: Date.now(),
          arrived_iso: new Date().toISOString(),
        }));
      }
      if (seenUpdates.size > 1000) {
        for (const id of seenUpdates) {
          seenUpdates.delete(id);
          break;
        }
      }

      // Budget dance: work running while the request is open has no wall-clock
      // limit, but once we respond, waitUntil() only gets ~30s more before the
      // runtime cancels it (observed in prod). So hold the response up to 50s
      // and only spill still-running work into the waitUntil grace period.
      // Combined budget ≈ 80s — NIM queue waits of 60s+ have been measured,
      // and every internal retry loop caps itself under this ceiling so a
      // too-slow call fails with a "try again" message instead of a stuck
      // status bubble.
      const bot = getBot(env);
      const work = bot
        .init()
        .then(() => bot.handleUpdate(update))
        .catch((err) => {
          console.error(JSON.stringify({ event: "update_failed", error: String(err) }));
        });
      const HOLD = Symbol();
      const raced = await Promise.race([work, new Promise((r) => setTimeout(() => r(HOLD), 50_000))]);
      if (raced === HOLD) ctx.waitUntil(work);
      return new Response("ok");
    }

    return new Response("spending-ai bot is running");
  },

  async scheduled(controller, env): Promise<void> {
    await sendDailyReports(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
