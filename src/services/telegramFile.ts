import type { SlipTimer } from "./timing";

/** Downloads a Telegram photo by file_id and returns it base64-encoded for the vision API. */
export async function downloadPhotoBase64(botToken: string, fileId: string, timer?: SlipTimer): Promise<string> {
  // Downloads finish in well under a second; the timeouts are here because a
  // hung Telegram fetch would otherwise freeze an album's whole parse pool —
  // this is the one external call that had no abort clamp.
  const infoRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string } };
  timer?.mark("telegram_getFile");
  if (!info.ok || !info.result?.file_path) {
    throw new Error(`getFile failed for file_id ${fileId}`);
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!fileRes.ok) {
    throw new Error(`file download failed: HTTP ${fileRes.status}`);
  }
  const bytes = await fileRes.arrayBuffer();
  timer?.mark("telegram_file_download");
  return toBase64(bytes);
}

// Telegram's second-largest photo size is ~100KB, well within string limits —
// chunked to keep String.fromCharCode off the argument-count ceiling.
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
