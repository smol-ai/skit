import { ConfigProvider, Effect, Layer } from "effect";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { authJourneyOrigin, makeAuthJourneyFixture } from "../platform/auth-journey-fixture.js";
import { authLoginCommand } from "../registry/commands/login.js";
import { authLogoutCommand } from "../registry/commands/logout.js";
import { Registry } from "../registry/index.js";
import { result } from "../commands/result.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

/**
 * A person at a terminal signs in by approving the login in their browser, checks the stored
 * credential, then signs out, all with the real auth commands against a fixture Registry.
 */
const loginStatusLogout = (journeyHome: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, layer, revoked, opened } = yield* makeAuthJourneyFixture(journeyHome);
      const renderer = yield* Renderer;
      return yield* Effect.gen(function* () {
        yield* typed(`skit auth login ${authJourneyOrigin}`);
        // A person at a terminal: prompts are allowed and a browser can approve the login.
        const login = yield* authLoginCommand({
          registry: authJourneyOrigin,
          scopes: ["library:sync"],
          home,
          relogin: false,
          interactive: true,
          browserApproval: true,
        });
        if ("verificationUri" in login)
          return yield* Effect.die("Expected the login to wait for approval, not hand it off");
        yield* renderer.result(result("authLogin", login));
        if (login.alreadyAuthenticated)
          return yield* Effect.die("Expected a new credential, not a reused one");
        if (!(yield* opened).includes(`${authJourneyOrigin}/device`))
          return yield* Effect.die("Expected the login to open the verification page");

        yield* typed("skit auth status");
        const status = yield* Registry.status(home);
        yield* renderer.result(result("authStatus", status));
        const [credential, ...others] = status.credentials;
        if (credential?.origin !== authJourneyOrigin || others.length > 0)
          return yield* Effect.die("Expected status to show the one new credential");

        yield* typed("skit auth logout");
        const logout = yield* authLogoutCommand(home);
        yield* renderer.result(result("authLogout", logout));
        if (!logout.revoked || !(yield* revoked).includes("pat_fixture"))
          return yield* Effect.die("Expected logout to revoke the credential on the Registry");
        if ((yield* Registry.status(home)).credentials.length > 0)
          return yield* Effect.die("Expected logout to forget the credential locally");
        return "No stored credential | the Registry revoked the CLI credential";
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            // No SKIT_SERVER_URL or SKIT_TOKEN from the shell that records the journey.
            skitConfigurationLayer(home).pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
    }),
  ).pipe(Effect.provide(skitLayer));

export const authJourney: JourneyStory<
  string,
  Effect.Error<ReturnType<typeof loginStatusLogout>>,
  Effect.Services<ReturnType<typeof loginStatusLogout>>
> = {
  _tag: "Journey",
  name: "auth/login-status-logout",
  description: "Log in through the browser, check the session, then log out.",
  initialState:
    "No stored credential | fixture Registry offers browser login | no OS credential store",
  answers: [],
  run: loginStatusLogout,
  finalState: (state) => state,
};
