import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Action } from "../core/actions";
import type { AuditEvent, AuditLog } from "./audit";
import type { Pairings } from "./pairing";
import { createMcpServer } from "./server";

export const DEFAULT_PORT = 4272;

export type HttpOptions = { actions: Action[]; pairings: Pairings; audit: AuditLog; port: number };

type RpcMessage = { id?: string | number | null; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
type RpcReply = { id?: string | number | null; error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } };

function messages(body: unknown): RpcMessage[] {
  const list = Array.isArray(body) ? body : [body];
  return list.filter((message): message is RpcMessage => message !== null && typeof message === "object");
}

/** What the server answered: the HTTP status, and the JSON-RPC body when there is one. */
type Exchange = { status: number; body: unknown };

/**
 * The audit trail for one authenticated MCP exchange, built from the JSON-RPC request and
 * the response it produced. This is the only place requests are audited. An HTTP error
 * status marks every message in the request as failed, even when the transport's error
 * body carries no id to match a message by (a malformed body, a wrong Accept header).
 */
function auditEvents(pairing: string, request: unknown, response: Exchange, httpMethod: string, durationMs: number): AuditEvent[] {
  const replies = new Map(messages(response.body).map(reply => [(reply as RpcReply).id, reply as RpcReply]));
  const httpError = response.status >= 400 ? `HTTP ${response.status}` : undefined;
  const sent = messages(request);
  if (sent.length === 0) {
    return [{ at: new Date().toISOString(), outcome: httpError ? "error" : "ok", pairing, method: `HTTP ${httpMethod}`,
      ...(httpError ? { detail: httpError } : {}), duration_ms: durationMs }];
  }
  return sent.map(message => {
    const reply = message.id === undefined ? undefined : replies.get(message.id);
    const failed = httpError !== undefined || reply?.error !== undefined || reply?.result?.isError === true;
    const detail = reply?.error?.message ?? (reply?.result?.isError ? reply.result.content?.[0]?.text : undefined) ?? httpError;
    const isToolCall = message.method === "tools/call";
    return {
      at: new Date().toISOString(),
      outcome: failed ? "error" : "ok",
      pairing,
      method: typeof message.method === "string" ? message.method : "unknown",
      ...(isToolCall ? { tool: String(message.params?.name), arguments: message.params?.arguments ?? {} } : {}),
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
      duration_ms: durationMs,
    };
  });
}

/**
 * The loopback MCP server as a Hono app. Layers, outermost first:
 *  1. Host allow-list (127.0.0.1 / localhost on our port): defeats DNS rebinding.
 *  2. Origin must be absent or loopback: a web page in the user's browser cannot call it.
 *  3. 1 MB body limit.
 *  4. Per-agent bearer token; the pairing name goes into every audit event.
 *  5. Read-only actions only (see core/actions.ts).
 * Every request, allowed or denied, is written to the audit log, here and nowhere else.
 */
export function createApp(options: HttpOptions): Hono {
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`]);
  const app = new Hono();
  const deny = (method: string, status: 401 | 403, detail: string) => {
    options.audit.append({ at: new Date().toISOString(), outcome: "denied", pairing: null, method, detail });
    return new Response(JSON.stringify({ error: detail }), {
      status,
      headers: { "Content-Type": "application/json", ...(status === 401 ? { "WWW-Authenticate": 'Bearer realm="tonos"' } : {}) },
    });
  };

  app.use("*", async (c, next) => {
    if (!allowedHosts.has(c.req.header("host") ?? "")) return deny(c.req.method, 403, "Host not allowed.");
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) return deny(c.req.method, 403, "Origin not allowed.");
    await next();
  });

  app.get("/health", c => c.json({ ok: true, name: "tonos" }));

  app.all("/mcp", bodyLimit({ maxSize: 1024 * 1024 }), async c => {
    const header = c.req.header("authorization") ?? "";
    const pairing = options.pairings.authenticate(header.startsWith("Bearer ") ? header.slice(7).trim() : null);
    if (pairing === null) return deny(c.req.method, 401, "Missing or unknown bearer token. Pair with `tonos pair <name>`.");

    const started = performance.now();
    const request: unknown = c.req.method === "POST" ? await c.req.raw.clone().json().catch(() => null) : null;

    // Stateless Streamable HTTP: a fresh server and transport per request, JSON responses, no sessions to hijack.
    const server = createMcpServer(options.actions);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(c.req.raw);
      const body: unknown = response.headers.get("content-type")?.includes("application/json")
        ? await response.clone().json().catch(() => null) : null;
      const exchange = { status: response.status, body };
      for (const event of auditEvents(pairing.name, request, exchange, c.req.method, Math.round(performance.now() - started))) {
        options.audit.append(event);
      }
      return response;
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.notFound(c => c.json({ error: "Not found. The MCP endpoint is /mcp." }, 404));
  return app;
}

/** Serves the app on 127.0.0.1 only. Never on 0.0.0.0. */
export function serveHttp(options: HttpOptions) {
  return Bun.serve({ hostname: "127.0.0.1", port: options.port, fetch: createApp(options).fetch });
}
