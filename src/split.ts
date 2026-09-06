import type { TransactionRow } from "./types";

/** The divisions offered on the button grid — no free-text input anywhere in the split flow. */
export const SPLIT_COUNTS = [2, 3, 4, 5, 6, 7, 8, 10, 12] as const;

export function isSplitCount(n: number): boolean {
  return (SPLIT_COUNTS as readonly number[]).includes(n);
}

/**
 * Parses a custom split amount or simple subtraction/addition expression from user input.
 * Supports plain numbers ("2280", "2,280.50"), currency symbols ("฿2280", "2280 thb"),
 * Thai numerals ("๒๒๘๐"), and simple math ("2800 - 520", "1000 + 500").
 * Returns null if the text cannot be cleanly parsed as a valid numeric amount.
 */
export function parseCustomAmount(input: string): number | null {
  if (!input) return null;
  // Convert Thai numerals to Arabic numerals (0-9)
  let clean = input.trim().replace(/[๐-๙]/g, (d) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(d)));

  // Strip currency words/symbols from start or end
  clean = clean.replace(/^(฿|thb|baht|บาท)\s*/i, "").replace(/\s*(฿|thb|baht|บาท)$/i, "");

  // Remove thousand-separator commas
  clean = clean.replace(/,/g, "");

  clean = clean.trim();
  if (!clean) return null;

  // Only allow digits, '.', '+', '-', and whitespace
  if (!/^[\d.\s+-]+$/.test(clean)) return null;

  // Reject consecutive operators like "--", "+-", "++", "-+"
  if (/[+-]{2,}/.test(clean.replace(/\s+/g, ""))) return null;

  // Prefix leading number with + if not already prefixed
  const signed = clean.startsWith("+") || clean.startsWith("-") ? clean : `+${clean}`;

  // Match items like: (+|-) followed by digits and optional decimal part
  const tokens = signed.match(/[+-]\s*\d+(?:\.\d+)?/g);
  if (!tokens) return null;

  // Verify that the tokens together account for the entire string
  const reconstructed = tokens.join("").replace(/\s+/g, "");
  if (reconstructed !== signed.replace(/\s+/g, "")) {
    return null;
  }

  let sum = 0;
  for (const token of tokens) {
    const compact = token.replace(/\s+/g, "");
    const sign = compact[0] === "-" ? -1 : 1;
    const val = parseFloat(compact.slice(1));
    if (isNaN(val)) return null;
    sum += sign * val;
  }

  return Math.round(sum * 100) / 100;
}

/**
 * Divides an amount into n parts without losing satang: the maths is done in
 * integer satang and the rounding remainder lands on the first part, so the
 * parts always add back up to exactly `total` (฿1,000 ÷ 3 → 333.34, 333.33, 333.33).
 */
export function divideAmount(total: number, n: number): number[] {
  const satang = Math.round(total * 100);
  const base = Math.floor(satang / n);
  const remainder = satang - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i === 0 ? remainder : 0)) / 100);
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2 && leap) return 29;
  return MONTH_LENGTHS[month - 1] ?? 30;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * Shifts a "YYYY-MM-DD…" timestamp k months forward, keeping whatever time
 * string follows the date. The day is clamped to the target month's length —
 * 31 Jan + 1 month is 28 Feb, not an invalid 31 Feb.
 */
export function addMonths(datetime: string, k: number): string {
  const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!match) return datetime;
  const [, y, mo, d, rest] = match;

  const absolute = Number(y) * 12 + (Number(mo) - 1) + k;
  const year = Math.floor(absolute / 12);
  const month = (absolute % 12) + 1;
  const day = Math.min(Number(d), daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}${rest}`;
}

/** "2026-08-15 10:30" → "Aug 2026". */
export function shortMonth(datetime: string): string {
  const match = datetime.match(/^(\d{4})-(\d{2})/);
  if (!match) return datetime;
  return `${SHORT_MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/**
 * The Bangkok-local timestamp an entry should be spread from. Slip datetimes are
 * already Bangkok-local; created_at is SQLite UTC, so it needs the +7 shift
 * before it can be compared with — or turned into — a Bangkok calendar date.
 */
export function baseDatetime(tx: Pick<TransactionRow, "slip_datetime" | "created_at">): string {
  if (tx.slip_datetime) return tx.slip_datetime;
  const utc = Date.parse(`${tx.created_at.replace(" ", "T")}Z`);
  const bangkok = new Date((Number.isNaN(utc) ? Date.now() : utc) + 7 * 3600 * 1000).toISOString();
  return `${bangkok.slice(0, 10)} ${bangkok.slice(11, 16)}`;
}

export interface MonthPart {
  /** 1-based. */
  part: number;
  amount: number;
  slipDatetime: string;
  transRef: string | null;
}

/**
 * The rows a month-split should produce. Part 1 keeps the slip's real reference
 * so re-sending the same photo still trips the UNIQUE constraint on trans_ref
 * and is caught as a duplicate; later parts get a "#n" suffix to sit beside it.
 */
export function monthParts(tx: TransactionRow, months: number): MonthPart[] {
  const base = baseDatetime(tx);
  return divideAmount(tx.amount, months).map((amount, i) => ({
    part: i + 1,
    amount,
    slipDatetime: addMonths(base, i),
    transRef: tx.trans_ref === null ? null : i === 0 ? tx.trans_ref : `${tx.trans_ref}#${i + 1}`,
  }));
}

/** "Aug 2026 → Jul 2027" for any part of a month-split, worked out from that part alone. */
export function monthRangeLabel(tx: TransactionRow): string | null {
  if (tx.split_kind !== "month" || !tx.split_part || !tx.split_total) return null;
  const here = baseDatetime(tx);
  const first = addMonths(here, 1 - tx.split_part);
  const last = addMonths(here, tx.split_total - tx.split_part);
  return `${shortMonth(first)} → ${shortMonth(last)}`;
}
