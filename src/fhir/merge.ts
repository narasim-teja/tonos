import { createHash } from "node:crypto";
import type { Composition, FhirResource, Patient } from "fhir/r4";
import { ASSEMBLER } from "./phr";
import { CODES, SYSTEMS } from "./codes";

/** Parses a `.phr` file: one FHIR resource per line. */
export function parsePhr(text: string, name: string): FhirResource[] {
  return text.split("\n").map(line => line.trim()).filter(Boolean).map((line, index) => {
    const resource = JSON.parse(line) as FhirResource;
    if (typeof resource.resourceType !== "string" || typeof resource.id !== "string") {
      throw new Error(`${name}: line ${index + 1} is not a FHIR resource with an id.`);
    }
    return resource;
  });
}

/** Content identity, ignoring `meta.lastUpdated`, which differs between exports of the same data. */
function fingerprint(resource: FhirResource): string {
  const { meta, ...rest } = resource as FhirResource & { meta?: Record<string, unknown> };
  const { lastUpdated: _ignored, ...metaRest } = meta ?? {};
  return createHash("sha256").update(JSON.stringify({ ...rest, meta: metaRest })).digest("hex");
}

export type MergeReport = {
  inputs: Array<{ name: string; resources: number }>;
  resources: number;
  duplicates_dropped: number;
  replaced: Array<{ key: string; reason: string }>;
};

/**
 * Merges PHR files (for example a Health Bridge export and a tonos export) into one record.
 *
 * Both writers use `Patient/me` and `Composition/cover`, so concatenating the files would
 * produce two different resources with the same id. This merge keeps one Patient (fields
 * combined, conflicting values fail), writes one new cover Composition naming every source,
 * keeps every Provenance, Device and Observation, and drops exact duplicates. Any other id
 * that appears twice with different content is an error, never a silent overwrite.
 */
export function mergePhr(inputs: Array<{ name: string; resources: FhirResource[] }>, now = new Date()): { resources: FhirResource[]; report: MergeReport } {
  const report: MergeReport = { inputs: inputs.map(input => ({ name: input.name, resources: input.resources.length })), resources: 0, duplicates_dropped: 0, replaced: [] };
  const byKey = new Map<string, FhirResource>();
  const covers: Composition[] = [];
  let patient: Patient | null = null;

  for (const input of inputs) {
    for (const resource of input.resources) {
      const key = `${resource.resourceType}/${resource.id}`;
      if (resource.resourceType === "Composition" && resource.id === "cover") { covers.push(resource); continue; }
      if (resource.resourceType === "Patient") {
        patient = mergePatient(patient, resource);
        continue;
      }
      const existing = byKey.get(key);
      if (existing === undefined) { byKey.set(key, resource); continue; }
      if (fingerprint(existing) === fingerprint(resource)) { report.duplicates_dropped += 1; continue; }
      throw new Error(`${input.name}: ${key} already exists with different content. Refusing to overwrite.`);
    }
  }
  if (patient === null) throw new Error("No Patient resource in the inputs.");
  if (covers.length > 0) report.replaced.push({ key: "Composition/cover", reason: `${covers.length} cover pages combined into one` });

  const timestamp = now.toISOString();
  const sections = covers.flatMap(cover => (cover.section ?? []).map(section => ({
    ...section, title: `${cover.title ?? "Source"}: ${section.title ?? ""}`.trim(),
  })));
  const cover: Composition = {
    resourceType: "Composition",
    id: "cover",
    meta: { lastUpdated: timestamp },
    status: "final",
    type: { coding: [{ system: SYSTEMS.loinc, code: CODES.medicalRecords.code, display: CODES.medicalRecords.display }] },
    subject: { reference: "Patient/me" },
    date: timestamp,
    author: [{ reference: "Patient/me" }, { display: `${ASSEMBLER.name} ${ASSEMBLER.version} (merge)` }],
    title: "Personal health record (merged)",
    section: [
      { title: "Sources", text: {
        status: "generated",
        div: `<div xmlns="http://www.w3.org/1999/xhtml">${inputs.map(input => `<p>${escape(input.name)}: ${input.resources.length} resources</p>`).join("")}</div>`,
      } },
      ...sections,
    ],
  };
  const resources: FhirResource[] = [{ ...patient, meta: { ...patient.meta, lastUpdated: timestamp } }, cover, ...byKey.values()];
  report.resources = resources.length;
  return { resources, report };
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One person, two writers: keep every field either side knows; a real conflict is an error. */
function mergePatient(current: Patient | null, next: Patient): Patient {
  if (current === null) return next;
  const merged: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(next)) {
    if (field === "meta") continue;
    const existing = merged[field];
    if (existing === undefined) { merged[field] = value; continue; }
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new Error(`Patient.${field} differs between inputs. Merge refused; the files may describe different people.`);
    }
  }
  return merged as unknown as Patient;
}
