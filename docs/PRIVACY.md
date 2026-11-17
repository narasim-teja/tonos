# Privacy

tonos is a personal, local-first tool. It runs only on the user's own computer.

- **What it stores.** Records from the WHOOP data export the user imports, kept in a
  SQLite file in the user's data directory (`~/.tonos` by default), readable only by them.
- **What it does not store.** Responses from the WHOOP API. When the user connects the
  optional live API, results are used to answer that request and then discarded.
- **Tokens.** WHOOP OAuth tokens stay in the user's operating-system keychain. Agent tokens
  are stored only as hashes.
- **What leaves the machine.** Only requests the user starts: the WHOOP sign-in and live
  API calls, which go to WHOOP. Whatever an agent the user has paired reads is sent to that
  agent; the user chooses the agent.
- **The developer** operates no server and collects no data, analytics or telemetry.
- **Removing data.** `tonos purge --yes` deletes the stored records. `tonos auth logout`
  revokes WHOOP API access and deletes the tokens. Access can also be revoked in the WHOOP
  app.

Contact: open an issue on the repository.
