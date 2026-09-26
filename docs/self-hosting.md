# Self-hosting the SKIT Registry

The first supported self-hosting target is a Cloudflare Worker backed by D1 and R2. The deployment remains closed to public account registration from its first request. A one-time bootstrap ceremony creates the initial server operator without temporarily opening registration or requiring hand-written database changes.

This document defines the supported deployment and bootstrap experience and its security invariants. Operator management and guided recovery are not implemented; the relevant sections below record constraints for future work rather than commands available today.

## Deployment shape

The canonical deployment contains:

- one Worker running `packages/skit-server-effect/src/index.ts`;
- one D1 database for identity, authorization, Library, and Release metadata, plus pre-release authoring data;
- one R2 bucket for private Library snapshots and immutable Release archives, plus pre-release Draft content;
- the authentication and Personal Access Token rate-limit bindings;
- optionally, one Cloudflare Email Service send binding for account verification; and
- an exact HTTPS `PUBLIC_APP_ORIGIN`.

Cloudflare Artifacts is not part of the supported deployment. R2 is the sole Draft content backend. Wrangler is the canonical deployment path; additional deployment tools must implement the same lifecycle rather than define a second bootstrap or persistence model.

## Quick deployment to workers.dev

From the repository root, run:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup
```

Use `--name <worker-name>` to override the default `skit-server` name. The command asks Wrangler for the selected Cloudflare account and credential, reads that account's actual `workers.dev` subdomain through the Cloudflare API, and pins both the account ID and exact canonical origin in a resumable, gitignored local `wrangler.jsonc`. It then provisions D1 and R2, applies every committed migration, generates a Better Auth secret in a mode-`0600` temporary directory, and deploys the Worker once. The credential is held only in memory. The temporary secret and Wrangler output files are removed whether deployment succeeds or fails and are never written to the repository or deployment configuration. Existing checkouts migrate the legacy `wrangler.deploy.jsonc` only when the new path is absent; if both exist, setup stops without overwriting either.

If Wrangler can access more than one account, select one by its displayed name or ID with `--account <account>`.

By default, the resources are named `<worker-name>-db` and `<worker-name>-blobs`. Choose unused names when those already exist:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup -- \
  --database-name my-skit-database \
  --bucket-name my-skit-blobs
```

When resuming setup, the command adopts exact-name D1 and R2 resources in the selected account if
their bindings are absent. Review names carefully: setup then applies SKIT migrations to the D1
database. It never chooses a fuzzy name match.

To require email verification, first onboard the sender domain in
[Cloudflare Email Service](https://developers.cloudflare.com/email-service/configuration/domains/),
then pass its bare sender address:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup -- \
  --email-from noreply@example.com
```

Cloudflare sender onboarding adds outbound DKIM, SPF, bounce-MX, and DMARC records. It is separate
from inbound Email Routing and does not require replacing the zone's normal inbox MX records.
Without an onboarded sending domain, Cloudflare restricts delivery to verified destination
addresses; with one, SKIT can send verification messages to arbitrary account addresses.

Preview the configuration shape and command plan without authenticating to Cloudflare or changing local files. The account ID and canonical origin remain absent until the authenticated preflight:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup -- \
  --dry-run
```

The generated deployment configuration is deliberately gitignored because it contains account-specific D1 identifiers. Subsequent code deployments reuse the same resources and secret:

```sh
pnpm --filter @smolai/skit-server-effect deploy
```

After the first deployment, complete the one-time operator ceremony at the origin printed by the command:

```sh
pnpm skit server bootstrap \
  --url <origin-printed-by-deploy:setup> \
  --config packages/skit-server-effect/wrangler.jsonc \
  --wrangler packages/skit-server-effect/node_modules/.bin/wrangler
```

Cloudflare documents `workers.dev` as an evaluation and personal-project endpoint. SKIT supports it as the first canonical origin, while recommending a Custom Domain for production.

## Promote to a custom domain

The domain must already belong to a zone on the same Cloudflare account. Promote it with:

```sh
pnpm --filter @smolai/skit-server-effect deploy:domain -- \
  https://registry.example.com \
  --email-from noreply@example.com
```

This updates `PUBLIC_APP_ORIGIN`, adds the hostname as a Cloudflare Custom Domain, disables the `workers.dev` route, applies pending migrations, and deploys as one configuration change. It does not copy or replace D1 or R2. Disabling the old route is intentional: Registry origins carry identity and credentials, so SKIT does not treat the old and new hosts as interchangeable aliases.

Changing the canonical origin invalidates the practical use of existing host-bound browser sessions and stored CLI credentials. Sign in again at the custom domain and run `skit auth login https://registry.example.com` on each CLI installation. Do not promote the origin while synchronization or other Registry operations are in flight.

## Initial operator bootstrap

Normal email/password registration remains closed throughout deployment. After applying migrations and deploying the Worker, run the guided bootstrap:

```sh
pnpm skit server bootstrap \
  --url <origin-printed-by-deploy:setup> \
  --config packages/skit-server-effect/wrangler.jsonc \
  --wrangler packages/skit-server-effect/node_modules/.bin/wrangler
```

The command generates and installs the one-time Worker secret, waits for the secret-backed setup surface to become available, opens `/setup` with the capability in the URL fragment, waits for setup to complete, and removes the Worker secret. URL fragments are not sent in HTTP requests; the setup page moves the capability into the form and immediately clears the address bar. The operator only supplies their username, email address, and password. The browser-launch command briefly contains the capability in its local process arguments; treat other users of the deployment workstation as trusted during this ceremony. A successful request:

1. consumes the deployment's bootstrap claim;
2. creates the Better Auth user and password account;
3. creates the corresponding SKIT Principal;
4. grants that Principal the server-operator capability; and
5. establishes a normal browser session or directs the operator to normal sign-in.

If Email Service is configured, bootstrap also sends a verification link and password sign-in is
blocked until the operator follows it. The atomic operator records already exist at that point;
verification proves control of the submitted mailbox. If sending fails, bootstrap remains
consumed and the sign-in page's resend action is the recovery path after email is restored.

`POST /api/bootstrap` makes this outcome explicit with `verificationEmailSent`. `true` means the
send binding accepted the verification message. `false` means Email Service was disabled or the
send failed; it does not mean bootstrap rolled back. The browser reports the failure and directs
the operator to **Resend verification email**. The CLI cannot observe the browser's POST response
because it only waits for bootstrap status, so its completion output points back to the browser
result instead of claiming that mail was delivered.

Resend remains available without a session because an unverified account cannot sign in. It is
covered by `AUTH_RATE_LIMITER`; the generated configuration allows five requests per source IP
and authentication endpoint per 60 seconds. Unauthenticated requests return the same success
shape for unknown, already verified, and unverified addresses, with Better Auth's constant-time
floor, so the endpoint does not reveal account existence.

Secret removal is attempted automatically after completion, failure, or interruption and is defense in depth. If cleanup itself fails, the CLI prints the exact `wrangler secret delete SKIT_BOOTSTRAP_SECRET --config <path>` command to run. Before a successful claim, do not assume an interrupted cleanup made the capability inert. After a successful claim, the permanent D1 record—not secret deletion—makes bootstrap single-use. The command wraps the same server-side protocol rather than introducing a second provisioning path.

The command expects `wrangler` on `PATH`. Use `--wrangler <path>` when it is installed elsewhere. Configurations with Wrangler environments must pass `--url` explicitly so the CLI cannot select the wrong deployment origin.

## CLI authentication

After bootstrap, authenticate the CLI directly against the selected server:

```sh
pnpm skit auth login https://registry.example.com
pnpm skit auth status
```

Login reuses a valid saved credential after checking it with the Registry, without prompting or replacing it. When a new credential is needed, it prompts for email and password in an interactive terminal, creates a 90-day Personal Access Token with `library:sync` scope, and signs out the temporary Better Auth session. The credential is stored in `~/.skit/auth.json` with mode `0600`; `--home` overrides `SKIT_HOME`, which overrides that default. Login reports the exact path, and future commands reuse it from any working directory. Passwords are never stored or accepted as command arguments or non-interactive input. The server retains pre-release authoring scopes, but they are not part of the v1 CLI or compatibility promise.

`SKIT_SERVER_URL` selects a Registry for otherwise unqualified automation, and `SKIT_TOKEN` applies only when that origin matches. There is no implicit public Registry: without stored authentication or an explicit server environment variable, network commands fail before making a request. Use `skit auth login --relogin` to deliberately rotate a saved credential without changing the configured default. To remove access, `skit auth logout [origin-or-alias]` first asks that Registry to revoke its PAT, then removes it locally; omitting the target is allowed only when exactly one credential is stored. A PAT may revoke only itself and remains unable to call operator-only routes.

## Post-deploy diagnostics

`GET /health` is an unauthenticated liveness check. It proves only that the deployed Worker can answer a request; it does not touch D1 or R2 and must not be used as evidence that the server is operational.

`GET /api/operator/readiness` is a browser-session-only operator check. It verifies required configuration, the served public origin, D1 access, the exact committed migration set, R2 access, and completion of initial bootstrap. Personal Access Tokens cannot call this endpoint.

Readiness reports Email Service as a separate configuration check. It says whether verification
is disabled or the binding and sender are present; it deliberately does not send mail, so it does
not prove sender-domain activation or delivery.

The readiness endpoint and the repository's `verify:deployment` script are development and
troubleshooting diagnostics, not steps in the public onboarding journey. The script requires a
short-lived browser session because readiness is an operator capability; normal CLI Personal
Access Tokens deliberately cannot call it. Do not copy a browser session cookie into command
history, repository files, shell profiles, or CI variables. A future operator UI should call the
same endpoint without requiring manual cookie handling.

For this early release, successful bootstrap followed by `pnpm skit auth login` is the supported
onboarding completion point.

Readiness is shared infrastructure, not a synchronization journey. A v1 deployment rehearsal must separately prove portable Library synchronization between two isolated homes. Library synchronization must never create a Release or upload content to the pre-release Draft service. The journey reconciles portable intent into device-local Projections, reports filesystem conflicts as partial, and defers Bindings for unavailable Harnesses without creating speculative roots.

The default deployed story is one account across multiple devices. Registration remains closed
and invites do not exist. An operator may deliberately set `ACCOUNT_REGISTRATION_MODE=open`; with
Email Service enabled, each new password account must verify its mailbox before choosing a
Registry username and receiving a Principal or Namespace. Operator-team management remains
unimplemented: bootstrap creates the sole operator, and ordinary accounts or teams do not gain
operator authority.

## Live email smoke test

The normal Worker and product-lifecycle suites do not contact Cloudflare Email Service. They use
the real workerd runtime and storage bindings with a fake only at the outbound email boundary.
Actual sender-domain activation and delivery therefore require an opt-in, non-production smoke
test.

Use a separate checkout or worktree so an existing gitignored `wrangler.jsonc` is not replaced,
then deploy isolated resources with an onboarded sender:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup -- \
  --name skit-email-test \
  --database-name skit-email-test-db \
  --bucket-name skit-email-test-blobs \
  --email-from noreply@example.com
```

Complete the printed bootstrap command and verify all of the following:

1. the setup page says the verification message was sent;
2. password sign-in is rejected before following the message link;
3. the link returns to the Registry and permits the operator to sign in;
4. **Resend verification email** delivers another link; and
5. replaying an already-used link is harmless.

To test ordinary account onboarding, deliberately change `ACCOUNT_REGISTRATION_MODE` to `open` in
that isolated `wrangler.jsonc`, run `pnpm --filter @smolai/skit-server-effect deploy`, and create a
new account. Signup must not claim a Registry username. After verification, the browser must show
the username-claim form; only a successful claim creates the Principal and personal Namespace.
Return registration to `closed` or retire the test deployment when finished. This live test must
never target the production Registry.

## Bootstrap invariants

Bootstrap must satisfy all of the following:

- `ACCOUNT_REGISTRATION_MODE` remains `closed`; bootstrap is not ordinary registration.
- If `SKIT_BOOTSTRAP_SECRET` is absent, bootstrap routes return `404` and do not advertise an inactive setup surface.
- The submitted secret is never logged, stored in plaintext, or returned in a response.
- The request Origin must exactly match `PUBLIC_APP_ORIGIN`; production bootstrap requires HTTPS and does not permit cross-origin requests.
- Bootstrap POST requests have a dedicated per-IP rate limit independent of Better Auth's routes.
- The server refuses bootstrap when any Better Auth user already exists, even if the bootstrap claim row is unexpectedly absent.
- A successful claim remains consumed permanently. Removing every user does not return the server to an uninitialized state.

The server must not implement bootstrap as a user-count check followed by account creation. Two concurrent requests could both observe an empty database. Instead, D1 owns a singleton bootstrap record whose primary-key insertion, Better Auth account records, SKIT Principal, and operator grant are committed in one atomic batch. A competing or replayed request fails without creating a second account.

The setup status endpoint exposes only whether initial setup is required. After a successful claim it reports setup complete permanently and reveals no account information.

## Better Auth boundary

Better Auth remains the owner of normal browser sessions and email/password sign-in. Bootstrap must use the same password hashing and verification implementation configured in Better Auth; it must not introduce a second password format.

Because the bootstrap claim and initial identity records must be atomic, the bootstrap path may create the pinned Better Auth records in the same D1 batch. This is allowed only while:

- Better Auth remains version-pinned;
- committed migrations define the expected Better Auth schema;
- the schema-conformance test detects dependency/schema drift; and
- bootstrap uses the same identifier, timestamp, password, and Principal invariants as normal account creation.

Session creation can occur after the identity transaction. If session creation fails, the bootstrap remains successful and the operator can use normal sign-in; the server must not roll back or re-arm bootstrap.

## Operator capability

Server operation and content ownership are separate authority domains. Bootstrap grants a server-operator capability; it does not grant ownership of every Namespace, SKIT, Library, Draft, or Release.

Bootstrap currently records one binary operator capability separately from content grants. Operator-management routes are not implemented yet. When added, they may use that capability for narrowly defined operations such as account provisioning, suspension, operator promotion or demotion, and recovery rather than introducing a general administrative RBAC system. Content access continues to use ordinary Namespace, team, and resource grants.

Future operator-management routes must require a browser session. A `skit_pat_` Personal Access Token must not provision accounts, promote operators, perform recovery, or change server configuration regardless of its product scopes. The server must also prevent deletion, suspension, or demotion of the last active operator.

Creating an ordinary personal Namespace for the initial operator is a separate domain operation. It must not be implicit evidence of server administration, nor may operator status imply ownership of other Namespaces.

## Recovery

Recovery never reopens `/setup` and never deletes or resets the permanent bootstrap claim. The Cloudflare account holder already controls the Worker, D1, R2, routes, and secrets, so loss of operator access is an explicit infrastructure break-glass procedure.

The supported recovery operation should eventually be exposed as a narrowly scoped command such as:

```sh
skit server recover-operator --email operator@example.com
```

The command must identify an existing account, restore its operator capability or credential through a reviewed server-owned procedure, and increment its authorization generation. Incrementing the generation invalidates all existing sessions and Personal Access Tokens for that Principal. It must not accept arbitrary SQL, create an unrelated second identity, or make bootstrap reusable.

Until that command exists, any Wrangler/D1 recovery procedure must document its exact preconditions, statements, verification, and session/PAT invalidation effects rather than asking an operator to improvise database changes.

## Required acceptance proof

The self-hosting journey is supported only when an account-free deployed test proves:

1. a migrated server with closed registration and no bootstrap secret exposes no setup surface;
2. installing the secret enables setup without enabling ordinary registration;
3. two concurrent valid bootstrap attempts create exactly one user, Principal, and operator;
4. replay fails after the atomic claim;
5. the initial operator can sign in and mint an ordinary scoped PAT;
6. the PAT cannot call operator-management routes;
7. removing the Worker secret does not affect the initialized server;
8. deleting or losing the operator does not re-arm bootstrap; and
9. break-glass recovery invalidates earlier sessions and PATs.

Deployment readiness must additionally verify required environment values, applied migration compatibility, D1 and R2 availability, public-origin correctness, and whether initial bootstrap is still required.
