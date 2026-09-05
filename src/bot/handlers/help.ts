import type { Bot } from "grammy";
import type { BotContext } from "../bot";
import { HELP_TEXT } from "../help";

/**
 * /help — a fixed message. No LLM, no OCR, no database, so it costs nothing
 * against the webhook time budget and can never leave a status bubble hanging.
 */
export function registerHelp(bot: Bot<BotContext>) {
  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });
}
