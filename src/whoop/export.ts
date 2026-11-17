import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  SCHEMA_VERSION, cycleSchema, journalSchema, sleepSchema, workoutSchema,
  type Cycle, type JournalEntry, type Recovery, type Sleep, type Workout,
} from "../core/schema";
import type { ImportBatch, ImportReport } from "../core/store";
import { epochSeconds, exportInstant, exportOffset, recordId, stableId } from "../core/time";
import { parseCsvRecords } from "./csv";

/** The four files in WHOOP's in-app CSV export, with the columns this importer reads. */
export const EXPORT_FILES = {
  "physiological_cycles.csv": [
    "Cycle start time", "Cycle end time", "Cycle timezone", "Recovery score %", "Resting heart rate (bpm)",
    "Heart rate variability (ms)", "Skin temp (celsius)", "Blood oxygen %", "Day Strain", "Energy burned (cal)",
    "Max HR (bpm)", "Average HR (bpm)",
  ],
  "sleeps.csv": [
    "Cycle start time", "Cycle timezone", "Sleep onset", "Wake onset", "Sleep performance %", "Respiratory rate (rpm)",
    "Asleep duration (min)", "In bed duration (min)", "Light sleep duration (min)", "Deep (SWS) duration (min)",
    "REM duration (min)", "Awake duration (min)", "Sleep need (min)", "Sleep debt (min)", "Sleep efficiency %",
    "Sleep consistency %", "Nap",
  ],
  "workouts.csv": [
    "Cycle start time", "Cycle timezone", "Workout start time", "Workout end time", "Duration (min)", "Activity name",
    "Activity Strain", "Energy burned (cal)", "Max HR (bpm)", "Average HR (bpm)", "HR Zone 1 %", "HR Zone 2 %",
    "HR Zone 3 %", "HR Zone 4 %", "HR Zone 5 %", "GPS enabled",
  ],
  "journal_entries.csv": ["Cycle start time", "Cycle timezone", "Question text", "Answered yes", "Notes"],
} as const;

type ExportFile = keyof typeof EXPORT_FILES;

/** Number cell → number, blank → null. Anything else is a format change and fails loudly. */
function num(row: Record<string, string>, column: string): number | null {
  const value = row[column]?.trim() ?? "";
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Column ${JSON.stringify(column)} has a non-numeric value.`);
  return parsed;
}

function bool(row: Record<string, string>, column: string): boolean | null {
  const value = row[column]?.trim().toLowerCase() ?? "";
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Column ${JSON.stringify(column)} has a non-boolean value.`);
}

function text(row: Record<string, string>, column: string): string | null {
  const value = row[column] ?? "";
  return value.trim() === "" ? null : value;
}

/** Offset for a row, or null when the export left the cycle columns blank. */
function rowOffset(row: Record<string, string>): string | null {
  const zone = row["Cycle timezone"]?.trim() ?? "";
  return zone === "" ? null : exportOffset(zone);
}

function cycleIdFor(row: Record<string, string>, offset: string | null): string | null {
  const start = offset === null ? null : exportInstant(row["Cycle start time"], offset);
  return start === null ? null : recordId("cycle", start);
}

function readSource(path: string): Map<ExportFile, string> {
  if (!existsSync(path)) throw new Error(`No such file or directory: ${path}`);
  const files = new Map<ExportFile, string>();
  const wanted = Object.keys(EXPORT_FILES) as ExportFile[];
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      if ((wanted as string[]).includes(name)) files.set(name as ExportFile, readFileSync(join(path, name), "utf8"));
    }
  } else if (path.toLowerCase().endsWith(".zip")) {
    const list = Bun.spawnSync(["unzip", "-Z1", path]);
    if (list.exitCode !== 0) throw new Error(`Could not read zip: ${list.stderr.toString().trim()}`);
    for (const entry of list.stdout.toString().split("\n").map(line => line.trim()).filter(Boolean)) {
      const name = basename(entry);
      if (!(wanted as string[]).includes(name) || entry.includes("__MACOSX")) continue;
      const read = Bun.spawnSync(["unzip", "-p", path, entry]);
      if (read.exitCode !== 0) throw new Error(`Could not extract ${entry} from zip.`);
      files.set(name as ExportFile, read.stdout.toString());
    }
  } else {
    throw new Error("Import a WHOOP export folder or its .zip file.");
  }
  if (files.size === 0) {
    throw new Error(`No WHOOP export files found. Expected one of: ${wanted.join(", ")}.`);
  }
  return files;
}

/**
 * Parses a WHOOP member data export into validated records. Pure: it reads files and
 * returns records; writing them is the store's job.
 */
export function parseExport(path: string): ImportBatch {
  const sources = readSource(path);
  const report: ImportReport = {
    source_path: path, files: [], counts: { cycle: 0, sleep: 0, workout: 0, journal: 0 }, skipped: [],
    range: { from: null, to: null },
  };
  const rowsOf = (file: ExportFile) => {
    const contents = sources.get(file);
    if (contents === undefined) return [];
    const rows = parseCsvRecords(contents, EXPORT_FILES[file], file);
    report.files.push({ name: file, sha256: createHash("sha256").update(contents).digest("hex"), rows: rows.length });
    return rows;
  };
  const each = <T>(file: ExportFile, build: (row: Record<string, string>) => T | null): T[] => {
    const out: T[] = [];
    rowsOf(file).forEach((row, index) => {
      try {
        const value = build(row);
        if (value !== null) out.push(value);
      } catch (error) {
        report.skipped.push({ file, row: index + 2, reason: error instanceof Error ? error.message : String(error) });
      }
    });
    return out;
  };

  const cycles = each("physiological_cycles.csv", row => {
    const offset = rowOffset(row);
    const start = offset === null ? null : exportInstant(row["Cycle start time"], offset);
    if (offset === null || start === null) throw new Error("Cycle has no start time.");
    const recovery: Recovery = {
      recovery_score: num(row, "Recovery score %"),
      resting_heart_rate: num(row, "Resting heart rate (bpm)"),
      hrv_rmssd_ms: num(row, "Heart rate variability (ms)"),
      spo2_percent: num(row, "Blood oxygen %"),
      skin_temp_celsius: num(row, "Skin temp (celsius)"),
    };
    const strain = num(row, "Day Strain");
    return cycleSchema.parse({
      schema_version: SCHEMA_VERSION, id: recordId("cycle", start), kind: "cycle", source: "export", whoop_id: null,
      start, end: exportInstant(row["Cycle end time"], offset), timezone_offset: offset,
      score_state: strain === null ? "ABSENT" : "SCORED",
      strain, energy_kcal: num(row, "Energy burned (cal)"),
      average_heart_rate: num(row, "Average HR (bpm)"), max_heart_rate: num(row, "Max HR (bpm)"),
      step_count: null,
      recovery: Object.values(recovery).every(value => value === null) ? null : recovery,
    } satisfies Cycle);
  });

  const sleeps = each("sleeps.csv", row => {
    const offset = rowOffset(row);
    const start = exportInstant(row["Sleep onset"], offset);
    const end = exportInstant(row["Wake onset"], offset);
    if (offset === null || start === null || end === null) throw new Error("Sleep has no onset or wake time.");
    const performance = num(row, "Sleep performance %");
    return sleepSchema.parse({
      schema_version: SCHEMA_VERSION, id: recordId("sleep", start), kind: "sleep", source: "export", whoop_id: null,
      start, end, timezone_offset: offset, score_state: performance === null ? "ABSENT" : "SCORED",
      nap: bool(row, "Nap") ?? false, cycle_id: cycleIdFor(row, offset),
      performance_percent: performance, consistency_percent: num(row, "Sleep consistency %"),
      efficiency_percent: num(row, "Sleep efficiency %"), respiratory_rate: num(row, "Respiratory rate (rpm)"),
      asleep_min: num(row, "Asleep duration (min)"), in_bed_min: num(row, "In bed duration (min)"),
      light_min: num(row, "Light sleep duration (min)"), deep_min: num(row, "Deep (SWS) duration (min)"),
      rem_min: num(row, "REM duration (min)"), awake_min: num(row, "Awake duration (min)"),
      need_min: num(row, "Sleep need (min)"), debt_min: num(row, "Sleep debt (min)"),
    } satisfies Sleep);
  });

  const workouts = each("workouts.csv", row => {
    const offset = rowOffset(row);
    const start = exportInstant(row["Workout start time"], offset);
    const end = exportInstant(row["Workout end time"], offset);
    if (offset === null || start === null || end === null) throw new Error("Workout has no start or end time.");
    const zones = {
      zone_1: num(row, "HR Zone 1 %"), zone_2: num(row, "HR Zone 2 %"), zone_3: num(row, "HR Zone 3 %"),
      zone_4: num(row, "HR Zone 4 %"), zone_5: num(row, "HR Zone 5 %"),
    };
    const strain = num(row, "Activity Strain");
    return workoutSchema.parse({
      schema_version: SCHEMA_VERSION, id: recordId("workout", start), kind: "workout", source: "export", whoop_id: null,
      start, end, timezone_offset: offset, score_state: strain === null ? "ABSENT" : "SCORED",
      cycle_id: cycleIdFor(row, offset), activity: text(row, "Activity name") ?? "Activity",
      duration_min: num(row, "Duration (min)"), strain, energy_kcal: num(row, "Energy burned (cal)"),
      average_heart_rate: num(row, "Average HR (bpm)"), max_heart_rate: num(row, "Max HR (bpm)"),
      heart_rate_zones_percent: Object.values(zones).every(value => value === null) ? null : zones,
      distance_m: null, gps: bool(row, "GPS enabled"),
    } satisfies Workout);
  });

  const journal = each("journal_entries.csv", row => {
    const offset = rowOffset(row);
    const cycleStart = offset === null ? null : exportInstant(row["Cycle start time"], offset);
    const question = text(row, "Question text");
    const answer = bool(row, "Answered yes");
    if (question === null || answer === null) throw new Error("Journal row has no question or answer.");
    const notes = text(row, "Notes");
    // Rows without a cycle are keyed by their content so re-imports stay idempotent.
    const key = cycleStart === null ? ["no-cycle", question, String(answer), notes ?? ""] : [epochSeconds(cycleStart), question];
    return journalSchema.parse({
      schema_version: SCHEMA_VERSION, id: stableId("journal", key), kind: "journal", source: "export",
      cycle_id: cycleStart === null ? null : recordId("cycle", cycleStart), cycle_start: cycleStart,
      timezone_offset: offset, question, answered_yes: answer, notes,
    } satisfies JournalEntry);
  });

  report.counts = { cycle: cycles.length, sleep: sleeps.length, workout: workouts.length, journal: journal.length };
  const starts = [...cycles, ...sleeps, ...workouts].map(record => record.start.slice(0, 10)).sort();
  report.range = { from: starts[0] ?? null, to: starts.at(-1) ?? null };
  return { cycles, sleeps, workouts, journal, report };
}
