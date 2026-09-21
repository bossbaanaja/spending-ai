import { isQueuedAlbum, listDueAlbumJobs } from '../db/repo';

export function albumQueueEnabled(env: Env, telegramId: number): boolean {
  const users = (env.ALBUM_QUEUE_USERS ?? '').split(',').map(value => value.trim());
  return users.includes('*') || users.includes(String(telegramId));
}

/** D1 is the durable outbox. A failed publish is picked up by the minute cron. */
export async function publishAlbum(env: Env, batchId: number, delaySeconds = 3): Promise<void> {
  try {
    await env.ALBUM_QUEUE.send({ batchId }, { delaySeconds });
  } catch (error) {
    console.error(JSON.stringify({ event: 'album_queue_publish_failed', batch: batchId, error: String(error) }));
  }
}

export async function recoverAlbumJobs(env: Env): Promise<void> {
  for (const job of await listDueAlbumJobs(env.DB, Date.now(), true)) {
    if (await isQueuedAlbum(env.DB, job.batch_id)) await publishAlbum(env, job.batch_id, 0);
  }
}
