import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync } from "node:fs";
import { createActions } from "../src/core/actions";
import { AuditLog } from "../src/mcp/audit";
import { serveHttp } from "../src/mcp/http";
import { Pairings } from "../src/mcp/pairing";
import { EXAMPLE_DIR, exampleStore, tempDir } from "./helpers";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

describe("loopback MCP server", () => {
  const port = 41_000 + Math.floor(Math.random() * 2_000);
  const base = `http://127.0.0.1:${port}`;
  let env: ReturnType<typeof exampleStore>;
  let server: ReturnType<typeof serveHttp>;
  let pairings: Pairings;
  let audit: AuditLog;
  let token: string;

  beforeAll(() => {
    env = exampleStore();
    pairings = new Pairings(env.dir);
    audit = new AuditLog(env.dir);
    token = pairings.pair("Test Agent").token;
    const actions = createActions(env.store, { allowJournal: false, live: null });
    server = serveHttp({ actions, pairings, audit, port });
  });
  afterAll(() => { server.stop(true); env.cleanup(); });

  const connect = async (bearer: string) => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }));
    return client;
  };

  test("a paired agent lists only read-only tools; the journal stays hidden unless enabled", async () => {
    const client = await connect(token);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      ["get_cycles", "get_daily_summary", "get_record", "get_sleeps", "get_workouts", "status"]);
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false)).toBe(true);
    await client.close();
    expect(audit.tail(10).some(entry => entry.method === "tools/list" && entry.pairing === "Test Agent")).toBe(true);
  });

  test("a tool call returns structured data and is audited under the agent's name", async () => {
    const client = await connect(token);
    const result = await client.callTool({ name: "get_daily_summary", arguments: { from: "2026-03-06", to: "2026-03-08" } });
    const summary = result.structuredContent as { days: Array<{ date: string; recorded: boolean; day_strain: number | null }> };
    expect(summary.days.map(day => day.date)).toEqual(["2026-03-06", "2026-03-07", "2026-03-08"]);
    expect(summary.days.find(day => day.date === "2026-03-08")?.day_strain).toBe(14.2);
    await client.close();
    const event = audit.tail(5).find(entry => entry.tool === "get_daily_summary");
    expect(event).toMatchObject({ outcome: "ok", pairing: "Test Agent", arguments: { from: "2026-03-06", to: "2026-03-08" } });
    expect(JSON.stringify(event)).not.toContain("14.2"); // results are never logged
  });

  test("the guides in docs/ are served as MCP resources", async () => {
    const client = await connect(token);
    const { resources } = await client.listResources();
    expect(resources.map(resource => resource.uri).sort()).toEqual(
      ["tonos://fhir-guide", "tonos://guide", "tonos://schema-guide", "tonos://schemas"]);
    const guide = await client.readResource({ uri: "tonos://guide" });
    expect((guide.contents[0] as { text: string }).text).toContain("# Using tonos");
    await client.close();
  });

  test("invalid arguments come back as a tool error, not a crash", async () => {
    const client = await connect(token);
    const result = await client.callTool({ name: "get_cycles", arguments: { from: "2026-03-09", to: "2026-03-01" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  const rpc = (headers: Record<string, string>) => fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  test("no token, an unknown token, or a revoked token gets 401 and is audited as denied", async () => {
    expect((await rpc({})).status).toBe(401);
    expect((await rpc({ Authorization: "Bearer tns_not-a-real-token" })).status).toBe(401);
    const { token: other } = pairings.pair("Short-lived");
    pairings.revoke("Short-lived");
    expect((await rpc({ Authorization: `Bearer ${other}` })).status).toBe(401);
    expect(audit.tail(3).every(entry => entry.outcome === "denied")).toBe(true);
  });

  test("a foreign Host (DNS rebinding) or a web page Origin is refused before auth", async () => {
    expect((await rpc({ Authorization: `Bearer ${token}`, Host: "evil.example:80" })).status).toBe(403);
    expect((await rpc({ Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
  });

  test("a request the transport rejects is audited as an error, not ok, even with no id to match", async () => {
    // Wrong Accept header: the transport answers 406 with a JSON-RPC error that has no id.
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const [event] = audit.tail(1);
    expect(event).toMatchObject({ outcome: "error", pairing: "Test Agent", method: "tools/list" });
  });

  test("tokens are stored only as hashes", async () => {
    const stored = await Bun.file(`${env.dir}/pairings.json`).text();
    expect(stored).not.toContain(token);
  });
});

describe("one core, three interfaces", () => {
  test("the CLI and MCP over stdio return the same summary", async () => {
    const env = exampleStore();
    try {
      env.store.close();
      const cli = Bun.spawnSync(["bun", CLI, "summary", "--from", "2026-03-05", "--to", "2026-03-09", "--data", env.dir], { cwd: ROOT });
      expect(cli.exitCode).toBe(0);
      const client = new Client({ name: "parity", version: "0" });
      await client.connect(new StdioClientTransport({ command: "bun", args: [CLI, "mcp", "--data", env.dir], cwd: ROOT }));
      const viaMcp = await client.callTool({ name: "get_daily_summary", arguments: { from: "2026-03-05", to: "2026-03-09" } });
      await client.close();
      expect(viaMcp.structuredContent).toEqual(JSON.parse(cli.stdout.toString()));
    } finally { env.cleanup(); }
  });

  test("CLI errors are JSON on stderr with a non-zero exit, and a bad import creates nothing", () => {
    const { dir, cleanup } = tempDir();
    try {
      const data = `${dir}/never-created`;
      const run = Bun.spawnSync(["bun", CLI, "import", `${EXAMPLE_DIR}/missing`, "--data", data], { cwd: ROOT });
      expect(run.exitCode).toBe(1);
      expect(JSON.parse(run.stderr.toString()).error).toContain("No such file or directory");
      expect(existsSync(data)).toBe(false);
    } finally { cleanup(); }
  });
});
