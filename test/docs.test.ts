import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activityTableMarkdown, codeTableMarkdown, replaceSection } from "../src/fhir/code-table";
import { localCodeSystem } from "../src/fhir/codesystem";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("docs/FHIR.md's code and activity tables match src/fhir/codes.ts (run `bun run docs` to regenerate)", () => {
  const doc = read("docs/FHIR.md");
  const regenerated = replaceSection(replaceSection(doc, "code-table", codeTableMarkdown()), "activity-table", activityTableMarkdown());
  expect(doc).toBe(regenerated);
});

test("the published local CodeSystem matches src/fhir/codes.ts (run `bun run docs` to regenerate)", () => {
  expect(JSON.parse(read("docs/fhir/CodeSystem-wearable-metrics.json"))).toEqual(localCodeSystem());
});

test("the guides MCP serves as resources exist", () => {
  for (const file of ["docs/SKILL.md", "docs/SCHEMA.md", "docs/FHIR.md"]) expect(read(file).length).toBeGreaterThan(500);
});
