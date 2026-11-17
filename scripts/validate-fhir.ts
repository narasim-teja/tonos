#!/usr/bin/env bun
/**
 * Validates the PHR export of the fictional example with the official HL7 FHIR Validator.
 *
 *   bun scripts/validate-fhir.ts
 *
 * Needs Java 17+ (`JAVA` env, `java` on PATH, or Homebrew's keg-only openjdk).
 * Validates against the PHR IG's continuous build: the published 1.0.0-ballot2 package
 * (April 2025) does not contain the PGHD profiles at all. Errors the IG itself causes are
 * listed in scripts/known-ig-issues.json with the reason; any other error fails the run.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PHR_IG } from "../src/fhir/codes";
import { buildPhr, toBundle } from "../src/fhir/phr";
import { parseExport } from "../src/whoop/export";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "out");
mkdirSync(out, { recursive: true });

const VALIDATOR = "https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar";

async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  process.stderr.write(`Downloading ${url}\n`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await Bun.write(file, response);
}

function java(): string {
  const candidates = [process.env.JAVA, "/opt/homebrew/opt/openjdk/bin/java", "/usr/local/opt/openjdk/bin/java", "java"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Bun.spawnSync([candidate, "-version"]).exitCode === 0) return candidate;
  }
  throw new Error("No working Java found. Install Java 17+ (brew install openjdk) or set JAVA.");
}

// 1. Export the fictional example as a Bundle. Never a real export.
const parsed = parseExport(join(root, "examples/export.zip"));
const resources = buildPhr({ cycles: parsed.cycles, sleeps: parsed.sleeps, workouts: parsed.workouts, sources: parsed.report.files });
writeFileSync(join(out, "example-bundle.json"), JSON.stringify(toBundle(resources), null, 2));

// 2. Fetch the validator and the IG build, then validate.
await download(VALIDATOR, join(out, "validator_cli.jar"));
await download(PHR_IG.buildPackage, join(out, "phr-ci-build.tgz"));
const run = Bun.spawnSync([
  java(), "-jar", join(out, "validator_cli.jar"), join(out, "example-bundle.json"),
  "-version", "4.0.1", "-ig", join(out, "phr-ci-build.tgz"),
  "-ig", join(root, "docs/fhir/CodeSystem-wearable-metrics.json"),
  "-html-output", join(out, "validation.html"), "-output-style", "compact",
], { cwd: root });
const log = run.stdout.toString() + run.stderr.toString();
writeFileSync(join(out, "validation.log"), log);

// 3. Separate known IG defects from our own errors.
type KnownIssue = { pattern: string; reason: string };
const known: KnownIssue[] = await Bun.file(join(root, "scripts/known-ig-issues.json")).json();
const errors = log.split("\n").filter(line => / Error - /.test(line));
const unexpected = errors.filter(line => !known.some(issue => line.includes(issue.pattern)));
const warnings = log.split("\n").filter(line => / Warning - /.test(line));

console.log(`Validated ${join("out", "example-bundle.json")} against the PHR IG continuous build.`);
console.log(`Errors: ${errors.length} (${errors.length - unexpected.length} known IG issues, ${unexpected.length} unexpected). Warnings: ${warnings.length}.`);
for (const issue of known) {
  const count = errors.filter(line => line.includes(issue.pattern)).length;
  if (count > 0) console.log(`  known (${count}): ${issue.reason}`);
}
for (const line of unexpected) console.log(`  UNEXPECTED: ${line.trim()}`);
console.log(`Full report: out/validation.html, out/validation.log`);
process.exit(unexpected.length === 0 ? 0 : 1);
