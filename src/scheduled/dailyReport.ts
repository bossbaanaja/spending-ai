import { deleteOldBatches, getDailyUserSummaries, type DailyUserSummary } from "../db/repo";
import { fmtAmount } from "../bot/card";
import { sendTelegramMessage } from "../services/telegram";

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Previous Bangkok calendar date, anchored to the cron's scheduled time. */
export function previousBangkokDate(scheduledTime: number): string {
  return new Date(scheduledTime + BANGKOK_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

function dateLabel(date: string): string {
  const month = MONTH_NAMES[Number(date.slice(5, 7)) - 1];
  return month ? `${Number(date.slice(8, 10))} ${month} ${date.slice(0, 4)}` : date;
}

export function formatDailyReport(summary: DailyUserSummary, date: string): string {
  const lines = [`🌅 Yesterday's spending — ${dateLabel(date)}`];
  if (summary.count === 0) {
    lines.push("", "No spending recorded yesterday.");
    return lines.join("\n");
  }

  if (summary.totals.length === 1) {
    const total = summary.totals[0];
    if (total) {
      lines.push(
        `Total: ${fmtAmount(total.total, total.currency)} across ${summary.count} slip${summary.count === 1 ? "" : "s"}`,
        "",
      );
    }
  } else {
    lines.push("Totals:");
    for (const total of summary.totals) {
      lines.push(`• ${fmtAmount(total.total, total.currency)} across ${total.count} slip${total.count === 1 ? "" : "s"}`);
    }
    lines.push("");
  }
  for (const category of summary.byCategory) {
    lines.push(`${category.category}: ${fmtAmount(category.total, category.currency)}`);
  }
  lines.push("", "Use /dashboard to see your monthly summary.");
  return lines.join("\n");
}

export async function sendDailyReports(env: Env, scheduledTime: number): Promise<void> {
  const date = previousBangkokDate(scheduledTime);
  const summaries = await getDailyUserSummaries(env.DB, date);
  let failed = 0;

  for (const summary of summaries) {
    try {
      await sendTelegramMessage(env.BOT_TOKEN, summary.telegramId, formatDailyReport(summary, date));
    } catch (error) {
      failed += 1;
      console.error(
        JSON.stringify({
          event: "daily_report_send_failed",
          telegram_id: summary.telegramId,
          date,
          error: String(error),
        }),
      );
    }
  }

  // Album bookkeeping is only needed while a batch can still be answered.
  // Swallow failures: housekeeping must never cost anyone their daily report.
  try {
    const removed = await deleteOldBatches(env.DB);
    if (removed > 0) console.log(JSON.stringify({ event: "slip_batches_pruned", removed }));
  } catch (error) {
    console.error(JSON.stringify({ event: "slip_batches_prune_failed", error: String(error) }));
  }

  console.log(JSON.stringify({ event: "daily_reports_finished", date, sent: summaries.length - failed, failed }));
  if (failed > 0) throw new Error(`daily report failed for ${failed} of ${summaries.length} users`);
}
