#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { z } from "zod";
import { helpText, resolveCommand } from "./commands";
import { Context, type Flags } from "./context";

function output(value: unknown): void {
  process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" }, from: { type: "string" }, to: { type: "string" }, out: { type: "string" },
      format: { type: "string" }, port: { type: "string" }, json: { type: "string" }, input: { type: "string" },
      activity: { type: "string" }, count: { type: "string" }, "no-naps": { type: "boolean" },
      "allow-journal": { type: "boolean" }, live: { type: "boolean" }, yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const { help, ...flags } = values;
  const resolved = resolveCommand(positionals);
  if (positionals.length === 0 || help) { process.stdout.write(helpText()); return; }
  if (resolved === null) throw new Error(`Unknown command ${JSON.stringify(positionals.join(" "))}. Run tonos --help.`);

  const ctx = new Context(flags as Flags, resolved.args);
  try {
    output(await resolved.command.run(ctx));
  } finally {
    ctx.close();
  }
}

main().catch(error => {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
