import type { TransactionRow } from './types';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function isSpendingMonth(value: string): boolean {
  return /^(19\d{2}|[2-9]\d{3})-(0[1-9]|1[0-2])$/.test(value);
}

export function monthLabel(value: string): string {
  return `${MONTH_NAMES[Number(value.slice(5)) - 1]} ${value.slice(0, 4)}`;
}

export function paymentDate(tx: Pick<TransactionRow, 'slip_datetime' | 'created_at'>): string {
  if (tx.slip_datetime) return tx.slip_datetime.slice(0, 10);
  return new Date(Date.parse(tx.created_at.replace(' ', 'T') + 'Z') + 7 * 3600_000).toISOString().slice(0, 10);
}
