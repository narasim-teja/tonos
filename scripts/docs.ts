#!/usr/bin/env bun
/**
 * Regenerates the documentation that is derived from code:
 *  - the code and activity tables in docs/FHIR.md, from src/fhir/codes.ts;
 *  - docs/fhir/CodeSystem-wearable-metrics.json, from the local codes.
 *
 *   bun run docs
 *
 * test/docs.test.ts fails when these are out of date.
 */
import { activityTableMarkdown, codeTableMarkdown, replaceSection } from "../src/fhir/code-table";
import { localCodeSystem } from "../src/fhir/codesystem";

const root = new URL("..", import.meta.url).pathname;
const fhirDoc = `${root}docs/FHIR.md`;

let text = await Bun.file(fhirDoc).text();
text = replaceSection(text, "code-table", codeTableMarkdown());
text = replaceSection(text, "activity-table", activityTableMarkdown());
await Bun.write(fhirDoc, text);
await Bun.write(`${root}docs/fhir/CodeSystem-wearable-metrics.json`, `${JSON.stringify(localCodeSystem(), null, 2)}\n`);
console.log("Updated docs/FHIR.md tables and docs/fhir/CodeSystem-wearable-metrics.json.");
