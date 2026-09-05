import type { Bot } from "grammy";
import { getMonthSummary } from "../../db/repo";
import { buildCategoryChartUrl } from "../../services/chart";
import type { BotContext } from "../bot";
import { fmtAmount } from "../card";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Current month in Bangkok time (UTC+7), as "YYYY-MM". */
function currentBangkokMonth(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1];
  return name ? `${name} ${month.slice(0, 4)}` : month;
}

/** /dashboard [YYYY-MM] — text summary + QuickChart image. */
export function registerDashboard(bot: Bot<BotContext>) {
  bot.command("dashboard", async (ctx) => {
    const user = ctx.dbUser;
    if (!user) return;

    const arg = (ctx.match ?? "").trim();
    const month = /^\d{4}-\d{2}$/.test(arg) ? arg : currentBangkokMonth();
    const label = monthLabel(month);

    const summary = await getMonthSummary(ctx.env.DB, user.id, month);
    if (summary.count === 0) {
      await ctx.reply(
        `No spending recorded for ${label} yet.\n\nSend me a slip photo to get started` +
          ` — or check another month with /dashboard YYYY-MM.`,
      );
      return;
    }

    const lines = [
      `📊 ${label}`,
      `Total: ${fmtAmount(summary.total)} across ${summary.count} slip${summary.count === 1 ? "" : "s"}`,
      "",
    ];
    for (const c of summary.byCategory) {
      const pct = summary.total > 0 ? Math.round((c.total / summary.total) * 100) : 0;
      lines.push(`${c.category}: ${fmtAmount(c.total)} (${pct}%)`);
    }
    if (summary.topReceivers.length > 0) {
      lines.push("", "Top merchants:");
      for (const r of summary.topReceivers) {
        lines.push(`• ${r.receiver} — ${fmtAmount(r.total)} (${r.count}×)`);
      }
    }
    await ctx.reply(lines.join("\n"));

    try {
      await ctx.replyWithPhoto(buildCategoryChartUrl(summary, label));
    } catch (err) {
      // The text summary already went out — a chart hiccup shouldn't kill the reply.
      console.error(JSON.stringify({ event: "chart_failed", error: String(err) }));
    }
  });
}
