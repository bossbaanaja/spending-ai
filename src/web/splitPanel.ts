/** No user data is interpolated into HTML. Authenticated data is loaded as JSON. */
export const splitPanelHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Your share</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;background:var(--tg-theme-bg-color,#f5f7fa);color:var(--tg-theme-text-color,#17212b);font:16px/1.5 system-ui,sans-serif}
main{max-width:480px;margin:auto;padding:28px 22px calc(24px + env(safe-area-inset-bottom))}
.eyebrow{font-size:12px;letter-spacing:.12em;font-weight:700;color:var(--tg-theme-hint-color,#687787)}
h1{font-size:30px;letter-spacing:-.03em;margin:8px 0}p{margin:8px 0 22px;color:var(--tg-theme-hint-color,#687787)}
.summary{padding:16px 18px;border-radius:16px;background:var(--tg-theme-secondary-bg-color,#e9eef4);margin:24px 0}
.summary span{display:block;font-size:13px;color:var(--tg-theme-hint-color,#687787)}.summary strong{font-size:24px}#note{overflow-wrap:anywhere}
label{display:block;font-weight:600;margin-bottom:8px}.field{display:flex;align-items:center;gap:12px;border:2px solid var(--tg-theme-hint-color,#8b98a5);border-radius:14px;padding:14px 16px}
.field:focus-within{border-color:var(--tg-theme-button-color,#2481cc)}input{font:600 28px system-ui;width:100%;min-width:0;border:0;outline:0;background:transparent;color:inherit}
.hint{font-size:13px;margin:10px 0 22px}button{width:100%;padding:15px;border:0;border-radius:12px;font:600 16px system-ui;cursor:pointer;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff)}
button:disabled{opacity:.5;cursor:default}#cancel{margin-top:10px;background:transparent;color:var(--tg-theme-link-color,#2481cc)}#status{min-height:24px;margin:14px 0;color:var(--tg-theme-text-color,#17212b)}[hidden]{display:none!important}
</style></head><body><main>
<div class="eyebrow">SPLIT PAYMENT</div><h1>Your share</h1><p>Keep only the amount that was yours.</p>
<div class="summary" hidden id="summary"><span>Original slip total</span><strong id="total"></strong><span id="note"></span></div>
<form id="form"><label for="amount">How much was yours?</label><div class="field"><span id="currency">฿</span><input id="amount" type="text" inputmode="decimal" autocomplete="off" maxlength="100" placeholder="0.00" aria-describedby="hint status" required disabled></div>
<p class="hint" id="hint">Enter an amount, such as 2,280. You can also paste 2,800 - 520.</p>
<button id="save" disabled>Save my share</button></form><p id="status" role="status" aria-live="polite">Opening your slip…</p><button id="cancel" type="button">Cancel</button>
</main><script>
const app = window.Telegram && window.Telegram.WebApp;
const token = new URLSearchParams(location.search).get('token');
const form = document.getElementById('form'), amount = document.getElementById('amount'), save = document.getElementById('save'), status = document.getElementById('status'), cancel = document.getElementById('cancel');
let busy = false, saved = false;
if (app) { app.ready(); app.BackButton.show(); app.BackButton.onClick(() => { if (!busy) app.close(); }); }
cancel.onclick = () => { if (!busy && app) app.close(); };
async function request(path, extra = {}) {
  const response = await fetch(path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,initData:app.initData,...extra}),signal:AbortSignal.timeout(25000)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not complete that request. Please try again.');
  return data;
}
async function load() {
  if (!app || !app.initData || !token) { status.textContent = 'Open this panel using My share was… in your private chat with the bot.'; return; }
  try {
    const data = await request('/split-panel/load');
    document.getElementById('summary').hidden = false;
    document.getElementById('total').textContent = data.totalLabel;
    document.getElementById('note').textContent = data.note || '';
    document.getElementById('currency').textContent = data.currency === 'THB' ? '฿' : data.currency;
    amount.value = data.currentShare || ''; amount.disabled = false; save.disabled = false; status.textContent = '';
  } catch (error) { status.textContent = error.message || 'Could not open this slip. Close the panel and try again.'; }
}
form.onsubmit = async event => {
  event.preventDefault(); if (busy || saved || amount.disabled) return;
  busy = true; save.disabled = true; cancel.disabled = true; amount.disabled = true; save.textContent = 'Saving…'; status.textContent = '';
  try {
    const data = await request('/split-panel/save', {amount:amount.value});
    saved = true; status.textContent = data.message; form.hidden = true; cancel.textContent = 'Done';
    if (data.cardUpdated) app.close();
  } catch (error) { status.textContent = error.name === 'TimeoutError' ? 'Connection timed out. Tap Save again to check and finish saving.' : error.message; }
  finally { busy = false; cancel.disabled = false; if (!saved) { save.disabled = false; amount.disabled = false; save.textContent = 'Save my share'; } }
};
load();
</script></body></html>`;
