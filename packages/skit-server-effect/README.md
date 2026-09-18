# SKIT Registry server

`@smolai/skit-server-effect` is the open-source Cloudflare Worker used to run a SKIT
Registry. It combines an Effect HTTP application, a browser account UI, D1 metadata, and R2
artifact storage.

## Registry v1

The supported v1 server surface is synchronization and distribution:

- browser account sign-in and the one-time initial-operator bootstrap;
- scoped Personal Access Tokens;
- portable Library synchronization and private Library snapshots;
- immutable Release download;
- SKIT and Agent Skills discovery, including direct installation by Agent Skills clients;
- unauthenticated liveness and operator-authenticated deployment readiness.

The Worker also contains Draft, Publication, author-inventory, team, and SKIT-deletion APIs.
They are pre-release authoring interfaces: the v1 CLI does not expose them, they are not part
of the v1 compatibility promise, and they may change or be removed.

## Deploy

The supported target is Cloudflare Workers with one D1 database and one R2 bucket. From the
repository root:

```sh
pnpm install
pnpm build
pnpm --filter @smolai/skit-server-effect deploy:setup
pnpm skit server bootstrap \
  --url <origin-printed-by-deploy:setup> \
  --config packages/skit-server-effect/wrangler.jsonc \
  --wrangler packages/skit-server-effect/node_modules/.bin/wrangler
pnpm skit auth login <origin-printed-by-deploy:setup>
```

The setup command provisions isolated resources, applies committed migrations, generates the
authentication secret, and deploys with registration closed. Completing bootstrap and signing in
through the CLI is the supported first-release onboarding boundary. Follow the complete
[self-hosting guide](../../docs/self-hosting.md), including its bootstrap and security
boundaries, rather than treating the abbreviated commands above as an operations runbook.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `PUBLIC_APP_ORIGIN` | variable | Exact HTTPS Registry origin; identity and browser security depend on it |
| `ACCOUNT_REGISTRATION_MODE` | variable | `closed` for self-hosting; `open` deliberately permits registration |
| `BETTER_AUTH_SECRET` | secret | Better Auth signing secret, at least 32 characters |
| `SKIT_BOOTSTRAP_SECRET` | temporary secret | Enables the one-time setup surface; removed after bootstrap |
| `DB` | D1 binding | Identity, authorization, Library, and Release metadata |
| `SKIT_BLOBS` | R2 binding | Private snapshots and immutable Release archives |
| `AUTH_RATE_LIMITER` | rate-limit binding | Browser authentication requests |
| `PAT_RATE_LIMITER` | rate-limit binding | Personal Access Token requests |
| `BOOTSTRAP_RATE_LIMITER` | rate-limit binding | Initial-operator bootstrap requests |
| `ASSETS` | Worker assets binding | Browser application assets |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | optional secrets | GitHub sign-in; configure both or neither |
| `EMAIL`, `EMAIL_FROM` | optional binding and variable | Verification email; configure both or neither |

`wrangler.example.jsonc` is the committed public template. `deploy:setup` writes the gitignored
`wrangler.jsonc` containing deployment-specific resource identifiers. Existing checkouts with a
legacy `wrangler.deploy.jsonc` are migrated when the new path is absent; if both files exist, the
command stops without choosing or overwriting either. Credentials, production identifiers, DNS
control, backups, and operator access do not belong in this repository.

### Email verification with Cloudflare

SKIT uses Cloudflare Email Service directly; no third-party mail provider is required. First
[onboard a sending domain](https://developers.cloudflare.com/email-service/configuration/domains/)
in the Cloudflare dashboard and wait for its sender authentication records to become active.
This is outbound-email configuration (DKIM, SPF, a bounce MX record, and DMARC), not inbound
Email Routing, and it does not replace the zone's ordinary inbox MX records.

Then add one bare sender address to setup or domain promotion:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup -- \
  --email-from noreply@example.com

pnpm --filter @smolai/skit-server-effect deploy:domain -- \
  https://registry.example.com \
  --email-from noreply@example.com
```

The command writes both the `EMAIL` send binding and `EMAIL_FROM` to the gitignored deployment
configuration. Before a sending domain is onboarded, Cloudflare restricts delivery to verified
destination addresses; after onboarding, it can deliver verification messages to arbitrary
recipients. See the [Workers send-email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
and [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

When email is configured, password signup creates an unverified Better Auth account but does not
claim a Registry username, Principal, or Namespace. The user follows the emailed link, receives a
session, and then claims a Registry username in the browser. Unverified sign-in is rejected, and
the sign-in form can resend the verification message. Bootstrap remains a privileged ceremony:
it creates the initial operator atomically, sends a verification message, and requires
verification before password sign-in. Delivery failure does not re-arm a consumed bootstrap
claim; use resend after restoring Email Service.

Operator readiness reports whether email verification is disabled or has both required settings.
It does not send a probe message, so it cannot prove DNS activation or recipient delivery.

The successful bootstrap response includes `verificationEmailSent`. A value of `false` means the
operator records and permanent bootstrap claim were committed, but Email Service was disabled or
delivery failed. It does not make bootstrap reusable. The setup page reports that state and sends
the operator to **Resend verification email** after delivery is restored.

Verification resend is unauthenticated so a user who cannot sign in can recover. It shares
`AUTH_RATE_LIMITER` with email signup and sign-in; the generated configuration permits five
requests per source IP and endpoint per 60 seconds. For an unauthenticated request, an unknown,
already verified, or unverified address receives the same successful response. Better Auth also
applies a constant-time floor, so this endpoint must not be used to discover whether an account
exists.

## Accounts and GitHub sign-in

Better Auth owns browser accounts, sessions, email/password sign-in, and the optional GitHub
OAuth exchange. SKIT gives each account an opaque, Registry-local Principal for authorization.
A Principal is not an operator or an author identity: it may separately hold the server-operator
capability, belong to teams, own a Namespace, or receive resource grants.

Set both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to offer GitHub sign-in. Configure the
GitHub OAuth application callback as
`<PUBLIC_APP_ORIGIN>/api/auth/callback/github`. The browser application starts the exchange
through Better Auth and returns to the Registry after GitHub authorization.
`ACCOUNT_REGISTRATION_MODE=closed` disables both email/password registration and first-time
GitHub account creation. Existing linked GitHub accounts can still sign in. Set registration to
`open` only when this Registry deliberately accepts new accounts.

A new GitHub account does not derive Registry authority from its GitHub login or profile name.
After sign-in, a user without a Registry username must choose one in the browser application.
The GitHub-provided name is only a suggestion. A successful claim atomically:

1. normalizes and records the Registry username;
2. creates the account's SKIT Principal; and
3. creates the same-name personal Namespace owned by that Principal.

Usernames and Namespaces are unique within one Registry. An invalid username returns a validation
error, and an existing Namespace makes the requested username unavailable. Repeating the claim
for an account that already has a username returns its existing username rather than changing it.

GitHub account linking is limited to the same email address. GitHub is a trusted linking provider,
but different-email linking is not enabled. Linking an account, signing in through GitHub, or
claiming a username does not grant server-operator authority. The one-time bootstrap ceremony is
the only currently supported interface that grants that capability; operator-management routes
are not implemented yet.

## Canonical and self-hosted Registries

There is one implementation and one deployment workflow. `skit.smol.ai` is authoritative
because smol.ai operates that origin and controls its DNS and credentials, not because the
Worker claims a special canonical flag. A self-hosted deployment is an independent Registry
authority with its own origin, accounts, namespaces, data, and credentials.

The CLI does not silently substitute one Registry for another. Authenticate against the
intended origin with `skit auth login <origin>` and configure aliases/defaults explicitly.

## Development and verification

```sh
pnpm --filter @smolai/skit-server-effect dev
pnpm --filter @smolai/skit-server-effect test
pnpm test:e2e
```

The normal server tests use workerd with real local D1 and R2 bindings. The root E2E command
builds the CLI and exercises portable Library synchronization against a disposable Registry.
See [Cloudflare testing](../../docs/cloudflare-testing.md) for the binding and fixture policy.

These account-free tests use a fake at the outbound email boundary. They prove verification,
expiry, replay, resend throttling, bootstrap delivery failure, and identity provisioning, but not
real message delivery. To smoke-test Cloudflare Email Service, use a non-production Worker, D1,
R2 bucket, and onboarded sender domain:

```sh
pnpm --filter @smolai/skit-server-effect deploy:setup -- \
  --name skit-email-test \
  --database-name skit-email-test-db \
  --bucket-name skit-email-test-blobs \
  --email-from noreply@example.com
```

Use a separate checkout or worktree if another gitignored `wrangler.jsonc` already describes a
real deployment. Complete the printed bootstrap command, confirm the setup page reports that mail
was sent, confirm password sign-in fails before verification, follow the link, and confirm the
operator can sign in. Exercise **Resend verification email** as well. To test ordinary onboarding,
deliberately set `ACCOUNT_REGISTRATION_MODE` to `open` in that test deployment, redeploy, create a
new account, and confirm the verification link leads to username claim before a Principal and
Namespace are created. Restore `closed` or retire the isolated test deployment afterward.

## Known operational gaps

- Operator-management and guided operator-recovery commands are not implemented.
- Backup, restore, rollback, and incident-response procedures have not yet been exercised and
  are not claimed as supported runbooks.
- Changing the Registry origin changes its authority and requires clients to authenticate
  again.
