import {
  beginAlbumItemAttempt, checkpointAlbumItem, claimAlbumJob, clearAlbumQuestion,
  finishAlbumJob, getActiveQuestion, getAlbumItemWork, getAlbumJob, getAlbumOwner, getBatch,
  getBatchByGroup, getTransaction, isQueuedAlbum, listBatchItems, markAlbumCard,
  ownsAlbumJob, recordAlbumDeliveryFailure, registerQueuedPhoto, rememberAlbumCaption,
  setBatchAskIndex, setOwnedAlbumState, setBatchStatusMessage,
} from '../db/repo';
import { albumQueueEnabled, publishAlbum } from '../services/albumQueue';
import { albumMessage, AlbumTelegramError } from '../services/albumTelegram';
import { parseSlip } from '../services/slipParser';
import { downloadPhotoBase64 } from '../services/telegramFile';
import type { ParsedSlip, UserRow } from '../types';
import { saveAlbumItem } from '../db/repo';
import { batchTally, type AlbumPhoto } from './batch';
import { formatBatchSummary, formatTxCard } from './card';
import { batchNoteKeyboard, txKeyboard } from './keyboards';

const JOB_LEASE_MS = 120_000;
const READ_BUDGET_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** Returns false for legacy users. Existing queued albums always drain, even
 * after the rollout flag is disabled. No bot initialization or model calls. */
export async function intakeQueuedAlbum(env: Env, user: UserRow, photo: AlbumPhoto): Promise<boolean> {
  const old = await getBatchByGroup(env.DB, user.id, photo.mediaGroupId);
  if (!albumQueueEnabled(env, user.telegram_id) && !(old && await isQueuedAlbum(env.DB, old.id))) return false;
  const batch = await registerQueuedPhoto(env.DB, user.id, photo);
  await publishAlbum(env, batch.id);
  return true;
}

/** One queue delivery processes at most two photos. Every delivery has a fresh
 * bounded budget, while checkpoints/receipts survive its lifetime. */
export async function processAlbumJob(env: Env, batchId: number): Promise<void> {
  if (!await isQueuedAlbum(env.DB, batchId)) return;
  const token = crypto.randomUUID();
  const job = await claimAlbumJob(env.DB, batchId, token, Date.now(), JOB_LEASE_MS);
  if (!job) return;
  let retryAt: number | null = Date.now() + 15_000;
  const db = env.DB;
  try {
    const user = await getAlbumOwner(db, batchId);
    if (!user) throw new Error('album owner not found');
    let batch = await getBatch(db, batchId, user.id);
    if (!batch) throw new Error('album not found');
    if (batch.caption) await rememberAlbumCaption(db, batchId, batch.caption);

    if (!batch.status_message_id) {
      // Notification failure must never block reading or saving.
      try {
        const id = await albumMessage(env, batch.chat_id, '🔍 Reading your slips…');
        await setBatchStatusMessage(db, batchId, id);
        batch = { ...batch, status_message_id: id };
      } catch (error) {
        console.error(JSON.stringify({ event: 'album_status_failed', batch: batchId, error: String(error) }));
      }
    }

    let currentJob = await getAlbumJob(db, batchId);
    const caption = batch.caption;
    const items = await listBatchItems(db, batchId);
    const candidates = items.slice(0, 10).filter(item => item.outcome === 'queued' && (!item.parsed_json || currentJob?.note_mode));
    const deadline = Date.now() + READ_BUDGET_MS;
    let failedAttempt = false;
    await Promise.all(candidates.slice(0, 2).map(async (item, slot) => {
      const work = await beginAlbumItemAttempt(db, item.id, token);
      if (!work) throw new Error('album lease lost');
      try {
        if (work.attempts > MAX_ATTEMPTS) throw new Error('retry limit reached');
        let parsed: ParsedSlip;
        if (item.parsed_json) parsed = JSON.parse(item.parsed_json) as ParsedSlip;
        else {
          const image = work.ocr_text ? '' : await downloadPhotoBase64(env.BOT_TOKEN, item.file_id, undefined, deadline);
          parsed = await parseSlip(image, currentJob?.accepted_note ?? caption ?? '', env, undefined, {
            deadline, hedge: false, startIndex: slot, nimTimeoutMs: 25_000,
            cachedOcr: work.ocr_text ?? undefined,
            onOcr: text => checkpointAlbumItem(db, item.id, token, { ocr: text }),
          });
          await checkpointAlbumItem(db, item.id, token, { parsed: JSON.stringify(parsed) });
        }
        // Re-read the note decision: a caption or accepted answer may arrive
        // while OCR is running. Individual notes must never inherit shared text.
        const latest = await getAlbumJob(db, batchId);
        if (latest?.note_mode) {
          await saveAlbumItem(db, user.id, item.id, parsed,
            latest.note_mode === 'shared' ? latest.accepted_note : null, token);
        }
      } catch (error) {
        failedAttempt = true;
        await checkpointAlbumItem(db, item.id, token, {
          error: String(error), ...(work.attempts >= MAX_ATTEMPTS ? { outcome: 'failed' as const } : {}),
        });
        console.error(JSON.stringify({ event: 'album_item_attempt_failed', batch: batchId, item: item.id, attempt: work.attempts, error: String(error) }));
      }
    }));
    for (const item of items.slice(10)) {
      if (item.outcome === 'queued') await checkpointAlbumItem(db, item.id, token, { outcome: 'skipped' });
    }
    if (!await ownsAlbumJob(db, batchId, token)) return;
    batch = (await getBatch(db, batchId, user.id))!;
    if (batch.caption) await rememberAlbumCaption(db, batchId, batch.caption);
    currentJob = await getAlbumJob(db, batchId);
    const finalItems = await listBatchItems(db, batchId);
    const remaining = finalItems.filter(item => item.outcome === 'queued' && (!item.parsed_json || currentJob?.note_mode));
    const ready = finalItems.filter(item => item.outcome === 'queued' && item.parsed_json);
    if (remaining.length && !failedAttempt) retryAt = Date.now() + 1000;
    const tally = await batchTally(db, batch, user.id);
    let text: string;
    let keyboard = batchNoteKeyboard(batchId);
    if (remaining.length) {
      text = `🔍 ${finalItems.length - remaining.length}/${finalItems.length} slips processed. Continuing automatically…`;
    } else if (!currentJob?.note_mode && ready.length) {
      await setOwnedAlbumState(db, batchId, token, 'awaiting_note');
      const active = await getActiveQuestion(db, user.id);
      text = `🔍 Read ${ready.length} slips. ${tally.failed} failed. ${tally.skipped} skipped.\n\n` +
        (active?.kind === 'album' && active.target_id === batchId
          ? 'What were these for? Reply with one note, or choose individual notes.'
          : 'Tap Resume to add a note and save this album.');
    } else if (currentJob?.note_mode === 'each') {
      // Late photos can change send order. Start a fresh explicit walk rather
      // than silently attaching a response to a shifted index.
      if (batch.state !== 'asking') {
        await setOwnedAlbumState(db, batchId, token, 'awaiting_note');
        await setBatchAskIndex(db, batchId, 0);
      }
      text = formatBatchSummary(tally, `✅ Logged ${tally.saved.length} slips`) + '\n\nTap Different note for each to review individual notes.';
    } else {
      await setOwnedAlbumState(db, batchId, token, 'done');
      await clearAlbumQuestion(db, user.id, batchId, token);
      text = formatBatchSummary(tally, `✅ Logged ${tally.saved.length} slips`);
    }

    let notificationFailed = false;
    try {
      const id = await albumMessage(env, batch.chat_id, text, batch.status_message_id, keyboard);
      await setBatchStatusMessage(db, batchId, id);
      // At most two cards per delivery, bounded independently from saving.
      let sent = 0;
      for (const item of finalItems) {
        if (item.outcome !== 'saved' || !item.tx_id) continue;
        if ((await getAlbumItemWork(db, item.id))?.card_message_id) continue;
        const tx = await getTransaction(db, item.tx_id, user.id);
        if (!tx) continue;
        if (sent++ >= 2) { notificationFailed = true; break; }
        const id = await albumMessage(env, batch.chat_id, formatTxCard(tx), null, txKeyboard(tx));
        await markAlbumCard(db, item.id, id);
      }
    } catch (error) {
      const attempts = await recordAlbumDeliveryFailure(db, batchId, token, String(error));
      notificationFailed = attempts < 6;
      if (error instanceof AlbumTelegramError) retryAt = Date.now() + Math.max(15, error.retryAfter) * 1000;
      console.error(JSON.stringify({ event: 'album_notification_failed', batch: batchId, attempts, error: String(error) }));
    }
    if (!remaining.length && !notificationFailed) retryAt = null;
    console.error(JSON.stringify({ event: 'album_job_finished', batch: batchId, received: finalItems.length,
      saved: tally.saved.length, remaining: remaining.length, failed: tally.failed, retry: retryAt !== null }));
  } finally {
    await finishAlbumJob(db, job, token, retryAt);
    const pending = await getAlbumJob(db, batchId);
    if (pending && pending.desired_version > pending.completed_version) {
      await publishAlbum(env, batchId, Math.max(1, Math.ceil((pending.next_run_at - Date.now()) / 1000)));
    }
  }
}
