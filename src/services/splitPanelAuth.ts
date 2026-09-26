// Telegram Mini App authentication plus a signed link binding the card to its owner.
const enc = new TextEncoder();
const MAX_AGE_SECONDS = 3600;

async function key(bytes: Uint8Array) {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function hmac(secret: Uint8Array, value: string) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(value)));
}
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
async function verifies(secret: Uint8Array, value: string, signature: string) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b, 16));
  return crypto.subtle.verify('HMAC', await key(secret), bytes, enc.encode(value));
}

export interface SplitPanelLink {
  telegramId: number;
  txId: number;
  messageId: number;
  expires: number;
  identity: string;
  revision: number;
  operation: string;
}

export async function createSplitPanelToken(botToken: string, telegramId: number, txId: number, messageId: number,
  version: { identity: string; revision: number }): Promise<string> {
  const payload = [telegramId, txId, messageId, Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
    version.identity, version.revision, crypto.randomUUID()].join(':');
  return `${payload}:${hex(await hmac(enc.encode(botToken), `split-panel:${payload}`))}`;
}

export async function verifySplitPanelToken(botToken: string, token: string): Promise<SplitPanelLink | null> {
  const parts = token.split(':');
  if (parts.length !== 8 || parts.slice(0, 4).some(p => !/^\d+$/.test(p))) return null;
  const [telegramId, txId, messageId, expires] = parts.slice(0, 4).map(Number);
  if (!telegramId || !txId || !messageId || !expires ||
      ![telegramId, txId, messageId, expires].every(Number.isSafeInteger)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (expires < now || expires > now + MAX_AGE_SECONDS + 30) return null;
  const identity = parts[4]!, revision = Number(parts[5]), operation = parts[6]!;
  if (!/^[a-f0-9]{32}$/.test(identity) || !/^\d+$/.test(parts[5]!) || !Number.isSafeInteger(revision) ||
      !/^[a-f0-9-]{36}$/.test(operation)) return null;
  if (!await verifies(enc.encode(botToken), `split-panel:${parts.slice(0, 7).join(':')}`, parts[7]!)) return null;
  return { telegramId, txId, messageId, expires, identity, revision, operation };
}

export async function verifyMiniAppUser(botToken: string, initData: string): Promise<number | null> {
  try {
    const params = new URLSearchParams(initData);
    // Duplicate fields create ambiguous signatures and must never be accepted.
    if (new Set(params.keys()).size !== Array.from(params.keys()).length) return null;
    const hash = params.get('hash') ?? '';
    params.delete('hash');
    params.sort();
    const check = Array.from(params, ([k, v]) => `${k}=${v}`).join('\n');
    const secret = await hmac(enc.encode('WebAppData'), botToken);
    if (!await verifies(secret, check, hash)) return null;
    const authDate = Number(params.get('auth_date'));
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (!Number.isSafeInteger(authDate) || age < -30 || age > MAX_AGE_SECONDS) return null;
    const user: unknown = JSON.parse(params.get('user') ?? 'null');
    if (!user || typeof user !== 'object' || !('id' in user) ||
        typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return user.id;
  } catch { return null; }
}
