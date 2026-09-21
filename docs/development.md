# Development

This guide covers repository setup, local CLI usage, isolated testing, generated artifacts, and the checks expected before a change is committed.

## Prerequisites

- Node.js 22.13.0 or newer
- pnpm 11.23.0

Install pnpm with `npx get-pnpm`, `corepack`, or a system package manager such as Homebrew.

## Setup

```sh
git clone <repository-url> skit
cd skit
git switch dev
pnpm install
pnpm build
pnpm verify
```

The repository is a pnpm workspace containing these application packages:

| Package                                                      | Responsibility                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/skit` (`@smolai/skit-core`)                        | SKIT format, validation, source resolution, and local-library state |
| `packages/cli` (`@smolai/skit`)                              | The standalone CLI, command presentation, and harness projections   |
| `packages/skit-server-effect` (`@smolai/skit-server-effect`) | The reference Cloudflare Worker registry backed by D1 and R2        |

Core owns authoritative local-library state. CLI code should request core mutations rather than write `state.json` independently. Server code consumes core contracts but does not define local installation policy.

## Running the CLI locally

Operator first-run discovery is `skit setup`, documented in the [README](../README.md#getting-started). This section is contributor linking and isolated testing.

Build and run the executable directly without changing `PATH`:

```sh
pnpm build
node packages/cli/bin/skit.js --help
node packages/cli/bin/skit.js add tim/dad-joke --home "$(mktemp -d)"
```

To use `skit` as a command, link **`packages/cli`**. The workspace root
(`skit-monorepo`) has no `bin` field, so `pnpm link --global` from the
repository root warns `skit-monorepo has no binaries` and does not install
`skit`.

If pnpm has no global bin directory (`ERR_PNPM_NO_GLOBAL_BIN_DIR`), create one
and reload the shell before linking:

```sh
pnpm setup
source ~/.zshrc   # or ~/.bashrc
```

Then link from the CLI package:

```sh
cd packages/cli
pnpm link --global
rehash # refresh zsh's command cache
which skit
skit --help
```

If pnpm's global bin directory is still not on `PATH`, npm can provide the development link instead:

```sh
cd packages/cli
npm link
rehash
```

The link points into the checkout. After pulling changes, rebuild the repository; it does not need to be linked again:

```sh
git pull
pnpm install
pnpm build
pnpm verify
```

Remove the link from `packages/cli` with the package manager that created it:

```sh
pnpm unlink --global
# or: npm unlink --global @smolai/skit
```

## Safe local testing

SKIT can write Projections into Harness directories. Use isolated storage and explicit temporary Harness roots during development so tests cannot modify real Harness configuration:

```sh
skit_test_home=$(mktemp -d)
codex_test_root=$(mktemp -d)

skit add tim/dad-joke --home "$skit_test_home"
skit list --home "$skit_test_home" --json
skit enable tim/dad-joke \
  --for codex \
  --home "$skit_test_home" \
  --codex-root "$codex_test_root"

find "$codex_test_root" -type f
```

`SKIT_HOME` isolates the whole local library. The CLI also accepts `--home`, `--codex-root`, `--claude-root`, `--opencode-root`, and `--devin-root` overrides.

## Quality checks

Use the fast commit gate while iterating and before each commit:

```sh
pnpm verify
```

It checks formatting, lint, and types. Run focused tests for the files or workspace being
changed rather than the entire repository suite.

Run the complete local quality gate once before pushing:

```sh
pnpm check
```

It runs, in order:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm build`
4. `pnpm typecheck`
5. `pnpm test`

Use `pnpm format` to apply repository formatting.

## Generated CLI contracts

Every command declares its output schemas, exit codes, and interaction behavior in the typed Command Catalog. The generated command manifest and JSON Schemas under `packages/cli/contracts/` are committed so contract changes are visible in review.

Regenerate them after changing command metadata or output schemas:

```sh
pnpm --filter @smolai/skit generate:contracts
pnpm verify
```

Commit the source change and its regenerated artifacts together. Contract tests verify that generated files are current and that real command payloads validate against their declared schemas.

Contract artifacts may be overwritten freely while a branch is in development. Before merge, CI
compares the final generated contracts with the pull request's base commit. A stable contract ID
that exists at that base is frozen: changing its shape requires the next version in that contract
family, and a branch may advance a family by only one version. Run the same check locally with:

```sh
pnpm --filter @smolai/skit contracts:check --base main
```

## Tests

Cloudflare code follows the mandatory policy in [Cloudflare testing](./cloudflare-testing.md). In particular, Worker persistence tests use workerd with real local D1 and R2 bindings; hand-written binding mocks and inline authored-document fixtures are prohibited.

The normal test suite is isolated and does not require network access:

```sh
pnpm test
```

Run the complete local registry product loop with:

```sh
pnpm test:e2e
```

This uses Wrangler's `createTestHarness()` to expose the real local Cloudflare runtime to the separately spawned CLI process, with temporary D1, R2, local-library, and harness state. Its permitted scope and required safeguards are defined in [Cloudflare testing](./cloudflare-testing.md). The v1 journey proves portable Library and Binding synchronization between isolated homes, including private snapshots and device-local Projection reconciliation. Authoring, Draft synchronization, and Publication are pre-release server surfaces and are not exercised through the v1 CLI.

Keep the disposable two-home Skill User gate and the live product-journey discipline. The two-home gate exposed a real unavailable-Harness removal failure on its first run; the additive live capstone exposed the missing exact-release pin operation; and several reconciliation slices required a second review round because their filesystem behavior was safe while their user-visible result still overclaimed success. These gates protect observable behavior and truthful reporting, not merely implementation coverage.

Set `SKIT_E2E_KEEP=1` to retain the temporary workspace after failure. Set `SKIT_E2E_PORT` only when a specific loopback port is required.

Opt-in live smoke tests read from GitHub and a caller-selected Registry but never publish or write upstream:

```sh
SKIT_LIVE_E2E=1 SKIT_SERVER_URL=https://registry.example.com pnpm test:e2e:live
```

The live suite remains outside the normal quality gate because it depends on external services and network access.

## Reference registry development

The server advertises its supported route templates at `/.well-known/agent-skills/` and `/.well-known/skit`. Browser clients authenticate through `/api/auth/*`; CLI clients use a hashed `skit_pat_` token created by an authenticated session through `/api/tokens`. Draft and Publication templates remain pre-release and are not part of the v1 CLI compatibility promise.

When changing the Descriptor accepted by both the CLI and Registry, deploy the Worker before
distributing the matching CLI. A new Worker must accept and normalize the preceding Descriptor
spelling before a CLI begins sending the new spelling; older strict Workers cannot interpret
fields introduced by a newer CLI.

This ordering also applies when relaxing a request contract. For example, deploy a Worker that
accepts an omitted Publication `revision_id` before distributing a CLI that lets the Registry
select its current Draft Revision.

The closed-registration deployment and one-time initial-operator bootstrap are defined in [Self-hosting skit-server](./self-hosting.md). Bootstrap is implemented; operator-management routes and the recovery command described there remain requirements rather than available interfaces.

The Effect server package keeps its deployment entry points at its root and its Worker entry point in `src/index.ts`. For the supported first deployment and custom-domain promotion workflow, follow [Self-hosting the SKIT Registry](./self-hosting.md). The deployment wizard provisions D1 and R2, installs the Better Auth secret, applies migrations, writes the local Cloudflare configuration, and deploys.

`ACCOUNT_REGISTRATION_MODE` controls only account creation. Set it to `closed` for an operator-managed server; existing accounts can still sign in. Set it to `open` only when the server intentionally accepts public registration. Missing and unrecognized values fail closed.

For a new closed-registration server, run the guided bootstrap after the first deployment:

```sh
pnpm skit server bootstrap
```

The command opens the setup form and attempts to remove its one-time Worker secret after completion, failure, or interruption. If cleanup fails before setup completes, follow the printed `wrangler secret delete` command immediately; only a completed permanent D1 claim makes the capability inert independently of secret cleanup. See [Self-hosting skit-server](./self-hosting.md) for the complete security and recovery contract.

For development and troubleshooting, `pnpm --filter @smolai/skit-server-effect verify:deployment`
uses `SKIT_SERVER_URL` and a temporary `SKIT_SESSION_COOKIE` to check the served origin, D1
migrations, R2, and bootstrap state. It is not part of the public onboarding journey. The
self-hosting guide distinguishes this infrastructure diagnostic from the portable Library
synchronization acceptance journey.

For normal CLI operations, use `skit auth login [alias-or-origin]` rather than copying a session cookie. The target may be omitted when a default Registry is configured. The login command creates an expiring, scoped PAT and immediately signs out its temporary browser-style session. The deployment verifier remains session-only because readiness is an operator capability, not a PAT capability.

For local development:

```sh
pnpm --filter @smolai/skit-server-effect dev
```

## Making changes

- Preserve the separation between adding a source and enabling a skill.
- Treat local-library state as authoritative and projections as derived filesystem effects.
- Keep terminal presentation and process exit behavior in the CLI package.
- Add or update process-level tests when changing output streams, exit codes, or JSON envelopes.
- Regenerate committed contracts when command metadata or machine-readable output changes.
- Attach evidence and verification dates when changing harness-registry facts.
- Record durable, costly-to-reverse architectural decisions in an ADR rather than only in a work item or commit message.

## Before committing

- Run `pnpm verify` and the focused tests for the changed behavior.
- Regenerate CLI contracts when applicable and review the generated diff.
- Add regression coverage for behavior changes.
- Update repository documentation or an ADR when a durable contract or boundary changes.
- Confirm manual testing used isolated library and harness roots.
- Check `git status` for generated output or temporary files that should not be committed.

Before pushing, run `pnpm check` once. Run `pnpm test:e2e` separately when the change affects
the Registry or CLI lifecycle.
