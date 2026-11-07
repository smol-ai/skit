import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer } from "effect";
import {
  makeBetterAuth,
  type BetterAuthConfiguration,
  type BetterAuthService,
} from "./internal/better-auth.js";
import { makeCredentials, type AuthenticationService } from "./internal/credentials.js";
import {
  makeBootstrap,
  type BootstrapService,
  type BootstrapClaimResult,
  type CreateError,
} from "./internal/bootstrap.js";
import type { BootstrapInput, Scope } from "./contracts.js";
export type { Principal } from "./internal/credentials.js";
export { isServerOperator } from "./internal/credentials.js";
export { BootstrapInput } from "./contracts.js";
export type { Scope } from "./contracts.js";
export type { CreateError } from "./internal/bootstrap.js";

export interface IdentityService extends AuthenticationService {
  readonly handle: BetterAuthService["handle"];
  readonly authenticateSession: BetterAuthService["getSession"];
  readonly claimUsername: BetterAuthService["claimUsername"];
  readonly provisionedUsername: BetterAuthService["provisionedUsername"];
  readonly isBootstrapNeeded: BootstrapService["isNeeded"];
  readonly createOperator: (
    input: BootstrapInput,
  ) => Effect.Effect<
    BootstrapClaimResult & { readonly verificationEmailSent: boolean },
    CreateError
  >;
}
export class Identity extends Context.Service<Identity, IdentityService>()(
  "@skit-server-effect/Identity",
) {}

export const layer = (
  configuration: BetterAuthConfiguration,
  supportedScopes: ReadonlySet<Scope>,
  bootstrapSecret: string | undefined,
) =>
  Layer.effect(
    Identity,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const adapter = yield* makeBetterAuth(configuration, sql);
      const credentials = yield* makeCredentials(sql, supportedScopes, adapter);
      const bootstrap = yield* makeBootstrap(sql, bootstrapSecret);
      const createOperator = Effect.fn("Identity.createOperator")(function* (
        input: BootstrapInput,
      ) {
        const { email, username } = yield* bootstrap.createInitialOperator(input);
        const verificationEmailSent = yield* adapter.sendVerificationEmail(email).pipe(
          Effect.tapError((error) => Effect.logError("bootstrap verification email failed", error)),
          Effect.match({ onFailure: () => false, onSuccess: (sent) => sent }),
        );
        return { email, username, verificationEmailSent };
      });
      return Identity.of({
        ...credentials,
        handle: adapter.handle,
        authenticateSession: adapter.getSession,
        claimUsername: adapter.claimUsername,
        provisionedUsername: adapter.provisionedUsername,
        isBootstrapNeeded: bootstrap.isNeeded,
        createOperator,
      });
    }),
  );
