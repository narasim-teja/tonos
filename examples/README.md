# Example export

Fictional data in the exact shape of a WHOOP member data export (in-app **Data Export**,
as of November 2026). No real person's data. Used by the tests and for trying the CLI:

```sh
bun run tonos import examples/export.zip --data ./example-data
```

The rows exercise the cases the importer has to get right:

| Case | Where |
| --- | --- |
| Today's cycle: no end, no Strain yet, but last night's Recovery is present | first cycle row |
| A day WHOOP could not score: every score blank | 2026-03-07 cycle |
| US daylight-saving change: offsets move from UTC-05:00 to UTC-04:00 | cycles on 2026-03-07 and 2026-03-08 |
| A nap: `Nap` true, no consistency score | sleeps.csv, 2026-03-08 15:10 |
| An activity with no PHR IG code (`Sauna`) and WHOOP's generic `Activity` | workouts.csv |
| A journal note with a comma, a newline and doubled quotes | journal_entries.csv |
| A journal row with no cycle | last journal row |
