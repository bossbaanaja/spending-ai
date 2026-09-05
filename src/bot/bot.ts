import { Bot, type Context } from "grammy";
import { getUserByTelegramId } from "../db/repo";
import type { UserRow } from "../types";
import { registerDashboard } from "./handlers/dashboard";
import { registerEdit } from "./handlers/edit";
import { registerHelp } from "./handlers/help";
import { registerMessage } from "./handlers/message";
import { registerSlip } from "./handlers/slip";
import { registerStart } from "./handlers/start";

export type BotContext = Context & {
  env: Env;
  dbUser: UserRow | null;
};

// Config-scoped cache: env bindings are stable for the isolate's lifetime, so
// the bot is built once per isolate, not per update.
let cachedBot: Bot<BotContext> | null = null;

export function getBot(env: Env): Bot<BotContext> {
  if (cachedBot) return cachedBot;

  const bot = new Bot<BotContext>(env.BOT_TOKEN);

  // Attach env + the registered user (if any) to every update.
  bot.use(async (ctx, next) => {
    ctx.env = env;
    ctx.dbUser = ctx.from ? await getUserByTelegramId(env.DB, ctx.from.id) : null;
    await next();
  });

  // /start is reachable without registration — it IS the registration.
  registerStart(bot);

  // Auth gate: everything below requires an invite-token registration.
  bot.use(async (ctx, next) => {
    if (!ctx.dbUser) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "You need an invite first — send /start <token>." });
      } else {
        await ctx.reply("This bot is invite-only. Send /start <invite token> to get access.");
      }
      return;
    }
    await next();
  });

  registerEdit(bot); // callbacks + /undo
  registerHelp(bot);
  registerDashboard(bot);
  registerSlip(bot); // photos
  registerMessage(bot); // plain-text fallback — must be last

  bot.catch((err) => {
    console.error(JSON.stringify({ event: "bot_error", error: String(err.error) }));
  });

  cachedBot = bot;
  return bot;
}
