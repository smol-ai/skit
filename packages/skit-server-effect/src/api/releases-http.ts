import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Identity } from "../identity/service.js";
import { downloadRelease, downloadReleaseAnonymous } from "./release-download.js";
import { Skits } from "../skits/service.js";
import { ReleaseApi } from "@smolai/skit-core/api";

export const authenticatedReleaseHandlers = HttpApiBuilder.group(
  ReleaseApi,
  "releaseDownloads",
  (handlers) =>
    Effect.gen(function* () {
      const authentication = yield* Identity;
      const skits = yield* Skits;
      return handlers.handle("download", ({ params }) =>
        downloadRelease(params).pipe(
          Effect.provideService(Identity, authentication),
          Effect.provideService(Skits, skits),
        ),
      );
    }),
);

export const anonymousReleaseHandlers = HttpApiBuilder.group(
  ReleaseApi,
  "releaseDownloads",
  (handlers) =>
    Effect.gen(function* () {
      const skits = yield* Skits;
      return handlers.handle("download", ({ params }) =>
        downloadReleaseAnonymous(params).pipe(Effect.provideService(Skits, skits)),
      );
    }),
);
