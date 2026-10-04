# Software versions and releases

`skit --version` prints the installed version without network access. `skit version`
reports build identity and checks npm with a 1.5-second network timeout; `--json`
returns `skit.version.v2`. An unavailable check does not fail local version reporting.
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
`~/.local/state/skit`), outside the Library. Failed completed checks back off for
24 hours; successful cached data expires after seven days. Corrupt cache files are
ignored. Upgrade instructions currently use npm; the executable cannot reliably
identify which package manager originally installed it.

## Publishing

Configure npm trusted publishing for `.github/workflows/release-cli.yml` and the
GitHub `npm` environment before the first publication. Dispatch the workflow with
an existing CLI artifact tag. It verifies a clean tagged commit, supported version,
and registry availability; builds and smoke-tests a packed artifact; publishes
with provenance under `staging`; smoke-tests the published version; then promotes
its computed release channel. An already published version cannot be reused after
a failed smoke test: bump the version and create a new tag. Tags may be missing or
point at prereleases during initial publication; clients handle both safely.

There is no self-updater or version-floor enforcement yet. API payload schema
validation continues to establish wire compatibility independently of software
release versions. CLI and server releases can advance independently.
