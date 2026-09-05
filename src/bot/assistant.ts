import { InlineKeyboard } from "grammy";
import {
  getLatestTransaction,
  getMonthSummary,
  getTransaction,
  listTransactions,
  sumTransactions,
  type MonthSummary,
} from "../db/repo";
import { nimChat, type NimMessage, type NimTool, type NimToolCall } from "../services/nim";
import { CATEGORIES, type Category, type TransactionRow, type UserRow } from "../types";
import { fmtAmount } from "./card";
import { SHORT_USAGE } from "./help";

export interface AssistantReply {
  text: string;
  /** Overflow when the answer doesn't fit one Telegram message (~4096 chars):
   * the first chunk edits the status bubble, these follow as new messages. */
  extras?: string[];
  keyboard?: InlineKeyboard;
}

const HELP_TEXT =
  "I can answer questions about your spending (\"how much on food this month?\"), " +
  "or fix entries (\"change my last slip to Transport\", \"delete the last one\").\n\n" +
  SHORT_USAGE;

// The model only ever reads data or *proposes* a change. Proposals render the
// same cat:/del: confirm buttons the slip cards use, so a write happens only
// when the user taps — never straight from model output.
const TOOLS: NimTool[] = [
  {
    type: "function",
    function: {
      name: "get_month_summary",
      description:
        "Get one month's spending summary: total, entry count, per-category totals, top merchants, and per-day totals.",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: 'Month as "YYYY-MM". Omit for the current month.' },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_transactions",
      description:
        "List logged spending entries, newest first. `total` and `count` cover EVERY entry the filters match, even when the returned list is truncated — always quote those for 'how much' questions. Use filters to answer questions like 'what did I spend on food last week'.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...CATEGORIES] },
          receiver: { type: "string", description: "Match merchants/recipients whose name contains this text." },
          date_from: { type: "string", description: 'Earliest date, "YYYY-MM-DD" (inclusive).' },
          date_to: { type: "string", description: 'Latest date, "YYYY-MM-DD" (inclusive).' },
          limit: { type: "integer", description: "Max entries to return (default 20, max 100)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_last_transaction",
      description: "Get the most recently logged spending entry.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_edit_category",
      description:
        "Ask the user to confirm changing one entry's category. Shows a confirm button — the change only happens if they tap it.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: { type: "integer", description: "Entry id. Omit to target the most recent entry." },
          category: { type: "string", enum: [...CATEGORIES] },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_delete",
      description:
        "Ask the user to confirm deleting one entry. Shows a confirm button — the delete only happens if they tap it.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: { type: "integer", description: "Entry id. Omit to target the most recent entry." },
        },
      },
    },
  },
];

/** Current date in Bangkok time (UTC+7) as "YYYY-MM-DD". */
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function systemPrompt(): string {
  return `You are the assistant inside a Telegram bot that tracks the user's personal spending, logged from Thai mobile-banking slips. Today is ${bangkokToday()} (Asia/Bangkok). Amounts are Thai Baht unless stated otherwise. Categories: ${CATEGORIES.join(", ")}.

Rules:
- For any question about the user's spending, call a tool. NEVER state or estimate an amount that did not come from a tool result, and never compute new totals or percentages yourself — quote figures exactly as the tools return them.
- When the user asks to change or remove an entry, use propose_edit_category or propose_delete — the user confirms with a button, you never change data yourself.
- Months are "YYYY-MM", dates are "YYYY-MM-DD" (convert Buddhist Era years: subtract 543).
- Reply in the user's language (Thai or English). Keep replies short — this is a chat. Plain text only, no markdown.
- If the request has nothing to do with spending tracking, do not call a tool — briefly say what you can help with instead.
- If the user asks what you or the bot can do, do not call a tool — answer in one line and tell them to send /help for the full list.
- When the user asks to see or list their entries, call list_transactions with limit 100 and list every returned entry, one per line: date — amount category (note). If the result says truncated, say how many more there are.`;
}

/**
 * One user message in, one reply out. At most 3 model calls: up to two rounds
 * of read-tools, then a forced plain answer. A propose-tool short-circuits
 * into a confirm card. Every figure in a data-backed reply is string-checked
 * against the tool payloads; on drift we send the deterministic rendering
 * instead of the model's phrasing.
 */
export async function runAssistant(env: Env, user: UserRow, text: string): Promise<AssistantReply> {
  // Under the update's ~80s lifetime (index.ts) — leave room to send the reply.
  const deadline = Date.now() + 70_000;
  const messages: NimMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: text },
  ];
  const payloads: unknown[] = [];
  const fallbacks: string[] = [];
  let outOfTime = false;

  for (let round = 0; round < 3; round++) {
    // Stop while a fallback answer is still better than a thrown "out of
    // time" — a round with under ~8s left can't complete a model call.
    if (Date.now() > deadline - 8_000) {
      outOfTime = true;
      break;
    }
    const lastRound = round === 2;
    let res;
    try {
      // 4096 tokens: a full 100-entry listing plus hidden reasoning must fit —
      // the default 2048 cut long listings off mid-line.
      res = await nimChat(env, messages, {
        tools: TOOLS,
        toolChoice: lastRound ? "none" : "auto",
        deadline,
        maxTokens: 4096,
      });
    } catch (err) {
      // The data a dead phrasing call was meant to phrase is already in hand —
      // sending it raw beats a generic error. Only a first-round failure (no
      // tools ran yet, nothing to show) still surfaces as one.
      if (fallbacks.length === 0) throw err;
      console.error(JSON.stringify({ event: "assistant_round_failed", round, error: String(err) }));
      return chunkReply(fallbacks.join("\n\n"));
    }

    if (res.toolCalls.length === 0) {
      const reply = res.content?.trim();
      if (!reply) break;
      if (payloads.length > 0 && !numbersMatch(reply, payloads)) {
        console.error(JSON.stringify({ event: "assistant_verify_failed", reply: reply.slice(0, 300) }));
        const dump = fallbacks.join("\n\n");
        return dump ? chunkReply(dump) : { text: HELP_TEXT };
      }
      return chunkReply(reply);
    }

    // A propose-tool ends the turn with a confirm card — no phrasing call needed.
    const propose = res.toolCalls.find((tc) => tc.function.name.startsWith("propose_"));
    if (propose) return await buildProposeCard(env, user, propose);

    messages.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      const result = await runReadTool(env, user, tc);
      payloads.push(result.payload);
      if (result.fallback) fallbacks.push(result.fallback);
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result.payload) });
      console.error(JSON.stringify({ event: "assistant_tool", tool: tc.function.name, args: tc.function.arguments }));
    }
  }

  // Ran out of rounds or time — the raw data beats no answer. With nothing
  // fetched at all, an "out of time" is a timeout, not a question we can't
  // handle: say so instead of reciting capabilities after a long wait.
  if (fallbacks.length > 0) return chunkReply(fallbacks.join("\n\n"));
  return {
    text: outOfTime ? "😕 That took too long to answer — please ask again in a moment." : HELP_TEXT,
  };
}

/**
 * Telegram caps one message at 4096 chars, so a long answer (a full listing)
 * is split on line boundaries into follow-up messages instead of being cut
 * off with "…". Capped at 5 messages so one question can't flood the chat.
 */
const MAX_MSG_CHARS = 3900;
const MAX_MSG_CHUNKS = 5;

function chunkReply(text: string): AssistantReply {
  if (text.length <= MAX_MSG_CHARS) return { text };
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single line over the cap (no natural break) gets hard-split.
    for (let piece = line; ; piece = piece.slice(MAX_MSG_CHARS)) {
      const head = piece.slice(0, MAX_MSG_CHARS);
      if (current && current.length + head.length + 1 > MAX_MSG_CHARS) {
        chunks.push(current);
        current = head;
      } else {
        current = current ? `${current}\n${head}` : head;
      }
      if (piece.length <= MAX_MSG_CHARS) break;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > MAX_MSG_CHUNKS) {
    chunks.length = MAX_MSG_CHUNKS;
    chunks[MAX_MSG_CHUNKS - 1] += "\n…(answer truncated)";
  }
  return { text: chunks[0] ?? "", extras: chunks.slice(1) };
}

// ---------- read tools ----------

/** null = the model sent broken JSON. Callers must not treat that as "no
 * filters" — a mangled "food last week" query would silently become an
 * unfiltered read whose total answers a different question. */
function parseArgs(tc: NimToolCall): Record<string, unknown> | null {
  try {
    return JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asOptString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Case-insensitive category lookup — the model sometimes sends "food". */
function findCategory(value: unknown): Category | undefined {
  if (typeof value !== "string") return undefined;
  return CATEGORIES.find((c) => c.toLowerCase() === value.trim().toLowerCase());
}

function txDate(tx: TransactionRow): string {
  return (tx.slip_datetime ?? tx.created_at).slice(0, 10);
}

function txPayload(tx: TransactionRow) {
  return {
    id: tx.id,
    date: txDate(tx),
    amount: tx.amount,
    currency: tx.currency,
    category: tx.category,
    note: tx.note,
    receiver: tx.receiver,
    bank: tx.bank,
  };
}

function txLine(tx: TransactionRow): string {
  const what = tx.note ?? tx.receiver ?? tx.category;
  return `• ${txDate(tx)} — ${fmtAmount(tx.amount, tx.currency)} ${tx.category} (${what})`;
}

function formatSummary(s: MonthSummary): string {
  if (s.count === 0) return `No spending recorded for ${s.month}.`;
  const lines = [`${s.month}: ${fmtAmount(s.total)} across ${s.count} entr${s.count === 1 ? "y" : "ies"}`];
  for (const c of s.byCategory) lines.push(`${c.category}: ${fmtAmount(c.total)}`);
  return lines.join("\n");
}

async function runReadTool(
  env: Env,
  user: UserRow,
  tc: NimToolCall,
): Promise<{ payload: unknown; fallback: string | null }> {
  const args = parseArgs(tc);
  if (!args) {
    return { payload: { error: "Tool arguments were not valid JSON — call the tool again." }, fallback: null };
  }

  switch (tc.function.name) {
    case "get_month_summary": {
      const raw = asOptString(args.month);
      const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : bangkokToday().slice(0, 7);
      const summary = await getMonthSummary(env.DB, user.id, month);
      return { payload: summary, fallback: formatSummary(summary) };
    }

    case "list_transactions": {
      const category = args.category !== undefined ? findCategory(args.category) : undefined;
      if (args.category !== undefined && !category) {
        return {
          payload: { error: `Unknown category "${String(args.category)}". Valid: ${CATEGORIES.join(", ")}` },
          fallback: null,
        };
      }
      const filters = {
        category,
        receiver: asOptString(args.receiver),
        dateFrom: asOptString(args.date_from),
        dateTo: asOptString(args.date_to),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      };
      // total/count aggregate over every matching row, not just the returned
      // page — quoting a page sum as "your food spending" was confidently
      // wrong the moment a filter matched more rows than the cap.
      const [rows, sum] = await Promise.all([
        listTransactions(env.DB, user.id, filters),
        sumTransactions(env.DB, user.id, filters),
      ]);
      const notShown = sum.count - rows.length;
      const payload = {
        count: sum.count,
        total: sum.total,
        returned: rows.length,
        truncated: notShown > 0,
        ...(notShown > 0 ? { not_shown: notShown } : {}),
        transactions: rows.map(txPayload),
      };
      // Every fetched row is rendered — chunkReply splits long listings across
      // messages. "…more" only remains past the 100-row fetch cap.
      const fallback =
        sum.count === 0
          ? "No matching entries found."
          : [
              `${sum.count} entr${sum.count === 1 ? "y" : "ies"}, total ${fmtAmount(sum.total)}:`,
              ...rows.map(txLine),
              ...(notShown > 0 ? [`…and ${notShown} more — ask a narrower date range to see them.`] : []),
            ].join("\n");
      return { payload, fallback };
    }

    case "get_last_transaction": {
      const tx = await getLatestTransaction(env.DB, user.id);
      return {
        payload: { transaction: tx ? txPayload(tx) : null },
        fallback: tx ? `Your latest entry:\n${txLine(tx)}` : "No entries logged yet.",
      };
    }

    default:
      return { payload: { error: `Unknown tool ${tc.function.name}` }, fallback: null };
  }
}

// ---------- propose tools → confirm cards ----------

async function buildProposeCard(env: Env, user: UserRow, tc: NimToolCall): Promise<AssistantReply> {
  // Broken args are safe to shrug off here: worst case the card targets the
  // latest entry, and nothing happens without the user's confirming tap.
  const args = parseArgs(tc) ?? {};
  const id = typeof args.transaction_id === "number" ? args.transaction_id : Number(args.transaction_id);
  const tx = Number.isInteger(id) && id > 0 ? await getTransaction(env.DB, id, user.id) : await getLatestTransaction(env.DB, user.id);
  if (!tx) {
    return { text: "I couldn't find that entry — check /dashboard for what's logged." };
  }

  const what = [fmtAmount(tx.amount, tx.currency), tx.receiver ?? tx.note ?? tx.category, txDate(tx)].join(" — ");

  if (tc.function.name === "propose_edit_category") {
    const category = findCategory(args.category);
    if (!category) {
      return { text: `Which category should it be? One of: ${CATEGORIES.join(", ")}.` };
    }
    if (category === tx.category) {
      return { text: `That entry (${what}) is already in ${category} — nothing to change.` };
    }
    return {
      text: `Change this entry from ${tx.category} to ${category}?\n${what}`,
      keyboard: new InlineKeyboard().text(`✅ Change to ${category}`, `cat:${tx.id}:${category}`).text("✖ Cancel", "dismiss"),
    };
  }

  return {
    text: `Delete this entry?\n${what} (${tx.category})`,
    keyboard: new InlineKeyboard().text("🗑 Yes, delete", `del:${tx.id}`).text("✖ Cancel", "dismiss"),
  };
}

// ---------- number verification ----------

/**
 * Cheap paraphrase-drift guard: every *amount-shaped* number in the reply must
 * literally appear somewhere in the tool payloads (as a JSON number, allowing
 * comma formatting and .00-style rounding, or inside a string like a date).
 *
 * Amount-shaped = has decimals, comma grouping, or is ≥ 100. Small bare
 * integers are phrasing, not data — "last 7 days", "top 5", a day of the
 * month — and rejecting a correct total because of an incidental 7 sent the
 * user a raw data dump instead of the answer. Small hallucinated counts were
 * never really caught anyway (date/id digits made most of them "allowed").
 *
 * Thai-facing wrinkles handled here: Thai numerals (๑๒๓) are normalized to
 * ASCII first so they can't skip the check entirely, and every year-like
 * value in a payload also allows its Buddhist Era form (+543), since a Thai
 * reply saying 2569 for a slip dated 2026 is correct, not drift.
 */
function numbersMatch(reply: string, payloads: unknown[]): boolean {
  const allowed = new Set<string>();
  const addValue = (n: number) => {
    if (!Number.isFinite(n)) return;
    allowed.add(String(n));
    allowed.add(n.toFixed(2));
    allowed.add(String(Math.round(n)));
    if (Number.isInteger(n) && n >= 1400 && n <= 2200) addValue(n + 543);
  };
  const walk = (value: unknown) => {
    if (typeof value === "number") addValue(value);
    else if (typeof value === "string") {
      for (const token of value.match(/\d+(?:\.\d+)?/g) ?? []) addValue(Number.parseFloat(token));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  payloads.forEach(walk);

  const normalized = reply.replace(/[๐-๙]/g, (ch) => String(ch.charCodeAt(0) - 0x0e50));
  for (const raw of normalized.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = Number.parseFloat(raw.replace(/,/g, ""));
    const amountShaped = raw.includes(".") || raw.includes(",") || n >= 100;
    if (!amountShaped) continue;
    if (!allowed.has(String(n)) && !allowed.has(n.toFixed(2))) return false;
  }
  return true;
}
