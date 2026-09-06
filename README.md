# Spending AI 🧾💸

An intelligent Telegram spending tracker built for **Cloudflare Workers**. It automatically logs expenses from photos of Thai mobile-banking slips (PromptPay, KBank, SCB, etc.), stores them in **Cloudflare D1**, generates visual monthly dashboards, supports multi-way bill splitting, and includes an AI-powered chat assistant.

---

## ✨ Features

- 📸 **Automatic Slip Reading**: Send a photo of any Thai bank transfer slip. The bot extracts amount, date, bank, merchant/receiver, and transaction reference using a two-stage AI pipeline (Typhoon OCR + NVIDIA NIM).
- 📚 **Batch Album Ingestion**: Select and send up to 10 slips in a single album. The bot parses them concurrently and guides you through tagging notes in one flow.
- 🛡️ **Duplicate Detection**: Uses transaction reference numbers from slips to prevent logging the same payment twice.
- ✂️ **Instant Bill Splitting**:
  - **👥 Between People**: Paid for a group? Keep only your share (e.g. ฿1,200 ÷ 4 = ฿300) and drop the rest from your totals.
  - **✏️ Custom Share ("My share was…")**: Non-equal split? Type the exact net amount you paid (e.g. `2280` or `2800 - 520`) when someone covers part of the bill.
  - **🗓 Across Months**: Large annual payment (e.g. car insurance)? Spread it into equal monthly portions across future months.
  - **↩️ Undo Split**: Reverts splits back to the original amount at any time.
- 📊 **Monthly Dashboard & Charts**: `/dashboard` displays spending totals, category breakdowns, and top merchants with an auto-generated visual chart. Past months can be viewed via `/dashboard YYYY-MM`.
- ⏰ **Daily Morning Summary**: Cloudflare Cron sends a summary every morning at 5:00 AM (Bangkok time) detailing the previous day's spending.
- 💬 **AI Chat Assistant**: Ask questions in natural Thai or English (*"How much did I spend on food this month?"*, *"What were my biggest expenses last week?"*). You can also ask it to update categories or delete transactions with one-tap confirmation buttons.
- 🔐 **Invite-Only Access**: Restrict bot usage with invite tokens; each user's financial records are kept isolated and private.

---

## 🏗️ Architecture

```text
Telegram User ──> Telegram Webhook ──> Cloudflare Worker (grammY)
                                             │
      ┌──────────────────────────────────────┴──────────────────────────────────────┐
      │                                                                             │
 📸 Slip Photo                                                               💬 Text Query
      │                                                                             │
  Typhoon OCR (Thai document model)                                            NVIDIA NIM LLM
      │                                                                    (Tool-calling Assistant)
  NVIDIA NIM (Hedged JSON extraction)                                               │
      │                                                                             │
      └──────────────────────────────────────┬──────────────────────────────────────┘
                                             ▼
                                Cloudflare D1 Database (SQLite)
```

- **Runtime**: Cloudflare Workers (TypeScript) with an 80-second extended budget window for external AI calls.
- **OCR**: [OpenTyphoon OCR](https://playground.opentyphoon.ai) — specialized for Thai text and mobile banking layouts.
- **LLM**: [NVIDIA NIM](https://build.nvidia.com) — resilient model rotation chain with hedged racing to minimize latency.
- **Database**: Cloudflare D1 (serverless SQLite).
- **Bot Framework**: [grammY](https://grammy.dev).

---

## 🚀 Getting Started & Deployment

### Prerequisites

1. **Cloudflare Account** with Wrangler installed (`npm install -g wrangler` or use `npx wrangler`).
2. **Telegram Bot Token** from [@BotFather](https://t.me/BotFather).
3. **Typhoon OCR API Key** from [OpenTyphoon Playground](https://playground.opentyphoon.ai).
4. **NVIDIA NIM API Key** from [NVIDIA Build](https://build.nvidia.com).

### 1. Clone and Install

```bash
git clone https://github.com/bossbaanaja/spending-ai.git
cd spending-ai
npm install
```

### 2. Set Up Cloudflare D1

Create a D1 database:
```bash
npx wrangler d1 create spending_ai
```

Copy the generated `database_id` into your [wrangler.jsonc](file:///C:/Users/nutch/Desktop/spending_ai/wrangler.jsonc):
```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "spending_ai",
    "database_id": "<YOUR_D1_DATABASE_ID>"
  }
]
```

Apply the database schema:
```bash
npm run db:apply
```
*(For local development, run `npm run db:apply:local`)*

### 3. Configure Secrets

Set your production secrets via Wrangler:

```bash
npx wrangler secret put BOT_TOKEN          # From Telegram @BotFather
npx wrangler secret put WEBHOOK_SECRET     # Random string (e.g. openssl rand -hex 32)
npx wrangler secret put NVIDIA_API_KEY     # From NVIDIA Build
npx wrangler secret put TYPHOON_OCR_API_KEY # From OpenTyphoon
npx wrangler secret put INVITE_TOKENS      # Comma-separated list of invite codes
npx wrangler secret put ADMIN_TOKENS       # Comma-separated list of admin codes
```

For local testing with `npm run dev`, place these values in a `.dev.vars` file (git-ignored).

### 4. Deploy

Deploy the worker:
```bash
npm run deploy
```

### 5. Register the Telegram Webhook

Point Telegram to your deployed Cloudflare Worker:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<YOUR_WORKER_SUBDOMAIN>.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>"
```

---

## 📖 Bot Usage & Commands

For full end-user documentation, see [USER_MANUAL.md](file:///C:/Users/nutch/Desktop/spending_ai/USER_MANUAL.md).

| Command / Action | Description |
|---|---|
| `/start <invite-token>` | Join the bot with a valid invite token |
| `/help` | View help and available features |
| *(send a slip photo)* | Log spending with an optional caption (e.g. `"lunch"`) |
| *(send multiple photos)* | Batch import up to 10 slips at once |
| *(send a text message)* | Ask the AI assistant questions about your spending or request changes |
| `/dashboard` | View current month's spending breakdown and chart |
| `/dashboard YYYY-MM` | View a specific past month's dashboard (e.g. `/dashboard 2026-06`) |
| `/undo` | Immediately delete the last logged transaction |
| tap category button | Correct an entry's assigned category |
| tap ✂️ Split | Split a bill among friends (equal or custom share) or amortize across multiple months |
| tap ↩️ Undo split | Revert a split back to original slip value |
| tap 🗑 Delete | Delete a transaction (or all parts of a month split) |

---

## 🛡️ Security & Privacy

- **Invite-Gated**: Unregistered users cannot interact with the bot or trigger backend LLM calls.
- **User Isolation**: All spending records in D1 are scoped to `user_id`. Users cannot view or query each other's transactions.
- **Webhook Signature Verification**: Webhooks enforce timing-safe secret validation matching `WEBHOOK_SECRET`.
- **Safe Assistant Actions**: The AI chat assistant cannot execute destructive database updates autonomously; it only presents one-tap confirmation buttons for category modifications and deletions.

---

## 🛠️ Development

- `npm run dev` — Run local development server via Wrangler
- `npm run check` — Typecheck codebase (`tsc --noEmit`)
- `npm run types` — Regenerate Cloudflare worker environment types
- `npm run db:apply` — Apply SQL schema to remote production D1
- `npm run deploy` — Deploy updates to Cloudflare Workers

---

## 📄 License

MIT License. Feel free to use and adapt for your personal finance tracking!
