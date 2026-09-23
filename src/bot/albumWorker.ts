import {
  beginAlbumItemAttempt, checkpointAlbumItem, claimAlbumJob, clearAlbumQuestion,
  finishAlbumJob, getActiveQuestion, getAlbumItemWork, getAlbumJob, getAlbumOwner, getBatch,
  getBatchByGroup, getTransaction, isQueuedAlbum, listBatchItems, markAlbumCard,
  ownsAlbumJob, recordAlbumDeliveryFailure, registerQueuedPhoto, rememberAlbumCaption,
  setBatchAskIndex, setBatchAskMessage, setOwnedAlbumState, setBatchStatusMessage,
} from '../db/repo';
import { albumQueueEnabled, publishAlbum } from '../services/albumQueue';
import { albumMessage, AlbumTelegramError } from '../services/albumTelegram';
import { parseSlip } from '../services/slipParser';
import { downloadPhotoBase64 } from '../services/telegramFile';
import type { ParsedSlip, UserRow } from '../types';
import { saveAlbumItem } from '../db/repo';
import { batchTally, type AlbumPhoto } from './batch';
import { fmtAmount, formatBatchSummary, formatTxCard } from './card';
import { batchAskKeyboard, batchNoteKeyboard, txKeyboard } from './keyboards';
import { AlbumTrace } from '../services/timing';

const JOB_LEASE_MS = 120_000;
const READ_BUDGET_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** Returns false for legacy users. Existing queued albums always drain, even
 * after the rollout flag is disabled. No bot initialization or model calls. */
export async function intakeQueuedAlbum(env: Env, user: UserRow, photo: AlbumPhoto): Promise<boolean> {
  const trace = new AlbumTrace({ mediaGroupId: photo.mediaGroupId, messageId: photo.messageId });
  trace.event('photo_received');
  const old = await getBatchByGroup(env.DB, user.id, photo.mediaGroupId);
  if (!albumQueueEnabled(env, user.telegram_id) && !(old && await isQueuedAlbum(env.DB, old.id))) return false;
  const batch = await trace.measure('photo_register', () => registerQueuedPhoto(env.DB, user.id, photo));
  trace.event('photo_registered', { batchId: batch.id });
  await publishAlbum(env, batch.id);
  trace.event('intake_complete', { batchId: batch.id });
  return true;
}

/** One queue delivery processes at most two photos. Every delivery has a fresh
 * bounded budget, while checkpoints/receipts survive its lifetime. */
export async function processAlbumJob(env: Env, batchId: number, delivery: { enqueuedAtMs?: number; delaySeconds?: number } = {}): Promise<void> {
  const trace = new AlbumTrace({ batchId, runId: crypto.randomUUID() });
  trace.event('queue_received', {
    queueWaitMs: delivery.enqueuedAtMs === undefined ? null : Date.now() - delivery.enqueuedAtMs,
    requestedDelayMs: delivery.delaySeconds === undefined ? null : delivery.delaySeconds * 1000,
  });
  await trace.measure('job', () => runAlbumJob(env, batchId, trace));
}

async function runAlbumJob(env: Env, batchId: number, trace: AlbumTrace): Promise<void> {
  if (!await isQueuedAlbum(env.DB, batchId)) return;
  const token = crypto.randomUUID();
  const job = await trace.measure('job_claim', () => claimAlbumJob(env.DB, batchId, token, Date.now(), JOB_LEASE_MS));
  if (!job) { trace.event('job_not_claimed'); return; }
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
        const id = await trace.measure('status_initial', () => albumMessage(env, batch!.chat_id, '🔍 Reading your slips…'));
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
      const itemTrace = trace.child({ itemId: item.id });
      return itemTrace.measure('item', async () => {
        const work = await beginAlbumItemAttempt(db, item.id, token);
        if (!work) throw new Error('album lease lost');
        itemTrace.event('attempt_started', { attempt: work.attempts, parsedReused: !!item.parsed_json, ocrReused: !!work.ocr_text });
        try {
          if (work.attempts > MAX_ATTEMPTS) throw new Error('retry limit reached');
          let parsed: ParsedSlip;
          if (item.parsed_json) parsed = JSON.parse(item.parsed_json) as ParsedSlip;
          else {
            const image = work.ocr_text ? '' : await itemTrace.measure('photo_download', () => downloadPhotoBase64(env.BOT_TOKEN, item.file_id, undefined, deadline));
            parsed = await parseSlip(image, currentJob?.accepted_note ?? caption ?? '', env, undefined, {
              deadline, hedge: false, startIndex: slot, nimTimeoutMs: 25_000, trace: itemTrace,
              cachedOcr: work.ocr_text ?? undefined,
              onOcr: text => checkpointAlbumItem(db, item.id, token, { ocr: text }),
            });
            await itemTrace.measure('parsed_checkpoint', () => checkpointAlbumItem(db, item.id, token, { parsed: JSON.stringify(parsed) }));
          }
          // Re-read the note decision: a caption or accepted answer may arrive
          // while OCR is running. Individual notes must never inherit shared text.
          const latest = await getAlbumJob(db, batchId);
          if (latest?.note_mode) {
            await itemTrace.measure('expense_save', () => saveAlbumItem(db, user.id, item.id, parsed,
              latest.note_mode === 'shared' ? latest.accepted_note : null, token));
          }
        } catch (error) {
          failedAttempt = true;
          itemTrace.event('attempt_failed', { attempt: work.attempts });
          await checkpointAlbumItem(db, item.id, token, {
            error: String(error), ...(work.attempts >= MAX_ATTEMPTS ? { outcome: 'failed' as const } : {}),
          });
          console.error(JSON.stringify({ event: 'album_item_attempt_failed', batch: batchId, item: item.id, attempt: work.attempts, error: String(error) }));
        }
      });
    }));
    trace.event('pair_complete');
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
    const tally = await trace.measure('summary_read', () => batchTally(db, batch!, user.id));
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
      const id = await trace.measure('status_update', () => albumMessage(env, batch!.chat_id, text, batch!.status_message_id, keyboard));
      await setBatchStatusMessage(db, batchId, id);
      trace.event('status_delivered', { state: remaining.length ? 'processing' : !currentJob?.note_mode && ready.length ? 'awaiting_note' : currentJob?.note_mode === 'each' ? 'individual_notes' : 'done' });
      if (!remaining.length && currentJob?.note_mode === 'each' && batch.state !== 'asking') {
        const active = await getActiveQuestion(db, user.id);
        if (active?.kind === 'album' && active.target_id === batchId) {
          const first = tally.saved[0];
          if (first) {
            const prompt = `Slip 1 of ${tally.saved.length} · ${fmtAmount(first.amount, first.currency)} · ${first.receiver ?? first.category}\nWhat was this for?`;
            const questionId = await trace.measure('note_prompt', () => albumMessage(env, batch!.chat_id, prompt, batch!.ask_message_id,
              batchAskKeyboard(batchId, 0)));
            trace.event('note_prompt_delivered', { index: 0 });
            await setBatchAskIndex(db, batchId, 0);
            await setBatchAskMessage(db, batchId, questionId);
            await setOwnedAlbumState(db, batchId, token, 'asking');
          } else {
            await setOwnedAlbumState(db, batchId, token, 'done');
            await clearAlbumQuestion(db, user.id, batchId, token);
          }
        }
      }
      // At most two cards per delivery, bounded independently from saving.
      let sent = 0;
      for (const item of finalItems) {
        if (item.outcome !== 'saved' || !item.tx_id) continue;
        if ((await getAlbumItemWork(db, item.id))?.card_message_id) continue;
        const tx = await getTransaction(db, item.tx_id, user.id);
        if (!tx) continue;
        if (sent++ >= 2) { notificationFailed = true; break; }
        const id = await trace.measure('expense_card', () => albumMessage(env, batch!.chat_id, formatTxCard(tx), null, txKeyboard(tx)));
        await markAlbumCard(db, item.id, id);
        trace.event('card_delivered', { itemId: item.id });
      }
    } catch (error) {
      const attempts = await recordAlbumDeliveryFailure(db, batchId, token, String(error));
      notificationFailed = attempts < 6;
      if (error instanceof AlbumTelegramError) retryAt = Date.now() + Math.max(15, error.retryAfter) * 1000;
      console.error(JSON.stringify({ event: 'album_notification_failed', batch: batchId, attempts, error: String(error) }));
    }
    if (!remaining.length && !notificationFailed) retryAt = null;
    trace.event('run_result', { remaining: remaining.length, saved: tally.saved.length, retryAtMs: retryAt });
    console.error(JSON.stringify({ event: 'album_job_finished', batch: batchId, received: finalItems.length,
      saved: tally.saved.length, remaining: remaining.length, failed: tally.failed, retry: retryAt !== null }));
  } finally {
    await trace.measure('job_checkpoint', () => finishAlbumJob(db, job, token, retryAt));
    const pending = await getAlbumJob(db, batchId);
    if (pending && pending.desired_version > pending.completed_version) {
      await publishAlbum(env, batchId, Math.max(1, Math.ceil((pending.next_run_at - Date.now()) / 1000)));
    }
  }
}
