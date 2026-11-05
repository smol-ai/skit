import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer } from "effect";
import {
  makeBetterAuth,
  type BetterAuthConfiguration,
  type BetterAuthService,
} from "./internal/better-auth.js";
import { makeCredentials, type AuthenticationService } from "./internal/credentials.js";
import type { Scope } from "./contracts.js";
export type { Principal } from "./internal/credentials.js";
export { isServerOperator } from "./internal/credentials.js";
export type { Scope } from "./contracts.js";

export interface IdentityService extends AuthenticationService {
  readonly handle: BetterAuthService["handle"];
  readonly authenticateSession: BetterAuthService["getSession"];
  readonly claimUsername: BetterAuthService["claimUsername"];
  readonly provisionedUsername: BetterAuthService["provisionedUsername"];
  readonly sendVerificationEmail: BetterAuthService["sendVerificationEmail"];
}
export class Identity extends Context.Service<Identity, IdentityService>()(
  "@skit-server-effect/Identity",
) {}

export const layer = (
  configuration: BetterAuthConfiguration,
  supportedScopes: ReadonlySet<Scope>,
) =>
  Layer.effect(
    Identity,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const adapter = yield* makeBetterAuth(configuration, sql);
      const credentials = yield* makeCredentials(sql, supportedScopes, adapter);
      return Identity.of({
        ...credentials,
        handle: adapter.handle,
        authenticateSession: adapter.getSession,
        claimUsername: adapter.claimUsername,
        provisionedUsername: adapter.provisionedUsername,
        sendVerificationEmail: adapter.sendVerificationEmail,
      });
    }),
  );
