import type { StoredRecord } from "./schema";

/** Shifts a local wall-clock instant by whole hours and returns the local date. */
function localDateAfter(instant: string, hours: number): string {
  return new Date(Date.parse(`${instant.slice(0, 19)}Z`) + hours * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The local calendar day a record belongs to, as a person would say it, in the record's own
 * UTC offset:
 *  - a sleep belongs to the day you woke up;
 *  - a cycle to the waking day it covers (cycles start at sleep onset, so 12 hours after the
 *    start is safely inside that day);
 *  - a workout to the day it started;
 *  - a journal answer to its cycle's day.
 * Used by the store (range queries), the live API (filtering) and the daily summary.
 */
export function recordDay(record: StoredRecord): string | null {
  switch (record.kind) {
    case "sleep": return (record.end ?? record.start).slice(0, 10);
    case "cycle": return localDateAfter(record.start, 12);
    case "workout": return record.start.slice(0, 10);
    case "journal": return record.cycle_start === null ? null : localDateAfter(record.cycle_start, 12);
  }
}
