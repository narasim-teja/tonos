import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensureDataDir } from "../core/data-dir";

const TOKEN_PREFIX = "tns_";

const pairingSchema = z.strictObject({
  id: z.string(),
  name: z.string().min(1).max(80),
  token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  /** First characters of the token, shown so the user can tell pairings apart. Not enough to authenticate. */
  token_prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  request_count: z.number().int(),
});

export type Pairing = z.infer<typeof pairingSchema>;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Writes via a temporary file and rename, so a crash never leaves a half-written file. Owner-only. */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Per-agent bearer tokens for the loopback server. Each agent the user pairs gets its own
 * token, shown once. Only its SHA-256 is stored; comparison is constant-time. Revoking one
 * agent leaves the others working.
 */
export class Pairings {
  private file: string;

  constructor(private directory: string) {
    this.file = join(directory, "pairings.json");
  }

  list(): Pairing[] {
    if (!existsSync(this.file)) return [];
    return z.array(pairingSchema).parse(JSON.parse(readFileSync(this.file, "utf8")));
  }

  private save(pairings: Pairing[]): void {
    ensureDataDir(this.directory);
    writeAtomic(this.file, `${JSON.stringify(pairings, null, 2)}\n`);
  }

  /** Creates a pairing and returns the token. It is never shown again. */
  pair(name: string, now = new Date()): { pairing: Pairing; token: string } {
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const pairing = pairingSchema.parse({
      id: randomBytes(6).toString("hex"), name: name.trim(), token_hash: sha256(token), token_prefix: token.slice(0, 10),
      created_at: now.toISOString(), last_used_at: null, revoked_at: null, request_count: 0,
    });
    this.save([...this.list(), pairing]);
    return { pairing, token };
  }

  /** Revokes by id or by name. Returns the revoked pairings. */
  revoke(idOrName: string, now = new Date()): Pairing[] {
    const revoked: Pairing[] = [];
    const pairings = this.list().map(pairing => {
      if (pairing.revoked_at === null && (pairing.id === idOrName || pairing.name === idOrName)) {
        const updated = { ...pairing, revoked_at: now.toISOString() };
        revoked.push(updated);
        return updated;
      }
      return pairing;
    });
    if (revoked.length === 0) throw new Error(`No active pairing named or with id ${JSON.stringify(idOrName)}.`);
    this.save(pairings);
    return revoked;
  }

  /** The active pairing a bearer token belongs to, or null. Records the use. */
  authenticate(token: string | null, now = new Date()): Pairing | null {
    if (token === null || !token.startsWith(TOKEN_PREFIX)) return null;
    const presented = Buffer.from(sha256(token), "hex");
    const pairings = this.list();
    const match = pairings.find(pairing =>
      pairing.revoked_at === null && timingSafeEqual(Buffer.from(pairing.token_hash, "hex"), presented));
    if (!match) return null;
    match.last_used_at = now.toISOString();
    match.request_count += 1;
    this.save(pairings);
    return match;
  }
}
