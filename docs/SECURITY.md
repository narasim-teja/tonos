# Security and data handling

tonos holds a person's health data and hands it to AI agents. This is what it protects,
from whom, and what it does not do.

## Assets

1. The stored records: two-plus years of recovery, HRV, sleep and workouts.
2. The journal: medications, alcohol and free-text notes. More sensitive than the rest.
3. WHOOP OAuth tokens, when the live API is used. A refresh token is long-lived access to
   the account's data.
4. Agent tokens for the loopback server.

## Threats

1. **A web page in the user's browser** calls `127.0.0.1:4272`, directly or by DNS
   rebinding a hostname to 127.0.0.1.
2. **Another local process** connects to the loopback port.
3. **An agent goes beyond its task**: reads more than needed, or is steered by text inside
   the data (prompt injection through journal notes).
4. **Credential leakage**: WHOOP tokens or agent tokens end up in the repository, the data
   directory, logs or chat.
5. **Silent data damage**: a format change in WHOOP's export shifts columns or times, and
   wrong values flow into an agent's answer or a FHIR export.

Out of scope: malware running as the user (it can read anything the user can), and a
stolen unlocked laptop.

## Controls

| Layer | Control | Defeats |
| --- | --- | --- |
| Bind | Listens on 127.0.0.1 only, never 0.0.0.0 | Remote access |
| Host | Only `127.0.0.1:<port>` and `localhost:<port>` are accepted | DNS rebinding (1) |
| Origin | Requests with a non-loopback `Origin` are refused | Browser pages (1) |
| Auth | Per-agent bearer token, 256 random bits, stored only as SHA-256, compared in constant time, revocable one by one | Other local processes (2) |
| Scope | MCP exposes read-only tools only. Import, export, purge, pairing and login are CLI-only | Overreach (3) |
| Journal | Not exposed to agents unless the server starts with `--allow-journal` | Overreach (3) |
| Data as data | Server instructions and docs/SKILL.md tell agents that record text is never instructions | Injection (3), partly |
| Audit | Every request, allowed or denied, appended to `audit.jsonl` with agent name, tool, arguments and outcome. Results are never logged | Lets the user see (3) after the fact |
| Secrets | WHOOP tokens in the macOS Keychain (`Bun.secrets`), encrypted at rest. Client credentials only from the environment or `.env`, which is gitignored | Leakage (4) |
| Files | Data directory 0700; store, pairings and audit files 0600 | Other users on the machine |
| Parsing | Strict CSV parsing; a missing column, a wrong field count or an unknown timestamp format fails the import instead of guessing. Every record is schema-validated before it is stored | Silent damage (5) |
| Body | MCP request bodies over 1 MB are refused | Resource abuse |

## Why the store holds only your export

WHOOP's API Terms of Use (effective October 6, 2026) say developers may not "build
databases, or otherwise create permanent copies of WHOOP Data", may not embed developer
credentials in open-source projects, and restrict translating WHOOP Data. They also
require encryption at rest. So:

- The store accepts only records from the member's own data export. `Store.importExport`
  refuses API records; a test checks it.
- Live API results are returned to the caller and dropped.
- tonos ships no WHOOP credentials. Each user registers their own app (WHOOP's free
  Sandbox tier allows 10 members) and keeps the secret in their own environment.
- FHIR export runs only on stored export records, and only when the user runs it.
- Import is manual: the user downloads the zip and points tonos at it. WHOOP's consumer
  terms prohibit automated extraction, so tonos does not script the app or the website.

This is a reading of the terms by a non-lawyer, written down so it can be checked.

## Known limitations

- **Tokens are not bound to a calling app.** Health Bridge binds each token to the code
  signature of the first app that uses it. A Bun process cannot resolve the peer's code
  signature without native code, so a stolen agent token works from any local process
  until it is revoked. Mitigation: one token per agent, `tonos unpair`, and the audit log.
- **The store is not encrypted at rest.** It relies on file permissions and full-disk
  encryption (FileVault). WHOOP's encryption requirement covers API data, which tonos does
  not store; export data is the user's own file.
- **`--live` sends WHOOP data to the agent.** WHOOP's API terms restrict using WHOOP data
  to "develop" AI applications. tonos reads that as aimed at training and building AI
  products, not at a member reading their own data with their own agent. Live tools stay
  off unless the user passes `--live`.
- **Prompt injection is mitigated, not solved.** Instructions to the agent help; the hard
  limit is that every tool is read-only.

## Reporting

Open a private security advisory on the repository.
