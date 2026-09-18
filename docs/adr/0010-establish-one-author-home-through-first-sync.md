# Establish One Author Home Through First Sync

An authored SKIT has at most one canonical remote home. An unbound collection establishes it through the first applied synchronization:

```sh
skit author sync --to <destination> --visibility <policy> --apply
```

There is no separate user-facing `author bind` command. Preview is the default and names the Registry-qualified SKIT Identity, visibility, Draft file count, and intended effects. Sync creates or advances private Draft state and never creates a Release.

After the Registry accepts the initial Draft, the CLI writes committed `skit.remote.json` beside `skit.json`. The file contains only schema version, canonical HTTPS Registry origin, Namespace, and SKIT slug. It is repository-portable authoring metadata but is excluded from the SKIT Descriptor, Draft artifact, and Release archive. Credentials and synchronization evidence remain device-local under the SKIT home.

This gives collaborators who clone the Author repository the same canonical destination without treating Git configuration as Registry authority or placing deployment location in portable artifact identity. The server must accept the identity and Draft before local remote-home state is recorded, so failed discovery, authentication, authorization, validation, concurrency, or storage cannot leave a false binding.

We rejected a separate `bind` command because it exposes implementation language, conflicts with Library-to-Harness Binding terminology, and adds ceremony without producing the Author's intended outcome. We rejected storing the home only in device-local state because clones could silently select different Registries. We rejected storing it in `skit.json` because Registry location is authoring configuration rather than artifact content. We rejected Git-like multiple remotes because one SKIT has one authoritative Draft and Release history; migration, mirroring, and forking are distinct explicit lifecycle operations.

This supersedes ADR-0003's unresolved placement of later Registry binding and its statement, attributed to ADR-0004, that no portable Registry binding would be added. ADR-0004's Draft storage decision remains unchanged.
