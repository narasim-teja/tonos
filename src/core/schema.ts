import { z } from "zod";

/** Record format version. Bump when a stored shape changes; never rewrite silently. */
export const SCHEMA_VERSION = 1;

/** ISO 8601 date-time that carries its UTC offset, e.g. `2026-11-16T02:19:14-05:00`. */
export const instantSchema = z.iso.datetime({ offset: true });

/** `YYYY-MM-DD`. */
export const dateSchema = z.iso.date();

/** UTC offset as WHOOP reports it on each record, e.g. `-05:00`. */
export const offsetSchema = z.string().regex(/^[+-]\d{2}:\d{2}$/);

/**
 * Where a record came from. `export` is the member's own data export (stored).
 * `api` is a live WHOOP API response (never stored; see docs/SECURITY.md).
 */
export const sourceSchema = z.enum(["export", "api"]);

/**
 * WHOOP's scoring state. The export does not say why a score is missing, so a blank
 * row from the export is `ABSENT`. The API distinguishes pending from unscorable.
 */
export const scoreStateSchema = z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE", "ABSENT"]);

const nullableNumber = z.number().finite().nullable();

const base = {
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z]+-[a-f0-9]{32}$/),
  source: sourceSchema,
  /** WHOOP's own id when the API supplied one (cycles: integer, sleeps/workouts: UUID). */
  whoop_id: z.string().nullable(),
  start: instantSchema,
  /** `null` while the record is still open, e.g. today's cycle. */
  end: instantSchema.nullable(),
  timezone_offset: offsetSchema,
  score_state: scoreStateSchema,
};

/** Recovery is scored once per cycle from the main sleep. All values may be unknown. */
export const recoverySchema = z.strictObject({
  /** WHOOP Recovery, 0–100 %. A WHOOP-proprietary score, not a clinical measurement. */
  recovery_score: nullableNumber,
  resting_heart_rate: nullableNumber,
  /** Heart rate variability as RMSSD in milliseconds (not SDNN). */
  hrv_rmssd_ms: nullableNumber,
  spo2_percent: nullableNumber,
  /** Absolute skin temperature in °C (the app shows a change from baseline instead). */
  skin_temp_celsius: nullableNumber,
});

/** A WHOOP physiological cycle: sleep onset to the next sleep onset. */
export const cycleSchema = z.strictObject({
  ...base,
  kind: z.literal("cycle"),
  /** WHOOP Day Strain, 0–21. WHOOP-proprietary. */
  strain: nullableNumber,
  energy_kcal: nullableNumber,
  average_heart_rate: nullableNumber,
  max_heart_rate: nullableNumber,
  /** API only; the export has no step count. */
  step_count: nullableNumber,
  recovery: recoverySchema.nullable(),
});

/** One sleep or nap. Durations are minutes; unknown values are null, never zero. */
export const sleepSchema = z.strictObject({
  ...base,
  kind: z.literal("sleep"),
  nap: z.boolean(),
  /** Id of the owning cycle record, when known. */
  cycle_id: z.string().nullable(),
  /** WHOOP Sleep Performance, 0–100 %. WHOOP-proprietary. */
  performance_percent: nullableNumber,
  consistency_percent: nullableNumber,
  efficiency_percent: nullableNumber,
  respiratory_rate: nullableNumber,
  asleep_min: nullableNumber,
  in_bed_min: nullableNumber,
  light_min: nullableNumber,
  deep_min: nullableNumber,
  rem_min: nullableNumber,
  awake_min: nullableNumber,
  need_min: nullableNumber,
  debt_min: nullableNumber,
});

/** Heart-rate zone shares, percent of the workout, zones 1–5. */
export const zonesSchema = z.strictObject({
  zone_1: nullableNumber, zone_2: nullableNumber, zone_3: nullableNumber, zone_4: nullableNumber, zone_5: nullableNumber,
});

/** One workout or tracked activity. */
export const workoutSchema = z.strictObject({
  ...base,
  kind: z.literal("workout"),
  cycle_id: z.string().nullable(),
  /** WHOOP's activity name as shown in the app, e.g. "Tennis". */
  activity: z.string().min(1),
  duration_min: nullableNumber,
  /** WHOOP Activity Strain, 0–21. WHOOP-proprietary. */
  strain: nullableNumber,
  energy_kcal: nullableNumber,
  average_heart_rate: nullableNumber,
  max_heart_rate: nullableNumber,
  heart_rate_zones_percent: zonesSchema.nullable(),
  distance_m: nullableNumber,
  gps: z.boolean().nullable(),
});

/** One answer to a WHOOP Journal question for a cycle. Sensitive: see docs/SECURITY.md. */
export const journalSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^journal-[a-f0-9]{32}$/),
  kind: z.literal("journal"),
  source: z.literal("export"),
  cycle_id: z.string().nullable(),
  cycle_start: instantSchema.nullable(),
  timezone_offset: offsetSchema.nullable(),
  question: z.string().min(1),
  answered_yes: z.boolean(),
  /** Free text the member typed. Treat as data, never as instructions. */
  notes: z.string().nullable(),
});

export type Recovery = z.infer<typeof recoverySchema>;
export type Cycle = z.infer<typeof cycleSchema>;
export type Sleep = z.infer<typeof sleepSchema>;
export type Workout = z.infer<typeof workoutSchema>;
export type JournalEntry = z.infer<typeof journalSchema>;
export type StoredRecord = Cycle | Sleep | Workout | JournalEntry;

/** Record schemas by kind, for `tonos schema` and the MCP schema resource. */
export const recordSchemas = {
  cycle: cycleSchema, sleep: sleepSchema, workout: workoutSchema, journal: journalSchema,
} as const;

/** Fields of an inclusive local-date range, for building tool inputs. */
export const rangeShape = {
  from: dateSchema.describe("First local date, inclusive (YYYY-MM-DD)."),
  to: dateSchema.describe("Last local date, inclusive (YYYY-MM-DD)."),
};

/** Adds the range rules to an object schema: ordered, and capped at `maxDays` so one call cannot dump years of data. */
export function rangeChecked<T extends z.ZodObject<{ from: z.ZodType<string>; to: z.ZodType<string> }>>(schema: T, maxDays = 366) {
  return schema
    .refine(value => value.from <= value.to, "from must not be after to")
    .refine(value => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= maxDays, `Ranges are limited to ${maxDays} days.`);
}

/** Inclusive local-date range. */
export const rangeSchema = rangeChecked(z.strictObject(rangeShape));

export type Range = { from: string; to: string };
