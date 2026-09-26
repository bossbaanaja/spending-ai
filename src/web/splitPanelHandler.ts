import { getVersionedTransaction, getUserByTelegramId, savePanelShare, requestTransactionCard } from '../db/repo';
import { fmtAmount } from '../bot/card';
import { flushTransactionCard } from '../bot/cardRefresh';
import { parseCustomAmount } from '../split';
import { verifyMiniAppUser, verifySplitPanelToken } from '../services/splitPanelAuth';
import { splitPanelHtml } from './splitPanel';

const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body: object, status = 200) => Response.json(body, { status, headers });

export async function handleSplitPanel(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/split-panel' && request.method === 'GET') {
    return new Response(splitPanelHtml, { headers: {
      ...headers, 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    } });
  }
  if (!['/split-panel/load', '/split-panel/save'].includes(path)) return json({ error: 'Not found.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) {
    return json({ error: 'Open this panel from Telegram.' }, 403);
  }
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415);
  try {
    // Bound streamed input even when Content-Length is absent or dishonest.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'Missing request.' }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); return json({ error: 'Request too large.' }, 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return json({ error: 'Invalid request.' }, 400); }
    if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string' ||
        !('initData' in body) || typeof body.initData !== 'string') return json({ error: 'Invalid request.' }, 400);
    const link = await verifySplitPanelToken(env.BOT_TOKEN, body.token);
    const telegramId = await verifyMiniAppUser(env.BOT_TOKEN, body.initData);
    if (!link || !telegramId || link.telegramId !== telegramId) {
      return json({ error: 'This panel has expired or could not be verified. Close it, tap Back, then Split to open a fresh panel.' }, 401);
    }
    const user = await getUserByTelegramId(env.DB, telegramId);
    if (!user) return json({ error: 'You need to register with the bot first.' }, 403);
    const tx = await getVersionedTransaction(env.DB, link.txId, user.id);
    if (!tx || tx.identity !== link.identity) return json({ error: 'That entry no longer exists.' }, 404);
    const retry = tx.revision === link.revision + 1 && tx.split_token === link.operation;
    if (tx.revision !== link.revision && !retry) return json({ error: 'This entry changed. Close the panel and open Split again.' }, 409);
    if (tx.split_kind === 'month') return json({ error: 'This entry is now spread across months. Undo that split before changing your share.' }, 409);
    const total = tx.original_amount ?? tx.amount;
    if (path.endsWith('/load')) return json({
      totalLabel: fmtAmount(total, tx.currency), currency: tx.currency, note: tx.note,
      currentShare: tx.split_kind === 'people' ? String(tx.amount) : '',
    });
    const amount = 'amount' in body && typeof body.amount === 'string' && body.amount.length <= 100
      ? parseCustomAmount(body.amount) : null;
    if (amount === null || !Number.isFinite(amount) || amount <= 0 || amount > total) {
      return json({ error: `Enter an amount above zero and no more than ${fmtAmount(total, tx.currency)}.` }, 400);
    }
    // Register before the write: its trigger leaves durable refresh work even if this request dies.
    await requestTransactionCard(env.DB, tx.id, user.id, link.identity, telegramId, link.messageId);
    const updated = await savePanelShare(env.DB, tx.id, user.id, amount, link);
    if (!updated) return json({ error: 'This entry changed. Close the panel and open Split again.' }, 409);
    const cardUpdated = await flushTransactionCard(env, telegramId, link.messageId);
    return json({ cardUpdated, message: cardUpdated
      ? `Saved your share: ${fmtAmount(updated.amount, updated.currency)}.`
      : `Saved your share: ${fmtAmount(updated.amount, updated.currency)}. The chat card is waiting to refresh; your dashboard has the saved amount.` });
  } catch {
    console.error(JSON.stringify({ event: 'split_panel_failed' }));
    return json({ error: 'Could not finish that request. Please try Save again or reopen the panel.' }, 500);
  }
}
