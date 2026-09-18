# Qualify SKIT Identity by Registry Authority

A canonical SKIT Identity includes the Registry authority, Namespace, and SKIT slug. Its readable form is:

```text
skit://skills.example.com/tim/my-skills
```

A contained Skill appends its Skill name as a fragment:

```text
skit://skills.example.com/tim/my-skills#review
```

The URI authority identifies the Registry host (and non-default port when present); Registry discovery and requests use the corresponding configured HTTPS origin. Internally, identity remains structured as Registry origin, Namespace, and SKIT slug. Callers consume the Collection Identity catalog result rather than constructing or parsing these strings independently.

`tim/my-skills` is convenient shorthand only when an active Registry is already explicit in the operation or author binding. It is not portable or globally unique. The former `skit:tim/my-skills` form is also Registry-relative and must not be emitted as a canonical identity in new state.

This is required because independently operated Registries may both host `tim/my-skills`; those resources have unrelated authority, Draft history, Releases, visibility, and grants. A username or Namespace has meaning only within its Registry. Opaque Registry database identifiers, credentials, Source Revisions, and Content Digests remain outside SKIT Identity.

We rejected treating `namespace/skit` or `skit:namespace/skit` as globally canonical because both silently depend on ambient Registry configuration. We rejected deriving authority from Git because source hosting does not establish Registry identity or authorization. We also rejected using an HTTPS download URL as identity because routes and deployment topology may change while the Registry authority and logical SKIT remain the same.

The committed author binding in `skit.remote.json` records the HTTPS Registry origin plus Namespace and SKIT slug. It therefore supplies the complete structured identity from which the canonical `skit://` reference is derived without placing Registry location in the artifact Descriptor.
