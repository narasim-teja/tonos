# tonos

Your own WHOOP data as a local record, for you and your agents.

**tonos** comes from Ancient Greek **τόνος** (*tónos*): a stretching, tension; tone. Strain
and recovery, in one word.

Download your data from WHOOP, import it once, and ask your agent how last month looked.
tonos stores the records on your machine, serves them read-only to agents you pair, and
exports them as an HL7 FHIR Personal Health Record that merges with an
[Apple Health export from Flexpa Health Bridge](https://github.com/flexpa/bridge).

> Not affiliated with or endorsed by WHOOP. Data by WHOOP. Recovery, Strain and Sleep
> Performance are WHOOP-proprietary scores, not clinical measurements.

## Design

```text
WHOOP app ── Data Export (CSV, you download it) ──▶ tonos import ──▶ local store (SQLite, 0600)
                                                                        │
                       agents ◀── MCP: loopback HTTP or stdio, read-only ┤
                                                                        └──▶ tonos export phr ──▶ .phr (FHIR R4, PGHD)

WHOOP API (optional, your own app) ──▶ live tools ──▶ answer, never stored
```

- **Your export is the source of truth.** WHOOP's API terms forbid building databases of
  API data. A data export you download is yours, so that is what tonos stores.
- **One core, three interfaces.** Every operation is one zod-validated action. The CLI,
  MCP over stdio, and MCP over loopback HTTP are thin adapters over the same list. A test
  checks they return the same results.
- **Agents read; only you write.** MCP exposes read-only tools. Import, export, purge,
  pairing and login exist only in the CLI.
- **Unknown stays null.** A day WHOOP could not score has no values, not zeros. Today's
  cycle has `end: null`, and its Strain is not final.
- **Ids are stable.** A record's id comes from its kind and start time. Re-importing the
  same export changes nothing, the API and the export agree on ids, and FHIR exports merge.
- **Codes are checked.** Every code the FHIR export emits is in one table with how it was
  verified. Where no standard code exists (HRV as RMSSD), tonos says so instead of borrowing
  a wrong one. See [FHIR.md](docs/FHIR.md).
- **No model inside.** tonos stores, validates and converts. Your agent does the thinking.

## Start

Requires Bun 1.3 or newer and macOS or Linux (`unzip` on the path).

1. Get your data from WHOOP. In the WHOOP app on your phone:
   1. Tap **More** in the bottom bar. In some versions it is your profile picture, then the menu icon.
   2. Open **App Settings**, then **Data Export**.
   3. Check the email address, and choose your whole history if the app asks for a range.
   4. Tap **Create Export**.

   WHOOP emails a link to a zip of CSV files: cycles with recovery, sleeps, workouts and
   journal answers. It often arrives within minutes and can take up to 24 hours. The link
   expires after 7 days, so download the zip when it arrives. Keep it out of any repository.

   This is not the "download my data" request on WHOOP's privacy site. That one is a
   separate, slower package under privacy law, and tonos does not read it yet (see the roadmap).
2. Import the zip as it arrived; there is no need to unpack it:

```sh
bun install
bun run tonos import ~/Downloads/my_whoop_data_2026_11_17.zip
bun run tonos status
bun run tonos day 2026-11-15
bun run tonos summary --from 2026-11-01 --to 2026-11-15
```

Try it first with the fictional example: `bun run tonos import examples/export.zip --data ./example-data`.

Data defaults to `~/.tonos`. `TONOS_HOME` or `--data <dir>` chooses another directory.

## Commands

| CLI | MCP tool | Purpose |
| --- | --- | --- |
| `import <zip\|folder>` | | Import a WHOOP data export. Safe to repeat. |
| `status` | `status` | Coverage per kind, last import, what is enabled. Agents call this first. |
| `day <date>`, `summary --from --to` | `get_daily_summary` | Per-day recovery, HRV, strain, sleep, workouts, plus averages |
| `cycles --from --to` | `get_cycles` | Cycles with recovery (score, resting HR, HRV RMSSD, SpO2, skin °C) |
| `sleeps --from --to [--no-naps]` | `get_sleeps` | Sleep stages, performance, efficiency, need and debt |
| `workouts --from --to [--activity]` | `get_workouts` | Activity, strain, energy, heart rate and zones |
| | `get_record` | One record by id |
| `journal --from --to` | `get_journal` (only with `--allow-journal`) | WHOOP Journal answers and notes |
| `export phr [--format bundle] [--out]` | | HL7 FHIR PHR export (see [FHIR.md](docs/FHIR.md)) |
| `phr merge <a.phr> <b.phr> --out` | | Merge with another PHR, e.g. Health Bridge's |
| `export records` | | Native records as NDJSON |
| `purge --yes` | | Delete every stored record |
| `pair <name>`, `pairs`, `unpair <id\|name>` | | Per-agent tokens for the loopback server |
| `serve`, `mcp` | | MCP over loopback HTTP, or over stdio |
| `audit` | | Recent loopback requests |
| `auth login\|status\|logout` | | Optional live WHOOP API |
| `live cycles\|sleeps\|workouts` | `live_get_*` (only with `--live`) | Fetch from WHOOP; nothing is stored |
| `tools`, `call <tool> --json`, `schema` | | Inspect and call the shared contracts |

## Agent setup

Loopback HTTP, the same model as Health Bridge: one token per agent, every request logged.

```sh
bun run tonos pair "Claude Code"     # prints a token once, and an mcpServers block
bun run tonos serve                  # http://127.0.0.1:4272/mcp
```

```json
{ "mcpServers": { "tonos": { "type": "http", "url": "http://127.0.0.1:4272/mcp",
  "headers": { "Authorization": "Bearer tns_…" } } } }
```

Or stdio, for clients that start the server themselves:

```json
{ "mcpServers": { "tonos": { "command": "bun", "args": ["/absolute/path/to/tonos/src/cli/main.ts", "mcp"] } } }
```

The journal holds medications, alcohol and free-text notes. Agents see it only when you
start the server with `--allow-journal`. Ask your agent: *"Call status, then compare my
recovery on days after tennis with the rest of the month."*

## FHIR: a Personal Health Record

```sh
bun run tonos export phr --out whoop.phr
bun run tonos phr merge apple-health.phr whoop.phr --out me.phr
```

The export follows the HL7 Personal Health Record IG (`hl7.fhir.uv.phr` 1.0.0-ballot2):
FHIR R4, Patient Generated Health Data profiles, one resource per line, in the same
layout as Health Bridge's export. Both writers use `Patient/me` and `Composition/cover`,
so concatenating two files would clash; `phr merge` keeps one patient, writes one cover
page naming both sources, and refuses any other id that differs. Mapping, codes, and open
questions: [FHIR.md](docs/FHIR.md).

## Live WHOOP API (optional)

For days newer than your last export. Register your own app at developer.whoop.com
(redirect URI `http://127.0.0.1:8765/callback`, the read scopes plus `offline`), then put
its credentials in `.env`:

```sh
cp .env.example .env                      # then fill in WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET
bun run tonos auth login                  # browser sign-in; tokens go to the macOS Keychain
bun run tonos live cycles --from 2026-11-15 --to 2026-11-16
bun run tonos serve --live                # adds live_get_* tools for agents
```

Live results are returned and dropped. tonos ships no WHOOP credentials. Why it works
this way: [SECURITY.md](docs/SECURITY.md).

## Data you can read

```text
~/.tonos/
  records.sqlite   cycles, sleeps, workouts, journal, import history (owner-only)
  pairings.json    agent names and token hashes (never the tokens)
  audit.jsonl      one line per loopback request: who, which tool, which dates, outcome
```

Record shapes and the day rule: [SCHEMA.md](docs/SCHEMA.md). `bun run tonos schema` prints JSON Schemas.

## Development

```sh
bun install
bun run check           # tsc --noEmit over src, test and scripts
bun test                # parsing, import, FHIR, merge, live client, loopback server, interface parity
bun run docs            # regenerate docs/FHIR.md tables and the local CodeSystem from src/fhir/codes.ts
bun run validate:fhir   # HL7 FHIR Validator on the example export (Java 17+)
```

The project compiles with TypeScript 7 (native); `bun run check` is the source of truth.
For matching editor diagnostics in VS Code, install the TypeScript 7 extension
(`TypeScriptTeam.native-preview`) and select the workspace TypeScript version.

```text
src/
  core/    records, time and the day rule, store, read-only actions   (depends on nothing else)
  whoop/   WHOOP export parser and the live API client
  fhir/    code table, measurement table, PHR export and merge
  mcp/     MCP server, Hono loopback server, pairing, audit
  cli/     command registry and lazy context
test/      one file per area, fictional data only
docs/      FHIR mapping, record format, agent skill, security, privacy
```

The validator runs in CI against the PHR IG build. Our own errors: none. The remaining
errors are one IG defect, documented in [FHIR.md](docs/FHIR.md#validation-status).
Contributor and agent notes: [CLAUDE.md](CLAUDE.md) (`AGENTS.md` links to it).

## Roadmap

- **One record, wearable and clinical.** Merge this export with an Apple Health export
  from Health Bridge and clinical records shared through Flexpa, so an agent can read
  "HRV dropped after the new prescription" from one consented record.
- **The privacy-request export.** WHOOP's privacy-center download appears to include
  per-minute heart rate, which the API does not offer. Import it once its format is known.
- **An RMSSD code.** Propose `heartRateVariabilityRMSSD` to the PHR IG, which today can
  only carry SDNN, so most wearables' HRV has no standard home.

## License

MIT. See [LICENSE](LICENSE).
