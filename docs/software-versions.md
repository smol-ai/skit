# Software versions and releases

`skit --version` prints the installed version without network access. `skit version`
reports build identity and checks npm with a 1.5-second network timeout; `--json`
returns `skit.version.v2` (replacing the subcommand’s previous v1 output).
The global `--version --json` retains `skit.version.v1`. An unavailable check does not fail local version reporting.
Development builds can inspect npm but are not compared as published releases.

Release identity means a clean artifact-tagged build, not proof of publication or
installation provenance. CLI tags are `@smolai/skit@<version>`; server tags are
`@smolai/skit-server-effect@<version>`. Set `SKIT_RELEASE=1` to require release
validation during a build. Ordinary builds report `kind: dev` and their manifest
version and Git commit. Server health and discovery expose the server's own build.

Stable versions check `latest`; `-alpha.N`, `-beta.N`, and `-rc.N` check their own
tags. Preview users can graduate to a newer stable version. Stable users are never
offered a prerelease on `latest`. Set `SKIT_RELEASE_CHANNEL` to override the tag;
this selects an update source, not the tag originally used to install the package.
Set `SKIT_NPM_REGISTRY` for a different registry.

Interactive release builds check at most daily and show update notices on stderr,
at most once per available version per day. Checks overlap command execution and
may wait for the remaining timeout after it completes. JSON, CI, help/version,
noninteractive and development runs skip passive checks. `SKIT_NO_UPDATE_CHECK=1`
disables passive checks. Explicit `skit version` always performs a fresh check.
The versioned atomic cache lives under `$XDG_STATE_HOME/skit` (default
`~/.local/state/skit`), outside the Library. If this state cannot be written, passive checks are skipped
so each invocation cannot repeat a network delay; explicit checks still work. Failed completed checks back off for
24 hours; successful cached data expires after seven days. Corrupt cache files are
ignored. Upgrade instructions currently use npm; the executable cannot reliably
identify which package manager originally installed it.

## Publishing

For the first publication, add a granular token with publication rights as the
GitHub `npm` environment secret `NPM_BOOTSTRAP_TOKEN`, then dispatch
`.github/workflows/release-cli.yml` with `bootstrap: true` and an existing CLI
artifact tag. The token is passed only to the release step. Once the package
exists, configure its trusted publisher for `release-cli.yml`, the repository,
and environment `npm`; enable both **Allow npm publish** and **Allow npm dist-tag**.
Subsequent dispatches use `bootstrap: false` and OIDC. The workflow pins npm
11.21.0, which supports OIDC tag management. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Dispatches verify a clean tagged commit, supported version,
and registry availability, build and smoke-test a packed artifact, publish
with provenance under `staging`, smoke-test the published version, then promote
its computed release channel. Published installation is retried with bounded
backoff for propagation delays. Re-running the same tag after a failed promotion
resumes only if the published tarball integrity matches the newly built tarball
exactly; it smoke-tests that publication again before promotion. A mismatched
artifact needs a new version and tag. Tags may be missing or
point at prereleases during initial publication; clients handle both safely.

There is no self-updater or version-floor enforcement yet. API payload schema
validation continues to establish wire compatibility independently of software
release versions. CLI and server releases can advance independently.

## Server releases

Server upgrades use a tagged source checkout and the existing deployment command,
with independent `@smolai/skit-server-effect@<version>` tags. See the
[server upgrade procedure](../packages/skit-server-effect/README.md#releases-and-upgrades)
for identity verification, configuration preservation, and migration constraints.
No server npm package or automated server release workflow is needed.
