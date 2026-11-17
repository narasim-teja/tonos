# FHIR mapping

`tonos export phr` writes an HL7 FHIR R4 Personal Health Record following the HL7 PHR IG
and its Patient Generated Health Data (PGHD) profiles. The layout matches Flexpa Health
Bridge's `.phr` export so the two can be read together. Every choice below was checked with
the HL7 FHIR Validator (`bun run validate:fhir`).

## Which IG

The PGHD profiles and code systems exist only in the IG's **continuous build**
(build.fhir.org, 2026-09-17). The published `hl7.fhir.uv.phr` 1.0.0-ballot2 package
(April 2025) contains none of them: 16 resources, no `pghd-*` profiles, no
`observation-pghd-codes`. The build still carries the 1.0.0-ballot2 label, so a tool that
says "1.0.0-ballot2" cannot be validated against any published package. tonos validates
against the build package and says so in the cover page.

## File layout

One resource per line (`.phr`, `application/x-ndjson`), or `--format bundle` for a
`collection` Bundle. In order:

1. `Patient/me`. tonos knows nothing about you beyond the data, so it has no name or birth date.
2. `Composition/cover`. Cover page (LOINC 11503-0): source, date range, counts, and the attribution.
3. `Provenance`. The patient is the author, tonos is the assembler, and the source names each CSV file with its SHA-256.
4. `Device`. One WHOOP device (`pghd-device`), referenced by every Observation.
5. Observations, as below.

Observation ids are `<measurement>-<record hash>`, where the record hash comes from the
record's kind and start time. Exporting the same records again gives identical
Observations. Only Patient, Composition and Provenance carry the export time. In the
`.phr` form references are relative (`Patient/me`), as in Health Bridge. In the Bundle
form each reference is rewritten to its entry's `urn:uuid` fullUrl, which is how
references resolve inside a Bundle.

## What each record becomes

Every row comes from one declarative table, `src/fhir/measurements.ts`: profile, codes,
category, unit and value for each measurement, in one place.

| WHOOP value | Observation | Shape | Code |
| --- | --- | --- | --- |
| Resting heart rate | `rhr-…` | `pghd-vitalsigns` | LOINC 8867-4 + 40443-4, PGHD `restingHeartRate` |
| HRV (RMSSD) | `hrv-…` | no profile (see below) | local `heartRateVariabilityRMSSD` |
| SpO2 | `spo2-…` | `pghd-oxygenSaturation` | LOINC 2708-6, 59408-5, PGHD `oxygenSaturation` |
| Skin temperature | `skintemp-…` | `pghd-vitalsigns` | PGHD `appleSleepingWristTemperature` |
| Recovery score | `recovery-…` | vendor-derived | local `whoopRecoveryScore` |
| Day Strain | `strain-…` | vendor-derived | local `whoopDayStrain`; components: average/max heart rate, total energy |
| Sleep | `sleep-…` | `pghd-sleep-episode` | PGHD `sleepEpisode`; IG sleep-episode components |
| Respiratory rate | `resp-…` | `pghd-respiratoryrate` | LOINC 9279-1, PGHD `respiratoryRate` |
| Sleep Performance | `sleepscore-…` | vendor-derived | local `whoopSleepPerformance`; components: consistency, need, debt, awake time |
| Workout | `workout-…` | `pghd-workout` | PGHD activity code (table below) |
| Workout energy | `workout-energy-…` | `pghd-activity` | LOINC 41981-2, PGHD `totalEnergyBurned`; member of the workout |

Recovery vitals use the main sleep's period as their effective time, because that is when
WHOOP measures them.

## Decisions, and what the validator showed

- **Resting heart rate needs 8867-4 as well as 40443-4.** FHIR's core heart-rate profile
  requires the generic heart-rate code whenever a heart-rate observation is a vital sign.
  40443-4 alone fails. Health Bridge exports resting heart rate with no LOINC code today;
  adding 40443-4 there would need 8867-4 too.
- **HRV is RMSSD, and nothing standard can carry it.** WHOOP, Oura and Garmin report RMSSD.
  LOINC has only SDNN (80404-7, 112429-6); so does the IG (`heartRateVariabilitySDNN`).
  `pghd-vitalsigns` requires a PGHD code, so an RMSSD value cannot conform to it. tonos
  exports HRV as a plain vital-sign Observation with a local code, rather than mislabel
  RMSSD as SDNN or claim a profile it cannot meet. The IG needs an RMSSD code.
- **Skin temperature uses the IG's wrist-temperature code.** LOINC 39106-0 "Temperature of
  Skin" is a coded exam finding (scale Nom: warm, cool), not a number, and LOINC has no
  numeric skin-temperature code. The IG's `appleSleepingWristTemperature` is defined as
  "wrist temperature during sleep" in °C, which is exactly what WHOOP measures, and it
  merges with Apple Watch data. The code is named after Apple; its definition is not.
- **Sleep components carry one code each.** `pghd-sleep-episode` fixes every component to
  exactly one coding from `sleep-episode-codes`, so LOINC sleep codes cannot ride along.
- **WHOOP "light" sleep is the IG's "core" sleep.** The IG takes its stage names from
  HealthKit, where core means light NREM.
- **WHOOP "awake" is not wake after sleep onset.** It includes time awake before first
  sleep, so it is a local `awakeDuration` on the Sleep Performance observation.
- **Energy is total, not active.** WHOOP's calories include resting expenditure: LOINC
  41981-2 with the IG's `totalEnergyBurned`.
- **Units follow the profiles.** `pghd-respiratoryrate` fixes the display unit to `/min`.
  Scores use UCUM `1`; annotations like `{score}` are ignored in unit comparison.
- **Proprietary scores stay separate.** Recovery, Strain and Sleep Performance are their own
  Observations with no PGHD profile, `method.text` "WHOOP proprietary algorithm", and a
  `vendor-derived` tag. They keep WHOOP's names, as WHOOP's brand guidelines require.
- **Status.** Everything from the export is `final`. A cycle with no end (today's) is
  `preliminary` with an open period, because its Strain keeps rising. The export leaves
  that Strain blank; the live API scores it.
- **Blank means absent.** No Observation is written for a value WHOOP did not score.
- **The journal is not exported.**

## Validation status

`bun run validate:fhir` exports the fictional example as a Bundle and runs the HL7 FHIR
Validator against the IG build and the local CodeSystem. Result on 2026-11-16:
**0 errors of our own.** The remaining errors are one IG defect, listed with its reason in
`scripts/known-ig-issues.json`:

- `pghd-vitalsigns` and `pghd-workout` slice `Observation.code.coding` by `system`, but
  their `PGHDCode` slice fixes no system (`pghd-activity`'s does). The validator reports
  "the discriminator [system] does not have fixed value, binding or existence assertions"
  for every instance of those profiles, including Health Bridge's. To be reported to HL7.

Remaining warnings are best-practice notes (`dom-6`: resources without narrative, which
Health Bridge also omits) and code systems the validator could not resolve offline.

## Code table

Generated from `src/fhir/codes.ts` by `bun run docs`; a test fails if it drifts.

- **loinc**: confirmed with `CodeSystem/$lookup` on tx.fhir.org and accepted by the validator.
- **phr-ig**: present in the PHR IG build's code systems and value sets.
- **local**: defined here because no standard code fits. Published as
  [docs/fhir/CodeSystem-wearable-metrics.json](fhir/CodeSystem-wearable-metrics.json).

<!-- code-table:start -->
| Code | System | Display | Checked | Note |
| --- | --- | --- | --- | --- |
| 8867-4 | LOINC | Heart rate | loinc |  |
| 40443-4 | LOINC | Heart rate --resting | loinc |  |
| 2708-6 | LOINC | Oxygen saturation in Arterial blood | loinc |  |
| 59408-5 | LOINC | Oxygen saturation in Arterial blood by Pulse oximetry | loinc |  |
| 9279-1 | LOINC | Respiratory rate | loinc |  |
| 41981-2 | LOINC | Calories burned | loinc | WHOOP energy is total expenditure, not active energy only. |
| 11503-0 | LOINC | Medical records | loinc |  |
| heartRate | PGHD | Heart rate | phr-ig |  |
| restingHeartRate | PGHD | Resting heart rate | phr-ig |  |
| appleSleepingWristTemperature | PGHD | Apple sleeping wrist temperature | phr-ig | The IG names it after Apple; its definition is device-neutral: 'wrist temperature during sleep'. LOINC has no numeric skin-temperature code (39106-0 is a coded exam finding). |
| totalEnergyBurned | PGHD | Total energy burned | phr-ig |  |
| oxygenSaturation | PGHD | Oxygen saturation | phr-ig |  |
| respiratoryRate | PGHD | Respiratory rate | phr-ig |  |
| sleepEpisode | PGHD | Sleep episode | phr-ig |  |
| other | PGHD | Other | phr-ig |  |
| totalSleepTime | sleep-episode | Total sleep time | phr-ig |  |
| coreSleepDuration | sleep-episode | Core sleep duration | phr-ig | WHOOP 'light' sleep. The IG's 'core' (from HealthKit) is light NREM sleep. |
| deepSleepDuration | sleep-episode | Deep sleep duration | phr-ig |  |
| remSleepDuration | sleep-episode | REM sleep duration | phr-ig |  |
| coreSleepPercentage | sleep-episode | Core sleep percentage | phr-ig |  |
| deepSleepPercentage | sleep-episode | Deep sleep percentage | phr-ig |  |
| remSleepPercentage | sleep-episode | REM sleep percentage | phr-ig |  |
| sleepEfficiencyPercentage | sleep-episode | Sleep efficiency percentage | phr-ig |  |
| isMainSleep | sleep-episode | Is main sleep | phr-ig |  |
| heartRateVariabilityRMSSD | local | Heart rate variability RMSSD | local | No LOINC or PHR IG code exists for RMSSD. LOINC 80404-7 and PGHD heartRateVariabilitySDNN are SDNN, a different statistic. |
| whoopRecoveryScore | local | WHOOP Recovery | local | WHOOP-proprietary score, 0-100 %. Not a clinical measurement. |
| whoopDayStrain | local | WHOOP Day Strain | local | WHOOP-proprietary score, 0-21. |
| whoopActivityStrain | local | WHOOP Activity Strain | local | WHOOP-proprietary score, 0-21. |
| whoopSleepPerformance | local | WHOOP Sleep Performance | local | WHOOP-proprietary score, 0-100 %. |
| whoopSleepConsistency | local | WHOOP Sleep Consistency | local | WHOOP-proprietary score, 0-100 %. |
| whoopSleepNeed | local | WHOOP Sleep Need | local | WHOOP's estimate of sleep needed. |
| whoopSleepDebt | local | WHOOP Sleep Debt | local | WHOOP's estimate of accumulated sleep debt. |
| awakeDuration | local | Awake duration in bed | local | Total awake time in bed, including before first sleep. Not the IG's wakeAfterSleepOnset. |
| workoutDuration | local | Workout duration | local | Bridge carries this as text only; coded here. |
| averageHeartRate | local | Average heart rate over the period | local | Qualifies LOINC 8867-4 as a mean. |
| maxHeartRate | local | Maximum heart rate over the period | local | Qualifies LOINC 8867-4 as a maximum. |
| heartRateZone1Percentage | local | Heart rate zone 1 percentage | local | WHOOP zone, % of workout time. |
| heartRateZone2Percentage | local | Heart rate zone 2 percentage | local | WHOOP zone, % of workout time. |
| heartRateZone3Percentage | local | Heart rate zone 3 percentage | local | WHOOP zone, % of workout time. |
| heartRateZone4Percentage | local | Heart rate zone 4 percentage | local | WHOOP zone, % of workout time. |
| heartRateZone5Percentage | local | Heart rate zone 5 percentage | local | WHOOP zone, % of workout time. |
| vendor-derived | local | Vendor-derived score | local | meta.tag on observations whose value comes from a proprietary algorithm. |
<!-- code-table:end -->

## Activity codes

WHOOP's activity names mapped to the IG's workout codes. Generated from `ACTIVITY_CODES`.

<!-- activity-table:start -->
| WHOOP activity | PGHD workout code |
| --- | --- |
| Running | running |
| Cycling | cycling |
| Spin | cycling |
| Mountain Biking | cycling |
| Walking | walking |
| Hiking/Rucking | hiking |
| Hiking | hiking |
| Swimming | swimming |
| Tennis | tennis |
| Pickleball | pickleball |
| Squash | squash |
| Badminton | badminton |
| Table Tennis | tableTennis |
| Volleyball | volleyball |
| Basketball | basketball |
| Soccer | soccer |
| Cricket | cricket |
| Lacrosse | lacrosse |
| Baseball | baseball |
| Softball | softball |
| Rugby | rugby |
| Golf | golf |
| Ice Hockey | hockey |
| Field Hockey | hockey |
| Weightlifting | traditionalStrengthTraining |
| Powerlifting | traditionalStrengthTraining |
| Strength Trainer | traditionalStrengthTraining |
| Functional Fitness | functionalStrengthTraining |
| HIIT | highIntensityIntervalTraining |
| Yoga | yoga |
| Hot Yoga | yoga |
| Pilates | pilates |
| Rowing | rowing |
| Elliptical | elliptical |
| Stairmaster | stairClimbing |
| Boxing | boxing |
| Kickboxing | kickboxing |
| Martial Arts | martialArts |
| Dance | dance |
| Climbing | climbing |
| Rock Climbing | climbing |
| Skiing | downhillSkiing |
| Snowboarding | snowboarding |
| Jumping Rope | jumpRope |
| Meditation | mindAndBody |
| Stretching | flexibility |
| anything else | other, with WHOOP's name as text |
<!-- activity-table:end -->

## Open questions

- **An RMSSD code** in the IG (and ideally LOINC), so most wearables' HRV has a standard home.
- **The PGHDCode slicing defect** in `pghd-vitalsigns` and `pghd-workout`.
- **A published package** containing the PGHD profiles, so exports can be validated against
  a version rather than a moving build.
- **Merging with Health Bridge.** Both writers use `Patient/me` and `Composition/cover`.
  `tonos phr merge` resolves that; a shared convention would be better.
