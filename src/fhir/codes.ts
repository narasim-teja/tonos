/**
 * Every code the FHIR export emits, with how it was checked. docs/FHIR.md's code table is
 * generated from this file (`bun run docs`); a test fails if the export uses a code that is
 * not listed here, or if the docs drift.
 *
 * Verification:
 *  - `loinc`: looked up on the HL7 terminology server (tx.fhir.org, CodeSystem/$lookup), 2026-11-16,
 *    and accepted by the HL7 FHIR Validator.
 *  - `phr-ig`: present in the PHR IG code systems and value sets of the continuous build below.
 *  - `local`: defined by this project because no standard code exists (docs/fhir/CodeSystem-wearable-metrics.json).
 */

export const PROJECT_URL = "https://github.com/narasim-teja/tonos";

export const SYSTEMS = {
  loinc: "http://loinc.org",
  ucum: "http://unitsofmeasure.org",
  pghd: "http://hl7.org/fhir/uv/phr/CodeSystem/observation-pghd-codes",
  sleepEpisode: "http://hl7.org/fhir/uv/phr/CodeSystem/sleep-episode-codes",
  observationCategory: "http://terminology.hl7.org/CodeSystem/observation-category",
  provenanceParticipant: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
  dataOperation: "http://terminology.hl7.org/CodeSystem/v3-DataOperation",
  /** Project-local codes: RMSSD (no standard code exists) and WHOOP's proprietary scores. */
  local: `${PROJECT_URL}/fhir/CodeSystem/wearable-metrics`,
} as const;

/**
 * The PHR IG as actually used. The PGHD profiles and code systems exist only in the IG's
 * continuous build; the published 1.0.0-ballot2 package (April 2025) does not contain them,
 * although the build still carries that version label.
 */
export const PHR_IG = {
  canonical: "http://hl7.org/fhir/uv/phr",
  version: "1.0.0-ballot2",
  build: "2026-09-17",
  buildPackage: "https://build.fhir.org/ig/HL7/personal-health-record-format-ig/package.tgz",
  profile: (name: string) => `http://hl7.org/fhir/uv/phr/StructureDefinition/${name}`,
} as const;

export type Verification = "loinc" | "phr-ig" | "local";

export type CodeEntry = {
  system: string; code: string; display: string; verification: Verification; note?: string;
};

const loinc = (code: string, display: string, note?: string): CodeEntry =>
  ({ system: SYSTEMS.loinc, code, display, verification: "loinc", note });
const pghd = (code: string, display: string): CodeEntry =>
  ({ system: SYSTEMS.pghd, code, display, verification: "phr-ig" });
const episode = (code: string, display: string, note?: string): CodeEntry =>
  ({ system: SYSTEMS.sleepEpisode, code, display, verification: "phr-ig", note });
const local = (code: string, display: string, note: string): CodeEntry =>
  ({ system: SYSTEMS.local, code, display, verification: "local", note });

/** The code table. Keys are what the exporter refers to. */
export const CODES = {
  heartRate: loinc("8867-4", "Heart rate"),
  restingHeartRate: loinc("40443-4", "Heart rate --resting"),
  oxygenSaturation: loinc("2708-6", "Oxygen saturation in Arterial blood"),
  oxygenSaturationPulseOx: loinc("59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry"),
  respiratoryRate: loinc("9279-1", "Respiratory rate"),
  caloriesBurned: loinc("41981-2", "Calories burned", "WHOOP energy is total expenditure, not active energy only."),
  medicalRecords: loinc("11503-0", "Medical records"),

  pghdHeartRate: pghd("heartRate", "Heart rate"),
  pghdRestingHeartRate: pghd("restingHeartRate", "Resting heart rate"),
  pghdSleepingWristTemperature: {
    ...pghd("appleSleepingWristTemperature", "Apple sleeping wrist temperature"),
    note: "The IG names it after Apple; its definition is device-neutral: 'wrist temperature during sleep'. LOINC has no numeric skin-temperature code (39106-0 is a coded exam finding).",
  },
  pghdTotalEnergyBurned: pghd("totalEnergyBurned", "Total energy burned"),
  pghdOxygenSaturation: pghd("oxygenSaturation", "Oxygen saturation"),
  pghdRespiratoryRate: pghd("respiratoryRate", "Respiratory rate"),
  pghdSleepEpisode: pghd("sleepEpisode", "Sleep episode"),
  pghdOther: pghd("other", "Other"),

  totalSleepTime: episode("totalSleepTime", "Total sleep time"),
  coreSleepDuration: episode("coreSleepDuration", "Core sleep duration", "WHOOP 'light' sleep. The IG's 'core' (from HealthKit) is light NREM sleep."),
  deepSleepDuration: episode("deepSleepDuration", "Deep sleep duration"),
  remSleepDuration: episode("remSleepDuration", "REM sleep duration"),
  coreSleepPercentage: episode("coreSleepPercentage", "Core sleep percentage"),
  deepSleepPercentage: episode("deepSleepPercentage", "Deep sleep percentage"),
  remSleepPercentage: episode("remSleepPercentage", "REM sleep percentage"),
  sleepEfficiencyPercentage: episode("sleepEfficiencyPercentage", "Sleep efficiency percentage"),
  isMainSleep: episode("isMainSleep", "Is main sleep"),

  hrvRmssd: local("heartRateVariabilityRMSSD", "Heart rate variability RMSSD",
    "No LOINC or PHR IG code exists for RMSSD. LOINC 80404-7 and PGHD heartRateVariabilitySDNN are SDNN, a different statistic."),
  recoveryScore: local("whoopRecoveryScore", "WHOOP Recovery", "WHOOP-proprietary score, 0-100 %. Not a clinical measurement."),
  dayStrain: local("whoopDayStrain", "WHOOP Day Strain", "WHOOP-proprietary score, 0-21."),
  activityStrain: local("whoopActivityStrain", "WHOOP Activity Strain", "WHOOP-proprietary score, 0-21."),
  sleepPerformance: local("whoopSleepPerformance", "WHOOP Sleep Performance", "WHOOP-proprietary score, 0-100 %."),
  sleepConsistency: local("whoopSleepConsistency", "WHOOP Sleep Consistency", "WHOOP-proprietary score, 0-100 %."),
  sleepNeed: local("whoopSleepNeed", "WHOOP Sleep Need", "WHOOP's estimate of sleep needed."),
  sleepDebt: local("whoopSleepDebt", "WHOOP Sleep Debt", "WHOOP's estimate of accumulated sleep debt."),
  awakeDuration: local("awakeDuration", "Awake duration in bed",
    "Total awake time in bed, including before first sleep. Not the IG's wakeAfterSleepOnset."),
  workoutDuration: local("workoutDuration", "Workout duration", "Bridge carries this as text only; coded here."),
  averageHeartRate: local("averageHeartRate", "Average heart rate over the period", "Qualifies LOINC 8867-4 as a mean."),
  maxHeartRate: local("maxHeartRate", "Maximum heart rate over the period", "Qualifies LOINC 8867-4 as a maximum."),
  hrZone1: local("heartRateZone1Percentage", "Heart rate zone 1 percentage", "WHOOP zone, % of workout time."),
  hrZone2: local("heartRateZone2Percentage", "Heart rate zone 2 percentage", "WHOOP zone, % of workout time."),
  hrZone3: local("heartRateZone3Percentage", "Heart rate zone 3 percentage", "WHOOP zone, % of workout time."),
  hrZone4: local("heartRateZone4Percentage", "Heart rate zone 4 percentage", "WHOOP zone, % of workout time."),
  hrZone5: local("heartRateZone5Percentage", "Heart rate zone 5 percentage", "WHOOP zone, % of workout time."),
  vendorDerived: local("vendor-derived", "Vendor-derived score",
    "meta.tag on observations whose value comes from a proprietary algorithm."),
} as const satisfies Record<string, CodeEntry>;

export type CodeKey = keyof typeof CODES;

/** FHIR Coding for a table entry. */
export function coding(key: CodeKey): { system: string; code: string; display: string } {
  const entry = CODES[key];
  return { system: entry.system, code: entry.code, display: entry.display };
}

/**
 * WHOOP activity name → PHR IG workout activity code (HealthKit's names). Unknown
 * activities export as `other` with WHOOP's name in `code.text`, never a guess.
 */
export const ACTIVITY_CODES: Record<string, string> = {
  "Running": "running", "Cycling": "cycling", "Spin": "cycling", "Mountain Biking": "cycling",
  "Walking": "walking", "Hiking/Rucking": "hiking", "Hiking": "hiking", "Swimming": "swimming",
  "Tennis": "tennis", "Pickleball": "pickleball", "Squash": "squash", "Badminton": "badminton", "Table Tennis": "tableTennis",
  "Volleyball": "volleyball", "Basketball": "basketball", "Soccer": "soccer", "Cricket": "cricket", "Lacrosse": "lacrosse",
  "Baseball": "baseball", "Softball": "softball", "Rugby": "rugby", "Golf": "golf", "Ice Hockey": "hockey", "Field Hockey": "hockey",
  "Weightlifting": "traditionalStrengthTraining", "Powerlifting": "traditionalStrengthTraining",
  "Strength Trainer": "traditionalStrengthTraining", "Functional Fitness": "functionalStrengthTraining",
  "HIIT": "highIntensityIntervalTraining", "Yoga": "yoga", "Hot Yoga": "yoga", "Pilates": "pilates",
  "Rowing": "rowing", "Elliptical": "elliptical", "Stairmaster": "stairClimbing", "Boxing": "boxing",
  "Kickboxing": "kickboxing", "Martial Arts": "martialArts", "Dance": "dance", "Climbing": "climbing",
  "Rock Climbing": "climbing", "Skiing": "downhillSkiing", "Snowboarding": "snowboarding", "Jumping Rope": "jumpRope",
  "Meditation": "mindAndBody", "Stretching": "flexibility",
};
