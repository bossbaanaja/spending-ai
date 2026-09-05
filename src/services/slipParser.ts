import { asCategory, CATEGORIES, type ParsedSlip } from "../types";
import { nimChat, nimChatHedged, type NimChatResult } from "./nim";
import type { SlipTimer } from "./timing";
import { typhoonOcrImage } from "./typhoonOcr";

const SLIP_PROMPT = `You read text extracted by OCR from Thai mobile-banking payment slips (KBank, SCB, Bangkok Bank, Krungthai, PromptPay, TrueMoney Wallet, etc.). The OCR text is markdown and may contain HTML tables or minor OCR noise.

Extract the transaction into a JSON object with exactly these fields:
{
  "amount": <number — the transferred amount>,
  "currency": "<ISO 4217 code, default THB>",
  "datetime": "<YYYY-MM-DD HH:MM — the date and time printed on the slip, or null>",
  "bank": "<sender's bank or wallet name in English, or null>",
  "receiver": "<recipient / merchant name as printed on the slip, or null>",
  "trans_ref": "<the transaction reference or transaction ID string, or null>",
  "category": "<exactly one of: ${CATEGORIES.join(", ")}>",
  "confidence": <number 0 to 1 — how sure you are about the amount and reference>
}

Rules:
- Thai slips often print Buddhist Era years (พ.ศ., e.g. 2569) — subtract 543 to get the Gregorian year.
- The amount is the transferred sum, not the fee (ค่าธรรมเนียม) — fees are usually 0.00 and listed separately.
- If the user stated a purpose, use it to pick the category; otherwise infer from the receiver name.
- Respond with ONLY the JSON object. No explanation, no markdown fences.`;

export interface ParseSlipOptions {
  /**
   * Absolute cutoff (epoch ms) for both stages. An album shares one deadline
   * across every slip in it, because they all run inside the leader's single
   * invocation. Defaults to 65s from now — see the comment below.
   */
  deadline?: number;
  /**
   * Race two models for the answer. Worth it for one slip (it kills the slow
   * tail), not for a large album: the slips already run in parallel, so
   * hedging would only double the load on the provider that stalls under it.
   * Defaults to true.
   */
  hedge?: boolean;
  /**
   * Which model in the chain the (unhedged) NIM call starts on. NIM's rate
   * limit is per model, so an album's concurrent slips pass different values
   * here to sit in different queues instead of fighting over one.
   */
  startIndex?: number;
  /**
   * Per-attempt cap for the NIM stage. A lone slip keeps nim.ts's 45s default
   * because its hedge twin covers a stalled model; an album has no hedge and
   * shares one deadline across every slip, so one stalled attempt must cost
   * far less than half the budget — the album path passes ~25s.
   */
  nimTimeoutMs?: number;
}

/**
 * Two-stage pipeline: Typhoon OCR (built for Thai documents) turns the image
 * into text, then the NIM model turns that text into the structured slip.
 * Each stage carries its own retry + timeout; a failure in either surfaces to
 * the caller, which tells the user to retry.
 */
export async function parseSlip(
  imageBase64: string,
  caption: string,
  env: Env,
  timer?: SlipTimer,
  options: ParseSlipOptions = {},
): Promise<ParsedSlip> {
  // Hard cutoff for the whole two-stage parse. The update lives ~80s total
  // (50s held response + ~30s waitUntil grace, index.ts); failing by ~65s
  // leaves the slip handler time to edit the status bubble with the error
  // instead of being cancelled mid-flight with the bubble stuck.
  const { deadline = Date.now() + 65_000, hedge = true, startIndex = 0, nimTimeoutMs } = options;
  const ocrText = await typhoonOcrImage(imageBase64, env, deadline);
  timer?.mark("ocr_done");
  console.error(JSON.stringify({ event: "slip_ocr_done", chars: ocrText.length }));

  // 2048 tokens, not 512: gpt-oss-120b's hidden reasoning counts against the
  // limit and 512 was observed cutting the JSON off mid-object.
  const messages = [
    { role: "system" as const, content: SLIP_PROMPT },
    {
      role: "user" as const,
      content:
        `OCR text of the slip:\n${ocrText}\n\n` +
        (caption ? `Purpose from user: "${caption}"` : "No purpose given by the user."),
    },
  ];
  const toSlip = ({ content }: NimChatResult) => {
    if (!content) throw new Error("slip parse: NIM returned tool calls instead of content");
    return extractJson(content);
  };

  // Hedged: primary and backup model raced, first *valid* answer wins — a
  // truncated or malformed response loses the race instead of poisoning it.
  // Unhedged still walks the whole fallback chain (NIM_MODELS), one at a time.
  const result = hedge
    ? await nimChatHedged(env, messages, { maxTokens: 2048, deadline }, toSlip)
    : toSlip(await nimChat(env, messages, { maxTokens: 2048, deadline, startIndex, timeoutMs: nimTimeoutMs }));
  timer?.mark("nim_done");
  return result;
}

/** Strips markdown fences / surrounding prose, parses, and validates the model's JSON. */
function extractJson(content: string): ParsedSlip {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON object in model output: ${content.slice(0, 200)}`);
  const raw = JSON.parse(match[0]) as Record<string, unknown>;

  const amount = typeof raw.amount === "number" ? raw.amount : Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid amount in model output: ${String(raw.amount)}`);
  }

  return {
    amount,
    currency: cleanString(raw.currency)?.toUpperCase() ?? "THB",
    datetime: validDatetime(cleanString(raw.datetime)),
    bank: cleanString(raw.bank),
    receiver: cleanString(raw.receiver),
    trans_ref: cleanString(raw.trans_ref),
    category: asCategory(raw.category),
    confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0,
  };
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

function validDatetime(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value : null;
}
