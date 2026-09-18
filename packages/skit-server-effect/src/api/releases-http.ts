import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Authentication } from "../auth/authentication.js";
import { Authorization } from "../authorization/service.js";
import { downloadRelease, downloadReleaseAnonymous } from "../releases/http.js";
import { ReleaseStore } from "../releases/store.js";
import { ReleaseApi } from "./releases.js";

export const authenticatedReleaseHandlers = HttpApiBuilder.group(
  ReleaseApi,
  "releaseDownloads",
  (handlers) =>
    Effect.gen(function* () {
      const authentication = yield* Authentication;
      const authorization = yield* Authorization;
      const store = yield* ReleaseStore;
      return handlers.handle("download", ({ params }) =>
        downloadRelease(params).pipe(
          Effect.provideService(Authentication, authentication),
          Effect.provideService(Authorization, authorization),
          Effect.provideService(ReleaseStore, store),
        ),
      );
    }),
);

export const anonymousReleaseHandlers = HttpApiBuilder.group(
  ReleaseApi,
  "releaseDownloads",
  (handlers) =>
    Effect.gen(function* () {
      const store = yield* ReleaseStore;
      return handlers.handle("download", ({ params }) =>
        downloadReleaseAnonymous(params).pipe(Effect.provideService(ReleaseStore, store)),
      );
    }),
);
