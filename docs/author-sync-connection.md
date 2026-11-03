# Recovering first author connection

Compared with `60b7a8b8c24f42ad7d8040cc5e41962dff63ab32`; After describes
the current working tree.

```text
Before
CLI → syncAuthorWorkspace
      ├─ check destination absent → create remote
      ├─ run recoverable revision sync
      └─ write skit.remote.json (only after sync)
         A lost create response or restart strands an existing destination.

After
CLI → loadAuthorSyncRemote (credential origin, including pending connection)
    → syncAuthorWorkspace (owns connection lifecycle)
      ├─ Unconnected → check absent → durably save Connecting
      ├─ Connecting → replay create with saved request ID
      │  Registry Skits.create owns atomic creation and matching replay
      ├─ save fresh Idle checkpoint → durably save remote home
      └─ Connected → existing recoverable revision sync
```

Connecting is a tagged checkpoint in `.skit/connection.json`, excluded from
revision trees. It holds the destination, visibility and a random creation
request ID before any create request. Restart needs no destination flags.
Matching flags may be repeated; conflicting flags cannot redirect the pending
operation. A preview never creates a checkpoint or sends a create request.

`POST /api/skits` accepts an optional `request_id`. Existing callers retain
create-once behavior. A matching ID and visibility replay succeeds without
changing the SKIT or its current revision; an unrelated existing destination
still conflicts. A definitive receipt mismatch removes the pending intent so
the author can choose another destination; uncertain failures keep it.
Authorization is checked on every replay. Migration 0012 adds
a nullable receipt column without replacing existing identities or history.

The portable `skit.remote.v1` contract stays unchanged. It is saved and flushed
before revision sync begins. If pending-checkpoint cleanup is interrupted, the
durable remote home takes precedence. Until that commit point, retries replay
creation and reset the local sync base, with no revision writes yet performed.
These guarantees require an upgraded Registry; an older server that ignores
request IDs cannot recover an uncertain create response.

Local verification covers requests lost before and after creation, restart while
awaiting the create response, lost revision/move responses, failure saving the
remote home, two devices competing to create, unchanged pending previews,
conflicting flags, malformed checkpoints and credential isolation. The real
Worker tests cover authenticated creation replay through HTTP, D1 and R2,
including keeping an already advanced current pointer unchanged.

Roll out migration 0012 and the Registry change before relying on client
connection recovery. These changes have not been deployed.
