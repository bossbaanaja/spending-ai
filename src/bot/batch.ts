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
  activateQuestion,
  acceptAlbumNote,
  chooseIndividualNotes,
  clearAlbumQuestion,
  getAlbumJob,
  getActiveQuestion,
  consumeQuestion,
  resumeAlbumQuestion,
  restoreAlbumQuestion,
  rememberAlbumCaption,
  claimAlbumJob,
  finishAlbumJob,
  wakeAlbum,
  commitWalkAnswer,
  isQueuedAlbum,
  saveAlbumItem,
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
import { publishAlbum } from '../services/albumQueue';
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
 * Per-attempt cap for an album slip's NIM call (a lone slip keeps the 45s
 * default — its hedge twin covers a stall).
 */
const ALBUM_NIM_TIMEOUT_MS = 25_000;
const DEBOUNCE_STEP_MS = 600;
const MIN_DEBOUNCE_MS = 2_500;
const DEBOUNCE_MAX_MS = 10_000;
/**
 * Shared cutoff for reading slips in the album before Cloudflare Worker
 * lifetime forces termination.
 */
const PARSE_BUDGET_MS = 55_000;
/** Concurrency pool size for reading slips within an album. */
const PARSE_CONCURRENCY = 2;
/** Cutoff margin: do not start another slip if remaining budget is below this. */
const CUTOFF_MARGIN_MS = 12_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AlbumPhoto {
  generation?: number;
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
  const registeredAt = Date.now();
  const claimed = await claimBatch(db, user.id, photo.mediaGroupId, photo.chatId, photo.caption);
  const batch = claimed ?? (await getBatchByGroup(db, user.id, photo.mediaGroupId));
  if (!batch) throw new Error(`album ${photo.mediaGroupId}: lost the claim but found no batch row`);

  if (claimed) await activateQuestion(db, user.id, photo.caption ? 'none' : 'album', batch.id, photo.generation ?? Date.now());

  await addBatchItem(db, batch.id, photo.messageId, photo.fileId);
  // Telegram attaches the caption to one photo of the album, which is not
  // necessarily the one that won the claim.
  if (photo.caption && !claimed) await setBatchCaption(db, batch.id, photo.caption);

  console.error(JSON.stringify({
    event: "album_photo_registered",
    role: claimed ? "leader" : "follower",
    batch_id: batch.id,
    media_group_id: photo.mediaGroupId,
    message_id: photo.messageId,
    registered_at: registeredAt,
    registered_iso: new Date(registeredAt).toISOString(),
  }));

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
    ).catch(() => {});

  // Progressive saving writes rows as they finish, so a crash partway through leaves some
  // entries in the ledger. The error message must not claim otherwise.
  let mayHaveWritten = false;

  try {
    await settleAlbum(db, claimed.id);
    // Re-read: a follower may have written the caption after we claimed.
    const batch = (await getBatch(db, claimed.id, user.id)) ?? claimed;
    const all = await listBatchItems(db, batch.id);
    const items = all.slice(0, MAX_BATCH_SLIPS);
    const overflow = all.slice(MAX_BATCH_SLIPS);
    const deadline = startedAt + PARSE_BUDGET_MS;
    const unreadOverflow = [...overflow];

    if (batch.caption) {
      const caption = batch.caption;
      await rememberAlbumCaption(db, batch.id, caption);
      mayHaveWritten = true;
      const saved: TransactionRow[] = [];
      let duplicates = 0;
      let failed = 0;
      let completed = 0;
      let writeLock = Promise.resolve();

      let nextIdx = 0;
      const workers = Array.from({ length: Math.min(PARSE_CONCURRENCY, items.length) }, async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= items.length) break;
          const item = items[i];
          if (!item) continue;

          // Stop if not enough budget left for another slip
          if (deadline - Date.now() < CUTOFF_MARGIN_MS) {
            console.error(
              JSON.stringify({ event: "batch_deadline_cutoff", item_id: item.id, remaining_ms: deadline - Date.now() }),
            );
            unreadOverflow.push(item);
            continue;
          }

          try {
            const image = await downloadPhotoBase64(env.BOT_TOKEN, item.file_id);
            const slip = await parseSlip(image, caption, env, undefined, {
              deadline,
              hedge: false,
              startIndex: 0,
              nimTimeoutMs: ALBUM_NIM_TIMEOUT_MS,
            });

            // Progressive save: write row immediately to D1, serialized
            await setItemsParsed(db, [{ itemId: item.id, parsedJson: JSON.stringify(slip), outcome: 'queued' }]);
            const write = writeLock.then(async () => {
              await saveAlbumItem(db, user.id, item.id, slip, caption);
              const persisted = (await listBatchItems(db, batch.id)).find(row => row.id === item.id);
              if (persisted?.outcome === 'duplicate') {
                duplicates += 1;
              } else {
                const result = persisted?.tx_id ? await getTransaction(db, persisted.tx_id, user.id) : null;
                if (!result) throw new Error('album save did not produce an expense');
                saved.push(result);
                // Send confirmation card immediately to chat
                await api
                  .sendMessage(batch.chat_id, formatTxCard(result), { reply_markup: txKeyboard(result) })
                  .catch((err) => {
                    console.error(JSON.stringify({ event: "slip_batch_card_failed", tx: result.id, error: String(err) }));
                  });
              }
            });
            writeLock = write.catch(() => {});
            await write;
          } catch (err) {
            failed += 1;
            // A parsed slip with a failed save stays queued for a retry.
            const persisted = (await listBatchItems(db, batch.id)).find(row => row.id === item.id);
            if (!persisted?.parsed_json) await setItemResult(db, item.id, "failed", null, caption);
            console.error(
              JSON.stringify({ event: "slip_batch_item_failed", batch: batch.id, item: item.id, error: String(err) }),
            );
          } finally {
            completed += 1;
            if (items.length > 1 && completed < items.length) {
              await editStatus(`🔍 Reading slips (${completed}/${items.length} done)…`);
            }
          }
        }
      });

      await Promise.all(workers);
      await writeLock;

      if (unreadOverflow.length > 0) {
        await setItemsParsed(
          db,
          unreadOverflow.map((ov) => ({ itemId: ov.id, parsedJson: null, outcome: "skipped" })),
        );
      }

      const needsSave = (await listBatchItems(db, batch.id)).some(item => item.outcome === 'queued' && item.parsed_json);
      await setBatchState(db, batch.id, needsSave ? 'awaiting_note' : 'done');
      const late = unreadOverflow.length + (await countUnreadItems(db, batch.id));

      if (saved.length === 0 && duplicates === 0) {
        await editStatus(
          "😕 I couldn't read any of those slips. Try sending clearer photos — or send them one at a time.",
        );
      } else {
        const heading =
          saved.length === 0
            ? "⚠️ Nothing new to log"
            : `✅ Logged ${saved.length} slip${saved.length === 1 ? "" : "s"}`;
        await editStatus(
          formatBatchSummary({ saved, duplicates, failed, skipped: late }, heading),
          saved.length > 1 || needsSave ? batchNoteKeyboard(batch.id) : undefined,
        );
      }

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

    // No caption: read slips concurrently, then ask once.
    const readable: ReadSlip[] = [];
    const outcomes: { itemId: number; parsedJson: string | null; outcome: BatchItemOutcome; order: number }[] = [];
    let failed = 0;
    let completed = 0;

    let nextIdx = 0;
    const workers = Array.from({ length: Math.min(PARSE_CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= items.length) break;
        const item = items[i];
        if (!item) continue;

        if (deadline - Date.now() < CUTOFF_MARGIN_MS) {
          console.error(
            JSON.stringify({ event: "batch_deadline_cutoff", item_id: item.id, remaining_ms: deadline - Date.now() }),
          );
          unreadOverflow.push(item);
          continue;
        }

        try {
          const image = await downloadPhotoBase64(env.BOT_TOKEN, item.file_id);
          const slip = await parseSlip(image, "", env, undefined, {
            deadline,
            hedge: false,
            startIndex: 0,
            nimTimeoutMs: ALBUM_NIM_TIMEOUT_MS,
          });
          readable.push({ item, slip, order: i });
          await setItemsParsed(db, [{ itemId: item.id, parsedJson: JSON.stringify(slip), outcome: 'queued' }]);
          outcomes.push({ itemId: item.id, parsedJson: JSON.stringify(slip), outcome: "queued", order: i });
        } catch (err) {
          failed += 1;
          outcomes.push({ itemId: item.id, parsedJson: null, outcome: "failed", order: i });
          console.error(
            JSON.stringify({ event: "slip_batch_item_failed", batch: batch.id, item: item.id, error: String(err) }),
          );
        } finally {
          completed += 1;
          if (items.length > 1 && completed < items.length) {
            await editStatus(`🔍 Reading slips (${completed}/${items.length} done)…`);
          }
        }
      }
    });

    await Promise.all(workers);

    for (const ov of unreadOverflow) {
      outcomes.push({ itemId: ov.id, parsedJson: null, outcome: "skipped", order: 999 });
    }

    readable.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    outcomes.sort((a, b) => a.order - b.order);

    if (outcomes.length > 0) {
      await setItemsParsed(
        db,
        outcomes.map(({ itemId, parsedJson, outcome }) => ({ itemId, parsedJson, outcome })),
      );
    }

    if (readable.length === 0) {
      await setBatchState(db, batch.id, "done");
      await editStatus(
        "😕 I couldn't read any of those slips. Try sending clearer photos — or send them one at a time.",
      );
      logBatch(batch, {
        slips: items.length,
        saved: 0,
        duplicates: 0,
        failed,
        skipped: unreadOverflow.length,
        ms: Date.now() - startedAt,
      });
      return;
    }

    await setBatchState(db, batch.id, "awaiting_note");
    const slips = readable.map((entry) => entry.slip);
    const late = unreadOverflow.length + (await countUnreadItems(db, batch.id));
    await editStatus(
      askNoteText(slips, { failed, skipped: late }),
      batchNoteKeyboard(batch.id),
    );
    logBatch(batch, {
      slips: items.length,
      saved: 0,
      duplicates: 0,
      failed,
      skipped: late,
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
    );
  }
}

/**
 * Waits for the album's other updates to check in. Enforces a minimum arrival
 * window so slower mobile network uploads are not prematurely cut off.
 */
async function settleAlbum(db: D1Database, batchId: number): Promise<number> {
  const startedAt = Date.now();
  const until = startedAt + DEBOUNCE_MAX_MS;
  let count = await countBatchItems(db, batchId);
  let stable = 0;
  let poll = 0;

  console.error(
    JSON.stringify({
      event: "settle_album_start",
      batch_id: batchId,
      initial_count: count,
      started_at: startedAt,
      started_iso: new Date(startedAt).toISOString(),
      debounce_max_ms: DEBOUNCE_MAX_MS,
    }),
  );

  while (
    (Date.now() - startedAt < MIN_DEBOUNCE_MS || stable < 2) &&
    count < MAX_BATCH_SLIPS &&
    Date.now() < until
  ) {
    await sleep(DEBOUNCE_STEP_MS);
    const now = await countBatchItems(db, batchId);
    const elapsed = Date.now() - startedAt;
    poll += 1;
    console.error(
      JSON.stringify({
        event: "settle_album_poll",
        batch_id: batchId,
        poll,
        count_before: count,
        count_now: now,
        stable: now === count ? stable + 1 : 0,
        elapsed_ms: elapsed,
      }),
    );
    stable = now === count ? stable + 1 : 0;
    count = now;
  }

  console.error(
    JSON.stringify({
      event: "settle_album_done",
      batch_id: batchId,
      final_count: count,
      total_polls: poll,
      elapsed_ms: Date.now() - startedAt,
      exit_reason: count >= MAX_BATCH_SLIPS ? "cap_reached" : stable >= 2 ? "stable" : "timeout",
    }),
  );

  return count;
}

interface ReadSlip {
  item: SlipBatchItemRow;
  slip: ParsedSlip;
  order?: number;
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
): Promise<{ saved: TransactionRow[]; duplicates: number; saveFailures: number }> {
  const saved: TransactionRow[] = [];
  let duplicates = 0;
  let saveFailures = 0;

  for (const { item, slip } of readable) {
    try {
      await saveAlbumItem(db, userId, item.id, slip, note);
      const persisted = (await listBatchItems(db, item.batch_id)).find(row => row.id === item.id);
      if (persisted?.outcome === 'duplicate') duplicates += 1;
      else if (persisted?.tx_id) {
        const tx = await getTransaction(db, persisted.tx_id, userId);
        if (tx) saved.push(tx);
      } else throw new Error('album save did not finish');
    } catch (error) {
      saveFailures++;
      console.error(JSON.stringify({ event: 'album_save_retry_needed', item: item.id, error: String(error) }));
    }
  }
  return { saved, duplicates, saveFailures };
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
  // First accepted note is durable. A retry finishes with that same note.
  const accepted = await acceptAlbumNote(db, user.id, batch.id, note);
  const previous = await getAlbumJob(db, batch.id);
  if (!accepted && previous?.note_mode !== 'shared') return;
  note = previous?.accepted_note ?? note;
  await wakeAlbum(db, batch.id);
  if (await isQueuedAlbum(db, batch.id)) {
    await clearAlbumQuestion(db, user.id, batch.id);
    await publishAlbum(env, batch.id, 0);
    return;
  }
  const token = crypto.randomUUID();
  const job = await claimAlbumJob(db, batch.id, token, Date.now(), 70_000);
  if (!job) return;
  let retryAt: number | null = Date.now() + 30_000;
  try {
    const { readable } = await pendingItems(db, batch.id);
    const { saveFailures } = await saveAll(db, user.id, readable, note);
    const tally = await batchTally(db, batch, user.id);
    if (saveFailures) {
      await setBatchState(db, batch.id, 'awaiting_note');
      await statusEditor(api, batch)(`${tally.saved.length} slips saved. ${saveFailures} still need saving. Tap Resume to retry.`, batchNoteKeyboard(batch.id));
      return;
    }
    await setBatchState(db, batch.id, 'done');
    await clearAlbumQuestion(db, user.id, batch.id);
    await renderResult(api, batch, statusEditor(api, batch), tally);
    retryAt = null;
  } catch (err) {
    // The early "done" above is what makes a second quick reply harmless, but
    // on a failed save it would strand the batch: the user is told to retry
    // the note, so the batch must be back in the state that reply can reach.
    // Re-saving is safe — trans_ref dedup turns rows already written into
    // "already logged" instead of double entries.
    await setBatchState(db, batch.id, "awaiting_note").catch(() => {});
    throw err;
  } finally {
    await finishAlbumJob(db, job, token, retryAt);
  }
}

export async function batchTally(db: D1Database, batch: SlipBatchRow, userId: number): Promise<BatchTally> {
  const items = await listBatchItems(db, batch.id);
  const saved: TransactionRow[] = [];
  for (const item of items) {
    if (item.outcome === 'saved' && item.tx_id) {
      const tx = await getTransaction(db, item.tx_id, userId);
      if (tx) saved.push(tx);
    }
  }
  return { saved, duplicates: items.filter(i => i.outcome === 'duplicate').length,
    failed: items.filter(i => i.outcome === 'failed').length,
    skipped: items.filter(i => i.outcome === 'skipped').length };
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
  if (await isQueuedAlbum(db, batch.id)) {
    if (!await chooseIndividualNotes(db, user.id, batch.id)) return;
    await resumeAlbumQuestion(db, user.id, batch.id);
    await wakeAlbum(db, batch.id);
    await publishAlbum(env, batch.id, 0);
    return;
  }
  await wakeAlbum(db, batch.id);
  const token = crypto.randomUUID();
  const job = await claimAlbumJob(db, batch.id, token, Date.now(), 70_000);
  if (!job) return;
  let retryAt: number | null = Date.now() + 30_000;
  try {
    if (!await chooseIndividualNotes(db, user.id, batch.id)) return;
    await resumeAlbumQuestion(db, user.id, batch.id);

  // The walk claims the one waiting slot. Without this, a single slip still
  // waiting for its note would have its answer swallowed by the walk's first
  // question — the text handler checks batches before pending slips.
  await deletePending(db, user.id);

  if (batch.state === "awaiting_note") {
    const { readable, failed, skipped } = await pendingItems(db, batch.id);
    const { saved, duplicates, saveFailures } = await saveAll(db, user.id, readable, null);
    if (saveFailures) throw new Error('some slips still need saving');
    // offerNotes = false: the walk is starting right now, so re-attaching the
    // button that started it would just let it be started twice.
    await renderResult(api, batch, statusEditor(api, batch), { saved, duplicates, failed, skipped }, false);
  }

  await setBatchState(db, batch.id, "asking");
  await setBatchAskIndex(db, batch.id, 0);
  await setBatchAskMessage(db, batch.id, null);
  await askNext(api, env, user, { ...batch, state: "asking", ask_index: 0, ask_message_id: null }, null);
    retryAt = null;
  } finally {
    await finishAlbumJob(db, job, token, retryAt);
  }
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
  if (!await commitWalkAnswer(db, user.id, batch.id, batch.ask_index, note)) return;
  await askNext(api, env, user, { ...batch, ask_index: batch.ask_index + 1 }, `Saved as "${note}".`);
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
  if (!await commitWalkAnswer(env.DB, user.id, batch.id, batch.ask_index, null)) return;
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
      reply_markup: batchAskKeyboard(batch.id, batch.ask_index),
    });
  } else {
    const sent = await api.sendMessage(batch.chat_id, text, { reply_markup: batchAskKeyboard(batch.id, batch.ask_index) });
    await setBatchAskMessage(db, batch.id, sent.message_id);
  }
  return true;
}

/** ✅ Stop asking, or the walk ran out of slips. */
export async function finishNoteWalk(api: Api, env: Env, batch: SlipBatchRow, text: string): Promise<void> {
  await setBatchState(env.DB, batch.id, "done");
  await clearAlbumQuestion(env.DB, batch.user_id, batch.id);
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
