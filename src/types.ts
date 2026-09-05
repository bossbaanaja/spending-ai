export const CATEGORIES = [
  "Food",
  "Transport",
  "Shopping",
  "Bills",
  "Health",
  "Entertainment",
  "Transfer",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function asCategory(value: unknown): Category {
  return CATEGORIES.includes(value as Category) ? (value as Category) : "Other";
}

/** What the vision model extracts from one slip image. */
export interface ParsedSlip {
  amount: number;
  currency: string;
  /** "YYYY-MM-DD HH:MM" as printed on the slip (Gregorian), or null if unreadable. */
  datetime: string | null;
  bank: string | null;
  receiver: string | null;
  trans_ref: string | null;
  category: Category;
  confidence: number;
}

export type Role = "member" | "admin";

/** "people" = only your share is kept; "month" = spread across months, one row each. */
export type SplitKind = "people" | "month";

export interface UserRow {
  id: number;
  telegram_id: number;
  display_name: string | null;
  token: string;
  role: Role;
  created_at: string;
}

export interface TransactionRow {
  id: number;
  user_id: number;
  amount: number;
  currency: string;
  category: string;
  note: string | null;
  receiver: string | null;
  bank: string | null;
  trans_ref: string | null;
  slip_datetime: string | null;
  raw_json: string | null;
  created_at: string;
  // Split bookkeeping — all null on an ordinary entry.
  split_kind: SplitKind | null;
  /** Ties the parts of one month-split together. Null for a people-split. */
  split_group: string | null;
  split_part: number | null;
  split_total: number | null;
  /** The amount before any split, so "undo split" can put it back. */
  original_amount: number | null;
}

export interface PendingSlipRow {
  id: number;
  user_id: number;
  file_id: string;
  parsed_json: string;
  created_at: string;
}

/**
 * Where a photo album is in its life: collecting the sibling updates, waiting
 * for the user to say what the slips were for, walking them one by one for
 * individual notes, or finished.
 */
export type BatchState = "collecting" | "awaiting_note" | "asking" | "done";

/** What became of one photo in an album. */
export type BatchItemOutcome = "queued" | "saved" | "duplicate" | "failed" | "skipped";

export interface SlipBatchRow {
  id: number;
  user_id: number;
  media_group_id: string;
  chat_id: number;
  status_message_id: number | null;
  ask_message_id: number | null;
  caption: string | null;
  state: BatchState;
  ask_index: number;
  created_at: string;
}

export interface SlipBatchItemRow {
  id: number;
  batch_id: number;
  message_id: number;
  file_id: string;
  parsed_json: string | null;
  outcome: BatchItemOutcome;
  tx_id: number | null;
  note: string | null;
}
