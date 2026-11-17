import { createHash } from "node:crypto";
import { instantSchema, offsetSchema } from "./schema";

const LOCAL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * `"UTC-05:00"` → `"-05:00"`. The export writes one offset per cycle row.
 * Throws on anything else, so a format change fails loudly instead of shifting data.
 */
export function exportOffset(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "UTC" || trimmed === "UTC+00:00" || trimmed === "UTC-00:00") return "+00:00";
  const offset = trimmed.replace(/^UTC/, "");
  return offsetSchema.parse(offset);
}

/**
 * The export writes naive local wall-clock time plus the row's offset in a separate column
 * (`"2026-11-16 02:19:14"` + `"UTC-05:00"`). Joined, that is an exact instant:
 * `"2026-11-16T02:19:14-05:00"`. Blank cells stay null.
 */
export function exportInstant(local: string | undefined, offset: string | null): string | null {
  const value = local?.trim() ?? "";
  if (value === "") return null;
  const match = LOCAL_TIMESTAMP.exec(value);
  if (!match) throw new Error(`Unexpected timestamp format: ${JSON.stringify(value)}`);
  if (offset === null) throw new Error(`Timestamp ${value} has no timezone offset.`);
  return instantSchema.parse(`${match[1]}T${match[2]}${offset}`);
}

/**
 * Re-expresses an API instant (UTC, with milliseconds) in the record's own offset at
 * whole-second precision, matching the export, so both sources produce the same ids.
 */
export function apiInstant(utc: string, offset: string): string {
  const millis = Date.parse(utc);
  if (Number.isNaN(millis)) throw new Error(`Invalid API timestamp: ${utc}`);
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(":").map(Number) as [number, number];
  const shifted = new Date(Math.floor(millis / 1000) * 1000 + sign * (hours * 60 + minutes) * 60_000);
  return instantSchema.parse(`${shifted.toISOString().slice(0, 19)}${offset}`);
}

/** Whole seconds since the epoch for an instant with any offset. */
export function epochSeconds(instant: string): number {
  return Math.floor(Date.parse(instant) / 1000);
}

/** The local calendar date of an instant, in the offset it was recorded with. */
export function localDate(instant: string): string {
  return instant.slice(0, 10);
}

/** Whole-minute span between two instants. */
export function minutesBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
}

/**
 * A stable id: kind prefix + 32 hex characters of SHA-256 over the identifying parts.
 * The same record always gets the same id, whichever source it came from, so re-imports
 * replace instead of duplicating and FHIR exports merge.
 */
export function stableId(kind: string, parts: Array<string | number>): string {
  const digest = createHash("sha256").update([kind, ...parts].join("|")).digest("hex");
  return `${kind}-${digest.slice(0, 32)}`;
}

/** Record id keyed by kind and start instant (UTC seconds). */
export function recordId(kind: "cycle" | "sleep" | "workout", start: string): string {
  return stableId(kind, [epochSeconds(start)]);
}
