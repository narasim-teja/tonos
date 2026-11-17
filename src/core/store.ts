import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir } from "./data-dir";
import { recordDay } from "./day";
import {
  SCHEMA_VERSION, cycleSchema, journalSchema, sleepSchema, workoutSchema,
  type Cycle, type JournalEntry, type Range, type Sleep, type StoredRecord, type Workout,
} from "./schema";
import { epochSeconds } from "./time";

export type Kind = StoredRecord["kind"];

const parsers = { cycle: cycleSchema, sleep: sleepSchema, workout: workoutSchema, journal: journalSchema } as const;

type KindMap = { cycle: Cycle; sleep: Sleep; workout: Workout; journal: JournalEntry };

/** Provenance of one import: the files read (with SHA-256), counts, skipped rows and the day range. */
export type ImportReport = {
  source_path: string;
  files: Array<{ name: string; sha256: string; rows: number }>;
  counts: Record<Kind, number>;
  skipped: Array<{ file: string; row: number; reason: string }>;
  range: { from: string | null; to: string | null };
};

/** What any data source hands the store: validated records plus their provenance. */
export type ImportBatch = {
  cycles: Cycle[]; sleeps: Sleep[]; workouts: Workout[]; journal: JournalEntry[]; report: ImportReport;
};

/** Result of writing one import: what changed, so re-importing the same export is visibly a no-op. */
export type ImportResult = {
  inserted: number; updated: number; unchanged: number; report: ImportReport;
};

/**
 * Local store for records from the member's own export. One SQLite file, readable only
 * by the owner. API responses are never written here (see docs/SECURITY.md); `importExport` refuses them.
 */
export class Store {
  readonly path: string;
  private db: Database;

  constructor(directory: string) {
    this.path = join(ensureDataDir(directory), "records.sqlite");
    this.db = new Database(this.path, { create: true, strict: true });
    chmodSync(this.path, 0o600);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, day TEXT, start_epoch INTEGER, body TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS records_kind_day ON records (kind, day)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, imported_at TEXT NOT NULL, report TEXT NOT NULL)`);
    const version = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (version === null) {
      this.db.query("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(version.value) !== SCHEMA_VERSION) {
      throw new Error(`Store ${this.path} uses schema version ${version.value}; this build reads ${SCHEMA_VERSION}. Re-import into a new data directory.`);
    }
  }

  /**
   * Writes one parsed export in a single transaction. Records are keyed by stable ids,
   * so importing the same export twice changes nothing and a newer export updates in place.
   */
  importExport(parsed: ImportBatch, now = new Date()): ImportResult {
    const records: StoredRecord[] = [...parsed.cycles, ...parsed.sleeps, ...parsed.workouts, ...parsed.journal];
    const result: ImportResult = { inserted: 0, updated: 0, unchanged: 0, report: parsed.report };
    const select = this.db.query<{ body: string }, [string]>("SELECT body FROM records WHERE id = ?");
    const upsert = this.db.query(`INSERT INTO records (id, kind, day, start_epoch, body, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, day = excluded.day, start_epoch = excluded.start_epoch,
        body = excluded.body, updated_at = excluded.updated_at`);
    const timestamp = now.toISOString();
    this.db.transaction(() => {
      for (const record of records) {
        if (record.source !== "export") throw new Error("Only records from the member's own export are stored.");
        const body = JSON.stringify(parsers[record.kind].parse(record));
        const existing = select.get(record.id);
        if (existing?.body === body) { result.unchanged += 1; continue; }
        if (existing) result.updated += 1; else result.inserted += 1;
        const start = record.kind === "journal" ? record.cycle_start : record.start;
        upsert.run(record.id, record.kind, recordDay(record), start === null ? null : epochSeconds(start), body, timestamp);
      }
      this.db.query("INSERT INTO imports (imported_at, report) VALUES (?, ?)")
        .run(timestamp, JSON.stringify({ ...parsed.report, inserted: result.inserted, updated: result.updated, unchanged: result.unchanged }));
    })();
    return result;
  }

  /** Records of one kind, oldest first, optionally limited to an inclusive local-day range. */
  list<K extends Kind>(kind: K, range?: Range): Array<KindMap[K]> {
    const rows = range
      ? this.db.query<{ body: string }, [string, string, string]>(
        "SELECT body FROM records WHERE kind = ? AND day >= ? AND day <= ? ORDER BY start_epoch, id").all(kind, range.from, range.to)
      : this.db.query<{ body: string }, [string]>("SELECT body FROM records WHERE kind = ? ORDER BY start_epoch, id").all(kind);
    return rows.map(row => parsers[kind].parse(JSON.parse(row.body)) as KindMap[K]);
  }

  /** One record by id, or null. */
  get(id: string): StoredRecord | null {
    const row = this.db.query<{ kind: Kind; body: string }, [string]>("SELECT kind, body FROM records WHERE id = ?").get(id);
    return row === null ? null : parsers[row.kind].parse(JSON.parse(row.body));
  }

  /** Counts and the first/last local day per kind. */
  coverage(): Record<Kind, { count: number; first_day: string | null; last_day: string | null }> {
    const rows = this.db.query<{ kind: Kind; count: number; first: string | null; last: string | null }, []>(
      "SELECT kind, COUNT(*) AS count, MIN(day) AS first, MAX(day) AS last FROM records GROUP BY kind").all();
    const empty = { count: 0, first_day: null, last_day: null };
    const out: Record<Kind, { count: number; first_day: string | null; last_day: string | null }> = {
      cycle: { ...empty }, sleep: { ...empty }, workout: { ...empty }, journal: { ...empty },
    };
    for (const row of rows) out[row.kind] = { count: row.count, first_day: row.first, last_day: row.last };
    return out;
  }

  /** Import history, newest first. */
  imports(): Array<{ imported_at: string; report: unknown }> {
    return this.db.query<{ imported_at: string; report: string }, []>(
      "SELECT imported_at, report FROM imports ORDER BY id DESC").all()
      .map(row => ({ imported_at: row.imported_at, report: JSON.parse(row.report) }));
  }

  /** Deletes every stored record and the import history. The file itself stays. */
  purge(): { deleted: number } {
    const { count } = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM records").get() ?? { count: 0 };
    this.db.transaction(() => {
      this.db.run("DELETE FROM records");
      this.db.run("DELETE FROM imports");
    })();
    this.db.run("VACUUM");
    return { deleted: count };
  }

  close(): void {
    this.db.close();
  }
}

/** Opens (creating if needed) the store in a data directory. */
export function openStore(directory: string): Store {
  return new Store(directory);
}
