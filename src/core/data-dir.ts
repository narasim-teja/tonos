import { existsSync, mkdirSync } from "node:fs";

/**
 * Creates the data directory, owner-only (0700), if it does not exist. Every component that
 * writes into the data directory (store, pairings, audit log) calls this; nothing creates it
 * as a side effect of something else. An existing directory's permissions are left alone,
 * since the user may have pointed `--data` at a folder they manage.
 */
export function ensureDataDir(directory: string): string {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
