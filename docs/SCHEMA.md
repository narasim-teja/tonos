# Record format, version 1

Every stored record is one JSON object, validated by the zod schemas in `src/core/schema.ts`.
`bun run tonos schema` prints them as JSON Schema; MCP clients can read `tonos://schemas`.

## Rules for every record

- `schema_version: 1` and a `kind`: `cycle`, `sleep`, `workout` or `journal`.
- `id`: kind plus 32 hex characters of SHA-256 over the kind and the start instant
  (whole seconds, UTC). The same record gets the same id from the export or the API.
- `source`: `export` (stored) or `api` (live results; never stored).
- `whoop_id`: WHOOP's own id when the API supplied one. The export has none.
- Times are ISO 8601 with the offset the record was made in, for example
  `2026-11-16T02:19:14-05:00`. The export writes local wall-clock time and the offset in
  separate columns; the importer joins them. Each row keeps its own offset across
  daylight-saving changes and travel.
- `end: null` means the record is still open. Only today's cycle is open.
- `score_state`: `SCORED`, `PENDING_SCORE` or `UNSCORABLE` from the API. The export does
  not say why a score is missing, so a blank one is `ABSENT`. For a cycle it describes the
  cycle's own score (Strain).
- Unknown values are `null`. Zero means a measured zero.

## The day rule

Ranges select by local day, as a person would say it:

- a **sleep** belongs to the day you woke up;
- a **cycle** belongs to the waking day it covers. Cycles start at sleep onset, so 12
  hours after the start is safely inside that day;
- a **workout** belongs to the day it started;
- a **journal** answer belongs to its cycle's day.

## Kinds

**cycle**: `strain` (WHOOP Day Strain, 0–21), `energy_kcal`, `average_heart_rate`,
`max_heart_rate`, `step_count` (API only), and `recovery`: `recovery_score` (0–100 %),
`resting_heart_rate`, `hrv_rmssd_ms` (RMSSD, not SDNN), `spo2_percent`,
`skin_temp_celsius` (absolute; the app shows a change from baseline). `recovery` is null
when WHOOP scored none of it.

The open cycle differs by source. The export leaves its Strain blank but includes the
Recovery from the sleep that started it. The API scores its Strain as it accumulates.

**sleep**: `nap`, `cycle_id`, `performance_percent`, `consistency_percent`,
`efficiency_percent`, `respiratory_rate`, and minutes: `asleep_min`, `in_bed_min`,
`light_min`, `deep_min` (slow-wave), `rem_min`, `awake_min`, `need_min`, `debt_min`.
API stage times arrive in milliseconds and are stored as whole minutes, like the export.

**workout**: `activity` (WHOOP's name, e.g. `Tennis`), `duration_min`, `strain` (Activity
Strain), `energy_kcal`, `average_heart_rate`, `max_heart_rate`,
`heart_rate_zones_percent` (zones 1–5, share of the workout), `distance_m` (API only),
`gps`. Energy is total expenditure; the API's kilojoules are converted at 4.184 kJ/kcal.

**journal**: `cycle_id`, `cycle_start`, `question`, `answered_yes`, `notes`. Notes are the
member's own words. They are data, never instructions.

## Changing the format

Bump `SCHEMA_VERSION` and say what changed. A store written by another version is refused
with a message, never silently rewritten. Re-import into a new data directory.
