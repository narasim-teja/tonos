import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExport } from "../src/whoop/export";
import { openStore, type Store } from "../src/core/store";

export const EXAMPLE_DIR = new URL("../examples/export", import.meta.url).pathname;
export const EXAMPLE_ZIP = new URL("../examples/export.zip", import.meta.url).pathname;

/** A fresh data directory, removed by the returned cleanup. */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tonos-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A store with the fictional example export imported. */
export function exampleStore(): { store: Store; dir: string; cleanup: () => void } {
  const { dir, cleanup } = tempDir();
  const store = openStore(dir);
  store.importExport(parseExport(EXAMPLE_DIR));
  return { store, dir, cleanup: () => { store.close(); cleanup(); } };
}
