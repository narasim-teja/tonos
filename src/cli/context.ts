import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createActions, type Action, type LiveSource } from "../core/actions";
import { rangeSchema, type Range } from "../core/schema";
import { openStore, type Store } from "../core/store";
import { AuditLog } from "../mcp/audit";
import { Pairings } from "../mcp/pairing";
import { WhoopClient, credentialsFromEnv, keychainVault, type Credentials, type TokenVault } from "../whoop/api";

export type Flags = {
  data?: string; from?: string; to?: string; out?: string; format?: string; port?: string; json?: string; input?: string;
  activity?: string; count?: string; "no-naps"?: boolean; "allow-journal"?: boolean; live?: boolean; yes?: boolean;
};

/**
 * Everything a command may need, opened only when the command asks for it. A command that
 * fails before touching the store never creates a data directory; one that never reads
 * WHOOP never touches the keychain.
 */
export class Context {
  readonly directory: string;
  private opened: Store | null = null;

  constructor(readonly flags: Flags, readonly args: string[]) {
    this.directory = resolve(flags.data ?? process.env.TONOS_HOME ?? join(homedir(), ".tonos"));
  }

  /** Positional argument `index`, or an error naming the usage. */
  arg(index: number, usage: string): string {
    const value = this.args[index];
    if (value === undefined) throw new Error(`Usage: tonos ${usage}`);
    return value;
  }

  /** The --from/--to range, validated. */
  range(): Range {
    return rangeSchema.parse({ from: this.flags.from, to: this.flags.to });
  }

  store(): Store {
    this.opened ??= openStore(this.directory);
    return this.opened;
  }

  pairings(): Pairings { return new Pairings(this.directory); }
  audit(): AuditLog { return new AuditLog(this.directory); }
  vault(): TokenVault { return keychainVault(this.directory); }

  credentials(): Credentials {
    const credentials = credentialsFromEnv();
    if (credentials === null) throw new Error("Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET (your own WHOOP developer app) in the environment or .env.");
    return credentials;
  }

  /** The connected live WHOOP source. Fails with the next step when the user has not logged in. */
  async live(): Promise<LiveSource> {
    const credentials = this.credentials();
    const vault = this.vault();
    if ((await vault.load()) === null) throw new Error("Live WHOOP API is not connected. Run `tonos auth login`.");
    return new WhoopClient(credentials, vault);
  }

  /**
   * The session's read-only actions.
   *  - `audience`: the journal is opt-in (`--allow-journal`) for agents; at the terminal the
   *    user is reading their own data, so it is always available to `user`.
   *  - `live`: whether this session connects to WHOOP. The caller decides: a `live …` command
   *    always does, a server only with `--live`.
   */
  async actions(audience: "agent" | "user", live: boolean): Promise<Action[]> {
    return createActions(this.store(), {
      allowJournal: audience === "user" || this.flags["allow-journal"] === true,
      live: live ? await this.live() : null,
    });
  }

  close(): void {
    this.opened?.close();
  }
}
