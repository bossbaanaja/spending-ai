import { InlineKeyboard } from "grammy";
import { SPLIT_COUNTS } from "../split";
import { CATEGORIES, type TransactionRow } from "../types";

/** Category-override buttons + split/delete, attached to every confirmation card. */
export function txKeyboard(tx: TransactionRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  CATEGORIES.forEach((category, i) => {
    kb.text(category, `cat:${tx.id}:${category}`);
    if (i % 4 === 3) kb.row();
  });

  // An entry already spread over months hides Split: dividing one instalment
  // again would be ambiguous. Split by people first, spread second.
  if (tx.split_kind !== "month") kb.text("✂️ Split", `split:${tx.id}`);
  if (tx.split_kind) kb.text("↩️ Undo split", `unsplit:${tx.id}`);

  if (tx.split_group && tx.split_total) {
    kb.text(`🗑 Delete all ${tx.split_total}`, `delgrp:${tx.split_group}`);
  } else {
    kb.text("🗑 Delete", `del:${tx.id}`);
  }
  return kb;
}

/**
 * Offered on an album's summary: one note covers the whole batch by default,
 * this walks the slips one at a time instead. Only worth showing when there
 * is more than one slip to walk.
 */
export function batchNoteKeyboard(batchId: number): InlineKeyboard {
  return new InlineKeyboard().text("📝 Different note for each", `bnote:each:${batchId}`);
}

/** Shown under each "slip n of N — what was this for?" question. */
export function batchAskKeyboard(batchId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏭ Skip", `bnote:skip:${batchId}`)
    .text("✅ Stop asking", `bnote:stop:${batchId}`);
}

/** Step 1 of the split flow: which kind of split. */
export function splitModeKeyboard(txId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Between people", `splitp:${txId}`)
    .text("🗓 Across months", `splitm:${txId}`)
    .row()
    .text("◀️ Back", `splitback:${txId}`);
}

/** Step 2: how many ways. `mode` is the callback prefix — "splitp" or "splitm". */
export function splitCountKeyboard(txId: number, mode: "splitp" | "splitm"): InlineKeyboard {
  const kb = new InlineKeyboard();
  SPLIT_COUNTS.forEach((n, i) => {
    kb.text(String(n), `${mode}:${txId}:${n}`);
    if (i % 5 === 4) kb.row();
  });
  return kb.row().text("◀️ Back", `split:${txId}`);
}

/**
 * Shown by /undo before anything is deleted.
 * `key` is either a numeric transaction id (single entry) or a split_group
 * string (month-split group), encoded in the callback data so the confirm
 * handler knows what to wipe.
 */
export function undoConfirmKeyboard(key: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Yes, delete", `undoconfirm:${key}`)
    .text("❌ Cancel", "undocancel");
}
