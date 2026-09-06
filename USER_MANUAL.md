# Spending AI — User Manual

A Telegram bot that logs your spending automatically from photos of Thai mobile-banking slips (KBank, SCB, PromptPay, etc.), provides automated monthly dashboards, and answers spending questions via an AI chat assistant.

---

## 1. Getting access

The bot is invite-only. To join:

1. Open a chat with the bot on Telegram.
2. Send:
   ```
   /start <your-invite-token>
   ```
3. You'll get a welcome message once you're registered.

If you send `/start` without a token, or with an invalid token, the bot will ask for a valid one instead of letting you in. Share your invite token with anyone you want to give access to — everyone who joins with it can use the bot, and each person's spending is tracked separately in their own private account (users cannot see each other's entries).

---

## 2. Logging a spend

Send a **photo of a banking slip** to the bot.

- **With a caption** (e.g. `"lunch with team"`): the bot reads the slip, categorizes it, and saves it immediately.
- **Without a caption**: the bot reads the slip, then asks *"What was this for?"* — just reply with a short text message (e.g. `"groceries"`) and it saves at that point.

What the bot reads off the slip automatically:
- Amount and currency
- Date/time of the transfer
- Sending bank
- Receiver / merchant name
- A unique transaction reference (used to block duplicates)
- A suggested category

**Duplicate protection:** if you accidentally send the same slip twice, the bot recognizes it (via the transaction reference) and won't log it a second time.

### Sending several slips at once

Select multiple slips in Telegram's photo picker and send them together as an album. The bot reads them all in one go and replies with a summary followed by one card per slip, so every entry still has its own category / ✂️ Split / 🗑 buttons.

- **With a caption on the album**: all of them are saved straight away with that caption as the note.
- **Without a caption**: the bot asks *"What were these for?"* once, and your reply becomes the note on all of them.
- **📝 Different note for each**: tap this on the summary and the bot walks the slips one at a time — *"Slip 1 of 4 · ฿420 · 7-Eleven — what was this for?"* — with **⏭ Skip** and **✅ Stop asking** if you change your mind partway.

Anything that couldn't be read is called out in the summary (`1 couldn't be read`) while the rest still save — just re-send that one on its own. Duplicates are counted the same way.

Telegram itself only allows 10 photos per album, so sending more than that creates several albums and the bot handles each as its own batch — you'll get one summary per album, which is expected.

### Categories
Every entry is filed under one of:
`Food`, `Transport`, `Shopping`, `Bills`, `Health`, `Entertainment`, `Transfer`, `Other`

---

## 3. Fixing a mistake

Every saved entry comes back as a confirmation card with buttons underneath:

- **Category buttons** — tap the correct category if the bot guessed wrong; the entry updates instantly.
- **🗑 Delete** — removes that specific entry.
- **`/undo`** — removes the most recent entry you logged (handy right after a mistake, no need to hunt for the card).

---

## 4. Splitting a bill — ✂️ Split

Sometimes one slip isn't really one spend. Every saved entry has a **✂️ Split** button with three options:

### 👥 Between people — *equal split for the group*

You covered a ฿1,200 dinner for four. Tap **✂️ Split → 👥 Between people → 4**, and the entry becomes **฿300** — your share. The other ฿900 was never your money, so it's simply dropped and never counts in your totals.

The card then shows a reminder of what happened:
```
✅ Saved ฿300 — Food
👥 My share — ฿1,200 ÷ 4 people
```

### ✏️ My share was… — *non-equal split / custom amount*

You paid a ฿2,800 bill, but a friend paid ฿520 for their portion (so your net share was only ฿2,280). Tap **✂️ Split → ✏️ My share was…**, and the bot prompts:
> *"How much was actually yours? Reply with the amount (e.g. 2280 or 2800 - 520)."*

Reply with either:
- The exact amount: `2280` (or `2,280` or `฿2280`)
- Or simple arithmetic: `2800 - 520`

The entry updates to **฿2,280**, leaving a clear record on the card:
```
✅ Saved ฿2,280 — Food
✏️ My share — ฿2,800 on the slip
```
If you change your mind during the prompt, tap **◀️ Back** or send `/cancel`.

### 🗓 Across months — *one payment covering many months*

You paid ฿12,000 of car insurance in one go, but it covers the year. Tap **✂️ Split → 🗓 Across months → 12**, and it becomes twelve separate ฿1,000 entries, one dated in each of the next twelve months.

That means `/dashboard` for this month shows ฿1,000 of Bills instead of a ฿12,000 spike, and `/dashboard` for any month next year already shows its ฿1,000 too. Odd amounts divide to the satang — the parts always add back up to exactly what you paid.

### Good to know

- **Both together:** split by people first, then across months (you covered a friend's share of an annual bill). An entry already spread over months hides the ✂️ Split button, so do it in that order.
- **↩️ Undo split** puts an entry back to the original slip amount and removes the extra monthly parts. It's on every split entry.
- **Deleting** a month-split shows **🗑 Delete all 12** so you don't leave stray parts behind. `/undo` does the same.
- **The 5 AM report** only counts money that actually left your account that day, so future monthly parts don't show up in it — they appear in `/dashboard` for their own month instead.
- **Duplicate protection still works.** Re-sending a photo of a slip you already split is still recognised and refused.

---

## 5. Viewing your spending — `/dashboard`

Send:
```
/dashboard
```
to get the current month's summary: total spent, a breakdown by category with percentages, and your top 5 merchants/receivers. A chart image follows the text summary.

To check a **past month**, add it in `YYYY-MM` format:
```
/dashboard 2026-06
```

If nothing was logged for that month, the bot tells you instead of showing an empty chart.

Every morning at **5:00 AM Thailand time**, the bot also sends you a short report for the previous day. It shows the total, number of slips, and category breakdown. If you recorded nothing, it confirms that instead.

---

## 6. Chatting with the AI Assistant

Whenever you don't have a pending slip waiting for a note, you can message the bot in plain Thai or English. The assistant reads your spending data and can answer questions or propose changes.

### Ask questions
- *"How much did I spend on food this month?"*
- *"Show my expenses from yesterday"*
- *"What were my biggest purchases in August?"*
- *"List all transfers to John"*

### Make changes via chat
- *"Change my last slip to Transport"*
- *"Delete that ฿350 coffee from yesterday"*

For modifications and deletions, the assistant will display confirmation buttons (like **Confirm Category** or **🗑 Delete**) — nothing is changed without your confirmation.

---

## 7. Quick command reference

| Command / Action | What it does |
|---|---|
| `/start <token>` | Join the bot with your invite token |
| `/help` | The full list of what the bot can do |
| *(send a photo)* | Log a spend from a slip |
| *(send several photos)* | Log a whole batch of slips in one go |
| *(reply with text)* | Complete a pending slip that's missing its "what was this for" note |
| *(chat message)* | Ask questions or propose changes via the AI chat assistant |
| `/dashboard` | This month's summary + chart |
| `/dashboard YYYY-MM` | A specific month's summary + chart |
| `/undo` | Delete your most recently logged entry |
| tap a category button | Correct a saved entry's category |
| tap ✂️ Split | Keep only your share, or spread the bill across months |
| tap ↩️ Undo split | Put a split entry back to the original amount |
| tap 🗑 Delete | Remove a saved entry (or all parts of a month-split) |

---

## 8. Notes & limits

- The bot only responds to registered users — random messages from strangers are ignored.
- If you send a plain text message when no slip is pending a note, it routes directly to the AI chat assistant.
- Slip reading is powered by AI vision and OCR, so always check the confirmation card, especially the amount and category, and adjust with the buttons if needed.
- All amounts are tracked in Thai Baht (THB) unless the slip specifies otherwise.
