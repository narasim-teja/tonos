import { describe, expect, test } from "bun:test";
import type { FhirResource, Observation } from "fhir/r4";
import { ACTIVITY_CODES, CODES, PHR_IG, SYSTEMS } from "../src/fhir/codes";
import { buildPhr, cycleObservations, toBundle, toNdjson } from "../src/fhir/phr";
import { parseExport } from "../src/whoop/export";
import { mergePhr, parsePhr } from "../src/fhir/merge";
import { EXAMPLE_DIR } from "./helpers";

const parsed = parseExport(EXAMPLE_DIR);
const input = { cycles: parsed.cycles, sleeps: parsed.sleeps, workouts: parsed.workouts, sources: parsed.report.files };
const resources = buildPhr(input, new Date("2026-03-10T12:00:00Z"));
const observations = resources.filter((resource): resource is Observation => resource.resourceType === "Observation");
const byPrefix = (prefix: string) => observations.filter(resource => resource.id!.startsWith(prefix));
const codesOf = (resource: Observation) => resource.code.coding!.map(c => `${c.system}|${c.code}`);

/** Workout activity codes in the PHR IG (HealthKit names), as transcribed in Health Bridge's PGHDCodeMap. */
const IG_WORKOUT_CODES = new Set([
  "americanFootball", "archery", "australianFootball", "badminton", "barre", "baseball", "basketball", "bowling", "boxing",
  "cardioDance", "climbing", "cooldown", "coreTraining", "cricket", "crossCountrySkiing", "crossTraining", "curling", "cycling",
  "dance", "danceInspiredTraining", "discSports", "downhillSkiing", "elliptical", "equestrianSports", "fencing", "fishing",
  "fitnessGaming", "flexibility", "functionalStrengthTraining", "golf", "gymnastics", "handball", "handCycling",
  "highIntensityIntervalTraining", "hiking", "hockey", "hunting", "jumpRope", "kickboxing", "lacrosse", "martialArts",
  "mindAndBody", "mixedCardio", "mixedMetabolicCardioTraining", "other", "paddleSports", "pickleball", "pilates", "play",
  "preparationAndRecovery", "racquetball", "rowing", "rugby", "running", "sailing", "skatingSports", "snowboarding", "snowSports",
  "soccer", "socialDance", "softball", "squash", "stairClimbing", "stairs", "stepTraining", "surfingSports", "swimBikeRun",
  "swimming", "tableTennis", "taiChi", "tennis", "trackAndField", "traditionalStrengthTraining", "transition", "underwaterDiving",
  "volleyball", "walking", "waterFitness", "waterPolo", "waterSports", "wheelchairRunPace", "wheelchairWalkPace", "wrestling", "yoga",
]);

describe("PHR export", () => {
  test("starts with Patient, cover Composition, Provenance and the WHOOP Device, like Health Bridge", () => {
    expect(resources.slice(0, 4).map(resource => resource.resourceType)).toEqual(["Patient", "Composition", "Provenance", "Device"]);
    expect(resources[0]!.id).toBe("me");
    expect(resources[1]!.id).toBe("cover");
  });

  test("every resource id is unique and the same records always produce the same resources", () => {
    const keys = resources.map(resource => `${resource.resourceType}/${resource.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const again = buildPhr(input, new Date("2027-01-01T00:00:00Z")).filter(resource => resource.resourceType === "Observation");
    expect(again).toEqual(observations);
  });

  test("resting heart rate carries 8867-4 (required by FHIR's heart-rate profile), then 40443-4, then the PGHD code", () => {
    const [rhr] = byPrefix("rhr-");
    expect(codesOf(rhr!)).toEqual([`${SYSTEMS.loinc}|8867-4`, `${SYSTEMS.loinc}|40443-4`, `${SYSTEMS.pghd}|restingHeartRate`]);
    expect(rhr!.valueQuantity).toMatchObject({ unit: "beats/min", code: "/min", system: SYSTEMS.ucum });
  });

  test("HRV is RMSSD, never SDNN, and claims no PGHD profile it cannot meet", () => {
    const [hrv] = byPrefix("hrv-");
    expect(codesOf(hrv!)).toEqual([`${SYSTEMS.local}|heartRateVariabilityRMSSD`]);
    expect(hrv!.meta).toBeUndefined();
    const all = JSON.stringify(resources);
    expect(all).not.toContain("80404-7");
    expect(all).not.toContain("heartRateVariabilitySDNN");
  });

  test("skin temperature uses the IG's sleeping wrist temperature, not a coded LOINC finding or body temperature", () => {
    const [skin] = byPrefix("skintemp-");
    expect(codesOf(skin!)).toEqual([`${SYSTEMS.pghd}|appleSleepingWristTemperature`]);
    expect(skin!.valueQuantity).toMatchObject({ code: "Cel" });
    const all = JSON.stringify(resources);
    expect(all).not.toContain("39106-0");
    expect(all).not.toContain("8310-5");
  });

  test("respiratory rate uses the unit the profile fixes, and scores use UCUM 1, not an annotation", () => {
    const [resp] = byPrefix("resp-");
    expect(resp!.valueQuantity).toMatchObject({ unit: "/min", code: "/min" });
    expect(JSON.stringify(resources)).not.toContain("{score}");
  });

  test("workout energy is the IG's total energy, not active energy", () => {
    const [energy] = byPrefix("workout-energy-");
    expect(codesOf(energy!)).toEqual([`${SYSTEMS.loinc}|41981-2`, `${SYSTEMS.pghd}|totalEnergyBurned`]);
  });

  test("recovery vitals are timed to the main sleep they were measured in", () => {
    const open = parsed.cycles.find(cycle => cycle.end === null)!;
    const [rhr] = byPrefix(`rhr-${open.id.slice(6)}`);
    expect(rhr!.effectivePeriod).toEqual({ start: "2026-03-09T00:41:12-04:00", end: "2026-03-09T08:12:40-04:00" });
  });

  test("WHOOP's proprietary scores carry no PGHD profile and are tagged vendor-derived", () => {
    for (const prefix of ["recovery-", "strain-", "sleepscore-"]) {
      const [score] = byPrefix(prefix);
      expect(score!.meta?.profile).toBeUndefined();
      expect(score!.meta?.tag?.[0]?.code).toBe("vendor-derived");
      expect(score!.method?.text).toBe("WHOOP proprietary algorithm");
    }
  });

  test("an open cycle's Strain is preliminary and its period has no end", () => {
    const open = { ...parsed.cycles.find(cycle => cycle.end === null)!, strain: 8.4, score_state: "SCORED" as const };
    const strain = cycleObservations(open, undefined).find(resource => resource.id!.startsWith("strain-"))!;
    expect(strain.status).toBe("preliminary");
    expect(strain.effectivePeriod).toEqual({ start: open.start });
  });

  test("blank values produce no observation rather than a zero", () => {
    const unscored = parsed.cycles.find(cycle => cycle.recovery === null)!;
    expect(observations.filter(resource => resource.id!.includes(unscored.id.slice(6)))).toEqual([]);
  });

  test("a sleep is one pghd-sleep-episode; WHOOP light sleep maps to the IG's core sleep", () => {
    const [episode] = byPrefix("sleep-");
    expect(episode!.meta?.profile).toEqual([PHR_IG.profile("pghd-sleep-episode")]);
    const core = episode!.component!.find(c => c.code.coding![0]!.code === "coreSleepDuration")!;
    // The profile allows exactly one coding per component.
    expect(core.code.coding!.map(c => c.code)).toEqual(["coreSleepDuration"]);
    expect(episode!.component!.some(c => c.code.coding![0]!.code === "wakeAfterSleepOnset")).toBe(false);
  });

  test("workouts use IG activity codes; unknown activities are 'other' with WHOOP's name as text", () => {
    const tennis = byPrefix("workout-").find(resource => resource.code.text === "Tennis")!;
    expect(tennis.code.coding![0]).toMatchObject({ system: SYSTEMS.pghd, code: "tennis" });
    const sauna = byPrefix("workout-").find(resource => resource.code.text === "Sauna")!;
    expect(sauna.code.coding![0]!.code).toBe("other");
  });

  test("every observation id is <measurement>-<record hash>, and the workout and its energy link both ways", () => {
    const tennis = byPrefix("workout-").find(resource => resource.code.text === "Tennis")!;
    const recordHash = tennis.id!.slice("workout-".length);
    const energyId = `workout-energy-${recordHash}`;
    expect(tennis.hasMember).toEqual([{ reference: `Observation/${energyId}` }]);
    expect(observations.find(resource => resource.id === energyId)?.derivedFrom).toEqual([{ reference: `Observation/${tennis.id}` }]);
    expect(observations.every(resource => /^[a-z0-9]+(-[a-z]+)*-[a-f0-9]{32}$/.test(resource.id!))).toBe(true);
  });

  test("every activity mapping points at a real IG workout code", () => {
    for (const code of Object.values(ACTIVITY_CODES)) expect(IG_WORKOUT_CODES.has(code)).toBe(true);
  });

  test("every coding in the export comes from the verified code table", () => {
    const table = new Set(Object.values(CODES).map(entry => `${entry.system}|${entry.code}`));
    const allowedElsewhere = new Set<string>([SYSTEMS.observationCategory, SYSTEMS.provenanceParticipant, SYSTEMS.dataOperation]);
    const codings: Array<{ system?: string; code?: string }> = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        if (typeof object.system === "string" && typeof object.code === "string" && object.system !== SYSTEMS.ucum) codings.push(object);
        Object.values(object).forEach(walk);
      }
    };
    walk(resources);
    for (const c of codings) {
      if (allowedElsewhere.has(c.system!)) continue;
      if (c.system === SYSTEMS.pghd && IG_WORKOUT_CODES.has(c.code!)) continue;
      expect(table.has(`${c.system}|${c.code}`)).toBe(true);
    }
  });

  test("NDJSON round-trips, and the Bundle carries every resource", () => {
    expect(parsePhr(toNdjson(resources), "x.phr")).toEqual(resources);
    expect(toBundle(resources).entry).toHaveLength(resources.length);
  });

  test("inside the Bundle, every internal reference points at an entry's fullUrl", () => {
    const bundle = toBundle(resources);
    const fullUrls = new Set(bundle.entry!.map(entry => entry.fullUrl));
    const references: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === "object") {
        for (const [field, inner] of Object.entries(value)) {
          if (field === "reference" && typeof inner === "string") references.push(inner); else walk(inner);
        }
      }
    };
    walk(bundle.entry!.map(entry => entry.resource));
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter(reference => !fullUrls.has(reference))).toEqual([]);
    // The .phr form keeps Health Bridge's relative references.
    expect(JSON.stringify(resources)).toContain('"reference":"Patient/me"');
  });
});

describe("PHR merge", () => {
  const bridgeLike: FhirResource[] = [
    { resourceType: "Patient", id: "me", birthDate: "1990-01-01", meta: { lastUpdated: "2026-03-10T00:00:00Z" } },
    { resourceType: "Composition", id: "cover", status: "final", type: { text: "Medical records" }, date: "2026-03-10", author: [{ display: "Health Bridge" }], title: "Apple Health", section: [{ title: "About this record" }] },
    { resourceType: "Provenance", id: "export-bridge", target: [{ reference: "Patient/me" }], recorded: "2026-03-10T00:00:00Z", agent: [{ who: { display: "Health Bridge" } }] },
    { resourceType: "Observation", id: "apple-hr-1", status: "final", code: { coding: [{ system: SYSTEMS.loinc, code: "8867-4" }] }, subject: { reference: "Patient/me" } },
  ];

  test("one Patient, one new cover page naming both sources, every observation kept", () => {
    const { resources: merged, report } = mergePhr([{ name: "apple.phr", resources: bridgeLike }, { name: "whoop.phr", resources }]);
    expect(merged.filter(resource => resource.resourceType === "Patient")).toHaveLength(1);
    expect(merged[0]).toMatchObject({ resourceType: "Patient", birthDate: "1990-01-01" });
    const covers = merged.filter(resource => resource.resourceType === "Composition");
    expect(covers).toHaveLength(1);
    expect(JSON.stringify(covers[0])).toContain("apple.phr");
    expect(JSON.stringify(covers[0])).toContain("whoop.phr");
    expect(merged.filter(resource => resource.resourceType === "Provenance")).toHaveLength(2);
    expect(merged.filter(resource => resource.resourceType === "Observation")).toHaveLength(observations.length + 1);
    expect(report.replaced).toEqual([{ key: "Composition/cover", reason: "2 cover pages combined into one" }]);
  });

  test("merging the same export twice drops exact duplicates", () => {
    const { report } = mergePhr([{ name: "a", resources }, { name: "b", resources: buildPhr(input, new Date("2026-04-01T00:00:00Z")) }]);
    expect(report.duplicates_dropped).toBeGreaterThan(observations.length - 1);
  });

  test("the same id with different content is refused, never overwritten", () => {
    const changed = bridgeLike.map(resource => resource.id === "apple-hr-1" ? { ...resource, status: "amended" } as FhirResource : resource);
    expect(() => mergePhr([{ name: "a", resources: bridgeLike }, { name: "b", resources: changed }])).toThrow("already exists with different content");
  });

  test("two different people are refused", () => {
    const other = bridgeLike.map(resource => resource.resourceType === "Patient" ? { ...resource, birthDate: "1985-05-05" } : resource);
    expect(() => mergePhr([{ name: "a", resources: bridgeLike }, { name: "b", resources: other }])).toThrow("Patient.birthDate differs");
  });
});
