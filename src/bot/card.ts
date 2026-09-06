import type { InlineKeyboard } from "grammy";
import { insertTransaction } from "../db/repo";
import { monthRangeLabel } from "../split";
import type { ParsedSlip, TransactionRow } from "../types";
import { txKeyboard } from "./keyboards";

export function fmtAmount(amount: number, currency = "THB"): string {
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return currency === "THB" ? `฿${formatted}` : `${formatted} ${currency}`;
}

export function formatTxCard(tx: TransactionRow): string {
  const lines = [`✅ Saved ${fmtAmount(tx.amount, tx.currency)} — ${tx.category}`];
  const split = formatSplitLine(tx);
  if (split) lines.push(split);
  if (tx.note) lines.push(`📝 ${tx.note}`);
  if (tx.receiver) lines.push(`🏪 ${tx.receiver}`);
  const bankLine = [tx.bank, tx.slip_datetime].filter(Boolean).join(" · ");
  if (bankLine) lines.push(`🏦 ${bankLine}`);
  if (tx.trans_ref) lines.push(`ref: ${tx.trans_ref}`);
  lines.push("", "Wrong category? Tap below to fix it.");
  return lines.join("\n");
}

/** The one line that explains why the saved amount differs from the slip. */
export function formatSplitLine(tx: TransactionRow): string | null {
  const paid = tx.original_amount !== null ? fmtAmount(tx.original_amount, tx.currency) : null;

  if (tx.split_kind === "people") {
    if (tx.split_total) {
      return `👥 My share — ${paid ?? "slip"} ÷ ${tx.split_total} people`;
    }
    return `✏️ My share — ${paid ?? "slip"} on the slip`;
  }
  // No "of ฿X" here: after a people-split the pre-split amount is the whole slip,
  // not the sum being spread, and a subtly wrong total is worse than no total.
  if (tx.split_kind === "month" && tx.split_part && tx.split_total) {
    const range = monthRangeLabel(tx);
    return `🗓 Part ${tx.split_part}/${tx.split_total}${range ? ` · ${range}` : ""}`;
  }
  return null;
}

export interface BatchOutcomeCounts {
  /** Slips being counted — saved rows after the write, parsed slips before it. */
  saved: { amount: number; currency: string }[];
  duplicates: number;
  failed: number;
  /** Photos past the per-album cap, which were never read. */
  skipped: number;
}

/**
 * The one message that stands in for a whole album: what got logged, what was
 * already there, and what couldn't be read. The per-slip cards follow it, so
 * this deliberately stays short.
 */
export function formatBatchSummary(counts: BatchOutcomeCounts, heading: string): string {
  const currency = counts.saved[0]?.currency ?? "THB";
  const total = counts.saved.reduce((sum, tx) => sum + tx.amount, 0);
  // "— ฿0 total" is noise when nothing was saved (e.g. the whole album was
  // already logged), so the heading stands alone there.
  const lines = [counts.saved.length > 0 ? `${heading} — ${fmtAmount(total, currency)} total` : heading];

  const detail: string[] = [];
  if (counts.saved.length > 0) detail.push(`${counts.saved.length} saved`);
  if (counts.duplicates > 0) detail.push(`${counts.duplicates} already logged`);
  if (counts.failed > 0) detail.push(`${counts.failed} couldn't be read`);
  if (detail.length > 1 || counts.saved.length === 0) lines.push(detail.join(" · "));
  if (counts.failed > 0) lines.push("Send the unreadable one again on its own and I'll retry it.");
  if (counts.skipped > 0) {
    lines.push(`${counts.skipped} more weren't processed — send those as a second batch.`);
  }
  return lines.join("\n");
}

/**
 * Inserts a parsed slip and returns the reply to send — the confirmation card
 * with override buttons, or a duplicate warning when trans_ref was seen before.
 */
export async function saveParsedSlip(
  db: D1Database,
  userId: number,
  parsed: ParsedSlip,
  note: string | null,
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const result = await insertTransaction(db, userId, parsed, note);
  if (result === "duplicate") {
    return {
      text: `⚠️ This slip is already logged (ref ${parsed.trans_ref ?? "unknown"}) — skipped to avoid a double entry.`,
    };
  }
  return { text: formatTxCard(result), keyboard: txKeyboard(result) };
}
