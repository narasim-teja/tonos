import { ACTIVITY_CODES, CODES, SYSTEMS } from "./codes";

const SYSTEM_NAMES: Record<string, string> = {
  [SYSTEMS.loinc]: "LOINC",
  [SYSTEMS.pghd]: "PGHD",
  [SYSTEMS.sleepEpisode]: "sleep-episode",
  [SYSTEMS.local]: "local",
};

const cell = (text: string) => text.replace(/\|/g, "\\|");

/** The docs/FHIR.md code table, generated from src/fhir/codes.ts so the two cannot drift. */
export function codeTableMarkdown(): string {
  const rows = Object.values(CODES).map(entry =>
    `| ${entry.code} | ${SYSTEM_NAMES[entry.system] ?? entry.system} | ${cell(entry.display)} | ${entry.verification} | ${cell(entry.note ?? "")} |`);
  return ["| Code | System | Display | Checked | Note |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/** The WHOOP activity → PHR IG workout code table, generated from ACTIVITY_CODES. */
export function activityTableMarkdown(): string {
  const rows = Object.entries(ACTIVITY_CODES).map(([whoop, code]) => `| ${whoop} | ${code} |`);
  return ["| WHOOP activity | PGHD workout code |", "| --- | --- |", ...rows, "| anything else | other, with WHOOP's name as text |"].join("\n");
}

/** Replaces the text between `<!-- name:start -->` and `<!-- name:end -->` markers. */
export function replaceSection(document: string, name: string, content: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = document.indexOf(start);
  const to = document.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`Markers for "${name}" not found in the document.`);
  return `${document.slice(0, from + start.length)}\n${content}\n${document.slice(to)}`;
}
