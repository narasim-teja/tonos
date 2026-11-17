import type { CodeableConcept, Observation, ObservationComponent, Quantity } from "fhir/r4";
import type { Cycle, Sleep, Workout } from "../core/schema";
import { ACTIVITY_CODES, CODES, PHR_IG, SYSTEMS, coding, type CodeKey } from "./codes";

/**
 * Every Observation the PHR export can emit, as data. Profile, codes, category, unit and
 * value accessor for each measurement live here, next to the IG constraint that forces
 * them, so the builder has no per-measurement decisions of its own. Checked against the
 * HL7 FHIR Validator and the PHR IG continuous build (see scripts/validate-fhir.ts).
 */

/** Units as UCUM code plus display. Where a profile fixes the display, the comment says so. */
export const UNITS = {
  beatsPerMinute: { unit: "beats/min", code: "/min" },
  /** pghd-respiratoryrate fixes Quantity.unit to "/min". */
  perMinute: { unit: "/min", code: "/min" },
  milliseconds: { unit: "ms", code: "ms" },
  percent: { unit: "%", code: "%" },
  celsius: { unit: "°C", code: "Cel" },
  minutes: { unit: "min", code: "min" },
  kilocalories: { unit: "kcal", code: "kcal" },
  /** Unitless scores. UCUM annotations like {score} are ignored in unit comparison, so the validator advises "1". */
  score: { unit: "score", code: "1" },
} as const satisfies Record<string, { unit: string; code: string }>;

export type UnitKey = keyof typeof UNITS;

/**
 * What an Observation claims to be:
 *  - a PGHD profile, when the value can conform to one;
 *  - `vendor`: a WHOOP-proprietary score, no profile, tagged vendor-derived;
 *  - `unprofiled`: a real measurement no PGHD profile can carry (HRV as RMSSD: the profile
 *    requires a PGHD code and the IG has none for RMSSD).
 */
export type Shape = { profile: string } | "vendor" | "unprofiled";

export type Category = "vital-signs" | "activity" | "social-history";

const CATEGORY_DISPLAY: Record<Category, string> = { "vital-signs": "Vital Signs", activity: "Activity", "social-history": "Social History" };

/** A component: a coded value inside an Observation. */
export type ComponentSpec<R> = {
  codes: CodeKey[]; text?: string;
  value: (record: R) => number | boolean | null;
  /** Omitted for boolean components. */
  unit?: UnitKey;
};

/** One kind of Observation. */
export type MeasurementSpec<R> = {
  /** Id prefix; the record's hash follows, so ids are stable. */
  key: string;
  shape: Shape;
  code: CodeKey[] | ((record: R) => CodeableConcept);
  text?: string;
  category?: Category;
  /** The Observation's own value. Measurements with only components omit it. */
  value?: { unit: UnitKey; of: (record: R) => number | null };
  components?: Array<ComponentSpec<R>>;
};

const VENDOR_METHOD = { text: "WHOOP proprietary algorithm" };
const VENDOR_TAG = { system: SYSTEMS.local, code: CODES.vendorDerived.code, display: CODES.vendorDerived.display };

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function quantity(value: number, unit: UnitKey): Quantity {
  return { value: round(value), unit: UNITS[unit].unit, system: SYSTEMS.ucum, code: UNITS[unit].code };
}

function concept(keys: CodeKey[], text?: string): CodeableConcept {
  return { coding: keys.map(coding), ...(text === undefined ? {} : { text }) };
}

function components<R>(specs: Array<ComponentSpec<R>>, record: R): ObservationComponent[] {
  return specs.flatMap((spec): ObservationComponent[] => {
    const value = spec.value(record);
    if (value === null) return [];
    const code = concept(spec.codes, spec.text);
    if (typeof value === "boolean") return [{ code, valueBoolean: value }];
    if (spec.unit === undefined) throw new Error(`Component ${spec.codes.join("+")} has a number but no unit.`);
    return [{ code, valueQuantity: quantity(value, spec.unit) }];
  });
}

/** Where the Observation sits: its id, time, status, and links. Decided by the record, not the spec. */
export type Placement = Pick<Observation, "effectiveDateTime" | "effectivePeriod" | "derivedFrom" | "hasMember"> & {
  id: string; status: Observation["status"];
};

export const PATIENT_REF = { reference: "Patient/me" };

/**
 * Builds one Observation from its spec, or null when the record has no value for it.
 * Blank stays absent: no Observation is written for a value WHOOP did not score.
 */
export function buildObservation<R>(spec: MeasurementSpec<R>, record: R, placement: Placement, device: { reference: string; display: string }): Observation | null {
  const value = spec.value?.of(record);
  if (spec.value && (value === null || value === undefined)) return null;
  const parts = components(spec.components ?? [], record);
  if (!spec.value && parts.length === 0) return null;
  const { id, status, ...timing } = placement;
  return {
    resourceType: "Observation",
    id,
    ...(spec.shape === "vendor" ? { meta: { tag: [VENDOR_TAG] } }
      : spec.shape === "unprofiled" ? {} : { meta: { profile: [PHR_IG.profile(spec.shape.profile)] } }),
    status,
    ...(spec.category ? { category: [{ coding: [{ system: SYSTEMS.observationCategory, code: spec.category, display: CATEGORY_DISPLAY[spec.category] }] }] } : {}),
    code: typeof spec.code === "function" ? spec.code(record) : concept(spec.code, spec.text),
    subject: PATIENT_REF,
    performer: [PATIENT_REF],
    ...timing,
    device,
    ...(spec.value && typeof value === "number" ? { valueQuantity: quantity(value, spec.value.unit) } : {}),
    ...(spec.shape === "vendor" ? { method: VENDOR_METHOD } : {}),
    ...(parts.length > 0 ? { component: parts } : {}),
  };
}

// ── Cycles ──────────────────────────────────────────────────────────────────────────────

/** Measured during the cycle's main sleep. */
export const RECOVERY: Array<MeasurementSpec<Cycle>> = [
  {
    // FHIR's core heart-rate profile requires the generic 8867-4 alongside the specific 40443-4.
    key: "rhr", shape: { profile: "pghd-vitalsigns" }, category: "vital-signs",
    code: ["heartRate", "restingHeartRate", "pghdRestingHeartRate"],
    value: { unit: "beatsPerMinute", of: cycle => cycle.recovery?.resting_heart_rate ?? null },
  },
  {
    key: "hrv", shape: "unprofiled", category: "vital-signs",
    code: ["hrvRmssd"], text: "Heart rate variability (RMSSD)",
    value: { unit: "milliseconds", of: cycle => cycle.recovery?.hrv_rmssd_ms ?? null },
  },
  {
    key: "spo2", shape: { profile: "pghd-oxygenSaturation" }, category: "vital-signs",
    code: ["oxygenSaturation", "oxygenSaturationPulseOx", "pghdOxygenSaturation"],
    value: { unit: "percent", of: cycle => cycle.recovery?.spo2_percent ?? null },
  },
  {
    // LOINC has no numeric skin-temperature code; the IG's device-neutral wrist-temperature code fits exactly.
    key: "skintemp", shape: { profile: "pghd-vitalsigns" }, category: "vital-signs",
    code: ["pghdSleepingWristTemperature"], text: "Wrist temperature during sleep",
    value: { unit: "celsius", of: cycle => cycle.recovery?.skin_temp_celsius ?? null },
  },
  {
    key: "recovery", shape: "vendor", code: ["recoveryScore"],
    value: { unit: "percent", of: cycle => cycle.recovery?.recovery_score ?? null },
  },
];

/** Spans the whole cycle. Preliminary while the cycle is open (see phr.ts). */
export const DAY_STRAIN: MeasurementSpec<Cycle> = {
  key: "strain", shape: "vendor", code: ["dayStrain"],
  value: { unit: "score", of: cycle => cycle.strain },
  components: [
    { codes: ["heartRate", "averageHeartRate"], text: "Average heart rate", unit: "beatsPerMinute", value: cycle => cycle.average_heart_rate },
    { codes: ["heartRate", "maxHeartRate"], text: "Maximum heart rate", unit: "beatsPerMinute", value: cycle => cycle.max_heart_rate },
    { codes: ["caloriesBurned", "pghdTotalEnergyBurned"], unit: "kilocalories", value: cycle => cycle.energy_kcal },
  ],
};

// ── Sleeps ──────────────────────────────────────────────────────────────────────────────

const share = (part: number | null, whole: number | null) => part === null || whole === null || whole <= 0 ? null : part / whole * 100;

/** pghd-sleep-episode fixes each component to exactly one coding from sleep-episode-codes, so LOINC cannot ride along. */
export const SLEEP_EPISODE: MeasurementSpec<Sleep> = {
  key: "sleep", shape: { profile: "pghd-sleep-episode" }, category: "social-history", code: ["pghdSleepEpisode"],
  components: [
    { codes: ["totalSleepTime"], unit: "minutes", value: sleep => sleep.asleep_min },
    { codes: ["coreSleepDuration"], unit: "minutes", value: sleep => sleep.light_min },
    { codes: ["deepSleepDuration"], unit: "minutes", value: sleep => sleep.deep_min },
    { codes: ["remSleepDuration"], unit: "minutes", value: sleep => sleep.rem_min },
    { codes: ["coreSleepPercentage"], unit: "percent", value: sleep => share(sleep.light_min, sleep.asleep_min) },
    { codes: ["deepSleepPercentage"], unit: "percent", value: sleep => share(sleep.deep_min, sleep.asleep_min) },
    { codes: ["remSleepPercentage"], unit: "percent", value: sleep => share(sleep.rem_min, sleep.asleep_min) },
    { codes: ["sleepEfficiencyPercentage"], unit: "percent", value: sleep => sleep.efficiency_percent },
    { codes: ["isMainSleep"], value: sleep => !sleep.nap },
  ],
};

export const RESPIRATORY_RATE: MeasurementSpec<Sleep> = {
  key: "resp", shape: { profile: "pghd-respiratoryrate" }, category: "vital-signs",
  code: ["respiratoryRate", "pghdRespiratoryRate"],
  value: { unit: "perMinute", of: sleep => sleep.respiratory_rate },
};

export const SLEEP_SCORE: MeasurementSpec<Sleep> = {
  key: "sleepscore", shape: "vendor", code: ["sleepPerformance"],
  value: { unit: "percent", of: sleep => sleep.performance_percent },
  components: [
    { codes: ["sleepConsistency"], unit: "percent", value: sleep => sleep.consistency_percent },
    { codes: ["sleepNeed"], unit: "minutes", value: sleep => sleep.need_min },
    { codes: ["sleepDebt"], unit: "minutes", value: sleep => sleep.debt_min },
    { codes: ["awakeDuration"], unit: "minutes", value: sleep => sleep.awake_min },
  ],
};

// ── Workouts ────────────────────────────────────────────────────────────────────────────

/** Unknown activities export as `other` with WHOOP's name as text, never a guess. */
function activityCode(workout: Workout): CodeableConcept {
  const code = ACTIVITY_CODES[workout.activity];
  return code === undefined
    ? { coding: [coding("pghdOther")], text: workout.activity }
    : { coding: [{ system: SYSTEMS.pghd, code, display: workout.activity }], text: workout.activity };
}

const zone = (n: 1 | 2 | 3 | 4 | 5): ComponentSpec<Workout> => ({
  codes: [`hrZone${n}` as CodeKey], unit: "percent", value: workout => workout.heart_rate_zones_percent?.[`zone_${n}`] ?? null,
});

export const WORKOUT: MeasurementSpec<Workout> = {
  key: "workout", shape: { profile: "pghd-workout" }, category: "activity", code: activityCode,
  components: [
    { codes: ["workoutDuration"], text: "Duration", unit: "minutes", value: workout => workout.duration_min },
    { codes: ["heartRate", "averageHeartRate"], text: "Average heart rate", unit: "beatsPerMinute", value: workout => workout.average_heart_rate },
    { codes: ["heartRate", "maxHeartRate"], text: "Maximum heart rate", unit: "beatsPerMinute", value: workout => workout.max_heart_rate },
    { codes: ["activityStrain"], unit: "score", value: workout => workout.strain },
    zone(1), zone(2), zone(3), zone(4), zone(5),
  ],
};

/** WHOOP energy includes resting expenditure: the IG's totalEnergyBurned, not activeEnergyBurned. */
export const WORKOUT_ENERGY: MeasurementSpec<Workout> = {
  key: "workout-energy", shape: { profile: "pghd-activity" }, category: "activity",
  code: ["caloriesBurned", "pghdTotalEnergyBurned"],
  value: { unit: "kilocalories", of: workout => workout.energy_kcal },
};
