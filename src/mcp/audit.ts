import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir } from "../core/data-dir";

/** One request to the loopback server, allowed or not. Results are never logged. */
export type AuditEvent = {
  at: string;
  outcome: "ok" | "denied" | "error";
  /** The paired agent's name, or null when the request was not authenticated. */
  pairing: string | null;
  /** JSON-RPC method (`tools/call`, `tools/list`, …) or the HTTP method for non-RPC requests. */
  method: string;
  tool?: string;
  /** Tool arguments: date ranges and filters. */
  arguments?: unknown;
  detail?: string;
  duration_ms?: number;
};

/** Append-only JSON Lines log, owner-only. */
export class AuditLog {
  readonly file: string;

  constructor(private directory: string) {
    this.file = join(directory, "audit.jsonl");
  }

  append(event: AuditEvent): void {
    ensureDataDir(this.directory);
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  tail(count = 20): AuditEvent[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).slice(-count).map(line => JSON.parse(line) as AuditEvent);
  }
}
