import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { recordJsonSchemas } from "../core/actions";
import { recordSchemas } from "../core/schema";
import { mergePhr, parsePhr } from "../fhir/merge";
import { buildPhr, toBundle, toNdjson } from "../fhir/phr";
import { DEFAULT_PORT, serveHttp } from "../mcp/http";
import { serveStdio } from "../mcp/server";
import { WhoopClient, login } from "../whoop/api";
import { parseExport } from "../whoop/export";
import type { Context } from "./context";

/** One CLI command. `run` returns what to print; it opens only the resources it uses. */
export type Command = {
  name: string;
  usage: string;
  summary: string;
  group: "Data" | "FHIR" | "Agents" | "Live WHOOP API";
  run: (ctx: Context) => Promise<unknown>;
};

/**
 * A command that runs one shared action, so CLI and MCP results are identical by
 * construction. `live` says whether the action reads WHOOP instead of the store.
 */
function query(name: string, usage: string, summary: string, action: string, input: (ctx: Context) => unknown,
  options: { group?: Command["group"]; live?: boolean } = {}): Command {
  return {
    name, usage, summary, group: options.group ?? "Data",
    run: async ctx => {
      const actions = await ctx.actions("user", options.live ?? false);
      const found = actions.find(candidate => candidate.name === action);
      if (!found) throw new Error(`Action ${action} is not available in this session.`);
      return found.run(input(ctx));
    },
  };
}

function writeOrReturn(ctx: Context, text: string, summary: Record<string, unknown>): unknown {
  if (ctx.flags.out === undefined) return text;
  writeFileSync(ctx.flags.out, text, { mode: 0o600 });
  return { written: ctx.flags.out, ...summary };
}

export const COMMANDS: Command[] = [
  {
    name: "import", usage: "import <export.zip | export-folder>", summary: "Import your WHOOP data export. Safe to repeat.", group: "Data",
    // Parse before touching the store: a bad path or format creates nothing.
    run: async ctx => {
      const batch = parseExport(resolve(ctx.arg(0, "import <export.zip | export-folder>")));
      return ctx.store().importExport(batch);
    },
  },
  query("status", "status", "What is stored, and from which import.", "status", () => ({})),
  query("day", "day YYYY-MM-DD", "One day: recovery, sleep, strain, workouts.", "get_daily_summary", ctx => ({ from: ctx.arg(0, "day YYYY-MM-DD"), to: ctx.arg(0, "day YYYY-MM-DD") })),
  query("summary", "summary --from … --to …", "Per-day summary and averages.", "get_daily_summary", ctx => ctx.range()),
  query("cycles", "cycles --from … --to …", "Cycles with recovery and strain.", "get_cycles", ctx => ctx.range()),
  query("sleeps", "sleeps --from … --to … [--no-naps]", "Sleeps and naps.", "get_sleeps", ctx => ({ ...ctx.range(), include_naps: ctx.flags["no-naps"] !== true })),
  query("workouts", "workouts --from … --to … [--activity Tennis]", "Workouts.", "get_workouts", ctx => ({ ...ctx.range(), activity: ctx.flags.activity })),
  query("journal", "journal --from … --to …", "WHOOP Journal answers and notes.", "get_journal", ctx => ctx.range()),
  {
    name: "purge", usage: "purge --yes", summary: "Delete every stored record.", group: "Data",
    run: async ctx => {
      if (ctx.flags.yes !== true) throw new Error("This deletes every stored record. Re-run with --yes.");
      return ctx.store().purge();
    },
  },
  {
    name: "export records", usage: "export records [--from … --to …] [--out file]", summary: "Native records as NDJSON.", group: "Data",
    run: async ctx => {
      const range = ctx.flags.from === undefined && ctx.flags.to === undefined ? undefined : ctx.range();
      const store = ctx.store();
      const records = (["cycle", "sleep", "workout", "journal"] as const).flatMap(kind => store.list(kind, range));
      return writeOrReturn(ctx, records.map(record => JSON.stringify(record)).join("\n") + "\n", { records: records.length });
    },
  },
  {
    name: "export phr", usage: "export phr [--format ndjson|bundle] [--from … --to …] [--out file]", summary: "HL7 FHIR Personal Health Record.", group: "FHIR",
    run: async ctx => {
      const format = z.enum(["ndjson", "bundle"]).parse(ctx.flags.format ?? "ndjson");
      const range = ctx.flags.from === undefined && ctx.flags.to === undefined ? undefined : ctx.range();
      const store = ctx.store();
      const lastImport = store.imports()[0]?.report as { files?: Array<{ name: string; sha256: string }> } | undefined;
      const resources = buildPhr({
        cycles: store.list("cycle", range), sleeps: store.list("sleep", range), workouts: store.list("workout", range),
        sources: (lastImport?.files ?? []).map(file => ({ name: file.name, sha256: file.sha256 })),
      });
      const text = format === "ndjson" ? toNdjson(resources) : `${JSON.stringify(toBundle(resources), null, 2)}\n`;
      return writeOrReturn(ctx, text, { format, resources: resources.length });
    },
  },
  {
    name: "phr merge", usage: "phr merge <a.phr> <b.phr> [...] --out merged.phr", summary: "Merge PHR files, e.g. with Health Bridge's.", group: "FHIR",
    run: async ctx => {
      if (ctx.args.length < 2 || ctx.flags.out === undefined) throw new Error("Usage: tonos phr merge <a.phr> <b.phr> [...] --out merged.phr");
      const merged = mergePhr(ctx.args.map(file => ({ name: file, resources: parsePhr(readFileSync(file, "utf8"), file) })));
      writeFileSync(ctx.flags.out, toNdjson(merged.resources), { mode: 0o600 });
      return { written: ctx.flags.out, ...merged.report };
    },
  },
  {
    name: "pair", usage: "pair <name>", summary: "Create a token for one agent (shown once).", group: "Agents",
    run: async ctx => {
      const { pairing, token } = ctx.pairings().pair(ctx.args.join(" ") || ctx.arg(0, "pair <name>"));
      const port = Number(ctx.flags.port ?? DEFAULT_PORT);
      return {
        paired: pairing.name, id: pairing.id, token, note: "Shown once. Store it in your agent's MCP config.",
        mcp_config: { mcpServers: { tonos: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
      };
    },
  },
  {
    name: "pairs", usage: "pairs", summary: "List pairings.", group: "Agents",
    run: async ctx => ctx.pairings().list().map(({ token_hash: _hash, ...visible }) => visible),
  },
  {
    name: "unpair", usage: "unpair <id | name>", summary: "Revoke one agent.", group: "Agents",
    run: async ctx => ({ revoked: ctx.pairings().revoke(ctx.arg(0, "unpair <id | name>")).map(pairing => pairing.name) }),
  },
  {
    name: "serve", usage: `serve [--port ${DEFAULT_PORT}] [--allow-journal] [--live]`, summary: "Loopback MCP on 127.0.0.1.", group: "Agents",
    run: async ctx => {
      const actions = await ctx.actions("agent", ctx.flags.live === true);
      const server = serveHttp({ actions, pairings: ctx.pairings(), audit: ctx.audit(), port: Number(ctx.flags.port ?? DEFAULT_PORT) });
      process.stderr.write(`tonos MCP on http://127.0.0.1:${server.port}/mcp — ${actions.length} read-only tools. Ctrl-C to stop.\n`);
      return new Promise(() => {});
    },
  },
  {
    name: "mcp", usage: "mcp [--allow-journal] [--live]", summary: "MCP over stdio.", group: "Agents",
    run: async ctx => {
      await serveStdio(await ctx.actions("agent", ctx.flags.live === true));
      return new Promise(() => {});
    },
  },
  {
    name: "audit", usage: "audit [--count 20]", summary: "Recent loopback requests.", group: "Agents",
    run: async ctx => ctx.audit().tail(Number(ctx.flags.count ?? "20")),
  },
  {
    name: "tools", usage: "tools", summary: "The read-only actions and their input schemas.", group: "Agents",
    run: async ctx => (await ctx.actions("user", ctx.flags.live === true)).map(action => ({
      name: action.name, description: action.description, inputSchema: z.toJSONSchema(action.schema, { io: "input" }),
    })),
  },
  {
    name: "call", usage: "call <tool> --json '{…}'", summary: "Run one action by name.", group: "Agents",
    run: async ctx => {
      const name = ctx.arg(0, "call <tool> --json '{…}'");
      const input = ctx.flags.input !== undefined ? JSON.parse(readFileSync(ctx.flags.input === "-" ? 0 : ctx.flags.input, "utf8"))
        : ctx.flags.json !== undefined ? JSON.parse(ctx.flags.json) : {};
      const action = (await ctx.actions("user", ctx.flags.live === true)).find(candidate => candidate.name === name);
      if (!action) throw new Error(`Unknown tool ${JSON.stringify(name)}. Run \`tonos tools\`.`);
      return action.run(input);
    },
  },
  {
    name: "schema", usage: "schema [cycle|sleep|workout|journal]", summary: "JSON Schema of the record kinds.", group: "Agents",
    run: async ctx => {
      const kind = ctx.args[0];
      if (kind !== undefined && !(kind in recordSchemas)) throw new Error("Choose cycle, sleep, workout or journal.");
      const all = recordJsonSchemas();
      return kind === undefined ? all : { [kind]: all[kind] };
    },
  },
  {
    name: "auth login", usage: "auth login [--port 8765]", summary: "Sign in to your own WHOOP app; tokens go to the Keychain.", group: "Live WHOOP API",
    run: async ctx => {
      const port = Number(ctx.flags.port ?? "8765");
      process.stderr.write(`Opening WHOOP sign-in. Redirect URI must be http://127.0.0.1:${port}/callback\n`);
      return { logged_in: true, ...(await login({ credentials: ctx.credentials(), vault: ctx.vault(), port })), tokens: "macOS Keychain (service tonos.whoop-oauth)" };
    },
  },
  {
    name: "auth status", usage: "auth status", summary: "Whether credentials and a login exist.", group: "Live WHOOP API",
    run: async ctx => {
      const tokens = await ctx.vault().load();
      return {
        logged_in: tokens !== null,
        access_token_expires_at: tokens === null ? null : new Date(tokens.expires_at).toISOString(),
      };
    },
  },
  {
    name: "auth logout", usage: "auth logout", summary: "Revoke access at WHOOP and forget the tokens.", group: "Live WHOOP API",
    run: async ctx => ({ ...(await new WhoopClient(ctx.credentials(), ctx.vault()).logout()), cleared: true }),
  },
  ...(["cycles", "sleeps", "workouts"] as const).map(kind =>
    query(`live ${kind}`, `live ${kind} --from … --to …`, `Fetch ${kind} from WHOOP; nothing is stored.`, `live_get_${kind}`,
      ctx => ctx.range(), { group: "Live WHOOP API", live: true })),
];

/** Finds the command for the leading words: two-word commands (`export phr`) before one-word ones. */
export function resolveCommand(words: string[]): { command: Command; args: string[] } | null {
  const two = COMMANDS.find(command => command.name === `${words[0]} ${words[1]}`);
  if (two) return { command: two, args: words.slice(2) };
  const one = COMMANDS.find(command => command.name === words[0]);
  return one ? { command: one, args: words.slice(1) } : null;
}

/** Help text generated from the registry, so it cannot drift from the commands. */
export function helpText(): string {
  const groups = ["Data", "FHIR", "Agents", "Live WHOOP API"] as const;
  return [
    "tonos — your own WHOOP data as a local record for you and your agents.", "",
    ...groups.flatMap(group => {
      const members = COMMANDS.filter(command => command.group === group);
      const width = Math.max(...members.map(command => command.usage.length)) + 2;
      return [group, ...members.map(command => `  tonos ${command.usage.padEnd(width)}${command.summary}`), ""];
    }),
    "Global: --data <dir> (default: TONOS_HOME or ~/.tonos). Results are JSON on stdout; errors are JSON on stderr.", "",
  ].join("\n");
}
