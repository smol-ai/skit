# Represent Unbound SKITs Without a Sentinel Identity

An authored SKIT Descriptor does not carry Registry `id`. Its required `slug` names the local collection without asserting a Registry Namespace or canonical SKIT Identity. The absence of Registry identity is structural; `local/<slug>` is no longer synthesized during parsing or interpreted as a special namespace-shaped sentinel.

An authored repository's remote-home state is determined only by the presence of a valid root `skit.remote.json`. That file supplies Registry origin, Namespace, and SKIT slug. Local sync and publish code must not infer boundness from Descriptor strings or the legacy `registry` field. At a Registry API boundary, the client or server derives the request Descriptor's route-qualified `id` from the authorized Namespace and SKIT slug. The Registry continues to store and return route-qualified Descriptor identity for Drafts and Releases.

This keeps three concepts separate:

- `slug` is portable local authoring intent;
- `skit.remote.json` is repository-owned author-home configuration;
- `skit://<registry-authority>/<namespace>/<skit>` is canonical Registry-qualified identity.

`local` remains a valid Registry Namespace. We reject reserving it because doing so would encode an implementation workaround into the public namespace grammar, break any Registry that already provisioned `local`, and still leave unboundness represented indirectly. No migration or special handling is required for a genuine Registry Namespace named `local`; its Registry authority and remote-home record distinguish it from legacy sentinel data.

## Contract consequences

The core model separates an artifact `SkitDescriptor`, which has a required `slug` and no Registry `id`, from a Registry wire Descriptor, which has route-qualified identity. This is preferable to making one public field optional: callers cannot accidentally treat an unbound declaration as Registry identity, and code that genuinely requires Registry identity must accept it explicitly. Code that needs a stable local catalog key uses the identity catalog's structural local/source identity rather than manufacturing a Descriptor `id`.

Registry request and response schemas continue requiring a route-qualified `id`, because those payloads exist inside an explicit Registry authority and route. Sync constructs that wire value from its destination or recorded remote home; server integrity derives it from already-validated Namespace and SKIT-slug route components without changing the authored artifact. The standalone composed-ID regex is deleted rather than retained as a second, looser copy of the component grammar. Release identity construction receives Registry identity at the publication boundary rather than borrowing a provisional local value.

Validation policy must also stop using `id.startsWith("local/")` as a proxy for lifecycle state. Whether incomplete publication declarations are acceptable is an explicit validation phase or operation policy. First sync can therefore validate Registry readiness before a remote home exists, while ordinary local authoring can still report incomplete declarations appropriately.

This is a breaking TypeScript model change wherever `SkitDescriptor.id` is assumed to be present, but it is not an authored `skit.json` format change. The strict `skit.json` schema already contains `slug` and no `id`; `parseSkitConfig` currently invents `local/<slug>` in memory. Generated CLI output contracts must be versioned if their public payload shape changes; Registry wire contracts retain their required route identity.

## Migration

Existing `skit.json` files need no rewrite or migration because they never authored the sentinel. Removing the derivation in `parseSkitConfig` is sufficient for those repositories. README-frontmatter Descriptors must use `slug`; legacy `id: local/<slug>` input is rejected rather than preserved through a compatibility path. The only known producer was SKIT's own internal normalization adapter, which changes in the same implementation. Those generated adapters may have been copied into the content-addressed local Library store, but there is no installed base to preserve. Development stores created before this decision are disposable and must be rebuilt; the implementation does not re-hash, migrate, or retain a reader for them. New initialization, normalization adapters, fixtures, output, and rewritten Descriptors never emit `local/*`.

At the time of this decision, source-derived Collection Identity also changed the derived Collection reference of authored SKITs installed from GitHub, generic Git, or local paths from `declared-skit` to the corresponding source profile. That reference layer was later removed; portable artifact metadata still does not override acquisition identity.

Projection policy likewise follows explicit declarations without an identity-profile exception. The former compatibility rule treated a single `explicit` trigger on generated collections as host policy. Source-derived Collection Identity moves authored GitHub, generic Git, and local SKITs from `declared-skit` to `github-collection`, `git-collection`, or `local-collection`; retaining a rule scoped to non-`declared-skit` collections would therefore silently widen it to authored SKITs. With no installed base requiring the adapter behavior, generated normalization declares `host_policy` directly and the compatibility rule is removed.

The transitional Descriptor `registry` field is removed rather than migrated. A genuine Registry resource whose Namespace is `local` remains valid because Registry wire identity is interpreted with its explicit route and authority, never by string prefix alone.

Implementation must update the core schemas and types, validation and Release-identity construction, CLI sync and publish guards, generated internal normalization, output contracts where required, and repository-owned fixtures. There is no compatibility reader for external artifacts or persisted internal stores because the absence of an installed base makes a clean break preferable to carrying migration code. The implementation follows this ADR in a separate reviewed change.

We rejected reserving the `local` Namespace, replacing the sentinel with a different magic prefix, and using an empty string. Each preserves string pattern matching as hidden lifecycle state. We also rejected putting Registry identity back into `skit.json`, because ADR-0010 establishes remote-home metadata outside the artifact Descriptor.

We considered keeping `id` required and filling it with the bare slug, but rejected it because the same field would mean local name in one context and Registry identity in another. We considered making `SkitDescriptor.id` optional, but rejected a single weak shape because it would spread presence checks across consumers and preserve the temptation to infer lifecycle state from it. Separate artifact and Registry-wire types make the boundary explicit and allow composed Registry identity to be derived from validated components.

This refines ADR-0003's statement that a Descriptor can be unbound, completes ADR-0005's removal of synthetic local identity from library behavior, and preserves ADR-0009 and ADR-0010's Registry-qualified identity and single-author-home decisions.
