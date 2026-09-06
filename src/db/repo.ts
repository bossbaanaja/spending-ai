import { divideAmount, monthParts } from "../split";
import type {
  BatchItemOutcome,
  BatchState,
  Category,
  ParsedSlip,
  PendingSlipRow,
  Role,
  SlipBatchItemRow,
  SlipBatchRow,
  TransactionRow,
  UserRow,
} from "../types";

// COALESCE: prefer the datetime printed on the slip; fall back to when we logged it.
const MONTH_EXPR = "substr(COALESCE(slip_datetime, created_at), 1, 7)";
const DAY_EXPR = "substr(COALESCE(slip_datetime, created_at), 9, 2)";

/** Today in Bangkok time (UTC+7) as "YYYY-MM-DD". */
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------- users ----------

export async function getUserByTelegramId(db: D1Database, telegramId: number): Promise<UserRow | null> {
  return await db.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(telegramId).first<UserRow>();
}

export async function upsertUser(
  db: D1Database,
  telegramId: number,
  displayName: string | null,
  token: string,
  role: Role,
): Promise<UserRow> {
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, display_name, token, role) VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET display_name = excluded.display_name, token = excluded.token, role = excluded.role
       RETURNING *`,
    )
    .bind(telegramId, displayName, token, role)
    .first<UserRow>();
  if (!row) throw new Error("user upsert returned no row");
  return row;
}

// ---------- transactions ----------

/** Inserts a parsed slip. Returns "duplicate" when trans_ref was already logged. */
export async function insertTransaction(
  db: D1Database,
  userId: number,
  parsed: ParsedSlip,
  note: string | null,
): Promise<TransactionRow | "duplicate"> {
  try {
    const row = await db
      .prepare(
        `INSERT INTO transactions
           (user_id, amount, currency, category, note, receiver, bank, trans_ref, slip_datetime, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .bind(
        userId,
        parsed.amount,
        parsed.currency,
        parsed.category,
        note,
        parsed.receiver,
        parsed.bank,
        parsed.trans_ref,
        parsed.datetime,
        JSON.stringify(parsed),
      )
      .first<TransactionRow>();
    if (!row) throw new Error("transaction insert returned no row");
    return row;
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) return "duplicate";
    throw err;
  }
}

export async function getTransaction(db: D1Database, id: number, userId: number): Promise<TransactionRow | null> {
  return await db
    .prepare("SELECT * FROM transactions WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<TransactionRow>();
}

/**
 * The entry "the last one" means to the user. A month-split inserts its later
 * instalments after the original row, so a plain id-DESC would answer with a
 * future-dated part 12 — the wrong target for /undo, "change my last slip to
 * Transport", and the assistant's propose tools. Part 1 is the row the user
 * actually created, and the one carrying original_amount.
 */
export async function getLatestTransaction(db: D1Database, userId: number): Promise<TransactionRow | null> {
  return await db
    .prepare(
      `SELECT * FROM transactions
        WHERE user_id = ? AND (split_kind IS NULL OR split_kind <> 'month' OR split_part = 1)
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<TransactionRow>();
}

export async function updateCategory(
  db: D1Database,
  id: number,
  userId: number,
  category: Category,
): Promise<TransactionRow | null> {
  return await db
    .prepare("UPDATE transactions SET category = ? WHERE id = ? AND user_id = ? RETURNING *")
    .bind(category, id, userId)
    .first<TransactionRow>();
}

export async function updateNote(
  db: D1Database,
  id: number,
  userId: number,
  note: string,
): Promise<TransactionRow | null> {
  return await db
    .prepare("UPDATE transactions SET note = ? WHERE id = ? AND user_id = ? RETURNING *")
    .bind(note, id, userId)
    .first<TransactionRow>();
}

export async function deleteTransaction(db: D1Database, id: number, userId: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM transactions WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return res.meta.changes > 0;
}

// ---------- splits ----------

/**
 * "I paid for the group": keeps only the user's share of the entry and drops the
 * rest — other people's money was never their spending. Re-splitting divides the
 * pre-split amount again, so tapping ÷4 then ÷5 gives a fifth, not a twentieth.
 */
export async function splitByPeople(
  db: D1Database,
  id: number,
  userId: number,
  ways: number,
): Promise<TransactionRow | null> {
  const tx = await getTransaction(db, id, userId);
  if (!tx) return null;

  const total = tx.original_amount ?? tx.amount;
  const share = divideAmount(total, ways)[0] ?? total;
  return await db
    .prepare(
      `UPDATE transactions
          SET amount = ?, original_amount = COALESCE(original_amount, amount),
              split_kind = 'people', split_part = 1, split_total = ?
        WHERE id = ? AND user_id = ?
       RETURNING *`,
    )
    .bind(share, ways, id, userId)
    .first<TransactionRow>();
}

/**
 * "My share was X": sets the amount to the user's typed figure, keeping
 * original_amount so undo restores the whole slip. split_total is NULL
 * to distinguish this custom amount from equal N-person splits.
 */
export async function splitByCustom(
  db: D1Database,
  id: number,
  userId: number,
  myShare: number,
): Promise<TransactionRow | null> {
  const tx = await getTransaction(db, id, userId);
  if (!tx) return null;

  return await db
    .prepare(
      `UPDATE transactions
          SET amount = ?, original_amount = COALESCE(original_amount, amount),
              split_kind = 'people', split_part = 1, split_total = NULL
        WHERE id = ? AND user_id = ?
       RETURNING *`,
    )
    .bind(myShare, id, userId)
    .first<TransactionRow>();
}

/**
 * Spreads one payment across N months as N rows, one dated in each month, so
 * every existing per-month query picks up the right slice without changes.
 * Applied after a people-split it spreads the user's share, not the full slip.
 */
export async function splitByMonths(
  db: D1Database,
  id: number,
  userId: number,
  months: number,
): Promise<TransactionRow | null> {
  const tx = await getTransaction(db, id, userId);
  if (!tx || tx.split_kind === "month") return null;

  const group = crypto.randomUUID();
  const [first, ...rest] = monthParts(tx, months);
  if (!first) return null;

  // SQLite evaluates every SET expression against the pre-update row, so the
  // COALESCE still sees the old amount even though amount is reassigned here.
  await db.batch([
    db
      .prepare(
        `UPDATE transactions
            SET amount = ?, slip_datetime = ?, original_amount = COALESCE(original_amount, amount),
                split_kind = 'month', split_group = ?, split_part = 1, split_total = ?
          WHERE id = ? AND user_id = ?`,
      )
      .bind(first.amount, first.slipDatetime, group, months, id, userId),
    ...rest.map((part) =>
      db
        .prepare(
          `INSERT INTO transactions
             (user_id, amount, currency, category, note, receiver, bank, trans_ref, slip_datetime,
              raw_json, split_kind, split_group, split_part, split_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'month', ?, ?, ?)`,
        )
        .bind(
          userId,
          part.amount,
          tx.currency,
          tx.category,
          tx.note,
          tx.receiver,
          tx.bank,
          part.transRef,
          part.slipDatetime,
          tx.raw_json,
          group,
          part.part,
          months,
        ),
    ),
  ]);

  return await getTransaction(db, id, userId);
}

/**
 * Puts a split entry back the way it was: the original amount is restored and any
 * extra monthly rows are removed. Works from any part of a month-split. A double
 * split (people, then months) unwinds in one go — original_amount is the pre-split
 * slip amount either way.
 */
export async function undoSplit(db: D1Database, id: number, userId: number): Promise<TransactionRow | null> {
  const tx = await getTransaction(db, id, userId);
  if (!tx || !tx.split_kind) return null;

  let targetId = tx.id;
  if (tx.split_group) {
    // Part 1 is the row that carries original_amount; the others are ours to drop.
    const first = await db
      .prepare("SELECT id FROM transactions WHERE split_group = ? AND user_id = ? ORDER BY split_part LIMIT 1")
      .bind(tx.split_group, userId)
      .first<{ id: number }>();
    if (!first) return null;
    targetId = first.id;
    await db
      .prepare("DELETE FROM transactions WHERE split_group = ? AND user_id = ? AND id <> ?")
      .bind(tx.split_group, userId, targetId)
      .run();
  }

  return await db
    .prepare(
      `UPDATE transactions
          SET amount = COALESCE(original_amount, amount), original_amount = NULL,
              split_kind = NULL, split_group = NULL, split_part = NULL, split_total = NULL
        WHERE id = ? AND user_id = ?
       RETURNING *`,
    )
    .bind(targetId, userId)
    .first<TransactionRow>();
}

/** Deletes every part of a month-split at once, so no orphan instalments are left behind. */
export async function deleteSplitGroup(db: D1Database, group: string, userId: number): Promise<number> {
  const res = await db
    .prepare("DELETE FROM transactions WHERE split_group = ? AND user_id = ?")
    .bind(group, userId)
    .run();
  return res.meta.changes;
}

export interface TxFilters {
  category?: Category;
  /** Substring match against the receiver/merchant name. */
  receiver?: string;
  /** Inclusive "YYYY-MM-DD" bounds against the slip date (falling back to logged date). */
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

/** WHERE clause + binds shared by the filtered list and its true-total aggregate,
 * so the two can never disagree about which rows a filter matches. */
function txFilterWhere(userId: number, filters: TxFilters): { where: string; binds: (string | number)[] } {
  const DATE_EXPR = "substr(COALESCE(slip_datetime, created_at), 1, 10)";
  const conds = ["user_id = ?"];
  const binds: (string | number)[] = [userId];

  if (filters.category) {
    conds.push("category = ?");
    binds.push(filters.category);
  }
  if (filters.receiver) {
    conds.push("receiver LIKE ? ESCAPE '\\'");
    binds.push(`%${filters.receiver.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (filters.dateFrom) {
    conds.push(`${DATE_EXPR} >= ?`);
    binds.push(filters.dateFrom);
  }
  // Month-splits put instalments on future dates. Without an explicit end date,
  // "what did I spend recently" should stop at today rather than lead with next
  // year's instalments; an explicit dateTo (e.g. a future month) still wins.
  conds.push(`${DATE_EXPR} <= ?`);
  binds.push(filters.dateTo ?? bangkokToday());

  return { where: conds.join(" AND "), binds };
}

/** Filtered read for the chat assistant — newest first, capped at 100 rows. */
export async function listTransactions(db: D1Database, userId: number, filters: TxFilters): Promise<TransactionRow[]> {
  const { where, binds } = txFilterWhere(userId, filters);
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);

  const res = await db
    .prepare(
      `SELECT * FROM transactions WHERE ${where}
       ORDER BY COALESCE(slip_datetime, created_at) DESC LIMIT ${limit}`,
    )
    .bind(...binds)
    .all<TransactionRow>();
  return res.results;
}

/**
 * True total and count over *every* row a filter matches, not just the rows the
 * capped list returns. The list alone quietly summed only its own page, so a
 * question spanning more entries than the cap got a confidently wrong figure.
 */
export async function sumTransactions(
  db: D1Database,
  userId: number,
  filters: TxFilters,
): Promise<{ total: number; count: number }> {
  const { where, binds } = txFilterWhere(userId, filters);
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM transactions WHERE ${where}`)
    .bind(...binds)
    .first<{ total: number; count: number }>();
  return { total: Math.round((row?.total ?? 0) * 100) / 100, count: row?.count ?? 0 };
}

// ---------- pending slips ----------

/** Holds an OCR result while we wait for the user to say what the spend was for. One pending slip per user. */
export async function setPending(db: D1Database, userId: number, fileId: string, parsedJson: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM pending_slips WHERE user_id = ?").bind(userId),
    db.prepare("INSERT INTO pending_slips (user_id, file_id, parsed_json) VALUES (?, ?, ?)").bind(userId, fileId, parsedJson),
  ]);
}

export async function getPending(db: D1Database, userId: number): Promise<PendingSlipRow | null> {
  return await db
    .prepare("SELECT * FROM pending_slips WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .bind(userId)
    .first<PendingSlipRow>();
}

export async function deletePending(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM pending_slips WHERE user_id = ?").bind(userId).run();
}

// ---------- pending splits (custom amount) ----------

export interface PendingSplitRow {
  id: number;
  user_id: number;
  tx_id: number;
  message_id: number | null;
  created_at: string;
}

export async function setPendingCustomSplit(
  db: D1Database,
  userId: number,
  txId: number,
  messageId: number | null,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM pending_splits WHERE user_id = ?").bind(userId),
    db
      .prepare("INSERT INTO pending_splits (user_id, tx_id, message_id) VALUES (?, ?, ?)")
      .bind(userId, txId, messageId),
  ]);
}

export async function getPendingCustomSplit(db: D1Database, userId: number): Promise<PendingSplitRow | null> {
  return await db
    .prepare("SELECT * FROM pending_splits WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .bind(userId)
    .first<PendingSplitRow>();
}

export async function deletePendingCustomSplit(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM pending_splits WHERE user_id = ?").bind(userId).run();
}

// ---------- slip batches (photo albums) ----------

/**
 * Leader election for one album. Telegram delivers an album as N concurrent
 * updates; each one calls this, and SQLite's UNIQUE(user_id, media_group_id)
 * guarantees exactly one INSERT succeeds. A returned row means "you own this
 * batch"; null means someone else does — the caller registers its photo with
 * addBatchItem and stops there.
 */
export async function claimBatch(
  db: D1Database,
  userId: number,
  mediaGroupId: string,
  chatId: number,
  caption: string | null,
): Promise<SlipBatchRow | null> {
  return await db
    .prepare(
      `INSERT INTO slip_batches (user_id, media_group_id, chat_id, caption) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, media_group_id) DO NOTHING
       RETURNING *`,
    )
    .bind(userId, mediaGroupId, chatId, caption)
    .first<SlipBatchRow>();
}

export async function getBatch(db: D1Database, id: number, userId: number): Promise<SlipBatchRow | null> {
  return await db
    .prepare("SELECT * FROM slip_batches WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<SlipBatchRow>();
}

export async function getBatchByGroup(
  db: D1Database,
  userId: number,
  mediaGroupId: string,
): Promise<SlipBatchRow | null> {
  return await db
    .prepare("SELECT * FROM slip_batches WHERE user_id = ? AND media_group_id = ?")
    .bind(userId, mediaGroupId)
    .first<SlipBatchRow>();
}

/**
 * The album currently waiting on the user, if any — what a plain text message
 * should be treated as an answer to. Scoped to the last few hours so a batch
 * abandoned yesterday can't swallow today's chat message as a note.
 */
export async function getActiveBatch(db: D1Database, userId: number): Promise<SlipBatchRow | null> {
  return await db
    .prepare(
      `SELECT * FROM slip_batches
        WHERE user_id = ? AND state IN ('awaiting_note', 'asking')
          AND created_at > datetime('now', ?)
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId, `-${BATCH_ANSWERABLE_HOURS} hours`)
    .first<SlipBatchRow>();
}

/**
 * How long an album stays answerable. Past this, a typed reply is treated as
 * ordinary chat again — so anything that could ask the user a fresh question
 * about an old batch has to honour the same window (see isBatchAnswerable),
 * or it would ask something the answer can never reach.
 */
export const BATCH_ANSWERABLE_HOURS = 6;

/** Whether a reply to this batch would still be routed back to it. */
export function isBatchAnswerable(batch: SlipBatchRow): boolean {
  const created = Date.parse(`${batch.created_at.replace(" ", "T")}Z`);
  if (Number.isNaN(created)) return true; // unparseable timestamp: don't lock the user out
  return Date.now() - created < BATCH_ANSWERABLE_HOURS * 3600 * 1000;
}

/** Stragglers: photos that registered too late for the leader to ever read them. */
export async function countUnreadItems(db: D1Database, batchId: number): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM slip_batch_items WHERE batch_id = ? AND outcome = 'queued' AND parsed_json IS NULL",
    )
    .bind(batchId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Registers one photo of an album. OR IGNORE: a redelivered update is a no-op. */
export async function addBatchItem(
  db: D1Database,
  batchId: number,
  messageId: number,
  fileId: string,
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO slip_batch_items (batch_id, message_id, file_id) VALUES (?, ?, ?)")
    .bind(batchId, messageId, fileId)
    .run();
}

/** Only the first caption sticks — Telegram allows one per album anyway. */
export async function setBatchCaption(db: D1Database, batchId: number, caption: string): Promise<void> {
  await db
    .prepare("UPDATE slip_batches SET caption = ? WHERE id = ? AND caption IS NULL")
    .bind(caption, batchId)
    .run();
}

export async function countBatchItems(db: D1Database, batchId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM slip_batch_items WHERE batch_id = ?")
    .bind(batchId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The album's photos in send order (message_id is monotonic per chat; arrival order isn't). */
export async function listBatchItems(db: D1Database, batchId: number): Promise<SlipBatchItemRow[]> {
  const res = await db
    .prepare("SELECT * FROM slip_batch_items WHERE batch_id = ? ORDER BY message_id")
    .bind(batchId)
    .all<SlipBatchItemRow>();
  return res.results;
}

export async function setBatchStatusMessage(db: D1Database, batchId: number, messageId: number): Promise<void> {
  await db.prepare("UPDATE slip_batches SET status_message_id = ? WHERE id = ?").bind(messageId, batchId).run();
}

export async function setBatchAskMessage(db: D1Database, batchId: number, messageId: number | null): Promise<void> {
  await db.prepare("UPDATE slip_batches SET ask_message_id = ? WHERE id = ?").bind(messageId, batchId).run();
}

export async function setBatchState(db: D1Database, batchId: number, state: BatchState): Promise<void> {
  await db.prepare("UPDATE slip_batches SET state = ? WHERE id = ?").bind(state, batchId).run();
}

export async function setBatchAskIndex(db: D1Database, batchId: number, index: number): Promise<void> {
  await db.prepare("UPDATE slip_batches SET ask_index = ? WHERE id = ?").bind(index, batchId).run();
}

/**
 * Stores what the OCR + model made of each photo, before the save decision —
 * one round trip for the whole album. A null parse is a slip we couldn't read.
 */
export async function setItemsParsed(
  db: D1Database,
  entries: { itemId: number; parsedJson: string | null; outcome: BatchItemOutcome }[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.batch(
    entries.map((entry) =>
      db
        .prepare("UPDATE slip_batch_items SET parsed_json = ?, outcome = ? WHERE id = ?")
        .bind(entry.parsedJson, entry.outcome, entry.itemId),
    ),
  );
}

export async function setItemResult(
  db: D1Database,
  itemId: number,
  outcome: BatchItemOutcome,
  txId: number | null,
  note: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE slip_batch_items SET outcome = ?, tx_id = ?, note = ? WHERE id = ?")
    .bind(outcome, txId, note, itemId)
    .run();
}

export async function setItemNote(db: D1Database, itemId: number, note: string | null): Promise<void> {
  await db.prepare("UPDATE slip_batch_items SET note = ? WHERE id = ?").bind(note, itemId).run();
}

/**
 * Retires whatever album was waiting on the user. Keeps the "one waiting slot
 * per user" rule that pending_slips has always had: a newly sent slip takes
 * over the slot, and the user's next words answer the new question.
 */
export async function clearActiveBatches(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare("UPDATE slip_batches SET state = 'done' WHERE user_id = ? AND state IN ('awaiting_note', 'asking')")
    .bind(userId)
    .run();
}

/** Housekeeping from the daily cron — finished albums are only kept for the note walk. */
export async function deleteOldBatches(db: D1Database): Promise<number> {
  const res = await db.batch([
    db.prepare(
      `DELETE FROM slip_batch_items WHERE batch_id IN
         (SELECT id FROM slip_batches WHERE created_at < datetime('now', '-7 days'))`,
    ),
    db.prepare("DELETE FROM slip_batches WHERE created_at < datetime('now', '-7 days')"),
  ]);
  return res[1]?.meta.changes ?? 0;
}

// ---------- dashboard aggregates ----------

export interface MonthSummary {
  month: string; // "YYYY-MM"
  total: number;
  count: number;
  byCategory: { category: string; total: number }[];
  topReceivers: { receiver: string; total: number; count: number }[];
  byDay: { day: string; total: number }[]; // day = "01".."31"
}

export async function getMonthSummary(db: D1Database, userId: number, month: string): Promise<MonthSummary> {
  const where = `user_id = ? AND ${MONTH_EXPR} = ?`;

  const [totals, byCategory, topReceivers, byDay] = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM transactions WHERE ${where}`).bind(userId, month),
    db
      .prepare(
        `SELECT category, SUM(amount) AS total FROM transactions WHERE ${where}
         GROUP BY category ORDER BY total DESC`,
      )
      .bind(userId, month),
    db
      .prepare(
        `SELECT receiver, SUM(amount) AS total, COUNT(*) AS count FROM transactions
         WHERE ${where} AND receiver IS NOT NULL
         GROUP BY receiver ORDER BY total DESC LIMIT 5`,
      )
      .bind(userId, month),
    db
      .prepare(
        `SELECT ${DAY_EXPR} AS day, SUM(amount) AS total FROM transactions WHERE ${where}
         GROUP BY day ORDER BY day`,
      )
      .bind(userId, month),
  ]);

  if (!totals || !byCategory || !topReceivers || !byDay) {
    throw new Error("month summary batch returned fewer results than expected");
  }

  const t = (totals.results[0] ?? { total: 0, count: 0 }) as { total: number; count: number };
  return {
    month,
    total: t.total,
    count: t.count,
    byCategory: byCategory.results as { category: string; total: number }[],
    topReceivers: topReceivers.results as { receiver: string; total: number; count: number }[],
    byDay: byDay.results as { day: string; total: number }[],
  };
}

// ---------- scheduled daily reports ----------

export interface DailyUserSummary {
  telegramId: number;
  count: number;
  totals: { currency: string; total: number; count: number }[];
  byCategory: { category: string; currency: string; total: number }[];
}

interface DailySummaryRow {
  telegram_id: number;
  category: string | null;
  currency: string | null;
  total: number;
  count: number;
}

/** One summary per registered user for a Bangkok calendar date ("YYYY-MM-DD"). */
export async function getDailyUserSummaries(db: D1Database, date: string): Promise<DailyUserSummary[]> {
  // Slip timestamps are already Bangkok-local. created_at is SQLite UTC, so
  // shift only the fallback before comparing Bangkok calendar dates.
  const DATE_EXPR =
    "CASE WHEN t.slip_datetime IS NOT NULL THEN substr(t.slip_datetime, 1, 10) ELSE date(t.created_at, '+7 hours') END";
  // Later instalments of a month-split are dated in the future but nothing left
  // the bank that day — reporting them as "you spent this yesterday" would be
  // wrong. Part 1 still shows, on the day the payment actually happened.
  const NOT_FUTURE_INSTALMENT = "(t.split_kind IS NULL OR t.split_kind <> 'month' OR t.split_part = 1)";
  const result = await db
    .prepare(
      `SELECT u.telegram_id, t.category, COALESCE(t.currency, 'THB') AS currency,
              COALESCE(SUM(t.amount), 0) AS total, COUNT(t.id) AS count
       FROM users u
       LEFT JOIN transactions t ON t.user_id = u.id AND ${DATE_EXPR} = ? AND ${NOT_FUTURE_INSTALMENT}
       GROUP BY u.id, u.telegram_id, t.category, COALESCE(t.currency, 'THB')
       ORDER BY u.id, total DESC`,
    )
    .bind(date)
    .all<DailySummaryRow>();

  const summaries = new Map<number, DailyUserSummary>();
  for (const row of result.results) {
    const summary = summaries.get(row.telegram_id) ?? {
      telegramId: row.telegram_id,
      count: 0,
      totals: [],
      byCategory: [],
    };
    summary.count += row.count;
    if (row.category && row.currency && row.count > 0) {
      const currencyTotal = summary.totals.find((item) => item.currency === row.currency);
      if (currencyTotal) {
        currencyTotal.total += row.total;
        currencyTotal.count += row.count;
      } else {
        summary.totals.push({ currency: row.currency, total: row.total, count: row.count });
      }
      summary.byCategory.push({ category: row.category, currency: row.currency, total: row.total });
    }
    summaries.set(row.telegram_id, summary);
  }
  return [...summaries.values()];
}
