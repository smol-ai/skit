# Development

This guide covers repository setup, local CLI usage, isolated testing, generated artifacts, and the checks expected before a change is committed.

## Prerequisites

- Node.js 24.22.1+ on 24.x, or 26.12.1+ (Node 22 is unsupported because loading SQLite emits a warning that breaks CLI output contracts)
  ([October 2026 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases))
- pnpm 11.23.0

Install pnpm with `npx get-pnpm`, `corepack`, or a system package manager such as Homebrew.

## Setup

```sh
git clone https://github.com/smol-ai/skit.git
cd skit
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

Operator first-run discovery is `skit setup`, documented in the [README](../README.md#setup). This section is contributor linking and isolated testing.

Build and run the executable directly without changing `PATH`:

```sh
pnpm build
node packages/cli/bin/skit.js --help
node packages/cli/bin/skit.js add ./skills/skit --home "$(mktemp -d)"
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

For a disposable Linux home with interactive Codex, use [Linux VM testing](./linux-vm-testing.md).

SKIT can write Projections into Harness directories. Use isolated storage and explicit temporary Harness roots during development so tests cannot modify real Harness configuration:

```sh
skit_test_home=$(mktemp -d)
codex_test_root=$(mktemp -d)
claude_test_root=$(mktemp -d)

skit add ./skills/skit --home "$skit_test_home"
skit list --home "$skit_test_home" --json
skit enable skit \
  --home "$skit_test_home" \
  --codex-root "$codex_test_root" \
  --claude-root "$claude_test_root"

find "$codex_test_root" "$claude_test_root" -type f
```

`SKIT_HOME` isolates the whole local library, not Harness roots: without `--codex-root` and `--claude-root`, SKIT writes into the real `~/.agents/skills` and, when Claude Code is installed, `~/.claude/skills`. The CLI also accepts `--home`, `--codex-root`, `--claude-root`, `--opencode-root`, and `--devin-root` overrides.

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

Every command declares its output schemas, effects, and interaction behavior in the typed Command Catalog. The generated command manifest publishes one shared policy for normal command outcomes: `0` for success, `1` for failure (including partial batches), and `2` for invalid syntax or arguments. JSON errors retain precise domain codes; batch results retain each item’s outcome and code. Commands and error classes do not choose numeric statuses; the CLI output boundary does.

This replaces the statuses `11`, `12`, `13`, `64`, `65`, and `77` in the next release. Scripts that branch on those numbers should use the shared statuses and inspect JSON codes for details. Output schema names remain unchanged by the exit-code simplification. Signal termination keeps the runtime and shell’s conventional signal status.

The generated command manifest and JSON Schemas under `packages/cli/contracts/` are committed so contract changes are visible in review.

Regenerate them after changing command metadata or output schemas:

```sh
pnpm --filter @smolai/skit generate:contracts
pnpm verify
```

Commit the source change and its regenerated artifacts together. Contract tests verify that generated files are current and that real command payloads validate against their declared schemas.

Regenerate and commit contract artifacts whenever their schemas or command metadata
change. Development CI checks artifact freshness and payload validity; merging into
`dev` does not freeze contract IDs.

Contract version bumps are finalized during release preparation, following the
[compatibility policy](./coding-standards.md#name-things-plainly). The release
workflow and local check use the latest published npm package as their baseline:

```sh
pnpm --filter @smolai/skit contracts:check
```

The checker downloads the published archive, verifies its SHA512 integrity, and
reads the shipped manifest and schemas without installing or executing the package.
It reports the compared version and integrity. Use `--release 0.3.0` to compare
against an exact published version. Git branches and tags are not release baselines.
Network or archive failures fail the check; they never skip compatibility checks.

The next release uses `skit.add.preview.v5` for the changed Source diagnostics.
Installed-edit outputs retain the published wire-name families as
`skit.update.projection-retention.v3` and
`skit.update.projection-retention.plan.v3`; their internal names remain
`installedEdit` and `installedEditPlan`.

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
pnpm skit server bootstrap \
  --url <origin-printed-by-deploy:setup> \
  --config packages/skit-server-effect/wrangler.jsonc \
  --wrangler packages/skit-server-effect/node_modules/.bin/wrangler
```

Without `--config` it reads `wrangler.jsonc` from the current directory, which is the repository root under `pnpm skit`.

The command opens the setup form and attempts to remove its one-time Worker secret after completion, failure, or interruption. If cleanup fails before setup completes, follow the printed `wrangler secret delete` command immediately; only a completed permanent D1 claim makes the capability inert independently of secret cleanup. See [Self-hosting skit-server](./self-hosting.md) for the complete security and recovery contract.

For development and troubleshooting, `pnpm --filter @smolai/skit-server-effect verify:deployment`
uses `SKIT_SERVER_URL` and a temporary `SKIT_SESSION_COOKIE` to check the served origin, D1
migrations, R2, and bootstrap state. It is not part of the public onboarding journey. The
self-hosting guide distinguishes this infrastructure diagnostic from the portable Library
synchronization acceptance journey.

For normal CLI operations, use `skit auth login [alias-or-origin]` rather than copying a session cookie. Without a target it uses `SKIT_SERVER_URL`, then the configured default Registry, then `https://skit.smol.ai`. The login command has the user approve a device code in the browser, creates an expiring, scoped PAT with the session that approval grants, and immediately signs that session out. The deployment verifier remains session-only because readiness is an operator capability, not a PAT capability.

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
