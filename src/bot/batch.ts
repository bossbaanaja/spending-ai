// Multi-slip intake: what happens when several slips arrive as one Telegram
// album.
//
// Telegram does NOT deliver an album as one message. It delivers N separate
// webhook updates that merely share a media_group_id, so N independent copies
// of this worker wake up at the same instant with no idea they belong
// together. The database is the only thing all of them can see, so that is
// where they agree on a leader: the UNIQUE(user_id, media_group_id) key on
// slip_batches means exactly one INSERT can succeed. That update owns the
// batch; the others register their photo and exit in milliseconds.
//
// Everything downstream follows from the leader carrying the whole album
// inside its single invocation: one status bubble instead of N, one shared
// ~80s lifetime (see index.ts), and one shared time budget for the parses.

import type { Api, InlineKeyboard } from "grammy";
import {
  addBatchItem,
  claimBatch,
  clearActiveBatches,
  countBatchItems,
  countUnreadItems,
  deletePending,
  getBatch,
  getBatchByGroup,
  getTransaction,
  insertTransaction,
  listBatchItems,
  setBatchAskIndex,
  setBatchAskMessage,
  setBatchCaption,
  setBatchState,
  setBatchStatusMessage,
  setItemNote,
  setItemResult,
  setItemsParsed,
  updateNote,
} from "../db/repo";
import { parseSlip } from "../services/slipParser";
import { downloadPhotoBase64 } from "../services/telegramFile";
import type {
  BatchItemOutcome,
  ParsedSlip,
  SlipBatchItemRow,
  SlipBatchRow,
  TransactionRow,
  UserRow,
} from "../types";
import { fmtAmount, formatBatchSummary, formatTxCard } from "./card";
import { batchAskKeyboard, batchNoteKeyboard, txKeyboard } from "./keyboards";

/**
 * Photos past this are registered but never read — reported, never silently
 * dropped. Telegram already caps a media group at 10, so this is a backstop
 * rather than a policy: sending 20 photos produces two albums, two batches.
 */
const MAX_BATCH_SLIPS = 10;
/**
 * How many slips are read at once. Both providers rate-limit one key's
 * simultaneous requests (measured 2026-08-26: Typhoon rejects past ~3 at
 * once with instant 429s; NIM allows only 1–2 in flight per model, with a
 * seconds-long penalty window). At 5, every slip after the first burned its
 * retries inside that window and died — 2 stays under both ceilings.
 */
const PARSE_CONCURRENCY = 2;
/**
 * Hedge only a lone slip. An album's slips already run in parallel, and
 * doubling their model calls is exactly what blew through NIM's per-key rate
 * window (measured: 4 simultaneous calls → 1 answer, 3 rejections).
 */
const HEDGE_MAX_SLIPS = 1;
/**
 * Per-attempt cap for an album slip's NIM call (a lone slip keeps the 45s
 * default — its hedge twin covers a stall). Healthy answers measured 1.5–34s;
 * a stalled model must cost ~25s of the shared budget, not 45, so the retry
 * loop still has time to rotate to a model that answers.
 */
const ALBUM_NIM_TIMEOUT_MS = 25_000;
const DEBOUNCE_STEP_MS = 700;
const DEBOUNCE_MAX_MS = 4_000;
/**
 * Shared cutoff for reading every slip in the album. Shorter than the 65s a
 * lone slip gets, because the debounce has already spent a second or two of
 * the update's ~80s lifetime and the summary still has to be sent.
 */
const PARSE_BUDGET_MS = 58_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AlbumPhoto {
  chatId: number;
  messageId: number;
  mediaGroupId: string;
  fileId: string;
  caption: string | null;
}

/**
 * Entry point for one photo of an album. Registers it, then either takes
 * charge of the whole batch or returns immediately as a follower.
 */
export async function handleAlbumPhoto(api: Api, env: Env, user: UserRow, photo: AlbumPhoto): Promise<void> {
  const db = env.DB;
  const claimed = await claimBatch(db, user.id, photo.mediaGroupId, photo.chatId, photo.caption);
  const batch = claimed ?? (await getBatchByGroup(db, user.id, photo.mediaGroupId));
  if (!batch) throw new Error(`album ${photo.mediaGroupId}: lost the claim but found no batch row`);

  await addBatchItem(db, batch.id, photo.messageId, photo.fileId);
  // Telegram attaches the caption to one photo of the album, which is not
  // necessarily the one that won the claim.
  if (photo.caption && !claimed) await setBatchCaption(db, batch.id, photo.caption);

  if (!claimed) return; // follower: someone else is driving this album
  await runBatch(api, env, user, batch);
}

/** The leader's job, start to finish. */
async function runBatch(api: Api, env: Env, user: UserRow, claimed: SlipBatchRow): Promise<void> {
  const db = env.DB;
  const startedAt = Date.now();
  const status = await api.sendMessage(claimed.chat_id, "🔍 Reading your slips…");
  await setBatchStatusMessage(db, claimed.id, status.message_id);

  const editStatus = (text: string, keyboard?: InlineKeyboard) =>
    api.editMessageText(
      claimed.chat_id,
      status.message_id,
      text,
      keyboard ? { reply_markup: keyboard } : undefined,
    );

  // saveAll writes one row at a time, so a crash partway through leaves some
  // entries in the ledger. The error message must not claim otherwise.
  let mayHaveWritten = false;

  try {
    await settleAlbum(db, claimed.id);
    // Re-read: a follower may have written the caption after we claimed.
    const batch = (await getBatch(db, claimed.id, user.id)) ?? claimed;
    const all = await listBatchItems(db, batch.id);
    const items = all.slice(0, MAX_BATCH_SLIPS);
    const overflow = all.slice(MAX_BATCH_SLIPS);
    const skipped = overflow.length;

    const { readable, failed } = await readSlips(env, batch, items, overflow);

    if (readable.length === 0) {
      await setBatchState(db, batch.id, "done");
      await editStatus(
        "😕 I couldn't read any of those slips. Try sending clearer photos — or send them one at a time.",
      );
      logBatch(batch, { slips: items.length, saved: 0, duplicates: 0, failed, skipped, ms: Date.now() - startedAt });
      return;
    }

    if (batch.caption) {
      mayHaveWritten = true;
      const { saved, duplicates } = await saveAll(db, user.id, readable, batch.caption);
      await setBatchState(db, batch.id, "done");
      // A photo that registered after the debounce closed was never read.
      // Counting it here is the difference between "2 more weren't processed"
      // and a slip vanishing without a word.
      const late = skipped + (await countUnreadItems(db, batch.id));
      await renderResult(api, batch, editStatus, { saved, duplicates, failed, skipped: late });
      logBatch(batch, {
        slips: items.length,
        saved: saved.length,
        duplicates,
        failed,
        skipped: late,
        ms: Date.now() - startedAt,
      });
      return;
    }

    // No caption: hold the whole album and ask once. One waiting slot per
    // user, so this supersedes any single slip still waiting for its note.
    await setBatchState(db, batch.id, "awaiting_note");
    await deletePending(db, user.id);
    const slips = readable.map((entry) => entry.slip);
    await editStatus(
      askNoteText(slips, { failed, skipped }),
      slips.length > 1 ? batchNoteKeyboard(batch.id) : undefined,
    );
    logBatch(batch, {
      slips: items.length,
      saved: 0,
      duplicates: 0,
      failed,
      skipped,
      ms: Date.now() - startedAt,
      outcome: "awaiting_note",
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "slip_batch_failed", batch: claimed.id, error: String(err) }));
    await setBatchState(db, claimed.id, "done").catch(() => {});
    await editStatus(
      mayHaveWritten
        ? "😕 Something went wrong partway through those slips. Check /dashboard — some of them may already be logged."
        : "😕 Something went wrong reading those slips. Send them again in a moment — nothing was saved.",
    ).catch(() => {});
  }
}

/**
 * Waits for the album's other updates to check in. Telegram gives no "this
 * album has N photos" signal, so the only workable rule is "stop when the
 * arrivals stop": two unchanged counts in a row, 4s, or the cap — whichever
 * comes first. Usually settles in ~1.5s. A straggler arriving after the
 * window still registers as a follower of this batch; it is never read, and
 * the summary counts it among the "weren't processed" slips.
 */
async function settleAlbum(db: D1Database, batchId: number): Promise<number> {
  const until = Date.now() + DEBOUNCE_MAX_MS;
  let count = await countBatchItems(db, batchId);
  let stable = 0;

  while (stable < 2 && count < MAX_BATCH_SLIPS && Date.now() < until) {
    await sleep(DEBOUNCE_STEP_MS);
    const now = await countBatchItems(db, batchId);
    stable = now === count ? stable + 1 : 0;
    count = now;
  }
  return count;
}

interface ReadSlip {
  item: SlipBatchItemRow;
  slip: ParsedSlip;
}

/** Reads every photo through the normal two-stage pipeline; one bad slip never blocks the rest. */
async function readSlips(
  env: Env,
  batch: SlipBatchRow,
  items: SlipBatchItemRow[],
  overflow: SlipBatchItemRow[],
): Promise<{ readable: ReadSlip[]; failed: number }> {
  const deadline = Date.now() + PARSE_BUDGET_MS;
  const hedge = items.length <= HEDGE_MAX_SLIPS;

  const results = await mapPool(items, PARSE_CONCURRENCY, async (item, slot) => {
    const image = await downloadPhotoBase64(env.BOT_TOKEN, item.file_id);
    // Start each pool slot on its own model: NIM's rate limit is per model, so
    // the slips in flight must sit in different queues. Keyed to the slot, not
    // the slip's position — a worker that runs ahead would otherwise land on
    // the same model as the slower one (observed: slips 0 and 2 both opening
    // on minimax-m3, both rejected). One slip per slot means one model each.
    return await parseSlip(image, batch.caption ?? "", env, undefined, {
      deadline,
      hedge,
      startIndex: slot,
      nimTimeoutMs: hedge ? undefined : ALBUM_NIM_TIMEOUT_MS,
    });
  });

  const readable: ReadSlip[] = [];
  const outcomes: { itemId: number; parsedJson: string | null; outcome: BatchItemOutcome }[] = [];
  let failed = 0;

  results.forEach((result, i) => {
    const item = items[i];
    if (!item) return;
    if (result.status === "fulfilled") {
      readable.push({ item, slip: result.value });
      outcomes.push({ itemId: item.id, parsedJson: JSON.stringify(result.value), outcome: "queued" });
    } else {
      failed += 1;
      outcomes.push({ itemId: item.id, parsedJson: null, outcome: "failed" });
      console.error(
        JSON.stringify({ event: "slip_batch_item_failed", batch: batch.id, error: String(result.reason) }),
      );
    }
  });

  // Past the cap: recorded as skipped so the summary can still account for
  // them after the user answers the note, long after this function is gone.
  for (const item of overflow) {
    outcomes.push({ itemId: item.id, parsedJson: null, outcome: "skipped" });
  }

  await setItemsParsed(env.DB, outcomes);
  return { readable, failed };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, never rejecting.
 * `fn` also receives its pool slot (0..limit-1) — a stable identity for the
 * one job running there, which is what lets callers give each concurrent job
 * a different external resource.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, slot: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;

  const worker = async (slot: number) => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      try {
        if (item === undefined) throw new Error(`missing item at index ${i}`);
        results[i] = { status: "fulfilled", value: await fn(item, slot) };
      } catch (reason) {
        // Every index gets a slot: a hole here would be silently skipped by
        // the caller's forEach and the slip would vanish from the tally.
        results[i] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, (_, slot) => worker(slot)));
  return results;
}

/**
 * Saves the album. Sequential on purpose: insertTransaction turns the
 * UNIQUE(trans_ref) violation into a "duplicate" answer per slip, which only
 * works one statement at a time.
 */
async function saveAll(
  db: D1Database,
  userId: number,
  readable: ReadSlip[],
  note: string | null,
): Promise<{ saved: TransactionRow[]; duplicates: number }> {
  const saved: TransactionRow[] = [];
  let duplicates = 0;

  for (const { item, slip } of readable) {
    const result = await insertTransaction(db, userId, slip, note);
    if (result === "duplicate") {
      duplicates += 1;
      await setItemResult(db, item.id, "duplicate", null, note);
    } else {
      saved.push(result);
      await setItemResult(db, item.id, "saved", result.id, note);
    }
  }
  return { saved, duplicates };
}

interface BatchTally {
  saved: TransactionRow[];
  duplicates: number;
  failed: number;
  skipped: number;
}

/**
 * The summary plus one card per saved slip. An album that turned out to hold
 * a single readable slip is indistinguishable from a normal single send — no
 * summary, just the card.
 */
async function renderResult(
  api: Api,
  batch: SlipBatchRow,
  editStatus: (text: string, keyboard?: InlineKeyboard) => Promise<unknown>,
  tally: BatchTally,
  offerNotes = true,
): Promise<void> {
  const only = tally.saved[0];
  if (only && tally.saved.length === 1 && tally.duplicates === 0 && tally.failed === 0 && tally.skipped === 0) {
    await editStatus(formatTxCard(only), txKeyboard(only));
    return;
  }

  const heading =
    tally.saved.length === 0
      ? "⚠️ Nothing new to log"
      : `✅ Logged ${tally.saved.length} slip${tally.saved.length === 1 ? "" : "s"}`;
  await editStatus(
    formatBatchSummary(tally, heading),
    offerNotes && tally.saved.length > 1 ? batchNoteKeyboard(batch.id) : undefined,
  );

  // Sequential, and each guarded: several messages to one chat back-to-back
  // brush against Telegram's per-chat rate limit, and one refused card must
  // not cost the user the rest of them.
  for (const tx of tally.saved) {
    try {
      await api.sendMessage(batch.chat_id, formatTxCard(tx), { reply_markup: txKeyboard(tx) });
    } catch (err) {
      console.error(JSON.stringify({ event: "slip_batch_card_failed", tx: tx.id, error: String(err) }));
    }
  }
}

/** The "what were these for?" question, sized to how many slips were actually read. */
function askNoteText(slips: ParsedSlip[], counts: { failed: number; skipped: number }): string {
  const first = slips[0];
  if (slips.length === 1 && first && counts.failed === 0 && counts.skipped === 0) {
    const to = first.receiver ? ` to ${first.receiver}` : "";
    return `Got it — ${fmtAmount(first.amount, first.currency)}${to}.\n\nWhat was this for? (reply with a short note to save it)`;
  }
  const summary = formatBatchSummary(
    { saved: slips, duplicates: 0, failed: counts.failed, skipped: counts.skipped },
    `🔍 Read ${slips.length} slip${slips.length === 1 ? "" : "s"}`,
  );
  return `${summary}\n\nWhat were these for? (reply with a short note to save them)`;
}

// ---------- answering the note ----------

/** The user replied to the album's one question: same note on every slip, then save. */
export async function completeBatchWithNote(
  api: Api,
  env: Env,
  user: UserRow,
  batch: SlipBatchRow,
  note: string,
): Promise<void> {
  const db = env.DB;
  const { readable, failed, skipped } = await pendingItems(db, batch.id);
  await setBatchState(db, batch.id, "done");

  if (readable.length === 0) {
    await api.sendMessage(batch.chat_id, "Those slips are no longer waiting — send them again.");
    return;
  }

  try {
    const { saved, duplicates } = await saveAll(db, user.id, readable, note);
    await renderResult(api, batch, statusEditor(api, batch), { saved, duplicates, failed, skipped });
  } catch (err) {
    // The early "done" above is what makes a second quick reply harmless, but
    // on a failed save it would strand the batch: the user is told to retry
    // the note, so the batch must be back in the state that reply can reach.
    // Re-saving is safe — trans_ref dedup turns rows already written into
    // "already logged" instead of double entries.
    await setBatchState(db, batch.id, "awaiting_note").catch(() => {});
    throw err;
  }
}

/**
 * Where the album stands: what is still waiting to be written, plus the
 * slips that never made it. The counts are read back from the rows rather
 * than carried in memory, because the leader's invocation is long gone by
 * the time the user types the note.
 */
async function pendingItems(
  db: D1Database,
  batchId: number,
): Promise<{ readable: ReadSlip[]; failed: number; skipped: number }> {
  const items = await listBatchItems(db, batchId);
  const readable: ReadSlip[] = [];
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.outcome === "failed") failed += 1;
    if (item.outcome === "skipped") skipped += 1;
    // Still queued with nothing parsed: a photo that registered after the
    // leader had already read the list. Report it rather than lose it.
    if (item.outcome === "queued" && !item.parsed_json) skipped += 1;
    if (item.outcome !== "queued" || !item.parsed_json) continue;
    try {
      readable.push({ item, slip: JSON.parse(item.parsed_json) as ParsedSlip });
    } catch {
      // A row we can't read back is one we can't save; counting it as a
      // failure keeps the summary honest instead of crashing the save.
      failed += 1;
    }
  }
  return { readable, failed, skipped };
}

// ---------- the per-slip note walk ----------

/**
 * "📝 Different note for each". If the album is still waiting for its one
 * note, save everything unnoted first — the walk fills the notes in as it
 * goes, so there is nothing to lose by writing the entries now.
 */
export async function startNoteWalk(api: Api, env: Env, user: UserRow, batch: SlipBatchRow): Promise<void> {
  const db = env.DB;

  // The walk claims the one waiting slot. Without this, a single slip still
  // waiting for its note would have its answer swallowed by the walk's first
  // question — the text handler checks batches before pending slips.
  await deletePending(db, user.id);

  if (batch.state === "awaiting_note") {
    const { readable, failed, skipped } = await pendingItems(db, batch.id);
    if (readable.length === 0) {
      await setBatchState(db, batch.id, "done");
      await api.sendMessage(batch.chat_id, "Those slips are no longer waiting — send them again.");
      return;
    }
    const { saved, duplicates } = await saveAll(db, user.id, readable, null);
    // offerNotes = false: the walk is starting right now, so re-attaching the
    // button that started it would just let it be started twice.
    await renderResult(api, batch, statusEditor(api, batch), { saved, duplicates, failed, skipped }, false);
  }

  await setBatchState(db, batch.id, "asking");
  await setBatchAskIndex(db, batch.id, 0);
  await setBatchAskMessage(db, batch.id, null);
  await askNext(api, env, user, { ...batch, state: "asking", ask_index: 0, ask_message_id: null }, null);
}

/** Edits the batch's status bubble, or sends a fresh message if it's gone. */
function statusEditor(api: Api, batch: SlipBatchRow) {
  return (text: string, keyboard?: InlineKeyboard) => {
    const other = keyboard ? { reply_markup: keyboard } : undefined;
    return batch.status_message_id
      ? api.editMessageText(batch.chat_id, batch.status_message_id, text, other)
      : api.sendMessage(batch.chat_id, text, other);
  };
}

/** The user answered the question for the current slip. */
export async function answerAskNote(
  api: Api,
  env: Env,
  user: UserRow,
  batch: SlipBatchRow,
  note: string,
): Promise<void> {
  const db = env.DB;
  const saved = (await listBatchItems(db, batch.id)).filter((item) => item.outcome === "saved" && item.tx_id);
  const item = saved[batch.ask_index];

  if (!item?.tx_id) {
    await finishNoteWalk(api, env, batch, "✅ All done — notes updated.");
    return;
  }
  await updateNote(db, item.tx_id, user.id, note);
  await setItemNote(db, item.id, note);
  await advanceNoteWalk(api, env, user, batch, `Saved as "${note}".`);
}

/** ⏭ Skip / the answer landed — move the cursor on and ask the next one. */
export async function advanceNoteWalk(
  api: Api,
  env: Env,
  user: UserRow,
  batch: SlipBatchRow,
  confirmation: string | null,
): Promise<void> {
  const nextIndex = batch.ask_index + 1;
  await setBatchAskIndex(env.DB, batch.id, nextIndex);
  await askNext(api, env, user, { ...batch, ask_index: nextIndex }, confirmation);
}

/**
 * Asks about the slip at the cursor, editing the one question message in
 * place rather than stacking a new message per slip. Returns false when the
 * walk is over.
 */
async function askNext(
  api: Api,
  env: Env,
  user: UserRow,
  batch: SlipBatchRow,
  confirmation: string | null,
): Promise<boolean> {
  const db = env.DB;
  const saved = (await listBatchItems(db, batch.id)).filter((item) => item.outcome === "saved" && item.tx_id);
  const item = saved[batch.ask_index];
  const txId = item?.tx_id;

  if (!item || !txId) {
    await finishNoteWalk(api, env, batch, "✅ All done — notes updated.");
    return false;
  }

  const tx = await getTransaction(db, txId, user.id);
  if (!tx) {
    await advanceNoteWalk(api, env, user, batch, confirmation);
    return true;
  }

  const label = [fmtAmount(tx.amount, tx.currency), tx.receiver ?? tx.category].join(" · ");
  const text = [
    confirmation,
    `Slip ${batch.ask_index + 1} of ${saved.length} · ${label}`,
    "What was this for?",
  ]
    .filter(Boolean)
    .join("\n");

  if (batch.ask_message_id) {
    await api.editMessageText(batch.chat_id, batch.ask_message_id, text, {
      reply_markup: batchAskKeyboard(batch.id),
    });
  } else {
    const sent = await api.sendMessage(batch.chat_id, text, { reply_markup: batchAskKeyboard(batch.id) });
    await setBatchAskMessage(db, batch.id, sent.message_id);
  }
  return true;
}

/** ✅ Stop asking, or the walk ran out of slips. */
export async function finishNoteWalk(api: Api, env: Env, batch: SlipBatchRow, text: string): Promise<void> {
  await setBatchState(env.DB, batch.id, "done");
  if (batch.ask_message_id) {
    await api.editMessageText(batch.chat_id, batch.ask_message_id, text);
  } else {
    await api.sendMessage(batch.chat_id, text);
  }
}

/** A new single slip takes over the one "waiting for a note" slot. */
export async function supersedeActiveBatch(env: Env, user: UserRow): Promise<void> {
  await clearActiveBatches(env.DB, user.id);
}

function logBatch(batch: SlipBatchRow, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event: "slip_batch_done", batch: batch.id, ...fields }));
}
