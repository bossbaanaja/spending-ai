import type { Bot } from "grammy";
import { upsertUser } from "../../db/repo";
import type { BotContext } from "../bot";
import { SHORT_USAGE } from "../help";

/** /start <token> — invite-token registration. Registered before the auth gate. */
export function registerStart(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    const token = (ctx.match ?? "").trim();

    if (!token) {
      if (ctx.dbUser) {
        await ctx.reply(`You're already set up, ${ctx.dbUser.display_name ?? "friend"}!\n\n${SHORT_USAGE}`);
      } else {
        await ctx.reply("Hi! This bot is invite-only. Send /start <invite token> to get access.");
      }
      return;
    }

    const adminTokens = (ctx.env.ADMIN_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const memberTokens = ctx.env.INVITE_TOKENS.split(",").map((t) => t.trim()).filter(Boolean);

    const role = adminTokens.includes(token) ? "admin" : memberTokens.includes(token) ? "member" : null;
    if (!role) {
      await ctx.reply("That invite token isn't valid — double-check it and try again.");
      return;
    }

    const from = ctx.from;
    if (!from) return;
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ") || null;
    await upsertUser(ctx.env.DB, from.id, displayName, token, role);
    await ctx.reply(`🎉 Welcome${displayName ? `, ${displayName}` : ""}! You're all set.\n\n${SHORT_USAGE}`);
  });
}
