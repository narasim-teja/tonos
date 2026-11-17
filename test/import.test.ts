import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { parseCsv, parseCsvRecords } from "../src/whoop/csv";
import { parseExport } from "../src/whoop/export";
import { recordDay } from "../src/core/day";
import { openStore } from "../src/core/store";
import { apiInstant, exportInstant, exportOffset, recordId } from "../src/core/time";
import { EXAMPLE_DIR, EXAMPLE_ZIP, exampleStore, tempDir } from "./helpers";

describe("csv", () => {
  test("quoted fields keep commas, doubled quotes and newlines", () => {
    expect(parseCsv('a,b\n1,"x, ""y""\nz"\n')).toEqual([["a", "b"], ["1", 'x, "y"\nz']]);
  });
  test("CRLF line endings and a byte-order mark are handled", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
  test("empty trailing cells are kept, so blank scores stay blank", () => {
    expect(parseCsv("a,b,c\n1,,\n")).toEqual([["a", "b", "c"], ["1", "", ""]]);
  });
  test("a row with the wrong number of fields fails instead of shifting columns", () => {
    expect(() => parseCsvRecords("a,b\n1,2,3\n", ["a"], "f.csv")).toThrow("row 2 has 3 fields, expected 2");
  });
  test("a missing column fails loudly", () => {
    expect(() => parseCsvRecords("a,b\n1,2\n", ["a", "Day Strain"], "f.csv")).toThrow('missing column(s) "Day Strain"');
  });
  test("an unterminated quote fails", () => {
    expect(() => parseCsv('a\n"open')).toThrow("inside a quoted field");
  });
});

describe("time", () => {
  test("export local time plus its offset becomes one exact instant", () => {
    expect(exportInstant("2026-11-16 02:19:14", exportOffset("UTC-05:00"))).toBe("2026-11-16T02:19:14-05:00");
    expect(exportOffset("UTC+05:30")).toBe("+05:30");
    expect(exportInstant("", "-05:00")).toBeNull();
  });
  test("an unexpected timestamp format fails instead of guessing", () => {
    expect(() => exportInstant("11/16/2026 2:19 AM", "-05:00")).toThrow("Unexpected timestamp format");
  });
  test("an API instant and an export row for the same moment get the same id", () => {
    const fromApi = apiInstant("2026-11-16T07:19:14.731Z", "-05:00");
    const fromExport = exportInstant("2026-11-16 02:19:14", "-05:00")!;
    expect(fromApi).toBe("2026-11-16T02:19:14-05:00");
    expect(recordId("cycle", fromApi)).toBe(recordId("cycle", fromExport));
  });
});

describe("import", () => {
  const parsed = parseExport(EXAMPLE_DIR);

  test("every example row is read and none skipped", () => {
    expect(parsed.report.counts).toEqual({ cycle: 4, sleep: 4, workout: 3, journal: 4 });
    expect(parsed.report.skipped).toEqual([]);
    expect(parsed.report.files.map(file => file.name).sort()).toEqual(
      ["journal_entries.csv", "physiological_cycles.csv", "sleeps.csv", "workouts.csv"]);
  });

  test("the zip and the folder produce identical records", () => {
    const zipped = parseExport(EXAMPLE_ZIP);
    expect(zipped.cycles).toEqual(parsed.cycles);
    expect(zipped.journal).toEqual(parsed.journal);
  });

  test("today's cycle has no end and no Strain, but keeps last night's Recovery", () => {
    const open = parsed.cycles.find(cycle => cycle.end === null)!;
    expect(open.start).toBe("2026-03-09T00:41:12-04:00");
    expect(open.strain).toBeNull();
    expect(open.score_state).toBe("ABSENT");
    expect(open.recovery?.recovery_score).toBe(71);
  });

  test("an unscored day keeps every value null, never zero", () => {
    const unscored = parsed.cycles.find(cycle => cycle.start === "2026-03-07T00:15:00-05:00")!;
    expect(unscored.recovery).toBeNull();
    expect(unscored.strain).toBeNull();
    expect(unscored.energy_kcal).toBeNull();
  });

  test("each row keeps its own offset across a daylight-saving change", () => {
    expect(parsed.cycles.map(cycle => cycle.timezone_offset)).toEqual(["-04:00", "-04:00", "-05:00", "-05:00"]);
  });

  test("naps are flagged and linked to their cycle", () => {
    const nap = parsed.sleeps.find(sleep => sleep.nap)!;
    expect(nap.consistency_percent).toBeNull();
    expect(nap.cycle_id).toBe(recordId("cycle", "2026-03-08T01:05:30-04:00"));
  });

  test("journal notes survive commas, quotes and newlines verbatim", () => {
    const note = parsed.journal.find(entry => entry.notes !== null)!;
    expect(note.notes).toBe('Two espressos, one after 4pm.\nAlso a "decaf" later');
    expect(parsed.journal.filter(entry => entry.cycle_id === null)).toHaveLength(1);
  });

  test("a sleep belongs to the day you woke up; a cycle to the waking day it covers", () => {
    const lateNight = parsed.sleeps.find(sleep => sleep.start === "2026-03-05T23:20:44-05:00")!;
    expect(recordDay(lateNight)).toBe("2026-03-06");
    const lateCycle = parsed.cycles.find(cycle => cycle.start === "2026-03-05T23:20:44-05:00")!;
    expect(recordDay(lateCycle)).toBe("2026-03-06");
  });
});

describe("store", () => {
  test("re-importing the same export changes nothing", () => {
    const { store, cleanup } = exampleStore();
    try {
      const again = store.importExport(parseExport(EXAMPLE_ZIP));
      expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 15 });
      expect(store.imports()).toHaveLength(2);
    } finally { cleanup(); }
  });

  test("a corrected value in a newer export updates in place", () => {
    const { store, cleanup } = exampleStore();
    try {
      const parsed = parseExport(EXAMPLE_DIR);
      parsed.cycles[1] = { ...parsed.cycles[1]!, strain: 14.3 };
      expect(store.importExport(parsed)).toMatchObject({ inserted: 0, updated: 1 });
      expect(store.list("cycle").find(cycle => cycle.id === parsed.cycles[1]!.id)?.strain).toBe(14.3);
    } finally { cleanup(); }
  });

  test("records from the live API are refused", () => {
    const { store, cleanup } = exampleStore();
    try {
      const parsed = parseExport(EXAMPLE_DIR);
      parsed.cycles = [{ ...parsed.cycles[0]!, source: "api" }];
      expect(() => store.importExport(parsed)).toThrow("Only records from the member's own export are stored.");
    } finally { cleanup(); }
  });

  test("ranges select by local day", () => {
    const { store, cleanup } = exampleStore();
    try {
      expect(store.list("sleep", { from: "2026-03-08", to: "2026-03-08" }).map(sleep => sleep.nap)).toEqual([false, true]);
      expect(store.list("cycle", { from: "2026-03-01", to: "2026-03-05" })).toEqual([]);
    } finally { cleanup(); }
  });

  test("the store file is readable by the owner only", () => {
    const { dir, cleanup } = tempDir();
    try {
      openStore(dir).close();
      expect(statSync(join(dir, "records.sqlite")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally { cleanup(); }
  });

  test("purge deletes every record", () => {
    const { store, cleanup } = exampleStore();
    try {
      expect(store.purge()).toEqual({ deleted: 15 });
      expect(store.coverage().cycle.count).toBe(0);
    } finally { cleanup(); }
  });
});
