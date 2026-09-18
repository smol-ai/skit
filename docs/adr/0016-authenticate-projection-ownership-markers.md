# Authenticate Projection Ownership Markers with a device key

> Superseded by ADR-0017. Authenticated marker and device-identity work is not part of the custody-recovery repair.

Ownership Markers are independent custody evidence, but version-1 markers are unauthenticated and are not bound to their filesystem target. SKIT therefore introduces a version-2 marker authenticated by a device-local HMAC key. Legacy markers remain diagnostic evidence and require ledger corroboration.

## Device identity

Each local Library has one 32-byte random secret stored at `~/.skit/device-key.json`. The file contains `schemaVersion`, `deviceId`, and a base64-encoded secret. `deviceId` is an independent random 128-bit identifier generated alongside the secret; it is never derived from key material.

Ownership Markers may live beneath repository Skill Roots and may therefore be committed to public version control. `deviceId` is public by design and contains no secret-derived material. It remains a stable correlation token, so diagnostics display it only when needed and documentation must not describe it as anonymous.

The key file is created atomically with exclusive creation, mode `0600`, beneath a mode-`0700` Library directory. On platforms that expose POSIX modes, a group- or world-accessible key is rejected as a health condition rather than silently used. The key is not part of state migration, content backup, publication, or repository data.

## Marker version 2

A marker contains:

- `schemaVersion: 2` and `projectionPolicyVersion`;
- `deviceId`, Projection id, Collection reference, Skill reference, expected content hash, and transaction id;
- the target's `declaredPath` and resolved, byte-faithful `canonicalPath`;
- the committed satisfied-Binding keys; and
- `authentication: { algorithm: "hmac-sha256", tag: "sha256:…" }`.

The authentication tag is HMAC-SHA-256 over a UTF-8 JSON array with a fixed field order and a domain prefix, `skit/ownership-marker/v2`. The array contains every semantic field above except the tag itself. Arrays whose order is not semantic, including satisfied-Binding keys, are sorted before encoding. Signing and verification both parse and validate values, construct this normalized tuple, and encode it with SKIT's one deterministic JSON serializer; literal marker bytes, escaping, and whitespace are never authenticated directly. Marker validation rejects unknown fields, duplicate Binding keys, malformed digests, unsupported algorithms or versions, and any missing or empty identity field before authentication is attempted.

The canonical target binding is deliberate. Copying a marker to another target, or retargeting a symlink, fails target verification even if the bytes are otherwise unchanged. A reconciled relocation writes a newly authenticated marker transactionally; it never edits the old marker in place before the ledger commits.

## Authority

Marker syntax, authentication, target binding, ledger agreement, and content agreement are separate findings. Diagnostics classify every available signal and do not abort because one signal fails.

An authenticated version-2 marker from the current device with matching target and content hash may establish custody when its ledger record is absent. It can support non-destructive re-indexing and an explicit orphan-release operation. Release still requires an operator command and refuses modified content by default.

An authenticated marker with a target or hash mismatch retains custody as a conflict but cannot authorize deletion. A marker from another device is a foreign-device custody claim: it is visible and unhealthy, but the local device cannot authenticate it and must not delete or adopt its bytes automatically. A marker carrying an identifier in the local ledger's superseded-device history is instead a superseded-local claim. It is recognizably local but unverifiable by the active key, remains unhealthy, and has the same non-destructive authority boundary.

A version-1 marker corroborated by the version-2 ledger preserves existing custody. Without that ledger record it is an orphan claim only: it makes health unhealthy but cannot authorize deletion, adoption, or destructive re-indexing. Version-3 state records the last committed marker version for each Projection. Observing a lower version is a marker-downgrade condition and never silently enters the weaker legacy authority path. Invalid marker syntax or shape is always a first-class condition and is never equivalent to marker absence.

## Key loss and rotation

Missing or unreadable key material never causes SKIT to generate a replacement during diagnosis. Existing version-2 markers become unverifiable custody claims and all marker-authorized destructive operations stop.

The operator may restore the original key from a private backup, or explicitly rotate to a new key. Rotation first backs up the current key and ledger, creates the replacement key atomically, moves the prior `deviceId` into state history, and re-authenticates only Projections corroborated by the ledger whose target, identity, and expected content hash all agree. Ledger-absent markers are not re-authenticated during rotation. Any disagreement remains held as a superseded-local claim for reconciliation. Rotation is transactional: failure leaves either the old key and markers or the new key and all eligible rewritten markers, never a mixed authority set presented as healthy.

Importing a key validates its independent identifier and secret, installs it with restrictive permissions, and runs diagnosis before enabling destructive commands. A foreign device key is never fetched from marker contents or synchronized directories.

The key file must not be synchronized between machines. Deliberately copying it makes those machines one logical custody authority with one public `deviceId`, but SKIT provides no concurrent-writer coordination for that configuration and treats it as unsupported. Operators synchronize projected bytes without synchronizing device keys; the receiving device reports their markers as foreign claims.

## Consequences

Version-3 state records the active `deviceId`, superseded local identifiers, and each Projection's committed marker version; marker version 2 and state version 3 ship together. Re-indexing from authenticated markers reconstructs custody records only. It does not invent retained Entries, Binding intent, or satisfied-Binding relations beyond the committed relations authenticated in the marker.

Loss of both ledger and device key is not automatically recoverable as destructive authority. SKIT can inventory and preserve the bytes, but an operator must restore the key or use an explicit manual adoption/reconciliation workflow that establishes new custody without claiming the old marker was authenticated.
