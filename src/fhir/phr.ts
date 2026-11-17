import { createHash } from "node:crypto";
import type { Bundle, Composition, Device, FhirResource, Observation, Patient, Provenance } from "fhir/r4";
import type { Cycle, Sleep, Workout } from "../core/schema";
import { PHR_IG, SYSTEMS, coding } from "./codes";
import {
  DAY_STRAIN, PATIENT_REF, RECOVERY, RESPIRATORY_RATE, SLEEP_EPISODE, SLEEP_SCORE, WORKOUT, WORKOUT_ENERGY,
  buildObservation, type MeasurementSpec, type Placement,
} from "./measurements";

/** Name and version written into Provenance and the cover Composition. */
export const ASSEMBLER = { name: "tonos", version: "0.1.0" } as const;

function hash(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

const DEVICE_ID = `device-${hash(["device", "WHOOP"])}`;
const DEVICE_REF = { reference: `Device/${DEVICE_ID}`, display: "WHOOP" };

/** The hash part of a record id (`cycle-<hash>` → `<hash>`), shared by every Observation derived from it. */
const recordHash = (record: { id: string }) => record.id.slice(record.id.indexOf("-") + 1);

/** Observation id: the measurement's key plus the source record's hash. Stable across exports. */
const observationId = <R>(spec: MeasurementSpec<R>, record: { id: string }) => `${spec.key}-${recordHash(record)}`;

type Timing = Pick<Placement, "effectiveDateTime" | "effectivePeriod">;
const span = (start: string, end: string | null): Timing => ({ effectivePeriod: end === null ? { start } : { start, end } });

function emit<R extends { id: string }>(spec: MeasurementSpec<R>, record: R, timing: Timing, extra: Partial<Placement> = {}): Observation | null {
  return buildObservation(spec, record, { id: observationId(spec, record), status: "final", ...timing, ...extra }, DEVICE_REF);
}

/** Recovery vitals and score (timed to the main sleep they were measured in), and Day Strain. */
export function cycleObservations(cycle: Cycle, mainSleep: Sleep | undefined): Observation[] {
  const recoveryTiming = mainSleep ? span(mainSleep.start, mainSleep.end) : { effectiveDateTime: cycle.start };
  return [
    ...RECOVERY.map(spec => emit(spec, cycle, recoveryTiming)),
    // A cycle without an end is today's: WHOOP keeps adding Strain until the next sleep.
    emit(DAY_STRAIN, cycle, span(cycle.start, cycle.end), { status: cycle.end === null ? "preliminary" : "final" }),
  ].filter((observation): observation is Observation => observation !== null);
}

/** The sleep episode, respiratory rate, and WHOOP's sleep scores (derived from the episode). */
export function sleepObservations(sleep: Sleep): Observation[] {
  const timing = span(sleep.start, sleep.end);
  const episode = emit(SLEEP_EPISODE, sleep, timing);
  const derived = episode === null ? {} : { derivedFrom: [{ reference: `Observation/${episode.id}` }] };
  return [episode, emit(RESPIRATORY_RATE, sleep, timing), emit(SLEEP_SCORE, sleep, timing, derived)]
    .filter((observation): observation is Observation => observation !== null);
}

/** The workout and its energy as a member observation, as the IG's walking example does. */
export function workoutObservations(workout: Workout): Observation[] {
  const timing = span(workout.start, workout.end);
  const energy = emit(WORKOUT_ENERGY, workout, timing, { derivedFrom: [{ reference: `Observation/${observationId(WORKOUT, workout)}` }] });
  const main = emit(WORKOUT, workout, timing, energy === null ? {} : { hasMember: [{ reference: `Observation/${energy.id}` }] });
  return [main, energy].filter((observation): observation is Observation => observation !== null);
}

export type PhrInput = {
  cycles: Cycle[]; sleeps: Sleep[]; workouts: Workout[];
  /** Files the records came from (name + SHA-256), recorded in Provenance. */
  sources: Array<{ name: string; sha256: string }>;
};

function narrative(paragraphs: string[]) {
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { status: "generated" as const, div: `<div xmlns="http://www.w3.org/1999/xhtml">${paragraphs.map(text => `<p>${escape(text)}</p>`).join("")}</div>` };
}

/**
 * Builds a PHR export: Patient, cover Composition, Provenance, the WHOOP Device, then
 * Observations, in the same order and with the same conventions as Health Bridge, so the
 * two `.phr` files can be read together. Ids are deterministic: the same records always
 * produce the same Observations.
 */
export function buildPhr(input: PhrInput, now = new Date()): FhirResource[] {
  const mainSleepByCycle = new Map(input.sleeps.filter(sleep => !sleep.nap && sleep.cycle_id !== null).map(sleep => [sleep.cycle_id!, sleep]));
  const observations = [
    ...input.cycles.flatMap(cycle => cycleObservations(cycle, mainSleepByCycle.get(cycle.id))),
    ...input.sleeps.flatMap(sleepObservations),
    ...input.workouts.flatMap(workoutObservations),
  ];
  const records = [...input.cycles, ...input.sleeps, ...input.workouts];
  const first = records.map(record => record.start).sort()[0];
  const last = records.map(record => record.end ?? record.start).sort().at(-1);
  const timestamp = now.toISOString();
  const assembler = `${ASSEMBLER.name} ${ASSEMBLER.version}`;
  const count = (key: string) => observations.filter(observation => observation.id!.startsWith(`${key}-`)).length;

  const patient: Patient = { resourceType: "Patient", id: "me", meta: { lastUpdated: timestamp } };
  const composition: Composition = {
    resourceType: "Composition",
    id: "cover",
    meta: { lastUpdated: timestamp },
    status: "final",
    type: { coding: [coding("medicalRecords")] },
    subject: PATIENT_REF,
    date: timestamp,
    author: [PATIENT_REF, { display: assembler }],
    title: "WHOOP data — personal health record",
    section: [
      {
        title: "About this record",
        text: narrative([
          `Personal health record exported by ${assembler} on ${timestamp.slice(0, 10)}.`,
          "Source: the member's own WHOOP data export. Data by WHOOP. Not affiliated with or endorsed by WHOOP.",
          `Covers ${first?.slice(0, 10) ?? "nothing"} to ${last?.slice(0, 10) ?? "nothing"}. ${observations.length + 4} resources in total.`,
          `Format: HL7 FHIR R4 Personal Health Record (.phr, newline-delimited JSON), Patient Generated Health Data profiles from the PHR IG build ${PHR_IG.build} (labelled ${PHR_IG.version}).`,
          "WHOOP Recovery, Strain and Sleep Performance are proprietary scores, tagged vendor-derived. They are not clinical measurements.",
        ]),
      },
      {
        title: "Patient-generated health data",
        code: { coding: [{ system: SYSTEMS.observationCategory, code: "vital-signs", display: "Vital Signs" },
          { system: SYSTEMS.observationCategory, code: "activity", display: "Activity" }] },
        text: narrative([
          `Cycles: ${input.cycles.length}`, `Sleep episodes: ${count(SLEEP_EPISODE.key)}`, `Workouts: ${count(WORKOUT.key)}`,
          ...RECOVERY.map(spec => `${spec.text ?? spec.key}: ${count(spec.key)}`),
          `Respiratory rate: ${count(RESPIRATORY_RATE.key)}`,
        ]),
      },
    ],
  };
  const provenance: Provenance = {
    resourceType: "Provenance",
    id: `export-${hash(["export", timestamp])}`,
    target: [{ reference: "Composition/cover" }, PATIENT_REF],
    ...(first && last ? { occurredPeriod: { start: first, end: last } } : {}),
    recorded: timestamp,
    activity: { coding: [{ system: SYSTEMS.dataOperation, code: "CREATE", display: "create" }] },
    agent: [
      { type: { coding: [{ system: SYSTEMS.provenanceParticipant, code: "author", display: "Author" }] }, who: PATIENT_REF },
      { type: { coding: [{ system: SYSTEMS.provenanceParticipant, code: "assembler", display: "Assembler" }] }, who: { display: assembler } },
    ],
    entity: [{ role: "source", what: { display: `WHOOP member data export (CSV). Files: ${input.sources.map(file => `${file.name} sha256:${file.sha256}`).join(", ") || "none"}` } }],
  };
  const device: Device = {
    resourceType: "Device",
    id: DEVICE_ID,
    meta: { profile: [PHR_IG.profile("pghd-device")] },
    manufacturer: "WHOOP, Inc.",
    deviceName: [{ name: "WHOOP", type: "user-friendly-name" }],
    patient: PATIENT_REF,
  };
  return [patient, composition, provenance, device, ...observations];
}

/** `.phr`: one resource per line, with Health Bridge's relative references. */
export function toNdjson(resources: FhirResource[]): string {
  return resources.map(resource => JSON.stringify(resource)).join("\n") + "\n";
}

function uuidFrom(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The same resources as a FHIR `collection` Bundle. Inside a Bundle, a relative reference
 * like "Patient/me" does not resolve to a urn:uuid entry, so each reference to a resource
 * in the Bundle is rewritten to that entry's fullUrl.
 */
export function toBundle(resources: FhirResource[], now = new Date()): Bundle {
  const fullUrls = new Map(resources.map(resource => {
    const key = `${resource.resourceType}/${resource.id}`;
    return [key, `urn:uuid:${uuidFrom(key)}`] as const;
  }));
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([field, inner]) =>
      [field, field === "reference" && typeof inner === "string" ? fullUrls.get(inner) ?? inner : rewrite(inner)]));
  };
  return {
    resourceType: "Bundle",
    type: "collection",
    timestamp: now.toISOString(),
    entry: resources.map(resource => ({
      fullUrl: fullUrls.get(`${resource.resourceType}/${resource.id}`)!,
      resource: rewrite(resource) as FhirResource,
    })),
  };
}
